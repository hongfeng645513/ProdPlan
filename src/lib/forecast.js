/**
 * "Where will this furnace be in an hour?"
 *
 * The planner answers questions about batches. This answers a question about a
 * furnace that is running *right now*: given its temperature at a known moment
 * and whether the element is on or off, project the temperature forward hour by
 * hour.
 *
 * The two directions are not symmetrical, and that asymmetry is the whole point
 * of the module:
 *
 *   Cooling  — a physical process with no memory of how it got hot. Newton's
 *              law is anchored directly on the temperature you type in, so any
 *              starting point is valid, including one that never appears in the
 *              workbook.
 *
 *   Heating  — a *controlled* ramp. The furnace does not choose its own rate;
 *              it follows the recipe in the workbook. So a temperature during
 *              heating identifies a position on that ramp, and the forecast is
 *              simply the rest of the recipe from that position onward.
 */

/** Hours for Newton cooling to fall from `from` to `target`. */
function coolingHours(from, target, ambient, k) {
  const excess = from - ambient
  const wanted = target - ambient
  if (!(excess > 0) || !(wanted > 0) || !(k > 0)) return null
  if (wanted >= excess) return 0
  return Math.log(excess / wanted) / k
}

const EPS = 1e-9

/** The controlled part of the measured curve: load through end of soak. */
function heatingBranch(machine) {
  const end = machine.phases.holdEnd
  return machine.measured.filter((p) => p.t <= end + EPS)
}

/** Temperature on the measured curve at hour t (linear between samples). */
function measuredAt(points, t) {
  if (t <= points[0].t) return points[0].T
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
 * Invert the heating ramp: at what hour of the recipe is the furnace at `temp`?
 *
 * The ramp is monotonic for every furnace in the workbook, so this is well
 * defined. Resolution is limited by the workbook's 1-hour sampling — between
 * two samples we can only interpolate linearly, which on the graphitization
 * furnaces' first hour (20 → 1000 °C) is a coarse approximation.
 */
export function heatingPositionAt(machine, temp) {
  const pts = heatingBranch(machine)
  if (temp <= pts[0].T) return { t: pts[0].t, clamped: 'below' }
  const peak = machine.phases.peakTemp
  if (temp > peak + EPS) return { t: null, clamped: 'above' }

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (temp >= a.T - EPS && temp <= b.T + EPS && b.T > a.T) {
      const f = (temp - a.T) / (b.T - a.T)
      return { t: a.t + f * (b.t - a.t), clamped: null }
    }
  }
  // at or above the plateau: it is already at the set point
  return { t: machine.phases.heatEnd, clamped: null }
}

/**
 * Project temperature forward.
 *
 * @param {object} machine
 * @param {object} params   cooling parameters (ambient, k, unloadTemp)
 * @param {object} opts
 * @param {'heating'|'cooling'} opts.state  is the element on?
 * @param {number} opts.temp                temperature now, °C
 * @param {number} opts.hours               how far ahead to project
 * @param {number} opts.step                sampling step for the curve
 * @returns {{points, table, milestones, warnings, setPoint, valid}}
 */
export function forecast(machine, params, { state, temp, hours = 24, step = 0.25 }) {
  const warnings = []
  const milestones = []
  const setPoint = machine.phases.peakTemp
  const ambient = params.ambient

  // resolved once, not per sample
  const pos = state === 'heating' ? heatingPositionAt(machine, temp) : null
  const ramp = state === 'heating' ? heatingBranch(machine) : null

  const at = (h) => {
    if (state === 'cooling') {
      // Newton anchored on the entered temperature, not on the workbook's
      // heat-off point — this furnace is wherever the operator says it is.
      return ambient + (temp - ambient) * Math.exp(-params.k * h)
    }
    if (pos.t == null) return temp
    const t = pos.t + h
    // past the end of the ramp the element is still on, so it holds
    return t >= machine.phases.heatEnd ? setPoint : measuredAt(ramp, t)
  }

  let valid = true

  if (state === 'cooling') {
    if (!(params.k > 0)) {
      warnings.push('This furnace has no usable cooling fit, so cooling cannot be modelled.')
      valid = false
    } else if (temp <= ambient + 0.5) {
      warnings.push(`Already at room temperature (${Math.round(ambient)} °C) — nothing left to cool.`)
    } else {
      const toUnload = coolingHours(temp, params.unloadTemp, ambient, params.k)
      if (toUnload != null && toUnload > 0) {
        milestones.push({ key: 'unload', label: `Cool enough to open (${Math.round(params.unloadTemp)} °C)`, hours: toUnload })
      } else if (temp <= params.unloadTemp) {
        milestones.push({ key: 'unload', label: `Already below the unload temperature (${Math.round(params.unloadTemp)} °C)`, hours: 0 })
      }
      const near = ambient + 10
      if (temp > near) {
        const h = Math.log((temp - ambient) / 10) / params.k
        milestones.push({ key: 'ambient', label: `Within 10 °C of room (${Math.round(near)} °C)`, hours: h })
      }
    }
  } else {
    if (pos.clamped === 'above') {
      warnings.push(
        `${Math.round(temp)} °C is above this furnace's set point of ${Math.round(setPoint)} °C — ` +
          'the heating recipe does not go there, so no forecast is possible.',
      )
      valid = false
    } else {
      if (pos.clamped === 'below') {
        warnings.push(
          `${Math.round(temp)} °C is below the start of the recipe — treating the furnace as being at the very beginning of its ramp.`,
        )
      }
      const remaining = machine.phases.heatEnd - pos.t
      if (remaining > EPS) {
        milestones.push({ key: 'setpoint', label: `Reaches the set point (${Math.round(setPoint)} °C)`, hours: remaining })
      } else {
        milestones.push({ key: 'setpoint', label: `Already at the set point (${Math.round(setPoint)} °C)`, hours: 0 })
      }
      milestones.push({
        key: 'position',
        label: 'Position on the heating recipe',
        hours: pos.t,
        asPosition: true,
      })
    }
  }

  const points = []
  if (valid) {
    for (let h = 0; h <= hours + EPS; h += step) {
      points.push({ t: Math.round(h * 1000) / 1000, T: at(h), modeled: state === 'cooling' })
    }
  }

  // the hour-by-hour list an operator actually reads off
  const table = []
  if (valid) {
    for (let h = 0; h <= Math.round(hours); h++) table.push({ h, T: at(h) })
  }

  milestones.sort((a, b) => a.hours - b.hours)
  return { points, table, milestones, warnings, setPoint, valid, ambient }
}
