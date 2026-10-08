/**
 * Local mock of an OpenAI-compatible endpoint, used to exercise the full
 * agent loop (streaming text, tool calls, reasoning) without a real API key.
 *
 *   node scripts/mock-server.mjs [port]
 *
 * Point the app's Base URL at http://127.0.0.1:8899/v1 and use any model name.
 *
 * The behaviour is keyword-driven so specific paths can be verified:
 *   含「画图」/「函数」 → calls plot_function
 *   含「导出」/「讲义」 → calls write_document
 *   含「错题」         → calls add_wrongbook_entry
 *   含「卡片」         → calls add_flashcard
 *   含「知识库」       → calls search_knowledge_base
 *   含「推理」         → streams reasoning_content first
 *   otherwise          → a short markdown+KaTeX answer
 */
import http from 'node:http'

const PORT = Number(process.argv[2] || 8899)

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

/** Split text into small chunks so the client's incremental parsing is tested. */
function* chunks(s) {
  const size = 6
  for (let i = 0; i < s.length; i += size) yield s.slice(i, i + size)
}

const DEMO_ANSWER = `## 解题思路

这道题的核心是**等价无穷小替换的适用条件**。

先看整体判断：当 $x \\to 0$ 时，$\\sin x \\sim x$，但分子是 $\\sin x - x$，属于两个等价量相减。

$$\\lim_{x \\to 0} \\frac{\\sin x - x}{x^3}$$

因为 $\\sin x - x = -\\frac{x^3}{6} + o(x^3)$，所以

$$\\lim_{x \\to 0} \\frac{-x^3/6 + o(x^3)}{x^3} = -\\frac{1}{6}$$

> 关键易错点：等价无穷小替换不能在加减法中随意使用，否则会得到 $0$ 这个错误答案。

### 易错提醒

| 错误做法 | 结果 | 为什么错 |
|---|---|---|
| 直接替换 $\\sin x \\to x$ | $0$ | 减法中丢失了高阶项 |
| 使用洛必达 | 需要多次求导 | 可行但繁琐，且容易算错 |

### 变式检验

请自己先做：求 $\\lim_{x \\to 0} \\dfrac{\\tan x - x}{x^3}$。

答案：$\\dfrac{1}{3}$。提示：用 $\\tan x = x + \\frac{x^3}{3} + o(x^3)$。`

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-tutor', object: 'model' }, { id: 'mock-reasoner', object: 'model' }] }))
    return
  }

  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', async () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {}
      const msgs = parsed.messages || []
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      const userText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '')
      const hasToolResult = msgs.some((m) => m.role === 'tool')

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      const model = parsed.model || 'mock-tutor'
      const id = `chatcmpl-${Date.now()}`
      const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }

      const emitText = async (text) => {
        for (const piece of chunks(text)) {
          sse(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
          await new Promise((r) => setTimeout(r, 12))
        }
      }

      // ---- decide a tool call for this turn ----
      let tool = null
      if (!hasToolResult) {
        if (/画图|函数|图像|曲线/.test(userText)) {
          tool = { name: 'plot_function', args: { curves: [{ expr: 'sin(x)/x', label: 'sin(x)/x' }], xRange: [-15, 15], title: 'sin(x)/x 图像' } }
        } else if (/导出|讲义|文档/.test(userText)) {
          tool = { name: 'write_document', args: { title: '研来测试讲义', format: 'docx', markdown: '# 测试讲义\n\n这是由 mock 服务生成的测试文档。\n\n## 公式\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$' } }
        } else if (/错题/.test(userText)) {
          tool = { name: 'add_wrongbook_entry', args: { question: '求 lim(sin x - x)/x^3', myAnswer: '用等价无穷小得 0', correctAnswer: '-1/6', reason: '在减法中错误使用等价无穷小替换', reasonCategory: '概念不清', knowledgePoints: ['等价无穷小替换条件', '泰勒展开'], difficulty: 4, subject: '数学一' } }
        } else if (/卡片/.test(userText)) {
          tool = { name: 'add_flashcard', args: { cards: [{ front: '洛必达法则的三个使用条件？', back: '1. 0/0 或 ∞/∞ 型；2. 分子分母可导；3. 导数之比的极限存在或为无穷。', knowledgePoints: ['洛必达法则'] }] } }
        } else if (/知识库/.test(userText)) {
          tool = { name: 'search_knowledge_base', args: { query: userText.slice(0, 40) } }
        } else if (/计算|算一下/.test(userText)) {
          tool = { name: 'calculator', args: { action: 'derivative', expr: 'x^3 - 3*x + 1', variable: 'x' } }
        }
      }

      if (tool) {
        if (parsed.tools?.length) {
          await emitText('我先读取一下相关信息。')
          sse(res, {
            ...base,
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] },
                finish_reason: null,
              },
            ],
          })
          sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        } else {
          await emitText(DEMO_ANSWER)
          sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        }
        sse(res, { ...base, choices: [], usage: { prompt_tokens: 812, completion_tokens: 233, total_tokens: 1045 } })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // ---- plain answer, with optional reasoning stream ----
      if (/推理/.test(userText) || model.includes('reason')) {
        for (const piece of chunks('让我先分析一下这个问题的结构……关键是把条件转化成形如 f(x)=g(x) 的方程，再讨论根的个数。')) {
          sse(res, { ...base, choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }] })
          await new Promise((r) => setTimeout(r, 16))
        }
      }
      await emitText(DEMO_ANSWER)
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      sse(res, { ...base, choices: [], usage: { prompt_tokens: 640, completion_tokens: 412, total_tokens: 1052 } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${req.url}` } }))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock OpenAI-compatible server on http://127.0.0.1:${PORT}/v1`)
  console.log('models: mock-tutor, mock-reasoner')
  console.log('keywords: 画图 / 导出 / 错题 / 卡片 / 知识库 / 计算 / 推理')
})
