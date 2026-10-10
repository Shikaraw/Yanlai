'use strict'
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { CalculatorManager, resolveConfig } = require('../electron/lib/calculator.cjs')
const request = id => ({ id, mode: 'calculus', expression: '1+1' })
function fakeSpawn(options = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.killed = false
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', 1)); return true }
  if (!options.noReady) queueMicrotask(() => {
    child.stderr.write('diagnostic only\n')
    child.stdout.write('{"type":"ready","protocol":1}\n')
  })
  child.stdin.on('data', chunk => {
    const p = JSON.parse(chunk.toString())
    if (options.respond) child.stdout.write(JSON.stringify({ id: p.id, ok: true, result: { text: '2', latex: '2' } }) + '\n')
  })
  return child
}
async function main() {
  const path = require('node:path')
  const config = resolveConfig({ env: {} })
  assert.equal(config.root, path.resolve(__dirname, '../resources/clever-calculator'))
  assert.equal(config.python, path.join(config.root, 'python', process.platform === 'win32' ? 'python.exe' : 'python'))
  assert.equal(resolveConfig({ packaged: true, resourcesPath: 'C:/Portable App/resources', env: {} }).worker,
    path.join('C:/Portable App/resources', 'clever-calculator', 'worker.py'))
  assert.equal(resolveConfig({ env: { YANLAI_CALCULATOR_PYTHON: 'custom-python' } }).python, 'custom-python')
  const manifest = require('../scripts/calculator/verify-runtime.cjs').verify(config.root)
  assert.equal(manifest.originalSource.license, 'not found in original source tree')
  const cases = [
    { id: 'integral', mode: 'calculus', expression: '∫(x^2,x,0,1)' },
    { id: 'derivative', mode: 'calculus', expression: 'd(sin(x),x)' },
    { id: 'implicit', mode: 'calculus', expression: '2x+1' },
    { id: 'matrix', mode: 'matrix', expression: 'inverse([[1,2],[3,4]])' },
    { id: 'ode', mode: 'ode', expression: "y'+y=0", conditions: ['y(0)=1'] },
    { id: 'unsafe', mode: 'matrix', expression: "__import__('os').system('whoami')" },
    { id: 'attribute', mode: 'calculus', expression: 'x.__class__' },
    { id: 'power', mode: 'calculus', expression: '2^1000' },
    { id: 'mode', mode: 'exec', expression: '1' },
    { id: 'large', mode: 'calculus', expression: '1'.repeat(2049) },
    request('recover'),
  ]
  const worker = spawnSync(config.python, ['-I', '-B', '-u', config.worker], {
    input: 'not-json\n' + cases.map(p => JSON.stringify(p)).join('\n') + '\n',
    encoding: 'utf8', windowsHide: true, timeout: 45000,
    env: { ...process.env, PATH: '', PYTHONPATH: 'C:/nonexistent', PYTHONHOME: 'C:/nonexistent' },
  })
  assert.equal(worker.error, undefined)
  assert.equal(worker.status, 0, worker.stderr)
  const lines = worker.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines[0].modes, ['calculus', 'matrix', 'ode'])
  assert.equal(lines[1].ok, false)
  const responses = Object.fromEntries(lines.slice(2).map(p => [p.id, p]))
  for (const id of ['integral', 'derivative', 'implicit', 'matrix', 'ode', 'recover']) assert.equal(responses[id].ok, true, JSON.stringify(responses[id]))
  assert.match(responses.integral.result.text, /1\/3/)
  assert.match(responses.derivative.result.latex, /cos/)
  assert.equal(responses.matrix.result.isMatrix, true)
  assert.match(responses.ode.result.text, /exp\(-x\)/)
  for (const id of ['unsafe', 'attribute', 'power', 'mode', 'large']) assert.equal(responses[id].ok, false)
  assert.equal(Object.keys(responses).length, cases.length)
  const imports = spawnSync(config.python, ['-I', '-B', '-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('worker', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
worker.load_engines()
assert not any(n.split('.')[0] in ('numpy', 'matplotlib', 'PySide6', 'PyQt5', 'PyQt6') for n in sys.modules)
for expression in ('open(1)', 'x.real', '[x for x in [1]]', 'lambda:1'):
    try: worker.safe_parse(expression)
    except Exception: pass
    else: raise AssertionError(expression)
`, config.worker], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.equal(imports.status, 0, imports.stderr)
  console.log('Bundled worker: protocol, Unicode, calculus, matrix, ODE, validation, AST, dependency isolation PASSED')
  let children = []
  const manager = new CalculatorManager({}, { spawnFn: () => { const c = fakeSpawn({ respond: true }); children.push(c); return c } })
  assert.equal(manager.status().state, 'stopped')
  assert.equal((await manager.ensureReady()).ready, true)
  assert.equal(manager.stderr, 'diagnostic only\n')
  assert.equal((await manager.calculate(request('normal'))).result.text, '2')
  assert.equal((await manager.calculate({ ...request('bad'), command: 'exec' })).ok, false)
  children[0].emit('close', 9)
  assert.equal(manager.status().ready, false)
  assert.equal((await manager.calculate(request('recovered'))).ok, true)
  assert.equal(children.length, 2)
  manager.dispose()

  const slow = new CalculatorManager({}, { spawnFn: () => fakeSpawn(), requestTimeout: 30 })
  const pending = slow.calculate(request('timeout'))
  await new Promise(r => setTimeout(r, 5))
  assert.equal((await slow.calculate(request('busy'))).error.code, 'BUSY')
  assert.equal((await pending).error.code, 'TIMEOUT')
  assert.equal(slow.status().ready, false)
  await slow.ensureReady()
  const cancelled = slow.calculate(request('cancel'))
  await new Promise(r => setTimeout(r, 5))
  assert.equal(slow.cancel('cancel'), true)
  assert.equal((await cancelled).error.code, 'CANCELLED')
  assert.equal((await slow.restart()).ready, true)
  slow.dispose()

  const never = new CalculatorManager({}, { spawnFn: () => fakeSpawn({ noReady: true }), startupTimeout: 20 })
  await assert.rejects(never.ensureReady(), /did not become ready/)
  never.dispose()
  const invalid = new CalculatorManager({}, { spawnFn: () => {
    const c = fakeSpawn(); queueMicrotask(() => c.stdout.write('not json\n')); return c
  } })
  await invalid.ensureReady().catch(() => {})
  assert.equal(invalid.status().ready, false)
  invalid.dispose()

  const warmChildren = []
  const warm = new CalculatorManager({}, { spawnFn: () => {
    const c = fakeSpawn({ noReady: true, respond: true }); warmChildren.push(c); return c
  } })
  const warmups = [warm.ensureReady(), warm.ensureReady(), warm.ensureReady()]
  const duringWarmup = warm.calculate(request('during-warmup'))
  assert.equal(warmChildren.length, 1)
  assert.equal((await warm.calculate(request('warmup-busy'))).error.code, 'BUSY')
  warmChildren[0].stdout.write('{"type":"ready","protocol":1}\n')
  assert.equal((await Promise.all(warmups)).every(s => s.ready), true)
  assert.equal((await duringWarmup).ok, true)
  await new Promise(r => setTimeout(r, 40))
  assert.equal(warm.child, warmChildren[0], 'idle warm worker must be retained')
  assert.equal(warmChildren[0].killed, false)
  await warm.ensureReady()
  assert.equal((await warm.calculate(request('after-idle'))).ok, true)
  assert.equal(warmChildren.length, 1)
  warm.dispose()

  // Calculation-first startup must also be shared by readiness callers.
  let startupChild
  const startup = new CalculatorManager({}, { spawnFn: () => (startupChild = fakeSpawn({ noReady: true, respond: true })) })
  const startupCalculation = startup.calculate(request('startup-cancel'))
  const startupReady = startup.ensureReady()
  const rejectedStartup = assert.rejects(startupReady, e => e.code === 'CANCELLED' && /cancelled/.test(e.message))
  assert.equal(startup.cancel('unrelated'), false)
  assert.equal(startup.cancel('startup-cancel'), true)
  const startupResult = await startupCalculation
  assert.equal(startupResult.error.code, 'CANCELLED')
  assert.match(startupResult.error.message, /cancelled/)
  await rejectedStartup
  assert.equal(startupChild.killed, true)
  startupChild.stdout.write('{"type":"ready","protocol":1}\n')
  assert.equal(startup.status().state, 'stopped')
  startup.dispose()

  // Cancellation between ready emission and the awaiting calculation continuation.
  let raceChild
  const race = new CalculatorManager({}, { spawnFn: () => (raceChild = fakeSpawn({ noReady: true, respond: true })) })
  const racedCalculation = race.calculate(request('ready-cancel'))
  raceChild.stdout.write('{"type":"ready","protocol":1}\n')
  assert.equal(race.cancel('ready-cancel'), true)
  assert.equal((await racedCalculation).error.code, 'CANCELLED')
  assert.equal(race.pending.size, 0)
  race.dispose()

  for (const readyBeforeDispose of [false, true]) {
    let shutdownChild, spawnCount = 0, writes = 0
    const shutdown = new CalculatorManager({}, { spawnFn: () => {
      spawnCount++
      shutdownChild = fakeSpawn({ noReady: true })
      shutdownChild.stdin.on('data', () => writes++)
      return shutdownChild
    } })
    const calculation = shutdown.calculate(request('shutdown'))
    const readiness = shutdown.ensureReady()
    const settledReadiness = readiness.catch(e => e)
    if (readyBeforeDispose) shutdownChild.stdout.write('{"type":"ready","protocol":1}\n')
    shutdown.dispose()
    shutdownChild.stdout.write('{"type":"ready","protocol":1}\n')
    assert.equal((await calculation).error.code, 'STOPPED')
    await settledReadiness
    assert.equal(shutdown.status().state, 'stopped')
    assert.equal(shutdownChild.killed, true)
    assert.equal(writes, 0, 'shutdown must not submit work after readiness resolves')
    await assert.rejects(shutdown.ensureReady(), /shutting down/)
    await assert.rejects(shutdown.restart(), /shutting down/)
    assert.equal((await shutdown.calculate(request('after-shutdown'))).error.code, 'UNAVAILABLE')
    assert.equal(spawnCount, 1, 'shutdown must not resurrect a worker')
  }

  // Bundle the actual UI input helpers in memory, so advertised templates cannot drift
  // from a copied fixture. No generated test files or renderer dependencies are needed.
  const inputSource = path.resolve(__dirname, '../src/lib/calculator-input.ts')
  const bundledInput = require('esbuild').buildSync({
    entryPoints: [inputSource], bundle: true, platform: 'node', format: 'cjs', write: false,
  })
  const inputModule = new (require('node:module'))(inputSource, module)
  inputModule._compile(bundledInput.outputFiles[0].text, inputSource)
  const { EXAMPLES, keyboardKeys, insertKey, MATRIX_OPERATIONS, matrixExpression, resizeMatrix } = inputModule.exports
  const advertised = []
  const addAdvertised = (label, mode, expression, conditions) => {
    advertised.push({ label, payload: { id: `ui-${advertised.length}`, mode, expression,
      ...(conditions?.length ? { conditions } : {}) } })
  }
  const matrixPowerKey = keyboardKeys('matrix').find(key => key.label === '^')
  assert.ok(matrixPowerKey, 'Matrix keyboard must retain its power key')
  assert.equal(matrixPowerKey.text, '**', 'Matrix power must insert supported Python syntax')
  for (const mode of ['calculus', 'ode']) {
    assert.equal(keyboardKeys(mode).find(key => key.label === '^')?.text, '^')
  }
  assert.equal(keyboardKeys('ode').some(key => key.label === 'Abs' || key.prefix === 'Abs('), false,
    'ODE keyboard must not advertise the unsupported Abs(x) default')
  for (const mode of ['calculus', 'matrix']) {
    assert.ok(keyboardKeys(mode).some(key => key.prefix === 'Abs('), `${mode} must retain supported Abs`)
  }
  // Exercise the actual inserted text in both a matrix literal and a generated cell.
  const insertedPower = insertKey('23', 1, 1, matrixPowerKey)
  assert.equal(insertedPower.value, '2**3')
  addAdvertised('inserted matrix power literal', 'matrix', `[[${insertedPower.value}]]`)
  addAdvertised('generated matrix power determinant', 'matrix',
    matrixExpression([[insertedPower.value, '0'], ['0', '1']], 'det'))

  for (const mode of ['calculus', 'matrix', 'ode']) {
    assert.ok(EXAMPLES[mode].length, `${mode} must have examples`)
    for (const example of EXAMPLES[mode]) {
      addAdvertised(`example ${mode}: ${example.label}`, mode, example.expression,
        (example.conditions || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean))
    }
    for (const key of keyboardKeys(mode)) {
      if (key.prefix !== undefined) {
        const edit = insertKey('', 0, 0, key)
        assert.equal(edit.accepted, true)
        assert.equal(edit.value, key.prefix + (key.placeholder || '') + (key.suffix || ''))
        const contextual = mode === 'matrix' ? `[[${edit.value}]]`
          : mode === 'ode' ? `y'=${edit.value}` : edit.value
        addAdvertised(`keyboard ${mode}: ${key.label} (${edit.value})`, mode, contextual)
        // Also exercise wrapping a selected mathematical expression, not just defaults.
        const selection = mode === 'ode' ? '2' : 'x+1'
        const selected = insertKey(selection, 0, selection.length, key)
        assert.equal(selected.accepted, true)
        addAdvertised(`selected keyboard ${mode}: ${key.label}`, mode,
          mode === 'matrix' ? `[[${selected.value}]]`
            : mode === 'ode' ? `y'=${selected.value}` : selected.value)
      } else {
        // Fragments such as '(' or '=' are not standalone calculations. Require a
        // valid context for every literal key; unknown newly advertised keys fail.
        const contexts = {
          '+': '1+2', '-': '1-2', '*': '2*3', '/': '1/2', '^': '2^3', '**': '2**3', '.': '1.5',
          '(': '(x+1)', ')': '(x+1)', ',': 'log(8,2)', '[': '[[1,2],[3,4]]', ']': '[[1,2],[3,4]]',
          '=': 'y\'+y=0', "y'": "y'+y=0", "y''": "y''+y=0", "y'''": "y'''+y=0",
          x: 'x', y: 'y', pi: 'pi', E: 'E', oo: 'oo',
        }
        const expression = /^\d$/.test(key.text || '') ? key.text : contexts[key.text]
        assert.ok(expression, `Unsupported/uncovered keyboard literal ${mode}: ${JSON.stringify(key)}`)
        assert.equal(insertKey('', 0, 0, key).value, key.text)
        addAdvertised(`literal keyboard ${mode}: ${key.label}`, mode,
          mode === 'matrix' && !['[', ']'].includes(key.text) ? `[[${expression}]]`
            : mode === 'ode' && !['=', "y'", "y''", "y'''"].includes(key.text) ? `y'+y=${expression}` : expression)
      }
    }
  }
  assert.deepEqual(MATRIX_OPERATIONS.map(([op]) => op),
    ['literal', 'det', 'inverse', 'transpose', 'rank', 'trace', 'rref', 'eigenval'])
  for (const [operation] of MATRIX_OPERATIONS) {
    addAdvertised(`matrix operation ${operation}`, 'matrix', matrixExpression([['1', '2'], ['3', '4']], operation))
  }
  for (let size = 1; size <= 8; size++) {
    const identity = resizeMatrix([], size, size, true)
    assert.deepEqual(identity, Array.from({ length: size }, (_, r) =>
      Array.from({ length: size }, (_, c) => r === c ? '1' : '0')))
    for (const [operation] of MATRIX_OPERATIONS) {
      addAdvertised(`identity ${size}x${size} ${operation}`, 'matrix', matrixExpression(identity, operation))
    }
  }
  const rectangularIdentity = resizeMatrix([], 2, 3, true)
  assert.deepEqual(rectangularIdentity, [['1', '0', '0'], ['0', '1', '0']])
  addAdvertised('rectangular identity literal', 'matrix', matrixExpression(rectangularIdentity, 'literal'))
  // Constants must evaluate as constants, rather than merely parse as free symbols.
  addAdvertised('constant semantics', 'calculus', 'sin(pi)+log(E)+Abs(-2)')
  addAdvertised('infinite integration bound', 'calculus', '∫(exp(-x),x,0,oo)')

  const real = new CalculatorManager(config)
  try {
    const invalidTemplates = []
    for (const { label, payload } of advertised) {
      const result = await real.calculate(payload)
      if (!result.ok) invalidTemplates.push(`${label}: ${payload.expression}: ${JSON.stringify(result.error)}`)
      else {
        assert.equal(typeof result.result.text, 'string', label)
        assert.ok(result.result.text.length, label)
        if (label === 'constant semantics') assert.match(result.result.text, /(?:^|\s|=)3(?:\s|$)/)
        if (label === 'infinite integration bound') assert.match(result.result.text, /(?:^|\s|=)1(?:\s|$)/)
        if (label.startsWith('identity ') && label.endsWith(' det')) assert.match(result.result.text, /(?:^|\s|=)1(?:\s|$)/)
      }
    }
    console.log(`Bundled UI coverage: ${advertised.length - invalidTemplates.length}/${advertised.length} cases passed; ${invalidTemplates.length} invalid advertised templates`)
    assert.deepEqual(invalidTemplates, [], `Invalid advertised UI templates:\n${invalidTemplates.join('\n')}`)
    console.log(`Bundled worker: ${advertised.length} actual UI examples, keyboard templates/literals, matrix operations and generated identities PASSED`)
    const result = await real.calculate({ id: 'real-worker', mode: 'matrix', expression: 'det([[1,2],[3,4]])' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(result.result.text, /-2/)
  } finally { real.dispose() }
  // A relocated packaged layout with spaces must work without a checkout or PATH Python.
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'calculator portable '))
  const resources = path.join(temporary, 'resources')
  let packaged
  try {
    fs.cpSync(config.root, path.join(resources, 'clever-calculator'), { recursive: true })
    packaged = new CalculatorManager(resolveConfig({ packaged: true, resourcesPath: resources, env: {} }))
    const result = await packaged.calculate({ id: 'portable', mode: 'calculus', expression: '∫(x^2,x,0,1)' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(result.result.text, /1\/3/)
  } finally {
    if (packaged) {
      const child = packaged.child
      const exited = child ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve()
      packaged.dispose()
      await exited
    }
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  const missing = new CalculatorManager({ python: path.join(temporary, 'missing-python.exe'), worker: config.worker })
  try {
    assert.equal((await missing.calculate(request('missing-runtime'))).error.code, 'UNAVAILABLE')
  } finally { missing.dispose() }
  console.log('Packaged relocation (path with spaces), missing-runtime failure PASSED')
  console.log('Calculator manager: readiness, IDs, validation, stderr isolation, busy bound, timeout, cancellation, crash recovery, restart, startup failure, malformed output, real-worker smoke PASSED')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
