/**
 * Rasterise build/icon.svg into the PNG/ICO assets Electron and Windows need.
 *
 * Strategy: Chromium (through Electron) renders ONE 1024x1024 master PNG —
 * it is the only SVG engine guaranteed to be present (cairo/inkscape are not).
 * Pillow then does the downscaling with a proper Lanczos filter and assembles
 * the multi-resolution .ico. Downscaling a single high-res render gives much
 * cleaner small icons than asking the browser to lay out at 16px.
 *
 * Usage: npx electron scripts/make-icons.mjs    (or: npm run icon)
 */
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'build')
const svgPath = path.join(buildDir, 'icon.svg')
const masterPath = path.join(buildDir, 'icon-1024.png')

const MASTER = 1024

async function renderMaster() {
  const svg = fs.readFileSync(svgPath, 'utf8')
  const win = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: true, webSecurity: false },
  })
  try {
    // a data: URL avoids any file-protocol / path-escaping problems on Windows
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent;width:${MASTER}px;height:${MASTER}px;overflow:hidden}
      svg{display:block;width:${MASTER}px;height:${MASTER}px}
    </style></head><body>${svg}</body></html>`
    const url = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`
    await win.loadURL(url)
    // give the SVG layout/antialiasing a moment to settle
    await new Promise((r) => setTimeout(r, 600))
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: MASTER, height: MASTER })
    const png = image.toPNG()
    if (!png || png.length < 1000) throw new Error('capturePage returned an empty image')
    fs.writeFileSync(masterPath, png)
    return png.length
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

function deriveWithPillow() {
  const py = `
import sys
from PIL import Image
root = sys.argv[1]
master = Image.open(root + "/icon-1024.png").convert("RGBA")

def resize(size):
    return master.resize((size, size), Image.LANCZOS)

# Electron / general use
resize(512).save(root + "/icon.png")
resize(256).save(root + "/icon-256.png")
resize(128).save(root + "/icon-128.png")
resize(64).save(root + "/icon-64.png")
resize(48).save(root + "/icon-48.png")
resize(32).save(root + "/icon-32.png")
resize(24).save(root + "/icon-24.png")
resize(16).save(root + "/icon-16.png")

# tray icon: slightly padded so it does not touch the menu-bar edge
tray = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
inner = resize(26)
tray.paste(inner, (3, 3), inner)
tray.save(root + "/tray.png")

# multi-resolution Windows icon, ordered smallest -> largest
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [resize(s) for s in ico_sizes]
frames[-1].save(
    root + "/icon.ico",
    format="ICO",
    sizes=[(s, s) for s in ico_sizes],
    append_images=frames[:-1],
)

# a 512 JPEG is handy for docs / store listings
resize(512).convert("RGB").save(root + "/icon-preview.jpg", quality=92)
print("derived PNG sizes + icon.ico + tray.png + icon-preview.jpg")
`
  return execFileSync('python', ['-c', py, buildDir.replace(/\\/g, '/')], { encoding: 'utf8' })
}

async function main() {
  if (!fs.existsSync(svgPath)) {
    console.error('missing build/icon.svg')
    app.exit(1)
    return
  }
  await app.whenReady()
  const bytes = await renderMaster()
  console.log(`  ✓ icon-1024.png (${(bytes / 1024).toFixed(1)} KB)`)
  try {
    const out = deriveWithPillow()
    console.log('  ' + out.trim())
  } catch (e) {
    console.warn('  ! Pillow step failed:', e.message)
    console.warn('    icon-1024.png exists; run `python -m pip install pillow` then re-run.')
  }
  app.exit(0)
}

main().catch((e) => {
  console.error('icon generation failed:', e)
  app.exit(1)
})
