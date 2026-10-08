'use strict'
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { dirs } = require('./store.cjs')

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

/* ------------------------------------------------------------------ *
 * Windows SAPI bridge. Text is handed over through a UTF-8 temp file  *
 * so no shell escaping is ever needed for arbitrary user content.     *
 * ------------------------------------------------------------------ */
const PS_LIST = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$out = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; gender = "$($_.Gender)"; culture = "$($_.Culture)" }
}
$out | ConvertTo-Json -Compress
`

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($env:YANLAI_TEXT_FILE, [System.Text.Encoding]::UTF8)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:YANLAI_VOICE) { try { $s.SelectVoice($env:YANLAI_VOICE) } catch {} }
try { $s.Rate = [int]$env:YANLAI_RATE } catch {}
try { $s.Volume = [int]$env:YANLAI_VOLUME } catch {}
$s.SetOutputToWaveFile($env:YANLAI_WAV_FILE)
$s.Speak($text)
$s.Dispose()
`

function psPath() {
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
  ]
  for (const c of candidates) {
    try {
      if (c.includes('\\') && fs.existsSync(c)) return c
    } catch {}
  }
  return 'powershell.exe'
}

function toSapiRate(rate) {
  // renderer rate ~0.5..2.0  ->  SAPI -10..10
  const r = Math.max(0.5, Math.min(2, Number(rate) || 1))
  return Math.round((r - 1) * 10)
}

async function listVoices() {
  if (!isWin) return []
  try {
    const res = spawnSync(psPath(), ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    })
    if (res.status !== 0 && !res.stdout) return []
    const raw = (res.stdout || '').trim()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return arr.map((v) => ({ name: v.name, lang: v.culture, gender: v.gender }))
  } catch {
    return []
  }
}

/** Render one text chunk to a wav file, resolving with its path. */
function synthesizeWav(text, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!isWin) return reject(new Error('System TTS is only available on Windows'))
    const id = crypto.randomBytes(6).toString('hex')
    const txtFile = path.join(dirs().sounds, `say-${id}.txt`)
    const wavFile = path.join(dirs().sounds, `say-${id}.wav`)
    try {
      fs.mkdirSync(dirs().sounds, { recursive: true })
      fs.writeFileSync(txtFile, String(text || ''), 'utf8')
    } catch (e) {
      return reject(e)
    }
    const env = {
      ...process.env,
      YANLAI_TEXT_FILE: txtFile,
      YANLAI_WAV_FILE: wavFile,
      YANLAI_VOICE: opts.voice || '',
      YANLAI_RATE: String(toSapiRate(opts.rate)),
      YANLAI_VOLUME: String(Math.round(Math.max(0, Math.min(1, opts.volume ?? 1)) * 100)),
    }
    const child = spawn(psPath(), ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
      env,
      windowsHide: true,
    })
    let err = ''
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', () => {
      try {
        fs.unlinkSync(txtFile)
      } catch {}
      if (fs.existsSync(wavFile)) resolve(wavFile)
      else reject(new Error(err || 'TTS synthesis failed'))
    })
  })
}

function cleanupWav(file) {
  try {
    if (file && file.startsWith(dirs().sounds)) fs.unlinkSync(file)
  } catch {}
}

/**
 * macOS / Linux fallback: fire-and-forget CLI speaking. Returns a handle
 * whose kill() stops playback; renderer treats it as non-cancellable queue.
 */
function speakNative(text, opts = {}) {
  if (isMac) {
    const rate = Math.round((Number(opts.rate) || 1) * 180)
    const voice = opts.voice ? ['-v', opts.voice] : []
    theChild = spawn('say', [...voice, '-r', String(rate), String(text || '')], { windowsHide: true })
    return theChild
  }
  if (isWin) return null
  const child = spawn('spd-say', [String(text || '')], { windowsHide: true })
  return child
}

let theChild = null

module.exports = { listVoices, synthesizeWav, cleanupWav, speakNative, toSapiRate, isWin }
