'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { BrowserWindow } = require('electron')

/* ------------------------------------------------------------------ *
 * Minimal Markdown -> DOCX. Deliberately not a full parser: it covers *
 * what study notes actually use (headings, lists, tables, code,       *
 * quotes, emphasis). Math stays as readable text.                     *
 * ------------------------------------------------------------------ */

function splitInline(text) {
  // returns [{text, bold, italics, code}]
  const out = []
  const re = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) })
    const tok = m[0]
    if (tok.startsWith('***')) out.push({ text: tok.slice(3, -3), bold: true, italics: true })
    else if (tok.startsWith('**')) out.push({ text: tok.slice(2, -2), bold: true })
    else if (tok.startsWith('`')) out.push({ text: tok.slice(1, -1), code: true })
    else out.push({ text: tok.slice(1, -1), italics: true })
    last = m.index + tok.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out.map((r) => ({ ...r, text: r.text.replace(/\\\$|\$\$/g, '') }))
}

function mdToBlocks(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0
  let para = []
  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'p', runs: splitInline(para.join(' ')) })
      para = []
    }
  }
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*```(\w*)/)
    if (fence) {
      i++
      const buf = []
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++])
      i++
      blocks.push({ type: 'code', text: buf.join('\n'), lang: fence[1] })
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      flushPara()
      blocks.push({ type: 'h', level: h[1].length, runs: splitInline(h[2]) })
      i++
      continue
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushPara()
      const ordered = /^\s*\d+\./.test(line)
      const items = []
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''))
        i++
      }
      blocks.push({ type: 'list', ordered, items: items.map(splitInline) })
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara()
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ type: 'quote', runs: splitInline(buf.join(' ')) })
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara()
      const cells = (l) =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim())
      const head = cells(lines[i])
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      blocks.push({ type: 'table', head, rows })
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara()
      blocks.push({ type: 'hr' })
      i++
      continue
    }
    if (!line.trim()) {
      flushPara()
      i++
      continue
    }
    para.push(line.trim())
    i++
  }
  flushPara()
  return blocks
}

async function markdownToDocxBuffer({ title, markdown }) {
  const docx = await import('docx')
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle } =
    docx
  const headings = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
  ]
  const runsOf = (runs, opts = {}) =>
    (runs || []).map(
      (r) =>
        new TextRun({
          text: r.text,
          bold: !!r.bold || !!opts.bold,
          italics: !!r.italics,
          font: r.code ? 'Consolas' : 'Times New Roman',
          size: opts.size || 24,
          color: r.code ? '8B5CF6' : undefined,
          shading: r.code ? { fill: 'F3F4F6' } : undefined,
        }),
    )
  const children = []
  if (title) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 },
        children: [new TextRun({ text: title, bold: true, size: 40, font: 'Microsoft YaHei' })],
      }),
    )
  }
  for (const b of mdToBlocks(markdown)) {
    if (b.type === 'h') {
      children.push(new Paragraph({ heading: headings[b.level] || HeadingLevel.HEADING_6, spacing: { before: 220, after: 120 }, children: runsOf(b.runs) }))
    } else if (b.type === 'p') {
      children.push(new Paragraph({ spacing: { after: 140, line: 320 }, children: runsOf(b.runs) }))
    } else if (b.type === 'quote') {
      children.push(
        new Paragraph({
          spacing: { after: 140 },
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: '22D3EE' } },
          children: runsOf(b.runs, { size: 22 }),
        }),
      )
    } else if (b.type === 'code') {
      for (const ln of b.text.split('\n')) {
        children.push(
          new Paragraph({
            spacing: { after: 0 },
            shading: { fill: 'F3F4F6' },
            children: [new TextRun({ text: ln || ' ', font: 'Consolas', size: 20 })],
          }),
        )
      }
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }))
    } else if (b.type === 'list') {
      b.items.forEach((item, idx) => {
        children.push(
          new Paragraph({
            spacing: { after: 60 },
            indent: { left: 420, hanging: 240 },
            children: [new TextRun({ text: b.ordered ? `${idx + 1}. ` : '•  ', bold: true }), ...runsOf(item)],
          }),
        )
      })
    } else if (b.type === 'table') {
      const mkCell = (text, bold) =>
        new TableCell({
          width: { size: Math.floor(100 / Math.max(1, b.head.length)), type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: runsOf(splitInline(text), { bold }) })],
        })
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ tableHeader: true, children: b.head.map((h) => mkCell(h, true)) }),
            ...b.rows.map((r) => new TableRow({ children: r.map((c) => mkCell(c, false)) })),
          ],
        }),
      )
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }))
    } else if (b.type === 'hr') {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1' } }, children: [] }))
    }
  }
  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Times New Roman', size: 24 } },
      },
    },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } }, children }],
  })
  return Packer.toBuffer(doc)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function buildPrintHtml({ title, markdown, html }) {
  const body = html || `<pre class="md">${escapeHtml(markdown || '')}</pre>`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title || '研来文档')}</title>
<style>
  @page { margin: 18mm 16mm; }
  body { font-family: "Times New Roman","Microsoft YaHei",serif; font-size: 12pt; line-height: 1.7; color:#111; }
  h1,h2,h3,h4 { font-family: "Microsoft YaHei",sans-serif; line-height:1.35; }
  h1 { font-size: 20pt; text-align:center; margin: 0 0 18pt; }
  h2 { font-size: 15pt; margin: 16pt 0 8pt; border-left: 4px solid #0ea5e9; padding-left: 8pt; }
  h3 { font-size: 13pt; margin: 12pt 0 6pt; }
  pre { background:#f5f6f8; padding:8pt; border-radius:4pt; font-family: Consolas, monospace; font-size:10pt; white-space: pre-wrap; }
  code { background:#f5f6f8; padding:1pt 3pt; border-radius:3pt; font-family: Consolas, monospace; font-size:10pt; }
  blockquote { border-left: 3px solid #94a3b8; margin: 8pt 0; padding: 2pt 10pt; color:#334155; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  th, td { border: 1px solid #cbd5e1; padding: 4pt 6pt; font-size: 10.5pt; }
  th { background:#eef2f7; }
  img { max-width: 100%; }
</style></head><body>${body}</body></html>`
}

async function exportPdf({ title, markdown, html, outPath }) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  })
  try {
    const doc = buildPrintHtml({ title, markdown, html })
    const tmp = path.join(require('node:os').tmpdir(), `yanlai-print-${Date.now()}.html`)
    fs.writeFileSync(tmp, doc, 'utf8')
    await win.loadFile(tmp)
    await new Promise((r) => setTimeout(r, 350))
    const data = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'default' },
      pageSize: 'A4',
    })
    fs.writeFileSync(outPath, data)
    try {
      fs.unlinkSync(tmp)
    } catch {}
    return outPath
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

module.exports = { markdownToDocxBuffer, exportPdf, buildPrintHtml, mdToBlocks, splitInline }
