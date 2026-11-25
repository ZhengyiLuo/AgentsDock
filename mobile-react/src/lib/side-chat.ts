import type { Backend, Health } from '../types'
export type { SideQuestionsCapability } from '../types'

export const SIDE_QUESTION_MAX_CHARS = 512 * 1024
export const SIDE_CHAT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Only the durable native-context contract is offered on mobile. */
export function sideChatSupported(health: Health | null | undefined, backend: Backend | undefined): boolean {
  const capability = health?.capabilities?.side_questions
  return (backend === 'codex' || backend === 'claude') && capability?.available === true
    && capability.version === 2 && capability.native_context === true && capability.sync === true
    && Array.isArray(capability.backends) && capability.backends.includes(backend)
}

export function sideQuestionLimit(health: Health | null | undefined): number {
  const limit = health?.capabilities?.side_questions?.max_question_chars
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, SIDE_QUESTION_MAX_CHARS) : SIDE_QUESTION_MAX_CHARS
}

export interface SideQuestionInput {
  request_id: string
  question: string
  side_chat_id: string
  after_request_id?: string
  model?: string
  effort?: string
}

export interface SideChatActivityItem {
  id: string
  kind: 'reasoning_summary' | 'reasoning' | 'commentary' | 'answer' | 'tool'
  text: string
  status: 'running' | 'completed'
  tool?: string
}

export interface SyncedSideChat {
  session_id: string
  side_chat_id: string
  revision: number
  last_request_id: string | null
  model?: string
  effort?: string
  exchanges: Array<{
    request_id: string
    question: string
    status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
    answer?: string
    activity?: SideChatActivityItem[]
    context_note?: string
    backend?: 'codex' | 'claude'
    error?: string
    created_at: string
    updated_at: string
  }>
}

export function isSideChatIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

function validUnicode(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (code >= 0xd800 && code <= 0xdfff) return false
  }
  return true
}

/** No visible-history projection or client-authored assistant messages. */
export function validateSideQuestionInput(input: SideQuestionInput, limit = SIDE_QUESTION_MAX_CHARS): SideQuestionInput {
  if (!input || !isSideChatIdentifier(input.request_id) || !isSideChatIdentifier(input.side_chat_id)
    || Object.keys(input).some(key => !['request_id', 'question', 'side_chat_id', 'after_request_id', 'model', 'effort'].includes(key))
    || (input.after_request_id !== undefined && !isSideChatIdentifier(input.after_request_id))) {
    throw new Error('side_question_invalid_request')
  }
  if (typeof input.question !== 'string' || !input.question.trim() || !validUnicode(input.question)
    || Array.from(input.question.trim()).length > limit) throw new Error('side_question_invalid_question')
  const result: SideQuestionInput = { request_id: input.request_id, side_chat_id: input.side_chat_id, question: input.question.trim() }
  if (input.after_request_id !== undefined) result.after_request_id = input.after_request_id
  for (const field of ['model', 'effort'] as const) {
    const value = input[field]
    if (value === undefined) continue
    if (typeof value !== 'string' || !validUnicode(value) || /[\u0000-\u001f\u007f]/.test(value)
      || (field === 'model' && !value.trim()) || Array.from(value).length > (field === 'model' ? 256 : 64)) {
      throw new Error('side_question_invalid_request')
    }
    result[field] = value.trim()
  }
  // The server limits the serialized UTF-8 body, not only question codepoints.
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > SIDE_QUESTION_MAX_CHARS) {
    throw new Error('side_question_invalid_question')
  }
  return result
}

export function parseSyncedSideChat(value: unknown, sessionId: string): SyncedSideChat {
  const chat = value as Partial<SyncedSideChat> | null
  if (!chat || chat.session_id !== sessionId || !isSideChatIdentifier(chat.side_chat_id)
    || !Number.isSafeInteger(chat.revision) || chat.revision! < 0
    || (chat.last_request_id !== null && !isSideChatIdentifier(chat.last_request_id)) || !Array.isArray(chat.exchanges)
    || [chat.model, chat.effort].some(item => item !== undefined && typeof item !== 'string')) {
    throw new Error('side_question_invalid_response')
  }
  const ids = new Set<string>()
  for (const exchange of chat.exchanges) {
    if (!exchange || !isSideChatIdentifier(exchange.request_id) || ids.has(exchange.request_id)
      || typeof exchange.question !== 'string' || !exchange.question.trim()
      || !['running', 'completed', 'cancelled', 'failed', 'interrupted'].includes(exchange.status)
      || (exchange.status === 'completed' && (typeof exchange.answer !== 'string' || !exchange.answer.trim()))
      || (exchange.backend !== undefined && !['codex', 'claude'].includes(exchange.backend))
      || [exchange.answer, exchange.context_note, exchange.error].some(item => item !== undefined && typeof item !== 'string')
      || typeof exchange.created_at !== 'string' || typeof exchange.updated_at !== 'string') {
      throw new Error('side_question_invalid_response')
    }
    if (exchange.activity !== undefined) {
      const activityIds = new Set<string>()
      if (!Array.isArray(exchange.activity) || exchange.activity.some(item => {
        if (!item || typeof item.id !== 'string' || !item.id || activityIds.has(item.id)
          || !['reasoning_summary', 'reasoning', 'commentary', 'answer', 'tool'].includes(item.kind)
          || typeof item.text !== 'string' || !['running', 'completed'].includes(item.status)
          || (item.tool !== undefined && typeof item.tool !== 'string')) return true
        activityIds.add(item.id)
        return false
      })) throw new Error('side_question_invalid_response')
    }
    ids.add(exchange.request_id)
  }
  if (chat.exchanges.filter(exchange => exchange.status === 'running').length > 1) throw new Error('side_question_invalid_response')
  return chat as SyncedSideChat
}
