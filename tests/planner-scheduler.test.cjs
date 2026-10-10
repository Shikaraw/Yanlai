'use strict'
const assert = require('node:assert/strict')
const { Planner, resolveDayItems, toMinutes } = require('../electron/lib/planner.cjs')
const RealDate = Date
let clock = new RealDate(2026, 9, 5, 9).getTime() // Monday, local time
class FakeDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [clock])) }
  static now() { return clock }
}
global.Date = FakeDate
const at = (day, hour, minute = 0, second = 0) => { clock = new RealDate(2026, 9, day, hour, minute, second).getTime() }
const item = (id, start, end, extra = {}) => ({ id, title: id, start, end, ...extra })
const unified = (items, extra = {}) => ({ mode: 'unified', unified: items, activeDays: [1, 2, 3, 4, 5, 6, 7], ...extra })
const fixture = (initial, initialSettings = {}) => {
  let schedule = initial, settings = initialSettings
  const fired = []
  const planner = new Planner({ getSchedule: () => schedule, getSettings: () => settings, onFire: (payload) => fired.push(payload) })
  return { planner, fired, save: (s) => { schedule = s; planner.reload() }, settings: (s) => { settings = s } }
}
let passed = 0, failed = 0
function test(name, run) {
  at(5, 9)
  try { run(); passed++; console.log(`  PASS ${name}`) }
  catch (error) { failed++; console.error(`  FAIL ${name}\n${error.stack}`) }
}
try {
  test('time parser rejects malformed types and out-of-range values', () => {
    for (const value of [null, undefined, {}, [], 900, '24:00', '12:60', '-1:00', '9:0', 'bad']) assert.equal(toMinutes(value), null)
    assert.equal(toMinutes(' 9:05 '), 545)
    assert.equal(toMinutes('23:59'), 1439)
  })
  test('malformed schedules and item lists are safe in resolution, preview, status and tick', () => {
    for (const schedule of [null, false, 'bad', [], {}, { mode: 'unknown', unified: [] },
      { mode: 'unified', unified: {} }, { mode: 'weekly', weekly: { 1: 'bad' } },
      { mode: 'workday', workdays: {}, workday: {} }, { mode: 'workday', workday: [] },
      unified([null, 1, {}, [], item('bad-start', '99:00'), item('bad-end', '09:00', 'oops')])]) {
      const { planner, fired } = fixture(schedule)
      assert.deepEqual(resolveDayItems(schedule), [])
      assert.deepEqual(planner.preview(), [])
      assert.equal(planner.status().current, null)
      planner.tick()
      assert.equal(fired.length, 0)
    }
  })
  test('valid items sort without mutating source; open-ended items complete at start', () => {
    const schedule = unified([item('later', '10:00'), item('early', '08:00', '08:30'), null, item('open', '09:00', '')])
    const { planner } = fixture(schedule)
    assert.deepEqual(planner.preview().map((it) => [it.id, it.state]), [['early', 'done'], ['open', 'done'], ['later', 'pending']])
    assert.equal(schedule.unified[0].id, 'later')
    assert.equal(planner.status().progress, 2 / 3)
  })
  test('unified activeDays: omitted defaults to all, empty disables all, invalid is safe', () => {
    const events = [item('a', '09:00', '10:00')]
    assert.equal(resolveDayItems({ unified: events }).length, 1)
    for (const days of [[], [2], '1', null, ['1']]) {
      const { planner, fired } = fixture(unified(events, { activeDays: days }))
      assert.equal(planner.preview().length, 0)
      assert.equal(planner.status().count, 0)
      planner.tick()
      assert.equal(fired.length, 0)
    }
    assert.equal(resolveDayItems(unified(events, { activeDays: [1] })).length, 1)
  })
  test('weekly/workday routing ignores unified activeDays and honors empty workdays', () => {
    const work = [item('work', '09:00', '10:00')], rest = [item('rest', '10:00', '11:00')]
    assert.equal(resolveDayItems({ mode: 'weekly', weekly: { 1: work }, activeDays: [] })[0].id, 'work')
    assert.equal(resolveDayItems({ mode: 'workday', workday: { work, rest }, activeDays: [] })[0].id, 'work')
    assert.equal(resolveDayItems({ mode: 'workday', workdays: [], workday: { work, rest } })[0].id, 'rest')
    at(10, 9) // Saturday
    assert.equal(resolveDayItems({ mode: 'workday', workday: { work, rest } })[0].id, 'rest')
  })
  test('overnight event stays pending before start and active after start, not done', () => {
    const { planner } = fixture(unified([item('study', '08:00', '09:00'), item('sleep', '23:00', '06:00')]))
    at(5, 12)
    assert.equal(planner.preview()[1].state, 'pending')
    assert.equal(planner.status().progress, 0.5)
    assert.equal(planner.status().next.id, 'sleep')
    at(5, 23)
    assert.equal(planner.preview()[1].state, 'active')
    assert.equal(planner.status().current.id, 'sleep')
    assert.equal(planner.status().progress, 0.5)
  })
  test('current carries previous day overnight event with original day metadata', () => {
    const { planner } = fixture({ mode: 'weekly', weekly: { 1: [item('monday', '23:00', '06:00')], 2: [item('tuesday', '08:00', '09:00')] } })
    at(6, 1)
    const status = planner.status()
    assert.equal(status.current.id, 'monday')
    assert.equal(status.current.state, 'active')
    assert.equal(status.current.dateKey, '2026-10-05')
    assert.equal(status.current.dow, 1)
    assert.equal(status.next.id, 'tuesday')
    assert.equal(status.count, 1)
    assert.equal(status.progress, 0)
    assert.deepEqual(planner.preview().map((it) => it.id), ['tuesday'])
    at(6, 6)
    assert.equal(planner.status().current, null)
  })
  test('carryover uses originating active day even when today disabled', () => {
    const { planner } = fixture(unified([item('night', '23:00', '02:00')], { activeDays: [1] }))
    at(6, 1)
    assert.equal(planner.status().current.id, 'night')
    assert.equal(planner.status().count, 0)
    at(5, 1)
    assert.equal(planner.status().current, null) // Sunday was disabled
  })
  test('overnight workday carryover uses yesterday scenario, not today rest list', () => {
    const { planner } = fixture({ mode: 'workday', workday: { work: [item('work-night', '23:00', '06:00')], rest: [] } })
    at(10, 2)
    assert.equal(planner.status().current.id, 'work-night')
    assert.equal(planner.status().count, 0)
  })
  test('same-day intervals use inclusive start and exclusive end; equal end is zero duration', () => {
    const { planner } = fixture(unified([item('a', '09:00', '10:00'), item('zero', '10:00', '10:00')]))
    assert.equal(planner.status().current.id, 'a')
    at(5, 10)
    assert.equal(planner.status().current, null)
    assert.equal(planner.status().progress, 1)
  })
  test('future preview pending and invalid day offsets rejected', () => {
    const { planner } = fixture(unified([item('a', '08:00', '09:00')]))
    assert.equal(planner.preview(1)[0].state, 'pending')
    assert.equal(planner.preview(1)[0].dateKey, '2026-10-06')
    for (const offset of [NaN, Infinity, '1', 0.5, 1e9]) assert.deepEqual(planner.preview(offset), [])
  })
  test('reload preserves fired guards after edits, with legacy fallback and plan scoping', () => {
    const schedule = unified([item('a', '09:00', '10:00')], { planId: 'one' })
    const { planner, fired, save } = fixture(schedule)
    planner.tick(); planner.tick()
    save({ ...schedule, updatedAt: 42, unified: [item('a', '09:00', '11:00', { title: 'edited' })] })
    assert.equal(fired.length, 1)
    save({ ...schedule, planId: 'two' })
    assert.equal(fired.length, 2)
    save(schedule)
    assert.equal(fired.length, 2)
    save({ ...schedule, planId: undefined })
    save({ ...schedule, planId: undefined, updatedAt: 99 })
    assert.equal(fired.length, 3)
  })
  test('firing window prevents missed-reminder flood and repeats on next occurrence date', () => {
    const { planner, fired } = fixture(unified([item('a', '09:00', '10:00'), item('off', '09:00', '10:00', { remind: false })]))
    at(5, 9, 1, 30); planner.tick()
    assert.equal(fired.length, 0)
    at(6, 9, 1, 29); planner.tick(); planner.tick()
    assert.equal(fired.length, 1)
    at(7, 9); planner.tick()
    assert.equal(fired.length, 2)
    at(9, 9); planner.tick()
    assert.equal(planner.fired.size, 1)
  })
  test('advance reminders cross midnight and retain tomorrow guard on rollover/reload', () => {
    const schedule = { mode: 'weekly', planId: 'one', weekly: { 2: [item('early', '00:01', '01:00')] } }
    const { planner, fired, save } = fixture(schedule, { planner: { advanceSeconds: 120 } })
    at(5, 23, 59); planner.tick()
    assert.equal(fired.length, 1)
    at(6, 0); planner.tick(); save(schedule)
    assert.equal(fired.length, 1)
  })
  test('midnight grace window includes yesterday and cannot duplicate prior fire', () => {
    const { planner, fired } = fixture(unified([item('late', '23:59', '00:30')]))
    at(6, 0, 0, 20); planner.tick()
    assert.equal(fired.length, 1)
    planner.tick()
    assert.equal(fired.length, 1)
  })
  test('malformed advance settings safe; negative disabled and excessive bounded', () => {
    for (const advanceSeconds of [Infinity, NaN, '60', {}, -60]) {
      const { planner, fired } = fixture(unified([item('a', '09:00')]), { planner: { advanceSeconds } })
      planner.tick()
      assert.equal(fired.length, 1)
    }
    const { planner, fired } = fixture(unified([item('a', '10:00')]), { planner: { advanceSeconds: 1e9 } })
    planner.tick()
    assert.equal(fired.length, 1)
  })
  test('snooze validation and paused due reminders', () => {
    const { planner, fired } = fixture(unified([item('a', '09:00')]))
    planner.tick()
    for (const minutes of [0, -1, Infinity, NaN, '5', null]) planner.snooze(minutes)
    assert.equal(planner.snoozed.length, 0)
    planner.snooze(5)
    planner.setPaused(true)
    at(5, 9, 5); planner.tick(); planner.tick()
    assert.equal(fired.length, 2)
    assert.equal(fired[1].kind, 'snooze')
    assert.equal(planner.snoozed.length, 0)
  })
  test('notification exceptions do not kill scheduler or permit repeat firing', () => {
    let calls = 0
    const planner = new Planner({ getSchedule: () => unified([item('a', '09:00')]), onFire: () => { calls++; throw new Error('notification failure') } })
    planner.tick(); planner.reload()
    assert.equal(calls, 1)
  })
} finally { global.Date = RealDate }
console.log(`\n${passed} scheduler checks passed; ${failed} failed`)
process.exitCode = failed ? 1 : 0
