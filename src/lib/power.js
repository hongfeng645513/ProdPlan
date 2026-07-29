/**
 * Electricity model for the line.
 *
 * The Electricity sheet gives a maximum current per piece of plant. That is a
 * rating, not a schedule — what the site actually draws at any moment depends on
 * which furnaces have their elements on, which support plant those furnaces drag
 * along with them, and whether the coating line is up. This module turns a plan
 * into that draw, hour by hour, and gives the scheduler a way to ask "can this
 * batch start here without going over the site limit?".
 *
 * Four kinds of load, and they behave differently:
 *
 *   baseline   R&D and Facility. Nobody has measured these — the sheet says
 *              "Unknown" — so the operator types them in and they sit under
 *              everything else for the whole horizon.
 *
 *   furnace    Drawn on the heating ramp only. Once the set point is reached
 *              the element is not what the current limit is about any more, and
 *              during natural cooling the furnace draws nothing at all.
 *
 *   support    Cooling and vacuum systems. Tied to the furnaces they serve, and
 *              counted ONCE however many of those furnaces are running: one
 *              cooling system serving three furnaces is still one motor. This is
 *              the part a naive per-batch sum gets wrong.
 *
 *   coating    Runs continuously by choice ("as much as possible"), 200 A for
 *              its first two hours and 100 A after. Losing it costs another
 *              two-hour warm-up, so it is modelled as a state machine rather
 *              than a flat load.
 *
 * A rating the sheet leaves blank is counted as 0 A, never guessed. Guessing
 * would quietly raise the ceiling, which is the one thing a current limit exists
 * to stop.
 */

const EPS = 1e-6

export const BASELINE_INPUT_IDS = ['r-d', 'facility']

/** Load bands, in the order they stack in the chart and the table. */
export const LOAD_KINDS = [
  { key: 'baseline', label: 'R&D + facility' },
  { key: 'support', label: 'Cooling + vacuum' },
  { key: 'coating', label: 'Coating line' },
  { key: 'furnace', label: 'Furnaces (heating)' },
]

const sum = (xs) => xs.reduce((a, b) => a + b, 0)

/** Merge overlapping intervals — support plant is one motor, not one per user. */
function union(intervals) {
  if (!intervals.length) return []
  const sorted = [...intervals].sort((a, b) => a.from - b.from)
  const out = [{ ...sorted[0] }]
  for (const iv of sorted.slice(1)) {
    const last = out[out.length - 1]
    if (iv.from <= last.to + EPS) last.to = Math.max(last.to, iv.to)
    else out.push({ ...iv })
  }
  return out
}

const covers = (intervals, t) => intervals.some((iv) => t >= iv.from - EPS && t < iv.to - EPS)

/**
 * Fold the workbook's electricity block and the operator's inputs into the
 * numbers the rest of this module works with.
 *
 * `inputs` is what the planner asks for: amps for R&D and Facility, a site
 * maximum, and which of the unscheduled extras (pre-treatment, Furnace 7) are
 * running.
 */
export function resolvePower(power, inputs = {}) {
  const equipment = power?.equipment || []
  const byId = new Map(equipment.map((e) => [e.id, e]))
  const rated = (id) => {
    const e = byId.get(id)
    return e && Number.isFinite(e.maxAmps) ? e.maxAmps : 0
  }

  const baselineParts = []
  for (const id of BASELINE_INPUT_IDS) {
    const e = byId.get(id)
    if (!e) continue
    const a = Number(inputs.baseline?.[id]) || 0
    if (a > 0) baselineParts.push({ id, name: e.name, amps: a })
  }
  for (const e of equipment) {
    if (e.kind !== 'other') continue
    if (inputs.extras?.[e.id]) baselineParts.push({ id: e.id, name: e.name, amps: rated(e.id) })
  }

  // furnace -> the support plant that has to run with it, from the Rules sheet
  const supportFor = new Map()
  for (const s of power?.support || []) {
    for (const m of s.machines) {
      if (!supportFor.has(m)) supportFor.set(m, [])
      supportFor.get(m).push(s.equipment)
    }
  }

  const c = power?.coating || {}
  const coating = {
    id: 'coating-line',
    name: byId.get('coating-line')?.name || 'Coating line',
    warmupAmps: c.warmupAmps ?? 0,
    warmupHours: c.warmupHours ?? 0,
    runAmps: c.runAmps ?? 0,
    enabled: inputs.coating !== false && (c.runAmps ?? 0) > 0,
    text: c.profileText || null,
  }

  return {
    byId,
    equipment,
    ampsOf: rated,
    supportFor,
    coating,
    baseline: sum(baselineParts.map((p) => p.amps)),
    baselineParts,
    capAmps: Number(inputs.maxAmps) > 0 ? Number(inputs.maxAmps) : Infinity,
    unrated: equipment.filter((e) => e.kind === 'furnace' && !e.rated).map((e) => e.name),
  }
}

/**
 * The mutable ledger the scheduler books against.
 *
 * While batches are being placed the coating line is assumed to be up, because
 * the Rules sheet puts it above the furnaces: it is the furnaces that get
 * pushed later to stay under the limit, not the coating line that gets shed.
 * Whether it really stays up is settled afterwards by `simulate()`, which is
 * the only place the trip-and-restart behaviour lives.
 */
export function createLedger(resolved, horizonHours) {
  const furnaceLoads = [] // {from, to, amps, machineId}
  const supportUse = new Map() // eqId -> raw intervals, unioned on read
  let cuts = [0, horizonHours]

  const coatingAssumed = (t) => {
    const c = resolved.coating
    if (!c.enabled) return 0
    return t < c.warmupHours - EPS ? c.warmupAmps : c.runAmps
  }

  const rebuildCuts = () => {
    const s = new Set([0, horizonHours])
    if (resolved.coating.enabled && resolved.coating.warmupHours > 0) {
      s.add(resolved.coating.warmupHours)
    }
    for (const l of furnaceLoads) (s.add(l.from), s.add(l.to))
    for (const ivs of supportUse.values()) for (const iv of ivs) (s.add(iv.from), s.add(iv.to))
    cuts = [...s].filter((t) => t >= -EPS).sort((a, b) => a - b)
  }

  const supportUnion = (eq) => union(supportUse.get(eq) || [])

  /** Everything already committed, plus the assumed coating line, at time t. */
  const ambientAt = (t, ignoreCoating = false) => {
    let a = resolved.baseline + (ignoreCoating ? 0 : coatingAssumed(t))
    for (const l of furnaceLoads) if (t >= l.from - EPS && t < l.to - EPS) a += l.amps
    for (const eq of supportUse.keys()) if (covers(supportUnion(eq), t)) a += resolved.ampsOf(eq)
    return a
  }

  /**
   * What one more batch would add at time t — the furnace's own draw on the
   * ramp, plus any support plant that is not already running for someone else.
   */
  const deltaAt = (machine, tpl, start, t) => {
    let a = 0
    const heatFrom = start + tpl.offsets.heat.from
    const heatTo = start + tpl.offsets.heat.to
    if (t >= heatFrom - EPS && t < heatTo - EPS) a += resolved.ampsOf(machine.id)

    const onFrom = start + tpl.offsets.heat.from
    const onTo = start + tpl.offsets.cool.to
    if (t >= onFrom - EPS && t < onTo - EPS) {
      for (const eq of resolved.supportFor.get(machine.id) || []) {
        if (!covers(supportUnion(eq), t)) a += resolved.ampsOf(eq)
      }
    }
    return a
  }

  /**
   * Earliest start no earlier than `from` at which this batch stays under the
   * cap for its whole window. Walks forward one load step at a time rather than
   * scanning every candidate, so it stays cheap enough to re-run per keystroke.
   */
  const earliestStart = (from, machine, tpl, ceiling, ignoreCoating = false) => {
    if (!Number.isFinite(resolved.capAmps)) return from
    let s = from
    for (let guard = 0; guard < 4000; guard++) {
      if (s + tpl.total > ceiling + EPS) return null
      const winFrom = s + tpl.offsets.heat.from
      const winTo = s + tpl.offsets.cool.to
      const marks = [
        ...new Set([winFrom, winTo, s + tpl.offsets.heat.to, ...cuts.filter((c) => c > winFrom && c < winTo)]),
      ].sort((a, b) => a - b)

      let clash = null
      for (let i = 0; i < marks.length - 1; i++) {
        const mid = (marks[i] + marks[i + 1]) / 2
        if (ambientAt(mid, ignoreCoating) + deltaAt(machine, tpl, s, mid) > resolved.capAmps + EPS) {
          clash = { from: marks[i], to: marks[i + 1] }
          break
        }
      }
      if (!clash) return s
      // Shift right just past the step that caused it; the load can only fall at
      // a cut, so nothing between here and there is worth testing.
      const next = cuts.find((c) => c > clash.from + EPS)
      s = next == null ? s + Math.max(EPS, clash.to - clash.from) : s + (next - clash.from)
    }
    return null
  }

  const commit = (machine, tpl, start) => {
    const amps = resolved.ampsOf(machine.id)
    if (amps > 0) {
      furnaceLoads.push({
        from: start + tpl.offsets.heat.from,
        to: start + tpl.offsets.heat.to,
        amps,
        machineId: machine.id,
      })
    }
    for (const eq of resolved.supportFor.get(machine.id) || []) {
      if (!supportUse.has(eq)) supportUse.set(eq, [])
      supportUse.get(eq).push({ from: start + tpl.offsets.heat.from, to: start + tpl.offsets.cool.to })
    }
    rebuildCuts()
  }

  rebuildCuts()
  return { ambientAt, deltaAt, earliestStart, commit, get cuts() { return cuts } }
}

/**
 * Rebuild the whole load timeline from a finished plan, this time working out
 * what the coating line really does.
 *
 * It wants to be on. It needs `warmupHours` of headroom at `warmupAmps` before
 * it delivers anything, and if headroom ever drops below what it is drawing it
 * trips and has to warm up again from scratch — which is exactly what the rule
 * on the sheet describes. Everything else is fixed by now, so this is a single
 * forward pass over the load steps.
 */
export function simulate({ batches, machines, templates, resolved, horizonHours }) {
  const byId = new Map(machines.map((m) => [m.id, m]))
  const furnaceLoads = []
  const supportRaw = new Map()

  for (const b of batches) {
    const tpl = templates.get(b.machineId)
    if (!tpl) continue
    const amps = resolved.ampsOf(b.machineId)
    const heatFrom = b.start + tpl.offsets.heat.from
    const heatTo = b.start + tpl.offsets.heat.to
    if (amps > 0) furnaceLoads.push({ from: heatFrom, to: heatTo, amps, machineId: b.machineId })
    for (const eq of resolved.supportFor.get(b.machineId) || []) {
      if (!supportRaw.has(eq)) supportRaw.set(eq, [])
      supportRaw.get(eq).push({ from: heatFrom, to: b.start + tpl.offsets.cool.to })
    }
  }

  const supportUnions = new Map([...supportRaw].map(([eq, ivs]) => [eq, union(ivs)]))

  const cutSet = new Set([0, horizonHours])
  for (const l of furnaceLoads) (cutSet.add(l.from), cutSet.add(l.to))
  for (const ivs of supportUnions.values()) for (const iv of ivs) (cutSet.add(iv.from), cutSet.add(iv.to))
  for (let h = 0; h <= Math.ceil(horizonHours) + EPS; h++) cutSet.add(Math.min(h, horizonHours))
  const cuts = [...cutSet].filter((t) => t >= -EPS && t <= horizonHours + EPS).sort((a, b) => a - b)

  const fixedAt = (t) => {
    const furnace = sum(furnaceLoads.filter((l) => t >= l.from - EPS && t < l.to - EPS).map((l) => l.amps))
    let support = 0
    const supportOn = []
    for (const [eq, ivs] of supportUnions) {
      if (covers(ivs, t)) {
        support += resolved.ampsOf(eq)
        supportOn.push(eq)
      }
    }
    return { furnace, support, supportOn, baseline: resolved.baseline }
  }

  // --- the coating line, step by step -------------------------------------
  //
  // Three states. Off, warming up (200 A, two hours, delivering nothing), and
  // running (100 A). It starts warming the moment there is headroom for the
  // warm-up current, and any dip below what it is currently drawing trips it
  // back to off — losing the warm-up done so far, exactly as the rule says.
  const c = resolved.coating
  const cap = resolved.capAmps
  const coatingSegs = [] // {from, to, amps, phase}
  const trips = []

  if (c.enabled) {
    const push = (from, to, amps, phase) => {
      if (to > from + EPS && amps > 0) {
        const last = coatingSegs[coatingSegs.length - 1]
        if (last && last.phase === phase && Math.abs(last.to - from) < EPS) last.to = to
        else coatingSegs.push({ from, to, amps, phase })
      }
    }
    const trip = (at, from) => {
      trips.push({ at, phase: from })
      return { mode: 'off', warmupLeft: c.warmupHours }
    }

    let mode = 'off'
    let warmupLeft = c.warmupHours

    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i]
      const b = cuts[i + 1]
      if (b - a < EPS) continue
      const f = fixedAt((a + b) / 2)
      const free = cap - (f.baseline + f.furnace + f.support)

      let t = a
      while (t < b - EPS) {
        if (mode === 'off') {
          if (free + EPS < c.warmupAmps) break // not enough room to even start
          mode = 'warmup'
          warmupLeft = c.warmupHours
        }
        if (mode === 'warmup') {
          if (free + EPS < c.warmupAmps) {
            ;({ mode, warmupLeft } = trip(t, 'warmup'))
            break
          }
          const step = Math.min(warmupLeft, b - t)
          push(t, t + step, c.warmupAmps, 'warmup')
          warmupLeft -= step
          t += step
          if (warmupLeft <= EPS) mode = 'run'
          continue
        }
        if (free + EPS < c.runAmps) {
          ;({ mode, warmupLeft } = trip(t, 'run'))
          break
        }
        push(t, b, c.runAmps, 'run')
        t = b
      }
    }
  }

  const coatingAt = (t) => sum(coatingSegs.filter((s) => t >= s.from - EPS && t < s.to - EPS).map((s) => s.amps))

  // --- the timeline everyone else reads ------------------------------------
  const steps = []
  for (let i = 0; i < cuts.length - 1; i++) {
    const from = cuts[i]
    const to = cuts[i + 1]
    if (to - from < EPS) continue
    const mid = (from + to) / 2
    const f = fixedAt(mid)
    const coating = coatingAt(mid)
    steps.push({
      from,
      to,
      baseline: f.baseline,
      support: f.support,
      supportOn: f.supportOn,
      coating,
      furnace: f.furnace,
      total: f.baseline + f.support + coating + f.furnace,
    })
  }

  const peak = steps.reduce((a, s) => Math.max(a, s.total), 0)
  const over = steps.filter((s) => s.total > cap + 1e-3)
  const ampHours = sum(steps.map((s) => s.total * (s.to - s.from)))

  /** One row per whole hour — "total consumption for each time". */
  const hourly = []
  for (let h = 0; h < horizonHours - EPS; h++) {
    const from = h
    const to = Math.min(h + 1, horizonHours)
    const inHour = steps.filter((s) => s.to > from + EPS && s.from < to - EPS)
    const w = (key) =>
      inHour.length
        ? sum(inHour.map((s) => s[key] * (Math.min(s.to, to) - Math.max(s.from, from)))) / (to - from)
        : 0
    hourly.push({
      hour: h,
      from,
      to,
      baseline: w('baseline'),
      support: w('support'),
      coating: w('coating'),
      furnace: w('furnace'),
      total: w('total'),
      peak: inHour.reduce((a, s) => Math.max(a, s.total), 0),
      furnacesOn: [
        ...new Set(
          furnaceLoads
            .filter((l) => l.to > from + EPS && l.from < to - EPS)
            .map((l) => byId.get(l.machineId)?.name || l.machineId),
        ),
      ],
    })
  }

  /** Stepped points for the chart: two per step, so the line has square corners. */
  const series = []
  for (const s of steps) {
    series.push({ t: s.from, ...s })
    series.push({ t: s.to, ...s })
  }

  return {
    steps,
    series,
    hourly,
    peak,
    ampHours,
    cap,
    overCap: over.length > 0,
    overCapHours: sum(over.map((s) => s.to - s.from)),
    coatingSegs,
    coatingTrips: trips,
    coatingUptime: horizonHours > 0 ? sum(coatingSegs.map((s) => s.to - s.from)) / horizonHours : 0,
  }
}
