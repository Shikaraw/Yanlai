import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icons'
import { bridge } from '../lib/bridge'
import { speech } from '../lib/tts'
import { durationLabel } from '../lib/util'

/**
 * The always-on-top reminder window. It is a separate BrowserWindow, so it must
 * apply its own theme and cannot read the main window's zustand stores — the
 * payload arrives base64url-encoded in the URL hash.
 */
export function ReminderApp() {
  const payload = useMemo(() => parsePayload(), [])
  const [countdown, setCountdown] = useState<number | null>(null)
  const [snoozed, setSnoozed] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [accent, setAccent] = useState('cyan')
  const [autoSpeak, setAutoSpeak] = useState(false)

  useEffect(() => {
    // the theme lives in main-process settings; fetch it so the popup matches
    bridge.settings
      .get()
      .then((s: any) => {
        setTheme(s?.appearance?.theme === 'light' ? 'light' : 'dark')
        setAccent(s?.appearance?.accent || 'cyan')
        const engine = s?.tts?.engine
        setAutoSpeak(!!engine && engine !== 'off' && s?.planner?.speakReminder === true)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!payload?.end) return
    const tick = () => {
      const now = new Date()
      const [eh, em] = String(payload.end).split(':').map(Number)
      if (!Number.isFinite(eh)) return
      const end = new Date(now)
      end.setHours(eh, em || 0, 0, 0)
      let ms = end.getTime() - now.getTime()
      if (ms < 0) ms += 86400000 // end time is tomorrow (cross-midnight slot)
      setCountdown(ms)
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [payload])

  useEffect(() => {
    // auto-dismiss test reminders so they never linger on screen
    if (payload?.kind === 'test') {
      const t = setTimeout(() => bridge.reminder.dismiss(), 12000)
      return () => clearTimeout(t)
    }
  }, [payload])

  if (!payload) {
    return (
      <div className="reminder">
        <div className="r-title">提醒数据无效</div>
        <div className="r-actions">
          <button className="btn primary" onClick={() => bridge.reminder.dismiss()}>
            关闭
          </button>
        </div>
      </div>
    )
  }

  const kindLabel =
    payload.kind === 'test' ? '测试提醒' : payload.kind === 'snooze' ? '稍后提醒' : payload.type === 'review' ? '复习提醒' : payload.type === 'break' ? '休息提醒' : '学习提醒'

  const speak = () => {
    speech.configure({
      engine: 'system',
      autoRead: 'off',
      voice: '',
      rate: 1,
      pitch: 1,
      volume: 1,
      api: { baseUrl: '', apiKey: '', model: '', voice: '', format: 'mp3' },
    })
    speech.speakNow(`${payload.title}。${payload.body || ''}${payload.next ? `接下来是${payload.next.start}的${payload.next.title}。` : ''}`)
  }

  return (
    <div
      className="reminder"
      data-theme={theme}
      data-accent={accent}
      style={{
        background: theme === 'light' ? 'linear-gradient(150deg,#fff,#f2f5fb)' : 'linear-gradient(150deg,#0f1626,#0a0e17)',
      }}
    >
      <div className="r-head">
        <span style={{ color: 'var(--accent)' }}>
          <Icon.bell size={18} />
        </span>
        <span className="r-kind">{kindLabel}</span>
        <span className="mono muted" style={{ fontSize: 12 }}>
          {payload.start || ''}
          {payload.end ? ` - ${payload.end}` : ''}
        </span>
        <button className="btn ghost icon sm" onClick={() => bridge.reminder.dismiss()} title="关闭">
          <Icon.x size={14} />
        </button>
      </div>

      <div>
        <div className="r-title">{payload.title}</div>
        {payload.subject ? <span className="chip accent" style={{ marginTop: 6 }}>{payload.subject}</span> : null}
      </div>

      {payload.body ? <div className="r-body">{payload.body}</div> : null}

      {countdown !== null && payload.end ? (
        <div className="r-next">
          <Icon.clock size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
          本时段剩余 {formatCountdown(countdown)}
          {payload.end && ` · 共 ${durationLabel(payload.start, payload.end)}`}
        </div>
      ) : null}

      {payload.next ? (
        <div className="r-next">
          <Icon.chevron size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
          接下来：{payload.next.start} {payload.next.title}
        </div>
      ) : null}

      <div className="r-actions">
        <button className="btn" onClick={() => bridge.reminder.snooze(5)} disabled={snoozed}>
          {snoozed ? '已延后' : '5 分钟后再说'}
        </button>
        <button className="btn ghost" onClick={speak} title="朗读这条提醒">
          <Icon.volume size={14} />
        </button>
        <button className="btn primary" onClick={() => bridge.reminder.openApp()}>
          <Icon.chat size={14} />
          开始学习
        </button>
      </div>
    </div>
  )
}

function formatCountdown(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${s} 秒`
  return `${s} 秒`
}

function parsePayload() {
  const hash = window.location.hash.replace(/^#/, '')
  const qIdx = hash.indexOf('?')
  if (qIdx < 0) return null
  const params = new URLSearchParams(hash.slice(qIdx + 1))
  const raw = params.get('data')
  if (!raw) return null
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const json = decodeURIComponent(
      Array.from(atob(padded))
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    )
    return JSON.parse(json)
  } catch {
    return null
  }
}
