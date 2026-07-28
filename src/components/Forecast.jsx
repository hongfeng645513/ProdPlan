import { useMemo, useState } from 'react'
import TemperatureChart from './TemperatureChart.jsx'
import { forecast } from '../lib/forecast.js'
import { clock, dateAt, degrees, num, seriesColor, stamp } from '../lib/format.js'

const toLocalInput = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const fromLocalInput = (s) => {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Where is one furnace headed, hour by hour, from wherever it is right now.
 *
 * Deliberately separate from the planner: the planner reasons about batches
 * that have not started, this answers a question about metal that is already
 * hot. The only shared assumption is the cooling constant.
 */
export default function Forecast({ machines, paramsFor, theme, colorIndex }) {
  const [machineId, setMachineId] = useState(machines[0]?.id)
  const [state, setState] = useState('cooling')
  const [tempText, setTempText] = useState(() => String(machines[0]?.phases.peakTemp ?? 1000))
  const [timeText, setTimeText] = useState(() => toLocalInput(new Date()))
  const [hoursAhead, setHoursAhead] = useState(24)

  const machine = machines.find((m) => m.id === machineId) || machines[0]
  const params = paramsFor(machine)
  const startDate = fromLocalInput(timeText)
  const temp = Number(tempText)
  const tempValid = tempText.trim() !== '' && Number.isFinite(temp)
  const color = seriesColor(colorIndex[machine.id] ?? 0, theme)

  const result = useMemo(
    () => (tempValid ? forecast(machine, params, { state, temp, hours: hoursAhead }) : null),
    [machine, params.k, params.ambient, params.unloadTemp, state, temp, hoursAhead, tempValid],
  )

  const series = result?.valid
    ? [{ id: machine.id, label: machine.name, color, points: result.points }]
    : []

  const setNow = () => setTimeText(toLocalInput(new Date()))
  const useSetPoint = () => setTempText(String(Math.round(machine.phases.peakTemp)))
  const useRoom = () => setTempText(String(Math.round(params.ambient)))

  return (
    <section className="detail planner forecast">
      <h2>Where is a furnace headed?</h2>
      <p className="sub">
        Tell it which furnace, how hot it is now and whether the element is on. It projects the
        temperature forward hour by hour. Cooling is modelled from the temperature you enter, so it
        works from any starting point; heating follows the controlled ramp in the workbook.
      </p>

      <div className="planner-controls">
        <div className="control-block">
          <label htmlFor="fc-machine">Furnace</label>
          <select id="fc-machine" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {m.function}
              </option>
            ))}
          </select>
          <p className="control-hint">
            Set point {degrees(machine.phases.peakTemp)} · room {degrees(params.ambient)} · k{' '}
            {num(params.k, 4)} /h
          </p>
        </div>

        <div className="control-block">
          <span className="control-legend">Element</span>
          <div className="segmented" role="tablist">
            <button
              role="tab"
              aria-selected={state === 'heating'}
              className={state === 'heating' ? 'is-active' : ''}
              onClick={() => setState('heating')}
            >
              Heating
            </button>
            <button
              role="tab"
              aria-selected={state === 'cooling'}
              className={state === 'cooling' ? 'is-active' : ''}
              onClick={() => setState('cooling')}
            >
              Cooling
            </button>
          </div>
          <p className="control-hint">
            {state === 'heating'
              ? 'On — the furnace follows its recipe up to the set point, then holds there.'
              : 'Off — natural cooling towards room temperature.'}
          </p>
        </div>

        <div className="control-block">
          <label htmlFor="fc-temp">Temperature now (°C)</label>
          <input
            id="fc-temp"
            type="number"
            step="10"
            value={tempText}
            onChange={(e) => setTempText(e.target.value)}
          />
          {!tempValid && <p className="control-error">Enter a temperature.</p>}
          <div className="picker-actions">
            <button className="link" onClick={useSetPoint}>
              Set point
            </button>
            <button className="link" onClick={useRoom}>
              Room
            </button>
          </div>
        </div>

        <div className="control-block">
          <label htmlFor="fc-time">Time</label>
          <input
            id="fc-time"
            type="datetime-local"
            value={timeText}
            onChange={(e) => setTimeText(e.target.value)}
          />
          <div className="picker-actions">
            <button className="link" onClick={setNow}>
              Now
            </button>
          </div>
          <label htmlFor="fc-hours">Hours ahead</label>
          <input
            id="fc-hours"
            type="number"
            min="1"
            max="168"
            step="1"
            value={hoursAhead}
            onChange={(e) => setHoursAhead(Math.max(1, Math.min(168, Number(e.target.value) || 1)))}
          />
        </div>
      </div>

      {!result || !startDate ? (
        <p className="empty">Enter a temperature and a valid time.</p>
      ) : (
        <>
          {result.warnings.length > 0 && (
            <ul className="notices">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          {result.valid && (
            <>
              {result.milestones.length > 0 && (
                <div className="stats">
                  {result.milestones.map((m) => (
                    <div className="stat" key={m.key}>
                      <span className="stat-label">{m.label}</span>
                      <strong className="stat-value">
                        {m.asPosition ? clock(m.hours) : stamp(dateAt(startDate, m.hours))}
                      </strong>
                      <span className="stat-sub">
                        {m.asPosition
                          ? 'into the recipe — the rest follows from here'
                          : m.hours <= 0
                            ? 'already there'
                            : `in ${clock(m.hours)}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="chart-head">
                <h3>Projected temperature</h3>
                <p className="control-hint" style={{ margin: 0 }}>
                  {state === 'heating'
                    ? 'Solid — the controlled ramp, straight from the workbook.'
                    : 'Dashed — modelled cooling, using this furnace’s own constant.'}
                </p>
              </div>
              <TemperatureChart
                series={series}
                height={320}
                showArea
                labelEnds={false}
                xLabel={`Hours from ${stamp(startDate)}`}
              />

              <div className="table-wrap">
                <table>
                  <caption>Hour by hour</caption>
                  <thead>
                    <tr>
                      <th scope="col">In</th>
                      <th scope="col">Clock</th>
                      <th scope="col">Temperature</th>
                      <th scope="col">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.table.map((row, i) => {
                      const prev = i > 0 ? result.table[i - 1].T : null
                      const d = prev == null ? null : row.T - prev
                      return (
                        <tr key={row.h}>
                          <td>{row.h === 0 ? 'now' : `+${row.h} h`}</td>
                          <th scope="row">{stamp(dateAt(startDate, row.h))}</th>
                          <td>{degrees(row.T)}</td>
                          <td className="delta">
                            {d == null ? '—' : `${d > 0 ? '+' : ''}${num(d, 0)} °C`}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
