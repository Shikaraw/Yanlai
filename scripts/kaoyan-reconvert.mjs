/**
 * Re-run the HTML→Markdown conversion over the already-downloaded raw pages,
 * so converter improvements do not require re-crawling the site.
 *
 *   node scripts/kaoyan-reconvert.mjs
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { htmlToDoc } from './kaoyan-html2md.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, '.tmp-fetch')
const rawDir = path.join(SRC, 'raw')
const mdDir = path.join(SRC, 'md')

function slugFromUrl(url) {
  return new URL(url).pathname.replace(/^\/kaoyan\//, '').replace(/\/$/, '') || 'index'
}

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'))
let ok = 0
const next = manifest.map((entry) => {
  if (!entry.ok) return entry
  const rawFile = path.join(rawDir, `${slugFromUrl(entry.url).replace(/\//g, '__')}.html`)
  if (!fs.existsSync(rawFile)) return { ...entry, ok: false, error: 'raw html missing' }
  const doc = htmlToDoc(fs.readFileSync(rawFile, 'utf8'), entry.url)
  fs.writeFileSync(path.join(SRC, 'md', `${slugFromUrl(entry.url).replace(/\//g, '__')}.md`), doc.markdown, 'utf8')
  ok++
  return { ...entry, title: doc.title, chars: doc.chars }
})

fs.writeFileSync(path.join(SRC, 'manifest.json'), JSON.stringify(next, null, 2), 'utf8')
console.log(`重新转换 ${ok} 页`)
