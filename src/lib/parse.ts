/**
 * Document text extraction.
 *
 * Heavy parsers are dynamically imported so a user who only chats never pays
 * for pdf.js or SheetJS in their initial bundle.
 */

export interface ParsedDoc {
  text: string
  pages?: number
  sheets?: string[]
  meta?: Record<string, any>
  /** extraction warning, e.g. scanned PDF with no text layer */
  warning?: string
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64)
  const len = bin.length
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i)
  return out
}

/* ------------------------------- PDF ------------------------------- */
let pdfWorkerReady: Promise<any> | null = null
async function getPdfjs() {
  if (!pdfWorkerReady) {
    pdfWorkerReady = (async () => {
      const pdfjs: any = await import('pdfjs-dist')
      try {
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      } catch {
        // worker unavailable (e.g. browser preview) — pdf.js falls back to main thread
      }
      return pdfjs
    })()
  }
  return pdfWorkerReady
}

export async function parsePdfBase64(b64: string): Promise<ParsedDoc> {
  const pdfjs = await getPdfjs()
  const data = base64ToUint8(b64)
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise
  const out: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    let line = ''
    let lastY: number | null = null
    const parts: string[] = []
    for (const item of content.items as any[]) {
      if (!('str' in item)) continue
      const y = item.transform?.[5]
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) {
        parts.push(line)
        line = ''
      }
      line += item.str
      if (item.hasEOL) {
        parts.push(line)
        line = ''
      }
      lastY = y ?? lastY
    }
    if (line) parts.push(line)
    const text = parts.join('\n').replace(/[ \t]{2,}/g, ' ')
    out.push(`\n\n【第 ${p} 页】\n${text}`)
  }
  const text = out.join('\n')
  const warning = text.replace(/【第 \d+ 页】/g, '').trim().length < 40 ? '该 PDF 可能是扫描件，未提取到文字层。可考虑使用 OCR 工具转换后再导入。' : undefined
  return { text, pages: doc.numPages, warning, meta: { title: doc.getMetadata ? (await doc.getMetadata().catch(() => null))?.info?.Title : undefined } }
}

/* ------------------------------- DOCX ------------------------------ */
export async function parseDocxBase64(b64: string): Promise<ParsedDoc> {
  const mammoth: any = await import('mammoth')
  const arr = base64ToUint8(b64)
  const res = await mammoth.extractRawText({ arrayBuffer: arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) })
  return { text: res.value || '', meta: { messages: res.messages?.length || 0 } }
}

/* ------------------------------- XLSX ------------------------------ */
export async function parseXlsxBase64(b64: string): Promise<ParsedDoc> {
  const XLSX: any = await import('xlsx')
  const arr = base64ToUint8(b64)
  const wb = XLSX.read(arr, { type: 'array', cellDates: true })
  const sheets: string[] = wb.SheetNames || []
  const parts: string[] = []
  for (const name of sheets) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false })
    parts.push(`\n\n【工作表：${name}】\n${csv}`)
  }
  return { text: parts.join('\n'), sheets }
}

/* ------------------------------- router ---------------------------- */
export function extOf(nameOrPath: string) {
  const m = /\.([a-z0-9]+)$/i.exec(String(nameOrPath || ''))
  return (m?.[1] || '').toLowerCase()
}

export async function parseFile(
  filePath: string,
  readBase64: (p: string) => Promise<{ data: string; size: number } | null>,
  readText: (p: string) => Promise<string>,
): Promise<ParsedDoc> {
  const ext = extOf(filePath)
  if (['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'tex', 'html', 'htm', 'xml', 'yaml', 'yml'].includes(ext)) {
    const text = await readText(filePath)
    return { text }
  }
  const b = await readBase64(filePath)
  if (!b) throw new Error('无法读取文件内容')
  switch (ext) {
    case 'pdf':
      return parsePdfBase64(b.data)
    case 'docx':
    case 'doc':
      return parseDocxBase64(b.data)
    case 'xlsx':
    case 'xls':
    case 'xlsm':
      return parseXlsxBase64(b.data)
    default:
      // unknown binary: refuse rather than import garbage
      throw new Error(`暂不支持的文件类型 .${ext}`)
  }
}

/** Build an OCR-free image attachment: the vision model reads it at chat time. */
export function isImage(ext: string) {
  return ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'].includes(ext)
}
