import { create } from 'zustand'
import { bridge } from '../lib/bridge'
import { kvGet, kvSet } from '../lib/idb'
import { uid } from '../lib/util'

export type ViewId =
  | 'chat'
  | 'planner'
  | 'wrongbook'
  | 'flashcards'
  | 'knowledge'
  | 'dashboard'
  | 'workspace'
  | 'settings'
  | 'about'

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'warn' | 'error'
  title: string
  body?: string
  ttl?: number
  action?: { label: string; run: () => void }
}

export interface ConfirmReq {
  title: string
  body?: string
  confirmText?: string
  danger?: boolean
  resolve: (v: boolean) => void
}

interface AppState {
  ready: boolean
  settings: any
  info: any
  view: ViewId
  /** settings sub-tab to open when navigating to settings */
  settingsTab: string
  toasts: Toast[]
  confirm: ConfirmReq | null
  plannerStatus: any
  sidebarCollapsed: boolean
  rightPanel: boolean
  paletteOpen: boolean
  globalBusy: string | null

  init: () => Promise<void>
  setView: (v: ViewId, tab?: string) => void
  patchSettings: (patch: any, opts?: { silent?: boolean }) => Promise<void>
  resetSettings: () => Promise<void>
  toast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
  ask: (req: Omit<ConfirmReq, 'resolve'>) => Promise<boolean>
  resolveConfirm: (v: boolean) => void
  setPlannerStatus: (s: any) => void
  toggleSidebar: () => void
  setRightPanel: (v: boolean) => void
  setPalette: (v: boolean) => void
  setBusy: (label: string | null) => void
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  settings: null,
  info: null,
  view: 'chat',
  settingsTab: 'model',
  toasts: [],
  confirm: null,
  plannerStatus: null,
  sidebarCollapsed: false,
  rightPanel: false,
  paletteOpen: false,
  globalBusy: null,

  async init() {
    try {
      const [settings, info] = await Promise.all([bridge.settings.get(), bridge.app.info()])
      set({ settings, info })
      applyTheme(settings)
      const collapsed = await kvGet<boolean>('ui.sidebarCollapsed', false)
      const right = await kvGet<boolean>('ui.rightPanel', false)
      set({ ready: true, sidebarCollapsed: !!collapsed, rightPanel: right !== false })
      bridge.app.onReady?.(() => {})
      bridge.win.onMaximizeChange?.(() => {})
    } catch (e) {
      set({ ready: true })
      get().toast({ kind: 'error', title: '初始化失败', body: String((e as Error)?.message || e) })
    }
  },

  setView(v, tab) {
    set({ view: v, ...(tab ? { settingsTab: tab } : {}) })
  },

  async patchSettings(patch, opts) {
    const next = await bridge.settings.set(patch)
    set({ settings: next })
    applyTheme(next)
    if (!opts?.silent) {
      // keep noise low: only surface structural changes
      if (patch?.workspace !== undefined) get().toast({ kind: 'success', title: '工作区已更新' })
    }
    if (patch?.ui?.autoLaunch !== undefined) bridge.app.setLoginItem(!!patch.ui.autoLaunch)
  },

  async resetSettings() {
    const next = await bridge.settings.reset()
    set({ settings: next })
    applyTheme(next)
    get().toast({ kind: 'success', title: '已恢复默认设置' })
  },

  toast(t) {
    const id = uid('t')
    set({ toasts: [...get().toasts, { ...t, id }] })
    const ttl = t.ttl ?? (t.kind === 'error' ? 7000 : 3600)
    if (ttl > 0) setTimeout(() => get().dismissToast(id), ttl)
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((x) => x.id !== id) })
  },

  ask(req) {
    return new Promise<boolean>((resolve) => set({ confirm: { ...req, resolve } }))
  },

  resolveConfirm(v) {
    const c = get().confirm
    if (c) c.resolve(v)
    set({ confirm: null })
  },

  setPlannerStatus(s) {
    set({ plannerStatus: s })
  },

  toggleSidebar() {
    const v = !get().sidebarCollapsed
    set({ sidebarCollapsed: v })
    kvSet('ui.sidebarCollapsed', v)
  },

  setRightPanel(v) {
    set({ rightPanel: v })
    kvSet('ui.rightPanel', v)
  },

  setPalette(v) {
    set({ paletteOpen: v })
  },

  setBusy(label) {
    set({ globalBusy: label })
  },
}))

/** Theme is applied as CSS custom properties on <html> so every component can read it. */
export function applyTheme(s: any) {
  if (!s || typeof document === 'undefined') return
  const root = document.documentElement
  const theme = s.appearance?.theme === 'light' ? 'light' : 'dark'
  root.dataset.theme = theme
  root.dataset.accent = s.appearance?.accent || 'cyan'
  root.dataset.compact = s.appearance?.compact ? '1' : '0'
  root.style.setProperty('--font-scale', String(s.appearance?.fontScale || 1))
  root.style.setProperty('--motion', s.appearance?.reduceMotion ? '0' : '1')
}

/* Convenience selector hooks */
export const useSettings = () => useApp((s) => s.settings)
export const useTheme = () => useApp((s) => s.settings?.appearance)
