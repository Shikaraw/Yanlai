import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { useData } from '../store/useData'
import { useChat, estimateSavedTokens } from '../store/useChat'
import { Icon } from '../components/Icons'
import { Field, Modal, Segmented, SettingRow, Switch } from '../components/ui'
import { bridge } from '../lib/bridge'
import { listModels, testConnection } from '../lib/llm'
import { speech } from '../lib/tts'
import { storageEstimate } from '../lib/idb'
import { APP_VERSION, SUBJECTS } from '../lib/prompts'
import { clsx, fmtBytes } from '../lib/util'
import { REASON_CATEGORIES } from '../lib/types'
import { UpdatePanel } from './UpdatePanel'

const TABS = [
  { id: 'model', label: '模型与 API', icon: 'cpu' },
  { id: 'tts', label: '朗读', icon: 'volume' },
  { id: 'workspace', label: '工作区', icon: 'folder' },
  { id: 'agent', label: '辅导行为', icon: 'brain' },
  { id: 'tokens', label: '省 token', icon: 'zap' },
  { id: 'memory', label: '记忆与错题', icon: 'target' },
  { id: 'planner', label: '提醒', icon: 'bell' },
  { id: 'appearance', label: '外观', icon: 'palette' },
  { id: 'data', label: '数据', icon: 'database' },
  { id: 'update', label: '检查更新', icon: 'download' },
  { id: 'about', label: '关于', icon: 'info' },
] as const

export function SettingsView() {
  const app = useApp()
  const [tab, setTab] = useState<string>(app.settingsTab || 'model')

  useEffect(() => {
    setTab(app.settingsTab || 'model')
  }, [app.settingsTab])

  const settings = app.settings
  if (!settings) return null

  return (
    <>
      <div className="panel-head">
        <Icon.settings size={19} style={{ color: 'var(--accent)' }} />
        <div className="grow">
          <h1>设置</h1>
          <div className="sub">所有配置保存在本机，API Key 仅存于本地文件，不会上传</div>
        </div>
      </div>

      <div className="panel-body">
        <div className="settings-layout">
          <div className="settings-nav">
            {TABS.map((t) => {
              const I = Icon[t.icon]
              return (
                <button key={t.id} className={clsx(tab === t.id && 'active')} onClick={() => setTab(t.id)}>
                  <I size={15} />
                  {t.label}
                </button>
              )
            })}
          </div>

          <div className="scroll-y">
            {tab === 'model' ? <ModelTab /> : null}
            {tab === 'tts' ? <TtsTab /> : null}
            {tab === 'workspace' ? <WorkspaceTab /> : null}
            {tab === 'agent' ? <AgentTab /> : null}
            {tab === 'tokens' ? <TokensTab /> : null}
            {tab === 'memory' ? <MemoryTab /> : null}
            {tab === 'planner' ? <PlannerTab /> : null}
            {tab === 'appearance' ? <AppearanceTab /> : null}
            {tab === 'data' ? <DataTab /> : null}
            {tab === 'update' ? <UpdatePanel /> : null}
            {tab === 'about' ? <AboutTab /> : null}
          </div>
        </div>
      </div>
    </>
  )
}

/* ================================================================== */
/* model                                                              */
/* ================================================================== */
function ModelTab() {
  const app = useApp()
  const p = app.settings.provider
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string; models?: string[] } | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [showKey, setShowKey] = useState(false)

  const save = (patch: any) => app.patchSettings({ provider: patch }, { silent: true })

  const doTest = async () => {
    setTesting(true)
    setTestResult(null)
    setModels([])
    try {
      const r = await testConnection(p.baseUrl, p.apiKey, p.model)
      setTestResult({
        ok: true,
        msg: `连接成功（${r.ms}ms）${r.modelFound === false ? '，但未在模型列表中找到该模型名，请核对' : ''}`,
        models: r.models || undefined,
      })
      if (r.models) setModels(r.models)
    } catch (e: any) {
      setTestResult({ ok: false, msg: String(e?.message || e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="settings-section">
      <SettingRow
        title="服务预设"
        desc="一键填入常见服务商的接口地址。本地 Ollama / vLLM 等兼容接口同样适用。"
      >
        <select
          className="select"
          style={{ width: 210 }}
          value={p.presetId || ''}
          onChange={(e) => {
            const preset = (app.settings.presets || []).find((x: any) => x.id === e.target.value)
            if (preset) save({ presetId: preset.id, baseUrl: preset.baseUrl, model: preset.model })
          }}
        >
          <option value="">自定义</option>
          {(app.settings.presets || []).map((x: any) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </SettingRow>

      <Field label="Base URL" hint="需指向兼容 OpenAI 的接口根路径，通常以 /v1 结尾，例如 https://api.deepseek.com/v1">
        <input className="input" value={p.baseUrl} onChange={(e) => save({ baseUrl: e.target.value, presetId: '' })} placeholder="https://api.deepseek.com/v1" />
      </Field>

      <Field label="API Key" hint="仅保存在本机配置文件（userData/settings.json）。若使用本地模型可留空。">
        <div className="input-group">
          <input
            className="input"
            type={showKey ? 'text' : 'password'}
            value={p.apiKey}
            onChange={(e) => save({ apiKey: e.target.value })}
            placeholder="sk-..."
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn" onClick={() => setShowKey(!showKey)} title={showKey ? '隐藏' : '显示'}>
            <Icon.eye size={15} />
          </button>
        </div>
      </Field>

      <Field label="模型名称" hint="如 deepseek-chat、deepseek-reasoner、gpt-4o、qwen-plus、qwen2.5:7b">
        <div className="input-group">
          <input className="input" value={p.model} onChange={(e) => save({ model: e.target.value })} placeholder="deepseek-chat" list="yanlai-models" />
          <datalist id="yanlai-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button
            className="btn"
            title="从服务端拉取可用模型列表"
            onClick={async () => {
              try {
                const list = await listModels(p.baseUrl, p.apiKey)
                setModels(list)
                app.toast({ kind: 'success', title: `获取到 ${list.length} 个模型`, body: '点击模型名输入框可下拉选择。' })
              } catch (e: any) {
                app.toast({ kind: 'error', title: '获取失败', body: String(e?.message || e) })
              }
            }}
          >
            <Icon.refresh size={15} />
          </button>
        </div>
      </Field>

      <div className="row" style={{ gap: 9 }}>
        <button className="btn primary" onClick={doTest} disabled={testing || !p.baseUrl}>
          {testing ? (
            <>
              <span className="tc-spin" style={{ display: 'grid', placeItems: 'center' }}>
                <Icon.refresh size={15} />
              </span>
              测试中…
            </>
          ) : (
            <>
              <Icon.zap size={15} />
              测试连接
            </>
          )}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          测试只请求一次模型列表，不消耗生成额度
        </span>
      </div>

      {testResult ? (
        <div className={clsx('card', testResult.ok ? '' : '')} style={{ borderColor: testResult.ok ? 'color-mix(in srgb, var(--ok) 40%, transparent)' : 'color-mix(in srgb, var(--err) 40%, transparent)' }}>
          <div className="row" style={{ gap: 9 }}>
            {testResult.ok ? <Icon.check size={16} style={{ color: 'var(--ok)' }} /> : <Icon.alert size={16} style={{ color: 'var(--err)' }} />}
            <span style={{ fontSize: 13 }}>{testResult.msg}</span>
          </div>
          {testResult.models?.length ? (
            <div className="row wrap" style={{ gap: 5, marginTop: 10, maxHeight: 130, overflow: 'auto' }}>
              {testResult.models.slice(0, 40).map((m) => (
                <button key={m} className={clsx('chip', m === p.model && 'accent')} style={{ cursor: 'pointer' }} onClick={() => save({ model: m })}>
                  {m}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <div className="card-title">
          <Icon.terminal size={15} />
          生成参数
        </div>
        <div className="card-sub">大多数学科问答建议温度 0.3~0.7：太低会死板，太高会不稳定。</div>
        <div className="col" style={{ gap: 15 }}>
          <div>
            <div className="row between" style={{ fontSize: 12.5, marginBottom: 5 }}>
              <span>温度（temperature，创造性）</span>
              <b className="tnum">{Number(p.temperature ?? 0.6).toFixed(2)}</b>
            </div>
            <input className="slider" type="range" min={0} max={1.5} step={0.05} value={p.temperature ?? 0.6} onChange={(e) => save({ temperature: Number(e.target.value) })} />
            <div className="row between muted" style={{ fontSize: 11 }}>
              <span>严谨（数学证明）</span>
              <span>灵活（作文思路）</span>
            </div>
          </div>
          <div>
            <div className="row between" style={{ fontSize: 12.5, marginBottom: 5 }}>
              <span>单次最大输出 tokens</span>
              <b className="tnum">{p.maxTokens || 8192}</b>
            </div>
            <input className="slider" type="range" min={1024} max={32768} step={512} value={p.maxTokens || 8192} onChange={(e) => save({ maxTokens: Number(e.target.value) })} />
            <div className="field-hint">整卷、长讲义需要较大的值。若服务端上限更低会报错，可适当调小。</div>
          </div>
          <div>
            <div className="row between" style={{ fontSize: 12.5, marginBottom: 5 }}>
              <span>top_p（采样范围）</span>
              <b className="tnum">{Number(p.topP ?? 1).toFixed(2)}</b>
            </div>
            <input className="slider" type="range" min={0.1} max={1} step={0.05} value={p.topP ?? 1} onChange={(e) => save({ topP: Number(e.target.value) })} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Icon.eye size={15} />
          视觉能力（看图讲题）
        </div>
        <div className="card-sub">
          开启后可直接粘贴题目截图、拍照图片，由模型读取图片内容。需要所选模型支持视觉输入（如 gpt-4o、qwen-vl、glm-4v）。
        </div>
        <SettingRow title="允许发送图片" desc="关闭后粘贴的图片只会以文件名形式告知模型。">
          <Switch checked={app.settings.vision?.enabled !== false} onChange={(v) => app.patchSettings({ vision: { enabled: v } }, { silent: true })} />
        </SettingRow>
      </div>

      <div className="card">
        <div className="card-title">
          <Icon.book size={15} />
          默认备考科目
        </div>
        <div className="card-sub">新建对话时会带上该科目，让术语与答题规范更贴合。</div>
        <select
          className="select"
          value={app.settings.study?.subject || ''}
          onChange={(e) => app.patchSettings({ study: { subject: e.target.value } }, { silent: true })}
        >
          <option value="">不指定</option>
          {SUBJECTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

/* ================================================================== */
/* tts                                                                */
/* ================================================================== */
function TtsTab() {
  const app = useApp()
  const t = app.settings.tts
  const [voices, setVoices] = useState<Array<{ name: string; lang?: string; gender?: string }>>([])
  const [loading, setLoading] = useState(false)
  const [previewing, setPreviewing] = useState(false)

  const save = (patch: any) => app.patchSettings({ tts: patch }, { silent: true })

  const loadVoices = async () => {
    setLoading(true)
    try {
      if (t.engine === 'system') {
        const v = await speech.listSystemVoices()
        setVoices(v)
        if (!v.length) app.toast({ kind: 'warn', title: '未检测到系统语音', body: 'Windows 可在「设置 → 时间和语言 → 语音」中安装中文语音包。' })
      } else {
        const v = speech.listBrowserVoices().map((x) => ({ name: x.name, lang: x.lang }))
        setVoices(v)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadVoices()
  }, [t.engine])

  const preview = async () => {
    setPreviewing(true)
    speech.configure({
      engine: t.engine === 'off' ? 'system' : t.engine,
      autoRead: 'off',
      voice: t.voice,
      rate: t.rate,
      pitch: t.pitch,
      volume: t.volume,
      api: t.api,
    })
    speech.speakNow('你好，我是研来。这里是朗读效果试听，接下来我为你讲解这道极限题。')
    setTimeout(() => setPreviewing(false), 2500)
  }

  return (
    <div className="settings-section">
      <SettingRow title="朗读引擎" desc="系统朗读免费离线；API 朗读音质更好但会产生费用；浏览器朗读用于网页预览环境。">
        <select className="select" style={{ width: 210 }} value={t.engine} onChange={(e) => save({ engine: e.target.value })}>
          <option value="off">关闭</option>
          <option value="system">系统内置语音（Windows SAPI，离线免费）</option>
          <option value="api">自定义 TTS API（OpenAI 兼容 /audio/speech）</option>
          <option value="browser">浏览器语音合成（Web Speech）</option>
        </select>
      </SettingRow>

      <SettingRow
        title="自动朗读"
        desc="「边输出边朗读」会在句子生成完后立即开始，延迟最低；「输出完朗读」等整段结束后再读。"
      >
        <Segmented
          value={t.autoRead}
          onChange={(v) => save({ autoRead: v })}
          options={[
            { value: 'off', label: '关闭' },
            { value: 'stream', label: '边输出边朗读' },
            { value: 'after', label: '输出完朗读' },
          ]}
        />
      </SettingRow>

      {t.engine === 'api' ? (
        <div className="card">
          <div className="card-title">
            <Icon.volume size={15} />
            TTS API 配置
          </div>
          <div className="col" style={{ gap: 13 }}>
            <Field label="Base URL" hint="例如 https://api.openai.com/v1 或本地 GPT-SoVITS / edge-tts 服务的兼容地址">
              <input className="input" value={t.api.baseUrl} onChange={(e) => save({ api: { ...t.api, baseUrl: e.target.value } })} placeholder="https://api.openai.com/v1" />
            </Field>
            <Field label="API Key">
              <input className="input" type="password" value={t.api.apiKey} onChange={(e) => save({ api: { ...t.api, apiKey: e.target.value } })} placeholder="sk-..." autoComplete="off" />
            </Field>
            <div className="row" style={{ gap: 12 }}>
              <Field label="模型">
                <input className="input" value={t.api.model} onChange={(e) => save({ api: { ...t.api, model: e.target.value } })} placeholder="tts-1" />
              </Field>
              <Field label="音色">
                <input className="input" value={t.api.voice} onChange={(e) => save({ api: { ...t.api, voice: e.target.value } })} placeholder="alloy / zh-CN-XiaoxiaoNeural" />
              </Field>
              <Field label="格式">
                <select className="select" value={t.api.format} onChange={(e) => save({ api: { ...t.api, format: e.target.value } })}>
                  {['mp3', 'wav', 'opus', 'aac', 'flac'].map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
        </div>
      ) : null}

      {t.engine === 'system' || t.engine === 'browser' ? (
        <div className="card">
          <div className="card-title">
            <Icon.volume size={15} />
            音色选择
          </div>
          <div className="card-sub">
            {t.engine === 'system' ? '来自 Windows 已安装的语音包（含离线中文语音）。' : '来自浏览器的可用语音列表。'}
          </div>
          <div className="row" style={{ gap: 9 }}>
            <select className="select grow" value={t.voice} onChange={(e) => save({ voice: e.target.value })}>
              <option value="">系统默认音色</option>
              {voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name}
                  {v.lang ? ` · ${v.lang}` : ''}
                  {v.gender ? ` · ${v.gender}` : ''}
                </option>
              ))}
            </select>
            <button className="btn" onClick={loadVoices} disabled={loading}>
              {loading ? '检测中…' : '重新检测'}
            </button>
          </div>
          {!voices.length && !loading ? (
            <div className="field-hint" style={{ marginTop: 8 }}>
              Windows 可安装更多语音：设置 → 时间和语言 → 语音 → 管理语音。中文语音包（如 Microsoft Xiaoxiao）安装后即可在此选择。
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <div className="card-title">
          <Icon.settings size={15} />
          语速与音量
        </div>
        <div className="col" style={{ gap: 15 }}>
          <div>
            <div className="row between" style={{ fontSize: 12.5, marginBottom: 5 }}>
              <span>语速</span>
              <b className="tnum">{Number(t.rate).toFixed(2)}×</b>
            </div>
            <input className="slider" type="range" min={0.5} max={2} step={0.05} value={t.rate} onChange={(e) => save({ rate: Number(e.target.value) })} />
          </div>
          <div>
            <div className="row between" style={{ fontSize: 12.5, marginBottom: 5 }}>
              <span>音量</span>
              <b className="tnum">{Math.round(Number(t.volume) * 100)}%</b>
            </div>
            <input className="slider" type="range" min={0} max={1} step={0.05} value={t.volume} onChange={(e) => save({ volume: Number(e.target.value) })} />
          </div>
          {t.engine === 'browser' ? (
            <div>
              <div className="row between" style={{ fontSize: 12.5, marginBottom: 5 }}>
                <span>音调</span>
                <b className="tnum">{Number(t.pitch).toFixed(2)}</b>
              </div>
              <input className="slider" type="range" min={0.5} max={2} step={0.05} value={t.pitch} onChange={(e) => save({ pitch: Number(e.target.value) })} />
            </div>
          ) : null}
          <div className="row" style={{ gap: 9 }}>
            <button className="btn" onClick={preview} disabled={previewing || t.engine === 'off'}>
              <Icon.play size={14} />
              {previewing ? '试听中…' : '试听'}
            </button>
            <button className="btn ghost" onClick={() => speech.stop()}>
              <Icon.stop size={14} />
              停止
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              朗读会自动跳过代码块、公式用中文读法（如 \frac 读作「分之」）
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ================================================================== */
/* workspace                                                          */
/* ================================================================== */
function WorkspaceTab() {
  const app = useApp()
  const [paths, setPaths] = useState<any>(null)
  const [files, setFiles] = useState<Array<{ name: string; size: number; mtime: number }>>([])

  const ws = app.settings.workspace

  useEffect(() => {
    void bridge.paths.info().then(setPaths)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (ws) bridge.fs.listDir(ws).then((r) => !cancelled && setFiles(r))
    return () => {
      cancelled = true
    }
  }, [ws])

  return (
    <div className="settings-section">
      <SettingRow
        title="工作区目录"
        desc="AI 生成的所有文件（讲义、试卷、图像、导出文档）都会保存到这里，AI 也能读取这里的资料。"
        stack
      >
        <div className="row" style={{ gap: 9 }}>
          <input className="input grow mono" value={ws || ''} readOnly placeholder="尚未设置" />
          <button
            className="btn primary"
            onClick={async () => {
              const dir = await bridge.dialog.openFolder({ title: '选择工作区目录', defaultPath: ws })
              if (dir) {
                await app.patchSettings({ workspace: dir })
                app.toast({ kind: 'success', title: '工作区已设置', body: dir })
              }
            }}
          >
            <Icon.folder size={15} />
            选择目录
          </button>
          <button className="btn" onClick={() => bridge.shell.openPath(ws)} disabled={!ws}>
            <Icon.external size={15} />
            打开
          </button>
        </div>
      </SettingRow>

      {!ws ? (
        <SettingRow title="使用默认工作区" desc={`未设置时可使用应用数据目录下的 workspace：${paths?.defaultWorkspace || ''}`}>
          <button className="btn" onClick={() => app.patchSettings({ workspace: paths?.defaultWorkspace })} disabled={!paths}>
            使用默认
          </button>
        </SettingRow>
      ) : null}

      <div className="card">
        <div className="card-title">
          <Icon.folder size={15} />
          当前目录内容
        </div>
        <div className="card-sub">{files.length} 个文件 / 文件夹</div>
        {files.length ? (
          <div className="col" style={{ gap: 4, maxHeight: 280, overflow: 'auto' }}>
            {files.slice(0, 60).map((f: any) => (
              <div className="row between" key={f.path || f.name} style={{ fontSize: 12.5, padding: '3px 0' }}>
                <span className="row center" style={{ gap: 7, minWidth: 0 }}>
                  {f.isDir ? <Icon.folder size={14} /> : <Icon.file size={14} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                </span>
                <span className="muted" style={{ flex: '0 0 auto' }}>
                  {f.isDir ? '—' : fmtBytes(f.size)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12.5 }}>目录为空，或尚未设置工作区。</div>
        )}
      </div>

      <div className="grid two">
        {paths ? (
          <>
            <SettingRow title="数据目录" desc="设置、对话、知识库索引、错题本等存放位置" stack>
              <div className="row" style={{ gap: 7 }}>
                <input className="input mono grow" value={paths.userData} readOnly style={{ fontSize: 11.5 }} />
                <button className="btn ghost icon sm" onClick={() => bridge.shell.openPath(paths.userData)}>
                  <Icon.external size={14} />
                </button>
              </div>
            </SettingRow>
            <SettingRow title="导出目录" desc="未指定路径时文档导出的默认位置" stack>
              <div className="row" style={{ gap: 7 }}>
                <input className="input mono grow" value={paths.defaultExports} readOnly style={{ fontSize: 11.5 }} />
                <button className="btn ghost icon sm" onClick={() => bridge.shell.openPath(paths.defaultExports)}>
                  <Icon.external size={14} />
                </button>
              </div>
            </SettingRow>
          </>
        ) : null}
      </div>
    </div>
  )
}

/* ================================================================== */
/* agent                                                              */
/* ================================================================== */
function AgentTab() {
  const app = useApp()
  const a = app.settings.agent
  const save = (patch: any) => app.patchSettings({ agent: patch }, { silent: true })

  return (
    <div className="settings-section">
      <SettingRow title="启用工具调用" desc="关闭后 AI 只能用文字回答，无法绘图、导出文档、检索知识库或记录错题。">
        <Switch checked={a.toolsEnabled !== false} onChange={(v) => save({ toolsEnabled: v })} />
      </SettingRow>

      <SettingRow title="自动检索知识库" desc="提问时在本地检索资料并随请求发送（不额外消耗 token）。关闭后 AI 只在你明确要求时才检索。">
        <Switch checked={a.autoKnowledgeSearch !== false} onChange={(v) => save({ autoKnowledgeSearch: v })} />
      </SettingRow>

      <SettingRow title="单轮最多工具调用轮数" desc="数值越大能完成更复杂的多步任务（如先检索、再绘图、再导出），但也会消耗更多 token。">
        <div className="row center" style={{ gap: 9 }}>
          <input
            className="input"
            type="number"
            min={0}
            max={8}
            style={{ width: 76 }}
            value={a.maxToolRounds ?? 4}
            onChange={(e) => save({ maxToolRounds: Math.max(0, Math.min(8, Number(e.target.value) || 0)) })}
          />
          <span className="muted" style={{ fontSize: 12 }}>轮</span>
        </div>
      </SettingRow>

      <SettingRow title="自定义系统提示词" desc="追加在你的偏好之上，用于补充个性化要求（例如「解释时多用工程类比」「不要省略推导步骤」）。默认内建的考研教学规范优先级更高。">
        <span />
      </SettingRow>
      <textarea
        className="textarea"
        rows={6}
        value={a.systemPromptExtra || ''}
        onChange={(e) => save({ systemPromptExtra: e.target.value })}
        placeholder="例如：我在准备跨专业考研，基础薄弱，请尽量补充前置知识；公式推导请不要跳步。"
      />

      <div className="card">
        <div className="card-title">
          <Icon.info size={15} />
          内建教学职责
        </div>
        <div className="card-sub">以下能力已内置，无需额外配置：</div>
        <div className="col" style={{ gap: 6, fontSize: 12.5 }}>
          {[
            '讲题先讲思路来源，再分步推导，最后给同源变式题',
            '错题自动定位错误步骤、归类错因、写入错题本',
            '函数图像、几何关系自动调用绘图能力',
            '按考研真题题型出整卷（含答案、解析、考点分布表）',
            '讲义、试卷、大纲可导出 Word / PDF / Excel / Markdown',
            '知识点自动整理并生成背诵卡片，进入遗忘曲线复习',
            '回答引用知识库资料时标注出处',
          ].map((x) => (
            <div className="row" key={x} style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon.check size={13} style={{ color: 'var(--ok)', flex: '0 0 auto', marginTop: 3 }} />
              <span>{x}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ================================================================== */
/* tokens                                                             */
/* ================================================================== */
function TokensTab() {
  const app = useApp()
  const data = useData()
  const chat = useChat()
  const t = app.settings.tokens
  const save = (patch: any) => app.patchSettings({ tokens: patch }, { silent: true })

  const savedTokens = useMemo(() => estimateSavedTokens(chat.sessions), [chat.sessions])
  const totalSessionTokens = useMemo(() => chat.sessions.reduce((n, s) => n + (s.sessionTokens || 0), 0), [chat.sessions])

  return (
    <div className="settings-section">
      <div className="card" style={{ borderColor: 'var(--accent-line)' }}>
        <div className="row between">
          <div>
            <div className="card-title">
              <Icon.zap size={15} style={{ color: 'var(--accent)' }} />
              省 token 总开关
            </div>
            <div className="card-sub" style={{ marginBottom: 0 }}>
              关掉后对话会发送完整历史与全部图片，回答更连贯但花费显著增加。
            </div>
          </div>
          <Switch checked={t.savingEnabled !== false} onChange={(v) => save({ savingEnabled: v })} />
        </div>
      </div>

      <div className="grid three">
        <div className="stat-tile">
          <div className="k">累计消耗 token</div>
          <div className="v">{totalSessionTokens.toLocaleString()}</div>
          <div className="d">按服务端返回的真实用量统计</div>
        </div>
        <div className="stat-tile">
          <div className="k">已压缩内容</div>
          <div className="v" style={{ color: 'var(--ok)' }}>~{savedTokens.toLocaleString()}</div>
          <div className="d">被摘要替代的旧消息估算量</div>
        </div>
        <div className="stat-tile">
          <div className="k">本地检索节省</div>
          <div className="v">{data.kbIndex?.size || 0}</div>
          <div className="d">知识库片段按需注入，不重复发送</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Icon.cpu size={15} />
          五项省 token 机制
        </div>
        <div className="card-sub">全部在本机完成，不改变你看到的界面内容。</div>
        <div className="col" style={{ gap: 10, fontSize: 12.5 }}>
          {[
            ['知识库按需注入', '检索结果只存在于当轮请求中，不写回历史。40 轮对话只付一次检索的代价。'],
            ['图片自动衰减', '只有最近几轮的截图会真的发送图片数据，更早的图片替换为文字占位符。'],
            ['工具输出摘要化', '超出近期窗口的工具原始返回会压缩成一行摘要，保留生成的文件引用。'],
            ['本地抽取式摘要', '旧对话用本地算法提取标题与核心句，不调用付费摘要接口。'],
            ['历史轮数上限', '超出设定轮数的对话自动进入摘要区，而不是整段保留。'],
          ].map(([title, desc]) => (
            <div key={title} className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
              <Icon.check size={13} style={{ color: 'var(--accent)', flex: '0 0 auto', marginTop: 3 }} />
              <span>
                <b>{title}</b>
                <span className="muted"> — {desc}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <SettingRow title="保留完整细节的最近轮数" desc="更早的对话会被本地摘要替代。10 轮通常足够保持上下文连贯。">
        <div className="row center" style={{ gap: 9 }}>
          <input className="input" type="number" min={2} max={40} style={{ width: 76 }} value={t.historyRounds ?? 10} onChange={(e) => save({ historyRounds: Math.max(2, Math.min(40, Number(e.target.value) || 10)) })} />
          <span className="muted" style={{ fontSize: 12 }}>轮</span>
        </div>
      </SettingRow>

      <SettingRow title="检索片段数量上限" desc="每次自动检索最多带几段资料。4 段通常覆盖一个考点。">
        <div className="row center" style={{ gap: 9 }}>
          <input className="input" type="number" min={1} max={10} style={{ width: 76 }} value={t.kbTopK ?? 4} onChange={(e) => save({ kbTopK: Math.max(1, Math.min(10, Number(e.target.value) || 4)) })} />
          <span className="muted" style={{ fontSize: 12 }}>段</span>
        </div>
      </SettingRow>

      <SettingRow title="检索片段字符预算" desc="注入的资料总长度上限。过大容易淹没问题本身。">
        <div className="row center" style={{ gap: 9 }}>
          <input className="input" type="number" min={800} max={12000} step={200} style={{ width: 96 }} value={t.kbCharBudget ?? 3200} onChange={(e) => save({ kbCharBudget: Math.max(800, Math.min(12000, Number(e.target.value) || 3200)) })} />
          <span className="muted" style={{ fontSize: 12 }}>字符</span>
        </div>
      </SettingRow>

      <SettingRow title="淘汰旧图片" desc="把超出近期窗口的截图替换为文字说明，保留模型已提取的信息。">
        <Switch checked={t.stripOldImages !== false} onChange={(v) => save({ stripOldImages: v })} />
      </SettingRow>

      <SettingRow title="摘要化旧工具输出" desc="绘图、检索、计算的原始返回会压缩成一行摘要。">
        <Switch checked={t.stripOldTools !== false} onChange={(v) => save({ stripOldTools: v })} />
      </SettingRow>

      <div className="card">
        <div className="card-title">
          <Icon.info size={15} />
          不消耗 token 的操作
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {['本地知识库检索', '错题本检索', '对话标题生成', '图片衰减与摘要', '绘图渲染', '公式排版', '错因自动归类', '统计与图表'].map((x) => (
            <span className="chip ok" key={x}>
              {x}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ================================================================== */
/* memory                                                             */
/* ================================================================== */
function MemoryTab() {
  const app = useApp()
  const data = useData()
  const m = app.settings.memory
  const save = (patch: any) => app.patchSettings({ memory: patch }, { silent: true })
  const stats = useMemo(() => data.wrongStats(), [data.wrongEntries])

  return (
    <div className="settings-section">
      <SettingRow title="自动记录错题" desc="当 AI 判断你提交了自己的错误解答时，会自动写入错题本（题目、错解、正解、错因、知识点）。">
        <Switch checked={m.autoWrongBook !== false} onChange={(v) => save({ autoWrongBook: v })} />
      </SettingRow>

      <SettingRow title="错题自动生成卡片" desc="记录错题的同时为其知识点生成背诵卡片。">
        <Switch checked={m.autoFlashcards === true} onChange={(v) => save({ autoFlashcards: v })} />
      </SettingRow>

      <SettingRow title="允许 AI 存入知识库" desc="允许 AI 把整理出的知识点、大纲保存为知识库文档，便于后续检索。">
        <Switch checked={m.autoKnowledgeSave !== false} onChange={(v) => save({ autoKnowledgeSave: v })} />
      </SettingRow>

      <div className="card">
        <div className="card-title">
          <Icon.target size={15} />
          错因归类体系
        </div>
        <div className="card-sub">AI 会把每道错题归入其中一类，用于统计你最常出问题的环节。</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {REASON_CATEGORIES.map((r) => {
            const n = stats.byReason.find((x) => x.key === r)?.n || 0
            return (
              <span className={clsx('chip', n ? 'accent' : '')} key={r}>
                {r}
                {n ? ` · ${n}` : ''}
              </span>
            )
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Icon.clock size={15} />
          遗忘曲线复习间隔
        </div>
        <div className="card-sub">错题与卡片按下列间隔安排复习，答错会退回起点。</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {['1 天', '2 天', '4 天', '7 天', '15 天', '30 天'].map((x, i) => (
            <span className="chip" key={x}>
              第 {i + 1} 次 · {x}
            </span>
          ))}
          <span className="chip warn">首次复习 · 10 分钟</span>
        </div>
        <div className="field-hint" style={{ marginTop: 10 }}>
          掌握度达到 5/5 后不再排入复习队列，但仍保留在错题本中可随时查阅。
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Icon.brain size={15} />
          为什么要分类错因
        </div>
        <div className="card-sub">
          「算错」往往是「公式记错」的结果，「不会做」常常是「概念不清」的表象。把错因归到根因层面，才能对症下药——如果 60% 的错误都是审题问题，那该练的是读题习惯，而不是继续刷题。
        </div>
      </div>
    </div>
  )
}

/* ================================================================== */
/* planner                                                            */
/* ================================================================== */
function PlannerTab() {
  const app = useApp()
  const p = app.settings.planner
  const save = (patch: any) => app.patchSettings({ planner: patch }, { silent: true })
  const [status, setStatus] = useState<any>(null)

  useEffect(() => {
    void bridge.planner.status().then(setStatus)
    const t = setInterval(() => bridge.planner.status().then(setStatus), 15000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="settings-section">
      <SettingRow title="到点弹窗提醒" desc="在屏幕右下角弹出提醒窗口，显示当前时段与下一项安排。">
        <Switch checked={p.popup !== false} onChange={(v) => save({ popup: v })} />
      </SettingRow>

      <SettingRow title="系统通知" desc="通过操作系统通知中心提醒，即使主窗口最小化也能看到。">
        <Switch checked={p.notify !== false} onChange={(v) => save({ notify: v })} />
      </SettingRow>

      <SettingRow title="提醒提示音" desc="触发提醒时播放一声提示音。">
        <Switch checked={p.notifySound !== false} onChange={(v) => save({ notifySound: v })} />
      </SettingRow>

      <SettingRow title="提前提醒时长" desc="在计划开始时间之前多久提醒，便于提前收起手头的事。">
        <div className="row center" style={{ gap: 9 }}>
          <input
            className="input"
            type="number"
            min={0}
            max={60}
            style={{ width: 76 }}
            value={Math.round((p.advanceSeconds || 0) / 60)}
            onChange={(e) => save({ advanceSeconds: Math.max(0, Math.min(60, Number(e.target.value) || 0)) * 60 })}
          />
          <span className="muted" style={{ fontSize: 12 }}>分钟</span>
        </div>
      </SettingRow>

      <SettingRow title="提醒总开关" desc={status?.hasSchedule ? `当前已配置 ${status.count || 0} 个今日时段` : '尚未配置时间规划'}>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={() => bridge.planner.testFire()}>
            <Icon.bell size={14} />
            测试提醒
          </button>
          <button
            className="btn"
            onClick={async () => {
              const paused = await bridge.planner.pause(!status?.paused)
              setStatus({ ...(status || {}), paused })
              app.toast({ kind: 'info', title: paused ? '提醒已暂停' : '提醒已恢复' })
            }}
          >
            {status?.paused ? <Icon.play size={14} /> : <Icon.pause size={14} />}
            {status?.paused ? '恢复提醒' : '暂停提醒'}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        title="最小化到系统托盘"
        desc="关闭窗口时保留后台运行，时间提醒与托盘图标继续工作。关闭此项后点关闭按钮将直接退出。"
      >
        <Switch checked={app.settings.ui?.minimizeToTray !== false} onChange={(v) => app.patchSettings({ ui: { minimizeToTray: v } }, { silent: true })} />
      </SettingRow>

      <SettingRow title="开机自动启动" desc="登录系统后自动在后台运行，确保提醒不遗漏。">
        <Switch checked={app.settings.ui?.autoLaunch === true} onChange={(v) => app.patchSettings({ ui: { autoLaunch: v } }, { silent: true })} />
      </SettingRow>

      <SettingRow title="启动时最小化" desc="随开机启动时不弹出主窗口，只在托盘静默运行。">
        <Switch checked={app.settings.ui?.startMinimized === true} onChange={(v) => app.patchSettings({ ui: { startMinimized: v } }, { silent: true })} />
      </SettingRow>
    </div>
  )
}

/* ================================================================== */
/* appearance                                                         */
/* ================================================================== */
function AppearanceTab() {
  const app = useApp()
  const a = app.settings.appearance
  const save = (patch: any) => app.patchSettings({ appearance: patch }, { silent: true })

  const ACCENTS = [
    { id: 'cyan', label: '深空青', color: '#22d3ee' },
    { id: 'violet', label: '星紫', color: '#a78bfa' },
    { id: 'emerald', label: '量子绿', color: '#34d399' },
    { id: 'amber', label: '熔金', color: '#fbbf24' },
    { id: 'rose', label: '星云粉', color: '#fb7185' },
    { id: 'azure', label: '天工蓝', color: '#60a5fa' },
  ]

  return (
    <div className="settings-section">
      <SettingRow title="主题" desc="深色更适合长时间学习，浅色在白天光线充足时更清晰。">
        <Segmented
          value={a.theme}
          onChange={(v) => save({ theme: v })}
          options={[
            { value: 'dark', label: '深色' },
            { value: 'light', label: '浅色' },
          ]}
        />
      </SettingRow>

      <div className="card">
        <div className="card-title">
          <Icon.palette size={15} />
          强调色
        </div>
        <div className="card-sub">切换后整个界面的主色（含图表、按钮、高亮）会同步变化。</div>
        <div className="row wrap" style={{ gap: 9 }}>
          {ACCENTS.map((x) => (
            <button
              key={x.id}
              className={clsx('chip', a.accent === x.id && 'accent')}
              style={{ cursor: 'pointer', gap: 7 }}
              onClick={() => save({ accent: x.id })}
            >
              <span style={{ width: 12, height: 12, borderRadius: 4, background: x.color, display: 'block' }} />
              {x.label}
              {a.accent === x.id ? <Icon.check size={12} /> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Icon.eye size={15} />
          排版
        </div>
        <div className="col" style={{ gap: 15 }}>
          <div>
            <div className="row between" style={{ fontSize: 12.5, marginBottom: 5 }}>
              <span>字号缩放</span>
              <b className="tnum">{Math.round((a.fontScale || 1) * 100)}%</b>
            </div>
            <input className="slider" type="range" min={0.85} max={1.35} step={0.05} value={a.fontScale || 1} onChange={(e) => save({ fontScale: Number(e.target.value) })} />
          </div>
          <SettingRow title="紧凑布局" desc="缩小间距与内边距，一屏显示更多内容。">
            <Switch checked={!!a.compact} onChange={(v) => save({ compact: v })} />
          </SettingRow>
          <SettingRow title="减少动效" desc="关闭过渡与淡入动画，适合低配设备或对动效敏感的使用者。">
            <Switch checked={!!a.reduceMotion} onChange={(v) => save({ reduceMotion: v })} />
          </SettingRow>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Icon.chat size={15} />
          对话偏好
        </div>
        <div className="col" style={{ gap: 0 }}>
          <SettingRow title="Enter 直接发送" desc="关闭后按 Enter 换行，用 Ctrl+Enter 发送（适合写长题目的场景）。">
            <Switch checked={app.settings.ui?.sendOnEnter !== false} onChange={(v) => app.patchSettings({ ui: { sendOnEnter: v } }, { silent: true })} />
          </SettingRow>
          <SettingRow title="显示 token 用量" desc="生成过程中显示上下文规模与工具调用次数。">
            <Switch checked={app.settings.ui?.showTokens !== false} onChange={(v) => app.patchSettings({ ui: { showTokens: v } }, { silent: true })} />
          </SettingRow>
          <SettingRow title="显示消息时间" desc="在每条消息上方显示相对时间。">
            <Switch checked={app.settings.ui?.showTimestamps === true} onChange={(v) => app.patchSettings({ ui: { showTimestamps: v } }, { silent: true })} />
          </SettingRow>
        </div>
      </div>
    </div>
  )
}

/* ================================================================== */
/* data                                                               */
/* ================================================================== */
function DataTab() {
  const app = useApp()
  const data = useData()
  const chat = useChat()
  const [storage, setStorage] = useState({ usage: 0, quota: 0 })
  const [busy, setBusy] = useState('')

  useEffect(() => {
    void storageEstimate().then(setStorage)
  }, [])

  const exportAll = async () => {
    setBusy('export')
    try {
      const payload = {
        version: APP_VERSION,
        exportedAt: new Date().toISOString(),
        settings: { ...app.settings, provider: { ...app.settings.provider, apiKey: '' } },
        wrongEntries: data.wrongEntries,
        flashcards: data.flashcards,
        knowledgeDocs: data.kbDocs.map((d) => ({ ...d, sourcePath: undefined, storedPath: undefined })),
        chats: chat.sessions,
      }
      const dest = await bridge.dialog.saveFile({
        title: '导出研来数据备份',
        defaultPath: `yanlai-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (!dest) return
      const r = await bridge.fs.writeText(dest, JSON.stringify(payload, null, 2))
      app.toast(r.ok ? { kind: 'success', title: '备份已导出', body: dest } : { kind: 'error', title: '导出失败', body: r.error })
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="settings-section">
      <div className="grid three">
        <div className="stat-tile">
          <div className="k">已用存储</div>
          <div className="v">{fmtBytes(storage.usage)}</div>
          <div className="d">本机 IndexedDB</div>
        </div>
        <div className="stat-tile">
          <div className="k">对话</div>
          <div className="v">{chat.sessions.length}</div>
          <div className="d">共 {chat.sessions.reduce((n, s) => n + s.messages.length, 0)} 条消息</div>
        </div>
        <div className="stat-tile">
          <div className="k">错题 / 卡片</div>
          <div className="v">
            {data.wrongEntries.length}
            <span style={{ fontSize: 14, fontWeight: 500 }}> / {data.flashcards.length}</span>
          </div>
          <div className="d">知识库 {data.kbDocs.length} 份</div>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 9 }}>
        <button className="btn" onClick={exportAll} disabled={!!busy}>
          <Icon.download size={15} />
          导出全部数据备份
        </button>
        <button className="btn" onClick={() => bridge.shell.openPath(data.kbDocs[0]?.storedPath || '')} disabled={!data.kbDocs.length}>
          <Icon.folder size={15} />
          打开资料目录
        </button>
        <button className="btn" onClick={() => bridge.system.openLogs()}>
          <Icon.terminal size={15} />
          打开日志
        </button>
      </div>

      <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--err) 28%, transparent)' }}>
        <div className="card-title" style={{ color: 'var(--err)' }}>
          <Icon.alert size={15} />
          危险操作
        </div>
        <div className="card-sub">以下操作不可撤销，请确认后再执行。</div>
        <div className="col" style={{ gap: 9 }}>
          {[
            {
              label: '清空所有对话',
              desc: `${chat.sessions.length} 个会话`,
              run: async () => {
                if (await app.ask({ title: '清空所有对话？', body: '所有会话与消息将被永久删除。', confirmText: '清空', danger: true })) {
                  await chat.clearAll()
                  app.toast({ kind: 'success', title: '对话已清空' })
                }
              },
            },
            {
              label: '清空错题本',
              desc: `${data.wrongEntries.length} 道错题`,
              run: async () => {
                if (await app.ask({ title: '清空错题本？', body: '所有错题记录与复习进度将被删除。', confirmText: '清空', danger: true })) {
                  await data.clearWrongbook()
                  app.toast({ kind: 'success', title: '错题本已清空' })
                }
              },
            },
            {
              label: '清空知识库',
              desc: `${data.kbDocs.length} 份资料`,
              run: async () => {
                if (await app.ask({ title: '清空知识库？', body: '所有资料、索引片段将被删除。', confirmText: '清空', danger: true })) {
                  await data.clearKb()
                  app.toast({ kind: 'success', title: '知识库已清空' })
                }
              },
            },
            {
              label: '恢复默认设置',
              desc: '模型、朗读、外观等配置回到初始状态',
              run: async () => {
                if (await app.ask({ title: '恢复默认设置？', body: 'API Key 与模型配置将被清除，需要重新填写。对话、错题与知识库不受影响。', confirmText: '恢复默认', danger: true })) {
                  await app.resetSettings()
                }
              },
            },
          ].map((x) => (
            <div className="row between" key={x.label} style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 570 }}>{x.label}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{x.desc}</div>
              </div>
              <button className="btn sm danger" onClick={x.run}>
                <Icon.trash size={13} />
                执行
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Icon.info size={15} />
          数据存放位置
        </div>
        <div className="col" style={{ gap: 6, fontSize: 12.5 }}>
          <div className="row between">
            <span className="muted">配置文件（含 API Key）</span>
            <span className="mono">userData/settings.json</span>
          </div>
          <div className="row between">
            <span className="muted">对话 / 错题 / 卡片 / 知识库索引</span>
            <span className="mono">浏览器 IndexedDB（本机）</span>
          </div>
          <div className="row between">
            <span className="muted">资料原文与附件</span>
            <span className="mono">userData/kb, userData/attachments</span>
          </div>
          <div className="row between">
            <span className="muted">生成的文件</span>
            <span className="mono">工作区目录 / userData/exports</span>
          </div>
        </div>
        <div className="field-hint" style={{ marginTop: 10 }}>
          所有数据都在本机。除你配置的模型接口外，应用不会向任何第三方发送内容。
        </div>
      </div>
    </div>
  )
}

/* ================================================================== */
/* about                                                              */
/* ================================================================== */
function AboutTab() {
  const app = useApp()
  const info = app.info || {}
  const [shortcuts] = useState([
    ['Ctrl + N', '新建对话'],
    ['Ctrl + P', '打开时间规划'],
    ['Ctrl + B', '打开错题本'],
    ['Ctrl + K', '打开知识库'],
    ['Ctrl + V', '粘贴题目截图'],
    ['Ctrl + Shift + P', '命令面板'],
    ['Enter', '发送消息（可在外观设置中改为换行）'],
    ['Shift + Enter', '换行'],
    ['↑', '输入框为空时调出上一条提问'],
    ['Esc', '关闭弹窗 / 命令面板'],
  ])

  return (
    <div className="settings-section">
      <div className="card">
        <div className="row" style={{ gap: 15 }}>
          <img src="./logo.svg" alt="研来" style={{ width: 58, height: 58, borderRadius: 16 }} />
          <div className="grow">
            <div style={{ fontSize: 19, fontWeight: 700 }}>研来 · Yanlai</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              面向研究生入学考试的学习辅导 AI 助手
            </div>
            <div className="row wrap" style={{ gap: 6, marginTop: 9 }}>
              <span className="chip accent">版本 {info.version || APP_VERSION}</span>
              <span className="chip">{info.platform || '-'}</span>
              <span className="chip">Electron {info.electron || '-'}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Icon.info size={15} />
          核心能力
        </div>
        <div className="grid two" style={{ gap: 10, fontSize: 12.5 }}>
          {[
            ['讲题与推导', '先讲思路来源，再分步推导，附易错点与同源变式题'],
            ['数学绘图', '函数图像、参数曲线、极坐标、积分面积，直接显示在对话中'],
            ['整卷与出题', '按考研真题题型出卷，含答案、解析与考点分布表'],
            ['文档产出', '导出 Word / PDF / Excel / Markdown / HTML'],
            ['知识库', '导入教材真题，本地检索、回答标注出处'],
            ['错题本', '自动记录错因错解正解，知识点与错因双重归类'],
            ['背诵卡片', '知识点转卡片，按遗忘曲线复习'],
            ['时间规划', '按周 / 每日统一 / 工作日休息日三种模式，到时弹窗提醒'],
            ['朗读', '系统语音 / 自定义 TTS API / 边输出边朗读'],
            ['记忆管理', '淘汰旧图片与工具输出，长对话也能省 token'],
          ].map(([t, d]) => (
            <div key={t}>
              <div style={{ fontWeight: 620, marginBottom: 2 }}>{t}</div>
              <div className="muted">{d}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Icon.terminal size={15} />
          快捷键
        </div>
        <div className="col" style={{ gap: 0 }}>
          {shortcuts.map(([k, d]) => (
            <div className="row between" key={k} style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="mono" style={{ fontSize: 12.5 }}>
                {k}
              </span>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {d}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Icon.book size={15} />
          使用建议
        </div>
        <div className="col" style={{ gap: 8, fontSize: 12.5, lineHeight: 1.65 }}>
          <div>
            <b>1. 先建知识库。</b>把你用的教材、真题导入进去。之后提问会自动检索并标注出处，准确率提升非常明显。
          </div>
          <div>
            <b>2. 截图讲题最快。</b>Win+Shift+S 截图后直接在输入框 Ctrl+V，省去打字的工夫。
          </div>
          <div>
            <b>3. 做错的题一定发给我。</b>附上你的错误解答，我会定位到具体的错误步骤并归类错因——这比看正确答案有用得多。
          </div>
          <div>
            <b>4. 让计划落到提醒上。</b>在「学习计划」模式里让我生成计划，会直接写入时间规划模块，到点弹窗提醒。
          </div>
          <div>
            <b>5. 定期复盘。</b>用「复盘总结」模式，我会读你的错题数据，找出最该优先补的漏洞。
          </div>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 9 }}>
        <button className="btn primary" onClick={() => app.setView('settings', 'update')}>
          <Icon.refresh size={15} />
          检查更新
        </button>
        <button className="btn" onClick={() => bridge.system.openLogs()}>
          <Icon.terminal size={15} />
          打开日志目录
        </button>
        <button className="btn" onClick={async () => { const p = await bridge.paths.info(); bridge.shell.openPath(p.userData) }}>
          <Icon.folder size={15} />
          打开数据目录
        </button>
      </div>
    </div>
  )
}
