import { useEffect, useMemo, useState } from 'react'
import data from './data/machines.json'
import ProcessFlow from './components/ProcessFlow.jsx'
import MachineCard from './components/MachineCard.jsx'
import MachineDetail from './components/MachineDetail.jsx'
import TemperatureChart from './components/TemperatureChart.jsx'
import { buildCurve, cycleSummary, defaultParams } from './lib/cooling.js'
import { clock, degrees, grams, num, seriesColor } from './lib/format.js'

const STORE_KEY = 'prodplan.cooling.v1'

const readStore = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
  } catch {
    return {}
  }
}
const writeStore = (v) => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v))
  } catch {
    /* storage unavailable — parameters simply stay in memory */
  }
}

export default function App() {
  const machines = data.machines
  const colorIndex = useMemo(() => Object.fromEntries(machines.map((m, i) => [m.id, i])), [machines])

  const [theme, setTheme] = useState('light')
  const [selected, setSelected] = useState(machines[0]?.id)
  const [view, setView] = useState('machines')
  const [filter, setFilter] = useState('all')
  const [overrides, setOverrides] = useState(readStore)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => writeStore(overrides), [overrides])

  const paramsFor = (m) => ({ ...defaultParams(m), ...(overrides[m.id] || {}) })
  const color = (m) => seriesColor(colorIndex[m.id], theme)

  const shown = machines.filter(
    (m) => filter === 'all' || m.function.toLowerCase().startsWith(filter),
  )
  const current = machines.find((m) => m.id === selected) || machines[0]

  // Furnaces that currently share an identical profile are drawn as one line —
  // six lines stacked on the same pixels would hide five of them. They separate
  // automatically as soon as their cooling parameters are tuned apart.
  const compareGroups = []
  for (const m of shown) {
    const points = buildCurve(m, paramsFor(m), 0.5)
    const sig = points.map((p) => `${p.t}:${p.T.toFixed(1)}`).join('|')
    const hit = compareGroups.find((g) => g.sig === sig)
    if (hit) hit.machines.push(m)
    else compareGroups.push({ sig, points, machines: [m] })
  }
  const compareSeries = compareGroups.map((g) => ({
    id: g.machines[0].id,
    label: g.machines.map((m) => m.name.replace('Furnace ', 'F')).join(', '),
    color: color(g.machines[0]),
    points: g.points,
  }))
  const groupColor = Object.fromEntries(
    compareGroups.flatMap((g) => g.machines.map((m) => [m.id, color(g.machines[0])])),
  )
  const merged = compareGroups.some((g) => g.machines.length > 1)

  const totals = machines.reduce(
    (acc, m) => {
      const c = cycleSummary(m, paramsFor(m))
      const key = m.function.toLowerCase().startsWith('carb') ? 'carb' : 'graph'
      acc[key] += c.kgPerDay
      return acc
    },
    { carb: 0, graph: 0 },
  )

  return (
    <div className="app viz-root">
      <header className="topbar">
        <div>
          <h1>ProdPlan — furnace overview</h1>
          <p className="sub">
            GO film line · {machines.length} furnaces · source <code>{data.source}</code>
          </p>
        </div>
        <div className="topbar-actions">
          <div className="capacity-pill">
            <span>Nominal capacity</span>
            <strong>
              {num(totals.carb, 1)} kg/day carbonization · {num(totals.graph, 1)} kg/day graphitization
            </strong>
          </div>
          <button className="btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Light' : 'Dark'} mode
          </button>
        </div>
      </header>

      <ProcessFlow
        machines={machines}
        selected={selected}
        onSelect={(id) => {
          setSelected(id)
          setView('machines')
        }}
      />

      <nav className="toolbar">
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={view === 'machines'}
            className={view === 'machines' ? 'is-active' : ''}
            onClick={() => setView('machines')}
          >
            Machines
          </button>
          <button
            role="tab"
            aria-selected={view === 'compare'}
            className={view === 'compare' ? 'is-active' : ''}
            onClick={() => setView('compare')}
          >
            Compare curves
          </button>
        </div>
        <div className="filters">
          {[
            ['all', 'All'],
            ['carb', 'Carbonization'],
            ['graph', 'Graphitization'],
          ].map(([k, label]) => (
            <button key={k} className={filter === k ? 'is-active' : ''} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </nav>

      {view === 'machines' ? (
        <>
          <div className="grid">
            {shown.map((m) => (
              <MachineCard
                key={m.id}
                machine={m}
                params={paramsFor(m)}
                color={color(m)}
                selected={m.id === selected}
                onSelect={setSelected}
              />
            ))}
          </div>
          {current && shown.some((m) => m.id === current.id) && (
            <MachineDetail
              machine={current}
              params={paramsFor(current)}
              color={color(current)}
              onParams={(p) => setOverrides({ ...overrides, [current.id]: p })}
              onReset={() => {
                const next = { ...overrides }
                delete next[current.id]
                setOverrides(next)
              }}
            />
          )}
        </>
      ) : (
        <section className="detail">
          <h2>Temperature profiles</h2>
          <p className="sub">
            Solid = measured heating and hold. Dashed = modelled natural cooling, using each furnace's own
            cooling constant.
            {merged && ' Furnaces whose profiles are currently identical share one line.'}
          </p>
          <ul className="legend">
            {compareSeries.map((s) => (
              <li key={s.id}>
                <span className="key" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
          <TemperatureChart series={compareSeries} height={420} showArea={false} labelEnds={compareSeries.length <= 4} />

          <div className="table-wrap">
            <table>
              <caption>Cycle comparison under current cooling parameters</caption>
              <thead>
                <tr>
                  <th scope="col">Furnace</th>
                  <th scope="col">Function</th>
                  <th scope="col">Model</th>
                  <th scope="col">Holders</th>
                  <th scope="col">Peak</th>
                  <th scope="col">Heat</th>
                  <th scope="col">Hold</th>
                  <th scope="col">Cool</th>
                  <th scope="col">Cycle</th>
                  <th scope="col">Out / batch</th>
                  <th scope="col">kg / day</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => {
                  const c = cycleSummary(m, paramsFor(m))
                  return (
                    <tr key={m.id}>
                      <th scope="row">
                        <span className="key" style={{ background: groupColor[m.id] }} />
                        {m.name}
                      </th>
                      <td>{m.function}</td>
                      <td>{m.model}</td>
                      <td>{m.holders}</td>
                      <td>{degrees(m.phases.peakTemp)}</td>
                      <td>{clock(c.heat)}</td>
                      <td>{clock(c.hold)}</td>
                      <td>{clock(c.cool)}</td>
                      <td>{clock(c.total)}</td>
                      <td>{grams(m.capacity.batchOutputG)}</td>
                      <td>{num(c.kgPerDay, 2)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="footer">
        Machine properties and temperature curves are read from <code>Machine/{data.source}</code> —
        rerun <code>npm run data</code> after editing the workbook. Cooling parameters you adjust here are
        kept in this browser only.
      </footer>
    </div>
  )
}
