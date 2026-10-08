/**
 * Knowledge base: chunking + local lexical retrieval.
 *
 * Retrieval is deliberately local (BM25 over CJK bigrams) rather than
 * embedding-based. Reasons: it costs zero tokens, needs no second API key or
 * network round-trip per question, works offline, and for textbook-style
 * material — where the student's question usually shares literal terminology
 * with the source — it is accurate. Optional remote embeddings can be layered
 * on later without changing the call sites.
 */

import type { KbChunk, KnowledgeDoc } from './types'
import { uid } from './util'

/* ------------------------------------------------------------------ */
/* chunking                                                            */
/* ------------------------------------------------------------------ */
const HEADING_RE = /^(?:#{1,6}\s+.+|第\s*[0-9一二三四五六七八九十百]+\s*[章节讲部分篇]|Chapter\s+\d+|[0-9]+(?:\.[0-9]+){0,3}\s+\S.{0,60})$/

export interface ChunkOptions {
  targetChars?: number
  overlapChars?: number
  maxChunkChars?: number
}

/** Split on structural boundaries first, then pack paragraphs into windows. */
export function chunkText(
  text: string,
  doc: { id: string; name: string; subject?: string; tags?: string[] },
  opts: ChunkOptions = {},
): KbChunk[] {
  const target = opts.targetChars ?? 760
  const overlap = opts.overlapChars ?? 90
  const hardMax = opts.maxChunkChars ?? 1800

  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')

  /** sections: [{heading, body}] */
  const sections: Array<{ heading: string; body: string }> = []
  let curHeading = ''
  let cur: string[] = []
  const flush = () => {
    const body = cur.join('\n').trim()
    if (body || curHeading) sections.push({ heading: curHeading, body })
    cur = []
  }
  for (const line of lines) {
    const t = line.trim()
    if (t && HEADING_RE.test(t) && t.length < 90) {
      flush()
      curHeading = t.replace(/^#{1,6}\s*/, '').trim()
      continue
    }
    cur.push(line)
  }
  flush()

  const chunks: KbChunk[] = []
  let idx = 0
  const push = (heading: string, body: string) => {
    const clean = body.replace(/\n{3,}/g, '\n\n').trim()
    if (!clean) return
    const withCtx = heading ? `${heading}\n${clean}` : clean
    chunks.push({
      id: `${doc.id}#${idx}`,
      docId: doc.id,
      docName: doc.name,
      idx: idx++,
      heading: heading || undefined,
      text: withCtx.length > hardMax ? withCtx.slice(0, hardMax) : withCtx,
      tokens: estimateChunkTokens(withCtx),
      subject: doc.subject,
      tags: doc.tags,
    })
  }

  for (const sec of sections) {
    const paras = sec.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    if (!paras.length) {
      push(sec.heading, sec.body)
      continue
    }
    let buf: string[] = []
    let bufLen = 0
    const emit = () => {
      if (!buf.length) return
      push(sec.heading, buf.join('\n\n'))
      // carry an overlap tail so a fact split across the boundary is still findable
      const tail = buf.join('\n\n').slice(-overlap)
      buf = tail.trim() ? [tail] : []
      bufLen = tail.length
    }
    for (const p of paras) {
      if (p.length > hardMax) {
        // a single huge paragraph (e.g. a pasted exam paper): hard-split on sentences
        const sents = p.split(/(?<=[。！？.!?;；])\s*/)
        for (const s of sents) {
          if (bufLen + s.length > target && bufLen > 0) emit()
          buf.push(s)
          bufLen += s.length
        }
        continue
      }
      if (bufLen + p.length > target && bufLen > 0) emit()
      buf.push(p)
      bufLen += p.length + 2
    }
    emit()
  }

  // guard: a document with no newlines at all
  if (!chunks.length) {
    const s = String(text || '').trim()
    for (let i = 0; i < s.length; i += target - overlap) {
      const piece = s.slice(i, i + target)
      if (!piece.trim()) continue
      chunks.push({
        id: `${doc.id}#${idx}`,
        docId: doc.id,
        docName: doc.name,
        idx: idx++,
        text: piece,
        tokens: estimateChunkTokens(piece),
        subject: doc.subject,
        tags: doc.tags,
      })
    }
  }
  return chunks
}

function estimateChunkTokens(s: string) {
  let cjk = 0
  let other = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0x2e80 && c <= 0x9fff) cjk++
    else other++
  }
  return Math.ceil(cjk * 1.05 + other / 3.6)
}

/* ------------------------------------------------------------------ */
/* tokenisation: CJK bigrams + latin/digit words                       */
/* ------------------------------------------------------------------ */
const STOP = new Set([
  '的', '了', '是', '在', '和', '与', '有', '为', '对', '中', '上', '下', '个', 'this', 'that', 'the', 'and', 'for',
  'are', 'is', 'of', 'to', 'in', 'on', 'a', 'an', '请', '什么', '如何', '怎么', '可以', '以及', '我们', '你',
])

export function indexTokens(text: string): string[] {
  const s = String(text || '')
  const out: string[] = []
  // latin words / numbers
  const latin = s.match(/[A-Za-z][A-Za-z0-9_\-]{1,}|[0-9]+(?:\.[0-9]+)?/g)
  if (latin) {
    for (const w of latin) {
      const lw = w.toLowerCase()
      if (!STOP.has(lw)) out.push(lw)
    }
  }
  // CJK runs -> unigrams (filtered) + bigrams
  const runs = s.match(/[\u3400-\u9fff\u3040-\u30ff]+/g)
  if (runs) {
    for (const run of runs) {
      for (let i = 0; i < run.length; i++) {
        const ch = run[i]
        if (!STOP.has(ch)) out.push(ch)
        if (i + 1 < run.length) out.push(run.slice(i, i + 2))
      }
      // also index 3-grams for longer runs to improve precision on technical terms
      if (run.length >= 3) {
        for (let i = 0; i + 3 <= run.length; i++) out.push(run.slice(i, i + 3))
      }
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* BM25 index                                                          */
/* ------------------------------------------------------------------ */
export interface ScoredChunk extends KbChunk {
  score: number
  matched: string[]
}

export class Bm25Index {
  private docs: Array<{ id: string; tf: Map<string, number>; len: number; chunk: KbChunk }> = []
  private df = new Map<string, number>()
  private avgLen = 1
  private k1 = 1.4
  private b = 0.72

  constructor(chunks: KbChunk[]) {
    for (const c of chunks) {
      const toks = indexTokens(c.text)
      const tf = new Map<string, number>()
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1)
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1)
      this.docs.push({ id: c.id, tf, len: toks.length, chunk: c })
    }
    this.avgLen = this.docs.reduce((n, d) => n + d.len, 0) / Math.max(1, this.docs.length)
  }

  get size() {
    return this.docs.length
  }

  search(query: string, topK = 4, opts: { docIds?: string[]; minScore?: number } = {}): ScoredChunk[] {
    const q = indexTokens(query)
    if (!q.length) return []
    const N = this.docs.length
    const unique = [...new Set(q)]
    const scores: Array<{ d: (typeof this.docs)[number]; score: number; matched: string[] }> = []

    for (const d of this.docs) {
      if (opts.docIds && opts.docIds.length && !opts.docIds.includes(d.chunk.docId)) continue
      let score = 0
      const matched: string[] = []
      for (const t of unique) {
        const f = d.tf.get(t)
        if (!f) continue
        const df = this.df.get(t) || 1
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        const norm = f * (this.k1 + 1) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen))
        score += idf * norm
        matched.push(t)
      }
      if (score > 0) scores.push({ d, score, matched })
    }

    // bonus for high query coverage (prevents one common term dominating)
    const qSet = new Set(unique)
    for (const s of scores) {
      const coverage = new Set(s.matched).size / qSet.size
      s.score *= 1 + coverage * 0.9
      // prefer chunks whose heading matches the query
      if (s.d.chunk.heading && indexTokens(s.d.chunk.heading).some((t) => qSet.has(t))) s.score *= 1.2
    }

    scores.sort((a, b) => b.score - a.score)
    const top = scores.slice(0, Math.max(1, topK))
    const min = opts.minScore ?? 0
    return top
      .filter((s) => s.score >= min)
      .map((s) => ({ ...s.d.chunk, score: s.score, matched: [...new Set(s.matched)].slice(0, 8) }))
  }
}

/** Cheap extractive answer preview used by the "ask the knowledge base" panel. */
export function highlightSnippet(text: string, terms: string[], maxLen = 260) {
  const t = String(text || '')
  if (!terms.length) return t.slice(0, maxLen)
  let bestIdx = 0
  let bestHits = -1
  const window = Math.max(60, maxLen)
  for (let i = 0; i < t.length; i += 40) {
    const seg = t.slice(i, i + window)
    let hits = 0
    for (const term of terms) if (seg.includes(term)) hits++
    if (hits > bestHits) {
      bestHits = hits
      bestIdx = i
    }
  }
  const seg = t.slice(bestIdx, bestIdx + maxLen)
  return `${bestIdx > 0 ? '…' : ''}${seg}${bestIdx + maxLen < t.length ? '…' : ''}`
}

/* ------------------------------------------------------------------ */
/* context assembly (token-budgeted)                                   */
/* ------------------------------------------------------------------ */
export interface KbSearchResult {
  text: string
  used: ScoredChunk[]
  chars: number
}

export function buildKbContext(
  hits: ScoredChunk[],
  charBudget = 3200,
): KbSearchResult {
  const used: ScoredChunk[] = []
  let total = 0
  const lines: string[] = []
  for (const h of hits) {
    const header = `〔${h.docName}${h.heading ? ` › ${h.heading}` : ''}〕`
    const room = charBudget - total - header.length - 4
    if (room < 160) break
    const body = h.text.length > room ? h.text.slice(0, room) + '…' : h.text
    lines.push(`${header}\n${body}`)
    total += header.length + body.length + 4
    used.push(h)
    if (total >= charBudget) break
  }
  return { text: lines.join('\n\n'), used, chars: total }
}

export function makeDoc(partial: Partial<KnowledgeDoc>): KnowledgeDoc {
  const now = Date.now()
  return {
    id: partial.id || uid('kb'),
    name: partial.name || '未命名资料',
    type: partial.type || 'manual',
    tags: partial.tags || [],
    chars: partial.chars || 0,
    chunkCount: partial.chunkCount || 0,
    createdAt: partial.createdAt || now,
    updatedAt: now,
    ...partial,
  } as KnowledgeDoc
}
