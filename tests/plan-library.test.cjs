'use strict'
// Exercise the actual inline IPC section without starting Electron or its windows.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8')
const section = source.slice(source.indexOf('function plannerLibraryPath()'), source.indexOf("ipcMain.handle('planner:status'"))
const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value))
const schedule = (name) => ({ version: 1, name, mode: 'unified', unified: [{ id: 'item', start: '08:00', title: name }] })
let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log(`PASS ${name}`)
}
function harness(initial = {}) {
  const files = new Map(Object.entries(initial))
  const handlers = new Map()
  const writes = []
  let reloads = 0
  let fail = () => false
  const store = {
    dirs: () => ({ userData: '/test' }),
    readJson: (file, fallback) => files.has(path.basename(file)) ? copy(files.get(path.basename(file))) : fallback,
    writeJson: (file, data) => {
      const name = path.basename(file)
      writes.push(name)
      if (fail(name, data)) return false
      files.set(name, copy(data))
      return true
    },
  }
  vm.runInNewContext(section, {
    path, crypto, store, Date,
    fs: { unlinkSync: (file) => files.delete(path.basename(file)) },
    planner: { reload: () => reloads++ },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  })
  return {
    call: (method, data) => handlers.get(`planner:${method}`)(null, data),
    read: (name) => copy(files.get(name)),
    fail: (predicate) => { fail = predicate },
    get reloads() { return reloads },
    writes,
  }
}
function twoPlans() {
  const h = harness()
  const a = h.call('savePlan', { name: 'A', schedule: schedule('A') }).plan
  const b = h.call('savePlan', { name: 'B', schedule: schedule('B') }).plan
  assert.equal(h.call('activatePlan', a.id).ok, true)
  return { h, a, b }
}

test('first generated plan is a named inactive draft', () => {
  const h = harness()
  const r = h.call('savePlan', { name: '  Draft  ', schedule: schedule('AI') })
  assert.equal(r.ok, true)
  assert.equal(r.plan.name, 'Draft')
  assert.equal(r.plan.schedule.planId, r.plan.id)
  assert.equal(r.library.activeId, '')
  assert.equal(h.read('planner.json'), undefined)
  assert.equal(h.reloads, 0)
})
test('new plan preserves active schedule and same-name plans get distinct identities', () => {
  const { h, a } = twoPlans()
  const before = h.read('planner.json')
  const r = h.call('savePlan', { name: 'A', schedule: schedule('New AI') })
  assert.notEqual(r.plan.id, a.id)
  assert.equal(r.library.activeId, a.id)
  assert.deepEqual(h.read('planner.json'), before)
  assert.equal(h.reloads, 1)
})
test('activation writes matching planId into schedule', () => {
  const { h, b } = twoPlans()
  const r = h.call('activatePlan', b.id)
  assert.equal(r.ok, true)
  assert.equal(h.read('planner.json').planId, b.id)
  assert.equal(h.read('planner-plans.json').activeId, b.id)
})
test('active save synchronizes name, schedule and timestamp', () => {
  const { h, a } = twoPlans()
  const createdAt = a.createdAt
  const r = h.call('savePlan', { id: a.id, name: 'Renamed', schedule: schedule('Edit') })
  assert.equal(r.ok, true)
  assert.equal(r.plan.createdAt, createdAt)
  assert.deepEqual(h.read('planner.json'), h.read('planner-plans.json').plans[0].schedule)
  assert.equal(h.read('planner.json').name, 'Renamed')
  assert.equal(h.reloads, 2)
})
test('setSchedule creates and activates initial plan', () => {
  const h = harness()
  const r = h.call('setSchedule', schedule('Manual'))
  assert.equal(r.ok, true)
  assert.equal(r.library.activeId, r.schedule.planId)
  assert.deepEqual(h.read('planner.json'), h.read('planner-plans.json').plans[0].schedule)
})
test('setSchedule synchronizes active plan name and rejects stale identity', () => {
  const { h, a, b } = twoPlans()
  const r = h.call('setSchedule', { ...schedule('Edited'), planId: a.id })
  assert.equal(r.ok, true)
  assert.equal(h.read('planner-plans.json').plans[0].name, 'Edited')
  assert.deepEqual(h.read('planner.json'), h.read('planner-plans.json').plans[0].schedule)
  assert.equal(h.call('setSchedule', { ...schedule('Stale'), planId: b.id }).ok, false)
  assert.equal(h.read('planner.json').name, 'Edited')
})
test('deleting inactive plan never rewrites active schedule or reloads', () => {
  const { h, b } = twoPlans()
  const before = h.read('planner.json')
  const r = h.call('deletePlan', b.id)
  assert.equal(r.ok, true)
  assert.deepEqual(h.read('planner.json'), before)
  assert.equal(h.reloads, 1)
})
test('deleting active plan switches to identified remaining plan', () => {
  const { h, a, b } = twoPlans()
  const r = h.call('deletePlan', a.id)
  assert.equal(r.ok, true)
  assert.equal(r.library.activeId, b.id)
  assert.equal(h.read('planner.json').planId, b.id)
  assert.equal(h.call('deletePlan', b.id).ok, false)
})
for (const operation of ['activatePlan', 'deletePlan', 'savePlan', 'setSchedule']) {
  for (const file of ['planner-plans.json', 'planner.json']) {
    test(`${operation} checks ${file} failure and preserves persisted state`, () => {
      const { h, a, b } = twoPlans()
      const libraryBefore = h.read('planner-plans.json')
      const scheduleBefore = h.read('planner.json')
      h.fail((name) => name === file)
      const arg = operation === 'activatePlan' ? b.id : operation === 'deletePlan' ? a.id
        : operation === 'savePlan' ? { id: a.id, name: 'Failed', schedule: schedule('Failed') }
          : { ...schedule('Failed'), planId: a.id }
      const r = h.call(operation, arg)
      assert.equal(r.ok, false)
      assert.ok(r.error)
      assert.deepEqual(h.read('planner-plans.json'), libraryBefore)
      assert.deepEqual(h.read('planner.json'), scheduleBefore)
      assert.equal(h.reloads, 1)
    })
  }
}
test('rollback failure is reported explicitly', () => {
  const { h, b } = twoPlans()
  let libraryWrites = 0
  h.fail((name) => name === 'planner.json' || (name === 'planner-plans.json' && ++libraryWrites > 1))
  assert.match(h.call('activatePlan', b.id).error, /回滚失败/)
})
test('legacy schedule migrates once and persists stable identity', () => {
  const h = harness({ 'planner.json': schedule('Legacy') })
  const first = h.call('listPlans')
  assert.equal(first.plans.length, 1)
  assert.equal(first.activeId, h.read('planner.json').planId)
  assert.equal(h.call('listPlans').activeId, first.activeId)
})
test('legacy library migration preserves latest schedule edits', () => {
  const h = harness({
    'planner.json': schedule('Latest'),
    'planner-plans.json': { version: 1, activeId: 'old', plans: [{ id: 'old', name: 'Saved name', schedule: schedule('Stale') }] },
  })
  const r = h.call('listPlans')
  assert.equal(h.read('planner.json').planId, 'old')
  assert.equal(r.plans[0].schedule.unified[0].title, 'Latest')
  assert.equal(r.plans[0].schedule.name, 'Saved name')
})
test('migration errors are surfaced rather than returning unpersisted IDs', () => {
  const h = harness({ 'planner.json': schedule('Legacy') })
  h.fail(() => true)
  assert.throws(() => h.call('listPlans'), /写入失败/)
  assert.equal(h.call('setSchedule', schedule('Edit')).ok, false)
})
test('empty saved library is not repeatedly migrated from schedule', () => {
  const h = harness({ 'planner.json': schedule('Old'), 'planner-plans.json': { version: 1, activeId: '', plans: [] } })
  assert.equal(h.call('listPlans').plans.length, 0)
  assert.equal(h.writes.length, 0)
})
test('unknown IDs and invalid schedules fail without writing', () => {
  const { h } = twoPlans()
  const count = h.writes.length
  for (const method of ['activatePlan', 'deletePlan']) assert.equal(h.call(method, 'missing').ok, false)
  assert.equal(h.call('savePlan', { id: 'missing', schedule: schedule('X') }).ok, false)
  assert.equal(h.call('savePlan', { schedule: null }).ok, false)
  assert.equal(h.call('setSchedule', []).ok, false)
  assert.equal(h.writes.length, count)
})

async function testAI() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yanlai-plan-test-'))
  try {
    const outfile = path.join(dir, 'tools.mjs')
    await require('esbuild').build({ entryPoints: [path.join(root, 'src/lib/tools.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
    const { executeTool } = await import(pathToFileURL(outfile).href)
    let saved
    const ctx = { savePlan: async (s) => { saved = s } }
    const result = await executeTool('save_study_plan', { mode: 'unified', name: '  AI draft  ', items: [{ title: 'Math', start: '08:00' }] }, ctx)
    assert.equal(saved.name, 'AI draft')
    assert.match(result.text, /尚未启用/)
    assert.match(result.text, /当前启用的计划保持不变/)
    const failure = await executeTool('save_study_plan', { mode: 'unified' }, { savePlan: async () => { throw new Error('disk full') } })
    assert.match(failure.text, /disk full/)
    assert.equal(failure.label, '工具出错')
    passed += 2
    console.log('PASS AI tool saves named draft and reports failures honestly')
    const chat = fs.readFileSync(path.join(root, 'src/store/useChat.ts'), 'utf8')
    const contextSave = chat.slice(chat.indexOf('    savePlan: async (schedule: any) => {'), chat.indexOf('    exportDoc: async'))
    const executable = `({${contextSave.replace('(schedule: any)', '(schedule)')}})`
    let payload
    const wiring = vm.runInNewContext(executable, { bridge: { planner: { savePlan: async (p) => { payload = p; return { ok: true } } } }, Error })
    await wiring.savePlan(saved)
    assert.equal(payload.name, saved.name)
    assert.equal(Object.hasOwn(payload, 'id'), false)
    const badWiring = vm.runInNewContext(executable, { bridge: { planner: { savePlan: async () => ({ ok: false, error: 'write failed' }) } }, Error })
    await assert.rejects(badWiring.savePlan(saved), /write failed/)
    passed++
    console.log('PASS AI context uses savePlan with no id and checks errors')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
testAI().then(() => console.log(`\n${passed} plan library / AI checks passed`)).catch((e) => { console.error(e); process.exitCode = 1 })
