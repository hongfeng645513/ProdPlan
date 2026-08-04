/**
 * Read an MCGS instrument export into runs.
 *
 * The export is one long CSV covering weeks of logging, and it is NOT one run:
 * the logger keeps writing between batches, so a single file contains several
 * firings separated by hours or weeks, plus stretches where the furnace simply
 * sat cold. Importing it as a continuous trace would be wrong in a way that is
 * hard to see later, so this module splits it and classifies what it finds.
 *
 * Column mapping is POSITIONAL, deliberately. The Furnace 3 export heads its
 * temperature columns 低温测量值 ("low temperature"), because carbonization runs
 * to 1000 °C. The graphitization furnaces run to 2800 °C and their exports are
 * expected to use different headers. Matching on those strings would work
 * perfectly until the first Furnace 1 file and then fail confusingly, so the
 * header is used only as a sanity check on shape.
 *
 *   MCGS_TIME, MCGS_TIMEMS, temp1, temp2, temp3, setpoint, vacuum, pressure, water
 *        0           1        2      3      4       5         6        7       8
 *
 * Note MCGS_TIMEMS: the export carries a millisecond column between the
 * timestamp and the first temperature. It is ignored, but it has to be counted
 * or every column after it lands one place to the left.
 */

/** A gap longer than this starts a new run. Hours. */
export const DEFAULT_GAP_HOURS = 4

/**
 * The export layouts, by furnace type.
 *
 * Columns are read by POSITION, not by header name. The carbonization export
 * heads its temperature columns 低温测量值 ("low temperature") because those
 * furnaces run to 1000 C; the graphitization furnaces run to 2800 C and will not
 * use the same words. Matching on those strings would work perfectly until the
 * first Furnace 1 file.
 *
 * `msColumn` is the awkward part. The Furnace 3 export carries an MCGS_TIMEMS
 * column between the timestamp and the data — undocumented, and if it is not
 * counted every field after it lands one place to the left, which reads as
 * plausible numbers in the wrong columns rather than as an error. Both layouts
 * therefore declare their column count with and without it, and the parser
 * decides from the header row which it is looking at.
 */
export const FORMATS = {
  /** Furnaces 3 and 4: one furnace per file, three probes, vacuum gauge. */
  carbonization: {
    id: 'carbonization',
    label: 'Furnace 3 or 4 (one furnace per file)',
    furnaces: 1,
    widthWithMs: 9,
    widthWithoutMs: 8,
    /** offsets are relative to the first data column, after any ms column */
    channels: [{ tempA: 0, tempB: 1, tempC: 2, setTemp: 3, vacuum: 4, pressure: 5, waterTemp: 6 }],
  },

  /**
   * Furnaces 1+2 and 5+6: two furnaces share one file.
   *
   * The layout is asymmetric and easy to transcribe wrongly, so it is written
   * out rather than derived:
   *
   *   0 first furnace  measured temperature
   *   1 first furnace  set temperature
   *   2 second furnace SET temperature      <- set and measured are the other
   *   3 second furnace MEASURED temperature <- way round for the second furnace
   *   4 first furnace  water temperature
   *   5 second furnace water temperature
   *   6 second furnace pressure             <- pressures are second-then-first,
   *   7 first furnace  pressure             <- the reverse of the water columns
   *
   * There is no vacuum column, which is why `ventIndex` falls back to pressure.
   */
  graphitization: {
    id: 'graphitization',
    label: 'Furnaces 1+2 or 5+6 (two furnaces per file)',
    furnaces: 2,
    widthWithMs: 10,
    widthWithoutMs: 9,
    channels: [
      { tempA: 0, setTemp: 1, waterTemp: 4, pressure: 7 }, // first furnace
      { tempA: 3, setTemp: 2, waterTemp: 5, pressure: 6 }, // second furnace
    ],
  },
}

/** Which furnaces each file covers, in the order the format's channels are listed. */
export const FURNACE_GROUPS = [
  { id: 'furnace-1-2', label: 'Furnace 1 and 2', format: 'graphitization', machines: ['furnace-1', 'furnace-2'] },
  { id: 'furnace-3', label: 'Furnace 3', format: 'carbonization', machines: ['furnace-3'] },
  { id: 'furnace-4', label: 'Furnace 4', format: 'carbonization', machines: ['furnace-4'] },
  { id: 'furnace-5-6', label: 'Furnace 5 and 6', format: 'graphitization', machines: ['furnace-5', 'furnace-6'] },
]

/** Below this peak, with no set point, a segment is idle logging rather than a firing. */
const IDLE_PEAK_C = 60

export const EXPECTED_COLUMNS = 9

/**
 * MCGS writes "2025/09/22 22:11:17" with no time zone. Parsed as a naive local
 * wall clock and kept that way — inventing an offset would shift every reading.
 */
function parseTimestamp(s) {
  const m = String(s).trim().match(/^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi, sec] = m
  return new Date(+y, +mo - 1, +d, +h, +mi, +sec)
}

const num = (v) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse the CSV text into rows. Returns {rows, warnings, header}.
 * Never throws on a bad line — a single malformed row in 20 000 should not
 * lose the import, so bad rows are counted and reported.
 */
export function parseCsv(text, formatId = 'carbonization', channel = 0) {
  const format = FORMATS[formatId]
  if (!format) return { rows: [], warnings: [`Unknown format "${formatId}".`], header: [] }

  const warnings = []
  // Excel and MCGS both like a BOM; left in place it corrupts the first header.
  const clean = text.replace(/^﻿/, '')
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (!lines.length) return { rows: [], warnings: ['The file is empty.'], header: [] }

  const header = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim())

  // Decide whether the millisecond column is present from the width, and
  // corroborate with the header text where it names itself.
  let dataStart
  if (header.length === format.widthWithMs) dataStart = 2
  else if (header.length === format.widthWithoutMs) dataStart = 1
  else {
    dataStart = /ms$/i.test(header[1] || '') ? 2 : 1
    warnings.push(
      `Expected ${format.widthWithoutMs} or ${format.widthWithMs} columns for this layout, found ${header.length}. ` +
        'Columns are read by position, so check the values below before importing — a different layout ' +
        'puts plausible numbers in the wrong fields rather than failing outright.',
    )
  }
  if (dataStart === 2 && !/ms$/i.test(header[1] || '')) {
    warnings.push(
      `Treating column 2 ("${header[1]}") as a milliseconds column and ignoring it, based on the column count.`,
    )
  }

  const map = format.channels[channel]
  if (!map) return { rows: [], warnings: [`This layout has no furnace ${channel + 1}.`], header }
  const minWidth = dataStart + Math.max(...Object.values(map)) + 1

  const rows = []
  let bad = 0
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',')
    const at = parseTimestamp(c[0])
    if (!at || c.length < minWidth) {
      bad++
      continue
    }
    const pick = (key) => (map[key] == null ? null : num(c[dataStart + map[key]]))
    rows.push({
      at,
      tempA: pick('tempA'),
      tempB: pick('tempB'),
      tempC: pick('tempC'),
      setTemp: pick('setTemp'),
      vacuum: pick('vacuum'),
      pressure: pick('pressure'),
      waterTemp: pick('waterTemp'),
    })
  }

  if (bad) warnings.push(`${bad} line(s) could not be read and were skipped.`)
  rows.sort((a, b) => a.at - b.at)

  // Drop repeated timestamps.
  //
  // The logger occasionally writes the same sample twice within one second,
  // distinguished only by the MCGS_TIMEMS column — the Furnace 3 export has two
  // such pairs, with identical readings. A sample is keyed on (run, time), so
  // the database collapses them anyway; deduplicating here means the count the
  // importer reports matches the count that lands, instead of every affected
  // run being reported as one sample short forever.
  const deduped = []
  let duplicates = 0
  let lastMs = null
  for (const r of rows) {
    const ms = r.at.getTime()
    if (ms === lastMs) {
      duplicates++
      continue
    }
    deduped.push(r)
    lastMs = ms
  }
  if (duplicates) {
    warnings.push(
      `${duplicates} sample(s) repeated a timestamp already recorded and were dropped ` +
        '— the logger wrote them twice within the same second.',
    )
  }
  rows.length = 0
  rows.push(...deduped)

  // An export that lands on a round number is usually a capped export, not a
  // complete history. Worth saying rather than silently importing a truncation.
  if (rows.length === 20000 || rows.length === 10000 || rows.length === 50000) {
    warnings.push(
      `Exactly ${rows.length} rows — MCGS exports are often capped at a round number, ` +
        'so earlier data may be missing from this file.',
    )
  }

  return { rows, warnings, header }
}

/** Mean of whichever probes reported, or null if none did. */
export function probeMean(row) {
  const xs = [row.tempA, row.tempB, row.tempC].filter((x) => x != null)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

/**
 * Split rows into segments on time gaps, and say what each one is.
 *
 * A segment that never had a set point and never got warm is the logger idling
 * between batches — real in the file, but not a run. It is reported and
 * excluded rather than dropped silently, because "9 segments, 5 of them
 * firings" is a fact worth showing the person doing the import.
 */
export function segment(rows, gapHours = DEFAULT_GAP_HOURS) {
  if (!rows.length) return []
  const gapMs = gapHours * 3600_000
  const groups = []
  let cur = [rows[0]]

  for (let i = 1; i < rows.length; i++) {
    if (rows[i].at - rows[i - 1].at > gapMs) {
      groups.push(cur)
      cur = []
    }
    cur.push(rows[i])
  }
  groups.push(cur)

  return groups.map((g) => {
    const peak = Math.max(...g.map((r) => probeMean(r) ?? -Infinity))
    const setPoint = Math.max(...g.map((r) => r.setTemp ?? 0))
    const fired = setPoint > 0 && peak > IDLE_PEAK_C

    // Element off: the first sample where the set point falls away to nothing.
    let heatOffIndex = -1
    for (let i = 1; i < g.length; i++) {
      if ((g[i].setTemp ?? 0) === 0 && (g[i - 1].setTemp ?? 0) > 0) {
        heatOffIndex = i
        break
      }
    }

    return {
      rows: g,
      startedAt: g[0].at,
      endedAt: g[g.length - 1].at,
      sampleCount: g.length,
      peakTempC: Number.isFinite(peak) ? peak : null,
      setPointC: setPoint,
      fired,
      heatOffIndex,
      heatOffAt: heatOffIndex >= 0 ? g[heatOffIndex].at : null,
      hours: (g[g.length - 1].at - g[0].at) / 3600_000,
    }
  })
}

/**
 * Refit Newton's law of cooling against a run's own cooling branch.
 *
 *     T(t) = Tamb + (Toff - Tamb) * exp(-k * (t - tOff))
 *
 * Same one-parameter model and same least-squares-on-log-excess as the workbook
 * fit in derive.js, so a refitted k is directly comparable with the one it would
 * replace. What differs is the source: thousands of real 30-second samples from
 * this furnace as it is now, rather than a dozen hourly points recorded once.
 *
 * Anchored on the measured heat-off point. Returns null when the run has no
 * usable cooling branch — a run that was stopped early, or never fired, has
 * nothing to say about how the furnace cools.
 */
/**
 * Index at which the chamber was back-filled, or -1.
 *
 * The threshold comes from the run's own vacuum range rather than a fixed
 * number, because the instrument's units are not guaranteed to be the same on
 * every furnace. Shared by the cooling fit and the reference-curve builder so
 * both cut at the same place.
 */
export function ventIndex(rows, fromIndex = 0) {
  // Vacuum first. The graphitization export has no vacuum column, so pressure
  // stands in — the signal being looked for is the same either way: the reading
  // jumping by orders of magnitude as the chamber returns to atmosphere.
  for (const key of ['vacuum', 'pressure']) {
    const values = rows.map((r) => r[key] ?? 0)
    const max = Math.max(...values)
    if (!(max > 1000)) continue
    const above = max * 0.1
    for (let i = Math.max(0, fromIndex); i < rows.length; i++) {
      if (values[i] > above) return i
    }
  }
  return -1
}

export function fitCooling(seg, { ambient = null } = {}) {
  if (!seg.fired || seg.heatOffIndex < 0) return null

  const tail = seg.rows.slice(seg.heatOffIndex)
  if (tail.length < 10) return null

  // Ambient: the coldest thing seen in the run, capped at 25 °C — the same
  // convention the workbook fit uses, so the two remain comparable.
  const coldest = Math.min(...seg.rows.map((r) => probeMean(r)).filter((x) => x != null))
  const amb = ambient ?? Math.min(coldest, 25)

  const tOffMs = tail[0].at.getTime()
  const tempAtOff = probeMean(tail[0])
  const excess0 = tempAtOff - amb
  if (!(excess0 > 0)) return null

  // Stop when the cooling stops being the cooling this model describes.
  //
  // Two things end the usable branch, and both produce a confident, meaningless
  // k if fitted through:
  //
  //   vented   Under vacuum the furnace loses heat by radiation, which is what
  //            Newton's law approximates here. Back-fill the chamber and it
  //            cools by convection instead — a different mechanism entirely.
  //            On the Furnace 3 data this shows as 196 °C -> 46 °C while the
  //            vacuum reading jumps from 43 to 90 000, and fitting across it
  //            gave an RMSE of 174 °C reported as though it were a measurement.
  //
  //   reheat   A furnace re-fired for the next batch before it has cooled out.
  //            Newton cooling only ever descends.
  //
  // The vent threshold is taken from the run's own vacuum range rather than a
  // fixed number, because the instrument's units are not guaranteed to be the
  // same on every furnace.
  const REHEAT_C = 5
  const maxVacuum = Math.max(...seg.rows.map((r) => r.vacuum ?? 0))
  const ventAbove = maxVacuum > 1000 ? maxVacuum * 0.1 : Infinity

  const usable = []
  let floor = Infinity
  let truncatedAt = null
  let truncatedBy = null

  for (const r of tail) {
    const T = probeMean(r)
    if (T == null) continue
    const h = (r.at.getTime() - tOffMs) / 3600_000
    if (h <= 0) continue

    if ((r.vacuum ?? 0) > ventAbove) {
      truncatedAt = Math.round(h * 100) / 100
      truncatedBy = 'vacuum broken — the chamber was back-filled and cooling switched to convection'
      break
    }
    if (T > floor + REHEAT_C) {
      truncatedAt = Math.round(h * 100) / 100
      truncatedBy = 'the furnace was re-fired before it finished cooling'
      break
    }
    floor = Math.min(floor, T)

    if (T - amb <= 1) continue
    usable.push({ h, T })
  }
  if (usable.length < 5) return null

  let numer = 0
  let denom = 0
  for (const p of usable) {
    numer += p.h * -Math.log((p.T - amb) / excess0)
    denom += p.h * p.h
  }
  if (denom === 0) return null
  const k = numer / denom
  if (!(k > 0)) return null

  const model = (h) => amb + excess0 * Math.exp(-k * h)
  const rmse = Math.sqrt(
    usable.reduce((a, p) => a + (p.T - model(p.h)) ** 2, 0) / usable.length,
  )

  return {
    k: Math.round(k * 100000) / 100000,
    ambient: amb,
    tempAtOff,
    rmse: Math.round(rmse * 10) / 10,
    points: usable.length,
    coolingHours: Math.round(usable[usable.length - 1].h * 100) / 100,
    halfLifeHours: Math.round((Math.log(2) / k) * 100) / 100,
    // Set when the branch was cut short; the fit covers only the hours up to
    // that point, and `truncatedBy` says what ended it.
    truncatedAtHours: truncatedAt,
    truncatedBy,
  }
}

/**
 * Whole-file pipeline: text in, importable runs out.
 * Pure — no network, no database — so the same code runs in the browser for the
 * preview and under Node in the tests.
 */
export function readRuns(text, { gapHours = DEFAULT_GAP_HOURS, sourceFile = null, format = 'carbonization', channel = 0 } = {}) {
  const { rows, warnings, header } = parseCsv(text, format, channel)
  const segments = segment(rows, gapHours)

  const runs = segments
    .filter((s) => s.fired)
    .map((s) => ({
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      sampleCount: s.sampleCount,
      peakTempC: Math.round(s.peakTempC * 10) / 10,
      setPointC: s.setPointC,
      heatOffAt: s.heatOffAt,
      hours: Math.round(s.hours * 10) / 10,
      fit: fitCooling(s),
      samples: s.rows,
      sourceFile,
    }))

  const idle = segments.filter((s) => !s.fired)
  if (idle.length) {
    warnings.push(
      `${idle.length} segment(s) were the logger running while the furnace was cold ` +
        '(no set point, never warmed) and are not imported.',
    )
  }
  const noFit = runs.filter((r) => !r.fit).length
  if (noFit) {
    warnings.push(`${noFit} run(s) have no usable cooling branch, so no cooling constant was fitted.`)
  }
  // Without a signal for the chamber returning to atmosphere, a fit can span two
  // different cooling mechanisms and still look convincing. Say so.
  const unvented = runs.filter((r) => r.fit && !r.fit.truncatedBy).length
  if (unvented && runs.some((r) => r.samples.every((s) => s.vacuum == null))) {
    warnings.push(
      `${unvented} fit(s) were not cut at a chamber vent — this layout has no vacuum column, so the ` +
        'cooling constant may span both the sealed and the opened phase. Check the fit error before trusting it.',
    )
  }

  return {
    runs,
    idleSegments: idle.length,
    warnings,
    header,
    totalRows: rows.length,
    format,
    channel,
  }
}
