'use strict'
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload)

/** Subscribe helper that returns an unsubscribe function. */
function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('yanlai', {
  calculator: {
    status: () => invoke('calculator:status'),
    ready: () => invoke('calculator:ready'),
    calculate: (request) => invoke('calculator:calculate', request),
    cancel: (id) => invoke('calculator:cancel', id),
    restart: () => invoke('calculator:restart'),
  },
  app: {
    info: () => invoke('app:info'),
    setLoginItem: (v) => invoke('app:setLoginItem', v),
    onReady: (cb) => on('app:ready', cb),
  },
  win: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggleMaximize'),
    isMaximized: () => invoke('window:isMaximized'),
    close: () => invoke('window:close'),
    hide: () => invoke('window:hide'),
    setAlwaysOnTop: (v) => invoke('window:setAlwaysOnTop', v),
    onMaximizeChange: (cb) => on('window:maximizeChange', cb),
    getFocusState: () => invoke('window:getFocusState'),
    onFocusState: (cb) => on('window:focusState', cb),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    reset: () => invoke('settings:reset'),
    onChange: (cb) => on('settings:changed', cb),
  },
  dialog: {
    openFiles: (opts) => invoke('dialog:openFiles', opts),
    openFolder: (opts) => invoke('dialog:openFolder', opts),
    saveFile: (opts) => invoke('dialog:saveFile', opts),
    message: (opts) => invoke('dialog:message', opts),
  },
  fs: {
    readText: (f) => invoke('fs:readText', f),
    readBase64: (f) => invoke('fs:readBase64', f),
    writeText: (file, text) => invoke('fs:writeText', { file, text }),
    writeBase64: (file, base64) => invoke('fs:writeBase64', { file, base64 }),
    exists: (f) => invoke('fs:exists', f),
    stat: (f) => invoke('fs:stat', f),
    delete: (f) => invoke('fs:delete', f),
    rename: (from, to) => invoke('fs:rename', { from, to }),
    listDir: (d) => invoke('fs:listDir', d),
    mkdir: (d) => invoke('fs:mkdir', d),
    reveal: (f) => invoke('fs:reveal', f),
    // File.path was removed in Electron 32; this is the supported replacement
    // for turning a dropped File into a real filesystem path.
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || null
      } catch {
        return null
      }
    },
  },
  shell: {
    openPath: (f) => invoke('shell:openPath', f),
    openExternal: (u) => invoke('shell:openExternal', u),
  },
  clipboard: {
    readText: () => invoke('clipboard:readText'),
    writeText: (t) => invoke('clipboard:writeText', t),
  },
  paths: {
    info: () => invoke('path:info'),
    toFileUrl: (f) => invoke('path:toFileUrl', f),
  },
  attach: {
    save: (name, base64) => invoke('attach:save', { name, base64 }),
    prune: () => invoke('attach:prune'),
  },
  doc: {
    export: (payload) => invoke('doc:export', payload),
  },
  tts: {
    voices: () => invoke('tts:voices'),
    synth: (payload) => invoke('tts:synth', payload),
  },
  kb: {
    list: () => invoke('kb:list'),
    saveIndex: (d) => invoke('kb:saveIndex', d),
    saveChunks: (docId, chunks) => invoke('kb:saveChunks', { docId, chunks }),
    loadChunks: (docId) => invoke('kb:loadChunks', docId),
    delete: (docId) => invoke('kb:delete', docId),
    copySource: (src, docId) => invoke('kb:copySource', { src, docId }),
    takeCliImport: () => invoke('kb:cliImportTake'),
    cliImportDone: () => invoke('kb:cliImportDone'),
    purgeFiles: () => invoke('kb:purgeFiles'),
  },
  planner: {
    getSchedule: () => invoke('planner:getSchedule'),
    setSchedule: (d) => invoke('planner:setSchedule', d),
    listPlans: () => invoke('planner:listPlans'),
    savePlan: (p) => invoke('planner:savePlan', p),
    activatePlan: (id) => invoke('planner:activatePlan', id),
    deletePlan: (id) => invoke('planner:deletePlan', id),
    status: () => invoke('planner:status'),
    pause: (v) => invoke('planner:pause', v),
    preview: (dayOffset) => invoke('planner:preview', dayOffset),
    testFire: () => invoke('planner:testFire'),
    onFired: (cb) => on('planner:fired', cb),
    onEvent: (cb) => on('planner:event', cb),
  },
  reminder: {
    dismiss: () => invoke('reminder:dismiss'),
    openApp: () => invoke('reminder:openApp'),
    snooze: (m) => invoke('reminder:snooze', m),
  },
  system: {
    notify: (payload) => invoke('notify', payload),
    beep: () => invoke('beep'),
    log: (level, message) => invoke('log:write', { level, message }),
    openLogs: () => invoke('log:open'),
  },
  update: {
    check: (opts) => invoke('update:check', opts),
    releases: (limit) => invoke('update:releases', limit),
    mirrors: () => invoke('update:mirrors'),
    skipVersion: (v) => invoke('update:skipVersion', v),
    clearSkip: () => invoke('update:clearSkip'),
    openRelease: (payload) => invoke('update:openRelease', payload),
    onAvailable: (cb) => on('update:available', cb),
  },
  tray: {
    onAction: (cb) => on('tray:action', cb),
  },
})
