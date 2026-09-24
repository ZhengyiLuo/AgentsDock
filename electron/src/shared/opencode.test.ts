import { describe, expect, it } from 'vitest'
import type { Event, Health, RuntimeCatalog, Session } from './types'
import { opencodeBackendAvailable, opencodeBackendSupported, runtimeSelectionError, runtimeEffortAfterModelChange, selectableChatBackendChoices, selectableChatBackends } from './runtime-catalog'
import { applyOpenCodeSessionEvent, openCodeProviderCommandsAvailable } from './opencode'
import { normalizeOpenCodePermissionMode, supportedOpenCodePermissionModes } from './opencode-permissions'

const health: Health = { ok: true, capabilities: {
  opencode_backend: { available: true, required: false, action: null, version: 1, message: 'Supported' },
  local_provider_commands_v1: { available: true, required: false, action: null, version: 1, message: 'Skills', supported_backends: ['opencode'] }
} }
const catalog: RuntimeCatalog = { backends: { opencode: {
  available: true, models: [{ value: '', label: 'OpenCode default' }, { value: 'provider/model', label: 'Model' }], efforts: [],
  permission_modes: ['default', 'full_access', 'plan']
} } }

describe('OpenCode optional backend contract', () => {
  it('adopts native identity, clears quarantined context, and rejects stale or foreign events', () => {
    const session: Session = { id: 'chat', title: 'OpenCode', backend: 'opencode' }
    const binding: Event = { id: 'event-1', seq: 1, session_id: 'chat', backend: 'opencode', type: 'provider_session', ts: '', provider_session_id: 'ses-native' }
    const bound = applyOpenCodeSessionEvent(session, binding)
    expect(bound).toMatchObject({ session_id: 'ses-native', opencode_session_id: 'ses-native', backend_locked: true })
    const reset = applyOpenCodeSessionEvent(bound, { ...binding, seq: 2, type: 'provider_session_reset', previous_provider_session_id: 'ses-native' })
    expect(reset).toMatchObject({ session_id: null, opencode_session_id: null, backend_locked: true })
    expect(applyOpenCodeSessionEvent(reset, binding)).toBe(reset)
    expect(applyOpenCodeSessionEvent(bound, { ...binding, seq: 3, session_id: 'other' })).toBe(bound)
    expect(applyOpenCodeSessionEvent(bound, { ...binding, seq: 3, type: 'provider_session_reset', previous_provider_session_id: 'old-native' })).toBe(bound)
  })
  it('separates server support, discoverability, runtime admission and explicit model validation', () => {
    expect(opencodeBackendSupported(health)).toBe(true)
    expect(opencodeBackendAvailable(health, catalog)).toBe(true)
    expect(selectableChatBackends(health, null)).toContain('opencode')
    expect(selectableChatBackends({ ok: true }, catalog)).not.toContain('opencode')
    expect(selectableChatBackendChoices({ ok: true }, catalog)).toContain('opencode')
    expect(runtimeSelectionError({ ok: true }, catalog, 'opencode')).toMatch(/Update the server/)
    expect(runtimeSelectionError(health, null, 'opencode')).toMatch(/loading/)
    expect(runtimeSelectionError(health, catalog, 'opencode', '')).toBeNull()
    expect(runtimeSelectionError(health, catalog, 'opencode', 'provider/model')).toBeNull()
    expect(runtimeSelectionError(health, catalog, 'opencode', 'auto')).toMatch(/not offered by OpenCode/)
    expect(runtimeEffortAfterModelChange(catalog, 'opencode', 'provider/model', 'high')).toBeNull()
  })

  it('uses newer runtime diagnostic failures instead of stale ready catalogs', () => {
    const unavailable: Health = { ...health, runtimes: { opencode: {
      backend: 'opencode', available: false, status: 'missing', message: 'OpenCode CLI is missing.', checked_at: '2026-09-20T12:00:00Z'
    } } }
    expect(opencodeBackendAvailable(unavailable, catalog)).toBe(false)
    expect(runtimeSelectionError(unavailable, catalog, 'opencode')).toContain('CLI is missing')
  })

  it('gates skills independently and keeps only native permission modes', () => {
    expect(openCodeProviderCommandsAvailable(health)).toBe(true)
    expect(openCodeProviderCommandsAvailable({ ok: true })).toBe(false)
    expect(openCodeProviderCommandsAvailable({ ...health, capabilities: { opencode_backend: health.capabilities!.opencode_backend } })).toBe(false)
    expect(normalizeOpenCodePermissionMode('auto_review')).toBe('default')
    expect(normalizeOpenCodePermissionMode('plan')).toBe('plan')
    expect(supportedOpenCodePermissionModes(['default', 'plan', 'bypassPermissions'])).toEqual(['default', 'plan'])
  })
})
