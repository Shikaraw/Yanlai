import assert from 'node:assert/strict'
import { FocusAccumulator, averageFocusedMs, scheduledFocusIntervals, sanitizeFocusSnapshot, emptyFocusSnapshot, MAX_FOCUS_DAYS, MAX_FOCUS_SESSIONS, FOCUS_SESSION_RETENTION_MS, MAX_OBSERVATION_GAP_MS } from './focus.mjs'

const focusedState = { focused: true, visible: true, minimized: false }
const awayState = { focused: false, visible: true, minimized: false }

let now = 1_000_000
const clock = () => now
const interval = { start: now, end: now + 10_000 }
const acc = new FocusAccumulator(clock)
acc.setIntervals([interval])
acc.observe({ focused: true, visible: true, minimized: false })
now += 3_000
acc.observe({ focused: false, visible: true, minimized: false })
now += 1_000
// Duplicate blur and minimize/hidden transitions do not create extra sessions.
acc.observe({ focused: false, visible: false, minimized: true })
now += 2_000
acc.observe({ focused: true, visible: true, minimized: false })
now += 2_000
acc.observe({ focused: false, visible: true, minimized: false })
const first = acc.snapshot().days[0]
assert.equal(first.focusedMs, 5_000)
assert.equal(first.outOfWindowMs, 3_000)
assert.equal(first.switches, 2)
assert.equal(first.completedFocusedMs, 5_000)
assert.equal(averageFocusedMs(first), 2_500)
assert.deepEqual(acc.snapshot().sessions, [
  { start: interval.start, end: interval.start + 3000, durationMs: 3000, kind: 'focused', endReason: 'switch' },
  { start: interval.start + 3000, end: interval.start + 6000, durationMs: 3000, kind: 'outOfWindow', endReason: 'switch' },
  { start: interval.start + 6000, end: interval.start + 8000, durationMs: 2000, kind: 'focused', endReason: 'switch' },
])
const detached = acc.snapshot()
detached.sessions[0].durationMs = 99
assert.equal(acc.snapshot().sessions[0].durationMs, 3000)

// A new accumulator starts at its injected clock and cannot replay prior downtime.
now += 1_000
const reloaded = new FocusAccumulator(clock, acc.snapshot())
reloaded.setIntervals([interval])
reloaded.observe({ focused: true, visible: true, minimized: false })
assert.deepEqual(reloaded.snapshot(), acc.snapshot())

// Heartbeats do not split a span; an unfinished span is never replayed after reload.
now = 1_100_000
const unfinished = new FocusAccumulator(clock)
unfinished.setIntervals([{ start: now, end: now + 100_000 }])
unfinished.observe(focusedState)
now += 1000
unfinished.advance()
now += 1000
unfinished.observe(focusedState)
assert.deepEqual(unfinished.snapshot().sessions, [])
const beforeReload = unfinished.snapshot()
now += 60_000
const fresh = new FocusAccumulator(clock, beforeReload)
fresh.setIntervals([{ start: now, end: now + 10_000 }])
fresh.observe(awayState)
assert.deepEqual(fresh.snapshot(), beforeReload)
now += 500
fresh.observe(focusedState)
assert.equal(fresh.snapshot().sessions[0].start, now - 500)
assert.equal(fresh.snapshot().sessions[0].durationMs, 500)
assert.equal(fresh.snapshot().days[0].switches, 0)

// Focused time and the completed bout are split at local midnight.
const midnight = new Date(2026, 0, 2, 0, 0, 0, 0).getTime()
now = midnight - 1_000
const overnight = new FocusAccumulator(clock)
overnight.setIntervals([{ start: now, end: now + 3_000 }])
overnight.observe({ focused: true, visible: true, minimized: false })
now += 2_000
overnight.observe({ focused: false, visible: true, minimized: false })
const split = overnight.snapshot().days
assert.equal(split.length, 2)
assert.equal(split[0].focusedMs, 1_000)
assert.equal(split[1].focusedMs, 1_000)
assert.equal(split[1].switches, 1)
assert.equal(split[0].completedFocusedMs + split[1].completedFocusedMs, 2_000)
assert.deepEqual(overnight.snapshot().sessions, [
  { start: midnight - 1000, end: midnight + 1000, durationMs: 2000, kind: 'focused', endReason: 'switch' },
])

// Only study/review items become eligible intervals.
const schedule = {
  version: 1, mode: 'unified', unified: [
    { id: 'study', start: '09:00', end: '10:00', title: 'Study', kind: 'study' },
    { id: 'review', start: '11:00', end: '12:00', title: 'Review', kind: 'review' },
    { id: 'class', start: '12:00', end: '13:00', title: 'Class', kind: 'class' },
    { id: 'break', start: '10:00', end: '10:30', title: 'Break', kind: 'break' },
  ], weekly: {}, workday: { work: [], rest: [] }, workdays: [1, 2, 3, 4, 5], activeDays: [1, 2, 3, 4, 5, 6, 7],
}
const intervals = scheduledFocusIntervals(schedule, new Date(2026, 0, 5, 9, 30).getTime())
assert.equal(intervals.length, 6) // yesterday, today, tomorrow; study/review only
assert.ok(intervals.every(i => [9, 11].includes(new Date(i.start).getHours())))
const monday = new Date(2026, 0, 5, 9, 30).getTime()
assert.deepEqual(scheduledFocusIntervals({ ...schedule, activeDays: [] }, monday), [])
assert.equal(scheduledFocusIntervals({ ...schedule, activeDays: undefined }, monday).length, 6)
assert.equal(scheduledFocusIntervals({ ...schedule, activeDays: [1] }, monday).length, 2)
// weekly/workday select their own days, matching the reminder scheduler.
for (const activeDays of [[], [7]]) {
  assert.equal(scheduledFocusIntervals({ ...schedule, mode: 'weekly', activeDays, weekly: { 1: schedule.unified } }, monday).length, 2)
  assert.equal(scheduledFocusIntervals({ ...schedule, mode: 'workday', activeDays, workday: { work: schedule.unified, rest: [] } }, monday).length, 4)
}
const nightPlan = { ...schedule, activeDays: [7], unified: [{ id: 'night', kind: 'study', start: '23:00', end: '01:00' }] }
const nightIntervals = scheduledFocusIntervals(nightPlan, new Date(2026, 0, 5, 0, 30).getTime())
assert.equal(nightIntervals.length, 1)
assert.equal(new Date(nightIntervals[0].end).getDate(), 5)

// Sleep / stalled timers discard the whole unobserved gap and censor the bout.
now = 2_000_000
const sleeping = new FocusAccumulator(clock)
sleeping.setIntervals([{ start: now, end: now + 10_000_000 }])
sleeping.observe({ focused: true, visible: true, minimized: false })
now += 1000
sleeping.advance()
now += MAX_OBSERVATION_GAP_MS + 1
sleeping.advance()
sleeping.observe({ focused: false, visible: true, minimized: false })
assert.equal(sleeping.snapshot().days[0].focusedMs, 1000)
assert.equal(sleeping.snapshot().days[0].switches, 0)
assert.deepEqual(sleeping.snapshot().sessions, [
  { start: 2_000_000, end: 2_001_000, durationMs: 1000, kind: 'focused', endReason: 'gap' },
])
sleeping.observe({ focused: true, visible: true, minimized: false })
now += 2000
sleeping.observe({ focused: false, visible: true, minimized: false })
assert.equal(sleeping.snapshot().days[0].focusedMs, 3000)
assert.equal(sleeping.snapshot().days[0].completedFocusedMs, 2000)
// A clock rollback must not freeze tracking until the old cursor is reached.
now -= 1000
sleeping.observe({ focused: true, visible: true, minimized: false })
now += 500
sleeping.observe({ focused: false, visible: true, minimized: false })
assert.equal(sleeping.snapshot().days[0].focusedMs, 3500)

// Overlapping slots form a union, and leaving a schedule censors a bout.
now = 3_000_000
const overlapping = new FocusAccumulator(clock)
overlapping.setIntervals([{ start: now, end: now + 4000 }, { start: now + 1000, end: now + 5000 }])
overlapping.observe({ focused: true, visible: true, minimized: false })
now += 5000
overlapping.advance()
overlapping.observe({ focused: false, visible: true, minimized: false })
assert.equal(overlapping.snapshot().days[0].focusedMs, 5000)
assert.equal(overlapping.snapshot().days[0].switches, 0)
assert.deepEqual(overlapping.snapshot().sessions, [
  { start: 3_000_000, end: 3_005_000, durationMs: 5000, kind: 'focused', endReason: 'schedule' },
])
now += 1000
overlapping.observe(focusedState)
now += 1000
overlapping.observe(awayState)
assert.equal(overlapping.snapshot().sessions.length, 1, 'no records outside eligible intervals')

// Disjoint slots split records at their actual boundaries, not at heartbeat times.
now = 4_000_000
const disjoint = new FocusAccumulator(clock)
disjoint.setIntervals([{ start: now + 1000, end: now + 2000 }, { start: now + 3000, end: now + 5000 }])
disjoint.observe(awayState)
now += 4000
disjoint.observe(focusedState)
now += 500
disjoint.suspend()
assert.deepEqual(disjoint.snapshot().sessions, [
  { start: 4_001_000, end: 4_002_000, durationMs: 1000, kind: 'outOfWindow', endReason: 'schedule' },
  { start: 4_003_000, end: 4_004_000, durationMs: 1000, kind: 'outOfWindow', endReason: 'switch' },
  { start: 4_004_000, end: 4_004_500, durationMs: 500, kind: 'focused', endReason: 'stop' },
])
assert.equal(disjoint.snapshot().days[0].switches, 0, 'a monitoring stop is not a window switch')

// Unknown initial state and sleep downtime are not assumed to be window-out time.
now = 5_000_000
const unknownState = new FocusAccumulator(clock)
unknownState.setIntervals([{ start: now, end: now + 100_000 }])
now += 1000
unknownState.advance()
assert.deepEqual(unknownState.snapshot(), emptyFocusSnapshot())
unknownState.observe(focusedState)
now += 1000
unknownState.advance()
now += MAX_OBSERVATION_GAP_MS + 1
unknownState.advance()
now += 1000
unknownState.advance()
assert.equal(unknownState.snapshot().days[0].outOfWindowMs, 0)
unknownState.observe(focusedState)
now += 1000
unknownState.observe({ ...focusedState, minimized: true })
assert.equal(unknownState.snapshot().sessions.at(-1).durationMs, 1000)
now += 1000
unknownState.observe({ ...focusedState, visible: false })
assert.equal(unknownState.snapshot().sessions.length, 2, 'equivalent away states do not duplicate records')

// Legacy aggregates load unchanged; validation strips metadata and bounds age/count.
const retentionNow = new Date(2026, 9, 10).getTime()
const cutoff = retentionNow - FOCUS_SESSION_RETENTION_MS
const record = { start: retentionNow - 2000, end: retentionNow - 1000, durationMs: 1000, kind: 'outOfWindow', endReason: 'switch' }
assert.deepEqual(sanitizeFocusSnapshot({ version: 1, days: [first] }, retentionNow), { version: 1, days: [first], sessions: [] })
const validated = sanitizeFocusSnapshot({ version: 1, days: [], sessions: [
  { ...record, appTitle: 'must not persist' },
  { ...record, start: cutoff, end: cutoff + 1000 },
  { ...record, start: cutoff - 1, end: cutoff + 999 },
  { ...record, durationMs: -1 }, { ...record, durationMs: 999 },
  { ...record, end: record.start, durationMs: 0 },
  { ...record, start: 1.5 }, { ...record, end: Infinity },
  { ...record, kind: 'other' }, { ...record, endReason: 'other' },
  { ...record, start: retentionNow, end: retentionNow + 1000 }, null,
] }, retentionNow)
assert.deepEqual(validated.sessions, [{ ...record, start: cutoff, end: cutoff + 1000 }, record])
const manySessions = Array.from({ length: MAX_FOCUS_SESSIONS + 5 }, (_, i) => ({ ...record, start: retentionNow - 10_000 + i * 2, end: retentionNow - 9999 + i * 2, durationMs: 1 }))
const retained = sanitizeFocusSnapshot({ version: 1, days: [first], sessions: [...manySessions].reverse() }, retentionNow)
assert.equal(retained.sessions.length, MAX_FOCUS_SESSIONS)
assert.deepEqual(retained.sessions[0], manySessions[5])
assert.deepEqual(retained.days, [first], 'record retention never recomputes legacy aggregates')
const expiring = new FocusAccumulator(() => retentionNow + FOCUS_SESSION_RETENTION_MS, { version: 1, days: [first], sessions: [record] })
assert.deepEqual(expiring.snapshot().sessions, [])
assert.deepEqual(sanitizeFocusSnapshot({ version: 1, days: [], sessions: {} }, retentionNow).sessions, [])

const bounded = sanitizeFocusSnapshot({ version: 1, days: Array.from({ length: MAX_FOCUS_DAYS + 5 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, focusedMs: i, outOfWindowMs: 0, switches: 0, completedFocusedMs: 0 })) })
assert.equal(bounded.days.length, MAX_FOCUS_DAYS)
assert.equal(sanitizeFocusSnapshot({ version: 1, days: [{ date: 'bad', focusedMs: -1, outOfWindowMs: 0, switches: 0, completedFocusedMs: 0 }] }).days.length, 0)
// Exercise the actual store with mocked persistence/native bridge and controlled timers.
const { build } = await import('esbuild')
const { fileURLToPath } = await import('node:url')
const storage = new Map()
let blockedWrite = null
let releaseWrite = () => {}
const writeLog = []
const testKvSet = async (key, value) => {
  const snapshot = structuredClone(value)
  if (blockedWrite) { const wait = blockedWrite; blockedWrite = null; await wait }
  storage.set(key, snapshot)
  writeLog.push({ key, value: snapshot })
}
const listeners = new Set()
const timers = new Map()
let nextTimer = 0
let focusReads = 0
let scheduleReads = 0
let statusReads = 0
let native = { focused: true, visible: true, minimized: false, sequence: 1, at: now }
const testBridge = {
  win: {
    getFocusState: async () => { focusReads++; return native },
    onFocusState: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  },
  planner: {
    getSchedule: async () => { scheduleReads++; return schedule },
    status: async () => { statusReads++; return { paused: true, hasSchedule: true } },
    onEvent: () => () => {},
  },
}
globalThis.__focusTest = { bridge: testBridge, storage, kvSet: testKvSet }
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../../src/store/useFocus.ts', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{ name: 'focus-test-dependencies', setup(plugin) {
    plugin.onResolve({ filter: /\/lib\/(bridge|idb)$/ }, args => ({ path: args.path, namespace: 'focus-test' }))
    plugin.onLoad({ filter: /.*/, namespace: 'focus-test' }, args => ({ contents: args.path.endsWith('bridge')
      ? 'export const isElectron = true; export const bridge = globalThis.__focusTest.bridge'
      : 'export const kvGet = async (key, fallback) => globalThis.__focusTest.storage.get(key) ?? fallback; export const kvSet = globalThis.__focusTest.kvSet' }))
  } }],
})
const realNow = Date.now
const realInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const realWindow = globalThis.window
Date.now = () => now
globalThis.window = { addEventListener() {}, removeEventListener() {} }
globalThis.setInterval = (fn) => { const id = ++nextTimer; timers.set(id, fn); return id }
globalThis.clearInterval = (id) => timers.delete(id)
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
let stopOwner = () => {}
try {
  const { useFocus, startFocusMonitoring } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
  now = monday
  // StrictMode's immediate cleanup never starts stale native subscriptions.
  const earlyStop = startFocusMonitoring()
  earlyStop()
  stopOwner = startFocusMonitoring()
  await settle()
  assert.equal(useFocus.getState().ready, true)
  assert.equal(useFocus.getState().enabled, false)
  assert.equal(listeners.size, 0)
  assert.equal(focusReads + scheduleReads, 0)
  useFocus.getState().setEnabled(true)
  await settle()
  assert.equal(storage.get('focus.v1.enabled'), true)
  assert.equal(useFocus.getState().tracking, true)
  assert.equal(statusReads, 0, 'reminder pause/status must never gate monitoring')
  now += 1000
  for (const fn of timers.values()) fn()
  await settle()
  assert.equal(useFocus.getState().snapshot.days[0].focusedMs, 1000)
  now += MAX_OBSERVATION_GAP_MS + 1
  for (const fn of timers.values()) fn()
  await settle()
  assert.equal(useFocus.getState().snapshot.days[0].focusedMs, 1000)
  assert.equal(useFocus.getState().snapshot.sessions[0].endReason, 'gap')
  // Block a pre-reset heartbeat write; the queued reset must win even after teardown.
  blockedWrite = new Promise(resolve => { releaseWrite = resolve })
  for (const fn of timers.values()) fn()
  await settle()
  const resetting = useFocus.getState().reset()
  assert.deepEqual(useFocus.getState().snapshot, emptyFocusSnapshot())
  releaseWrite()
  await resetting
  assert.deepEqual(storage.get('focus.v1.aggregate'), emptyFocusSnapshot())
  assert.equal(writeLog.filter(row => row.key === 'focus.v1.aggregate').at(-1).value.sessions.length, 0)
  assert.equal(useFocus.getState().enabled, true)
  now += 1000
  native = { ...native, focused: false, sequence: 2 }
  for (const fn of listeners) fn(native)
  assert.equal(useFocus.getState().snapshot.days[0].completedFocusedMs, 1000)
  assert.deepEqual(useFocus.getState().snapshot.sessions, [
    { start: now - 1000, end: now, durationMs: 1000, kind: 'focused', endReason: 'switch' },
  ])
  now += 500
  useFocus.getState().setEnabled(false)
  await settle()
  assert.equal(storage.get('focus.v1.enabled'), false)
  assert.equal(listeners.size, 0)
  assert.equal(timers.size, 0)
  const disabledSnapshot = useFocus.getState().snapshot
  assert.deepEqual(disabledSnapshot.sessions.at(-1), { start: now - 500, end: now, durationMs: 500, kind: 'outOfWindow', endReason: 'stop' })
  assert.deepEqual(storage.get('focus.v1.aggregate'), disabledSnapshot)
  now += 60_000
  stopOwner()
  stopOwner = startFocusMonitoring()
  await settle()
  assert.equal(useFocus.getState().enabled, false)
  assert.deepEqual(useFocus.getState().snapshot, disabledSnapshot)
  // Stored explicit consent survives another owner, without replaying downtime.
  useFocus.getState().setEnabled(true)
  await settle()
  stopOwner()
  await settle()
  stopOwner = startFocusMonitoring()
  await settle()
  assert.equal(useFocus.getState().enabled, true)
  assert.equal(listeners.size, 1)
  assert.deepEqual(useFocus.getState().snapshot, disabledSnapshot)
} finally {
  stopOwner()
  await settle()
  Date.now = realNow
  globalThis.setInterval = realInterval
  globalThis.clearInterval = realClearInterval
  globalThis.window = realWindow
  delete globalThis.__focusTest
}
console.log('focus accumulator and monitoring tests passed')
