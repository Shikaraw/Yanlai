import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { useData } from '../store/useData'
import { Icon } from '../components/Icons'
import { EmptyState, Modal } from '../components/ui'
import { Markdown } from '../components/Markdown'
import { bridge } from '../lib/bridge'
import { clsx, fmtBytes, fmtDateTime } from '../lib/util'
import type { Artifact } from '../lib/types'

type Row = { name: string; path: string; isDir: boolean; size: number; mtime: number }

export function WorkspaceView() {
  const app = useApp()
  const data = useData()
  const [dir, setDir] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<{ name: string; text?: string; url?: string } | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'files' | 'generated'>('files')

  const ws = app.settings?.workspace || ''

  useEffect(() => {
    setDir(ws)
  }, [ws])

  const reload = async (d = dir) => {
    if (!d) {
      setRows([])
      return
    }
    setLoading(true)
    try {
      setRows(await bridge.fs.listDir(d))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload(dir)
  }, [dir])

  const filtered = useMemo(() => {
    if (!query.trim()) return rows
    const q = query.trim().toLowerCase()
    return rows.filter((r) => r.name.toLowerCase().includes(q))
  }, [rows, query])

  const open = async (r: Row) => {
    if (r.isDir) {
      setDir(r.path)
      return
    }
    const ext = (r.name.split('.').pop() || '').toLowerCase()
    if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'svg'].includes(ext)) {
      const b = await bridge.fs.readBase64(r.path)
      if (b) setPreview({ name: r.name, url: `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b.data}` })
      return
    }
    if (['md', 'markdown', 'txt', 'json', 'csv', 'tex', 'log'].includes(ext)) {
      const t = await bridge.fs.readText(r.path)
      setPreview({ name: r.name, text: t.slice(0, 200000) })
      return
    }
    bridge.shell.openPath(r.path)
  }

  const parentDir = dir ? dir.replace(/[\\/][^\\/]*$/, '') : ''

  return (
    <>
      <div className="panel-head">
        <Icon.folder size={19} style={{ color: 'var(--accent)' }} />
        <div className="grow">
          <h1>工作区</h1>
          <div className="sub mono" style={{ fontSize: 11.5 }}>
            {dir || '未设置工作区'}
          </div>
        </div>
        <div className="row center" style={{ gap: 8 }}>
          <Icon.search size={15} style={{ color: 'var(--text-3)' }} />
          <input className="input" style={{ width: 180 }} placeholder="筛选文件…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button className="btn sm" onClick={() => reload()} disabled={!dir}>
          <Icon.refresh size={14} />
          刷新
        </button>
        <button
          className="btn sm"
          onClick={async () => {
            const d = await bridge.dialog.openFolder({ title: '打开其他文件夹', defaultPath: dir })
            if (d) setDir(d)
          }}
        >
          <Icon.folder size={14} />
          切换目录
        </button>
        <button className="btn sm primary" onClick={() => bridge.shell.openPath(dir)} disabled={!dir}>
          <Icon.external size={14} />
          用文件管理器打开
        </button>
      </div>

      <div className="panel-body">
        <div className="row" style={{ marginBottom: 14, gap: 8 }}>
          <button className={clsx('btn sm', view === 'files' && 'primary')} onClick={() => setView('files')}>
            <Icon.folder size={14} />
            目录浏览
          </button>
          <button className={clsx('btn sm', view === 'generated' && 'primary')} onClick={() => setView('generated')}>
            <Icon.sparkles size={14} />
            AI 生成的文件 ({data.artifacts.length})
          </button>
        </div>

        {view === 'generated' ? (
          data.artifacts.length ? (
            <div className="col" style={{ gap: 9 }}>
              {data.artifacts.map((a) => (
                <div className="kb-item" key={a.id}>
                  <div className="kb-icon">
                    {a.kind === 'chart' ? <Icon.chart size={17} /> : a.kind === 'doc' ? <Icon.file size={17} /> : <Icon.image size={17} />}
                  </div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="kb-name">{a.name}</div>
                    <div className="kb-meta">
                      <span>{a.ext?.toUpperCase() || a.kind}</span>
                      <span>{fmtBytes(a.size)}</span>
                      <span>{fmtDateTime(a.createdAt)}</span>
                    </div>
                  </div>
                  <div className="row" style={{ gap: 4, flex: '0 0 auto' }}>
                    {a.path ? (
                      <>
                        <button className="btn ghost icon sm" title="预览" onClick={() => bridge.shell.openPath(a.path!)}>
                          <Icon.eye size={14} />
                        </button>
                        <button className="btn ghost icon sm" title="在文件夹中显示" onClick={() => bridge.fs.reveal(a.path!)}>
                          <Icon.folder size={14} />
                        </button>
                        <button
                          className="btn ghost icon sm"
                          title="另存为"
                          onClick={async () => {
                            const dest = await bridge.dialog.saveFile({ title: '另存为', defaultPath: a.path })
                            if (dest) {
                              const r = await bridge.fs.rename(a.path!, dest)
                              app.toast(r.ok ? { kind: 'success', title: '已另存为', body: dest } : { kind: 'error', title: '失败', body: r.error })
                            }
                          }}
                        >
                          <Icon.download size={14} />
                        </button>
                      </>
                    ) : null}
                    <button
                      className="btn ghost icon sm"
                      title="删除"
                      onClick={async () => {
                        const ok = await app.ask({ title: `删除「${a.name}」？`, body: a.path ? '同时会删除磁盘上的文件。' : '仅从列表中移除。', confirmText: '删除', danger: true })
                        if (ok) {
                          if (a.path) await bridge.fs.delete(a.path)
                          await data.deleteArtifact(a.id)
                        }
                      }}
                    >
                      <Icon.trash size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon="sparkles" title="还没有生成文件" body="让 AI 导出讲义、试卷或知识点整理，生成的文件会出现在这里，同时保存到你的工作区目录。" />
          )
        ) : !dir ? (
          <EmptyState icon="folder" title="未设置工作区" body="选择一个文件夹作为工作区，AI 生成的文件与可读取的资料都以此为根目录。">
            <button className="btn primary" onClick={() => app.setView('settings', 'workspace')}>
              去设置工作区
            </button>
          </EmptyState>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 12, gap: 8 }}>
              <button className="btn ghost icon sm" onClick={() => setDir(parentDir)} disabled={!parentDir || parentDir === dir}>
                <Icon.chevron size={15} style={{ transform: 'rotate(180deg)' }} />
              </button>
              <span className="mono muted" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {dir}
              </span>
              <span className="grow" />
              <span className="muted" style={{ fontSize: 11.5 }}>{filtered.length} 项</span>
            </div>

            {loading ? (
              <div className="muted" style={{ fontSize: 13 }}>正在读取…</div>
            ) : filtered.length ? (
              <div className="col" style={{ gap: 7 }}>
                {filtered.map((r) => (
                  <div className="kb-item" key={r.path} style={{ cursor: 'pointer' }} onClick={() => open(r)}>
                    <div className="kb-icon" style={{ background: r.isDir ? 'var(--bg-3)' : 'var(--accent-soft)', color: r.isDir ? 'var(--text-2)' : 'var(--accent)' }}>
                      {r.isDir ? <Icon.folder size={17} /> : <Icon.file size={17} />}
                    </div>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="kb-name">{r.name}</div>
                      <div className="kb-meta">
                        <span>{r.isDir ? '文件夹' : fmtBytes(r.size)}</span>
                        <span>{fmtDateTime(r.mtime)}</span>
                      </div>
                    </div>
                    <div className="row" style={{ gap: 4, flex: '0 0 auto' }} onClick={(e) => e.stopPropagation()}>
                      <button className="btn ghost icon sm" title="在文件夹中显示" onClick={() => bridge.fs.reveal(r.path)}>
                        <Icon.folder size={14} />
                      </button>
                      <button
                        className="btn ghost icon sm"
                        title="让 AI 读取这个文件"
                        onClick={() => {
                          app.setView('chat')
                          setTimeout(() => {
                            const el = document.getElementById('yanlai-composer') as HTMLTextAreaElement | null
                            if (el) {
                              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                              setter?.call(el, `请阅读文件 ${r.path}，然后总结它的主要考点。`)
                              el.dispatchEvent(new Event('input', { bubbles: true }))
                              el.focus()
                            }
                          }, 120)
                        }}
                      >
                        <Icon.sparkles size={14} />
                      </button>
                      <button
                        className="btn ghost icon sm"
                        title="导入到知识库"
                        onClick={async () => {
                          const res = await data.importFromPaths([r.path])
                          app.toast(
                            res.ok
                              ? { kind: 'success', title: '已导入知识库', body: r.name }
                              : { kind: 'error', title: '导入失败', body: res.failed.join('；') },
                          )
                        }}
                      >
                        <Icon.database size={14} />
                      </button>
                      <button
                        className="btn ghost icon sm"
                        title="删除"
                        onClick={async () => {
                          const ok = await app.ask({ title: `删除「${r.name}」？`, body: '文件将从磁盘中永久删除。', confirmText: '删除', danger: true })
                          if (ok) {
                            await bridge.fs.delete(r.path)
                            void reload()
                          }
                        }}
                      >
                        <Icon.trash size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon="folder" title={query ? '没有匹配的文件' : '文件夹是空的'} body={query ? '换个关键词试试。' : 'AI 生成的文件会保存到这里。也可以把教材资料放进来，让 AI 读取。'} />
            )}
          </>
        )}
      </div>

      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name || ''} icon="file" wide>
        {preview?.url ? (
          <img src={preview.url} alt={preview.name} style={{ maxWidth: '100%', borderRadius: 10 }} />
        ) : (
          <div style={{ maxHeight: '64vh', overflow: 'auto' }}>
            <Markdown>{preview?.text || ''}</Markdown>
          </div>
        )}
      </Modal>
    </>
  )
}

export type { Artifact }
