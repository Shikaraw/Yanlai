import assert from 'node:assert/strict'
import { backspace, CalculatorGeneration, EXAMPLES, EXPRESSION_LIMIT, inputSelection, insertKey, keyboardKeys, MATRIX_OPERATIONS, matrixExpression, matrixSize, resizeMatrix } from './calculator-input.mjs'

let checks = 0
function test(name, fn) { fn(); checks++; console.log(`PASS ${name}`) }
test('insert at caret and replace selection', () => {
  assert.deepEqual(insertKey('abcd', 2, 2, { text: '+', label: '+' }), { value: 'ab+cd', start: 3, end: 3, accepted: true })
  assert.equal(insertKey('abcd', 1, 3, { text: 'x', label: 'x' }).value, 'axd')
})
test('functions wrap selection and select the body', () => {
  const sin = keyboardKeys('calculus').find(key => key.label === 'sin')
  assert.deepEqual(insertKey('1+x^2', 2, 5, sin), { value: '1+sin(x^2)', start: 6, end: 9, accepted: true })
  assert.equal(insertKey('', 0, 0, sin).value, 'sin(x)')
  assert.equal(insertKey('', 0, 0, keyboardKeys('calculus').find(key => key.label === '定积分 ∫')).value, '∫(x^2, x, 0, 1)')
  assert.equal(insertKey('x^3', 0, 3, keyboardKeys('calculus').find(key => key.label === '求导 d')).value, 'd(x^3, x)')
})
test('live selection wins over stale select event snapshot', () => {
  const sin = keyboardKeys('calculus').find(key => key.label === 'sin')
  const saved = { start: 3, end: 3 }
  const range = inputSelection({ selectionStart: 0, selectionEnd: 3 }, saved)
  assert.deepEqual(insertKey('x^2', range.start, range.end, sin), { value: 'sin(x^2)', start: 4, end: 7, accepted: true })
  assert.deepEqual(saved, { start: 3, end: 3 })
  // A shortcut that did not select must not be interpreted as select-all.
  const caret = inputSelection({ selectionStart: 3, selectionEnd: 3 }, { start: 0, end: 3 })
  assert.equal(insertKey('x^2', caret.start, caret.end, sin).value, 'x^2sin(x)')
  // Tab/keyboard activation retains the pre-blur snapshot when no live field is focused.
  assert.deepEqual(inputSelection(null, range), { start: 0, end: 3 })
  const partial = inputSelection({ selectionStart: 2, selectionEnd: 3 }, saved)
  assert.equal(insertKey('x^2', partial.start, partial.end, sin).value, 'x^sin(2)')
})
test('selection bounds and atomic maximum lengths', () => {
  assert.equal(insertKey('x', -5, 99, { text: 'y', label: '' }).value, 'y')
  const full = 'x'.repeat(EXPRESSION_LIMIT)
  assert.equal(insertKey(full, 0, 0, { text: '+', label: '' }).accepted, false)
  assert.equal(insertKey(full, 0, 1, { text: 'y', label: '' }).accepted, true)
  assert.equal(insertKey(full, 0, 1, { prefix: 'sin(', suffix: ')', label: '' }).value, full)
})
test('backspace handles selection, start, and surrogate pair', () => {
  assert.equal(backspace('abc', 1, 3).value, 'a')
  assert.equal(backspace('abc', 0, 0).value, 'abc')
  assert.deepEqual(backspace('x😀y', 3, 3), { value: 'xy', start: 1, end: 1, accepted: true })
})
test('mode-specific keys and multiple examples', () => {
  assert.ok(keyboardKeys('ode').some(key => key.text === "y''"))
  assert.ok(!keyboardKeys('matrix').some(key => key.prefix === '∫('))
  for (const examples of Object.values(EXAMPLES)) {
    assert.ok(examples.length >= 3)
    for (const example of examples) assert.ok(example.expression.length <= EXPRESSION_LIMIT)
  }
  assert.equal(EXAMPLES.ode[1].conditions, "y(0)=0\ny'(0)=1")
})
test('generated power keys match each engine and ODE omits unsupported Abs template', () => {
  for (const mode of ['calculus', 'matrix', 'ode']) {
    const power = keyboardKeys(mode).find(key => key.label === '^')
    const edit = insertKey('23', 1, 1, power)
    assert.equal(edit.value, mode === 'matrix' ? '2**3' : '2^3')
    assert.equal(edit.start, mode === 'matrix' ? 3 : 2)
    assert.equal(edit.end, edit.start)
    if (mode === 'matrix') assert.equal(matrixExpression([[edit.value]], 'literal'), '[[2**3]]')
    assert.equal(keyboardKeys(mode).some(key => key.label === 'Abs'), mode !== 'ode')
  }
})
test('matrix resize preserves cells, dimensions bounded 1..8', () => {
  assert.deepEqual(resizeMatrix([['x']], 2, 2), [['x', '0'], ['0', '0']])
  assert.deepEqual(resizeMatrix([['x', 'y'], ['z', '1']], 1, 1), [['x']])
  assert.equal(matrixSize(0), 1); assert.equal(matrixSize(99), 8); assert.equal(matrixSize(NaN), 1)
  assert.deepEqual(resizeMatrix([], 3, 3, true), [['1', '0', '0'], ['0', '1', '0'], ['0', '0', '1']])
})
test('operations generate actual worker syntax without evaluation', () => {
  for (const [op] of MATRIX_OPERATIONS) {
    assert.equal(matrixExpression([['1', '2'], ['3', '4']], op), op === 'literal' ? '[[1,2],[3,4]]' : `${op}([[1,2],[3,4]])`)
  }
  assert.equal(matrixExpression([[' ', 'atan2(x,y)', '1/2']], 'literal'), '[[0,atan2(x,y),1/2]]')
})
test('matrix guards shape, injection, parentheses, and max size', () => {
  for (const cells of [[], [[]], [['1'], ['2', '3']], Array.from({ length: 9 }, () => ['1'])]) assert.throws(() => matrixExpression(cells, 'literal'))
  for (const cell of ['1,2', '1],[2', '__import__(x)', 'sin(x', 'x)', 'x;z', 'x\ny', 'x'.repeat(129)]) assert.throws(() => matrixExpression([[cell]], 'literal'))
  assert.throws(() => matrixExpression([['1']], 'unsupported'))
  assert.throws(() => matrixExpression(resizeMatrix([], 8, 8).map(row => row.map(() => 'x'.repeat(40))), 'literal'))
})
test('generation suppresses late warmup, restart, compute, and unmount responses', () => {
  const guard = new CalculatorGeneration()
  const warmup = guard.next()
  const compute = guard.next()
  assert.equal(guard.isCurrent(warmup), false); assert.equal(guard.isCurrent(compute), true)
  const restart = guard.next()
  assert.equal(guard.isCurrent(compute), false)
  guard.next() // unmount / StrictMode cleanup
  assert.equal(guard.isCurrent(restart), false)
  const remount = guard.next()
  assert.equal(guard.isCurrent(warmup), false); assert.equal(guard.isCurrent(remount), true)
})
console.log(`${checks} calculator input tests passed`)
