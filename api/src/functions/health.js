/**
 * Anonymous health check.
 *
 * The frontend falls back to its bundled snapshot when /api/machines fails,
 * silently and by design — which means a broken database connection renders
 * identically to a working one. That is good for availability and terrible for
 * knowing whether the migration actually did anything.
 *
 * This endpoint answers that question from the server side. It runs the SAME
 * four queries /api/machines runs, so it exercises the real code path rather
 * than a simplified one, but returns only row counts. No machine specs, no
 * curves, no rules — nothing worth authenticating to protect, which is why it
 * can stay anonymous while everything else requires the planner role.
 */
const { app } = require('@azure/functions')
const { query } = require('../db')

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: async (request, context) => {
    const started = Date.now()
    try {
      const [machines, points, rules, equipment] = await Promise.all([
        query(`SELECT id, name, model, function, holders,
                      gf_size            AS "gfSize",
                      gf_per_holder::float8 AS "gfPerHolder",
                      yield::float8      AS "yield",
                      has_open_marker    AS "hasOpenMarker"
               FROM machines ORDER BY name`),
        query(`SELECT machine_id AS "machineId", t_hours::float8 AS t, temp_c::float8 AS "T"
               FROM curve_points ORDER BY machine_id, t_hours`),
        query('SELECT text FROM rules ORDER BY id'),
        query(`SELECT id, name, max_amps::float8 AS "maxAmps", rated, needs_input AS "needsInput"
               FROM equipment ORDER BY id`),
      ])

      // A curve point count per machine is enough to spot a partial seed
      // without disclosing the curve itself.
      const perMachine = {}
      for (const p of points.rows) {
        perMachine[p.machineId] = (perMachine[p.machineId] || 0) + 1
      }

      // Which tables actually exist. A migration that was never applied looks
      // from the outside exactly like a bug in the feature that needs it, so
      // report it here rather than leave it to be inferred from a 500.
      const tables = await query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' ORDER BY table_name`,
      )
      const present = tables.rows.map((r) => r.table_name)
      const missing = ['machines', 'curve_points', 'rules', 'equipment', 'runs', 'run_samples'].filter(
        (t) => !present.includes(t),
      )

      let runCounts = null
      if (!missing.includes('runs')) {
        const r = await query(
          `SELECT (SELECT count(*)::int FROM runs) AS runs,
                  (SELECT count(*)::int FROM run_samples) AS samples`,
        )
        runCounts = r.rows[0]
      }

      return {
        jsonBody: {
          ok: true,
          database: 'reachable',
          source: 'postgres',
          counts: {
            machines: machines.rows.length,
            curvePoints: points.rows.length,
            rules: rules.rows.length,
            equipment: equipment.rows.length,
          },
          curvePointsPerMachine: perMachine,
          tables: present,
          missingTables: missing,
          schemaComplete: missing.length === 0,
          runs: runCounts,
          elapsedMs: Date.now() - started,
        },
      }
    } catch (err) {
      context.error('health check failed', err)
      return {
        status: 503,
        jsonBody: {
          ok: false,
          database: 'unreachable',
          // The message names the failure mode (auth, timeout, missing table)
          // without echoing the connection string back out.
          reason: String(err.message || err).slice(0, 200),
          elapsedMs: Date.now() - started,
        },
      }
    }
  },
})
