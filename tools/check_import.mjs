/**
 * Assertions for the MCGS run importer.
 *
 * The interesting one is the round trip: synthesise a cooling curve from a
 * KNOWN cooling constant, feed it through the importer as if it were an export,
 * and require the fit to recover that constant. A cooling fit that is subtly
 * wrong produces plausible numbers and misprices every cycle length, so it
 * needs a test that would notice — not just one that checks it returns a value.
 *
 *   node tools/check_import.mjs
 */
import { parseCsv, segment, fitCooling, readRuns, probeMean } from '../src/lib/runImport.js'
import { buildTimeline, decimate, toSqlLocal, asDate, GAP_DISPLAY } from '../src/lib/runView.js'
import { curveFromRun, summary } from '../src/lib/curveFromRun.js'

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Build an MCGS-shaped export: ramp, soak, then Newton cooling at a known k. */
function synthesise({ start, k, ambient = 20, peak = 1000, rampH = 7, soakH = 1, coolH = 20, stepS = 30 }) {
  const lines = ['"MCGS_TIME","MCGS_TIMEMS","低温测量值1","低温测量值2","低温测量值3","低温设定值1","真空检测数值","压力显示","水温测量值"']
  const t0 = start.getTime()
  const push = (h, temp, set) => {
    const at = new Date(t0 + h * 3600_000)
    const v = temp.toFixed(6)
    lines.push(`${stamp(at)},600,${v},${v},${v},${set.toFixed(6)},0.230000,0.000000,25.000000`)
  }
  for (let h = 0; h < rampH; h += stepS / 3600) push(h, ambient + (peak - ambient) * (h / rampH), peak)
  for (let h = rampH; h < rampH + soakH; h += stepS / 3600) push(h, peak, peak)
  for (let h = 0; h <= coolH; h += stepS / 3600) {
    push(rampH + soakH + h, ambient + (peak - ambient) * Math.exp(-k * h), 0)
  }
  return lines.join('\n')
}

console.log('\nMCGS run importer')

// --- parsing --------------------------------------------------------------
const csv = synthesise({ start: new Date(2025, 8, 23, 13, 44, 0), k: 0.0726 })
const parsed = parseCsv(csv)
check('reads every data row', parsed.rows.length > 3000, `${parsed.rows.length} rows`)
check('maps 9 columns, skipping MCGS_TIMEMS', parsed.header.length === 9, parsed.header.join('|').slice(0, 40))
check(
  'temperature is not read from the milliseconds column',
  parsed.rows.every((r) => r.tempA !== 600),
  'a positional slip would put 600 in tempA',
)
check('water temp lands in the last column', parsed.rows[0].waterTemp === 25, String(parsed.rows[0].waterTemp))

// --- BOM ------------------------------------------------------------------
const withBom = parseCsv('﻿' + csv)
check('strips the byte-order mark', withBom.rows.length === parsed.rows.length)

// --- the fit recovers a known k -------------------------------------------
for (const trueK of [0.0726, 0.12, 0.05, 0.2]) {
  const text = synthesise({ start: new Date(2025, 8, 23, 13, 44, 0), k: trueK })
  const { runs } = readRuns(text)
  const got = runs[0]?.fit?.k
  const err = got == null ? Infinity : Math.abs(got - trueK) / trueK
  check(
    `recovers k = ${trueK}`,
    err < 0.02,
    got == null ? 'no fit produced' : `fitted ${got} (${(err * 100).toFixed(2)}% off)`,
  )
}

// --- segmentation ---------------------------------------------------------
const a = synthesise({ start: new Date(2025, 8, 23, 13, 44, 0), k: 0.0726 })
const b = synthesise({ start: new Date(2025, 9, 23, 15, 6, 0), k: 0.0726 })
const twoRuns = a + '\n' + b.split('\n').slice(1).join('\n')
const seg = readRuns(twoRuns)
check('splits a file into separate runs on long gaps', seg.runs.length === 2, `${seg.runs.length} run(s)`)

// --- idle logging is not a run --------------------------------------------
const idle = [
  '"MCGS_TIME","MCGS_TIMEMS","低温测量值1","低温测量值2","低温测量值3","低温设定值1","真空检测数值","压力显示","水温测量值"',
]
for (let i = 0; i < 100; i++) {
  const at = new Date(2025, 10, 17, 21, 50, 0)
  at.setSeconds(at.getSeconds() + i * 30)
  idle.push(`${stamp(at)},600,18.000000,18.000000,18.000000,0.000000,100000.000000,100.000000,24.600000`)
}
const idleResult = readRuns(idle.join('\n'))
check(
  'cold logging is reported, not imported as a run',
  idleResult.runs.length === 0 && idleResult.idleSegments === 1,
  `${idleResult.runs.length} run(s), ${idleResult.idleSegments} idle segment(s)`,
)

// --- element-off detection ------------------------------------------------
const offRun = segment(parseCsv(csv).rows)[0]
check('finds element-off from the set point falling to zero', offRun.heatOffAt != null,
  offRun.heatOffAt ? offRun.heatOffAt.toISOString().slice(0, 16) : 'not found')
check('element-off lands after the soak, not during the ramp',
  offRun.heatOffIndex > 0 && probeMean(offRun.rows[offRun.heatOffIndex]) > 900,
  `${Math.round(probeMean(offRun.rows[offRun.heatOffIndex]) || 0)} C at heat-off`)

// --- the vacuum break ends the usable branch ------------------------------
//
// Under vacuum the furnace cools by radiation, which is what this model
// approximates. Back-filled, it cools by convection — far faster and a
// different shape. Fitting across the vent is what produced a 174 C RMSE on
// real Furnace 3 data, so the cut has to happen.
{
  const trueK = 0.06
  const amb = 20
  const peak = 1000
  const lines = ['"MCGS_TIME","MCGS_TIMEMS","低温测量值1","低温测量值2","低温测量值3","低温设定值1","真空检测数值","压力显示","水温测量值"']
  const t0 = new Date(2025, 8, 23, 13, 44, 0).getTime()
  const row = (h, T, set, vac) => {
    const at = new Date(t0 + h * 3600_000)
    lines.push(`${stamp(at)},600,${T.toFixed(6)},${T.toFixed(6)},${T.toFixed(6)},${set.toFixed(6)},${vac.toFixed(6)},0.000000,25.000000`)
  }
  for (let h = 0; h < 8; h += 30 / 3600) row(h, amb + (peak - amb) * (h / 8), peak, 1)
  // 16 h of true Newton cooling under vacuum
  let vented = amb
  for (let h = 0; h <= 16; h += 30 / 3600) {
    vented = amb + (peak - amb) * Math.exp(-trueK * h)
    row(8 + h, vented, 0, 1 + h)
  }
  // then the chamber is opened: convective collapse, vacuum to atmosphere
  for (let h = 0; h <= 3; h += 30 / 3600) {
    row(24 + h, Math.max(amb, vented * Math.exp(-1.5 * h)), 0, 100000)
  }

  const { runs } = readRuns(lines.join('\n'))
  const fit = runs[0]?.fit
  check('fits through the vacuum branch only', fit != null && Math.abs(fit.k - trueK) / trueK < 0.05,
    fit ? `fitted ${fit.k} vs true ${trueK}` : 'no fit')
  check('reports that the vacuum break ended the fit',
    !!fit?.truncatedBy && fit.truncatedBy.includes('vacuum'),
    fit?.truncatedBy || 'not truncated')
  check('fitting across the vent would have been much worse',
    fit != null && fit.rmse < 15, fit ? `rmse ${fit.rmse}C` : '-')
}

// --- repeated timestamps --------------------------------------------------
//
// The logger sometimes writes a sample twice within one second, differing only
// in MCGS_TIMEMS. Samples are keyed on (run, time), so the second write is
// dropped on insert whatever happens here — but unless it is dropped at parse
// time too, the importer reports a count that can never be reached and the run
// looks permanently one sample short.
{
  const head = '"MCGS_TIME","MCGS_TIMEMS","低温测量值1","低温测量值2","低温测量值3","低温设定值1","真空检测数值","压力显示","水温测量值"'
  const dup = [
    head,
    '2025/11/20 16:28:35,623,14.000000,15.000000,15.000000,0.000000,5000.000000,4.000000,21.600000',
    '2025/11/20 16:29:05,623,14.000000,15.000000,15.000000,0.000000,5000.000000,4.000000,21.600000',
    '2025/11/20 16:29:05,837,14.000000,15.000000,15.000000,0.000000,5000.000000,4.000000,21.600000',
    '2025/11/20 16:29:35,623,14.000000,15.000000,15.000000,0.000000,5000.000000,4.000000,21.600000',
  ].join('\n')
  const r = parseCsv(dup)
  check('a repeated timestamp is dropped', r.rows.length === 3, `${r.rows.length} rows from 4 lines`)
  check('every timestamp is unique after parsing',
    new Set(r.rows.map((x) => x.at.getTime())).size === r.rows.length)
  check('the duplicate is reported rather than hidden',
    r.warnings.some((w) => w.includes('repeated a timestamp')),
    r.warnings.join(' | ') || 'no warning')
}

// --- the two-furnace graphitization layout --------------------------------
//
// This layout is asymmetric in two places and both are easy to transcribe
// backwards, with no symptom except a furnace quietly described by its
// neighbour's numbers:
//
//   the first furnace is measured-then-set, the second is SET-then-measured
//   water temperatures run first-then-second, pressures run SECOND-then-first
//
// So the assertions below check that each channel picks up its own values and
// not the other furnace's.
{
  const head =
    '"MCGS_TIME","MCGS_TIMEMS","F1 measured","F1 set","F2 set","F2 measured","F1 water","F2 water","F2 pressure","F1 pressure"'
  // distinct values per field so a mis-mapped column is unmistakable
  const line = '2025/11/18 12:48:00,600,1111.0,1000.0,2000.0,2222.0,31.0,32.0,62.0,61.0'
  const a = parseCsv([head, line].join('\n'), 'graphitization', 0)
  const b = parseCsv([head, line].join('\n'), 'graphitization', 1)

  check('first furnace takes its own measured temperature', a.rows[0].tempA === 1111, String(a.rows[0].tempA))
  check('first furnace takes its own set point', a.rows[0].setTemp === 1000, String(a.rows[0].setTemp))
  check('second furnace takes its own measured temperature', b.rows[0].tempA === 2222, String(b.rows[0].tempA))
  check('second furnace takes its own set point — not the first one\'s', b.rows[0].setTemp === 2000, String(b.rows[0].setTemp))
  check('water temperatures are first-then-second',
    a.rows[0].waterTemp === 31 && b.rows[0].waterTemp === 32,
    `${a.rows[0].waterTemp} / ${b.rows[0].waterTemp}`)
  check('pressures are second-then-first, the reverse of water',
    a.rows[0].pressure === 61 && b.rows[0].pressure === 62,
    `${a.rows[0].pressure} / ${b.rows[0].pressure}`)
  check('no vacuum channel in this layout', a.rows[0].vacuum === null && b.rows[0].vacuum === null)
  check('the millisecond column is not read as data',
    ![a.rows[0].tempA, a.rows[0].setTemp, a.rows[0].waterTemp, a.rows[0].pressure].includes(600))

  // ...and the same file with no millisecond column must map identically.
  const headNoMs = '"MCGS_TIME","F1 measured","F1 set","F2 set","F2 measured","F1 water","F2 water","F2 pressure","F1 pressure"'
  const lineNoMs = '2025/11/18 12:48:00,1111.0,1000.0,2000.0,2222.0,31.0,32.0,62.0,61.0'
  const c = parseCsv([headNoMs, lineNoMs].join('\n'), 'graphitization', 0)
  const d = parseCsv([headNoMs, lineNoMs].join('\n'), 'graphitization', 1)
  check('a file without the millisecond column maps the same',
    c.rows[0].tempA === 1111 && c.rows[0].setTemp === 1000 && c.rows[0].pressure === 61 &&
      d.rows[0].tempA === 2222 && d.rows[0].pressure === 62,
    `${c.rows[0].tempA}/${c.rows[0].pressure} · ${d.rows[0].tempA}/${d.rows[0].pressure}`)
  check('and does so without a column-count warning',
    c.warnings.length === 0, c.warnings.join(' | '))
}

// --- a paired file yields a run per furnace -------------------------------
{
  const head =
    '"MCGS_TIME","MCGS_TIMEMS","F1 measured","F1 set","F2 set","F2 measured","F1 water","F2 water","F2 pressure","F1 pressure"'
  const lines = [head]
  const t0 = new Date(2025, 10, 18, 12, 48, 0).getTime()
  const amb = 20
  // two furnaces cooling at genuinely different rates
  const kA = 0.12
  const kB = 0.08
  const row = (h, ta, sa, sb, tb, p) => {
    const at = new Date(t0 + h * 3600_000)
    lines.push(`${stamp(at)},600,${ta.toFixed(3)},${sa.toFixed(3)},${sb.toFixed(3)},${tb.toFixed(3)},30.000,31.000,${p.toFixed(3)},${p.toFixed(3)}`)
  }
  const peak = 2800
  for (let h = 0; h < 12; h += 30 / 3600) {
    const T = amb + (peak - amb) * (h / 12)
    row(h, T, peak, peak, T, 1)
  }
  for (let h = 12; h < 13; h += 30 / 3600) row(h, peak, peak, peak, peak, 1)
  for (let h = 0; h <= 18; h += 30 / 3600) {
    row(13 + h, amb + (peak - amb) * Math.exp(-kA * h), 0, 0, amb + (peak - amb) * Math.exp(-kB * h), 1)
  }

  const text = lines.join('\n')
  const first = readRuns(text, { format: 'graphitization', channel: 0 })
  const second = readRuns(text, { format: 'graphitization', channel: 1 })

  check('a run is found for each furnace in the file',
    first.runs.length === 1 && second.runs.length === 1,
    `${first.runs.length} / ${second.runs.length}`)
  check('each furnace fits its own cooling constant',
    Math.abs(first.runs[0].fit.k - kA) / kA < 0.03 && Math.abs(second.runs[0].fit.k - kB) / kB < 0.03,
    `${first.runs[0].fit?.k} vs ${kA}, ${second.runs[0].fit?.k} vs ${kB}`)
  check('the two furnaces are not given the same constant',
    Math.abs(first.runs[0].fit.k - second.runs[0].fit.k) > 0.01,
    `${first.runs[0].fit.k} vs ${second.runs[0].fit.k}`)
  check('a layout without vacuum says the fit was not cut at a vent',
    first.warnings.some((w) => w.includes('no vacuum column')),
    first.warnings.join(' | ') || 'no warning')
}

// --- malformed input ------------------------------------------------------
const junk = parseCsv('"MCGS_TIME","MCGS_TIMEMS","a","b","c","d","e","f","g"\nnot,a,valid,row\n')
check('a malformed row is skipped, not fatal', junk.rows.length === 0 && junk.warnings.length > 0)
check('an empty file is handled', parseCsv('').warnings.length > 0)

// --- the viewer's collapsed time axis -------------------------------------
//
// A chart with a quietly wrong axis still draws a convincing curve, so the
// compression is asserted rather than eyeballed.
{
  const at = (min) => new Date(2025, 8, 23, 0, 0, 0, 0).getTime() + min * 60_000
  const mk = (mins) => mins.map((m) => ({ at: new Date(at(m)) }))

  // 0,1,2 then a three-hour hole, then 183,184
  const tl = buildTimeline(mk([0, 1, 2, 183, 184]))
  check('contiguous samples keep their real spacing', tl.xs[1] === 1 && tl.xs[2] === 2, tl.xs.join(','))
  check('a long gap is compressed to a fixed width', tl.xs[3] === 2 + GAP_DISPLAY, String(tl.xs[3]))
  check('spacing resumes after the gap', tl.xs[4] === 2 + GAP_DISPLAY + 1, String(tl.xs[4]))
  check('the gap is reported so it can be marked', tl.gaps.length === 1 && Math.round(tl.gaps[0].minutes) === 181,
    JSON.stringify(tl.gaps.map((g) => g.minutes)))
  check('a 181-minute hole does not dominate a 4-minute run',
    tl.span < 10, `span ${tl.span} display-minutes`)

  const none = buildTimeline(mk([0, 1, 2, 3]))
  check('no gaps means a plain linear axis', none.gaps.length === 0 && none.span === 3, String(none.span))
  check('an empty sample list is safe', buildTimeline([]).xs.length === 0)

  // decimation must not misreport the plotted range
  const idx = Array.from({ length: 5000 }, (_, i) => i)
  const thin = decimate(idx, 1000)
  check('decimation respects the cap', thin.length <= 1001, `${thin.length} points`)
  check('decimation keeps the first and last sample',
    thin[0] === 0 && thin[thin.length - 1] === 4999, `${thin[0]}..${thin[thin.length - 1]}`)
  check('a short series is left alone', decimate([1, 2, 3], 1000).length === 3)
}

// --- timestamps survive the round trip as wall clock ----------------------
//
// The export has no time zone, so its times are wall clock and stored in a
// `timestamp` column as-is. Using toISOString() anywhere in that path shifts
// every reading by the machine's UTC offset — on import and again on display,
// consistently enough to look right while being hours wrong.
{
  const wall = '2025/09/23 13:44:17'
  const [d] = parseCsv(
    '"MCGS_TIME","MCGS_TIMEMS","a","b","c","d","e","f","g"\n' +
      `${wall},600,500.0,500.0,500.0,1000.0,1.0,0.0,25.0\n`,
  ).rows
  check('parsed as the wall clock printed in the file',
    d.at.getHours() === 13 && d.at.getMinutes() === 44 && d.at.getSeconds() === 17,
    d.at.toString().slice(0, 24))
  check('serialised back to the same wall clock',
    toSqlLocal(d.at) === '2025-09-23 13:44:17', toSqlLocal(d.at))
  check('a database string round trips unchanged',
    toSqlLocal(asDate('2025-09-23 13:44:17')) === '2025-09-23 13:44:17',
    toSqlLocal(asDate('2025-09-23 13:44:17')))
  check('midnight does not roll to the previous day',
    toSqlLocal(asDate('2025-09-23 00:30:00')) === '2025-09-23 00:30:00',
    toSqlLocal(asDate('2025-09-23 00:30:00')))
}

// --- a run resampled into a reference curve -------------------------------
//
// The reference curve is what the planner derives phases, the cooling fit, cycle
// length and capacity from, so a resampling error propagates into every plan
// while still looking like a perfectly reasonable curve.
{
  const trueK = 0.07
  const amb = 20
  const peak = 1000
  const RAMP = 7
  const SOAK = 1
  const lines = ['"MCGS_TIME","MCGS_TIMEMS","低温测量值1","低温测量值2","低温测量值3","低温设定值1","真空检测数值","压力显示","水温测量值"']
  const t0 = new Date(2025, 10, 18, 12, 48, 0).getTime()
  const row = (h, T, set, vac) => {
    const at = new Date(t0 + h * 3600_000)
    lines.push(`${stamp(at)},600,${T.toFixed(6)},${T.toFixed(6)},${T.toFixed(6)},${set.toFixed(6)},${vac.toFixed(6)},0.000000,25.000000`)
  }
  for (let h = 0; h < RAMP; h += 30 / 3600) row(h, amb + (peak - amb) * (h / RAMP), peak, 1)
  for (let h = RAMP; h < RAMP + SOAK; h += 30 / 3600) row(h, peak, peak, 1)
  let last = peak
  for (let h = 0; h <= 12; h += 30 / 3600) {
    last = amb + (peak - amb) * Math.exp(-trueK * h)
    row(RAMP + SOAK + h, last, 0, 1)
  }
  // chamber opened: convective collapse, which must not reach the curve
  for (let h = 0; h <= 3; h += 30 / 3600) row(RAMP + SOAK + 12 + h, Math.max(amb, last * Math.exp(-2 * h)), 0, 100000)

  const { rows: sampleRows } = parseCsv(lines.join('\n'))
  const built = curveFromRun(sampleRows.map((r) => ({ ...r, at: r.at })))

  check('curve starts at hour zero', built.points[0]?.t === 0, String(built.points[0]?.t))
  check('curve is sampled hourly',
    built.points.slice(0, 8).every((p, i) => Math.abs(p.t - i) < 1e-9),
    built.points.slice(0, 4).map((p) => p.t).join(','))
  check('curve stops at the vacuum break',
    built.truncatedAtHours != null && Math.abs(built.truncatedAtHours - 20) < 0.1,
    String(built.truncatedAtHours))
  check('the convective collapse is excluded',
    built.points[built.points.length - 1].T > 300,
    `ends at ${built.points[built.points.length - 1].T} C`)

  const s = summary(built.points)
  check('recovers the heating duration', s && Math.abs(s.heatDuration - RAMP) <= 1, `${s?.heatDuration} h vs ${RAMP}`)
  check('recovers the hold duration', s && Math.abs(s.holdDuration - SOAK) <= 1, `${s?.holdDuration} h vs ${SOAK}`)
  check('recovers the peak', s && Math.abs(s.peakTemp - peak) < 5, `${s?.peakTemp} C`)
  check('the curve refits k close to the true value',
    s?.k != null && Math.abs(s.k - trueK) / trueK < 0.1, `${s?.k} vs ${trueK}`)
  check('unload temperature is the temperature at the vent',
    s && s.unloadTemp === built.points[built.points.length - 1].T, String(s?.unloadTemp))

  // Points must be strictly increasing in t, or the API rejects them and
  // detectPhases would index the wrong sample.
  check('times are strictly increasing',
    built.points.every((p, i) => i === 0 || p.t > built.points[i - 1].t))
  check('no duplicate times', new Set(built.points.map((p) => p.t)).size === built.points.length)
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
