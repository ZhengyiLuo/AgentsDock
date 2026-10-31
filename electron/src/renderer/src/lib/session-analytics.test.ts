import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@shared/types'
import { messageAnalyticsProps, trackConfirmedSessionChange, trackImportedAPIResults } from './session-analytics'
import { useAppStore } from '../store/app-store'

const analytics = vi.hoisted(() => ({ trackEvent: vi.fn() }))
vi.mock('./analytics', () => analytics)
const base: Session = { id: 'private-chat', title: 'Private title', backend: 'codex', cwd: '/private', model: 'private-model' }
beforeEach(() => analytics.trackEvent.mockClear())

describe('message connection kind', () => {
  it.each(['codex', 'claude', 'cursor', 'opencode', 'gemini'] as const)('classifies explicit %s routing only', backend => {
    const field = backend === 'codex' ? 'codex_provider' : 'provider_connection'
    for (const [connection, kind] of [['default', 'default'], ['custom', 'custom_api']] as const) {
      expect(messageAnalyticsProps({...base, backend, [field]:connection})).toEqual({backend,connection_kind:kind})
    }
    for (const connection of [undefined, null, '', 'private-api-host']) {
      expect(messageAnalyticsProps({...base, backend, [field]:connection} as Session)).toEqual({backend})
    }
  })
  it('does not infer from the other provider field or carry content', () => {
    expect(messageAnalyticsProps({...base,provider_connection:'custom'})).toEqual({backend:'codex'})
    expect(messageAnalyticsProps({...base,backend:'claude',codex_provider:'custom'})).toEqual({backend:'claude'})
    expect(messageAnalyticsProps(undefined)).toEqual({})
    const session: Session = {...base,codex_provider:'custom'}
    const snapshot = messageAnalyticsProps(session)
    session.codex_provider = 'default'
    expect(snapshot).toEqual({backend:'codex',connection_kind:'custom_api'})
  })
})

describe('confirmed explicit session metrics', () => {
  it.each([
    ['codex', { codex_sandbox_mode: 'workspace-write', codex_approval_policy: 'never' }],
    ['claude', { claude_permission_mode: 'acceptEdits' }],
    ['cursor', { cursor_permission_mode: 'plan' }],
    ['opencode', { opencode_permission_mode: 'full_access' }],
    ['gemini', { gemini_permission_mode: 'autoEdit' }]
  ] as const)('counts one %s permission action without its values', (backend, patch) => {
    const before = { ...base, backend }
    trackConfirmedSessionChange(before, patch as Partial<Session>, { ...before, ...patch } as Session)
    expect(analytics.trackEvent).toHaveBeenCalledExactlyOnceWith('chat_permission_mode_changed', { backend })
  })

  it('excludes unchanged/rejected models, provider resets and automatic server differences', () => {
    trackConfirmedSessionChange(base, { model: base.model }, base)
    trackConfirmedSessionChange(base, { model: 'rejected' }, base)
    trackConfirmedSessionChange(base, { title: 'New title' }, { ...base, model: 'automatic-migration' })
    trackConfirmedSessionChange(base, { backend: 'claude', model: null }, { ...base, backend: 'claude', model: null })
    expect(analytics.trackEvent.mock.calls).toEqual([['chat_agent_changed', { backend: 'claude' }]])
  })

  it('records model and archive transitions, never their content', () => {
    const changed = { ...base, model: 'secret-custom-model', archived: true }
    trackConfirmedSessionChange(base, { model: changed.model, archived: true }, changed)
    trackConfirmedSessionChange(changed, { archived: false }, { ...changed, archived: false })
    trackConfirmedSessionChange(changed, { archived: true }, changed)
    expect(analytics.trackEvent.mock.calls).toEqual([
      ['chat_model_changed', { backend: 'codex' }], ['chat_archived'], ['chat_unarchived']
    ])
  })

  it('does not mistake server normalization of default connection fields for an Agent change', () => {
    trackConfirmedSessionChange(base, { model: 'selected' }, { ...base, model: 'selected', codex_provider: 'default', provider_connection: 'default' })
    expect(analytics.trackEvent).toHaveBeenCalledExactlyOnceWith('chat_model_changed', { backend: 'codex' })
  })

  it('counts only confirmed explicitly API-bound imports, with local-only correlation', () => {
    const items = ['accepted', 'denied', 'existing', 'unknown', 'missing'].map(provider_session_id => ({ backend: 'gemini' as const, provider_connection: 'custom' as const, provider_session_id }))
    trackImportedAPIResults([...items, items[0], { backend: 'gemini', provider_session_id: 'native' }], [
      { backend: 'gemini', provider_session_id: 'accepted', ok: true, session_id: 'private', imported: 1 },
      { backend: 'gemini', provider_session_id: 'denied', ok: false, session_id: null, imported: 0 },
      { backend: 'gemini', provider_session_id: 'existing', ok: false, session_id: null, imported: 0, code: 'already_imported' },
      { backend: 'gemini', provider_session_id: 'unknown', ok: false, session_id: null, imported: 0, code: 'client_status_unknown' }
    ])
    expect(analytics.trackEvent.mock.calls).toEqual([
      ['imported_chat_api_connected', { backend: 'gemini', success: true }],
      ['imported_chat_api_connected', { backend: 'gemini', success: false }]
    ])
  })
})

describe('store ownership and server confirmation', () => {
  const update = vi.fn()
  beforeEach(() => {
    update.mockReset()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sessions: { update } } })
    useAppStore.setState({ activeProfileId: 'a', profileGeneration: 1, switchingProfileId: null, sessions: [base], error: null })
  })
  it('waits for confirmation; drops a late response after changing servers', async () => {
    let resolve!: (session: Session) => void
    update.mockReturnValue(new Promise<Session>(done => { resolve = done }))
    const pending = useAppStore.getState().updateSession(base.id, { model: 'new-private-model' })
    expect(analytics.trackEvent).not.toHaveBeenCalled()
    useAppStore.setState({ activeProfileId: 'b', profileGeneration: 2 })
    resolve({ ...base, model: 'new-private-model' })
    await pending
    expect(analytics.trackEvent).not.toHaveBeenCalled()
  })
  it('does not count failed/unchanged patches; counts one accepted archive', async () => {
    update.mockRejectedValueOnce(new Error('private-server-error')).mockResolvedValueOnce(base).mockResolvedValueOnce({ ...base, archived: true })
    await useAppStore.getState().updateSession(base.id, { archived: true })
    await useAppStore.getState().updateSession(base.id, { archived: true })
    expect(analytics.trackEvent).not.toHaveBeenCalled()
    await useAppStore.getState().updateSession(base.id, { archived: true })
    expect(analytics.trackEvent).toHaveBeenCalledExactlyOnceWith('chat_archived')
  })
  it('reports Gemini connection failures instead of treating a swallowed error as success', async () => {
    const imported = { ...base, backend: 'gemini' as const, session_id: 'private-native-thread' }
    useAppStore.setState({ sessions: [imported] })
    update.mockRejectedValueOnce(new Error('private-key-error')).mockResolvedValueOnce({ ...imported, provider_connection: 'custom' })
    await useAppStore.getState().updateSession(base.id, { gemini_connect_api: true })
    await useAppStore.getState().updateSession(base.id, { gemini_connect_api: true })
    expect(analytics.trackEvent.mock.calls).toEqual([
      ['imported_chat_api_connected', { backend: 'gemini', success: false }],
      ['imported_chat_api_connected', { backend: 'gemini', success: true }]
    ])
  })
})
