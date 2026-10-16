import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Bell, BellRing, Monitor, Volume2, X } from 'lucide-react'

type AlertGpu = {
  index: number
  uuid: string | null
  name: string | null
  memory_used_mb: number | null
  memory_total_mb: number | null
}
type Snapshot = { hostname: string; gpu_available: boolean; gpus: AlertGpu[] }
type Rule = { host: string; target: string; thresholdGb: number; sound: boolean; desktop: boolean }
type AlertResult = { message: string; gpuIndex: number }

const gpuKey = (gpu: AlertGpu) => gpu.uuid ?? `index:${gpu.index}`
const gpuLabel = (gpu: AlertGpu) => `GPU ${String(gpu.index).padStart(2, '0')}`
const freeMemoryGb = (gpu: AlertGpu) => {
  const used = gpu.memory_used_mb
  const total = gpu.memory_total_mb
  if (used == null || total == null || !Number.isFinite(used) || !Number.isFinite(total) || total <= 0 || used < 0 || used > total) return null
  return (total - used) / 1024
}

export function GpuAlert({ snapshot, connected, onInspect }: {
  snapshot: Snapshot | null
  connected: boolean
  onInspect: (gpuIndex: number) => void
}) {
  const [target, setTarget] = useState('any')
  const [threshold, setThreshold] = useState('40')
  const [sound, setSound] = useState(true)
  const [desktop, setDesktop] = useState(false)
  const [status, setStatus] = useState<'idle' | 'watching' | 'triggered'>('idle')
  const [starting, setStarting] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<AlertResult | null>(null)
  const ruleRef = useRef<Rule | null>(null)
  const lastSnapshotRef = useRef(snapshot)
  const audioRef = useRef<AudioContext | null>(null)
  const desktopAvailable = window.isSecureContext && 'Notification' in window
  const soundAvailable = 'AudioContext' in window
  const locked = status === 'watching' || starting
  const gpus = snapshot?.gpus ?? []
  const targets = gpus.filter((gpu) => target === 'any' || gpuKey(gpu) === target)
  const knownFree = targets.map(freeMemoryGb).filter((value): value is number => value != null)
  const currentFree = connected && snapshot?.gpu_available && knownFree.length ? Math.max(...knownFree) : null
  const currentLabel = target === 'any' ? '当前最多空闲' : '当前空闲'
  const waitingForData = !connected || !snapshot?.gpu_available || !knownFree.length

  useEffect(() => () => { void audioRef.current?.close().catch(() => {}) }, [])

  useEffect(() => {
    const rule = ruleRef.current
    if (status !== 'watching' || !rule || !snapshot || !connected || !snapshot.gpu_available || snapshot === lastSnapshotRef.current || snapshot.hostname !== rule.host) return
    // Only fresh, successful collections may trigger; starting on stale data
    // or retrying a failed request cannot produce a notification.
    lastSnapshotRef.current = snapshot
    const matches = snapshot.gpus.filter((gpu) => {
      const free = freeMemoryGb(gpu)
      return (rule.target === 'any' || gpuKey(gpu) === rule.target) && free != null && free > rule.thresholdGb
    })
    if (!matches.length) return
    ruleRef.current = null
    setStatus('triggered')
    const message = matches.map((gpu) => `${gpuLabel(gpu)} 空闲显存 ${freeMemoryGb(gpu)!.toFixed(1)} GB`).join('；')
    setResult({ message, gpuIndex: matches[0].index })

    if (rule.sound && audioRef.current) {
      const audio = audioRef.current
      void audio.resume().then(() => {
        if (audio.state !== 'running') {
          setNote('浏览器暂停了提示音，请留意网页提醒。')
          return
        }
        for (let index = 0; index < 2; index += 1) {
          const oscillator = audio.createOscillator()
          const gain = audio.createGain()
          const start = audio.currentTime + index * 0.22
          oscillator.frequency.value = index ? 880 : 660
          gain.gain.setValueAtTime(0, start)
          gain.gain.linearRampToValueAtTime(0.12, start + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18)
          oscillator.connect(gain)
          gain.connect(audio.destination)
          oscillator.start(start)
          oscillator.stop(start + 0.2)
          oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
        }
      }).catch(() => setNote('提示音未能播放，请留意网页提醒。'))
    }
    if (rule.desktop && desktopAvailable && Notification.permission === 'granted') {
      try {
        const notification = new Notification('LabMonitor · 空卡提醒', { body: `${rule.host}：${message}`, tag: 'labmonitor-gpu-alert' })
        notification.onclick = () => { window.focus(); notification.close() }
      } catch {
        setNote('此浏览器无法弹出桌面通知，已显示网页提醒。')
      }
    }
  }, [snapshot, connected, status, desktopAvailable])

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (status === 'watching') {
      ruleRef.current = null
      setStatus('idle')
      return
    }
    const thresholdGb = Number(threshold)
    if (!threshold.trim() || !Number.isFinite(thresholdGb) || thresholdGb < 0) {
      setError('请输入大于或等于 0 的显存阈值。')
      return
    }
    if (!snapshot || !targets.length || !connected || !snapshot.gpu_available) {
      setError('请等待 GPU 数据恢复后再开启提醒。')
      return
    }
    const capacities = targets.map((gpu) => gpu.memory_total_mb).filter((value): value is number => value != null && Number.isFinite(value) && value > 0)
    if (capacities.length === targets.length && thresholdGb >= Math.max(...capacities) / 1024) {
      setError('阈值需小于目标 GPU 的显存总量。')
      return
    }
    setError('')
    setNote('')
    setStarting(true)
    // Both APIs are invoked from this button gesture, before any await.
    let permission = Promise.resolve<NotificationPermission>('default')
    if (desktop && desktopAvailable) {
      try { permission = Notification.requestPermission().catch(() => 'denied' as NotificationPermission) }
      catch { permission = Promise.resolve<NotificationPermission>('denied') }
    }
    if (sound && soundAvailable) {
      try {
        if (!audioRef.current || audioRef.current.state === 'closed') audioRef.current = new AudioContext()
        await audioRef.current.resume()
      } catch {
        setNote('提示音不可用，仍会显示网页提醒。')
      }
    }
    const granted = await permission
    if (desktop && granted !== 'granted') setNote('桌面通知未获授权，仍会显示网页提醒。')
    ruleRef.current = { host: snapshot.hostname, target, thresholdGb, sound, desktop: desktop && granted === 'granted' }
    // Wait for the next successful sample, including if already above threshold.
    lastSnapshotRef.current = snapshot
    setResult(null)
    setStatus('watching')
    setStarting(false)
  }

  return <section className={`glass alert-tool ${status === 'watching' ? 'is-watching' : ''}`} aria-labelledby="gpu-alert-title">
    <form className="alert-tool-row" onSubmit={(event) => void start(event)}>
      <div className="alert-tool-title"><span className="alert-tool-icon"><Bell size={18} /></span><div><h2 id="gpu-alert-title">空卡提醒</h2><span>满足条件后提醒一次</span></div></div>
      <label className="alert-field target-field"><span>目标卡</span><select value={target} onChange={(event) => { setTarget(event.target.value); setError('') }} disabled={locked} aria-label="提醒目标 GPU"><option value="any">任意一张 GPU</option>{gpus.map((gpu) => <option key={gpuKey(gpu)} value={gpuKey(gpu)}>{gpuLabel(gpu)} · {gpu.name ?? '型号不可用'}</option>)}{target !== 'any' && !targets.length && <option value={target}>目标 GPU 暂不可用</option>}</select></label>
      <label className="alert-field threshold-field"><span>空闲显存大于</span><span className="alert-number"><input type="number" min="0" step="0.1" required value={threshold} onChange={(event) => { setThreshold(event.target.value); setError('') }} disabled={locked} aria-label="空闲显存阈值 GB" /><span>GB</span></span></label>
      <div className="alert-channels"><label title={soundAvailable ? '满足条件时播放提示音' : '此浏览器不支持提示音'}><input type="checkbox" checked={sound} onChange={(event) => setSound(event.target.checked)} disabled={locked || !soundAvailable} /><Volume2 size={14} />提示音</label><label title={desktopAvailable ? '开启提醒时申请浏览器通知权限' : '桌面通知需要 HTTPS 或 localhost'}><input type="checkbox" checked={desktop} onChange={(event) => setDesktop(event.target.checked)} disabled={locked || !desktopAvailable} /><Monitor size={14} />桌面通知</label></div>
      <button className={`alert-action ${status === 'watching' ? 'stop' : ''}`} type="submit" disabled={starting || (status !== 'watching' && (!gpus.length || !connected || !snapshot?.gpu_available))}>{starting ? '准备中…' : status === 'watching' ? '停止提醒' : status === 'triggered' ? '再次提醒' : '开启提醒'}</button>
    </form>
    <div className="alert-tool-foot"><span className={`alert-watch-state ${status === 'watching' ? 'active' : ''}`} role="status">{status === 'watching' ? <><i />{waitingForData ? '等待采集恢复' : '正在监测'}</> : status === 'triggered' ? '已提醒，监测已停止' : '尚未开启'}<span className="alert-foot-divider">·</span>{currentLabel} {currentFree == null ? '不可用' : `${currentFree.toFixed(1)} GB`}</span><span>保持网页打开{desktopAvailable ? '；仅按空闲显存判断' : '；HTTP 访问可使用网页提醒与提示音'}</span></div>
    {error && <p className="alert-tool-message error" role="alert">{error}</p>}
    {note && <p className="alert-tool-message" role="status">{note}</p>}
    {result && <div className="alert-result" role="status" aria-live="polite"><BellRing size={19} /><div><strong>目标显存已满足</strong><p>{result.message}</p></div><button className="alert-inspect" onClick={() => onInspect(result.gpuIndex)}>查看 GPU</button><button className="alert-dismiss" onClick={() => setResult(null)} aria-label="关闭空卡提醒消息"><X size={15} /></button></div>}
  </section>
}
