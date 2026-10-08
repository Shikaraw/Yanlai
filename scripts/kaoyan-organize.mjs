/**
 * Turn the flat crawl output (.tmp-fetch/md + manifest.json) into a readable
 * folder tree that mirrors the site's outline, ready to import into the 研来
 * knowledge base (知识库 → 导入文件夹).
 *
 * The knowledge base names each document after its filename, so filenames are
 * the real titles, and the folders exist purely so a human can browse the tree.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, '.tmp-fetch')
const OUT = process.argv[2] || path.join(ROOT, 'kaoyan-kb')

const CH_TITLES = {
  1: '第01章 极限与函数性质',
  2: '第02章 导数',
  3: '第03章 积分',
  4: '第04章 微分方程',
  5: '第05章 多元微分',
  6: '第06章 二重积分',
  7: '第07章 无穷级数',
  8: '第08章 空间几何',
}

/** Windows-illegal filename characters, plus the ones that confuse markdown. */
function safe(name) {
  return String(name || '未命名')
    .replace(/[\\/:*?"<>|]/g, '·')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
}

function chapterOf(pathname) {
  const m = /\/advanced-math\/ch0?(\d+)-/.exec(pathname)
  return m ? Number(m[1]) : 0
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8')).filter((d) => d.ok)
  fs.rmSync(OUT, { recursive: true, force: true })

  const used = new Set()
  const placed = []

  const unique = (dir, base) => {
    let name = base
    let n = 2
    while (used.has(path.join(dir, name).toLowerCase())) name = `${base} (${n++})`
    used.add(path.join(dir, name).toLowerCase())
    return name
  }

  for (const doc of manifest) {
    const pathname = new URL(doc.url).pathname
    const title = doc.title.replace(/^📚\s*/, '').trim()
    let relDir

    if (pathname.includes('/errors/')) {
      relDir = path.join('02-数学错题集')
    } else if (/^\/kaoyan\/math\/advanced-math/.test(pathname)) {
      const ch = chapterOf(pathname)
      relDir = path.join('01-高等数学', CH_TITLES[ch] || `第${ch}章`)
    } else {
      relDir = '00-总览与索引'
    }
    // the two site-level indexes sit at the top of the overview folder
    const dir = path.join(OUT, relDir)
    fs.mkdirSync(dir, { recursive: true })

    let base = safe(title)
    if (pathname === '/kaoyan/math') base = '00-考研数学一全景知识库'
    else if (pathname === '/kaoyan/math-notes-index') base = '00-笔记整理索引'
    else if (/知识点索引$/.test(title)) base = `00-${safe(title)}`

    const md = fs.readFileSync(doc.mdPath, 'utf8')
    const file = path.join(dir, unique(dir, `${base}.md`))
    fs.writeFileSync(file, md, 'utf8')
    placed.push({ file: path.relative(OUT, file), chars: md.length, title })
  }

  placed.sort((a, b) => a.file.localeCompare(b.file, 'zh'))
  // The TOC lives *outside* the imported tree so the knowledge base does not
  // ingest a link-only page (and so `导入文件夹` never picks it up).
  fs.writeFileSync(
    path.join(path.dirname(OUT), `${path.basename(OUT)}-目录.md`),
    ['# 考研数学一知识库 · 目录', '', `共 ${placed.length} 篇，约 ${placed.reduce((n, p) => n + p.chars, 0).toLocaleString()} 字。`, '', ...placed.map((p) => `- ${p.title}`)].join('\n'),
    'utf8',
  )

  console.log(`整理完成 → ${OUT}`)
  const byDir = {}
  for (const p of placed) {
    const d = path.dirname(p.file)
    byDir[d] = (byDir[d] || 0) + 1
  }
  for (const d of Object.keys(byDir).sort()) console.log(`  ${String(byDir[d]).padStart(3)}  ${d}`)
  console.log(`  合计 ${placed.length} 篇 · ${placed.reduce((n, p) => n + p.chars, 0).toLocaleString()} 字`)
}

main()
