import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import katex from 'katex'

/* ------------------------------------------------------------------ */
/* pre-processing: normalise LaTeX delimiters that models emit         */
/* ------------------------------------------------------------------ */
/**
 * Models routinely emit \[ ... \], \( ... \), or bare `\begin{align}` blocks.
 * remark-math only understands $ / $$, so translate first. Code fences are
 * protected so we never mangle code samples.
 */
export function normalizeMath(src: string): string {
  if (!src) return ''
  const blocks: string[] = []
  let out = src.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    blocks.push(m)
    return `\u0000CODE${blocks.length - 1}\u0000`
  })

  out = out
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, e) => `\n$$\n${e.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, e) => `$${e.trim()}$`)
    .replace(/\$\$([\s\S]*?)\$\$/g, (_m, e) => `\n$$\n${e.trim()}\n$$\n`)
    // \begin{...} ... \end{...} without $ delimiters (common for align/gather)
    .replace(
      /(^|\n)(\s*)(\\begin\{(align|aligned|gather|array|matrix|pmatrix|bmatrix|cases|equation)\*?\}[\s\S]*?\\end\{\4\*?\})/g,
      (_m, pre, _ind, body) => `${pre}\n$$\n${body.trim()}\n$$\n`,
    )
    // bare braces style {eq} used by some providers
    .replace(/\\begin\{align\*\}/g, '\\begin{aligned}')
    .replace(/\\end\{align\*\}/g, '\\end{aligned}')

  return out.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => blocks[Number(i)])
}

/* ------------------------------------------------------------------ */
/* boundary-aware streaming markdown                                   */
/* ------------------------------------------------------------------ */
/**
 * While tokens stream in, an open `$$` or an unfinished code fence makes the
 * rendered output flicker and sometimes throw. We render the stable prefix and
 * append the unstable tail as plain text, so maths never pops in and out.
 */
export function splitStable(md: string): { stable: string; tail: string } {
  const s = normalizeMath(md)
  const fenceCount = (s.match(/```/g) || []).length
  if (fenceCount % 2 === 1) {
    const last = s.lastIndexOf('```')
    return { stable: s.slice(0, last), tail: s.slice(last) }
  }
  const dollar = (s.match(/\$\$/g) || []).length
  if (dollar % 2 === 1) {
    const last = s.lastIndexOf('$$')
    return { stable: s.slice(0, last), tail: s.slice(last) }
  }
  // a trailing incomplete inline formula: "$x^2" with no closing $
  const lastOpen = s.lastIndexOf('$')
  if (lastOpen > -1) {
    const seg = s.slice(lastOpen)
    if (!/\$/.test(seg.slice(1)) && !seg.includes('\n')) {
      return { stable: s.slice(0, lastOpen), tail: seg }
    }
  }
  return { stable: s, tail: '' }
}

/* ------------------------------------------------------------------ */
/* inline-math autolinking for bare ASCII formulas                     */
/* ------------------------------------------------------------------ */
/** Wrap things like x^2, a_n, \alpha inside $...$ when the model forgot. */
function autowrapMath(text: string): string {
  if (!text || /\$/.test(text)) return text
  const hasTex = /\\(frac|sqrt|int|sum|alpha|beta|theta|lambda|cdot|times|leq|geq|neq|infty|partial|nabla|begin)/.test(text)
  const hasPow = /[a-zA-Z0-9)\]]\s*\^\s*[-+]?[a-zA-Z0-9{(]/.test(text)
  if (!hasTex && !hasPow) return text
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*[-*|#>]|^\s*\d+\./.test(line) && !hasTex) return line
      if (line.includes('$')) return line
      return line.replace(
        /(\\[a-zA-Z]+(?:\{[^}]*\})*|(?<![A-Za-z0-9_])(?:[a-zA-Z]|[0-9]+(?:\.[0-9]+)?)(?:\s*\^\s*\{?[-+]?[a-zA-Z0-9]+\}?|\s*_\s*\{?[a-zA-Z0-9]+\}?)+)/g,
        (m) => (m.trim().length > 1 ? `$${m}$` : m),
      )
    })
    .join('\n')
}

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */
export interface MarkdownProps {
  children: string
  /** true while text is still streaming */
  streaming?: boolean
  className?: string
  /** called when the user clicks an image (opens the preview panel) */
  onImageClick?: (src: string, alt: string) => void
  /** resolve a relative artifact reference to a displayable URL */
  resolveSrc?: (src: string) => string
}

function CodeBlock({ className, children, ...rest }: any) {
  const [copied, setCopied] = useState(false)
  const code = String(children ?? '').replace(/\n$/, '')
  const lang = /language-([\w-]+)/.exec(className || '')?.[1]
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {}
  }
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-lang">{lang || 'text'}</span>
        <button className="code-copy" onClick={copy} title="复制代码">
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>
        <code className={className} {...rest}>
          {children}
        </code>
      </pre>
    </div>
  )
}

/** A display-math block rendered directly through KaTeX with error fallback. */
function MathBlock({ tex, display }: { tex: string; display: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        errorColor: '#fb7185',
        strict: false,
        trust: false,
        macros: { '\\RR': '\\mathbb{R}', '\\NN': '\\mathbb{N}', '\\ZZ': '\\mathbb{Z}', '\\QQ': '\\mathbb{Q}' },
      })
    } catch (e: any) {
      return `<span class="katex-error">公式解析失败: ${String(e?.message || e)}</span>`
    }
  }, [tex, display])
  return <span className={display ? 'math-display' : 'math-inline'} dangerouslySetInnerHTML={{ __html: html }} />
}

export const Markdown = memo(function Markdown({ children, streaming, className, onImageClick, resolveSrc }: MarkdownProps) {
  const src = useMemo(() => {
    const base = streaming ? splitStable(children).stable : children
    const tail = streaming ? splitStable(children).tail : ''
    return { text: normalizeMath(base), tail }
  }, [children, streaming])

  const components = useMemo(
    () => ({
      code(props: any) {
        const { inline, className: cls, children: kids } = props
        // rehype-highlight adds hljs classes for fenced blocks
        const isBlock = !inline && (cls?.includes('language-') || String(kids ?? '').includes('\n') || cls?.includes('hljs'))
        if (isBlock) return <CodeBlock className={cls}>{kids}</CodeBlock>
        return <code className="inline-code">{kids}</code>
      },
      pre(props: any) {
        // CodeBlock already renders its own <pre>
        const child = props.children
        if (child && typeof child === 'object' && (child as any).type === CodeBlock) return child
        return <pre className="md-pre">{props.children}</pre>
      },
      a({ href, children: kids, ...rest }: any) {
        const external = /^https?:/i.test(href || '')
        return (
          <a
            href={href}
            {...rest}
            onClick={(e) => {
              if (external) {
                e.preventDefault()
                ;(window as any).yanlai?.shell?.openExternal?.(href)
              }
            }}
            title={external ? '在浏览器中打开' : href}
          >
            {kids}
          </a>
        )
      },
      img({ src: s, alt, ...rest }: any) {
        const resolved = resolveSrc ? resolveSrc(String(s || '')) : String(s || '')
        return (
          <img
            src={resolved}
            alt={alt || ''}
            loading="lazy"
            className="md-img"
            onClick={() => onImageClick?.(resolved, alt || '')}
            {...rest}
          />
        )
      },
      table({ children: kids }: any) {
        return (
          <div className="md-table-wrap">
            <table>{kids}</table>
          </div>
        )
      },
      blockquote({ children: kids }: any) {
        return <blockquote className="md-quote">{kids}</blockquote>
      },
      hr() {
        return <hr className="md-hr" />
      },
    }),
    [onImageClick, resolveSrc],
  )

  return (
    <div className={`md-body${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { throwOnError: false, strict: false, trust: false, errorColor: '#fb7185' }],
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
        components={components}
        // children is the raw markdown string
      >
        {src.text}
      </ReactMarkdown>
      {src.tail ? <span className="md-tail">{src.tail}</span> : null}
      {streaming ? <span className="caret" /> : null}
    </div>
  )
})

/* ------------------------------------------------------------------ */
/* tiny inline-math renderer for non-markdown contexts                 */
/* ------------------------------------------------------------------ */
export function InlineTex({ tex }: { tex: string }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, { displayMode: false, throwOnError: false, strict: false })
    } catch {
      return tex
    }
  }, [tex])
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

/** Renders a string that may contain $...$ segments. */
export function MixedText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: Array<{ t: 'text' | 'math'; v: string }> = []
    const re = /\$([^$\n]+)\$/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) })
      out.push({ t: 'math', v: m[1] })
      last = m.index + m[0].length
    }
    if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
    return out
  }, [text])
  return (
    <>
      {parts.map((p, i) => (p.t === 'math' ? <InlineTex key={i} tex={p.v} /> : <span key={i}>{p.v}</span>))}
    </>
  )
}
