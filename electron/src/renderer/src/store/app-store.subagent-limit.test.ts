import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { BootstrapPayload, ProfileProviderRuntimeEvent, Session } from '@shared/types'
import { useAppStore } from './app-store'

const pending: Session = { id: 'chat', title: 'Chat', backend: 'codex', subagent_limit: 64,
  subagent_limit_control: { supported: true, applies_to: 'automatically_when_idle', application_state: 'pending',
    requested_limit: 64, effective_limit: 16 } }
const applied: ProfileProviderRuntimeEvent = {
  profileId: 'one', profileGeneration: 4,
  event: { type: 'provider_runtime_changed', session_id: 'chat', backend: 'codex', runtime: 'subagent_limit', ephemeral: true,
    subagent_limit: 64, subagent_limit_control: { ...pending.subagent_limit_control!, application_state: 'applied', effective_limit: 64 } }
}
async function install() {
  const handlers = new Map<string, (value: any) => void>()
  const fetch = vi.fn()
  const payload: BootstrapPayload = {
    settings: { serverUrl: '', hasAccessToken: false, serverSetupComplete: true }, health: null, sessions: [], jobs: [], selectedSessionId: null,
    folderOrder: [], collapsedFolders: [], archivedCollapsed: false, inspectorVisible: true
  }
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    bootstrap: async () => payload,
    events: { on: (name: string, callback: (value: any) => void) => { handlers.set(name, callback); return () => handlers.delete(name) } },
    native: { log: vi.fn(), setBadge: vi.fn() }, sessions: { get: fetch, list: fetch },
    servers: { refresh: fetch }
  } as unknown as AgentsDockAPI })
  await useAppStore.getState().initialize()
  const other: Session = { ...pending, id: 'other' }
  useAppStore.setState({ activeProfileId: 'one', profileGeneration: 4, switchingProfileId: null,
    profiles: [{ id: 'one', serverIdentity: 'server-one' }] as any,
    sessions: [pending, other], selectedSessionId: 'chat', activeSessionIds: new Set(['chat']),
    snapshots: { chat: { session: { ...pending, system_prompt: 'Fixture full session detail' }, events: [], queuedTurns: [], files: [], eventsTotal: 0,
      hasMoreEvents: false, filesTotal: 0, cachedAt: 0 } } })
  return { receive: (value: ProfileProviderRuntimeEvent) => handlers.get('server:provider-runtime')?.(value), fetch, other }
}

beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true))

describe('subagent limit acknowledgment stream', () => {
  it('updates the existing session and snapshot live without fetching or disturbing work', async () => {
    const api = await install()
    const before = useAppStore.getState()
    api.receive(applied)
    const after = useAppStore.getState()
    expect(after.sessions[0].subagent_limit_control).toEqual(applied.event.runtime === 'subagent_limit' && applied.event.subagent_limit_control)
    expect(after.snapshots.chat.session.subagent_limit_control).toBe(after.sessions[0].subagent_limit_control)
    expect(after.snapshots.chat.session.subagent_limit).toBe(64)
    expect(after.snapshots.chat.session.system_prompt).toBe('Fixture full session detail')
    expect(after.sessions[1]).toBe(api.other)
    expect(after.snapshots.chat.events).toBe(before.snapshots.chat.events)
    expect(after.snapshots.chat.queuedTurns).toBe(before.snapshots.chat.queuedTurns)
    expect(after.activeSessionIds).toBe(before.activeSessionIds)
    expect(api.fetch).not.toHaveBeenCalled()
  })

  it('ignores other profiles, generations, unknown chats and unrelated runtime notices', async () => {
    const api = await install()
    const before = useAppStore.getState().sessions
    api.receive({ ...applied, profileId: 'two' })
    api.receive({ ...applied, profileGeneration: 3 })
    api.receive({ ...applied, event: { ...applied.event, session_id: 'missing' } })
    api.receive({ ...applied, event: { type: 'provider_runtime_changed', session_id: 'chat', backend: 'codex', runtime: 'context_usage', ephemeral: true } })
    expect(useAppStore.getState().sessions).toBe(before)
    expect(api.fetch).not.toHaveBeenCalled()
  })

  it('applies endpoint catalog changes to the matching session and snapshot without fetching', async () => {
    const api = await install()
    const before = useAppStore.getState()
    const updated: Session = { ...pending, codex_provider: 'custom', model: 'new-model', effort: 'low',
      codex_provider_catalog: { configured: true, available: true, base_url: 'https://new.example/v1', model: 'new-model',
        models: [{ value: 'new-model', label: 'New model' }] },
      codex_provider_control: { pending: false, active_provider: 'custom', requested_provider: 'custom',
        active_base_url: 'https://new.example/v1', requested_base_url: 'https://new.example/v1' } }
    const packet: ProfileProviderRuntimeEvent = { profileId: 'one', profileGeneration: 4,
      event: { type: 'provider_runtime_changed', session_id: 'chat', backend: 'codex',
        runtime: 'codex_provider', ephemeral: true, session: updated } }
    api.receive({ ...packet, profileId: 'two' })
    api.receive({ ...packet, profileGeneration: 3 })
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    api.receive(packet)
    const after = useAppStore.getState()
    expect(after.sessions[0]).toEqual(updated)
    expect(after.snapshots.chat.session.codex_provider_catalog).toBe(updated.codex_provider_catalog)
    expect(after.snapshots.chat.session.system_prompt).toBe('Fixture full session detail')
    expect(after.sessions[1]).toBe(api.other)
    expect(after.snapshots.chat.events).toBe(before.snapshots.chat.events)
    expect(after.snapshots.chat.queuedTurns).toBe(before.snapshots.chat.queuedTurns)
    expect(after.activeSessionIds).toBe(before.activeSessionIds)
    expect(api.fetch).not.toHaveBeenCalled()
  })
})
