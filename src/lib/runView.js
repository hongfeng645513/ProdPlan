/**
 * Axis maths for the measured-run viewer.
 *
 * Separated from the component so it can be tested under Node. The gap
 * collapsing in particular is easy to get subtly wrong in a way that looks
 * plausible on screen — a chart with a squashed axis still draws a nice curve.
 */

/** A hole longer than this many minutes is collapsed rather than drawn. */
export const GAP_MINUTES = 5

/** Display-minutes allotted to a collapsed gap, whatever its real length. */
export const GAP_DISPLAY = 4

export const asDate = (v) => (v instanceof Date ? v : new Date(String(v).replace(' ', 'T')))

const p2 = (n) => String(n).padStart(2, '0')

/**
 * Format a Date as the wall clock it represents, for a timestamp column that
 * carries no time zone.
 *
 * NOT toISOString(). The instrument export has no offset, so its times are
 * parsed as local wall clock and stored in a `timestamp` column as-is.
 * toISOString() converts to UTC, which would shift every reading by the
 * machine's offset — writing 13:44 as 11:44 on import, and displaying 13:44 as
 * 11:44 on the way back out. Both wrong, and consistently enough to look right.
 */
export function toSqlLocal(v) {
  const d = asDate(v)
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  )
}

/** Wall clock to the minute, for display. */
export const fmtLocal = (v) => toSqlLocal(v).slice(0, 16)

/**
 * Build a display axis that keeps real durations within contiguous stretches
 * and compresses the holes between them.
 *
 * Without this, a run with a three-hour logging gap is mostly empty space with
 * a straight line drawn across the part where nothing is known — which reads as
 * data. Contiguous stretches keep their true proportions; the gaps are returned
 * so the view can mark them.
 *
 * @returns {{xs: number[], gaps: {x:number, minutes:number, at:*}[], span:number}}
 */
export function buildTimeline(samples, { gapMinutes = GAP_MINUTES, gapDisplay = GAP_DISPLAY } = {}) {
  if (!samples?.length) return { xs: [], gaps: [], span: 1 }

  const xs = new Array(samples.length)
  const gaps = []
  xs[0] = 0

  for (let i = 1; i < samples.length; i++) {
    const dt = (asDate(samples[i].at) - asDate(samples[i - 1].at)) / 60000
    if (dt > gapMinutes) {
      gaps.push({ x: xs[i - 1], minutes: dt, at: samples[i - 1].at })
      xs[i] = xs[i - 1] + gapDisplay
    } else {
      xs[i] = xs[i - 1] + dt
    }
  }

  return { xs, gaps, span: xs[xs.length - 1] || 1 }
}

/**
 * Thin a list of sample indices so the SVG stays a reasonable size. The first
 * and last are always kept, so the plotted range still matches the interval the
 * view says it is showing.
 */
export function decimate(indices, max) {
  if (indices.length <= max) return indices
  const stride = Math.ceil(indices.length / max)
  const out = []
  for (let i = 0; i < indices.length; i += stride) out.push(indices[i])
  const last = indices[indices.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}
