'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')

const failure = (id, code, message) => ({ id, ok: false, error: { code, message } })
function resolveConfig({ packaged = false, resourcesPath = '', env = process.env } = {}) {
  const root = env.YANLAI_CALCULATOR_ROOT || (packaged
    ? path.join(resourcesPath, 'clever-calculator')
    : path.resolve(__dirname, '../../resources/clever-calculator'))
  const bundledPython = path.join(root, 'python', process.platform === 'win32' ? 'python.exe' : 'python')
  return {
    root,
    python: env.YANLAI_CALCULATOR_PYTHON || bundledPython,
    worker: env.YANLAI_CALCULATOR_WORKER || path.join(root, 'worker.py'),
  }
}
function validRequest(p) {
  return p && typeof p === 'object' && !Array.isArray(p)
    && Object.keys(p).every(k => ['id', 'mode', 'expression', 'conditions'].includes(k))
    && typeof p.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(p.id)
    && ['calculus', 'matrix', 'ode'].includes(p.mode)
    && typeof p.expression === 'string' && p.expression.trim() && p.expression.length <= 2048
    && (p.conditions === undefined || (Array.isArray(p.conditions) && p.conditions.length <= 8
      && p.conditions.every(c => typeof c === 'string' && c.length <= 2048)))
}
class CalculatorManager {
  // A freshly extracted portable runtime can take >10s during Windows antivirus scanning.
  constructor(config, { spawnFn = spawn, startupTimeout = 30000, requestTimeout = 14000 } = {}) {
    this.config = config
    this.spawnFn = spawnFn
    this.startupTimeout = startupTimeout
    this.requestTimeout = requestTimeout
    this.child = null
    this.starting = null
    this.pending = new Map()
    this.ready = false
    this.stderr = ''
    this.lastError = ''
    this.closed = false
    this.generation = 0
    this.stopError = null
  }
  status() {
    return { ready: this.ready, state: this.ready ? 'ready' : this.child ? 'starting' : 'stopped', error: this.lastError || undefined }
  }
  stop(code = 'STOPPED', message = 'Calculator stopped') {
    const child = this.child
    this.child = null
    this.ready = false
    this.lastError = message
    this.generation++
    this.stopError = Object.assign(new Error(message), { code })
    if (this.startReject) this.startReject(this.stopError)
    this.startReject = null
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve(failure(id, code, message))
    }
    this.pending.clear()
    if (child) child.kill()
  }
  async ensureReady() {
    if (this.closed) throw new Error('Calculator is shutting down')
    if (this.ready) return this.status()
    if (this.starting) return this.starting
    const start = new Promise((resolve, reject) => {
      let child
      try {
        child = this.spawnFn(this.config.python, ['-I', '-B', '-u', this.config.worker], {
          windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' },
        })
      } catch (e) { reject(e); return }
      this.child = child
      this.stderr = ''
      let buffer = ''
      const timer = setTimeout(() => this.stop('STARTUP_TIMEOUT', 'Python worker did not become ready'), this.startupTimeout)
      this.startReject = e => { clearTimeout(timer); reject(e) }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', text => { if (this.child === child) this.stderr = (this.stderr + text).slice(-4096) })
      child.stdout.on('data', text => {
        if (this.child !== child) return
        buffer += text
        if (Buffer.byteLength(buffer) > 131072) { this.stop('PROTOCOL_ERROR', 'Worker output exceeds limit'); return }
        let pos
        while ((pos = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1)
          let message
          try { message = JSON.parse(line) } catch { this.stop('PROTOCOL_ERROR', 'Invalid JSON from worker'); return }
          if (message?.type === 'ready' && message.protocol === 1 && !this.ready) {
            this.ready = true; this.lastError = ''; clearTimeout(timer); this.startReject = null
            resolve(this.status())
          } else if (message && typeof message.id === 'string' && typeof message.ok === 'boolean') {
            const p = this.pending.get(message.id)
            if (!p) continue
            if ((message.ok && typeof message.result?.text !== 'string')
              || (!message.ok && typeof message.error?.message !== 'string')) {
              this.stop('PROTOCOL_ERROR', 'Invalid worker response'); return
            }
            clearTimeout(p.timer); this.pending.delete(message.id); p.resolve(message)
          } else { this.stop('PROTOCOL_ERROR', 'Unexpected worker response'); return }
        }
      })
      const failed = message => { if (this.child === child) this.stop('WORKER_CRASH', message) }
      child.on('error', e => failed(`Unable to start Python: ${e.message}`))
      child.on('close', code => failed(`Python worker exited (${code}); check Python and SymPy configuration`))
      child.stdin.on('error', e => failed(`Worker input failed: ${e.message}`))
    })
    this.starting = start
    try { return await start } finally { if (this.starting === start) this.starting = null }
  }
  async calculate(payload) {
    if (!validRequest(payload)) return failure(payload?.id || null, 'INVALID_INPUT', 'Invalid calculator request')
    // One calculation at a time: prevents queued symbolic work from consuming unbounded CPU/memory.
    if (this.pending.size || this.busy) return failure(payload.id, 'BUSY', 'Calculator is busy')
    this.busy = true
    this.activeId = payload.id
    const generation = this.generation
    try {
      await this.ensureReady()
      // Readiness may resolve just before cancellation/shutdown, before this continuation runs.
      if (this.generation !== generation) throw this.stopError
      if (this.closed || !this.child || !this.ready) throw new Error('Calculator is not ready')
      return await new Promise(resolve => {
        const timer = setTimeout(() => this.stop('TIMEOUT', 'Calculation timed out; retry to start a fresh worker'), this.requestTimeout)
        this.pending.set(payload.id, { resolve, timer })
        this.child.stdin.write(JSON.stringify(payload) + '\n', e => {
          if (e) this.stop('WORKER_CRASH', e.message)
        })
      })
    } catch (e) {
      const code = ['CANCELLED', 'STOPPED', 'RESTARTED'].includes(e.code) ? e.code : 'UNAVAILABLE'
      return failure(payload.id, code, e.message)
    }
    finally { this.busy = false; this.activeId = null }
  }
  cancel(id) {
    if (this.activeId !== id && !this.pending.has(id)) return false
    this.stop('CANCELLED', 'Calculation cancelled')
    return true
  }
  async restart() {
    this.stop('RESTARTED', 'Calculator restarted')
    // let a rejected startup settle before creating a replacement
    if (this.starting) await this.starting.catch(() => {})
    return this.ensureReady()
  }
  dispose() { this.closed = true; this.stop() }
}
module.exports = { CalculatorManager, resolveConfig, validRequest, failure }
