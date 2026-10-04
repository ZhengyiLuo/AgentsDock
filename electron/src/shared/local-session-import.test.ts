import { describe, expect, it } from 'vitest'
import type { Health } from './types'
import {
  cursorLocalSessionImportSupported,
  localSessionImportBatchLimit,
  localSessionImportCapability,
  localSessionImportListLimit,
  parseBulkImportSessionItems,
  parseBulkImportSessionResultsResponse,
  parseLocalSessionCandidatesResponse
} from './local-session-import'

function supportedHealth(overrides: Partial<Health> = {}): Health {
  return {
    ok: true,
    api_contract_version: 15,
    capabilities: {
      local_session_import_v1: {
        available: true,
        required: false,
        message: '',
        action: null,
        version: 1,
        max_batch_items: 25,
        max_list_items: 500
      }
    },
    ...overrides
  }
}

describe('local session import contract', () => {
  it('requires the explicit Cursor public-snapshot capability', () => {
    const base = supportedHealth()
    expect(cursorLocalSessionImportSupported(base)).toBe(false)
    for (const [override, expected] of [
      [{}, true], [{ available: false }, false], [{ version: 0 }, false],
      [{ history_mode: 'unknown' }, false]
    ] as const) {
      expect(cursorLocalSessionImportSupported({ ...base, capabilities: {
        ...base.capabilities,
        local_session_import_cursor_v1: { available: true, version: 1, history_mode: 'initial_text_snapshot', ...override }
      } })).toBe(expected)
    }
  })

  it('accepts Cursor candidates, requests and durable results without weakening identity validation', () => {
    const item = { provider_session_id: 'cursor-native', backend: 'cursor' as const, cwd: '/work' }
    expect(parseBulkImportSessionItems([item])).toEqual([item])
    expect(parseLocalSessionCandidatesResponse({ sessions: [{
      ...item, label: 'Native title', updated_at: '2026-09-20T00:00:00Z'
    }] })[0].backend).toBe('cursor')
    expect(parseBulkImportSessionResultsResponse({ results: [{
      ...item, session_id: 'imported', ok: true, imported: 2
    }] }, [item])[0].ok).toBe(true)
    expect(() => parseBulkImportSessionItems([{ ...item, backend: 'other' }])).toThrow()
  })

  it('requires API 15 and accepts additive capability versions at or above version 1', () => {
    expect(localSessionImportCapability(supportedHealth())).not.toBeNull()
    expect(localSessionImportCapability(supportedHealth({ api_contract_version: 14 }))).toBeNull()
    expect(localSessionImportCapability(supportedHealth({ capabilities: {} }))).toBeNull()
    expect(localSessionImportCapability(supportedHealth({
      capabilities: {
        local_session_import_v1: {
          available: true,
          required: false,
          message: '',
          action: null,
          version: 2 as 1,
          max_batch_items: 25,
          max_list_items: 500
        }
      }
    }))).not.toBeNull()
  })

  it('never exceeds the Electron hard limits when a server advertises larger values', () => {
    const capability = localSessionImportCapability(supportedHealth({
      capabilities: {
        local_session_import_v1: {
          available: true,
          required: false,
          message: '',
          action: null,
          version: 1,
          max_batch_items: 1_000,
          max_list_items: 10_000
        }
      }
    }))!

    expect(localSessionImportBatchLimit(capability)).toBe(25)
    expect(localSessionImportListLimit(capability)).toBe(500)
  })

  it('sanitizes IPC items to the supported field set and rejects duplicate identities', () => {
    expect(parseBulkImportSessionItems([{
      provider_session_id: 'provider-1',
      backend: 'claude',
      cwd: '/work',
      title: 'Chat',
      injected: true
    }])).toEqual([{
      provider_session_id: 'provider-1',
      backend: 'claude',
      cwd: '/work',
      title: 'Chat'
    }])

    expect(() => parseBulkImportSessionItems([
      { provider_session_id: 'provider-1', backend: 'claude' },
      { provider_session_id: 'provider-1', backend: 'claude' }
    ])).toThrow(/duplicates an earlier provider session/i)
  })

  it('accepts duplicate provider strings across backends and preserves truthful result semantics', () => {
    const requested = parseBulkImportSessionItems([
      { provider_session_id: 'provider-1', backend: 'claude' },
      { provider_session_id: 'provider-1', backend: 'codex' }
    ])
    expect(parseBulkImportSessionResultsResponse({
      results: [
        { provider_session_id: 'provider-1', backend: 'claude', session_id: 'chat-a', ok: true, imported: 3 },
        { provider_session_id: 'provider-1', backend: 'codex', session_id: null, ok: false, imported: 0, code: 'empty', error: 'No messages' }
      ]
    }, requested)).toHaveLength(2)

    expect(() => parseBulkImportSessionResultsResponse({
      results: [
        { provider_session_id: 'provider-1', backend: 'claude', session_id: 'chat-a', ok: true, imported: 0 },
        { provider_session_id: 'provider-1', backend: 'codex', session_id: null, ok: false, imported: 0 }
      ]
    }, requested)).toThrow(/internally inconsistent/i)
  })

  it('rejects duplicate candidate identities returned by the server', () => {
    expect(() => parseLocalSessionCandidatesResponse({ sessions: [
      { provider_session_id: 'provider-1', backend: 'claude', label: 'One', updated_at: '2026-08-01T00:00:00Z', cwd: null },
      { provider_session_id: 'provider-1', backend: 'claude', label: 'Two', updated_at: '2026-08-02T00:00:00Z', cwd: null }
    ] })).toThrow(/duplicate local sessions/i)
  })

  it('sanitizes malformed display labels without hiding the remaining local sessions', () => {
    const sessions = parseLocalSessionCandidatesResponse({ sessions: [
      { provider_session_id: 'claude-session-1', backend: 'claude', label: 'Linear-123 \u001b[31mfix', updated_at: '2026-08-01T00:00:00Z', cwd: '/work' },
      { provider_session_id: 'codex-session-2', backend: 'codex', label: null, updated_at: '2026-08-02T00:00:00Z', cwd: null },
      { provider_session_id: 'codex-session-3', backend: 'codex', label: '普通标题 — 🚀', updated_at: '2026-08-03T00:00:00Z', cwd: null }
    ] })

    expect(sessions.map(session => session.label)).toEqual([
      'Claude chat claude-s',
      'Codex chat codex-se',
      '普通标题 — 🚀'
    ])
  })
})
