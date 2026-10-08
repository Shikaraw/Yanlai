'use strict'
const path = require('node:path')
const fs = require('node:fs')
const { Tray, Menu, nativeImage, app } = require('electron')

let tray = null

function iconPath(name) {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', name),
    path.join(process.resourcesPath || '', 'build', name),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {}
  }
  return null
}

function createTray({ getWindow, onAction, onQuit }) {
  const file = iconPath('tray.png') || iconPath('icon.png')
  if (!file) return null
  const img = nativeImage.createFromPath(file)
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 }))
  tray.setToolTip('研来 Yanlai · 考研学习辅导')
  refreshTray({ getWindow, onAction, onQuit })
  tray.on('click', () => {
    const win = getWindow()
    if (!win) return
    if (win.isVisible() && !win.isMinimized()) {
      win.hide()
    } else {
      win.show()
      win.focus()
    }
  })
  tray.on('double-click', () => {
    const win = getWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })
  return tray
}

function refreshTray({ getWindow, onAction, onQuit }) {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    {
      label: '打开研来主窗口',
      click: () => {
        const win = getWindow()
        if (win) {
          win.show()
          win.focus()
        }
      },
    },
    { type: 'separator' },
    { label: '新对话 (Ctrl+N)', click: () => onAction('new-chat') },
    { label: '对话工作台', click: () => onAction('go-chat') },
    { label: '时间规划', click: () => onAction('go-planner') },
    { label: '错题本', click: () => onAction('go-wrongbook') },
    { label: '知识库', click: () => onAction('go-knowledge') },
    { label: '背诵卡片', click: () => onAction('go-flashcards') },
    { label: '学习统计', click: () => onAction('go-dashboard') },
    { type: 'separator' },
    {
      label: '暂停时间提醒',
      type: 'checkbox',
      checked: !!global.__yanlaiPlannerPaused,
      click: (item) => {
        global.__yanlaiPlannerPaused = item.checked
        refreshTray({ getWindow, onAction, onQuit })
        onAction(item.checked ? 'planner-pause' : 'planner-resume')
      },
    },
    { label: '朗读开关', click: () => onAction('toggle-tts') },
    { type: 'separator' },
    { label: '设置', click: () => onAction('go-settings') },
    { label: '检查更新', click: () => onAction('go-update') },
    { label: '版本信息', click: () => onAction('go-about') },
    { type: 'separator' },
    {
      label: '退出研来',
      click: () => onQuit(),
    },
  ])
  tray.setContextMenu(menu)
}

function destroyTray() {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

module.exports = { createTray, refreshTray, destroyTray, iconPath }
