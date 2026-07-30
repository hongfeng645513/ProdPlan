/**
 * Machines: read the source data, and maintain it.
 *
 * IMPORTANT — one app.http() registration per ROUTE, dispatching on method
 * inside. Azure Functions v4 keys HTTP functions by route, so registering
 * `machines` twice (once for GET, once for POST) silently drops one of them and
 * the endpoint 404s with nothing in the logs to explain why. Every route in this
 * API is therefore declared exactly once, with all its methods listed together.
 *
 * This endpoint returns SOURCE rows only — specs, measured curve points, rule
 * sentences, current ratings. It deliberately computes nothing: phases, the
 * Newton cooling fit, batch capacity and the parsed rules are all derived in the
 * browser by src/lib/derive.js, so there is exactly one implementation of the
 * modelling, in one language, reachable by `npm run check` under bare Node.
 */
const { app } = require('@azure/functions')
const { query } = require('../db')
const { validateMachine } = require('../validate')

const json = (status, body) => ({ status, jsonBody: body })
const badRequest = (errors) => json(400, { error: 'validation failed', errors })

const fail = (context, what, err) => {
  context.error(`${what} failed`, err)
  return json(500, { error: `${what} failed`, reason: String(err.message || err).slice(0, 300) })
}

app.http('ping', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'ping',
  handler: async () => ({ jsonBody: { ok: true, service: 'prodplan-api' } }),
})

app.http('machines', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'machines',
  handler: async (request, context) => {
    if (request.method === 'POST') return createMachine(request, context)
    return listSource(context)
  },
})

app.http('machineById', {
  methods: ['PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'machines/{id}',
  handler: async (request, context) => {
    if (request.method === 'DELETE') return deleteMachine(request, context)
    return updateMachine(request, context)
  },
})

app.http('machineCooling', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'machines/{id}/cooling',
  handler: async (request, context) => setCooling(request, context),
})

// --------------------------------------------------------------------------

async function listSource(context) {
  try {
    // numeric columns are cast to float8 on the way out. node-postgres hands
    // back `numeric` as a STRING to avoid precision loss, and a string that
    // looks like a number will sail through JSON and then quietly corrupt every
    // calculation downstream.
    const [machines, points, rules, equipment] = await Promise.all([
      query(`SELECT id, name, model, function, holders,
                    gf_size            AS "gfSize",
                    gf_per_holder::float8 AS "gfPerHolder",
                    yield::float8      AS "yield",
                    has_open_marker    AS "hasOpenMarker",
                    cooling_k_override::float8 AS "coolingKOverride",
                    cooling_k_source   AS "coolingKSource"
             FROM machines ORDER BY name`),
      query(`SELECT machine_id AS "machineId", t_hours::float8 AS t, temp_c::float8 AS "T"
             FROM curve_points ORDER BY machine_id, t_hours`),
      query('SELECT text FROM rules ORDER BY id'),
      query(`SELECT id, name, max_amps::float8 AS "maxAmps", rated, needs_input AS "needsInput"
             FROM equipment ORDER BY id`),
    ])

    const byMachine = new Map(machines.rows.map((m) => [m.id, []]))
    for (const p of points.rows) {
      byMachine.get(p.machineId)?.push({ t: p.t, T: p.T })
    }

    return {
      jsonBody: {
        source: 'postgres',
        machines: machines.rows.map((m) => ({ ...m, measured: byMachine.get(m.id) || [] })),
        ruleSentences: rules.rows.map((r) => r.text),
        equipment: equipment.rows,
      },
    }
  } catch (err) {
    context.error('failed to read source data', err)
    return json(503, { error: 'database unavailable' })
  }
}

async function createMachine(request, context) {
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

    // A machine with no curve cannot be planned — phases and the cooling fit are
    // derived from measured points. Say so rather than let it look healthy in
    // the list and then break the planner.
    return json(201, {
      id: m.id,
      warnings: ['No temperature curve yet — this furnace cannot be planned or forecast until curve points exist.'],
    })
  } catch (err) {
    return fail(context, 'machine create', err)
  }
}

async function updateMachine(request, context) {
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
}

async function deleteMachine(request, context) {
  try {
    const id = request.params.id
    const words = id.replace(/-/g, ' ')
    const mentions = await query(
      "SELECT id, text FROM rules WHERE lower(replace(text, '-', ' ')) LIKE $1",
      [`%${words}%`],
    )
    const points = await query('SELECT count(*)::int AS n FROM curve_points WHERE machine_id = $1', [id])
    const res = await query('DELETE FROM machines WHERE id = $1', [id])
    if (!res.rowCount) return json(404, { error: `no machine "${id}"` })

    const warnings = []
    if (points.rows[0].n > 0) warnings.push(`${points.rows[0].n} curve point(s) were deleted with it.`)
    for (const r of mentions.rows) {
      warnings.push(`Rule still names this furnace and will no longer apply to it: "${r.text}"`)
    }
    return json(200, { id, deleted: true, warnings })
  } catch (err) {
    return fail(context, 'machine delete', err)
  }
}

/**
 * Apply (or clear) a measured cooling constant.
 *
 * Stored, unlike everything else derived, because it is a decision: a person
 * judged a refit from real runs to describe the furnace better than the
 * reference curve's fit. `cooling_k_source` records where it came from so the
 * choice is auditable rather than an unexplained number.
 */
async function setCooling(request, context) {
  try {
    const id = request.params.id
    const body = await request.json()
    const k = body.k

    if (k != null && (typeof k !== 'number' || !(k > 0) || k > 5)) {
      return json(400, { error: 'k must be a positive number below 5, or null to clear the override' })
    }

    const res = await query(
      'UPDATE machines SET cooling_k_override = $2, cooling_k_source = $3, updated_at = now() WHERE id = $1',
      [id, k ?? null, k == null ? null : String(body.source || 'measured runs').slice(0, 200)],
    )
    if (!res.rowCount) return json(404, { error: `no machine "${id}"` })

    return json(200, {
      id,
      k: k ?? null,
      cleared: k == null,
      warnings: k == null ? [] : ['Cycle times, batches per day and every plan will change to match the new cooling constant.'],
    })
  } catch (err) {
    return fail(context, 'cooling override', err)
  }
}
