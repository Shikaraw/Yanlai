'use strict'
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, nativeTheme, clipboard } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

const store = require('./lib/store.cjs')
const settingsLib = require('./lib/settings.cjs')
const docsLib = require('./lib/docs.cjs')
const ttsLib = require('./lib/tts.cjs')
const updater = require('./lib/updater.cjs')
const { CalculatorManager, resolveConfig, failure: calculatorFailure } = require('./lib/calculator.cjs')
const calculator = new CalculatorManager(resolveConfig({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }))
app.on('before-quit', () => calculator.dispose())
const { createTray, refreshTray, destroyTray, iconPath } = require('./lib/tray.cjs')
const { Planner } = require('./lib/planner.cjs')

// Dev mode must be opted into explicitly (npm run dev sets NODE_ENV=development).
// Relying on `!app.isPackaged` alone would make `npx electron .` try to reach a
// dev server that is not running, instead of loading the built bundle.
const isDev = process.env.NODE_ENV === 'development'
const DEV_URL = 'http://127.0.0.1:5273'

let mainWindow = null
let reminderWindow = null
let planner = null
let quitting = false
let trayActions = null
// true while the first-close dialog is on screen, so a second close event does
// not stack another dialog
let closePromptOpen = false

/* ---------------- CLI: bulk knowledge-base import ----------------
 * `yanlai --import-kb <dir> [--subject 数学] [--import-kb-exit]`
 * lets a large folder be ingested without clicking through the UI, and makes
 * seeding a fresh install scriptable.
 * ---------------------------------------------------------------- */
function parseCliImport() {
  const argv = process.argv.slice(1)
  const out = { dir: '', subject: '', exit: argv.includes('--import-kb-exit'), replace: argv.includes('--import-kb-replace') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--import-kb') out.dir = argv[i + 1] || ''
    else if (a.startsWith('--import-kb=')) out.dir = a.slice('--import-kb='.length)
    else if (a === '--subject') out.subject = argv[i + 1] || ''
    else if (a.startsWith('--subject=')) out.subject = a.slice('--subject='.length)
  }
  if (out.dir && !path.isAbsolute(out.dir)) out.dir = path.resolve(process.cwd(), out.dir)
  return out.dir ? out : null
}
const cliImport = parseCliImport()
let cliImportPending = cliImport

const inspectionProfile = process.env.YANLAI_INSPECTION_PROFILE
if (inspectionProfile) {
  if (!path.isAbsolute(inspectionProfile)) throw new Error('YANLAI_INSPECTION_PROFILE must be an absolute path')
  app.setPath('userData', inspectionProfile)
}

/* ---------------- single instance (防多开) ---------------- */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (!mainWindow.isVisible()) mainWindow.show()
      mainWindow.focus()
    }
  })
}

store.setUserData(path.join(app.getPath('userData')))
store.ensureDirs()

/* ---------------- helpers ---------------- */
function buildDir() {
  const cands = [path.join(__dirname, '..', 'build'), path.join(process.resourcesPath || '', 'build')]
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c
    } catch {}
  }
  return null
}

function appIcon() {
  const dir = buildDir()
  if (!dir) return undefined
  for (const n of ['icon.png', 'icon.ico']) {
    const p = path.join(dir, n)
    if (fs.existsSync(p)) return p
  }
  return undefined
}

function loadRenderer(win, hash) {
  if (isDev) {
    win.loadURL(`${DEV_URL}${hash ? `/#${hash}` : ''}`)
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), hash ? { hash } : undefined)
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

let focusSequence = 0
function mainFocusState() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  return { focused: !!win && win.isFocused(), visible: !!win && win.isVisible(), minimized: !!win && win.isMinimized(), at: Date.now(), sequence: focusSequence }
}
function emitMainFocus() {
  focusSequence++
  send('window:focusState', mainFocusState())
}

function applyLoginItem(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true, args: ['--hidden'] })
  } catch {}
}

/** Hide to the tray, keeping the process (and the reminder scheduler) alive. */
function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.hide()
  if (!global.__yanlaiTrayHintShown) {
    global.__yanlaiTrayHintShown = true
    try {
      new Notification({ title: '研来仍在后台运行', body: '已最小化到系统托盘，点击托盘图标可重新打开。' }).show()
    } catch {}
  }
}

/* ---------------- main window ---------------- */
function createMainWindow() {
  const s = settingsLib.loadSettings()
  const icon = appIcon()
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    backgroundColor: s.appearance.theme === 'light' ? '#f4f6fb' : '#0a0e17',
    title: '研来 · Yanlai',
    icon,
    autoHideMenuBar: true,
    // The app draws its own titlebar (with the plan readout and tool buttons),
    // so the native frame is removed to avoid two stacked bars. macOS keeps its
    // inset traffic lights; Windows/Linux use the custom controls.
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webSecurity: true,
    },
  })

  // Only this BrowserWindow is observed; reminder/export windows never publish.
  for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) mainWindow.on(event, emitMainFocus)
  mainWindow.webContents.on('did-finish-load', emitMainFocus)

  loadRenderer(mainWindow)

  mainWindow.once('ready-to-show', () => {
    const hidden = process.argv.includes('--hidden') || s.ui.startMinimized
    if (!hidden) mainWindow.show()
  })

  mainWindow.on('close', (e) => {
    if (quitting) return
    const st = settingsLib.loadSettings()
    // closeAction is the source of truth. When it is unset (existing installs
    // that predate this setting) default to asking, so the behaviour is
    // explained once instead of silently quitting or hiding.
    const action = st.ui.closeAction || 'ask'

    if (action === 'tray') {
      e.preventDefault()
      hideToTray()
      return
    }
    if (action === 'quit') {
      doQuit()
      return
    }

    // action === 'ask': resolve asynchronously. The button index and the
    // checkbox state are only both available from the async variant, and the
    // window must be kept alive until the user answers.
    e.preventDefault()
    if (closePromptOpen) return
    closePromptOpen = true
    dialog
      .showMessageBox(mainWindow, {
        type: 'question',
        title: '关闭研来',
        message: '要退出研来，还是最小化到系统托盘？',
        detail: '最小化到托盘后研来仍在后台运行，时间提醒会照常弹出。选择「退出研来」才会完全结束程序。',
        buttons: ['最小化到托盘', '退出研来', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        checkboxLabel: '记住我的选择，下次不再询问',
        checkboxChecked: false,
      })
      .then(({ response, checkboxChecked }) => {
        closePromptOpen = false
        if (response === 2) return // 取消：窗口保持打开
        const target = response === 1 ? 'quit' : 'tray'
        // keep minimizeToTray in sync: window-all-closed still consults it
        if (checkboxChecked) settingsLib.saveSettings({ ui: { closeAction: target, minimizeToTray: target !== 'quit' } })
        send('settings:changed', settingsLib.loadSettings())
        if (target === 'quit') doQuit()
        else hideToTray()
      })
      .catch(() => {
        closePromptOpen = false
      })
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // keep the custom titlebar's maximize/restore glyph in sync
  const emitMaximize = () => send('window:maximizeChange', !!mainWindow && mainWindow.isMaximized())
  mainWindow.on('maximize', emitMaximize)
  mainWindow.on('unmaximize', emitMaximize)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    send('app:ready', { version: app.getVersion(), platform: process.platform, isDev })
  })
}

/* ---------------- reminder popup ---------------- */
function showReminderWindow(payload) {
  const s = settingsLib.loadSettings()
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.close()
    reminderWindow = null
  }
  const width = 420
  const height = 260
  const { screen } = require('electron')
  const display = screen.getPrimaryDisplay()
  const wa = display.workArea
  const x = wa.x + wa.width - width - 28
  const y = wa.y + wa.height - height - 28
  reminderWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: s.appearance.theme === 'light' ? '#ffffff' : '#0d1420',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  reminderWindow.setAlwaysOnTop(true, 'screen-saver')
  const hash = `reminder?data=${encodeURIComponent(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'))}`
  loadRenderer(reminderWindow, hash)
  reminderWindow.on('closed', () => {
    reminderWindow = null
  })
  if (s.planner.notifySound !== false) playChime()
  send('planner:fired', payload)
}

/** Short attention chime synthesized on the fly — no asset dependency. */
function playChime() {
  try {
    const s = settingsLib.loadSettings()
    if (s.appearance.reduceMotion) return
    const { exec } = require('node:child_process')
    if (process.platform === 'win32') {
      exec(
        `powershell -NoProfile -NonInteractive -Command "[console]::beep(880,120);[console]::beep(1174,150)"`,
        { windowsHide: true },
      )
    } else if (process.platform === 'darwin') {
      exec(`afplay /System/Library/Sounds/Glass.aiff`)
    } else {
      exec(`paplay /usr/share/sounds/freedesktop/stereo/complete.oga`)
    }
  } catch {}
}

/* ---------------- tray actions ---------------- */
function handleTrayAction(action) {
  switch (action) {
    case 'new-chat':
    case 'go-chat':
    case 'go-planner':
    case 'go-wrongbook':
    case 'go-knowledge':
    case 'go-flashcards':
    case 'go-dashboard':
    case 'go-settings':
    case 'go-about':
    case 'go-update':
    case 'planner-pause':
    case 'planner-resume':
    case 'toggle-tts':
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      }
      send('tray:action', action)
      break
    default:
      break
  }
}

/* ---------------- IPC: calculator (main renderer only) ---------------- */
const calculatorAllowed = event => !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
ipcMain.handle('calculator:status', () => calculator.status())
ipcMain.handle('calculator:ready', async event => {
  if (!calculatorAllowed(event)) return { ready: false, state: 'stopped', error: 'Calculator access denied' }
  try { return await calculator.ensureReady() }
  catch (e) { return { ...calculator.status(), error: e.message } }
})
ipcMain.handle('calculator:calculate', (event, payload) => calculatorAllowed(event)
  ? calculator.calculate(payload) : calculatorFailure(payload?.id || null, 'DENIED', 'Calculator access denied'))
ipcMain.handle('calculator:cancel', (event, id) => calculatorAllowed(event) && calculator.cancel(id))
ipcMain.handle('calculator:restart', async event => {
  if (!calculatorAllowed(event)) return { ready: false, state: 'stopped', error: 'Calculator access denied' }
  try { return await calculator.restart() }
  catch (e) { return { ...calculator.status(), error: e.message } }
})

/* ---------------- IPC: app / window ---------------- */
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  name: '研来',
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  userData: store.dirs().userData,
  isDev,
}))

ipcMain.handle('app:setLoginItem', (_e, enabled) => {
  applyLoginItem(enabled)
  return true
})

ipcMain.handle('window:getFocusState', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return null
  return mainFocusState()
})
ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize())
ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
  return mainWindow.isMaximized()
})
ipcMain.handle('window:close', () => mainWindow && mainWindow.close())
ipcMain.handle('window:hide', () => mainWindow && mainWindow.hide())
ipcMain.handle('window:setAlwaysOnTop', (_e, v) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(!!v)
  return !!v
})
ipcMain.handle('window:isMaximized', () => !!mainWindow && mainWindow.isMaximized())

ipcMain.handle('reminder:dismiss', () => {
  if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.close()
  return true
})
ipcMain.handle('reminder:openApp', () => {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  }
  if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.close()
  return true
})
ipcMain.handle('reminder:snooze', (_e, minutes) => {
  if (planner) planner.snooze(Number(minutes) || 5)
  if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.close()
  return true
})

/* ---------------- IPC: settings ---------------- */
ipcMain.handle('settings:get', () => settingsLib.loadSettings())
ipcMain.handle('settings:set', (_e, patch) => {
  const next = settingsLib.saveSettings(patch)
  if (patch?.ui?.autoLaunch !== undefined) applyLoginItem(patch.ui.autoLaunch)
  if (patch?.appearance?.theme) {
    nativeTheme.themeSource = next.appearance.theme === 'light' ? 'light' : 'dark'
  }
  return next
})
ipcMain.handle('settings:reset', () => {
  const def = structuredClone(settingsLib.DEFAULT_SETTINGS)
  store.writeJson(settingsLib.settingsPath(), def)
  return def
})

/* ---------------- IPC: dialogs ---------------- */
ipcMain.handle('dialog:openFiles', async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: opts.title || '选择文件',
    properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])],
    filters: opts.filters || [
      { name: '常见资料', extensions: ['txt', 'md', 'pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv', 'json', 'png', 'jpg', 'jpeg', 'webp', 'bmp'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  })
  if (res.canceled) return []
  return res.filePaths
})

ipcMain.handle('dialog:openFolder', async (_e, opts = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: opts.title || '选择文件夹',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: opts.defaultPath || undefined,
  })
  if (res.canceled) return null
  return res.filePaths[0]
})

ipcMain.handle('dialog:saveFile', async (_e, opts = {}) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: opts.title || '保存文件',
    defaultPath: opts.defaultPath,
    filters: opts.filters,
  })
  if (res.canceled) return null
  return res.filePath
})

ipcMain.handle('dialog:message', async (_e, opts = {}) => {
  const res = await dialog.showMessageBox(mainWindow, {
    type: opts.type || 'info',
    title: opts.title || '研来',
    message: opts.message || '',
    detail: opts.detail,
    buttons: opts.buttons || ['确定'],
    defaultId: 0,
    cancelId: opts.buttons ? opts.buttons.length - 1 : 0,
  })
  return res.response
})

/* ---------------- IPC: filesystem ---------------- */
ipcMain.handle('fs:readText', (_e, file) => {
  try {
    const buf = fs.readFileSync(file)
    // strip UTF-8 BOM, tolerate GBK-ish by fallback
    let text = buf.toString('utf8')
    if (text.includes('\uFFFD')) {
      try {
        text = new TextDecoder('gbk').decode(buf)
      } catch {}
    }
    return text.replace(/^\uFEFF/, '')
  } catch (e) {
    return ''
  }
})

ipcMain.handle('fs:readBase64', (_e, file) => {
  try {
    const buf = fs.readFileSync(file)
    return { data: buf.toString('base64'), size: buf.length }
  } catch {
    return null
  }
})

ipcMain.handle('fs:writeText', (_e, { file, text }) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(text ?? ''), 'utf8')
    return { ok: true, file }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

ipcMain.handle('fs:writeBase64', (_e, { file, base64 }) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(base64, 'base64'))
    return { ok: true, file }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

ipcMain.handle('fs:exists', (_e, file) => {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
})

ipcMain.handle('fs:stat', (_e, file) => {
  try {
    const st = fs.statSync(file)
    return { isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }
  } catch {
    return null
  }
})

ipcMain.handle('fs:delete', async (_e, file) => {
  try {
    const st = fs.statSync(file)
    if (st.isDirectory()) fs.rmSync(file, { recursive: true, force: true })
    else fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('fs:rename', (_e, { from, to }) => {
  try {
    fs.renameSync(from, to)
    return { ok: true, file: to }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

ipcMain.handle('fs:listDir', (_e, dir) => {
  try {
    const rows = fs
      .readdirSync(dir, { withFileTypes: true })
      .map((d) => {
        let size = 0
        let mtime = 0
        try {
          const st = fs.statSync(path.join(dir, d.name))
          size = st.size
          mtime = st.mtimeMs
        } catch {}
        return { name: d.name, path: path.join(dir, d.name), isDir: d.isDirectory(), size, mtime }
      })
      .filter((r) => !r.name.startsWith('.') && r.name !== 'node_modules')
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    return rows
  } catch {
    return []
  }
})

ipcMain.handle('fs:mkdir', (_e, dir) => {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return { ok: true, file: dir }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

ipcMain.handle('fs:reveal', (_e, file) => {
  shell.showItemInFolder(file)
  return true
})

ipcMain.handle('shell:openPath', async (_e, file) => {
  const err = await shell.openPath(file)
  return { ok: !err, error: err || undefined }
})

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https?:/i.test(url)) shell.openExternal(url)
  return true
})

ipcMain.handle('clipboard:readText', () => clipboard.readText())
ipcMain.handle('clipboard:writeText', (_e, t) => {
  clipboard.writeText(String(t ?? ''))
  return true
})

ipcMain.handle('path:info', () => ({
  home: os.homedir(),
  desktop: app.getPath('desktop'),
  documents: app.getPath('documents'),
  downloads: app.getPath('downloads'),
  pictures: app.getPath('pictures'),
  temp: os.tmpdir(),
  userData: store.dirs().userData,
  defaultWorkspace: store.dirs().workspace,
  defaultExports: store.dirs().exports,
  sep: path.sep,
}))

ipcMain.handle('path:toFileUrl', (_e, file) => pathToFileURL(file).href)

/* ---------------- IPC: attachments ---------------- */
ipcMain.handle('attach:save', (_e, { name, base64 }) => {
  try {
    const safe = String(name || 'attachment').replace(/[\\/:*?"<>|]/g, '_')
    const ext = path.extname(safe)
    const stem = path.basename(safe, ext)
    const file = path.join(store.dirs().attachments, `${stem}-${crypto.randomBytes(3).toString('hex')}${ext}`)
    fs.writeFileSync(file, Buffer.from(base64, 'base64'))
    return { ok: true, file }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
})

ipcMain.handle('attach:prune', () => {
  // keep attachments dir bounded: drop files older than 30 days not referenced
  try {
    const dir = store.dirs().attachments
    const now = Date.now()
    let removed = 0
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      try {
        const st = fs.statSync(p)
        if (now - st.mtimeMs > 30 * 864e5) {
          fs.unlinkSync(p)
          removed++
        }
      } catch {}
    }
    return removed
  } catch {
    return 0
  }
})

/* ---------------- IPC: documents / export ---------------- */
ipcMain.handle('doc:export', async (_e, { format, title, markdown, html, outPath }) => {
  try {
    let target = outPath
    if (!target) {
      const base = (title || '研来文档').replace(/[\\/:*?"<>|]/g, '_')
      target = path.join(store.dirs().exports, `${base}.${format}`)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (format === 'docx') {
      const buf = await docsLib.markdownToDocxBuffer({ title, markdown })
      fs.writeFileSync(target, buf)
    } else if (format === 'pdf') {
      await docsLib.exportPdf({ title, markdown, html, outPath: target })
    } else if (format === 'md' || format === 'markdown') {
      fs.writeFileSync(target, String(markdown ?? ''), 'utf8')
    } else if (format === 'html') {
      fs.writeFileSync(target, docsLib.buildPrintHtml({ title, markdown, html }), 'utf8')
    } else if (format === 'txt') {
      fs.writeFileSync(target, String(markdown ?? ''), 'utf8')
    } else {
      return { ok: false, error: `不支持的格式: ${format}` }
    }
    return { ok: true, file: target }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
})

/* ---------------- IPC: TTS ---------------- */
ipcMain.handle('tts:voices', async () => ttsLib.listVoices())

ipcMain.handle('tts:synth', async (_e, { text, voice, rate, volume }) => {
  try {
    const file = await ttsLib.synthesizeWav(text, { voice, rate, volume })
    const buf = fs.readFileSync(file)
    ttsLib.cleanupWav(file)
    return { ok: true, base64: buf.toString('base64'), mime: 'audio/wav' }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
})

/* ---------------- IPC: knowledge base ---------------- */
ipcMain.handle('kb:list', () => store.readJson(path.join(store.dirs().kb, 'index.json'), { docs: [] }))
ipcMain.handle('kb:saveIndex', (_e, data) => {
  store.writeJson(path.join(store.dirs().kb, 'index.json'), data)
  return true
})
ipcMain.handle('kb:saveChunks', (_e, { docId, chunks }) => {
  store.writeJson(path.join(store.dirs().kb, `${docId}.json`), { docId, chunks })
  return true
})
ipcMain.handle('kb:loadChunks', (_e, docId) => store.readJson(path.join(store.dirs().kb, `${docId}.json`), { docId, chunks: [] }))
ipcMain.handle('kb:delete', (_e, docId) => {
  try {
    fs.unlinkSync(path.join(store.dirs().kb, `${docId}.json`))
  } catch {}
  return true
})
ipcMain.handle('kb:copySource', async (_e, { src, docId }) => {
  try {
    const dest = path.join(store.dirs().kb, `src-${docId}${path.extname(src)}`)
    fs.copyFileSync(src, dest)
    return dest
  } catch {
    return null
  }
})
ipcMain.handle('kb:purgeFiles', () => {
  // Removes every stored chunk file and source copy. The caller is responsible
  // for having already cleared the matching IndexedDB records (`clearKb`).
  try {
    const kbDir = store.dirs().kb
    for (const n of fs.readdirSync(kbDir)) {
      try { fs.unlinkSync(path.join(kbDir, n)) } catch {}
    }
    return true
  } catch {
    return false
  }
})
ipcMain.handle('kb:cliImportTake', () => {
  // pulled by the renderer once it has booted; `did-finish-load` fires long
  // before React subscribes, so a push would be dropped
  const p = cliImportPending
  cliImportPending = null
  return p
})
ipcMain.handle('kb:cliImportDone', () => {
  if (cliImport && cliImport.exit) doQuit()
  return true
})

/* ---------------- IPC: notifications ---------------- */
ipcMain.handle('notify', (_e, { title, body, silent }) => {
  try {
    if (Notification.isSupported()) {
      new Notification({ title: title || '研来', body: body || '', silent: !!silent, icon: appIcon() }).show()
      return true
    }
  } catch {}
  return false
})

ipcMain.handle('beep', () => {
  playChime()
  return true
})

/* ---------------- IPC: logs ---------------- */
ipcMain.handle('log:write', (_e, { level, message }) => {
  try {
    const line = `${new Date().toISOString()}\t${level}\t${String(message).slice(0, 4000)}\n`
    fs.appendFileSync(path.join(store.dirs().logs, 'yanlai.log'), line, 'utf8')
    return true
  } catch {
    return false
  }
})
ipcMain.handle('log:open', () => shell.openPath(store.dirs().logs))

/* ---------------- menu ---------------- */
function buildAppMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建对话', accelerator: 'CmdOrCtrl+N', click: () => handleTrayAction('new-chat') },
        { label: '设置工作区…', click: () => handleTrayAction('go-settings') },
        { type: 'separator' },
        { label: '退出', accelerator: isMac ? 'Cmd+Q' : 'Alt+F4', click: () => doQuit() },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '学习',
      submenu: [
        { label: '对话工作台', click: () => handleTrayAction('go-chat') },
        { label: '时间规划', accelerator: 'CmdOrCtrl+P', click: () => handleTrayAction('go-planner') },
        { label: '错题本', accelerator: 'CmdOrCtrl+B', click: () => handleTrayAction('go-wrongbook') },
        { label: '知识库', accelerator: 'CmdOrCtrl+K', click: () => handleTrayAction('go-knowledge') },
        { label: '背诵卡片', click: () => handleTrayAction('go-flashcards') },
        { label: '学习统计', click: () => handleTrayAction('go-dashboard') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新', click: () => handleTrayAction('go-update') },
        { label: '版本信息', click: () => handleTrayAction('go-about') },
        { label: '打开日志目录', click: () => shell.openPath(store.dirs().logs) },
        { label: '打开数据目录', click: () => shell.openPath(store.dirs().userData) },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

/* ---------------- update check on startup ---------------- */
/**
 * Runs a few seconds after launch so it never competes with first paint, and
 * only surfaces a result when there is genuinely something newer. A skipped
 * version is remembered, so the user is asked once per release, not every boot.
 */
function scheduleStartupUpdateCheck() {
  const settings = settingsLib.loadSettings()
  if (settings?.update?.enabled === false || settings?.update?.autoCheck === false) return
  const delay = 6000
  setTimeout(async () => {
    try {
      const res = await updater.checkForUpdate(settingsLib.loadSettings(), app.getVersion())
      settingsLib.saveSettings({
        update: {
          lastCheckedAt: Date.now(),
          lastResult: { ok: res.ok, latestVersion: res.latestVersion || '', hasUpdate: !!res.hasUpdate, source: res.source || '', reason: res.reason || '', message: res.message || '' },
        },
      })
      if (res.ok && res.hasUpdate) {
        const skipped = settingsLib.loadSettings()?.update?.skippedVersion
        if (skipped === res.latestVersion) return
        send('update:available', res)
      }
    } catch (e) {
      // an unreachable GitHub must never disturb startup
    }
  }, delay)
}

/* ---------------- quit ---------------- */
function doQuit() {
  quitting = true
  if (planner) planner.stop()
  destroyTray()
  app.quit()
}

/* ---------------- boot ---------------- */
if (gotLock) {
  app.whenReady().then(() => {
    const s = settingsLib.loadSettings()
    nativeTheme.themeSource = s.appearance.theme === 'light' ? 'light' : 'dark'
    applyLoginItem(s.ui.autoLaunch)

    createMainWindow()
    Menu.setApplicationMenu(buildAppMenu())

    trayActions = { getWindow: () => mainWindow, onAction: handleTrayAction, onQuit: doQuit }
    createTray(trayActions)

    planner = new Planner({
      getSchedule: () => store.readJson(path.join(store.dirs().userData, 'planner.json'), null),
      getSettings: () => settingsLib.loadSettings(),
      onFire: (payload) => {
        const st = settingsLib.loadSettings()
        if (st.planner.popup !== false) showReminderWindow(payload)
        if (st.planner.notify !== false && Notification.isSupported()) {
          try {
            new Notification({ title: payload.title || '时间提醒', body: payload.body || '', icon: appIcon() }).show()
          } catch {}
        }
        send('planner:event', payload)
      },
    })
    planner.start()
    global.__yanlaiPlanner = planner

    scheduleStartupUpdateCheck()

    app.on('activate', () => {
      if (!mainWindow) createMainWindow()
      else mainWindow.show()
    })
  })

  app.on('window-all-closed', () => {
    // tray-resident app: keep running unless the user explicitly quit
    const s = settingsLib.loadSettings()
    if (process.platform !== 'darwin' && !s.ui.minimizeToTray) doQuit()
  })

  app.on('before-quit', () => {
    quitting = true
    if (planner) planner.stop()
  })
}

/* ---------------- IPC: update check ---------------- */
ipcMain.handle('update:check', async (_e, opts = {}) => {
  const settings = settingsLib.loadSettings()
  const current = app.getVersion()
  const result = await updater.checkForUpdate(settings, current, opts)
  // remember the outcome so the settings screen can show "last checked"
  settingsLib.saveSettings({
    update: { lastCheckedAt: Date.now(), lastResult: { ok: result.ok, latestVersion: result.latestVersion || '', hasUpdate: !!result.hasUpdate, source: result.source || '', reason: result.reason || '', message: result.message || '' } },
  })
  return { ...result, currentVersion: current }
})

ipcMain.handle('update:releases', async (_e, limit) => updater.listReleases(settingsLib.loadSettings(), Number(limit) || 10))

ipcMain.handle('update:mirrors', () => updater.MIRROR_PRESETS)

ipcMain.handle('update:skipVersion', (_e, version) => {
  settingsLib.saveSettings({ update: { skippedVersion: String(version || '') } })
  return true
})

ipcMain.handle('update:clearSkip', () => {
  settingsLib.saveSettings({ update: { skippedVersion: '' } })
  return true
})

/** Open the release page (or a specific asset) in the browser via a mirror. */
ipcMain.handle('update:openRelease', async (_e, { url, useMirror }) => {
  const settings = settingsLib.loadSettings()
  let target = String(url || '')
  if (useMirror && target) {
    const mirrors = updater.resolveMirrors(settings)
    if (mirrors[0]?.prefix && /^https:\/\/github\.com\//i.test(target)) {
      target = `${mirrors[0].prefix}${target}`
    }
  }
  if (/^https?:/i.test(target)) shell.openExternal(target)
  return target
})

/* ---------------- IPC: planner status / schedule ---------------- */
function plannerLibraryPath() { return path.join(store.dirs().userData, 'planner-plans.json') }
function plannerSchedulePath() { return path.join(store.dirs().userData, 'planner.json') }
function planId() { return `plan_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}` }
function persistPlanLibrary(lib, schedule) {
  const previous = store.readJson(plannerLibraryPath(), null)
  if (!store.writeJson(plannerLibraryPath(), lib)) return { ok: false, error: '计划库文件写入失败' }
  if (schedule !== undefined && !store.writeJson(plannerSchedulePath(), schedule)) {
    let restored = false
    try {
      restored = previous !== null ? store.writeJson(plannerLibraryPath(), previous) : (fs.unlinkSync(plannerLibraryPath()), true)
    } catch {}
    return { ok: false, error: `计划文件写入失败${restored ? '' : '；计划库回滚失败，请重新选择当前计划'}` }
  }
  if (schedule !== undefined && planner) planner.reload()
  return { ok: true }
}
function loadPlanLibrary() {
  const current = store.readJson(plannerSchedulePath(), null)
  const saved = store.readJson(plannerLibraryPath(), null)
  if (saved && Array.isArray(saved.plans)) {
    const lib = { ...saved, version: 1, plans: saved.plans.map((p) => ({ ...p, schedule: { ...p.schedule, planId: p.id } })) }
    if (!lib.plans.some((p) => p.id === lib.activeId)) lib.activeId = ''
    // Older libraries had no schedule identity. Preserve any edits in planner.json.
    const active = lib.plans.find((p) => p.id === lib.activeId)
    if (active && current && !current.planId) {
      active.schedule = { ...current, name: active.name, planId: active.id }
      const result = persistPlanLibrary(lib, active.schedule)
      if (!result.ok) throw new Error(result.error)
    }
    return lib
  }
  if (current) {
    const id = current.planId || planId()
    const schedule = { ...current, planId: id }
    const migrated = { version: 1, activeId: id, plans: [{ id, name: current.name || '默认计划', createdAt: current.updatedAt || Date.now(), updatedAt: current.updatedAt || Date.now(), schedule }] }
    const result = persistPlanLibrary(migrated, schedule)
    if (!result.ok) throw new Error(result.error)
    return migrated
  }
  return { version: 1, activeId: '', plans: [] }
}
function plannerOperation(fn) {
  try { return fn() } catch (e) { return { ok: false, error: e?.message || '计划操作失败' } }
}
function validPlanSchedule(schedule) { return schedule && typeof schedule === 'object' && !Array.isArray(schedule) }
ipcMain.handle('planner:listPlans', () => loadPlanLibrary())
ipcMain.handle('planner:savePlan', (_e, data = {}) => plannerOperation(() => {
  const { id, name, schedule } = data
  if (!validPlanSchedule(schedule)) return { ok: false, error: '计划内容无效' }
  const lib = loadPlanLibrary(); const now = Date.now()
  const idx = lib.plans.findIndex((p) => p.id === id)
  if (id && idx < 0) return { ok: false, error: '计划不存在' }
  const newId = idx >= 0 ? id : planId()
  const planName = String(name || schedule.name || '未命名计划').trim() || '未命名计划'
  const plan = { id: newId, name: planName, createdAt: idx >= 0 ? lib.plans[idx].createdAt : now, updatedAt: now, schedule: { ...schedule, planId: newId, name: planName, updatedAt: now } }
  if (idx >= 0) lib.plans[idx] = plan; else lib.plans.push(plan)
  // New plans are drafts until explicitly activated, including the first AI plan.
  const activeSchedule = lib.activeId === plan.id ? plan.schedule : undefined
  const result = persistPlanLibrary(lib, activeSchedule)
  if (!result.ok) return result
  return { ok: true, plan, library: lib }
}))
ipcMain.handle('planner:activatePlan', (_e, id) => plannerOperation(() => {
  const lib = loadPlanLibrary(); const p = lib.plans.find((x) => x.id === id)
  if (!p) return { ok: false, error: '计划不存在' }
  lib.activeId = id
  const result = persistPlanLibrary(lib, p.schedule)
  if (!result.ok) return result
  return { ok: true, library: lib, schedule: p.schedule }
}))
ipcMain.handle('planner:deletePlan', (_e, id) => plannerOperation(() => {
  const lib = loadPlanLibrary()
  if (!lib.plans.some((p) => p.id === id)) return { ok: false, error: '计划不存在' }
  if (lib.plans.length <= 1) return { ok: false, error: '至少保留一个计划' }
  const deletingActive = lib.activeId === id
  lib.plans = lib.plans.filter((p) => p.id !== id)
  if (deletingActive) lib.activeId = lib.plans[0].id
  const schedule = deletingActive ? lib.plans[0].schedule : undefined
  const result = persistPlanLibrary(lib, schedule)
  if (!result.ok) return result
  return { ok: true, library: lib, ...(schedule ? { schedule } : {}) }
}))
ipcMain.handle('planner:getSchedule', () => { loadPlanLibrary(); return store.readJson(plannerSchedulePath(), null) })
ipcMain.handle('planner:setSchedule', (_e, data) => plannerOperation(() => {
  if (!validPlanSchedule(data)) return { ok: false, error: '计划内容无效' }
  const lib = loadPlanLibrary()
  const active = lib.plans.find((p) => p.id === lib.activeId)
  // A stale editor must not overwrite a plan activated in another view.
  if (data.planId && data.planId !== lib.activeId) return { ok: false, error: '当前计划已切换，请重新加载后保存' }
  const now = Date.now(); const id = active ? active.id : planId()
  const name = String(data.name || active?.name || '未命名计划').trim() || '未命名计划'
  const payload = { ...data, planId: id, name, updatedAt: now }
  if (active) Object.assign(active, { name, schedule: payload, updatedAt: now })
  else {
    lib.activeId = id
    lib.plans.push({ id, name, createdAt: now, updatedAt: now, schedule: payload })
  }
  const result = persistPlanLibrary(lib, payload)
  if (!result.ok) return result
  return { ok: true, schedule: payload, library: lib }
}))
ipcMain.handle('planner:status', () => (planner ? planner.status() : null))
ipcMain.handle('planner:pause', (_e, paused) => {
  if (planner) planner.setPaused(!!paused)
  global.__yanlaiPlannerPaused = !!paused
  if (trayActions) refreshTray(trayActions)
  return !!paused
})
ipcMain.handle('planner:preview', (_e, dayOffset) => (planner ? planner.preview(Number(dayOffset) || 0) : null))
ipcMain.handle('planner:testFire', () => {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  showReminderWindow({
    kind: 'test',
    title: '研来提醒测试',
    body: '这是一条测试提醒，说明弹窗与通知工作正常。',
    start: `${hh}:${mm}`,
    next: null,
  })
  return true
})

module.exports = {}
