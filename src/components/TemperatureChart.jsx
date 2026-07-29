import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clockTicks, hourOfDay, num } from '../lib/format.js'

const BASE_PAD = { top: 18, right: 30, bottom: 40, left: 58 }

/** Reserve room on the right for the longest end-label so nothing overflows. */
function padFor(series, labelEnds) {
  if (!labelEnds || series.length > 4) return BASE_PAD
  const longest = series.reduce((n, s) => Math.max(n, s.label.length), 0)
  return { ...BASE_PAD, right: Math.min(150, 24 + longest * 6.6) }
}

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

/** Ticks from 0 to at least `max`, on a 1/2/2.5/5/10 step — the top tick always
 *  covers the data, so nothing is ever drawn outside the plot box. */
function niceTicks(max, count = 5) {
  if (!(max > 0)) return [0, 1]
  const raw = max / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10
  const steps = Math.max(1, Math.ceil(max / step - 1e-9))
  return Array.from({ length: steps + 1 }, (_, i) => Number((i * step).toFixed(6)))
}

/**
 * Temperature vs time. One or more furnace cycles on a single axis.
 * Solid = measured / controlled heating; dashed = modelled natural cooling.
 *
 * Pass `xOrigin` (a Date) to label the x-axis with the hour of the day (HH)
 * instead of hours elapsed.
 */
export default function TemperatureChart({
  series,
  phases = null,
  samples = null,
  height = 340,
  showArea = true,
  labelEnds = true,
  xLabel = 'Time since load (hours)',
  xOrigin = null,
}) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState(null)
  const PAD = useMemo(() => padFor(series, labelEnds), [series, labelEnds])

  const { xMax, yMax } = useMemo(() => {
    let x = 0
    let y = 0
    for (const s of series)
      for (const p of s.points) {
        if (p.t > x) x = p.t
        if (p.T > y) y = p.T
      }
    return { xMax: Math.ceil(x), yMax: y }
  }, [series])

  const yTicks = useMemo(() => niceTicks(yMax * 1.06, 5), [yMax])
  const yTop = yTicks[yTicks.length - 1] || 1
  const xTicks = useMemo(() => {
    const count = Math.min(8, Math.max(4, Math.round(xMax / 6)))
    return xOrigin
      ? clockTicks(xMax, xOrigin, count)
      : niceTicks(xMax, count).filter((v) => v <= xMax + 1e-9)
  }, [xMax, xOrigin])

  const xTickLabel = useCallback((v) => (xOrigin ? hourOfDay(xOrigin, v) : num(v)), [xOrigin])

  const plotW = Math.max(10, width - PAD.left - PAD.right)
  const plotH = Math.max(10, height - PAD.top - PAD.bottom)
  const sx = useCallback((t) => PAD.left + (t / (xMax || 1)) * plotW, [xMax, plotW])
  const sy = useCallback((T) => PAD.top + plotH - (T / yTop) * plotH, [yTop, plotH])

  // split each series into solid (measured) and dashed (modelled) sub-paths
  const paths = useMemo(
    () =>
      series.map((s) => {
        const segs = []
        let cur = null
        for (const p of s.points) {
          if (!cur || cur.modeled !== !!p.modeled) {
            if (cur) cur.pts.push(p) // bridge the joint so there is no visual gap
            cur = { modeled: !!p.modeled, pts: [] }
            segs.push(cur)
          }
          cur.pts.push(p)
        }
        return {
          ...s,
          segs: segs.map((seg) => ({
            modeled: seg.modeled,
            d: seg.pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.T).toFixed(1)}`).join(''),
          })),
          area:
            `M${sx(s.points[0].t).toFixed(1)},${sy(0).toFixed(1)}` +
            s.points.map((p) => `L${sx(p.t).toFixed(1)},${sy(p.T).toFixed(1)}`).join('') +
            `L${sx(s.points[s.points.length - 1].t).toFixed(1)},${sy(0).toFixed(1)}Z`,
        }
      }),
    [series, sx, sy],
  )

  // Converging lines: stacked end-labels detach from their line and read as
  // noise, so drop them and let the legend carry identity.
  const endLabelsCollide = useMemo(() => {
    const ys = series.map((s) => sy(s.points[s.points.length - 1].T)).sort((a, b) => a - b)
    return ys.some((y, i) => i > 0 && y - ys[i - 1] < 14)
  }, [series, sy])

  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    const t = ((e.clientX - box.left - PAD.left) / plotW) * xMax
    if (t < -0.5 || t > xMax + 0.5) return setHover(null)
    const rows = series
      .map((s) => {
        let best = null
        let bd = Infinity
        for (const p of s.points) {
          const d = Math.abs(p.t - t)
          if (d < bd) {
            bd = d
            best = p
          }
        }
        return best && bd <= Math.max(0.5, xMax / plotW * 12) ? { label: s.label, color: s.color, p: best } : null
      })
      .filter(Boolean)
    setHover(rows.length ? { t: rows[0].p.t, rows } : null)
  }

  const bands = phases
    ? [
        { from: 0, to: phases.heatEnd, key: 'heat', label: 'Heating' },
        { from: phases.heatEnd, to: phases.holdEnd, key: 'hold', label: 'Hold' },
        { from: phases.holdEnd, to: xMax, key: 'cool', label: 'Natural cooling' },
      ]
    : []

  return (
    <div className="chart" ref={ref}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Furnace temperature versus time"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {bands.map((b) => (
          <g key={b.key}>
            <rect
              x={sx(b.from)}
              y={PAD.top}
              width={Math.max(0, sx(b.to) - sx(b.from))}
              height={plotH}
              className={`band band-${b.key}`}
            />
            {sx(b.to) - sx(b.from) > 46 && (
              <text x={sx(b.from) + 6} y={PAD.top + 12} className="band-label">
                {b.label}
              </text>
            )}
          </g>
        ))}

        {yTicks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={sy(v)} y2={sy(v)} className={v === 0 ? 'axis' : 'gridline'} />
            <text x={PAD.left - 8} y={sy(v) + 4} className="tick tick-y">
              {num(v)}
            </text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text key={v} x={sx(v)} y={PAD.top + plotH + 20} className="tick tick-x">
            {xTickLabel(v)}
          </text>
        ))}
        <text x={PAD.left} y={height - 6} className="axis-title">
          {xLabel}
        </text>
        <text
          className="axis-title"
          transform={`translate(13 ${PAD.top + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          Temperature (°C)
        </text>

        {showArea &&
          paths.length === 1 &&
          paths.map((s) => <path key={`a-${s.id}`} d={s.area} fill={s.color} opacity="0.1" />)}

        {paths.map((s) =>
          s.segs.map((seg, i) => (
            <path
              key={`${s.id}-${i}`}
              d={seg.d}
              fill="none"
              stroke={s.color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={seg.modeled ? '6 5' : undefined}
            />
          )),
        )}

        {samples &&
          samples.map((p, i) => (
            <circle key={i} cx={sx(p.t)} cy={sy(p.T)} r="4" className="sample" fill={samples.color || '#898781'} />
          ))}

        {labelEnds &&
          series.length <= 4 &&
          !endLabelsCollide &&
          paths.map((s) => {
            const last = s.points[s.points.length - 1]
            return (
              <g key={`e-${s.id}`}>
                <circle cx={sx(last.t)} cy={sy(last.T)} r="4.5" fill={s.color} className="end-dot" />
                <text x={sx(last.t) + 9} y={sy(last.T) + 4} className="end-label">
                  {s.label}
                </text>
              </g>
            )
          })}

        {hover && (
          <g pointerEvents="none">
            <line x1={sx(hover.t)} x2={sx(hover.t)} y1={PAD.top} y2={PAD.top + plotH} className="crosshair" />
            {hover.rows.map((r, i) => (
              <circle key={i} cx={sx(r.p.t)} cy={sy(r.p.T)} r="4.5" fill={r.color} className="end-dot" />
            ))}
          </g>
        )}
      </svg>

      {hover && (
        <div
          className="tooltip"
          style={{
            left: `${Math.min(Math.max(sx(hover.t), 60), width - 130)}px`,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="tooltip-title">{num(hover.t, hover.t % 1 ? 2 : 0)} h</div>
          {hover.rows.map((r, i) => (
            <div className="tooltip-row" key={i}>
              <span className="key" style={{ background: r.color }} />
              <span className="tooltip-label">{r.label}</span>
              <span className="tooltip-value">
                {num(r.p.T)} °C{r.p.modeled ? ' *' : ''}
              </span>
            </div>
          ))}
          {hover.rows.some((r) => r.p.modeled) && <div className="tooltip-note">* modelled cooling</div>}
        </div>
      )}
    </div>
  )
}
