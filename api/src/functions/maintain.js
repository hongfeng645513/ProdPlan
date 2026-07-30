/**
 * Equipment and rules maintenance.
 *
 * One app.http() registration per ROUTE, dispatching on method inside — see the
 * note in machines.js. Registering the same route twice drops one registration
 * silently, and the endpoint 404s with nothing to explain it.
 *
 * Write access is gated on the `editor` role by staticwebapp.config.json, not
 * here: the platform rejects the request before it reaches this code. Fields are
 * still validated, because the browser is not the only possible caller.
 *
 * Deletes return non-blocking `warnings` rather than refusing. Removing a piece
 * of equipment a rule still ties to a furnace leaves a dangling reference the
 * planner handles by ignoring — exactly the kind of silent loosening this
 * project reports rather than hides. The caller is told; the caller decides.
 */
const { app } = require('@azure/functions')
const { query } = require('../db')
const { validateEquipment, validateRule } = require('../validate')

const json = (status, body) => ({ status, jsonBody: body })
const badRequest = (errors) => json(400, { error: 'validation failed', errors })

const fail = (context, what, err) => {
  context.error(`${what} failed`, err)
  return json(500, { error: `${what} failed`, reason: String(err.message || err).slice(0, 300) })
}

/** Rule sentences that mention a given id, loosely. */
async function rulesMentioning(needle) {
  const { rows } = await query(
    "SELECT id, text FROM rules WHERE lower(replace(text, '-', ' ')) LIKE $1",
    [`%${needle.replace(/-/g, ' ')}%`],
  )
  return rows
}

/** Blank ratings are counted as 0 A, never guessed — so say so out loud. */
function unratedWarning(e) {
  if (e.rated || e.needsInput) return []
  return [
    `"${e.name}" has no rating, so the planner counts it as 0 A. ` +
      'The real site draw will be higher than the plan shows.',
  ]
}

// --------------------------------------------------------------------------
// equipment
// --------------------------------------------------------------------------

app.http('equipment', {
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

app.http('equipmentById', {
  methods: ['PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'equipment/{id}',
  handler: async (request, context) => {
    const id = request.params.id
    try {
      if (request.method === 'DELETE') {
        const mentions = await rulesMentioning(id)
        const res = await query('DELETE FROM equipment WHERE id = $1', [id])
        if (!res.rowCount) return json(404, { error: `no equipment "${id}"` })
        return json(200, {
          id,
          deleted: true,
          warnings: mentions.map(
            (r) => `Rule still names this equipment; its load will no longer be counted: "${r.text}"`,
          ),
        })
      }

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
      return fail(context, 'equipment save', err)
    }
  },
})

// --------------------------------------------------------------------------
// rules
// --------------------------------------------------------------------------

app.http('rules', {
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

app.http('ruleById', {
  methods: ['PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'rules/{id}',
  handler: async (request, context) => {
    const id = Number(request.params.id)
    if (!Number.isInteger(id)) return badRequest(['rule id must be an integer'])
    try {
      if (request.method === 'DELETE') {
        const res = await query('DELETE FROM rules WHERE id = $1', [id])
        if (!res.rowCount) return json(404, { error: `no rule ${id}` })
        return json(200, { id, deleted: true })
      }

      const r = await request.json()
      const errors = validateRule(r)
      if (errors.length) return badRequest(errors)

      const res = await query('UPDATE rules SET text = $2 WHERE id = $1', [id, r.text.trim()])
      if (!res.rowCount) return json(404, { error: `no rule ${id}` })
      return json(200, { id, updated: true })
    } catch (err) {
      return fail(context, 'rule save', err)
    }
  },
})
