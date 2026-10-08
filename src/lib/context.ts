/**
 * Token-saving context construction.
 *
 * The expensive part of a long tutoring session is re-sending the whole
 * transcript every turn. We attack that on five fronts, none of which changes
 * what the student sees:
 *
 *  1. TRANSIENT INJECTIONS — retrieved knowledge-base chunks, workspace file
 *     listings and wrongbook hits are injected as a system message for the
 *     current turn only. They are never written back into history, so a 40-turn
 *     conversation pays for a retrieval once, not forty times.
 *  2. IMAGE DECAY — screenshots only stay in the payload for the most recent
 *     turns. Older images are replaced by a textual placeholder, because the
 *     model has already extracted whatever it needed from them.
 *  3. TOOL RESULT DECAY — raw tool output (often thousands of characters of
 *     JSON) collapses to a one-line digest plus any artifact references once it
 *     is out of the recent window.
 *  4. EXTRACTIVE DIGEST — turns older than `historyRounds` are compressed
 *     locally (headings + topic sentences), not by a paid summarisation call.
 *     We keep the structure of what was discussed and drop the prose.
 *  5. DEDUPE — identical consecutive references (same doc cited repeatedly) are
 *     collapsed to a single occurrence.
 */

import type { ChatMessage, Attachment } from './types'

/** Rough token estimate. Chinese text is ~1 token/char; Latin ~1 per 4 chars. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const s = String(text)
  let cjk = 0
  let other = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0x2e80 && c <= 0x9fff) cjk++
    else if (c >= 0xf900 && c <= 0xfaff) cjk++
    else other++
  }
  return Math.ceil(cjk * 1.05 + other / 3.6)
}

export function estimateMessagesTokens(msgs: any[]): number {
  let n = 0
  for (const m of msgs) {
    if (typeof m.content === 'string') n += estimateTokens(m.content) + 4
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') n += estimateTokens(p.text) + 4
        else if (p.type === 'image_url') n += 780 // ~one 1024px tile
      }
    }
    if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls)) + 8
  }
  return n
}

const TOOL_PLACEHOLDER = (name: string, digest: string) => `【早前调用 ${name}｜摘要】${digest}`

/** One-line digest of a tool result, preserving artifact references. */
function digestToolResult(name: string, result?: string) {
  const r = String(result || '')
  if (!r) return '（无返回）'
  const art = /(?:生成|已保存|文件|路径|artifact)[:：]\s*([^\n]{0,120})/.exec(r)
  const firstLine = r.split('\n').find((l) => l.trim()) || ''
  const head = firstLine.trim().slice(0, 110)
  const tail = art?.[1] ? ` → 产出：${art[1].trim()}` : ''
  return `${head}${tail}${r.length > 160 ? ' …' : ''}`
}

/** Extract the skeleton of a long teaching answer: headings + first sentence each. */
export function digestContent(md: string, maxChars = 420): string {
  const s = String(md || '')
  if (s.length <= maxChars) return s

  // Prefer structural lines: headings, bolded lead-ins, list markers.
  const lines = s.split('\n')
  const picked: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (/^#{1,6}\s/.test(t)) picked.push(t.replace(/^#{1,6}\s*/, '· ').slice(0, 80))
    else if (/^(\*\*|__).{2,60}(\*\*|__)/.test(t)) picked.push(`· ${t.replace(/\*\*/g, '').slice(0, 70)}`)
    else if (/^\s*[-*+]\s+/.test(line) && picked.length < 14) picked.push(`  - ${t.replace(/^[-*+]\s+/, '').slice(0, 68)}`)
  }

  // The skeleton is the point of a digest. Only synthesise from prose when the
  // answer had no structure to hold on to — otherwise a wall of repeated body
  // text would sneak in and defeat the compression.
  let out = picked.join('\n')
  if (!picked.length) {
    const sentences = s
      .replace(/```[\s\S]*?```/g, '')
      .split(/(?<=[。！？.!?])\s*/)
      .map((x) => x.trim())
      .filter((x) => x.length > 6)
    out = sentences.slice(0, 4).map((x) => x.slice(0, 88)).join(' ')
  }
  if (out.length > maxChars) out = out.slice(0, maxChars) + '…'
  return out
}

export interface BuildContextOptions {
  /** full-detail turns retained at the tail */
  historyRounds?: number
  stripOldImages?: boolean
  stripOldTools?: boolean
  /** hard cap for the whole transcript section */
  charBudget?: number
  /** transient system preamble for this turn only (RAG results etc.) */
  transientContext?: string
  systemPrompt: string
  /** rolling summary already stored on the session */
  sessionSummary?: string
}

export interface BuiltContext {
  messages: any[]
  stats: {
    rawMessages: number
    sentMessages: number
    estimatedTokens: number
    droppedMessages: number
    digests: number
    strippedImages: number
    strippedTools: number
  }
}

function attachmentToPart(a: Attachment) {
  if (a.kind === 'image') {
    const url = a.dataUrl || (a.path ? `file://${a.path.replace(/\\/g, '/')}` : '')
    if (!url) return null
    return { type: 'image_url', image_url: { url } }
  }
  return null
}

function fileSummary(a: Attachment) {
  const kb = a.size ? `, ${(a.size / 1024).toFixed(1)}KB` : ''
  const head = a.text ? `\n\`\`\`\n${a.text.slice(0, 1800)}${a.text.length > 1800 ? '\n…（内容已截断）' : ''}\n\`\`\`` : ''
  return `[附件: ${a.name} (${a.ext || 'file'}${kb})]${head}`
}

/**
 * Convert internal ChatMessage[] into the OpenAI wire format with decay applied.
 */
export function buildContext(messages: ChatMessage[], opts: BuildContextOptions): BuiltContext {
  const historyRounds = Math.max(1, opts.historyRounds ?? 10)
  const stripOldImages = opts.stripOldImages !== false
  const stripOldTools = opts.stripOldTools !== false
  const charBudget = opts.charBudget ?? 48000

  const stats = {
    rawMessages: messages.length,
    sentMessages: 0,
    estimatedTokens: 0,
    droppedMessages: 0,
    digests: 0,
    strippedImages: 0,
    strippedTools: 0,
  }

  // index of the message that starts the "recent full-detail" window
  const userIdx = messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0)
  const windowStart = userIdx.length > historyRounds ? userIdx[userIdx.length - historyRounds] : 0

  const out: any[] = []
  const systemParts: string[] = [opts.systemPrompt]
  if (opts.transientContext && opts.transientContext.trim()) {
    systemParts.push(`【本轮检索上下文 · 仅供本次回答参考，不要复述原文】\n${opts.transientContext.trim()}`)
  }
  out.push({ role: 'system', content: systemParts.join('\n\n---\n\n') })

  // rolling summary of what has already been dropped in earlier turns
  const digestParts: string[] = []
  if (opts.sessionSummary) digestParts.push(opts.sessionSummary)

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'system') continue
    if (m.error) continue
    if (m.role === 'assistant' && !m.content?.trim() && !m.toolCalls?.length) continue

    const inWindow = i >= windowStart

    /* ---- assistant turns ---- */
    if (m.role === 'assistant') {
      const tools = (m.toolCalls || []).filter((t) => t.status !== 'pending')
      const hasText = !!m.content?.trim()

      // A tool round is only sendable as a unit: the API rejects an assistant
      // message carrying tool_calls whose matching tool results are missing.
      if (tools.length && (inWindow || !stripOldTools)) {
        out.push({
          role: 'assistant',
          content: m.content || '',
          tool_calls: tools.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) },
          })),
        })
        for (const t of tools) {
          const keepFull = inWindow
          out.push({
            role: 'tool',
            tool_call_id: t.id,
            content: keepFull ? String(t.result ?? '').slice(0, 6000) : digestToolResult(t.name, t.result),
          })
          if (!keepFull) stats.strippedTools++
        }
        continue
      }

      if (tools.length) {
        // old tool round: collapse into the digest block instead
        for (const t of tools) {
          digestParts.push(TOOL_PLACEHOLDER(t.name, digestToolResult(t.name, t.result)))
          stats.strippedTools++
        }
        if (hasText) {
          digestParts.push(`【早前回答要点】${digestContent(m.content)}`)
          stats.digests++
        }
        continue
      }

      if (!hasText) continue
      if (inWindow) {
        out.push({ role: 'assistant', content: m.content })
      } else {
        digestParts.push(`【早前回答要点】${digestContent(m.content)}`)
        stats.digests++
      }
      continue
    }

    /* ---- user turns ---- */
    if (m.role === 'user') {
      let text = m.content || ''
      const atts = (m.attachments || []).filter(Boolean)
      if (!atts.length) {
        if (inWindow) out.push({ role: 'user', content: text })
        else {
          digestParts.push(`【学生曾问】${text.slice(0, 160)}`)
          stats.digests++
        }
        continue
      }

      // with attachments: build multimodal parts
      const keepImages = inWindow || !stripOldImages
      const parts: any[] = []
      const fileNotes: string[] = []
      for (const a of atts) {
        if (a.kind === 'image') {
          if (keepImages) {
            const p = attachmentToPart(a)
            if (p) {
              parts.push(p)
              continue
            }
          }
          stats.strippedImages++
          fileNotes.push(`[早前图片「${a.name}」已省略]`)
        } else {
          if (inWindow) fileNotes.push(fileSummary(a))
          else {
            fileNotes.push(`[早前附件「${a.name}」已省略]`)
            stats.strippedTools++
          }
        }
      }
      const body = [text, ...fileNotes].filter(Boolean).join('\n\n')
      if (parts.length) out.push({ role: 'user', content: [{ type: 'text', text: body }, ...parts] })
      else out.push({ role: 'user', content: body })
    }
  }

  // inject the digest block right after the system message
  if (digestParts.length) {
    const digest = `【此前对话的压缩记录 · 供你保持连贯，不要直接引用其措辞】\n${digestParts.join('\n')}`
    out.splice(1, 0, { role: 'system', content: digest })
  }

  /* ---- budget enforcement: drop the oldest non-system entries first ---- */
  let budget = charBudget
  const countChars = (ms: any[]) =>
    ms.reduce((n, m) => {
      if (typeof m.content === 'string') return n + m.content.length
      if (Array.isArray(m.content)) return n + m.content.reduce((k: number, p: any) => k + (p.type === 'text' ? p.text.length : 1500), 0)
      return n + 20
    }, 0)

  const sysCount = out.filter((m) => m.role === 'system')
  while (countChars(out) > budget && out.length > sysCount.length + 2) {
    const idx = out.findIndex((m, i) => i > 0 && m.role !== 'system')
    if (idx < 0) break
    const removed = out[idx]
    out.splice(idx, 1)
    // a tool result without its assistant tool_call breaks the API contract
    if (removed.role === 'tool') {
      const orphan = out.findIndex((m) => m.role === 'tool' && !out.some((x) => x.tool_calls?.some((t: any) => t.id === m.tool_call_id)))
      if (orphan >= 0) out.splice(orphan, 1)
    }
    stats.droppedMessages++
  }

  // final safety: remove orphan tool messages
  const callIds = new Set<string>()
  for (const m of out) for (const t of m.tool_calls || []) callIds.add(t.id)
  const cleaned = out.filter((m) => m.role !== 'tool' || callIds.has(m.tool_call_id))

  stats.sentMessages = cleaned.length
  stats.estimatedTokens = estimateMessagesTokens(cleaned)
  return { messages: cleaned, stats }
}

/** Roll the dropped portion of a session into a persistent summary string. */
export function updateSessionSummary(prev: string | undefined, messages: ChatMessage[], keepFrom: number) {
  const dropped = messages.slice(0, keepFrom).filter((m) => m.role === 'assistant' && m.content)
  const previous = prev || ''
  const fresh = dropped.map((m) => `· ${digestContent(m.content, 180)}`).join('\n')
  const merged = [previous, fresh].filter(Boolean).join('\n')
  // keep the summary bounded
  return merged.length > 2400 ? merged.slice(-2400) : merged
}
