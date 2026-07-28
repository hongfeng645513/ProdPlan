import { num } from '../lib/format.js'

/** Accessible fallback for the chart: every measured point, plus the model value. */
export default function DataTable({ rows, machine }) {
  const { heatEnd, holdEnd } = machine.phases
  const phaseOf = (t) => (t <= heatEnd ? 'Heating' : t <= holdEnd ? 'Hold' : 'Cooling')
  return (
    <div className="table-wrap">
      <table>
        <caption>{machine.name} — temperature profile from {machine.name}'s sheet in Machines.xlsx</caption>
        <thead>
          <tr>
            <th scope="col">Hour</th>
            <th scope="col">Phase</th>
            <th scope="col">Measured (°C)</th>
            <th scope="col">Model (°C)</th>
            <th scope="col">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.t}>
              <td>{num(r.t)}</td>
              <td>{phaseOf(r.t)}</td>
              <td>{num(r.measured)}</td>
              <td>{r.model == null ? '—' : num(r.model)}</td>
              <td>{r.model == null ? '—' : num(r.measured - r.model)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
