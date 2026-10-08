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

/** Does the text contain CJK characters (i.e. needs a Chinese-capable voice)? */
function hasCJK(text) {
  return /[\u3400-\u9fff\u3040-\u30ff\uf900-\ufaff]/.test(String(text || ''))
}

/**
 * Choose a voice that can actually pronounce the text.
 *
 * SAPI does not error when a voice cannot read the script — it just produces an
 * EMPTY wav (measured: 46 bytes, header only) and the user hears nothing. The
 * most common trigger is an English-only voice reading Chinese.
 *
 * So: when the text needs CJK and the configured voice is missing or not
 * Chinese, silently substitute an installed Chinese voice. Respect an explicit
 * Chinese voice; never override a voice that already matches the script.
 */
async function pickVoiceForText(text, requestedVoice) {
  const voices = await listVoices()
  if (!voices.length) return { voice: requestedVoice || '', substituted: false, voices }

  const requested = voices.find((v) => v.name === requestedVoice)
  const needCJK = hasCJK(text)
  const isCJKVoice = (v) => /^zh|chinese|中文|huihui|xiaoxiao|yaoyao|kangkang/i.test(`${v.lang || ''} ${v.name || ''}`)

  if (!needCJK) return { voice: requestedVoice || '', substituted: false, voices }
  // an explicitly chosen Chinese voice is exactly what we want
  if (requested && isCJKVoice(requested)) return { voice: requested.name, substituted: false, voices }

  const zh = voices.find(isCJKVoice)
  if (zh) return { voice: zh.name, substituted: !!requestedVoice, voices, fallbackVoice: zh.name }
  // no Chinese voice installed — keep the request, but the caller will notice
  // the empty output and surface a clear message
  return { voice: requestedVoice || '', substituted: false, voices, noCJKVoice: true }
}

/** Render one text chunk to a wav file, resolving with its path. */
async function synthesizeWav(text, opts = {}) {
  if (!isWin) throw new Error('System TTS is only available on Windows')
  const content = String(text || '')
  const picked = await pickVoiceForText(content, opts.voice || '')
  const voice = picked.voice

  const id = crypto.randomBytes(6).toString('hex')
  const txtFile = path.join(dirs().sounds, `say-${id}.txt`)
  const wavFile = path.join(dirs().sounds, `say-${id}.wav`)
  try {
    fs.mkdirSync(dirs().sounds, { recursive: true })
    fs.writeFileSync(txtFile, content, 'utf8')
  } catch (e) {
    throw e
  }

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      YANLAI_TEXT_FILE: txtFile,
      YANLAI_WAV_FILE: wavFile,
      YANLAI_VOICE: voice || '',
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

      if (!fs.existsSync(wavFile)) return reject(new Error(err || '语音合成失败'))

      // A header-only WAV means the voice produced no audio. SAPI reports no
      // error for this, so we must detect it ourselves or the user just gets
      // silence with no explanation.
      let size = 0
      try {
        size = fs.statSync(wavFile).size
      } catch {}
      if (size < 1024) {
        try {
          fs.unlinkSync(wavFile)
        } catch {}
        if (picked.noCJKVoice) {
          return reject(
            new Error(
              '系统未安装中文语音包，无法朗读中文内容。请在 Windows「设置 → 时间和语言 → 语音 → 管理语音」中安装中文语音（如 Microsoft Huihui），或改用自定义 TTS API 引擎。',
            ),
          )
        }
        return reject(
          new Error(
            `所选语音「${voice || '系统默认'}」无法朗读这段文本（合成结果为空）。请在设置 → 朗读中换一个音色。`,
          ),
        )
      }
      resolve(wavFile)
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

module.exports = { listVoices, synthesizeWav, cleanupWav, speakNative, toSapiRate, isWin, hasCJK, pickVoiceForText }
