import { useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { useData } from '../store/useData'
import { Icon } from '../components/Icons'
import { EmptyState, Field, Modal, Segmented } from '../components/ui'
import { Markdown } from '../components/Markdown'
import { clsx, fmtDate, relativeTime, uid } from '../lib/util'
import type { Flashcard } from '../lib/types'

export function FlashcardsView() {
  const app = useApp()
  const data = useData()
  const [tab, setTab] = useState<'review' | 'browse'>('review')
  const [flipped, setFlipped] = useState(false)
  const [idx, setIdx] = useState(0)
  const [sessionDone, setSessionDone] = useState(0)
  const [editing, setEditing] = useState<Partial<Flashcard> | null>(null)
  const [query, setQuery] = useState('')

  const due = useMemo(() => data.dueFlashcards(), [data.flashcards])
  const card = due[Math.min(idx, Math.max(0, due.length - 1))]

  const browseList = useMemo(() => {
    let rows = data.flashcards
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      rows = rows.filter((c) => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q))
    }
    return [...rows].sort((a, b) => a.dueAt - b.dueAt)
  }, [data.flashcards, query])

  const stats = useMemo(() => {
    const now = Date.now()
    const total = data.flashcards.length
    const ready = data.flashcards.filter((c) => c.dueAt <= now).length
    const learning = data.flashcards.filter((c) => c.box <= 2).length
    const mature = data.flashcards.filter((c) => c.box >= 4).length
    const lapses = data.flashcards.reduce((n, c) => n + c.lapses, 0)
    return { total, ready, learning, mature, lapses }
  }, [data.flashcards])

  return (
    <>
      <div className="panel-head">
        <Icon.cards size={19} style={{ color: 'var(--accent)' }} />
        <div className="grow">
          <h1>背诵卡片</h1>
          <div className="sub">
            共 {stats.total} 张 · 今日待复习 {stats.ready} 张 · 巩固中 {stats.learning} · 已牢固 {stats.mature}
          </div>
        </div>
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as typeof tab)}
          options={[
            { value: 'review', label: `复习 (${stats.ready})`, icon: 'refresh' },
            { value: 'browse', label: '全部卡片', icon: 'list' },
          ]}
        />
        <button
          className="btn sm"
          title="把错题本里的知识点自动转成卡片"
          disabled={!data.wrongEntries.length}
          onClick={async () => {
            const n = await data.generateCardsFromWrongbook()
            app.toast({
              kind: n ? 'success' : 'info',
              title: n ? `已生成 ${n} 张卡片` : '没有新的可生成内容',
              body: n ? '来自错题本的知识点，已进入复习队列。' : '错题本里的知识点都已经生成过卡片了。',
            })
          }}
        >
          <Icon.sparkles size={14} />
          错题转卡片
        </button>
        <button className="btn sm primary" onClick={() => setEditing({ front: '', back: '', knowledgePoints: [] })}>
          <Icon.plus size={14} />
          新建卡片
        </button>
      </div>

      <div className="panel-body">
        {tab === 'review' ? (
          !due.length ? (
            <EmptyState
              icon="award"
              title="没有需要复习的卡片"
              body={
                stats.total
                  ? '所有卡片都还在间隔期内。按遗忘曲线，下次到期时会自动出现在这里。'
                  : '还没有卡片。可以让 AI 把知识点或错题整理成卡片，也可以手动新建。'
              }
            >
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" onClick={() => app.setView('chat')}>
                  <Icon.sparkles size={15} />
                  让 AI 生成卡片
                </button>
                {stats.total ? (
                  <button className="btn" onClick={() => setTab('browse')}>
                    浏览全部
                  </button>
                ) : null}
              </div>
            </EmptyState>
          ) : !card ? null : (
            <div className="flash-stage">
              <div className="row between" style={{ marginBottom: 13, fontSize: 12.5 }}>
                <span className="muted">
                  第 {idx + 1} / {due.length} 张 · 已完成 {sessionDone} 张
                </span>
                <span className="muted">
                  {card.source === 'wrongbook' ? '来自错题本' : card.source === 'agent' ? 'AI 生成' : '手动创建'} · 复习 {card.reviewCount} 次
                </span>
              </div>
              <div className="bar-track" style={{ marginBottom: 18 }}>
                <div className="bar-fill" style={{ width: `${((idx + 1) / due.length) * 100}%` }} />
              </div>

              <div className="flash-card" onClick={() => setFlipped((f) => !f)}>
                {card.subject ? <span className="chip accent fc-tag">{card.subject}</span> : null}
                <span className="chip fc-tag" style={{ left: card.subject ? 'auto' : 17, right: 17 }}>
                  第 {card.box + 1} 级
                </span>

                {!flipped ? (
                  <>
                    <div className="muted" style={{ fontSize: 11.5, letterSpacing: '0.1em', marginBottom: 12 }}>
                      问题
                    </div>
                    <div className="fc-front">{card.front}</div>
                    {card.knowledgePoints.length ? (
                      <div className="row wrap" style={{ gap: 6, marginTop: 18, justifyContent: 'center' }}>
                        {card.knowledgePoints.slice(0, 4).map((k) => (
                          <span className="chip" key={k}>
                            {k}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="muted" style={{ fontSize: 11.5, letterSpacing: '0.1em', marginBottom: 10, alignSelf: 'flex-start' }}>
                      答案
                    </div>
                    <div className="fc-back">
                      <Markdown>{card.back}</Markdown>
                    </div>
                  </>
                )}
                <span className="fc-flip">{flipped ? '点击翻回问题' : '点击显示答案'}</span>
              </div>

              {flipped ? (
                <div className="grade-row">
                  <button
                    className="grade-btn again"
                    onClick={async () => {
                      await data.gradeFlashcard(card.id, 'again')
                      setFlipped(false)
                      setSessionDone((n) => n + 1)
                      setIdx((i) => i + 1)
                    }}
                  >
                    完全忘了
                    <small>10 分钟后再来</small>
                  </button>
                  <button
                    className="grade-btn hard"
                    onClick={async () => {
                      await data.gradeFlashcard(card.id, 'hard')
                      setFlipped(false)
                      setSessionDone((n) => n + 1)
                      setIdx((i) => i + 1)
                    }}
                  >
                    想了一会儿
                    <small>保持当前间隔</small>
                  </button>
                  <button
                    className="grade-btn good"
                    onClick={async () => {
                      await data.gradeFlashcard(card.id, 'good')
                      setFlipped(false)
                      setSessionDone((n) => n + 1)
                      setIdx((i) => i + 1)
                    }}
                  >
                    想起来了
                    <small>间隔加倍</small>
                  </button>
                  <button
                    className="grade-btn easy"
                    onClick={async () => {
                      await data.gradeFlashcard(card.id, 'easy')
                      setFlipped(false)
                      setSessionDone((n) => n + 1)
                      setIdx((i) => i + 1)
                    }}
                  >
                    太简单了
                    <small>跳两级</small>
                  </button>
                </div>
              ) : (
                <div className="row" style={{ marginTop: 16, justifyContent: 'center', gap: 9 }}>
                  <button className="btn" onClick={() => { setFlipped(false); setIdx((i) => i + 1) }} title="跳过这张，稍后再来">
                    跳过
                  </button>
                  <button className="btn ghost" onClick={() => setEditing(card)}>
                    <Icon.edit size={14} />
                    编辑
                  </button>
                </div>
              )}
              <div className="muted" style={{ fontSize: 11.5, textAlign: 'center', marginTop: 14 }}>
                间隔重复：10 分钟 → 1 天 → 2 天 → 4 天 → 7 天 → 15 天 → 30 天。答错会退回第一级。
              </div>
            </div>
          )
        ) : (
          <>
            <div className="row" style={{ marginBottom: 14, gap: 10 }}>
              <div className="row center grow" style={{ gap: 8 }}>
                <Icon.search size={15} style={{ color: 'var(--text-3)' }} />
                <input className="input" placeholder="搜索卡片内容…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <button className="btn sm" onClick={() => setTab('review')}>
                <Icon.play size={13} />
                开始复习
              </button>
            </div>

            {browseList.length ? (
              <div className="col" style={{ gap: 8 }}>
                {browseList.map((c) => {
                  const isDue = c.dueAt <= Date.now()
                  return (
                    <div className="kb-item" key={c.id} style={{ alignItems: 'flex-start' }}>
                      <div className="kb-icon" style={{ background: isDue ? 'var(--accent-soft)' : 'var(--bg-3)', color: isDue ? 'var(--accent)' : 'var(--text-3)' }}>
                        <Icon.cards size={17} />
                      </div>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="kb-name" style={{ fontWeight: 570 }}>
                          {c.front}
                        </div>
                        <div className="kb-meta">
                          <span>第 {c.box + 1} 级</span>
                          {c.subject ? <span>{c.subject}</span> : null}
                          <span>复习 {c.reviewCount} 次</span>
                          {c.lapses ? <span style={{ color: 'var(--err)' }}>遗忘 {c.lapses} 次</span> : null}
                          <span>{isDue ? '待复习' : `下次 ${fmtDate(c.dueAt)}`}</span>
                        </div>
                      </div>
                      <div className="row" style={{ gap: 4, flex: '0 0 auto' }}>
                        <button className="btn ghost icon sm" title="编辑" onClick={() => setEditing(c)}>
                          <Icon.edit size={14} />
                        </button>
                        <button
                          className="btn ghost icon sm"
                          title="重置进度"
                          onClick={() => data.updateFlashcard(c.id, { box: 0, dueAt: Date.now(), reviewCount: 0, lapses: 0 })}
                        >
                          <Icon.refresh size={14} />
                        </button>
                        <button
                          className="btn ghost icon sm"
                          title="删除"
                          onClick={async () => {
                            const ok = await app.ask({ title: '删除这张卡片？', confirmText: '删除', danger: true })
                            if (ok) await data.deleteFlashcard(c.id)
                          }}
                        >
                          <Icon.trash size={14} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <EmptyState icon="cards" title={query ? '没有匹配的卡片' : '还没有卡片'} body={query ? '换个关键词试试。' : '让 AI 把知识点整理成卡片，或在错题本里点「错题转卡片」。'} />
            )}
          </>
        )}
      </div>

      <CardEditor
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={async (c) => {
          if (c.id) await data.updateFlashcard(c.id, c)
          else await data.addFlashcard(c)
          setEditing(null)
          app.toast({ kind: 'success', title: '卡片已保存' })
        }}
      />
    </>
  )
}

function CardEditor({
  editing,
  onClose,
  onSave,
}: {
  editing: Partial<Flashcard> | null
  onClose: () => void
  onSave: (c: Partial<Flashcard>) => void
}) {
  const [draft, setDraft] = useState<Partial<Flashcard>>({})
  const [kp, setKp] = useState('')
  useMemo(() => {
    if (editing) {
      setDraft(editing)
      setKp((editing.knowledgePoints || []).join('、'))
    }
  }, [editing])

  if (!editing) return null
  return (
    <Modal
      open
      onClose={onClose}
      title={editing.id ? '编辑卡片' : '新建卡片'}
      icon="cards"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!draft.front?.trim() || !draft.back?.trim()}
            onClick={() => onSave({ ...draft, knowledgePoints: kp.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean) })}
          >
            <Icon.check size={15} />
            保存
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <Field label="问题（正面）" hint="要具体、可自我检测，避免“简述XX理论”这类过于宽泛的问法。">
          <textarea className="textarea" rows={2} value={draft.front || ''} onChange={(e) => setDraft({ ...draft, front: e.target.value })} placeholder="如：洛必达法则的使用条件有哪三个？" />
        </Field>
        <Field label="答案（背面）" hint="先给核心要点，再展开。支持 Markdown 与 LaTeX。">
          <textarea className="textarea" rows={4} value={draft.back || ''} onChange={(e) => setDraft({ ...draft, back: e.target.value })} />
        </Field>
        <div className="row" style={{ gap: 12 }}>
          <Field label="科目">
            <input className="input" value={draft.subject || ''} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="数学一" />
          </Field>
          <Field label="知识点">
            <input className="input" value={kp} onChange={(e) => setKp(e.target.value)} placeholder="洛必达法则、极限" />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
