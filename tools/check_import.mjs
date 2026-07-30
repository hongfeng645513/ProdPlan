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
import { buildTimeline, decimate, GAP_DISPLAY } from '../src/lib/runView.js'

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

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
