/**
 * Newton's law of cooling for the natural cool-down branch of a furnace cycle.
 *
 *   T(t) = Tamb + (Toff - Tamb) * exp(-k * (t - tOff))
 *
 * Heating and soaking are controlled and accurately known, so those come from
 * the measured curve. Cooling is a natural process that depends on the room
 * temperature and on how well the furnace is insulated — it differs from
 * machine to machine and drifts over time — so it is modelled with a single
 * cooling constant k that can be re-tuned per machine.
 */

/** Default tunable parameters for a machine, taken from the workbook fit. */
export function defaultParams(machine) {
  const c = machine.cooling || {}
  return {
    ambient: c.ambient ?? 20,
    k: c.k ?? 0.1,
    unloadTemp: machine.phases.unloadTemp ?? 200,
  }
}

/** Modelled temperature at hour t (t must be at/after heat-off). */
export function coolingTemp(machine, params, t) {
  const { tOff, tempAtOff } = machine.cooling
  const excess = tempAtOff - params.ambient
  return params.ambient + excess * Math.exp(-params.k * (t - tOff))
}

/** Hours of cooling needed to reach `target` degrees C after heat-off. */
export function hoursToTemp(machine, params, target) {
  const { tempAtOff } = machine.cooling
  const excess = tempAtOff - params.ambient
  const wanted = target - params.ambient
  if (!(excess > 0) || !(wanted > 0) || !(params.k > 0)) return null
  if (wanted >= excess) return 0
  return Math.log(excess / wanted) / params.k
}

/** Linear interpolation on the measured (controlled) part of the curve. */
function measuredAt(points, t) {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (t >= a.t && t <= b.t) {
      const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t)
      return a.T + f * (b.T - a.T)
    }
  }
  return points[points.length - 1].T
}

/**
 * Full cycle curve: measured heating + soak, then the modelled cooling tail.
 * Points carry `modeled: true` where the value comes from the cooling model
 * rather than from the workbook, so the chart can draw them dashed.
 */
export function buildCurve(machine, params, step = 0.25) {
  const { tOff } = machine.cooling
  const measured = machine.measured
  const out = []

  for (let t = 0; t <= tOff + 1e-9; t += step) {
    out.push({ t: round(t), T: measuredAt(measured, t), modeled: false })
  }

  const coolHours = hoursToTemp(machine, params, params.unloadTemp)
  const end = coolHours == null ? machine.phases.unloadAt : tOff + coolHours
  for (let t = tOff + step; t <= end + 1e-9; t += step) {
    out.push({ t: round(t), T: coolingTemp(machine, params, t), modeled: true })
  }
  const last = out[out.length - 1]
  if (Math.abs(last.t - end) > 1e-6) {
    out.push({ t: round(end), T: coolingTemp(machine, params, end), modeled: true })
  }
  return out
}

/** Measured points that fall on the cooling branch — plotted as validation dots. */
export function coolingSamples(machine) {
  return machine.measured.filter((p) => p.t > machine.cooling.tOff)
}

/** Cycle timing + throughput under the current cooling parameters. */
export function cycleSummary(machine, params) {
  const p = machine.phases
  const cool = hoursToTemp(machine, params, params.unloadTemp)
  const coolHours = cool == null ? p.coolDuration : cool
  const total = p.heatDuration + p.holdDuration + coolHours
  const out = machine.capacity.batchOutputG
  return {
    heat: p.heatDuration,
    hold: p.holdDuration,
    cool: coolHours,
    total,
    batchesPerDay: total > 0 ? 24 / total : 0,
    gramsPerHour: total > 0 ? out / total : 0,
    kgPerDay: total > 0 ? (out * (24 / total)) / 1000 : 0,
  }
}

/** Root-mean-square error of the current parameters against measured points. */
export function modelError(machine, params) {
  const pts = coolingSamples(machine)
  if (!pts.length) return null
  const sq = pts.reduce((acc, p) => {
    const d = p.T - coolingTemp(machine, params, p.t)
    return acc + d * d
  }, 0)
  return Math.sqrt(sq / pts.length)
}

const round = (x) => Math.round(x * 1000) / 1000
