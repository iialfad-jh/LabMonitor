import { memo, useEffect, useId, useLayoutEffect, useRef } from 'react'

export type GpuHistoryPoint = {
  // Use the browser's monotonic clock so clock differences cannot jump the plot.
  at: number
  utilization: number | null
  memoryUsedMb: number | null
  memoryTotalMb: number | null
}

export const REFRESH_MS = 3000
export const HISTORY_WINDOW_MS = 30_000
const PLOT_LEFT = 7
const PLOT_WIDTH = 286
const PLOT_TOP = 14
const PLOT_BOTTOM = 82
const SCROLL_SPEED = PLOT_WIDTH / HISTORY_WINDOW_MS
const GRID_INTERVAL_MS = REFRESH_MS

// All visible charts share one frame loop. React only renders when data changes.
const frameListeners = new Set<(now: number) => void>()
let frameId = 0
function animate(now: number) {
  frameId = 0
  frameListeners.forEach((listener) => listener(now))
  if (frameListeners.size) frameId = requestAnimationFrame(animate)
}
function subscribeFrame(listener: (now: number) => void) {
  frameListeners.add(listener)
  if (!frameId) frameId = requestAnimationFrame(animate)
  return () => {
    frameListeners.delete(listener)
    if (!frameListeners.size) {
      cancelAnimationFrame(frameId)
      frameId = 0
    }
  }
}

function valueY(value: number, maxValue: number) {
  return PLOT_BOTTOM - Math.min(1, Math.max(0, value / maxValue)) * (PLOT_BOTTOM - PLOT_TOP)
}

function trendPath(points: GpuHistoryPoint[], key: 'utilization' | 'memoryUsedMb', anchorAt: number, maxValue: number) {
  let path = ''
  let previous: { x: number; y: number; at: number } | null = null
  for (const point of points) {
    const value = point[key]
    if (value == null) {
      previous = null
      continue
    }
    // Keep coordinates outside the window; SVG clipping removes them smoothly.
    const x = PLOT_LEFT + PLOT_WIDTH + (point.at - anchorAt) * SCROLL_SPEED
    const y = valueY(value, maxValue)
    if (!previous) {
      path += ` M ${x.toFixed(3)},${y.toFixed(3)}`
    } else {
      // Each segment stays unchanged when a new sample arrives. Horizontal
      // tangents soften corners without overshooting either measured value.
      const middleX = ((previous.x + x) / 2).toFixed(3)
      path += ` C ${middleX},${previous.y.toFixed(3)} ${middleX},${y.toFixed(3)} ${x.toFixed(3)},${y.toFixed(3)}`
    }
    previous = { x, y, at: point.at }
  }
  return path
}

const formatMemory = (value: number | null) => value == null ? '不可用' : `${(value / 1024).toFixed(0)} GB`

export const GpuTrend = memo(function GpuTrend({ points }: { points: GpuHistoryPoint[] }) {
  const clipId = `trend-${useId().replace(/:/g, '')}`
  const plotRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<SVGGElement>(null)
  const gridRef = useRef<SVGGElement>(null)
  const latestPoint = points[points.length - 1]
  const anchorAt = latestPoint?.at ?? 0
  const anchorRef = useRef(anchorAt)
  const knownMemory = points.map((point) => point.memoryTotalMb ?? point.memoryUsedMb).filter((value): value is number => value != null)
  const memoryMax = knownMemory.length ? Math.max(...knownMemory, 1) : null
  const memoryScale = memoryMax ?? 1

  // Rebase the paths and their translation in the same paint: existing samples
  // keep the same screen position when the next response is received.
  useLayoutEffect(() => {
    anchorRef.current = anchorAt
    if (scrollRef.current) {
      scrollRef.current.setAttribute('transform', `translate(${-Math.max(0, performance.now() - anchorAt) * SCROLL_SPEED} 0)`)
    }
  }, [anchorAt])

  useEffect(() => {
    const scroll = scrollRef.current
    const grid = gridRef.current
    if (!scroll || !grid) return
    let unsubscribe: (() => void) | undefined
    const paint = (now: number) => {
      scroll.setAttribute('transform', `translate(${-Math.max(0, now - anchorRef.current) * SCROLL_SPEED} 0)`)
      grid.setAttribute('transform', `translate(${-((now % GRID_INTERVAL_MS) * SCROLL_SPEED)} 0)`)
    }
    const updateAnimation = () => {
      unsubscribe?.()
      unsubscribe = undefined
      if (document.hidden) return
      paint(performance.now())
      unsubscribe = subscribeFrame(paint)
    }
    document.addEventListener('visibilitychange', updateAnimation)
    updateAnimation()
    return () => {
      document.removeEventListener('visibilitychange', updateAnimation)
      unsubscribe?.()
    }
  }, [])

  return <div className="gpu-trend" aria-label="最近三十秒 GPU 利用率与显存趋势">
    <div className="trend-head"><span>实时趋势 · 最近 30 秒</span><span className="trend-legends"><i className="trend-legend utilization" />利用率 <i className="trend-legend memory" />显存</span></div>
    <div className="trend-chart-shell">
      <div className="trend-y-axis utilization-axis"><span>100%</span><span>50%</span><span>0%</span></div>
      <div className="trend-plot" ref={plotRef}>
        <svg viewBox="0 0 300 92" preserveAspectRatio="none" aria-hidden="true">
          <defs><clipPath id={clipId}><rect x={PLOT_LEFT} y="10" width={PLOT_WIDTH} height="76" /></clipPath></defs>
          <line x1="7" y1="14" x2="293" y2="14" /><line x1="7" y1="48" x2="293" y2="48" /><line x1="7" y1="82" x2="293" y2="82" />
          <g clipPath={`url(#${clipId})`}>
            <g ref={gridRef} className="trend-time-grid">
              {Array.from({ length: 12 }, (_, index) => <line key={index} x1={293 - index * (PLOT_WIDTH / 10)} y1="14" x2={293 - index * (PLOT_WIDTH / 10)} y2="82" />)}
            </g>
            <g ref={scrollRef} className="trend-scroll">
              <path className="trend-path utilization" d={trendPath(points, 'utilization', anchorAt, 100)} />
              <path className="trend-path memory" d={trendPath(points, 'memoryUsedMb', anchorAt, memoryScale)} />
              {latestPoint?.utilization != null && <circle className="trend-point utilization" cx="293" cy={valueY(latestPoint.utilization, 100)} r="2.5" />}
              {latestPoint?.memoryUsedMb != null && <circle className="trend-point memory" cx="293" cy={valueY(latestPoint.memoryUsedMb, memoryScale)} r="2.5" />}
            </g>
          </g>
        </svg>
      </div>
      <div className="trend-y-axis memory-axis"><span>{formatMemory(memoryMax)}</span><span>{formatMemory(memoryMax == null ? null : memoryMax / 2)}</span><span>{memoryMax == null ? '不可用' : '0 GB'}</span></div>
    </div>
  </div>
})
