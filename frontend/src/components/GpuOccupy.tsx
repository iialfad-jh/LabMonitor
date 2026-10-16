import { useMemo, useState, type FormEvent } from 'react'
import { Check, Copy, Cpu, Square, Terminal } from 'lucide-react'

type OccupyGpu = { index: number; name: string | null; memory_total_mb: number | null; memory_used_mb: number | null }
export type OccupancyItem = {
  gpu_index: number
  gb: number | null
  session_name: string
  state: 'waiting' | 'starting' | 'occupied' | 'error' | 'ended' | 'stopped'
  message: string
  free_gb: number | null
  started_at: string | null
  updated_at: string | null
}
type Snapshot = { gpu_available: boolean; gpus: OccupyGpu[]; occupancy?: OccupancyItem[] }

const freeGb = (gpu: OccupyGpu | undefined) => {
  if (!gpu || gpu.memory_used_mb == null || gpu.memory_total_mb == null || gpu.memory_total_mb <= 0) return null
  const value = (gpu.memory_total_mb - gpu.memory_used_mb) / 1024
  return Number.isFinite(value) && value >= 0 ? value : null
}

const stateText = (state: OccupancyItem['state']) => ({
  waiting: '等待显存', starting: '正在启动', occupied: '占用中', error: '启动失败', ended: '会话已结束', stopped: '已停止',
}[state])

export function GpuOccupy({ snapshot, onRefresh }: { snapshot: Snapshot | null; onRefresh: () => Promise<void> }) {
  const [target, setTarget] = useState('')
  const [gb, setGb] = useState('10')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  const gpus = snapshot?.gpus ?? []
  const selectedGpu = gpus.find((gpu) => String(gpu.index) === target) ?? gpus[0]
  const selectedIndex = selectedGpu?.index
  const items = snapshot?.occupancy ?? []
  const activeItems = items.filter((item) => ['waiting', 'starting', 'occupied'].includes(item.state))
  const current = selectedIndex == null ? undefined : items.find((item) => item.gpu_index === selectedIndex)
  const currentActive = current && ['waiting', 'starting', 'occupied'].includes(current.state) ? current : undefined
  const locked = pending || !!currentActive
  const currentFree = freeGb(selectedGpu)

  const activeSummary = useMemo(() => activeItems.filter((item) => item.state === 'occupied' || item.state === 'waiting'), [activeItems])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setMessage('')
    const value = Number(gb)
    if (selectedIndex == null || !Number.isFinite(value) || value <= 0) {
      setError('请选择可用 GPU，并输入大于 0 的显存。')
      return
    }
    if (currentFree != null && value >= currentFree) {
      setError('预占用量不能达到当前可用显存，请预留启动计算所需的空间。')
      return
    }
    setPending(true)
    try {
      const response = await fetch('/api/occupancy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ gpu_index: selectedIndex, gb: value }),
      })
      const data = await response.json().catch(() => ({})) as { item?: OccupancyItem; detail?: string }
      if (!response.ok) throw new Error(data.detail ?? `服务器返回错误 (${response.status})`)
      setMessage(data.item?.message ?? '已开始等待目标 GPU 有足够可用显存。')
      await onRefresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法开启 GPU 占用。')
    } finally {
      setPending(false)
    }
  }

  const stop = async (gpuIndex: number) => {
    setPending(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch(`/api/occupancy/${gpuIndex}`, { method: 'DELETE', headers: { Accept: 'application/json' } })
      const data = await response.json().catch(() => ({})) as { item?: OccupancyItem; detail?: string }
      if (!response.ok) throw new Error(data.detail ?? `服务器返回错误 (${response.status})`)
      setMessage(data.item?.message ?? '占用已停止。')
      await onRefresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法停止 GPU 占用。')
    } finally {
      setPending(false)
    }
  }

  const copySession = async (sessionName: string) => {
    try {
      await navigator.clipboard.writeText(`tmux attach -t ${sessionName}`)
      setCopied(sessionName)
      window.setTimeout(() => setCopied((value) => value === sessionName ? '' : value), 1800)
    } catch {
      setError('浏览器不允许复制，请手动复制 tmux 会话名称。')
    }
  }

  return <section className="glass occupancy-tool" aria-labelledby="gpu-occupy-title">
    <form className="occupancy-row" onSubmit={(event) => void submit(event)}>
      <div className="occupancy-title"><span className="occupancy-icon"><Cpu size={18} /></span><div><h2 id="gpu-occupy-title">占用卡</h2><span>显存足够后自动启动 GPU 计算</span></div></div>
      <label className="occupancy-field"><span>目标卡</span><select aria-label="占用目标 GPU" value={selectedIndex == null ? '' : String(selectedIndex)} onChange={(event) => setTarget(event.target.value)} disabled={locked || !gpus.length}><option value="" disabled>选择 GPU</option>{gpus.map((gpu) => <option key={gpu.index} value={gpu.index}>GPU {String(gpu.index).padStart(2, '0')} · {gpu.name ?? '型号不可用'}</option>)}</select></label>
      <label className="occupancy-field"><span>预占用显存</span><span className="occupancy-number"><input type="number" min="0.1" step="0.1" required aria-label="预占用显存 GB" value={gb} onChange={(event) => setGb(event.target.value)} disabled={locked || !gpus.length} /><span>GB</span></span></label>
      <button className={`occupancy-action ${currentActive ? 'stop' : ''}`} type={currentActive ? 'button' : 'submit'} onClick={currentActive ? () => void stop(currentActive.gpu_index) : undefined} disabled={pending || !gpus.length || !snapshot?.gpu_available}>{pending ? '处理中…' : currentActive ? '停止占用' : '开始占用'}</button>
    </form>
    <div className="occupancy-foot"><span><span className={`occupancy-dot ${activeSummary.length ? 'active' : ''}`} />{current ? stateText(current.state) : '尚未开启'}{currentFree == null ? '' : ` · 当前可用 ${currentFree.toFixed(1)} GB`}</span><span>{current && ['error', 'ended'].includes(current.state) ? current.message : '启动后可用 tmux 查看输出'}</span></div>
    {error && <p className="occupancy-message error" role="alert">{error}</p>}
    {message && <p className="occupancy-message" role="status">{message}</p>}
    {activeItems.length > 0 && <div className="occupancy-sessions"><span className="occupancy-session-label"><Terminal size={14} />当前会话</span>{activeItems.map((item) => <div className="occupancy-session" key={item.session_name}><div><strong>GPU {String(item.gpu_index).padStart(2, '0')} · {stateText(item.state)}</strong><code>{item.session_name}</code><small>{item.message}{item.gb == null ? '' : ` · 目标 ${item.gb.toFixed(1)} GB`}</small></div><div className="occupancy-session-actions">{item.state === 'occupied' && <button type="button" className="copy-session" title="复制 tmux 连接命令" aria-label={`复制 ${item.session_name} 连接命令`} onClick={() => void copySession(item.session_name)}>{copied === item.session_name ? <Check size={14} /> : <Copy size={14} />}</button>}<button type="button" className="stop-session" title="删除 tmux 会话并释放占用" aria-label={`停止 GPU ${item.gpu_index} 占用`} onClick={() => void stop(item.gpu_index)} disabled={pending}><Square size={13} />停止</button></div></div>)}</div>}
  </section>
}
