import { useState } from 'react'
import { readRuns, DEFAULT_GAP_HOURS } from '../lib/runImport.js'
import { num } from '../lib/format.js'
import { toSqlLocal, fmtLocal } from '../lib/runView.js'

/**
 * Import an MCGS instrument export and, optionally, adopt the cooling constant
 * it measures.
 *
 * The file is parsed in the browser so the runs it contains can be shown before
 * anything is written. That matters here more than usual: one export covers
 * weeks, contains several firings and several stretches of the logger running
 * against a cold furnace, and the fitted constant is only trustworthy for the
 * runs that actually cooled under vacuum. Importing blind would hide all of it.
 */

/** Furnaces whose export format is known. Others are added as formats arrive. */
const SUPPORTED = ['furnace-3', 'furnace-4']

const fmtDate = (d) => (d ? fmtLocal(d) : '—')

export default function RunImport({ data, canEdit, onChanged }) {
  const [machineId, setMachineId] = useState(SUPPORTED[0])
  const [gapHours, setGapHours] = useState(DEFAULT_GAP_HOURS)
  const [parsed, setParsed] = useState(null)
  const [fileName, setFileName] = useState(null)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState([])
  const [error, setError] = useState(null)

  const machines = data.machines.filter((m) => SUPPORTED.includes(m.id))
  const machine = data.machines.find((m) => m.id === machineId)

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setLog([])
    setFileName(file.name)
    try {
      const text = await file.text()
      setParsed(readRuns(text, { gapHours: Number(gapHours), sourceFile: file.name }))
    } catch (err) {
      setError(`Could not read the file: ${err.message}`)
      setParsed(null)
    }
  }

  const doImport = async () => {
    if (!parsed?.runs.length) return
    setBusy(true)
    setError(null)
    const lines = []
    try {
      for (const run of parsed.runs) {
        const res = await fetch('api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            machineId,
            run: {
              startedAt: toSqlLocal(run.startedAt),
              endedAt: toSqlLocal(run.endedAt),
              heatOffAt: run.heatOffAt ? toSqlLocal(run.heatOffAt) : null,
              peakTempC: run.peakTempC,
              setPointC: run.setPointC,
              sourceFile: run.sourceFile,
              fit: run.fit,
              samples: run.samples.map((s) => ({
                at: toSqlLocal(s.at),
                tempA: s.tempA, tempB: s.tempB, tempC: s.tempC,
                setTemp: s.setTemp, vacuum: s.vacuum,
                pressure: s.pressure, waterTemp: s.waterTemp,
              })),
            },
          }),
        })
        const body = await res.json().catch(() => ({}))
        if (res.status === 403) throw new Error('You do not have the editor role.')
        if (!res.ok) throw new Error(body.error || `Import failed (${res.status})`)
        lines.push(
          body.skipped
            ? `${fmtDate(run.startedAt)} — already imported, skipped`
            : `${fmtDate(run.startedAt)} — ${body.samples} samples stored`,
        )
        setLog([...lines])
      }
      await onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const fits = parsed?.runs.map((r) => r.fit).filter(Boolean) || []
  const meanK = fits.length ? fits.reduce((a, f) => a + f.k, 0) / fits.length : null
  const workbookK = machine?.cooling?.overridden ? machine.cooling.fittedK : machine?.cooling?.k

  const applyK = async (k, source) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`api/machines/${encodeURIComponent(machineId)}/cooling`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ k, source }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Failed (${res.status})`)
      await onChanged()
      setLog((l) => [...l, k == null ? 'Cooling constant reset to the reference curve fit.' : `Cooling constant set to ${k}.`])
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p className="sub">
        Reads an MCGS export (<code>MCGS_TIME</code>, three probes, set point, vacuum, pressure,
        water). One file covers weeks and holds several firings, so it is split into separate runs
        and the stretches where the logger ran against a cold furnace are left out.
      </p>

      <div className="edit-grid">
        <label>
          Furnace
          <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <span className="hint">Furnaces 1, 2, 5 and 6 use a different export format.</span>
        </label>
        <label>
          Split runs on a gap of
          <input
            type="number" min="0.5" step="0.5" value={gapHours}
            onChange={(e) => setGapHours(e.target.value)}
          />
          <span className="hint">Hours of no logging that starts a new run.</span>
        </label>
        <label>
          CSV file
          <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={!canEdit} />
        </label>
      </div>

      {error && <div className="notice notice-error"><strong>{error}</strong></div>}

      {parsed && (
        <>
          <h3 className="import-head">
            {fileName} — {parsed.totalRows.toLocaleString()} rows, {parsed.runs.length} run(s) found
          </h3>

          {parsed.warnings.length > 0 && (
            <div className="notice">
              <ul className="notice-list">
                {parsed.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          <div className="table-wrap">
            <table>
              <caption>
                Cooling is fitted only while the chamber is under vacuum. Once it is back-filled the
                furnace cools by convection instead of radiation, which this model does not describe.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Hours</th>
                  <th scope="col">Samples</th>
                  <th scope="col">Peak</th>
                  <th scope="col">Fitted k</th>
                  <th scope="col">Fit error</th>
                  <th scope="col">Cooling branch</th>
                </tr>
              </thead>
              <tbody>
                {parsed.runs.map((r, i) => (
                  <tr key={i}>
                    <th scope="row">{fmtDate(r.startedAt)}</th>
                    <td>{num(r.hours, 1)}</td>
                    <td>{r.sampleCount.toLocaleString()}</td>
                    <td>{num(r.peakTempC)} °C</td>
                    <td>{r.fit ? num(r.fit.k, 4) : <span className="warn-cell">no fit</span>}</td>
                    <td>{r.fit ? `± ${num(r.fit.rmse, 1)} °C` : '—'}</td>
                    <td>
                      {r.fit
                        ? `${num(r.fit.coolingHours, 1)} h${r.fit.truncatedBy ? ` — cut short: ${r.fit.truncatedBy}` : ''}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canEdit && (
            <div className="edit-actions">
              <button className="btn" onClick={doImport} disabled={busy || !parsed.runs.length}>
                {busy ? 'Importing…' : `Import ${parsed.runs.length} run(s)`}
              </button>
            </div>
          )}

          {meanK != null && machine && (
            <div className="edit-panel">
              <h3>Cooling constant for {machine.name}</h3>
              <table className="compare-k">
                <tbody>
                  <tr>
                    <th scope="row">Measured across {fits.length} run(s)</th>
                    <td><strong>{num(meanK, 4)} /h</strong></td>
                    <td>half-life {num(Math.log(2) / meanK, 2)} h</td>
                  </tr>
                  <tr>
                    <th scope="row">From the reference curve</th>
                    <td>{num(workbookK, 4)} /h</td>
                    <td>half-life {num(Math.log(2) / workbookK, 2)} h</td>
                  </tr>
                </tbody>
              </table>
              <p className="sub">
                {meanK < workbookK
                  ? `The furnace cools about ${num(((workbookK / meanK) - 1) * 100, 0)} % slower than the reference curve says, so real cycles are longer than the planner currently assumes.`
                  : `The furnace cools about ${num(((meanK / workbookK) - 1) * 100, 0)} % faster than the reference curve says, so real cycles are shorter than the planner currently assumes.`}
              </p>
              {machine.cooling?.overridden && (
                <p className="sub">
                  Currently overridden to {num(machine.cooling.k, 4)} /h ({machine.cooling.overrideSource}).
                </p>
              )}
              {canEdit && (
                <div className="edit-actions">
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => applyK(Math.round(meanK * 100000) / 100000, `mean of ${fits.length} measured run(s), ${fileName}`)}
                  >
                    Use the measured constant
                  </button>
                  {machine.cooling?.overridden && (
                    <button className="btn" disabled={busy} onClick={() => applyK(null)}>
                      Reset to the curve fit
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {log.length > 0 && (
        <div className="notice notice-ok">
          <ul className="notice-list">
            {log.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </div>
      )}
    </>
  )
}
