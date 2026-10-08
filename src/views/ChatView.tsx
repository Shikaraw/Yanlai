import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store/useApp'
import { useChat } from '../store/useChat'
import { useData } from '../store/useData'
import { Icon, FEATURE_ICON } from '../components/Icons'
import { AutoTextarea, EmptyState } from '../components/ui'
import { MessageBubble } from '../components/MessageBubble'
import { FEATURES, SAMPLE_PROMPTS, featureById, featureGreeting } from '../lib/prompts'
import { attachmentFromFile, attachmentFromPath, filesFromDataTransfer, totalAttachmentSize } from '../lib/attachments'
import { clsx, fmtBytes, uid } from '../lib/util'
import { speech } from '../lib/tts'
import { bridge } from '../lib/bridge'
import type { Artifact, Attachment, ChatMessage } from '../lib/types'

export function ChatView({ onOpenArtifact }: { onOpenArtifact: (a: Artifact) => void }) {
  const app = useApp()
  const chat = useChat()
  const data = useData()
  const session = chat.sessions.find((s) => s.id === chat.currentId) || null

  const [input, setInput] = useState('')
  const [atts, setAtts] = useState<Attachment[]>([])
  const [feature, setFeature] = useState(session?.feature || 'general')
  const [dragging, setDragging] = useState(false)
  const [featureMenuOpen, setFeatureMenuOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const dragDepth = useRef(0)

  const settings = app.settings || {}
  const sendOnEnter = settings.ui?.sendOnEnter !== false
  const subject = session?.subject || ''
  const greeting = useMemo(() => featureGreeting(feature, subject), [feature, subject])

  // keep the composer feature in sync when switching sessions
  useEffect(() => {
    setFeature(session?.feature || 'general')
  }, [session?.id])

  // restore an edit target coming from a message action
  useEffect(() => {
    if (chat.editTarget) {
      setInput(chat.editTarget.text)
      chat.setEditTarget(null)
    }
  }, [chat.editTarget])

  /* ---------------- autoscroll ---------------- */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (stickToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [session?.messages, chat.streaming])

  /* ---------------- global drag & drop ---------------- */
  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      dragDepth.current++
      setDragging(true)
    }
    const onLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const onOver = (e: DragEvent) => e.preventDefault()
    const onDrop = async (e: DragEvent) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const files = filesFromDataTransfer(e.dataTransfer)
      if (files.length) await addFiles(files)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      const next: Attachment[] = []
      for (const f of list) {
        const a = await attachmentFromFile(f)
        if (a) next.push(a)
      }
      if (next.length) setAtts((prev) => [...prev, ...next])
    },
    [],
  )

  /* ---------------- paste ---------------- */
  const onPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const dt = e.clipboardData
      if (!dt) return
      const files = filesFromDataTransfer(dt)
      if (files.length) {
        e.preventDefault()
        await addFiles(files)
        return
      }
      // a pasted image can also arrive as a bare bitmap
      const items = Array.from(dt.items || [])
      const img = items.find((i) => i.type.startsWith('image/'))
      if (img) {
        const f = img.getAsFile()
        if (f) {
          e.preventDefault()
          await addFiles([f])
        }
      }
    },
    [addFiles],
  )

  /* ---------------- pick files ---------------- */
  const pickFiles = async () => {
    const paths = await bridge.dialog.openFiles({ multi: true, title: '选择要附加的资料' })
    const next: Attachment[] = []
    for (const p of paths) {
      const a = await attachmentFromPath(p)
      if (a) next.push(a)
    }
    if (next.length) setAtts((prev) => [...prev, ...next])
    else if (paths.length) app.toast({ kind: 'warn', title: '未能附加', body: '文件类型可能不受支持。' })
  }

  /* ---------------- send ---------------- */
  const doSend = async (overrideText?: string, opts: { regenerate?: boolean; editMessageId?: string } = {}) => {
    const text = overrideText ?? input
    if (!text.trim() && !atts.length && !opts.regenerate) return
    const payloadAtts = atts
    setInput('')
    setAtts([])
    stickToBottom.current = true
    // move the scroll after the new bubble mounts
    setTimeout(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }, 40)
    await chat.send({ text, attachments: payloadAtts, feature, ...opts })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      if (sendOnEnter && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        void doSend()
      } else if (!sendOnEnter && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void doSend()
      }
    }
    if (e.key === 'ArrowUp' && !input && !chat.streaming) {
      // shell-like history recall
      const prev = [...(session?.messages || [])].reverse().find((m) => m.role === 'user')
      if (prev) {
        e.preventDefault()
        setInput(prev.content)
      }
    }
  }

  const messages = session?.messages || []
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant' && !m.streaming)?.id
  const activeSpeech = useRef(false)

  useEffect(() => {
    const unsub = speech.subscribe((st) => {
      activeSpeech.current = st.speaking
    })
    return () => {
      unsub()
    }
  }, [])
  const [reading, setReading] = useState(false)
  useEffect(() => {
    const unsub = speech.subscribe((st) => setReading(st.speaking))
    return () => {
      unsub()
    }
  }, [])

  const attSize = totalAttachmentSize(atts)

  return (
    <div className="chat-wrap">
      <div className="chat-main">
        <div className="chat-scroll" ref={scrollRef} id="yanlai-chat-scroll">
          {!messages.length ? (
            <Welcome feature={feature} subject={subject} onPick={(t) => setInput(t)} onSend={(t) => doSend(t)} greeting={greeting} />
          ) : (
            <div className="thread">
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  isLastAssistant={m.id === lastAssistantId}
                  showTimestamps={settings.ui?.showTimestamps}
                  onRegenerate={() => doSend(undefined, { regenerate: true })}
                  onEdit={(mm) => {
                    if (mm.role === 'user') {
                      const idx = messages.findIndex((x) => x.id === mm.id)
                      const text = messages.slice(0, idx).map((x) => x.content).join('\n\n')
                      void doSend(mm.content, { editMessageId: mm.id })
                      void text
                    } else {
                      chat.setEditTarget({ messageId: 'quote', text: `> ${mm.content.slice(0, 400)}\n\n` })
                      setInput(`> ${mm.content.slice(0, 400)}\n\n`)
                    }
                  }}
                  onDelete={() => chat.deleteMessage(m.id)}
                  onOpenArtifact={onOpenArtifact}
                  onOpenImage={(src, alt) => onOpenArtifact({ id: uid('img'), kind: 'image', name: alt || '图片', dataUrl: src, createdAt: Date.now() })}
                />
              ))}
              {chat.lastRetrieval && (chat.lastRetrieval.docs > 0 || chat.lastRetrieval.wrongs > 0) ? (
                <div className="row center" style={{ justifyContent: 'center', marginTop: -6 }}>
                  <span className="chip" title={`知识库 ${chat.lastRetrieval.docs} 段 / ${chat.lastRetrieval.chars} 字，错题 ${chat.lastRetrieval.wrongs} 条`}>
                    <Icon.database size={12} />
                    已检索知识库 {chat.lastRetrieval.docs} 段
                    {chat.lastRetrieval.wrongs ? ` · 关联错题 ${chat.lastRetrieval.wrongs} 条` : ''}
                    <span className="muted">（本地检索，零 token）</span>
                  </span>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer">
            {/* feature strip */}
            <div className="feature-strip">
              {FEATURES.map((f) => {
                const FI = Icon[FEATURE_ICON[f.id] || 'chat']
                return (
                  <button
                    key={f.id}
                    className={clsx('feature-pill', feature === f.id && 'active')}
                    onClick={() => setFeature(f.id)}
                    title={f.instruction.slice(0, 120)}
                  >
                    <FI size={13} />
                    {f.label}
                  </button>
                )
              })}
            </div>

            <div
              className={clsx('composer-box', dragging && 'dragover')}
              onDragOver={(e) => {
                e.preventDefault()
              }}
              onDrop={async (e) => {
                e.preventDefault()
                const files = filesFromDataTransfer(e.dataTransfer)
                if (files.length) await addFiles(files)
              }}
            >
              {atts.length ? (
                <div className="composer-atts">
                  {atts.map((a) => (
                    <div className="composer-att" key={a.id} title={a.path || a.name}>
                      {a.kind === 'image' && a.dataUrl ? (
                        <img src={a.dataUrl} alt={a.name} />
                      ) : (
                        <Icon.file size={15} />
                      )}
                      <span className="ca-name">{a.name}</span>
                      {a.size ? <span className="muted" style={{ fontSize: 10 }}>{fmtBytes(a.size)}</span> : null}
                      <span className="ca-x" onClick={() => setAtts((p) => p.filter((x) => x.id !== a.id))} role="button" aria-label="移除">
                        <Icon.x size={12} />
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              <AutoTextarea
                id="yanlai-composer"
                value={input}
                onChange={setInput}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                placeholder={`${featureById(feature).label}｜输入问题，或粘贴题目截图（Ctrl+V）、拖入资料文件…`}
                disabled={chat.streaming}
              />

              <div className="composer-bar">
                <button className="btn ghost icon sm" onClick={pickFiles} title="添加文件或图片">
                  <Icon.paperclip size={16} />
                </button>
                <button
                  className="btn ghost icon sm"
                  title="截屏提问：粘贴剪贴板中的图片"
                  onClick={async () => {
                    const files = await readClipboardImage()
                    if (files) await addFiles([files])
                    else app.toast({ kind: 'info', title: '剪贴板中没有图片', body: '可用系统截图工具（Win+Shift+S）截图后再按 Ctrl+V。' })
                  }}
                >
                  <Icon.image size={16} />
                </button>
                <button
                  className={clsx('btn ghost icon sm')}
                  title={reading ? '停止朗读' : '朗读当前模式说明 / 停止朗读'}
                  onClick={() => (reading ? speech.stop() : app.toast({ kind: 'info', title: '朗读已就绪', body: '每条回复下方有「朗读」按钮。可在设置 → 朗读中配置自动朗读。' }))}
                >
                  {reading ? <Icon.volumeOff size={16} style={{ color: 'var(--err)' }} /> : <Icon.volume size={16} />}
                </button>

                <span className="composer-hint">
                  {atts.length ? (
                    <>
                      {atts.length} 个附件 · {fmtBytes(attSize)}
                      {' · '}
                    </>
                  ) : null}
                  {sendOnEnter ? (
                    <>
                      <span className="kbd">Enter</span> 发送 · <span className="kbd">Shift+Enter</span> 换行
                    </>
                  ) : (
                    <>
                      <span className="kbd">Ctrl+Enter</span> 发送
                    </>
                  )}
                </span>

                {chat.streaming ? (
                  <button className="send-btn stop" onClick={() => chat.stop()} title="停止生成">
                    <Icon.stop size={15} />
                  </button>
                ) : (
                  <button className="send-btn" disabled={!input.trim() && !atts.length} onClick={() => doSend()} title="发送">
                    <Icon.send size={15} />
                  </button>
                )}
              </div>
            </div>

            {chat.streamStats?.promptTokens && settings.ui?.showTokens !== false && chat.streaming ? (
              <div className="row" style={{ justifyContent: 'center', marginTop: 6, fontSize: 11, color: 'var(--text-3)' }}>
                上下文 ~{chat.streamStats.promptTokens} tok
                {chat.streamStats.usedTools ? ` · 已调用 ${chat.streamStats.usedTools} 个工具` : ''}
                {settings.tokens?.savingEnabled !== false ? ' · 省 token 模式已开启' : ''}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {dragging ? (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <Icon.upload size={42} />
            <h2 style={{ margin: '14px 0 6px', fontSize: 19 }}>松开以添加资料</h2>
            <p style={{ margin: 0, fontSize: 13.5 }}>图片、PDF、Word、Excel、Markdown 均可直接拖入</p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* welcome screen                                                      */
/* ------------------------------------------------------------------ */
function Welcome({
  feature,
  onPick,
  onSend,
  greeting,
  subject,
}: {
  feature: string
  onPick: (t: string) => void
  onSend: (t: string) => void
  greeting: string
  subject: string
}) {
  const app = useApp()
  const data = useData()
  const f = featureById(feature)
  const hasKb = data.kbDocs.length > 0
  const wrongDue = useMemo(() => {
    const end = new Date()
    end.setHours(23, 59, 59, 999)
    return data.wrongEntries.filter((w) => w.mastery < 5 && (w.nextReviewAt ?? 0) <= end.getTime()).length
  }, [data.wrongEntries])
  const cardsDue = useMemo(() => data.dueFlashcards().length, [data.flashcards])

  return (
    <div className="welcome">
      <div className="welcome-mark">
        <img className="welcome-logo" src="./logo.svg" alt="研来" />
        <div>
          <h1>研来 · 考研辅导</h1>
          <div className="muted" style={{ fontSize: 12.5, letterSpacing: '0.05em' }}>YANLAI · POSTGRADUATE ENTRANCE EXAM TUTOR</div>
        </div>
      </div>
      <p className="tagline">{greeting}</p>

      <div className="sample-grid">
        {SAMPLE_PROMPTS.map((p) => (
          <button className="sample-card" key={p} onClick={() => onPick(p)} title="点击填入输入框">
            <span className="row center" style={{ gap: 8 }}>
              <Icon.sparkles size={13} style={{ color: 'var(--accent)', flex: '0 0 auto' }} />
              <span>{p}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="hint-tiles">
        <div className="hint-tile">
          <Icon.image size={15} style={{ color: 'var(--accent)', flex: '0 0 auto', marginTop: 2 }} />
          <span>
            <b>截图就能讲题。</b>按 <span className="kbd">Win+Shift+S</span> 截图后在输入框 <span className="kbd">Ctrl+V</span>，我会直接读图讲解。
          </span>
        </div>
        <div className="hint-tile">
          <Icon.database size={15} style={{ color: hasKb ? 'var(--ok)' : 'var(--text-3)', flex: '0 0 auto', marginTop: 2 }} />
          <span>
            {hasKb ? (
              <>
                知识库已收录 <b>{data.kbDocs.length}</b> 份资料，提问时会自动检索并标注出处。
              </>
            ) : (
              <>
                还没有知识库。<button className="btn ghost sm" style={{ padding: '0 4px' }} onClick={() => app.setView('knowledge')}>导入教材或真题</button>，回答会更贴合你的资料。
              </>
            )}
          </span>
        </div>
        <div className="hint-tile">
          <Icon.fire size={15} style={{ color: 'var(--accent)', flex: '0 0 auto', marginTop: 2 }} />
          <span>
            <b>今天待办：</b>
            {wrongDue ? <button className="btn ghost sm" style={{ padding: '0 4px' }} onClick={() => app.setView('wrongbook')}>错题复习 {wrongDue} 道</button> : <span className="muted">错题已复习完</span>}
            {' · '}
            {cardsDue ? <button className="btn ghost sm" style={{ padding: '0 4px' }} onClick={() => app.setView('flashcards')}>背诵卡片 {cardsDue} 张</button> : <span className="muted">卡片无待复习</span>}
          </span>
        </div>
        <div className="hint-tile">
          <Icon.zap size={15} style={{ color: 'var(--accent)', flex: '0 0 auto', marginTop: 2 }} />
          <span>
            <b>省 token 已启用：</b>知识库检索、错题关联与标题生成全部在本机完成，不额外消耗额度。
          </span>
        </div>
      </div>

      {/* quick feature launchers */}
      <div style={{ marginTop: 22 }}>
        <div className="muted" style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 9 }}>
          或者直接开始一项学习任务
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {FEATURES.filter((x) => x.seed).map((x) => {
            const FI = Icon[FEATURE_ICON[x.id] || 'chat']
            return (
              <button key={x.id} className="btn sm" onClick={() => onPick(`${x.seed}${x.seed.endsWith('\n') ? '' : ' '}`)}>
                <FI size={14} />
                {x.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* clipboard image helper                                              */
/* ------------------------------------------------------------------ */
async function readClipboardImage(): Promise<File | null> {
  try {
    const items = await (navigator.clipboard as any).read?.()
    for (const it of items || []) {
      for (const type of it.types || []) {
        if (type.startsWith('image/')) {
          const blob = await it.getType(type)
          return new File([blob], `剪贴板图片-${Date.now()}.png`, { type })
        }
      }
    }
  } catch {}
  return null
}
