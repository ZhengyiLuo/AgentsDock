import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localSessionImportCapability, localSessionImportListLimit, localSessionImportBatchLimit,
  parseLocalSessionCandidatesResponse, parseBulkImportSessionItems, parseBulkImportSessionResultsResponse } from './local-session-import'
import type { Health } from '../types'

const capability = { available: true, required: false, message: 'Available', action: null, version: 1 as const, max_list_items: 700, max_batch_items: 50 }
const health: Health = { ok: true, api_contract_version: 15, capabilities: { local_session_import_v1: capability } }
test('local import requires the full negotiated server contract and caps advertised limits', () => {
  assert.equal(localSessionImportCapability(health), capability)
  assert.equal(localSessionImportListLimit(capability), 500)
  assert.equal(localSessionImportBatchLimit(capability), 25)
  for (const candidate of [null, { ...health, ok: false }, { ...health, api_contract_version: 14 },
    { ...health, capabilities: {} }, { ...health, capabilities: { local_session_import_v1: { ...capability, available: false } } }]) {
    assert.equal(localSessionImportCapability(candidate), null)
  }
})
test('candidate parser rejects oversized, duplicate, invalid, and unsupported provider identities', () => {
  const row = { provider_session_id: 'provider-a', backend: 'codex', label: 'Saved', cwd: '/project', updated_at: '2026-09-14T00:00:00Z' }
  assert.equal(parseLocalSessionCandidatesResponse({ sessions: [row] })[0].label, 'Saved')
  assert.throws(() => parseLocalSessionCandidatesResponse({ sessions: [row, row] }), /duplicate/)
  assert.throws(() => parseLocalSessionCandidatesResponse({ sessions: [row] }, 0), /invalid/)
  assert.throws(() => parseLocalSessionCandidatesResponse({ sessions: [{ ...row, backend: 'cursor' }] }), /invalid/)
  assert.throws(() => parseLocalSessionCandidatesResponse({ sessions: [{ ...row, provider_session_id: '\u0000' }] }), /invalid/)
})
test('import writes validate identities and success receipts must exactly cover requested items', () => {
  const requested = [{ provider_session_id: 'provider-a', backend: 'codex' as const }]
  assert.deepEqual(parseBulkImportSessionItems(requested, 25), requested)
  assert.throws(() => parseBulkImportSessionItems([...requested, ...requested]), /duplicates/)
  assert.throws(() => parseBulkImportSessionItems([{ ...requested[0], provider_session_id: ' padded ' }]), /invalid/)
  const result = { provider_session_id: 'provider-a', backend: 'codex', ok: true, imported: 1, session_id: 'chat-a' }
  assert.equal(parseBulkImportSessionResultsResponse({ results: [result] }, requested)[0].session_id, 'chat-a')
  for (const value of [{ ...result, imported: 0 }, { ...result, session_id: null }, { ...result, provider_session_id: 'other' }, { ...result, ok: false }]) {
    assert.throws(() => parseBulkImportSessionResultsResponse({ results: [value] }, requested))
  }
  assert.throws(() => parseBulkImportSessionResultsResponse({ results: [] }, requested), /count/)
})
