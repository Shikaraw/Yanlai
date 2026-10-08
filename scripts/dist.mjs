#!/usr/bin/env node
/**
 * Packaging entry point.
 *
 * Why this wrapper exists: the project versioning rule uses a two-digit patch
 * (`1.0.00`), which is deliberately NOT valid semver. electron-builder reads
 * `package.json#version` through a semver parser and silently normalises
 * `1.0.00` to `1.0.0`, so `${version}` in the artifact name would produce
 * filenames that disagree with the version the app displays.
 *
 * Fix: pass the un-normalised string through `APP_VERSION` and use
 * `${env.APP_VERSION}` in the artifact name template.
 *
 * Usage:
 *   npm run dist                 # current platform, nsis + portable on Windows
 *   npm run dist -- --mac        # extra args are forwarded to electron-builder
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version

// electron-builder fetches NSIS / 7z tooling from GitHub, which is frequently
// unreachable on mainland networks. Allow an override without editing config.
const mirror =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  process.env.npm_config_electron_builder_binaries_mirror ||
  'https://npmmirror.com/mirrors/electron-builder-binaries/'

const extra = process.argv.slice(2)
const args = ['electron-builder', ...(extra.length ? extra : ['--win', '--x64'])]

console.log(`packaging 研来 ${version}`)
console.log(`  electron-builder-binaries mirror: ${mirror}`)

const res = spawnSync('npx', args, {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, APP_VERSION: version, ELECTRON_BUILDER_BINARIES_MIRROR: mirror },
})

process.exit(res.status ?? 1)
