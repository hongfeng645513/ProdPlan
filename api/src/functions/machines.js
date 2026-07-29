/**
 * Read-only source data for the planner.
 *
 * This endpoint returns SOURCE rows only — specs, measured curve points, rule
 * sentences, current ratings. It deliberately computes nothing: the phase
 * boundaries, the Newton cooling fit, the batch capacity and the parsed rules
 * are all derived in the browser by src/lib/derive.js.
 *
 * Keeping the modelling out of here means there is exactly one implementation
 * of it, in one language, reachable by `npm run check` under bare Node. An API
 * that also derived would be a second copy to keep in step, and the failure
 * mode of a drifted copy is a plan that looks perfectly reasonable and is wrong.
 */
const { app } = require('@azure/functions')
const { query } = require('../db')

app.http('ping', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'ping',
  handler: async () => ({ jsonBody: { ok: true, service: 'prodplan-api' } }),
})

app.http('machines', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'machines',
  handler: async (request, context) => {
    try {
      // numeric columns are cast to float8 on the way out. node-postgres hands
      // back `numeric` as a STRING to avoid precision loss, and a string that
      // looks like a number will sail through JSON and then quietly corrupt
      // every calculation downstream.
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
      // The frontend falls back to its bundled snapshot when this fails, so a
      // clear status matters more than a clever recovery here.
      context.error('failed to read source data', err)
      return { status: 503, jsonBody: { error: 'database unavailable' } }
    }
  },
})
