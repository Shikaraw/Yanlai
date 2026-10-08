/** Ad-hoc harness: exercises DOCX / PDF / HTML export against the real libs. */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const docs = require('../electron/lib/docs.cjs')

const BT = String.fromCharCode(92) // backslash, kept explicit to avoid escape confusion
const MD = [
  '# 研来测试讲义',
  '',
  '## 一、中值定理',
  '',
  `**罗尔定理**：若 $f(x)$ 在 $[a,b]$ 连续、在 $(a,b)$ 可导且 $f(a)=f(b)$，则存在 $${BT}xi$ 使 $f'(${BT}xi)=0$。`,
  '',
  '### 使用条件',
  '',
  '- 闭区间连续',
  '- 开区间可导',
  '- 端点值相等',
  '',
  '> 三个条件缺一不可。',
  '',
  '## 二、公式表',
  '',
  '| 定理 | 条件 | 结论 |',
  '|---|---|---|',
  "| 罗尔 | f(a)=f(b) | f'(ξ)=0 |",
  "| 拉格朗日 | 连续可导 | f(b)-f(a)=f'(ξ)(b-a) |",
  '',
  '```python',
  'def f(x):',
  '    return x ** 2 - 4',
  '```',
  '',
  '## 三、积分',
  '',
  `$$${BT}int_0^1 x^2 ${BT}, dx = ${BT}frac{1}{3}$$`,
  '',
  '---',
  '',
  '结束。',
  '',
].join('\n')

/** Pull text out of a docx (it is a zip; word/document.xml holds the runs). */
function extractDocxText(buf) {
  const zlib = require('node:zlib')
  let offset = 0
  while (offset < buf.length - 4) {
    if (buf.readUInt32LE(offset) === 0x04034b50) {
      const method = buf.readUInt16LE(offset + 8)
      const compSize = buf.readUInt32LE(offset + 18)
      const nameLen = buf.readUInt16LE(offset + 26)
      const extraLen = buf.readUInt16LE(offset + 28)
      const name = buf.slice(offset + 30, offset + 30 + nameLen).toString('utf8')
      const dataStart = offset + 30 + nameLen + extraLen
      if (name === 'word/document.xml') {
        const raw = buf.slice(dataStart, dataStart + compSize)
        const xml = method === 8 ? zlib.inflateRawSync(raw).toString('utf8') : raw.toString('utf8')
        return xml.replace(/<[^>]+>/g, '')
      }
      offset = dataStart + compSize
    } else {
      offset++
    }
  }
  return ''
}

app.whenReady().then(async () => {
  // keep at least one window alive: exportPdf creates+destroys a hidden window,
  // and with none left Electron fires window-all-closed and quits the process
  const keepAlive = new BrowserWindow({ show: false })
  const out = path.join(os.tmpdir(), 'yanlai-doc-test')
  fs.mkdirSync(out, { recursive: true })
  let failed = 0
  const ok = (name, cond, extra = '') => {
    console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${extra}`}`)
    if (!cond) failed++
  }

  // ---- block parsing ----
  const blocks = docs.mdToBlocks(MD)
  const kinds = blocks.map((b) => b.type)
  ok('parses headings', kinds.includes('h'))
  ok('parses lists', kinds.includes('list'))
  ok('parses quote', kinds.includes('quote'))
  ok('parses table', kinds.includes('table'))
  ok('parses code fence', kinds.includes('code'))
  ok('parses hr', kinds.includes('hr'))
  ok('parses paragraphs', kinds.includes('p'))
  const table = blocks.find((b) => b.type === 'table')
  ok('table has 3 header cells', table && table.head.length === 3, JSON.stringify(table && table.head))
  ok('table has 2 body rows', table && table.rows.length === 2)
  const list = blocks.find((b) => b.type === 'list')
  ok('list has 3 items', list && list.items.length === 3)

  // ---- inline runs ----
  const runs = docs.splitInline('普通 **加粗** 和 `代码` 与 *斜体*')
  ok('bold run detected', runs.some((r) => r.bold && r.text === '加粗'))
  ok('code run detected', runs.some((r) => r.code && r.text === '代码'))
  ok('italic run detected', runs.some((r) => r.italics && r.text === '斜体'))

  // ---- docx ----
  try {
    const buf = await docs.markdownToDocxBuffer({ title: '研来测试讲义', markdown: MD })
    const docxPath = path.join(out, 'test.docx')
    fs.writeFileSync(docxPath, buf)
    ok('docx is a zip (PK header)', buf[0] === 0x50 && buf[1] === 0x4b)
    ok('docx is non-trivial in size', buf.length > 5000, `${buf.length} bytes`)
    const text = extractDocxText(buf)
    ok('docx contains the title', text.includes('研来测试讲义'))
    ok('docx contains Chinese body text', text.includes('罗尔定理'))
    ok('docx contains list items', text.includes('闭区间连续'))
    ok('docx contains table cells', text.includes('拉格朗日'))
    ok('docx contains code', text.includes('return x'))
    ok('docx preserves math as text', text.includes('int_0^1'))
    console.log(`    → ${docxPath} (${(buf.length / 1024).toFixed(1)} KB)`)
  } catch (e) {
    ok('docx generation', false, e.message)
  }

  // ---- pdf ----
  try {
    const pdfPath = path.join(out, 'test.pdf')
    await docs.exportPdf({ title: '研来测试讲义', markdown: MD, outPath: pdfPath })
    const buf = fs.readFileSync(pdfPath)
    ok('pdf has %PDF header', buf.slice(0, 5).toString() === '%PDF-')
    ok('pdf is non-trivial in size', buf.length > 3000, `${buf.length} bytes`)
    ok('pdf has EOF marker', buf.slice(-2048).toString('latin1').includes('%%EOF'))
    console.log(`    → ${pdfPath} (${(buf.length / 1024).toFixed(1)} KB)`)
  } catch (e) {
    ok('pdf generation', false, e.message)
  }

  // ---- html ----
  const html = docs.buildPrintHtml({ title: '研来测试讲义', markdown: MD })
  ok('html includes content', html.includes('罗尔定理'))
  ok('html has print styles', html.includes('@page'))
  ok('html escapes title', docs.buildPrintHtml({ title: '<script>x</script>', markdown: 'x' }).includes('&lt;script&gt;'))

  // ---- edge cases ----
  try {
    const empty = await docs.markdownToDocxBuffer({ title: '空', markdown: '' })
    ok('empty markdown still produces a docx', empty.length > 500)
  } catch (e) {
    ok('empty markdown handled', false, e.message)
  }
  try {
    const weird = await docs.markdownToDocxBuffer({
      title: '怪',
      markdown: '# 未闭合 **加粗\n\n| 只有表头 |\n|---|\n\n```\n未闭合代码',
    })
    ok('malformed markdown does not throw', weird.length > 500)
  } catch (e) {
    ok('malformed markdown handled', false, e.message)
  }
  const xss = docs.buildPrintHtml({ title: 'x', markdown: '<img src=x onerror=alert(1)>' })
  // escaped output keeps the text but neutralises it: the tag must not survive as markup
  ok('raw HTML in markdown is escaped', !/<img\s/.test(xss) && xss.includes('&lt;img'))

  console.log(failed ? `\n✗ ${failed} failed` : '\n✓ all export checks passed')
  app.exit(failed ? 1 : 0)
})
