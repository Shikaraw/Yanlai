'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

let USER_DATA = path.join(os.homedir(), '.yanlai')
function setUserData(dir) {
  USER_DATA = dir
}

const DIRS = ['chats', 'attachments', 'exports', 'kb', 'workspace', 'logs', 'sounds']

function ensureDirs() {
  for (const d of DIRS) {
    try {
      fs.mkdirSync(path.join(USER_DATA, d), { recursive: true })
    } catch {}
  }
}

function dirs() {
  return {
    userData: USER_DATA,
    chats: path.join(USER_DATA, 'chats'),
    attachments: path.join(USER_DATA, 'attachments'),
    exports: path.join(USER_DATA, 'exports'),
    kb: path.join(USER_DATA, 'kb'),
    workspace: path.join(USER_DATA, 'workspace'),
    logs: path.join(USER_DATA, 'logs'),
    sounds: path.join(USER_DATA, 'sounds'),
  }
}

/** Atomic JSON read; returns fallback on any error. */
function readJson(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** Atomic JSON write (tmp + rename) so a crash never truncates the store. */
function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (e) {
    return false
  }
}

/** Append-only JSONL used for knowledge-base chunks (cheap, token-friendly). */
function appendJsonl(file, rows) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const lines = rows.map((r) => JSON.stringify(r)).join('\n')
    fs.appendFileSync(file, lines + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function uniquePath(file) {
  if (!fs.existsSync(file)) return file
  const ext = path.extname(file)
  const base = file.slice(0, file.length - ext.length)
  let i = 1
  while (fs.existsSync(`${base} (${i})${ext}`)) i++
  return `${base} (${i})${ext}`
}

module.exports = { setUserData, ensureDirs, dirs, readJson, writeJson, appendJsonl, readJsonl, uniquePath }
