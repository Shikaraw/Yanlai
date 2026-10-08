/**
 * Shared UI primitives: toasts, confirm dialog, dropdown menu, segmented
 * control, switch, chart bits, and a few layout helpers.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons'
import { clsx } from '../lib/util'

/* ------------------------------------------------------------------ */
/* switch                                                              */
/* ------------------------------------------------------------------ */
export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={clsx('switch', checked && 'on')}
      onClick={() => !disabled && onChange(!checked)}
      style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
    />
  )
}

/* ------------------------------------------------------------------ */
/* segmented control                                                   */
/* ------------------------------------------------------------------ */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string; icon?: keyof typeof Icon }>
  onChange: (v: T) => void
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => {
        const I = o.icon ? Icon[o.icon] : null
        return (
          <button
            key={String(o.value)}
            role="tab"
            aria-selected={value === o.value}
            className={clsx(value === o.value && 'active')}
            onClick={() => onChange(o.value)}
          >
            {I ? <I size={14} /> : null}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* dropdown menu                                                       */
/* ------------------------------------------------------------------ */
export interface MenuEntry {
  label: string
  icon?: keyof typeof Icon
  onClick?: () => void
  danger?: boolean
  separator?: boolean
  disabled?: boolean
}

export function Dropdown({ trigger, entries, align = 'right' }: { trigger: (open: () => void) => ReactNode; entries: MenuEntry[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const r = anchorRef.current.getBoundingClientRect()
    const w = 200
    const left = align === 'right' ? Math.min(r.right - w, window.innerWidth - w - 8) : r.left
    setPos({ top: Math.min(r.bottom + 5, window.innerHeight - 60), left: Math.max(8, left) })
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      if (anchorRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <span ref={anchorRef} style={{ display: 'inline-flex' }}>
        {trigger(() => setOpen((v) => !v))}
      </span>
      {open &&
        createPortal(
          <div className="menu" ref={menuRef} style={{ top: pos.top, left: pos.left }} role="menu">
            {entries.map((e, i) =>
              e.separator ? (
                <div key={i} className="menu-sep" />
              ) : (
                (() => {
                  const EntryIcon = e.icon ? Icon[e.icon] : null
                  return (
                    <button
                      key={i}
                      role="menuitem"
                      className={clsx('menu-item', e.danger && 'danger')}
                      disabled={e.disabled}
                      style={e.disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                      onClick={() => {
                        setOpen(false)
                        e.onClick?.()
                      }}
                    >
                      {EntryIcon ? <EntryIcon size={15} /> : null}
                      <span>{e.label}</span>
                    </button>
                  )
                })()
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* modal                                                               */
/* ------------------------------------------------------------------ */
export function Modal({
  open,
  onClose,
  title,
  icon,
  children,
  footer,
  wide,
  dismissable = true,
}: {
  open: boolean
  onClose: () => void
  title: string
  icon?: keyof typeof Icon
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  dismissable?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, dismissable])

  if (!open) return null
  const HeaderIcon = icon ? Icon[icon] : null
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && dismissable && onClose()}>
      <div className={clsx('modal', wide && 'wide')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          {HeaderIcon ? <HeaderIcon size={18} /> : null}
          <h2>{title}</h2>
          <div className="grow" />
          {dismissable ? (
            <button className="btn ghost icon sm" onClick={onClose} aria-label="关闭">
              <Icon.close size={16} />
            </button>
          ) : null}
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ */
/* toasts                                                             */
/* ------------------------------------------------------------------ */
export function Toasts({ toasts, onDismiss }: { toasts: Array<{ id: string; kind: string; title: string; body?: string; action?: { label: string; run: () => void } }>; onDismiss: (id: string) => void }) {
  const iconFor = (k: string) => (k === 'success' ? 'check' : k === 'error' ? 'alert' : k === 'warn' ? 'alert' : 'info')
  const colorFor = (k: string) => (k === 'success' ? 'var(--ok)' : k === 'error' ? 'var(--err)' : k === 'warn' ? 'var(--warn)' : 'var(--accent)')
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div className="toast" key={t.id} role="status">
          <span style={{ color: colorFor(t.kind), marginTop: 1 }}>
            {(() => {
              const I = Icon[iconFor(t.kind) as keyof typeof Icon]
              return <I size={17} />
            })()}
          </span>
          <div className="t-body">
            <div className="t-title">{t.title}</div>
            {t.body ? <div className="t-sub">{t.body}</div> : null}
            {t.action ? (
              <button
                className="btn sm"
                style={{ marginTop: 7 }}
                onClick={() => {
                  t.action!.run()
                  onDismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
          <button className="btn ghost icon sm" onClick={() => onDismiss(t.id)} aria-label="关闭提示">
            <Icon.x size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* charts                                                              */
/* ------------------------------------------------------------------ */
export function Ring({ value, size = 62, stroke = 5, label }: { value: number; size?: number; stroke?: number; label?: string }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(1, value || 0))
  return (
    <div className="rel" style={{ width: size, height: size, display: 'grid', placeItems: 'center' }}>
      <svg className="ring" width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--bg-4)" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="var(--accent)"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.2,0.9,0.3,1)' }}
        />
      </svg>
      <div style={{ position: 'absolute', textAlign: 'center' }}>
        <div style={{ fontSize: size * 0.24, fontWeight: 700, lineHeight: 1 }}>{Math.round(pct * 100)}%</div>
        {label ? <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{label}</div> : null}
      </div>
    </div>
  )
}

export function BarList({ rows, color = 'var(--accent)', emptyText = '暂无数据' }: { rows: Array<{ key: string; n: number; color?: string }>; color?: string; emptyText?: string }) {
  if (!rows.length) return <div className="muted" style={{ fontSize: 12.5, padding: '8px 0' }}>{emptyText}</div>
  const max = Math.max(...rows.map((r) => r.n), 1)
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.key}>
          <div className="bl" title={r.key}>
            {r.key}
          </div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(r.n / max) * 100}%`, background: r.color || color }} />
          </div>
          <div className="bv">{r.n}</div>
        </div>
      ))}
    </div>
  )
}

export function Sparkline({ values, labels }: { values: number[]; labels?: string[] }) {
  const max = Math.max(...values, 1)
  return (
    <div className="spark">
      {values.map((v, i) => (
        <i
          key={i}
          className={clsx(v === max && max > 0 && 'hot')}
          style={{ height: `${Math.max(3, (v / max) * 100)}%` }}
          title={`${labels?.[i] || i}: ${v}`}
        />
      ))}
    </div>
  )
}

const DONUT_COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#fb923c', '#60a5fa', '#f87171', '#4ade80', '#e879f9']

export function Donut({ rows, size = 128 }: { rows: Array<{ key: string; n: number }>; size?: number }) {
  const total = rows.reduce((n, r) => n + r.n, 0)
  if (!total) return <div className="muted" style={{ fontSize: 12.5 }}>暂无数据</div>
  const r = size / 2 - 13
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="donut-wrap">
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flex: '0 0 auto' }}>
        {rows.map((row, i) => {
          const frac = row.n / total
          const dash = frac * c
          const el = (
            <circle
              key={row.key}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
              strokeWidth={17}
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-offset}
            />
          )
          offset += dash
          return el
        })}
        <circle cx={size / 2} cy={size / 2} r={r - 12} fill="var(--panel-solid)" />
      </svg>
      <div className="legend" style={{ flex: 1, minWidth: 150 }}>
        {rows.map((row, i) => (
          <div className="legend-row" key={row.key}>
            <span className="legend-swatch" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
            <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.key}
            </span>
            <span className="muted tnum">
              {row.n} · {Math.round((row.n / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* misc                                                               */
/* ------------------------------------------------------------------ */
export function EmptyState({ icon = 'sparkles', title, body, children }: { icon?: keyof typeof Icon; title: string; body?: string; children?: ReactNode }) {
  const I = Icon[icon]
  return (
    <div className="empty">
      <span className="empty-icon">
        <I size={42} />
      </span>
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {children}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  )
}

export function SettingRow({
  title,
  desc,
  children,
  stack,
}: {
  title: string
  desc?: string
  children: ReactNode
  stack?: boolean
}) {
  return (
    <div className={clsx('settings-row', stack && 'stack')}>
      <div className="sr-main">
        <div className="sr-title">{title}</div>
        {desc ? <div className="sr-desc">{desc}</div> : null}
      </div>
      {children}
    </div>
  )
}

/** Copy-to-clipboard button with transient confirmation. */
export function CopyButton({ text, label = '复制', size = 15 }: { text: string; label?: string; size?: number }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="msg-action"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          ;(window as any).yanlai?.clipboard?.writeText?.(text)
        }
        setDone(true)
        setTimeout(() => setDone(false), 1300)
      }}
    >
      <Icon.copy size={size} />
      {done ? '已复制' : label}
    </button>
  )
}

/** Auto-growing textarea. */
export function AutoTextarea({
  value,
  onChange,
  onKeyDown,
  placeholder,
  maxHeight = 236,
  minHeight = 46,
  autoFocus,
  onPaste,
  disabled,
  id,
}: {
  value: string
  onChange: (v: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  placeholder?: string
  maxHeight?: number
  minHeight?: number
  autoFocus?: boolean
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  disabled?: boolean
  id?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(maxHeight, Math.max(minHeight, el.scrollHeight))}px`
  }, [value, maxHeight, minHeight])
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  return (
    <textarea
      id={id}
      ref={ref}
      className="composer-input"
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      rows={1}
    />
  )
}

/** Human-friendly relative date with a tooltip of the exact time. */
export function TimeLabel({ ts, relative = true }: { ts: number; relative?: boolean }) {
  const text = relative
    ? (() => {
        const d = Date.now() - ts
        const m = Math.floor(d / 60000)
        if (m < 1) return '刚刚'
        if (m < 60) return `${m} 分钟前`
        const h = Math.floor(m / 60)
        if (h < 24) return `${h} 小时前`
        const dd = Math.floor(h / 24)
        if (dd < 30) return `${dd} 天前`
        return new Date(ts).toLocaleDateString('zh-CN')
      })()
    : new Date(ts).toLocaleString('zh-CN')
  return <span title={new Date(ts).toLocaleString('zh-CN')}>{text}</span>
}
