/**
 * Tool registry.
 *
 * Every tool is declared with a JSON schema for the model *and* a local
 * executor. Descriptions are intentionally short — they are part of the system
 * prompt and therefore billed on every tool-enabled turn.
 */

import type { Artifact, Flashcard, KnowledgeDoc, PlanSchedule, WrongEntry } from './types'
import { plotSvg, makeFn, findRoots, findExtremum, integrate, numericDerivative, CURVE_COLORS } from './mathplot'
import { Bm25Index, buildKbContext, chunkText, makeDoc } from './kb'
import { uid, activeReason } from './util'
import { REASON_CATEGORIES } from './types'

export interface ToolResult {
  /** text handed back to the model */
  text: string
  artifacts?: Artifact[]
  /** short label shown in the UI chip */
  label?: string
}

export interface ToolContext {
  workspace: string
  theme: 'dark' | 'light'
  settings: any
  kbIndex: Bm25Index | null
  kbDocs: KnowledgeDoc[]
  wrongEntries: WrongEntry[]
  addWrongEntry: (e: Partial<WrongEntry>) => Promise<WrongEntry>
  addFlashcard: (c: Partial<Flashcard>) => Promise<Flashcard>
  saveKnowledgeNote: (name: string, text: string, tags?: string[], subject?: string) => Promise<KnowledgeDoc>
  savePlan: (schedule: PlanSchedule) => Promise<void>
  exportDoc: (args: { format: string; title: string; markdown: string; rows?: any[][]; outPath?: string }) => Promise<ToolResult>
  readFile: (path: string) => Promise<string>
  listWorkspace: () => Promise<string>
  writeFile: (path: string, text: string) => Promise<string>
}

export interface ToolDef {
  name: string
  description: string
  parameters: any
  run: (args: any, ctx: ToolContext) => Promise<ToolResult>
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
function num(v: any, d = 0) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : d
}

/** Accept the many shapes a model uses for a range: [a,b], {min,max}, "a,b". */
function parseRange(v: any, fallback: [number, number]): [number, number] {
  if (Array.isArray(v) && v.length >= 2) return [num(v[0], fallback[0]), num(v[1], fallback[1])]
  if (v && typeof v === 'object') return [num(v.min ?? v.from ?? v.start, fallback[0]), num(v.max ?? v.to ?? v.end, fallback[1])]
  if (typeof v === 'string' && v.includes(',')) {
    const [a, b] = v.split(',')
    return [num(a, fallback[0]), num(b, fallback[1])]
  }
  return fallback
}

function svgArtifact(svg: string, name: string, width: number, height: number): Artifact {
  // data URL keeps the artifact self-contained for exports and thumbnails
  const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
  return { id: uid('art'), kind: 'chart', name, svg, dataUrl, size: svg.length, createdAt: Date.now(), ext: 'svg', mime: 'image/svg+xml' }
}

/* ------------------------------------------------------------------ */
/* plot_function                                                       */
/* ------------------------------------------------------------------ */
const plotFunction: ToolDef = {
  name: 'plot_function',
  description:
    '绘制函数图像并在对话中显示。支持显函数、参数方程、极坐标。可同时画多条曲线、标注散点与辅助线、填充两曲线间区域。用于讲解函数性质、几何关系、积分面积、分布曲线等。',
  parameters: {
    type: 'object',
    properties: {
      curves: {
        type: 'array',
        description: '要绘制的曲线列表',
        items: {
          type: 'object',
          properties: {
            expr: { type: 'string', description: '表达式，变量为 x（参数方程/极坐标用 t）。如 "x^2-2*x+1"、"sin(x)/x"' },
            yExpr: { type: 'string', description: '参数方程的 y 关于 t 的表达式' },
            kind: { type: 'string', enum: ['explicit', 'parametric', 'polar'], description: '默认 explicit' },
            paramRange: { type: 'array', items: { type: 'number' }, description: '参数范围 [t0,t1]，默认 [0,2π]' },
            label: { type: 'string', description: '图例名称' },
            color: { type: 'string', description: '颜色，默认自动分配' },
            dash: { type: 'boolean', description: '虚线' },
          },
          required: ['expr'],
        },
      },
      xRange: { type: 'array', items: { type: 'number' }, description: 'x 轴范围 [min,max]，默认自动 [-10,10]' },
      yRange: { type: 'array', items: { type: 'number' }, description: 'y 轴范围，默认自动' },
      points: {
        type: 'array',
        description: '要标注的散点（如极值点、交点）',
        items: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, color: { type: 'string' } },
          required: ['x', 'y'],
        },
      },
      segments: {
        type: 'array',
        description: '辅助虚线（如渐近线、切线）',
        items: {
          type: 'object',
          properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, label: { type: 'string' } },
          required: ['x1', 'y1', 'x2', 'y2'],
        },
      },
      area: {
        type: 'object',
        description: '填充区域（如积分的面积）',
        properties: {
          expr1: { type: 'string' },
          expr2: { type: 'string', description: '默认为 x 轴 (y=0)' },
          from: { type: 'number' },
          to: { type: 'number' },
        },
        required: ['expr1', 'from', 'to'],
      },
      title: { type: 'string' },
      xLabel: { type: 'string' },
      yLabel: { type: 'string' },
      autoAnnotate: { type: 'boolean', description: '自动标注零点与极值点，默认 true' },
    },
    required: ['curves'],
  },
  async run(args, ctx) {
    const curves = (args.curves || []).map((c: any, i: number) => ({
      expr: String(c.expr || 'x'),
      yExpr: c.yExpr ? String(c.yExpr) : undefined,
      kind: c.kind || (c.yExpr ? 'parametric' : 'explicit'),
      paramRange: c.paramRange ? parseRange(c.paramRange, [0, Math.PI * 2]) : undefined,
      label: c.label || String(c.expr),
      color: c.color || CURVE_COLORS[i % CURVE_COLORS.length],
      dash: !!c.dash,
    }))
    const xRange = args.xRange ? parseRange(args.xRange, [-10, 10]) : undefined
    const yRange = args.yRange ? parseRange(args.yRange, [-10, 10]) : undefined

    const autoAnnotate = args.autoAnnotate !== false
    const points: any[] = [...(args.points || [])]
    const notes: string[] = []

    // auto-annotate only for single explicit curves — avoids cluttering comparisons
    const single = curves.filter((c: any) => c.kind === 'explicit')
    if (autoAnnotate && single.length === 1 && (xRange || true)) {
      const f = makeFn(single[0].expr, 'x')
      const [a, b] = xRange || [-10, 10]
      try {
        const roots = findRoots((x) => {
          const v = f(x)
          return Number.isFinite(v) ? v : NaN
        }, a, b, 600)
        for (const r of roots.slice(0, 4)) points.push({ x: r, y: 0, label: `(${r.toFixed(3)}, 0)`, color: '#fb7185' })
        if (roots.length) notes.push(`零点 x ≈ ${roots.slice(0, 4).map((r) => r.toFixed(4)).join(', ')}`)
        const mn = findExtremum(f, a, b, 'min')
        const mx = findExtremum(f, a, b, 'max')
        if (Number.isFinite(mn.y)) {
          points.push({ x: mn.x, y: mn.y, label: `极小 ${mn.y.toFixed(3)}`, color: '#a3e635' })
          notes.push(`极小值 f(${mn.x.toFixed(4)}) ≈ ${mn.y.toFixed(4)}`)
        }
        if (Number.isFinite(mx.y)) {
          points.push({ x: mx.x, y: mx.y, label: `极大 ${mx.y.toFixed(3)}`, color: '#fbbf24' })
          notes.push(`极大值 f(${mx.x.toFixed(4)}) ≈ ${mx.y.toFixed(4)}`)
        }
      } catch {
        /* annotation is best-effort */
      }
    }

    const { svg, bounds } = plotSvg({
      curves,
      xRange,
      yRange,
      theme: ctx.theme,
      title: args.title,
      xLabel: args.xLabel,
      yLabel: args.yLabel,
      points: points.length ? points : undefined,
      segments: args.segments,
      area: args.area
        ? { expr1: args.area.expr1, expr2: args.area.expr2, from: num(args.area.from), to: num(args.area.to) }
        : undefined,
    })

    const art = svgArtifact(svg, args.title || `函数图像 ${curves.map((c: any) => c.expr).join(' / ')}`, bounds.width, bounds.height)
    let extra = ''
    if (args.area) {
      try {
        const f = makeFn(args.area.expr1, 'x')
        const g = args.area.expr2 ? makeFn(args.area.expr2, 'x') : () => 0
        const val = integrate((x) => f(x) - g(x), num(args.area.from), num(args.area.to), 4000)
        if (Number.isFinite(val)) extra = `\n填充区域面积（数值积分）≈ ${val.toFixed(6)}`
      } catch {}
    }
    return {
      label: '已绘制图像',
      artifacts: [art],
      text: `图像已生成并显示在对话中。坐标范围 x∈[${bounds.xRange[0].toFixed(3)}, ${bounds.xRange[1].toFixed(3)}], y∈[${bounds.yRange[0].toFixed(3)}, ${bounds.yRange[1].toFixed(3)}]。${notes.length ? `\n自动分析：${notes.join('；')}` : ''}${extra}\n请结合图像讲解，指出关键点与题目结论的对应关系。不要输出 SVG 代码。`,
    }
  },
}

/* ------------------------------------------------------------------ */
/* calculator                                                          */
/* ------------------------------------------------------------------ */
const calculator: ToolDef = {
  name: 'calculator',
  description:
    '精确计算与符号运算。支持：求值、化简、求导、数值求解方程、数值积分、求和、矩阵运算、统计量。避免手算失误时使用。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['evaluate', 'simplify', 'derivative', 'solve', 'integrate', 'sum', 'matrix', 'stats'],
        description: '运算类型',
      },
      expr: { type: 'string', description: '表达式，变量用 x/y/z 等；矩阵用 [[1,2],[3,4]] 形式' },
      variable: { type: 'string', description: 'derivative/solve 的主变量，默认 x' },
      point: { type: 'number', description: 'derivative 求导后代入的取值点（可选）' },
      range: { type: 'array', items: { type: 'number' }, description: 'solve/integrate 的区间 [a,b]' },
      order: { type: 'number', description: 'derivative 的阶数，默认 1' },
      values: { type: 'array', items: { type: 'number' }, description: 'stats 的数值列表' },
      matrixOp: { type: 'string', enum: ['det', 'inv', 'transpose', 'rank', 'eigenvalues'], description: 'matrix 的具体操作' },
      precision: { type: 'number', description: '结果保留小数位，默认 8' },
    },
    required: ['action'],
  },
  async run(args) {
    const math: any = await import('mathjs')
    const prec = Math.max(0, Math.min(14, num(args.precision, 8)))
    const action = args.action
    const round = (v: any): any => {
      if (typeof v === 'number') return Number.isFinite(v) ? Number(v.toFixed(prec)) : String(v)
      if (v?.entries && typeof v.toArray === 'function') return round(v.toArray())
      if (Array.isArray(v)) return v.map(round)
      if (typeof v === 'string') return v
      if (v?.toString) return v.toString()
      return v
    }
    const fmt = (v: any) => {
      const r = round(v)
      return typeof r === 'object' ? JSON.stringify(r) : String(r)
    }

    try {
      switch (action) {
        case 'evaluate': {
          const val = math.evaluate(String(args.expr))
          return { label: '计算完成', text: `${args.expr} = ${fmt(val)}` }
        }
        case 'simplify': {
          const s = math.simplify(String(args.expr))
          return { label: '化简完成', text: `${args.expr} 化简为：${s.toString()}${args.variable ? `\n对 ${args.variable} 而言` : ''}` }
        }
        case 'derivative': {
          const v = args.variable || 'x'
          let d = math.derivative(String(args.expr), v)
          const order = Math.max(1, Math.min(6, num(args.order, 1)))
          for (let i = 1; i < order; i++) d = math.derivative(d, v)
          let extra = ''
          if (args.point !== undefined) {
            const val = d.evaluate({ [v]: num(args.point) })
            extra = `\n代入 ${v} = ${args.point}：${fmt(val)}`
          }
          const simp = math.simplify(d)
          return { label: `${order} 阶导数`, text: `d^${order}/d${v}^${order} (${args.expr}) = ${d.toString()}\n化简形式：${simp.toString()}${extra}` }
        }
        case 'solve': {
          const v = args.variable || 'x'
          const [a, b] = parseRange(args.range, [-20, 20])
          const src = String(args.expr)
          const f = (x: number) => Number(math.evaluate(src, { [v]: x }))
          const roots = findRoots(f, a, b, 3000)
          if (!roots.length) return { label: '无解', text: `在区间 [${a}, ${b}] 内未找到实数根。可扩大 range 或检查方程是否有解。` }
          const verified = roots.map((r) => ({ r, y: f(r) }))
          return {
            label: `${roots.length} 个根`,
            text: `方程 ${src} = 0 在 [${a}, ${b}] 内的实根：\n${verified.map((x) => `  ${v} ≈ ${x.r.toFixed(prec)}  （代入验算 = ${x.y.toExponential(2)}）`).join('\n')}`,
          }
        }
        case 'integrate': {
          const v = args.variable || 'x'
          const [a, b] = parseRange(args.range, [0, 1])
          const src = String(args.expr)
          const f = (x: number) => Number(math.evaluate(src, { [v]: x }))
          const val = integrate(f, a, b, 8000)
          if (!Number.isFinite(val)) return { label: '积分失败', text: '被积函数在区间内存在不连续或发散点，无法数值积分。请检查区间。' }
          // cross-check with a coarser grid to flag wildly oscillatory integrands
          const rough = integrate(f, a, b, 400)
          const unstable = Number.isFinite(rough) && Math.abs(rough - val) > Math.max(1e-6, Math.abs(val) * 0.01)
          return {
            label: '积分完成',
            text: `∫_${a}^${b} (${src}) d${v} ≈ ${val.toFixed(Math.max(prec, 8))}${unstable ? '\n注意：粗网格与细网格结果差异较大，被积函数可能剧烈振荡，请核对区间与表达式。' : ''}`,
          }
        }
        case 'sum': {
          const val = math.evaluate(String(args.expr))
          return { label: '求和完成', text: `结果：${fmt(val)}` }
        }
        case 'matrix': {
          const m = math.evaluate(String(args.expr))
          const op = args.matrixOp || 'det'
          const fn = math[op] || math[op === 'inv' ? 'inv' : op]
          const res = op === 'det' ? math.det(m) : op === 'inv' ? math.inv(m) : op === 'transpose' ? math.transpose(m) : math[op]?.(m)
          return {
            label: `矩阵 ${op}`,
            text:
              op === 'eigenvalues'
                ? `特征值：${fmt(math.eigs ? math.eigs(m).values : res)}`
                : `${op} 结果：${fmt(res)}`,
          }
        }
        case 'stats': {
          const arr = (args.values || []).map((x: any) => num(x))
          if (!arr.length) return { label: '无数据', text: '请提供 values 数组。' }
          const sorted = [...arr].sort((a, b) => a - b)
          const mean = arr.reduce((a, b) => a + b, 0) / arr.length
          const variance = arr.length > 1 ? arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1) : 0
          return {
            label: '统计量',
            text: [
              `n = ${arr.length}`,
              `平均 = ${fmt(mean)}`,
              `样本标准差 = ${fmt(Math.sqrt(variance))}`,
              `方差 = ${fmt(variance)}`,
              `最小 = ${fmt(sorted[0])}  最大 = ${fmt(sorted[sorted.length - 1])}`,
              `中位数 = ${fmt(sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)}`,
              `极差 = ${fmt(sorted[sorted.length - 1] - sorted[0])}`,
            ].join('\n'),
          }
        }
        default:
          return { label: '未支持', text: `不支持的运算类型：${action}` }
      }
    } catch (e: any) {
      return { label: '计算失败', text: `计算失败：${e?.message || e}。请检查表达式语法（乘号需显式写出，如 2*x 而不是 2x）。` }
    }
  },
}

/* ------------------------------------------------------------------ */
/* write_document                                                      */
/* ------------------------------------------------------------------ */
const writeDocument: ToolDef = {
  name: 'write_document',
  description:
    '把整理好的内容导出为文件并保存到工作区。支持 md / docx / pdf / html / txt / xlsx。讲义、试卷、大纲、知识点整理应导出 docx 或 pdf；错题表格、分数统计用 xlsx。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '文档标题，同时作为文件名' },
      markdown: { type: 'string', description: '文档正文（Markdown 格式，数学用 $...$）' },
      format: { type: 'string', enum: ['md', 'docx', 'pdf', 'html', 'txt', 'xlsx'], description: '导出格式' },
      rows: {
        type: 'array',
        description: '仅 format=xlsx 时使用：单元格数据，第一行为表头。示例 [["题号","知识点","错因"],["1","极限","概念不清"]]',
        items: { type: 'array' },
      },
      sheetName: { type: 'string', description: 'xlsx 工作表名' },
      filename: { type: 'string', description: '自定义文件名（不含扩展名）' },
    },
    required: ['title', 'format'],
  },
  async run(args, ctx) {
    const format = String(args.format || 'md')
    const title = String(args.title || '研来文档')
    const res = await ctx.exportDoc({
      format,
      title: args.filename || title,
      markdown: String(args.markdown || ''),
      rows: args.rows,
      outPath: undefined,
    })
    if (!res) return { label: '导出失败', text: '导出未完成。' }
    return { ...res, label: `${format.toUpperCase()} 已导出` }
  },
}

/* ------------------------------------------------------------------ */
/* read_file / list_workspace                                          */
/* ------------------------------------------------------------------ */
const readFileTool: ToolDef = {
  name: 'read_file',
  description: '读取工作区（或知识库来源目录）中的文本文件内容。用于查看学生导入的教材、真题、笔记。支持 txt/md/csv/json/tex。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，可为绝对路径或相对工作区的路径' },
      maxChars: { type: 'number', description: '最多返回的字符数，默认 6000' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const max = Math.max(500, Math.min(40000, num(args.maxChars, 6000)))
    const raw = await ctx.readFile(String(args.path))
    if (!raw) return { label: '读取失败', text: `无法读取文件：${args.path}。请确认路径存在，或改用 list_workspace 查看可用文件。` }
    const truncated = raw.length > max
    return {
      label: '已读取文件',
      text: `文件 ${args.path} 内容${truncated ? `（前 ${max} 字符，原文共 ${raw.length} 字符）` : ''}：\n\n${raw.slice(0, max)}`,
    }
  },
}

const listWorkspaceTool: ToolDef = {
  name: 'list_workspace',
  description: '列出当前工作区中的文件，了解学生手上有哪些资料可用。',
  parameters: { type: 'object', properties: { subdir: { type: 'string', description: '可选子目录' } } },
  async run(_args, ctx) {
    const listing = await ctx.listWorkspace()
    return { label: '已列出文件', text: listing || '工作区为空。可以建议学生导入教材或真题资料，我会据此建立知识库。' }
  },
}

/* ------------------------------------------------------------------ */
/* search_knowledge_base                                               */
/* ------------------------------------------------------------------ */
const searchKbTool: ToolDef = {
  name: 'search_knowledge_base',
  description: '在学生导入的知识库中检索相关片段（教材、笔记、真题）。回答问题前若涉及具体资料内容，应先检索。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索问题，尽量包含该领域的专业术语' },
      topK: { type: 'number', description: '返回片段数，默认 4' },
      docName: { type: 'string', description: '限定在某份资料内检索（可选）' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    if (!ctx.kbIndex || !ctx.kbIndex.size) {
      return { label: '知识库为空', text: '知识库中还没有资料。请告诉学生先在「知识库」页面导入教材或笔记，之后我就能基于资料作答。' }
    }
    const topK = Math.max(1, Math.min(10, num(args.topK, ctx.settings?.tokens?.kbTopK || 4)))
    let docIds: string[] | undefined
    if (args.docName) {
      const hit = ctx.kbDocs.find((d) => d.name.includes(String(args.docName)))
      if (hit) docIds = [hit.id]
    }
    const hits = ctx.kbIndex.search(String(args.query), topK, { docIds })
    if (!hits.length) {
      return { label: '未命中', text: `知识库中未检索到与「${args.query}」相关的内容。可以告知学生资料未覆盖此考点，并说明你会用自身知识补充。` }
    }
    const budget = ctx.settings?.tokens?.kbCharBudget || 3200
    const built = buildKbContext(hits, budget)
    return {
      label: `命中 ${hits.length} 段`,
      text: `检索到以下资料片段（按相关度排序，请整合后作答并标注出处）：\n\n${built.text}`,
    }
  },
}

/* ------------------------------------------------------------------ */
/* search_wrongbook                                                    */
/* ------------------------------------------------------------------ */
const searchWrongTool: ToolDef = {
  name: 'search_wrongbook',
  description: '检索学生的历史错题记录。用于复习、查漏补缺、以及提醒"你以前在同类知识点上错过"。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词（知识点、题型）。留空则返回最近错题' },
      knowledgePoint: { type: 'string', description: '按知识点筛选' },
      reasonCategory: { type: 'string', description: '按错因类别筛选' },
      limit: { type: 'number', description: '返回条数，默认 8' },
    },
  },
  async run(args, ctx) {
    const all = ctx.wrongEntries || []
    if (!all.length) {
      return { label: '错题本为空', text: '学生还没有错题记录。可以在讲解错题后自动记录，也可以让学生手动添加。' }
    }
    const limit = Math.max(1, Math.min(30, num(args.limit, 8)))
    let rows = all
    if (args.knowledgePoint) {
      const kp = String(args.knowledgePoint)
      rows = rows.filter((r) => r.knowledgePoints.some((k) => k.includes(kp) || kp.includes(k)))
    }
    if (args.reasonCategory) rows = rows.filter((r) => r.reasonCategory === args.reasonCategory)
    if (args.query) {
      const q = String(args.query)
      const idx = new Bm25Index(
        rows.map((r) => ({
          id: r.id,
          docId: 'wb',
          docName: r.subject,
          idx: 0,
          text: `${r.question}\n${r.reason}\n${r.knowledgePoints.join(' ')}\n${r.myAnswer || ''}`,
          tokens: 0,
        })),
      )
      // enlarge the pool, then rank by BM25 so the model does not receive a
      // recency-ordered list that buries the actually relevant past mistakes
      const hits = idx.search(q, Math.min(rows.length, limit * 4), { minScore: 0.05 })
      const byId = new Map(rows.map((r) => [r.id, r]))
      rows = hits.map((h) => byId.get(h.id)!).filter(Boolean).slice(0, limit)
    } else {
      rows = [...rows].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
    }

    if (!rows.length) return { label: '未命中', text: '没有找到符合条件的错题记录。' }

    // aggregate so the model can see the weak-spot pattern without reading every row
    const reasonCount = new Map<string, number>()
    const kpCount = new Map<string, number>()
    for (const r of rows) {
      reasonCount.set(r.reasonCategory, (reasonCount.get(r.reasonCategory) || 0) + 1)
      for (const k of r.knowledgePoints) kpCount.set(k, (kpCount.get(k) || 0) + 1)
    }
    const topKp = [...kpCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    const topReason = [...reasonCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)

    const body = rows
      .slice(0, limit)
      .map(
        (r, i) =>
          `【错题 ${i + 1}】${r.subject}${r.chapter ? ` · ${r.chapter}` : ''} | 难度 ${r.difficulty}/5 | 错因类别：${r.reasonCategory} | 掌握度 ${r.mastery}/5 | 已复习 ${r.reviewCount} 次\n题干：${r.question.slice(0, 400)}\n学生的错解：${(r.myAnswer || '（未记录）').slice(0, 300)}\n正解要点：${(r.correctAnswer || '（未记录）').slice(0, 300)}\n错因：${r.reason.slice(0, 300)}\n知识点：${r.knowledgePoints.join('、')}`,
      )
      .join('\n\n')

    return {
      label: `错题 ${rows.length} 条`,
      text: `共匹配 ${rows.length} 条错题。\n\n薄弱知识点排行：${topKp.map(([k, n]) => `${k}(${n})`).join('、') || '—'}\n错因分布：${topReason.map(([k, n]) => `${k}(${n})`).join('、') || '—'}\n\n${body}\n\n请基于以上记录做针对性分析，注意指出重复出现的模式。`,
    }
  },
}

/* ------------------------------------------------------------------ */
/* add_wrongbook_entry                                                 */
/* ------------------------------------------------------------------ */
const addWrongTool: ToolDef = {
  name: 'add_wrongbook_entry',
  description: '把学生的错题记入错题本，包含错因、错解、正解、知识点归类。当学生自己做错了题时调用。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '题干' },
      myAnswer: { type: 'string', description: '学生的错误解答（原样保留）' },
      correctAnswer: { type: 'string', description: '正确解答（含关键步骤）' },
      reason: { type: 'string', description: '错因分析，一句话说清为什么会这样错' },
      reasonCategory: { type: 'string', enum: REASON_CATEGORIES as unknown as string[], description: '错因类别' },
      knowledgePoints: { type: 'array', items: { type: 'string' }, description: '涉及的知识点，2~5 个' },
      subject: { type: 'string', description: '科目' },
      chapter: { type: 'string', description: '章节' },
      difficulty: { type: 'number', description: '难度 1~5' },
      source: { type: 'string', description: '来源，如「2023 数一真题 T15」' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['question', 'reason', 'knowledgePoints'],
  },
  async run(args, ctx) {
    const reasonText = String(args.reason || '')
    const entry = await ctx.addWrongEntry({
      question: String(args.question || ''),
      myAnswer: args.myAnswer ? String(args.myAnswer) : undefined,
      correctAnswer: args.correctAnswer ? String(args.correctAnswer) : undefined,
      reason: reasonText,
      reasonCategory: (REASON_CATEGORIES.includes(args.reasonCategory) ? args.reasonCategory : activeReason(reasonText)) as any,
      knowledgePoints: (args.knowledgePoints || []).map(String).slice(0, 6),
      subject: args.subject ? String(args.subject) : ctx.settings?.study?.subject || '未分类',
      chapter: args.chapter ? String(args.chapter) : undefined,
      difficulty: Math.max(1, Math.min(5, num(args.difficulty, 3))) as any,
      source: args.source ? String(args.source) : undefined,
      tags: (args.tags || []).map(String),
    })
    return {
      label: '已记入错题本',
      text: `已记入错题本（ID ${entry.id}）。归类：${entry.reasonCategory}｜知识点：${entry.knowledgePoints.join('、')}。该错题已加入复习队列（下次复习 ${new Date(entry.nextReviewAt || Date.now()).toLocaleDateString('zh-CN')}）。请继续完成讲解，不要提及工具本身。`,
    }
  },
}

/* ------------------------------------------------------------------ */
/* add_flashcard                                                       */
/* ------------------------------------------------------------------ */
const addFlashcardTool: ToolDef = {
  name: 'add_flashcard',
  description: '生成背诵卡片加入间隔重复复习队列。一卡一知识点，问题要具体可自测。',
  parameters: {
    type: 'object',
    properties: {
      cards: {
        type: 'array',
        description: '卡片列表',
        items: {
          type: 'object',
          properties: {
            front: { type: 'string', description: '问题（正面）' },
            back: { type: 'string', description: '答案（背面），先给核心要点再展开' },
            subject: { type: 'string' },
            knowledgePoints: { type: 'array', items: { type: 'string' } },
          },
          required: ['front', 'back'],
        },
      },
    },
    required: ['cards'],
  },
  async run(args, ctx) {
    const cards = args.cards || []
    if (!cards.length) return { label: '无卡片', text: '没有提供卡片内容。' }
    let n = 0
    for (const c of cards) {
      if (!c?.front || !c?.back) continue
      await ctx.addFlashcard({
        front: String(c.front),
        back: String(c.back),
        subject: c.subject ? String(c.subject) : undefined,
        knowledgePoints: (c.knowledgePoints || []).map(String),
        source: 'agent',
      })
      n++
    }
    return {
      label: `生成 ${n} 张卡片`,
      text: `已生成 ${n} 张背诵卡片，进入间隔重复队列（1 天 → 2 天 → 4 天 → 7 天 → 15 天 → 30 天）。学生可在「背诵卡片」页复习。请简要说明卡片覆盖的知识点，不要在回复里重复列出全部卡片内容。`,
    }
  },
}

/* ------------------------------------------------------------------ */
/* save_study_plan                                                     */
/* ------------------------------------------------------------------ */
const savePlanTool: ToolDef = {
  name: 'save_study_plan',
  description:
    '把学习计划以新命名方案保存到时间规划方案库，不覆盖或切换当前计划。学生需在规划页手动启用后才会收到提醒。mode=unified 每日统一作息；mode=workday 工作日/休息日分开；mode=weekly 按周一到周日分别设置。',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['unified', 'workday', 'weekly'] },
      items: {
        type: 'array',
        description: '统一作息的时段列表（mode=unified 时使用）',
        items: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'HH:MM' },
            end: { type: 'string', description: 'HH:MM' },
            title: { type: 'string' },
            kind: { type: 'string', enum: ['study', 'break', 'meal', 'exercise', 'sleep', 'class', 'review', 'other'] },
            subject: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['start', 'title'],
        },
      },
      workItems: { type: 'array', description: '工作日时段（mode=workday）', items: { type: 'object' } },
      restItems: { type: 'array', description: '休息日时段（mode=workday）', items: { type: 'object' } },
      weeklyItems: {
        type: 'object',
        description: 'mode=weekly：{"1": [...周一], "2": [...], ..., "7": [...]}',
      },
      workdays: { type: 'array', items: { type: 'number' }, description: '哪些天算工作日，默认 [1,2,3,4,5]' },
      notify: { type: 'boolean', description: '是否开启到时提醒，默认 true' },
      name: { type: 'string', description: '计划名称' },
    },
    required: ['mode'],
  },
  async run(args, ctx) {
    const norm = (list: any[]) =>
      (list || []).map((it) => ({
        id: uid('pi'),
        start: String(it.start || '08:00'),
        end: String(it.end || ''),
        title: String(it.title || '学习'),
        kind: it.kind || 'study',
        subject: it.subject ? String(it.subject) : undefined,
        note: it.note ? String(it.note) : undefined,
        remind: it.remind !== false,
      }))
    const mode = args.mode || 'unified'
    const schedule: PlanSchedule = {
      version: 1,
      mode,
      unified: norm(args.items),
      workday: { work: norm(args.workItems || args.items), rest: norm(args.restItems) },
      weekly: Object.fromEntries(Object.entries(args.weeklyItems || {}).map(([k, v]) => [k, norm(v as any[])])),
      workdays: (args.workdays || [1, 2, 3, 4, 5]).map((n: any) => num(n, 1)),
      activeDays: [1, 2, 3, 4, 5, 6, 7],
      name: String(args.name || '').trim() || '研来生成的学习计划',
      updatedAt: Date.now(),
    }
    await ctx.savePlan(schedule)
    const count =
      mode === 'unified'
        ? schedule.unified.length
        : mode === 'workday'
          ? schedule.workday.work.length + schedule.workday.rest.length
          : Object.values(schedule.weekly).reduce((n, v) => n + (v?.length || 0), 0)
    return {
      label: '计划已存入方案库',
      text: `学习计划「${schedule.name}」已作为新方案保存到时间规划方案库：模式「${mode === 'unified' ? '每日统一作息' : mode === 'workday' ? '工作日/休息日分开' : '按周规划'}」，共 ${count} 个时段。当前启用的计划保持不变，新方案尚未启用，也不会自动触发提醒。学生可点击左侧「时间规划」选择此方案，微调并手动启用；提醒是否开启以应用设置为准。请简要概括计划结构与执行要点，不要逐条罗列所有时段。`,
    }
  },
}

/* ------------------------------------------------------------------ */
/* save_knowledge_note                                                 */
/* ------------------------------------------------------------------ */
const saveKnowledgeTool: ToolDef = {
  name: 'save_knowledge_note',
  description: '把整理出的知识点/大纲存为知识库文档，便于后续检索与复习。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '文档名称' },
      content: { type: 'string', description: '内容（Markdown）' },
      subject: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['name', 'content'],
  },
  async run(args, ctx) {
    const doc = await ctx.saveKnowledgeNote(String(args.name || '知识笔记'), String(args.content || ''), (args.tags || []).map(String), args.subject)
    return {
      label: '已存入知识库',
      text: `已将「${doc.name}」存入知识库（${doc.chunkCount} 个片段，${doc.chars} 字），后续提问时可被检索到。请简要说明已保存，不要重复输出全文。`,
    }
  },
}

/* ------------------------------------------------------------------ */
/* registry                                                            */
/* ------------------------------------------------------------------ */
export const ALL_TOOLS: ToolDef[] = [
  plotFunction,
  calculator,
  writeDocument,
  readFileTool,
  listWorkspaceTool,
  searchKbTool,
  searchWrongTool,
  addWrongTool,
  addFlashcardTool,
  savePlanTool,
  saveKnowledgeTool,
]

export const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]))

/** Look up tools by name and convert to the wire format. */
export function toolsFor(names: string[]) {
  return names
    .map((n) => TOOL_MAP.get(n))
    .filter(Boolean)
    .map((t) => ({
      type: 'function' as const,
      function: { name: t!.name, description: t!.description, parameters: t!.parameters },
    }))
}

export async function executeTool(name: string, args: any, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOL_MAP.get(name)
  if (!tool) return { label: '未知工具', text: `不存在名为 ${name} 的工具。请改用其他方式回答。` }
  try {
    return await tool.run(args || {}, ctx)
  } catch (e: any) {
    return { label: '工具出错', text: `工具 ${name} 执行失败：${e?.message || e}。请说明情况并用你自己的知识继续作答。` }
  }
}

/* ------------------------------------------------------------------ */
/* deterministic post-processing: auto-log real mistakes               */
/* ------------------------------------------------------------------ */
const MISTAKE_HINT = /(我(做|选|写|算)错了|做错|错了|不对吧|为什么(我)?(做|选)错|答案是.{0,12}(我|却)|应该是.{0,12}但我|帮我(看|分析).{0,6}错|错题)/

/**
 * Heuristic: has the student just submitted their own attempt that looks wrong?
 * Runs locally so we never spend a request deciding this. Only a hint — the
 * model still decides whether to call add_wrongbook_entry.
 */
export function looksLikeMistakeReport(text: string) {
  const t = String(text || '')
  if (t.length < 12) return false
  if (MISTAKE_HINT.test(t)) return true
  // "my answer is X, correct answer is Y" pattern
  return /(我的|我算|我选|我解)[\s\S]{0,60}(正确|答案|标准答案)[\s\S]{0,60}/.test(t)
}
