export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface Attachment {
  id: string
  kind: 'image' | 'file'
  name: string
  path?: string
  mime?: string
  size?: number
  /** inline base64 (images pasted/small) — kept out of the LLM payload once old */
  dataUrl?: string
  text?: string
  ext?: string
}

export interface ToolCallRec {
  id: string
  name: string
  args: any
  result?: string
  status: 'pending' | 'ok' | 'error'
  startedAt?: number
  endedAt?: number
}

export interface ChatMessage {
  id: string
  role: Role
  content: string
  /** reasoning models (deepseek-reasoner / o-series) */
  reasoning?: string
  createdAt: number
  attachments?: Attachment[]
  toolCalls?: ToolCallRec[]
  /** study-feature tag that produced this message */
  feature?: string
  model?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  /** marks locally-generated compaction summaries */
  compacted?: boolean
  error?: boolean
  streaming?: boolean
  /** files produced by tools in this turn */
  artifacts?: Artifact[]
  bookmarked?: boolean
  spoken?: boolean
}

export interface Artifact {
  id: string
  kind: 'doc' | 'image' | 'chart' | 'data' | 'code'
  name: string
  path?: string
  ext?: string
  dataUrl?: string
  /** for plot artifacts */
  svg?: string
  size?: number
  createdAt: number
  fromMessage?: string
  mime?: string
  /** for preview rendering when available */
  text?: string
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  subject?: string
  pinned?: boolean
  archived?: boolean
  /** rolling local summary of dropped turns (token saving) */
  summary?: string
  feature?: string
  sessionTokens?: number
}

export interface KnowledgeDoc {
  id: string
  name: string
  sourcePath?: string
  storedPath?: string
  type: 'txt' | 'md' | 'pdf' | 'docx' | 'xlsx' | 'csv' | 'json' | 'image' | 'manual'
  subject?: string
  tags: string[]
  chars: number
  chunkCount: number
  createdAt: number
  updatedAt: number
  note?: string
  /** auto-organized digest produced by the agent */
  digestDocId?: string
  sizeBytes?: number
}

export interface KbChunk {
  id: string
  docId: string
  docName: string
  idx: number
  heading?: string
  text: string
  tokens: number
  subject?: string
  tags?: string[]
}

export interface WrongEntry {
  id: string
  subject: string
  chapter?: string
  knowledgePoints: string[]
  question: string
  myAnswer?: string
  correctAnswer?: string
  reason: string
  reasonCategory: ReasonCategory
  difficulty: 1 | 2 | 3 | 4 | 5
  source?: string
  createdAt: number
  updatedAt: number
  reviewCount: number
  lastReviewedAt?: number
  nextReviewAt?: number
  mastery: number // 0..5, 5 = mastered
  tags: string[]
  note?: string
  imagePaths?: string[]
  chatId?: string
}

export type ReasonCategory =
  | '概念不清'
  | '公式记错'
  | '计算失误'
  | '审题错误'
  | '思路偏差'
  | '方法不会'
  | '知识盲区'
  | '时间不足'
  | '粗心大意'
  | '其他'

export const REASON_CATEGORIES: ReasonCategory[] = [
  '概念不清',
  '公式记错',
  '计算失误',
  '审题错误',
  '思路偏差',
  '方法不会',
  '知识盲区',
  '时间不足',
  '粗心大意',
  '其他',
]

export interface Flashcard {
  id: string
  front: string
  back: string
  subject?: string
  knowledgePoints: string[]
  box: number // SM-2 lite: 0..5
  dueAt: number
  createdAt: number
  reviewCount: number
  lapses: number
  source?: 'wrongbook' | 'manual' | 'agent' | 'knowledge'
  sourceId?: string
}

export interface PlanItem {
  id: string
  start: string
  end: string
  title: string
  kind: 'study' | 'break' | 'meal' | 'exercise' | 'sleep' | 'class' | 'review' | 'other'
  subject?: string
  note?: string
  remind?: boolean
  color?: string
}

export interface PlanSchedule {
  version: number
  mode: 'weekly' | 'unified' | 'workday'
  weekly: Record<string, PlanItem[]>
  unified: PlanItem[]
  workday: { work: PlanItem[]; rest: PlanItem[] }
  workdays: number[]
  activeDays: number[]
  updatedAt?: number
  name?: string
}

export interface StudyStats {
  totalStudyMinutes: number
  bySubject: Record<string, number>
  streakDays: number
  lastStudyDate?: string
  daily: Record<string, number>
}
