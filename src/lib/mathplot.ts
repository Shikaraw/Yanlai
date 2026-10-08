/**
 * Math expression evaluation + SVG plotting.
 *
 * Two deliberate choices:
 *  1. No `eval` / `new Function`. Student-supplied and model-supplied
 *     expressions are parsed by a hand-written recursive-descent parser, so a
 *     malformed or hostile string can throw but can never execute code.
 *  2. Output is plain SVG rather than a canvas bitmap: it scales crisply, is
 *     tiny, embeds into DOCX/PDF exports, and can be shown inline in a message.
 */

/* ------------------------------------------------------------------ */
/* tokenizer + parser                                                  */
/* ------------------------------------------------------------------ */
type Tok = { t: 'num' | 'id' | 'op' | 'lp' | 'rp' | 'comma'; v: string }

const CONSTS: Record<string, number> = {
  pi: Math.PI,
  PI: Math.PI,
  π: Math.PI,
  e: Math.E,
  E: Math.E,
  tau: Math.PI * 2,
  inf: Infinity,
  Infinity: Infinity,
  phi: (1 + Math.sqrt(5)) / 2,
}

const FNS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
  sec: (x) => 1 / Math.cos(x),
  csc: (x) => 1 / Math.sin(x),
  cot: (x) => 1 / Math.tan(x),
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  sign: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  trunc: Math.trunc,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  mod: (a, b) => a % b,
  hypot: Math.hypot,
  gamma: (x) => tgamma(x),
  factorial: (x) => tgamma(x + 1),
  erfc: (x) => 1 - erf(x),
}

/** Lanczos approximation — enough for study-level statistics plots. */
function tgamma(z: number): number {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * tgamma(1 - z))
  z -= 1
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  let x = g[0]
  for (let i = 1; i < 9; i++) x += g[i] / (z + i)
  const t = z + 7.5
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x
}

function erf(x: number): number {
  const s = Math.sign(x)
  x = Math.abs(x)
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const t = 1 / (1 + p * x)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return s * y
}

function tokenize(src: string): Tok[] {
  const s = String(src || '')
    // structural LaTeX commands first: they carry semantics we must preserve
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))')
    .replace(/\\dfrac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))')
    .replace(/\\tfrac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))')
    .replace(/\\sqrt\s*\[3\]\s*\{([^{}]*)\}/g, 'cbrt($1)')
    .replace(/\\sqrt\s*\[n\]\s*\{([^{}]*)\}/g, 'pow($1,1/n)')
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt($1)')
    .replace(/\\left|\\right|\\,|\\!|\\;|\\quad|\\qquad/g, ' ')
    .replace(/\\cdot|\\times/g, '*')
    .replace(/\\div/g, '/')
    .replace(/\\pi/g, 'pi')
    .replace(/\\operatorname\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, (m) => m.slice(1))
    // exponent / subscript groups, then any remaining braces become parens so
    // `sqrt{9}`, `x^{2}`, `2{3}` style input all tokenise
    .replace(/\^\s*\{([^{}]*)\}/g, '^($1)')
    .replace(/_\s*\{([^{}]*)\}/g, '_$1')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
  const out: Tok[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/[0-9.]/.test(c)) {
      let j = i
      while (j < s.length && /[0-9.eE]/.test(s[j])) {
        // allow exponent sign: 1e-3
        if ((s[j] === 'e' || s[j] === 'E') && /[+-]/.test(s[j + 1] || '') && /[0-9]/.test(s[j + 2] || '')) j++
        j++
      }
      out.push({ t: 'num', v: s.slice(i, j) })
      i = j
      continue
    }
    if (/[a-zA-Zπ_]/.test(c)) {
      let j = i
      while (j < s.length && /[a-zA-Z0-9_π]/.test(s[j])) j++
      out.push({ t: 'id', v: s.slice(i, j) })
      i = j
      continue
    }
    if (c === '(' || c === '[') {
      out.push({ t: 'lp', v: c })
      i++
      continue
    }
    if (c === ')' || c === ']') {
      out.push({ t: 'rp', v: c })
      i++
      continue
    }
    if (c === ',') {
      out.push({ t: 'comma', v: c })
      i++
      continue
    }
    if ('+-*/^%'.includes(c)) {
      // handle ** as pow
      if (c === '*' && s[i + 1] === '*') {
        out.push({ t: 'op', v: '^' })
        i += 2
        continue
      }
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    if (c === '<' || c === '>') {
      // comparisons used by piecewise-ish expressions
      const two = s.slice(i, i + 2)
      if (two === '<=' || two === '>=') {
        out.push({ t: 'op', v: two })
        i += 2
        continue
      }
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    if (c === '=' ) {
      out.push({ t: 'op', v: '=' })
      i++
      continue
    }
    throw new Error(`无法识别的字符 "${c}"`)
  }
  return out
}

/**
 * Recursive descent parser producing a closure tree.
 * Grammar (loosest to tightest):
 *   cmp := sum (('<'|'>'|'<='|'>='|'=') sum)*
 *   sum := term (('+'|'-') term)*
 *   term := unary (('*'|'/'|'%') unary)*
 *   unary := ('-'|'+') unary | power
 *   power := atom ('^' unary)?          // right-assoc
 *   atom := num | const | var | fn '(' args ')' | '(' cmp ')'
 */
export interface EvalContext {
  vars: Record<string, number>
}

export function compileExpr(src: string, varNames: string[] = ['x']): (vars: Record<string, number>) => number {
  const toks = tokenize(src)
  let pos = 0
  const peek = () => toks[pos]
  const next = () => toks[pos++]
  const expect = (t: Tok['t']) => {
    const tk = next()
    if (!tk || tk.t !== t) throw new Error(`语法错误：期望 ${t}，实际 ${tk ? tk.v : '结束'}`)
    return tk
  }

  function parseCmp(): (v: Record<string, number>) => number {
    let left = parseSum()
    while (peek() && peek().t === 'op' && ['<', '>', '<=', '>=', '='].includes(peek().v)) {
      const op = next().v
      const right = parseSum()
      const l = left, r = right
      left = (v) => {
        const a = l(v), b = r(v)
        const res =
          op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : Math.abs(a - b) < 1e-12
        return res ? 1 : 0
      }
    }
    return left
  }

  function parseSum(): (v: Record<string, number>) => number {
    let left = parseTerm()
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = next().v
      const right = parseTerm()
      const l = left, r = right
      left = op === '+' ? (v) => l(v) + r(v) : (v) => l(v) - r(v)
    }
    return left
  }

  function parseTerm(): (v: Record<string, number>) => number {
    let left = parseUnary()
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/' || peek().v === '%')) {
      const op = next().v
      const right = parseUnary()
      const l = left, r = right
      left =
        op === '*' ? (v) => l(v) * r(v) : op === '/' ? (v) => l(v) / r(v) : (v) => l(v) % r(v)
    }
    return left
  }

  function parseUnary(): (v: Record<string, number>) => number {
    const tk = peek()
    if (tk && tk.t === 'op' && (tk.v === '-' || tk.v === '+')) {
      next()
      const inner = parseUnary()
      return tk.v === '-' ? (v) => -inner(v) : inner
    }
    return parsePower()
  }

  function parsePower(): (v: Record<string, number>) => number {
    const base = parseAtom()
    if (peek() && peek().t === 'op' && peek().v === '^') {
      next()
      const exp = parseUnary() // right associative
      return (v) => Math.pow(base(v), exp(v))
    }
    return base
  }

  function parseAtom(): (v: Record<string, number>) => number {
    const tk = next()
    if (!tk) throw new Error('表达式意外结束')
    if (tk.t === 'num') {
      const n = Number(tk.v)
      if (!Number.isFinite(n) && !/e/i.test(tk.v)) throw new Error(`无效数字 "${tk.v}"`)
      return () => n
    }
    if (tk.t === 'lp') {
      const inner = parseCmp()
      expect('rp')
      return inner
    }
    if (tk.t === 'id') {
      const name = tk.v
      if (peek() && peek().t === 'lp') {
        next()
        const args: Array<(v: Record<string, number>) => number> = []
        if (peek() && peek().t !== 'rp') {
          args.push(parseCmp())
          while (peek() && peek().t === 'comma') {
            next()
            args.push(parseCmp())
          }
        }
        expect('rp')
        const fn = FNS[name]
        if (!fn) throw new Error(`未知函数 "${name}"，可用函数见帮助`)
        return (v) => fn(...args.map((a) => a(v)))
      }
      if (name in CONSTS) {
        const c = CONSTS[name]
        return () => c
      }
      if (varNames.includes(name) || name.length <= 2 || /^[a-zA-Z]\d*$/.test(name)) {
        const key = name === 'π' ? 'pi' : name
        return (v) => {
          const val = v[key]
          if (val === undefined) return NaN
          return val
        }
      }
      throw new Error(`未知变量 "${name}"`)
    }
    throw new Error(`语法错误：意外的 "${tk.v}"`)
  }

  const ast = parseCmp()
  if (pos < toks.length) throw new Error(`表达式末尾有多余内容 "${toks[pos].v}"`)
  return ast
}

/** Convenience: single-variable evaluation. */
export function makeFn(src: string, varName = 'x') {
  const c = compileExpr(src, [varName])
  return (x: number) => c({ [varName]: x })
}

/* ------------------------------------------------------------------ */
/* plotting                                                            */
/* ------------------------------------------------------------------ */
export type CurveKind = 'explicit' | 'parametric' | 'polar'

export interface Curve {
  kind?: CurveKind
  expr: string
  /** for parametric */
  yExpr?: string
  /** polar angle range, or parametric param range */
  paramRange?: [number, number]
  label?: string
  color?: string
  dash?: boolean
  width?: number
  /** exclude y outside this range (e.g. asymptotes) */
  clampY?: boolean
}

export interface PlotOptions {
  curves: Curve[]
  xRange?: [number, number]
  yRange?: [number, number]
  width?: number
  height?: number
  theme?: 'dark' | 'light'
  title?: string
  xLabel?: string
  yLabel?: string
  grid?: boolean
  points?: Array<{ x: number; y: number; label?: string; color?: string }>
  segments?: Array<{ x1: number; y1: number; x2: number; y2: number; color?: string; label?: string }>
  /** shade area between two curves */
  area?: { expr1: string; expr2?: string; from: number; to: number; color?: string }
  showLegend?: boolean
}

const PALETTE = ['#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb7185', '#38bdf8', '#34d399']
export const CURVE_COLORS = PALETTE

/** "Nice" axis step: 1, 2, 5 × 10^k. */
function niceStep(span: number, targetTicks = 8) {
  const raw = span / Math.max(1, targetTicks)
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)))
  const norm = raw / mag
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * mag
}

function fmtTick(v: number, step: number) {
  if (Math.abs(v) < 1e-12) return '0'
  const dec = Math.max(0, Math.min(6, -Math.floor(Math.log10(Math.abs(step))) + (step < 1 ? 0 : 0)))
  const abs = Math.abs(v)
  if (abs >= 1e5 || abs < 1e-4) return v.toExponential(1)
  return Number(v.toFixed(dec)).toString()
}

function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** Decide whether a jump between samples is a real branch or an asymptote. */
function isDiscontinuity(y0: number, y1: number, yRange: number) {
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return true
  return Math.abs(y1 - y0) > yRange * 1.6
}

export function plotSvg(opts: PlotOptions): { svg: string; bounds: any } {
  const W = opts.width || 760
  const H = opts.height || 460
  const pad = { l: 58, r: 22, t: opts.title ? 46 : 24, b: 46 }
  const theme = opts.theme || 'dark'
  const dark = theme === 'dark'
  const ink = dark ? '#e6edf7' : '#0f172a'
  const muted = dark ? '#7c8aa5' : '#64748b'
  const gridCol = dark ? 'rgba(124,138,165,0.18)' : 'rgba(100,116,139,0.18)'
  const axisCol = dark ? 'rgba(190,205,230,0.55)' : 'rgba(51,65,85,0.6)'
  const bg = dark ? 'transparent' : 'transparent'

  const curves = opts.curves || []
  const N = 1400

  /* --- sample every curve first so we can auto-fit y --- */
  interface Sampled {
    pts: Array<[number, number]>
    breaks: number[]
    color: string
    label: string
    width: number
    dash?: boolean
  }
  let xRange = opts.xRange || [-10, 10]

  const sampled: Sampled[] = []
  const allY: number[] = []

  curves.forEach((c, ci) => {
    const kind = c.kind || 'explicit'
    const color = c.color || PALETTE[ci % PALETTE.length]
    const pts: Array<[number, number]> = []
    const breaks: number[] = []
    const label = c.label || (kind === 'parametric' ? `(${c.expr}, ${c.yExpr})` : c.expr)
    try {
      if (kind === 'explicit') {
        const f = makeFn(c.expr, 'x')
        const [a, b] = xRange
        for (let i = 0; i <= N; i++) {
          const x = a + ((b - a) * i) / N
          let y: number
          try {
            y = f(x)
          } catch {
            y = NaN
          }
          if (!Number.isFinite(y)) {
            if (pts.length) breaks.push(pts.length)
            continue
          }
          if (c.clampY && opts.yRange && (y < opts.yRange[0] - 1 || y > opts.yRange[1] + 1)) {
            if (pts.length) breaks.push(pts.length)
            continue
          }
          pts.push([x, y])
          allY.push(y)
        }
      } else if (kind === 'polar') {
        const f = makeFn(c.expr, 't')
        const [t0, t1] = c.paramRange || [0, Math.PI * 2]
        for (let i = 0; i <= N; i++) {
          const t = t0 + ((t1 - t0) * i) / N
          const r = f(t)
          if (!Number.isFinite(r)) {
            if (pts.length) breaks.push(pts.length)
            continue
          }
          const x = r * Math.cos(t)
          const y = r * Math.sin(t)
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue
          pts.push([x, y])
          allY.push(y)
        }
      } else {
        const fx = makeFn(c.expr, 't')
        const fy = makeFn(c.yExpr || 't', 't')
        const [t0, t1] = c.paramRange || [0, Math.PI * 2]
        for (let i = 0; i <= N; i++) {
          const t = t0 + ((t1 - t0) * i) / N
          const x = fx(t)
          const y = fy(t)
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            if (pts.length) breaks.push(pts.length)
            continue
          }
          pts.push([x, y])
          allY.push(y)
        }
      }
    } catch (e) {
      // keep other curves alive; surface the failure in the legend
      sampled.push({ pts: [], breaks: [], color, label: `${label}（解析失败: ${(e as Error).message}）`, width: c.width || 2.2 })
      return
    }
    sampled.push({ pts, breaks, color, label, width: c.width || 2.2, dash: c.dash })
  })

  // expand x-range for non-explicit curves
  const anyNonExplicit = curves.some((c) => (c.kind || 'explicit') !== 'explicit')
  if (anyNonExplicit && !opts.xRange) {
    const xs = sampled.flatMap((s) => s.pts.map((p) => p[0]))
    if (xs.length) {
      const mn = Math.min(...xs), mx = Math.max(...xs)
      const padX = (mx - mn) * 0.08 || 1
      xRange = [mn - padX, mx + padX]
    }
  }

  /* --- y range --- */
  let [y0, y1] = opts.yRange || [NaN, NaN]
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) {
    const finite = allY.filter((v) => Number.isFinite(v))
    if (finite.length) {
      finite.sort((a, b) => a - b)
      const q = (p: number) => finite[Math.floor((finite.length - 1) * p)]
      let lo = q(0.005)
      let hi = q(0.995)
      if (hi - lo < 1e-9) {
        lo -= 1
        hi += 1
      }
      const padY = (hi - lo) * 0.12
      y0 = lo - padY
      y1 = hi + padY
    } else {
      y0 = -10
      y1 = 10
    }
    // align to the same "nice" origin feel as x
    if (y0 < 0 && y1 > 0) {
      const m = Math.max(Math.abs(y0), Math.abs(y1))
      y0 = -m
      y1 = m
    }
  }
  if (opts.points?.length) {
    for (const p of opts.points) {
      y0 = Math.min(y0, p.y)
      y1 = Math.max(y1, p.y)
    }
  }

  const [x0, x1] = xRange
  const plotW = W - pad.l - pad.r
  const plotH = H - pad.t - pad.b
  const sx = (x: number) => pad.l + ((x - x0) / (x1 - x0 || 1)) * plotW
  const sy = (y: number) => pad.t + plotH - ((y - y0) / (y1 - y0 || 1)) * plotH

  const xStep = niceStep(x1 - x0, 9)
  const yStep = niceStep(y1 - y0, 7)

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-sans-serif,-apple-system,Segoe UI,Roboto,'Helvetica Neue','Microsoft YaHei',sans-serif"><rect x="0" y="0" width="${W}" height="${H}" fill="${bg}"/>`,
  )
  parts.push(
    `<defs><clipPath id="yc-plot-clip"><rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}"/></clipPath></defs>`,
  )
  if (opts.title) {
    parts.push(`<text x="${W / 2}" y="26" text-anchor="middle" font-size="15" font-weight="600" fill="${ink}">${esc(opts.title)}</text>`)
  }

  // grid
  if (opts.grid !== false) {
    for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1 + 1e-9; v += xStep) {
      const X = sx(v)
      parts.push(`<line x1="${X.toFixed(2)}" y1="${pad.t}" x2="${X.toFixed(2)}" y2="${pad.t + plotH}" stroke="${gridCol}" stroke-width="1"/>`)
    }
    for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1 + 1e-9; v += yStep) {
      const Y = sy(v)
      parts.push(`<line x1="${pad.l}" y1="${Y.toFixed(2)}" x2="${pad.l + plotW}" y2="${Y.toFixed(2)}" stroke="${gridCol}" stroke-width="1"/>`)
    }
  }

  // axes (only if they fall inside the view)
  const ax = Math.min(Math.max(sy(0), pad.t), pad.t + plotH)
  const ay = Math.min(Math.max(sx(0), pad.l), pad.l + plotW)
  if (y0 <= 0 && y1 >= 0) {
    parts.push(`<line x1="${pad.l}" y1="${ax.toFixed(2)}" x2="${pad.l + plotW}" y2="${ax.toFixed(2)}" stroke="${axisCol}" stroke-width="1.4"/>`)
  }
  if (x0 <= 0 && x1 >= 0) {
    parts.push(`<line x1="${ay.toFixed(2)}" y1="${pad.t}" x2="${ay.toFixed(2)}" y2="${pad.t + plotH}" stroke="${axisCol}" stroke-width="1.4"/>`)
  }

  // ticks + labels
  for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1 + 1e-9; v += xStep) {
    const X = sx(v)
    if (X < pad.l - 1 || X > pad.l + plotW + 1) continue
    parts.push(`<line x1="${X.toFixed(2)}" y1="${ax - 4}" x2="${X.toFixed(2)}" y2="${ax + 4}" stroke="${axisCol}" stroke-width="1.2"/>`)
    parts.push(`<text x="${X.toFixed(2)}" y="${(pad.t + plotH + 18).toFixed(2)}" text-anchor="middle" font-size="11" fill="${muted}">${esc(fmtTick(v, xStep))}</text>`)
  }
  for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1 + 1e-9; v += yStep) {
    const Y = sy(v)
    if (Y < pad.t - 1 || Y > pad.t + plotH + 1) continue
    parts.push(`<line x1="${ay - 4}" y1="${Y.toFixed(2)}" x2="${ay + 4}" y2="${Y.toFixed(2)}" stroke="${axisCol}" stroke-width="1.2"/>`)
    parts.push(`<text x="${(pad.l - 8).toFixed(2)}" y="${(Y + 4).toFixed(2)}" text-anchor="end" font-size="11" fill="${muted}">${esc(fmtTick(v, yStep))}</text>`)
  }

  // axis names
  parts.push(`<text x="${(pad.l + plotW).toFixed(2)}" y="${(ax - 8).toFixed(2)}" text-anchor="end" font-size="12" font-style="italic" fill="${ink}">${esc(opts.xLabel || 'x')}</text>`)
  parts.push(`<text x="${(ay + 8).toFixed(2)}" y="${(pad.t + 12).toFixed(2)}" font-size="12" font-style="italic" fill="${ink}">${esc(opts.yLabel || 'y')}</text>`)

  // shaded area between curves
  if (opts.area) {
    try {
      const f1 = makeFn(opts.area.expr1, 'x')
      const f2 = opts.area.expr2 ? makeFn(opts.area.expr2, 'x') : null
      const a = opts.area.from
      const b = opts.area.to
      const M = 400
      const top: string[] = []
      const bottom: string[] = []
      for (let i = 0; i <= M; i++) {
        const x = a + ((b - a) * i) / M
        const v1 = f1(x)
        const v2 = f2 ? f2(x) : Math.max(Math.min(0, y0), 0)
        if (!Number.isFinite(v1) || !Number.isFinite(v2)) continue
        top.push(`${sx(x).toFixed(2)},${sy(v1).toFixed(2)}`)
        bottom.push(`${sx(x).toFixed(2)},${sy(v2).toFixed(2)}`)
      }
      if (top.length > 1) {
        const poly = [...top, ...bottom.reverse()].join(' ')
        parts.push(
          `<polygon points="${poly}" fill="${opts.area.color || 'rgba(34,211,238,0.22)'}" stroke="none" clip-path="url(#yc-plot-clip)"/>`,
        )
      }
    } catch {}
  }

  // curves
  parts.push('<g clip-path="url(#yc-plot-clip)">')
  for (const s of sampled) {
    if (!s.pts.length) continue
    const ySpan = y1 - y0
    const chunks: string[][] = [[]]
    let prev: [number, number] | null = null
    for (const p of s.pts) {
      if (prev && isDiscontinuity(prev[1], p[1], ySpan)) {
        chunks.push([])
      }
      chunks[chunks.length - 1].push(`${sx(p[0]).toFixed(2)},${sy(p[1]).toFixed(2)}`)
      prev = p
    }
    for (const ch of chunks) {
      if (ch.length < 2) {
        if (ch.length === 1) {
          const [px, py] = ch[0].split(',')
          parts.push(`<circle cx="${px}" cy="${py}" r="${(s.width || 2.2) / 1.6}" fill="${s.color}"/>`)
        }
        continue
      }
      parts.push(
        `<polyline points="${ch.join(' ')}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2.2}" stroke-linecap="round" stroke-linejoin="round"${s.dash ? ' stroke-dasharray="7 5"' : ''}/>`,
      )
    }
  }

  // segments
  for (const g of opts.segments || []) {
    parts.push(
      `<line x1="${sx(g.x1).toFixed(2)}" y1="${sy(g.y1).toFixed(2)}" x2="${sx(g.x2).toFixed(2)}" y2="${sy(g.y2).toFixed(2)}" stroke="${g.color || '#f472b6'}" stroke-width="1.8" stroke-dasharray="5 4"/>`,
    )
  }

  // points
  for (const p of opts.points || []) {
    const X = sx(p.x)
    const Y = sy(p.y)
    parts.push(`<circle cx="${X.toFixed(2)}" cy="${Y.toFixed(2)}" r="4.2" fill="${p.color || '#fb7185'}" stroke="${dark ? '#0a0e17' : '#fff'}" stroke-width="1.6"/>`)
    if (p.label) {
      parts.push(
        `<text x="${(X + 9).toFixed(2)}" y="${(Y - 8).toFixed(2)}" font-size="11.5" fill="${ink}" stroke="${dark ? '#0a0e17' : '#ffffff'}" stroke-width="3" paint-order="stroke">${esc(p.label)}</text>`,
      )
    }
  }
  parts.push('</g>')

  // legend
  const showLegend = opts.showLegend !== false && sampled.filter((s) => s.label).length > 0
  if (showLegend) {
    const items = sampled.map((s) => ({ label: s.label, color: s.color, dash: s.dash })).slice(0, 8)
    const lh = 17
    const lw = Math.min(260, Math.max(...items.map((i) => String(i.label).length * 7.2 + 26), 90))
    const lx = pad.l + plotW - lw - 8
    const ly = pad.t + 8
    parts.push(`<g opacity="0.97"><rect x="${lx.toFixed(1)}" y="${ly}" width="${lw.toFixed(1)}" height="${items.length * lh + 10}" rx="7" fill="${dark ? 'rgba(16,22,36,0.82)' : 'rgba(255,255,255,0.88)'}" stroke="${gridCol}"/></g>`)
    items.forEach((it, i) => {
      const yy = ly + 12 + i * lh
      parts.push(`<line x1="${(lx + 9).toFixed(1)}" y1="${yy + 4}" x2="${(lx + 30).toFixed(1)}" y2="${yy + 4}" stroke="${it.color}" stroke-width="2.4"${it.dash ? ' stroke-dasharray="5 4"' : ''}/>`)
      parts.push(
        `<text x="${(lx + 36).toFixed(1)}" y="${yy + 8}" font-size="11.5" fill="${ink}">${esc(String(it.label).slice(0, 34))}</text>`,
      )
    })
  }

  parts.push('</svg>')
  return {
    svg: parts.join(''),
    bounds: { xRange, yRange: [y0, y1], width: W, height: H },
  }
}

/* ------------------------------------------------------------------ */
/* numeric helpers exposed as tools                                    */
/* ------------------------------------------------------------------ */
export function numericDerivative(f: (x: number) => number, x: number, h = 1e-6) {
  return (f(x + h) - f(x - h)) / (2 * h)
}

/** Simpson's rule; returns NaN if the function is not finite along the path. */
export function integrate(f: (x: number) => number, a: number, b: number, n = 2000) {
  if (n % 2 === 1) n++
  const h = (b - a) / n
  let sum = f(a) + f(b)
  for (let i = 1; i < n; i++) {
    const v = f(a + i * h)
    if (!Number.isFinite(v)) return NaN
    sum += v * (i % 2 === 0 ? 2 : 4)
  }
  return (sum * h) / 3
}

/** Bisection root finding over a scan of the interval. */
export function findRoots(f: (x: number) => number, a: number, b: number, samples = 800) {
  const roots: number[] = []
  let prevX = a
  let prevY = f(a)
  for (let i = 1; i <= samples; i++) {
    const x = a + ((b - a) * i) / samples
    const y = f(x)
    if (Number.isFinite(prevY) && Number.isFinite(y) && prevY !== 0 && Math.sign(prevY) !== Math.sign(y)) {
      let lo = prevX, hi = x, flo = prevY
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2
        const fm = f(mid)
        if (fm === 0) break
        if (Math.sign(fm) === Math.sign(flo)) {
          lo = mid
          flo = fm
        } else hi = mid
      }
      const r = (lo + hi) / 2
      if (!roots.some((v) => Math.abs(v - r) < 1e-7)) roots.push(Number(r.toFixed(10)))
    }
    prevX = x
    prevY = y
  }
  return roots
}

/** Golden-section search for an extremum on [a,b]. */
export function findExtremum(f: (x: number) => number, a: number, b: number, mode: 'min' | 'max' = 'min') {
  const g = (x: number) => f(x)
  const sign = mode === 'min' ? 1 : -1
  let lo = a, hi = b
  const gr = (Math.sqrt(5) - 1) / 2
  let c = hi - gr * (hi - lo)
  let d = lo + gr * (hi - lo)
  let fc = sign * g(c)
  let fd = sign * g(d)
  for (let i = 0; i < 200; i++) {
    if (fc < fd) {
      hi = d
      d = c
      fd = fc
      c = hi - gr * (hi - lo)
      fc = sign * g(c)
    } else {
      lo = c
      c = d
      fc = fd
      d = lo + gr * (hi - lo)
      fd = sign * g(d)
    }
  }
  const x = (lo + hi) / 2
  return { x, y: g(x) }
}
