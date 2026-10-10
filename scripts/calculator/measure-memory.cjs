'use strict'
// Measures only the bundled worker launched here, never enumerates or stops other processes.
const { execFile, spawnSync } = require('node:child_process')
const { promisify } = require('node:util')
const { performance } = require('node:perf_hooks')
const os = require('node:os')
const { CalculatorManager, resolveConfig } = require('../../electron/lib/calculator.cjs')
const exec = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  if (process.platform !== 'win32') throw new Error('This measurement requires Windows PowerShell process counters')
  const config = resolveConfig({ env: {} }) // Deliberately ignore runtime override environment variables.
  const runtime = spawnSync(config.python, ['-I', '-B', '-c',
    'import sys,sympy,mpmath,json; print(json.dumps(dict(python=sys.version.split()[0],sympy=sympy.__version__,mpmath=mpmath.__version__)))'],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (runtime.error || runtime.status !== 0) throw new Error(`Bundled runtime check failed: ${runtime.error || runtime.stderr}`)
  const manager = new CalculatorManager(config)
  let ownedChild
  const cleanup = async () => {
    const child = ownedChild || manager.child
    const exited = child && child.exitCode === null && child.signalCode === null
      ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve()
    manager.dispose()
    await exited
  }
  const interrupted = () => { cleanup().then(() => process.exit(130), () => process.exit(1)) }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  try {
    const start = performance.now()
    const readiness = manager.ensureReady()
    ownedChild = manager.child
    await readiness
    const readinessMs = performance.now() - start
    const pid = ownedChild.pid
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Worker has no valid PID')
    const samples = []
    async function sample(stage) {
      if (manager.child !== ownedChild || !manager.ready || ownedChild.exitCode !== null || ownedChild.signalCode !== null) {
        throw new Error('Owned worker changed or exited')
      }
      const command = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid}; $p.Refresh(); [pscustomobject]@{pid=$p.Id; workingSetBytes=$p.WorkingSet64; privateBytes=$p.PrivateMemorySize64; osVersion=[Environment]::OSVersion.Version.ToString(); powershell=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json -Compress`
      const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, timeout: 15000, maxBuffer: 16384 })
      const counters = JSON.parse(stdout.trim())
      if (counters.pid !== pid) throw new Error('Unexpected process PID')
      samples.push({ stage, ...counters,
        workingSetMiB: counters.workingSetBytes / 1048576,
        privateMiB: counters.privateBytes / 1048576 })
    }
    await sample('ready')
    const workloads = [
      { mode: 'calculus', expression: '∫(x^2,x,0,1)' },
      { mode: 'matrix', expression: 'inverse([[1,2],[3,4]])' },
      { mode: 'ode', expression: "y'+y=0", conditions: ['y(0)=1'] },
    ]
    const calls = []
    for (const workload of workloads) {
      for (let iteration = 1; iteration <= 5; iteration++) {
        const started = performance.now()
        const result = await manager.calculate({ id: `measure-${workload.mode}-${iteration}`, ...workload })
        const elapsedMs = performance.now() - started
        if (!result.ok) throw new Error(`${workload.mode}: ${JSON.stringify(result.error)}`)
        calls.push({ ...workload, iteration, elapsedMs })
        if (iteration === 1) await sample(`after-${workload.mode}-first`)
      }
      await sample(`after-${workload.mode}-repeated`)
    }
    await sleep(5000)
    await sample('idle-5s')
    await sleep(10000)
    await sample('idle-15s')
    console.log(JSON.stringify({
      measuredAt: new Date().toISOString(),
      environment: { platform: process.platform, architecture: process.arch, osRelease: os.release(),
        cpuModel: os.cpus()[0]?.model, logicalCPUs: os.cpus().length, totalMemoryMiB: os.totalmem() / 1048576,
        node: process.version, ...JSON.parse(runtime.stdout) },
      runtime: 'resources/clever-calculator/python/python.exe',
      worker: 'resources/clever-calculator/worker.py',
      readinessMs, calls, samples,
      notes: 'One fresh bundled worker; five sequential calls per mode; same PID throughout; MiB = bytes / 1048576. PowerShell sampling overhead excluded from call timings. Cleanup kills only the worker owned by this manager.',
    }, null, 2))
  } finally {
    await cleanup()
    process.removeListener('SIGINT', interrupted)
    process.removeListener('SIGTERM', interrupted)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
