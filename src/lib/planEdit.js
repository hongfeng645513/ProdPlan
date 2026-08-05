/**
 * Hand-adjusting a generated plan.
 *
 * The scheduler places batches greedily and never produces a plan that breaks a
 * rule. Once someone drags a batch, that guarantee is gone — so the point of
 * this module is to say precisely what an edit broke, rather than to stop the
 * edit happening.
 *
 * That choice is deliberate. A planner who moves a batch usually knows something
 * the model does not: a shift pattern, a delivery, an engineer on site on
 * Tuesday. Refusing the move would make the tool argue with the person using it.
 * But letting a plan quietly violate the constraints it exists to enforce would
 * be worse than not having them, so every edited plan is re-checked from
 * scratch and every violation is named.
 *
 * Edits are held as a sparse map of batch id -> {start, machineId}. The original
 * plan is never mutated: clearing the map restores exactly what the scheduler
 * produced.
 */
import { cycleTemplate, isCarbonization } from './schedule.js'
import { simulate } from './power.js'

const EPS = 1e-6

/**
 * Rebuild the batch list with edits applied.
 *
 * A moved batch is re-derived rather than shifted: its legs, its power window
 * and — if it changed furnace — its output all follow from the machine and the
 * start time, so recomputing is both simpler and safer than patching offsets.
 */
export function applyEdits({ result, machines, rules, paramsFor, edits }) {
  if (!edits || !Object.keys(edits).length) {
    return { batches: result.batches, edited: [], templates: templatesFor(result, machines, rules, paramsFor) }
  }
  const templates = templatesFor(result, machines, rules, paramsFor)
  const edited = []

  const batches = result.batches.map((b) => {
    const edit = edits[b.id]
    if (!edit) return b

    const machine = machines.find((m) => m.id === (edit.machineId ?? b.machineId))
    if (!machine) return b
    const tpl = templates.get(machine.id) || cycleTemplate(machine, paramsFor(machine), rules)
    const start = Math.max(0, edit.start ?? b.start)
    const carb = isCarbonization(machine)

    edited.push(b.id)
    return {
      ...b,
      machineId: machine.id,
      machineName: machine.name,
      stage: carb ? 'carbonization' : 'graphitization',
      holders: machine.holders,
      start,
      end: start + tpl.total,
      powerFrom: start + tpl.powerFrom,
      powerTo: start + tpl.powerTo,
      legs: tpl.legs.map((leg) => ({
        key: leg.key,
        from: start + tpl.offsets[leg.key].from,
        to: start + tpl.offsets[leg.key].to,
      })),
      gfGrams: carb ? 0 : machine.holders * (machine.gfPerHolder || 0) * (machine.yield ?? 1),
      moved: true,
    }
  })

  batches.sort((a, b) => a.start - b.start || a.machineName.localeCompare(b.machineName))
  return { batches, edited, templates }
}

function templatesFor(result, machines, rules, paramsFor) {
  const ids = new Set(result.perMachine.map((r) => r.id))
  return new Map(
    machines.filter((m) => ids.has(m.id)).map((m) => [m.id, cycleTemplate(m, paramsFor(m), rules)]),
  )
}

/**
 * Check an edited plan against every constraint the scheduler enforces while
 * building one.
 *
 * Returns a flat list rather than throwing: an edit can break several things at
 * once, and being told only the first would make fixing it a guessing game.
 */
export function validatePlan({ batches, machines, rules, power, electricity, startWipHolders = 0, horizonHours }) {
  const violations = []
  const nameOf = (id) => machines.find((m) => m.id === id)?.name || id

  // 1. A furnace cannot run two batches at once.
  for (const m of new Set(batches.map((b) => b.machineId))) {
    const mine = batches.filter((b) => b.machineId === m).sort((a, b) => a.start - b.start)
    for (let i = 1; i < mine.length; i++) {
      if (mine[i].start < mine[i - 1].end - EPS) {
        violations.push({
          kind: 'overlap',
          batchIds: [mine[i - 1].id, mine[i].id],
          message: `${nameOf(m)} would be running two batches at once from ${hh(mine[i].start)}.`,
        })
      }
    }
  }

  // 2. Furnaces that may not have their elements on together.
  for (const g of rules?.exclusiveHeating || []) {
    const [a, b] = g.machines
    for (const x of batches.filter((t) => t.machineId === a)) {
      for (const y of batches.filter((t) => t.machineId === b)) {
        if (x.powerFrom < y.powerTo - EPS && y.powerFrom < x.powerTo - EPS) {
          violations.push({
            kind: 'exclusive',
            batchIds: [x.id, y.id],
            message: `${nameOf(a)} and ${nameOf(b)} would be heating together from ${hh(Math.max(x.powerFrom, y.powerFrom))} — the rules forbid it.`,
          })
        }
      }
    }
  }

  // 3. Graphitization cannot consume carbonized material before it exists.
  //
  // Material arriving at exactly time t may be loaded at t, so arrivals settle
  // before consumption when the timestamps tie.
  const events = batches.map((b) =>
    b.stage === 'carbonization'
      ? { t: b.end, d: +b.holders, id: b.id }
      : { t: b.start, d: -b.holders, id: b.id },
  )
  events.sort((x, y) => x.t - y.t || y.d - x.d)
  let stock = startWipHolders
  for (const e of events) {
    stock += e.d
    if (stock < -EPS) {
      violations.push({
        kind: 'feedstock',
        batchIds: [e.id],
        message: `At ${hh(e.t)} this batch would load ${Math.abs(e.d)} holder(s) of carbonized material that has not been made yet.`,
      })
      stock = 0 // report the first shortfall per gap, not every batch after it
    }
  }

  // 4. The site current limit.
  if (electricity && Number.isFinite(power?.capAmps)) {
    const over = electricity.steps.filter((s) => s.total > power.capAmps + 1e-3)
    if (over.length) {
      const peak = Math.max(...over.map((s) => s.total))
      violations.push({
        kind: 'current',
        batchIds: [],
        message: `Draw reaches ${Math.round(peak)} A against a ${Math.round(power.capAmps)} A limit, for ${round1(over.reduce((a, s) => a + (s.to - s.from), 0))} h.`,
      })
    }
  }

  // 5. Anything pushed past the end of the window simply is not in the plan.
  if (horizonHours != null) {
    for (const b of batches) {
      if (b.end > horizonHours + EPS) {
        violations.push({
          kind: 'horizon',
          batchIds: [b.id],
          message: `${b.machineName} finishes at ${hh(b.end)}, past the end of the planning window.`,
        })
      }
    }
  }

  return violations
}

/** Recompute the load profile for an edited plan. */
export function electricityFor({ batches, machines, templates, resolved, horizonHours }) {
  if (!resolved) return null
  const pool = machines.filter((m) => templates.has(m.id))
  return simulate({ batches, machines: pool, templates, resolved, horizonHours })
}

/** Totals, recomputed so the summary matches what is on screen. */
export function totalsFor(batches, horizonHours) {
  const gfGrams = batches.reduce((a, b) => a + (b.gfGrams || 0), 0)
  const carb = batches.filter((b) => b.stage === 'carbonization')
  const graph = batches.filter((b) => b.stage === 'graphitization')
  return {
    gfGrams,
    batches: batches.length,
    carbBatches: carb.length,
    graphBatches: graph.length,
    holdersCarbonized: carb.reduce((a, b) => a + b.holders, 0),
    holdersGraphitized: graph.reduce((a, b) => a + b.holders, 0),
    gfPerDay: horizonHours > 0 ? (gfGrams / horizonHours) * 24 : 0,
  }
}

const hh = (h) => `${Math.floor(h)} h`
const round1 = (x) => Math.round(x * 10) / 10
