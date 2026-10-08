/**
 * OpenAI-compatible streaming chat client.
 *
 * Works with any provider exposing /chat/completions with SSE: DeepSeek,
 * OpenAI, Moonshot, DashScope, Zhipu, Ollama, vLLM, one-api, ...
 *
 * Features that matter for this app:
 *  - streamed text + streamed *reasoning* (deepseek-reasoner, o-series)
 *  - streamed tool calls, accumulated by index
 *  - vision input (image parts) for screenshot question solving
 *  - cooperative cancellation via AbortSignal
 */

import type { ChatMessage } from './types'

export interface LlmTool {
  type: 'function'
  function: { name: string; description: string; parameters: any }
}

export interface StreamHandlers {
  onDelta?: (text: string) => void
  onReasoning?: (text: string) => void
  onToolCallDelta?: (calls: Array<{ index: number; id?: string; name?: string; argsText?: string }>) => void
  onUsage?: (u: any) => void
  onFinish?: (reason: string) => void
  onError?: (err: Error) => void
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: Array<any>
  tools?: LlmTool[]
  toolChoice?: 'auto' | 'none' | 'required'
  temperature?: number
  topP?: number
  maxTokens?: number
  signal?: AbortSignal
  /** extra provider-specific body fields */
  extraBody?: Record<string, any>
}

function joinUrl(base: string, path: string) {
  const b = String(base || '').replace(/\/+$/, '')
  if (!b) return path
  if (b.endsWith(path)) return b
  return `${b}${path}`
}

export async function streamChat(req: ChatRequest, h: StreamHandlers = {}): Promise<void> {
  const url = joinUrl(req.baseUrl, '/chat/completions')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`

  const body: Record<string, any> = {
    model: req.model,
    messages: req.messages,
    stream: true,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    ...(req.tools?.length ? { tools: req.tools, tool_choice: req.toolChoice || 'auto' } : {}),
    ...(req.extraBody || {}),
  }
  // Ollama and a few gateways reject stream_options; DeepSeek/OpenAI accept it.
  if (!/ollama|11434/i.test(req.baseUrl)) body.stream_options = { include_usage: true }

  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal })
  } catch (e: any) {
    if (e?.name === 'AbortError') return h.onFinish?.('aborted')
    throw new Error(`网络请求失败：${e?.message || e}（请检查 Base URL 与网络/代理设置）`)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const txt = await res.text()
      try {
        const j = JSON.parse(txt)
        detail = j?.error?.message || j?.message || txt
      } catch {
        detail = txt
      }
    } catch {}
    const hint =
      res.status === 401
        ? 'API Key 无效或未填写。'
        : res.status === 404
          ? '接口路径不存在，请确认 Base URL（通常以 /v1 结尾）。'
          : res.status === 429
            ? '触发速率限制或余额不足。'
            : res.status >= 500
              ? '服务端错误，可稍后重试。'
              : ''
    throw new Error(`API 错误 ${res.status}：${detail?.slice(0, 400) || res.statusText}${hint ? ` ${hint}` : ''}`)
  }
  if (!res.body) throw new Error('响应没有可读的数据流。')

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let finishReason = 'stop'

  const handleObj = (obj: any) => {
    if (obj?.usage) h.onUsage?.(obj.usage)
    const choice = obj?.choices?.[0]
    if (!choice) return
    const d = choice.delta || {}
    if (typeof d.content === 'string' && d.content) h.onDelta?.(d.content)
    // reasoning_content: DeepSeek; reasoning: several gateways; thinking: some
    const reasoning = d.reasoning_content ?? d.reasoning ?? d.thinking
    if (typeof reasoning === 'string' && reasoning) h.onReasoning?.(reasoning)
    if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
      h.onToolCallDelta?.(
        d.tool_calls.map((tc: any, i: number) => ({
          index: typeof tc.index === 'number' ? tc.index : i,
          id: tc.id,
          name: tc.function?.name,
          argsText: tc.function?.arguments,
        })),
      )
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        h.onFinish?.('aborted')
        return
      }
      throw e
    }
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })

    // Consume complete lines; keep the trailing partial line in `buffer`.
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith(':') || t.startsWith('event:') || t.startsWith('id:')) continue
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') {
        h.onFinish?.(finishReason)
        return
      }
      try {
        handleObj(JSON.parse(payload))
      } catch {
        // partial JSON split across chunks is impossible here (we split on \n),
        // so a parse failure means the provider sent a non-JSON keepalive.
      }
    }
  }
  h.onFinish?.(finishReason)
}

/** Non-streaming call, used for cheap internal jobs (titling, classification). */
export async function completeOnce(req: Omit<ChatRequest, 'signal'> & { signal?: AbortSignal }) {
  const url = joinUrl(req.baseUrl, '/chat/completions')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal: req.signal,
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: false,
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens ?? 512,
    }),
  })
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`)
  const j = await res.json()
  return { text: j?.choices?.[0]?.message?.content || '', usage: j?.usage }
}

/** Ask the provider what models it exposes; used by the settings screen. */
export async function listModels(baseUrl: string, apiKey: string) {
  const url = joinUrl(baseUrl, '/models')
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`无法获取模型列表 (${res.status})`)
  const j = await res.json()
  const arr = j?.data || j?.models || []
  return arr
    .map((m: any) => (typeof m === 'string' ? m : m?.id || m?.name))
    .filter(Boolean)
    .sort() as string[]
}

/** Cheap connectivity/auth probe that does not consume generation tokens. */
export async function testConnection(baseUrl: string, apiKey: string, model: string) {
  const started = Date.now()
  const models = await listModels(baseUrl, apiKey).catch(() => null)
  if (models && models.length) {
    return { ok: true, ms: Date.now() - started, models, modelFound: models.some((m) => m === model) }
  }
  // fall back to a 1-token completion
  const url = joinUrl(baseUrl, '/chat/completions')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
  })
  if (!res.ok) throw new Error(`连接失败 (${res.status} ${res.statusText})`)
  return { ok: true, ms: Date.now() - started, models: null, modelFound: null }
}
