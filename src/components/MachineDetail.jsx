import { useMemo, useState } from 'react'
import TemperatureChart from './TemperatureChart.jsx'
import DataTable from './DataTable.jsx'
import { buildCurve, coolingSamples, coolingTemp, cycleSummary, defaultParams, hoursToTemp, modelError } from '../lib/cooling.js'
import { clock, degrees, grams, num } from '../lib/format.js'

function Spec({ label, value, hint }) {
  return (
    <div className="spec">
      <dt>{label}</dt>
      <dd>
        {value}
        {hint && <span className="hint"> {hint}</span>}
      </dd>
    </div>
  )
}

export default function MachineDetail({ machine, params, color, onParams, onReset }) {
  const [showTable, setShowTable] = useState(false)
  const curve = useMemo(() => buildCurve(machine, params), [machine, params])
  const cyc = cycleSummary(machine, params)
  const samples = coolingSamples(machine)
  const rmse = modelError(machine, params)
  const fit = machine.cooling
  const fn = machine.function.toLowerCase().startsWith('carb') ? 'carb' : 'graph'
  const isDefault =
    Math.abs(params.k - fit.k) < 1e-9 &&
    params.ambient === fit.ambient &&
    params.unloadTemp === machine.phases.unloadTemp

  const set = (patch) => onParams({ ...params, ...patch })

  return (
    <section className="detail">
      <header className="detail-head">
        <div>
          <h2>
            <span className="key key-lg" style={{ background: color }} />
            {machine.name}
          </h2>
          <p className="sub">
            {machine.model} · <span className={`badge badge-${fn}`}>{machine.function}</span>
          </p>
        </div>
        <div className="headline">
          <span className="headline-label">Cycle time</span>
          <span className="headline-value">{clock(cyc.total)}</span>
          <span className="headline-sub">
            {num(cyc.batchesPerDay, 2)} batches / day · {num(cyc.kgPerDay, 2)} kg / day
          </span>
        </div>
      </header>

      <dl className="specs">
        <Spec label="Function" value={machine.function} />
        <Spec label="Model" value={machine.model} />
        <Spec label="Holders" value={num(machine.holders)} />
        <Spec label="GF size" value={`${machine.gfSize} mm`} />
        <Spec label="GF per holder" value={grams(machine.gfPerHolder)} />
        <Spec label="Yield" value={`${num(machine.yield * 100, 0)} %`} />
        <Spec label="Load per batch" value={grams(machine.capacity.batchInputG)} hint={`${machine.holders} × ${machine.gfPerHolder} g`} />
        <Spec label="Output per batch" value={grams(machine.capacity.batchOutputG)} hint={`at ${num(machine.yield * 100, 0)} % yield`} />
        <Spec label="Set point" value={degrees(machine.phases.peakTemp)} />
        <Spec label="Unload at" value={degrees(params.unloadTemp)} />
      </dl>

      <div className="phase-bar" role="img" aria-label="Cycle phase breakdown">
        {[
          { key: 'heat', label: 'Heating', v: cyc.heat },
          { key: 'hold', label: 'Hold', v: cyc.hold },
          { key: 'cool', label: 'Cooling', v: cyc.cool },
        ].map((p) => (
          <div key={p.key} className={`phase phase-${p.key}`} style={{ flexGrow: Math.max(p.v, 0.01) }}>
            <span className="phase-label">{p.label}</span>
            <span className="phase-value">{clock(p.v)}</span>
          </div>
        ))}
      </div>

      <TemperatureChart
        series={[{ id: machine.id, label: machine.name, color, points: curve }]}
        phases={machine.phases}
        samples={Object.assign(samples, { color })}
        height={360}
      />

      <p className="legend-note">
        <span className="line-key" style={{ background: color }} /> measured / controlled ramp &nbsp;
        <span className="line-key dashed" style={{ borderColor: color }} /> modelled natural cooling &nbsp;
        <span className="dot-key" style={{ background: color }} /> measured cooling sample
      </p>

      <div className="tuning">
        <h3>Cooling model</h3>
        <p className="tuning-intro">
          Heating and hold are controlled and accurate. Cooling is natural, so it is modelled as
          <code> T = T₍room₎ + (T₍off₎ − T₍room₎)·e^(−k·Δt)</code> from heat-off at {num(fit.tOff)} h /{' '}
          {degrees(fit.tempAtOff)}. Tune <em>k</em> per furnace as insulation and room conditions change.
        </p>

        <div className="controls">
          <label className="control">
            <span>
              Room temperature <strong>{degrees(params.ambient)}</strong>
            </span>
            <input
              type="range"
              min="5"
              max="45"
              step="1"
              value={params.ambient}
              onChange={(e) => set({ ambient: Number(e.target.value) })}
            />
          </label>

          <label className="control">
            <span>
              Cooling constant k <strong>{num(params.k, 4)} /h</strong>
              <span className="hint"> half-life {num(Math.log(2) / params.k, 2)} h</span>
            </span>
            <input
              type="range"
              min="0.02"
              max="0.30"
              step="0.001"
              value={params.k}
              onChange={(e) => set({ k: Number(e.target.value) })}
            />
          </label>

          <label className="control">
            <span>
              Unload temperature <strong>{degrees(params.unloadTemp)}</strong>
            </span>
            <input
              type="range"
              min="50"
              max="600"
              step="10"
              value={params.unloadTemp}
              onChange={(e) => set({ unloadTemp: Number(e.target.value) })}
            />
          </label>
        </div>

        <div className="fit-row">
          <div className="fit-stat">
            <span>Cooling time to {degrees(params.unloadTemp)}</span>
            <strong>{clock(hoursToTemp(machine, params, params.unloadTemp))}</strong>
          </div>
          <div className="fit-stat">
            <span>Model vs {samples.length} measured points</span>
            <strong>± {num(rmse, 0)} °C RMSE</strong>
          </div>
          <div className="fit-stat">
            <span>Workbook fit</span>
            <strong>k = {num(fit.k, 4)} /h</strong>
          </div>
          <button className="btn" onClick={onReset} disabled={isDefault}>
            Reset to workbook fit
          </button>
        </div>
      </div>

      <div className="table-toggle">
        <button className="btn" onClick={() => setShowTable((v) => !v)} aria-expanded={showTable}>
          {showTable ? 'Hide' : 'Show'} data table
        </button>
      </div>
      {showTable && (
        <DataTable
          rows={machine.measured.map((p) => ({
            t: p.t,
            measured: p.T,
            model: p.t > fit.tOff ? coolingTemp(machine, params, p.t) : null,
          }))}
          machine={machine}
        />
      )}
    </section>
  )
}
