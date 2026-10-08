/* Small shared helpers. Kept dependency-free so they can run anywhere. */

export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

export function clsx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

export function fmtBytes(n?: number) {
  if (!n && n !== 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function fmtTime(ts?: number) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtDateTime(ts?: number) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtDate(ts?: number) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function relativeTime(ts?: number) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return fmtDate(ts)
}

export function toMinutes(hhmm?: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

export function fromMinutes(min: number) {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function durationLabel(start?: string, end?: string) {
  const a = toMinutes(start)
  const b = toMinutes(end)
  if (a === null || b === null) return ''
  const d = b - a
  if (d <= 0) return ''
  if (d < 60) return `${d} 分钟`
  const h = Math.floor(d / 60)
  const m = d % 60
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

/** Strip markdown / LaTeX down to speakable plain text for TTS. */
export function speakable(md: string) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' 代码块已省略 ')
    .replace(/\$\$([\s\S]*?)\$\$/g, (_m, e) => latexToSpeech(String(e)))
    .replace(/\$([^$\n]+)\$/g, (_m, e) => latexToSpeech(String(e)))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/-{3,}/g, '，')
    .replace(/[\u2500-\u257F]/g, '')
    .replace(/\n{2,}/g, '。')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Best-effort reading of simple LaTeX so TTS does not spell symbols out. */
function latexToSpeech(tex: string) {
  return String(tex)
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1 分之 $2')
    .replace(/\\sqrt\{([^{}]+)\}/g, '根号 $1')
    .replace(/\\(int|sum|prod|lim|log|ln|sin|cos|tan|alpha|beta|gamma|theta|pi|lambda|mu|sigma|omega|infty)/g, (_m, s) => {
      const map: Record<string, string> = {
        int: '积分',
        sum: '求和',
        prod: '连乘',
        lim: '极限',
        log: '对数',
        ln: '自然对数',
        sin: '正弦',
        cos: '余弦',
        tan: '正切',
        alpha: '阿尔法',
        beta: '贝塔',
        gamma: '伽马',
        theta: '西塔',
        pi: '派',
        lambda: '兰姆达',
        mu: '缪',
        sigma: '西格玛',
        omega: '欧米伽',
        infty: '无穷',
      }
      return map[s] || s
    })
    .replace(/\\times/g, ' 乘以 ')
    .replace(/\\cdot/g, ' 点乘 ')
    .replace(/\\div/g, ' 除以 ')
    .replace(/\\pm/g, ' 正负 ')
    .replace(/\\leq?|<=/g, ' 小于等于 ')
    .replace(/\\geq?|>=/g, ' 大于等于 ')
    .replace(/\\neq|!=/g, ' 不等于 ')
    .replace(/\\to|\\rightarrow/g, ' 趋于 ')
    .replace(/\\approx/g, ' 约等于 ')
    .replace(/[\^_]\{?([^{}\s]+)\}?/g, ' 的 $1 次方 ')
    .replace(/[\\{}]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Split streaming text into speakable sentences so TTS can start early.
 *
 * Short fragments are carried forward rather than dropped: a one-word sentence
 * like "所以。" must not vanish just because the next sentence was long enough
 * to be flushed on its own.
 */
export function drainSentences(buf: string): { ready: string[]; rest: string } {
  const ready: string[] = []
  const re = /[^。！？!?\n]*[。！？!?]+|[^\n]*\n{2,}/g
  let consumed = 0
  let pending = ''
  let m: RegExpExecArray | null
  while ((m = re.exec(buf))) {
    const raw = m[0]
    const candidate = (pending + raw).trim()
    if (candidate.length >= 8) {
      ready.push(candidate)
      pending = ''
      consumed = m.index + raw.length
    } else {
      // too short to be worth an utterance on its own — hold it and append the
      // next sentence, but do not advance `consumed` past it
      pending = candidate
    }
  }
  let rest = buf.slice(consumed)
  // bound the trailing fragment so an unpunctuated stream still gets spoken
  if (rest.length > 400) {
    const cut = rest.lastIndexOf('，', 400)
    const at = cut > 80 ? cut + 1 : 400
    ready.push(rest.slice(0, at).trim())
    rest = rest.slice(at)
  }
  return { ready, rest }
}

export function activeReason(text: string): ReasonCategoryLike {
  const t = text || ''
  const rules: Array<[RegExp, string]> = [
    [/概念|定义|不理解|混淆|分不清|性质/, '概念不清'],
    [/公式|定理记错|记混了|记错/, '公式记错'],
    [/算错|计算|口算|代入|漏算|符号错/, '计算失误'],
    [/看错题|审题|没看清|条件|问的是|误解题意/, '审题错误'],
    [/思路|方向|方法不对|想不到|切入点/, '思路偏差'],
    [/不会|没学过|无从下手|完全没头绪/, '方法不会'],
    [/没复习|盲区|根本没/, '知识盲区'],
    [/时间不够|来不及|没做完/, '时间不足'],
    [/粗心|马虎|笔误|抄错/, '粗心大意'],
  ]
  for (const [re, cat] of rules) if (re.test(t)) return cat as ReasonCategoryLike
  return '其他'
}

type ReasonCategoryLike = string
