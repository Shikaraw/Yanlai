import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { useData } from '../store/useData'
import { useChat } from '../store/useChat'
import { Icon } from '../components/Icons'
import { BarList, Donut, EmptyState, Ring, Sparkline } from '../components/ui'
import { bridge } from '../lib/bridge'
import { kvGet } from '../lib/idb'
import { clsx, fmtDate } from '../lib/util'

export function DashboardView() {
  const app = useApp()
  const data = useData()
  const chat = useChat()
  const [plannerStatus, setPlannerStatus] = useState<any>(app.plannerStatus)
  const [subjectTime, setSubjectTime] = useState<Record<string, number>>({})
  const [todayPlan, setTodayPlan] = useState<any[]>([])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const st = await bridge.planner.status().catch(() => null)
      const preview = await bridge.planner.preview(0).catch(() => null)
      const subj = await kvGet<Record<string, number>>('subjectTime', {})
      if (cancelled) return
      setPlannerStatus(st)
      setTodayPlan(Array.isArray(preview) ? preview : [])
      setSubjectTime(subj || {})
    }
    void load()
    const t = setInterval(load, 30000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const stats = useMemo(() => data.wrongStats(), [data.wrongEntries])

  /* ---- last 14 days study minutes ---- */
  const last14 = useMemo(() => {
    const out: Array<{ day: string; label: string; minutes: number }> = []
    for (let i = 13; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      out.push({
        day: key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        minutes: data.studyStats[key] || 0,
      })
    }
    return out
  }, [data.studyStats])

  const streak = useMemo(() => {
    let n = 0
    for (let i = 0; i < 400; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      const v = data.studyStats[key] || 0
      if (v > 0) n++
      else if (i > 0) break
    }
    return n
  }, [data.studyStats])

  const weekMinutes = last14.slice(7).reduce((n, d) => n + d.minutes, 0)
  const prevWeekMinutes = last14.slice(0, 7).reduce((n, d) => n + d.minutes, 0)
  const weekDelta = prevWeekMinutes ? ((weekMinutes - prevWeekMinutes) / prevWeekMinutes) * 100 : 0

  const cardStats = useMemo(() => {
    const now = Date.now()
    const total = data.flashcards.length
    const due = data.flashcards.filter((c) => c.dueAt <= now).length
    const mature = data.flashcards.filter((c) => c.box >= 4).length
    const totalReviews = data.flashcards.reduce((n, c) => n + c.reviewCount, 0)
    return { total, due, mature, totalReviews, retention: totalReviews ? Math.round((mature / Math.max(1, total)) * 100) : 0 }
  }, [data.flashcards])

  const totalMessages = useMemo(() => chat.sessions.reduce((n, s) => n + s.messages.filter((m) => m.role === 'assistant').length, 0), [chat.sessions])
  const totalSessions = chat.sessions.length

  const studyMinutesToday = last14[13]?.minutes || 0
  const planProgress = plannerStatus?.progress || 0

  return (
    <>
      <div className="panel-head">
        <Icon.chart size={19} style={{ color: 'var(--accent)' }} />
        <div className="grow">
          <h1>学习统计</h1>
          <div className="sub">
            连续学习 {streak} 天 · 本周 {Math.round(weekMinutes)} 分钟
            {prevWeekMinutes ? `（较上周 ${weekDelta >= 0 ? '+' : ''}${weekDelta.toFixed(0)}%）` : ''}
          </div>
        </div>
        <button
          className="btn sm"
          onClick={() => {
            app.setView('chat')
            app.toast({ kind: 'info', title: '已切换到对话', body: '可以对我说：「帮我做一次学习复盘」，我会读取错题与统计数据给出调整建议。' })
          }}
        >
          <Icon.refresh size={14} />
          生成复盘
        </button>
      </div>

      <div className="panel-body">
        {/* ---- headline tiles ---- */}
        <div className="grid four" style={{ marginBottom: 16 }}>
          <div className="stat-tile">
            <div className="k">今日学习</div>
            <div className="v">
              {Math.round(studyMinutesToday)}
              <span style={{ fontSize: 14, fontWeight: 500 }}> 分钟</span>
            </div>
            <div className="d">{fmtDate(Date.now())}</div>
          </div>
          <div className="stat-tile">
            <div className="k">连续打卡</div>
            <div className="v" style={{ color: streak >= 3 ? 'var(--accent)' : undefined }}>
              {streak}
              <span style={{ fontSize: 14, fontWeight: 500 }}> 天</span>
            </div>
            <div className="d">{streak >= 7 ? '保持得很好' : streak ? '继续坚持' : '今天开始吧'}</div>
          </div>
          <div className="stat-tile">
            <div className="k">错题掌握</div>
            <div className="v">
              {stats.mastered}
              <span style={{ fontSize: 14, fontWeight: 500 }}> / {stats.total}</span>
            </div>
            <div className="d">待复习 {stats.dueToday} 道</div>
          </div>
          <div className="stat-tile">
            <div className="k">卡片牢固率</div>
            <div className="v">{cardStats.retention}<span style={{ fontSize: 14, fontWeight: 500 }}>%</span></div>
            <div className="d">{cardStats.total} 张 · 今日到期 {cardStats.due}</div>
          </div>
        </div>

        <div className="grid two" style={{ marginBottom: 16 }}>
          {/* ---- 14 day activity ---- */}
          <div className="card">
            <div className="card-title">
              <Icon.trend size={15} />
              近 14 天学习时长
            </div>
            <div className="card-sub">单位：分钟。数据来自时间规划中的「完成时段」记录。</div>
            <Sparkline values={last14.map((d) => d.minutes)} labels={last14.map((d) => d.label)} />
            <div className="row between" style={{ marginTop: 7, fontSize: 11 }}>
              <span className="muted">{last14[0]?.label}</span>
              <span className="muted">今天</span>
            </div>
            <div className="grid three" style={{ marginTop: 14, gap: 10 }}>
              <div>
                <div className="muted" style={{ fontSize: 11.5 }}>日均</div>
                <div style={{ fontWeight: 680, fontSize: 17 }}>{Math.round(last14.reduce((n, d) => n + d.minutes, 0) / 14)} 分</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: 11.5 }}>最长一天</div>
                <div style={{ fontWeight: 680, fontSize: 17 }}>{Math.max(...last14.map((d) => d.minutes), 0)} 分</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: 11.5 }}>有学习天数</div>
                <div style={{ fontWeight: 680, fontSize: 17 }}>{last14.filter((d) => d.minutes > 0).length} / 14</div>
              </div>
            </div>
          </div>

          {/* ---- today's plan progress ---- */}
          <div className="card">
            <div className="card-title">
              <Icon.calendar size={15} />
              今日计划执行
            </div>
            <div className="card-sub">
              {plannerStatus?.hasSchedule ? '按时间规划推进，进行中的时段会高亮提醒。' : '还没有设置时间规划。'}
            </div>
            {plannerStatus?.hasSchedule ? (
              <>
                <div className="row" style={{ gap: 20, alignItems: 'center' }}>
                  <Ring value={planProgress} size={82} stroke={7} label="完成度" />
                  <div className="grow col" style={{ gap: 7 }}>
                    <div className="row between" style={{ fontSize: 12.5 }}>
                      <span className="muted">今日时段</span>
                      <b>{plannerStatus.count || todayPlan.length}</b>
                    </div>
                    <div className="row between" style={{ fontSize: 12.5 }}>
                      <span className="muted">当前进行</span>
                      <b style={{ color: 'var(--accent)' }}>{plannerStatus.current?.title || '无'}</b>
                    </div>
                    <div className="row between" style={{ fontSize: 12.5 }}>
                      <span className="muted">下一项</span>
                      <span>
                        {plannerStatus.next ? `${plannerStatus.next.start} ${plannerStatus.next.title}` : '今日已结束'}
                      </span>
                    </div>
                  </div>
                </div>
                {todayPlan.length ? (
                  <div className="col" style={{ gap: 5, marginTop: 15 }}>
                    {todayPlan.slice(0, 8).map((it: any, i) => (
                      <div key={i} className="row" style={{ gap: 8, fontSize: 12, opacity: it.state === 'done' ? 0.5 : 1 }}>
                        <span className="mono muted" style={{ flex: '0 0 auto', width: 42 }}>
                          {it.start}
                        </span>
                        <span className={clsx('grow')} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: it.state === 'active' ? 'var(--accent)' : undefined }}>
                          {it.title}
                        </span>
                        {it.state === 'active' ? <span className="chip accent" style={{ fontSize: 10 }}>进行中</span> : it.state === 'done' ? <Icon.check size={13} style={{ color: 'var(--ok)' }} /> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="row" style={{ gap: 10 }}>
                <EmptyState icon="calendar" title="未设置计划" body="设置作息后，这里会显示执行进度与打卡数据。">
                  <button className="btn primary" onClick={() => app.setView('planner')}>
                    去设置时间规划
                  </button>
                </EmptyState>
              </div>
            )}
          </div>
        </div>

        {/* ---- wrongbook analysis ---- */}
        <div className="grid two" style={{ marginBottom: 16 }}>
          <div className="card">
            <div className="card-title">
              <Icon.brain size={15} />
              错因结构
            </div>
            <div className="card-sub">你的错误主要来自哪一环？针对根因改进，比多做题有效。</div>
            {stats.byReason.length ? <Donut rows={stats.byReason} /> : <div className="muted" style={{ fontSize: 12.5 }}>还没有错题数据。</div>}
          </div>
          <div className="card">
            <div className="card-title">
              <Icon.layers size={15} />
              知识点薄弱排行
            </div>
            <div className="card-sub">错题涉及知识点 Top 10。</div>
            <BarList rows={stats.byKnowledge.slice(0, 10)} emptyText="还没有错题数据。" />
          </div>
        </div>

        <div className="grid three">
          <div className="card">
            <div className="card-title">
              <Icon.book size={15} />
              各科投入
            </div>
            <div className="card-sub">累计学习时长（分钟）。</div>
            <BarList
              rows={Object.entries(subjectTime)
                .map(([key, n]) => ({ key, n: Math.round(n) }))
                .sort((a, b) => b.n - a.n)
                .slice(0, 8)}
              color="#a78bfa"
              emptyText="暂无科目记录。可在时间规划中给时段标注科目。"
            />
          </div>
          <div className="card">
            <div className="card-title">
              <Icon.chat size={15} />
              辅导使用情况
            </div>
            <div className="card-sub">AI 对话与产出统计。</div>
            <div className="col" style={{ gap: 9, fontSize: 13 }}>
              {[
                { k: '会话总数', v: totalSessions },
                { k: '已辅导回复', v: totalMessages },
                { k: '生成卡片', v: cardStats.total },
                { k: '累计复习次数', v: cardStats.totalReviews },
                { k: '知识库资料', v: data.kbDocs.length },
                { k: '导出文件', v: data.artifacts.filter((a) => a.kind === 'doc').length },
              ].map((r) => (
                <div className="row between" key={r.k}>
                  <span className="muted">{r.k}</span>
                  <b className="tnum">{r.v}</b>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="card-title">
              <Icon.award size={15} />
              建议
            </div>
            <div className="card-sub">基于当前数据自动生成。</div>
            <div className="col" style={{ gap: 9, fontSize: 12.5, lineHeight: 1.65 }}>
              {streak === 0 ? <Suggestion text="还没有学习记录，先设置一份作息计划并开始执行。" action={{ label: '去设置', run: () => app.setView('planner') }} /> : null}
              {stats.dueToday > 0 ? <Suggestion text={`有 ${stats.dueToday} 道错题今天到期，先复习完再刷新题。`} action={{ label: '去复习', run: () => app.setView('wrongbook') }} /> : null}
              {cardStats.due > 0 ? <Suggestion text={`${cardStats.due} 张背诵卡片待复习，碎片时间即可完成。`} action={{ label: '去背卡片', run: () => app.setView('flashcards') }} /> : null}
              {stats.worstKnowledge.length ? <Suggestion text={`薄弱知识点：${stats.worstKnowledge.slice(0, 3).join('、')}。建议安排专项训练。`} action={{ label: '生成专项', run: () => app.setView('chat') }} /> : null}
              {!data.kbDocs.length ? <Suggestion text="导入教材后可获得带出处的回答，准确度显著提升。" action={{ label: '导入资料', run: () => app.setView('knowledge') }} /> : null}
              {weekDelta < -15 ? <Suggestion text={`本周学习时长比上周下降 ${Math.abs(weekDelta).toFixed(0)}%，注意保持节奏。`} /> : null}
              {streak >= 7 ? <Suggestion text={`已连续学习 ${streak} 天，节奏很好，注意保证睡眠。`} /> : null}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function Suggestion({ text, action }: { text: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
      <Icon.chevron size={13} style={{ color: 'var(--accent)', flex: '0 0 auto', marginTop: 3 }} />
      <span className="grow">{text}</span>
      {action ? (
        <button className="btn ghost sm" onClick={action.run} style={{ flex: '0 0 auto' }}>
          {action.label}
        </button>
      ) : null}
    </div>
  )
}
