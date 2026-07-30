/**
 * Maintenance endpoints — create, update and delete the source data.
 *
 * Write access is gated on the `editor` role by staticwebapp.config.json, not
 * here: the platform rejects the request before it reaches this code, so these
 * handlers do not re-check roles. They do validate every field, because the
 * browser is not the only possible caller.
 *
 * Deletes return non-blocking `warnings` rather than refusing. Removing a
 * furnace that a rule still names, or a piece of equipment a rule ties to a
 * furnace, leaves a dangling reference the planner handles by ignoring — which
 * is exactly the kind of silent loosening this project reports rather than
 * hides. The caller is told; the caller decides.
 */
const { app } = require('@azure/functions')
const { query } = require('../db')
const { validateMachine, validateEquipment, validateRule } = require('../validate')

const json = (status, body) => ({ status, jsonBody: body })
const badRequest = (errors) => json(400, { error: 'validation failed', errors })

const fail = (context, what, err) => {
  context.error(`${what} failed`, err)
  return json(500, { error: `${what} failed`, reason: String(err.message || err).slice(0, 200) })
}

/** Rule sentences that mention a given machine or equipment id, loosely. */
async function rulesMentioning(needle) {
  const words = needle.replace(/-/g, ' ')
  const { rows } = await query(
    'SELECT id, text FROM rules WHERE lower(replace(text, \'-\', \' \')) LIKE $1',
    [`%${words}%`],
  )
  return rows
}

// --------------------------------------------------------------------------
// machines
// --------------------------------------------------------------------------

app.http('machineCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'machines',
  handler: async (request, context) => {
    try {
      const m = await request.json()
      const errors = validateMachine(m, { requireId: true })
      if (errors.length) return badRequest(errors)

      const exists = await query('SELECT 1 FROM machines WHERE id = $1', [m.id])
      if (exists.rowCount) return json(409, { error: `machine "${m.id}" already exists` })

      await query(
        `INSERT INTO machines (id, name, model, function, holders, gf_size, gf_per_holder, yield, has_open_marker)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [m.id, m.name, m.model || '', m.function, m.holders, m.gfSize || '',
         m.gfPerHolder, m.yield, !!m.hasOpenMarker],
      )

      // A machine with no curve cannot be planned — phases and the cooling fit
      // are derived from measured points. Say so rather than let it appear
      // healthy in the list and then break the planner.
      return json(201, {
        id: m.id,
        warnings: ['No temperature curve yet — this furnace cannot be planned or forecast until curve points exist.'],
      })
    } catch (err) {
      return fail(context, 'machine create', err)
    }
  },
})

app.http('machineUpdate', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'machines/{id}',
  handler: async (request, context) => {
    try {
      const id = request.params.id
      const m = await request.json()
      const errors = validateMachine(m)
      if (errors.length) return badRequest(errors)

      const res = await query(
        `UPDATE machines SET name=$2, model=$3, function=$4, holders=$5,
                gf_size=$6, gf_per_holder=$7, yield=$8, has_open_marker=$9, updated_at=now()
         WHERE id=$1`,
        [id, m.name, m.model || '', m.function, m.holders, m.gfSize || '',
         m.gfPerHolder, m.yield, !!m.hasOpenMarker],
      )
      if (!res.rowCount) return json(404, { error: `no machine "${id}"` })

      return json(200, { id, updated: true })
    } catch (err) {
      return fail(context, 'machine update', err)
    }
  },
})

app.http('machineDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'machines/{id}',
  handler: async (request, context) => {
    try {
      const id = request.params.id
      const mentions = await rulesMentioning(id)

      const points = await query('SELECT count(*)::int AS n FROM curve_points WHERE machine_id = $1', [id])
      const res = await query('DELETE FROM machines WHERE id = $1', [id])
      if (!res.rowCount) return json(404, { error: `no machine "${id}"` })

      const warnings = []
      if (points.rows[0].n > 0) {
        warnings.push(`${points.rows[0].n} curve point(s) were deleted with it.`)
      }
      for (const r of mentions) {
        warnings.push(`Rule still names this furnace and will no longer apply to it: "${r.text}"`)
      }
      return json(200, { id, deleted: true, warnings })
    } catch (err) {
      return fail(context, 'machine delete', err)
    }
  },
})

// --------------------------------------------------------------------------
// equipment
// --------------------------------------------------------------------------

app.http('equipmentCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'equipment',
  handler: async (request, context) => {
    try {
      const e = await request.json()
      const errors = validateEquipment(e, { requireId: true })
      if (errors.length) return badRequest(errors)

      const exists = await query('SELECT 1 FROM equipment WHERE id = $1', [e.id])
      if (exists.rowCount) return json(409, { error: `equipment "${e.id}" already exists` })

      await query(
        'INSERT INTO equipment (id, name, max_amps, rated, needs_input) VALUES ($1,$2,$3,$4,$5)',
        [e.id, e.name, e.rated ? e.maxAmps : null, !!e.rated, !!e.needsInput],
      )
      return json(201, { id: e.id, warnings: unratedWarning(e) })
    } catch (err) {
      return fail(context, 'equipment create', err)
    }
  },
})

app.http('equipmentUpdate', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'equipment/{id}',
  handler: async (request, context) => {
    try {
      const id = request.params.id
      const e = await request.json()
      const errors = validateEquipment(e)
      if (errors.length) return badRequest(errors)

      const res = await query(
        'UPDATE equipment SET name=$2, max_amps=$3, rated=$4, needs_input=$5 WHERE id=$1',
        [id, e.name, e.rated ? e.maxAmps : null, !!e.rated, !!e.needsInput],
      )
      if (!res.rowCount) return json(404, { error: `no equipment "${id}"` })

      return json(200, { id, updated: true, warnings: unratedWarning(e) })
    } catch (err) {
      return fail(context, 'equipment update', err)
    }
  },
})

app.http('equipmentDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'equipment/{id}',
  handler: async (request, context) => {
    try {
      const id = request.params.id
      const mentions = await rulesMentioning(id)
      const res = await query('DELETE FROM equipment WHERE id = $1', [id])
      if (!res.rowCount) return json(404, { error: `no equipment "${id}"` })

      const warnings = mentions.map(
        (r) => `Rule still names this equipment; its load will no longer be counted: "${r.text}"`,
      )
      return json(200, { id, deleted: true, warnings })
    } catch (err) {
      return fail(context, 'equipment delete', err)
    }
  },
})

/** Blank ratings are counted as 0 A, never guessed — so say so out loud. */
function unratedWarning(e) {
  if (e.rated || e.needsInput) return []
  return [
    `"${e.name}" has no rating, so the planner counts it as 0 A. ` +
      'The real site draw will be higher than the plan shows.',
  ]
}

// --------------------------------------------------------------------------
// rules
// --------------------------------------------------------------------------

app.http('ruleCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'rules',
  handler: async (request, context) => {
    try {
      const r = await request.json()
      const errors = validateRule(r)
      if (errors.length) return badRequest(errors)

      const next = await query('SELECT coalesce(max(id), -1) + 1 AS id FROM rules')
      const id = next.rows[0].id
      await query('INSERT INTO rules (id, text) VALUES ($1, $2)', [id, r.text.trim()])
      return json(201, { id })
    } catch (err) {
      return fail(context, 'rule create', err)
    }
  },
})

app.http('ruleUpdate', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'rules/{id}',
  handler: async (request, context) => {
    try {
      const id = Number(request.params.id)
      if (!Number.isInteger(id)) return badRequest(['rule id must be an integer'])

      const r = await request.json()
      const errors = validateRule(r)
      if (errors.length) return badRequest(errors)

      const res = await query('UPDATE rules SET text = $2 WHERE id = $1', [id, r.text.trim()])
      if (!res.rowCount) return json(404, { error: `no rule ${id}` })

      return json(200, { id, updated: true })
    } catch (err) {
      return fail(context, 'rule update', err)
    }
  },
})

app.http('ruleDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'rules/{id}',
  handler: async (request, context) => {
    try {
      const id = Number(request.params.id)
      if (!Number.isInteger(id)) return badRequest(['rule id must be an integer'])

      const res = await query('DELETE FROM rules WHERE id = $1', [id])
      if (!res.rowCount) return json(404, { error: `no rule ${id}` })

      return json(200, { id, deleted: true })
    } catch (err) {
      return fail(context, 'rule delete', err)
    }
  },
})
