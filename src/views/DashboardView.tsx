import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { useData } from '../store/useData'
import { useChat } from '../store/useChat'
import { Icon } from '../components/Icons'
import { BarList, Donut, EmptyState, Modal, Ring, Sparkline } from '../components/ui'
import { bridge } from '../lib/bridge'
import { kvGet } from '../lib/idb'
import { clsx } from '../lib/util'
import { useFocus } from '../store/useFocus'
import { localDateKey } from '../lib/planner'

export function DashboardView() {
  const app = useApp()
  const data = useData()
  const chat = useChat()
  const [plannerStatus, setPlannerStatus] = useState<any>(app.plannerStatus)
  const [subjectTime, setSubjectTime] = useState<Record<string, number>>({})
  const [todayPlan, setTodayPlan] = useState<any[]>([])
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const focus = useFocus()
  const focusDays = focus.snapshot.days
  const [dayKeys, setDayKeys] = useState(() => {
    const now = new Date()
    return { local: localDateKey(now), utc: now.toISOString().slice(0, 10) }
  })
  const todayKey = dayKeys.local
  const utcTodayKey = dayKeys.utc
  const focusToday = focusDays.find((d) => d.date === todayKey) || { date: todayKey, focusedMs: 0, outOfWindowMs: 0, switches: 0, completedFocusedMs: 0 }
  const focusTotal = focusDays.reduce((n, d) => n + d.focusedMs + d.outOfWindowMs, 0)
  const focusFocused = focusDays.reduce((n, d) => n + d.focusedMs, 0)
  const focusAway = focusDays.reduce((n, d) => n + d.outOfWindowMs, 0)
  const focusSwitches = focusDays.reduce((n, d) => n + d.switches, 0)
  const focusCompletedMs = focusDays.reduce((n, d) => n + d.completedFocusedMs, 0)
  const focusAverageMs = focusSwitches ? focusCompletedMs / focusSwitches : 0
  const recentAwaySessions = useMemo(() => (focus.snapshot.sessions || [])
    .filter((session) => session.kind === 'outOfWindow')
    .sort((a, b) => b.end - a.end || b.start - a.start)
    .slice(0, 20), [focus.snapshot.sessions])
  const hasFocusRecords = focusDays.length > 0 || !!focus.snapshot.sessions?.length
  const sessionTime = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false })
  const focusPct = focusTotal ? Math.round((focusFocused / focusTotal) * 100) : 0
  const focusTrend = useMemo(() => {
    const days: Array<{ day: string; label: string; focusedMs: number; outOfWindowMs: number }> = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(`${todayKey}T12:00:00`)
      d.setDate(d.getDate() - i)
      const key = localDateKey(d)
      const row = focusDays.find((day) => day.date === key)
      days.push({ day: key, label: `${d.getMonth() + 1}/${d.getDate()}`, focusedMs: row?.focusedMs || 0, outOfWindowMs: row?.outOfWindowMs || 0 })
    }
    return days
  }, [focusDays, todayKey])

  const toggleFocus = (enabled: boolean) => focus.setEnabled(enabled)
  const confirmReset = async () => {
    setResetting(true)
    await focus.reset()
    setResetting(false)
    setResetOpen(false)
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const now = new Date()
      const local = localDateKey(now)
      const utc = now.toISOString().slice(0, 10)
      // Invalidate calendar-based views even when monitoring is disabled or data is unchanged.
      setDayKeys((previous) => previous.local === local && previous.utc === utc ? previous : { local, utc })
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

  /* ---- legacy recorded minutes, bucketed by UTC date ---- */
  const last14 = useMemo(() => {
    const out: Array<{ day: string; label: string; minutes: number }> = []
    for (let i = 13; i >= 0; i--) {
      const d = new Date(`${utcTodayKey}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() - i)
      const key = d.toISOString().slice(0, 10)
      out.push({
        day: key,
        label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
        minutes: data.studyStats[key] || 0,
      })
    }
    return out
  }, [data.studyStats, utcTodayKey])

  const streak = useMemo(() => {
    let n = 0
    for (let i = 0; i < 400; i++) {
      const d = new Date(`${utcTodayKey}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() - i)
      const key = d.toISOString().slice(0, 10)
      const v = data.studyStats[key] || 0
      if (v > 0) n++
      else break
    }
    return n
  }, [data.studyStats, utcTodayKey])

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
            专注窗口统计 · 历史记录近 7 个 UTC 日 {Math.round(weekMinutes)} 分钟
            {prevWeekMinutes ? `（较前 7 个 UTC 日 ${weekDelta >= 0 ? '+' : ''}${weekDelta.toFixed(0)}%）` : ''}
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

      <Modal open={resetOpen} onClose={() => !resetting && setResetOpen(false)} title="清除专注统计" dismissable={!resetting} footer={<><button className="btn" disabled={resetting} onClick={() => setResetOpen(false)}>取消</button><button className="btn primary" disabled={resetting} onClick={() => void confirmReset()}>{resetting ? '清除中…' : '确认清除'}</button></>}>
        <p>将删除本机保存的所有专注日聚合统计（最多 90 个日期）及可选的时段明细（最多 2000 条、保留 90 天），且无法恢复。不会删除 UTC 历史分钟记录，也不会改变专注监测的开关。</p>
      </Modal>
      <div className="panel-body">
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><Icon.target size={15} /><span>专注监测</span><div className="grow" />{focus.ready ? <><span className="muted" style={{ fontSize: 11.5 }}>{focus.tracking ? '监测中' : focus.enabled ? '已开启，等待学习/复习时段' : '未开启'}</span><button type="button" role="switch" aria-label="专注监测" aria-checked={focus.enabled} className={clsx('switch', focus.enabled && 'on')} onClick={() => toggleFocus(!focus.enabled)} /></> : null}</div>
          <div className="card-sub">默认关闭。开启后只统计时间规划中「学习」和「复习」时段；上课、休息和其他类型不计入。仅记录 Yanlai 窗口是否处于前台及观察到的起止时间，不读取其他应用内容，不代表实际学习或任务完成。偏好、最多 90 个日期的日聚合与可选时段明细（最多 2000 条、保留 90 天）仅保存在本机，可随时关闭或清除。</div>
          {!focus.enabled ? <div className="row between" style={{ gap: 12 }}>
            <div className="muted" style={{ fontSize: 12.5 }}>开启专注监测后才会订阅窗口状态并记录统计。</div>
            <div className="row" style={{ gap: 8 }}><button className="btn sm" onClick={() => toggleFocus(true)} disabled={!focus.ready}>开启监测</button>{hasFocusRecords ? <button className="btn ghost sm" onClick={() => setResetOpen(true)}>清除统计</button> : null}</div>
          </div> : focusTotal ? <>
            <div className="grid three" style={{ alignItems: 'center' }}>
              <Donut rows={[{ key: 'Yanlai 窗口', n: focusFocused }, { key: '切屏时间', n: focusAway }]} />
              <div className="col" style={{ gap: 7, fontSize: 12.5 }}>
                <div className="row between"><span className="muted">保留记录总时长</span><b>{(focusTotal / 3600000).toFixed(2)} 小时</b></div>
                <div className="row between"><span className="muted">Yanlai 窗口内</span><b style={{ color: 'var(--accent)' }}>{focusPct}%</b></div>
                <div className="row between"><span className="muted">切屏时间</span><b>{100 - focusPct}%</b></div>
                <div className="row between"><span className="muted">保留记录切屏次数</span><b>{focusSwitches}</b></div>
              </div>
              <div className="col" style={{ gap: 7, fontSize: 12.5 }}>
                <div className="row between"><span className="muted">今日窗口内</span><b>{(focusToday.focusedMs / 60000).toFixed(1)} 分钟</b></div>
                <div className="row between"><span className="muted">今日切屏</span><b>{focusToday.switches} 次</b></div>
                <div className="row between"><span className="muted" title="保留日聚合中的已切出窗口内时长合计 ÷ 切屏次数；不含未切出或中断的片段。">切屏前平均窗口内（保留记录）</span><b>{focusSwitches ? `${(focusAverageMs / 60000).toFixed(1)} 分钟` : '暂无'}</b></div>
              </div>
            </div>
          </> : <div className="muted" style={{ fontSize: 12.5 }}>暂无监测数据。开启监测且处于计划的学习/复习时段时，才会记录观察到的窗口状态时长。</div>}
          {focus.enabled ? <div style={{ marginTop: 14 }}>
            <div className="row between" style={{ marginBottom: 7 }}><span className="muted" style={{ fontSize: 12 }}>近 7 个本地日窗口趋势（窗口内分钟）</span>{hasFocusRecords ? <button className="btn ghost sm" onClick={() => setResetOpen(true)}>清除统计</button> : null}</div>
            <Sparkline values={focusTrend.map((d) => Math.round(d.focusedMs / 60000))} labels={focusTrend.map((d) => d.label)} />
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 7, fontSize: 11.5 }}>
              {focusTrend.map((d) => <span key={d.day} className="muted">{d.label} {d.focusedMs ? `${Math.round(d.focusedMs / 60000)} 分钟` : '—'}</span>)}
            </div>
          </div> : null}
          <details style={{ marginTop: 12 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>最近切屏时段（最多 20 条）</summary>
            <div className="muted" style={{ marginTop: 7, fontSize: 11.5 }}>本地时间，按结束时间倒序。仅显示已结束的窗口外观察片段；不含正在记录的片段，旧数据可能没有明细，与切屏次数不一定一一对应。</div>
            {recentAwaySessions.length ? <div className="col" style={{ gap: 7, marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
              {recentAwaySessions.map((session) => <div key={`${session.start}-${session.end}`} className="row between" style={{ gap: 8, flexWrap: 'wrap', fontSize: 11.5 }}>
                <span><span className="muted">开始 </span><time dateTime={new Date(session.start).toISOString()}>{sessionTime(session.start)}</time><span className="muted"> · 结束 </span><time dateTime={new Date(session.end).toISOString()}>{sessionTime(session.end)}</time></span>
                <b className="tnum">时长 {(session.durationMs / 1000).toFixed(1)} 秒</b>
              </div>)}
            </div> : <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>暂无已结束的切屏时段明细。</div>}
          </details>
          {focus.error ? <div className="calculator-error" style={{ marginTop: 10 }}>{focus.error}</div> : null}
        </div>
        {/* ---- headline tiles ---- */}
        <div className="grid four" style={{ marginBottom: 16 }}>
          <div className="stat-tile">
            <div className="k">UTC 今日历史记录</div>
            <div className="v">
              {Math.round(studyMinutesToday)}
              <span style={{ fontSize: 14, fontWeight: 500 }}> 分钟</span>
            </div>
            <div className="d">{utcTodayKey}（UTC）· 非实测学习</div>
          </div>
          <div className="stat-tile">
            <div className="k">连续有记录的 UTC 日</div>
            <div className="v" style={{ color: streak >= 3 ? 'var(--accent)' : undefined }}>
              {streak}
              <span style={{ fontSize: 14, fontWeight: 500 }}> 天</span>
            </div>
            <div className="d">截至 UTC 今日 · 非打卡统计</div>
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
              近 14 个 UTC 日历史记录分钟
            </div>
            <div className="card-sub">旧版历史记录，按 UTC 日期分桶；当前版本没有调用分钟写入方法，不会随计划时段结束自动增加，也不代表任务完成、打卡或实测学习时长。</div>
            <Sparkline values={last14.map((d) => d.minutes)} labels={last14.map((d) => d.label)} />
            <div className="row between" style={{ marginTop: 7, fontSize: 11 }}>
              <span className="muted">{last14[0]?.label}</span>
              <span className="muted">UTC 今天</span>
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
                <div className="muted" style={{ fontSize: 11.5 }}>有记录日数</div>
                <div style={{ fontWeight: 680, fontSize: 17 }}>{last14.filter((d) => d.minutes > 0).length} / 14</div>
              </div>
            </div>
          </div>

          {/* ---- today's plan progress ---- */}
          <div className="card">
            <div className="card-title">
              <Icon.calendar size={15} />
              今日计划时间进度
            </div>
            <div className="card-sub">
              {plannerStatus?.hasSchedule ? '所有类型时段中，已到结束时间的时段占比；仅反映时间流逝，不代表完成或打卡。当前时段按时钟高亮。' : '还没有设置时间规划。'}
            </div>
            {plannerStatus?.hasSchedule ? (
              <>
                <div className="row" style={{ gap: 20, alignItems: 'center' }}>
                  <Ring value={planProgress} size={82} stroke={7} label="已过时段" />
                  <div className="grow col" style={{ gap: 7 }}>
                    <div className="row between" style={{ fontSize: 12.5 }}>
                      <span className="muted">今日时段（所有类型）</span>
                      <b>{plannerStatus.count || todayPlan.length}</b>
                    </div>
                    <div className="row between" style={{ fontSize: 12.5 }}>
                      <span className="muted">当前进行</span>
                      <b style={{ color: 'var(--accent)' }}>{plannerStatus.current?.title || '无'}</b>
                    </div>
                    <div className="row between" style={{ fontSize: 12.5 }}>
                      <span className="muted">下一项</span>
                      <span>
                        {plannerStatus.next ? `${plannerStatus.next.start} ${plannerStatus.next.title}` : '无后续时段'}
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
                        {it.state === 'active' ? <span className="chip accent" style={{ fontSize: 10 }}>进行中</span> : it.state === 'done' ? <span className="chip" style={{ fontSize: 10 }}>已过结束时间</span> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="row" style={{ gap: 10 }}>
                <EmptyState icon="calendar" title="未设置计划" body="设置作息后，这里会显示各类时段的时间进度，不是完成或打卡记录。">
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
              各科历史记录
            </div>
            <div className="card-sub">旧版按科目累计记录的分钟，非实测学习时长；当前没有活跃写入入口。</div>
            <BarList
              rows={Object.entries(subjectTime)
                .map(([key, n]) => ({ key, n: Math.round(n) }))
                .sort((a, b) => b.n - a.n)
                .slice(0, 8)}
              color="#a78bfa"
              emptyText="暂无历史科目分钟记录；标注计划科目不会自动记录时长。"
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
              {!plannerStatus?.hasSchedule ? <Suggestion text="尚未设置时间规划，可先安排学习与休息时段。" action={{ label: '去设置', run: () => app.setView('planner') }} /> : null}
              {stats.dueToday > 0 ? <Suggestion text={`有 ${stats.dueToday} 道错题今天到期，先复习完再刷新题。`} action={{ label: '去复习', run: () => app.setView('wrongbook') }} /> : null}
              {cardStats.due > 0 ? <Suggestion text={`${cardStats.due} 张背诵卡片待复习，碎片时间即可完成。`} action={{ label: '去背卡片', run: () => app.setView('flashcards') }} /> : null}
              {stats.worstKnowledge.length ? <Suggestion text={`薄弱知识点：${stats.worstKnowledge.slice(0, 3).join('、')}。建议安排专项训练。`} action={{ label: '生成专项', run: () => app.setView('chat') }} /> : null}
              {!data.kbDocs.length ? <Suggestion text="导入教材后可获得带出处的回答，准确度显著提升。" action={{ label: '导入资料', run: () => app.setView('knowledge') }} /> : null}
              {weekDelta < -15 ? <Suggestion text={`历史分钟记录中，近 7 个 UTC 日比前 7 日减少 ${Math.abs(weekDelta).toFixed(0)}%；该差异不代表实际学习变化。`} /> : null}
              {streak >= 7 ? <Suggestion text={`历史数据截至 UTC 今日连续 ${streak} 日有分钟记录；不代表连续学习或打卡。`} /> : null}
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
