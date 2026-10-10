'use strict'

/* Plan scheduler: local-calendar occurrences, independent of renderer lifetime. */
const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isoDay(d = new Date()) {
  return d.getDay() || 7
}

function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  return h <= 23 && mi <= 59 ? h * 60 + mi : null
}

function sortItems(items) {
  if (!Array.isArray(items)) return []
  return items.filter((it) => isRecord(it) && toMinutes(it.start) !== null &&
    (it.end === undefined || it.end === null || it.end === '' || toMinutes(it.end) !== null))
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
}

/** Active days apply to unified mode; weekly/workday lists have their own routing. */
function resolveDayItems(schedule, date = new Date()) {
  if (!isRecord(schedule) || !Number.isFinite(date.getTime())) return []
  const mode = schedule.mode ?? 'unified'
  const dow = isoDay(date)
  if (mode === 'weekly') return sortItems(isRecord(schedule.weekly) ? schedule.weekly[dow] : null)
  if (mode === 'workday') {
    const workdays = schedule.workdays === undefined ? [1, 2, 3, 4, 5] : schedule.workdays
    if (!Array.isArray(workdays) || !isRecord(schedule.workday)) return []
    return sortItems(workdays.includes(dow) ? schedule.workday.work : schedule.workday.rest)
  }
  if (mode !== 'unified') return []
  if (schedule.activeDays !== undefined &&
      (!Array.isArray(schedule.activeDays) || !schedule.activeDays.includes(dow))) return []
  return sortItems(schedule.unified)
}

function offsetDate(date, offset) {
  const result = new Date(date)
  result.setDate(result.getDate() + offset)
  return result
}

function occurrences(schedule, date) {
  return resolveDayItems(schedule, date).map((item) => {
    const startMin = toMinutes(item.start), endMin = toMinutes(item.end)
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, startMin)
    const end = new Date(start)
    if (endMin !== null) {
      if (endMin < startMin) end.setDate(end.getDate() + 1)
      end.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0)
    }
    return { item, start: start.getTime(), end: end.getTime(), dateKey: todayKey(date) }
  })
}

function previewItem(event, date, now, isToday) {
  const state = !isToday || now < event.start ? 'pending' : now < event.end ? 'active' : 'done'
  return { ...event.item, state, dayLabel: DAY_LABELS[isoDay(date) - 1], dow: isoDay(date), dateKey: event.dateKey }
}

class Planner {
  constructor({ getSchedule, onFire, getSettings }) {
    this.getSchedule = getSchedule || (() => null)
    this.getSettings = getSettings || (() => ({}))
    this.onFire = onFire || (() => {})
    this.timer = null
    this.status_ = { paused: false }
    this.fired = new Set() // JSON [occurrence date, plan identity, event identity]
    this.snoozed = []
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
    // Saving or reactivating a plan must not re-fire an already delivered event.
    this.tick()
  }

  setPaused(v) {
    this.status_.paused = !!v
  }

  snooze(minutes, payload) {
    const p = payload || this.lastPayload
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || !isRecord(p)) return
    const at = Date.now() + minutes * 60000
    if (!Number.isFinite(at)) return
    this.snoozed.push({ at, payload: { ...p, kind: 'snooze', title: `${typeof p.title === 'string' ? p.title : '学习任务'}（稍后提醒）` } })
  }

  /** Today's preview contains today's starts; overnight carryover is in status.current. */
  preview(dayOffset = 0) {
    if (!Number.isSafeInteger(dayOffset) || Math.abs(dayOffset) > 36600) return []
    const now = new Date(), date = offsetDate(now, dayOffset)
    return occurrences(this.getSchedule(), date).map((event) => previewItem(event, date, now.getTime(), dayOffset === 0))
  }

  status() {
    const schedule = this.getSchedule(), now = new Date(), nowMs = now.getTime()
    const events = occurrences(schedule, now)
    const today = events.map((event) => previewItem(event, now, nowMs, true))
    const previous = offsetDate(now, -1)
    // Prefer an active start today over overlapping carryover from yesterday.
    const current = events.find((event) => nowMs >= event.start && nowMs < event.end) ||
      occurrences(schedule, previous).find((event) => nowMs >= event.start && nowMs < event.end)
    return {
      paused: this.status_.paused,
      mode: isRecord(schedule) ? schedule.mode || 'unified' : 'unified',
      hasSchedule: isRecord(schedule),
      now: now.getHours() * 60 + now.getMinutes(),
      current: current ? previewItem(current, current.dateKey === todayKey(now) ? now : previous, nowMs, true) : null,
      next: today.find((it) => toMinutes(it.start) > now.getHours() * 60 + now.getMinutes()) || null,
      count: today.length,
      progress: today.length ? today.filter((it) => it.state === 'done').length / today.length : 0,
    }
  }

  tick() {
    const now = new Date(), nowMs = now.getTime(), key = todayKey(now)
    if (this.lastPruneKey !== key) {
      // Keep yesterday and tomorrow too: advance reminders may fire before midnight.
      const oldest = todayKey(offsetDate(now, -1))
      for (const guard of this.fired) if (JSON.parse(guard)[0] < oldest) this.fired.delete(guard)
      this.lastPruneKey = key
    }

    const due = this.snoozed.filter((s) => s.at <= nowMs)
    this.snoozed = this.snoozed.filter((s) => s.at > nowMs)
    for (const reminder of due) this.emit(reminder.payload)
    if (this.status_.paused) return

    const settings = this.getSettings() || {}
    const rawAdvance = settings?.planner?.advanceSeconds
    const advance = typeof rawAdvance === 'number' && Number.isFinite(rawAdvance) ? Math.max(0, Math.min(3600, rawAdvance)) : 0
    const schedule = this.getSchedule()
    const planId = typeof schedule?.planId === 'string' && schedule.planId ? schedule.planId : 'legacy'
    // Yesterday covers the 90s grace window; tomorrow covers advance across midnight.
    for (const offset of [-1, 0, 1]) {
      const events = occurrences(schedule, offsetDate(now, offset))
      for (let i = 0; i < events.length; i++) {
        const { item: it, start, dateKey } = events[i]
        if (it.remind === false) continue
        const fireAt = start - advance * 1000
        const id = typeof it.id === 'string' && it.id ? it.id : `${it.start}-${typeof it.title === 'string' ? it.title : ''}`
        const guard = JSON.stringify([dateKey, planId, id])
        if (nowMs < fireAt || nowMs - fireAt >= 90000 || this.fired.has(guard)) continue
        this.fired.add(guard)
        const next = events[i + 1]?.item
        this.emit({
          kind: 'event', id,
          title: typeof it.title === 'string' && it.title ? it.title : '学习任务',
          body: typeof it.note === 'string' ? it.note : '',
          subject: typeof it.subject === 'string' ? it.subject : '',
          type: typeof it.kind === 'string' ? it.kind : 'study',
          start: it.start, end: it.end || '',
          next: next ? { title: next.title, start: next.start } : null,
          at: now.toISOString(),
        })
      }
    }
  }

  emit(payload) {
    this.lastPayload = payload
    try { this.onFire(payload) } catch (_) { /* Notification failures must not kill scheduling. */ }
  }
}

module.exports = { Planner, resolveDayItems, toMinutes, todayKey, DAY_LABELS, isoDay }
