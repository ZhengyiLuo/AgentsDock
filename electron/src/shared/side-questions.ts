import type { Backend, Health } from './types'

export const SIDE_QUESTION_MAX_CHARS = 8000
export const SIDE_QUESTION_MAX_HISTORY_ITEMS = 32
export const SIDE_QUESTION_MAX_HISTORY_CHARS = 60000

export interface SideQuestionsCapability {
  available: boolean
  version: number
  backends: Array<'codex' | 'claude'>
  max_question_chars: number
  history?: boolean
  max_history_items?: number
  max_history_chars?: number
  sync?: boolean
  native_context?: boolean
}

export interface SideQuestionScope {
  profileId: string
  profileGeneration: number
  serverIdentity?: string | null
}

/** Connection generations authorize new work; a verified server owns its conversation across visits. */
export function sideQuestionOwnerKey(scope: SideQuestionScope): string {
  return JSON.stringify([scope.profileId, scope.serverIdentity || scope.profileGeneration])
}

export interface SideQuestionInput {
  request_id: string
  question: string
  history?: SideQuestionHistoryItem[]
  side_chat_id?: string
  after_request_id?: string
}

export interface SideQuestionHistoryItem {
  role: 'user' | 'assistant'
  text: string
}

export interface SideQuestionAnswer {
  request_id: string
  session_id: string
  backend: 'codex' | 'claude'
  answer: string
  context_note?: string
}

export interface SideQuestionCancellation {
  request_id: string
  status: 'cancelled' | 'not_found'
}

export function sideQuestionsAvailable(health: Health | null | undefined, backend: Backend | undefined): boolean {
  const capability = health?.capabilities?.side_questions
  return (backend === 'codex' || backend === 'claude')
    && capability?.available === true
    && capability.version === 2 && capability.native_context === true
    && Array.isArray(capability.backends)
    && capability.backends.includes(backend)
}

export function sideQuestionLimit(health: Health | null | undefined): number {
  const limit = health?.capabilities?.side_questions?.max_question_chars
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, SIDE_QUESTION_MAX_CHARS)
    : SIDE_QUESTION_MAX_CHARS
}

export function sideQuestionHistoryAvailable(health: Health | null | undefined): boolean {
  return health?.capabilities?.side_questions?.history === true
}

function validUnicode(text: string): boolean {
  // A lone surrogate is replaced in transit, changing the request and its
  // receipt identity. Keep frontend and server validation consistent.
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (code >= 0xd800 && code <= 0xdfff) return false
  }
  return true
}

export function validateSideQuestionInput(input: SideQuestionInput, limit = SIDE_QUESTION_MAX_CHARS): SideQuestionInput {
  if (!input || typeof input.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.request_id)) {
    throw new Error('side_question_invalid_request')
  }
  if (typeof input.question !== 'string' || !input.question.trim() || !validUnicode(input.question)
    || Array.from(input.question.trim()).length > limit) {
    throw new Error('side_question_invalid_question')
  }
  const result: SideQuestionInput = { request_id: input.request_id, question: input.question.trim() }
  for (const field of ['side_chat_id', 'after_request_id'] as const) {
    const value = input[field]
    if (value !== undefined) {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('side_question_invalid_request')
      result[field] = value
    }
  }
  if (result.after_request_id && !result.side_chat_id) throw new Error('side_question_invalid_request')
  if (input.history !== undefined) {
    if (!Array.isArray(input.history) || input.history.length > SIDE_QUESTION_MAX_HISTORY_ITEMS || input.history.length % 2 !== 0) {
      throw new Error('side_question_invalid_history')
    }
    let characters = 0
    result.history = input.history.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).some(key => key !== 'role' && key !== 'text')
        || item.role !== (index % 2 === 0 ? 'user' : 'assistant')
        || typeof item.text !== 'string' || !item.text.trim() || !validUnicode(item.text)) {
        throw new Error('side_question_invalid_history')
      }
      characters += Array.from(item.text).length
      if (characters > SIDE_QUESTION_MAX_HISTORY_CHARS) throw new Error('side_question_invalid_history')
      return { role: item.role, text: item.text }
    })
  }
  return result
}

export function parseSideQuestionAnswer(value: unknown, sessionId: string, requestId: string): SideQuestionAnswer {
  const answer = value as Partial<SideQuestionAnswer> | null
  if (!answer || answer.request_id !== requestId || answer.session_id !== sessionId
    || !['codex', 'claude'].includes(answer.backend ?? '')
    || typeof answer.answer !== 'string' || !answer.answer.trim()
    || (answer.context_note !== undefined && typeof answer.context_note !== 'string')) {
    throw new Error('side_question_invalid_response')
  }
  return answer as SideQuestionAnswer
}

/** Server-owned side chat. Revisions survive clear and process restarts. */
export interface SyncedSideChat {
  session_id: string
  side_chat_id: string
  revision: number
  last_request_id: string | null
  exchanges: Array<{
    request_id: string
    question: string
    status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
    answer?: string
    context_note?: string
    backend?: 'codex' | 'claude'
    error?: string
    created_at: string
    updated_at: string
  }>
}

export function sideChatSyncAvailable(health: Health | null | undefined): boolean {
  return health?.capabilities?.side_questions?.sync === true
}

export function parseSyncedSideChat(value: unknown, sessionId: string): SyncedSideChat {
  const chat = value as Partial<SyncedSideChat> | null
  const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
  if (!chat || chat.session_id !== sessionId || !id(chat.side_chat_id)
    || !Number.isSafeInteger(chat.revision) || chat.revision! < 0
    || (chat.last_request_id !== null && !id(chat.last_request_id)) || !Array.isArray(chat.exchanges)) {
    throw new Error('side_question_invalid_response')
  }
  const ids = new Set<string>()
  for (const exchange of chat.exchanges) {
    if (!exchange || !id(exchange.request_id) || ids.has(exchange.request_id)
      || typeof exchange.question !== 'string' || !exchange.question.trim()
      || !['running', 'completed', 'cancelled', 'failed', 'interrupted'].includes(exchange.status)
      || (exchange.status === 'completed' && (typeof exchange.answer !== 'string' || !exchange.answer.trim()))
      || (exchange.backend !== undefined && !['codex', 'claude'].includes(exchange.backend))
      || [exchange.answer, exchange.context_note, exchange.error].some(value => value !== undefined && typeof value !== 'string')
      || typeof exchange.created_at !== 'string' || typeof exchange.updated_at !== 'string') {
      throw new Error('side_question_invalid_response')
    }
    ids.add(exchange.request_id)
  }
  if (chat.exchanges.filter(exchange => exchange.status === 'running').length > 1) throw new Error('side_question_invalid_response')
  return chat as SyncedSideChat
}
