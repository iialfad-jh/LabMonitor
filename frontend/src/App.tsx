import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GpuTrend, HISTORY_WINDOW_MS, REFRESH_MS, type GpuHistoryPoint } from './components/GpuTrend'
import { GpuAlert } from './components/GpuAlert'
import { GpuOccupy, type OccupancyItem } from './components/GpuOccupy'
import {
  Activity,
  ArrowDownToLine,
  Check,
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
  occupancy: OccupancyItem[]
}

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
      const sampleTime = performance.now()
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
          const history = [...previous, point]
          const cutoff = sampleTime - HISTORY_WINDOW_MS
          const firstVisible = history.findIndex((item) => item.at >= cutoff)
          // Keep one preceding sample so the line crosses the clipping edge
          // continuously instead of losing an entire segment at each refresh.
          next[gpu.index] = history.slice(Math.max(0, firstVisible - 1))
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
    let nextPollAt = performance.now()
    const poll = async () => {
      await refresh()
      if (canceled) return
      nextPollAt += REFRESH_MS
      const now = performance.now()
      while (nextPollAt <= now) nextPollAt += REFRESH_MS
      timer = window.setTimeout(poll, nextPollAt - now)
    }
    void poll()
    return () => {
      canceled = true
      window.clearTimeout(timer)
    }
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
      <div className="intro-heading"><p className="eyebrow"><span className="eyebrow-line" />LIVE SYSTEM OVERVIEW</p><h1>服务器概览<span className="title-period">.</span></h1></div>
      <div className="overview-icons" role="group" aria-label="系统资源总览">
        <span className="glass overview-icon cpu-icon" tabIndex={0} role="img" aria-label={`CPU 使用率 ${formatPercent(metrics?.cpu.usage_percent)}，${metrics?.cpu.logical_cores ?? '不可用'} 个逻辑核心，${metrics?.cpu.physical_cores ?? '不可用'} 个物理核心`}>
          <Cpu size={19} />
          <span className="overview-tooltip"><strong>CPU · {formatPercent(metrics?.cpu.usage_percent)}</strong>逻辑 {metrics?.cpu.logical_cores ?? '不可用'} 核 · 物理 {metrics?.cpu.physical_cores ?? '不可用'} 核</span>
        </span>
        <span className="glass overview-icon memory-icon" tabIndex={0} role="img" aria-label={`内存使用率 ${formatPercent(metrics?.memory.usage_percent)}，已用 ${formatBytes(metrics?.memory.used_bytes)}`}>
          <MemoryStick size={19} />
          <span className="overview-tooltip"><strong>内存 · {formatPercent(metrics?.memory.usage_percent)}</strong>已用 {formatBytes(metrics?.memory.used_bytes)} / {formatBytes(metrics?.memory.total_bytes)}<br />可用 {formatBytes(metrics?.memory.available_bytes)}</span>
        </span>
        <label className="glass overview-icon disk-icon" aria-label={`磁盘 ${disk?.mountpoint ?? '不可用'}，使用率 ${formatPercent(disk?.usage_percent)}`}>
          <HardDrive size={19} />
          {metrics?.disks.length ? <select className="overview-disk-select" value={selectedDisk} onChange={(event) => setSelectedDisk(Number(event.target.value))} aria-label="选择磁盘挂载点">{metrics.disks.map((item, index) => <option value={index} key={`${item.mountpoint}-${index}`}>{item.mountpoint}</option>)}</select> : null}
          <span className="overview-tooltip"><strong>磁盘 {disk?.mountpoint ?? ''}</strong>{formatPercent(disk?.usage_percent)} · {formatBytes(disk?.used_bytes)} / {formatBytes(disk?.total_bytes)}</span>
        </label>
        <span className="glass overview-icon gpu-icon" tabIndex={0} role="img" aria-label={`${gpuCount ?? '不可用'} 张 GPU，平均利用率 ${formatPercent(avgGpu)}`}>
          <Zap size={19} />
          <span className="overview-tooltip"><strong>GPU</strong>{gpuCount ?? '不可用'} 张 · {metrics?.idle_gpu_count ?? '—'} 张空闲 · 平均 {formatPercent(avgGpu)}</span>
        </span>
      </div>
      <div className="uptime-chip glass"><span className="uptime-icon"><Clock3 size={17} /></span><span><small>系统运行时间</small><strong>{formatUptime(metrics?.system_uptime_seconds ?? null)}</strong></span></div>
    </section>

    <GpuAlert snapshot={metrics} connected={serverOnline} onInspect={(index) => setSelectedGpu(metrics?.gpus.find((gpu) => gpu.index === index) ?? null)} />
    <GpuOccupy snapshot={metrics} onRefresh={() => refresh(true)} />

    {fetchError && <div className="connection-alert"><span className="alert-icon">!</span><span>暂时无法连接监控服务：{fetchError}</span><button onClick={() => void refresh(true)}>重试</button></div>}
    {metrics && Object.entries(metrics.errors).map(([key, message]) => <div className="inline-alert" key={key}><span className="alert-icon">!</span><span>{message}</span></div>)}

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

    <footer className="page-footer"><span><Server size={13} /> {metrics?.hostname ?? 'LabMonitor'}</span><span>{metrics?.platform?.split(' ')[0] ?? 'Linux'} <i className="footer-separator">·</i> LabMonitor</span></footer>

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
