#!/usr/bin/env node
/**
 * Version bump helper implementing the project's versioning rule:
 *
 *   MAJOR . MID . PATCH     e.g. 1.0.00
 *
 *   patch  (最低位 +1)   small change  →  1.0.00 → 1.0.01
 *   minor  (第二位 +1)   large change  →  1.0.05 → 1.1.00
 *   major  (最高位 +1)   major change  →  1.4.02 → 2.0.00
 *
 * Lower digits reset to 00 when a higher digit is bumped.
 *
 * Usage:
 *   node scripts/bump-version.mjs patch [--dry]
 *   node scripts/bump-version.mjs minor
 *   node scripts/bump-version.mjs major
 *   node scripts/bump-version.mjs --show
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = {
  pkg: path.join(root, 'package.json'),
  prompts: path.join(root, 'src', 'lib', 'prompts.ts'),
  readme: path.join(root, 'README.md'),
}

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d{2})$/.exec(String(v).trim())
  if (!m) throw new Error(`version "${v}" does not match MAJOR.MINOR.PATCH(2 digits), e.g. 1.0.00`)
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

function format({ major, minor, patch }) {
  return `${major}.${minor}.${String(patch).padStart(2, '0')}`
}

function bump(v, kind) {
  const p = typeof v === 'string' ? parse(v) : { ...v }
  if (kind === 'patch') return format({ ...p, patch: p.patch + 1 })
  if (kind === 'minor') return format({ major: p.major, minor: p.minor + 1, patch: 0 })
  if (kind === 'major') return format({ major: p.major + 1, minor: 0, patch: 0 })
  throw new Error(`unknown bump kind "${kind}" (expected patch|minor|major)`)
}

function main() {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry')
  const pkg = JSON.parse(fs.readFileSync(files.pkg, 'utf8'))
  const current = pkg.version

  if (args.includes('--show') || args.length === 0) {
    console.log(`current version: ${current}`)
    console.log(`  patch → ${bump(current, 'patch')}   (小改动)`)
    console.log(`  minor → ${bump(current, 'minor')}   (大改动)`)
    console.log(`  major → ${bump(current, 'major')}   (重大改动)`)
    return
  }

  const kind = args.find((a) => ['patch', 'minor', 'major'].includes(a))
  if (!kind) {
    console.error('usage: node scripts/bump-version.mjs <patch|minor|major> [--dry]')
    process.exit(1)
  }

  const next = bump(current, kind)

  if (dry) {
    console.log(`${current} → ${next} (dry run)`)
    return
  }

  pkg.version = next
  fs.writeFileSync(files.pkg, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log(`package.json      ${current} → ${next}`)

  // keep APP_VERSION in the prompt module in sync
  if (fs.existsSync(files.prompts)) {
    const src = fs.readFileSync(files.prompts, 'utf8')
    const updated = src.replace(/(export const APP_VERSION = ')[^']+(')/, `$1${next}$2`)
    if (updated !== src) {
      fs.writeFileSync(files.prompts, updated, 'utf8')
      console.log(`prompts.ts        → ${next}`)
    }
  }

  // keep the version badge in the README in sync
  if (fs.existsSync(files.readme)) {
    const src = fs.readFileSync(files.readme, 'utf8')
    const updated = src.replace(/(version-)[\d.]+(-brightgreen)/, `$1${next}$2`)
    if (updated !== src) {
      fs.writeFileSync(files.readme, updated, 'utf8')
      console.log(`README.md         → ${next}`)
    }
  }

  console.log(`\n✓ bumped (${kind})`)
}

main()
