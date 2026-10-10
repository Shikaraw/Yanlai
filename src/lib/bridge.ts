/**
 * Thin typed wrapper over the Electron preload bridge.
 *
 * When the renderer runs in a plain browser (vite dev without Electron, or a
 * GUI smoke test) `window.yanlai` is absent. Rather than crash we fall back to
 * an in-memory mock so every view stays explorable; anything that genuinely
 * needs the OS (native TTS, PDF printing, tray) reports a clear error instead
 * of pretending to succeed.
 */

import type { FocusWindowState } from './focus'

export type CalculatorMode = 'calculus' | 'matrix' | 'ode'
export interface CalculatorRequest { id: string; mode: CalculatorMode; expression: string; conditions?: string[] }
export interface CalculatorResult { text: string; latex: string | null; kind?: string; isMatrix?: boolean; matrixText?: string; label?: string }
export type CalculatorResponse = { id: string | null; ok: true; result: CalculatorResult }
  | { id: string | null; ok: false; error: { code: string; message: string } }
export interface CalculatorStatus { ready: boolean; state: 'ready' | 'starting' | 'stopped'; error?: string }

export interface YanlaiBridge {
  calculator: {
    status(): Promise<CalculatorStatus>
    ready(): Promise<CalculatorStatus>
    calculate(request: CalculatorRequest): Promise<CalculatorResponse>
    cancel(id: string): Promise<boolean>
    restart(): Promise<CalculatorStatus>
  }
  app: {
    info(): Promise<any>
    setLoginItem(v: boolean): Promise<boolean>
    onReady(cb: (p: any) => void): () => void
  }
  win: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    isMaximized(): Promise<boolean>
    close(): Promise<void>
    hide(): Promise<void>
    setAlwaysOnTop(v: boolean): Promise<boolean>
    onMaximizeChange(cb: (v: boolean) => void): () => void
    getFocusState(): Promise<FocusWindowState | null>
    onFocusState(cb: (state: FocusWindowState) => void): () => void
  }
  settings: {
    get(): Promise<any>
    set(patch: any): Promise<any>
    reset(): Promise<any>
    onChange(cb: (s: any) => void): () => void
  }
  dialog: {
    openFiles(o?: any): Promise<string[]>
    openFolder(o?: any): Promise<string | null>
    saveFile(o?: any): Promise<string | null>
    message(o?: any): Promise<number>
  }
  fs: {
    readText(f: string): Promise<string>
    readBase64(f: string): Promise<{ data: string; size: number } | null>
    writeText(file: string, text: string): Promise<{ ok: boolean; file?: string; error?: string }>
    writeBase64(file: string, base64: string): Promise<{ ok: boolean; file?: string; error?: string }>
    exists(f: string): Promise<boolean>
    stat(f: string): Promise<{ isDir: boolean; size: number; mtime: number } | null>
    delete(f: string): Promise<boolean>
    rename(from: string, to: string): Promise<{ ok: boolean; file?: string; error?: string }>
    listDir(d: string): Promise<Array<{ name: string; path: string; isDir: boolean; size: number; mtime: number }>>
    mkdir(d: string): Promise<{ ok: boolean; file?: string; error?: string }>
    reveal(f: string): Promise<boolean>
    pathForFile(file: File): string | null
  }
  shell: { openPath(f: string): Promise<{ ok: boolean; error?: string }>; openExternal(u: string): Promise<boolean> }
  clipboard: { readText(): Promise<string>; writeText(t: string): Promise<boolean> }
  paths: { info(): Promise<any>; toFileUrl(f: string): Promise<string> }
  attach: { save(name: string, base64: string): Promise<{ ok: boolean; file?: string; error?: string }>; prune(): Promise<number> }
  doc: { export(p: any): Promise<{ ok: boolean; file?: string; error?: string }> }
  tts: { voices(): Promise<any[]>; synth(p: any): Promise<any> }
  kb: {
    list(): Promise<any>
    saveIndex(d: any): Promise<boolean>
    saveChunks(docId: string, chunks: any[]): Promise<boolean>
    loadChunks(docId: string): Promise<any>
    delete(docId: string): Promise<boolean>
    copySource(src: string, docId: string): Promise<string | null>
    takeCliImport(): Promise<{ dir: string; subject?: string; exit?: boolean; replace?: boolean } | null>
    cliImportDone(): Promise<boolean>
    purgeFiles(): Promise<boolean>
  }
  planner: {
    getSchedule(): Promise<any>
    setSchedule(d: any): Promise<any>
    listPlans(): Promise<any>
    savePlan(p: any): Promise<any>
    activatePlan(id: string): Promise<any>
    deletePlan(id: string): Promise<any>
    status(): Promise<any>
    pause(v: boolean): Promise<boolean>
    preview(dayOffset: number): Promise<any>
    testFire(): Promise<boolean>
    onFired(cb: (p: any) => void): () => void
    onEvent(cb: (p: any) => void): () => void
  }
  reminder: { dismiss(): Promise<boolean>; openApp(): Promise<boolean>; snooze(m: number): Promise<boolean> }
  system: {
    notify(p: any): Promise<boolean>
    beep(): Promise<boolean>
    log(level: string, message: string): Promise<boolean>
    openLogs(): Promise<boolean>
  }
  update: {
    check(opts?: any): Promise<UpdateResult>
    releases(limit?: number): Promise<{ ok: boolean; source?: string; releases: ReleaseInfo[] }>
    mirrors(): Promise<MirrorPreset[]>
    skipVersion(v: string): Promise<boolean>
    clearSkip(): Promise<boolean>
    openRelease(p: { url: string; useMirror?: boolean }): Promise<string>
    onAvailable(cb: (r: UpdateResult) => void): () => void
  }
  tray: { onAction(cb: (a: string) => void): () => void }
}

export interface UpdateAsset {
  name: string
  size: number
  url: string
  mirrorUrl: string
  downloadCount?: number
}

export interface UpdateResult {
  ok: boolean
  source?: string
  sourceId?: string
  repo?: string
  currentVersion: string
  latestVersion?: string
  tagName?: string
  hasUpdate?: boolean
  releaseUrl?: string
  notes?: string
  publishedAt?: string | null
  prerelease?: boolean
  assets?: UpdateAsset[]
  attempts?: Array<{ source: string; error: string; statusCode?: number }>
  reason?: 'no-release' | 'network' | string
  message?: string
}

export interface ReleaseInfo {
  tag: string
  name: string
  publishedAt: string
  prerelease: boolean
  notes: string
  url: string
  assets: Array<{ name: string; size: number; url: string; mirrorUrl: string }>
}

export interface MirrorPreset {
  id: string
  name: string
  prefix: string
  note?: string
}

export const isElectron = typeof window !== 'undefined' && !!(window as any).yanlai

/* ------------------------------------------------------------------ */
/* browser mock                                                        */
/* ------------------------------------------------------------------ */
const memFs = new Map<string, string>()
const LS_SETTINGS = 'yanlai.settings.mock'

function mockSettings() {
  try {
    return JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null')
  } catch {
    return null
  }
}

const noopUnsub = () => () => {}

function makeMock(): YanlaiBridge {
  const base = '/mock'
  const MOCK_DEFAULT = {
    provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', temperature: 0.6, maxTokens: 8192, topP: 1, presetId: 'deepseek' },
    presets: [
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    ],
    embedding: { enabled: false, baseUrl: '', apiKey: '', model: '' },
    workspace: `${base}/workspace`,
    appearance: { theme: 'dark', accent: 'cyan', fontScale: 1, reduceMotion: false, compact: false },
    agent: { toolsEnabled: true, maxToolRounds: 4, autoKnowledgeSearch: true, systemPromptExtra: '' },
    tokens: { savingEnabled: true, historyRounds: 10, kbTopK: 4, kbCharBudget: 3200, compressThreshold: 6000, stripOldImages: true, stripOldTools: true },
    tts: { engine: 'off', autoRead: 'off', voice: '', rate: 1, pitch: 1, volume: 1, api: { baseUrl: '', apiKey: '', model: '', voice: '', format: 'mp3' } },
    planner: { mode: 'workday', notify: true, notifySound: true, popup: true, advanceSeconds: 0, activeDays: [1, 2, 3, 4, 5, 6, 7] },
    memory: { autoWrongBook: true, autoFlashcards: false, autoKnowledgeSave: true },
    update: { enabled: true, autoCheck: true, source: 'mirror', mirrorId: 'ghproxy', customPrefix: '', repo: 'Shikaraw/Yanlai', useSystemProxy: false, skippedVersion: '', lastCheckedAt: 0, lastResult: null },
    ui: { sendOnEnter: true, showTokens: true, showTimestamps: false, confirmExit: true, minimizeToTray: true, startMinimized: false, autoLaunch: false },
    onboardingDone: false,
  }
  const merge = (a: any, b: any): any => {
    if (Array.isArray(b)) return b
    if (b === null || b === undefined) return a
    if (typeof b !== 'object') return b
    const out = { ...(a && typeof a === 'object' ? a : {}) }
    for (const k of Object.keys(b)) out[k] = merge(out[k], b[k])
    return out
  }
  let settings = merge(structuredClone(MOCK_DEFAULT), mockSettings() || {})
  const store = {
    index: JSON.parse(localStorage.getItem('yanlai.kbidx.mock') || '{"docs":[]}'),
    chunks: {} as Record<string, any>,
    planner: JSON.parse(localStorage.getItem('yanlai.planner.mock') || 'null'),
  }
  let planLibrary = JSON.parse(localStorage.getItem('yanlai.plans.mock') || 'null') || { version: 1, activeId: '', plans: [] }
  if (!planLibrary.plans.length && store.planner) {
    const id = crypto.randomUUID()
    store.planner = { ...store.planner, planId: id, name: store.planner.name || '默认计划' }
    planLibrary = { version: 1, activeId: id, plans: [{ id, name: store.planner.name, schedule: store.planner, createdAt: Date.now(), updatedAt: Date.now() }] }
  }
  const persistPlans = () => {
    localStorage.setItem('yanlai.plans.mock', JSON.stringify(planLibrary))
    localStorage.setItem('yanlai.planner.mock', JSON.stringify(store.planner))
  }
  const persistSettings = () => localStorage.setItem(LS_SETTINGS, JSON.stringify(settings))

  return {
    calculator: {
      status: async () => ({ ready: false, state: 'stopped', error: '符号计算需要桌面应用和 Python/SymPy。' }),
      ready: async () => ({ ready: false, state: 'stopped', error: '符号计算需要桌面应用和 Python/SymPy。' }),
      restart: async () => ({ ready: false, state: 'stopped', error: '符号计算需要桌面应用和 Python/SymPy。' }),
      calculate: async request => ({ id: request.id, ok: false, error: { code: 'UNAVAILABLE', message: '浏览器预览不执行 Python，请使用桌面应用。' } }),
      cancel: async () => false,
    },
    app: {
      info: async () => ({ version: '1.0.00', name: '研来', platform: 'browser', arch: 'n/a', electron: '-', chrome: navigator.userAgent, node: '-', userData: base, isDev: true, mock: true }),
      setLoginItem: async () => false,
      onReady: noopUnsub,
    },
    win: {
      minimize: async () => {},
      toggleMaximize: async () => false,
      isMaximized: async () => false,
      close: async () => {},
      hide: async () => {},
      setAlwaysOnTop: async (v) => v,
      onMaximizeChange: noopUnsub,
      getFocusState: async () => null, // No desktop observation in browser preview.
      onFocusState: noopUnsub,
    },
    settings: {
      get: async () => settings,
      set: async (patch) => {
        settings = merge(settings, patch || {})
        persistSettings()
        return settings
      },
      reset: async () => {
        settings = structuredClone(MOCK_DEFAULT)
        persistSettings()
        return settings
      },
      onChange: () => () => {},
    },
    dialog: {
      openFiles: async () => [],
      openFolder: async () => `${base}/workspace`,
      saveFile: async (o?: any) => o?.defaultPath || `${base}/export.txt`,
      message: async () => 0,
    },
    fs: {
      readText: async (f) => memFs.get(f) ?? '',
      readBase64: async (f) => (memFs.has(f) ? { data: memFs.get(f)!, size: memFs.get(f)!.length } : null),
      writeText: async (file, text) => {
        memFs.set(file, text)
        return { ok: true, file }
      },
      writeBase64: async (file, b64) => {
        memFs.set(file, b64)
        return { ok: true, file }
      },
      exists: async (f) => memFs.has(f),
      stat: async (f) => (memFs.has(f) ? { isDir: false, size: memFs.get(f)!.length, mtime: Date.now() } : null),
      delete: async (f) => memFs.delete(f),
      rename: async (from, to) => {
        const v = memFs.get(from)
        if (v === undefined) return { ok: false, error: 'not found' }
        memFs.delete(from)
        memFs.set(to, v)
        return { ok: true, file: to }
      },
      listDir: async () => [],
      mkdir: async (d) => ({ ok: true, file: d }),
      reveal: async () => false,
      pathForFile: () => null,
    },
    shell: {
      openPath: async () => ({ ok: false, error: '仅在桌面应用内可用' }),
      openExternal: async (u) => {
        window.open(u, '_blank')
        return true
      },
    },
    clipboard: {
      readText: async () => navigator.clipboard.readText().catch(() => ''),
      writeText: async (t) => {
        await navigator.clipboard.writeText(t).catch(() => {})
        return true
      },
    },
    paths: {
      info: async () => ({ home: base, desktop: base, documents: base, downloads: base, pictures: base, temp: base, userData: base, defaultWorkspace: `${base}/workspace`, defaultExports: `${base}/exports`, sep: '/' }),
      toFileUrl: async (f) => f,
    },
    attach: {
      save: async (name) => ({ ok: true, file: `${base}/attachments/${name}` }),
      prune: async () => 0,
    },
    doc: { export: async () => ({ ok: false, error: '浏览器预览模式不支持导出，请使用桌面应用。' }) },
    tts: { voices: async () => [], synth: async () => ({ ok: false, error: '浏览器预览模式请使用 Web Speech / API 朗读。' }) },
    kb: {
      list: async () => store.index,
      saveIndex: async (d) => {
        store.index = d
        localStorage.setItem('yanlai.kbidx.mock', JSON.stringify(d))
        return true
      },
      saveChunks: async (docId, chunks) => {
        store.chunks[docId] = chunks
        return true
      },
      loadChunks: async (docId) => ({ docId, chunks: store.chunks[docId] || [] }),
      delete: async (docId) => {
        delete store.chunks[docId]
        return true
      },
      copySource: async () => null,
      takeCliImport: async () => null,
      cliImportDone: async () => true,
      purgeFiles: async () => true,
    },
    planner: {
      getSchedule: async () => store.planner,
      setSchedule: async (d) => {
        const id = planLibrary.activeId || crypto.randomUUID()
        store.planner = { ...d, planId: id, name: d.name || '默认计划', updatedAt: Date.now() }
        const index = planLibrary.plans.findIndex((p: any) => p.id === id)
        const plan = { id, name: store.planner.name, schedule: store.planner, createdAt: index < 0 ? Date.now() : planLibrary.plans[index].createdAt, updatedAt: Date.now() }
        if (index < 0) planLibrary.plans.push(plan)
        else planLibrary.plans[index] = plan
        planLibrary.activeId = id
        persistPlans()
        return { ok: true, schedule: structuredClone(store.planner), library: structuredClone(planLibrary) }
      },
      listPlans: async () => structuredClone(planLibrary),
      savePlan: async ({ id, name, schedule }) => {
        const index = planLibrary.plans.findIndex((p: any) => p.id === id)
        if (id && index < 0) return { ok: false, error: '计划不存在' }
        const plan = { id: id || crypto.randomUUID(), name: String(name || '未命名计划').trim() || '未命名计划', schedule: structuredClone(schedule), createdAt: index < 0 ? Date.now() : planLibrary.plans[index].createdAt, updatedAt: Date.now() }
        plan.schedule = { ...plan.schedule, name: plan.name, planId: plan.id, updatedAt: plan.updatedAt }
        if (index < 0) planLibrary.plans.push(plan)
        else planLibrary.plans[index] = plan
        if (planLibrary.activeId === plan.id) store.planner = plan.schedule
        persistPlans()
        return { ok: true, plan: structuredClone(plan), library: structuredClone(planLibrary) }
      },
      activatePlan: async (id) => {
        const plan = planLibrary.plans.find((p: any) => p.id === id)
        if (!plan) return { ok: false, error: '计划不存在' }
        planLibrary.activeId = id
        store.planner = structuredClone(plan.schedule)
        persistPlans()
        return { ok: true, schedule: structuredClone(store.planner), library: structuredClone(planLibrary) }
      },
      deletePlan: async (id) => {
        if (planLibrary.plans.length <= 1) return { ok: false, error: '至少保留一个计划' }
        planLibrary.plans = planLibrary.plans.filter((p: any) => p.id !== id)
        if (planLibrary.activeId === id) {
          planLibrary.activeId = planLibrary.plans[0].id
          store.planner = structuredClone(planLibrary.plans[0].schedule)
        }
        persistPlans()
        return { ok: true, schedule: structuredClone(store.planner), library: structuredClone(planLibrary) }
      },
      status: async () => ({ paused: false, mode: store.planner?.mode || 'unified', hasSchedule: !!store.planner, now: 0, current: null, next: null, count: 0, progress: 0 }),
      pause: async (v) => v,
      preview: async () => [],
      testFire: async () => false,
      onFired: noopUnsub,
      onEvent: noopUnsub,
    },
    reminder: { dismiss: async () => true, openApp: async () => true, snooze: async () => true },
    system: {
      notify: async (p) => {
        try {
          if ('Notification' in window && Notification.permission === 'granted') new Notification(p.title, { body: p.body })
        } catch {}
        return true
      },
      beep: async () => false,
      log: async () => true,
      openLogs: async () => false,
    },
    update: {
      // browser preview has no Electron net stack; report unsupported honestly
      check: async () => ({ ok: false, currentVersion: '1.0.00', reason: 'network', message: '更新检查需要桌面应用环境（浏览器预览不支持）。' }),
      releases: async () => ({ ok: false, releases: [] }),
      mirrors: async () => [
        { id: 'ghproxy', name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/', note: '长期稳定，推荐' },
        { id: 'ghfast', name: 'ghfast.top', prefix: 'https://ghfast.top/', note: '备用线路' },
        { id: 'direct', name: 'GitHub 官方直连', prefix: '', note: '需要能直连 GitHub' },
      ],
      skipVersion: async () => true,
      clearSkip: async () => true,
      openRelease: async ({ url }) => {
        window.open(url, '_blank')
        return url
      },
      onAvailable: noopUnsub,
    },
    tray: { onAction: noopUnsub },
  }
}

export const bridge: YanlaiBridge = isElectron ? ((window as any).yanlai as YanlaiBridge) : makeMock()
