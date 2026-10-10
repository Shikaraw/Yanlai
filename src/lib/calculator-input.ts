import type { CalculatorMode } from './bridge'

export const EXPRESSION_LIMIT = 2048
export const CONDITIONS_LIMIT = 4096
export type InputEdit = { value: string; start: number; end: number; accepted: boolean }
export type InputSelection = { start: number; end: number }
// Read live DOM selection when available; cached onSelect can lag keyboard selection.
export function inputSelection(live: { selectionStart: number; selectionEnd: number } | null, saved: InputSelection): InputSelection {
  return live ? { start: live.selectionStart, end: live.selectionEnd } : { ...saved }
}
export type InputKey = { label: string; text?: string; prefix?: string; suffix?: string; placeholder?: string }

export const EXAMPLES: Record<CalculatorMode, { label: string; expression: string; conditions?: string }[]> = {
  calculus: [
    { label: '定积分', expression: '∫(x^2, x, 0, 1)' },
    { label: '求导', expression: 'd(sin(x), x)' },
    { label: '二阶导数', expression: 'd(x^3, x, 2)' },
    { label: '化简', expression: '(x^2-1)/(x-1)' },
  ],
  matrix: [
    { label: '求逆', expression: 'inverse([[1,2],[3,4]])' },
    { label: '行列式', expression: 'det([[1,2],[3,4]])' },
    { label: '行最简', expression: 'rref([[1,2,3],[2,4,6]])' },
  ],
  ode: [
    { label: '一阶初值', expression: "y'+y=0", conditions: 'y(0)=1' },
    { label: '二阶初值', expression: "y''+y=0", conditions: "y(0)=0\ny'(0)=1" },
    { label: '非齐次', expression: "y'-y=exp(x)", conditions: '' },
  ],
}

const COMMON_KEYS: InputKey[] = [
  ...['7', '8', '9', '+', '4', '5', '6', '-', '1', '2', '3', '*', '0', '.', '/', '^', 'x', 'y', '(', ')', ',', 'pi', 'E'].map(text => ({ label: text, text })),
  ...['sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'Abs'].map(name => ({ label: name, prefix: `${name}(`, suffix: ')', placeholder: 'x' })),
]
export function keyboardKeys(mode: CalculatorMode): InputKey[] {
  const extra: InputKey[] = mode === 'calculus' ? [
    { label: '求导 d', prefix: 'd(', suffix: ', x)', placeholder: 'x^2' },
    { label: '二阶导数', prefix: 'd(', suffix: ', x, 2)', placeholder: 'x^3' },
    { label: '不定积分 ∫', prefix: '∫(', suffix: ', x)', placeholder: 'x^2' },
    { label: '定积分 ∫', prefix: '∫(', suffix: ', x, 0, 1)', placeholder: 'x^2' },
    { label: '∞', text: 'oo' },
  ] : mode === 'ode' ? ["y'", "y''", "y'''", '='].map(text => ({ label: text, text })) : [
    { label: '[', text: '[' }, { label: ']', text: ']' },
  ]
  // Matrix parser requires Python power syntax; ODE solver cannot integrate
  // the default Abs(x) template, so do not advertise that key in ODE mode.
  const common = COMMON_KEYS.filter(key => mode !== 'ode' || key.label !== 'Abs')
    .map(key => mode === 'matrix' && key.label === '^' ? { ...key, text: '**' } : key)
  return [...common, ...extra]
}

// Reject oversized edits atomically: never truncate a closing bracket/template.
export function insertKey(value: string, start: number, end: number, key: InputKey, maxLength = EXPRESSION_LIMIT): InputEdit {
  start = Math.max(0, Math.min(value.length, Math.trunc(start) || 0))
  end = Math.max(start, Math.min(value.length, Math.trunc(end) || 0))
  const wrapped = key.prefix !== undefined
  const body = value.slice(start, end) || key.placeholder || ''
  const text = wrapped ? key.prefix + body + (key.suffix || '') : key.text || ''
  const next = value.slice(0, start) + text + value.slice(end)
  if (next.length > maxLength) return { value, start, end, accepted: false }
  const caret = start + text.length
  return { value: next, start: wrapped ? start + key.prefix!.length : caret,
    end: wrapped ? start + key.prefix!.length + body.length : caret, accepted: true }
}

export function backspace(value: string, start: number, end: number): InputEdit {
  if (start === end && start > 0) {
    const previous = Array.from(value.slice(0, start)).pop() || ''
    start -= previous.length
  }
  return insertKey(value, start, end, { label: '', text: '' }, Number.MAX_SAFE_INTEGER)
}

export function matrixSize(value: number): number {
  return Math.max(1, Math.min(8, Number.isFinite(value) ? Math.trunc(value) : 1))
}
export function resizeMatrix(cells: string[][], rows: number, cols: number, identity = false): string[][] {
  return Array.from({ length: matrixSize(rows) }, (_, r) => Array.from({ length: matrixSize(cols) }, (_, c) =>
    identity ? (r === c ? '1' : '0') : cells[r]?.[c] ?? '0'))
}
export const MATRIX_OPERATIONS = [
  ['literal', '填入矩阵'], ['det', '行列式'], ['inverse', '求逆'], ['transpose', '转置'],
  ['rank', '秩'], ['trace', '迹'], ['rref', '行最简'], ['eigenval', '特征值'],
] as const
export type MatrixOperation = typeof MATRIX_OPERATIONS[number][0]
export function matrixExpression(cells: string[][], operation: MatrixOperation): string {
  if (!MATRIX_OPERATIONS.some(([op]) => op === operation)) throw new Error('不支持的矩阵操作')
  if (!cells.length || cells.length > 8 || !cells[0].length || cells[0].length > 8 || cells.some(row => row.length !== cells[0].length)) throw new Error('矩阵须为 1–8 行、1–8 列')
  const rows = cells.map(row => row.map(cell => {
    const text = cell.trim() || '0'
    // Cells remain inert text. Forbid list/statement injection and unbalanced parentheses.
    let depth = 0
    if (text.length > 128 || /[\[\]{};:"`\\=\n\r]|__/.test(text)) throw new Error('矩阵单元格须为数学表达式（最多 128 字符）')
    for (const ch of text) {
      if (ch === '(') depth++
      if (ch === ')' && --depth < 0) throw new Error('单元格括号不匹配')
      if (ch === ',' && depth === 0) throw new Error('单元格不能包含顶层逗号')
    }
    if (depth) throw new Error('单元格括号不匹配')
    return text
  }))
  const literal = `[${rows.map(row => `[${row.join(',')}]`).join(',')}]`
  const result = operation === 'literal' ? literal : `${operation}(${literal})`
  if (result.length > EXPRESSION_LIMIT) throw new Error('生成的表达式超过 2048 字符，请缩短单元格')
  return result
}

// Each asynchronous status operation owns a generation; newer work/unmount invalidates it.
export class CalculatorGeneration {
  private generation = 0
  next(): number { return ++this.generation }
  isCurrent(generation: number): boolean { return this.generation === generation }
}
