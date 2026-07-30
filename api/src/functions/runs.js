/**
 * Imported furnace runs.
 *
 * The CSV is parsed in the browser by src/lib/runImport.js — the same module the
 * tests exercise under Node — so this endpoint receives already-segmented runs
 * rather than a file. That keeps one implementation of the parsing and the
 * cooling fit, and it lets the person importing see what was found *before*
 * anything is written.
 *
 * Samples are inserted in batches. A run is a few thousand rows at 30-second
 * resolution, and one INSERT per row against a two-connection pool on a
 * Burstable server is slow enough to time out the request.
 */
const { app } = require('@azure/functions')
const { getPool, query } = require('../db')

const json = (status, body) => ({ status, jsonBody: body })

/** Postgres caps a statement at 65535 parameters; 8 columns means ~8000 rows. */
const BATCH_ROWS = 500

app.http('runsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'runs',
  handler: async (request, context) => {
    try {
      const machineId = request.query.get('machineId')
      const params = machineId ? [machineId] : []
      const { rows } = await query(
        `SELECT r.id, r.machine_id AS "machineId", m.name AS "machineName",
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
        params,
      )
      return json(200, { runs: rows })
    } catch (err) {
      context.error('runs list failed', err)
      return json(503, { error: 'could not read runs', reason: String(err.message || err).slice(0, 200) })
    }
  },
})

app.http('runSamples', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'runs/{id}/samples',
  handler: async (request, context) => {
    try {
      const id = Number(request.params.id)
      if (!Number.isInteger(id)) return json(400, { error: 'run id must be an integer' })

      // The whole run is returned in one go — a few thousand rows — so the
      // viewer can re-scale and zoom without another round trip. Decimation for
      // display happens in the browser, where it can follow the zoom level.
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

app.http('runImport', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'runs',
  handler: async (request, context) => {
    const pool = getPool()
    const client = await pool.connect()
    try {
      const body = await request.json()
      const { machineId, run } = body
      if (!machineId || !run?.samples?.length) {
        return json(400, { error: 'machineId and a run with samples are required' })
      }

      const exists = await client.query('SELECT 1 FROM machines WHERE id = $1', [machineId])
      if (!exists.rowCount) return json(404, { error: `no machine "${machineId}"` })

      await client.query('BEGIN')

      // Re-importing the same export is normal — someone exports again to pick
      // up newer runs. The unique constraint makes that idempotent instead of
      // silently doubling a run's samples.
      const ins = await client.query(
        `INSERT INTO runs (machine_id, started_at, ended_at, sample_count, peak_temp_c,
                           set_point_c, heat_off_at, fitted_k, fit_rmse_c, fit_points, source_file, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (machine_id, started_at) DO NOTHING
         RETURNING id`,
        [machineId, run.startedAt, run.endedAt, run.samples.length, run.peakTempC,
         run.setPointC, run.heatOffAt || null, run.fit?.k ?? null, run.fit?.rmse ?? null,
         run.fit?.points ?? null, run.sourceFile || null, run.note || null],
      )

      if (!ins.rowCount) {
        await client.query('ROLLBACK')
        return json(200, { skipped: true, reason: 'this run is already imported' })
      }
      const runId = ins.rows[0].id

      let inserted = 0
      for (let i = 0; i < run.samples.length; i += BATCH_ROWS) {
        const chunk = run.samples.slice(i, i + BATCH_ROWS)
        const values = []
        const placeholders = chunk.map((s, j) => {
          const b = j * 9
          values.push(runId, s.at, s.tempA, s.tempB, s.tempC, s.setTemp, s.vacuum, s.pressure, s.waterTemp)
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`
        })
        const res = await client.query(
          `INSERT INTO run_samples (run_id, at, temp_a, temp_b, temp_c, set_temp, vacuum, pressure, water_temp)
           VALUES ${placeholders.join(',')}
           ON CONFLICT DO NOTHING`,
          values,
        )
        inserted += res.rowCount || 0
      }

      await client.query('COMMIT')
      return json(201, { runId, samples: inserted })
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* the connection may already be gone */
      }
      context.error('run import failed', err)
      return json(500, { error: 'import failed', reason: String(err.message || err).slice(0, 300) })
    } finally {
      client.release()
    }
  },
})

app.http('runDelete', {
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
      return json(500, { error: 'delete failed' })
    }
  },
})

/**
 * Apply (or clear) a measured cooling constant for a machine.
 *
 * This is stored, unlike everything else derived, because it is a decision: a
 * person judged a refit from real runs to be a better description of the furnace
 * than the reference curve's fit. `cooling_k_source` records where it came from
 * so the choice is auditable rather than an unexplained number.
 */
app.http('coolingOverride', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'machines/{id}/cooling',
  handler: async (request, context) => {
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
      context.error('cooling override failed', err)
      return json(500, { error: 'could not set the cooling constant' })
    }
  },
})
