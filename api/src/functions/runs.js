/**
 * Imported furnace runs.
 *
 * One app.http() registration per ROUTE, dispatching on method inside — see the
 * note in machines.js. `runs` was previously registered twice, once for GET and
 * once for POST; the second registration was dropped and every import silently
 * failed to reach a handler.
 *
 * The CSV is parsed in the browser by src/lib/runImport.js — the same module the
 * tests exercise under Node — so this endpoint receives already-segmented runs
 * rather than a file. That keeps one implementation of the parsing and the
 * cooling fit, and lets the person importing see what was found before anything
 * is written.
 */
const { app } = require('@azure/functions')
const { getPool, query } = require('../db')

const json = (status, body) => ({ status, jsonBody: body })

/** Postgres caps a statement at 65535 parameters; 9 columns means ~7000 rows. */
const BATCH_ROWS = 500

app.http('runs', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'runs',
  handler: async (request, context) => {
    if (request.method === 'POST') return importRun(request, context)
    return listRuns(request, context)
  },
})

app.http('runById', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'runs/{id}',
  handler: async (request, context) => {
    try {
      const id = Number(request.params.id)
      if (!Number.isInteger(id)) return json(400, { error: 'run id must be an integer' })
      const res = await query('DELETE FROM runs WHERE id = $1', [id])
      if (!res.rowCount) return json(404, { error: `no run ${id}` })
      return json(200, { id, deleted: true })
    } catch (err) {
      context.error('run delete failed', err)
      return json(500, { error: 'delete failed', reason: String(err.message || err).slice(0, 200) })
    }
  },
})

app.http('runSamples', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'runs/{id}/samples',
  handler: async (request, context) => {
    if (request.method === 'POST') return appendSamples(request, context)
    try {
      const id = Number(request.params.id)
      if (!Number.isInteger(id)) return json(400, { error: 'run id must be an integer' })

      // The whole run comes back in one go — a few thousand rows — so the viewer
      // can re-scale and zoom without another round trip. Decimation for display
      // happens in the browser, where it can follow the zoom level.
      const { rows } = await query(
        `SELECT at,
                temp_a::float8     AS "tempA",
                temp_b::float8     AS "tempB",
                temp_c::float8     AS "tempC",
                set_temp::float8   AS "setTemp",
                vacuum::float8     AS "vacuum",
                pressure::float8   AS "pressure",
                water_temp::float8 AS "waterTemp"
         FROM run_samples WHERE run_id = $1 ORDER BY at`,
        [id],
      )
      return json(200, { runId: id, count: rows.length, samples: rows })
    } catch (err) {
      context.error('run samples failed', err)
      return json(503, { error: 'could not read samples', reason: String(err.message || err).slice(0, 200) })
    }
  },
})

// --------------------------------------------------------------------------

async function listRuns(request, context) {
  try {
    const machineId = request.query.get('machineId')
    const { rows } = await query(
      `SELECT r.id::int AS id, r.machine_id AS "machineId", m.name AS "machineName",
              r.started_at AS "startedAt", r.ended_at AS "endedAt",
              r.sample_count AS "sampleCount",
              r.peak_temp_c::float8 AS "peakTempC",
              r.set_point_c::float8 AS "setPointC",
              r.heat_off_at AS "heatOffAt",
              r.fitted_k::float8 AS "fittedK",
              r.fit_rmse_c::float8 AS "fitRmseC",
              r.fit_points AS "fitPoints",
              r.source_file AS "sourceFile", r.imported_at AS "importedAt", r.note
       FROM runs r JOIN machines m ON m.id = r.machine_id
       ${machineId ? 'WHERE r.machine_id = $1' : ''}
       ORDER BY r.started_at DESC`,
      machineId ? [machineId] : [],
    )
    return json(200, { runs: rows })
  } catch (err) {
    context.error('runs list failed', err)
    return json(503, { error: 'could not read runs', reason: String(err.message || err).slice(0, 200) })
  }
}

/**
 * Create (or find) a run, without its samples.
 *
 * Samples arrive separately, in chunks, via POST runs/{id}/samples. A run of
 * seven thousand 30-second samples in one request is a body approaching a
 * megabyte and a request lasting tens of seconds, with nothing to show the
 * person waiting and nothing to resume from if it does not finish. Splitting it
 * makes each request small, gives the UI real progress, and makes a partial
 * import something to continue rather than something to undo.
 *
 * Idempotent: re-importing the same export returns the existing run and the
 * number of samples it already has, so the client can carry on where it stopped.
 */
async function importRun(request, context) {
  try {
    const { machineId, run } = await request.json()
    if (!machineId || !run?.startedAt) {
      return json(400, { error: 'machineId and a run with startedAt are required' })
    }

    const exists = await query('SELECT 1 FROM machines WHERE id = $1', [machineId])
    if (!exists.rowCount) return json(404, { error: `no machine "${machineId}"` })

    const ins = await query(
      `INSERT INTO runs (machine_id, started_at, ended_at, sample_count, peak_temp_c,
                         set_point_c, heat_off_at, fitted_k, fit_rmse_c, fit_points, source_file, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (machine_id, started_at) DO UPDATE SET
         ended_at = excluded.ended_at,
         sample_count = excluded.sample_count,
         peak_temp_c = excluded.peak_temp_c,
         set_point_c = excluded.set_point_c,
         heat_off_at = excluded.heat_off_at,
         fitted_k = excluded.fitted_k,
         fit_rmse_c = excluded.fit_rmse_c,
         fit_points = excluded.fit_points,
         source_file = excluded.source_file
       RETURNING id::int AS id, (xmax = 0) AS created`,
      [machineId, run.startedAt, run.endedAt, run.sampleCount ?? 0, run.peakTempC,
       run.setPointC, run.heatOffAt || null, run.fit?.k ?? null, run.fit?.rmse ?? null,
       run.fit?.points ?? null, run.sourceFile || null, run.note || null],
    )

    const runId = ins.rows[0].id
    const have = await query('SELECT count(*)::int AS n FROM run_samples WHERE run_id = $1', [runId])

    return json(ins.rows[0].created ? 201 : 200, {
      runId,
      created: ins.rows[0].created,
      existingSamples: have.rows[0].n,
    })
  } catch (err) {
    context.error('run create failed', err)
    return json(500, { error: 'could not create the run', reason: String(err.message || err).slice(0, 300) })
  }
}

/**
 * Append a chunk of samples to a run.
 *
 * ON CONFLICT DO NOTHING on (run_id, at) makes a re-sent chunk a no-op, so a
 * retry or a resume can send everything again without duplicating anything.
 */
async function appendSamples(request, context) {
  try {
    const runId = Number(request.params.id)
    if (!Number.isInteger(runId)) return json(400, { error: 'run id must be an integer' })

    const { samples } = await request.json()
    if (!Array.isArray(samples) || !samples.length) {
      return json(400, { error: 'samples are required' })
    }
    if (samples.length > 2000) {
      return json(413, { error: 'send at most 2000 samples per request' })
    }

    const exists = await query('SELECT 1 FROM runs WHERE id = $1', [runId])
    if (!exists.rowCount) return json(404, { error: `no run ${runId}` })

    let inserted = 0
    for (let i = 0; i < samples.length; i += BATCH_ROWS) {
      const chunk = samples.slice(i, i + BATCH_ROWS)
      const values = []
      const placeholders = chunk.map((s, j) => {
        const b = j * 9
        values.push(runId, s.at, s.tempA, s.tempB, s.tempC, s.setTemp, s.vacuum, s.pressure, s.waterTemp)
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`
      })
      const res = await query(
        `INSERT INTO run_samples (run_id, at, temp_a, temp_b, temp_c, set_temp, vacuum, pressure, water_temp)
         VALUES ${placeholders.join(',')}
         ON CONFLICT DO NOTHING`,
        values,
      )
      inserted += res.rowCount || 0
    }

    const total = await query('SELECT count(*)::int AS n FROM run_samples WHERE run_id = $1', [runId])
    return json(200, { runId, inserted, total: total.rows[0].n })
  } catch (err) {
    context.error('sample append failed', err)
    return json(500, { error: 'could not store samples', reason: String(err.message || err).slice(0, 300) })
  }
}
