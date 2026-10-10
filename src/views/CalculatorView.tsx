import { useEffect, useRef, useState } from 'react'
import { bridge, type CalculatorMode, type CalculatorResult } from '../lib/bridge'
import { useApp } from '../store/useApp'
import { useChat } from '../store/useChat'
import { Icon } from '../components/Icons'
import { Markdown } from '../components/Markdown'
import { backspace, CalculatorGeneration, CONDITIONS_LIMIT, EXAMPLES, EXPRESSION_LIMIT, inputSelection, insertKey, keyboardKeys, MATRIX_OPERATIONS, matrixExpression, resizeMatrix, type InputKey, type MatrixOperation } from '../lib/calculator-input'
import './CalculatorView.css'

const MODES: Record<CalculatorMode, { label: string; example: string; help: string }> = {
  calculus: { label: '微积分', example: '∫(x^2, x, 0, 1)', help: '化简、d(sin(x), x)、∫(x^2, x, 0, 1)。使用括号和明确的函数名。' },
  matrix: { label: '矩阵', example: 'inverse([[1, 2], [3, 4]])', help: '矩阵格式 [[1,2],[3,4]]；支持 det、inverse、rank、rref 等。最多 8×8。' },
  ode: { label: '微分方程', example: "y'+y=0", help: "使用 y'、y'' 等导数记号；初值条件每行一个，如 y(0)=1。" },
}
type Entry = { mode: CalculatorMode; expression: string; conditions: string[]; result: CalculatorResult }
type MatrixTable = { label: string; rows: string[][] }

// The worker serializes SymPy cells as text, not JSON (e.g. 1/2 or atan2(x, y)).
// Split only at top-level commas; cells stay inert strings and are never evaluated.
function splitMatrixItems(text: string): string[] | null {
  const stack: string[] = []
  const items: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch === '(' ? ')' : ch === '[' ? ']' : '}')
    else if (ch === ')' || ch === ']' || ch === '}') { if (stack.pop() !== ch) return null }
    else if (ch === ',' && !stack.length) { items.push(text.slice(start, i).trim()); start = i + 1 }
  }
  if (stack.length) return null
  items.push(text.slice(start).trim())
  return items.length <= 8 && items.every(Boolean) ? items : null
}

function parseMatrixRows(text: string): string[][] | null {
  const source = text.trim()
  if (source.length > 65536 || !source.startsWith('[') || !source.endsWith(']')) return null
  const rowTexts = splitMatrixItems(source.slice(1, -1))
  if (!rowTexts) return null
  const rows: string[][] = []
  for (const rowText of rowTexts) {
    if (!rowText.startsWith('[') || !rowText.endsWith(']')) return null
    const cells = splitMatrixItems(rowText.slice(1, -1))
    if (!cells || (rows.length && cells.length !== rows[0].length)) return null
    rows.push(cells)
  }
  return rows
}

function matrixTables(result: CalculatorResult): MatrixTable[] {
  if (result.isMatrix) {
    const rows = parseMatrixRows(result.matrixText || '')
    return rows ? [{ label: '结果矩阵', rows }] : []
  }
  // Multi-matrix operations (e.g. diagonalization) have no matrixText metadata;
  // their worker text contains labeled matrix literals. Keep the original below.
  const source = result.text
  if (source.length > 65536) return []
  const tables: MatrixTable[] = []
  let cursor = 0
  while (tables.length < 16) {
    const start = source.indexOf('[[', cursor)
    if (start < 0) break
    let end = start
    let depth = 0
    for (; end < source.length; end++) {
      if (source[end] === '[') depth++
      else if (source[end] === ']' && --depth === 0) { end++; break }
    }
    if (depth) break
    const rows = parseMatrixRows(source.slice(start, end))
    const prefix = source.slice(source.lastIndexOf('\n', start - 1) + 1, start)
    const label = prefix.match(/([A-Za-z][A-Za-z0-9_]*)\s*=\s*$/)?.[1]
    if (rows) tables.push({ label: label ? `${label} 矩阵` : `结果矩阵 ${tables.length + 1}`, rows })
    cursor = end
  }
  return tables
}

function MatrixResultTables({ result }: { result: CalculatorResult }) {
  return <>{matrixTables(result).map((matrix, i) => <div className="calculator-matrix-scroll" key={i}
    role="region" aria-label={`${matrix.label}（${matrix.rows.length} 行 × ${matrix.rows[0].length} 列），可滚动`} tabIndex={0}>
    <table className="calculator-matrix-table">
      <caption>{matrix.label} · {matrix.rows.length} × {matrix.rows[0].length}</caption>
      <thead><tr><th scope="col">行 / 列</th>{matrix.rows[0].map((_, col) => <th scope="col" key={col}>{col + 1}</th>)}</tr></thead>
      <tbody>{matrix.rows.map((row, r) => <tr key={r}><th scope="row">{r + 1}</th>
        {row.map((cell, c) => <td key={c}>{cell}</td>)}
      </tr>)}</tbody>
    </table>
  </div>)}</>
}
// Session-only and bounded: neither chat startup nor disk history pays calculator cost.
let historyCache: Entry[] = []
let drafts: Record<CalculatorMode, string> = { calculus: MODES.calculus.example, matrix: MODES.matrix.example, ode: MODES.ode.example }
let conditionDraft = ''

export default function CalculatorView({ compact = false, onClose, onExpand }: { compact?: boolean; onClose?: () => void; onExpand?: () => void }) {
  const app = useApp()
  const [mode, setMode] = useState<CalculatorMode>('calculus')
  const [expression, setExpression] = useState(drafts.calculus)
  const [conditions, setConditions] = useState(conditionDraft)
  const [entry, setEntry] = useState<Entry | null>(null)
  const [history, setHistory] = useState(historyCache)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('正在预热 Python · 本地符号计算，不调用 AI')
  const [error, setError] = useState('')
  const [keyboardOpen, setKeyboardOpen] = useState(true)
  const [cells, setCells] = useState<string[][]>([['1', '2'], ['3', '4']])
  const expressionRef = useRef<HTMLTextAreaElement>(null)
  const conditionsRef = useRef<HTMLTextAreaElement>(null)
  const selection = useRef({ start: expression.length, end: expression.length })
  const active = useRef<string | null>(null)
  const generation = useRef(new CalculatorGeneration())
  const mounted = useRef(true)
  const ready = async (restart = false) => {
    const token = generation.current.next()
    setStatus(restart ? '正在重启引擎…' : '正在预热 Python…')
    try {
      const st = await (restart ? bridge.calculator.restart() : bridge.calculator.ready())
      if (!mounted.current || !generation.current.isCurrent(token)) return
      setStatus(st.ready ? 'Python 已就绪 · 本地 SymPy' : '引擎未就绪；计算时可重试')
      setError(st.error || '')
    } catch (e) {
      if (mounted.current && generation.current.isCurrent(token)) { setError(String(e)); setStatus('计算服务不可用；可重试') }
    }
  }
  useEffect(() => {
    mounted.current = true
    void ready()
    return () => {
      mounted.current = false
      generation.current.next()
      const id = active.current
      active.current = null
      if (id) void bridge.calculator.cancel(id).catch(() => {})
      // Do not stop the resident worker when the UI closes.
    }
  }, [])

  const updateExpression = (value: string) => { drafts[mode] = value; setExpression(value) }
  const refocus = (start: number, end = start) => {
    selection.current = { start, end }
    requestAnimationFrame(() => {
      if (!mounted.current) return
      expressionRef.current?.focus()
      expressionRef.current?.setSelectionRange(start, end)
    })
  }
  const captureSelection = () => {
    selection.current = inputSelection(expressionRef.current, selection.current)
  }
  const typeKey = (key: InputKey | 'backspace') => {
    if (active.current) return
    // Pointer activation snapshots before blur; keyboard activation uses onBlur's
    // snapshot. If the textarea still owns focus, its live range is authoritative.
    const textarea = expressionRef.current
    const { start, end } = inputSelection(textarea && document.activeElement === textarea ? textarea : null, selection.current)
    const edit = key === 'backspace' ? backspace(expression, start, end) : insertKey(expression, start, end, key)
    if (!edit.accepted) { setError('表达式最多 2048 字符；本次插入未执行'); return }
    updateExpression(edit.value); setError(''); refocus(edit.start, edit.end)
  }
  const useMatrix = (operation: MatrixOperation) => {
    try {
      const text = matrixExpression(cells, operation)
      updateExpression(text); setError(''); refocus(text.length)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const addCondition = (text: string) => {
    const lines = conditions.split('\n').map(line => line.trim()).filter(Boolean)
    if (lines.length >= 8) { setError('最多支持 8 条初值条件'); return }
    const next = [...lines, text].join('\n')
    if (next.length > CONDITIONS_LIMIT) { setError('初值条件过长'); return }
    conditionDraft = next; setConditions(next); setError('')
    requestAnimationFrame(() => { if (mounted.current) { conditionsRef.current?.focus(); conditionsRef.current?.setSelectionRange(next.length, next.length) } })
  }

  const calculate = async () => {
    if (active.current || !expression.trim()) return
    const conditionLines = mode === 'ode' ? conditions.split('\n').map(s => s.trim()).filter(Boolean) : []
    if (conditionLines.length > 8 || conditionLines.some(line => line.length > EXPRESSION_LIMIT)) {
      setError('最多支持 8 条初值条件，每条最多 2048 字符'); return
    }
    const token = generation.current.next()
    const id = crypto.randomUUID()
    active.current = id
    setBusy(true); setError(''); setStatus('正在启动 / 计算…')
    const request = { id, mode, expression, conditions: conditionLines }
    try {
      const response = await bridge.calculator.calculate(request)
      if (!mounted.current || active.current !== id || !generation.current.isCurrent(token)) return
      if (response.ok === true) {
        const next = { mode, expression, conditions: request.conditions, result: response.result }
        setEntry(next)
        historyCache = [next, ...historyCache].slice(0, 20)
        setHistory(historyCache); setStatus('Python 已就绪 · 本地 SymPy')
      } else { setError(`${response.error.code} · ${response.error.message}`); setStatus('未完成；可重试或重启引擎') }
    } catch (e) {
      if (mounted.current && active.current === id && generation.current.isCurrent(token)) { setError(String(e)); setStatus('计算服务不可用') }
    } finally {
      if (active.current === id) { active.current = null; if (mounted.current) setBusy(false) }
    }
  }
  const textForChat = entry ? `CleverCalculator · ${MODES[entry.mode].label}\n表达式：${entry.expression}\n${entry.conditions.length ? `条件：${entry.conditions.join('；')}\n` : ''}${entry.result.text}` : ''

  return <>
    <div className="panel-head">
      <Icon.grid size={19} style={{ color: 'var(--accent)' }} />
      <div className="grow"><h1>数学计算器</h1><div className="sub" role="status">{status}</div></div>
      {onExpand ? <button className="btn ghost icon sm" title="展开到主区域" onClick={onExpand}><Icon.maximize size={15} /></button> : null}
      {onClose ? <button className="btn ghost icon sm" title="关闭计算器侧栏" onClick={onClose}><Icon.close size={15} /></button> : null}
      <button className="btn sm" disabled={busy} onClick={() => void ready(true)}>重启引擎</button>
    </div>
    <div className={`panel-body calculator-body${compact ? ' compact' : ''}`}>
      <div className="calculator-grid">
        <section className="calculator-card">
          <label htmlFor="calculator-mode">计算模式</label>
          <select id="calculator-mode" className="input" value={mode} disabled={busy} onChange={e => {
            const next = e.target.value as CalculatorMode
            setMode(next); setExpression(drafts[next]); selection.current = { start: drafts[next].length, end: drafts[next].length }; setError('')
          }}>{Object.entries(MODES).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select>
          <p className="muted calculator-help">{MODES[mode].help}</p>
          <label htmlFor="calculator-expression">表达式</label>
          <textarea ref={expressionRef} id="calculator-expression" className="input mono calculator-expression" value={expression} maxLength={EXPRESSION_LIMIT} disabled={busy}
            onChange={e => { updateExpression(e.target.value); selection.current = { start: e.target.selectionStart, end: e.target.selectionEnd } }}
            onBlur={captureSelection}
            onSelect={captureSelection}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void calculate() } }} />
          {mode === 'ode' && <><label htmlFor="calculator-conditions">初值条件（最多 8 条，可留空）</label>
            <textarea ref={conditionsRef} id="calculator-conditions" className="input mono" rows={3} value={conditions} maxLength={CONDITIONS_LIMIT} disabled={busy} placeholder="y(0)=1"
              onChange={e => { conditionDraft = e.target.value; setConditions(e.target.value) }}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void calculate() } }} />
            <div className="calculator-key-row" aria-label="初值条件快捷键">{['y(0)=1', 'y(0)=0', "y'(0)=0", "y'(0)=1"].map(text =>
              <button key={text} className="btn sm mono" disabled={busy} onClick={() => addCondition(text)}>{text}</button>)}</div>
          </>}
          <div className="calculator-keyboard">
            <button className="btn ghost sm" aria-expanded={keyboardOpen} aria-controls="calculator-soft-keys" onClick={() => setKeyboardOpen(open => !open)}>
              {keyboardOpen ? '收起' : '展开'}数学软键盘 · {MODES[mode].label}
            </button>
            {keyboardOpen && <div id="calculator-soft-keys">
              <p className="muted calculator-help">在光标处插入；函数包裹选中文字。模板中的内容会被选中，便于替换。使用 * 表示乘法。</p>
              <div className="calculator-key-row" role="group" aria-label={`${MODES[mode].label}数学按键`}>
                {keyboardKeys(mode).map(key => <button className="btn sm mono" key={key.label} disabled={busy}
                  onPointerDown={() => captureSelection()} onMouseDown={e => e.preventDefault()} onClick={() => typeKey(key)}>{key.label}</button>)}
                <button className="btn sm" disabled={busy} onPointerDown={() => captureSelection()} onMouseDown={e => e.preventDefault()} onClick={() => typeKey('backspace')}>退格</button>
                <button className="btn sm" disabled={busy} onClick={() => { updateExpression(''); setError(''); refocus(0) }}>清空表达式</button>
              </div>
              {mode === 'matrix' && <fieldset className="calculator-matrix-editor" disabled={busy}>
                <legend>矩阵编辑器 · 1–8 行 / 列</legend>
                <div className="calculator-matrix-dimensions">
                  <label>行数<select className="input" value={cells.length} onChange={e => setCells(resizeMatrix(cells, Number(e.target.value), cells[0].length))}>
                    {Array.from({ length: 8 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>
                  <label>列数<select className="input" value={cells[0].length} onChange={e => setCells(resizeMatrix(cells, cells.length, Number(e.target.value)))}>
                    {Array.from({ length: 8 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>
                  <button className="btn sm" disabled={cells.length !== cells[0].length} onClick={() => setCells(resizeMatrix([], cells.length, cells[0].length, true))}>单位矩阵</button>
                </div>
                <div className="calculator-matrix-scroll" role="region" aria-label="矩阵单元格，可横向滚动" tabIndex={0}>
                  <table className="calculator-matrix-table"><tbody>{cells.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>
                    <input className="input mono" aria-label={`第 ${r + 1} 行第 ${c + 1} 列`} value={cell} maxLength={128}
                      onChange={e => setCells(previous => previous.map((line, ri) => ri === r ? line.map((value, ci) => ci === c ? e.target.value : value) : line))} />
                  </td>)}</tr>)}</tbody></table>
                </div>
                <div className="calculator-key-row">{MATRIX_OPERATIONS.map(([op, label]) => <button className="btn sm" key={op}
                  disabled={busy || (['det', 'inverse', 'trace', 'eigenval'].includes(op) && cells.length !== cells[0].length)} onClick={() => useMatrix(op)}>{label}</button>)}</div>
                <p className="muted calculator-help">按钮将编辑器内容生成到表达式，不会自动计算；空单元格按 0 处理。求逆还要求矩阵可逆。</p>
              </fieldset>}
            </div>}
          </div>
          <div className="calculator-key-row" role="group" aria-label="可用示例">{EXAMPLES[mode].map(example => <button className="btn sm" key={example.label} disabled={busy}
            onClick={() => {
              updateExpression(example.expression)
              if (mode === 'ode') { conditionDraft = example.conditions || ''; setConditions(conditionDraft) }
              setError(''); refocus(example.expression.length)
            }}>示例 · {example.label}</button>)}</div>
          <div className="row calculator-actions">
            <button className="btn primary" disabled={busy || !expression.trim()} onClick={() => void calculate()}>{busy ? '计算中…' : '计算 / 求解'}</button>
            {busy && <button className="btn" onClick={() => { if (active.current) void bridge.calculator.cancel(active.current) }}>取消</button>}
            <span className="muted calculator-help">Ctrl / ⌘ + Enter</span>
          </div>
          {error && <div className="calculator-error" role="alert">{error}</div>}
        </section>
        <section className="calculator-card calculator-result" aria-label="计算结果">
          <h2>计算结果{entry ? ` · ${MODES[entry.mode].label}` : ''}</h2>
          {entry ? <>
            <div className="muted mono calculator-source">{entry.expression}</div>
            {entry.result.latex && entry.mode === 'calculus' && <Markdown>{`$$\n${entry.result.latex}\n$$`}</Markdown>}
            {entry.mode === 'matrix' && <MatrixResultTables result={entry.result} />}
            <pre>{entry.result.text}</pre>
            <div className="row calculator-actions">
              <button className="btn sm" onClick={async () => {
                try { const ok = await bridge.clipboard.writeText(textForChat); app.toast({ kind: ok ? 'success' : 'error', title: ok ? '已复制计算结果，可粘贴到对话' : '复制失败' }) }
                catch (e) { app.toast({ kind: 'error', title: '复制失败', body: String(e) }) }
              }}><Icon.copy size={14} />复制到对话</button>
              <button className="btn sm" onClick={() => {
                useChat.getState().setEditTarget({ messageId: 'calculator', text: textForChat + '\n\n请解释上述计算过程。' })
                app.setView('chat')
              }}><Icon.chat size={14} />插入当前对话</button>
            </div>
          </> : <p className="muted">输入表达式后开始计算。矩阵结果以表格与文本展示，微分方程结果以文本展示。</p>}
        </section>
      </div>
      <section className="calculator-card calculator-history">
        <div className="row between"><h2>本次会话历史（最多 20 条）</h2><button className="btn ghost sm" onClick={() => { historyCache = []; setHistory([]) }}>清空</button></div>
        {history.length ? history.map((item, i) => <button className="calculator-history-item" key={i} disabled={busy} onClick={() => {
          setMode(item.mode); drafts[item.mode] = item.expression; setExpression(item.expression)
          selection.current = { start: item.expression.length, end: item.expression.length }
          conditionDraft = item.conditions.join('\n'); setConditions(conditionDraft); setEntry(item); setError('')
        }}><span className="chip">{MODES[item.mode].label}</span><span className="mono">{item.expression}</span></button>) : <p className="muted">暂无计算记录</p>}
      </section>
      <p className="muted calculator-help">引擎来自 CleverCalculator。仅使用纯 SymPy 模块，不加载 Qt / Matplotlib。项目所有者已明确授权本次集成源码与程序公开发布；未另行赋予宽松许可证，第三方许可与声明仍适用。</p>
    </div>
  </>
}
