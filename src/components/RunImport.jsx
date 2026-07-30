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

/**
 * Samples per request.
 *
 * 500 is one INSERT statement server-side, so a chunk is a single database
 * round trip rather than two. Smaller chunks mean more requests but each one is
 * quick, which matters on a burstable server where sustained load throttles.
 */
const CHUNK = 500

/** A chunk that has not answered in this long is treated as lost. */
const REQUEST_TIMEOUT_MS = 45000

/** Attempts per request, with a growing pause between them. */
const RETRIES = 3

const fmtDate = (d) => (d ? fmtLocal(d) : '—')

export default function RunImport({ data, canEdit, onChanged }) {
  const [machineId, setMachineId] = useState(SUPPORTED[0])
  const [gapHours, setGapHours] = useState(DEFAULT_GAP_HOURS)
  const [parsed, setParsed] = useState(null)
  const [fileName, setFileName] = useState(null)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState([])
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)

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

  /**
   * Import every run, one chunk of samples at a time.
   *
   * Chunked rather than one request per run: a run is up to seven thousand
   * samples, which as a single body is close to a megabyte and a request lasting
   * tens of seconds. The first attempt at this imported two runs of five and
   * stopped, with nothing on screen to say how far it had got. Chunks make each
   * request small, keep progress visible, and — because appending a sample is
   * idempotent on (run, timestamp) — make a failed import something to run again
   * rather than something to clean up.
   */
  const doImport = async () => {
    if (!parsed?.runs.length) return
    setBusy(true)
    setError(null)
    setProgress(null)
    const lines = []

    /**
     * POST with a timeout and retries.
     *
     * Without a timeout a stalled request simply never settles, and the import
     * stops with the progress frozen and nothing said — which is exactly how
     * this failed before. A burstable database server can also slow sharply
     * under sustained inserts, so a chunk that fails once is usually worth
     * trying again rather than abandoning the whole import.
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

        if (res.status === 403) {
          throw new Error('You do not have the editor role, so nothing was saved.')
        }
        // 5xx and 429 are worth another go; a 400 will fail identically forever.
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
          throw new Error(
            `The server did not respond within ${REQUEST_TIMEOUT_MS / 1000}s, after ${attempt} attempts.`,
          )
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
    }

    try {
      const totalSamples = parsed.runs.reduce((a, r) => a + r.samples.length, 0)
      let done = 0

      for (const [n, run] of parsed.runs.entries()) {
        const meta = await post('api/runs', {
          machineId,
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

        // Already complete? Skip it. Re-sending is harmless but pointless, and
        // on a resume it is the difference between a few seconds and redoing
        // every insert in the file.
        if (meta.existingSamples >= run.samples.length) {
          done += run.samples.length
          lines.push(
            `${fmtDate(run.startedAt)} — already complete, ${meta.existingSamples.toLocaleString()} samples`,
          )
          setLog([...lines])
          setProgress({
            run: n + 1,
            of: parsed.runs.length,
            percent: Math.round((done / totalSamples) * 100),
            stored: meta.existingSamples,
            runTotal: run.samples.length,
          })
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
            run: n + 1,
            of: parsed.runs.length,
            percent: Math.round((done / totalSamples) * 100),
            stored: body.total,
            runTotal: run.samples.length,
          })
        }

        lines.push(
          `${fmtDate(run.startedAt)} — ${stored.toLocaleString()} of ${run.samples.length.toLocaleString()} samples stored` +
            (meta.created ? '' : ' (run already existed; filled in what was missing)'),
        )
        setLog([...lines])
      }
      setProgress(null)
      await onChanged()
    } catch (err) {
      setError(`${err.message} Anything already stored is kept — run the import again to continue from where it stopped.`)
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
              {progress && (
                <span className="sub import-progress">
                  Run {progress.run} of {progress.of} · {progress.stored?.toLocaleString()} of{' '}
                  {progress.runTotal?.toLocaleString()} in this run · {progress.percent}% overall
                </span>
              )}
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
