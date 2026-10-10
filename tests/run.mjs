/**
 * Headless test runner.
 *
 * The suites import the library modules directly. Because the sources are
 * TypeScript and the tests run in plain Node, esbuild (already a Vite
 * dependency) bundles the libraries first, then the tests execute against the
 * bundles. No test framework needed — each suite exits non-zero on failure.
 *
 *   npm test
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'tests', '.build')
const suites = ['math.plot.test.mjs', 'kb.context.test.mjs', 'focus.test.mjs', 'planner.test.mjs', 'calculator-input.test.mjs']
const libs = ['mathplot', 'kb', 'context', 'util', 'focus', 'planner', 'calculator-input']

fs.rmSync(buildDir, { recursive: true, force: true })
fs.mkdirSync(buildDir, { recursive: true })

// use esbuild's JS API: it resolves the platform binary itself and avoids the
// Windows `.cmd` shell-escaping problem with execFileSync
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

console.log('building library bundles…')
for (const lib of libs) {
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'lib', `${lib}.ts`)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: path.join(buildDir, `${lib}.mjs`),
    logLevel: 'error',
  })
}

let failed = 0
for (const suite of suites) {
  fs.copyFileSync(path.join(root, 'tests', suite), path.join(buildDir, suite))
  console.log(`\n──────── ${suite} ────────`)
  try {
    execFileSync(process.execPath, [path.join(buildDir, suite)], { stdio: 'inherit', cwd: buildDir })
  } catch {
    failed++
  }
}

// Pure CommonJS scheduler suite runs directly against the main-process library.
for (const suite of ['planner-scheduler.test.cjs', 'plan-library.test.cjs', 'calculator.test.cjs']) {
  console.log(`\n──────── ${suite} ────────`)
  try {
    execFileSync(process.execPath, [path.join(root, 'tests', suite)], { stdio: 'inherit', cwd: root })
  } catch {
    failed++
  }
}

// These suites need Electron (docx/pdf export uses the Chromium print pipeline;
// TTS uses the main-process SAPI bridge), so they run through the electron binary.
for (const suite of ['export.test.cjs', 'tts.test.cjs', 'updater.test.cjs']) {
  console.log(`\n──────── ${suite} (electron) ────────`)
  const electronBin = require('electron')
  try {
    execFileSync(electronBin, [path.join(root, 'tests', suite)], { stdio: 'inherit', cwd: root })
  } catch {
    failed++
  }
}

console.log(failed ? `\n✗ ${failed} suite(s) failed` : '\n✓ all suites passed')
process.exit(failed ? 1 : 0)
