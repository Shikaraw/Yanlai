import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { Icon } from '../components/Icons'
import { EmptyState, Field, Modal, Segmented, Switch } from '../components/ui'
import { bridge } from '../lib/bridge'
import { clsx, durationLabel, fromMinutes, toMinutes, uid } from '../lib/util'
import type { PlanItem, PlanSchedule } from '../lib/types'

const DAYS = [
  { n: 1, label: '周一' },
  { n: 2, label: '周二' },
  { n: 3, label: '周三' },
  { n: 4, label: '周四' },
  { n: 5, label: '周五' },
  { n: 6, label: '周六' },
  { n: 7, label: '周日' },
]

const KINDS: Array<{ v: PlanItem['kind']; label: string }> = [
  { v: 'study', label: '学习' },
  { v: 'review', label: '复习' },
  { v: 'class', label: '上课' },
  { v: 'break', label: '休息' },
  { v: 'meal', label: '用餐' },
  { v: 'exercise', label: '运动' },
  { v: 'sleep', label: '睡眠' },
  { v: 'other', label: '其他' },
]

const TEMPLATES: Array<{ name: string; desc: string; build: () => PlanItem[] }> = [
  {
    name: '标准考研作息',
    desc: '6:00 起，上午数学、下午专业课、晚上英语与政治，23:00 睡',
    build: () => [
      mk('06:00', '06:40', '起床 · 晨读', 'review'),
      mk('06:40', '07:20', '早餐', 'meal'),
      mk('07:20', '08:00', '单词 / 政治背诵', 'review', '英语'),
      mk('08:00', '11:30', '数学（最强脑力时段）', 'study', '数学'),
      mk('11:30', '13:00', '午餐 · 午休', 'meal'),
      mk('13:00', '14:00', '午睡', 'break'),
      mk('14:00', '17:00', '专业课', 'study', '专业课'),
      mk('17:00', '18:00', '运动 / 散步', 'exercise'),
      mk('18:00', '19:00', '晚餐', 'meal'),
      mk('19:00', '21:00', '英语真题 / 阅读', 'study', '英语'),
      mk('21:00', '22:00', '政治', 'study', '政治'),
      mk('22:00', '22:40', '错题复盘 · 卡片复习', 'review'),
      mk('23:00', '06:00', '睡眠', 'sleep'),
    ],
  },
  {
    name: '在职 / 在校有课',
    desc: '工作日晚上 4 小时集中学，周末全天学习',
    build: () => [
      mk('07:00', '07:30', '起床 · 单词', 'review', '英语'),
      mk('07:30', '08:30', '通勤 · 听力/背诵', 'review'),
      mk('19:00', '21:00', '数学', 'study', '数学'),
      mk('21:00', '22:30', '专业课', 'study', '专业课'),
      mk('22:30', '23:00', '复盘 + 明天计划', 'review'),
      mk('23:30', '07:00', '睡眠', 'sleep'),
    ],
  },
  {
    name: '强化期冲刺',
    desc: '每天 11 小时高强度，真题 + 模考交替',
    build: () => [
      mk('05:50', '06:30', '起床 · 晨背', 'review'),
      mk('06:30', '07:10', '早餐', 'meal'),
      mk('07:10', '10:10', '数学真题 / 强化', 'study', '数学'),
      mk('10:10', '10:25', '休息', 'break'),
      mk('10:25', '12:00', '专业课', 'study', '专业课'),
      mk('12:00', '13:30', '午餐 · 午休', 'meal'),
      mk('13:30', '14:00', '午睡', 'break'),
      mk('14:00', '17:00', '专业课 / 408', 'study', '专业课'),
      mk('17:00', '17:40', '运动', 'exercise'),
      mk('17:40', '18:40', '晚餐', 'meal'),
      mk('18:40', '21:00', '英语真题精读', 'study', '英语'),
      mk('21:00', '22:30', '政治', 'study', '政治'),
      mk('22:30', '23:10', '错题 + 卡片', 'review'),
      mk('23:30', '05:50', '睡眠', 'sleep'),
    ],
  },
  {
    name: '假期全天',
    desc: '上午数学、下午专业课、晚上英语政治，含两次运动',
    build: () => [
      mk('06:30', '07:10', '起床 · 晨读', 'review'),
      mk('07:10', '07:50', '早餐', 'meal'),
      mk('07:50', '09:00', '单词 + 政治背诵', 'review'),
      mk('09:00', '12:00', '数学', 'study', '数学'),
      mk('12:00', '13:30', '午餐 · 休息', 'meal'),
      mk('13:30', '14:15', '午睡', 'break'),
      mk('14:15', '17:15', '专业课', 'study', '专业课'),
      mk('17:15', '18:15', '运动', 'exercise'),
      mk('18:15', '19:15', '晚餐', 'meal'),
      mk('19:15', '21:15', '英语', 'study', '英语'),
      mk('21:15', '22:15', '政治', 'study', '政治'),
      mk('22:15', '23:00', '复盘 · 卡片', 'review'),
      mk('23:30', '06:30', '睡眠', 'sleep'),
    ],
  },
]

function mk(start: string, end: string, title: string, kind: PlanItem['kind'] = 'study', subject?: string, note?: string): PlanItem {
  return { id: uid('pi'), start, end, title, kind, subject, note, remind: true }
}

function emptySchedule(): PlanSchedule {
  return {
    version: 1,
    mode: 'unified',
    weekly: Object.fromEntries(DAYS.map((d) => [String(d.n), []])),
    unified: [],
    workday: { work: [], rest: [] },
    workdays: [1, 2, 3, 4, 5],
    activeDays: [1, 2, 3, 4, 5, 6, 7],
  }
}

export function PlannerView() {
  const app = useApp()
  const [schedule, setSchedule] = useState<PlanSchedule | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ day: string; item: PlanItem } | null>(null)
  const [weekDay, setWeekDay] = useState<string>('1')
  const [saving, setSaving] = useState(false)

  const now = new Date()
  const todayDow = String(now.getDay() === 0 ? 7 : now.getDay())
  const nowMin = now.getHours() * 60 + now.getMinutes()

  /* ---------------- load ---------------- */
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      const s = (await bridge.planner.getSchedule()) as PlanSchedule | null
      if (cancelled) return
      setSchedule(s || emptySchedule())
      setWeekDay(todayDow)
      setLoading(false)
    }
    void load()
    const unsub = bridge.planner.onEvent(() => {
      void refreshStatus()
    })
    async function refreshStatus() {
      const st = await bridge.planner.status().catch(() => null)
      if (st) app.setPlannerStatus(st)
    }
    void refreshStatus()
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  /* refresh status every 20s so "当前时段" stays accurate */
  useEffect(() => {
    const t = setInterval(async () => {
      const st = await bridge.planner.status().catch(() => null)
      if (st) app.setPlannerStatus(st)
    }, 20000)
    return () => clearInterval(t)
  }, [])

  const persist = async (next: PlanSchedule) => {
    setSchedule(next)
    setSaving(true)
    try {
      await bridge.planner.setSchedule(next)
      const st = await bridge.planner.status().catch(() => null)
      if (st) app.setPlannerStatus(st)
    } finally {
      setSaving(false)
    }
  }

  /* ---------------- current item list ---------------- */
  const listFor = (key: string): PlanItem[] => {
    if (!schedule) return []
    if (schedule.mode === 'weekly') return schedule.weekly?.[key] || []
    if (schedule.mode === 'workday') {
      const dow = Number(key)
      const isWork = (schedule.workdays || [1, 2, 3, 4, 5]).includes(dow)
      return isWork ? schedule.workday?.work || [] : schedule.workday?.rest || []
    }
    return schedule.unified || []
  }

  const setListFor = (next: PlanSchedule, key: string, items: PlanItem[]) => {
    if (next.mode === 'weekly') return { ...next, weekly: { ...next.weekly, [key]: items } }
    if (next.mode === 'workday') {
      const dow = Number(key)
      const isWork = (next.workdays || [1, 2, 3, 4, 5]).includes(dow)
      return isWork ? { ...next, workday: { ...next.workday, work: items } } : { ...next, workday: { ...next.workday, rest: items } }
    }
    return { ...next, unified: items }
  }

  const sorted = (items: PlanItem[]) => [...items].sort((a, b) => (toMinutes(a.start) ?? 1e9) - (toMinutes(b.start) ?? 1e9))

  /* ---------------- template application ---------------- */
  const applyTemplate = async (tpl: (typeof TEMPLATES)[number]) => {
    if (!schedule) return
    const items = tpl.build()
    if (schedule.mode === 'weekly') {
      // fill weekdays with the template, leave weekends for the student
      const next = { ...schedule, weekly: { ...schedule.weekly } }
      for (const d of DAYS) next.weekly[String(d.n)] = items.map((i) => ({ ...i, id: uid('pi') }))
      await persist(next)
      app.toast({ kind: 'success', title: `已套用「${tpl.name}」`, body: '已应用到周一至周日，可逐日微调。' })
    } else if (schedule.mode === 'workday') {
      await persist({
        ...schedule,
        workday: {
          work: items.map((i) => ({ ...i, id: uid('pi') })),
          rest: tpl.build().map((i) => ({ ...i, id: uid('pi') })),
        },
      })
      app.toast({ kind: 'success', title: `已套用「${tpl.name}」`, body: '工作日与休息日均已填充。' })
    } else {
      await persist({ ...schedule, unified: items })
      app.toast({ kind: 'success', title: `已套用「${tpl.name}」`, body: '已设为每日统一作息。' })
    }
  }

  /* ---------------- item CRUD ---------------- */
  const saveItem = async (day: string, item: PlanItem) => {
    if (!schedule) return
    const items = listFor(day)
    const exists = items.some((i) => i.id === item.id)
    const nextItems = sorted(exists ? items.map((i) => (i.id === item.id ? item : i)) : [...items, item])
    await persist(setListFor(schedule, day, nextItems))
    setEditing(null)
  }

  const deleteItem = async (day: string, id: string) => {
    if (!schedule) return
    await persist(setListFor(schedule, day, listFor(day).filter((i) => i.id !== id)))
    setEditing(null)
  }

  const duplicateItem = async (day: string, item: PlanItem) => {
    if (!schedule) return
    const copy = { ...item, id: uid('pi'), title: `${item.title}（副本）` }
    await persist(setListFor(schedule, day, sorted([...listFor(day), copy])))
  }

  /* ---------------- overview ---------------- */
  const status = app.plannerStatus
  const plannedToday = useMemo(() => {
    if (!schedule) return []
    return sorted(listFor(todayDow))
  }, [schedule, todayDow])

  const studyMinutes = (items: PlanItem[]) => items.filter((i) => ['study', 'review', 'class'].includes(i.kind)).reduce((n, i) => n + Math.max(0, (toMinutes(i.end) ?? 0) - (toMinutes(i.start) ?? 0)), 0)

  if (loading) {
    return (
      <div className="col center" style={{ height: '100%', justifyContent: 'center' }}>
        <span className="muted">正在载入时间规划…</span>
      </div>
    )
  }
  if (!schedule) return null

  const dayItems = sorted(listFor(weekDay))
  const modeLabel = schedule.mode === 'unified' ? '每日统一作息' : schedule.mode === 'workday' ? '工作日 / 休息日分开' : '按周规划'

  return (
    <>
      <div className="panel-head">
        <Icon.calendar size={19} style={{ color: 'var(--accent)' }} />
        <div className="grow">
          <h1>时间规划</h1>
          <div className="sub">
            {modeLabel} · 共 {schedule.mode === 'weekly' ? Object.values(schedule.weekly).reduce((n, v) => n + v.length, 0) : schedule.mode === 'workday' ? schedule.workday.work.length + schedule.workday.rest.length : schedule.unified.length} 个时段
            {saving ? ' · 保存中…' : ''}
          </div>
        </div>

        <button
          className="btn sm"
          title={status?.paused ? '恢复提醒' : '暂停提醒'}
          onClick={async () => {
            const paused = await bridge.planner.pause(!status?.paused)
            app.setPlannerStatus({ ...(status || {}), paused })
            app.toast({ kind: 'info', title: paused ? '提醒已暂停' : '提醒已恢复' })
          }}
        >
          {status?.paused ? <Icon.play size={14} /> : <Icon.pause size={14} />}
          {status?.paused ? '已暂停' : '暂停提醒'}
        </button>
        <button className="btn sm" onClick={() => bridge.planner.testFire()} title="立即弹出一次测试提醒">
          <Icon.bell size={14} />
          测试提醒
        </button>
        <button
          className="btn sm primary"
          onClick={() => app.setView('chat')}
          title="让 AI 根据你的情况生成计划"
        >
          <Icon.sparkles size={14} />
          AI 制定计划
        </button>
      </div>

      <div className="panel-body">
        {/* ---- mode selector ---- */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row wrap between">
            <div>
              <div className="card-title">
                <Icon.settings size={15} />
                规划模式
              </div>
              <div className="card-sub" style={{ marginBottom: 0 }}>
                选择适合你的作息结构。修改后立即生效，提醒会在到点时弹出。
              </div>
            </div>
            <Segmented
              value={schedule.mode}
              onChange={(v) => persist({ ...schedule, mode: v as PlanSchedule['mode'] })}
              options={[
                { value: 'weekly', label: '按周规划', icon: 'calendar' },
                { value: 'unified', label: '每日统一', icon: 'list' },
                { value: 'workday', label: '工作日/休息日', icon: 'grid' },
              ]}
            />
          </div>

          {schedule.mode === 'workday' ? (
            <div style={{ marginTop: 14 }}>
              <div className="field-label" style={{ marginBottom: 7 }}>
                哪些天算「工作日」
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {DAYS.map((d) => {
                  const on = (schedule.workdays || []).includes(d.n)
                  return (
                    <button
                      key={d.n}
                      className={clsx('chip', on && 'accent')}
                      style={{ cursor: 'pointer' }}
                      onClick={() =>
                        persist({
                          ...schedule,
                          workdays: on ? schedule.workdays.filter((x) => x !== d.n) : [...(schedule.workdays || []), d.n].sort(),
                        })
                      }
                    >
                      {on ? <Icon.check size={12} /> : null}
                      {d.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          {schedule.mode === 'unified' ? (
            <div style={{ marginTop: 14 }}>
              <div className="field-label" style={{ marginBottom: 7 }}>
                每周执行日
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {DAYS.map((d) => {
                  const on = (schedule.activeDays || []).includes(d.n)
                  return (
                    <button
                      key={d.n}
                      className={clsx('chip', on && 'accent')}
                      style={{ cursor: 'pointer' }}
                      onClick={() =>
                        persist({
                          ...schedule,
                          activeDays: on ? schedule.activeDays.filter((x) => x !== d.n) : [...(schedule.activeDays || []), d.n].sort(),
                        })
                      }
                    >
                      {on ? <Icon.check size={12} /> : null}
                      {d.label}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          <div className="split-line" style={{ margin: '14px 0 12px' }} />
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <Switch
              checked={app.settings?.planner?.popup !== false}
              onChange={(v) => app.patchSettings({ planner: { popup: v } }, { silent: true })}
            />
            <span style={{ fontSize: 13 }}>到点弹窗提醒</span>
            <span style={{ width: 14 }} />
            <Switch
              checked={app.settings?.planner?.notify !== false}
              onChange={(v) => app.patchSettings({ planner: { notify: v } }, { silent: true })}
            />
            <span style={{ fontSize: 13 }}>系统通知</span>
            <span style={{ width: 14 }} />
            <Switch
              checked={app.settings?.planner?.notifySound !== false}
              onChange={(v) => app.patchSettings({ planner: { notifySound: v } }, { silent: true })}
            />
            <span style={{ fontSize: 13 }}>提示音</span>
            <span className="grow" />
            <label className="row center" style={{ gap: 6, fontSize: 12.5 }}>
              提前
              <input
                className="input"
                style={{ width: 64, padding: '4px 8px' }}
                type="number"
                min={0}
                max={60}
                value={app.settings?.planner?.advanceSeconds ? Math.round(app.settings.planner.advanceSeconds / 60) : 0}
                onChange={(e) => app.patchSettings({ planner: { advanceSeconds: Math.max(0, Math.min(60, Number(e.target.value) || 0)) * 60 } }, { silent: true })}
              />
              分钟提醒
            </label>
          </div>
        </div>

        {/* ---- today overview ---- */}
        <div className="grid three" style={{ marginBottom: 16 }}>
          <div className="stat-tile">
            <div className="k">今日时段</div>
            <div className="v">{plannedToday.length}</div>
            <div className="d">{DAYS.find((d) => String(d.n) === todayDow)?.label}</div>
          </div>
          <div className="stat-tile">
            <div className="k">今日学习总量</div>
            <div className="v">{(studyMinutes(plannedToday) / 60).toFixed(1)}<span style={{ fontSize: 14, fontWeight: 500 }}> 小时</span></div>
            <div className="d">不含用餐 / 休息 / 运动</div>
          </div>
          <div className="stat-tile">
            <div className="k">当前进行中</div>
            <div className="v" style={{ fontSize: 16, fontWeight: 620, marginTop: 5 }}>
              {status?.current ? (
                <span style={{ color: 'var(--accent)' }}>{status.current.title}</span>
              ) : (
                <span className="muted">无</span>
              )}
            </div>
            <div className="d">
              {status?.current ? `${status.current.start} - ${status.current.end}` : status?.next ? `下一项 ${status.next.start} ${status.next.title}` : '今日无安排'}
            </div>
          </div>
        </div>

        {/* ---- editor ---- */}
        <div className="row between" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
          <div className="row center" style={{ gap: 10 }}>
            <h2 style={{ fontSize: 15, margin: 0, fontWeight: 660 }}>
              {schedule.mode === 'weekly' ? '按周编辑' : schedule.mode === 'workday' ? '分场景编辑' : '每日作息表'}
            </h2>
            {schedule.mode === 'weekly' ? (
              <Segmented
                value={weekDay}
                onChange={(v) => setWeekDay(String(v))}
                options={DAYS.map((d) => ({ value: String(d.n), label: d.label.slice(1) }))}
              />
            ) : schedule.mode === 'workday' ? (
              <Segmented
                value={weekDay === 'rest' ? 'rest' : 'work'}
                onChange={(v) => setWeekDay(String(v))}
                options={[
                  { value: 'work', label: '工作日' },
                  { value: 'rest', label: '休息日' },
                ]}
              />
            ) : null}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn sm"
              onClick={() =>
                setEditing({
                  day: schedule.mode === 'workday' ? (weekDay === 'rest' ? 'rest' : 'work') : weekDay,
                  item: mk('08:00', '09:00', '新时段', 'study'),
                })
              }
            >
              <Icon.plus size={14} />
              添加时段
            </button>
          </div>
        </div>

        {/* template picker */}
        {!(listFor(schedule.mode === 'workday' ? (weekDay === 'rest' ? 'rest' : 'work') : weekDay) || []).length ? (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-title">
              <Icon.zap size={15} />
              从模板快速开始
            </div>
            <div className="card-sub">套用后可以逐条修改，也可以直接让 AI 按你的情况生成。</div>
            <div className="grid two">
              {TEMPLATES.map((t) => (
                <button key={t.name} className="sample-card" onClick={() => applyTemplate(t)} style={{ textAlign: 'left' }}>
                  <div style={{ fontWeight: 620, marginBottom: 3 }}>{t.name}</div>
                  <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>{t.desc}</div>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <TimelineEditor
          mode={schedule.mode}
          dayKey={schedule.mode === 'workday' ? (weekDay === 'rest' ? 'rest' : 'work') : weekDay}
          items={sorted(listFor(schedule.mode === 'workday' ? (weekDay === 'rest' ? 'rest' : 'work') : weekDay) || [])}
          nowMin={nowMin}
          isToday={
            schedule.mode === 'weekly'
              ? weekDay === todayDow
              : schedule.mode === 'workday'
                ? ((schedule.workdays || [1, 2, 3, 4, 5]).includes(Number(todayDow)) === (weekDay === 'work'))
                : (schedule.activeDays || []).includes(Number(todayDow))
          }
          studyMinutes={studyMinutes(listFor(schedule.mode === 'workday' ? (weekDay === 'rest' ? 'rest' : 'work') : weekDay) || [])}
          onEdit={(item) => setEditing({ day: schedule.mode === 'workday' ? (weekDay === 'rest' ? 'rest' : 'work') : weekDay, item })}
          onToggle={(item) => {
            const key = schedule.mode === 'workday' ? (weekDay === 'rest' ? 'rest' : 'work') : weekDay
            const items = listFor(key).map((i) => (i.id === item.id ? { ...i, remind: i.remind === false } : i))
            void persist(setListFor(schedule, key, items))
          }}
          onDuplicate={(item) => duplicateItem(schedule.mode === 'workday' ? (weekDay === 'rest' ? 'rest' : 'work') : weekDay, item)}
        />

        {/* weekly overview when in weekly mode */}
        {schedule.mode === 'weekly' ? (
          <div style={{ marginTop: 22 }}>
            <h2 style={{ fontSize: 15, marginBottom: 10, fontWeight: 660 }}>一周总览</h2>
            <div className="week-grid">
              {DAYS.map((d) => {
                const items = sorted(schedule.weekly[String(d.n)] || [])
                const mins = studyMinutes(items)
                return (
                  <div className="week-col" key={d.n}>
                    <div className={clsx('week-col-head', String(d.n) === todayDow && 'today')}>
                      {d.label}
                      <div style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--text-3)' }}>
                        {(mins / 60).toFixed(1)}h
                      </div>
                    </div>
                    {items.length ? (
                      items.slice(0, 12).map((it) => (
                        <div
                          className="week-mini"
                          key={it.id}
                          data-kind={it.kind}
                          onClick={() => {
                            setWeekDay(String(d.n))
                            setEditing({ day: String(d.n), item: it })
                          }}
                          title={it.note || `${it.start} - ${it.end}`}
                        >
                          <div className="wm-time">{it.start}</div>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</div>
                        </div>
                      ))
                    ) : (
                      <button className="week-mini" onClick={() => { setWeekDay(String(d.n)); setEditing({ day: String(d.n), item: mk('08:00', '09:00', '新时段', 'study') }) }} style={{ borderLeftColor: 'var(--line)', color: 'var(--text-3)' }}>
                        + 添加
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        {/* workday/rest overview */}
        {schedule.mode === 'workday' ? (
          <div className="grid two" style={{ marginTop: 22 }}>
            {[
              { key: 'work', label: '工作日作息', items: sorted(schedule.workday.work) },
              { key: 'rest', label: '休息日作息', items: sorted(schedule.workday.rest) },
            ].map((blk) => (
              <div className="card" key={blk.key}>
                <div className="card-title">
                  <Icon.clock size={15} />
                  {blk.label}
                </div>
                <div className="card-sub">
                  {blk.items.length} 个时段 · 学习 {(studyMinutes(blk.items) / 60).toFixed(1)} 小时
                </div>
                {blk.items.length ? (
                  <div className="col" style={{ gap: 5 }}>
                    {blk.items.map((it) => (
                      <div key={it.id} className="row" style={{ fontSize: 12.5, gap: 8 }}>
                        <span className="mono muted" style={{ flex: '0 0 auto' }}>
                          {it.start}
                        </span>
                        <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {it.title}
                        </span>
                        <span className="muted" style={{ fontSize: 11 }}>
                          {durationLabel(it.start, it.end)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 12.5 }}>尚未安排</div>
                )}
                <button className="btn sm" style={{ marginTop: 11 }} onClick={() => setWeekDay(blk.key === 'work' ? 'work' : 'rest')}>
                  编辑
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <ItemEditor
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={saveItem}
        onDelete={deleteItem}
      />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* timeline                                                            */
/* ------------------------------------------------------------------ */
function TimelineEditor({
  items,
  nowMin,
  isToday,
  mode,
  dayKey,
  studyMinutes,
  onEdit,
  onToggle,
  onDuplicate,
}: {
  items: PlanItem[]
  nowMin: number
  isToday: boolean
  mode: PlanSchedule['mode']
  dayKey: string
  studyMinutes: number
  onEdit: (i: PlanItem) => void
  onToggle: (i: PlanItem) => void
  onDuplicate: (i: PlanItem) => void
}) {
  if (!items.length) {
    return (
      <EmptyState
        icon="calendar"
        title="这一天还没有安排"
        body="点击「添加时段」手动编排，或从上面的模板一键套用。也可以让 AI 根据你的复习进度生成计划。"
      />
    )
  }
  return (
    <div>
      <div className="row" style={{ gap: 12, marginBottom: 11, fontSize: 12.5, color: 'var(--text-3)' }}>
        <span>
          共 <b style={{ color: 'var(--text-1)' }}>{items.length}</b> 个时段
        </span>
        <span>
          其中学习类 <b style={{ color: 'var(--accent)' }}>{(studyMinutes / 60).toFixed(1)} 小时</b>
        </span>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 11.5 }}>
          点击时段可编辑 · 右侧开关控制是否提醒
        </span>
      </div>

      <div className="timeline">
        {items.map((it) => {
          const s = toMinutes(it.start) ?? 0
          const e = toMinutes(it.end)
          const active = isToday && e !== null && nowMin >= s && nowMin < e
          const done = isToday && e !== null && nowMin >= e
          return (
            <div className={clsx('tl-item', active && 'active', done && 'done')} key={it.id} data-kind={it.kind}>
              <div className="tl-time">
                <div className="tl-start mono">{it.start}</div>
                <div className="mono" style={{ fontSize: 10.5 }}>
                  {it.end || '—'}
                </div>
              </div>
              <div className="tl-rail">
                <span className="tl-dot" />
              </div>
              <div className="tl-card pointer" onClick={() => onEdit(it)}>
                <div className="tl-title">
                  <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.title}
                  </span>
                  {it.subject ? <span className="chip">{it.subject}</span> : null}
                  <span className="chip" style={{ fontSize: 10.5 }}>
                    {KINDS.find((k) => k.v === it.kind)?.label || it.kind}
                  </span>
                  {active ? <span className="chip accent">进行中</span> : null}
                  {done ? <span className="chip">已完成</span> : null}
                </div>
                <div className="tl-note">
                  {durationLabel(it.start, it.end)}
                  {it.note ? ` · ${it.note}` : ''}
                </div>
              </div>
              <div className="col center" style={{ justifyContent: 'center', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn ghost icon sm"
                  title={it.remind === false ? '已关闭提醒，点击开启' : '提醒已开启，点击关闭'}
                  onClick={() => onToggle(it)}
                >
                  {it.remind === false ? <Icon.bellOff size={14} style={{ color: 'var(--text-3)' }} /> : <Icon.bell size={14} style={{ color: 'var(--accent)' }} />}
                </button>
                <button className="btn ghost icon sm" title="复制到其他天" onClick={() => onDuplicate(it)}>
                  <Icon.copy size={14} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* item editor modal                                                   */
/* ------------------------------------------------------------------ */
function ItemEditor({
  editing,
  onClose,
  onSave,
  onDelete,
}: {
  editing: { day: string; item: PlanItem } | null
  onClose: () => void
  onSave: (day: string, item: PlanItem) => void
  onDelete: (day: string, id: string) => void
}) {
  const [draft, setDraft] = useState<PlanItem | null>(null)
  useEffect(() => {
    setDraft(editing ? { ...editing.item } : null)
  }, [editing])

  if (!editing || !draft) return null
  const isNew = !editing.item.title || editing.item.title === '新时段'
  const valid = !!draft.title.trim() && toMinutes(draft.start) !== null && (toMinutes(draft.end) !== null || !draft.end)

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? '添加时段' : '编辑时段'}
      icon="clock"
      footer={
        <>
          {!isNew ? (
            <button className="btn danger" onClick={() => onDelete(editing.day, draft.id)}>
              <Icon.trash size={15} />
              删除
            </button>
          ) : null}
          <div className="grow" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => onSave(editing.day, draft)}>
            <Icon.check size={15} />
            保存
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <Field label="时段名称">
          <input
            className="input"
            value={draft.title}
            autoFocus
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="如：数学强化训练 / 真题精读"
          />
        </Field>

        <div className="row" style={{ gap: 12 }}>
          <Field label="开始时间">
            <input className="input" type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
          </Field>
          <Field label="结束时间" hint={draft.end && (toMinutes(draft.end) ?? 0) <= (toMinutes(draft.start) ?? 0) ? '跨天时段（如 23:00 - 06:00 表示睡眠）' : undefined}>
            <input className="input" type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
          </Field>
        </div>

        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Field label="类型">
            <select className="select" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as PlanItem['kind'] })}>
              {KINDS.map((k) => (
                <option key={k.v} value={k.v}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="科目（可选）">
            <input className="input" value={draft.subject || ''} onChange={(e) => setDraft({ ...draft, subject: e.target.value || undefined })} placeholder="数学 / 英语 / 专业课" />
          </Field>
        </div>

        <Field label="备注（可选）">
          <input className="input" value={draft.note || ''} onChange={(e) => setDraft({ ...draft, note: e.target.value || undefined })} placeholder="如：做 2023 数一真题 T1-T10" />
        </Field>

        <div className="settings-row" style={{ padding: '11px 14px' }}>
          <div className="sr-main">
            <div className="sr-title">开启到点提醒</div>
            <div className="sr-desc">关闭后该时段不会弹窗，但仍会显示在时间线上。</div>
          </div>
          <Switch checked={draft.remind !== false} onChange={(v) => setDraft({ ...draft, remind: v })} />
        </div>
      </div>
    </Modal>
  )
}
