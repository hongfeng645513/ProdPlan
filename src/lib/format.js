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
