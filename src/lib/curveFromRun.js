/**
 * Turn a measured run into a reference temperature curve.
 *
 * The reference curve is what the planner derives everything from: the phase
 * boundaries, the cooling constant, the cycle length, the batch capacity. It is
 * hourly `t_hours -> temp_c` starting at zero, which is the shape the workbook
 * supplied. A run is thousands of 30-second samples at absolute timestamps, so
 * it has to be resampled.
 *
 * Two decisions worth knowing about:
 *
 *   probes   The curve carries one temperature per point, so the three probes
 *            are averaged — the same quantity the cooling fit uses, so a curve
 *            built here and a k measured from the same run agree.
 *
 *   the vent The curve is cut where the vacuum breaks. That is not tidying: it
 *            makes `unloadTemp` the temperature at which the furnace is actually
 *            opened, and it keeps the derived Newton fit describing the vacuum
 *            cooling it can model, rather than averaging it with the convective
 *            collapse that follows. Including the vent produced fits with a
 *            174 C error on real data.
 *
 * Replacing a curve changes every plan involving that furnace, so `summary()`
 * exists to show what would change before it is applied.
 */
import { probeMean, ventIndex } from './runImport.js'
import { detectPhases, ambientFor, fitNewton } from './derive.js'

const asMs = (v) => (v instanceof Date ? v.getTime() : new Date(String(v).replace(' ', 'T')).getTime())

/**
 * @param {object[]} samples  run samples, ordered by time
 * @param {object}   opts
 * @param {number}   opts.intervalHours  spacing of the produced points
 * @param {boolean}  opts.truncateAtVent stop where the chamber is back-filled
 * @returns {{points: {t:number,T:number}[], warnings: string[], truncatedAtHours: number|null, usedSamples: number}}
 */
export function curveFromRun(
  samples,
  {
    intervalHours = 1,
    truncateAtVent = true,
    /** Readings below this are the instrument out of range, not a cold furnace. */
    minValidTempC = null,
    /** Continue the modelled cool-down down to this temperature, then stop. */
    extendToC = null,
    /** Cooling constant used for that continuation — normally the run's own fit. */
    k = null,
    /** Ambient the cooling model relaxes towards. */
    ambientC = null,
  } = {},
) {
  const warnings = []
  if (!samples?.length) return { points: [], warnings: ['The run has no samples.'], truncatedAtHours: null, usedSamples: 0 }

  const rows = samples
    .map((s) => ({ ms: asMs(s.at), T: probeMean(s), vacuum: s.vacuum, setTemp: s.setTemp }))
    .filter((r) => Number.isFinite(r.ms) && r.T != null)
    .sort((a, b) => a.ms - b.ms)

  if (rows.length < 4) {
    return { points: [], warnings: ['Too few usable samples to build a curve.'], truncatedAtHours: null, usedSamples: 0 }
  }

  // Cut at the vent, searching only after the element goes off so an early
  // pump-down or a leak-up during heating cannot end the curve.
  let used = rows
  let truncatedAtHours = null
  if (truncateAtVent) {
    let offAt = 0
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i].setTemp ?? 0) === 0 && (rows[i - 1].setTemp ?? 0) > 0) {
        offAt = i
        break
      }
    }
    const v = ventIndex(rows, offAt || 1)
    if (v > 0) {
      truncatedAtHours = Math.round(((rows[v].ms - rows[0].ms) / 3600_000) * 100) / 100
      used = rows.slice(0, v)
      warnings.push(
        `Curve stops at ${truncatedAtHours} h, where the chamber was back-filled. ` +
          'Unload temperature therefore becomes the temperature at which the furnace is actually opened.',
      )
    }
  }
  // Cut where the instrument stops measuring.
  //
  // The graphitization pyrometers read nothing below 1000 C: under that they
  // sag to a pinned value near 790 and sit there. Those samples are not a cold
  // furnace, and a curve that includes them describes a furnace that stops
  // cooling — so the measured part of the curve ends here, and the rest is
  // continued by model below.
  if (minValidTempC != null) {
    const peakIndex = used.reduce((best, r, i) => (r.T > used[best].T ? i : best), 0)
    const cut = used.findIndex((r, i) => i > peakIndex && r.T < minValidTempC)
    if (cut > 0) {
      const atH = Math.round(((used[cut].ms - used[0].ms) / 3600_000) * 100) / 100
      used = used.slice(0, cut)
      warnings.push(
        `Measured data ends at ${atH} h, where the reading fell below ${minValidTempC} °C — ` +
          'the bottom of what this instrument can measure.',
      )
    }
  }

  if (used.length < 4) {
    return { points: [], warnings: ['Too little data before the chamber was opened.'], truncatedAtHours, usedSamples: 0 }
  }

  const t0 = used[0].ms
  const endH = (used[used.length - 1].ms - t0) / 3600_000

  /** Linear interpolation between the two samples bracketing an hour mark. */
  const at = (h) => {
    const target = t0 + h * 3600_000
    if (target <= used[0].ms) return used[0].T
    if (target >= used[used.length - 1].ms) return used[used.length - 1].T
    let lo = 0
    let hi = used.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (used[mid].ms <= target) lo = mid
      else hi = mid
    }
    const span = used[hi].ms - used[lo].ms
    const f = span === 0 ? 0 : (target - used[lo].ms) / span
    return used[lo].T + f * (used[hi].T - used[lo].T)
  }

  const points = []
  for (let h = 0; h <= endH + 1e-9; h += intervalHours) {
    points.push({ t: Math.round(h * 100) / 100, T: Math.round(at(h) * 10) / 10 })
  }
  // Keep the real end of the record even when it falls between marks, so the
  // unload point is the measured one rather than an interpolated near-miss.
  const lastT = Math.round(endH * 100) / 100
  if (points[points.length - 1].t < lastT - 1e-9) {
    points.push({ t: lastT, T: Math.round(used[used.length - 1].T * 10) / 10 })
  }

  if (points.length < 4) warnings.push('The run is shorter than a few sampling intervals; the curve will be coarse.')

  // Continue the cool-down by model, down to the unload temperature.
  //
  // The planner needs to know when the furnace can be opened, and on these
  // furnaces that happens well below anything the instrument can see. So the
  // curve is continued with the run's own fitted constant:
  //
  //     T(t) = Tamb + (Tlast - Tamb) * exp(-k * (t - tlast))
  //
  // Two honest caveats, both reported rather than buried. This tail is a model,
  // not a measurement. And k was fitted where radiation dominates — heat loss
  // goes as T^4 up there, not as the temperature difference Newton's law
  // assumes — so applied lower down it cools FASTER than the furnace really
  // will, which makes the predicted unload time optimistic rather than safe.
  let extrapolatedFrom = null
  let extrapolatedPoints = 0

  if (extendToC != null && k > 0) {
    const last = points[points.length - 1]
    const amb = ambientC ?? Math.min(20, extendToC - 1)

    if (last.T > extendToC && extendToC > amb) {
      extrapolatedFrom = last.t
      const excess = last.T - amb
      const model = (h) => amb + excess * Math.exp(-k * (h - last.t))
      const endsAt = last.t + Math.log(excess / (extendToC - amb)) / k

      for (let h = last.t + intervalHours; h < endsAt - 1e-9; h += intervalHours) {
        points.push({ t: Math.round(h * 100) / 100, T: Math.round(model(h) * 10) / 10 })
        extrapolatedPoints++
      }
      // Land exactly on the unload temperature, so the curve ends where the
      // furnace is actually openable rather than near it.
      points.push({ t: Math.round(endsAt * 100) / 100, T: extendToC })
      extrapolatedPoints++

      warnings.push(
        `Continued from ${num1(last.T)} °C at ${num1(last.t)} h down to ${extendToC} °C at ` +
          `${num1(endsAt)} h using k = ${k} — ${extrapolatedPoints} modelled point(s), not measured. ` +
          'k was fitted where radiation dominates, so this tail cools faster than the furnace really ' +
          'will and the unload time is optimistic.',
      )
    } else if (last.T > extendToC) {
      warnings.push(`No cooling constant available, so the curve stops at ${num1(last.T)} °C instead of ${extendToC} °C.`)
    }
  }

  return { points, warnings, truncatedAtHours, usedSamples: used.length, extrapolatedFrom, extrapolatedPoints }
}

const num1 = (x) => Math.round(x * 10) / 10

/**
 * What the planner would derive from a set of curve points — used to show the
 * consequences of a replacement next to the curve currently in use.
 */
export function summary(points) {
  if (!points?.length || points.length < 3) return null
  const phases = detectPhases(points)
  const ambient = ambientFor(points)
  const cooling = fitNewton(points, phases, ambient)
  const last = points[points.length - 1]

  return {
    peakTemp: phases.peakTemp,
    heatDuration: Math.round((phases.heatEnd - phases.heatStart) * 100) / 100,
    holdDuration: Math.round((phases.holdEnd - phases.heatEnd) * 100) / 100,
    coolDuration: Math.round((last.t - phases.holdEnd) * 100) / 100,
    cycleDuration: Math.round((last.t - phases.heatStart) * 100) / 100,
    unloadTemp: last.T,
    k: cooling?.k ?? null,
    rmse: cooling?.rmse ?? null,
    points: points.length,
  }
}
