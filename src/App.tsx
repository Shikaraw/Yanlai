import { useEffect, useMemo, useState } from 'react'
import { useApp, type ViewId } from './store/useApp'
import { useData } from './store/useData'
import { useChat, sessionListSorted } from './store/useChat'
import { Icon } from './components/Icons'
import { Dropdown, Modal, Toasts } from './components/ui'
import { ChatView } from './views/ChatView'
import { PlannerView } from './views/PlannerView'
import { WrongbookView } from './views/WrongbookView'
import { FlashcardsView } from './views/FlashcardsView'
import { KnowledgeView } from './views/KnowledgeView'
import { DashboardView } from './views/DashboardView'
import { WorkspaceView } from './views/WorkspaceView'
import { SettingsView } from './views/SettingsView'
import { PreviewPanel, type PreviewTarget } from './views/PreviewPanel'
import { UpdatePrompt } from './views/UpdatePanel'
import { bridge, isElectron } from './lib/bridge'
import { clsx, relativeTime } from './lib/util'
import type { Artifact } from './lib/types'

const NAV: Array<{ id: ViewId; label: string; icon: keyof typeof Icon }> = [
  { id: 'chat', label: '对话工作台', icon: 'chat' },
  { id: 'planner', label: '时间规划', icon: 'calendar' },
  { id: 'wrongbook', label: '错题本', icon: 'target' },
  { id: 'flashcards', label: '背诵卡片', icon: 'cards' },
  { id: 'knowledge', label: '知识库', icon: 'database' },
  { id: 'dashboard', label: '学习统计', icon: 'chart' },
  { id: 'workspace', label: '工作区', icon: 'folder' },
]

export function App() {
  const app = useApp()
  const data = useData()
  const chat = useChat()
  const [preview, setPreview] = useState<PreviewTarget | null>(null)
  const [booted, setBooted] = useState(false)

  /* ---------------- boot ---------------- */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await app.init()
      await Promise.all([data.load(), chat.load()])
      // prune stale attachment files on startup (keeps the data dir bounded)
      bridge.attach.prune().catch(() => {})
      if (!cancelled) setBooted(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /* ---------------- planner status polling ---------------- */
  useEffect(() => {
    const load = async () => {
      const st = await bridge.planner.status().catch(() => null)
      if (st) app.setPlannerStatus(st)
    }
    void load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])

  /* ---------------- tray actions ---------------- */
  useEffect(() => {
    const unsub = bridge.tray.onAction((action) => {
      const map: Record<string, ViewId> = {
        'new-chat': 'chat',
        'go-chat': 'chat',
        'go-planner': 'planner',
        'go-wrongbook': 'wrongbook',
        'go-knowledge': 'knowledge',
        'go-flashcards': 'flashcards',
        'go-dashboard': 'dashboard',
        'go-settings': 'settings',
        'go-about': 'settings',
        'go-update': 'settings',
      }
      if (action === 'new-chat') void chat.newSession()
      else if (action === 'go-settings') app.setView('settings', 'model')
      else if (action === 'go-about') app.setView('settings', 'about')
      else if (action === 'go-update') app.setView('settings', 'update')
      else if (action === 'toggle-tts') {
        const cur = app.settings?.tts?.autoRead || 'off'
        const next = cur === 'off' ? 'after' : 'off'
        void app.patchSettings({ tts: { autoRead: next } })
        app.toast({ kind: 'info', title: next === 'off' ? '已关闭自动朗读' : '已开启「输出完朗读」' })
      } else if (action === 'planner-pause') {
        app.toast({ kind: 'info', title: '时间提醒已暂停' })
      } else if (map[action]) {
        app.setView(map[action])
      }
    })
    return unsub
  }, [])

  /* ---------------- reminder events refresh state ---------------- */
  useEffect(() => {
    const unsub = bridge.planner.onEvent(async () => {
      const st = await bridge.planner.status().catch(() => null)
      if (st) app.setPlannerStatus(st)
    })
    return unsub
  }, [])

  /* ---------------- keyboard shortcuts ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) {
        if (e.key === 'Escape' && app.paletteOpen) app.setPalette(false)
        return
      }
      if (e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        app.setPalette(!app.paletteOpen)
        return
      }
      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault()
          void chat.newSession()
          break
        case 'p':
          if (!e.shiftKey) {
            e.preventDefault()
            app.setView('planner')
          }
          break
        case 'b':
          e.preventDefault()
          app.setView('wrongbook')
          break
        case 'k':
          e.preventDefault()
          app.setView('knowledge')
          break
        case ',':
          e.preventDefault()
          app.setView('settings')
          break
        default:
          break
      }
    }
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      const a = t.closest('a[href^="http"]') as HTMLAnchorElement | null
      if (a) {
        e.preventDefault()
        bridge.shell.openExternal(a.href)
      }
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('click', onClick)
    }
  }, [app.paletteOpen])

  const dueWrong = useMemo(() => {
    const end = new Date()
    end.setHours(23, 59, 59, 999)
    return data.wrongEntries.filter((w) => w.mastery < 5 && (w.nextReviewAt ?? 0) <= end.getTime()).length
  }, [data.wrongEntries])
  const dueCards = useMemo(() => data.dueFlashcards().length, [data.flashcards])

  const badges: Partial<Record<ViewId, number>> = {
    wrongbook: dueWrong,
    flashcards: dueCards,
  }

  const openArtifact = (a: Artifact) => {
    setPreview({ kind: 'artifact', artifact: a, name: a.name, path: a.path })
    if (!app.rightPanel) app.setRightPanel(true)
  }

  const showPreview = app.rightPanel && app.view === 'chat'

  if (!booted) {
    return (
      <div className="app">
        <div />
        <div className="main-col" style={{ display: 'grid', placeItems: 'center' }}>
          <div className="col center" style={{ gap: 13 }}>
            <img src="./logo.svg" alt="研来" style={{ width: 60, height: 60, borderRadius: 17 }} />
            <div style={{ fontWeight: 640, letterSpacing: '0.05em' }}>研来 · 正在启动</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <Sidebar badges={badges} />
      <div className="main-col">
        <TitleBar />
        {app.view === 'chat' ? (
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <ChatView onOpenArtifact={openArtifact} />
            {showPreview ? (
              <PreviewPanel target={preview} onClose={() => app.setRightPanel(false)} onChangeTarget={setPreview} />
            ) : null}
          </div>
        ) : app.view === 'planner' ? (
          <PlannerView />
        ) : app.view === 'wrongbook' ? (
          <WrongbookView />
        ) : app.view === 'flashcards' ? (
          <FlashcardsView />
        ) : app.view === 'knowledge' ? (
          <KnowledgeView />
        ) : app.view === 'dashboard' ? (
          <DashboardView />
        ) : app.view === 'workspace' ? (
          <WorkspaceView />
        ) : app.view === 'settings' ? (
          <SettingsView />
        ) : null}
      </div>

      <Toasts toasts={app.toasts} onDismiss={app.dismissToast} />
      <ConfirmDialog />
      <UpdatePrompt />
      <CommandPalette />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* sidebar                                                            */
/* ------------------------------------------------------------------ */
function Sidebar({ badges }: { badges: Partial<Record<ViewId, number>> }) {
  const app = useApp()
  const chat = useChat()
  const [search, setSearch] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)

  const sessions = sessionListSorted(chat.sessions, search)
  const collapsed = app.sidebarCollapsed

  return (
    <aside className={clsx('sidebar', collapsed && 'collapsed')}>
      <div className="sidebar-head">
        <img src="./logo.svg" alt="研来" style={{ width: 30, height: 30, borderRadius: 9, flex: '0 0 auto' }} />
        {!collapsed ? (
          <div className="grow brand-text" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 680, letterSpacing: '0.01em' }}>研来</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-3)', letterSpacing: '0.06em' }}>YANLAI · 考研辅导</div>
          </div>
        ) : null}
        <button className="btn ghost icon sm" onClick={() => app.toggleSidebar()} title={collapsed ? '展开侧栏' : '收起侧栏'}>
          <Icon.sidebar size={15} />
        </button>
      </div>

      <div style={{ padding: '0 8px 8px' }}>
        <button className="btn primary" style={{ width: '100%' }} onClick={() => void chat.newSession()} title="新建对话 (Ctrl+N)">
          <Icon.plus size={15} />
          {collapsed ? '' : '新建对话'}
        </button>
      </div>

      <nav className="nav">
        {NAV.map((n) => {
          const I = Icon[n.icon]
          const badge = badges[n.id]
          return (
            <button key={n.id} className={clsx('nav-item', app.view === n.id && 'active')} onClick={() => app.setView(n.id)} title={collapsed ? n.label : undefined}>
              <span className="nav-icon">
                <I size={17} />
              </span>
              <span className="nav-label">{n.label}</span>
              {badge ? <span className="nav-badge">{badge > 99 ? '99+' : badge}</span> : null}
            </button>
          )
        })}
      </nav>

      <div className="sidebar-section-title">
        <span>对话记录</span>
        {!collapsed && chat.sessions.length ? <span style={{ fontWeight: 500, letterSpacing: 0 }}>{chat.sessions.length}</span> : null}
      </div>

      {!collapsed ? (
        <div style={{ padding: '0 12px 8px' }}>
          <div className="row center" style={{ gap: 7, background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 8, padding: '5px 9px' }}>
            <Icon.search size={13} style={{ color: 'var(--text-3)' }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索对话…"
              style={{ border: 'none', background: 'none', outline: 'none', width: '100%', fontSize: 12.5 }}
            />
          </div>
        </div>
      ) : null}

      <div className="session-list">
        {sessions.length ? (
          sessions.map((s) => (
            <div
              key={s.id}
              className={clsx('session-item', chat.currentId === s.id && 'active')}
              onClick={() => {
                chat.selectSession(s.id)
                app.setView('chat')
              }}
              title={s.title}
            >
              {s.pinned ? (
                <span className="pin-dot">
                  <Icon.pin size={12} />
                </span>
              ) : null}
              <span className="s-title">{s.title}</span>
              <span className="s-actions" onClick={(e) => e.stopPropagation()}>
                <Dropdown
                  trigger={(open) => (
                    <button className="s-icon-btn" onClick={open} title="更多操作">
                      <Icon.chevronDown size={13} />
                    </button>
                  )}
                  entries={[
                    { label: s.pinned ? '取消置顶' : '置顶对话', icon: 'pin', onClick: () => void chat.togglePin(s.id) },
                    { label: '重命名', icon: 'edit', onClick: () => setRenaming({ id: s.id, title: s.title }) },
                    {
                      label: '查看 token 用量',
                      icon: 'zap',
                      onClick: () =>
                        app.toast({
                          kind: 'info',
                          title: '本会话累计用量',
                          body: `${(s.sessionTokens || 0).toLocaleString()} tokens · ${s.messages.length} 条消息`,
                        }),
                    },
                    { separator: true, label: '' },
                    {
                      label: '删除对话',
                      icon: 'trash',
                      danger: true,
                      onClick: async () => {
                        const ok = await app.ask({ title: '删除这个对话？', body: s.title, confirmText: '删除', danger: true })
                        if (ok) void chat.deleteSession(s.id)
                      },
                    },
                  ]}
                />
              </span>
            </div>
          ))
        ) : (
          <div className="muted" style={{ fontSize: 12, padding: '10px 12px' }}>
            {search ? '没有匹配的对话' : '还没有对话'}
          </div>
        )}
      </div>

      <div className="sidebar-foot">
        <button className="btn ghost icon sm" onClick={() => app.setView('settings')} title="设置">
          <Icon.settings size={15} />
        </button>
        {!collapsed ? (
          <>
            <span className="sidebar-foot-text grow" style={{ fontSize: 11 }}>
              v{app.info?.version || '1.0.00'}
              {!isElectron ? ' · 网页预览' : ''}
            </span>
            <button className="btn ghost icon sm" onClick={() => app.setView('settings', 'about')} title="关于与帮助">
              <Icon.info size={15} />
            </button>
            <button
              className="btn ghost icon sm"
              onClick={() => app.setPalette(true)}
              title="命令面板 (Ctrl+Shift+P)"
            >
              <Icon.terminal size={15} />
            </button>
          </>
        ) : null}
      </div>

      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="重命名对话"
        icon="edit"
        footer={
          <>
            <button className="btn" onClick={() => setRenaming(null)}>
              取消
            </button>
            <button
              className="btn primary"
              onClick={() => {
                if (renaming) void chat.renameSession(renaming.id, renaming.title)
                setRenaming(null)
              }}
            >
              保存
            </button>
          </>
        }
      >
        <input
          className="input"
          autoFocus
          value={renaming?.title || ''}
          onChange={(e) => setRenaming(renaming ? { ...renaming, title: e.target.value } : null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && renaming) {
              void chat.renameSession(renaming.id, renaming.title)
              setRenaming(null)
            }
          }}
        />
      </Modal>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* titlebar                                                           */
/* ------------------------------------------------------------------ */
function TitleBar() {
  const app = useApp()
  const chat = useChat()
  const session = chat.sessions.find((s) => s.id === chat.currentId)
  const status = app.plannerStatus
  const [maximized, setMaximized] = useState(false)
  const [pinned, setPinned] = useState(false)

  useEffect(() => {
    bridge.win.isMaximized?.().then(setMaximized)
    return bridge.win.onMaximizeChange?.((v: boolean) => setMaximized(!!v))
  }, [])

  const titleText = session?.title && session.title !== '新对话' ? session.title : '研来 · 考研学习辅导'

  return (
    <div className="titlebar">
      <div className="titlebar-brand no-drag" style={{ minWidth: 0 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{titleText}</span>
      </div>

      {/* current plan item — always visible, it is the "instrument readout" */}
      {status?.current ? (
        <span className="chip accent no-drag" style={{ flex: '0 0 auto' }} title={`${status.current.start} - ${status.current.end}`}>
          <Icon.clock size={12} />
          进行中：{status.current.title}
        </span>
      ) : status?.next ? (
        <span className="chip no-drag" style={{ flex: '0 0 auto' }} title="下一项安排">
          <Icon.clock size={12} />
          {status.next.start} {status.next.title}
        </span>
      ) : status?.hasSchedule === false ? (
        <button className="chip no-drag" style={{ flex: '0 0 auto', cursor: 'pointer' }} onClick={() => app.setView('planner')}>
          <Icon.calendar size={12} />
          设置作息计划
        </button>
      ) : null}

      <div className="titlebar-spacer" />

      <button
        className="btn ghost icon sm no-drag"
        title={app.rightPanel ? '隐藏预览面板' : '显示预览面板'}
        onClick={() => app.setRightPanel(!app.rightPanel)}
      >
        <Icon.eye size={15} />
      </button>
      <button
        className={clsx('btn ghost icon sm no-drag')}
        title={pinned ? '取消窗口置顶' : '窗口置顶（对照阅读时很有用）'}
        onClick={async () => {
          const v = await bridge.win.setAlwaysOnTop(!pinned)
          setPinned(!!v)
        }}
        style={pinned ? { color: 'var(--accent)' } : undefined}
      >
        <Icon.pin size={15} />
      </button>
      <button className="btn ghost icon sm no-drag" title="设置 (Ctrl+,)" onClick={() => app.setView('settings')}>
        <Icon.settings size={15} />
      </button>

      {isElectron ? (
        <div className="win-btns no-drag">
          <button className="win-btn" onClick={() => bridge.win.minimize()} title="最小化">
            <Icon.minimize size={15} />
          </button>
          <button
            className="win-btn"
            onClick={async () => setMaximized(await bridge.win.toggleMaximize())}
            title={maximized ? '还原' : '最大化'}
          >
            {maximized ? <Icon.restore size={14} /> : <Icon.maximize size={13} />}
          </button>
          <button className="win-btn close" onClick={() => bridge.win.close()} title="关闭（最小化到托盘）">
            <Icon.close size={15} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* confirm dialog                                                     */
/* ------------------------------------------------------------------ */
function ConfirmDialog() {
  const app = useApp()
  const c = app.confirm
  if (!c) return null
  return (
    <Modal
      open
      onClose={() => app.resolveConfirm(false)}
      title={c.title}
      icon={c.danger ? 'alert' : 'info'}
      footer={
        <>
          <button className="btn" onClick={() => app.resolveConfirm(false)}>
            取消
          </button>
          <button className={clsx('btn', c.danger ? 'danger' : 'primary')} onClick={() => app.resolveConfirm(true)} autoFocus>
            {c.confirmText || '确定'}
          </button>
        </>
      }
    >
      {c.body ? <div style={{ fontSize: 13.5, lineHeight: 1.7 }}>{c.body}</div> : null}
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/* command palette                                                    */
/* ------------------------------------------------------------------ */
function CommandPalette() {
  const app = useApp()
  const chat = useChat()
  const data = useData()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)

  const commands = useMemo(() => {
    const base: Array<{ label: string; hint?: string; icon: keyof typeof Icon; run: () => void }> = [
      { label: '新建对话', hint: 'Ctrl+N', icon: 'plus', run: () => void chat.newSession() },
      { label: '切换到 对话工作台', icon: 'chat', run: () => app.setView('chat') },
      { label: '切换到 时间规划', hint: 'Ctrl+P', icon: 'calendar', run: () => app.setView('planner') },
      { label: '切换到 错题本', hint: 'Ctrl+B', icon: 'target', run: () => app.setView('wrongbook') },
      { label: '切换到 背诵卡片', icon: 'cards', run: () => app.setView('flashcards') },
      { label: '切换到 知识库', hint: 'Ctrl+K', icon: 'database', run: () => app.setView('knowledge') },
      { label: '切换到 学习统计', icon: 'chart', run: () => app.setView('dashboard') },
      { label: '切换到 工作区', icon: 'folder', run: () => app.setView('workspace') },
      { label: '打开设置 · 模型与 API', icon: 'cpu', run: () => app.setView('settings', 'model') },
      { label: '打开设置 · 朗读', icon: 'volume', run: () => app.setView('settings', 'tts') },
      { label: '打开设置 · 省 token', icon: 'zap', run: () => app.setView('settings', 'tokens') },
      { label: '打开设置 · 工作区', icon: 'folder', run: () => app.setView('settings', 'workspace') },
      { label: '测试时间提醒弹窗', icon: 'bell', run: () => bridge.planner.testFire() },
      { label: '开始错题复习', icon: 'refresh', run: () => app.setView('wrongbook') },
      { label: '开始卡片复习', icon: 'cards', run: () => app.setView('flashcards') },
    ]
    // talking-point shortcuts that seed the composer
    const seeds = [
      { label: '让 AI 制定学习计划', text: '帮我制定考研学习计划。我的情况：' },
      { label: '让 AI 出一份整卷', text: '请出一份整卷，科目：' },
      { label: '让 AI 整理知识点', text: '请整理以下知识点：\n\n' },
      { label: '让 AI 做学习复盘', text: '帮我做一次学习复盘。\n' },
      { label: '让 AI 生成背诵卡片', text: '把以下内容做成背诵卡片：\n\n' },
    ]
    for (const s of seeds) {
      base.push({
        label: s.label,
        hint: '填入输入框',
        icon: 'sparkles',
        run: () => {
          app.setView('chat')
          setTimeout(() => {
            const el = document.getElementById('yanlai-composer') as HTMLTextAreaElement | null
            if (el) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
              setter?.call(el, s.text)
              el.dispatchEvent(new Event('input', { bubbles: true }))
              el.focus()
              el.setSelectionRange(el.value.length, el.value.length)
            }
          }, 130)
        },
      })
    }
    // jump to a specific chat
    for (const s of chat.sessions.slice(0, 12)) {
      base.push({
        label: `打开对话：${s.title}`,
        hint: relativeTime(s.updatedAt),
        icon: 'chat',
        run: () => {
          chat.selectSession(s.id)
          app.setView('chat')
        },
      })
    }
    // jump to a knowledge doc
    for (const d of data.kbDocs.slice(0, 8)) {
      base.push({
        label: `知识库：${d.name}`,
        hint: `${d.chunkCount} 段`,
        icon: 'database',
        run: () => app.setView('knowledge'),
      })
    }
    return base
  }, [chat.sessions, data.kbDocs])

  const filtered = useMemo(() => {
    if (!q.trim()) return commands.slice(0, 14)
    const needle = q.trim().toLowerCase()
    return commands
      .map((c) => {
        const l = c.label.toLowerCase()
        const idx = l.indexOf(needle)
        // prefix matches rank above mid-string matches
        return { c, score: idx < 0 ? -1 : idx === 0 ? 2 : 1 }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 14)
      .map((x) => x.c)
  }, [q, commands])

  useEffect(() => {
    setSel(0)
  }, [q, app.paletteOpen])

  useEffect(() => {
    if (!app.paletteOpen) setQ('')
  }, [app.paletteOpen])

  if (!app.paletteOpen) return null

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && app.setPalette(false)}>
      <div className="modal palette" role="dialog" aria-label="命令面板">
        <div className="palette-input-row">
          <Icon.terminal size={17} style={{ color: 'var(--accent)' }} />
          <input
            className="palette-input"
            autoFocus
            placeholder="输入命令或搜索对话、资料…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(s + 1, filtered.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(s - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const item = filtered[sel]
                if (item) {
                  item.run()
                  app.setPalette(false)
                }
              } else if (e.key === 'Escape') {
                app.setPalette(false)
              }
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list">
          {filtered.length ? (
            filtered.map((c, i) => {
              const I = Icon[c.icon]
              return (
                <button
                  key={c.label + i}
                  className={clsx('palette-item', i === sel && 'sel')}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => {
                    c.run()
                    app.setPalette(false)
                  }}
                >
                  <I size={15} style={{ color: i === sel ? 'var(--accent)' : 'var(--text-3)', flex: '0 0 auto' }} />
                  <span className="pi-label">{c.label}</span>
                  {c.hint ? <span className="pi-hint">{c.hint}</span> : null}
                </button>
              )
            })
          ) : (
            <div className="muted" style={{ padding: '18px 14px', fontSize: 13 }}>
              没有匹配的命令
            </div>
          )}
        </div>
        <div className="row between" style={{ padding: '9px 15px', borderTop: '1px solid var(--line)', fontSize: 11.5 }}>
          <span className="muted">
            <span className="kbd">↑</span> <span className="kbd">↓</span> 选择 · <span className="kbd">Enter</span> 执行
          </span>
          <span className="muted">{filtered.length} 项结果</span>
        </div>
      </div>
    </div>
  )
}
