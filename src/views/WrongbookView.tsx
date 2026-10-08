import { useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { useData } from '../store/useData'
import { Icon } from '../components/Icons'
import { BarList, Donut, EmptyState, Field, Modal, Segmented, Switch } from '../components/ui'
import { Markdown } from '../components/Markdown'
import { clsx, fmtDate, relativeTime, uid } from '../lib/util'
import { REASON_CATEGORIES, type ReasonCategory, type WrongEntry } from '../lib/types'

type SortKey = 'recent' | 'difficulty' | 'mastery' | 'due'

export function WrongbookView() {
  const app = useApp()
  const data = useData()
  const [query, setQuery] = useState('')
  const [subject, setSubject] = useState('全部')
  const [reason, setReason] = useState('全部')
  const [kp, setKp] = useState('全部')
  const [sort, setSort] = useState<SortKey>('recent')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<Partial<WrongEntry> | null>(null)
  const [tab, setTab] = useState<'list' | 'stats' | 'review'>('list')
  const [showStats, setShowStats] = useState(false)

  const stats = useMemo(() => data.wrongStats(), [data.wrongEntries])

  const subjects = useMemo(() => ['全部', ...new Set(data.wrongEntries.map((w) => w.subject))], [data.wrongEntries])
  const reasons = useMemo(() => ['全部', ...new Set(data.wrongEntries.map((w) => w.reasonCategory))], [data.wrongEntries])
  const kps = useMemo(() => ['全部', ...new Set(data.wrongEntries.flatMap((w) => w.knowledgePoints))].slice(0, 60), [data.wrongEntries])

  const filtered = useMemo(() => {
    let rows = data.wrongEntries
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      rows = rows.filter(
        (w) =>
          w.question.toLowerCase().includes(q) ||
          w.reason.toLowerCase().includes(q) ||
          (w.myAnswer || '').toLowerCase().includes(q) ||
          w.knowledgePoints.some((k) => k.toLowerCase().includes(q)),
      )
    }
    if (subject !== '全部') rows = rows.filter((w) => w.subject === subject)
    if (reason !== '全部') rows = rows.filter((w) => w.reasonCategory === reason)
    if (kp !== '全部') rows = rows.filter((w) => w.knowledgePoints.includes(kp))

    const by: Record<SortKey, (a: WrongEntry, b: WrongEntry) => number> = {
      recent: (a, b) => b.createdAt - a.createdAt,
      difficulty: (a, b) => b.difficulty - a.difficulty,
      mastery: (a, b) => a.mastery - b.mastery,
      due: (a, b) => (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0),
    }
    return [...rows].sort(by[sort])
  }, [data.wrongEntries, query, subject, reason, kp, sort])

  const dueList = useMemo(() => {
    const end = new Date()
    end.setHours(23, 59, 59, 999)
    return data.wrongEntries.filter((w) => w.mastery < 5 && (w.nextReviewAt ?? 0) <= end.getTime()).sort((a, b) => (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0))
  }, [data.wrongEntries])

  const [reviewIdx, setReviewIdx] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const reviewItem = dueList[Math.min(reviewIdx, Math.max(0, dueList.length - 1))]

  return (
    <>
      <div className="panel-head">
        <Icon.target size={19} style={{ color: 'var(--accent)' }} />
        <div className="grow">
          <h1>错题本</h1>
          <div className="sub">
            共 {stats.total} 道 · 待复习 {stats.dueToday} 道 · 已掌握 {stats.mastered} 道 · 平均掌握度 {stats.avgMastery.toFixed(1)}/5
          </div>
        </div>
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as typeof tab)}
          options={[
            { value: 'list', label: '错题列表', icon: 'list' },
            { value: 'review', label: `复习 (${stats.dueToday})`, icon: 'refresh' },
            { value: 'stats', label: '统计', icon: 'chart' },
          ]}
        />
        <button className="btn sm" onClick={() => setEditing({ subject: '', knowledgePoints: [], reasonCategory: '其他', difficulty: 3 })}>
          <Icon.plus size={14} />
          手动添加
        </button>
      </div>

      <div className="panel-body">
        {tab === 'list' ? (
          <>
            {/* filters */}
            <div className="card" style={{ marginBottom: 15 }}>
              <div className="row wrap" style={{ gap: 10 }}>
                <div className="row center" style={{ flex: '1 1 260px', gap: 8 }}>
                  <Icon.search size={15} style={{ color: 'var(--text-3)' }} />
                  <input className="input" placeholder="搜索题干、错因、知识点…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <select className="select" style={{ width: 140 }} value={subject} onChange={(e) => setSubject(e.target.value)}>
                  {subjects.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <select className="select" style={{ width: 150 }} value={reason} onChange={(e) => setReason(e.target.value)}>
                  {reasons.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <select className="select" style={{ width: 180 }} value={kp} onChange={(e) => setKp(e.target.value)}>
                  {kps.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <select className="select" style={{ width: 140 }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  <option value="recent">最近添加</option>
                  <option value="due">最快到期</option>
                  <option value="mastery">最不熟练</option>
                  <option value="difficulty">难度最高</option>
                </select>
              </div>
              {(query || subject !== '全部' || reason !== '全部' || kp !== '全部') && (
                <div className="row" style={{ marginTop: 10, gap: 8 }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    筛选出 {filtered.length} 道
                  </span>
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      setQuery('')
                      setSubject('全部')
                      setReason('全部')
                      setKp('全部')
                    }}
                  >
                    清除筛选
                  </button>
                </div>
              )}
            </div>

            {filtered.length ? (
              <div className="col" style={{ gap: 10 }}>
                {filtered.map((w) => (
                  <WrongRow
                    key={w.id}
                    w={w}
                    expanded={expanded === w.id}
                    onToggle={() => setExpanded(expanded === w.id ? null : w.id)}
                    onEdit={() => setEditing(w)}
                    onDelete={async () => {
                      const ok = await app.ask({ title: '删除这道错题？', body: '删除后无法恢复，相关的复习记录也会一并移除。', confirmText: '删除', danger: true })
                      if (ok) {
                        await data.deleteWrongEntry(w.id)
                        app.toast({ kind: 'success', title: '已删除' })
                      }
                    }}
                    onRate={(q) => data.reviewWrongEntry(w.id, q)}
                    onAsk={() => {
                      app.setView('chat')
                      app.toast({ kind: 'info', title: '已切换到对话', body: '把这道错题的题目发给我，我会针对你的错因重新讲解。' })
                    }}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                icon="target"
                title={data.wrongEntries.length ? '没有符合条件的错题' : '错题本还是空的'}
                body={
                  data.wrongEntries.length
                    ? '试试放宽筛选条件。'
                    : '做题时把题目、你的解答和正确答案一起发给我，我会分析错因、归类知识点并自动记入错题本。'
                }
              >
                {!data.wrongEntries.length ? (
                  <button className="btn primary" onClick={() => app.setView('chat')}>
                    <Icon.chat size={15} />
                    去对话里分析错题
                  </button>
                ) : null}
              </EmptyState>
            )}
          </>
        ) : null}

        {tab === 'review' ? (
          <ReviewMode
            dueList={dueList}
            item={reviewItem}
            idx={reviewIdx}
            revealed={revealed}
            onReveal={() => setRevealed(true)}
            onGrade={async (q) => {
              if (!reviewItem) return
              await data.reviewWrongEntry(reviewItem.id, q)
              setRevealed(false)
              setReviewIdx((i) => (i + 1 < dueList.length ? i + 1 : 0))
            }}
            onRestart={() => {
              setReviewIdx(0)
              setRevealed(false)
            }}
          />
        ) : null}

        {tab === 'stats' ? (
          <div className="col" style={{ gap: 16 }}>
            <div className="grid four">
              <div className="stat-tile">
                <div className="k">错题总数</div>
                <div className="v">{stats.total}</div>
              </div>
              <div className="stat-tile">
                <div className="k">今日待复习</div>
                <div className="v" style={{ color: stats.dueToday ? 'var(--accent)' : undefined }}>
                  {stats.dueToday}
                </div>
              </div>
              <div className="stat-tile">
                <div className="k">已掌握</div>
                <div className="v" style={{ color: 'var(--ok)' }}>
                  {stats.mastered}
                  <span style={{ fontSize: 14, fontWeight: 500 }}> / {stats.total}</span>
                </div>
              </div>
              <div className="stat-tile">
                <div className="k">平均掌握度</div>
                <div className="v">{stats.avgMastery.toFixed(1)}<span style={{ fontSize: 14, fontWeight: 500 }}> / 5</span></div>
              </div>
            </div>

            {stats.worstKnowledge.length ? (
              <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--warn) 34%, transparent)' }}>
                <div className="card-title">
                  <Icon.alert size={15} style={{ color: 'var(--warn)' }} />
                  最需要补的薄弱知识点
                </div>
                <div className="card-sub">这些知识点上你错了多次且尚未掌握，建议优先安排专项复习。</div>
                <div className="row wrap" style={{ gap: 7 }}>
                  {stats.worstKnowledge.map((k) => (
                    <button key={k} className="chip warn" style={{ cursor: 'pointer' }} onClick={() => { setKp(k); setTab('list') }}>
                      {k}
                    </button>
                  ))}
                </div>
                <button
                  className="btn sm"
                  style={{ marginTop: 11 }}
                  onClick={() => {
                    app.setView('chat')
                    app.toast({
                      kind: 'info',
                      title: '已切换到对话',
                      body: `可以对我说：「针对 ${stats.worstKnowledge.join('、')} 这几个薄弱点，给我一份专项复习方案」。`,
                    })
                  }}
                >
                  <Icon.sparkles size={14} />
                  生成专项复习方案
                </button>
              </div>
            ) : null}

            <div className="grid two">
              <div className="card">
                <div className="card-title">
                  <Icon.brain size={15} />
                  错因分布
                </div>
                <div className="card-sub">看清自己最常在哪一环出问题，比多刷题更重要。</div>
                <Donut rows={stats.byReason} />
              </div>
              <div className="card">
                <div className="card-title">
                  <Icon.layers size={15} />
                  知识点分布 Top 12
                </div>
                <div className="card-sub">错得最多的知识点排在前面。</div>
                <BarList rows={stats.byKnowledge.slice(0, 12)} />
              </div>
              <div className="card">
                <div className="card-title">
                  <Icon.book size={15} />
                  科目分布
                </div>
                <div className="card-sub">哪一科拖后腿一目了然。</div>
                <BarList rows={stats.bySubject} color="#a78bfa" />
              </div>
              <div className="card">
                <div className="card-title">
                  <Icon.trend size={15} />
                  难度分布
                </div>
                <div className="card-sub">难度 1-5，看错题集中在哪个难度档。</div>
                <BarList
                  rows={[1, 2, 3, 4, 5].map((d) => ({ key: `${d} 星`, n: Number(stats.byDifficulty.find((x) => x.key === String(d))?.n || 0) }))}
                  color="#fbbf24"
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <EntryEditor
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={async (e) => {
          if (e.id) await data.updateWrongEntry(e.id, e)
          else await data.addWrongEntry(e)
          setEditing(null)
          app.toast({ kind: 'success', title: '已保存到错题本' })
        }}
      />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* row                                                                 */
/* ------------------------------------------------------------------ */
function WrongRow({
  w,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onRate,
  onAsk,
}: {
  w: WrongEntry
  expanded: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  onRate: (q: 0 | 1 | 2) => void
  onAsk: () => void
}) {
  const overdue = (w.nextReviewAt ?? 0) < Date.now() && w.mastery < 5
  return (
    <div className="wb-item">
      <div className="wb-head" onClick={onToggle}>
        <Icon.chevron
          size={15}
          style={{ color: 'var(--text-3)', transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform 160ms', flex: '0 0 auto' }}
        />
        <div className="wb-q">
          <div className="q-text" title={w.question}>
            {w.question || '（无题干）'}
          </div>
          <div className="q-meta">
            <span className="chip">{w.subject}</span>
            <span className="chip warn">{w.reasonCategory}</span>
            {w.knowledgePoints.slice(0, 3).map((k) => (
              <span className="chip" key={k}>
                {k}
              </span>
            ))}
            {w.knowledgePoints.length > 3 ? <span className="chip">+{w.knowledgePoints.length - 3}</span> : null}
            <span className="chip" style={{ borderColor: 'transparent' }}>
              {'★'.repeat(w.difficulty)}
            </span>
          </div>
        </div>
        <div className="col center" style={{ gap: 3, flex: '0 0 auto', alignItems: 'flex-end' }}>
          <span className="mastery" title={`掌握度 ${w.mastery}/5`}>
            {[0, 1, 2, 3, 4].map((i) => (
              <i key={i} className={clsx(i < w.mastery && 'on')} />
            ))}
          </span>
          <span className="muted" style={{ fontSize: 10.5 }}>
            {w.mastery >= 5 ? '已掌握' : overdue ? '待复习' : `复习 ${fmtDate(w.nextReviewAt)}`}
            {' · '}
            {relativeTime(w.createdAt)}
          </span>
        </div>
      </div>

      {expanded ? (
        <div className="wb-body">
          {w.myAnswer ? (
            <div className="wb-section">
              <div className="wb-section-label">我的错解</div>
              <div className="wb-answer mine">{w.myAnswer}</div>
            </div>
          ) : null}
          {w.correctAnswer ? (
            <div className="wb-section">
              <div className="wb-section-label">正确解法</div>
              <div className="wb-answer correct">
                <Markdown>{w.correctAnswer}</Markdown>
              </div>
            </div>
          ) : null}
          <div className="wb-section">
            <div className="wb-section-label">错因分析 · {w.reasonCategory}</div>
            <div className="wb-answer reason">{w.reason}</div>
          </div>
          {w.knowledgePoints.length ? (
            <div className="wb-section">
              <div className="wb-section-label">涉及知识点</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {w.knowledgePoints.map((k) => (
                  <span className="chip accent" key={k}>
                    {k}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {w.note ? (
            <div className="wb-section">
              <div className="wb-section-label">备注</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{w.note}</div>
            </div>
          ) : null}

          <div className="row wrap between" style={{ marginTop: 14, gap: 9 }}>
            <div className="row center" style={{ gap: 6 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                复习自评：
              </span>
              <button className="btn sm danger" onClick={() => onRate(0)} title="还是做不出来">
                仍不会
              </button>
              <button className="btn sm" onClick={() => onRate(1)} title="做对了但不确定">
                有点模糊
              </button>
              <button className="btn sm" onClick={() => onRate(2)} title="完全掌握">
                <Icon.check size={13} />
                已掌握
              </button>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn ghost sm" onClick={onAsk}>
                <Icon.chat size={13} />
                让 AI 重讲
              </button>
              <button className="btn ghost sm" onClick={onEdit}>
                <Icon.edit size={13} />
                编辑
              </button>
              <button className="btn ghost sm" onClick={onDelete} style={{ color: 'var(--err)' }}>
                <Icon.trash size={13} />
                删除
              </button>
            </div>
          </div>
          {w.reviewCount ? (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
              已复习 {w.reviewCount} 次{w.lastReviewedAt ? ` · 上次 ${relativeTime(w.lastReviewedAt)}` : ''} · 采用遗忘曲线间隔（1/2/4/7/15/30 天）
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* review mode                                                         */
/* ------------------------------------------------------------------ */
function ReviewMode({
  dueList,
  item,
  idx,
  revealed,
  onReveal,
  onGrade,
  onRestart,
}: {
  dueList: WrongEntry[]
  item?: WrongEntry
  idx: number
  revealed: boolean
  onReveal: () => void
  onGrade: (q: 0 | 1 | 2) => void
  onRestart: () => void
}) {
  const app = useApp()
  if (!dueList.length) {
    return (
      <EmptyState icon="award" title="今天的错题复习已完成" body="按遗忘曲线，明天会有新的错题到期。也可以回到列表手动抽题复习。">
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={onRestart}>
            <Icon.refresh size={15} />
            重新开始
          </button>
          <button className="btn primary" onClick={() => app.setView('flashcards')}>
            <Icon.cards size={15} />
            去背卡片
          </button>
        </div>
      </EmptyState>
    )
  }
  if (!item) return null

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="row between" style={{ marginBottom: 13 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          第 {idx + 1} / {dueList.length} 道 · {item.subject} · 错因：{item.reasonCategory}
        </span>
        <span className="mastery" title={`当前掌握度 ${item.mastery}/5`}>
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} className={clsx(i < item.mastery && 'on')} />
          ))}
        </span>
      </div>
      <div className="bar-track" style={{ marginBottom: 17 }}>
        <div className="bar-fill" style={{ width: `${((idx + 1) / dueList.length) * 100}%` }} />
      </div>

      <div className="card" style={{ padding: 22 }}>
        <div className="wb-section-label">题目</div>
        <div style={{ fontSize: 15, lineHeight: 1.75, marginTop: 6 }}>
          <Markdown>{item.question}</Markdown>
        </div>

        {!revealed ? (
          <div className="row" style={{ justifyContent: 'center', marginTop: 22 }}>
            <button className="btn primary" onClick={onReveal} style={{ padding: '10px 22px' }}>
              <Icon.eye size={15} />
              先自己做一遍，然后查看答案
            </button>
          </div>
        ) : (
          <>
            {item.myAnswer ? (
              <div className="wb-section" style={{ marginTop: 20 }}>
                <div className="wb-section-label">你当时的错解</div>
                <div className="wb-answer mine">{item.myAnswer}</div>
              </div>
            ) : null}
            {item.correctAnswer ? (
              <div className="wb-section">
                <div className="wb-section-label">正确解法</div>
                <div className="wb-answer correct">
                  <Markdown>{item.correctAnswer}</Markdown>
                </div>
              </div>
            ) : null}
            <div className="wb-section">
              <div className="wb-section-label">错因归类 · {item.reasonCategory}</div>
              <div className="wb-answer reason">{item.reason}</div>
            </div>
            {item.knowledgePoints.length ? (
              <div className="wb-section">
                <div className="wb-section-label">知识点</div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {item.knowledgePoints.map((k) => (
                    <span className="chip accent" key={k}>
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {revealed ? (
        <div className="grade-row">
          <button className="grade-btn again" onClick={() => onGrade(0)}>
            仍不会
            <small>1 天后重来</small>
          </button>
          <button className="grade-btn hard" onClick={() => onGrade(1)}>
            有点模糊
            <small>缩短间隔</small>
          </button>
          <button className="grade-btn good" onClick={() => onGrade(2)}>
            已掌握
            <small>延长间隔</small>
          </button>
          <button className="grade-btn easy" onClick={onReveal}>
            再看一遍
            <small>留在本题</small>
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* entry editor                                                        */
/* ------------------------------------------------------------------ */
function EntryEditor({
  editing,
  onClose,
  onSave,
}: {
  editing: Partial<WrongEntry> | null
  onClose: () => void
  onSave: (e: Partial<WrongEntry>) => void
}) {
  const app = useApp()
  const [draft, setDraft] = useState<Partial<WrongEntry>>({})
  const [kpText, setKpText] = useState('')
  useState(() => {})

  // reset draft whenever the target changes
  useMemo(() => {
    if (editing) {
      setDraft(editing)
      setKpText((editing.knowledgePoints || []).join('、'))
    }
  }, [editing])

  if (!editing) return null

  const subjectList = ['数学一', '数学二', '数学三', '英语一', '英语二', '政治', '专业课', '未分类']
  const valid = !!draft.question?.trim() && !!draft.reason?.trim()

  return (
    <Modal
      open
      onClose={onClose}
      title={editing.id ? '编辑错题' : '添加错题'}
      icon="target"
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!valid}
            onClick={() =>
              onSave({
                ...draft,
                knowledgePoints: kpText
                  .split(/[、,，\s]+/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          >
            <Icon.check size={15} />
            保存
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Field label="科目">
            <input className="input" list="yanlai-subjects" value={draft.subject || ''} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="数学一" />
            <datalist id="yanlai-subjects">
              {subjectList.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          <Field label="章节（可选）">
            <input className="input" value={draft.chapter || ''} onChange={(e) => setDraft({ ...draft, chapter: e.target.value })} placeholder="如：高数 · 中值定理" />
          </Field>
          <Field label="难度">
            <select className="select" value={draft.difficulty || 3} onChange={(e) => setDraft({ ...draft, difficulty: Number(e.target.value) as any })}>
              {[1, 2, 3, 4, 5].map((d) => (
                <option key={d} value={d}>
                  {'★'.repeat(d)} {d}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="题干">
          <textarea className="textarea" rows={3} value={draft.question || ''} onChange={(e) => setDraft({ ...draft, question: e.target.value })} placeholder="粘贴题目内容（支持 LaTeX，如 $x^2$）" />
        </Field>

        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <Field label="我的错解">
            <textarea className="textarea" rows={3} value={draft.myAnswer || ''} onChange={(e) => setDraft({ ...draft, myAnswer: e.target.value })} placeholder="原样保留你的错误过程，便于以后看出思维路径" />
          </Field>
          <Field label="正确解法">
            <textarea className="textarea" rows={3} value={draft.correctAnswer || ''} onChange={(e) => setDraft({ ...draft, correctAnswer: e.target.value })} placeholder="关键步骤即可" />
          </Field>
        </div>

        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <Field label="错因分析" hint="一句话说清为什么会这样错。填写后系统会自动归类。">
            <textarea className="textarea" rows={2} value={draft.reason || ''} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} placeholder="如：忘记讨论判别式为负的情形，套公式时未验证适用范围" />
          </Field>
          <Field label="错因类别">
            <select className="select" value={draft.reasonCategory || '其他'} onChange={(e) => setDraft({ ...draft, reasonCategory: e.target.value as ReasonCategory })}>
              {REASON_CATEGORIES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <div className="field-hint">留空会按错因文字自动匹配。</div>
          </Field>
        </div>

        <Field label="知识点" hint="用顿号或逗号分隔，粒度到「拉格朗日中值定理」这一级，便于统计与复习。">
          <input className="input" value={kpText} onChange={(e) => setKpText(e.target.value)} placeholder="拉格朗日中值定理、导数的几何意义、不等式证明" />
        </Field>

        <div className="row" style={{ gap: 12 }}>
          <Field label="来源（可选）">
            <input className="input" value={draft.source || ''} onChange={(e) => setDraft({ ...draft, source: e.target.value })} placeholder="2023 数一真题 T15" />
          </Field>
          <Field label="备注（可选）">
            <input className="input" value={draft.note || ''} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </Field>
        </div>

        {!draft.id ? (
          <div className="settings-row" style={{ padding: '11px 14px' }}>
            <div className="sr-main">
              <div className="sr-title">同时生成背诵卡片</div>
              <div className="sr-desc">为每个知识点生成一张问答卡片，进入间隔重复队列，选择题能加深记忆。</div>
            </div>
            <Switch
              checked={app.settings?.memory?.autoFlashcards !== false}
              onChange={(v) => app.patchSettings({ memory: { autoFlashcards: v } }, { silent: true })}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
