/** Verifies updater version parsing, comparison, mirror resolution, and parsing. */
const { app } = require('electron')
const u = require('../electron/lib/updater.cjs')

app.whenReady().then(() => {
  let failed = 0
  const ok = (name, cond, extra = '') => {
    console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${extra}`}`)
    if (!cond) failed++
  }

  console.log('== version parsing (two-digit patch scheme) ==')
  const p = (v) => JSON.stringify(u.parseVersion(v))
  ok('1.0.00 parses', p('1.0.00') === '{"major":1,"minor":0,"patch":0}', p('1.0.00'))
  ok('1.0.05 parses patch=5', u.parseVersion('1.0.05').patch === 5)
  ok('v1.2.34 strips leading v', u.parseVersion('v1.2.34').minor === 2)
  ok('plain semver 2.0.0 parses', u.parseVersion('2.0.0').major === 2)
  ok('garbage returns null', u.parseVersion('abc') === null)
  ok('empty returns null', u.parseVersion('') === null)

  console.log('\n== version comparison ==')
  const c = u.compareVersions
  ok('1.0.00 < 1.0.01', c('1.0.00', '1.0.01') < 0)
  ok('1.0.05 < 1.1.00 (minor beats patch)', c('1.0.05', '1.1.00') < 0, `${c('1.0.05', '1.1.00')}`)
  ok('1.4.02 < 2.0.00 (major wins)', c('1.4.02', '2.0.00') < 0)
  ok('2.0.00 > 1.99.99', c('2.0.00', '1.99.99') > 0)
  ok('1.0.00 == v1.0.00 (prefix ignored)', c('1.0.00', 'v1.0.00') === 0)
  ok('1.0.00 == 1.0.0 (digit padding irrelevant)', c('1.0.00', '1.0.0') === 0)
  ok('1.10.00 > 1.9.00 (numeric not lexical)', c('1.10.00', '1.9.00') > 0)
  ok('1.0.100 > 1.0.99', c('1.0.100', '1.0.99') > 0)

  console.log('\n== mirror resolution ==')
  const def = u.resolveMirrors({ update: {} })
  ok('default is mirror mode', def.length > 1)
  ok('default prefers ghproxy first', def[0].id === 'ghproxy', def[0].id)
  ok('fallback list excludes direct', !def.slice(0, 4).some((m) => m.id === 'direct'))
  const direct = u.resolveMirrors({ update: { source: 'direct' } })
  ok('direct mode yields exactly one entry', direct.length === 1 && direct[0].prefix === '', JSON.stringify(direct))
  const custom = u.resolveMirrors({ update: { source: 'custom', customPrefix: 'my.proxy.io' } })
  ok('custom prefix gets https:// and trailing slash', custom[0].prefix === 'https://my.proxy.io/', custom[0].prefix)
  const custom2 = u.resolveMirrors({ update: { source: 'custom', customPrefix: 'http://x.dev/' } })
  ok('custom keeps explicit http scheme', custom2[0].prefix === 'http://x.dev/', custom2[0].prefix)
  const alt = u.resolveMirrors({ update: { mirrorId: 'ghfast' } })
  ok('selected mirror is tried first', alt[0].id === 'ghfast', alt[0].id)

  console.log('\n== repo parsing ==')
  ok('default repo is Shikaraw/Yanlai', u.parseRepo({}).slug === 'Shikaraw/Yanlai', u.parseRepo({}).slug)
  ok('custom repo honoured', u.parseRepo({ update: { repo: 'a/b' } }).slug === 'a/b')

  console.log('\n== mirror presets sanity ==')
  ok('every preset has id/name/prefix', u.MIRROR_PRESETS.every((m) => m.id && m.name && typeof m.prefix === 'string'))
  ok('direct preset has empty prefix', u.MIRROR_PRESETS.find((m) => m.id === 'direct').prefix === '')
  ok('exactly one direct entry', u.MIRROR_PRESETS.filter((m) => m.id === 'direct').length === 1)

  // The network result is environment-dependent and must never fail the suite:
  // a CI runner outside China reaches a different mirror set, and an offline
  // machine reaches nothing. We assert the *shape* of the result, which is what
  // the app actually depends on.
  console.log('\n== live check (环境相关：只校验返回结构) ==')
  u.checkForUpdate({ update: { source: 'mirror', mirrorId: 'ghproxy' } }, '1.0.00', { timeout: 15000 })
    .then((res) => {
      if (res.ok) {
        console.log(`  ✓ 已连通 · 来源: ${res.source}`)
        console.log(`    repo=${res.repo} latest=${res.latestVersion} hasUpdate=${res.hasUpdate}`)
        console.log(`    assets=${res.assets.length}${res.assets.length ? ` (${res.assets.map((a) => `${a.name} ${(a.size / 1048576).toFixed(1)}MB`).join(', ')})` : ''}`)
        if (res.assets[0]) console.log(`    mirrorUrl=${res.assets[0].mirrorUrl}`)
      } else {
        console.log(`  ○ 未连通 (${res.reason}): ${res.message}`)
        console.log('    （离线 / 仓库无 Release / 镜像不可达时属预期，不计为失败）')
      }

      // structural contract — must hold whether or not the network worked
      ok('result reports currentVersion', res.currentVersion === '1.0.00', String(res.currentVersion))
      ok('result reports the repo slug', res.repo === 'Shikaraw/Yanlai', String(res.repo))
      ok('result has a boolean ok flag', typeof res.ok === 'boolean')
      if (res.ok) {
        ok('success carries a source name', !!res.source, String(res.source))
        ok('success carries a comparable version', typeof res.latestVersion === 'string')
        ok('success carries a boolean hasUpdate', typeof res.hasUpdate === 'boolean')
      } else {
        ok('failure explains itself', !!res.message && !!res.reason, JSON.stringify(res))
      }

      console.log(failed ? `\n✗ ${failed} failed` : '\n✓ all updater logic checks passed')
      app.exit(failed ? 1 : 0)
    })
})
