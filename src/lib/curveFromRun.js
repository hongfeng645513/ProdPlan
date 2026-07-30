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
export function curveFromRun(samples, { intervalHours = 1, truncateAtVent = true } = {}) {
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

  return { points, warnings, truncatedAtHours, usedSamples: used.length }
}

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
