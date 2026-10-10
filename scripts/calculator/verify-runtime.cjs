'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

function verify(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime-manifest.json'), 'utf8'))
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const data = fs.readFileSync(path.join(root, relative))
    if (data.length !== expected.bytes || crypto.createHash('sha256').update(data).digest('hex') !== expected.sha256) {
      throw new Error(`Calculator resource integrity failure: ${relative}; run python scripts/calculator/prepare_runtime.py`)
    }
  }
  const actual = []
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else actual.push(path.relative(root, file).split(path.sep).join('/'))
    }
  }
  walk(root)
  for (const relative of actual) {
    if (relative !== 'runtime-manifest.json' && !manifest.files[relative]) throw new Error(`Unexpected calculator resource: ${relative}`)
  }
  const check = spawnSync(path.join(root, 'python/python.exe'), ['-I', '-B', '-c',
    'import sympy, mpmath, importlib.util; assert sympy.__version__ == "1.14.0"; assert mpmath.__version__ == "1.3.0"; assert all(importlib.util.find_spec(n) is None for n in ("numpy", "matplotlib", "PySide6", "PyQt5", "PyQt6"))'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (check.error || check.status !== 0) throw new Error(`Calculator runtime check failed: ${check.error || check.stderr}`)
  return manifest
}
module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32' || context.arch !== 1) {
    throw new Error('Bundled calculator runtime supports Windows x64 only; supply a matching runtime before packaging another target')
  }
  verify(path.join(context.packager.projectDir, 'resources/clever-calculator'))
}
module.exports.verify = verify
if (require.main === module) {
  const root = path.resolve(__dirname, '../../resources/clever-calculator')
  const manifest = verify(root)
  console.log(`Calculator resources verified: ${Object.keys(manifest.files).length} files, ${manifest.totalBytes} bytes plus manifest`)
}
