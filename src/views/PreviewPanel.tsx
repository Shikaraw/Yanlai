import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { useData } from '../store/useData'
import { Icon } from '../components/Icons'
import { Markdown } from '../components/Markdown'
import { EmptyState } from '../components/ui'
import { bridge } from '../lib/bridge'
import { clsx, fmtBytes, fmtDateTime } from '../lib/util'
import type { Artifact } from '../lib/types'

type PreviewTab = 'artifact' | 'workspace' | 'kb'

export interface PreviewTarget {
  kind: 'artifact' | 'image' | 'doc' | 'text'
  artifact?: Artifact
  path?: string
  name?: string
  text?: string
}

export function PreviewPanel({
  target,
  onClose,
  onChangeTarget,
}: {
  target: PreviewTarget | null
  onClose: () => void
  onChangeTarget: (t: PreviewTarget) => void
}) {
  const app = useApp()
  const data = useData()
  const [tab, setTab] = useState<PreviewTab>('artifact')
  const [fileText, setFileText] = useState<string>('')
  const [fileUrl, setFileUrl] = useState<string>('')
  const [loading, setLoading] = useState(false)

  const workspace = app.settings?.workspace || ''
  const [wsFiles, setWsFiles] = useState<Array<{ name: string; path: string; isDir: boolean; size: number; mtime: number }>>([])

  useEffect(() => {
    if (target) setTab('artifact')
  }, [target?.artifact?.id, target?.path, target?.name])

  /* ---- load a document/text/image target ---- */
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setFileText('')
      setFileUrl('')
      if (!target) return
      setLoading(true)
      try {
        // inline text provided directly
        if (target.text) {
          setFileText(target.text)
          return
        }
        // inline artifact data
        if (target.artifact?.dataUrl && target.artifact.kind !== 'doc') {
          if (!cancelled) setFileUrl(target.artifact.dataUrl)
          if (target.artifact.svg) setFileText(target.artifact.svg)
          return
        }
        const path = target.path || target.artifact?.path
        if (!path) return
        const ext = (path.split('.').pop() || '').toLowerCase()
        if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'svg'].includes(ext)) {
          const b = await bridge.fs.readBase64(path)
          if (b && !cancelled) setFileUrl(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b.data}`)
          return
        }
        if (['md', 'markdown', 'txt', 'json', 'csv', 'tex', 'log', 'html', 'xml', 'yaml', 'yml'].includes(ext)) {
          const t = await bridge.fs.readText(path)
          if (!cancelled) setFileText(t)
          return
        }
        if (ext === 'pdf') {
          const b = await bridge.fs.readBase64(path)
          if (b && !cancelled) setFileUrl(`data:application/pdf;base64,${b.data}`)
          return
        }
        // docx/xlsx: no inline renderer — offer to open natively
        if (!cancelled) setFileText('')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [target])

  /* ---- workspace listing ---- */
  useEffect(() => {
    if (tab !== 'workspace') return
    let cancelled = false
    const load = async () => {
      if (workspace) {
        const rows = await bridge.fs.listDir(workspace)
        if (!cancelled) setWsFiles(rows)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [tab, workspace])

  const artifacts = useMemo(() => data.artifacts, [data.artifacts])

  const ext = (target?.path || target?.artifact?.name || '').split('.').pop()?.toLowerCase() || ''
  const isDocx = ['docx', 'doc', 'xlsx', 'xls', 'xlsm'].includes(ext)
  const isPdf = ext === 'pdf'
  const isImage = !!fileUrl && !isPdf

  return (
    <div className="preview-panel">
      <div className="preview-tabs">
        <button className={clsx('preview-tab', tab === 'artifact' && 'active')} onClick={() => setTab('artifact')}>
          <Icon.eye size={14} />
          预览
        </button>
        <button className={clsx('preview-tab', tab === 'workspace' && 'active')} onClick={() => setTab('workspace')}>
          <Icon.folder size={14} />
          工作区
        </button>
        <button className={clsx('preview-tab', tab === 'kb' && 'active')} onClick={() => setTab('kb')}>
          <Icon.database size={14} />
          知识库
          {data.kbDocs.length ? <span className="chip" style={{ padding: '0 6px', fontSize: 10 }}>{data.kbDocs.length}</span> : null}
        </button>
        <div className="grow" />
        {target?.path || target?.artifact?.path ? (
          <>
            <button
              className="btn ghost icon sm"
              title="在文件夹中显示"
              onClick={() => bridge.fs.reveal((target.path || target.artifact!.path)!)}
            >
              <Icon.folder size={15} />
            </button>
            <button
              className="btn ghost icon sm"
              title="用系统程序打开"
              onClick={() => bridge.shell.openPath((target.path || target.artifact!.path)!)}
            >
              <Icon.external size={15} />
            </button>
          </>
        ) : null}
        <button className="btn ghost icon sm" title="收起预览" onClick={onClose}>
          <Icon.close size={15} />
        </button>
      </div>

      <div className="preview-body">
        {tab === 'artifact' ? (
          !target ? (
            artifacts.length ? (
              <div className="file-list">
                <div className="sidebar-section-title" style={{ padding: '10px 12px 6px' }}>
                  本次会话生成的文件 · {artifacts.length}
                </div>
                {artifacts.map((a) => (
                  <div
                    className="file-row"
                    key={a.id}
                    onClick={() => onChangeTarget({ kind: 'artifact', artifact: a, name: a.name, path: a.path })}
                  >
                    {a.kind === 'chart' ? <Icon.chart size={16} /> : a.kind === 'doc' ? <Icon.file size={16} /> : <Icon.image size={16} />}
                    <div className="grow">
                      <div className="f-name">{a.name}</div>
                      <div className="f-meta">
                        {a.ext?.toUpperCase()} · {fmtBytes(a.size)} · {fmtDateTime(a.createdAt)}
                      </div>
                    </div>
                    {a.path ? (
                      <button
                        className="btn ghost icon sm"
                        title="导出/另存为"
                        onClick={async (e) => {
                          e.stopPropagation()
                          const dest = await bridge.dialog.saveFile({
                            title: '另存为',
                            defaultPath: a.path,
                          })
                          if (dest) {
                            const r = await bridge.fs.rename(a.path!, dest)
                            if (r.ok) app.toast({ kind: 'success', title: '已另存为', body: dest })
                            else app.toast({ kind: 'error', title: '另存失败', body: r.error })
                          }
                        }}
                      >
                        <Icon.download size={14} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon="eye"
                title="预览区"
                body="讲解中的函数图像、导出的讲义与试卷会显示在这里。也可以在对话里点击图片或文件卡片预览。"
              />
            )
          ) : (
            <div>
              <div className="preview-doc">
                {loading ? (
                  <div className="muted">正在读取…</div>
                ) : isPdf ? (
                  <iframe className="preview-frame" src={fileUrl} title={target.name} style={{ height: '72vh' }} />
                ) : isImage ? (
                  <div className="preview-image-wrap">
                    <img src={fileUrl} alt={target.name} />
                  </div>
                ) : isDocx ? (
                  <div className="col" style={{ gap: 12 }}>
                    <EmptyState
                      icon="file"
                      title={`${ext.toUpperCase()} 文档已生成`}
                      body="Word / Excel 文件需要系统程序打开才能编辑。已保存到你的工作区，也可以在下方用只读方式查看源文本。"
                    />
                    <div className="row" style={{ justifyContent: 'center' }}>
                      {target.path || target.artifact?.path ? (
                        <button className="btn primary" onClick={() => bridge.shell.openPath((target.path || target.artifact!.path)!)}>
                          <Icon.external size={15} />
                          用系统程序打开
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : fileText ? (
                  <Markdown resolveSrc={(s) => s}>{fileText}</Markdown>
                ) : (
                  <EmptyState icon="file" title="无法内联预览" body="该文件格式不支持在应用内预览，可点击右上角用系统程序打开。" />
                )}
              </div>
            </div>
          )
        ) : null}

        {tab === 'workspace' ? (
          <div className="file-list">
            {!workspace ? (
              <EmptyState icon="folder" title="未设置工作区" body="在「设置 → 工作区」中选择一个文件夹，我生成的文件都会保存到这里。">
                <button className="btn primary" onClick={() => app.setView('settings', 'workspace')}>
                  去设置工作区
                </button>
              </EmptyState>
            ) : wsFiles.length ? (
              <>
                <div className="row between" style={{ padding: '6px 10px' }}>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {workspace}
                  </span>
                  <button
                    className="btn ghost icon sm"
                    title="刷新"
                    onClick={async () => setWsFiles(await bridge.fs.listDir(workspace))}
                  >
                    <Icon.refresh size={14} />
                  </button>
                </div>
                {wsFiles.map((f) => (
                  <div
                    className="file-row"
                    key={f.path}
                    onClick={() => {
                      if (f.isDir) {
                        bridge.shell.openPath(f.path)
                        return
                      }
                      onChangeTarget({ kind: 'text', path: f.path, name: f.name })
                    }}
                  >
                    {f.isDir ? <Icon.folder size={16} /> : <Icon.file size={16} />}
                    <div className="grow">
                      <div className="f-name">{f.name}</div>
                      <div className="f-meta">
                        {f.isDir ? '文件夹' : fmtBytes(f.size)} · {fmtDateTime(f.mtime)}
                      </div>
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <EmptyState
                icon="folder"
                title="工作区是空的"
                body="让研来生成讲义、试卷或知识点整理，导出的文件会自动出现在这里。"
              >
                <button className="btn" onClick={() => app.setView('chat')}>
                  去对话生成
                </button>
              </EmptyState>
            )}
          </div>
        ) : null}

        {tab === 'kb' ? (
          <div className="file-list">
            {data.kbDocs.length ? (
              <>
                <div className="sidebar-section-title" style={{ padding: '10px 12px 6px' }}>
                  已导入资料 · {data.kbDocs.length}
                </div>
                {data.kbDocs.map((d) => (
                  <div
                    className="file-row"
                    key={d.id}
                    onClick={() => {
                      const text = data.getDocText(d.id)
                      if (text) onChangeTarget({ kind: 'text', name: d.name, text })
                      else if (d.sourcePath) onChangeTarget({ kind: 'text', path: d.sourcePath, name: d.name })
                    }}
                    title={d.note || d.sourcePath}
                  >
                    <Icon.file size={16} />
                    <div className="grow">
                      <div className="f-name">{d.name}</div>
                      <div className="f-meta">
                        {d.subject ? `${d.subject} · ` : ''}
                        {d.chunkCount} 段 · {d.chars.toLocaleString()} 字
                      </div>
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <EmptyState icon="database" title="知识库为空" body="导入教材、笔记或真题后，提问时我会自动检索并标注出处。">
                <button className="btn primary" onClick={() => app.setView('knowledge')}>
                  去导入资料
                </button>
              </EmptyState>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
