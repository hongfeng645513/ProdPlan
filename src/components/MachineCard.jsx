import { useMemo } from 'react'
import { buildCurve, cycleSummary } from '../lib/cooling.js'
import { clock, degrees, grams, num } from '../lib/format.js'

function Sparkline({ points, color, width = 168, height = 40 }) {
  const d = useMemo(() => {
    const xMax = Math.max(...points.map((p) => p.t)) || 1
    const yMax = Math.max(...points.map((p) => p.T)) || 1
    return points
      .map((p, i) => `${i ? 'L' : 'M'}${((p.t / xMax) * (width - 2) + 1).toFixed(1)},${(height - 3 - (p.T / yMax) * (height - 6)).toFixed(1)}`)
      .join('')
  }, [points, width, height])
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export default function MachineCard({ machine, params, color, selected, onSelect }) {
  const curve = useMemo(() => buildCurve(machine, params, 0.5), [machine, params])
  const cyc = cycleSummary(machine, params)
  const fn = machine.function.toLowerCase().startsWith('carb') ? 'carb' : 'graph'

  return (
    <button
      className={`card${selected ? ' is-selected' : ''}`}
      onClick={() => onSelect(machine.id)}
      aria-pressed={selected}
    >
      <div className="card-head">
        <span className="key" style={{ background: color }} />
        <h3>{machine.name}</h3>
        <span className={`badge badge-${fn}`}>{machine.function}</span>
      </div>
      <p className="card-model">
        {machine.model} · {machine.holders} holders · {machine.gfSize} mm
      </p>
      <Sparkline points={curve} color={color} />
      <dl className="card-stats">
        <div>
          <dt>Peak</dt>
          <dd>{degrees(machine.phases.peakTemp)}</dd>
        </div>
        <div>
          <dt>Cycle</dt>
          <dd>{clock(cyc.total)}</dd>
        </div>
        <div>
          <dt>Out / batch</dt>
          <dd>{grams(machine.capacity.batchOutputG)}</dd>
        </div>
        <div>
          <dt>Per day</dt>
          <dd>{num(cyc.kgPerDay, 2)} kg</dd>
        </div>
      </dl>
    </button>
  )
}
