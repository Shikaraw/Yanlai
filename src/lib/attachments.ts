/**
 * Attachment intake: clipboard paste, drag & drop, and file picking.
 *
 * Images are kept inline as data URLs (needed for vision input) but also
 * mirrored to disk so a long session does not hold everything in memory.
 * Text-like files are read once and stored as text so they can be re-sent
 * cheaply without re-parsing.
 */

import { bridge } from './bridge'
import { uid } from './util'
import { extOf, isImage } from './parse'
import type { Attachment } from './types'

const MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024
/** Beyond this, a text file is summarised to a head/tail excerpt. */
const MAX_TEXT_CHARS = 60000

function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result || ''))
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(file)
  })
}

function dataUrlToBase64(dataUrl: string) {
  const i = dataUrl.indexOf(',')
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl
}

export async function attachmentFromFile(file: File): Promise<Attachment | null> {
  const name = file.name || '粘贴的图片.png'
  const ext = extOf(name) || (file.type.startsWith('image/') ? file.type.split('/')[1] : 'bin')
  const image = isImage(ext) || file.type.startsWith('image/')

  if (image) {
    if (file.size > MAX_INLINE_IMAGE_BYTES) {
      // too big to inline: persist then reference by path
      const buf = await file.arrayBuffer()
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
      const saved = await bridge.attach.save(name, b64)
      return { id: uid('att'), kind: 'image', name, ext, mime: file.type, size: file.size, path: saved.file }
    }
    const dataUrl = await fileToDataUrl(file)
    // mirror to disk in the background so exports can reference a real file
    let path: string | undefined
    try {
      const saved = await bridge.attach.save(name, dataUrlToBase64(dataUrl))
      path = saved.file
    } catch {}
    return { id: uid('att'), kind: 'image', name, ext, mime: file.type, size: file.size, dataUrl, path }
  }

  // non-image: extract text so the model can actually use the content
  const ext2 = ext || 'bin'
  const textLike = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'tex', 'log', 'html', 'xml', 'yaml', 'yml'].includes(ext2)
  if (textLike) {
    const text = await file.text().catch(() => '')
    return {
      id: uid('att'),
      kind: 'file',
      name,
      ext: ext2,
      mime: file.type,
      size: file.size,
      text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n…（文件过长，已截断 ${text.length - MAX_TEXT_CHARS} 字）` : text,
    }
  }

  // binary documents (pdf/docx/xlsx): persist, then let the caller parse on demand
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  const saved = await bridge.attach.save(name, btoa(bin))
  if (!saved.ok) return null
  let text: string | undefined
  try {
    const { parseFile } = await import('./parse')
    const parsed = await parseFile(saved.file!, bridge.fs.readBase64, bridge.fs.readText)
    if (parsed.text) {
      text =
        parsed.text.length > MAX_TEXT_CHARS
          ? `${parsed.text.slice(0, MAX_TEXT_CHARS)}\n\n…（文档过长，已截断）`
          : parsed.text
    }
  } catch (e: any) {
    text = `（该文件无法在本机解析：${e?.message || e}。如果是扫描版 PDF，请改传图片，我会用视觉能力读取。）`
  }
  return { id: uid('att'), kind: 'file', name, ext: ext2, mime: file.type, size: file.size, path: saved.file, text }
}

/** Collect every file from a drop/paste event, flattened. */
export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const out: File[] = []
  if (dt.items?.length) {
    for (const it of Array.from(dt.items)) {
      if (it.kind === 'file') {
        const f = it.getAsFile()
        if (f) out.push(f)
      }
    }
  }
  if (!out.length && dt.files?.length) out.push(...Array.from(dt.files))
  return out
}

export function filesFromPaths(paths: string[]): Array<{ path: string; name: string }> {
  return paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() || p }))
}

/** Build an attachment from a known filesystem path (used by the file picker). */
export async function attachmentFromPath(path: string): Promise<Attachment | null> {
  const name = path.split(/[\\/]/).pop() || path
  const ext = extOf(name)
  const stat = await bridge.fs.stat(path)
  if (isImage(ext)) {
    const b = await bridge.fs.readBase64(path)
    if (!b) return null
    const mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`
    const dataUrl = b.size <= MAX_INLINE_IMAGE_BYTES ? `data:${mime};base64,${b.data}` : undefined
    return { id: uid('att'), kind: 'image', name, ext, mime, size: b.size, path, dataUrl }
  }
  try {
    const { parseFile } = await import('./parse')
    const parsed = await parseFile(path, bridge.fs.readBase64, bridge.fs.readText)
    const text =
      parsed.text.length > MAX_TEXT_CHARS ? `${parsed.text.slice(0, MAX_TEXT_CHARS)}\n\n…（已截断）` : parsed.text
    return { id: uid('att'), kind: 'file', name, ext, size: stat?.size, path, text }
  } catch (e: any) {
    return { id: uid('att'), kind: 'file', name, ext, size: stat?.size, path, text: `（解析失败：${e?.message || e}）` }
  }
}

export function totalAttachmentSize(atts: Attachment[]) {
  return atts.reduce((n, a) => n + (a.size || 0), 0)
}
