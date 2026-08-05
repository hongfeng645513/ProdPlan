import { useEffect, useMemo, useState } from 'react'
import GanttChart from './GanttChart.jsx'
import PowerChart from './PowerChart.jsx'
import { planProduction, isCarbonization } from '../lib/schedule.js'
import { resolvePower } from '../lib/power.js'
import { applyEdits, validatePlan, electricityFor, totalsFor } from '../lib/planEdit.js'
import {
  LOAD_BANDS,
  PHASES,
  dateAt,
  grams,
  loadColor,
  num,
  phaseColor,
  span,
  stamp,
} from '../lib/format.js'

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

/** Hour-by-hour current draw, for whoever has to answer to the grid operator. */
function powerCsv(electricity, startDate) {
  const head = [
    'Hour',
    'Clock',
    'R&D + facility (A)',
    'Cooling + vacuum (A)',
    'Coating line (A)',
    'Furnaces heating (A)',
    'Total (A)',
    'Peak in hour (A)',
    'Furnaces on',
  ]
  const rows = electricity.hourly.map((h) => [
    `+${h.hour} h`,
    stamp(dateAt(startDate, h.from)),
    Math.round(h.baseline),
    Math.round(h.support),
    Math.round(h.coating),
    Math.round(h.furnace),
    Math.round(h.total),
    Math.round(h.peak),
    h.furnacesOn.join(' + ') || '—',
  ])
  return [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
}

const download = (text, name) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
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

export default function Planner({ machines, rules, power: powerData, paramsFor, theme }) {
  const [mode, setMode] = useState('window')
  const [startText, setStartText] = useState(() => toLocalInput(nextHour()))
  const [endText, setEndText] = useState(() => toLocalInput(new Date(nextHour().getTime() + 7 * 864e5)))
  const [targetKg, setTargetKg] = useState(20)
  const [stockHolders, setStockHolders] = useState(0)
  const [available, setAvailable] = useState(() => machines.map((m) => m.id))
  const [showAll, setShowAll] = useState(false)
  const [showAllHours, setShowAllHours] = useState(false)

  // Electricity — the two "Unknown" rows on the sheet and the site limit are
  // operator inputs, because nothing in the workbook can supply them.
  const [maxAmps, setMaxAmps] = useState(1000)
  const [rdAmps, setRdAmps] = useState(0)
  const [facilityAmps, setFacilityAmps] = useState(0)
  const [extras, setExtras] = useState({})
  const [coatingOn, setCoatingOn] = useState(true)

  const extraEquipment = useMemo(
    () => (powerData?.equipment || []).filter((e) => e.kind === 'other'),
    [powerData],
  )

  const startDate = fromLocalInput(startText)
  const endDate = fromLocalInput(endText)
  const horizonHours = startDate && endDate ? (endDate - startDate) / 3600_000 : 0
  const windowValid = mode !== 'window' || horizonHours > 0

  const resolved = useMemo(
    () =>
      powerData
        ? resolvePower(powerData, {
            maxAmps: Math.max(0, maxAmps),
            baseline: { 'r-d': Math.max(0, rdAmps), facility: Math.max(0, facilityAmps) },
            extras,
            coating: coatingOn,
          })
        : null,
    [powerData, maxAmps, rdAmps, facilityAmps, extras, coatingOn],
  )

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
      power: resolved,
    })
    // paramsFor is rebuilt on every render by App; the cooling overrides it
    // closes over are what actually matter, so key on those via machines.
  }, [machines, rules, available, mode, horizonHours, targetKg, stockHolders, startText, paramsFor, resolved])

  /**
   * Hand edits, as batch id -> {start, machineId}.
   *
   * Held apart from the generated plan rather than folded into it, so the
   * scheduler's answer is never lost: clearing this restores exactly what it
   * produced. Edits are dropped whenever the inputs change, because a batch id
   * from one plan means nothing in the next.
   */
  const [edits, setEdits] = useState({})
  useEffect(() => setEdits({}), [machines, rules, available, mode, horizonHours, targetKg, stockHolders, startText, resolved])

  /**
   * The plan as edited, re-checked from scratch.
   *
   * The scheduler cannot produce a plan that breaks a rule; a person dragging a
   * batch certainly can. So rather than police the drag, every edited plan is
   * revalidated and every violation named — the planner usually knows something
   * the model does not, but should not be left to discover the consequence.
   */
  const view = useMemo(() => {
    if (!result) return null
    if (!Object.keys(edits).length) {
      return { batches: result.batches, violations: [], electricity: result.electricity, totals: result.totals, edited: 0 }
    }
    const { batches, templates, edited } = applyEdits({ result, machines, rules, paramsFor, edits })
    const electricity = resolved
      ? electricityFor({ batches, machines, templates, resolved, horizonHours: result.horizonHours })
      : null
    const violations = validatePlan({
      batches, machines, rules,
      power: resolved,
      electricity,
      startWipHolders: Math.max(0, stockHolders),
      horizonHours: mode === 'window' ? result.horizonHours : null,
    })
    return { batches, violations, electricity, totals: totalsFor(batches, result.horizonHours), edited: edited.length }
  }, [result, edits, machines, rules, paramsFor, resolved, stockHolders, mode])

  const violationsByBatch = useMemo(() => {
    const map = {}
    for (const v of view?.violations || []) for (const id of v.batchIds) map[id] = true
    return map
  }, [view])

  const moveBatch = (id, to) => setEdits((cur) => ({ ...cur, [id]: to }))

  const toggle = (id) =>
    setAvailable((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  const setGroup = (pred) => setAvailable(machines.filter(pred).map((m) => m.id))

  const stampFile = () => toLocalInput(startDate).replace(/[:T]/g, '-')

  const finishDate = result && startDate ? dateAt(startDate, result.finishHours) : null
  const shownBatches = view ? (showAll ? view.batches : view.batches.slice(0, 25)) : []
  const power = view?.electricity || null
  const shownHours = power ? (showAllHours ? power.hourly : power.hourly.slice(0, 48)) : []
  const headroom = power && Number.isFinite(power.cap) ? power.cap - power.peak : null

  return (
    <section className="detail planner">
      <h2>Plan production</h2>
      <p className="sub">
        Schedules whole batches across the furnaces you make available, honouring every rule from the
        workbook's <code>Rules</code> sheet. Cycle lengths follow the cooling parameters set on the
        Machines tab, so retuning a furnace there re-plans the line here. Give it a site current
        limit and it will also push batches later rather than let the plan go over it, and show you
        what the site draws hour by hour.
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

        {powerData && (
          <div className="control-block">
            <span className="control-legend">Electricity</span>
            <label htmlFor="plan-maxa">Maximum current for the site (A)</label>
            <input
              id="plan-maxa"
              type="number"
              min="0"
              step="10"
              value={maxAmps}
              onChange={(e) => setMaxAmps(Number(e.target.value))}
            />
            <div className="amps-pair">
              <span>
                <label htmlFor="plan-rd">R&amp;D (A)</label>
                <input
                  id="plan-rd"
                  type="number"
                  min="0"
                  step="5"
                  value={rdAmps}
                  onChange={(e) => setRdAmps(Number(e.target.value))}
                />
              </span>
              <span>
                <label htmlFor="plan-fac">Facility (A)</label>
                <input
                  id="plan-fac"
                  type="number"
                  min="0"
                  step="5"
                  value={facilityAmps}
                  onChange={(e) => setFacilityAmps(Number(e.target.value))}
                />
              </span>
            </div>
            <p className="control-hint">
              The sheet lists both as <em>Unknown</em>, so they have to come from you. They are drawn
              for the whole horizon, under everything else.
            </p>
            <ul className="furnace-picker">
              <li>
                <label>
                  <input
                    type="checkbox"
                    checked={coatingOn}
                    onChange={() => setCoatingOn((v) => !v)}
                  />
                  <span>Coating line</span>
                  <span className="pick-meta">
                    {num(resolved?.coating.warmupAmps)} A / {num(resolved?.coating.warmupHours)} h then{' '}
                    {num(resolved?.coating.runAmps)} A
                  </span>
                </label>
              </li>
              {extraEquipment.map((e) => (
                <li key={e.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!extras[e.id]}
                      onChange={() => setExtras((cur) => ({ ...cur, [e.id]: !cur[e.id] }))}
                    />
                    <span>{e.name}</span>
                    <span className="pick-meta">{num(e.maxAmps)} A</span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="control-hint">
              No rule says when these run, so they are off unless you say otherwise. Cooling and vacuum
              systems are not listed — the Rules sheet ties those to their furnaces, and the planner
              switches them on and off with the batches.
            </p>
          </div>
        )}

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
            {power && (
              <Stat
                label="Peak current"
                value={`${num(power.peak)} A`}
                sub={
                  Number.isFinite(power.cap)
                    ? headroom >= 0
                      ? `${num(headroom)} A under the ${num(power.cap)} A limit`
                      : `${num(-headroom)} A OVER the limit`
                    : 'no limit set'
                }
                tone={power.overCap ? 'warn' : undefined}
              />
            )}
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
                  {power?.coatingSegs.length > 0 && (
                    <>
                      <li>
                        <span
                          className="key"
                          style={{ background: loadColor('coating', theme), opacity: 0.45 }}
                        />
                        Coating warm-up
                      </li>
                      <li>
                        <span className="key" style={{ background: loadColor('coating', theme) }} />
                        Coating running
                      </li>
                    </>
                  )}
                </ul>
              </div>
              <p className="hint gantt-hint">
                Drag a batch to move it in time, or onto another furnace of the same stage. The plan
                is re-checked after every move and anything it breaks is listed below.
              </p>

              <GanttChart
                result={{ ...result, batches: view.batches, electricity: view.electricity }}
                startDate={startDate}
                theme={theme}
                machines={machines}
                coatingName={resolved?.coating.name}
                onMoveBatch={moveBatch}
                violationsByBatch={violationsByBatch}
              />

              {view.edited > 0 && (
                <div className={view.violations.length ? 'notice notice-error' : 'notice notice-ok'}>
                  <strong>
                    {view.edited} batch(es) moved by hand
                    {view.violations.length
                      ? ` — ${view.violations.length} constraint(s) broken:`
                      : ' — the plan still obeys every constraint.'}
                  </strong>
                  {view.violations.length > 0 && (
                    <ul className="notice-list">
                      {view.violations.map((v, i) => <li key={i}>{v.message}</li>)}
                    </ul>
                  )}
                  <div className="edit-actions">
                    <button className="btn btn-sm" onClick={() => setEdits({})}>
                      Undo all moves
                    </button>
                  </div>
                </div>
              )}

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
                <button
                  className="btn"
                  onClick={() => download(csv(result, startDate), `prodplan-schedule-${stampFile()}.csv`)}
                >
                  Download schedule CSV
                </button>
              </div>
            </>
          )}

          {power && (
            <>
              <div className="chart-head">
                <h3>Electricity</h3>
                <ul className="legend">
                  {LOAD_BANDS.map((b) => (
                    <li key={b.key}>
                      <span className="key" style={{ background: loadColor(b.key, theme) }} />
                      {b.label}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="control-hint" style={{ marginTop: 0 }}>
                Furnaces draw their rated current on the heating ramp only. Cooling and vacuum systems
                follow the furnaces they serve, from element-on to cool enough to unload, and each one
                is counted once however many of its furnaces are running.
                {resolved?.coating.enabled &&
                  ' The coating line is held up wherever there is headroom; where the line goes flat it has tripped and is paying its warm-up again.'}
              </p>
              <PowerChart
                electricity={power}
                startDate={startDate}
                capAmps={power.cap}
                theme={theme}
              />

              <div className="stats">
                <Stat
                  label="Energy over the plan"
                  value={`${num(power.ampHours)} A·h`}
                  sub={`${num(power.ampHours / Math.max(1, result.horizonHours))} A average`}
                />
                <Stat
                  label="Coating line up"
                  value={`${num(power.coatingUptime * 100)}%`}
                  sub={
                    power.coatingTrips.length
                      ? `${power.coatingTrips.length} restart(s), ${num(resolved.coating.warmupHours)} h each`
                      : 'never interrupted'
                  }
                  tone={power.coatingTrips.length ? 'warn' : undefined}
                />
                <Stat
                  label="Headroom at the peak"
                  value={headroom == null ? '—' : `${num(headroom)} A`}
                  sub={
                    Number.isFinite(power.cap)
                      ? `peak ${num(power.peak)} A of ${num(power.cap)} A`
                      : 'set a maximum to see this'
                  }
                  tone={headroom != null && headroom < 0 ? 'warn' : undefined}
                />
              </div>

              <div className="table-wrap">
                <table>
                  <caption>Total current, hour by hour</caption>
                  <thead>
                    <tr>
                      <th scope="col">In</th>
                      <th scope="col">Clock</th>
                      <th scope="col">R&amp;D + fac.</th>
                      <th scope="col">Cool + vac.</th>
                      <th scope="col">Coating</th>
                      <th scope="col">Furnaces</th>
                      <th scope="col">Total</th>
                      <th scope="col">Heating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownHours.map((h) => (
                      <tr key={h.hour} className={h.peak > power.cap + 1e-3 ? 'is-over' : undefined}>
                        <td>+{h.hour} h</td>
                        <th scope="row">{stamp(dateAt(startDate, h.from))}</th>
                        <td>{num(h.baseline)}</td>
                        <td>{num(h.support)}</td>
                        <td>{num(h.coating)}</td>
                        <td>{num(h.furnace)}</td>
                        <td>
                          <strong>{num(h.total)} A</strong>
                        </td>
                        <td>{h.furnacesOn.join(' + ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="table-actions">
                {power.hourly.length > 48 && (
                  <button className="btn" onClick={() => setShowAllHours((v) => !v)}>
                    {showAllHours ? 'Show first 48 hours' : `Show all ${power.hourly.length} hours`}
                  </button>
                )}
                <button
                  className="btn"
                  onClick={() => download(powerCsv(power, startDate), `prodplan-electricity-${stampFile()}.csv`)}
                >
                  Download electricity CSV
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
