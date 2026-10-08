import { create } from 'zustand'
import { bridge } from '../lib/bridge'
import { STORES, idbGetAll, idbPut, idbDel, kvGet, kvSet } from '../lib/idb'
import { streamChat, completeOnce } from '../lib/llm'
import { buildContext, updateSessionSummary, estimateTokens } from '../lib/context'
import { assembleSystemPrompt, featureById } from '../lib/prompts'
import { executeTool, toolsFor, looksLikeMistakeReport } from '../lib/tools'
import { buildKbContext } from '../lib/kb'
import { uid, drainSentences } from '../lib/util'
import { speech } from '../lib/tts'
import type { Artifact, Attachment, ChatMessage, ChatSession } from '../lib/types'
import { useApp } from './useApp'
import { useData } from './useData'

interface ChatState {
  sessions: ChatSession[]
  currentId: string | null
  loaded: boolean
  streaming: boolean
  streamStats: { promptTokens: number; completionTokens: number; usedTools: number }
  abort: AbortController | null
  search: string
  /** current turn's transient retrieval summary, shown as a chip */
  lastRetrieval: { docs: number; chars: number; wrongs: number } | null
  editTarget: { messageId: string; text: string } | null

  load: () => Promise<void>
  current: () => ChatSession | null
  newSession: (feature?: string, subject?: string) => Promise<ChatSession>
  selectSession: (id: string) => void
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  togglePin: (id: string) => Promise<void>
  clearAll: () => Promise<void>
  setSearch: (s: string) => void
  setEditTarget: (t: ChatState['editTarget']) => void

  send: (opts: {
    text: string
    attachments?: Attachment[]
    feature?: string
    /** re-run from an edited user message */
    editMessageId?: string
    /** regenerate the last assistant answer */
    regenerate?: boolean
  }) => Promise<void>
  stop: () => void
  deleteMessage: (id: string) => Promise<void>
  bookmarkMessage: (id: string, v: boolean) => Promise<void>
}

const MAX_SESSIONS = 300

function emptySession(feature = 'general', subject?: string): ChatSession {
  return {
    id: uid('chat'),
    title: '新对话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    feature,
    subject,
    sessionTokens: 0,
  }
}

/** Derive a title locally — no paid request just to name a chat. */
function deriveTitle(text: string, featureId: string) {
  const f = featureById(featureId)
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return f.label
  const first = t.split(/[。！？!?\n]/)[0].trim()
  const base = first.length > 4 ? first.slice(0, 22) : t.slice(0, 22)
  return `${f.short}· ${base}${t.length > base.length ? '…' : ''}`
}

export const useChat = create<ChatState>((set, get) => ({
  sessions: [],
  currentId: null,
  loaded: false,
  streaming: false,
  streamStats: { promptTokens: 0, completionTokens: 0, usedTools: 0 },
  abort: null,
  search: '',
  lastRetrieval: null,
  editTarget: null,

  async load() {
    try {
      const sessions = await idbGetAll<ChatSession>(STORES.chats)
      sessions.sort((a, b) => b.updatedAt - a.updatedAt)
      const lastId = await kvGet<string>('lastChatId', '')
      // start on a fresh session: resuming a stale one is rarely what a student wants
      set({ sessions, loaded: true, currentId: sessions.find((s) => s.id === lastId)?.id || null })
    } catch {
      set({ loaded: true })
    }
  },

  current() {
    const { sessions, currentId } = get()
    return sessions.find((s) => s.id === currentId) || null
  },

  async newSession(feature = 'general', subject) {
    const s = emptySession(feature, subject)
    set({ sessions: [s, ...get().sessions], currentId: s.id })
    await idbPut(STORES.chats, s)
    await kvSet('lastChatId', s.id)
    return s
  },

  selectSession(id) {
    if (get().streaming) get().stop()
    set({ currentId: id, editTarget: null, lastRetrieval: null })
    kvSet('lastChatId', id)
  },

  async deleteSession(id) {
    await idbDel(STORES.chats, id)
    const sessions = get().sessions.filter((s) => s.id !== id)
    set({ sessions, currentId: get().currentId === id ? sessions[0]?.id || null : get().currentId })
  },

  async renameSession(id, title) {
    const sessions = get().sessions.map((s) => (s.id === id ? { ...s, title: title.slice(0, 80), updatedAt: Date.now() } : s))
    const s = sessions.find((x) => x.id === id)
    if (s) await idbPut(STORES.chats, s)
    set({ sessions })
  },

  async togglePin(id) {
    const sessions = get().sessions.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s))
    const s = sessions.find((x) => x.id === id)
    if (s) await idbPut(STORES.chats, s)
    set({ sessions })
  },

  async clearAll() {
    for (const s of get().sessions) await idbDel(STORES.chats, s.id)
    set({ sessions: [], currentId: null })
  },

  setSearch(s) {
    set({ search: s })
  },

  setEditTarget(t) {
    set({ editTarget: t })
  },

  /* ---------------------------------------------------------------- */
  /* the agentic turn                                                  */
  /* ---------------------------------------------------------------- */
  async send({ text, attachments = [], feature, editMessageId, regenerate }) {
    const app = useApp.getState()
    const data = useData.getState()
    const settings = app.settings || {}
    const provider = settings.provider || {}

    if (!provider.baseUrl || !provider.model) {
      app.toast({ kind: 'warn', title: '尚未配置模型', body: '请先在「设置 → 模型」填写 Base URL、API Key 与模型名。' })
      app.setView('settings', 'model')
      return
    }

    let session = get().current()
    if (!session) session = await get().newSession(feature || 'general')

    const featureId = feature || session.feature || 'general'
    const f = featureById(featureId)

    /* ---- assemble the new message list ---- */
    let history = [...session.messages]

    if (regenerate) {
      // drop trailing assistant/tool messages so we re-answer the last question
      while (history.length && history[history.length - 1].role !== 'user') history.pop()
      if (!history.length) return
    } else if (editMessageId) {
      const idx = history.findIndex((m) => m.id === editMessageId)
      if (idx >= 0) history = history.slice(0, idx)
      const msg: ChatMessage = {
        id: uid('m'),
        role: 'user',
        content: text,
        createdAt: Date.now(),
        attachments: attachments.length ? attachments : undefined,
        feature: featureId,
      }
      history.push(msg)
    } else {
      if (!text.trim() && !attachments.length) return
      const msg: ChatMessage = {
        id: uid('m'),
        role: 'user',
        content: text,
        createdAt: Date.now(),
        attachments: attachments.length ? attachments : undefined,
        feature: featureId,
      }
      history.push(msg)
    }

    const userText = text || '（见附件）'

    /* ---- local classification: should we pre-retrieve? (costs 0 tokens) ---- */
    const tokensCfg = settings.tokens || {}
    const savings = tokensCfg.savingEnabled !== false
    const autoKb = settings.agent?.autoKnowledgeSearch !== false && savings
    let transientContext = ''
    let retrievalInfo: ChatState['lastRetrieval'] = null

    if (autoKb || (featureId === 'review' || featureId === 'wronganalysis')) {
      const parts: string[] = []
      let docs = 0
      let chars = 0
      let wrongs = 0

      // knowledge base (always local: a vector of BM25 scores, no API cost)
      if (data.kbIndex && data.kbIndex.size) {
        const hits = data.searchKb(userInputForQuery(userText, attachments), tokensCfg.kbTopK || 4)
        if (hits.length) {
          const built = buildKbContext(hits, tokensCfg.kbCharBudget || 3200)
          if (built.text) {
            parts.push(`【知识库检索结果】\n${built.text}`)
            docs = built.used.length
            chars += built.chars
          }
        }
      }

      // wrongbook: worth surfacing for explanation/practice features
      if (['explain', 'analogy', 'review', 'wronganalysis', 'knowledge', 'general'].includes(featureId) && data.wrongEntries.length) {
        const kpHits = data.wrongEntries.filter((w) => {
          const q = userText
          return w.knowledgePoints.some((k) => q.includes(k)) || (w.subject && q.includes(w.subject))
        })
        if (kpHits.length) {
          wrongs = kpHits.length
          parts.push(
            `【学生历史错题提醒】\n${kpHits.slice(0, 4).map((w) => `· ${w.subject}｜${w.knowledgePoints.join('、')}｜错因：${w.reasonCategory}｜${w.reason.slice(0, 120)}`).join('\n')}`,
          )
        }
      }

      if (parts.length) {
        transientContext = parts.join('\n\n')
        retrievalInfo = { docs, chars, wrongs }
      }
    }

    // deterministic hint so the model reliably files a mistake without an extra round trip
    const mistakeHint = looksLikeMistakeReport(userText)
      ? '\n注意：学生这条消息包含他自己做错的答案。请先分析错因，然后调用 add_wrongbook_entry 记录下来。'
      : ''

    const combinedTransient = [transientContext, mistakeHint].filter(Boolean).join('\n\n')

    /* ---- system prompt ---- */
    const toolNames = settings.agent?.toolsEnabled === false ? [] : f.tools
    const systemPrompt = assembleSystemPrompt({
      feature: featureId,
      toolNames,
      includeKb: (data.kbIndex?.size || 0) > 0,
      includeWrong: data.wrongEntries.length > 0,
      subject: session.subject,
      extra: settings.agent?.systemPromptExtra,
    })

    /* ---- build the budgeted payload ---- */
    const built = buildContext(history, {
      historyRounds: savings ? tokensCfg.historyRounds || 10 : 999,
      stripOldImages: savings && tokensCfg.stripOldImages !== false,
      stripOldTools: savings && tokensCfg.stripOldTools !== false,
      transientContext: combinedTransient,
      systemPrompt,
      sessionSummary: savings ? session.summary : undefined,
    })

    /* ---- optimistic UI: show user msg + empty assistant ---- */
    const assistantId = uid('m')
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      reasoning: undefined,
      createdAt: Date.now(),
      model: provider.model,
      feature: featureId,
      streaming: true,
      toolCalls: [],
      artifacts: [],
    }
    const nextMessages = [...history, assistantMsg]
    const nextSession: ChatSession = {
      ...session,
      title: session.messages.length === 0 ? deriveTitle(userText, featureId) : session.title,
      feature: featureId,
      messages: nextMessages,
      updatedAt: Date.now(),
    }
    set({
      sessions: get().sessions.map((s) => (s.id === session!.id ? nextSession : s)),
      streaming: true,
      abort: new AbortController(),
      lastRetrieval: retrievalInfo,
      streamStats: { promptTokens: built.stats.estimatedTokens, completionTokens: 0, usedTools: 0 },
    })

    /* ---- streaming plumbing ---- */
    const sessionId = session.id
    const patchAssistant = (patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) => {
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id !== sessionId
            ? s
            : {
                ...s,
                updatedAt: Date.now(),
                messages: s.messages.map((m) => (m.id === assistantId ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)),
              },
        ),
      }))
    }

    const toolCtx = makeToolContext()

    let workingMessages = [...built.messages]
    const maxRounds = Math.max(0, Math.min(8, settings.agent?.maxToolRounds ?? 4))
    const useTools = toolNames.length > 0
    let completionTokens = 0
    let promptTokens = built.stats.estimatedTokens
    let usedTools = 0
    let ttsBuffer = ''
    let finalContent = ''
    const collectedArtifacts: Artifact[] = []

    const autoRead = settings.tts?.autoRead || 'off'
    speech.configure({
      engine: settings.tts?.engine || 'off',
      autoRead,
      voice: settings.tts?.voice || '',
      rate: settings.tts?.rate ?? 1,
      pitch: settings.tts?.pitch ?? 1,
      volume: settings.tts?.volume ?? 1,
      api: settings.tts?.api || { baseUrl: '', apiKey: '', model: 'tts-1', voice: 'alloy', format: 'mp3' },
    })
    if (!get().abort) set({ abort: new AbortController() })

    try {
      for (let round = 0; round <= maxRounds; round++) {
        // accumulate tool calls for this round
        const pending: Array<{ index: number; id?: string; name?: string; argsText: string }> = []
        let roundText = ''
        let roundReasoning = ''

        const isLastRound = round === maxRounds
        const signal = get().abort?.signal
        // After a tool round the model starts a fresh prose block. Without a
        // separator its text would run straight into the previous block, which
        // silently breaks markdown structure (e.g. a heading loses its line).
        let needsSeparator = round > 0

        await streamChat(
          {
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: provider.model,
            messages: workingMessages,
            tools: useTools && !isLastRound ? toolsFor(toolNames) : undefined,
            toolChoice: useTools && !isLastRound ? (round === 0 ? 'auto' : 'auto') : undefined,
            temperature: provider.temperature ?? 0.6,
            topP: provider.topP ?? 1,
            maxTokens: provider.maxTokens || 8192,
            signal,
          },
          {
            onDelta(t) {
              roundText += t
              finalContent += t
              const sep = needsSeparator ? (t.trim() ? '\n\n' : '') : ''
              if (needsSeparator && t.trim()) needsSeparator = false
              patchAssistant((m) => ({ content: (m.content || '') + sep + t }))
              if (autoRead === 'stream') {
                const { ready, rest } = drainSentences(ttsBuffer + t)
                ttsBuffer = rest
                for (const s of ready) speech.enqueue(s)
              }
            },
            onReasoning(t) {
              roundReasoning += t
              patchAssistant((m) => ({ reasoning: (m.reasoning || '') + t }))
            },
            onUsage(u) {
              if (u?.prompt_tokens) promptTokens = u.prompt_tokens
              if (u?.completion_tokens) completionTokens = u.completion_tokens
            },
            onToolCallDelta(calls) {
              for (const c of calls) {
                let slot = pending.find((p) => p.index === c.index)
                if (!slot) {
                  slot = { index: c.index, argsText: '' }
                  pending.push(slot)
                }
                if (c.id) slot.id = c.id
                if (c.name) slot.name = (slot.name || '') + c.name
                if (c.argsText) slot.argsText += c.argsText
              }
            },
          },
        )

        const signalAborted = !!signal?.aborted
        if (signalAborted) {
          patchAssistant({ streaming: false })
          break
        }

        /* ---- no tool calls: this round is the answer ---- */
        const valid = pending.filter((p) => p.name)
        if (!valid.length) break

        /* ---- execute tools, then loop ---- */
        // record the assistant tool_call message in the UI
        const toolRecs = valid.map((c) => ({
          id: c.id || uid('tc'),
          name: c.name!,
          args: safeParse(c.argsText),
          status: 'pending' as const,
          startedAt: Date.now(),
        }))
        patchAssistant({ toolCalls: toolRecs })

        // wire format for this assistant turn
        const wireToolCalls = toolRecs.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        }))
        workingMessages = [
          ...workingMessages,
          { role: 'assistant', content: roundText || '', tool_calls: wireToolCalls },
        ]

        for (let i = 0; i < toolRecs.length; i++) {
          const rec = toolRecs[i]
          const result = await executeTool(rec.name, rec.args, toolCtx)
          usedTools++
          const done = { ...rec, status: (result.label?.includes('失败') || result.label?.includes('出错') ? 'error' : 'ok') as 'ok' | 'error', result: result.text, endedAt: Date.now() }
          patchAssistant((m) => ({ toolCalls: (m.toolCalls || []).map((x) => (x.id === rec.id ? done : x)) }))
          workingMessages.push({ role: 'tool', tool_call_id: rec.id, content: result.text })

          if (result.artifacts?.length) {
            collectedArtifacts.push(...result.artifacts)
            // Artifacts are rendered by ArtifactCard from `m.artifacts`. They are
            // deliberately NOT inlined into the message text: a chart's data URL is
            // ~25KB of base64, which would bloat the stored message and — worse —
            // be counted as text tokens on every subsequent request.
            patchAssistant((m) => ({ artifacts: [...(m.artifacts || []), ...result.artifacts!] }))
            for (const a of result.artifacts!) await data.addArtifact(a)
          }
          set({ streamStats: { promptTokens, completionTokens, usedTools } })
        }

        // reset per-round accumulators so the next round streams into the same bubble
        if (round === maxRounds - 1) {
          // last tool round: tell the model to wrap up in prose
          workingMessages.push({ role: 'system', content: '工具结果已经返回，请直接给出最终讲解，不要再调用工具。' })
        }
      }

      /* ---- finalise ---- */
      if (autoRead === 'after' || autoRead === 'stream') {
        if (ttsBuffer.trim()) {
          speech.enqueue(ttsBuffer.trim(), { last: true })
          ttsBuffer = ''
        }
        if (autoRead === 'after' && finalContent.trim()) speech.speakNow(finalContent)
      }

      patchAssistant({ streaming: false, usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } })

      // persist with the rolling summary refreshed
      const fresh = get().sessions.find((s) => s.id === sessionId)
      if (fresh) {
        const keepFrom = Math.max(0, fresh.messages.length - (savings ? (tokensCfg.historyRounds || 10) * 2 : 9999))
        const summary = savings ? updateSessionSummary(fresh.summary, fresh.messages, keepFrom) : fresh.summary
        const sessionTokens = (fresh.sessionTokens || 0) + promptTokens + completionTokens
        const updatedSession = { ...fresh, summary, sessionTokens, updatedAt: Date.now() }
        await idbPut(STORES.chats, updatedSession)
        set({ sessions: get().sessions.map((s) => (s.id === sessionId ? updatedSession : s)) })
      }

      // housekeeping: keep the session list bounded
      const all = get().sessions
      if (all.length > MAX_SESSIONS) {
        const drop = all.filter((s) => !s.pinned).sort((a, b) => a.updatedAt - b.updatedAt).slice(0, all.length - MAX_SESSIONS)
        for (const d of drop) await idbDel(STORES.chats, d.id)
        set({ sessions: get().sessions.filter((s) => !drop.some((d) => d.id === s.id)) })
      }
      set({ streamStats: { promptTokens, completionTokens, usedTools } })
    } catch (e: any) {
      const msg = String(e?.message || e)
      patchAssistant({
        streaming: false,
        error: true,
        content: (get().sessions.find((s) => s.id === sessionId)?.messages.find((m) => m.id === assistantId)?.content || '') + `\n\n> ⚠️ **请求失败**：${msg}`,
      })
      useApp.getState().toast({ kind: 'error', title: '请求失败', body: msg })
    } finally {
      set({ streaming: false, abort: null })
    }
  },

  stop() {
    get().abort?.abort()
    speech.stop()
    set({ streaming: false })
    const id = get().currentId
    if (id) {
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id !== id ? s : { ...s, messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)) },
        ),
      }))
    }
  },

  async deleteMessage(id) {
    const s = get().current()
    if (!s) return
    const updated = { ...s, messages: s.messages.filter((m) => m.id !== id), updatedAt: Date.now() }
    await idbPut(STORES.chats, updated)
    set({ sessions: get().sessions.map((x) => (x.id === s.id ? updated : x)) })
  },

  async bookmarkMessage(id, v) {
    const s = get().current()
    if (!s) return
    const updated = { ...s, messages: s.messages.map((m) => (m.id === id ? { ...m, bookmarked: v } : m)) }
    await idbPut(STORES.chats, updated)
    set({ sessions: get().sessions.map((x) => (x.id === s.id ? updated : x)) })
  },
}))

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
function safeParse(text: string): any {
  const t = String(text || '').trim()
  if (!t) return {}
  try {
    return JSON.parse(t)
  } catch {
    // models sometimes emit trailing commas or single quotes
    try {
      return JSON.parse(t.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"'))
    } catch {
      return { _raw: t }
    }
  }
}

/** Combine typed text with attachment names so retrieval sees the topic. */
function userInputForQuery(text: string, attachments: Attachment[]) {
  const names = attachments.map((a) => a.name).join(' ')
  return `${text} ${names}`.trim()
}

/** Context object handed to tool executors, bound to live stores. */
function makeToolContext() {
  const app = useApp.getState()
  const data = useData.getState()
  const settings = app.settings || {}
  const workspace = settings.workspace || ''

  return {
    workspace,
    theme: (settings.appearance?.theme === 'light' ? 'light' : 'dark') as 'dark' | 'light',
    settings,
    kbIndex: data.kbIndex,
    kbDocs: data.kbDocs,
    wrongEntries: data.wrongEntries,
    addWrongEntry: (e: any) => useData.getState().addWrongEntry(e),
    addFlashcard: (c: any) => useData.getState().addFlashcard(c),
    saveKnowledgeNote: (name: string, text: string, tags?: string[], subject?: string) =>
      useData.getState().importText(name, text, { tags, subject, type: 'manual' }),
    savePlan: async (schedule: any) => {
      await bridge.planner.setSchedule(schedule)
      const status = await bridge.planner.status().catch(() => null)
      if (status) useApp.getState().setPlannerStatus(status)
    },
    exportDoc: async ({ format, title, markdown, rows }: any) => {
      void rows
      const res = await bridge.doc.export({ format, title, markdown })
      if (!res?.ok) return { text: `导出失败：${res?.error || '未知错误'}`, label: '导出失败' }
      const art: Artifact = {
        id: uid('art'),
        kind: 'doc',
        name: (res.file || '').split(/[\\/]/).pop() || title,
        path: res.file,
        ext: format,
        createdAt: Date.now(),
        size: (await bridge.fs.stat(res.file!))?.size,
      }
      await useData.getState().addArtifact(art)
      return {
        label: `已导出 ${format.toUpperCase()}`,
        artifacts: [art],
        text: `文件已保存到：${res.file}\n（已同时显示在对话中，学生可点击预览或打开。）请简要说明文件内容结构，不要重复正文。`,
      }
    },
    readFile: async (p: string) => {
      const { parseFile } = await import('../lib/parse')
      const path = /^([a-zA-Z]:[\\/]|\/)/.test(p) ? p : workspace ? `${workspace}/${p}` : p
      try {
        const parsed = await parseFile(path, bridge.fs.readBase64, bridge.fs.readText)
        return parsed.text
      } catch (e: any) {
        return ''
      }
    },
    listWorkspace: async () => {
      if (!workspace) return ''
      const rows = await bridge.fs.listDir(workspace)
      if (!rows.length) return ''
      return rows
        .slice(0, 80)
        .map((r) => `${r.isDir ? '📁' : '📄'} ${r.name}${r.isDir ? '/' : `  (${(r.size / 1024).toFixed(1)}KB)`}`)
        .join('\n')
    },
    writeFile: async (path: string, text: string) => {
      const res = await bridge.fs.writeText(path, text)
      return res.ok ? path : ''
    },
  }
}

/* ------------------------------------------------------------------ */
/* derived selectors                                                   */
/* ------------------------------------------------------------------ */
export function sessionListSorted(sessions: ChatSession[], search: string) {
  let list = sessions
  if (search.trim()) {
    const q = search.trim().toLowerCase()
    list = list.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.messages.some((m) => m.content.toLowerCase().includes(q)),
    )
  }
  return [...list].sort((a, b) => (a.pinned === b.pinned ? b.updatedAt - a.updatedAt : a.pinned ? -1 : 1))
}

/** Total estimated tokens across the whole history, for the settings screen. */
export function estimateSavedTokens(sessions: ChatSession[]) {
  let saved = 0
  for (const s of sessions) {
    for (const m of s.messages) {
      if (m.role === 'tool' && !m.content) continue
      if (m.compacted) saved += estimateTokens(m.content)
    }
  }
  return saved
}
