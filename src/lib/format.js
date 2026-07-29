export const num = (v, d = 0) =>
  v == null || Number.isNaN(v)
    ? '—'
    : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

export const hours = (v, d = 1) => (v == null ? '—' : `${num(v, d)} h`)

export const degrees = (v, d = 0) => (v == null ? '—' : `${num(v, d)} °C`)

/** 34.5 -> "34 h 30 min" */
export function clock(v) {
  if (v == null) return '—'
  const h = Math.floor(v)
  const m = Math.round((v - h) * 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

export const grams = (v) =>
  v == null ? '—' : v >= 1000 ? `${num(v / 1000, 2)} kg` : `${num(v, 0)} g`

/** Series colours — dataviz categorical slots 1-8, in fixed order. */
export const SERIES = [
  { light: '#2a78d6', dark: '#3987e5' },
  { light: '#eb6834', dark: '#d95926' },
  { light: '#1baf7a', dark: '#199e70' },
  { light: '#eda100', dark: '#c98500' },
  { light: '#e87ba4', dark: '#d55181' },
  { light: '#008300', dark: '#008300' },
  { light: '#4a3aa7', dark: '#9085e9' },
  { light: '#e34948', dark: '#e66767' },
]

export const seriesColor = (i, theme) => SERIES[i % SERIES.length][theme === 'dark' ? 'dark' : 'light']

/**
 * Cycle-phase colours for the planner's Gantt.
 *
 * Heating / hold / cooling are the categorical set — three hues, checked for
 * colourblind separation against the light and dark chart surfaces (worst
 * adjacent pair ΔE 15.7 light, 13.1 dark; normal-vision floor 22.2 / 16.4).
 * Loading and unloading are deliberately neutral: they are handling steps, not
 * process states, so they read as chrome and never compete with the thermal
 * story. They are told apart by position (always the first and last segment)
 * and by the tooltip, never by colour alone.
 */
export const PHASES = [
  { key: 'load', label: 'Load', neutral: true },
  { key: 'heat', label: 'Heating', light: '#eb6834', dark: '#d95926' },
  { key: 'hold', label: 'Hold', light: '#a82d76', dark: '#d1489b' },
  { key: 'cool', label: 'Cooling', light: '#2a78d6', dark: '#3987e5' },
  { key: 'unload', label: 'Unload', neutral: true },
]

export const PHASE = Object.fromEntries(PHASES.map((p) => [p.key, p]))

export const phaseColor = (key, theme) => {
  const p = PHASE[key]
  if (!p || p.neutral) return theme === 'dark' ? '#55554f' : '#cbcac0'
  return theme === 'dark' ? p.dark : p.light
}

/**
 * Load bands for the electricity chart, in the order they stack.
 *
 * Deliberately drawn from the same categorical set as the cycle phases, and the
 * furnace band reuses the heating hue — on both charts orange means "an element
 * is on", which is the whole point of the current limit.
 */
export const LOAD_BANDS = [
  { key: 'baseline', label: 'R&D + facility', neutral: true },
  { key: 'support', label: 'Cooling + vacuum', light: '#1baf7a', dark: '#199e70' },
  { key: 'coating', label: 'Coating line', light: '#eda100', dark: '#c98500' },
  { key: 'furnace', label: 'Furnaces heating', light: '#eb6834', dark: '#d95926' },
]

export const loadColor = (key, theme) => {
  const b = LOAD_BANDS.find((x) => x.key === key)
  if (!b || b.neutral) return theme === 'dark' ? '#55554f' : '#cbcac0'
  return theme === 'dark' ? b.dark : b.light
}

/** Wall-clock date `h` hours after `start` (a Date). */
export const dateAt = (start, h) => new Date(start.getTime() + h * 3600_000)

export const pad2 = (n) => String(n).padStart(2, '0')

/**
 * Clock-friendly hour steps, so a wall-clock axis lands on whole hours.
 * Capped at 12: a step of 24 or more puts every tick at the same hour of the
 * day, and an axis reading "00 00 00 00" tells you nothing.
 */
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12]

/**
 * Ticks for a wall-clock axis. Positions are elapsed hours from t=0, offset so
 * every tick falls on a whole hour of the day — which is what makes an HH label
 * honest when the run starts at, say, 10:47.
 */
export function clockTicks(xMax, origin, count = 6) {
  if (!(xMax > 0)) return [0]
  const step = HOUR_STEPS.find((s) => s >= xMax / count) || 12
  const startH = origin.getHours() + origin.getMinutes() / 60 + origin.getSeconds() / 3600
  const first = Math.max(0, Math.ceil(startH / step) * step - startH)
  const out = []
  for (let v = first; v <= xMax + 1e-9; v += step) out.push(Number(v.toFixed(6)))
  return out
}

/** "14" — the hour of the day `h` hours after `origin`. */
export const hourOfDay = (origin, h) => pad2(dateAt(origin, h).getHours())

/** "Mon 3 Aug 14:00" */
export const stamp = (d) =>
  d.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

/** "3 Aug" */
export const dayStamp = (d) =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

/** 51.4 h -> "2 d 3 h" once past a day, else "51 h 24 min" */
export function span(v) {
  if (v == null) return '—'
  if (v < 24) return clock(v)
  const d = Math.floor(v / 24)
  const h = Math.round(v - d * 24)
  return h ? `${d} d ${h} h` : `${d} d`
}
