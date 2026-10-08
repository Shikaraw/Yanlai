'use strict'
const path = require('node:path')
const fs = require('node:fs')
const { dirs, readJson } = require('./store.cjs')

/** Settings shape is owned by the renderer; main only persists it. */
const DEFAULT_SETTINGS = {
  version: 1,
  provider: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.6,
    maxTokens: 8192,
    topP: 1,
    presetId: 'deepseek',
  },
  presets: [
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'moonshot', name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { id: 'dashscope', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  ],
  embedding: { enabled: false, baseUrl: '', apiKey: '', model: 'text-embedding-3-small' },
  vision: { enabled: true },
  workspace: '',
  appearance: {
    theme: 'dark',
    accent: 'cyan',
    fontScale: 1,
    reduceMotion: false,
    compact: false,
  },
  agent: { toolsEnabled: true, maxToolRounds: 4, autoKnowledgeSearch: true, systemPromptExtra: '' },
  tokens: {
    savingEnabled: true,
    historyRounds: 10,
    kbTopK: 4,
    kbCharBudget: 3200,
    compressThreshold: 6000,
    stripOldImages: true,
    stripOldTools: true,
  },
  tts: {
    engine: 'off',
    autoRead: 'off',
    voice: '',
    rate: 1,
    pitch: 1,
    volume: 1,
    api: { baseUrl: '', apiKey: '', model: 'tts-1', voice: 'alloy', format: 'mp3' },
  },
  planner: {
    mode: 'workday',
    notify: true,
    notifySound: true,
    popup: true,
    advanceSeconds: 0,
    activeDays: [1, 2, 3, 4, 5, 6, 7],
  },
  memory: { autoWrongBook: true, autoFlashcards: false, autoKnowledgeSave: true },
  update: {
    enabled: true,
    autoCheck: true,
    /** mirror | direct | custom */
    source: 'mirror',
    mirrorId: 'ghproxy',
    customPrefix: '',
    repo: 'Shikaraw/Yanlai',
    /**
     * Use the OS/Clash proxy for update requests. Off by default: update checks
     * go to public GitHub mirrors, which are reachable directly, and inheriting
     * a broken system proxy makes every check fail with ERR_CONNECTION_CLOSED.
     * Only enable this if the machine has no direct route out at all.
     */
    useSystemProxy: false,
    /** skip a specific version so the prompt does not reappear every launch */
    skippedVersion: '',
    lastCheckedAt: 0,
    lastResult: null,
  },
  ui: {
    sendOnEnter: true,
    showTokens: true,
    showTimestamps: false,
    confirmExit: true,
    minimizeToTray: true,
    startMinimized: false,
    autoLaunch: false,
  },
  onboardingDone: false,
}

function settingsPath() {
  return path.join(dirs().userData, 'settings.json')
}

function loadSettings() {
  const saved = readJson(settingsPath(), {})
  return deepMerge(structuredClone(DEFAULT_SETTINGS), saved || {})
}

function saveSettings(patch) {
  const current = loadSettings()
  const next = deepMerge(current, patch || {})
  const { writeJson } = require('./store.cjs')
  writeJson(settingsPath(), next)
  return next
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch
  if (patch === null || patch === undefined) return base
  if (typeof patch !== 'object') return patch
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const k of Object.keys(patch)) {
    out[k] = deepMerge(out[k], patch[k])
  }
  return out
}

function ensureWorkspace() {
  const s = loadSettings()
  const ws = s.workspace || dirs().workspace
  try {
    fs.mkdirSync(ws, { recursive: true })
  } catch {}
  return ws
}

module.exports = { DEFAULT_SETTINGS, loadSettings, saveSettings, settingsPath, ensureWorkspace, deepMerge }
