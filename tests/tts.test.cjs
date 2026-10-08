/**
 * Verifies Windows SAPI voice listing, synthesis, and the empty-output guard.
 *
 * Important: this suite must be environment-tolerant. A CI runner typically has
 * only English voices, so the audio assertions are made conditional on a
 * voice that can actually pronounce the test text. What is always asserted is
 * the *detection* logic — a header-only WAV must be reported as an error rather
 * than passed off as success, because SAPI itself raises nothing.
 */
const { app } = require('electron')
const tts = require('../electron/lib/tts.cjs')
const store = require('../electron/lib/store.cjs')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  store.setUserData(path.join(app.getPath('userData')))
  store.ensureDirs()
  let failed = 0
  let skipped = 0
  const ok = (name, cond, extra = '') => {
    console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${extra}`}`)
    if (!cond) failed++
  }
  const skip = (name, why) => {
    skipped++
    console.log(`  ○ ${name}（跳过：${why}）`)
  }

  console.log('platform:', process.platform)

  /* ---------------- voice listing ---------------- */
  const voices = await tts.listVoices()
  ok('voice listing returns an array', Array.isArray(voices))
  if (!tts.isWin) {
    console.log('  非 Windows，后续系统语音断言跳过')
  } else {
    ok('at least one system voice installed', voices.length > 0, `${voices.length} voices`)
  }
  console.log('  voices:', voices.map((v) => `${v.name}${v.lang ? ` (${v.lang})` : ''}`).join(' | ') || '(none)')

  const zh = voices.find((v) => /^zh|chinese|中文|huihui|xiaoxiao|yaoyao|kangkang/i.test(`${v.lang} ${v.name}`))
  if (zh) {
    ok('a Chinese voice is available', true)
  } else {
    skip('a Chinese voice is available', '本机未安装中文语音包（CI 环境常见）')
  }

  /* ---------------- CJK detection (pure logic, always asserted) ---------------- */
  ok('detects Chinese text', tts.hasCJK('你好，这是一段中文。'))
  ok('detects Japanese kana', tts.hasCJK('こんにちは'))
  ok('does not flag pure English', !tts.hasCJK('Hello, this is English.'))
  ok('does not flag digits/symbols', !tts.hasCJK('12345 +-= /*'))

  /* ---------------- voice picking ---------------- */
  const pickEn = await tts.pickVoiceForText('Hello world, this is a test.', '')
  ok('english text keeps the requested voice', pickEn.voice === '', `got "${pickEn.voice}"`)
  const pickZh = await tts.pickVoiceForText('这是一段中文测试。', '')
  if (zh) {
    ok('chinese text auto-selects the Chinese voice', pickZh.voice === zh.name, `got "${pickZh.voice}", expected "${zh.name}"`)
    ok('marks the substitution', pickZh.substituted === true || pickZh.voice === zh.name)
  } else {
    skip('chinese text auto-selects the Chinese voice', '无中文语音可选中')
    ok('reports that no Chinese voice exists', pickZh.noCJKVoice === true, JSON.stringify(pickZh))
  }
  // a deliberately wrong voice for Chinese text should be substituted when possible
  const pickOverride = await tts.pickVoiceForText('这是一段中文测试。', 'Microsoft David Desktop')
  if (zh) {
    ok('english voice is replaced for chinese text', pickOverride.voice === zh.name, `got "${pickOverride.voice}"`)
  } else {
    skip('english voice is replaced for chinese text', '无中文语音可替代')
  }

  /* ---------------- rate mapping ---------------- */
  ok('rate 1.0 maps to SAPI 0', tts.toSapiRate(1) === 0)
  ok('rate 2.0 maps to SAPI 10', tts.toSapiRate(2) === 10)
  ok('rate is clamped below 0.5', tts.toSapiRate(0.1) === -5)
  ok('rate is clamped above 2', tts.toSapiRate(5) === 10)

  /* ---------------- synthesis ---------------- */
  if (!tts.isWin) {
    skip('synthesis', '非 Windows')
  } else if (!zh) {
    // No Chinese voice: synthesis MUST fail loudly rather than return silence.
    console.log('  （无中文语音，验证「空音频必须报错」而非静默成功）')
    let errMsg = ''
    try {
      const f = await tts.synthesizeWav('你好，我是研来。这是一段测试语音。', { voice: '', rate: 1, volume: 1 })
      // if it somehow succeeded, it must at least contain real audio
      const size = fs.statSync(f).size
      ok('no Chinese voice ⇒ either errors or produces real audio', size > 1024, `silently returned ${size} bytes`)
      tts.cleanupWav(f)
    } catch (e) {
      errMsg = String(e.message || e)
      ok('empty synthesis is reported as an error', true)
      ok('error message is actionable (mentions how to fix)', /语音包|音色|设置/.test(errMsg), errMsg)
      console.log(`    → ${errMsg}`)
    }
  } else {
    try {
      const file = await tts.synthesizeWav('你好，我是研来。这是一段测试语音。', { voice: zh.name, rate: 1, volume: 1 })
      ok('synthesis produced a file', fs.existsSync(file), file)
      const st = fs.statSync(file)
      ok('wav contains real audio (not header-only)', st.size > 4096, `${st.size} bytes`)
      const head = fs.readFileSync(file).slice(0, 12)
      ok('file has a RIFF/WAVE header', head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WAVE', head.toString('hex'))

      const f2 = await tts.synthesizeWav('你好。'.repeat(20), { voice: zh.name, rate: 1, volume: 1 })
      ok('longer text yields a larger file', fs.statSync(f2).size > st.size, `${fs.statSync(f2).size} vs ${st.size}`)

      const slow = await tts.synthesizeWav('这是一段用于测试语速的句子。', { voice: zh.name, rate: 0.8, volume: 1 })
      const fast = await tts.synthesizeWav('这是一段用于测试语速的句子。', { voice: zh.name, rate: 1.8, volume: 1 })
      ok('faster rate yields a smaller file', fs.statSync(fast).size < fs.statSync(slow).size, `${fs.statSync(fast).size} vs ${fs.statSync(slow).size}`)

      tts.cleanupWav(file)
      tts.cleanupWav(f2)
      tts.cleanupWav(slow)
      tts.cleanupWav(fast)
      ok('cleanup removes the temp wav', !fs.existsSync(file))
    } catch (e) {
      ok('synthesis', false, e.message)
    }
  }

  console.log(`\n${failed ? '✗' : '✓'} ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`)
  app.exit(failed ? 1 : 0)
})
