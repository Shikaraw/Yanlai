/**
 * Crawl the zemengzhou.com 考研知识库 section and save each page as Markdown.
 *
 * Scope is deliberately narrow: only links under /kaoyan/math (the 数学一 knowledge
 * base) plus its sister index /kaoyan/math-notes-index. Everything else on the site
 * (英语, 专业课, 毛泽东概论 …) is left alone.
 *
 * Node's fetch does not use the system proxy by default, which is what we want:
 * this host is reachable directly, and going through FLClash earlier caused
 * ERR_CONNECTION_CLOSED in Electron.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { htmlToDoc } from './kaoyan-html2md.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tmp-fetch')

const SEEDS = [
  'https://zemengzhou.com/kaoyan/math',
  'https://zemengzhou.com/kaoyan/math-notes-index',
]
const ALLOW = [/^https:\/\/zemengzhou\.com\/kaoyan\/math(\/|$)/, /^https:\/\/zemengzhou\.com\/kaoyan\/math-notes-index$/]
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY || 4)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function allowed(u) {
  return ALLOW.some((re) => re.test(u))
}

function norm(u) {
  const x = new URL(u)
  x.hash = ''
  let s = x.href
  if (s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** Discover in-scope links from a page's HTML. */
function discover(html, base) {
  const out = new Set()
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const raw = m[1]
    if (raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('javascript:')) continue
    let abs
    try {
      abs = new URL(raw, base).href
    } catch {
      continue
    }
    if (!abs.startsWith('http')) continue
    if (/\.(png|jpg|jpeg|webp|svg|ico|pdf|zip|xml|txt|css|js)$/i.test(new URL(abs).pathname)) continue
    if (!allowed(abs)) continue
    out.add(norm(abs))
  }
  return [...out]
}

/**
 * Fetch through curl rather than Node's fetch.
 *
 * Node's undici stack intermittently times out connecting to this host
 * (UND_ERR_CONNECT_TIMEOUT) while curl connects in ~0.3 s from the same shell.
 * curl also gives us a real connect/overall timeout and silent failure modes
 * that are easy to retry, so it is the more dependable transport here.
 */
function fetchText(url, { tries = 3, timeout = 180 } = {}) {
  const tmp = path.join(os.tmpdir(), `yanlai-crawl-${process.pid}-${Math.random().toString(36).slice(2)}.html`)
  const attempt = (n) =>
    new Promise((resolve, reject) => {
      execFile(
        'curl',
        [
          '-sSL',
          '--fail-with-body',
          '--compressed',
          '--max-time', String(timeout),
          '--connect-timeout', '25',
          '-A', UA,
          '-o', tmp,
          url,
        ],
        (err, _stdout, stderr) => {
          if (err) return reject(new Error((stderr || err.message || '').trim().slice(0, 200) || 'curl failed'))
          try {
            resolve(fs.readFileSync(tmp, 'utf8'))
          } catch (e) {
            reject(e)
          }
        },
      )
    }).finally(() => {
      try {
        fs.unlinkSync(tmp)
      } catch {}
    })

  return (async () => {
    let lastErr
    for (let i = 1; i <= tries; i++) {
      try {
        return await attempt(i)
      } catch (e) {
        lastErr = e
        if (i < tries) await new Promise((r) => setTimeout(r, 1500 * i))
      }
    }
    throw lastErr
  })()
}

function slugFromUrl(url) {
  const p = new URL(url).pathname.replace(/^\/kaoyan\//, '').replace(/\/$/, '')
  return p || 'index'
}

async function main() {
  const rawDir = path.join(OUT, 'raw')
  fs.mkdirSync(rawDir, { recursive: true })
  fs.mkdirSync(path.join(OUT, 'md'), { recursive: true })

  const seen = new Set()
  const queue = SEEDS.map(norm)
  const pages = []

  while (queue.length) {
    const batch = []
    while (queue.length && batch.length < CONCURRENCY) {
      const u = queue.shift()
      if (seen.has(u)) continue
      seen.add(u)
      batch.push(u)
    }
    if (!batch.length) break

    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const html = await fetchText(url)
          return { url, html }
        } catch (e) {
          return { url, error: String(e.message || e) }
        }
      }),
    )

    for (const r of results) {
      if (r.error) {
        console.log(`  ✗ ${r.url}  (${r.error})`)
        pages.push({ url: r.url, ok: false, error: r.error })
        continue
      }
      const slug = slugFromUrl(r.url)
      const file = path.join(rawDir, `${slug.replace(/\//g, '__')}.html`)
      fs.writeFileSync(file, r.html, 'utf8')
      const doc = htmlToDoc(r.html, r.url)

      // keep the source hierarchy so the folder reads like the site's outline
      const mdPath = path.join(OUT, 'md', `${slug.replace(/\//g, '__')}.md`)
      fs.mkdirSync(path.dirname(mdPath), { recursive: true })
      fs.writeFileSync(mdPath, doc.markdown, 'utf8')

      pages.push({ url: r.url, ok: true, slug, title: doc.title, chars: doc.chars, mdPath })
      console.log(`  ✓ ${String(doc.chars).padStart(7)}字  ${doc.title}`)

      for (const link of discover(r.html, r.url)) if (!seen.has(link)) queue.push(link)
    }
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(pages, null, 2), 'utf8')
  const ok = pages.filter((p) => p.ok)
  console.log(`\n完成：${ok.length} 页成功，${pages.length - ok.length} 页失败`)
  console.log(`总字数：${ok.reduce((n, p) => n + p.chars, 0).toLocaleString()}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
