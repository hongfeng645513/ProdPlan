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
const { getPool, query } = require('../db')
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

app.http('machineCurve', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'machines/{id}/curve',
  handler: async (request, context) => setCurve(request, context),
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
                    cooling_k_source   AS "coolingKSource",
                    curve_source_run_id AS "curveSourceRunId",
                    curve_source_label AS "curveSourceLabel",
                    curve_updated_at   AS "curveUpdatedAt"
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
 * Replace a furnace's reference curve with points resampled from a measured run.
 *
 * The resampling happens in the browser (src/lib/curveFromRun.js) so the shaping
 * logic stays beside the model it feeds and remains testable under Node; this
 * endpoint receives the finished points. It is the whole curve or nothing —
 * inside one transaction — because a half-replaced curve would derive phases and
 * a cooling fit from two different cycles spliced together, and would look
 * perfectly ordinary while doing it.
 *
 * The run it came from is recorded. Replacing a curve changes the furnace's
 * phases, its cooling constant, its cycle length and therefore every plan it
 * appears in, so where those numbers came from should not be a mystery later.
 */
async function setCurve(request, context) {
  const client = await getPool().connect()
  try {
    const id = request.params.id
    const { points, runId, label } = await request.json()

    if (!Array.isArray(points) || points.length < 3) {
      return json(400, { error: 'at least three curve points are required' })
    }
    const bad = points.find(
      (p) => !Number.isFinite(p?.t) || !Number.isFinite(p?.T) || p.t < 0,
    )
    if (bad) return json(400, { error: 'every point needs a numeric t (hours, >= 0) and T (degrees C)' })

    const sorted = [...points].sort((a, b) => a.t - b.t)
    if (new Set(sorted.map((p) => p.t)).size !== sorted.length) {
      return json(400, { error: 'curve points must have distinct times' })
    }

    const exists = await client.query('SELECT 1 FROM machines WHERE id = $1', [id])
    if (!exists.rowCount) return json(404, { error: `no machine "${id}"` })

    if (runId != null) {
      const r = await client.query('SELECT 1 FROM runs WHERE id = $1 AND machine_id = $2', [runId, id])
      if (!r.rowCount) return json(400, { error: `run ${runId} does not belong to ${id}` })
    }

    await client.query('BEGIN')
    await client.query('DELETE FROM curve_points WHERE machine_id = $1', [id])

    const values = []
    const placeholders = sorted.map((p, j) => {
      const b = j * 3
      values.push(id, p.t, p.T)
      return `($${b + 1},$${b + 2},$${b + 3})`
    })
    await client.query(
      `INSERT INTO curve_points (machine_id, t_hours, temp_c) VALUES ${placeholders.join(',')}`,
      values,
    )

    await client.query(
      `UPDATE machines SET curve_source_run_id = $2, curve_source_label = $3,
              curve_updated_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, runId ?? null, String(label || '').slice(0, 300) || null],
    )
    await client.query('COMMIT')

    return json(200, {
      id,
      points: sorted.length,
      runId: runId ?? null,
      warnings: [
        'Phases, the cooling fit, cycle time and batch capacity are all derived from this curve, so every plan for this furnace changes.',
      ],
    })
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* the connection may already be gone */
    }
    context.error('curve replace failed', err)
    return json(500, { error: 'could not replace the curve', reason: String(err.message || err).slice(0, 300) })
  } finally {
    client.release()
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
