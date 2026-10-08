/**
 * HTML -> Markdown converter for the zemengzhou.com 考研知识库 (Astro/KaTeX) pages.
 *
 * The site renders every formula with KaTeX, which keeps the original LaTeX in
 *   <annotation encoding="application/x-tex">…</annotation>
 * so we can round-trip math losslessly instead of trying to read the rendered
 * MathML/HTML spans (which would give us garbage strings).
 *
 * The rendered `<span class="katex-html">` copy is dropped: it is a visual
 * duplicate of the annotation and is what makes the raw pages ~1.5 MB each.
 */

import { parse } from 'parse5'

const SKIP_TAGS = new Set([
  'script', 'style', 'svg', 'button', 'nav', 'form', 'input', 'select',
  'textarea', 'noscript', 'iframe', 'video', 'audio', 'canvas',
])

const SKIP_CLASS = [
  'katex-html',          // visual duplicate of the annotation
  'toc', 'share', 'post-share', 'breadcrumb', 'mastery-breadcrumb',
  'mastery-index-nav', 'mastery-monograph-meta', 'post-pdf-download',
  'site-header', 'site-footer', 'music-player', 'page-turn',
]

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption', 'dl', 'dt', 'dd',
])

function attr(node, name) {
  const a = (node.attrs || []).find((x) => x.name === name)
  return a ? a.value : ''
}

function classList(node) {
  return attr(node, 'class').split(/\s+/).filter(Boolean)
}

function hasClass(node, cls) {
  return classList(node).includes(cls)
}

function classMatch(node, sub) {
  return classList(node).some((c) => c.includes(sub))
}

/** Concatenate all text under a node (used for katex annotation, pre, title). */
function textOf(node) {
  let out = ''
  const walk = (n) => {
    if (n.nodeName === '#text') {
      out += n.value
      return
    }
    if (n.tagName === 'br') {
      out += '\n'
      return
    }
    for (const c of n.childNodes || []) walk(c)
  }
  walk(node)
  return out
}

function findFirst(node, pred) {
  if (pred(node)) return node
  for (const c of node.childNodes || []) {
    const hit = findFirst(c, pred)
    if (hit) return hit
  }
  return null
}

function findTex(node) {
  return findFirst(node, (n) => n.tagName === 'annotation' && /x-tex/.test(attr(n, 'encoding')))
}

function absolute(href, base) {
  if (!href) return ''
  try {
    return new URL(href, base).href
  } catch {
    return href
  }
}

/* ------------------------------------------------------------------ */

function renderInlineChildren(node, ctx) {
  return (node.childNodes || []).map((c) => render(c, ctx)).join('')
}

function renderChildren(node, ctx) {
  return (node.childNodes || []).map((c) => render(c, ctx)).join('')
}

function renderList(node, ctx, ordered, depth) {
  const indent = '  '.repeat(depth)
  const items = (node.childNodes || []).filter((c) => c.tagName === 'li')
  const lines = []
  let n = 1
  for (const li of items) {
    const marker = ordered ? `${n++}. ` : '- '
    // Render the item, then prefix every line so nested content stays aligned.
    const inner = (li.childNodes || [])
      .map((c) => (c.tagName === 'ul' || c.tagName === 'ol' ? '' : render(c, ctx)))
      .join('')
      .trim()
    const nested = (li.childNodes || [])
      .filter((c) => c.tagName === 'ul' || c.tagName === 'ol')
      .map((c) => renderList(c, ctx, c.tagName === 'ol', depth + 1))
      .join('')
    const body = inner.replace(/\n{2,}/g, '\n').split('\n')
    lines.push(`${indent}${marker}${body[0] || ''}`)
    for (const extra of body.slice(1)) if (extra.trim()) lines.push(`${indent}  ${extra}`)
    if (nested) lines.push(nested)
  }
  return `\n\n${lines.join('\n')}\n\n`
}

function renderTable(node, ctx) {
  const rows = []
  const collect = (n) => {
    if (n.tagName === 'tr') {
      const cells = (n.childNodes || [])
        .filter((c) => c.tagName === 'td' || c.tagName === 'th')
        .map((c) => renderChildren(c, ctx).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim())
      if (cells.length) rows.push(cells)
      return
    }
    for (const c of n.childNodes || []) collect(c)
  }
  collect(node)
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const pad = (r) => r.concat(Array.from({ length: width - r.length }, () => ''))
  const head = pad(rows[0])
  const body = rows.slice(1).map(pad)
  const out = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`]
  for (const r of body) out.push(`| ${r.join(' | ')} |`)
  return `\n\n${out.join('\n')}\n\n`
}

function renderCallout(node, ctx) {
  const titleNode = findFirst(node, (n) => hasClass(n, 'callout__title'))
  const labelNode = findFirst(node, (n) => hasClass(n, 'callout__label'))
  const contentNode = findFirst(node, (n) => hasClass(n, 'callout__content'))
  const title = titleNode ? textOf(titleNode).replace(/\s+/g, ' ').trim() : ''
  const label = labelNode ? textOf(labelNode).replace(/\s+/g, ' ').trim() : ''
  const body = (contentNode ? renderChildren(contentNode, ctx) : renderChildren(node, ctx))
    .trim()
    .replace(/\n{2,}/g, '\n\n')
  const head = [label && `【${label}】`, title].filter(Boolean).join(' ')
  const quoted = body
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n')
  return `\n\n> ${head}\n>\n${quoted}\n\n`
}

function render(node, ctx) {
  if (!node) return ''
  if (node.nodeName === '#text') {
    return node.value.replace(/\s+/g, ' ')
  }
  if (node.nodeName === '#comment') return ''
  const tag = node.tagName
  if (!tag) return renderChildren(node, ctx)

  if (SKIP_TAGS.has(tag)) return ''
  if (SKIP_CLASS.some((c) => classMatch(node, c))) return ''

  // math first: display and inline both carry the raw LaTeX in an annotation
  if (tag === 'span' && hasClass(node, 'katex')) {
    const tex = findTex(node)
    if (!tex) return ''
    const raw = textOf(tex).trim()
    return ctx.display ? `$$${raw}$$` : `$${raw}$`
  }
  if (hasClass(node, 'katex-display')) {
    return renderChildren(node, { ...ctx, display: true })
  }

  switch (tag) {
    case 'br':
      return '\n'
    case 'hr':
      return '\n\n---\n\n'
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const level = Number(tag[1])
      return `\n\n${'#'.repeat(level)} ${renderInlineChildren(node, ctx).trim()}\n\n`
    }
    case 'p': {
      const inner = renderChildren(node, ctx).trim()
      return inner ? `\n\n${inner}\n\n` : ''
    }
    case 'strong': case 'b':
      return `**${renderChildren(node, ctx).trim()}**`
    case 'em': case 'i':
      return `*${renderChildren(node, ctx).trim()}*`
    case 'del': case 's':
      return `~~${renderChildren(node, ctx).trim()}~~`
    case 'code': {
      const t = textOf(node)
      return t.includes('\n') ? `\n\n\`\`\`\n${t}\n\`\`\`\n\n` : `\`${t}\``
    }
    case 'pre': {
      const t = textOf(node).replace(/\n+$/, '')
      return `\n\n\`\`\`\n${t}\n\`\`\`\n\n`
    }
    case 'a': {
      const text = renderChildren(node, ctx).trim()
      if (!text) {
        // link with no visible text (icon links) contributes nothing useful
        return ''
      }
      // Keep the anchor *text* but drop the target. Inside a local knowledge base
      // the URLs are dead weight: the site's own index pages are mostly links, so
      // keeping them floods retrieval chunks with percent-encoded path noise.
      return text
    }
    case 'img': {
      const src = absolute(attr(node, 'src'), ctx.base)
      const alt = attr(node, 'alt') || ''
      return src ? `![${alt}](${src})` : ''
    }
    case 'ul':
      return renderList(node, ctx, false, 0)
    case 'ol':
      return renderList(node, ctx, true, 0)
    case 'table':
      return renderTable(node, ctx)
    case 'blockquote': {
      const inner = renderChildren(node, ctx).trim()
      return inner
        ? `\n\n${inner.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n')}\n\n`
        : ''
    }
    case 'aside':
      if (classMatch(node, 'callout')) return renderCallout(node, ctx)
      return renderChildren(node, ctx)
    default:
      if (BLOCK_TAGS.has(tag)) {
        const inner = renderChildren(node, ctx)
        return inner.trim() ? `\n\n${inner.trim()}\n\n` : ''
      }
      return renderChildren(node, ctx)
  }
}

function normalize(md) {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(\S)\n{3,}/g, '$1\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
}

/** Strip every in-page 上一节/下一节/总目录 navigation paragraph. */
function dropNavParagraph(root) {
  const hits = []
  const walk = (n) => {
    if (
      n.tagName === 'p' &&
      /(上一节|下一节)/.test(textOf(n)) &&
      /(总目录|笔记整理索引)/.test(textOf(n))
    ) {
      hits.push(n)
    }
    for (const c of n.childNodes || []) walk(c)
  }
  walk(root)
  for (const hit of hits) {
    const p = hit.parentNode
    if (!p) continue
    const i = (p.childNodes || []).indexOf(hit)
    if (i >= 0) p.childNodes.splice(i, 1)
  }
}

/**
 * Convert one article page.
 * @returns {{title: string, markdown: string, words: number}}
 */
export function htmlToDoc(html, url) {
  const doc = parse(html)
  const body = findFirst(doc, (n) => n.tagName === 'body') || doc

  const article = findFirst(body, (n) => n.tagName === 'article' && classMatch(n, 'post-article'))
  const content = article
    ? findFirst(article, (n) => classMatch(n, 'kaoyan-prose')) ||
      findFirst(article, (n) => classMatch(n, 'content-card')) ||
      article
    : body

  dropNavParagraph(content)

  const h1 = findFirst(content, (n) => n.tagName === 'h1')
  let title = h1 ? textOf(h1).replace(/\s+/g, ' ').trim() : ''
  if (!title) {
    const t = findFirst(doc, (n) => n.tagName === 'title')
    title = t ? textOf(t).replace(/\s*[|｜-]\s*.*$/, '').trim() : ''
  }
  // the in-content H1 duplicates the title; keep it out of the body to avoid
  // a redundant "# title" line in the chunk text
  let markdown = normalize(render(content, { base: url, display: false }))
  markdown = markdown.replace(/^#\s+.*?\n+/, '')

  return {
    title: title || '未命名',
    markdown: `# ${title}\n\n${markdown}`.trim(),
    chars: markdown.length,
  }
}
