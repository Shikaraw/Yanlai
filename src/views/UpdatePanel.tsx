import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { Icon } from '../components/Icons'
import { Modal, Switch } from '../components/ui'
import { Markdown } from '../components/Markdown'
import { bridge } from '../lib/bridge'
import type { MirrorPreset, ReleaseInfo, UpdateResult } from '../lib/bridge'
import { clsx, fmtBytes, fmtDateTime } from '../lib/util'

/* ------------------------------------------------------------------ */
/* shared: version compare label                                       */
/* ------------------------------------------------------------------ */
function versionBadge(from: string, to: string) {
  return (
    <span className="row center" style={{ gap: 9 }}>
      <span className="chip mono">{from}</span>
      <Icon.chevron size={14} style={{ color: 'var(--text-3)' }} />
      <span className="chip accent mono" style={{ fontWeight: 700 }}>
        {to}
      </span>
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* startup prompt                                                      */
/* ------------------------------------------------------------------ */
/**
 * Shown shortly after launch when a newer release exists. Deliberately not a
 * blocking modal: the user can keep working, and "跳过此版本" is remembered so
 * the same release never nags twice.
 */
export function UpdatePrompt() {
  const app = useApp()
  const [result, setResult] = useState<UpdateResult | null>(null)

  useEffect(() => {
    const unsub = bridge.update.onAvailable((r) => {
      if (r?.ok && r.hasUpdate) setResult(r)
    })
    return unsub
  }, [])

  if (!result) return null

  const primary = pickPrimaryAsset(result.assets || [])

  return (
    <Modal
      open
      onClose={() => setResult(null)}
      title="发现新版本"
      icon="sparkles"
      footer={
        <>
          <button
            className="btn"
            onClick={async () => {
              await bridge.update.skipVersion(result.latestVersion || '')
              setResult(null)
              app.toast({ kind: 'info', title: `已跳过 ${result.latestVersion}`, body: '该版本不会再提示，可在设置中恢复。' })
            }}
          >
            跳过此版本
          </button>
          <div className="grow" />
          <button className="btn" onClick={() => setResult(null)}>
            稍后再说
          </button>
          <button
            className="btn primary"
            onClick={() => {
              if (primary) bridge.update.openRelease({ url: primary.mirrorUrl, useMirror: false })
              else bridge.update.openRelease({ url: result.releaseUrl || '', useMirror: true })
            }}
          >
            <Icon.download size={15} />
            {primary ? '前往下载' : '查看更新说明'}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 15 }}>
        <div className="row between wrap" style={{ gap: 10 }}>
          {versionBadge(result.currentVersion, result.latestVersion || '')}
          {result.publishedAt ? <span className="muted" style={{ fontSize: 12 }}>发布于 {fmtDateTime(Date.parse(result.publishedAt))}</span> : null}
        </div>

        {result.assets?.length ? (
          <div className="col" style={{ gap: 7 }}>
            <div className="wb-section-label">可下载文件</div>
            {result.assets.map((a) => (
              <div className="kb-item" key={a.name}>
                <div className="kb-icon">
                  <Icon.download size={16} />
                </div>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="kb-name">{a.name}</div>
                  <div className="kb-meta">
                    <span>{fmtBytes(a.size)}</span>
                    {a.downloadCount ? <span>已下载 {a.downloadCount} 次</span> : null}
                  </div>
                </div>
                <button
                  className="btn sm primary"
                  onClick={() => bridge.update.openRelease({ url: a.mirrorUrl, useMirror: false })}
                  title="通过镜像下载（浏览器打开）"
                >
                  下载
                </button>
                <button
                  className="btn sm"
                  onClick={() => bridge.update.openRelease({ url: a.url, useMirror: false })}
                  title="从 GitHub 官方地址下载"
                >
                  <Icon.external size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {result.notes?.trim() ? (
          <div>
            <div className="wb-section-label">更新内容</div>
            <div
              style={{
                maxHeight: 230,
                overflow: 'auto',
                padding: '11px 14px',
                background: 'var(--bg-1)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                fontSize: 13,
              }}
            >
              <Markdown>{result.notes}</Markdown>
            </div>
          </div>
        ) : null}

        <div className="row" style={{ gap: 7, fontSize: 12 }}>
          <Icon.info size={13} style={{ color: 'var(--text-3)' }} />
          <span className="muted">
            检查来源：{result.source || '—'} · 覆盖安装即可，你的对话、错题与知识库都会保留
          </span>
        </div>
      </div>
    </Modal>
  )
}

/** Prefer the full installer, then any .exe, then whatever exists. */
function pickPrimaryAsset(assets: NonNullable<UpdateResult['assets']>) {
  return (
    assets.find((a) => /安装包/i.test(a.name) && /\.exe$/i.test(a.name)) ||
    assets.find((a) => /\.exe$/i.test(a.name)) ||
    assets[0] ||
    null
  )
}

/* ------------------------------------------------------------------ */
/* settings panel                                                      */
/* ------------------------------------------------------------------ */
export function UpdatePanel() {
  const app = useApp()
  const cfg = app.settings?.update || {}
  const [result, setResult] = useState<UpdateResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [mirrors, setMirrors] = useState<MirrorPreset[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState<ReleaseInfo[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)

  useEffect(() => {
    bridge.update.mirrors().then(setMirrors).catch(() => {})
    if (cfg.lastResult) setResult({ ...cfg.lastResult, currentVersion: app.info?.version || '1.0.00' })
  }, [])

  const save = (patch: any) => app.patchSettings({ update: patch }, { silent: true })

  const check = async () => {
    setChecking(true)
    try {
      const r = await bridge.update.check()
      setResult(r)
      if (r.ok) {
        app.toast({
          kind: r.hasUpdate ? 'success' : 'info',
          title: r.hasUpdate ? `发现新版本 ${r.latestVersion}` : '已是最新版本',
          body: r.hasUpdate ? `当前 ${r.currentVersion}，可通过应用内链接下载。` : `当前 ${r.currentVersion} 已是最新（来源：${r.source}）。`,
        })
      } else {
        app.toast({ kind: 'warn', title: '检查更新失败', body: r.message })
      }
    } catch (e: any) {
      app.toast({ kind: 'error', title: '检查更新出错', body: String(e?.message || e) })
    } finally {
      setChecking(false)
    }
  }

  const loadHistory = async () => {
    setShowHistory(true)
    setLoadingHistory(true)
    try {
      const r = await bridge.update.releases(10)
      setHistory(r.releases || [])
    } finally {
      setLoadingHistory(false)
    }
  }

  const repo = cfg.repo || 'Shikaraw/Yanlai'
  const repoUrl = `https://github.com/${repo}`

  return (
    <div className="settings-section">
      {/* ---- current status ---- */}
      <div className="card" style={{ borderColor: result?.hasUpdate ? 'var(--accent-line)' : undefined }}>
        <div className="row between wrap" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 15 }}>
            <img src="./logo.svg" alt="" style={{ width: 46, height: 46, borderRadius: 13, flex: '0 0 auto' }} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 680 }}>研来 · Yanlai</div>
              <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                <span className="chip mono">当前 {app.info?.version || '1.0.00'}</span>
                {result?.ok && result.latestVersion ? (
                  result.hasUpdate ? (
                    <span className="chip accent">最新 {result.latestVersion} · 有更新</span>
                  ) : (
                    <span className="chip ok">已是最新</span>
                  )
                ) : null}
                {result?.reason === 'no-release' ? <span className="chip">仓库暂无 Release</span> : null}
              </div>
              {cfg.lastCheckedAt ? (
                <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
                  上次检查：{fmtDateTime(cfg.lastCheckedAt)}
                  {cfg.lastResult?.source ? ` · 来源 ${cfg.lastResult.source}` : ''}
                </div>
              ) : null}
            </div>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={loadHistory}>
              <Icon.list size={14} />
              版本历史
            </button>
            <button className="btn primary" onClick={check} disabled={checking}>
              {checking ? (
                <>
                  <span className="tc-spin" style={{ display: 'grid', placeItems: 'center' }}>
                    <Icon.refresh size={14} />
                  </span>
                  检查中…
                </>
              ) : (
                <>
                  <Icon.refresh size={14} />
                  检查更新
                </>
              )}
            </button>
          </div>
        </div>

        {result && !result.ok ? (
          <div
            style={{
              marginTop: 13,
              padding: '10px 13px',
              borderRadius: 9,
              background: result.reason === 'no-release' ? 'var(--bg-3)' : 'var(--warn-soft)',
              fontSize: 12.5,
              lineHeight: 1.6,
            }}
          >
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon.alert size={14} style={{ color: result.reason === 'no-release' ? 'var(--text-3)' : 'var(--warn)', marginTop: 2, flex: '0 0 auto' }} />
              <div>
                <div>{result.message}</div>
                {result.reason === 'network' && result.attempts?.length ? (
                  <details style={{ marginTop: 6 }}>
                    <summary className="muted" style={{ cursor: 'pointer', fontSize: 11.5 }}>
                      查看各线路尝试结果
                    </summary>
                    <div className="mono" style={{ fontSize: 11, marginTop: 5, color: 'var(--text-3)' }}>
                      {result.attempts.map((a) => (
                        <div key={a.source}>
                          {a.source}: {a.error}
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {result?.ok && result.hasUpdate ? (
          <div className="col" style={{ gap: 9, marginTop: 14 }}>
            {result.assets?.length ? (
              result.assets.map((a) => (
                <div className="row between" key={a.name} style={{ gap: 10, padding: '7px 0' }}>
                  <span className="row center" style={{ gap: 8, minWidth: 0 }}>
                    <Icon.file size={14} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                    <span className="muted" style={{ fontSize: 11.5, flex: '0 0 auto' }}>{fmtBytes(a.size)}</span>
                  </span>
                  <span className="row" style={{ gap: 6, flex: '0 0 auto' }}>
                    <button className="btn sm primary" onClick={() => bridge.update.openRelease({ url: a.mirrorUrl })}>
                      <Icon.download size={13} />
                      镜像下载
                    </button>
                    <button className="btn sm" onClick={() => bridge.update.openRelease({ url: a.url })}>
                      <Icon.external size={13} />
                      官方
                    </button>
                  </span>
                </div>
              ))
            ) : (
              <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => bridge.update.openRelease({ url: result.releaseUrl || '', useMirror: true })}>
                <Icon.external size={14} />
                打开发布页面
              </button>
            )}
          </div>
        ) : null}
      </div>

      {/* ---- behaviour ---- */}
      <Switch_ title="启用更新检查" desc="总开关。关闭后不会在启动时自动检查，也不显示更新提示。">
        <Switch checked={cfg.enabled !== false} onChange={(v) => save({ enabled: v })} />
      </Switch_>

      <Switch_ title="启动时自动检查" desc="应用启动约 6 秒后在后台静默检查，不阻塞界面。发现新版本才会提示。">
        <Switch checked={cfg.autoCheck !== false} onChange={(v) => save({ autoCheck: v })} />
      </Switch_>

      {/* ---- source ---- */}
      <div className="card">
        <div className="card-title">
          <Icon.terminal size={15} />
          更新检查源
        </div>
        <div className="card-sub">
          GitHub 官方 API 在国内常被限速或阻断，默认走公共加速镜像，并会自动在多个镜像间回退。
        </div>

        <div className="col" style={{ gap: 8 }}>
          {[
            { v: 'mirror', label: '镜像加速（推荐）', desc: '自动尝试多个公共 GitHub 加速线路，最稳定' },
            { v: 'direct', label: 'GitHub 官方直连', desc: '直接访问 api.github.com，需要网络能连上 GitHub' },
            { v: 'custom', label: '自定义代理前缀', desc: '使用你自己的反代地址（形如 https://your.proxy/）' },
          ].map((o) => (
            <button
              key={o.v}
              className={clsx('settings-row', 'pointer')}
              style={{ textAlign: 'left', borderColor: cfg.source === o.v ? 'var(--accent-line)' : undefined, background: cfg.source === o.v ? 'var(--accent-soft)' : undefined }}
              onClick={() => save({ source: o.v })}
            >
              <span style={{ color: cfg.source === o.v ? 'var(--accent)' : 'var(--text-3)', marginTop: 2 }}>
                {cfg.source === o.v ? <Icon.check size={16} /> : <span style={{ display: 'block', width: 16 }} />}
              </span>
              <div className="sr-main">
                <div className="sr-title">{o.label}</div>
                <div className="sr-desc">{o.desc}</div>
              </div>
            </button>
          ))}
        </div>

        {cfg.source === 'mirror' ? (
          <div style={{ marginTop: 14 }}>
            <div className="field-label" style={{ marginBottom: 7 }}>
              首选镜像
            </div>
            <div className="row wrap" style={{ gap: 7 }}>
              {mirrors.filter((m) => m.prefix).map((m) => (
                <button
                  key={m.id}
                  className={clsx('chip', cfg.mirrorId === m.id && 'accent')}
                  style={{ cursor: 'pointer' }}
                  onClick={() => save({ mirrorId: m.id })}
                  title={m.prefix}
                >
                  {cfg.mirrorId === m.id ? <Icon.check size={12} /> : null}
                  {m.name}
                  {m.note ? <span className="muted">· {m.note}</span> : null}
                </button>
              ))}
            </div>
            <div className="field-hint" style={{ marginTop: 7 }}>
              首选线路失败时会自动尝试其余线路，无需手动切换。
            </div>
          </div>
        ) : null}

        {cfg.source === 'custom' ? (
          <div style={{ marginTop: 14 }}>
            <input
              className="input mono"
              value={cfg.customPrefix || ''}
              onChange={(e) => save({ customPrefix: e.target.value })}
              placeholder="https://your-proxy.example.com/"
            />
            <div className="field-hint" style={{ marginTop: 6 }}>
              请求会拼成 <span className="mono">{'<前缀>'}https://api.github.com/repos/{repo}/releases/latest</span>
            </div>
          </div>
        ) : null}

        <div className="split-line" style={{ margin: '15px 0 12px' }} />

        <div className="settings-row" style={{ padding: '11px 14px', background: 'transparent', border: 'none' }}>
          <div className="sr-main">
            <div className="sr-title">使用系统代理</div>
            <div className="sr-desc">
              默认关闭。更新请求走公共镜像可直连；若本机系统代理（如 Clash）节点异常，开启反而会导致检查失败。仅当本机完全没有直连通道时才需要打开。
            </div>
          </div>
          <Switch checked={!!cfg.useSystemProxy} onChange={(v) => save({ useSystemProxy: v })} />
        </div>
      </div>

      {/* ---- repo ---- */}
      <div className="card">
        <div className="card-title">
          <Icon.folder size={15} />
          仓库地址
        </div>
        <div className="card-sub">检查更新会读取该仓库的 Releases。</div>
        <div className="row" style={{ gap: 8 }}>
          <input className="input mono grow" value={repo} onChange={(e) => save({ repo: e.target.value })} placeholder="owner/repo" />
          <button className="btn" onClick={() => bridge.update.openRelease({ url: repoUrl })}>
            <Icon.external size={14} />
            在浏览器打开
          </button>
        </div>

        {cfg.skippedVersion ? (
          <div className="row between" style={{ marginTop: 12, gap: 10 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              已跳过版本 <b className="mono">{cfg.skippedVersion}</b> 的更新提示
            </span>
            <button
              className="btn sm"
              onClick={async () => {
                await bridge.update.clearSkip()
                await app.patchSettings({ update: { skippedVersion: '' } }, { silent: true })
                app.toast({ kind: 'success', title: '已恢复提示' })
              }}
            >
              恢复提示
            </button>
          </div>
        ) : null}
      </div>

      {/* ---- history ---- */}
      <Modal open={showHistory} onClose={() => setShowHistory(false)} title="版本历史" icon="list" wide>
        {loadingHistory ? (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>正在读取 Release 列表…</div>
        ) : history.length ? (
          <div className="col" style={{ gap: 13 }}>
            {history.map((r) => (
              <div className="card" key={r.tag} style={{ padding: 15 }}>
                <div className="row between wrap" style={{ gap: 9 }}>
                  <span className="row center" style={{ gap: 8 }}>
                    <span className="chip accent mono">{r.tag}</span>
                    {r.prerelease ? <span className="chip warn">预发布</span> : null}
                    <span style={{ fontWeight: 620 }}>{r.name}</span>
                  </span>
                  <span className="row" style={{ gap: 8 }}>
                    <span className="muted" style={{ fontSize: 11.5 }}>{fmtDateTime(Date.parse(r.publishedAt))}</span>
                    <button className="btn sm" onClick={() => bridge.update.openRelease({ url: r.url })}>
                      <Icon.external size={13} />
                      打开
                    </button>
                  </span>
                </div>
                {r.assets.length ? (
                  <div className="row wrap" style={{ gap: 6, marginTop: 9 }}>
                    {r.assets.map((a) => (
                      <button key={a.name} className="chip" style={{ cursor: 'pointer' }} onClick={() => bridge.update.openRelease({ url: a.mirrorUrl })} title="通过镜像下载">
                        <Icon.download size={11} />
                        {a.name} · {fmtBytes(a.size)}
                      </button>
                    ))}
                  </div>
                ) : null}
                {r.notes?.trim() ? (
                  <div style={{ marginTop: 9, maxHeight: 140, overflow: 'auto', fontSize: 12.5, color: 'var(--text-2)' }}>
                    <Markdown>{r.notes}</Markdown>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">
            <span className="empty-icon">
              <Icon.list size={36} />
            </span>
            <h3>暂无版本记录</h3>
            <p>仓库里还没有发布任何 Release，或当前网络无法读取。</p>
          </div>
        )}
      </Modal>
    </div>
  )
}

/** Local helper: a bordered row with a switch, reusing the settings look. */
function Switch_({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="sr-main">
        <div className="sr-title">{title}</div>
        {desc ? <div className="sr-desc">{desc}</div> : null}
      </div>
      {children}
    </div>
  )
}
