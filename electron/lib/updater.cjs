'use strict'

/**
 * Update checking against GitHub Releases.
 *
 * Why mirrors are the default: direct access to api.github.com is frequently
 * unreachable or throttled from mainland networks (verified on this machine —
 * direct requests time out entirely, and a plain proxy tunnel completes CONNECT
 * but never finishes the TLS handshake). Public GitHub accelerators reach the
 * same API reliably, so we try a list of them and fall back automatically.
 *
 * The check itself is read-only and needs no credentials. Every mirror is a
 * transparent prefix proxy: `${mirror}https://api.github.com/...`.
 */

const { net, session } = require('electron')

/* ------------------------------------------------------------------ */
/* networking                                                          */
/* ------------------------------------------------------------------ */
/**
 * Update requests run on their own session, and by default BYPASS the system
 * proxy.
 *
 * This is not a micro-optimisation — it is required for correctness. Measured
 * on the development machine: Electron's default session inherits the OS proxy
 * (a local Clash instance). When that proxy's upstream node is down, every
 * request dies with ERR_CONNECTION_CLOSED *even though the mirror is reachable
 * directly* — curl succeeded against the same URL while Electron failed. The
 * public GitHub mirrors are domestic-reachable, so going direct is both faster
 * and far more reliable.
 *
 * Users whose only route out is a working proxy can opt back in via
 * `update.useSystemProxy`.
 */
const UPDATE_PARTITION = 'persistent:yanlai-update'
let updateSession = null
let proxyConfiguredFor = null

function getUpdateSession(useSystemProxy) {
  if (!updateSession) updateSession = session.fromPartition(UPDATE_PARTITION)
  const want = useSystemProxy ? 'system' : 'direct'
  if (proxyConfiguredFor !== want) {
    // 'system' lets Chromium pick up the OS proxy; 'direct' bypasses it entirely
    updateSession.setProxy(want === 'system' ? { mode: 'system' } : { mode: 'direct' }).catch(() => {})
    proxyConfiguredFor = want
  }
  return updateSession
}

/**
 * Prefix proxies, tried in order.
 *
 * Only entries verified to actually proxy api.github.com belong here. Measured
 * on a mainland network: all four serve correct public release data, so they are
 * kept in order of observed reliability. The `direct` entry stays last as a
 * fallback for networks that can reach GitHub unaided.
 *
 * Note: these mirrors replace the Authorization header with their own account,
 * so they are usable for READS ONLY. Publishing a Release cannot go through
 * them — see .github/workflows/release.yml.
 */
const MIRROR_PRESETS = [
  { id: 'ghproxy', name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/', note: '长期稳定，推荐' },
  { id: 'ghfast', name: 'ghfast.top', prefix: 'https://ghfast.top/', note: '备用线路' },
  { id: 'llkk', name: 'gh.llkk.cc', prefix: 'https://gh.llkk.cc/', note: '备用线路 2' },
  { id: 'moeyy', name: 'github.moeyy.xyz', prefix: 'https://github.moeyy.xyz/', note: '备用线路 3' },
  { id: 'direct', name: 'GitHub 官方直连', prefix: '', note: '需要能直连 GitHub' },
]

/** Resolve the user's mirror choice into an ordered list of prefixes to try. */
function resolveMirrors(settings) {
  const cfg = settings?.update || {}
  const mode = cfg.source || 'mirror' // mirror | direct | custom
  if (mode === 'direct') return [{ id: 'direct', name: '官方直连', prefix: '' }]
  if (mode === 'custom' && cfg.customPrefix) {
    return [{ id: 'custom', name: '自定义', prefix: normalizePrefix(cfg.customPrefix) }]
  }
  // mirror mode: prefer the user's pick, then every other preset as fallback
  const preferred = MIRROR_PRESETS.filter((m) => m.id === (cfg.mirrorId || 'ghproxy'))
  const rest = MIRROR_PRESETS.filter((m) => m.id !== (cfg.mirrorId || 'ghproxy') && m.id !== 'direct')
  return [...preferred, ...rest]
}

function normalizePrefix(p) {
  const s = String(p || '').trim()
  if (!s) return ''
  // accept "gh-proxy.com", "https://gh-proxy.com", "https://gh-proxy.com/"
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`
  return withScheme.endsWith('/') ? withScheme : `${withScheme}/`
}

/* ------------------------------------------------------------------ */
/* version comparison                                                  */
/* ------------------------------------------------------------------ */
/**
 * Parse the project's version scheme: MAJOR.MINOR.PATCH where PATCH is two
 * digits (1.0.00). Also tolerates ordinary semver and a leading "v".
 * Returns null when the string is not a version we can reason about.
 */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** -1 | 0 | 1, comparing numeric parts (so 1.0.05 < 1.1.00 < 2.0.00). */
function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1
  }
  return 0
}

/* ------------------------------------------------------------------ */
/* HTTP with timeout                                                   */
/* ------------------------------------------------------------------ */
function fetchJson(url, { timeout = 12000, headers = {}, useSystemProxy = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      fn(arg)
    }
    let req
    try {
      const ses = getUpdateSession(useSystemProxy)
      req = net.request({ method: 'GET', url, redirect: 'follow', session: ses, useSessionCookies: false })
    } catch (e) {
      return reject(e)
    }
    const timer = setTimeout(() => {
      try {
        req.abort()
      } catch {}
      done(reject, new Error('请求超时'))
    }, timeout)

    req.setHeader('Accept', 'application/vnd.github+json')
    req.setHeader('User-Agent', 'Yanlai-Updater')
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)

    req.on('response', (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        clearTimeout(timer)
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return done(reject, Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode, body }))
        }
        try {
          done(resolve, JSON.parse(body))
        } catch (e) {
          done(reject, new Error('返回内容不是合法 JSON'))
        }
      })
      res.on('error', (e) => {
        clearTimeout(timer)
        done(reject, e)
      })
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      done(reject, e)
    })
    req.end()
  })
}

/* ------------------------------------------------------------------ */
/* checking                                                            */
/* ------------------------------------------------------------------ */
function parseRepo(settings) {
  const cfg = settings?.update || {}
  const slug = cfg.repo || 'Shikaraw/Yanlai'
  const [owner, name] = String(slug).split('/')
  return { owner, name, slug: `${owner}/${name}` }
}

/**
 * Query the latest release. Tries each mirror in turn and reports which one
 * worked, so the UI can show provenance and the user can trust the result.
 */
async function checkForUpdate(settings, currentVersion, opts = {}) {
  const { slug } = parseRepo(settings)
  const mirrors = resolveMirrors(settings)
  const attempts = []

  for (const m of mirrors) {
    const url = `${m.prefix}https://api.github.com/repos/${slug}/releases/latest`
    try {
      const data = await fetchJson(url, { timeout: opts.timeout || 12000, useSystemProxy: !!settings?.update?.useSystemProxy })
      const tag = String(data.tag_name || data.name || '').trim()
      const latest = tag.replace(/^v/i, '')
      const cmp = compareVersions(latest, currentVersion)
      return {
        ok: true,
        source: m.name,
        sourceId: m.id,
        repo: slug,
        currentVersion,
        latestVersion: latest,
        tagName: data.tag_name || `v${latest}`,
        hasUpdate: cmp > 0,
        releaseUrl: data.html_url || `https://github.com/${slug}/releases`,
        notes: String(data.body || '').slice(0, 8000),
        publishedAt: data.published_at || null,
        prerelease: !!data.prerelease,
        assets: (data.assets || []).map((a) => ({
          name: a.name,
          size: a.size,
          // browser_download_url is a github.com URL; route it through the mirror
          url: a.browser_download_url,
          mirrorUrl: m.prefix ? `${m.prefix}${a.browser_download_url}` : a.browser_download_url,
          downloadCount: a.download_count,
        })),
        attempts,
      }
    } catch (e) {
      attempts.push({ source: m.name, error: e.message || String(e), statusCode: e.statusCode })
    }
  }

  // Every mirror failed. 404 on the first one usually means "no releases yet",
  // which is a normal state for a fresh repo and must not look like an error.
  const noRelease = attempts.some((a) => a.statusCode === 404)
  return {
    ok: false,
    repo: slug,
    currentVersion,
    reason: noRelease ? 'no-release' : 'network',
    message: noRelease
      ? '仓库中还没有发布任何 Release。'
      : '无法连接到 GitHub（所有镜像均失败）。可在设置中切换更新源，或稍后重试。',
    attempts,
  }
}

/** Ask GitHub for all releases (used by the "version history" view). */
async function listReleases(settings, limit = 10) {
  const { slug } = parseRepo(settings)
  const mirrors = resolveMirrors(settings)
  for (const m of mirrors) {
    try {
      const data = await fetchJson(`${m.prefix}https://api.github.com/repos/${slug}/releases?per_page=${limit}`, { timeout: 12000, useSystemProxy: !!settings?.update?.useSystemProxy })
      if (!Array.isArray(data)) continue
      return {
        ok: true,
        source: m.name,
        releases: data.map((r) => ({
          tag: r.tag_name,
          name: r.name || r.tag_name,
          publishedAt: r.published_at,
          prerelease: r.prerelease,
          notes: String(r.body || '').slice(0, 4000),
          url: r.html_url,
          assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url, mirrorUrl: m.prefix ? `${m.prefix}${a.browser_download_url}` : a.browser_download_url })),
        })),
      }
    } catch {}
  }
  return { ok: false, releases: [] }
}

module.exports = {
  MIRROR_PRESETS,
  resolveMirrors,
  normalizePrefix,
  parseVersion,
  compareVersions,
  parseRepo,
  checkForUpdate,
  listReleases,
}
