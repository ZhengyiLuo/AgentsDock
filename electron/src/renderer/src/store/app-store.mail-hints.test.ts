import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { BootstrapPayload, ProfileBootstrapPayload, PublicServerProfile } from '@shared/types'
import type { TeamHubScope } from '@shared/team-hub'
import { applyMailArrivalHint, beginMailHintStream, type MailHintProjection, type MailHintScope } from '@shared/team-mail-hints'
import { acknowledgeMailHintPage, captureMailHintScope, selectMailHintPending, useAppStore } from './app-store'

const scope: MailHintScope = {
  profileId: 'profile-1', profileGeneration: 1, serverIdentity: 'identity-1', streamId: 'stream-1',
  hubId: 'hub-1', teamId: 'team-1', recipientServerId: 'server-1'
}
const profile: PublicServerProfile = {
  id: scope.profileId, name: 'Test', serverUrl: 'https://example.test', serverIdentity: scope.serverIdentity,
  hasAccessToken: false, serverSetupComplete: true, connectionState: 'offline', cachedUnreadCount: 0
}
const cursor = (sequence: number) => ({ through_sequence: sequence, arrival_id: sequence ? `tmsg_${sequence.toString(16).padStart(32, '0')}` : null })
const coverage = (sequence: number) => ({ version: 1 as const, team_id: scope.teamId, recipient_server_id: scope.recipientServerId, ...cursor(sequence) })
function projection(revision: number, sequence: number, hintScope = scope): MailHintProjection {
  return {
    profileId: hintScope.profileId, profileGeneration: hintScope.profileGeneration, revision,
    state: applyMailArrivalHint(beginMailHintStream(hintScope), hintScope, 'snapshot', {
      ...coverage(sequence), team_id: hintScope.teamId, recipient_server_id: hintScope.recipientServerId, reset: false
    })
  }
}
function bootstrap(mailHints: MailHintProjection | null = null, active = profile, generation = 1): ProfileBootstrapPayload {
  return {
    settings: { serverUrl: active.serverUrl, hasAccessToken: false, serverSetupComplete: true },
    health: null, sessions: [], jobs: [], selectedSessionId: null, folderOrder: [], collapsedFolders: [],
    archivedCollapsed: false, inspectorVisible: true, activeProfileId: active.id, profileGeneration: generation,
    profiles: [active], mailHints
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function install(payload: Promise<BootstrapPayload> = Promise.resolve(bootstrap())) {
  const handlers = new Map<string, (payload: any) => void>()
  const subscriptions = vi.fn((channel: string, handler: (payload: any) => void) => {
    handlers.set(channel, handler)
    return () => handlers.delete(channel)
  })
  const teamHub = {
    teamMessages: vi.fn(), teamMessage: vi.fn(), workspace: vi.fn(), network: vi.fn(), members: vi.fn(),
    recordTeamMessageReceipt: vi.fn(), setTeamMessageMailboxState: vi.fn()
  }
  const acknowledgePage = vi.fn().mockResolvedValue(null)
  const native = { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined), notify: vi.fn() }
  const switchProfile = vi.fn()
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    bootstrap: vi.fn(() => payload), events: { on: subscriptions }, native, teamHub,
    mailHints: { acknowledgePage }, servers: { switch: switchProfile }
  } as unknown as AgentsDockAPI })
  return { handlers, subscriptions, teamHub, acknowledgePage, native, switchProfile }
}

beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true))

describe('passive Mail projection at the real app-store boundary', () => {
  it('max-merges bounded early events with delayed bootstrap and installs exactly one listener', async () => {
    const pending = deferred<BootstrapPayload>()
    const api = install(pending.promise)
    const initializing = useAppStore.getState().initialize()
    const live = projection(3, 9)
    api.handlers.get('team:mail-hints')?.(live)
    api.handlers.get('team:mail-hints')?.(projection(2, 4))
    api.handlers.get('team:mail-hints')?.(projection(100, 900, { ...scope, profileId: 'another-profile' }))
    pending.resolve(bootstrap(projection(1, 1)))
    await initializing
    await useAppStore.getState().initialize()

    expect(useAppStore.getState().mailHints).toBe(live)
    expect(selectMailHintPending(useAppStore.getState())).toBe(true)
    expect(api.subscriptions.mock.calls.filter(([channel]) => channel === 'team:mail-hints')).toHaveLength(1)
    for (const request of Object.values(api.teamHub)) expect(request).not.toHaveBeenCalled()
    expect(api.acknowledgePage).not.toHaveBeenCalled()
    expect(api.native.notify).not.toHaveBeenCalled()
  })

  it('coalesces an event burst and rejects stale revisions, other profiles, generations and identities', async () => {
    const api = install()
    await useAppStore.getState().initialize()
    for (let revision = 1; revision <= 200; revision += 1) api.handlers.get('team:mail-hints')?.(projection(revision, revision))
    const latest = useAppStore.getState().mailHints
    api.handlers.get('team:mail-hints')?.(projection(199, 900))
    api.handlers.get('team:mail-hints')?.(projection(201, 900, { ...scope, profileId: 'other' }))
    api.handlers.get('team:mail-hints')?.(projection(201, 900, { ...scope, profileGeneration: 2 }))
    api.handlers.get('team:mail-hints')?.(projection(201, 900, { ...scope, serverIdentity: 'other' }))
    expect(useAppStore.getState().mailHints).toBe(latest)
    api.handlers.get('team:mail-hints')?.({ profileId: scope.profileId, profileGeneration: 1, revision: 202, state: null })
    api.handlers.get('team:mail-hints')?.(projection(201, 900))
    expect(selectMailHintPending(useAppStore.getState())).toBe(false)
    expect(useAppStore.getState().mailHints?.revision).toBe(202)
    for (const request of Object.values(api.teamHub)) expect(request).not.toHaveBeenCalled()
    expect(api.acknowledgePage).not.toHaveBeenCalled()
  })

  it('clears on verified identity or generation change without carrying the old realm', async () => {
    const api = install(Promise.resolve(bootstrap(projection(1, 7))))
    await useAppStore.getState().initialize()
    const changed = { ...profile, serverIdentity: 'identity-2' }
    api.handlers.get('server:profiles')?.({ activeProfileId: profile.id, profileGeneration: 1, profiles: [changed] })
    expect(useAppStore.getState().mailHints).toBeNull()
    api.handlers.get('team:mail-hints')?.(projection(3, 90))
    expect(useAppStore.getState().mailHints).toBeNull()
    api.handlers.get('team:mail-hints')?.(projection(4, 8, { ...scope, serverIdentity: changed.serverIdentity }))
    expect(selectMailHintPending(useAppStore.getState())).toBe(true)
    api.handlers.get('server:profiles')?.({ activeProfileId: profile.id, profileGeneration: 2, profiles: [changed] })
    expect(useAppStore.getState().mailHints).toBeNull()
  })

  it('merges an event arriving during a switch with that exact profile bootstrap', async () => {
    const api = install(Promise.resolve(bootstrap(projection(1, 3))))
    await useAppStore.getState().initialize()
    const nextProfile = { ...profile, id: 'profile-2', serverIdentity: 'identity-2' }
    const nextScope = { ...scope, profileId: nextProfile.id, serverIdentity: nextProfile.serverIdentity, profileGeneration: 2 }
    const pending = deferred<ProfileBootstrapPayload>()
    api.switchProfile.mockReturnValue(pending.promise)
    const switching = useAppStore.getState().switchServer(nextProfile.id)
    await Promise.resolve()
    await Promise.resolve()
    const newer = projection(5, 11, nextScope)
    api.handlers.get('team:mail-hints')?.(newer)
    expect(selectMailHintPending(useAppStore.getState())).toBe(false)
    pending.resolve(bootstrap(projection(4, 5, nextScope), nextProfile, 2))
    await switching
    expect(useAppStore.getState().mailHints).toBe(newer)
    api.handlers.get('team:mail-hints')?.(projection(6, 100))
    expect(useAppStore.getState().mailHints).toBe(newer)
  })

  it('bounds early unmatched scopes instead of retaining an event backlog', async () => {
    const pending = deferred<BootstrapPayload>()
    const api = install(pending.promise)
    const initializing = useAppStore.getState().initialize()
    api.handlers.get('team:mail-hints')?.(projection(1, 50))
    for (let index = 0; index < 32; index += 1) {
      api.handlers.get('team:mail-hints')?.(projection(index + 2, 1, { ...scope, profileId: `other-${index}` }))
    }
    pending.resolve(bootstrap())
    await initializing
    expect(useAppStore.getState().mailHints).toBeNull()
  })

  it('retains a newer matching hint when a profile switch fails', async () => {
    const api = install()
    await useAppStore.getState().initialize()
    const pending = deferred<ProfileBootstrapPayload>()
    api.switchProfile.mockImplementation(async () => { await pending.promise; throw new Error('Switch failed') })
    const switching = useAppStore.getState().switchServer('another-profile')
    const failed = expect(switching).rejects.toThrow('Switch failed')
    await Promise.resolve()
    await Promise.resolve()
    const newer = projection(2, 7)
    api.handlers.get('team:mail-hints')?.(newer)
    expect(selectMailHintPending(useAppStore.getState())).toBe(false)
    pending.resolve(bootstrap())
    await failed
    expect(useAppStore.getState().mailHints).toBe(newer)
    expect(selectMailHintPending(useAppStore.getState())).toBe(true)
  })

  it('does not let a canceled initialization discard the in-flight switch buffer', async () => {
    const initial = deferred<BootstrapPayload>()
    const api = install(initial.promise)
    const initializing = useAppStore.getState().initialize()
    const nextProfile = { ...profile, id: 'profile-2', serverIdentity: 'identity-2' }
    const nextScope = { ...scope, profileId: nextProfile.id, serverIdentity: nextProfile.serverIdentity, profileGeneration: 2 }
    const pending = deferred<ProfileBootstrapPayload>()
    api.switchProfile.mockReturnValue(pending.promise)
    const switching = useAppStore.getState().switchServer(nextProfile.id)
    await Promise.resolve()
    await Promise.resolve()
    const newer = projection(5, 11, nextScope)
    api.handlers.get('team:mail-hints')?.(newer)
    initial.resolve(bootstrap())
    await initializing
    pending.resolve(bootstrap(projection(4, 5, nextScope), nextProfile, 2))
    await switching
    expect(useAppStore.getState().mailHints).toBe(newer)
  })

  it('captures only the unfiltered own-server Inbox at the exact verified Hub and stream', async () => {
    install(Promise.resolve(bootstrap(projection(1, 9))))
    await useAppStore.getState().initialize()
    const hubScope: TeamHubScope = { profileId: scope.profileId, profileGeneration: 1, serverIdentity: scope.serverIdentity, hubIdentity: scope.hubId, generation: 1 }
    const query = { teamId: scope.teamId, box: 'inbox', addressKind: 'server', addressId: scope.recipientServerId }
    expect(captureMailHintScope(hubScope, query)).toEqual(scope)
    expect(Object.isFrozen(captureMailHintScope(hubScope, query))).toBe(true)
    for (const patch of [{ box: 'sent' }, { addressKind: 'human' }, { addressId: 'another-server' }, { teamId: 'another-team' }, { unread: true }, { fromId: 'sender' }, { since: '2026-09-10' }]) {
      expect(captureMailHintScope(hubScope, { ...query, ...patch })).toBeNull()
    }
    expect(captureMailHintScope({ ...hubScope, hubIdentity: 'another-hub' }, query)).toBeNull()
    expect(captureMailHintScope({ ...hubScope, serverIdentity: 'another-identity' }, query)).toBeNull()
    useAppStore.setState({ switchingProfileId: scope.profileId })
    expect(captureMailHintScope(hubScope, query)).toBeNull()
  })

  it('does not let a delayed acknowledgement replace a newer stream or revision', async () => {
    const api = install(Promise.resolve(bootstrap(projection(1, 9))))
    await useAppStore.getState().initialize()
    const pending = deferred<MailHintProjection | null>()
    api.acknowledgePage.mockReturnValue(pending.promise)
    const acknowledging = acknowledgeMailHintPage(scope, cursor(0), coverage(9))
    const next = projection(3, 12, { ...scope, streamId: 'stream-2' })
    api.handlers.get('team:mail-hints')?.(next)
    pending.resolve({ ...projection(2, 9), state: null })
    await acknowledging
    expect(useAppStore.getState().mailHints).toBe(next)
    await acknowledgeMailHintPage(scope, cursor(0), coverage(9))
    expect(api.acknowledgePage).toHaveBeenCalledOnce()
    for (const request of Object.values(api.teamHub)) expect(request).not.toHaveBeenCalled()
  })
})
