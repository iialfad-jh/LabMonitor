import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowDownToLine,
  Check,
  ChevronDown,
  Clock3,
  Cpu,
  Database,
  HardDrive,
  MemoryStick,
  Moon,
  RefreshCw,
  Server,
  Sun,
  Thermometer,
  Zap,
  X,
} from 'lucide-react'

type ProcessInfo = { pid: number; username: string | null; name: string | null; memory_used_mb: number | null }
type GPU = {
  index: number
  uuid: string | null
  name: string | null
  utilization_percent: number | null
  memory_used_mb: number | null
  memory_total_mb: number | null
  temperature_c: number | null
  power_w: number | null
  power_limit_w: number | null
  status: 'idle' | 'busy' | 'unknown'
  processes: ProcessInfo[]
  processes_available: boolean
}
type GpuHistoryPoint = {
  at: number
  utilization: number | null
  memoryUsedMb: number | null
  memoryTotalMb: number | null
}
type Disk = {
  device: string
  mountpoint: string
  filesystem: string | null
  used_bytes: number | null
  total_bytes: number | null
  free_bytes: number | null
  usage_percent: number | null
  available: boolean
}
type Metrics = {
  collected_at: string
  hostname: string
  platform: string
  system_uptime_seconds: number | null
  cpu: { usage_percent: number | null; logical_cores: number | null; physical_cores: number | null }
  memory: { total_bytes: number | null; used_bytes: number | null; available_bytes: number | null; usage_percent: number | null }
  disks: Disk[]
  gpu_available: boolean
  gpu_count: number | null
  idle_gpu_count: number | null
  gpus: GPU[]
  errors: Record<string, string>
}

const REFRESH_MS = 3000
const HISTORY_WINDOW_MS = 30 * 1000
const formatPercent = (value: number | null | undefined) => value == null ? '不可用' : `${Math.round(value)}%`
const formatBytes = (value: number | null | undefined) => {
  if (value == null) return '不可用'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = value
  let index = 0
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1 }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}
const formatMb = (value: number | null | undefined) => value == null ? '不可用' : `${(value / 1024).toFixed(1)} GB`
const formatUptime = (seconds: number | null) => {
  if (seconds == null) return '不可用'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return days ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${minutes} 分`
}
const localTime = (date: string | null) => date ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(date)) : '等待连接'
const percentWidth = (value: number | null | undefined) => value == null ? '0%' : `${Math.min(100, Math.max(0, value))}%`
const formatChartTime = (timestamp: number) => new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}).format(new Date(timestamp))
const formatChartMemory = (value: number | null) => value == null ? '不可用' : `${(value / 1024).toFixed(0)} GB`

function trendPath(points: GpuHistoryPoint[], key: 'utilization' | 'memoryUsedMb', startAt: number, endAt: number, maxValue: number) {
  if (!points.length || endAt <= startAt) return ''
  const segments: Array<Array<{ x: number; y: number }>> = []
  let segment: Array<{ x: number; y: number }> = []
  points.forEach((point) => {
    const value = point[key]
    if (value == null) {
      if (segment.length) segments.push(segment)
      segment = []
      return
    }
    const x = 7 + ((point.at - startAt) / (endAt - startAt)) * 286
    const y = 82 - (Math.min(maxValue, Math.max(0, value)) / maxValue) * 68
    segment.push({ x: Math.min(293, Math.max(7, x)), y })
  })
  if (segment.length) segments.push(segment)

  return segments.map((current) => {
    if (current.length === 1) return `M ${current[0].x.toFixed(1)},${current[0].y.toFixed(1)}`
    let path = `M ${current[0].x.toFixed(1)},${current[0].y.toFixed(1)}`
    for (let index = 0; index < current.length - 1; index += 1) {
      const previous = current[index - 1] ?? current[index]
      const from = current[index]
      const to = current[index + 1]
      const next = current[index + 2] ?? to
      const controlOne = {
        x: from.x + (to.x - previous.x) / 6,
        y: Math.min(82, Math.max(14, from.y + (to.y - previous.y) / 6)),
      }
      const controlTwo = {
        x: to.x - (next.x - from.x) / 6,
        y: Math.min(82, Math.max(14, to.y - (next.y - from.y) / 6)),
      }
      path += ` C ${controlOne.x.toFixed(1)},${controlOne.y.toFixed(1)} ${controlTwo.x.toFixed(1)},${controlTwo.y.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`
    }
    return path
  }).join(' ')
}

function GpuTrend({ points }: { points: GpuHistoryPoint[] }) {
  const latestAt = points[points.length - 1]?.at ?? Date.now()
  const startAt = latestAt - HISTORY_WINDOW_MS
  const memoryMax = Math.max(...points.map((point) => point.memoryTotalMb ?? point.memoryUsedMb ?? 0), 1)
  const utilizationPath = trendPath(points, 'utilization', startAt, latestAt, 100)
  const memoryPath = trendPath(points, 'memoryUsedMb', startAt, latestAt, memoryMax)
  const latestPoint = points[points.length - 1]
  const latestUtilizationY = latestPoint?.utilization == null ? null : 82 - (Math.min(100, Math.max(0, latestPoint.utilization)) / 100) * 68
  const latestMemoryY = latestPoint?.memoryUsedMb == null ? null : 82 - (Math.min(memoryMax, Math.max(0, latestPoint.memoryUsedMb)) / memoryMax) * 68
  return <div className="gpu-trend" aria-label="最近三十秒 GPU 利用率与显存趋势">
    <div className="trend-head"><span>实时趋势 · 最近 30 秒</span><span className="trend-legends"><i className="trend-legend utilization" />利用率 <i className="trend-legend memory" />显存</span></div>
    <div className="trend-chart-shell">
      <div className="trend-y-axis utilization-axis"><span>100%</span><span>50%</span><span>0%</span></div>
      <div className="trend-plot">
        <svg viewBox="0 0 300 92" preserveAspectRatio="none" aria-hidden="true">
          <line x1="7" y1="14" x2="293" y2="14" /><line x1="7" y1="48" x2="293" y2="48" /><line x1="7" y1="82" x2="293" y2="82" />
          <path className="trend-path utilization" d={utilizationPath} /><path className="trend-path memory" d={memoryPath} />
          {latestUtilizationY != null && <circle className="trend-point utilization" cx="293" cy={latestUtilizationY} r="2.5" />}
          {latestMemoryY != null && <circle className="trend-point memory" cx="293" cy={latestMemoryY} r="2.5" />}
        </svg>
      </div>
      <div className="trend-y-axis memory-axis"><span>{formatChartMemory(memoryMax)}</span><span>{formatChartMemory(memoryMax / 2)}</span><span>0 GB</span></div>
    </div>
    <div className="trend-x-axis"><span>{formatChartTime(startAt)}</span><span>{formatChartTime(startAt + HISTORY_WINDOW_MS / 2)}</span><span>{formatChartTime(latestAt)}</span></div>
  </div>
}

function Ring({ value, color, size = 92 }: { value: number | null; color: string; size?: number }) {
  const radius = 38
  const circumference = 2 * Math.PI * radius
  const safeValue = value == null ? 0 : Math.min(100, Math.max(0, value))
  return <div className="ring" style={{ width: size, height: size, color }}>
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle className="ring-track" cx="50" cy="50" r={radius} />
      <circle className="ring-value" cx="50" cy="50" r={radius} style={{ strokeDasharray: circumference, strokeDashoffset: circumference * (1 - safeValue / 100) }} />
    </svg>
    <span className="ring-label">{formatPercent(value)}</span>
  </div>
}

function Meter({ value, color = 'blue' }: { value: number | null; color?: string }) {
  return <div className={`meter meter-${color}`}><span style={{ width: percentWidth(value) }} /></div>
}

function App() {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [dark, setDark] = useState(() => localStorage.getItem('labmonitor-theme') === 'dark')
  const [selectedDisk, setSelectedDisk] = useState(0)
  const [selectedGpu, setSelectedGpu] = useState<GPU | null>(null)
  const [gpuHistory, setGpuHistory] = useState<Record<number, GpuHistoryPoint[]>>({})
  const requestInFlight = useRef(false)

  const refresh = useCallback(async (manual = false) => {
    if (requestInFlight.current) return
    requestInFlight.current = true
    if (manual) setRefreshing(true)
    try {
      const response = await fetch('/api/metrics', { headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(`服务器返回错误 (${response.status})`)
      const data = await response.json() as Metrics
      setMetrics(data)
      const sampleTime = Number.isNaN(Date.parse(data.collected_at)) ? Date.now() : Date.parse(data.collected_at)
      setGpuHistory((current) => {
        const next = { ...current }
        data.gpus.forEach((gpu) => {
          const previous = current[gpu.index] ?? []
          const point: GpuHistoryPoint = {
            at: sampleTime,
            utilization: gpu.utilization_percent,
            memoryUsedMb: gpu.memory_used_mb,
            memoryTotalMb: gpu.memory_total_mb,
          }
          const withoutDuplicate = previous[previous.length - 1]?.at === sampleTime ? previous.slice(0, -1) : previous
          const cutoff = sampleTime - HISTORY_WINDOW_MS
          next[gpu.index] = [...withoutDuplicate, point].filter((item) => item.at >= cutoff)
        })
        return next
      })
      setFetchError(null)
      setLastUpdated(data.collected_at)
      setSelectedDisk((current) => data.disks.length ? Math.min(current, data.disks.length - 1) : 0)
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : '无法连接到监控服务')
    } finally {
      requestInFlight.current = false
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    let canceled = false
    let timer = 0
    const poll = async () => {
      await refresh()
      if (!canceled) timer = window.setTimeout(poll, REFRESH_MS)
    }
    void poll()
    return () => { canceled = true; window.clearTimeout(timer) }
  }, [refresh])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('labmonitor-theme', dark ? 'dark' : 'light')
  }, [dark])

  useEffect(() => {
    if (!selectedGpu) return
    const current = metrics?.gpus.find((gpu) => gpu.index === selectedGpu.index)
    if (current && current !== selectedGpu) setSelectedGpu(current)
    if (!current) setSelectedGpu(null)
  }, [metrics, selectedGpu])

  useEffect(() => {
    if (!selectedGpu) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedGpu(null) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedGpu])

  const disk = metrics?.disks[selectedDisk]
  const serverOnline = !!metrics && !fetchError
  const gpuCount = metrics?.gpu_count
  const avgGpu = useMemo(() => {
    const values = metrics?.gpus.map((gpu) => gpu.utilization_percent).filter((value): value is number => value != null) ?? []
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  }, [metrics])

  return <main className="app-shell">
    <div className="ambient ambient-one" /><div className="ambient ambient-two" /><div className="ambient ambient-three" />
    <header className="topbar glass">
      <a className="brand" href="#top" aria-label="LabMonitor 首页">
        <span className="brand-mark"><Activity size={20} strokeWidth={2.4} /></span>
        <span><strong>LabMonitor</strong><small>RESOURCE CENTER</small></span>
      </a>
      <div className="server-pill"><span className={`status-dot ${serverOnline ? 'online' : 'offline'}`} /><span>{metrics?.hostname ?? '服务器'} · {serverOnline ? '在线' : loading ? '连接中' : '离线'}</span></div>
      <div className="toolbar">
        <div className="update-time"><span className="pulse-dot" />更新于 {localTime(lastUpdated)}</div>
        <button className={`icon-button refresh-button ${refreshing ? 'spinning' : ''}`} onClick={() => void refresh(true)} title="立即刷新" aria-label="立即刷新" disabled={refreshing}>
          <RefreshCw size={17} />
        </button>
        <button className="icon-button theme-button" onClick={() => setDark((value) => !value)} title={dark ? '切换浅色主题' : '切换深色主题'} aria-label={dark ? '切换浅色主题' : '切换深色主题'}>
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </div>
    </header>

    <section className="intro" id="top">
      <div><p className="eyebrow"><span className="eyebrow-line" />LIVE SYSTEM OVERVIEW</p><h1>服务器概览<span className="title-period">.</span></h1><p className="intro-copy">一览系统状态与 GPU 资源，保持每一刻都在掌握之中。</p></div>
      <div className="uptime-chip glass"><span className="uptime-icon"><Clock3 size={17} /></span><span><small>系统运行时间</small><strong>{formatUptime(metrics?.system_uptime_seconds ?? null)}</strong></span></div>
    </section>

    {fetchError && <div className="connection-alert"><span className="alert-icon">!</span><span>暂时无法连接监控服务：{fetchError}</span><button onClick={() => void refresh(true)}>重试</button></div>}
    {metrics && Object.entries(metrics.errors).map(([key, message]) => <div className="inline-alert" key={key}><span className="alert-icon">!</span><span>{message}</span></div>)}

    <section className="overview-grid" aria-label="系统资源总览">
      <article className="glass overview-card cpu-card">
        <div className="card-topline"><span className="resource-icon cpu-icon"><Cpu size={19} /></span><span className="card-kicker">PROCESSOR</span><span className="soft-badge">CPU</span></div>
        <div className="metric-main"><div><p className="metric-title">处理器</p><strong className="big-value">{formatPercent(metrics?.cpu.usage_percent)}</strong></div><Ring value={metrics?.cpu.usage_percent ?? null} color="var(--blue)" /></div>
        <div className="metric-footer"><span>逻辑核心</span><strong>{metrics?.cpu.logical_cores ?? '不可用'} <small>核</small></strong><span className="footer-divider" /><span>物理核心</span><strong>{metrics?.cpu.physical_cores ?? '不可用'} <small>核</small></strong></div>
      </article>

      <article className="glass overview-card memory-card">
        <div className="card-topline"><span className="resource-icon memory-icon"><MemoryStick size={19} /></span><span className="card-kicker">MEMORY</span><span className="soft-badge">RAM</span></div>
        <div className="memory-head"><div><p className="metric-title">内存</p><strong className="big-value">{formatPercent(metrics?.memory.usage_percent)}</strong></div><span className="memory-total">共 {formatBytes(metrics?.memory.total_bytes)}</span></div>
        <div className="memory-track"><div className="memory-fill" style={{ width: percentWidth(metrics?.memory.usage_percent ?? null) }} /></div>
        <div className="memory-foot"><span><i className="legend-dot used" />已用 <strong>{formatBytes(metrics?.memory.used_bytes)}</strong></span><span><i className="legend-dot free" />可用 <strong>{formatBytes(metrics?.memory.available_bytes)}</strong></span></div>
      </article>

      <article className="glass overview-card disk-card">
        <div className="card-topline"><span className="resource-icon disk-icon"><HardDrive size={19} /></span><span className="card-kicker">STORAGE</span><span className="soft-badge">DISK</span></div>
        <div className="disk-head"><div><p className="metric-title">磁盘空间</p><strong className="big-value disk-value">{formatPercent(disk?.usage_percent)}</strong></div>
          {metrics?.disks.length ? <label className="disk-select-wrap"><select className="disk-select" value={selectedDisk} onChange={(event) => setSelectedDisk(Number(event.target.value))} aria-label="选择磁盘挂载点">{metrics.disks.map((item, index) => <option value={index} key={`${item.mountpoint}-${index}`}>{item.mountpoint}</option>)}</select><ChevronDown size={13} /></label> : <span className="disk-select placeholder-select">无挂载点</span>}
        </div>
        <Meter value={disk?.usage_percent ?? null} color="green" />
        <div className="disk-foot"><span>已用 <strong>{formatBytes(disk?.used_bytes)}</strong></span><span>总量 <strong>{formatBytes(disk?.total_bytes)}</strong></span></div>
      </article>

      <article className="glass overview-card gpu-overview-card">
        <div className="card-topline"><span className="resource-icon gpu-icon"><Zap size={19} /></span><span className="card-kicker">ACCELERATOR</span><span className="soft-badge">GPU</span></div>
        <div className="gpu-summary"><div><p className="metric-title">图形处理器</p><strong className="big-value">{gpuCount == null ? '不可用' : gpuCount}<small>{gpuCount == null ? '' : ' 张'}</small></strong></div><div className="gpu-idle"><span className="idle-number">{metrics?.idle_gpu_count ?? '—'}</span><span>空闲</span></div></div>
        <div className="gpu-summary-foot"><span><i className="legend-dot gpu-legend" /> GPU 平均负载</span><strong>{formatPercent(avgGpu)}</strong></div>
      </article>
    </section>

    <section className="gpu-section" aria-label="GPU 实时监控">
      <div className="section-heading"><div><p className="eyebrow"><span className="eyebrow-line" />HARDWARE</p><h2>GPU 实时监控</h2></div><span className="section-count">{gpuCount == null ? '数据不可用' : `${gpuCount} 张设备`}<span className="count-indicator" /></span></div>
      {metrics?.gpu_available && metrics.gpus.length > 0 ? <div className="gpu-grid">
        {metrics.gpus.map((gpu) => <button className={`glass gpu-card ${gpu.status === 'idle' ? 'gpu-idle-card' : ''}`} key={gpu.index} onClick={() => setSelectedGpu(gpu)} aria-label={`查看 GPU ${gpu.index} 详情`}>
          <div className="gpu-card-head"><span className="gpu-number">GPU <strong>{String(gpu.index).padStart(2, '0')}</strong></span><span className={`gpu-state ${gpu.status}`}><i />{gpu.status === 'idle' ? '空闲' : gpu.status === 'busy' ? '使用中' : '状态未知'}</span><span className="gpu-open"><ArrowDownToLine size={14} /></span></div>
          <h3>{gpu.name || '型号不可用'}</h3>
          <div className="gpu-live-values"><span><small>GPU 利用率</small><strong>{formatPercent(gpu.utilization_percent)}</strong></span><span><small>显存</small><strong>{formatMb(gpu.memory_used_mb)} <i>/</i> {formatMb(gpu.memory_total_mb)}</strong></span></div>
          <GpuTrend points={gpuHistory[gpu.index] ?? []} />
          <div className="gpu-specs"><span><Thermometer size={15} />{gpu.temperature_c == null ? '不可用' : `${gpu.temperature_c}°C`}</span><span><Zap size={14} />{gpu.power_w == null ? '不可用' : `${gpu.power_w.toFixed(0)} W`}</span><span><Activity size={14} />{gpu.processes.length} 个进程</span></div>
        </button>)}
      </div> : <div className="glass gpu-unavailable"><span className="unavailable-icon"><Database size={22} /></span><div><strong>{loading ? '正在读取 GPU 设备…' : 'GPU 数据不可用'}</strong><p>{metrics?.errors.gpus ?? (fetchError ? '请确认监控服务正在运行，然后重试。' : '当前服务器未检测到可用 GPU 设备。')}</p></div></div>}
    </section>

    <footer className="page-footer"><span><Server size={13} /> {metrics?.hostname ?? 'LabMonitor'}</span><span>自动刷新 · 每 3 秒</span><span>{metrics?.platform?.split(' ')[0] ?? 'Linux'} <i className="footer-separator">·</i> LabMonitor</span></footer>

    {selectedGpu && <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedGpu(null) }}>
      <section className="glass gpu-detail" role="dialog" aria-modal="true" aria-labelledby="gpu-detail-title">
        <div className="detail-top"><span className="detail-icon"><Zap size={19} /></span><button className="icon-button close-button" onClick={() => setSelectedGpu(null)} aria-label="关闭详情"><X size={18} /></button></div>
        <p className="eyebrow detail-eyebrow"><span className="eyebrow-line" />GPU {String(selectedGpu.index).padStart(2, '0')}</p>
        <h2 id="gpu-detail-title">{selectedGpu.name || '型号不可用'}</h2>
        <span className={`gpu-state detail-state ${selectedGpu.status}`}><i />{selectedGpu.status === 'idle' ? '空闲' : selectedGpu.status === 'busy' ? '使用中' : '状态未知'}</span>
        <div className="detail-stats"><div><span>GPU 利用率</span><strong>{formatPercent(selectedGpu.utilization_percent)}</strong><Meter value={selectedGpu.utilization_percent} /></div><div><span>显存占用</span><strong>{formatMb(selectedGpu.memory_used_mb)} <i>/</i> {formatMb(selectedGpu.memory_total_mb)}</strong><Meter value={selectedGpu.memory_total_mb && selectedGpu.memory_used_mb != null ? selectedGpu.memory_used_mb / selectedGpu.memory_total_mb * 100 : null} color="violet" /></div></div>
        <div className="detail-telemetry"><div><Thermometer size={16} /><span>温度</span><strong>{selectedGpu.temperature_c == null ? '不可用' : `${selectedGpu.temperature_c} °C`}</strong></div><div><Zap size={16} /><span>功耗</span><strong>{selectedGpu.power_w == null ? '不可用' : `${selectedGpu.power_w.toFixed(1)} W`}</strong></div><div><Activity size={16} /><span>功耗上限</span><strong>{selectedGpu.power_limit_w == null ? '不可用' : `${selectedGpu.power_limit_w.toFixed(0)} W`}</strong></div></div>
        <div className="process-heading"><div><h3>运行进程</h3><p>此处仅展示信息，不会更改或终止进程。</p></div><span>{selectedGpu.processes.length} 个</span></div>
        {selectedGpu.processes_available ? selectedGpu.processes.length ? <div className="process-list"><div className="process-row process-labels"><span>PID / 用户</span><span>进程名称</span><span>显存</span></div>{selectedGpu.processes.map((process) => <div className="process-row" key={`${process.pid}-${process.name}`}><span><strong>{process.pid}</strong><small>{process.username ?? '用户不可用'}</small></span><span className="process-name" title={process.name ?? ''}>{process.name ?? '名称不可用'}</span><span>{process.memory_used_mb == null ? '不可用' : `${formatMb(process.memory_used_mb)}`}</span></div>)}</div> : <div className="empty-process"><Check size={16} />当前没有检测到 GPU 计算进程</div> : <div className="empty-process">进程信息不可用</div>}
        <div className="detail-foot"><span>设备 UUID</span><code>{selectedGpu.uuid ?? '不可用'}</code></div>
      </section>
    </div>}
  </main>
}

export default App
