'use strict'

/* ------------------------------------------------------------------ *
 * Plan scheduler. Runs in the main process so reminders fire even when *
 * the window is hidden in the tray.                                   *
 * ------------------------------------------------------------------ */

const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isoDay(d = new Date()) {
  const js = d.getDay() // 0=Sun
  return js === 0 ? 7 : js // 1=Mon..7=Sun
}

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

function sortItems(items) {
  return [...(items || [])].sort((a, b) => (toMinutes(a.start) ?? 1e9) - (toMinutes(b.start) ?? 1e9))
}

/** Resolve which item list applies to a given date, per schedule mode. */
function resolveDayItems(schedule, date = new Date()) {
  if (!schedule) return []
  const mode = schedule.mode || 'unified'
  const dow = isoDay(date)
  if (mode === 'weekly') {
    const list = schedule.weekly?.[dow] || []
    return sortItems(list)
  }
  if (mode === 'workday') {
    const workdays = schedule.workdays || [1, 2, 3, 4, 5]
    const isWork = workdays.includes(dow)
    return sortItems(isWork ? schedule.workday?.work : schedule.workday?.rest)
  }
  // unified
  const active = schedule.activeDays
  if (Array.isArray(active) && active.length && !active.includes(dow)) return []
  return sortItems(schedule.unified)
}

class Planner {
  constructor({ getSchedule, onFire, getSettings }) {
    this.getSchedule = getSchedule || (() => null)
    this.getSettings = getSettings || (() => ({}))
    this.onFire = onFire || (() => {})
    this.timer = null
    this.status_ = { paused: false }
    this.fired = new Set() // `${dateKey}:${id}` guard
    this.snoozed = [] // [{ at: ms, payload }]
    this.lastPruneKey = null
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 1000)
    this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  reload() {
    this.fired.clear()
    this.tick()
  }

  setPaused(v) {
    this.status_.paused = !!v
  }

  snooze(minutes, payload) {
    const p = payload || this.lastPayload
    if (!p) return
    this.snoozed.push({ at: Date.now() + minutes * 60000, payload: { ...p, kind: 'snooze', title: `${p.title}（稍后提醒）` } })
  }

  /** Events for a given day offset (0 = today). */
  preview(dayOffset = 0) {
    const s = this.getSchedule()
    const d = new Date()
    d.setDate(d.getDate() + dayOffset)
    const items = resolveDayItems(s, d)
    const nowMin = d.getHours() * 60 + d.getMinutes()
    const isToday = dayOffset === 0
    return items.map((it) => {
      const start = toMinutes(it.start)
      const end = toMinutes(it.end)
      let state = 'pending'
      if (isToday) {
        if (end !== null && nowMin >= end) state = 'done'
        else if (start !== null && nowMin >= start) state = 'active'
      }
      return { ...it, state, dayLabel: DAY_LABELS[isoDay(d) - 1], dow: isoDay(d), dateKey: todayKey(d) }
    })
  }

  status() {
    const s = this.getSchedule()
    const today = this.preview(0)
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
    const next = today.find((it) => (toMinutes(it.start) ?? 0) > nowMin) || null
    const current = today.find((it) => {
      const a = toMinutes(it.start)
      const b = toMinutes(it.end)
      return a !== null && b !== null && nowMin >= a && nowMin < b
    })
    return {
      paused: this.status_.paused,
      mode: s?.mode || 'unified',
      hasSchedule: !!s,
      now: nowMin,
      current: current || null,
      next: next || null,
      count: today.length,
      progress: today.length ? today.filter((i) => i.state === 'done').length / today.length : 0,
    }
  }

  tick() {
    const now = new Date()
    const key = todayKey(now)
    if (this.lastPruneKey !== key) {
      this.fired.clear()
      this.lastPruneKey = key
    }

    // snoozed reminders fire regardless of pause state
    if (this.snoozed.length) {
      const due = this.snoozed.filter((s) => s.at <= Date.now())
      if (due.length) {
        this.snoozed = this.snoozed.filter((s) => s.at > Date.now())
        for (const d of due) this.emit(d.payload)
      }
    }

    if (this.status_.paused) return
    const settings = this.getSettings() || {}
    const advance = Number(settings?.planner?.advanceSeconds) || 0
    const items = resolveDayItems(this.getSchedule(), now)
    if (!items.length) return

    const nowMs = now.getTime()
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const mins = toMinutes(it.start)
      if (mins === null) continue
      if (it.remind === false) continue
      const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
      target.setMinutes(mins)
      const fireAt = target.getTime() - advance * 1000
      const id = it.id || `${it.start}-${it.title}`
      const gk = `${key}:${id}`
      // fire only within a 90s window after the target: prevents a flood of
      // missed reminders when the app was closed or the machine slept.
      if (nowMs >= fireAt && nowMs - fireAt < 90000 && !this.fired.has(gk)) {
        this.fired.add(gk)
        const next = items.slice(i + 1).find((x) => toMinutes(x.start) !== null) || null
        this.emit({
          kind: 'event',
          id,
          title: it.title || '学习任务',
          body: it.note || '',
          subject: it.subject || '',
          type: it.kind || 'study',
          start: it.start,
          end: it.end || '',
          next: next ? { title: next.title, start: next.start } : null,
          at: now.toISOString(),
        })
      }
    }
  }

  emit(payload) {
    this.lastPayload = payload
    try {
      this.onFire(payload)
    } catch (e) {
      // never let a renderer/notification failure kill the scheduler
    }
  }
}

module.exports = { Planner, resolveDayItems, toMinutes, todayKey, DAY_LABELS, isoDay }
