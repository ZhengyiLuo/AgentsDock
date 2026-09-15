import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Event } from '../types'
import { mergeEvents } from './format'
import { isImportedCodexGoalContext, isImportedCodexRuntimeNotification, isImportedSourceProvenNativeReplay } from './provider-origin'
import { mergeAndSanitizeIncomingEvents, sanitizeTimelineEvent } from './timeline-memory'

const hash = (text: string) => bytesToHex(sha256(utf8ToBytes(text)))
const record = (patch: Partial<Event> = {}): Event => ({ id: 'history-record', session_id: 'chat', seq: 100,
  type: 'turn_started', ts: '2026-09-14T12:00:00Z', run_id: 'import_history', imported: true, backend: 'codex', ...patch })
const origin = { provider: 'codex' as const, kind: 'user' as const, event_id: 'provider-item', session_id: 'thread',
  turn_id: 'provider-turn', native_event_id: 'native-input', timestamp: '2026-09-14T12:00:00Z' }

test('raw full-body proof is compared before clipping, never using an equal preview as evidence', () => {
  const body = 'Synthetic full history '.repeat(4_000)
  const stale = record({ prompt: body, provider_user_authored: true })
  const proof = record({ prompt: '', provider_user_authored: true, metadata_only: true,
    provider_history_repair: 'source_proven_native_replay', provider_origin: { ...origin, source_text_sha256: hash(body) } })
  assert.ok(body.length > 48_000)
  assert.equal(isImportedSourceProvenNativeReplay(sanitizeTimelineEvent(proof)), true)
  const retained = mergeAndSanitizeIncomingEvents([proof], [stale])
  assert.equal(retained[0], proof)
  assert.equal(mergeEvents([proof], retained)[0], proof)
  const changed = { ...stale, prompt: `${body} Changed trailing content.` }
  const clippedOriginal = sanitizeTimelineEvent(stale)
  const clippedChanged = sanitizeTimelineEvent(changed)
  assert.equal(clippedOriginal.prompt, clippedChanged.prompt, 'their clipped previews intentionally collide')
  const different = mergeAndSanitizeIncomingEvents([proof], [changed])[0]
  assert.equal(isImportedSourceProvenNativeReplay(different), false)
  assert.ok(different.prompt?.includes('[Content truncated on mobile.]'))
  const unprovable = mergeAndSanitizeIncomingEvents([proof], [clippedOriginal])[0]
  assert.equal(isImportedSourceProvenNativeReplay(unprovable), false, 'a previously clipped copy cannot prove complete source equality')
})

test('full runtime notification hashes survive sanitization and stale raw overlap', () => {
  const body = `<subagent_notification>${'Synthetic worker output '.repeat(3_000)}</subagent_notification>`
  const stale = record({ prompt: body })
  const proof = record({ prompt: '', metadata_only: true, provider_runtime_context: 'subagent_notification',
    provider_origin: { ...origin, kind: 'subagent_notification', source_text_sha256: hash(body) } })
  assert.equal(isImportedCodexRuntimeNotification(sanitizeTimelineEvent(proof)), true)
  assert.equal(mergeAndSanitizeIncomingEvents([proof], [stale])[0], proof)
  assert.equal(isImportedCodexRuntimeNotification(mergeAndSanitizeIncomingEvents([proof], [{ ...stale, prompt: `${body} Human follow-up.` }])[0]), false)
})

test('only a complete proven goal envelope may normalize to empty before the text limit', () => {
  const body = `<codex_internal_context source="goal">Continue working toward the active thread goal. <objective>${'Synthetic objective. '.repeat(4_000)}</objective></codex_internal_context>`
  const proof = record({ prompt: body, provider_runtime_context: 'goal', metadata_only: true })
  const sanitized = sanitizeTimelineEvent(proof)
  assert.equal(sanitized.prompt, '')
  assert.equal(isImportedCodexGoalContext(sanitized), true)
  for (const patch of [{ provider_user_authored: true }, { metadata_only: undefined }, { prompt: `${body} Real user addition.` }]) {
    const preserved = sanitizeTimelineEvent({ ...proof, ...patch })
    assert.notEqual(preserved.prompt, '')
    assert.equal(isImportedCodexGoalContext(preserved), false)
  }
})

test('raw ingress retains batch-local repairs but never borrows proof across a chat identity', () => {
  const stale = record({ prompt: 'Original text', provider_user_authored: true })
  const proof = record({ prompt: '', provider_user_authored: true, metadata_only: true,
    provider_history_repair: 'source_proven_native_replay', provider_origin: { ...origin, source_text_sha256: hash('Original text') } })
  const batch = mergeAndSanitizeIncomingEvents([], [proof, stale])
  assert.equal(batch[1], batch[0])
  const foreign = mergeAndSanitizeIncomingEvents([proof], [{ ...stale, session_id: 'other-chat' }])[0]
  assert.equal(foreign.prompt, 'Original text')
  assert.equal(foreign.provider_history_repair, undefined)
})
