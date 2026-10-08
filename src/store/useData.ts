import { create } from 'zustand'
import { bridge } from '../lib/bridge'
import { STORES, idbGetAll, idbPut, idbDel, idbClear, kvGet, kvSet } from '../lib/idb'
import { Bm25Index, chunkText, makeDoc, type ScoredChunk } from '../lib/kb'
import { uid, activeReason } from '../lib/util'
import { REASON_CATEGORIES, type Artifact, type Flashcard, type KbChunk, type KnowledgeDoc, type ReasonCategory, type WrongEntry } from '../lib/types'

/* ------------------------------------------------------------------ */
/* spaced repetition                                                   */
/* ------------------------------------------------------------------ */
const REVIEW_DAYS = [1, 2, 4, 7, 15, 30]
const DAY = 864e5

export function nextWrongReview(mastery: number, from = Date.now()) {
  const idx = Math.max(0, Math.min(REVIEW_DAYS.length - 1, mastery))
  return from + REVIEW_DAYS[idx] * DAY
}

/** Leitner boxes with short first interval so a new card is seen again today. */
const CARD_INTERVALS_MS = [10 * 60000, DAY, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY, 30 * DAY]

export function nextCardDue(box: number, from = Date.now()) {
  const idx = Math.max(0, Math.min(CARD_INTERVALS_MS.length - 1, box))
  return from + CARD_INTERVALS_MS[idx]
}

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */
export interface DataState {
  loaded: boolean
  wrongEntries: WrongEntry[]
  flashcards: Flashcard[]
  kbDocs: KnowledgeDoc[]
  kbIndex: Bm25Index | null
  kbChunks: Record<string, KbChunk[]>
  artifacts: Artifact[]
  studyStats: Record<string, number>
  importing: { active: boolean; label: string; progress: number } | null

  load: () => Promise<void>

  /* wrongbook */
  addWrongEntry: (e: Partial<WrongEntry>) => Promise<WrongEntry>
  updateWrongEntry: (id: string, patch: Partial<WrongEntry>) => Promise<void>
  deleteWrongEntry: (id: string) => Promise<void>
  reviewWrongEntry: (id: string, quality: 0 | 1 | 2) => Promise<void>
  clearWrongbook: () => Promise<void>
  wrongStats: () => WrongStats

  /* flashcards */
  addFlashcard: (c: Partial<Flashcard>) => Promise<Flashcard>
  updateFlashcard: (id: string, patch: Partial<Flashcard>) => Promise<void>
  deleteFlashcard: (id: string) => Promise<void>
  gradeFlashcard: (id: string, grade: 'again' | 'hard' | 'good' | 'easy') => Promise<void>
  dueFlashcards: () => Flashcard[]
  generateCardsFromWrongbook: () => Promise<number>

  /* knowledge base */
  importFromPaths: (paths: string[], opts?: { subject?: string; tags?: string[] }) => Promise<{ ok: number; failed: string[] }>
  importText: (name: string, text: string, opts?: { subject?: string; tags?: string[]; type?: KnowledgeDoc['type'] }) => Promise<KnowledgeDoc>
  deleteKbDoc: (id: string) => Promise<void>
  updateKbDoc: (id: string, patch: Partial<KnowledgeDoc>) => Promise<void>
  searchKb: (query: string, topK?: number) => ScoredChunk[]
  rebuildKbIndex: () => Promise<void>
  getDocText: (id: string) => string
  clearKb: () => Promise<void>

  /* artifacts */
  addArtifact: (a: Artifact) => Promise<void>
  deleteArtifact: (id: string) => Promise<void>

  /* misc */
  bumpStudyTime: (minutes: number, subject?: string) => Promise<void>
}

export interface WrongStats {
  total: number
  mastered: number
  unmastered: number
  dueToday: number
  byReason: Array<{ key: string; n: number }>
  byKnowledge: Array<{ key: string; n: number }>
  bySubject: Array<{ key: string; n: number }>
  byDifficulty: Array<{ key: string; n: number }>
  overTime: Array<{ day: string; n: number }>
  avgMastery: number
  worstKnowledge: string[]
}

export const useData = create<DataState>((set, get) => ({
  loaded: false,
  wrongEntries: [],
  flashcards: [],
  kbDocs: [],
  kbIndex: null,
  kbChunks: {},
  artifacts: [],
  studyStats: {},
  importing: null,

  async load() {
    try {
      const [wrongEntries, flashcards, kbDocs, artifacts, studyStats] = await Promise.all([
        idbGetAll<WrongEntry>(STORES.wrongbook),
        idbGetAll<Flashcard>(STORES.flashcards),
        idbGetAll<KnowledgeDoc>(STORES.kb),
        idbGetAll<Artifact>(STORES.artifacts),
        kvGet<Record<string, number>>('studyStats', {}),
      ])
      set({ wrongEntries, flashcards, kbDocs, artifacts, studyStats, loaded: true })
      await get().rebuildKbIndex()
    } catch {
      set({ loaded: true })
    }
  },

  /* ---------------- wrongbook ---------------- */
  async addWrongEntry(e) {
    const now = Date.now()
    const entry: WrongEntry = {
      id: e.id || uid('wb'),
      subject: e.subject || '未分类',
      chapter: e.chapter,
      knowledgePoints: e.knowledgePoints || [],
      question: e.question || '',
      myAnswer: e.myAnswer,
      correctAnswer: e.correctAnswer,
      reason: e.reason || '',
      reasonCategory: (e.reasonCategory || activeReason(e.reason || '')) as ReasonCategory,
      difficulty: (e.difficulty || 3) as any,
      source: e.source,
      createdAt: now,
      updatedAt: now,
      reviewCount: 0,
      nextReviewAt: now + DAY,
      mastery: 0,
      tags: e.tags || [],
      imagePaths: e.imagePaths,
      chatId: e.chatId,
    }
    await idbPut(STORES.wrongbook, entry)
    set({ wrongEntries: [entry, ...get().wrongEntries] })
    return entry
  },

  async updateWrongEntry(id, patch) {
    const list = get().wrongEntries.map((w) => (w.id === id ? { ...w, ...patch, updatedAt: Date.now() } : w))
    const item = list.find((w) => w.id === id)
    if (item) await idbPut(STORES.wrongbook, item)
    set({ wrongEntries: list })
  },

  async deleteWrongEntry(id) {
    await idbDel(STORES.wrongbook, id)
    set({ wrongEntries: get().wrongEntries.filter((w) => w.id !== id) })
  },

  async reviewWrongEntry(id, quality) {
    const w = get().wrongEntries.find((x) => x.id === id)
    if (!w) return
    // quality 0 = still wrong, 1 = right but shaky, 2 = solid
    const mastery = quality === 0 ? Math.max(0, w.mastery - 1) : quality === 1 ? Math.min(4, w.mastery + 1) : Math.min(5, w.mastery + 2)
    const patch: Partial<WrongEntry> = {
      mastery,
      reviewCount: w.reviewCount + 1,
      lastReviewedAt: Date.now(),
      nextReviewAt: mastery >= 5 ? undefined : nextWrongReview(mastery),
    }
    await get().updateWrongEntry(id, patch)
  },

  async clearWrongbook() {
    await idbClear(STORES.wrongbook)
    set({ wrongEntries: [] })
  },

  wrongStats() {
    const list = get().wrongEntries
    const now = Date.now()
    const endOfToday = new Date()
    endOfToday.setHours(23, 59, 59, 999)

    const count = (fn: (w: WrongEntry) => string | string[] | number) => {
      const m = new Map<string, number>()
      for (const w of list) {
        const v = fn(w)
        const keys = Array.isArray(v) ? v : [v]
        for (const k of keys) m.set(String(k), (m.get(String(k)) || 0) + 1)
      }
      return [...m.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n)
    }

    const days = new Map<string, number>()
    for (const w of list) {
      const d = new Date(w.createdAt)
      const key = `${d.getMonth() + 1}/${d.getDate()}`
      days.set(key, (days.get(key) || 0) + 1)
    }
    const overTime = [...days.entries()].map(([day, n]) => ({ day, n }))

    const masterySum = list.reduce((n, w) => n + w.mastery, 0)
    const byKnowledge = count((w) => w.knowledgePoints)

    return {
      total: list.length,
      mastered: list.filter((w) => w.mastery >= 5).length,
      unmastered: list.filter((w) => w.mastery < 5).length,
      dueToday: list.filter((w) => w.mastery < 5 && (w.nextReviewAt ?? 0) <= endOfToday.getTime()).length,
      byReason: count((w) => w.reasonCategory),
      byKnowledge,
      bySubject: count((w) => w.subject),
      byDifficulty: count((w) => `${w.difficulty}`),
      overTime,
      avgMastery: list.length ? masterySum / list.length : 0,
      worstKnowledge: byKnowledge.filter((k) => {
        const items = list.filter((w) => w.knowledgePoints.includes(k.key))
        return items.length >= 2 && items.reduce((n, w) => n + w.mastery, 0) / items.length < 2.5
      }).slice(0, 6).map((k) => k.key),
    }
  },

  /* ---------------- flashcards ---------------- */
  async addFlashcard(c) {
    const now = Date.now()
    const card: Flashcard = {
      id: c.id || uid('fc'),
      front: c.front || '',
      back: c.back || '',
      subject: c.subject,
      knowledgePoints: c.knowledgePoints || [],
      box: c.box ?? 0,
      dueAt: c.dueAt ?? now,
      createdAt: now,
      reviewCount: 0,
      lapses: 0,
      source: c.source || 'manual',
      sourceId: c.sourceId,
    }
    await idbPut(STORES.flashcards, card)
    set({ flashcards: [card, ...get().flashcards] })
    return card
  },

  async updateFlashcard(id, patch) {
    const list = get().flashcards.map((c) => (c.id === id ? { ...c, ...patch } : c))
    const item = list.find((c) => c.id === id)
    if (item) await idbPut(STORES.flashcards, item)
    set({ flashcards: list })
  },

  async deleteFlashcard(id) {
    await idbDel(STORES.flashcards, id)
    set({ flashcards: get().flashcards.filter((c) => c.id !== id) })
  },

  async gradeFlashcard(id, grade) {
    const c = get().flashcards.find((x) => x.id === id)
    if (!c) return
    let box = c.box
    let lapses = c.lapses
    if (grade === 'again') {
      box = 0
      lapses++
    } else if (grade === 'hard') box = Math.max(0, box) // repeat at same level
    else if (grade === 'good') box = Math.min(6, box + 1)
    else box = Math.min(6, box + 2)
    await get().updateFlashcard(id, {
      box,
      lapses,
      dueAt: nextCardDue(box),
      reviewCount: c.reviewCount + 1,
    })
  },

  dueFlashcards() {
    const now = Date.now()
    return get()
      .flashcards.filter((c) => c.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt)
  },

  async generateCardsFromWrongbook() {
    const list = get().wrongEntries
    const existing = new Set(get().flashcards.filter((c) => c.sourceId).map((c) => c.sourceId!))
    let n = 0
    for (const w of list) {
      if (existing.has(w.id)) continue
      if (!w.knowledgePoints.length) continue
      const front = `【${w.subject}】${w.knowledgePoints[0]}：请说明其关键条件，以及你上次错在哪里？`
      const back = `错因：${w.reason}\n\n要点：${(w.correctAnswer || w.question).slice(0, 420)}`
      await get().addFlashcard({
        front,
        back,
        subject: w.subject,
        knowledgePoints: w.knowledgePoints,
        source: 'wrongbook',
        sourceId: w.id,
      })
      n++
    }
    return n
  },

  /* ---------------- knowledge base ---------------- */
  async importFromPaths(paths, opts = {}) {
    let ok = 0
    const failed: string[] = []
    set({ importing: { active: true, label: '正在解析…', progress: 0 } })
    try {
      const { parseFile, extOf, isImage } = await import('../lib/parse')
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i]
        const name = p.split(/[\\/]/).pop() || p
        set({ importing: { active: true, label: `解析 ${name}`, progress: i / paths.length } })
        try {
          const ext = extOf(p)
          if (isImage(ext)) {
            // images are stored as docs whose content is resolved by vision at ask-time
            const doc = makeDoc({
              name,
              type: 'image',
              sourcePath: p,
              subject: opts.subject,
              tags: opts.tags || [],
              chars: 0,
              chunkCount: 0,
              note: '图片资料：提问时会作为视觉输入读取，不参与文本检索。',
            })
            await idbPut(STORES.kb, doc)
            set({ kbDocs: [doc, ...get().kbDocs] })
            ok++
            continue
          }
          const parsed = await parseFile(p, bridge.fs.readBase64, bridge.fs.readText)
          if (!parsed.text || parsed.text.trim().length < 10) {
            failed.push(`${name}${parsed.warning ? `（${parsed.warning}）` : '（内容为空）'}`)
            continue
          }
          const typeMap: Record<string, KnowledgeDoc['type']> = {
            txt: 'txt', md: 'md', markdown: 'md', pdf: 'pdf', docx: 'docx', doc: 'docx',
            xlsx: 'xlsx', xls: 'xlsx', csv: 'csv', json: 'json',
          }
          const doc = makeDoc({
            name,
            type: typeMap[ext] || 'txt',
            sourcePath: p,
            subject: opts.subject,
            tags: opts.tags || [],
            chars: parsed.text.length,
            sizeBytes: (await bridge.fs.stat(p))?.size,
            note: parsed.warning,
          })
          const chunks = chunkText(parsed.text, { id: doc.id, name: doc.name, subject: doc.subject, tags: doc.tags })
          doc.chunkCount = chunks.length
          const storedPath = await bridge.kb.copySource(p, doc.id).catch(() => null)
          if (storedPath) doc.storedPath = storedPath
          await bridge.kb.saveChunks(doc.id, chunks)
          await idbPut(STORES.kb, doc)
          set({
            kbDocs: [doc, ...get().kbDocs],
            kbChunks: { ...get().kbChunks, [doc.id]: chunks },
          })
          ok++
        } catch (e: any) {
          failed.push(`${name}（${e?.message || e}）`)
        }
      }
    } finally {
      set({ importing: null })
    }
    await get().rebuildKbIndex()
    return { ok, failed }
  },

  async importText(name, text, opts = {}) {
    const doc = makeDoc({
      name,
      type: opts.type || 'manual',
      subject: opts.subject,
      tags: opts.tags || [],
      chars: (text || '').length,
      note: '由研来整理生成',
    })
    const chunks = chunkText(text || '', { id: doc.id, name: doc.name, subject: doc.subject, tags: doc.tags })
    doc.chunkCount = chunks.length
    await bridge.kb.saveChunks(doc.id, chunks)
    await idbPut(STORES.kb, doc)
    set({ kbDocs: [doc, ...get().kbDocs], kbChunks: { ...get().kbChunks, [doc.id]: chunks } })
    await get().rebuildKbIndex()
    return doc
  },

  async deleteKbDoc(id) {
    await idbDel(STORES.kb, id)
    await bridge.kb.delete(id).catch(() => {})
    const chunks = { ...get().kbChunks }
    delete chunks[id]
    set({ kbDocs: get().kbDocs.filter((d) => d.id !== id), kbChunks: chunks })
    await get().rebuildKbIndex()
  },

  async updateKbDoc(id, patch) {
    const list = get().kbDocs.map((d) => (d.id === id ? { ...d, ...patch, updatedAt: Date.now() } : d))
    const doc = list.find((d) => d.id === id)
    if (doc) await idbPut(STORES.kb, doc)
    set({ kbDocs: list })
    // subject/tags feed retrieval scoring, so refresh the index
    if (patch.subject !== undefined || patch.tags !== undefined) await get().rebuildKbIndex()
  },

  searchKb(query, topK = 5) {
    const idx = get().kbIndex
    if (!idx || !idx.size) return []
    return idx.search(query, topK, { minScore: 0.05 })
  },

  async rebuildKbIndex() {
    const docs = get().kbDocs.filter((d) => d.type !== 'image')
    const cache: Record<string, KbChunk[]> = { ...get().kbChunks }
    const all: KbChunk[] = []
    for (const d of docs) {
      if (!cache[d.id]) {
        try {
          const stored = await bridge.kb.loadChunks(d.id)
          cache[d.id] = stored?.chunks || []
        } catch {
          cache[d.id] = []
        }
      }
      const chunks = cache[d.id] || []
      // keep doc-level metadata fresh on the chunks used for scoring
      for (const c of chunks) {
        all.push({ ...c, subject: d.subject, tags: d.tags, docName: d.name })
      }
    }
    set({ kbChunks: cache, kbIndex: all.length ? new Bm25Index(all) : null })
  },

  getDocText(id) {
    const chunks = get().kbChunks[id] || []
    return chunks.map((c) => c.text).join('\n\n')
  },

  async clearKb() {
    for (const d of get().kbDocs) await bridge.kb.delete(d.id).catch(() => {})
    await idbClear(STORES.kb)
    set({ kbDocs: [], kbChunks: {}, kbIndex: null })
  },

  /* ---------------- artifacts ---------------- */
  async addArtifact(a) {
    // strip huge inline payloads before persisting; keep svg (small) and path
    const lean: Artifact = { ...a }
    if (lean.dataUrl && lean.dataUrl.length > 400000) delete lean.dataUrl
    if (lean.text && lean.text.length > 200000) lean.text = lean.text.slice(0, 200000)
    await idbPut(STORES.artifacts, lean)
    set({ artifacts: [lean, ...get().artifacts].slice(0, 400) })
  },

  async deleteArtifact(id) {
    await idbDel(STORES.artifacts, id)
    set({ artifacts: get().artifacts.filter((a) => a.id !== id) })
  },

  /* ---------------- study time ---------------- */
  async bumpStudyTime(minutes, subject) {
    const key = new Date().toISOString().slice(0, 10)
    const stats = { ...get().studyStats }
    stats[key] = (stats[key] || 0) + minutes
    set({ studyStats: stats })
    await kvSet('studyStats', stats)
    if (subject) {
      const subj = await kvGet<Record<string, number>>('subjectTime', {})
      subj[subject] = (subj[subject] || 0) + minutes
      await kvSet('subjectTime', subj)
    }
  },
}))

export { REASON_CATEGORIES }
