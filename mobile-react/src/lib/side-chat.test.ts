import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSyncedSideChat, sideChatSupported, sideQuestionLimit, validateSideQuestionInput, SIDE_QUESTION_MAX_CHARS, type SyncedSideChat } from './side-chat'
import type { Health } from '../types'

const health: Health = { ok: true, capabilities: { side_questions: { available: true, version: 2, native_context: true, sync: true, backends: ['codex', 'claude'], max_question_chars: 500 } } }
const input = { request_id: 'request-a', side_chat_id: 'side-a', question: ' Why? ' }
const snapshot: SyncedSideChat = { session_id: 'chat-a', side_chat_id: 'side-a', revision: 1, last_request_id: null, exchanges: [] }

await test('only native synchronized Codex and Claude are offered; legacy and unsupported fail closed', () => {
  assert(sideChatSupported(health, 'codex'))
  assert(sideChatSupported(health, 'claude'))
  for (const backend of ['cursor', 'opencode', 'gemini', undefined] as const) assert(!sideChatSupported(health, backend))
  for (const patch of [{ available: false }, { version: 1 }, { native_context: false }, { sync: false }, { backends: [] }]) {
    assert(!sideChatSupported({ ...health, capabilities: { side_questions: { ...health.capabilities!.side_questions!, ...patch } } }, 'codex'))
  }
  assert(!sideChatSupported(undefined, 'codex'))
})

await test('question limits are bounded and validate codepoints, Unicode and serialized byte ceiling', () => {
  assert.equal(sideQuestionLimit(health), 500)
  assert.equal(sideQuestionLimit(null), SIDE_QUESTION_MAX_CHARS)
  assert.equal(sideQuestionLimit({ ...health, capabilities: { side_questions: { ...health.capabilities!.side_questions!, max_question_chars: Infinity } } }), SIDE_QUESTION_MAX_CHARS)
  assert.equal(validateSideQuestionInput(input).question, 'Why?')
  assert.equal(validateSideQuestionInput({ ...input, question: '😀😀' }, 2).question, '😀😀')
  for (const question of ['', ' ', '\ud800', 'long']) assert.throws(() => validateSideQuestionInput({ ...input, question }, 2))
  assert.throws(() => validateSideQuestionInput({ ...input, question: '😀'.repeat(140000) }))
})

await test('request IDs, settings and client-authored history reject before transport', () => {
  assert.deepEqual(validateSideQuestionInput({ ...input, after_request_id: 'previous', model: ' model ', effort: '' }), { ...input, question: 'Why?', after_request_id: 'previous', model: 'model', effort: '' })
  for (const patch of [{ request_id: '../bad' }, { side_chat_id: '' }, { after_request_id: null }, { history: [] }, { model: '' }, { effort: 'bad\n' }]) {
    assert.throws(() => validateSideQuestionInput({ ...input, ...patch } as never))
  }
})

await test('authoritative snapshots retain ordered activity and exact owner', () => {
  const activity = [
    { id: 'thinking', kind: 'reasoning', text: 'Visible native reasoning', status: 'completed' },
    { id: 'tool', kind: 'tool', tool: 'read_file', text: 'Reading', status: 'running' },
  ]
  const value = { ...snapshot, exchanges: [{ request_id: 'request-a', question: 'Why?', status: 'running', activity, created_at: 'now', updated_at: 'now' }] }
  assert.deepEqual(parseSyncedSideChat(value, 'chat-a'), value)
  assert.throws(() => parseSyncedSideChat(value, 'other-chat'))
})

await test('malformed snapshots cannot render foreign, duplicate or impossible progress', () => {
  const exchange = { request_id: 'request-a', question: 'Why?', status: 'running', created_at: 'now', updated_at: 'now' }
  const invalid = [
    { ...snapshot, revision: -1 }, { ...snapshot, last_request_id: undefined },
    { ...snapshot, exchanges: [exchange, exchange] },
    { ...snapshot, exchanges: [exchange, { ...exchange, request_id: 'other' }] },
    { ...snapshot, exchanges: [{ ...exchange, status: 'completed' }] },
    { ...snapshot, exchanges: [{ ...exchange, backend: 'gemini' }] },
    { ...snapshot, exchanges: [{ ...exchange, activity: [{ id: 'a', kind: 'encrypted', text: 'private', status: 'running' }] }] },
  ]
  for (const value of invalid) assert.throws(() => parseSyncedSideChat(value, 'chat-a'))
})
