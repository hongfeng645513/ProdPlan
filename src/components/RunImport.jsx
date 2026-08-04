import { useState } from 'react'
import { readRuns, DEFAULT_GAP_HOURS, FURNACE_GROUPS, FORMATS } from '../lib/runImport.js'
import { num } from '../lib/format.js'
import { toSqlLocal, fmtLocal } from '../lib/runView.js'

/**
 * Import an instrument export and, optionally, adopt the cooling constant it
 * measures.
 *
 * The file is parsed in the browser so the runs it contains can be shown before
 * anything is written. That matters here more than usual: one export covers
 * weeks, contains several firings and several stretches of the logger running
 * against a cold furnace, and the fitted constant is only trustworthy for the
 * runs that cooled with the chamber still sealed. Importing blind would hide all
 * of it.
 *
 * Some files cover two furnaces at once — the graphitization pairs share a
 * logger — so a file is parsed once per furnace and each gets its own runs and
 * its own cooling constant. They are genuinely different furnaces; giving them a
 * shared number because they share a file would be a modelling error, not a
 * simplification.
 */

/**
 * Samples per request.
 *
 * 500 is one INSERT statement server-side, so a chunk is a single database round
 * trip rather than two. Smaller chunks mean more requests but each is quick,
 * which matters on a burstable server where sustained load throttles.
 */
const CHUNK = 500

/** A chunk that has not answered in this long is treated as lost. */
const REQUEST_TIMEOUT_MS = 45000

/** Attempts per request, with a growing pause between them. */
const RETRIES = 3

const fmtDate = (d) => (d ? fmtLocal(d) : '—')

export default function RunImport({ data, canEdit, onChanged }) {
  const [groupId, setGroupId] = useState(FURNACE_GROUPS[0].id)
  const [gapHours, setGapHours] = useState(DEFAULT_GAP_HOURS)
  const [parsed, setParsed] = useState(null) // [{machineId, name, result}]
  const [fileName, setFileName] = useState(null)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState([])
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)

  const group = FURNACE_GROUPS.find((g) => g.id === groupId)
  const format = FORMATS[group.format]
  const known = (id) => data.machines.find((m) => m.id === id)

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setLog([])
    setFileName(file.name)
    try {
      const text = await file.text()
      // One pass per furnace the file covers. Each channel reads its own
      // columns out of the same rows.
      const per = group.machines.map((machineId, channel) => ({
        machineId,
        name: known(machineId)?.name || machineId,
        result: readRuns(text, {
          gapHours: Number(gapHours),
          sourceFile: file.name,
          format: group.format,
          channel,
        }),
      }))
      setParsed(per)
    } catch (err) {
      setError(`Could not read the file: ${err.message}`)
      setParsed(null)
    }
  }

  /**
   * POST with a timeout and retries.
   *
   * Without a timeout a stalled request never settles and the import stops with
   * the progress frozen and nothing said — indistinguishable from still working.
   * A burstable database also slows sharply under sustained inserts, so a chunk
   * that fails once is usually worth trying again.
   */
  const post = async (url, payload, attempt = 1) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 403) throw new Error('You do not have the editor role, so nothing was saved.')
      if (!res.ok) {
        const retriable = res.status >= 500 || res.status === 429
        const message = body.error || body.reason || `Request failed (${res.status})`
        if (retriable && attempt < RETRIES) {
          await new Promise((r) => setTimeout(r, attempt * 1500))
          return post(url, payload, attempt + 1)
        }
        throw new Error(`${message}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`)
      }
      return body
    } catch (err) {
      const timedOut = err.name === 'AbortError'
      if ((timedOut || err.message === 'Failed to fetch') && attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, attempt * 1500))
        return post(url, payload, attempt + 1)
      }
      if (timedOut) {
        throw new Error(`The server did not respond within ${REQUEST_TIMEOUT_MS / 1000}s, after ${attempt} attempts.`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  const doImport = async () => {
    if (!parsed?.length) return
    setBusy(true)
    setError(null)
    setProgress(null)
    const lines = []

    try {
      const totalSamples = parsed.reduce(
        (a, p) => a + p.result.runs.reduce((b, r) => b + r.samples.length, 0),
        0,
      )
      let done = 0

      for (const entry of parsed) {
        for (const run of entry.result.runs) {
          const meta = await post('api/runs', {
            machineId: entry.machineId,
            run: {
              startedAt: toSqlLocal(run.startedAt),
              endedAt: toSqlLocal(run.endedAt),
              heatOffAt: run.heatOffAt ? toSqlLocal(run.heatOffAt) : null,
              sampleCount: run.samples.length,
              peakTempC: run.peakTempC,
              setPointC: run.setPointC,
              sourceFile: run.sourceFile,
              fit: run.fit,
            },
          })

          // Already complete? Skip it. On a resume this is the difference
          // between a few seconds and redoing every insert in the file.
          if (meta.existingSamples >= run.samples.length) {
            done += run.samples.length
            lines.push(`${entry.name} · ${fmtDate(run.startedAt)} — already complete, ${meta.existingSamples.toLocaleString()} samples`)
            setLog([...lines])
            setProgress({ machine: entry.name, percent: Math.round((done / totalSamples) * 100) })
            continue
          }

          let stored = 0
          for (let i = 0; i < run.samples.length; i += CHUNK) {
            const chunk = run.samples.slice(i, i + CHUNK)
            const body = await post(`api/runs/${meta.runId}/samples`, {
              samples: chunk.map((s) => ({
                at: toSqlLocal(s.at),
                tempA: s.tempA, tempB: s.tempB, tempC: s.tempC,
                setTemp: s.setTemp, vacuum: s.vacuum,
                pressure: s.pressure, waterTemp: s.waterTemp,
              })),
            })
            stored = body.total
            done += chunk.length
            setProgress({
              machine: entry.name,
              percent: Math.round((done / totalSamples) * 100),
              stored: body.total,
              runTotal: run.samples.length,
            })
          }

          lines.push(
            `${entry.name} · ${fmtDate(run.startedAt)} — ${stored.toLocaleString()} of ${run.samples.length.toLocaleString()} samples stored`,
          )
          setLog([...lines])
        }
      }
      setProgress(null)
      await onChanged()
    } catch (err) {
      setError(`${err.message} Anything already stored is kept — run the import again to continue from where it stopped.`)
    } finally {
      setBusy(false)
    }
  }

  const applyK = async (machineId, k, source) => {
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

  const totalRuns = parsed?.reduce((a, p) => a + p.result.runs.length, 0) ?? 0

  return (
    <>
      <p className="sub">
        Reads an instrument export and splits it into runs. One file covers weeks and holds several
        firings, so the stretches where the logger ran against a cold furnace are left out.
        {format.furnaces > 1 && ' This layout carries two furnaces in one file; each is read and stored separately.'}
      </p>

      <div className="edit-grid">
        <label>
          Furnaces in this file
          <select value={groupId} onChange={(e) => { setGroupId(e.target.value); setParsed(null) }}>
            {FURNACE_GROUPS.map((g) => (
              <option key={g.id} value={g.id}>{g.label}</option>
            ))}
          </select>
          <span className="hint">{format.label}</span>
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
            {fileName} — {totalRuns} run(s) across {parsed.length} furnace(s)
          </h3>

          {parsed.map((entry) => (
            <FurnacePreview
              key={entry.machineId}
              entry={entry}
              machine={known(entry.machineId)}
              canEdit={canEdit}
              busy={busy}
              onApplyK={applyK}
            />
          ))}

          {canEdit && (
            <div className="edit-actions">
              <button className="btn" onClick={doImport} disabled={busy || !totalRuns}>
                {busy ? 'Importing…' : `Import ${totalRuns} run(s)`}
              </button>
              {progress && (
                <span className="sub import-progress">
                  {progress.machine}
                  {progress.stored != null && ` · ${progress.stored.toLocaleString()} of ${progress.runTotal?.toLocaleString()} in this run`}
                  {' '}· {progress.percent}% overall
                </span>
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

function FurnacePreview({ entry, machine, canEdit, busy, onApplyK }) {
  const { result, name } = entry
  const fits = result.runs.map((r) => r.fit).filter(Boolean)
  const meanK = fits.length ? fits.reduce((a, f) => a + f.k, 0) / fits.length : null
  const curveK = machine?.cooling?.overridden ? machine.cooling.fittedK : machine?.cooling?.k

  return (
    <section className="furnace-preview">
      <h4>
        {name} — {result.runs.length} run(s) from {result.totalRows.toLocaleString()} rows
      </h4>

      {result.warnings.length > 0 && (
        <div className="notice">
          <ul className="notice-list">
            {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {result.runs.length > 0 ? (
        <div className="table-wrap">
          <table>
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
              {result.runs.map((r, i) => (
                <tr key={i}>
                  <th scope="row">{fmtDate(r.startedAt)}</th>
                  <td>{num(r.hours, 1)}</td>
                  <td>{r.sampleCount.toLocaleString()}</td>
                  <td>{num(r.peakTempC)} °C</td>
                  <td>{r.fit ? num(r.fit.k, 4) : <span className="warn-cell">no fit</span>}</td>
                  <td className={r.fit && r.fit.rmse > 30 ? 'warn-cell' : ''}>
                    {r.fit ? `± ${num(r.fit.rmse, 1)} °C` : '—'}
                  </td>
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
      ) : (
        <p className="empty">No firings found for {name} in this file.</p>
      )}

      {meanK != null && machine && curveK && (
        <div className="edit-panel">
          <table className="compare-k">
            <tbody>
              <tr>
                <th scope="row">Measured across {fits.length} run(s)</th>
                <td><strong>{num(meanK, 4)} /h</strong></td>
                <td>half-life {num(Math.log(2) / meanK, 2)} h</td>
              </tr>
              <tr>
                <th scope="row">From the reference curve</th>
                <td>{num(curveK, 4)} /h</td>
                <td>half-life {num(Math.log(2) / curveK, 2)} h</td>
              </tr>
            </tbody>
          </table>
          <p className="sub">
            {meanK < curveK
              ? `${name} cools about ${num((curveK / meanK - 1) * 100, 0)} % slower than its reference curve says, so real cycles are longer than the planner assumes.`
              : `${name} cools about ${num((meanK / curveK - 1) * 100, 0)} % faster than its reference curve says, so real cycles are shorter than the planner assumes.`}
          </p>
          {machine.cooling?.overridden && (
            <p className="sub">Currently overridden to {num(machine.cooling.k, 4)} /h ({machine.cooling.overrideSource}).</p>
          )}
          {canEdit && (
            <div className="edit-actions">
              <button
                className="btn"
                disabled={busy}
                onClick={() => onApplyK(entry.machineId, Math.round(meanK * 100000) / 100000, `mean of ${fits.length} measured run(s)`)}
              >
                Use the measured constant for {name}
              </button>
              {machine.cooling?.overridden && (
                <button className="btn" disabled={busy} onClick={() => onApplyK(entry.machineId, null)}>
                  Reset to the curve fit
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
