import { describe, expect, it } from 'vitest'
import type { Event } from './types'
import { isImportedClaudeControlCompanion, isImportedProviderControlMetadata, isImportedProviderInterruption, mergeProviderInterruptionEvent } from './provider-origin'

const interruption = (patch: Partial<Event> = {}): Event => ({
  id: 'imported-control',
  session_id: 'chat-1',
  seq: 2,
  type: 'provider_interruption',
  ts: '2026-09-09T10:00:00Z',
  imported: true,
  backend: 'claude',
  provider_origin: {
    provider: 'claude',
    kind: 'interruption',
    event_id: '11111111-1111-4111-8111-111111111111',
    session_id: '22222222-2222-4222-8222-222222222222',
    timestamp: '2026-09-09T10:00:00Z',
    cause: 'unknown'
  },
  ...patch
})
const companion = (patch: Partial<Event> = {}): Event => interruption({
  type: 'turn_finished', metadata_only: true, run_id: 'import_control-only', provider_origin: undefined, ...patch
})

describe('imported Claude control companions', () => {
  it.each(['history_imported', 'turn_finished'])('accepts only the exact flagged %s import lifecycle', type => {
    const record = companion({ type })
    expect(isImportedClaudeControlCompanion(record)).toBe(true)
    expect(isImportedProviderControlMetadata(record)).toBe(true)
    expect(isImportedProviderInterruption(record)).toBe(false)
  })

  it('includes proven interruptions in the shared control-metadata guard', () => {
    expect(isImportedProviderControlMetadata(interruption())).toBe(true)
  })

  it.each([
    ['missing metadata flag', { metadata_only: undefined }],
    ['explicit non-metadata', { metadata_only: false }],
    ['not imported', { imported: false }],
    ['missing import marker', { imported: undefined }],
    ['missing backend', { backend: undefined }],
    ['other backend', { backend: 'codex' }],
    ['missing run', { run_id: undefined }],
    ['native run', { run_id: 'native-run' }],
    ['user start', { type: 'turn_started' }],
    ['native stop', { type: 'turn_stopped' }],
    ['assistant message', { type: 'assistant_text' }]
  ])('does not classify a companion with %s', (_name, patch) => {
    const record = companion(patch as Partial<Event>)
    expect(isImportedClaudeControlCompanion(record)).toBe(false)
    expect(isImportedProviderControlMetadata(record)).toBe(false)
  })
})

describe('imported provider interruption provenance', () => {
  it.each(['steer', 'stop', 'unknown'] as const)('accepts the exact %s lifecycle contract without reading its text', cause => {
    const record = interruption()
    record.provider_origin = { ...record.provider_origin!, cause }
    expect(isImportedProviderInterruption(record)).toBe(true)
    expect(isImportedProviderInterruption({ ...record, prompt: 'User-authored-looking text is not the authority.' })).toBe(true)
  })

  it('accepts canonical UUID casing and ISO offsets without requiring a redundant backend', () => {
    const record = interruption({ backend: undefined })
    record.provider_origin = {
      ...record.provider_origin!,
      event_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      timestamp: '2026-09-09T03:00:00.123456-07:00'
    }
    expect(isImportedProviderInterruption(record)).toBe(true)
  })

  it.each([
    ['ordinary user event', { type: 'turn_started' }],
    ['native stop', { type: 'turn_stopped' }],
    ['native error', { type: 'error' }],
    ['not imported', { imported: false }],
    ['missing import marker', { imported: undefined }],
    ['other backend', { backend: 'codex' }],
    ['missing provenance', { provider_origin: undefined }],
    ['null provenance', { provider_origin: null }],
    ['string provenance', { provider_origin: 'interruption' }]
  ])('does not classify %s as proven metadata', (_name, patch) => {
    expect(isImportedProviderInterruption({ ...interruption(), ...patch } as Event)).toBe(false)
  })

  it.each([
    ['other provider', { provider: 'codex' }],
    ['other kind', { kind: 'message' }],
    ['empty event ID', { event_id: '' }],
    ['noncanonical event ID', { event_id: '11111111111141118111111111111111' }],
    ['missing session ID', { session_id: undefined }],
    ['noncanonical session ID', { session_id: 'provider-session' }],
    ['invalid timestamp', { timestamp: '2026-99-99T10:00:00Z' }],
    ['date without time', { timestamp: '2026-09-09' }],
    ['time without zone', { timestamp: '2026-09-09T10:00:00' }],
    ['missing timestamp', { timestamp: undefined }],
    ['unrecognized cause', { cause: 'user' }],
    ['missing cause', { cause: undefined }]
  ])('rejects provenance with %s', (_name, patch) => {
    const record = interruption()
    expect(isImportedProviderInterruption({
      ...record,
      provider_origin: { ...record.provider_origin, ...patch }
    } as Event)).toBe(false)
  })

  it('does not recognize a real or legacy imported user message from its interruption text', () => {
    for (const imported of [false, true]) {
      expect(isImportedProviderInterruption(interruption({
        type: 'turn_started', imported, provider_origin: undefined,
        prompt: '[Request interrupted by user]'
      }))).toBe(false)
    }
  })
})

describe('provider interruption repair precedence', () => {
  it.each(['history_imported', 'turn_finished'])('preserves a proven %s companion correction in either direction', type => {
    const corrected = companion({ type })
    const stale = { ...corrected, metadata_only: undefined }
    expect(mergeProviderInterruptionEvent(stale, corrected)).toBe(corrected)
    expect(mergeProviderInterruptionEvent(corrected, stale)).toBe(corrected)
  })

  it('recognizes only the exact legacy history_imported omission of the import flag', () => {
    const corrected = companion({ type: 'history_imported' })
    const stale = { ...corrected, metadata_only: undefined, imported: undefined }
    expect(mergeProviderInterruptionEvent(corrected, stale)).toBe(corrected)
    const native = { ...stale, imported: false }
    expect(mergeProviderInterruptionEvent(corrected, native)).toBe(native)
    const unprovenTerminal = { ...stale, type: 'turn_finished' }
    expect(mergeProviderInterruptionEvent(companion(), unprovenTerminal)).toBe(unprovenTerminal)
  })

  it.each([
    ['different ID', { id: 'different-id' }],
    ['different session', { session_id: 'different-chat' }],
    ['different sequence', { seq: 3 }],
    ['different lifecycle', { type: 'history_imported' }],
    ['different import run', { run_id: 'import_other' }],
    ['different backend', { backend: 'codex' }],
    ['not imported', { imported: false }],
    ['missing import flag', { imported: undefined }],
    ['explicit non-metadata', { metadata_only: false }]
  ])('preserves incoming companion authority with %s', (_name, patch) => {
    const incoming = companion({ metadata_only: undefined, ...patch } as Partial<Event>)
    expect(mergeProviderInterruptionEvent(companion(), incoming)).toBe(incoming)
  })

  it('keeps the proven correction in either merge direction for the same chat and event ID', () => {
    const corrected = interruption()
    const legacy = interruption({ type: 'turn_started', provider_origin: undefined, prompt: '[Request interrupted by user]' })
    expect(mergeProviderInterruptionEvent(legacy, corrected)).toBe(corrected)
    expect(mergeProviderInterruptionEvent(corrected, legacy)).toBe(corrected)
  })

  it.each([
    ['different event', { id: 'different-id' }],
    ['different chat', { session_id: 'different-chat' }],
    ['native user message', { imported: false }],
    ['different provider', { backend: 'codex' }],
    ['native stop', { type: 'turn_stopped' }],
    ['assistant output', { type: 'assistant_text' }]
  ])('preserves ordinary incoming precedence for a %s', (_name, patch) => {
    const incoming = interruption({ type: 'turn_started', provider_origin: undefined, ...patch } as Partial<Event>)
    expect(mergeProviderInterruptionEvent(interruption(), incoming)).toBe(incoming)
  })

  it('does not give a malformed correction precedence over a legacy turn', () => {
    const malformed = interruption({ provider_origin: null })
    const legacy = interruption({ type: 'turn_started', provider_origin: undefined })
    expect(mergeProviderInterruptionEvent(malformed, legacy)).toBe(legacy)
  })
})
