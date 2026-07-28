/**
 * Production scheduler for the GO-film line.
 *
 * The line is two stages deep:
 *
 *     GO film ──► Carbonization (F3, F4) ──► Graphitization (F1, F2, F5, F6) ──► GF
 *
 * A batch occupies one furnace for a full cycle:
 *
 *     load ──► heat ──► hold ──► cool ──► unload
 *     └ 1 h ┘  └──── element is ON ────┘         └ 1 h ┘
 *
 * Heating and soaking come from the measured workbook curve; the cooling leg is
 * modelled with each furnace's own Newton constant (see cooling.js), so the
 * cycle length reacts to the cooling parameters an operator tunes on the
 * Machines tab.
 *
 * Constraints come from the workbook's Rules sheet, not from constants here:
 *   - pairs of furnaces that may not have their elements on at the same time
 *   - the load time before heating and the unload time after cooling
 *
 * Scheduling is greedy, earliest-completion-first. That is not provably optimal,
 * but with six furnaces and a hard two-stage dependency it lands on the same
 * answer as an exhaustive search in every case tested, and it stays fast enough
 * to re-run on every keystroke.
 */

import { defaultParams, hoursToTemp } from './cooling.js'

const EPS = 1e-6

export const isCarbonization = (m) => m.function.toLowerCase().startsWith('carb')

/** The five legs of one cycle, in hours, under the current cooling parameters. */
export function cycleTemplate(machine, params, rules) {
  const p = machine.phases
  const load = rules?.loadHours ?? 0
  const unload = rules?.unloadHours ?? 0
  const modelled = hoursToTemp(machine, params, params.unloadTemp)
  const cool = modelled == null ? p.coolDuration : modelled

  const legs = [
    { key: 'load', hours: load },
    { key: 'heat', hours: p.heatDuration },
    { key: 'hold', hours: p.holdDuration },
    { key: 'cool', hours: cool },
    { key: 'unload', hours: unload },
  ]
  let at = 0
  const offsets = {}
  for (const leg of legs) {
    offsets[leg.key] = { from: at, to: at + leg.hours }
    at += leg.hours
  }

  return {
    legs,
    offsets,
    load,
    heat: p.heatDuration,
    hold: p.holdDuration,
    cool,
    unload,
    // the element is on from the end of loading to the end of the soak
    powerFrom: offsets.heat.from,
    powerTo: offsets.hold.to,
    total: at,
  }
}

/**
 * Collapse the pairwise "cannot heat at the same time" rules into the groups
 * they actually describe.
 *
 * The sheet states constraints one pair at a time, but three rules covering
 * F1/F2, F1/F3 and F2/F3 are really one statement: *those three furnaces share
 * something* — a supply, a flue, an operator — and only one of them can be on
 * at a time. Reporting the six pairs back to an operator hides that; reporting
 * two groups of three explains why the line behaves the way it does.
 *
 * Connected components over the exclusivity graph.
 */
export function heatingGroups(rules) {
  const adj = new Map()
  const touch = (id) => adj.get(id) || adj.set(id, new Set()).get(id)
  for (const g of rules?.exclusiveHeating || []) {
    for (const a of g.machines) {
      touch(a)
      for (const b of g.machines) if (a !== b) adj.get(a).add(b)
    }
  }

  const seen = new Set()
  const groups = []
  for (const id of adj.keys()) {
    if (seen.has(id)) continue
    const stack = [id]
    const members = []
    seen.add(id)
    while (stack.length) {
      const cur = stack.pop()
      members.push(cur)
      for (const n of adj.get(cur) || []) if (!seen.has(n)) (seen.add(n), stack.push(n))
    }
    // A group is only *fully* exclusive if every pair inside it is ruled out;
    // otherwise it is a chain and some members may still overlap.
    const complete = members.every((a) => members.every((b) => a === b || adj.get(a).has(b)))
    groups.push({ machines: members.sort(), complete })
  }
  return groups
}

/** Peers a furnace may not heat alongside, from the Rules sheet. */
function peersOf(machineId, groups) {
  const peers = new Set()
  for (const g of groups || []) {
    if (g.machines.includes(machineId)) {
      for (const other of g.machines) if (other !== machineId) peers.add(other)
    }
  }
  return peers
}

/**
 * Push `start` later until this furnace's power-on window clears every window
 * already booked by a furnace it may not heat with.
 */
function clearExclusivity(start, tpl, peers, windowsByMachine) {
  if (!peers.size) return start
  const booked = []
  for (const p of peers) booked.push(...(windowsByMachine.get(p) || []))
  if (!booked.length) return start

  let est = start
  for (let guard = 0; guard < 5000; guard++) {
    const from = est + tpl.powerFrom
    const to = est + tpl.powerTo
    const clash = booked.find((w) => w.from < to - EPS && from < w.to - EPS)
    if (!clash) return est
    est = clash.to - tpl.powerFrom
  }
  return est
}

/**
 * Earliest time at which `need` holders of carbonized material are in stock.
 * `arrivals` is the sorted list of carbonization completions.
 */
function wipReadyAt(need, arrivals, consumed, from) {
  if (need <= 0) return from
  let have = -consumed
  for (const a of arrivals) {
    have += a.holders
    if (have >= need - EPS) return Math.max(from, a.t)
  }
  return null // never enough, no matter how long we wait
}

/**
 * Plan production.
 *
 * @param {object}   opts
 * @param {object[]} opts.machines        machines from machines.json
 * @param {object}   opts.rules           rules block from machines.json
 * @param {string[]} opts.availableIds    furnaces the planner may use
 * @param {Function} opts.paramsFor       machine -> cooling parameters
 * @param {'window'|'target'} opts.mode   fixed time window, or run until a target
 * @param {number}   opts.horizonHours    length of the window (mode 'window')
 * @param {number}   opts.targetGrams     GF wanted (mode 'target')
 * @param {number}   opts.startWipHolders carbonized holders already in stock at t=0
 * @param {boolean}  opts.chain           carbonization must feed graphitization
 * @param {number}   opts.maxHours        hard stop so 'target' can't run away
 */
export function planProduction({
  machines,
  rules,
  availableIds,
  paramsFor = defaultParams,
  mode = 'window',
  horizonHours = 24 * 7,
  targetGrams = 0,
  startWipHolders = 0,
  chain = true,
  maxHours = 24 * 365,
}) {
  const pool = machines.filter((m) => availableIds.includes(m.id))
  const templates = new Map(pool.map((m) => [m.id, cycleTemplate(m, paramsFor(m), rules)]))
  const carb = pool.filter(isCarbonization)
  const graph = pool.filter((m) => !isCarbonization(m))

  const warnings = []
  const ceiling = mode === 'window' ? horizonHours : maxHours

  if (!graph.length) {
    warnings.push('No graphitization furnace selected — GF output will be zero.')
  }
  if (chain && !carb.length && startWipHolders <= 0) {
    warnings.push(
      'No carbonization furnace selected and no carbonized stock on hand — graphitization has nothing to run.',
    )
  }

  const freeAt = new Map(pool.map((m) => [m.id, 0]))
  const windowsByMachine = new Map(pool.map((m) => [m.id, []]))
  const arrivals = [] // carbonization completions, kept sorted by time
  if (startWipHolders > 0) arrivals.push({ t: 0, holders: startWipHolders })

  const batchCount = new Map(pool.map((m) => [m.id, 0]))
  const batches = []
  let consumedHolders = 0
  let gfGrams = 0
  let seq = 0

  for (let guard = 0; guard < 2000; guard++) {
    let best = null

    for (const m of pool) {
      const tpl = templates.get(m.id)
      if (tpl.total <= 0) continue

      let est = freeAt.get(m.id)

      // graphitization can't start loading before its feedstock exists
      if (chain && !isCarbonization(m)) {
        const ready = wipReadyAt(m.holders, arrivals, consumedHolders, est)
        if (ready == null) continue
        est = ready
      }

      est = clearExclusivity(est, tpl, peersOf(m.id, rules?.exclusiveHeating), windowsByMachine)

      const end = est + tpl.total
      if (end > ceiling + EPS) continue

      const cand = { machine: m, tpl, start: est, end }
      // Earliest finish wins. On a tie, prefer the bigger furnace — feedstock is
      // usually the scarce thing, so the same holders are worth more in a
      // 3-holder furnace — and then the furnace that has run least, which
      // spreads wear instead of hammering whichever one sorts first.
      if (
        !best ||
        (Math.abs(cand.end - best.end) > EPS
          ? cand.end < best.end
          : cand.machine.holders !== best.machine.holders
            ? cand.machine.holders > best.machine.holders
            : batchCount.get(cand.machine.id) !== batchCount.get(best.machine.id)
              ? batchCount.get(cand.machine.id) < batchCount.get(best.machine.id)
              : cand.start < best.start - EPS)
      ) {
        best = cand
      }
    }

    if (!best) break

    const { machine: m, tpl, start, end } = best
    const carbBatch = isCarbonization(m)
    const out = carbBatch ? 0 : m.holders * (m.gfPerHolder || 0) * (m.yield ?? 1)

    batches.push({
      id: `${m.id}-${seq++}`,
      machineId: m.id,
      machineName: m.name,
      stage: carbBatch ? 'carbonization' : 'graphitization',
      holders: m.holders,
      start,
      end,
      powerFrom: start + tpl.powerFrom,
      powerTo: start + tpl.powerTo,
      legs: tpl.legs.map((leg) => ({
        key: leg.key,
        from: start + tpl.offsets[leg.key].from,
        to: start + tpl.offsets[leg.key].to,
      })),
      gfGrams: out,
    })

    freeAt.set(m.id, end)
    batchCount.set(m.id, batchCount.get(m.id) + 1)
    windowsByMachine.get(m.id).push({ from: start + tpl.powerFrom, to: start + tpl.powerTo })

    if (carbBatch) {
      arrivals.push({ t: end, holders: m.holders })
      arrivals.sort((a, b) => a.t - b.t)
    } else {
      if (chain) consumedHolders += m.holders
      gfGrams += out
    }

    if (mode === 'target' && gfGrams >= targetGrams - EPS) break
  }

  batches.sort((a, b) => a.start - b.start || a.machineName.localeCompare(b.machineName))

  const finishHours = batches.length ? Math.max(...batches.map((b) => b.end)) : 0
  const span = mode === 'window' ? horizonHours : finishHours

  const perMachine = pool.map((m) => {
    const mine = batches.filter((b) => b.machineId === m.id)
    const busy = mine.reduce((a, b) => a + (b.end - b.start), 0)
    return {
      id: m.id,
      name: m.name,
      stage: isCarbonization(m) ? 'carbonization' : 'graphitization',
      batches: mine.length,
      busyHours: busy,
      utilization: span > 0 ? busy / span : 0,
      cycleHours: templates.get(m.id).total,
      holders: m.holders,
    }
  })

  const carbHolders = batches
    .filter((b) => b.stage === 'carbonization')
    .reduce((a, b) => a + b.holders, 0)
  const graphHolders = batches
    .filter((b) => b.stage === 'graphitization')
    .reduce((a, b) => a + b.holders, 0)

  const util = (stage) => {
    const rows = perMachine.filter((r) => r.stage === stage)
    return rows.length ? rows.reduce((a, r) => a + r.utilization, 0) / rows.length : 0
  }
  const carbUtil = util('carbonization')
  const graphUtil = util('graphitization')

  // How saturated is each shared-power group? With mutually exclusive furnaces
  // this is usually the real constraint, not the stage utilisation.
  const groupLoad = heatingGroups(rules)
    .map((g) => {
      const members = g.machines.filter((id) => pool.some((m) => m.id === id))
      if (!members.length) return null
      const on = batches
        .filter((b) => members.includes(b.machineId))
        .reduce((a, b) => a + (b.powerTo - b.powerFrom), 0)
      return {
        machines: members,
        names: members.map((id) => machines.find((m) => m.id === id)?.name || id),
        complete: g.complete,
        heatingHours: on,
        utilization: span > 0 ? on / span : 0,
      }
    })
    .filter(Boolean)

  const reachedTarget = mode === 'target' ? gfGrams >= targetGrams - EPS : true
  if (mode === 'target' && !reachedTarget) {
    warnings.push(
      `Could not reach the target within ${Math.round(maxHours / 24)} days — the selected furnaces cap out below it.`,
    )
  }
  const leftoverWip = startWipHolders + carbHolders - graphHolders
  if (chain && leftoverWip > 0 && batches.length) {
    warnings.push(
      `${leftoverWip} holder(s) of carbonized material are left in stock at the end — carbonization ran ahead of graphitization.`,
    )
  }
  for (const r of rules?.raw || []) {
    if (!r.parsed) warnings.push(`Rule not enforced (not understood by the parser): "${r.text}"`)
  }

  return {
    mode,
    batches,
    perMachine,
    groupLoad,
    warnings,
    finishHours,
    horizonHours: span,
    reachedTarget,
    totals: {
      gfGrams,
      batches: batches.length,
      carbBatches: batches.filter((b) => b.stage === 'carbonization').length,
      graphBatches: batches.filter((b) => b.stage === 'graphitization').length,
      holdersCarbonized: carbHolders,
      holdersGraphitized: graphHolders,
      leftoverWip,
      gfPerDay: span > 0 ? (gfGrams / span) * 24 : 0,
    },
    bottleneck:
      !carb.length || !graph.length
        ? null
        : carbUtil >= graphUtil
          ? { stage: 'carbonization', utilization: carbUtil, other: graphUtil }
          : { stage: 'graphitization', utilization: graphUtil, other: carbUtil },
  }
}

/** Stock of carbonized material over time — drawn under the Gantt. */
export function wipSeries(result, startWipHolders = 0) {
  const events = []
  for (const b of result.batches) {
    if (b.stage === 'carbonization') events.push({ t: b.end, d: b.holders })
    else events.push({ t: b.start, d: -b.holders })
  }
  events.sort((a, b) => a.t - b.t)

  const out = [{ t: 0, holders: startWipHolders }]
  let have = startWipHolders
  for (const e of events) {
    out.push({ t: e.t, holders: have })
    have += e.d
    out.push({ t: e.t, holders: have })
  }
  out.push({ t: result.horizonHours, holders: have })
  return out
}
