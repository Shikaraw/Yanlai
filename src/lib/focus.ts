import { localDateKey, minutesOfTime, isStudyKind } from './planner'
import type { PlanSchedule } from './types'

export interface FocusWindowState {
  focused: boolean
  visible: boolean
  minimized: boolean
  at: number
  sequence: number
}
export interface FocusInterval { start: number; end: number }
export interface FocusDay {
  date: string
  focusedMs: number
  outOfWindowMs: number
  switches: number
  completedFocusedMs: number
}
export type FocusSessionEndReason = 'switch' | 'schedule' | 'gap' | 'stop'
/** Observed window-state spans only; never contains other application metadata. */
export interface FocusSession {
  start: number
  end: number
  durationMs: number
  kind: 'focused' | 'outOfWindow'
  endReason: FocusSessionEndReason
}
export interface FocusSnapshot { version: 1; days: FocusDay[]; sessions?: FocusSession[] }
export const MAX_FOCUS_DAYS = 90
export const MAX_FOCUS_SESSIONS = 2000
export const FOCUS_SESSION_RETENTION_MS = MAX_FOCUS_DAYS * 24 * 60 * 60 * 1000
// A delayed heartbeat cannot prove what happened during sleep / renderer suspension.
export const MAX_OBSERVATION_GAP_MS = 15_000
export const emptyFocusSnapshot = (): FocusSnapshot => ({ version: 1, days: [], sessions: [] })
export const averageFocusedMs = (day: FocusDay): number => day.switches ? day.completedFocusedMs / day.switches : 0

/** Validate persisted input, strip unknown fields, and bound retention. */
export function sanitizeFocusSnapshot(input: unknown, now = Date.now()): FocusSnapshot {
  const days = new Map<string, FocusDay>()
  const data = input as FocusSnapshot | null
  if (data?.version === 1 && Array.isArray(data.days)) {
    for (const row of data.days) {
      if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue
      const fields = [row.focusedMs, row.outOfWindowMs, row.switches, row.completedFocusedMs]
      if (!fields.every(v => Number.isSafeInteger(v) && v >= 0)) continue
      days.set(row.date, { date: row.date, focusedMs: row.focusedMs, outOfWindowMs: row.outOfWindowMs, switches: row.switches, completedFocusedMs: row.completedFocusedMs })
    }
  }
  const sessions: FocusSession[] = []
  if (data?.version === 1 && Array.isArray(data.sessions) && Number.isFinite(now)) {
    const cutoff = now - FOCUS_SESSION_RETENTION_MS
    for (const row of data.sessions) {
      if (!row || ![row.start, row.end, row.durationMs].every(v => Number.isSafeInteger(v) && v >= 0)) continue
      if (row.end <= row.start || row.durationMs !== row.end - row.start || row.start < cutoff || row.end > now) continue
      if (row.kind !== 'focused' && row.kind !== 'outOfWindow') continue
      if (!['switch', 'schedule', 'gap', 'stop'].includes(row.endReason)) continue
      sessions.push({ start: row.start, end: row.end, durationMs: row.durationMs, kind: row.kind, endReason: row.endReason })
    }
  }
  return {
    version: 1,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_FOCUS_DAYS),
    sessions: sessions.sort((a, b) => a.end - b.end || a.start - b.start).slice(-MAX_FOCUS_SESSIONS),
  }
}

/** Resolve local calendar schedules, including yesterday's overnight items. */
export function scheduledFocusIntervals(schedule: PlanSchedule | null, now: number): FocusInterval[] {
  if (!schedule) return []
  const result: FocusInterval[] = []
  for (const offset of [-1, 0, 1]) {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() + offset)
    const dow = date.getDay() || 7
    const items = schedule.mode === 'weekly' ? schedule.weekly?.[dow]
      : schedule.mode === 'workday' ? schedule.workday?.[(schedule.workdays || [1, 2, 3, 4, 5]).includes(dow) ? 'work' : 'rest']
      // Unified schedules use activeDays; missing means all days, [] means no days.
      : Array.isArray(schedule.activeDays) && !schedule.activeDays.includes(dow) ? [] : schedule.unified
    for (const item of items || []) {
      if (!isStudyKind(item.kind)) continue
      const startMin = minutesOfTime(item.start); const endMin = minutesOfTime(item.end)
      if (startMin === null || endMin === null || startMin === endMin) continue
      const start = new Date(date); start.setMinutes(startMin)
      const end = new Date(date); end.setMinutes(endMin)
      if (endMin < startMin) end.setDate(end.getDate() + 1)
      result.push({ start: start.getTime(), end: end.getTime() })
    }
  }
  return result
}

/** Pure accumulator. Clock and all observations are injected; reloads never replay gaps.
 * Switches are exits from a positive-length focused bout. Average is the mean
 * completed bout duration, excluding unfinished/censored bouts. Bouts split at
 * local midnight for daily attribution; a switch belongs to its exit date.
 */
export class FocusAccumulator {
  private data: FocusSnapshot
  private cursor: number
  private focused = false
  private observed = false
  private session: Pick<FocusSession, 'start' | 'end' | 'kind'> | null = null
  private intervals: FocusInterval[] = []
  private bout = new Map<string, number>()
  constructor(private clock: () => number, initial: unknown = emptyFocusSnapshot()) {
    this.cursor = clock()
    this.data = sanitizeFocusSnapshot(initial, this.cursor)
  }
  private closeSession(endReason: FocusSessionEndReason): void {
    if (this.session && this.session.end > this.session.start) {
      const { start, end, kind } = this.session
      const sessions = this.data.sessions ??= []
      sessions.push({ start, end, durationMs: end - start, kind, endReason })
    }
    this.session = null
  }
  private day(date: string): FocusDay {
    let day = this.data.days.find(d => d.date === date)
    if (!day) {
      day = { date, focusedMs: 0, outOfWindowMs: 0, switches: 0, completedFocusedMs: 0 }
      this.data.days.push(day)
    }
    return day
  }
  private eligible(at: number): boolean { return this.intervals.some(i => i.start <= at && at < i.end) }
  advance(at = this.clock()): void {
    if (!Number.isFinite(at)) return
    if (at < this.cursor || at - this.cursor > MAX_OBSERVATION_GAP_MS) {
      this.closeSession('gap')
      this.cursor = at
      this.bout.clear()
      this.focused = false
      this.observed = false
      this.data = sanitizeFocusSnapshot(this.data, at)
      return
    }
    if (at === this.cursor) return
    const edges = [...new Set([this.cursor, at, ...this.intervals.flatMap(i => [i.start, i.end]).filter(t => t > this.cursor && t < at)])].sort((a, b) => a - b)
    for (let n = 0; n < edges.length - 1; n++) {
      let start = edges[n]; const end = edges[n + 1]
      if (!this.eligible(start)) { this.closeSession('schedule'); this.bout.clear(); continue }
      if (!this.observed) continue
      if (!this.session) this.session = { start, end: start, kind: this.focused ? 'focused' : 'outOfWindow' }
      this.session.end = end
      while (start < end) {
        const date = new Date(start)
        const key = localDateKey(date)
        date.setHours(24, 0, 0, 0)
        const stop = Math.min(end, date.getTime())
        const ms = stop - start
        if (ms <= 0) break
        const day = this.day(key)
        if (this.focused) {
          day.focusedMs += ms
          this.bout.set(key, (this.bout.get(key) || 0) + ms)
        } else day.outOfWindowMs += ms
        start = stop
      }
    }
    this.cursor = at
    if (!this.eligible(at)) { this.closeSession('schedule'); this.bout.clear() }
    this.data = sanitizeFocusSnapshot(this.data, at)
  }
  setIntervals(intervals: FocusInterval[], at = this.clock()): void {
    if (!Number.isFinite(at)) return
    this.advance(at)
    this.intervals = intervals.filter(i => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start).map(i => ({ ...i }))
    if (!this.eligible(at)) { this.closeSession('schedule'); this.bout.clear() }
  }
  /** End an observed monitoring lifecycle without inventing a window switch. */
  suspend(at = this.clock()): void {
    if (!Number.isFinite(at)) return
    this.advance(at)
    this.closeSession('stop')
    this.bout.clear()
    this.observed = false
    this.focused = false
  }
  observe(state: Pick<FocusWindowState, 'focused' | 'visible' | 'minimized'>, at = this.clock()): void {
    if (!Number.isFinite(at)) return
    this.advance(at)
    const focused = state.focused && state.visible && !state.minimized
    if (this.focused && !focused && this.eligible(at) && this.bout.size) {
      this.day(localDateKey(new Date(at))).switches++
      for (const [date, ms] of this.bout) this.day(date).completedFocusedMs += ms
      this.bout.clear()
    }
    if (this.observed && focused !== this.focused) this.closeSession('switch')
    this.focused = focused
    this.observed = true
  }
  snapshot(): FocusSnapshot { return sanitizeFocusSnapshot(this.data, this.clock()) }
}
