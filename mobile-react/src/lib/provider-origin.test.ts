import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Event, ProviderHistoryOrigin } from '../types'
import {
  hasProviderUserProvenance, isImportedHistoryRecord, isImportedCodexGoalContext,
  isImportedCodexRuntimeNotification, isImportedProviderControlMetadata, isImportedProviderInterruption,
  isImportedClaudeControlCompanion, isImportedSourceProvenRepair,
  isImportedSourceProvenAssistantReplay, isImportedSourceProvenNativeReplay, mergeProviderInterruptionEvent,
} from './provider-origin'

const digest = (text: string) => bytesToHex(sha256(utf8ToBytes(text)))
const record = (patch: Partial<Event> = {}): Event => ({ id: 'record', session_id: 'chat', seq: 8,
  type: 'turn_started', ts: '2026-09-14T12:00:00Z', run_id: 'import_history', imported: true,
  backend: 'codex', prompt: '', ...patch })
const origin: ProviderHistoryOrigin = { provider: 'codex', kind: 'user', event_id: 'provider-item',
  session_id: 'provider-thread', turn_id: 'provider-turn', timestamp: '2026-09-14T11:59:00.125Z',
  native_event_id: 'native-record', source_text_sha256: digest('Synthetic original input') }

test('only explicit imported history and structured user origin own their respective classifications', () => {
  assert.equal(isImportedHistoryRecord(record()), true)
  for (const patch of [{ imported: false }, { imported: undefined }, { run_id: 'native' }]) assert.equal(isImportedHistoryRecord(record(patch)), false)
  for (const patch of [
    { provider_user_authored: true }, { provider_origin: { ...origin, kind: 'user' as const } },
    ...['clientId', 'client_id', 'clientUserMessageId', 'client_user_message_id'].map(key => ({ [key]: 'human' })),
  ]) assert.equal(hasProviderUserProvenance(record(patch)), true)
  assert.equal(hasProviderUserProvenance(record({ prompt: 'provider_user_authored=true' })), false)
})

for (const kind of ['subagent_notification', 'turn_aborted', 'provider_notice'] as const) {
  test(`${kind} requires complete proof and only retains an exact full-byte stale repair`, () => {
    const text = `<${kind}>Synthetic historical content</${kind}>`
    const proof = record({ metadata_only: true, provider_runtime_context: kind,
      provider_origin: { ...origin, kind, source_text_sha256: digest(text) } })
    assert.equal(isImportedCodexRuntimeNotification(proof), true)
    assert.equal(isImportedProviderControlMetadata(proof), true)
    const stale = record({ prompt: text })
    assert.equal(mergeProviderInterruptionEvent(stale, proof), proof)
    assert.equal(mergeProviderInterruptionEvent(proof, stale), proof)
    for (const patch of [
      { imported: false }, { backend: 'claude' as const }, { run_id: 'native' }, { type: 'assistant_text' },
      { provider_runtime_context: undefined }, { metadata_only: false }, { prompt: text },
      { provider_user_authored: true }, { provider_origin: undefined },
      ...['event_id', 'session_id', 'turn_id', 'timestamp', 'source_text_sha256'].map(key => ({ provider_origin: { ...proof.provider_origin!, [key]: '' } })),
      { provider_origin: { ...proof.provider_origin!, timestamp: '2026-09-14' } },
      { provider_origin: { ...origin, kind: 'user' as const } },
    ]) assert.equal(isImportedCodexRuntimeNotification({ ...proof, ...patch }), false)
    for (const patch of [{ id: 'other' }, { session_id: 'other' }, { seq: 9 }, { run_id: 'import_other' },
      { ts: '2026-09-14T12:01:00Z' }, { prompt: `${text} Human addition` }, { provider_user_authored: true }, { metadata_only: false }]) {
      const incoming = { ...stale, ...patch }
      assert.equal(mergeProviderInterruptionEvent(proof, incoming), incoming)
    }
  })
}

test('native replay proof covers input and output independently and preserves genuinely authored native copies', () => {
  for (const type of ['turn_started', 'assistant_text', 'reasoning_summary']) {
    const input = type === 'turn_started'
    const proof = record({ type, ...(input ? { prompt: '' } : { text: '' }), metadata_only: true,
      provider_user_authored: input, provider_history_repair: 'source_proven_native_replay',
      provider_origin: { ...origin, kind: input ? 'user' : 'assistant' } })
    assert.equal(isImportedSourceProvenNativeReplay(proof), true)
    const stale = { ...proof, provider_history_repair: undefined, metadata_only: undefined,
      ...(input ? { prompt: 'Synthetic original input' } : { text: 'Synthetic original input' }) }
    assert.equal(mergeProviderInterruptionEvent(proof, stale), proof)
    for (const patch of [{ provider_origin: undefined }, { metadata_only: false }, { imported: false },
      { provider_origin: { ...proof.provider_origin!, native_event_id: '' } },
      { provider_origin: { ...proof.provider_origin!, source_text_sha256: 'not-a-digest' } }]) {
      assert.equal(isImportedSourceProvenNativeReplay({ ...proof, ...patch }), false)
    }
    const native = { ...stale, run_id: 'native-run', imported: false }
    assert.equal(mergeProviderInterruptionEvent(proof, native), native)
    const changed = { ...stale, ...(input ? { prompt: 'Different human input' } : { text: 'Different answer' }) }
    assert.equal(mergeProviderInterruptionEvent(proof, changed), changed)
  }
})

test('Claude source repairs retain only their exact records and assistant source identity', () => {
  const input = record({ backend: 'claude', provider_history_repair: 'source_proven_import' })
  assert.equal(isImportedSourceProvenRepair(input), true)
  const stale = { ...input, provider_history_repair: undefined, prompt: 'Original imported wrapper' }
  assert.equal(mergeProviderInterruptionEvent(input, stale), input)
  const assistant = record({ backend: 'claude', type: 'assistant_text', text: '', metadata_only: true,
    provider_history_repair: 'source_proven_assistant_replay', provider_origin: {
      provider: 'claude', event_id: 'source-answer', session_id: 'provider-session', timestamp: origin.timestamp,
    } })
  assert.equal(isImportedSourceProvenAssistantReplay(assistant), true)
  const oldAnswer = { ...assistant, text: 'Old replay', metadata_only: undefined, provider_history_repair: undefined }
  assert.equal(mergeProviderInterruptionEvent(assistant, oldAnswer), assistant)
  for (const patch of [{ seq: 9 }, { run_id: 'import_other' }, { session_id: 'other' }, { provider_user_authored: true },
    { provider_origin: { ...assistant.provider_origin!, event_id: 'different' } }, { metadata_only: false }]) {
    const incoming = { ...oldAnswer, ...patch }
    assert.equal(mergeProviderInterruptionEvent(assistant, incoming), incoming)
  }
})

test('Claude interruption and companion controls require their exact contracts', () => {
  const interruption = record({ type: 'provider_interruption', backend: 'claude', provider_origin: {
    provider: 'claude', kind: 'interruption', event_id: '11111111-1111-4111-8111-111111111111',
    session_id: '22222222-2222-4222-8222-222222222222', timestamp: '2026-09-14T12:00:00Z', cause: 'stop',
  } })
  assert.equal(isImportedProviderInterruption(interruption), true)
  for (const patch of [{ imported: false }, { type: 'turn_started' }, { backend: 'codex' as const }, { provider_origin: null },
    { provider_origin: { ...interruption.provider_origin!, event_id: 'not-a-uuid' } },
    { provider_origin: { ...interruption.provider_origin!, timestamp: '2026-09-14' } }]) {
    assert.equal(isImportedProviderInterruption({ ...interruption, ...patch }), false)
  }
  for (const type of ['history_imported', 'turn_finished']) {
    const companion = record({ type, backend: 'claude', metadata_only: true })
    assert.equal(isImportedClaudeControlCompanion(companion), true)
    assert.equal(mergeProviderInterruptionEvent(companion, { ...companion, metadata_only: undefined }), companion)
    for (const patch of [{ imported: false }, { metadata_only: false }, { run_id: 'native' }, { backend: 'codex' as const }]) {
      assert.equal(isImportedClaudeControlCompanion({ ...companion, ...patch }), false)
    }
  }
})

test('goal context requires both runtime provenance and a complete exact envelope', () => {
  const prompt = '<codex_internal_context source="goal">Continue working toward the active thread goal. <objective>Complete the task.</objective></codex_internal_context>'
  const proof = record({ prompt, provider_runtime_context: 'goal', metadata_only: true })
  assert.equal(isImportedCodexGoalContext(proof), true)
  for (const patch of [{ metadata_only: undefined }, { provider_user_authored: true }, { prompt: `${prompt} A human addition` },
    { provider_runtime_context: undefined }, { prompt: prompt.replace('</codex_internal_context>', '') }]) {
    assert.equal(isImportedCodexGoalContext({ ...proof, ...patch }), false)
  }
})
