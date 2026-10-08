import { memo, useEffect, useRef, useState } from 'react'
import { Icon, FEATURE_ICON } from './Icons'
import { Markdown } from './Markdown'
import { CopyButton, Dropdown, TimeLabel } from './ui'
import { clsx, fmtBytes } from '../lib/util'
import { featureById } from '../lib/prompts'
import { speech } from '../lib/tts'
import { bridge } from '../lib/bridge'
import type { Artifact, ChatMessage } from '../lib/types'

/* ------------------------------------------------------------------ */
/* tool call chip                                                      */
/* ------------------------------------------------------------------ */
const TOOL_LABELS: Record<string, string> = {
  plot_function: '绘图',
  calculator: '计算',
  write_document: '导出文档',
  read_file: '读取文件',
  list_workspace: '查看工作区',
  search_knowledge_base: '检索知识库',
  search_wrongbook: '检索错题本',
  add_wrongbook_entry: '记录错题',
  add_flashcard: '生成卡片',
  save_study_plan: '写入计划',
  save_knowledge_note: '存入知识库',
}

function ToolChips({ calls }: { calls: NonNullable<ChatMessage['toolCalls']> }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="tools">
      {calls.map((t) => (
        <div key={t.id} style={{ alignSelf: 'flex-start', maxWidth: '100%' }}>
          <button className={clsx('tool-chip', t.status === 'pending' && 'pending')} onClick={() => setOpen(open === t.id ? null : t.id)}>
            <span className="tc-spin" style={{ display: 'grid', placeItems: 'center' }}>
              {t.status === 'pending' ? (
                <Icon.refresh size={13} />
              ) : t.status === 'error' ? (
                <span style={{ color: 'var(--err)' }}>
                  <Icon.alert size={13} />
                </span>
              ) : (
                <span style={{ color: 'var(--ok)' }}>
                  <Icon.check size={13} />
                </span>
              )}
            </span>
            <span className="tc-name">{TOOL_LABELS[t.name] || t.name}</span>
            {t.status === 'pending' ? <span className="muted">执行中…</span> : null}
            {t.result?.match(/命中 (\d+) 段/)?.[1] ? <span className="muted">命中 {t.result.match(/命中 (\d+) 段/)![1]} 段</span> : null}
            <span className="muted" style={{ fontSize: 10.5 }}>
              {open === t.id ? '收起' : '详情'}
            </span>
          </button>
          {open === t.id ? (
            <div className="tool-detail">
              <div style={{ color: 'var(--text-3)', marginBottom: 5 }}>
                参数：<span className="mono">{JSON.stringify(t.args)?.slice(0, 700)}</span>
              </div>
              {t.result ? t.result.slice(0, 2600) : '（等待返回…）'}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* artifact card                                                       */
/* ------------------------------------------------------------------ */
export function ArtifactCard({ a, onOpen }: { a: Artifact; onOpen?: (a: Artifact) => void }) {
  const isChart = a.kind === 'chart' && (a.svg || a.dataUrl)
  const isImg = a.dataUrl && (a.ext === 'png' || a.ext === 'jpg' || a.ext === 'jpeg' || a.ext === 'webp' || a.mime?.startsWith('image/'))
  const canOpen = !!(a.path || a.dataUrl)
  return (
    <div className="artifact">
      <div className="artifact-head">
        {isChart ? <Icon.chart size={15} /> : a.kind === 'doc' ? <Icon.file size={15} /> : <Icon.image size={15} />}
        <span className="a-name" title={a.name}>
          {a.name}
        </span>
        <span className="chip">{a.ext?.toUpperCase() || a.kind}</span>
        {a.size ? <span className="muted" style={{ fontSize: 11 }}>{fmtBytes(a.size)}</span> : null}
        {a.path ? (
          <button className="btn ghost icon sm" title="在文件夹中显示" onClick={() => bridge.fs.reveal(a.path!)}>
            <Icon.folder size={14} />
          </button>
        ) : null}
        {a.path ? (
          <button className="btn ghost icon sm" title="用系统程序打开" onClick={() => bridge.shell.openPath(a.path!)}>
            <Icon.external size={14} />
          </button>
        ) : null}
        {canOpen && onOpen ? (
          <button className="btn ghost icon sm" title="在右侧预览" onClick={() => onOpen(a)}>
            <Icon.eye size={14} />
          </button>
        ) : null}
      </div>
      {isChart || isImg ? (
        <div className="artifact-body">
          {isChart && a.svg ? (
            <div style={{ width: '100%' }} dangerouslySetInnerHTML={{ __html: a.svg }} onClick={() => onOpen?.(a)} />
          ) : (
            <img src={a.dataUrl} alt={a.name} onClick={() => onOpen?.(a)} />
          )}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* message                                                            */
/* ------------------------------------------------------------------ */
export interface MessageProps {
  message: ChatMessage
  /** whether this is the last assistant message (enables regenerate) */
  isLastAssistant?: boolean
  onRegenerate?: () => void
  onEdit?: (m: ChatMessage) => void
  onDelete?: () => void
  onOpenArtifact?: (a: Artifact) => void
  onOpenImage?: (src: string, alt: string) => void
  showTimestamps?: boolean
}

export const MessageBubble = memo(function MessageBubble({
  message: m,
  isLastAssistant,
  onRegenerate,
  onEdit,
  onDelete,
  onOpenArtifact,
  onOpenImage,
  showTimestamps,
}: MessageProps) {
  const [speaking, setSpeaking] = useState(false)
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const isUser = m.role === 'user'
  const feat = m.feature ? featureById(m.feature) : null
  const FI = feat ? Icon[FEATURE_ICON[feat.id] || 'chat'] : Icon.sparkles

  useEffect(() => {
    const unsub = speech.subscribe((st) => {
      // highlight only when this message's text is the active utterance
      setSpeaking(st.speaking && !!st.current && (m.content || '').includes(st.current.slice(0, 24)))
    })
    return () => {
      unsub()
    }
  }, [m.content])

  const images = (m.attachments || []).filter((a) => a.kind === 'image')
  const files = (m.attachments || []).filter((a) => a.kind !== 'image')
  const hasBody = !!m.content?.trim()
  const streamingEmpty = m.streaming && !hasBody && !m.toolCalls?.length

  return (
    <div className={clsx('msg', isUser ? 'user' : 'assistant', m.error && 'error')} data-msgid={m.id}>
      <div className="msg-avatar">{isUser ? '我' : <FI size={16} />}</div>
      <div className="msg-col">
        <div className="msg-meta">
          <span style={{ fontWeight: 600 }}>{isUser ? '我' : '研来'}</span>
          {feat && !isUser ? <span className="chip accent" style={{ fontSize: 10.5, padding: '1px 7px' }}>{feat.label}</span> : null}
          {m.usage?.total_tokens ? (
            <span className="muted" style={{ fontSize: 10.5 }}>
              {m.usage.prompt_tokens}→{m.usage.completion_tokens} tok
            </span>
          ) : null}
          {showTimestamps ? (
            <span className="muted" style={{ fontSize: 10.5 }}>
              <TimeLabel ts={m.createdAt} />
            </span>
          ) : null}
        </div>

        <div className="msg-bubble">
          {images.length ? (
            <div className="att-grid">
              {images.map((a) => (
                <img
                  key={a.id}
                  className="att-thumb"
                  src={a.dataUrl}
                  alt={a.name}
                  onClick={() => onOpenImage?.(a.dataUrl!, a.name)}
                  title={`${a.name}（点击放大）`}
                />
              ))}
            </div>
          ) : null}
          {files.length ? (
            <div className="att-grid">
              {files.map((a) => (
                <span className="att-file" key={a.id} title={a.path}>
                  <Icon.file size={13} />
                  {a.name}
                  {a.size ? <span className="muted">{fmtBytes(a.size)}</span> : null}
                </span>
              ))}
            </div>
          ) : null}

          {m.reasoning?.trim() ? (
            <details className="reasoning" open={reasoningOpen} onToggle={(e) => setReasoningOpen((e.target as HTMLDetailsElement).open)}>
              <summary>思考过程{m.streaming ? '（推理中…）' : ''}</summary>
              <div style={{ marginTop: 6 }}>{m.reasoning}</div>
            </details>
          ) : null}

          {m.toolCalls?.length ? <ToolChips calls={m.toolCalls} /> : null}

          {streamingEmpty ? (
            <div className="row" style={{ color: 'var(--text-3)', fontSize: 13 }}>
              <span className="tc-spin" style={{ display: 'grid', placeItems: 'center' }}>
                <Icon.refresh size={14} />
              </span>
              正在思考…
            </div>
          ) : hasBody ? (
            <Markdown streaming={m.streaming} onImageClick={onOpenImage} resolveSrc={(s) => s}>
              {m.content}
            </Markdown>
          ) : null}

          {m.artifacts?.map((a) => (
            <ArtifactCard key={a.id} a={a} onOpen={onOpenArtifact} />
          ))}
        </div>

        {!m.streaming && (hasBody || m.toolCalls?.length) ? (
          <div className="msg-actions">
            {!isUser ? (
              <>
                <button
                  className={clsx('msg-action', speaking && 'on')}
                  title={speaking ? '停止朗读' : '朗读这条回复'}
                  onClick={() => (speaking ? speech.stop() : speech.speakNow(m.content))}
                >
                  {speaking ? <Icon.stop size={14} /> : <Icon.volume size={14} />}
                  {speaking ? '停止' : '朗读'}
                </button>
                <CopyButton text={m.content} />
                {isLastAssistant && onRegenerate ? (
                  <button className="msg-action" onClick={onRegenerate} title="重新生成这条回复">
                    <Icon.refresh size={14} />
                    重新生成
                  </button>
                ) : null}
                <button
                  className="msg-action"
                  title="导出为 Word 文档"
                  onClick={async () => {
                    const title = (m.content.match(/^#{1,3}\s*(.+)$/m)?.[1] || '研来讲义').slice(0, 60)
                    const res = await bridge.doc.export({ format: 'docx', title, markdown: m.content })
                    if (res?.ok) {
                      useAppToast('已导出 Word', res.file)
                    } else {
                      useAppToast('导出失败', res?.error, 'error')
                    }
                  }}
                >
                  <Icon.download size={14} />
                  Word
                </button>
                <Dropdown
                  trigger={(open) => (
                    <button className="msg-action" onClick={open} title="更多">
                      <Icon.chevronDown size={14} />
                    </button>
                  )}
                  entries={[
                    { label: '导出 PDF', icon: 'download', onClick: () => exportAs(m.content, 'pdf') },
                    { label: '导出 Markdown', icon: 'file', onClick: () => exportAs(m.content, 'md') },
                    { label: '导出 HTML', icon: 'file', onClick: () => exportAs(m.content, 'html') },
                    { separator: true, label: '' },
                    { label: '引用本条续问', icon: 'chat', onClick: () => onEdit?.({ ...m, role: 'user' }) },
                    { separator: true, label: '' },
                    { label: '删除这条消息', icon: 'trash', danger: true, onClick: onDelete },
                  ]}
                />
              </>
            ) : (
              <>
                <button className="msg-action" onClick={() => onEdit?.(m)} title="编辑并重新提问">
                  <Icon.edit size={14} />
                  编辑
                </button>
                <CopyButton text={m.content} />
                <button className="msg-action" onClick={onDelete} title="删除">
                  <Icon.trash size={14} />
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
})

async function exportAs(markdown: string, format: string) {
  const title = (markdown.match(/^#{1,3}\s*(.+)$/m)?.[1] || '研来文档').slice(0, 60)
  const res = await bridge.doc.export({ format, title, markdown })
  if (res?.ok) useAppToast(`已导出 ${format.toUpperCase()}`, res.file)
  else useAppToast('导出失败', res?.error, 'error')
}

/** Lazily reach the toast store without importing it at module top level. */
function useAppToast(title: string, body?: string, kind: 'success' | 'error' = 'success') {
  import('../store/useApp').then(({ useApp }) => {
    useApp.getState().toast({ kind, title, body })
  })
}
