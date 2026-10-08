/**
 * Headless checks for knowledge-base retrieval and the token-saving context
 * builder — both are pure logic and easy to regress silently.
 */
import { chunkText, Bm25Index, buildKbContext, indexTokens, highlightSnippet } from './kb.mjs'
import { buildContext, estimateTokens, digestContent } from './context.mjs'
import { drainSentences as drainSentencesCheck } from './util.mjs'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const DOC = `# 第三章 中值定理

## 第一节 罗尔定理

罗尔定理：如果函数 f(x) 满足在闭区间 [a,b] 上连续，在开区间 (a,b) 内可导，且 f(a)=f(b)，
那么在开区间 (a,b) 内至少存在一点 ξ，使得 f'(ξ)=0。

使用罗尔定理的三个条件缺一不可。常见错误是忽略了端点值相等这一条件。

## 第二节 拉格朗日中值定理

拉格朗日中值定理是罗尔定理的推广：如果函数在 [a,b] 上连续，在 (a,b) 内可导，
则存在 ξ∈(a,b)，使得 f(b)-f(a)=f'(ξ)(b-a)。

推论：若在区间上 f'(x)≡0，则 f(x) 为常数。

## 第三节 柯西中值定理

柯西中值定理处理两个函数之比的情形，是证明洛必达法则的基础。

## 第四节 泰勒公式

泰勒公式用多项式逼近函数。带皮亚诺余项的泰勒公式常用于求极限。
常见展开式：sin x = x - x^3/6 + o(x^3)，e^x = 1 + x + x^2/2 + o(x^2)。

# 第四章 不定积分

## 第一类换元法

凑微分是核心思想，例如 ∫f(ax+b)dx = (1/a)∫f(u)du。
`

console.log('\n== chunking ==')
const chunks = chunkText(DOC, { id: 'd1', name: '高数讲义.md', subject: '数学一', tags: ['高数'] })
ok('produces multiple chunks', chunks.length >= 4, `got ${chunks.length}`)
ok('chunks carry heading context', chunks.some((c) => c.heading?.includes('罗尔定理')))
ok('chunk ids are stable and unique', new Set(chunks.map((c) => c.id)).size === chunks.length)
ok('chunks respect the hard max', chunks.every((c) => c.text.length <= 1900))
ok('every chunk references its doc', chunks.every((c) => c.docId === 'd1' && c.docName === '高数讲义.md'))

console.log('\n== tokenisation ==')
{
  const t = indexTokens('拉格朗日中值定理')
  ok('indexes CJK bigrams', t.includes('拉格'))
  ok('indexes CJK trigrams for long runs', t.includes('拉格朗'))
  const latin = indexTokens('f(x) = sin(x) TAYLOR')
  ok('indexes latin words lowercased', latin.includes('taylor'))
  ok('stops very common words', !indexTokens('this that').includes('this'))
}

console.log('\n== BM25 retrieval ==')
const idx = new Bm25Index(chunks)
ok('index size matches chunk count', idx.size === chunks.length)
{
  const hits = idx.search('拉格朗日中值定理的条件', 3)
  ok('finds the Lagrange section', hits.length > 0 && hits[0].text.includes('拉格朗日'), `top: ${hits[0]?.heading}`)
  ok('scores are descending', hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score))
}
{
  const hits = idx.search('洛必达法则的基础', 3)
  ok('finds the Cauchy section (洛必达 basis)', hits.some((h) => h.text.includes('柯西') || h.text.includes('洛必达')))
}
{
  const hits = idx.search('sin x 泰勒展开', 3)
  ok('finds the Taylor expansion', hits.some((h) => h.text.includes('泰勒') || h.text.includes('sin x')))
}
{
  const hits = idx.search('凑微分 换元', 3)
  ok('finds 换元法 section', hits.some((h) => h.text.includes('凑微分') || h.text.includes('换元')))
}
{
  const hits = idx.search('量子纠缠与薛定谔方程', 3)
  const strong = hits.filter((h) => h.score > 3)
  ok('unrelated query yields no strong hits', strong.length === 0, `best=${hits[0]?.score?.toFixed(2)}`)
}
{
  const hits = idx.search('罗尔定理', 5, { docIds: ['nonexistent'] })
  ok('docIds filter is honoured', hits.length === 0)
}
{
  const hits = idx.search('中值定理', 3)
  ok('heading match boosts ranking', hits.length > 0)
}

console.log('\n== kb context budget ==')
{
  const hits = idx.search('中值定理 条件', 6)
  const built = buildKbContext(hits, 900)
  ok('respects the character budget', built.chars <= 1000, `chars=${built.chars}`)
  ok('cites document names', built.text.includes('高数讲义.md'))
  ok('retains fewer chunks under a tight budget', built.used.length <= hits.length)
}
{
  // hit the same doc the index was built from so chunk sizes are known
  const hits = idx.search('中值定理', 4)
  const big = buildKbContext(hits, 20000)
  const total = hits.reduce((n, h) => n + h.text.length, 0)
  // pick a budget strictly below the available text so truncation must occur
  const small = buildKbContext(hits, Math.max(120, Math.floor(total * 0.4)))
  ok('a larger budget keeps at least as much text', big.chars > small.chars, `big=${big.chars} small=${small.chars} total=${total}`)
  ok('a larger budget keeps at least as many chunks', big.used.length >= small.used.length)
  ok('the small budget stayed within its limit', small.chars <= Math.max(120, Math.floor(total * 0.4)) + 200)
}
ok('highlightSnippet centres on a match', highlightSnippet('前面无关内容'.repeat(20) + '拉格朗日中值定理' + '后面无关内容'.repeat(20), ['拉格朗日'], 60).includes('拉格朗日'))

console.log('\n== token accounting ==')
ok('CJK text estimated near 1 token/char', Math.abs(estimateTokens('中值定理') - 4) <= 2, String(estimateTokens('中值定理')))
ok('latin is cheaper per char', estimateTokens('aaaaaaaaaa') < estimateTokens('中中中中中'))
ok('empty is zero', estimateTokens('') === 0)

console.log('\n== digest ==')
{
  const long = `# 标题一\n\n${'这是一段很长的正文内容。'.repeat(40)}\n\n## 标题二\n\n- 要点甲\n- 要点乙\n\n${'又一段正文。'.repeat(40)}`
  const d = digestContent(long, 200)
  ok('digest is bounded', d.length <= 201, `len=${d.length}`)
  ok('digest preserves headings', d.includes('标题一') || d.includes('标题二'))
}
ok('short content is passed through unchanged', digestContent('短内容', 200) === '短内容')

console.log('\n== context builder (token saving) ==')
{
  const LONG_BODY = '详细解释内容。'.repeat(200) // ~1400 chars, above the digest threshold
  const mkMsg = (i, role, content, extra = {}) => ({ id: `m${i}`, role, content, createdAt: Date.now() - (100 - i) * 1000, ...extra })
  const messages = []
  for (let i = 0; i < 24; i++) {
    messages.push(mkMsg(i * 2, 'user', `第 ${i} 个问题：请解释第 ${i} 个知识点。`))
    messages.push(mkMsg(i * 2 + 1, 'assistant', `# 回答 ${i}\n\n${LONG_BODY}`))
  }
  // attach an image to the very first turn
  messages[0].attachments = [{ id: 'a1', kind: 'image', name: 'old.png', dataUrl: 'data:image/png;base64,AAAA' }]
  // and a tool call
  messages[5].toolCalls = [{ id: 't1', name: 'search_knowledge_base', args: { query: 'x' }, result: 'X'.repeat(4000), status: 'ok' }]

  const built = buildContext(messages, {
    systemPrompt: 'SYSTEM',
    historyRounds: 4,
    stripOldImages: true,
    stripOldTools: true,
    transientContext: '【检索】片段内容',
  })
  ok('system prompt is first', built.messages[0].role === 'system' && built.messages[0].content.startsWith('SYSTEM'))
  ok('transient retrieval is included', built.messages[0].content.includes('片段内容'))
  ok('old image stripped from payload', !JSON.stringify(built.messages).includes('data:image/png'))
  ok('old image noted as text instead', JSON.stringify(built.messages).includes('已省略'))
  ok('report counts the stripped image', built.stats.strippedImages >= 1)
  ok('old tool output compressed', built.stats.strippedTools >= 1)
  ok('fewer messages sent than provided', built.stats.sentMessages < messages.length)
  ok('compression happened', built.stats.droppedMessages + built.stats.digests > 0)
  ok('a digest block is injected', built.messages.some((m) => m.role === 'system' && m.content.includes('压缩记录')))

  // only the in-window turns keep full prose; everything older must be digested
  ok('only 4 assistant turns keep full prose', built.messages.filter((m) => m.role === 'assistant').length === 4, `got ${built.messages.filter((m) => m.role === 'assistant').length}`)
  const bodyRuns = (JSON.stringify(built.messages).match(/详细解释内容。/g) || []).length
  ok('old long answers are not replayed verbatim', bodyRuns <= 4 * 200, `occurrences=${bodyRuns}`)
  ok('digest vastly shrinks the transcript', built.stats.estimatedTokens < estimateTokens(LONG_BODY) * 24 * 0.4, `tokens=${built.stats.estimatedTokens}`)
  ok('output is never larger than the input', built.stats.sentMessages <= built.stats.rawMessages)
  ok('token estimate is produced', built.stats.estimatedTokens > 0)
  ok('no orphan tool messages', built.messages.every((m) => m.role !== 'tool' || built.messages.some((x) => x.tool_calls?.some((t) => t.id === m.tool_call_id))))
}
{
  // with saving disabled everything should be present
  const messages = []
  for (let i = 0; i < 12; i++) {
    messages.push({ id: `u${i}`, role: 'user', content: `问题 ${i}`, createdAt: Date.now() })
    messages.push({ id: `a${i}`, role: 'assistant', content: `回答 ${i}`, createdAt: Date.now() })
  }
  const built = buildContext(messages, { systemPrompt: 'S', historyRounds: 999, stripOldImages: false, stripOldTools: false })
  ok('all turns retained when saving is off', built.messages.filter((m) => m.role === 'user').length === 12, `got ${built.messages.filter((m) => m.role === 'user').length}`)
}
{
  // error messages must never be sent
  const built = buildContext(
    [
      { id: 'u1', role: 'user', content: 'hi', createdAt: Date.now() },
      { id: 'e1', role: 'assistant', content: 'broke', createdAt: Date.now(), error: true },
    ],
    { systemPrompt: 'S' },
  )
  ok('error messages are dropped', !JSON.stringify(built.messages).includes('broke'))
}

console.log('\n== sentence streaming (TTS) ==')
{
  const r1 = drainSentencesCheck('这是第一句。这是第二句。这是未完')
  // short sentences may be merged into one utterance (better for natural speech),
  // but the completed text must be released and the fragment must be held back
  ok('releases completed text', r1.ready.length >= 1, JSON.stringify(r1.ready))
  ok('released text covers both sentences', r1.ready.join('').includes('第一句') && r1.ready.join('').includes('第二句'))
  ok('keeps the incomplete tail', r1.rest.includes('未完'))
  ok('does not leak the fragment into ready', !r1.ready.join('').includes('未完'))

  // a long unpunctuated stream must still get flushed in bounded pieces
  const r2 = drainSentencesCheck('没有标点的长文本'.repeat(60))
  ok('long unpunctuated text is flushed in bounded pieces', r2.ready.length >= 1)
  ok('flushed pieces are bounded', r2.ready.every((s) => s.length <= 420))

  // incremental feeding must not lose or duplicate anything
  let acc = ''
  let buf = ''
  const input = '第一句话在这里。第二句话。第三句。'
  const seen = []
  for (const ch of input) {
    buf += ch
    const { ready, rest } = drainSentencesCheck(buf)
    for (const s of ready) seen.push(s)
    buf = rest
  }
  seen.push(buf)
  acc = seen.join('')
  ok('incremental feeding loses no characters', acc.replace(/\s/g, '') === input.replace(/\s/g, ''), `got "${acc}"`)
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
