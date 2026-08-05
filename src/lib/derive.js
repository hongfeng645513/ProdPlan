/**
 * Everything that turns *source* data into the payload the app renders.
 *
 * This is a port of the derivation half of tools/convert_excel.py. It exists
 * because the source of truth is moving from the workbook into Postgres, where
 * the data becomes editable in the app: the moment a user can drag a curve
 * point, the phase boundaries, the Newton fit and the batch capacity have to be
 * recomputed on the spot, and they cannot be recomputed by a Python script that
 * only runs at conversion time.
 *
 * The split is deliberate:
 *
 *   SOURCE   what a human enters — specs, measured curve points, rule
 *            sentences, current ratings. This is what Postgres stores.
 *   DERIVED  phases, the cooling fit, capacity, gaps, and the machine-readable
 *            form of the rules. Never stored. A stored `k` is one curve edit
 *            away from being silently wrong, and a wrong `k` does not look
 *            wrong — it just quietly misprices every cycle length.
 *
 * `buildPayload()` takes the source rows and returns exactly the shape of
 * src/data/machines.json, so nothing downstream has to know where the data came
 * from. tools/check_derive.mjs asserts that round trip against the committed
 * file, which is what keeps this port honest against the Python original.
 */

// --------------------------------------------------------------------------
// text helpers — these mirror norm() / slug() / _duration() in the converter
// --------------------------------------------------------------------------

export const norm = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().toLowerCase())

export const slug = (t) =>
  norm(t)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

// Insertion order matters: "an" has to be tried before "a" so that "an hour"
// does not match the shorter alternative first.
const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  half: 0.5, an: 1, a: 1,
}

/** Pull a number of hours out of "... one hour ..." / "... 1.5 hours ...". */
function duration(text) {
  let m = text.match(/(\d+(?:\.\d+)?)\s*(?:h\b|hour)/)
  if (m) return parseFloat(m[1])
  m = text.match(new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join('|')})\\s+(?:h\\b|hour)`))
  if (m) return WORD_NUMBERS[m[1]]
  return null
}

/** Match Python's round(x, n) closely enough for the values in play here. */
const round = (x, n) => {
  const f = 10 ** n
  return Math.round(x * f) / f
}

// --------------------------------------------------------------------------
// phases, cooling fit, capacity
// --------------------------------------------------------------------------

/**
 * Split a measured curve into heating / hold / cooling.
 *
 * Heating is the controlled ramp to the set point; the hold is the plateau
 * within 1% of the peak; everything after it is natural cooling.
 */
export function detectPhases(points) {
  const temps = points.map((p) => p.T)
  const peak = Math.max(...temps)
  const plateau = []
  temps.forEach((T, i) => {
    if (T >= peak * 0.99) plateau.push(i)
  })
  const heatEndIndex = plateau[0]
  const holdEndIndex = plateau[plateau.length - 1]
  return {
    peakTemp: peak,
    heatStart: points[0].t,
    heatEnd: points[heatEndIndex].t,
    holdEnd: points[holdEndIndex].t,
    endOfRecord: points[points.length - 1].t,
    heatEndIndex,
    holdEndIndex,
  }
}

/** The ambient the fit is anchored to: the coldest point seen, capped at 25 C. */
export function ambientFor(points) {
  const coldest = Math.min(points[0].T, ...points.map((p) => p.T))
  return Math.min(coldest, 25.0)
}

/**
 * Fit Newton's law of cooling, anchored at the moment heating is switched off.
 *
 *     T(t) = Tamb + (Toff - Tamb) * exp(-k * (t - tOff))
 *
 * Toff and tOff come straight off the curve, so only k is fitted — least
 * squares on the log of the excess temperature. One free parameter is what lets
 * the app expose k as a single "how fast does this furnace cool" dial.
 */
export function fitNewton(points, phases, ambient) {
  const tOff = phases.holdEnd
  const tempAtOff = points[phases.holdEndIndex].T
  const excess0 = tempAtOff - ambient
  if (excess0 <= 0) return null

  const usable = points.filter((p) => p.t > tOff && p.T - ambient > 1)
  if (usable.length < 2) return null

  const num = usable.reduce((a, p) => a + (p.t - tOff) * -Math.log((p.T - ambient) / excess0), 0)
  const den = usable.reduce((a, p) => a + (p.t - tOff) ** 2, 0)
  if (den === 0) return null
  const k = num / den

  const model = (t) => ambient + excess0 * Math.exp(-k * (t - tOff))
  const residuals = usable.map((p) => p.T - model(p.t))
  const rmse = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / residuals.length)

  return {
    k: round(k, 5),
    ambient,
    tOff,
    tempAtOff,
    rmse: round(rmse, 1),
    fittedFrom: usable[0].t,
    fittedTo: usable[usable.length - 1].t,
    nPoints: usable.length,
    halfLifeHours: k > 0 ? round(Math.log(2) / k, 2) : null,
  }
}

/** Hours where the curve is interpolated rather than measured. */
export function findGaps(points, step = 1.0) {
  const gaps = []
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i + 1].t - points[i].t > step * 1.5) {
      gaps.push({ from: points[i].t, to: points[i + 1].t })
    }
  }
  return gaps
}

/**
 * One source machine (specs + measured points) -> the full object the app uses.
 */
export function buildMachine(source) {
  const points = [...source.measured].sort((a, b) => a.t - b.t)
  const phases = detectPhases(points)
  const ambient = ambientFor(points)
  let cooling = fitNewton(points, phases, ambient)

  // An operator-applied constant, measured from real runs, replaces the one
  // fitted from the reference curve. Kept as an override rather than silently
  // substituted: `fittedK` preserves what the curve said, so the two can be
  // compared and the choice reversed.
  if (cooling && source.coolingKOverride != null) {
    cooling = {
      ...cooling,
      fittedK: cooling.k,
      k: source.coolingKOverride,
      overridden: true,
      overrideSource: source.coolingKSource || 'measured runs',
      halfLifeHours:
        source.coolingKOverride > 0
          ? round(Math.log(2) / source.coolingKOverride, 2)
          : null,
    }
  }

  const unloadT = points[points.length - 1].t
  const unloadTemp = points[points.length - 1].T

  const holders = source.holders || 0
  const perHolder = source.gfPerHolder || 0
  const yld = source.yield || 1
  const batchIn = holders * perHolder
  const batchOut = batchIn * yld

  return {
    id: source.id,
    name: source.name,
    model: source.model || '',
    function: source.function || '',
    holders: source.holders,
    gfSize: source.gfSize || '',
    gfPerHolder: source.gfPerHolder,
    yield: source.yield,
    hasOpenMarker: !!source.hasOpenMarker,
    // Where the reference curve came from, present only once a curve has been
    // replaced from a measured run. Added conditionally so a workbook-derived
    // payload stays byte-identical to what convert_excel.py produces, which is
    // what check_derive.mjs asserts.
    ...(source.curveSourceRunId
      ? {
          curveSource: {
            runId: source.curveSourceRunId,
            label: source.curveSourceLabel || null,
            updatedAt: source.curveUpdatedAt || null,
          },
        }
      : {}),
    measured: points,
    phases: {
      heatStart: phases.heatStart,
      heatEnd: phases.heatEnd,
      holdEnd: phases.holdEnd,
      unloadAt: unloadT,
      unloadTemp,
      peakTemp: phases.peakTemp,
      heatDuration: round(phases.heatEnd - phases.heatStart, 2),
      holdDuration: round(phases.holdEnd - phases.heatEnd, 2),
      coolDuration: round(unloadT - phases.holdEnd, 2),
      cycleDuration: round(unloadT - phases.heatStart, 2),
    },
    cooling,
    capacity: {
      batchInputG: round(batchIn, 1),
      batchOutputG: round(batchOut, 1),
      gramsPerHour:
        unloadT > phases.heatStart ? round(batchOut / (unloadT - phases.heatStart), 1) : null,
    },
    gaps: findGaps(points),
  }
}

// --------------------------------------------------------------------------
// the Rules sheet, in plain English
// --------------------------------------------------------------------------

/**
 * Turn free-text constraints into something the planner can apply.
 *
 * Anything unrecognised is still returned under `raw` with `parsed: false`, so
 * a rule can never be silently dropped — the app lists the unparsed ones so an
 * operator can see the planner is not enforcing them. Preserve that contract:
 * a constraint that is quietly ignored is worse than one that is visibly
 * unsupported.
 */
export function parseRules(sentences) {
  const exclusive = []
  const support = []
  // Furnaces to load first when several are free at once, most preferred first.
  const preferred = []
  const preferredText = []
  const coating = {}
  const raw = []
  let loadHours = null
  let unloadHours = null

  for (const line of sentences) {
    const low = norm(line)
    let handled = false

    // "Cooling system 1 need to run during both heating and cooling for
    //  furnace 1, furnace 2 and furnace 3"
    //
    // Support plant is tied to the furnaces it serves, not to the clock: it runs
    // from element-on until the charge is cool enough to unload. Heating and
    // cooling are contiguous legs, so "during both" is one window, not two.
    const m = low.match(/^(cooling system \d+|vacuum system \d+)\b/)
    if (m && low.includes('run') && low.includes('furnace')) {
      const served = (low.match(/furnace\s*\d+/g) || []).map(slug)
      if (served.length) {
        support.push({
          equipment: slug(m[1]),
          machines: served,
          from: 'heat',
          to: 'cool',
          text: line,
        })
        handled = true
      }
      raw.push({ text: line, parsed: handled })
      continue
    }

    // "Coating line needs 200A during first 2 hours, then 100A ..."
    if (low.includes('coating line') && /\d+\s*a\b/.test(low)) {
      const amps = (low.match(/(\d+(?:\.\d+)?)\s*a\b/g) || []).map((s) => parseFloat(s))
      const hrs = duration(low)
      if (amps.length >= 2 && hrs) {
        Object.assign(coating, {
          warmupAmps: amps[0],
          warmupHours: hrs,
          runAmps: amps[1],
          restartsWarmup: /\b(stop|restart|again)\b/.test(low),
          profileText: line,
        })
        handled = true
      }
      raw.push({ text: line, parsed: handled })
      continue
    }

    // "Run coating line as much as possible"
    if (low.includes('coating line') && /as much as possible|maximi[sz]e/.test(low)) {
      coating.priority = 'high'
      coating.priorityText = line
      raw.push({ text: line, parsed: true })
      continue
    }

    // "Run Furnace 1 first" / "Prefer furnace 5" / "Furnace 2 has priority"
    //
    // Checked before the load/unload branches, because "Load furnace 1 first"
    // contains the word "load" and would otherwise be read as a statement about
    // how long loading takes.
    // No regex here on purpose: word-boundary escapes have a habit of not
    // surviving the trip through tooling, and a broken \b matches nothing at
    // all rather than failing loudly. Substring tests cannot rot that way.
    const SAYS_FIRST = ['first', 'priorit', 'prefer', 'beginning', 'earliest', 'to begin with']
    const SAYS_RUN = ['run', 'use', 'prefer', 'load', 'start', 'schedule', 'has', 'have']
    if (
      low.includes('furnace') &&
      SAYS_FIRST.some((w) => low.includes(w)) &&
      SAYS_RUN.some((w) => low.includes(w))
    ) {
      const names = low.match(/furnace\s*\d+/g) || []
      if (names.length) {
        for (const n of names.map(slug)) if (!preferred.includes(n)) preferred.push(n)
        preferredText.push(line)
        raw.push({ text: line, parsed: true })
        continue
      }
    }

    // "Furnace 1 and Furnace 2 cannot heat at the same time"
    if (/\b(cannot|can not|can't|must not|never)\b/.test(low) && low.includes('same time')) {
      const names = low.match(/furnace\s*\d+/g) || []
      if (names.length >= 2) {
        exclusive.push({ machines: names.map(slug), scope: 'power', text: line })
        handled = true
      }
    } else if (low.includes('load') && !low.includes('unload')) {
      const d = duration(low)
      if (d != null) {
        loadHours = d
        handled = true
      }
    } else if (low.includes('unload')) {
      const d = duration(low)
      if (d != null) {
        unloadHours = d
        handled = true
      }
    }

    raw.push({ text: line, parsed: handled })
  }

  return {
    raw,
    exclusiveHeating: exclusive,
    supportEquipment: support,
    coating,
    loadHours: loadHours ?? 0.0,
    unloadHours: unloadHours ?? 0.0,
    // Added only when a preference was actually expressed, so a workbook-derived
    // payload stays byte-identical to what convert_excel.py produces — which is
    // what check_derive.mjs asserts.
    ...(preferred.length ? { preferredMachines: preferred, preferredText } : {}),
  }
}

// --------------------------------------------------------------------------
// the whole payload
// --------------------------------------------------------------------------

/**
 * Tag each Electricity row with the part it plays in a plan, so the app can
 * group the operator inputs apart from the plant it actually schedules.
 */
function tagEquipment(equipment, machineIds, supportIds) {
  return equipment.map((e) => {
    let kind
    if (machineIds.has(e.id)) kind = 'furnace'
    else if (supportIds.has(e.id)) kind = 'support'
    else if (e.id.includes('coating')) kind = 'coating'
    else if (e.needsInput) kind = 'input'
    else kind = 'other'
    return { ...e, kind }
  })
}

/**
 * Source rows -> the exact shape of src/data/machines.json.
 *
 * @param {object}   src
 * @param {object[]} src.machines       specs + measured points, unsorted
 * @param {string[]} src.ruleSentences  the Rules sheet, one sentence per entry
 * @param {object[]} src.equipment      id, name, maxAmps, rated, needsInput
 * @param {string}   src.source         where the data came from, for display
 */
export function buildPayload(src) {
  const machines = (src.machines || []).map(buildMachine)
  machines.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const rules = parseRules(src.ruleSentences || [])

  const machineIds = new Set(machines.map((m) => m.id))
  const supportIds = new Set(rules.supportEquipment.map((s) => s.equipment))
  const equipment = tagEquipment(src.equipment || [], machineIds, supportIds)

  return {
    source: src.source || 'database',
    machines,
    rules,
    power: {
      equipment,
      coating: rules.coating,
      support: rules.supportEquipment,
    },
  }
}

/**
 * The inverse: strip a full payload back down to source data. Used to seed the
 * database from the committed JSON, and by the parity check.
 */
export function extractSource(payload) {
  return {
    source: payload.source,
    machines: payload.machines.map((m) => ({
      id: m.id,
      name: m.name,
      model: m.model,
      function: m.function,
      holders: m.holders,
      gfSize: m.gfSize,
      gfPerHolder: m.gfPerHolder,
      yield: m.yield,
      hasOpenMarker: m.hasOpenMarker,
      measured: m.measured,
      coolingKOverride: m.cooling?.overridden ? m.cooling.k : null,
      coolingKSource: m.cooling?.overrideSource ?? null,
      curveSourceRunId: m.curveSource?.runId ?? null,
      curveSourceLabel: m.curveSource?.label ?? null,
      curveUpdatedAt: m.curveSource?.updatedAt ?? null,
    })),
    ruleSentences: payload.rules.raw.map((r) => r.text),
    equipment: (payload.power?.equipment || []).map((e) => ({
      id: e.id,
      name: e.name,
      maxAmps: e.maxAmps,
      rated: e.rated,
      needsInput: e.needsInput,
    })),
  }
}
