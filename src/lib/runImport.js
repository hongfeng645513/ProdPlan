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
    /** These thermocouples read all the way down, so nothing is discarded. */
    minValidTempC: null,
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
    /**
     * These pyrometers cannot measure below 1000 C. Under that they drift down
     * to a pinned value around 790 and stay there, so readings below this are
     * not cold measurements — they are the instrument having run out of range.
     * The cooling fit uses nothing below it, and the reference curve continues
     * from here by model rather than by measurement.
     */
    minValidTempC: 1000,
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
  const timeGroups = []
  let cur = [rows[0]]

  for (let i = 1; i < rows.length; i++) {
    if (rows[i].at - rows[i - 1].at > gapMs) {
      timeGroups.push(cur)
      cur = []
    }
    cur.push(rows[i])
  }
  timeGroups.push(cur)

  // Split again on firings.
  //
  // Gaps alone are not enough. The carbonization logger stops between batches,
  // so its gaps happen to line up with its runs — but the graphitization logger
  // never stops, and a week of it arrives as one unbroken block holding two
  // firings and five days of the furnace sitting cold. Segmenting that by time
  // alone produces "runs" of eighty hours that are mostly idle, which is not
  // wrong so much as meaningless.
  //
  // A firing starts when the set point climbs away from its idle baseline. Each
  // one runs until the next begins, so the cool-down stays attached to the batch
  // that produced it.
  const groups = []
  for (const g of timeGroups) {
    const baseline = Math.min(...g.map((r) => r.setTemp ?? 0))
    const margin = 100
    const starts = []
    let above = false
    for (let i = 0; i < g.length; i++) {
      const hot = (g[i].setTemp ?? 0) > baseline + margin
      if (hot && !above) starts.push(i)
      above = hot
    }

    if (!starts.length) {
      groups.push(g)
      continue
    }

    // Trim the idle lead-in.
    //
    // A run has to begin at the start of heating, because everything derived
    // from the curve is measured from t = 0: a furnace that sat cold for forty
    // hours before firing otherwise reports a forty-hour ramp, which is not a
    // small error but a nonsensical one. A short pre-roll is kept so the start
    // of the ramp is not clipped.
    const PRE_ROLL_HOURS = 1
    const trimTo = (startIndex) => {
      const cutoff = g[startIndex].at.getTime() - PRE_ROLL_HOURS * 3600_000
      let i = startIndex
      while (i > 0 && g[i - 1].at.getTime() >= cutoff) i--
      return i
    }

    for (let s = 0; s < starts.length; s++) {
      const from = trimTo(starts[s])
      const to = s + 1 < starts.length ? trimTo(starts[s + 1]) : g.length
      if (to - from > 1) groups.push(g.slice(from, to))
    }
  }

  return groups.map((g) => {
    const temps = g.map((r) => probeMean(r)).filter((x) => x != null)
    const peak = temps.length ? Math.max(...temps) : -Infinity
    const floorTemp = temps.length ? Math.min(...temps) : null

    // Set points are read RELATIVE TO THEIR OWN BASELINE, not against zero.
    //
    // The carbonization controller drops its set point to 0 when the element
    // goes off. The graphitization controllers do not: they fall back to an idle
    // set point of 1000 and sit there. Testing against zero finds no heat-off at
    // all on those furnaces, which silently means no cooling fit rather than a
    // wrong one — easy to miss, since the runs still import.
    const setBaseline = Math.min(...g.map((r) => r.setTemp ?? 0))
    const setPoint = Math.max(...g.map((r) => r.setTemp ?? 0))
    const SET_MARGIN = 100

    // Likewise the idle *temperature* is not ambient. The graphitization
    // pyrometer cannot read below about 790 C and pins there whenever the
    // furnace is cold, so "did it get hot" has to be judged against the reading
    // floor rather than against room temperature.
    const fired =
      setPoint > setBaseline + SET_MARGIN &&
      floorTemp != null &&
      peak > Math.max(floorTemp + IDLE_PEAK_C, IDLE_PEAK_C)

    // Element off: the set point returning to its baseline, looked for only
    // after it has actually climbed above it, so a wobble during the ramp
    // cannot be mistaken for the end of the soak.
    let heatOffIndex = -1
    let climbed = false
    for (let i = 1; i < g.length; i++) {
      const set = g[i].setTemp ?? 0
      if (set > setBaseline + SET_MARGIN) {
        climbed = true
        continue
      }
      if (climbed && set <= setBaseline + SET_MARGIN) {
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
      setBaselineC: setBaseline,
      floorTempC: floorTemp,
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
  // Vacuum first; pressure stands in where there is no vacuum column. Either
  // way the signal is the same: the reading jumping as the chamber returns to
  // atmosphere.
  //
  // The guard matters more than the detection. On the graphitization export
  // pressure sits near atmospheric for the whole run — those furnaces are not
  // held under vacuum the way the carbonization ones are — so a naive threshold
  // fires on the very first sample and truncates the cooling branch to nothing.
  // A vent is only a vent if the chamber was sealed to begin with.
  const start = Math.max(0, fromIndex)
  for (const key of ['vacuum', 'pressure']) {
    const values = rows.map((r) => r[key] ?? 0)
    const max = Math.max(...values)
    if (!(max > 1000)) continue
    const above = max * 0.1
    if (!(values[start] < above)) continue // never sealed: nothing to detect
    for (let i = start; i < rows.length; i++) {
      if (values[i] > above) return i
    }
  }
  return -1
}

export function fitCooling(seg, { ambient = null, minValidTemp = null } = {}) {
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
  const vent = ventIndex(seg.rows, seg.heatOffIndex)
  const ventAtMs = vent > 0 ? seg.rows[vent].at.getTime() : null

  // The reading floor.
  //
  // The graphitization pyrometer cannot measure below about 790 C and pins
  // there whenever the furnace is cold — 60 to 80% of a week-long export is that
  // pinned value. Fitting through it says the furnace stopped cooling for days,
  // which drags k towards zero and reads as a furnace that never loses heat.
  // The branch therefore ends where the reading stops being a measurement.
  const READING_FLOOR_C = 5
  const floorTemp = seg.floorTempC

  const usable = []
  let lowestSoFar = Infinity
  let truncatedAt = null
  let truncatedBy = null

  for (const r of tail) {
    const T = probeMean(r)
    if (T == null) continue
    const h = (r.at.getTime() - tOffMs) / 3600_000
    if (h <= 0) continue

    if (ventAtMs != null && r.at.getTime() >= ventAtMs) {
      truncatedAt = Math.round(h * 100) / 100
      truncatedBy = 'vacuum broken — the chamber was back-filled and cooling switched to convection'
      break
    }
    // Below the instrument's stated range the reading is not a cold
    // measurement, it is an instrument out of range. Stop rather than fit to it.
    if (minValidTemp != null && T < minValidTemp) {
      truncatedAt = Math.round(h * 100) / 100
      truncatedBy = `the reading fell below ${minValidTemp} °C, which this instrument cannot measure`
      break
    }
    if (minValidTemp == null && floorTemp != null && T <= floorTemp + READING_FLOOR_C && floorTemp > 100) {
      truncatedAt = Math.round(h * 100) / 100
      truncatedBy = `the reading reached the bottom of the instrument's range (~${Math.round(floorTemp)} °C) and stopped being a measurement`
      break
    }
    if (T > lowestSoFar + REHEAT_C) {
      truncatedAt = Math.round(h * 100) / 100
      truncatedBy = 'the furnace was re-fired before it finished cooling'
      break
    }
    lowestSoFar = Math.min(lowestSoFar, T)

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
  const minValidTemp = FORMATS[format]?.minValidTempC ?? null

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
      minValidTempC: minValidTemp,
      fit: fitCooling(s, { minValidTemp }),
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
