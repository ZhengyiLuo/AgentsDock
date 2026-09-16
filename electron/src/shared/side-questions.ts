import type { Backend, Health } from './types'

export const SIDE_QUESTION_MAX_CHARS = 8000

export interface SideQuestionsCapability {
  available: boolean
  version: number
  backends: Array<'codex' | 'claude'>
  max_question_chars: number
}

export interface SideQuestionScope {
  profileId: string
  profileGeneration: number
}

export interface SideQuestionInput {
  request_id: string
  question: string
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
    && capability.version === 1
    && Array.isArray(capability.backends)
    && capability.backends.includes(backend)
}

export function sideQuestionLimit(health: Health | null | undefined): number {
  const limit = health?.capabilities?.side_questions?.max_question_chars
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, SIDE_QUESTION_MAX_CHARS)
    : SIDE_QUESTION_MAX_CHARS
}

export function validateSideQuestionInput(input: SideQuestionInput, limit = SIDE_QUESTION_MAX_CHARS): SideQuestionInput {
  if (!input || typeof input.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.request_id)) {
    throw new Error('side_question_invalid_request')
  }
  if (typeof input.question !== 'string' || !input.question.trim() || Array.from(input.question.trim()).length > limit) {
    throw new Error('side_question_invalid_question')
  }
  return { request_id: input.request_id, question: input.question.trim() }
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
