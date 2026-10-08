/**
 * Headless checks for the pieces that are hard to eyeball in the GUI:
 * the expression parser, numeric solver, and SVG plotter.
 *
 *   node .tmp-test/check.mjs
 */
import { makeFn, compileExpr, plotSvg, integrate, findRoots, findExtremum, numericDerivative } from './mathplot.mjs'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}
function near(a, b, tol = 1e-6) {
  return Number.isFinite(a) && Math.abs(a - b) < tol
}

console.log('\n== expression parser ==')
{
  const f = makeFn('x^2 - 2*x + 1')
  ok('x^2-2x+1 at x=3 → 4', near(f(3), 4), `got ${f(3)}`)
  ok('x^2-2x+1 at x=0 → 1', near(f(0), 1))

  const g = makeFn('sin(x)/x')
  ok('sin(x)/x at x=1 ≈ 0.8414709848', near(g(1), 0.8414709848078965, 1e-9))
  ok('sin(x)/x near 0 → 1 (removable)', near(g(1e-9), 1, 1e-6))

  ok('pi constant', near(makeFn('pi')(0), Math.PI, 1e-12))
  ok('e constant', near(makeFn('e')(0), Math.E, 1e-12))
  ok('sqrt(16)=4', near(makeFn('sqrt(16)')(0), 4))
  ok('log10(1000)=3', near(makeFn('log(1000)')(0), 3))
  ok('ln(e)=1', near(makeFn('ln(e)')(0), 1))
  ok('abs(-5)=5', near(makeFn('abs(-5)')(0), 5))
  ok('2*3+4=10 (precedence)', near(makeFn('2*3+4')(0), 10))
  ok('2+3*4=14 (precedence)', near(makeFn('2+3*4')(0), 14))
  ok('(2+3)*4=20', near(makeFn('(2+3)*4')(0), 20))
  ok('2^3^2=512 (right assoc)', near(makeFn('2^3^2')(0), 512))
  ok('-2^2=-4 (unary binds looser than ^)', near(makeFn('-2^2')(0), -4), `got ${makeFn('-2^2')(0)}`)
  ok('x^{-2} = 1/x^2', near(makeFn('x^{-2}')(2), 0.25))
  ok('2**3=8 (** as pow)', near(makeFn('2**3')(0), 8))
  ok('max(3,7)=7', near(makeFn('max(3,7)')(0), 7))
  ok('hypot(3,4)=5', near(makeFn('hypot(3,4)')(0), 5))
  ok('\\frac not required (LaTeX-ish \\sqrt{9})', near(makeFn('\\sqrt{9}')(0), 3))
  ok('\\pi parsed', near(makeFn('\\pi')(0), Math.PI, 1e-12))
  ok('e^(-x^2) gaussian at 0 = 1', near(makeFn('e^(-x^2)')(0), 1))
  ok('1e-3 literal', near(makeFn('1e-3')(0), 0.001))
  ok('factorial(5)=120', near(makeFn('factorial(5)')(0), 120, 1e-3))
  ok('gamma(5)=24', near(makeFn('gamma(5)')(0), 24, 1e-3))
}
{
  // error paths must throw, not silently return garbage
  let threw = false
  try {
    compileExpr('x +* 3', ['x'])
  } catch {
    threw = true
  }
  ok('malformed expression throws', threw)

  threw = false
  try {
    compileExpr('x @ 3', ['x'])
  } catch {
    threw = true
  }
  ok('illegal character throws', threw)

  threw = false
  try {
    compileExpr('unknownfn(3)', ['x'])
  } catch {
    threw = true
  }
  ok('unknown function throws', threw)

  // no code execution: a JS payload must not evaluate
  threw = false
  try {
    const evil = makeFn('process.exit(1)')
    evil(0)
  } catch {
    threw = true
  }
  ok('JS injection is rejected (no eval)', threw)
}

console.log('\n== numeric methods ==')
{
  const f = makeFn('x^2 - 4')
  const roots = findRoots(f, -5, 5)
  ok('roots of x^2-4 = ±2', roots.length === 2 && roots.some((r) => near(r, -2, 1e-5)) && roots.some((r) => near(r, 2, 1e-5)), JSON.stringify(roots))

  const mn = findExtremum(makeFn('x^2'), -5, 5, 'min')
  ok('min of x^2 at x≈0 y≈0', near(mn.x, 0, 1e-4) && near(mn.y, 0, 1e-6), JSON.stringify(mn))

  const mx = findExtremum(makeFn('-x^2 + 3*x'), -10, 10, 'max')
  ok('max of -x^2+3x at x=1.5', near(mx.x, 1.5, 1e-3), JSON.stringify(mx))

  ok('∫ x^2 dx from 0..1 = 1/3', near(integrate(makeFn('x^2'), 0, 1, 2000), 1 / 3, 1e-7))
  ok('∫ sin(x) dx from 0..pi = 2', near(integrate(makeFn('sin(x)'), 0, Math.PI, 4000), 2, 1e-7))
  ok('∫ 1/x from -1..1 is non-finite (flagged)', !Number.isFinite(integrate(makeFn('1/x'), -1, 1, 2000)))

  ok("d/dx x^3 at 2 = 12", near(numericDerivative(makeFn('x^3'), 2), 12, 1e-4))
}

console.log('\n== svg plotter ==')
{
  const { svg, bounds } = plotSvg({ curves: [{ expr: 'sin(x)/x', label: 'sin(x)/x' }], xRange: [-15, 15], theme: 'dark' })
  ok('returns an <svg> root', svg.startsWith('<svg'))
  ok('closes the svg element', svg.trimEnd().endsWith('</svg>'))
  ok('contains a polyline path', svg.includes('<polyline'))
  ok('has axis tick labels', /font-size="11"/.test(svg))
  ok('y-range auto-fit is finite', Number.isFinite(bounds.yRange[0]) && Number.isFinite(bounds.yRange[1]))
  ok('removable singularity handled (no NaN in points)', !svg.includes('NaN'))
  ok('legend rendered', svg.includes('sin(x)/x'))
}
{
  // asymptote: tan(x) over a wide range must split into branches, not draw vertical lines
  const { svg } = plotSvg({ curves: [{ expr: 'tan(x)' }], xRange: [-6, 6], yRange: [-8, 8], theme: 'light' })
  const polylines = (svg.match(/<polyline/g) || []).length
  ok('tan(x) splits into multiple branches', polylines > 1, `polylines=${polylines}`)
  ok('light theme uses dark ink', svg.includes('#0f172a'))
}
{
  const { svg } = plotSvg({
    curves: [{ expr: 'sqrt(4-x^2)', label: '上半圆' }],
    xRange: [-3, 3],
    yRange: [-1, 3],
    points: [{ x: 0, y: 2, label: '顶点' }],
    theme: 'dark',
  })
  ok('domain-restricted curve (sqrt) plots without NaN', !svg.includes('NaN'))
  ok('annotated point rendered', svg.includes('顶点'))
}
{
  const { svg } = plotSvg({
    curves: [{ expr: 'cos(t)', yExpr: 'sin(t)', kind: 'parametric', paramRange: [0, 6.283185], label: '单位圆' }],
    theme: 'dark',
  })
  ok('parametric curve renders as closed-ish path', svg.includes('<polyline'))
  ok('parametric path has no NaN', !svg.includes('NaN'))
}
{
  const { svg } = plotSvg({ curves: [{ expr: '2*cos(t)', kind: 'polar', paramRange: [0, 6.283185], label: 'r=2cos θ' }], theme: 'dark' })
  ok('polar curve renders', svg.includes('<polyline') && !svg.includes('NaN'))
}
{
  const { svg } = plotSvg({
    curves: [{ expr: 'x^2', label: 'x²' }],
    xRange: [-2, 2],
    area: { expr1: 'x^2', from: -1, to: 1 },
    theme: 'dark',
  })
  ok('shaded area polygon rendered', svg.includes('<polygon'))
}
{
  // a bad expression must not throw or emit NaN — it should degrade to a legend note
  const { svg } = plotSvg({ curves: [{ expr: 'bad bad bad' }], theme: 'dark' })
  ok('invalid curve degrades gracefully', svg.startsWith('<svg') && !svg.includes('NaN'))
}
{
  const { svg } = plotSvg({ curves: [{ expr: 'x', label: '<img onerror=alert(1)>' }], theme: 'dark' })
  ok('SVG output escapes HTML in labels', !svg.includes('<img') && svg.includes('&lt;img'))
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
