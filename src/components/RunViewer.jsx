import { useEffect, useMemo, useState } from 'react'
import { num } from '../lib/format.js'
import { buildTimeline, decimate, asDate, fmtLocal, GAP_DISPLAY } from '../lib/runView.js'
import { curveFromRun, summary } from '../lib/curveFromRun.js'
import { FURNACE_GROUPS, FORMATS } from '../lib/runImport.js'

/**
 * View the imported runs for one furnace: temperatures, vacuum, pressure and
 * water temperature over the run, plus the raw samples behind them.
 *
 * Three things about this data drive the design:
 *
 *   gaps      The logger stops and starts. Drawn on a plain time axis, a run
 *             with a three-hour hole in it is mostly empty space with a
 *             straight line drawn across the part where nothing is known. The
 *             axis therefore COLLAPSES gaps: contiguous stretches keep their
 *             true proportions, and a gap becomes a marked break. Tick labels
 *             carry real timestamps so the compression is never hidden.
 *
 *   vacuum    Ranges from 0.1 to 100 000 in a single run — six orders of
 *             magnitude. On a linear axis the entire pumped-down phase, which is
 *             the interesting part, is flat against zero. So it is drawn on a
 *             log axis.
 *
 *   volume    A run is a few thousand 30-second samples. The charts decimate to
 *             keep the SVG manageable and say so; the table windows rather than
 *             rendering every row.
 */

const CHART_W = 900
const PAD = { l: 62, r: 16, t: 12, b: 26 }
const MAX_PLOT_POINTS = 1400


/**
 * One chart. `series` are {key, label, color}; values are read off the samples.
 * `log` switches to a logarithmic y axis for quantities that span decades.
 */
function Chart({ samples, indices, xs, gaps, xFrom, xTo, series, height, log, unit, label }) {
  const plot = useMemo(() => decimate(indices, MAX_PLOT_POINTS), [indices])

  const values = []
  for (const i of indices) {
    for (const s of series) {
      const v = samples[i][s.key]
      if (v != null && Number.isFinite(v)) values.push(v)
    }
  }
  if (!values.length) return <p className="empty">No {label.toLowerCase()} data in this interval.</p>

  // A log axis cannot show zero, and this instrument reports a hard 0 when the
  // gauge bottoms out, so the floor is clamped rather than dropped.
  const FLOOR = 0.01
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (log) {
    lo = Math.max(FLOOR, lo)
    hi = Math.max(lo * 10, hi)
  } else {
    const pad = (hi - lo) * 0.08 || 1
    lo -= pad
    hi += pad
  }

  const h = height - PAD.t - PAD.b
  const w = CHART_W - PAD.l - PAD.r
  const sx = (x) => PAD.l + ((x - xFrom) / Math.max(1e-9, xTo - xFrom)) * w
  const sy = (v) => {
    if (log) {
      const t = (Math.log10(Math.max(FLOOR, v)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))
      return PAD.t + h - t * h
    }
    return PAD.t + h - ((v - lo) / Math.max(1e-9, hi - lo)) * h
  }

  const ticks = log
    ? Array.from({ length: Math.floor(Math.log10(hi)) - Math.ceil(Math.log10(lo)) + 1 }, (_, i) =>
        10 ** (Math.ceil(Math.log10(lo)) + i),
      ).filter((t) => t >= lo && t <= hi)
    : Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4)

  /** Break the path wherever a gap was collapsed — no line across missing data. */
  const pathFor = (key) => {
    const segs = []
    let cur = []
    let prev = null
    for (const i of plot) {
      const v = samples[i][key]
      if (v == null || !Number.isFinite(v)) continue
      if (prev != null && xs[i] - xs[prev] > GAP_DISPLAY + 1e-6) {
        if (cur.length) segs.push(cur)
        cur = []
      }
      cur.push(`${sx(xs[i]).toFixed(1)},${sy(v).toFixed(1)}`)
      prev = i
    }
    if (cur.length) segs.push(cur)
    return segs.map((s) => 'M' + s.join(' L')).join(' ')
  }

  return (
    <div className="run-chart">
      <div className="run-chart-head">
        <strong>{label}</strong>
        <ul className="legend">
          {series.map((s) => (
            <li key={s.key}>
              <span className="key" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      </div>
      <svg viewBox={`0 0 ${CHART_W} ${height}`} className="run-svg" role="img" aria-label={label}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={CHART_W - PAD.r} y1={sy(t)} y2={sy(t)} className="grid-line" />
            <text x={PAD.l - 6} y={sy(t) + 3} textAnchor="end" className="axis-text">
              {log ? (t >= 1000 ? `${t / 1000}k` : t) : num(t, Math.abs(hi - lo) < 10 ? 1 : 0)}
            </text>
          </g>
        ))}
        <text x={10} y={PAD.t + 8} className="axis-text">{unit}</text>

        {gaps
          .filter((g) => g.x >= xFrom && g.x <= xTo)
          .map((g, i) => (
            <line key={i} x1={sx(g.x)} x2={sx(g.x)} y1={PAD.t} y2={PAD.t + h} className="gap-line" />
          ))}

        {series.map((s) => (
          <path key={s.key} d={pathFor(s.key)} fill="none" stroke={s.color} strokeWidth="1.4" />
        ))}
      </svg>
    </div>
  )
}

/**
 * Adopt a run as the furnace's reference curve.
 *
 * Kept behind a confirmation and shown next to what it would change, because the
 * reference curve is what the planner derives phases, the cooling fit, cycle
 * length and batch capacity from — so this alters every plan the furnace appears
 * in, and does so without anything looking obviously different afterwards.
 */
/** Reference curves end where the furnace can be opened. */
const UNLOAD_TARGET_C = 300

/**
 * The lowest temperature this furnace's instrument can actually measure.
 *
 * Derived from the export format rather than stored per run: it is a property
 * of the instrument, not of a particular firing.
 */
function minValidTempFor(machineId) {
  const group = FURNACE_GROUPS.find((g) => g.machines.includes(machineId))
  return group ? FORMATS[group.format]?.minValidTempC ?? null : null
}

function AdoptCurve({ machine, samples, runId, runLabel, run, canEdit, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  const built = useMemo(
    () =>
      samples?.length
        ? curveFromRun(samples, {
            minValidTempC: minValidTempFor(machine.id),
            // Continue the modelled cool-down to the point the furnace can be
            // opened, using this run's own fitted constant.
            extendToC: minValidTempFor(machine.id) != null ? UNLOAD_TARGET_C : null,
            k: run?.fittedK ?? null,
            ambientC: 20,
          })
        : null,
    [samples, run, machine.id],
  )
  const next = useMemo(() => (built?.points?.length ? summary(built.points) : null), [built])
  const now = useMemo(() => summary(machine.measured), [machine.measured])

  if (!built || !next) return null

  const apply = async () => {
    if (!confirm(
      `Replace ${machine.name}'s reference curve with the run of ${runLabel}?\n\n` +
        'Phases, the cooling fit, cycle time and batch capacity all derive from this curve, ' +
        'so every plan for this furnace will change. The previous curve is not kept.',
    )) return

    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`api/machines/${encodeURIComponent(machine.id)}/curve`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          points: built.points,
          runId,
          label: `Measured run of ${runLabel}`,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 403) throw new Error('You do not have the editor role.')
      if (!res.ok) throw new Error(body.error || body.reason || `Failed (${res.status})`)
      setDone(`Reference curve replaced with ${body.points} points from this run.`)
      if (onChanged) await onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const row = (label, a, b, unit = '') => (
    <tr>
      <th scope="row">{label}</th>
      <td>{a == null ? '—' : `${num(a, 2)}${unit}`}</td>
      <td className={a != null && b != null && Math.abs(a - b) > 1e-6 ? 'changed-cell' : ''}>
        {b == null ? '—' : `${num(b, 2)}${unit}`}
      </td>
    </tr>
  )

  return (
    <div className="edit-panel">
      <h3>Use this run as the reference curve</h3>
      <p className="sub">
        The run is resampled hourly from the mean of the three probes.
        {built.truncatedAtHours != null &&
          ` It stops at ${num(built.truncatedAtHours, 1)} h, where the chamber was back-filled — so the unload temperature becomes the temperature at which the furnace is actually opened.`}
        {built.extrapolatedPoints > 0 &&
          ` The last ${built.extrapolatedPoints} point(s) are modelled, not measured: this instrument stops reading at ${minValidTempFor(machine.id)} °C, so the cool-down is continued to ${UNLOAD_TARGET_C} °C with the run's own cooling constant.`}
      </p>

      <div className="table-wrap">
        <table className="compare-curve">
          <thead>
            <tr>
              <th scope="col">Derived from the curve</th>
              <th scope="col">In use now</th>
              <th scope="col">From this run</th>
            </tr>
          </thead>
          <tbody>
            {row('Peak temperature', now?.peakTemp, next.peakTemp, ' °C')}
            {row('Heating', now?.heatDuration, next.heatDuration, ' h')}
            {row('Hold', now?.holdDuration, next.holdDuration, ' h')}
            {row('Cooling', now?.coolDuration, next.coolDuration, ' h')}
            {row('Full cycle', now?.cycleDuration, next.cycleDuration, ' h')}
            {row('Unload temperature', now?.unloadTemp, next.unloadTemp, ' °C')}
            {row('Fitted k', now?.k, next.k, ' /h')}
            {row('Fit error', now?.rmse, next.rmse, ' °C')}
            {row('Points', now?.points, next.points)}
          </tbody>
        </table>
      </div>

      {built.warnings.length > 0 && (
        <div className="notice">
          <ul className="notice-list">
            {built.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {error && <div className="notice notice-error"><strong>{error}</strong></div>}
      {done && <div className="notice notice-ok"><strong>{done}</strong></div>}

      {canEdit ? (
        <div className="edit-actions">
          <button className="btn" onClick={apply} disabled={busy}>
            {busy ? 'Replacing…' : 'Replace the reference curve'}
          </button>
        </div>
      ) : (
        <p className="sub">Replacing the curve requires the <code>editor</code> role.</p>
      )}
    </div>
  )
}

export default function RunViewer({ machine, canEdit, onChanged }) {
  const [runs, setRuns] = useState(null)
  const [runId, setRunId] = useState(null)
  const [samples, setSamples] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [from, setFrom] = useState(0)
  const [to, setTo] = useState(1)
  const [showRows, setShowRows] = useState(false)

  // Runs for this furnace.
  useEffect(() => {
    let live = true
    setRuns(null)
    setSamples(null)
    setRunId(null)
    setError(null)
    fetch(`api/runs?machineId=${encodeURIComponent(machine.id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`API returned ${r.status}`))))
      .then((b) => {
        if (!live) return
        setRuns(b.runs || [])
        if (b.runs?.length) setRunId(b.runs[0].id)
      })
      .catch((err) => live && setError(err.message))
    return () => {
      live = false
    }
  }, [machine.id])

  // Samples for the selected run.
  useEffect(() => {
    if (runId == null) return
    let live = true
    setLoading(true)
    setSamples(null)
    fetch(`api/runs/${runId}/samples`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`API returned ${r.status}`))))
      .then((b) => {
        if (!live) return
        setSamples(b.samples || [])
        setFrom(0)
        setTo(1)
      })
      .catch((err) => live && setError(err.message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [runId])

  const timeline = useMemo(() => (samples?.length ? buildTimeline(samples) : null), [samples])
  // Compared as strings: run ids arrive from a bigserial column, and
  // node-postgres returns bigint as a string. A strict compare against the
  // Number the <select> produces silently yields undefined, which blanks the
  // provenance label and disables the phase presets.
  const run = runs?.find((r) => String(r.id) === String(runId))

  const { indices, xFrom, xTo } = useMemo(() => {
    if (!timeline || !samples?.length) return { indices: [], xFrom: 0, xTo: 1 }
    const a = timeline.span * Math.min(from, to)
    const b = timeline.span * Math.max(from, to)
    const idx = []
    for (let i = 0; i < samples.length; i++) if (timeline.xs[i] >= a && timeline.xs[i] <= b) idx.push(i)
    return { indices: idx, xFrom: a, xTo: b }
  }, [timeline, samples, from, to])

  const downloadCsv = () => {
    const head = 'timestamp,temp_a,temp_b,temp_c,set_temp,vacuum,pressure,water_temp'
    const body = indices
      .map((i) => {
        const s = samples[i]
        return [fmtLocal(s.at), s.tempA, s.tempB, s.tempC, s.setTemp, s.vacuum, s.pressure, s.waterTemp].join(',')
      })
      .join('\n')
    const url = URL.createObjectURL(new Blob([head + '\n' + body], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${machine.id}-run-${runId}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (error) {
    return (
      <section className="detail">
        <h2>Measured runs</h2>
        <div className="notice notice-error"><strong>Could not load runs: {error}</strong></div>
      </section>
    )
  }
  if (runs == null) return <section className="detail"><p className="sub">Loading measured runs…</p></section>
  if (!runs.length) {
    return (
      <section className="detail">
        <h2>Measured runs</h2>
        <p className="empty">
          No imported runs for {machine.name} yet. Import an instrument export under
          <strong> Maintain data → Import runs</strong>.
        </p>
      </section>
    )
  }

  const preset = (a, b) => () => { setFrom(a); setTo(b) }
  const heatOffFraction = () => {
    if (!run?.heatOffAt || !timeline || !samples?.length) return null
    const t = asDate(run.heatOffAt).getTime()
    const i = samples.findIndex((s) => asDate(s.at).getTime() >= t)
    return i < 0 ? null : timeline.xs[i] / timeline.span
  }
  const offAt = heatOffFraction()

  return (
    <section className="detail">
      <h2>Measured runs — {machine.name}</h2>
      {machine.curveSource && (
        <p className="notice notice-ok">
          The reference curve for {machine.name} comes from{' '}
          <strong>{machine.curveSource.label || `run ${machine.curveSource.runId}`}</strong>
          {machine.curveSource.updatedAt && ` — applied ${fmtLocal(machine.curveSource.updatedAt)}`}.
          Phases, cooling and cycle time all derive from it.
        </p>
      )}

      <p className="sub">
        Imported from the instrument log. Time without logging is collapsed on the axis and marked
        with a vertical line, so contiguous stretches keep their real proportions and no line is
        drawn across data that does not exist.
      </p>

      <div className="edit-grid run-controls">
        <label>
          Run ({runs.length} imported)
          <select value={runId ?? ''} onChange={(e) => setRunId(Number(e.target.value))}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {fmtLocal(r.startedAt)} · {num(r.peakTempC)} °C peak · {r.sampleCount.toLocaleString()} samples
                {r.fittedK ? ` · k=${num(r.fittedK, 4)}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Interval start
          <input type="range" min="0" max="1" step="0.005" value={from} onChange={(e) => setFrom(+e.target.value)} />
        </label>
        <label>
          Interval end
          <input type="range" min="0" max="1" step="0.005" value={to} onChange={(e) => setTo(+e.target.value)} />
        </label>
      </div>

      <div className="filters run-presets">
        <button onClick={preset(0, 1)}>Whole run</button>
        {offAt != null && <button onClick={preset(0, offAt)}>Heating &amp; soak</button>}
        {offAt != null && <button onClick={preset(offAt, 1)}>Cooling only</button>}
        <button onClick={preset(0, 0.25)}>First quarter</button>
        <button onClick={preset(0.75, 1)}>Last quarter</button>
      </div>

      {loading && <p className="sub">Loading samples…</p>}

      {samples?.length > 0 && timeline && (
        <>
          <p className="sub run-meta">
            {indices.length.toLocaleString()} of {samples.length.toLocaleString()} samples ·{' '}
            {indices.length > 0 && (
              <>
                {fmtLocal(samples[indices[0]].at)} → {fmtLocal(samples[indices[indices.length - 1]].at)}
              </>
            )}
            {timeline.gaps.length > 0 && ` · ${timeline.gaps.length} logging gap(s) collapsed`}
            {indices.length > MAX_PLOT_POINTS && ` · charts drawn from every ${Math.ceil(indices.length / MAX_PLOT_POINTS)}th sample`}
          </p>

          <Chart
            samples={samples} indices={indices} xs={timeline.xs} gaps={timeline.gaps}
            xFrom={xFrom} xTo={xTo} height={240} unit="°C" label="Temperature"
            series={[
              { key: 'tempA', label: 'Probe A', color: '#eb6834' },
              { key: 'tempB', label: 'Probe B', color: '#2a78d6' },
              { key: 'tempC', label: 'Probe C', color: '#2f8f4e' },
              { key: 'setTemp', label: 'Set point', color: '#898781' },
            ]}
          />
          <Chart
            samples={samples} indices={indices} xs={timeline.xs} gaps={timeline.gaps}
            xFrom={xFrom} xTo={xTo} height={170} unit="vacuum (log)" label="Vacuum degree" log
            series={[{ key: 'vacuum', label: 'Vacuum', color: '#7b4fd1' }]}
          />
          <Chart
            samples={samples} indices={indices} xs={timeline.xs} gaps={timeline.gaps}
            xFrom={xFrom} xTo={xTo} height={150} unit="pressure" label="Pressure"
            series={[{ key: 'pressure', label: 'Pressure', color: '#c2185b' }]}
          />
          <Chart
            samples={samples} indices={indices} xs={timeline.xs} gaps={timeline.gaps}
            xFrom={xFrom} xTo={xTo} height={150} unit="°C" label="Water temperature"
            series={[{ key: 'waterTemp', label: 'Water', color: '#0f8b8d' }]}
          />

          <div className="edit-actions">
            <button className="btn" onClick={() => setShowRows(!showRows)}>
              {showRows ? 'Hide' : 'Show'} raw data
            </button>
            <button className="btn" onClick={downloadCsv}>Download interval as CSV</button>
          </div>

          <AdoptCurve
            machine={machine}
            samples={samples}
            runId={runId}
            runLabel={run ? fmtLocal(run.startedAt) : ''}
            run={run}
            canEdit={canEdit}
            onChanged={onChanged}
          />

          {showRows && (
            <div className="table-wrap raw-table">
              <table>
                <caption>
                  Raw samples in the selected interval
                  {indices.length > 500 && ' — first 500 shown; use the CSV for all of them'}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">A</th>
                    <th scope="col">B</th>
                    <th scope="col">C</th>
                    <th scope="col">Set</th>
                    <th scope="col">Vacuum</th>
                    <th scope="col">Pressure</th>
                    <th scope="col">Water</th>
                  </tr>
                </thead>
                <tbody>
                  {indices.slice(0, 500).map((i) => {
                    const s = samples[i]
                    return (
                      <tr key={i}>
                        <th scope="row">{fmtLocal(s.at)}</th>
                        <td>{num(s.tempA)}</td>
                        <td>{num(s.tempB)}</td>
                        <td>{num(s.tempC)}</td>
                        <td>{num(s.setTemp)}</td>
                        <td>{num(s.vacuum, s.vacuum < 10 ? 2 : 0)}</td>
                        <td>{num(s.pressure, 1)}</td>
                        <td>{num(s.waterTemp, 1)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
