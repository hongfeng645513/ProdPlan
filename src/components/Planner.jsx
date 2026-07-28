import { useMemo, useState } from 'react'
import GanttChart from './GanttChart.jsx'
import { planProduction, isCarbonization } from '../lib/schedule.js'
import { PHASES, dateAt, grams, num, phaseColor, span, stamp } from '../lib/format.js'

/** <input type="datetime-local"> speaks local wall-clock text, not Date. */
const toLocalInput = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const fromLocalInput = (s) => {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}
const nextHour = () => {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d
}

function csv(result, startDate) {
  const head = ['Batch', 'Furnace', 'Stage', 'Holders', 'Start', 'Load ends', 'Heat ends', 'Hold ends', 'Cool ends', 'End', 'GF (g)']
  const at = (b, k) => stamp(dateAt(startDate, b.legs.find((l) => l.key === k).to))
  const rows = result.batches.map((b) => [
    b.id,
    b.machineName,
    b.stage,
    b.holders,
    stamp(dateAt(startDate, b.start)),
    at(b, 'load'),
    at(b, 'heat'),
    at(b, 'hold'),
    at(b, 'cool'),
    stamp(dateAt(startDate, b.end)),
    Math.round(b.gfGrams),
  ])
  return [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  )
}

export default function Planner({ machines, rules, paramsFor, theme }) {
  const [mode, setMode] = useState('window')
  const [startText, setStartText] = useState(() => toLocalInput(nextHour()))
  const [endText, setEndText] = useState(() => toLocalInput(new Date(nextHour().getTime() + 7 * 864e5)))
  const [targetKg, setTargetKg] = useState(20)
  const [stockHolders, setStockHolders] = useState(0)
  const [available, setAvailable] = useState(() => machines.map((m) => m.id))
  const [showAll, setShowAll] = useState(false)

  const startDate = fromLocalInput(startText)
  const endDate = fromLocalInput(endText)
  const horizonHours = startDate && endDate ? (endDate - startDate) / 3600_000 : 0
  const windowValid = mode !== 'window' || horizonHours > 0

  const result = useMemo(() => {
    if (!startDate || !windowValid) return null
    return planProduction({
      machines,
      rules,
      availableIds: available,
      paramsFor,
      mode,
      horizonHours,
      targetGrams: Math.max(0, targetKg) * 1000,
      startWipHolders: Math.max(0, stockHolders),
      chain: true,
    })
    // paramsFor is rebuilt on every render by App; the cooling overrides it
    // closes over are what actually matter, so key on those via machines.
  }, [machines, rules, available, mode, horizonHours, targetKg, stockHolders, startText, paramsFor])

  const toggle = (id) =>
    setAvailable((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  const setGroup = (pred) => setAvailable(machines.filter(pred).map((m) => m.id))

  const download = () => {
    const blob = new Blob([csv(result, startDate)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `prodplan-schedule-${toLocalInput(startDate).replace(/[:T]/g, '-')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const finishDate = result && startDate ? dateAt(startDate, result.finishHours) : null
  const shownBatches = result ? (showAll ? result.batches : result.batches.slice(0, 25)) : []

  return (
    <section className="detail planner">
      <h2>Plan production</h2>
      <p className="sub">
        Schedules whole batches across the furnaces you make available, honouring every rule from the
        workbook's <code>Rules</code> sheet. Cycle lengths follow the cooling parameters set on the
        Machines tab, so retuning a furnace there re-plans the line here.
      </p>

      <div className="planner-controls">
        <div className="control-block">
          <span className="control-legend">What do you want to plan?</span>
          <div className="segmented" role="tablist">
            <button
              role="tab"
              aria-selected={mode === 'window'}
              className={mode === 'window' ? 'is-active' : ''}
              onClick={() => setMode('window')}
            >
              A time window
            </button>
            <button
              role="tab"
              aria-selected={mode === 'target'}
              className={mode === 'target' ? 'is-active' : ''}
              onClick={() => setMode('target')}
            >
              An amount of GF
            </button>
          </div>
          <p className="control-hint">
            {mode === 'window'
              ? 'Fill the window and report how much GF comes out.'
              : 'Run from the start time until the target is met, and report when that is.'}
          </p>
        </div>

        <div className="control-block">
          <label htmlFor="plan-start">Start</label>
          <input
            id="plan-start"
            type="datetime-local"
            value={startText}
            onChange={(e) => setStartText(e.target.value)}
          />
          {mode === 'window' ? (
            <>
              <label htmlFor="plan-end">End</label>
              <input
                id="plan-end"
                type="datetime-local"
                value={endText}
                onChange={(e) => setEndText(e.target.value)}
              />
              {!windowValid && <p className="control-error">The end must be after the start.</p>}
              {windowValid && <p className="control-hint">{span(horizonHours)} of production time.</p>}
            </>
          ) : (
            <>
              <label htmlFor="plan-target">Graphite film wanted (kg)</label>
              <input
                id="plan-target"
                type="number"
                min="0"
                step="0.5"
                value={targetKg}
                onChange={(e) => setTargetKg(Number(e.target.value))}
              />
              <p className="control-hint">
                Furnaces run full batches, so the plan meets or slightly overshoots this figure.
              </p>
            </>
          )}
        </div>

        <div className="control-block">
          <label htmlFor="plan-stock">Carbonized stock on hand (holders)</label>
          <input
            id="plan-stock"
            type="number"
            min="0"
            step="1"
            value={stockHolders}
            onChange={(e) => setStockHolders(Number(e.target.value))}
          />
          <p className="control-hint">
            Material already carbonized and waiting. Graphitization can start on this immediately
            instead of waiting for the first carbonization batch.
          </p>
        </div>

        <div className="control-block">
          <span className="control-legend">Furnaces available</span>
          <ul className="furnace-picker">
            {machines.map((m) => (
              <li key={m.id}>
                <label>
                  <input type="checkbox" checked={available.includes(m.id)} onChange={() => toggle(m.id)} />
                  <span>{m.name}</span>
                  <span className="pick-meta">
                    {isCarbonization(m) ? 'Carb' : 'Graph'} · {m.holders} holders
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="picker-actions">
            <button className="link" onClick={() => setGroup(() => true)}>
              All
            </button>
            <button className="link" onClick={() => setGroup(isCarbonization)}>
              Carbonization
            </button>
            <button className="link" onClick={() => setGroup((m) => !isCarbonization(m))}>
              Graphitization
            </button>
            <button className="link" onClick={() => setAvailable([])}>
              None
            </button>
          </div>
        </div>
      </div>

      {!result ? (
        <p className="empty">Set a valid start and end to plan.</p>
      ) : (
        <>
          <div className="stats">
            <Stat
              label="Graphite film produced"
              value={grams(result.totals.gfGrams)}
              sub={`${num(result.totals.gfPerDay / 1000, 2)} kg per day`}
            />
            <Stat
              label={mode === 'window' ? 'Last batch finishes' : 'Target met'}
              value={finishDate ? stamp(finishDate) : '—'}
              sub={result.finishHours ? span(result.finishHours) + ' after start' : 'nothing scheduled'}
              tone={mode === 'target' && !result.reachedTarget ? 'warn' : undefined}
            />
            <Stat
              label="Batches"
              value={num(result.totals.batches)}
              sub={`${result.totals.carbBatches} carbonization · ${result.totals.graphBatches} graphitization`}
            />
            <Stat
              label="Bottleneck"
              value={
                result.bottleneck
                  ? result.bottleneck.stage === 'carbonization'
                    ? 'Carbonization'
                    : 'Graphitization'
                  : '—'
              }
              sub={
                result.bottleneck
                  ? `${num(result.bottleneck.utilization * 100, 0)}% busy vs ${num(result.bottleneck.other * 100, 0)}% on the other stage`
                  : 'both stages need furnaces'
              }
            />
          </div>

          {result.warnings.length > 0 && (
            <ul className="notices">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          {result.batches.length > 0 && (
            <>
              <div className="chart-head">
                <h3>Schedule</h3>
                <ul className="legend">
                  {PHASES.map((p) => (
                    <li key={p.key}>
                      <span className="key" style={{ background: phaseColor(p.key, theme) }} />
                      {p.label}
                    </li>
                  ))}
                </ul>
              </div>
              <GanttChart result={result} startDate={startDate} theme={theme} machines={machines} />

              <div className="table-wrap">
                <table>
                  <caption>Furnace loading over the plan</caption>
                  <thead>
                    <tr>
                      <th scope="col">Furnace</th>
                      <th scope="col">Stage</th>
                      <th scope="col">Cycle</th>
                      <th scope="col">Batches</th>
                      <th scope="col">Busy</th>
                      <th scope="col">Utilization</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.perMachine.map((r) => (
                      <tr key={r.id}>
                        <th scope="row">{r.name}</th>
                        <td>{r.stage === 'carbonization' ? 'Carbonization' : 'Graphitization'}</td>
                        <td>{num(r.cycleHours, 1)} h</td>
                        <td>{r.batches}</td>
                        <td>{span(r.busyHours)}</td>
                        <td>
                          <span className="bar-cell">
                            <span className="bar-fill" style={{ width: `${Math.min(100, r.utilization * 100)}%` }} />
                            <span className="bar-text">{num(r.utilization * 100, 0)}%</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="table-wrap">
                <table>
                  <caption>
                    Batch list — the same data as the timeline, for anyone who needs numbers rather than bars
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Furnace</th>
                      <th scope="col">Stage</th>
                      <th scope="col">Load in</th>
                      <th scope="col">Heat on</th>
                      <th scope="col">Heat off</th>
                      <th scope="col">Out</th>
                      <th scope="col">GF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownBatches.map((b, i) => (
                      <tr key={b.id}>
                        <td>{i + 1}</td>
                        <th scope="row">{b.machineName}</th>
                        <td>{b.stage === 'carbonization' ? 'Carb' : 'Graph'}</td>
                        <td>{stamp(dateAt(startDate, b.start))}</td>
                        <td>{stamp(dateAt(startDate, b.powerFrom))}</td>
                        <td>{stamp(dateAt(startDate, b.powerTo))}</td>
                        <td>{stamp(dateAt(startDate, b.end))}</td>
                        <td>{b.gfGrams ? grams(b.gfGrams) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="table-actions">
                {result.batches.length > 25 && (
                  <button className="btn" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Show first 25' : `Show all ${result.batches.length} batches`}
                  </button>
                )}
                <button className="btn" onClick={download}>
                  Download CSV
                </button>
              </div>
            </>
          )}

          {result.batches.length === 0 && (
            <p className="empty">
              Nothing fits. Widen the window, add furnaces, or start with carbonized stock on hand.
            </p>
          )}

          {result.groupLoad?.length > 0 && (
            <div className="rules-applied">
              <h3>Shared-heating groups</h3>
              <p className="control-hint" style={{ marginTop: 0, marginBottom: 10 }}>
                The sheet states the constraint one pair at a time, but those pairs add up to
                groups. Only one furnace in each group can have its element on at a time, so a
                group at high load is limiting the line no matter how idle the individual
                furnaces look.
              </p>
              <ul className="group-load">
                {result.groupLoad.map((g) => (
                  <li key={g.machines.join()}>
                    <span className="group-names">{g.names.join(' · ')}</span>
                    <span className="bar-cell">
                      <span
                        className="bar-fill"
                        style={{ width: `${Math.min(100, g.utilization * 100)}%` }}
                      />
                      <span className="bar-text">{num(g.utilization * 100, 0)}% heating</span>
                    </span>
                    {!g.complete && (
                      <em className="group-note">
                        partial — not every pair in this group is ruled out
                      </em>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rules-applied">
            <h3>Rules applied</h3>
            <ul>
              {rules.raw.map((r, i) => (
                <li key={i} className={r.parsed ? 'is-on' : 'is-off'}>
                  {r.text}
                  {!r.parsed && <em> — not understood by the parser, so not enforced</em>}
                </li>
              ))}
            </ul>
            <p className="control-hint">
              Read from the <code>Rules</code> sheet of the workbook. Add a rule there and rerun{' '}
              <code>npm run data</code> to have the planner apply it.
            </p>
          </div>
        </>
      )}
    </section>
  )
}
