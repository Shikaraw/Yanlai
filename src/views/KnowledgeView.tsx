import { useMemo, useState } from 'react'
import { useApp } from '../store/useApp'
import { useData } from '../store/useData'
import { Icon } from '../components/Icons'
import { EmptyState, Field, Modal, Segmented } from '../components/ui'
import { Markdown } from '../components/Markdown'
import { bridge } from '../lib/bridge'
import { clsx, fmtBytes, fmtDateTime, fmtDate } from '../lib/util'
import { SUBJECTS } from '../lib/prompts'
import type { KnowledgeDoc } from '../lib/types'

export function KnowledgeView() {
  const app = useApp()
  const data = useData()
  const [tab, setTab] = useState<'docs' | 'search' | 'ask' | 'paste'>('docs')
  const [importSubject, setImportSubject] = useState('')
  const [editing, setEditing] = useState<KnowledgeDoc | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ReturnType<typeof data.searchKb>>([])
  const [askQ, setAskQ] = useState('')
  const [pasteName, setPasteName] = useState('')
  const [pasteText, setPasteText] = useState('')

  const totalChunks = useMemo(() => data.kbDocs.reduce((n, d) => n + d.chunkCount, 0), [data.kbDocs])
  const totalChars = useMemo(() => data.kbDocs.reduce((n, d) => n + d.chars, 0), [data.kbDocs])

  const doImport = async () => {
    const paths = await bridge.dialog.openFiles({
      multi: true,
      title: '导入知识库资料',
      filters: [
        { name: '教材与资料', extensions: ['pdf', 'docx', 'doc', 'txt', 'md', 'markdown', 'xlsx', 'xls', 'csv', 'json', 'tex'] },
        { name: '题目图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (!paths.length) return
    const res = await data.importFromPaths(paths, { subject: importSubject || undefined })
    if (res.ok) {
      app.toast({
        kind: 'success',
        title: `已导入 ${res.ok} 份资料`,
        body: res.failed.length ? `${res.failed.length} 份未成功：${res.failed.slice(0, 2).join('；')}` : '已建立检索索引，提问时会自动引用。',
      })
    } else {
      app.toast({ kind: 'error', title: '导入失败', body: res.failed.join('；') || '请检查文件格式。' })
    }
  }

  return (
    <>
      <div className="panel-head">
        <Icon.database size={19} style={{ color: 'var(--accent)' }} />
        <div className="grow">
          <h1>知识库</h1>
          <div className="sub">
            {data.kbDocs.length} 份资料 · {totalChunks} 个片段 · {totalChars.toLocaleString()} 字
            {data.kbIndex ? ` · 本地检索索引已就绪` : ' · 尚未建立索引'}
          </div>
        </div>
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as typeof tab)}
          options={[
            { value: 'docs', label: '资料', icon: 'list' },
            { value: 'search', label: '检索测试', icon: 'search' },
            { value: 'ask', label: '整库问答', icon: 'chat' },
            { value: 'paste', label: '粘贴文本', icon: 'edit' },
          ]}
        />
        <select className="select" style={{ width: 150 }} value={importSubject} onChange={(e) => setImportSubject(e.target.value)}>
          <option value="">导入科目（可选）</option>
          {SUBJECTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="btn sm primary" onClick={doImport}>
          <Icon.upload size={14} />
          导入资料
        </button>
      </div>

      <div className="panel-body">
        {data.importing ? (
          <div className="card" style={{ marginBottom: 15 }}>
            <div className="row between">
              <span className="row center" style={{ gap: 9 }}>
                <span className="tc-spin" style={{ display: 'grid', placeItems: 'center' }}>
                  <Icon.refresh size={15} />
                </span>
                {data.importing.label}
              </span>
              <span className="muted">{Math.round(data.importing.progress * 100)}%</span>
            </div>
            <div className="bar-track" style={{ marginTop: 10 }}>
              <div className="bar-fill" style={{ width: `${data.importing.progress * 100}%` }} />
            </div>
          </div>
        ) : null}

        {tab === 'docs' ? (
          <>
            <div className="dropzone" style={{ marginBottom: 16 }} onClick={doImport} onDragOver={(e) => e.preventDefault()}>
              <Icon.upload size={26} />
              <div style={{ marginTop: 9, fontWeight: 600, fontSize: 14 }}>拖入或点击选择资料</div>
              <div style={{ fontSize: 12.5, marginTop: 5, lineHeight: 1.6 }}>
                支持 PDF、Word、Excel、Markdown、TXT、CSV 与题目截图
                <br />
                资料仅保存在本机，检索在本地完成，不会上传到任何服务器
              </div>
            </div>

            {data.kbDocs.length ? (
              <>
                <div className="row between" style={{ marginBottom: 11 }}>
                  <h2 style={{ fontSize: 15, margin: 0, fontWeight: 660 }}>已导入资料</h2>
                  <div className="row" style={{ gap: 8 }}>
                    <button
                      className="btn sm"
                      title="让 AI 基于全部资料整理成结构化知识库（考纲式大纲 + 知识点）"
                      onClick={() => {
                        app.setView('chat')
                        app.toast({
                          kind: 'info',
                          title: '已切换到对话',
                          body: `可以对我说：「请基于知识库里的 ${data.kbDocs.length} 份资料整理一份考纲式知识点大纲，并存回知识库」。`,
                        })
                      }}
                    >
                      <Icon.sparkles size={14} />
                      AI 整理成知识库
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={async () => {
                        const ok = await app.ask({
                          title: '清空整个知识库？',
                          body: `将删除 ${data.kbDocs.length} 份资料及其索引，操作不可撤销。`,
                          confirmText: '清空',
                          danger: true,
                        })
                        if (ok) {
                          await data.clearKb()
                          app.toast({ kind: 'success', title: '知识库已清空' })
                        }
                      }}
                    >
                      <Icon.trash size={14} />
                      清空
                    </button>
                  </div>
                </div>
                <div className="col" style={{ gap: 9 }}>
                  {data.kbDocs.map((d) => (
                    <div className="kb-item" key={d.id}>
                      <div className="kb-icon">
                        {d.type === 'pdf' ? <Icon.file size={17} /> : d.type === 'docx' ? <Icon.file size={17} /> : d.type === 'xlsx' ? <Icon.grid size={17} /> : d.type === 'image' ? <Icon.image size={17} /> : d.type === 'manual' ? <Icon.sparkles size={17} /> : <Icon.book size={17} />}
                      </div>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="kb-name" title={d.name}>
                          {d.name}
                        </div>
                        <div className="kb-meta">
                          <span className="chip" style={{ fontSize: 10.5 }}>{d.type.toUpperCase()}</span>
                          {d.subject ? <span className="chip accent" style={{ fontSize: 10.5 }}>{d.subject}</span> : null}
                          <span>{d.type === 'image' ? '提问时视觉读取' : `${d.chunkCount} 段`}</span>
                          {d.chars ? <span>{d.chars.toLocaleString()} 字</span> : null}
                          {d.sizeBytes ? <span>{fmtBytes(d.sizeBytes)}</span> : null}
                          <span>{fmtDateTime(d.createdAt)}</span>
                        </div>
                        {d.note ? (
                          <div className="muted" style={{ fontSize: 11.5, marginTop: 4, color: 'var(--warn)' }}>
                            {d.note}
                          </div>
                        ) : null}
                      </div>
                      <div className="row" style={{ gap: 4, flex: '0 0 auto' }}>
                        <button
                          className="btn ghost icon sm"
                          title="查看内容片段"
                          onClick={() => {
                            const text = data.getDocText(d.id)
                            if (text) setEditing({ ...d, note: text.slice(0, 50000) as any })
                            else app.toast({ kind: 'info', title: '该资料没有可显示的文本', body: d.type === 'image' ? '图片资料在提问时由视觉模型直接读取。' : '未提取到文本。' })
                          }}
                        >
                          <Icon.eye size={14} />
                        </button>
                        {d.sourcePath || d.storedPath ? (
                          <button className="btn ghost icon sm" title="在文件夹中显示" onClick={() => bridge.fs.reveal((d.storedPath || d.sourcePath)!)}>
                            <Icon.folder size={14} />
                          </button>
                        ) : null}
                        <button
                          className="btn ghost icon sm"
                          title="删除"
                          onClick={async () => {
                            const ok = await app.ask({ title: `删除「${d.name}」？`, body: '该资料及其索引片段将被移除。', confirmText: '删除', danger: true })
                            if (ok) {
                              await data.deleteKbDoc(d.id)
                              app.toast({ kind: 'success', title: '已删除' })
                            }
                          }}
                        >
                          <Icon.trash size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : !data.importing ? (
              <EmptyState
                icon="database"
                title="还没有导入资料"
                body="导入你的教材、笔记、真题后，我回答问题时会先检索你的资料并标注出处，比凭空作答准确得多。也可以把课堂笔记直接粘贴进来。"
              >
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn primary" onClick={doImport}>
                    <Icon.upload size={15} />
                    选择文件导入
                  </button>
                  <button className="btn" onClick={() => setTab('paste')}>
                    粘贴文本
                  </button>
                </div>
              </EmptyState>
            ) : null}
          </>
        ) : null}

        {tab === 'search' ? (
          <>
            <div className="card" style={{ marginBottom: 15 }}>
              <div className="card-title">
                <Icon.search size={15} />
                检索测试
              </div>
              <div className="card-sub">
                本地 BM25 检索（含中文二元切分），不消耗任何 token。用来确认资料是否被正确索引、关键词能否命中。
              </div>
              <div className="row" style={{ gap: 9 }}>
                <input
                  className="input"
                  placeholder="输入检索词，如：拉格朗日中值定理 条件"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setResults(data.searchKb(query, 8))
                  }}
                />
                <button className="btn primary" disabled={!query.trim()} onClick={() => setResults(data.searchKb(query, 8))}>
                  检索
                </button>
              </div>
            </div>

            {results.length ? (
              <div className="col" style={{ gap: 10 }}>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  命中 {results.length} 个片段（按相关度排序）
                </div>
                {results.map((r) => (
                  <div className="card" key={r.id}>
                    <div className="row between" style={{ marginBottom: 7 }}>
                      <span className="row center" style={{ gap: 7 }}>
                        <Icon.file size={14} style={{ color: 'var(--accent)' }} />
                        <b style={{ fontSize: 13 }}>{r.docName}</b>
                        {r.heading ? <span className="muted" style={{ fontSize: 12 }}>› {r.heading}</span> : null}
                      </span>
                      <span className="chip accent" title="BM25 相关度得分">
                        {r.score.toFixed(2)}
                      </span>
                    </div>
                    <div style={{ fontSize: 12.8, lineHeight: 1.7, color: 'var(--text-1)', whiteSpace: 'pre-wrap' }}>
                      {r.text.slice(0, 640)}
                      {r.text.length > 640 ? '…' : ''}
                    </div>
                    <div className="row wrap" style={{ gap: 5, marginTop: 8 }}>
                      {r.matched.slice(0, 8).map((t) => (
                        <span className="chip" key={t} style={{ fontSize: 10.5 }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : query ? (
              <EmptyState icon="search" title="没有命中" body="试试更具体的术语，或者确认相关内容是否已导入。" />
            ) : null}
          </>
        ) : null}

        {tab === 'ask' ? (
          <>
            <div className="card">
              <div className="card-title">
                <Icon.chat size={15} />
                整库问答
              </div>
              <div className="card-sub">
                针对整个知识库提问，我会先本地检索相关片段，再带着出处作答。适合「这几本书里关于 X 的讲法有何不同」这类问题。
              </div>
              <textarea className="textarea" rows={3} value={askQ} onChange={(e) => setAskQ(e.target.value)} placeholder="如：我的资料里对「等价无穷小替换的条件」是怎么说明的？有哪些限制？" />
              <div className="row" style={{ marginTop: 11, gap: 9 }}>
                <button
                  className="btn primary"
                  disabled={!askQ.trim()}
                  onClick={() => {
                    const q = askQ.trim()
                    app.setView('chat')
                    setTimeout(() => {
                      const el = document.getElementById('yanlai-composer') as HTMLTextAreaElement | null
                      if (el) {
                        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                        setter?.call(el, q)
                        el.dispatchEvent(new Event('input', { bubbles: true }))
                        el.focus()
                      }
                    }, 120)
                  }}
                >
                  <Icon.send size={15} />
                  在对话中提问（带知识库检索）
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  会切换到对话页，问题已自动填入输入框
                </span>
              </div>
            </div>

            <div className="card" style={{ marginTop: 15 }}>
              <div className="card-title">
                <Icon.sparkles size={15} />
                常用操作
              </div>
              <div className="col" style={{ gap: 8 }}>
                {[
                  { label: '整理成考纲式知识点大纲', prompt: '请基于知识库中的全部资料，整理一份考纲式知识点大纲，标出重要度与考频，并存入知识库。' },
                  { label: '提取核心公式清单', prompt: '请从知识库资料中提取核心公式清单，按章节整理成表格，说明每个公式的适用条件。' },
                  { label: '找出资料之间的矛盾与缺口', prompt: '请检查知识库中不同资料对同一考点的表述是否一致，指出矛盾之处以及资料未覆盖的考纲内容。' },
                  { label: '生成背诵卡片', prompt: '请基于知识库资料生成一批背诵卡片，覆盖高频考点，调用工具写入复习队列。' },
                ].map((a) => (
                  <button
                    key={a.label}
                    className="btn"
                    style={{ justifyContent: 'flex-start' }}
                    onClick={() => {
                      app.setView('chat')
                      setTimeout(() => {
                        const el = document.getElementById('yanlai-composer') as HTMLTextAreaElement | null
                        if (el) {
                          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                          setter?.call(el, a.prompt)
                          el.dispatchEvent(new Event('input', { bubbles: true }))
                          el.focus()
                        }
                      }, 120)
                    }}
                  >
                    <Icon.chevron size={14} />
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}

        {tab === 'paste' ? (
          <div className="card" style={{ maxWidth: 760 }}>
            <div className="card-title">
              <Icon.edit size={15} />
              粘贴文本建立知识库
            </div>
            <div className="card-sub">适合课堂笔记、自己整理的提纲、从网页复制的资料。保存后会立即建立检索索引。</div>
            <div className="col" style={{ gap: 12 }}>
              <Field label="资料名称">
                <input className="input" value={pasteName} onChange={(e) => setPasteName(e.target.value)} placeholder="如：数据结构 · 树与二叉树笔记" />
              </Field>
              <Field label="内容" hint="支持 Markdown。用 ## 标题分段能让检索更准。">
                <textarea className="textarea" rows={12} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder={'## 二叉树的遍历\n\n前序遍历：根 → 左 → 右\n…'} />
              </Field>
              <div className="row" style={{ gap: 9 }}>
                <button
                  className="btn primary"
                  disabled={!pasteName.trim() || pasteText.trim().length < 20}
                  onClick={async () => {
                    const doc = await data.importText(pasteName.trim(), pasteText, {
                      subject: importSubject || undefined,
                      type: 'manual',
                      tags: [],
                    })
                    app.toast({ kind: 'success', title: '已存入知识库', body: `${doc.chunkCount} 个片段已建立索引。` })
                    setPasteName('')
                    setPasteText('')
                    setTab('docs')
                  }}
                >
                  <Icon.check size={15} />
                  保存并建立索引
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  至少 20 字 · 当前 {pasteText.length} 字
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.name || ''} icon="file" wide>
        {editing ? (
          <div className="col" style={{ gap: 10 }}>
            <div className="row wrap" style={{ gap: 7 }}>
              <span className="chip">{editing.type.toUpperCase()}</span>
              {editing.subject ? <span className="chip accent">{editing.subject}</span> : null}
              <span className="chip">{editing.chunkCount} 段</span>
              <span className="chip">{editing.chars.toLocaleString()} 字</span>
            </div>
            <div style={{ maxHeight: '58vh', overflow: 'auto', padding: '12px 15px', background: 'var(--bg-1)', borderRadius: 10, border: '1px solid var(--line)' }}>
              <Markdown>{String((editing as any).note || '（无内容）')}</Markdown>
            </div>
            {editing.sourcePath ? (
              <div className="muted" style={{ fontSize: 11.5 }}>
                源文件：{editing.sourcePath}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </>
  )
}
