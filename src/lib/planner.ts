import type { PlanItem } from './types'

export const STUDY_KINDS: ReadonlySet<PlanItem['kind']> = new Set(['study', 'review'])

export function isStudyKind(kind: PlanItem['kind'] | string | undefined): boolean {
  return kind === 'study' || kind === 'review'
}

export function minutesOfTime(value: string | undefined): number | null {
  if (!value) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Duration in minutes; an end before start means the interval crosses midnight. */
export function durationMinutes(start: string | undefined, end: string | undefined): number {
  const s = minutesOfTime(start); const e = minutesOfTime(end)
  if (s === null || e === null) return 0
  return e >= s ? e - s : 1440 - s + e
}

export function itemDuration(item: Pick<PlanItem, 'start' | 'end'>): number {
  return durationMinutes(item.start, item.end)
}

export function studyMinutes(items: PlanItem[]): number {
  return items.filter((item) => isStudyKind(item.kind)).reduce((sum, item) => sum + itemDuration(item), 0)
}

export type PlannerListKey = string | 'work' | 'rest'

export function resolveScenarioKey(schedule: { workdays?: number[] }, key: PlannerListKey): 'work' | 'rest' | number {
  if (key === 'work' || key === 'rest') return key
  const dow = Number(key)
  return (schedule.workdays || [1, 2, 3, 4, 5]).includes(dow) ? 'work' : 'rest'
}

export function localDateKey(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function copyForDays(item: PlanItem, destinations: string[]): PlanItem[] {
  return destinations.map((day) => ({ ...item, id: `${item.id}-copy-${day}-${Math.random().toString(36).slice(2, 8)}` }))
}
