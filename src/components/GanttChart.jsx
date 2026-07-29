import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PHASES,
  dateAt,
  dayStamp,
  grams,
  loadColor,
  num,
  phaseColor,
  span,
  stamp,
} from '../lib/format.js'

const PAD = { top: 10, right: 16, bottom: 46, left: 92 }
const ROW = 30
const BAR = 18

function useWidth() {
  const ref = useRef(null)
  const [w, setW] = useState(900)
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(Math.max(360, e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/**
 * Tick step in hours that keeps labels from colliding: 6 h up to whole weeks,
 * whichever is the first step that leaves at least `minPx` between ticks.
 */
function tickStep(hours, plotW, minPx = 78) {
  const steps = [1, 2, 3, 6, 12, 24, 48, 72, 168, 336, 720]
  const perHour = plotW / (hours || 1)
  return steps.find((s) => s * perHour >= minPx) || steps[steps.length - 1]
}

/** Whole days need only a date; finer steps need the hour too. */
const tickLabel = (d, step) =>
  step >= 24 ? dayStamp(d) : `${dayStamp(d)} ${String(d.getHours()).padStart(2, '0')}:00`

/**
 * Schedule timeline: one row per furnace, one bar per batch, each bar split
 * into its five cycle legs. Bars are the data; the row label and the legend
 * carry identity so nothing depends on colour alone.
 *
 * The coating line gets its own row under the furnaces, ruled off from them
 * because it is a different kind of thing: not a sequence of batches but a plant
 * that wants to be up the whole time, and whose gaps are the interesting part.
 */
export default function GanttChart({ result, startDate, theme, machines, coatingName = 'Coating line' }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState(null)
  const [hoverRun, setHoverRun] = useState(null)

  const rows = useMemo(() => {
    const order = machines.map((m) => m.id).filter((id) => result.perMachine.some((r) => r.id === id))
    return order.map((id) => ({
      ...result.perMachine.find((r) => r.id === id),
      items: result.batches.filter((b) => b.machineId === id),
    }))
  }, [result, machines])

  /**
   * Consecutive warm-up and run segments are one visit from the coating line's
   * point of view — the operator cares where the line went down, not where its
   * current stepped from 200 A to 100 A.
   */
  const coating = useMemo(() => {
    const segs = result.electricity?.coatingSegs || []
    const runs = []
    for (const s of segs) {
      const last = runs[runs.length - 1]
      if (last && Math.abs(last.to - s.from) < 1e-6) {
        last.to = s.to
        last.segs.push(s)
      } else {
        runs.push({ from: s.from, to: s.to, segs: [s] })
      }
    }
    return runs
  }, [result])

  const hasCoating = coating.length > 0
  const bodyRows = rows.length + (hasCoating ? 1 : 0)
  const coatY = PAD.top + rows.length * ROW

  // "Coating line" is longer than any furnace name, so the label gutter grows to
  // fit it rather than letting it collide with the count on the far left.
  const L = hasCoating ? 116 : PAD.left

  const hours = Math.max(result.horizonHours, result.finishHours, 1)
  const height = PAD.top + bodyRows * ROW + PAD.bottom
  const plotW = Math.max(10, width - L - PAD.right)
  const sx = useCallback((h) => L + (h / hours) * plotW, [hours, plotW, L])

  const step = tickStep(hours, plotW)
  const ticks = []
  for (let h = 0; h <= hours + 1e-6; h += step) ticks.push(h)

  // Day boundaries get a stronger rule than the tick grid when ticks are sub-daily.
  const dayLines = []
  if (step < 24) {
    const first = Math.ceil((startDate.getHours() ? 24 - startDate.getHours() : 0) / 24) * 24
    for (let h = first; h <= hours; h += 24) dayLines.push(h)
  }

  if (!rows.length) return null

  return (
    <div className="chart gantt" ref={ref}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Production schedule timeline, one row per furnace plus the coating line"
        onMouseLeave={() => (setHover(null), setHoverRun(null))}
      >
        {ticks.map((h) => (
          <line key={`g${h}`} x1={sx(h)} x2={sx(h)} y1={PAD.top} y2={PAD.top + bodyRows * ROW} className="gridline" />
        ))}
        {dayLines.map((h) => (
          <line key={`d${h}`} x1={sx(h)} x2={sx(h)} y1={PAD.top} y2={PAD.top + bodyRows * ROW} className="dayline" />
        ))}

        {rows.map((r, i) => {
          const y = PAD.top + i * ROW
          return (
            <g key={r.id}>
              {i % 2 === 1 && <rect x={L} y={y} width={plotW} height={ROW} className="row-stripe" />}
              <text x={L - 10} y={y + ROW / 2 + 4} className="gantt-row-label" textAnchor="end">
                {r.name}
              </text>
              <text x={4} y={y + ROW / 2 + 4} className="gantt-row-meta">
                {r.batches}×
              </text>

              {r.items.map((b) => (
                <g key={b.id}>
                  {b.legs.map((leg) => {
                    const x = sx(leg.from)
                    // 2 px of surface between neighbouring segments, but never
                    // let a short leg collapse to nothing.
                    const w = Math.max(1.2, sx(leg.to) - x - 1)
                    return (
                      <rect
                        key={leg.key}
                        x={x}
                        y={y + (ROW - BAR) / 2}
                        width={w}
                        height={BAR}
                        rx={leg.key === 'load' || leg.key === 'unload' ? 2 : 3}
                        fill={phaseColor(leg.key, theme)}
                        className={`gantt-seg${hover?.id === b.id ? ' is-hover' : ''}`}
                      />
                    )
                  })}
                  {/* one transparent hit target per batch, larger than the bar */}
                  <rect
                    x={sx(b.start)}
                    y={y + 2}
                    width={Math.max(6, sx(b.end) - sx(b.start))}
                    height={ROW - 4}
                    fill="transparent"
                    onMouseEnter={() => setHover(b)}
                  />
                </g>
              ))}
            </g>
          )
        })}

        {hasCoating && (
          <g>
            {/* ruled off from the furnaces: continuous plant, not a batch queue */}
            <line x1={L} x2={L + plotW} y1={coatY} y2={coatY} className="row-divider" />
            <text x={L - 10} y={coatY + ROW / 2 + 4} className="gantt-row-label" textAnchor="end">
              {coatingName}
            </text>
            <text x={4} y={coatY + ROW / 2 + 4} className="gantt-row-meta">
              {coating.length}×
            </text>

            {/* the whole horizon as a faint trough, so the gaps read as gaps */}
            <rect
              x={L}
              y={coatY + (ROW - BAR) / 2}
              width={plotW}
              height={BAR}
              rx={3}
              className="coating-trough"
            />

            {coating.map((run, i) => (
              <g key={i}>
                {run.segs.map((s, j) => (
                  <rect
                    key={j}
                    x={sx(s.from)}
                    y={coatY + (ROW - BAR) / 2}
                    width={Math.max(1.2, sx(s.to) - sx(s.from) - (j === run.segs.length - 1 ? 1 : 0))}
                    height={BAR}
                    rx={3}
                    fill={loadColor('coating', theme)}
                    // warm-up draws double and makes nothing — half opacity says
                    // "on but not yet producing" without inventing a second hue
                    opacity={s.phase === 'warmup' ? 0.45 : 1}
                    className={`gantt-seg${hoverRun === i ? ' is-hover' : ''}`}
                  />
                ))}
                <rect
                  x={sx(run.from)}
                  y={coatY + 2}
                  width={Math.max(6, sx(run.to) - sx(run.from))}
                  height={ROW - 4}
                  fill="transparent"
                  onMouseEnter={() => (setHoverRun(i), setHover(null))}
                />
              </g>
            ))}
          </g>
        )}

        <line
          x1={L}
          x2={L + plotW}
          y1={PAD.top + bodyRows * ROW}
          y2={PAD.top + bodyRows * ROW}
          className="axis"
        />
        {ticks.map((h) => (
          <text key={`t${h}`} x={sx(h)} y={PAD.top + bodyRows * ROW + 16} className="tick tick-x">
            {tickLabel(dateAt(startDate, h), step)}
          </text>
        ))}
        <text x={L} y={height - 6} className="axis-title">
          {`Schedule from ${stamp(startDate)} · ${num(hours, 0)} h total`}
        </text>
      </svg>

      {hover && (
        <div
          className="tooltip"
          style={{
            left: `${Math.min(Math.max(sx((hover.start + hover.end) / 2), 90), width - 110)}px`,
            top: `${PAD.top + rows.findIndex((r) => r.id === hover.machineId) * ROW + ROW + 6}px`,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="tooltip-title">
            {hover.machineName} · {hover.stage === 'carbonization' ? 'Carbonization' : 'Graphitization'}
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">Starts</span>
            <span className="tooltip-value">{stamp(dateAt(startDate, hover.start))}</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">Ends</span>
            <span className="tooltip-value">{stamp(dateAt(startDate, hover.end))}</span>
          </div>
          {hover.legs.map((leg) => (
            <div className="tooltip-row" key={leg.key}>
              <span className="key" style={{ background: phaseColor(leg.key, theme) }} />
              <span className="tooltip-label">{PHASES.find((p) => p.key === leg.key).label}</span>
              <span className="tooltip-value">{num(leg.to - leg.from, 1)} h</span>
            </div>
          ))}
          <div className="tooltip-row">
            <span className="tooltip-label">{hover.holders} holders</span>
            <span className="tooltip-value">
              {hover.stage === 'graphitization' ? `${grams(hover.gfGrams)} GF` : 'to stock'}
            </span>
          </div>
        </div>
      )}

      {hoverRun != null && coating[hoverRun] && (
        <div
          className="tooltip"
          style={{
            left: `${Math.min(Math.max(sx((coating[hoverRun].from + coating[hoverRun].to) / 2), 90), width - 110)}px`,
            top: `${coatY + ROW + 6}px`,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="tooltip-title">
            {coatingName} · run {hoverRun + 1} of {coating.length}
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">Up</span>
            <span className="tooltip-value">{stamp(dateAt(startDate, coating[hoverRun].from))}</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">Down</span>
            <span className="tooltip-value">{stamp(dateAt(startDate, coating[hoverRun].to))}</span>
          </div>
          {coating[hoverRun].segs.map((s, j) => (
            <div className="tooltip-row" key={j}>
              <span
                className="key"
                style={{ background: loadColor('coating', theme), opacity: s.phase === 'warmup' ? 0.45 : 1 }}
              />
              <span className="tooltip-label">
                {s.phase === 'warmup' ? 'Warm-up' : 'Running'} at {num(s.amps)} A
              </span>
              <span className="tooltip-value">{num(s.to - s.from, 1)} h</span>
            </div>
          ))}
          <div className="tooltip-row">
            <span className="tooltip-label">This run</span>
            <span className="tooltip-value">{span(coating[hoverRun].to - coating[hoverRun].from)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
