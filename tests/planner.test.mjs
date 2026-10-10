import { isStudyKind, durationMinutes, studyMinutes, resolveScenarioKey, localDateKey } from './planner.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`) } }
ok('only study/review count', isStudyKind('study') && isStudyKind('review') && !isStudyKind('class') && !isStudyKind('break'))
ok('normal duration', durationMinutes('09:00', '10:30') === 90)
ok('cross midnight duration', durationMinutes('23:00', '01:00') === 120)
ok('invalid duration zero', durationMinutes('bad', '01:00') === 0)
ok('class excluded from total', studyMinutes([{id:'a',start:'09:00',end:'10:00',title:'a',kind:'study'},{id:'b',start:'10:00',end:'12:00',title:'b',kind:'class'}]) === 60)
ok('work route', resolveScenarioKey({workdays:[1,2,3]}, 'work') === 'work' && resolveScenarioKey({workdays:[1,2,3]}, '1') === 'work')
ok('rest route', resolveScenarioKey({workdays:[1,2,3]}, 'rest') === 'rest' && resolveScenarioKey({workdays:[1,2,3]}, '6') === 'rest')
ok('local date key', /^\d{4}-\d{2}-\d{2}$/.test(localDateKey(new Date(2026, 0, 2))))
// Execute the view's actual handlers with isolated persistence/state doubles.
// Locate the source from either tests/ or the runner's tests/.build/ copy.
const testDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.basename(testDir) === '.build' ? path.resolve(testDir, '../..') : path.resolve(testDir, '..')
const source = fs.readFileSync(path.join(root, 'src/views/PlannerView.tsx'), 'utf8')
const ast = ts.createSourceFile('PlannerView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const view = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'PlannerView')
const handlers = new Map()
for (const statement of view.body.statements) {
  if (!ts.isVariableStatement(statement)) continue
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.initializer) handlers.set(declaration.name.text, declaration.initializer.getText(ast))
  }
}
function handler(name, context) {
  const js = ts.transpileModule(`(${handlers.get(name)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return vm.runInNewContext(js, context)
}
const item = { id: 'original', title: '新时段', start: '09:00', end: '10:00', kind: 'study', subject: '数学', note: '保留备注', remind: false }
const makeSchedule = mode => ({ mode, weekly: {}, unified: [], workday: { work: [item], rest: [{ ...item, id: 'existing', start: '12:00' }] }, workdays: [1, 2, 3, 4, 5] })
let checks = 0
for (const mode of ['weekly', 'workday', 'unified']) {
  for (const success of [false, true]) {
    const toasts = [], writes = []
    let ids = 0
    const apply = handler('applyTemplate', {
      schedule: makeSchedule(mode), saving: false, DAYS: Array.from({ length: 7 }, (_, i) => ({ n: i + 1 })),
      uid: () => `fresh-${++ids}`, app: { toast: toast => toasts.push(toast) },
      persist: async next => { writes.push(next); return success },
    })
    await apply({ name: '测试模板', build: () => [{ ...item }] })
    assert.equal(writes.length, 1)
    assert.equal(toasts.length, success ? 1 : 0, `${mode}: failure must not report success`)
    if (success) assert.equal(toasts[0].kind, 'success')
    checks++
  }
}
for (const day of ['work', 'rest', '1', '7']) {
  for (const success of [false, true]) {
    const schedule = makeSchedule('workday'), toasts = [], writes = []
    const original = structuredClone(schedule)
    const context = {
      schedule, saving: false, resolveScenarioKey, uid: () => 'independent-copy',
      sorted: items => [...items].sort((a, b) => a.start.localeCompare(b.start)),
      app: { toast: toast => toasts.push(toast) },
      persist: async next => { writes.push(next); return success },
    }
    context.listFor = handler('listFor', context)
    context.setListFor = handler('setListFor', context)
    await handler('duplicateItem', context)(day, item)
    const target = resolveScenarioKey(schedule, day) === 'work' ? 'rest' : 'work'
    const sourceKey = target === 'work' ? 'rest' : 'work'
    assert.equal(writes.length, 1)
    assert.equal(writes[0].workday[target].length, schedule.workday[target].length + 1)
    const copy = writes[0].workday[target].find(i => i.id === 'independent-copy')
    assert.deepEqual({ ...copy, id: item.id }, item)
    assert.notEqual(copy, item)
    assert.deepEqual(writes[0].workday[sourceKey], schedule.workday[sourceKey])
    assert.deepEqual(schedule, original, 'copy must not mutate the source schedule')
    assert.equal(toasts.length, success ? 1 : 0)
    if (success) assert.equal(toasts[0].kind, 'success')
    checks++
  }
}
const unifiedToasts = []
await handler('duplicateItem', {
  schedule: makeSchedule('unified'), saving: false,
  app: { toast: toast => unifiedToasts.push(toast) },
  persist: () => { throw new Error('unified copy must not persist') },
})('1', item)
assert.equal(unifiedToasts[0].kind, 'info')
assert.match(unifiedToasts[0].body, /共享同一组时段/)
checks++
const weeklyState = {}
await handler('duplicateItem', {
  schedule: makeSchedule('weekly'), saving: false, DAYS: Array.from({ length: 7 }, (_, i) => ({ n: i + 1 })),
  setCopyDays: days => { weeklyState.days = days }, setCopying: value => { weeklyState.copying = value },
})('3', item)
assert.deepEqual(Array.from(weeklyState.days), ['1', '2', '4', '5', '6', '7'])
assert.deepEqual({ ...weeklyState.copying.item }, item)
checks++
// Check every editor entry point carries explicit identity, never a title heuristic.
let newEntries = 0, editEntries = 0
function checkEditorEntries(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'setEditing' && ts.isObjectLiteralExpression(node.arguments[0])) {
    const identity = node.arguments[0].properties.find(prop => prop.name?.getText(ast) === 'isNew')
    assert.ok(identity, 'each editor entry must declare new/edit identity')
    if (identity.initializer.kind === ts.SyntaxKind.TrueKeyword) newEntries++
    else { assert.equal(identity.initializer.kind, ts.SyntaxKind.FalseKeyword); editEntries++ }
  }
  ts.forEachChild(node, checkEditorEntries)
}
checkEditorEntries(ast)
assert.equal(newEntries, 3)
assert.equal(editEntries, 2)
assert.match(source, /const isNew = editing\.isNew/)
assert.doesNotMatch(source, /const isNew = .*title/)
assert.match(source, /onCopy=\{\(item, day\) => void duplicateItem\(day, item\)\}/)
checks++
console.log(`  ${checks} planner view regression checks passed`)
console.log(`\n${fail ? `✗ ${fail} failed` : `✓ ${pass} planner utility checks passed`}`)
process.exit(fail ? 1 : 0)
