/** Verifies Windows SAPI voice listing + WAV synthesis through lib/tts.cjs. */
const { app } = require('electron')
const tts = require('../electron/lib/tts.cjs')
const store = require('../electron/lib/store.cjs')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  store.setUserData(path.join(app.getPath('userData')))
  store.ensureDirs()
  let failed = 0
  const ok = (name, cond, extra = '') => {
    console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${extra}`}`)
    if (!cond) failed++
  }

  console.log('platform:', process.platform)
  const voices = await tts.listVoices()
  ok('voice listing returns an array', Array.isArray(voices))
  ok('at least one system voice installed', voices.length > 0, `${voices.length} voices`)
  console.log('  voices:', voices.map((v) => `${v.name}${v.lang ? ` (${v.lang})` : ''}`).join(' | ') || '(none)')
  const zh = voices.find((v) => /zh|Chinese|Huihui|Xiaoxiao|Kangkang|Yaoyao/i.test(`${v.name}${v.lang}`))
  ok('a Chinese voice is available', !!zh, 'Windows 中文语音包可能未安装')
  const voice = zh?.name || ''

  // --- synthesis to wav ---
  try {
    const file = await tts.synthesizeWav('你好，我是研来。这是一段测试语音。', { voice, rate: 1, volume: 1 })
    ok('synthesis produced a file', fs.existsSync(file), file)
    const st = fs.statSync(file)
    ok('wav is non-trivial in size', st.size > 4000, `${st.size} bytes`)
    const head = fs.readFileSync(file).slice(0, 12)
    ok('file has a RIFF/WAVE header', head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WAVE', head.toString('hex'))
    // a longer text must produce a longer file
    const f2 = await tts.synthesizeWav('你好。'.repeat(20), { voice, rate: 1, volume: 1 })
    ok('longer text yields a larger file', fs.statSync(f2).size > st.size, `${fs.statSync(f2).size} vs ${st.size}`)
    // rate must affect output
    const f3 = await tts.synthesizeWav('这是一段用于测试语速的句子。', { voice, rate: 1.8, volume: 1 })
    ok('faster rate yields a smaller file', fs.statSync(f3).size < fs.statSync(await tts.synthesizeWav('这是一段用于测试语速的句子。', { voice, rate: 0.8, volume: 1 })).size)
    tts.cleanupWav(file)
    tts.cleanupWav(f2)
    tts.cleanupWav(f3)
    ok('cleanup removes the temp wav', !fs.existsSync(file))
  } catch (e) {
    ok('synthesis', false, e.message)
  }

  // --- rate mapping ---
  ok('rate 1.0 maps to SAPI 0', tts.toSapiRate(1) === 0)
  ok('rate 2.0 maps to SAPI 10', tts.toSapiRate(2) === 10)
  ok('rate is clamped below 0.5', tts.toSapiRate(0.1) === -5)
  ok('rate is clamped above 2', tts.toSapiRate(5) === 10)

  console.log(failed ? `\n✗ ${failed} failed` : '\n✓ all tts checks passed')
  app.exit(failed ? 1 : 0)
})
