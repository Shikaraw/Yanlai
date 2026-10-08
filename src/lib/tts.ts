/**
 * Speech engine.
 *
 * Three interchangeable backends behind one queue:
 *   system  — Windows SAPI synthesis (offline, free, no key). Synthesised to a
 *             wav and played through an <audio> element so it is cancellable.
 *   api     — any OpenAI-compatible /audio/speech endpoint (better voices).
 *   browser — Web Speech API, the only option in the browser preview build.
 *
 * A queue (rather than "synthesise the whole answer then play") is what makes
 * "read while streaming" work: sentences are enqueued as they are produced and
 * playback starts after the first one.
 */

import { bridge } from './bridge'
import { speakable } from './util'

export type TtsEngine = 'off' | 'system' | 'api' | 'browser'
export type AutoReadMode = 'off' | 'stream' | 'after'

export interface TtsConfig {
  engine: TtsEngine
  autoRead: AutoReadMode
  voice: string
  rate: number
  pitch: number
  volume: number
  api: { baseUrl: string; apiKey: string; model: string; voice: string; format: string }
}

interface QueueItem {
  id: string
  text: string
  /** final segment of this utterance batch */
  last?: boolean
}

type Listener = (state: TtsState) => void

export interface TtsState {
  speaking: boolean
  paused: boolean
  current: string
  queueLength: number
  error?: string
}

class SpeechEngine {
  private queue: QueueItem[] = []
  private playing = false
  private audio: HTMLAudioElement | null = null
  private abort: AbortController | null = null
  private listeners = new Set<Listener>()
  private state: TtsState = { speaking: false, paused: false, current: '', queueLength: 0 }
  private cfg: TtsConfig | null = null
  /** cache synthesised wav per text so replaying an answer costs nothing */
  private cache = new Map<string, string>()
  private cacheKeys: string[] = []

  subscribe(fn: Listener) {
    this.listeners.add(fn)
    fn(this.state)
    return () => this.listeners.delete(fn)
  }

  private emit(patch: Partial<TtsState>) {
    this.state = { ...this.state, ...patch, queueLength: this.queue.length }
    for (const l of this.listeners) l(this.state)
  }

  configure(cfg: TtsConfig) {
    if (this.cfg && this.cfg.engine !== cfg.engine) this.stop()
    this.cfg = cfg
  }

  get enabled() {
    return !!this.cfg && this.cfg.engine !== 'off'
  }

  /** Strip markdown and enqueue for playback. */
  enqueue(markdown: string, opts: { interrupt?: boolean; last?: boolean } = {}) {
    if (!this.enabled) return
    const text = speakable(markdown).slice(0, 6000)
    if (!text || text.length < 2) return
    if (opts.interrupt) this.stop()
    this.queue.push({ id: `s${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, text, last: opts.last })
    this.emit({ speaking: true })
    if (!this.playing) void this.pump()
  }

  private async pump() {
    if (this.playing) return
    this.playing = true
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!
        this.emit({ current: item.text.slice(0, 90), speaking: true })
        try {
          await this.speakOne(item.text)
        } catch (e: any) {
          this.emit({ error: String(e?.message || e) })
          // a failed segment should not wedge the queue
        }
      }
    } finally {
      this.playing = false
      this.emit({ speaking: false, current: '', paused: false })
    }
  }

  private async speakOne(text: string) {
    const cfg = this.cfg!
    if (cfg.engine === 'browser') return this.speakBrowser(text, cfg)
    if (cfg.engine === 'api') return this.speakApi(text, cfg)
    if (cfg.engine === 'system') return this.speakSystem(text, cfg)
  }

  /* ---------------- browser ---------------- */
  private speakBrowser(text: string, cfg: TtsConfig) {
    return new Promise<void>((resolve, reject) => {
      const synth = window.speechSynthesis
      if (!synth) return reject(new Error('浏览器不支持语音合成'))
      const u = new SpeechSynthesisUtterance(text)
      u.rate = Math.max(0.1, Math.min(3, cfg.rate || 1))
      u.pitch = Math.max(0, Math.min(2, cfg.pitch ?? 1))
      u.volume = Math.max(0, Math.min(1, cfg.volume ?? 1))
      if (cfg.voice) {
        const voices = synth.getVoices()
        const v = voices.find((x) => x.name === cfg.voice || x.voiceURI === cfg.voice)
        if (v) u.voice = v
      }
      u.onend = () => resolve()
      u.onerror = (e) => reject(new Error((e as any)?.error || '语音合成失败'))
      this.currentUtterance = u
      synth.speak(u)
    })
  }
  private currentUtterance: SpeechSynthesisUtterance | null = null

  /* ---------------- api ---------------- */
  private async speakApi(text: string, cfg: TtsConfig) {
    const cacheKey = `api|${cfg.api.model}|${cfg.api.voice}|${text}`
    let url = this.cache.get(cacheKey)
    if (!url) {
      const base = String(cfg.api.baseUrl || '').replace(/\/+$/, '')
      if (!base) throw new Error('未配置 TTS API 地址（设置 → 朗读）')
      this.abort = new AbortController()
      const res = await fetch(`${base}/audio/speech`, {
        method: 'POST',
        signal: this.abort.signal,
        headers: { 'Content-Type': 'application/json', ...(cfg.api.apiKey ? { Authorization: `Bearer ${cfg.api.apiKey}` } : {}) },
        body: JSON.stringify({
          model: cfg.api.model || 'tts-1',
          input: text,
          voice: cfg.api.voice || 'alloy',
          response_format: cfg.api.format || 'mp3',
          speed: Math.max(0.25, Math.min(4, cfg.rate || 1)),
        }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`TTS API 错误 ${res.status}：${detail.slice(0, 200) || res.statusText}`)
      }
      const blob = await res.blob()
      url = URL.createObjectURL(blob)
      this.remember(cacheKey, url)
    }
    await this.playUrl(url, cfg)
  }

  /* ---------------- windows SAPI ---------------- */
  private async speakSystem(text: string, cfg: TtsConfig) {
    const cacheKey = `sys|${cfg.voice}|${cfg.rate}|${text}`
    let url = this.cache.get(cacheKey)
    if (!url) {
      const r = await bridge.tts.synth({ text, voice: cfg.voice, rate: cfg.rate, volume: cfg.volume })
      if (!r?.ok) {
        // Surface the reason instead of failing silently — the most common case
        // is "no Chinese voice installed", where SAPI reports no error at all
        // and the user would otherwise just hear nothing.
        this.emit({ error: r?.error || '系统朗读失败' })
        if (this.onError) this.onError(r?.error || '系统朗读失败')
        throw new Error(r?.error || '系统朗读失败')
      }
      const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: r.mime || 'audio/wav' })
      url = URL.createObjectURL(blob)
      this.remember(cacheKey, url)
    }
    await this.playUrl(url, cfg)
  }

  /** Optional hook so the UI can toast TTS failures (set by the app shell). */
  onError: ((msg: string) => void) | null = null

  private remember(key: string, url: string) {
    this.cache.set(key, url)
    this.cacheKeys.push(key)
    // bound the object-URL pool so long sessions do not leak memory
    while (this.cacheKeys.length > 80) {
      const k = this.cacheKeys.shift()!
      const u = this.cache.get(k)
      if (u) URL.revokeObjectURL(u)
      this.cache.delete(k)
    }
  }

  private playUrl(url: string, cfg: TtsConfig) {
    return new Promise<void>((resolve, reject) => {
      const audio = new Audio(url)
      audio.volume = Math.max(0, Math.min(1, cfg.volume ?? 1))
      this.audio = audio
      const done = () => {
        audio.onended = null
        audio.onerror = null
        if (this.audio === audio) this.audio = null
        resolve()
      }
      audio.onended = done
      audio.onerror = () => reject(new Error('音频播放失败'))
      audio.play().catch(reject)
    })
  }

  pause() {
    if (this.cfg?.engine === 'browser') window.speechSynthesis?.pause()
    else this.audio?.pause()
    this.emit({ paused: true })
  }

  resume() {
    if (this.cfg?.engine === 'browser') window.speechSynthesis?.resume()
    else this.audio?.play().catch(() => {})
    this.emit({ paused: false })
  }

  stop() {
    this.queue = []
    this.abort?.abort()
    this.abort = null
    try {
      if (this.audio) {
        this.audio.pause()
        this.audio = null
      }
    } catch {}
    try {
      window.speechSynthesis?.cancel()
    } catch {}
    this.emit({ speaking: false, paused: false, current: '' })
  }

  /** Read one complete message immediately (the 🔊 button). */
  speakNow(markdown: string) {
    this.enqueue(markdown, { interrupt: true, last: true })
  }

  clearCache() {
    for (const u of this.cache.values()) URL.revokeObjectURL(u)
    this.cache.clear()
    this.cacheKeys = []
  }

  async listSystemVoices() {
    return bridge.tts.voices()
  }

  listBrowserVoices() {
    return typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis.getVoices() : []
  }
}

export const speech = new SpeechEngine()
