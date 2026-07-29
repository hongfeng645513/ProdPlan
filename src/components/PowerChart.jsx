import { useEffect, useMemo, useRef, useState } from 'react'
import { LOAD_BANDS, clockTicks, hourOfDay, loadColor, num, stamp, dateAt } from '../lib/format.js'

const PAD = { top: 18, right: 18, bottom: 40, left: 58 }

function useWidth() {
  const ref = useRef(null)
  const [w, setW] = useState(760)
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function niceTicks(max, count = 5) {
  if (!(max > 0)) return [0, 1]
  const raw = max / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10
  const steps = Math.max(1, Math.ceil(max / step - 1e-9))
  return Array.from({ length: steps + 1 }, (_, i) => Number((i * step).toFixed(6)))
}

/**
 * Site current over the plan, stacked by what is drawing it.
 *
 * Stacked rather than four separate lines because the only question this chart
 * has to answer is "how close is the top of the stack to the limit" — and the
 * bands underneath say which piece of plant to switch off if it is too close.
 * Squared corners throughout: load steps, it does not ramp between samples.
 */
export default function PowerChart({ electricity, startDate, capAmps, height = 260, theme }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState(null)

  const steps = electricity?.steps || []
  const xMax = steps.length ? steps[steps.length - 1].to : 0
  const capShown = Number.isFinite(capAmps) ? capAmps : 0
  const yMax = Math.max(electricity?.peak || 0, capShown)

  const yTicks = useMemo(() => niceTicks(yMax * 1.08, 5), [yMax])
  const yTop = yTicks[yTicks.length - 1] || 1
  const xTicks = useMemo(
    () => (startDate ? clockTicks(xMax, startDate, Math.min(10, Math.max(4, Math.round(xMax / 8)))) : []),
    [xMax, startDate],
  )

  const plotW = Math.max(10, width - PAD.left - PAD.right)
  const plotH = Math.max(10, height - PAD.top - PAD.bottom)
  const sx = (t) => PAD.left + (t / (xMax || 1)) * plotW
  const sy = (a) => PAD.top + plotH - (a / yTop) * plotH

  /**
   * One closed polygon per band rather than a rectangle per step: adjacent
   * rectangles leave hairline seams where the browser antialiases their shared
   * edge, and on a 168-hour plan that reads as a striped texture rather than a
   * solid band. Square corners come from repeating each x twice.
   */
  const areas = useMemo(() => {
    const stack = steps.map(() => 0)
    return LOAD_BANDS.map((band) => {
      const top = []
      const bottom = []
      steps.forEach((s, i) => {
        const base = stack[i]
        const v = s[band.key] || 0
        stack[i] = base + v
        top.push(`${sx(s.from).toFixed(1)},${sy(base + v).toFixed(1)}`)
        top.push(`${sx(s.to).toFixed(1)},${sy(base + v).toFixed(1)}`)
        bottom.push(`${sx(s.from).toFixed(1)},${sy(base).toFixed(1)}`)
        bottom.push(`${sx(s.to).toFixed(1)},${sy(base).toFixed(1)}`)
      })
      const any = steps.some((s) => (s[band.key] || 0) > 0)
      return {
        key: band.key,
        d: any ? `M${top.join('L')}L${bottom.reverse().join('L')}Z` : null,
      }
    }).filter((a) => a.d)
  }, [steps, yTop, plotW, plotH, width])

  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    const t = ((e.clientX - box.left - PAD.left) / plotW) * xMax
    const s = steps.find((x) => t >= x.from && t < x.to)
    setHover(s ? { t, step: s } : null)
  }

  if (!steps.length) return null

  return (
    <div className="chart" ref={ref}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Site current over the plan"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={sy(v)}
              y2={sy(v)}
              className={v === 0 ? 'axis' : 'gridline'}
            />
            <text x={PAD.left - 8} y={sy(v) + 4} className="tick tick-y">
              {num(v)}
            </text>
          </g>
        ))}

        {areas.map((a) => (
          <path
            key={a.key}
            d={a.d}
            fill={loadColor(a.key, theme)}
            opacity={a.key === 'baseline' ? 0.55 : 0.9}
          />
        ))}

        {Number.isFinite(capAmps) && capAmps > 0 && (
          <g>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={sy(capAmps)}
              y2={sy(capAmps)}
              className="cap-line"
            />
            <text x={PAD.left + plotW} y={sy(capAmps) - 6} className="cap-label">
              limit {num(capAmps)} A
            </text>
          </g>
        )}

        {xTicks.map((v) => (
          <text key={v} x={sx(v)} y={PAD.top + plotH + 20} className="tick tick-x">
            {hourOfDay(startDate, v)}
          </text>
        ))}
        <text x={PAD.left} y={height - 6} className="axis-title">
          Hour of day (HH){startDate ? ` — from ${stamp(startDate)}` : ''}
        </text>
        <text
          className="axis-title"
          transform={`translate(13 ${PAD.top + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          Current (A)
        </text>

        {hover && (
          <line
            x1={sx(hover.t)}
            x2={sx(hover.t)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            className="crosshair"
            pointerEvents="none"
          />
        )}
      </svg>

      {hover && (
        <div
          className="tooltip"
          style={{
            left: `${Math.min(Math.max(sx(hover.t), 70), width - 150)}px`,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="tooltip-title">
            {startDate ? stamp(dateAt(startDate, hover.t)) : `${num(hover.t, 1)} h`}
          </div>
          {LOAD_BANDS.map((b) =>
            hover.step[b.key] > 0 ? (
              <div className="tooltip-row" key={b.key}>
                <span className="key" style={{ background: loadColor(b.key, theme) }} />
                <span className="tooltip-label">{b.label}</span>
                <span className="tooltip-value">{num(hover.step[b.key])} A</span>
              </div>
            ) : null,
          )}
          <div className="tooltip-row">
            <span className="key" style={{ background: 'transparent' }} />
            <span className="tooltip-label">
              <strong>Total</strong>
            </span>
            <span className="tooltip-value">
              <strong>{num(hover.step.total)} A</strong>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
