import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentCrossChatRoute, AgentFile, BootstrapPayload, ChatReference, Event, Health, NativeFileRef, ProfileBootstrapPayload, PublicServerProfile,
  QueuedTurn, Session, SessionSnapshot, TimelinePage, TurnStopResult
} from '@shared/types'
import type { AgentsDockAPI } from '@shared/ipc'
import { RUNNING_FORK_UNAVAILABLE } from '@shared/session-fork'
import { isImportedProviderInterruption } from '@shared/provider-origin'
import { CHAT_FONT_SIZES } from '../lib/chat-font'
import { cancelPendingSteering, isSteeringPending, steerQueuedTurn, type SteeringScope } from '../lib/queue-actions'
import { boundedDeferredTimelineEvents, cacheSnapshot, compactSnapshotEvents, crossChatQueueRefreshSessionId, handleMenuCommand, interactiveClientCapabilities, mergeEvents, mergeSnapshots, reconcileSessions, replaceSnapshot, snapshotNeedsAuthoritativeTail, syncSnapshotSessions, timelineReplacementIsDiscontinuous, updateActiveSessions, updateQueuedTurns, useAppStore } from './app-store'

const event = (type: string, patch: Partial<Event> = {}): Event => ({ id: `event-${type}`, session_id: 'chat-1', seq: 1, type, ts: '2026-07-09T10:00:00Z', ...patch })
const providerInterruption = (patch: Partial<Event> = {}): Event => event('provider_interruption', {
  imported: true,
  backend: 'claude',
  provider_origin: {
    provider: 'claude', kind: 'interruption',
    event_id: '11111111-1111-4111-8111-111111111111',
    session_id: '22222222-2222-4222-8222-222222222222',
    timestamp: '2026-09-09T10:00:00Z', cause: 'unknown'
  },
  ...patch
})
const providerControlCompanion = (patch: Partial<Event> = {}): Event => event('turn_finished', {
  imported: true, metadata_only: true, backend: 'claude', run_id: 'import_control-only', ...patch
})

describe('cross-chat queue refresh signals', () => {
  it('refreshes only the target timeline after a durable delivery owns a queue row', () => {
    expect(crossChatQueueRefreshSessionId(event('cross_chat_handoff_queued', {
      queued_id: 'queued-1', target_session_id: 'chat-1'
    }))).toBe('chat-1')
    expect(crossChatQueueRefreshSessionId(event('cross_chat_exchange_leg_started', {
      queued_id: 'queued-2', target_session_id: 'chat-1'
    }))).toBe('chat-1')
  })

  it('ignores source copies and lifecycle events without a committed queue owner', () => {
    expect(crossChatQueueRefreshSessionId(event('cross_chat_handoff_queued', {
      queued_id: 'queued-1', target_session_id: 'chat-2'
    }))).toBeNull()
    expect(crossChatQueueRefreshSessionId(event('cross_chat_handoff_received', {
      target_session_id: 'chat-1'
    }))).toBeNull()
    expect(crossChatQueueRefreshSessionId(event('turn_queued', {
      queued_id: 'queued-user', target_session_id: 'chat-1'
    }))).toBeNull()
  })
})

const durableRouteHealth = (): Health => ({
  ok: true,
  capabilities: {
    cross_chat_handoffs_v1: {
      available: true,
      required: false,
      message: 'ready',
      action: null,
      version: 7,
      actions: ['route', 'instruction', 'request_reply'],
      supported_target_backends: ['codex', 'claude'],
      features: {
        durable_route_grants: true,
        agent_cross_chat_routes: true,
        agent_ambient_local_handoffs: false
      },
      agent_routes: {
        client_capability: 'agent_cross_chat_routes_v2',
        policy: 'default_deny',
        actions: ['instruction', 'request_reply'],
        default_actions: ['instruction', 'request_reply']
      }
    }
  }
})

describe('interactive provider capabilities', () => {
  const claude = { id: 'claude-chat', title: 'Claude', backend: 'claude' } satisfies Session
  const codex = { id: 'codex-chat', title: 'Codex', backend: 'codex' } satisfies Session
  const supportedHealth = {
    ok: true,
    capabilities: {
      claude_controls: {
        available: true,
        required: false,
        message: '',
        action: null,
        interactive_client_capability: 'claude_sdk_interactive_v1'
      }
    }
  } satisfies Health

  it('opts Claude into SDK interactions only when the server advertises the exact capability', () => {
    expect(interactiveClientCapabilities(claude, supportedHealth)).toEqual([
      'codex_interactive_v1',
      'codex_goal_steer_v1',
      'claude_sdk_interactive_v1'
    ])
    expect(interactiveClientCapabilities(claude, { ok: true })).toEqual(['codex_interactive_v1', 'codex_goal_steer_v1'])
    expect(interactiveClientCapabilities(claude, {
      ok: true,
      capabilities: { claude_controls: { available: true, required: false, message: '', action: null } }
    })).toEqual(['codex_interactive_v1', 'codex_goal_steer_v1'])
  })

  it('does not advertise Claude SDK interactions for Codex turns', () => {
    expect(interactiveClientCapabilities(codex, supportedHealth)).toEqual(['codex_interactive_v1', 'codex_goal_steer_v1'])
  })

  it('advertises bounded exchange v2 for every turn on a v2-capable server', () => {
    const v2Health: Health = {
      ok: true,
      capabilities: {
        cross_chat_handoffs_v1: {
          available: true, required: false, message: '', action: null,
          version: 2, actions: ['request_reply', 'instruction'], supported_target_backends: ['codex', 'claude']
        }
      }
    }

    expect(interactiveClientCapabilities(codex, v2Health)).toEqual([
      'codex_interactive_v1', 'codex_goal_steer_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2'
    ])
    expect(interactiveClientCapabilities(codex, v2Health)).toEqual([
      'codex_interactive_v1', 'codex_goal_steer_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2'
    ])
    expect(interactiveClientCapabilities(codex, {
      ...v2Health,
      capabilities: { cross_chat_handoffs_v1: { ...v2Health.capabilities!.cross_chat_handoffs_v1!, version: 1 } }
    })).toEqual(['codex_interactive_v1', 'codex_goal_steer_v1', 'cross_chat_handoffs_v1'])
  })

  it('advertises durable-route v2 only for the exact v7 default-deny contract', () => {
    const v7Health: Health = {
      ok: true,
      capabilities: {
        cross_chat_handoffs_v1: {
          available: true, required: false, message: '', action: null,
          version: 7, actions: ['route', 'request_reply', 'instruction'],
          supported_target_backends: ['codex', 'claude'],
          features: {
            durable_route_grants: true,
            agent_cross_chat_routes: true,
            agent_ambient_local_handoffs: false
          },
          agent_routes: { client_capability: 'agent_cross_chat_routes_v2', policy: 'default_deny' }
        }
      }
    }
    expect(interactiveClientCapabilities(codex, v7Health)).toEqual([
      'codex_interactive_v1', 'codex_goal_steer_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2',
      'agent_cross_chat_routes_v2'
    ])
    expect(interactiveClientCapabilities(codex, {
      ...v7Health,
      capabilities: { cross_chat_handoffs_v1: { ...v7Health.capabilities!.cross_chat_handoffs_v1!, available: false } }
    })).not.toContain('agent_cross_chat_routes_v2')
    expect(interactiveClientCapabilities(codex, {
      ...v7Health,
      capabilities: { cross_chat_handoffs_v1: {
        ...v7Health.capabilities!.cross_chat_handoffs_v1!,
        agent_routes: { client_capability: 'wrong-client' }
      } }
    })).not.toContain('agent_cross_chat_routes_v2')
    expect(interactiveClientCapabilities(codex, {
      ...v7Health,
      capabilities: { cross_chat_handoffs_v1: {
        ...v7Health.capabilities!.cross_chat_handoffs_v1!,
        version: 6,
        features: { route_hint_mentions: true, agent_cross_chat_routes: true }
      } }
    })).not.toContain('agent_cross_chat_routes_v2')
  })

  it('uses automatic ambient v4 access without a per-turn client capability', () => {
    const v4Health: Health = {
      ok: true,
      capabilities: {
        cross_chat_handoffs_v1: {
          available: true, required: false, message: '', action: null,
          version: 4, actions: ['request_reply', 'instruction'],
          supported_target_backends: ['codex', 'claude'],
          features: { agent_cross_chat_routes: false, agent_ambient_local_handoffs: true },
          ambient_local_handoffs: {
            enabled: true, policy: 'automatic', scope: 'all_same_server_chats', setup_required: false,
            actions: ['instruction', 'request_reply'], transcript_access: false
          }
        }
      }
    }

    expect(interactiveClientCapabilities(codex, v4Health)).toEqual([
      'codex_interactive_v1', 'codex_goal_steer_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2'
    ])
    expect(interactiveClientCapabilities(codex, {
      ...v4Health,
      capabilities: { cross_chat_handoffs_v1: {
        ...v4Health.capabilities!.cross_chat_handoffs_v1!,
        features: { agent_cross_chat_routes: true, agent_ambient_local_handoffs: false },
        agent_routes: { client_capability: 'agent_cross_chat_routes_v1' }
      } }
    })).not.toContain('agent_cross_chat_routes_v1')
  })
})

describe('live run state', () => {
  it('does not let a stale admission release unlock a newer send', () => {
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      turnAdmissionTokens: {}
    })

    const first = useAppStore.getState().beginTurnAdmission('chat-1')
    expect(first).toBeTruthy()
    useAppStore.getState().endTurnAdmission('chat-1', first as string)
    const second = useAppStore.getState().beginTurnAdmission('chat-1')
    expect(second).toBeTruthy()

    useAppStore.getState().endTurnAdmission('chat-1', first as string)
    expect(useAppStore.getState().turnAdmissionTokens['chat-1']).toBe(second)

    useAppStore.getState().endTurnAdmission('chat-1', second as string)
    expect(useAppStore.getState().turnAdmissionTokens['chat-1']).toBeUndefined()
  })

  it('tracks start and explicit terminal lifecycle events without mutating the previous set', () => {
    const empty = new Set<string>()
    const running = updateActiveSessions(empty, event('turn_started'))
    expect([...running]).toEqual(['chat-1'])
    expect(empty.size).toBe(0)
    expect(updateActiveSessions(running, event('turn_finished')).size).toBe(0)
    expect(updateActiveSessions(running, event('turn_stopped')).size).toBe(0)
    expect(updateActiveSessions(running, event('error')).size).toBe(0)
    expect(updateActiveSessions(running, event('tool_finished'))).toBe(running)
    expect(updateActiveSessions(running, event('turn_started'))).toBe(running)
  })

  it('does not flash idle for a native-steer logical transition', () => {
    const running = new Set(['chat-1'])

    expect(updateActiveSessions(running, event('turn_stopped', {
      run_id: 'old-logical-run',
      native_steer: true
    }))).toBe(running)
    expect(updateActiveSessions(running, event('turn_stopped', {
      run_id: 'older-server-run',
      superseded_by_run_id: 'steered-run'
    }))).toBe(running)
    expect([...running]).toEqual(['chat-1'])
    expect(updateActiveSessions(running, event('turn_stopped'))).toEqual(new Set())
  })

  it.each(['steer', 'stop', 'unknown'] as const)('does not change live run state for an imported %s interruption', cause => {
    const control = providerInterruption()
    if (!isImportedProviderInterruption(control)) throw new Error('Invalid interruption fixture')
    control.provider_origin = { ...control.provider_origin!, cause }
    const idle = new Set<string>()
    const running = new Set(['chat-1'])
    expect(updateActiveSessions(idle, control)).toBe(idle)
    expect(updateActiveSessions(running, control)).toBe(running)
  })

  it('keeps genuine starts and stops authoritative even when their text or origin resembles an interruption', () => {
    const start = providerInterruption({ type: 'turn_started', imported: false, prompt: '[Request interrupted by user]' })
    const running = updateActiveSessions(new Set(), start)
    expect(running).toEqual(new Set(['chat-1']))
    expect(updateActiveSessions(running, providerInterruption({ type: 'turn_stopped', imported: false }))).toEqual(new Set())
  })

  it.each(['history_imported', 'turn_finished'])('does not change live run state for a control-only %s companion', type => {
    const control = providerControlCompanion({ type })
    const idle = new Set<string>()
    const running = new Set(['chat-1'])
    expect(updateActiveSessions(idle, control)).toBe(idle)
    expect(updateActiveSessions(running, control)).toBe(running)
  })

  it('does not suppress genuine terminals that fail the exact control-only import contract', () => {
    for (const patch of [{ imported: false }, { run_id: 'native-run' }]) {
      expect(updateActiveSessions(new Set(['chat-1']), providerControlCompanion(patch))).toEqual(new Set())
    }
    const running = new Set(['chat-1'])
    // A normal (non-control-only) historical import still is not a live stop.
    expect(updateActiveSessions(running, providerControlCompanion({ metadata_only: false }))).toBe(running)
  })

  it('keeps the chat active until Stop is terminally acknowledged', async () => {
    let resolveStop!: (result: TurnStopResult) => void
    const stop = vi.fn(() => new Promise<TurnStopResult>(resolve => { resolveStop = resolve }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { stop } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [sessionFor('chat-1')],
      selectedSessionId: 'chat-1',
      activeSessionIds: new Set(['chat-1']),
      stoppingSessionIds: new Set(),
      activeProfileId: 'local',
      profileGeneration: 1,
      switchingProfileId: null,
      error: null
    })

    const request = useAppStore.getState().stopTurn()
    expect(useAppStore.getState().stoppingSessionIds).toContain('chat-1')
    await useAppStore.getState().stopTurn()
    expect(stop).toHaveBeenCalledTimes(1)

    resolveStop({
      ok: true,
      stopped: false,
      pending: true,
      native_interrupt: true,
      message: 'Stop was sent; waiting for Codex to finish stopping.'
    })
    await request

    expect(stop).toHaveBeenCalledWith('chat-1')
    expect(useAppStore.getState().activeSessionIds).toContain('chat-1')
    expect(useAppStore.getState().stoppingSessionIds).not.toContain('chat-1')
    expect(useAppStore.getState().error).toBe('Stop was sent; waiting for Codex to finish stopping.')
  })

  it('clears the active marker after Stop is terminally acknowledged', async () => {
    const stop = vi.fn().mockResolvedValue({ ok: true, stopped: true, pending: false })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { stop } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [sessionFor('chat-1')],
      selectedSessionId: 'chat-1',
      activeSessionIds: new Set(['chat-1']),
      stoppingSessionIds: new Set(),
      activeProfileId: 'local',
      profileGeneration: 1,
      switchingProfileId: null
    })

    await useAppStore.getState().stopTurn()

    expect(useAppStore.getState().activeSessionIds).not.toContain('chat-1')
    expect(useAppStore.getState().stoppingSessionIds).not.toContain('chat-1')
  })
})

describe('chat forking', () => {
  it('does not call an older server to fork an active turn', async () => {
    const fork = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { fork } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      sessions: [sessionFor('chat-1')], activeSessionIds: new Set(['chat-1']),
      turnAdmissionTokens: {}, error: null, health: null
    })

    await useAppStore.getState().forkSession('chat-1')

    expect(fork).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toBe(RUNNING_FORK_UNAVAILABLE)
  })

  it('forks a supported running chat without stopping it or clearing its admission', async () => {
    const fork = vi.fn().mockResolvedValue(sessionFor('child-chat'))
    const stop = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { fork }, turns: { stop } } as unknown as AgentsDockAPI
    })
    const originalRefresh = useAppStore.getState().refreshSessions
    const originalSelect = useAppStore.getState().selectSession
    const refreshSessions = vi.fn().mockResolvedValue(undefined)
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      sessions: [{ ...sessionFor('chat-1'), backend: 'claude' }], activeSessionIds: new Set(['chat-1']),
      turnAdmissionTokens: { 'chat-1': 'admission-1' }, error: null, refreshSessions, selectSession,
      health: { ok: true, capabilities: { session_fork_completed_prefix_v1: {
        available: true, version: 1, supported_backends: ['claude']
      } } }
    })
    try {
      await useAppStore.getState().forkSession('chat-1')
      expect(fork).toHaveBeenCalledExactlyOnceWith('chat-1')
      expect(selectSession).toHaveBeenCalledExactlyOnceWith('child-chat')
      expect(stop).not.toHaveBeenCalled()
      expect(useAppStore.getState().activeSessionIds).toContain('chat-1')
      expect(useAppStore.getState().turnAdmissionTokens['chat-1']).toBe('admission-1')
      expect(useAppStore.getState().error).toBeNull()
    } finally {
      useAppStore.setState({ refreshSessions: originalRefresh, selectSession: originalSelect })
    }
  })

  it('translates a raced server conflict instead of exposing the raw IPC error', async () => {
    const fork = vi.fn().mockRejectedValue(new Error(
      "Error invoking remote method 'sessions:fork': Error: wait for or stop the active turn before forking this chat"
    ))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { fork } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      sessions: [sessionFor('chat-1')], activeSessionIds: new Set(),
      turnAdmissionTokens: {}, error: null
    })

    await useAppStore.getState().forkSession('chat-1')

    expect(fork).toHaveBeenCalledWith('chat-1')
    expect(useAppStore.getState().error).toBe(RUNNING_FORK_UNAVAILABLE)
  })
})

describe('snapshot file isolation', () => {
  it('removes explicit foreign file ownership without collapsing a paginated total', () => {
    const local: AgentFile = { id: 'local', session_id: 'chat-1', filename: 'local.txt' }
    const foreign: AgentFile = { id: 'foreign', session_id: 'other-chat', filename: 'foreign.txt' }
    const current = snapshot('chat-1', [
      event('artifact_created', { artifact: local }),
      event('artifact_created', { id: 'foreign-event', seq: 2, artifact: foreign })
    ])
    current.files = [local, foreign]
    current.filesTotal = 20

    const result = cacheSnapshot({}, 'chat-1', current, 'chat-1')['chat-1']

    expect(result.files).toEqual([local])
    expect(result.filesTotal).toBe(19)
    expect(result.events).toHaveLength(1)
    expect(result.events[0].artifact).toBe(local)
  })
})

describe('session refresh identity', () => {
  it('reuses unchanged session objects and the containing array', () => {
    const previous = [sessionFor('chat-a'), sessionFor('chat-b')]
    const identical = previous.map(session => ({ ...session }))
    const reconciled = reconcileSessions(previous, identical)

    expect(reconciled).toBe(previous)
    expect(reconciled[0]).toBe(previous[0])
    expect(reconciled[1]).toBe(previous[1])
  })

  it('replaces only sessions whose server metadata changed', () => {
    const previous = [sessionFor('chat-a'), sessionFor('chat-b')]
    const reconciled = reconcileSessions(previous, [
      { ...previous[0] },
      { ...previous[1], title: 'Updated B' }
    ])

    expect(reconciled).not.toBe(previous)
    expect(reconciled[0]).toBe(previous[0])
    expect(reconciled[1]).not.toBe(previous[1])
    expect(reconciled[1].title).toBe('Updated B')
  })
})

describe('Codex permission session updates', () => {
  it('preserves every permission field in the renderer-to-server patch', async () => {
    const session = sessionFor('chat-1')
    const update = vi.fn().mockImplementation(async (_sessionId: string, patch: Partial<Session>) => ({
      ...session,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { update } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local',
      profileGeneration: 1,
      switchingProfileId: null,
      sessions: [session],
      error: null
    })

    await useAppStore.getState().updateSession('chat-1', {
      codex_approval_policy: 'on-request',
      codex_sandbox_mode: 'workspace-write',
      codex_permission_profile: ':workspace',
      codex_approvals_reviewer: 'auto_review'
    })

    expect(update).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      codex_approval_policy: 'on-request',
      codex_sandbox_mode: 'workspace-write',
      codex_permission_profile: ':workspace',
      codex_approvals_reviewer: 'auto_review'
    }))
    expect(useAppStore.getState().sessions[0]).toEqual(expect.objectContaining({
      codex_approval_policy: 'on-request',
      codex_sandbox_mode: 'workspace-write',
      codex_permission_profile: ':workspace',
      codex_approvals_reviewer: 'auto_review'
    }))
  })
})

describe('Claude permission session updates', () => {
  it('preserves the SDK permission mode in the renderer-to-server patch', async () => {
    const session = { ...sessionFor('chat-1'), backend: 'claude' as const, claude_permission_mode: 'default' as const }
    const update = vi.fn().mockImplementation(async (_sessionId: string, patch: Partial<Session>) => ({
      ...session,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { update } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local',
      profileGeneration: 1,
      switchingProfileId: null,
      sessions: [session],
      error: null
    })

    await useAppStore.getState().updateSession('chat-1', { claude_permission_mode: 'acceptEdits' })

    expect(update).toHaveBeenCalledWith('chat-1', { claude_permission_mode: 'acceptEdits' })
    expect(useAppStore.getState().sessions[0].claude_permission_mode).toBe('acceptEdits')
  })
})

describe('Cursor permission session updates', () => {
  it('preserves the Cursor CLI mode in the renderer-to-server patch', async () => {
    const session = { ...sessionFor('chat-1'), backend: 'cursor' as const, cursor_permission_mode: 'default' as const }
    const update = vi.fn().mockImplementation(async (_sessionId: string, patch: Partial<Session>) => ({
      ...session,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { update } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local',
      profileGeneration: 1,
      switchingProfileId: null,
      sessions: [session],
      error: null
    })

    await useAppStore.getState().updateSession('chat-1', { cursor_permission_mode: 'plan' })

    expect(update).toHaveBeenCalledWith('chat-1', { cursor_permission_mode: 'plan' })
    expect(useAppStore.getState().sessions[0].cursor_permission_mode).toBe('plan')
  })
})

describe('provider scheduled-jobs access session updates', () => {
  it('preserves the server-enforced mode in the renderer-to-server patch', async () => {
    const session = { ...sessionFor('chat-1'), provider_jobs_access: 'full' as const }
    const update = vi.fn().mockImplementation(async (_sessionId: string, patch: Partial<Session>) => ({
      ...session,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { update } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local',
      profileGeneration: 1,
      switchingProfileId: null,
      sessions: [session],
      error: null
    })

    await useAppStore.getState().updateSession('chat-1', { provider_jobs_access: 'read_only' })

    expect(update).toHaveBeenCalledWith('chat-1', { provider_jobs_access: 'read_only' })
    expect(useAppStore.getState().sessions[0].provider_jobs_access).toBe('read_only')
  })
})

describe('server shortcut navigation', () => {
  const realSwitchServer = useAppStore.getState().switchServer
  const realSelectAdjacent = useAppStore.getState().selectAdjacent
  const realRequestNewChat = useAppStore.getState().requestNewChat
  const alpha = { id: 'alpha', name: 'Alpha' } as PublicServerProfile
  const beta = { id: 'beta', name: 'Beta' } as PublicServerProfile
  const gamma = { id: 'gamma', name: 'Gamma' } as PublicServerProfile
  afterEach(() => useAppStore.setState({
    switchServer: realSwitchServer,
    selectAdjacent: realSelectAdjacent,
    requestNewChat: realRequestNewChat,
    switchingProfileId: null,
    error: null,
    modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
  }))

  it('cycles in saved order and wraps around', async () => {
    const switchServer = vi.fn().mockResolvedValue(true)
    useAppStore.setState({ profiles: [beta, alpha, gamma], activeProfileId: 'gamma', switchingProfileId: null, modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }, switchServer })

    await useAppStore.getState().selectAdjacentServer(1)

    expect(switchServer).toHaveBeenCalledWith('beta')
  })

  it('routes the native menu shortcut through the same guarded action', async () => {
    const switchServer = vi.fn().mockResolvedValue(true)
    useAppStore.setState({ profiles: [alpha, beta], activeProfileId: 'alpha', switchingProfileId: null, modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }, switchServer })

    handleMenuCommand('next-server', useAppStore.getState, value => useAppStore.setState(value))
    await vi.waitFor(() => expect(switchServer).toHaveBeenCalledWith('beta'))
  })

  it('routes app settings and update commands without stacking server settings', () => {
    const check = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { updates: { check } } as unknown as AgentsDockAPI
    })
    const selectSection = vi.fn()
    window.addEventListener('agentsdock:app-settings-section', selectSection)
    useAppStore.getState().setModal('settings', true)

    handleMenuCommand('settings', useAppStore.getState, value => useAppStore.setState(value))
    expect(useAppStore.getState().modals).toMatchObject({ settings: false, appSettings: true })

    useAppStore.getState().setModal('settings', true)
    handleMenuCommand('check-update', useAppStore.getState, value => useAppStore.setState(value))
    window.removeEventListener('agentsdock:app-settings-section', selectSection)

    expect(useAppStore.getState().modals).toMatchObject({ settings: false, appSettings: true })
    expect(selectSection).toHaveBeenCalledWith(expect.objectContaining({ detail: 'updates' }))
    expect(check).toHaveBeenCalledOnce()
  })

  it('applies an exact native-menu chat font size from the expanded size list', () => {
    const setPreference = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { preferences: { set: setPreference } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ activeProfileId: null })

    expect(CHAT_FONT_SIZES).toEqual([13, 14, 15, 16, 18, 20, 22, 24])
    handleMenuCommand('chat-font-size:24', useAppStore.getState, value => useAppStore.setState(value))

    expect(document.documentElement.style.getPropertyValue('--chat-font-size')).toBe('24px')
    expect(setPreference).toHaveBeenCalledWith('chatFontSize', 24)
  })

  it('routes Open Workspace File to the editor without opening chat search', () => {
    const openWorkspaceFile = vi.fn()
    window.addEventListener('agentsdock:open-workspace-file', openWorkspaceFile)

    handleMenuCommand('open-workspace-file', useAppStore.getState, value => useAppStore.setState(value))

    window.removeEventListener('agentsdock:open-workspace-file', openWorkspaceFile)
    expect(openWorkspaceFile).toHaveBeenCalledOnce()
    expect(useAppStore.getState().modals.search).toBe(false)
  })

  it('lets the focused workspace toggle Cmd+O without dispatching a second open', () => {
    const activeSurfaceQuickOpen = vi.fn((event: globalThis.Event) => event.preventDefault())
    const openWorkspaceFile = vi.fn()
    window.addEventListener('agentsdock:quick-open-active-surface', activeSurfaceQuickOpen)
    window.addEventListener('agentsdock:open-workspace-file', openWorkspaceFile)

    handleMenuCommand('open-workspace-file', useAppStore.getState, value => useAppStore.setState(value))

    window.removeEventListener('agentsdock:quick-open-active-surface', activeSurfaceQuickOpen)
    window.removeEventListener('agentsdock:open-workspace-file', openWorkspaceFile)
    expect(activeSurfaceQuickOpen).toHaveBeenCalledOnce()
    expect(openWorkspaceFile).not.toHaveBeenCalled()
  })

  it('routes Cmd+P straight to chat search even when a workspace offers contextual quick open', () => {
    const activeSurfaceQuickOpen = vi.fn((event: globalThis.Event) => event.preventDefault())
    window.addEventListener('agentsdock:quick-open-active-surface', activeSurfaceQuickOpen)

    handleMenuCommand('find-chat', useAppStore.getState, value => useAppStore.setState(value))

    window.removeEventListener('agentsdock:quick-open-active-surface', activeSurfaceQuickOpen)
    expect(activeSurfaceQuickOpen).not.toHaveBeenCalled()
    expect(useAppStore.getState().modals.search).toBe(true)
  })

  it('keeps an open chat search open and asks it to restore focus', () => {
    const focusChatSwitcher = vi.fn()
    window.addEventListener('agentsdock:focus-chat-switcher', focusChatSwitcher)
    useAppStore.setState(state => ({ modals: { ...state.modals, search: true } }))

    handleMenuCommand('find-chat', useAppStore.getState, value => useAppStore.setState(value))

    window.removeEventListener('agentsdock:focus-chat-switcher', focusChatSwitcher)
    expect(useAppStore.getState().modals.search).toBe(true)
    expect(focusChatSwitcher).toHaveBeenCalledOnce()
  })

  it('replaces an open workspace file picker with chat search', () => {
    const picker = document.createElement('div')
    picker.className = 'workspace-editor-palette'
    picker.setAttribute('aria-modal', 'true')
    document.body.appendChild(picker)
    const dismiss = vi.fn(() => picker.remove())
    window.addEventListener('agentsdock:dismiss-workspace-file-picker', dismiss)

    handleMenuCommand('find-chat', useAppStore.getState, value => useAppStore.setState(value))

    window.removeEventListener('agentsdock:dismiss-workspace-file-picker', dismiss)
    expect(dismiss).toHaveBeenCalledOnce()
    expect(useAppStore.getState().modals.search).toBe(true)
    expect(picker).not.toBeInTheDocument()
  })

  it('does not stack chat search over another blocking modal', () => {
    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)

    handleMenuCommand('find-chat', useAppStore.getState, value => useAppStore.setState(value))

    modal.remove()
    expect(useAppStore.getState().modals.search).toBe(false)
  })

  it('routes native Edit-menu undo and redo to the active editing surface', () => {
    const editHistory = vi.fn((event: globalThis.Event) => event.preventDefault())
    window.addEventListener('agentsdock:edit-history', editHistory)

    handleMenuCommand('undo', useAppStore.getState, value => useAppStore.setState(value))
    handleMenuCommand('redo', useAppStore.getState, value => useAppStore.setState(value))

    window.removeEventListener('agentsdock:edit-history', editHistory)
    expect(editHistory).toHaveBeenCalledTimes(2)
    expect(editHistory).toHaveBeenNthCalledWith(1, expect.objectContaining({
      detail: { direction: 'undo' }
    }))
    expect(editHistory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      detail: { direction: 'redo' }
    }))
  })

  it('routes New to the active surface before falling back to New Chat', () => {
    const requestNewChat = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ requestNewChat })
    const activeSurfaceNew = vi.fn((event: globalThis.Event) => event.preventDefault())
    window.addEventListener('agentsdock:new-active-surface', activeSurfaceNew)

    handleMenuCommand('new-chat', useAppStore.getState, value => useAppStore.setState(value))

    window.removeEventListener('agentsdock:new-active-surface', activeSurfaceNew)
    expect(activeSurfaceNew).toHaveBeenCalledOnce()
    expect(requestNewChat).not.toHaveBeenCalled()
  })

  it('requests a chat when no active surface handles New', () => {
    const requestNewChat = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ requestNewChat })
    handleMenuCommand('new-chat', useAppStore.getState, value => useAppStore.setState(value))

    expect(requestNewChat).toHaveBeenCalledOnce()
  })

  it('routes native workspace-tab navigation without switching chats', () => {
    const navigate = vi.fn()
    const selectAdjacent = vi.fn()
    useAppStore.setState({ selectAdjacent })
    window.addEventListener('agentsdock:navigate-workspace-tab', navigate)

    handleMenuCommand('next-workspace-tab', useAppStore.getState, value => useAppStore.setState(value))
    handleMenuCommand('previous-workspace-tab', useAppStore.getState, value => useAppStore.setState(value))

    window.removeEventListener('agentsdock:navigate-workspace-tab', navigate)
    expect(selectAdjacent).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenNthCalledWith(1, expect.objectContaining({ detail: { direction: 1 } }))
    expect(navigate).toHaveBeenNthCalledWith(2, expect.objectContaining({ detail: { direction: -1 } }))
  })

  it('routes Find to the active surface before falling back to chat', () => {
    const activeSurfaceFind = vi.fn((event: globalThis.Event) => event.preventDefault())
    const chatFind = vi.fn()
    window.addEventListener('agentsdock:find-active-surface', activeSurfaceFind)
    window.addEventListener('agentsdock:find-in-chat', chatFind)

    handleMenuCommand('find-in-current-chat', useAppStore.getState, value => useAppStore.setState(value))

    window.removeEventListener('agentsdock:find-active-surface', activeSurfaceFind)
    window.removeEventListener('agentsdock:find-in-chat', chatFind)
    expect(activeSurfaceFind).toHaveBeenCalledOnce()
    expect(chatFind).not.toHaveBeenCalled()
  })

  it('falls back to chat Find when no active surface handles it', () => {
    const chatFind = vi.fn()
    window.addEventListener('agentsdock:find-in-chat', chatFind)

    handleMenuCommand('find-in-current-chat', useAppStore.getState, value => useAppStore.setState(value))

    window.removeEventListener('agentsdock:find-in-chat', chatFind)
    expect(chatFind).toHaveBeenCalledOnce()
  })

  it('keeps an Attach Files picker targeted at the chat that opened it', async () => {
    const chosen = deferred<NativeFileRef[]>()
    const attachPathsForSession = vi.fn().mockResolvedValue(undefined)
    const realAttachPathsForSession = useAppStore.getState().attachPathsForSession
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { choose: vi.fn(() => chosen.promise) } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      sessions: [sessionFor('chat-a'), sessionFor('chat-b')],
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' }, focusedChatPane: 'primary', selectedSessionId: 'chat-a',
      attachPathsForSession
    })

    handleMenuCommand('attach-files', useAppStore.getState, value => useAppStore.setState(value))
    useAppStore.getState().focusChatPane('secondary')
    const file = { path: '/tmp/report.txt', name: 'report.txt' }
    chosen.resolve([file])
    await settleMicrotasks()

    expect(attachPathsForSession).toHaveBeenCalledWith('chat-a', [file])
    expect(attachPathsForSession).not.toHaveBeenCalledWith('chat-b', expect.anything())
    useAppStore.setState({ attachPathsForSession: realAttachPathsForSession })
  })

  it.each(['closed', 'archived'] as const)('cancels an Attach Files picker when its chat is %s', async disposition => {
    const chosen = deferred<NativeFileRef[]>()
    const attachPathsForSession = vi.fn().mockResolvedValue(undefined)
    const realAttachPathsForSession = useAppStore.getState().attachPathsForSession
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { choose: vi.fn(() => chosen.promise) } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      sessions: [sessionFor('chat-a'), sessionFor('chat-b')],
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' }, focusedChatPane: 'primary', selectedSessionId: 'chat-a',
      attachPathsForSession
    })

    handleMenuCommand('attach-files', useAppStore.getState, value => useAppStore.setState(value))
    if (disposition === 'closed') {
      useAppStore.setState({ chatPanes: { primary: 'chat-b', secondary: null }, focusedChatPane: 'primary', selectedSessionId: 'chat-b' })
    } else {
      useAppStore.setState({ sessions: [{ ...sessionFor('chat-a'), archived: true }, sessionFor('chat-b')] })
    }
    chosen.resolve([{ path: '/tmp/report.txt', name: 'report.txt' }])
    await settleMicrotasks()

    expect(attachPathsForSession).not.toHaveBeenCalled()
    useAppStore.setState({ attachPathsForSession: realAttachPathsForSession })
  })

  it('contains a rejected Attach Files picker after a profile switch', async () => {
    const chosen = deferred<NativeFileRef[]>()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { choose: vi.fn(() => chosen.promise) } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null, error: null,
      sessions: [sessionFor('chat-a')],
      chatPanes: { primary: 'chat-a', secondary: null }, focusedChatPane: 'primary', selectedSessionId: 'chat-a'
    })

    handleMenuCommand('attach-files', useAppStore.getState, value => useAppStore.setState(value))
    useAppStore.setState({ activeProfileId: 'remote', profileGeneration: 2, selectedSessionId: null })
    chosen.reject(new Error('The picker belongs to a retired profile.'))
    await settleMicrotasks()

    expect(useAppStore.getState().error).toBeNull()
  })

  it('does not interrupt another switch or an open dialog', async () => {
    const switchServer = vi.fn().mockResolvedValue(true)
    useAppStore.setState({ profiles: [alpha, beta], activeProfileId: 'alpha', switchingProfileId: 'beta', switchServer })
    await useAppStore.getState().selectAdjacentServer(1)
    expect(switchServer).not.toHaveBeenCalled()

    useAppStore.setState({ switchingProfileId: null, modals: { settings: true, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false } })
    await useAppStore.getState().selectAdjacentServer(1)
    expect(switchServer).not.toHaveBeenCalled()
  })

  it('surfaces a failed shortcut switch without rejecting globally', async () => {
    const switchServer = vi.fn().mockRejectedValue(new Error('Beta is offline'))
    useAppStore.setState({ profiles: [alpha, beta], activeProfileId: 'alpha', switchingProfileId: null, error: null, modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }, switchServer })

    await expect(useAppStore.getState().selectAdjacentServer(1)).resolves.toBeUndefined()

    expect(useAppStore.getState().error).toBe('Beta is offline')
  })
})

describe('instant new chat defaults', () => {
  const requestNewChat = useAppStore.getState().requestNewChat
  const refreshSessions = useAppStore.getState().refreshSessions
  const selectSession = useAppStore.getState().selectSession
  const profile: PublicServerProfile = {
    id: 'quick-chat-profile',
    name: 'Quick chat',
    serverUrl: 'http://127.0.0.1:7850',
    serverIdentity: 'quick-chat-server',
    hasAccessToken: true,
    serverSetupComplete: true,
    connectionState: 'online',
    cachedUnreadCount: 0
  }
  const closedModals = { settings: false, appSettings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }

  afterEach(() => useAppStore.setState({
    requestNewChat,
    refreshSessions,
    selectSession,
    creatingChat: false,
    error: null,
    modals: closedModals
  }))

  it('opens the chooser for the first chat in an empty workspace', async () => {
    const create = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        native: { analyticsDisabled: true },
        preferences: { getScoped: vi.fn().mockResolvedValue(null) },
        sessions: { create }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      requestNewChat,
      profiles: [profile], activeProfileId: profile.id, profileGeneration: 1, switchingProfileId: null,
      sessions: [], selectedSessionId: null, folderOrder: [], health: { ok: true }, runtimeCatalog: null,
      creatingChat: false, modals: closedModals
    })

    await useAppStore.getState().requestNewChat()

    expect(create).not.toHaveBeenCalled()
    expect(useAppStore.getState().modals.newChat).toBe(true)
    expect(useAppStore.getState().creatingChat).toBe(false)
  })

  it('creates once from the last-opened chat location and saved runtime defaults', async () => {
    const stored = { version: 1, folder: 'Saved', cwd: '/work/saved', backend: 'claude', model: 'claude-sonnet', effort: 'high' }
    const created = deferred<Session>()
    const create = vi.fn(() => created.promise)
    const setScoped = vi.fn().mockResolvedValue(undefined)
    const refresh = vi.fn().mockResolvedValue(undefined)
    const select = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        native: { analyticsDisabled: true },
        preferences: { getScoped: vi.fn().mockResolvedValue(stored), setScoped },
        sessions: { create }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      requestNewChat,
      profiles: [profile], activeProfileId: profile.id, profileGeneration: 1, switchingProfileId: null,
      sessions: [{ id: 'older', title: 'Older chat', folder: 'Older', cwd: '/work/older', backend: 'codex', model: 'gpt-old' }],
      selectedSessionId: 'older', folderOrder: ['Older', 'Fresh'], health: { ok: true }, runtimeCatalog: null,
      refreshSessions: refresh, selectSession: select, creatingChat: false, modals: closedModals
    })

    const first = useAppStore.getState().requestNewChat()
    const duplicate = useAppStore.getState().requestNewChat()
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'New chat', folder: 'Older', cwd: '/work/older', backend: 'claude', model: 'claude-sonnet', effort: 'high'
    }))
    created.resolve({ id: 'created', title: 'New chat', folder: 'Older', cwd: '/work/older', backend: 'claude', model: 'claude-sonnet', effort: 'high' })
    await Promise.all([first, duplicate])

    expect(setScoped).toHaveBeenCalledWith(expect.objectContaining({ profileId: profile.id, serverIdentity: profile.serverIdentity }), 'newChatDefaults:v1', expect.objectContaining({ folder: 'Older', cwd: '/work/older', backend: 'claude', model: 'claude-sonnet' }))
    expect(setScoped).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: profile.id, serverIdentity: profile.serverIdentity }),
      'directChatPlaceholder:v1:created',
      { version: 1, fingerprint: expect.any(String) }
    )
    expect(refresh).toHaveBeenCalledOnce()
    expect(select).toHaveBeenCalledWith('created')
    expect(useAppStore.getState().creatingChat).toBe(false)
  })

  it('uses the last-opened chat folder and working directory ahead of saved location defaults', async () => {
    const stored = { version: 1, folder: 'Older', cwd: '/work/older', backend: 'claude', model: 'claude-sonnet', effort: 'high' }
    const setScoped = vi.fn().mockResolvedValue(undefined)
    const create = vi.fn().mockResolvedValue({
      id: 'created', title: 'New chat', folder: 'Research', cwd: '/work/research', backend: 'claude', model: 'claude-sonnet', effort: 'high'
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        native: { analyticsDisabled: true },
        preferences: { getScoped: vi.fn().mockResolvedValue(stored), setScoped },
        sessions: { create }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      requestNewChat,
      profiles: [profile], activeProfileId: profile.id, profileGeneration: 1, switchingProfileId: null,
      sessions: [{ id: 'selected', title: 'Selected chat', folder: 'Research', cwd: '/work/research', backend: 'codex', model: 'gpt-current' }],
      selectedSessionId: 'selected', folderOrder: ['Older', 'Research'], health: { ok: true }, runtimeCatalog: null,
      refreshSessions: vi.fn().mockResolvedValue(undefined), selectSession: vi.fn().mockResolvedValue(undefined),
      creatingChat: false, modals: closedModals
    })

    await useAppStore.getState().requestNewChat()

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      folder: 'Research', cwd: '/work/research', backend: 'claude', model: 'claude-sonnet', effort: 'high'
    }))
    expect(setScoped).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: profile.id, serverIdentity: profile.serverIdentity }),
      'newChatDefaults:v1',
      expect.objectContaining({ folder: 'Research', cwd: '/work/research', backend: 'claude', model: 'claude-sonnet', effort: 'high' })
    )
  })

  it('keeps the location from the chat that was open when creation started', async () => {
    const stored = deferred<unknown>()
    const create = vi.fn().mockResolvedValue({
      id: 'created', title: 'New chat', folder: 'First', cwd: '/work/first', backend: 'claude', model: 'claude-sonnet', effort: 'high'
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        native: { analyticsDisabled: true },
        preferences: { getScoped: vi.fn(() => stored.promise), setScoped: vi.fn().mockResolvedValue(undefined) },
        sessions: { create }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      requestNewChat,
      profiles: [profile], activeProfileId: profile.id, profileGeneration: 1, switchingProfileId: null,
      sessions: [
        { id: 'first', title: 'First chat', folder: 'First', cwd: '/work/first', backend: 'codex' },
        { id: 'second', title: 'Second chat', folder: 'Second', cwd: '/work/second', backend: 'codex' }
      ],
      selectedSessionId: 'first', folderOrder: ['First', 'Second'], health: { ok: true }, runtimeCatalog: null,
      refreshSessions: vi.fn().mockResolvedValue(undefined), selectSession: vi.fn().mockResolvedValue(undefined),
      creatingChat: false, modals: closedModals
    })

    const request = useAppStore.getState().requestNewChat()
    useAppStore.setState({ selectedSessionId: 'second' })
    stored.resolve({ version: 1, folder: 'Saved', cwd: '/work/saved', backend: 'claude', model: 'claude-sonnet', effort: 'high' })
    await request

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ folder: 'First', cwd: '/work/first' }))
  })

  it('falls back to the chooser when persisted runtime defaults are stale', async () => {
    const create = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        native: { analyticsDisabled: true },
        preferences: { getScoped: vi.fn().mockResolvedValue({ version: 1, folder: 'General', cwd: '/work', backend: 'cursor', model: 'auto', effort: null }) },
        sessions: { create }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      requestNewChat,
      profiles: [profile], activeProfileId: profile.id, profileGeneration: 1, switchingProfileId: null,
      sessions: [{ id: 'chat', title: 'Existing', folder: 'General', backend: 'codex' }],
      selectedSessionId: 'chat', folderOrder: ['General'], health: { ok: true, capabilities: {} }, runtimeCatalog: null,
      creatingChat: false, modals: closedModals
    })

    await useAppStore.getState().requestNewChat()

    expect(create).not.toHaveBeenCalled()
    expect(useAppStore.getState().modals.newChat).toBe(true)
  })
})

describe('folder deletion', () => {
  it('moves every matching chat to General before removing the folder preference', async () => {
    const update = vi.fn(async (sessionId: string) => ({ ...sessionFor(sessionId), folder: 'General' }))
    const setPreference = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        sessions: { update, list: vi.fn().mockResolvedValue([]) },
        preferences: { set: setPreference }
      } as unknown as AgentsDockAPI
    })
    const research = { ...sessionFor('research'), folder: 'Research' }
    const pinned = { ...sessionFor('pinned'), folder: 'Research', pinned: true }
    const general = { ...sessionFor('general'), folder: 'General' }
    useAppStore.setState({
      sessions: [research, pinned, general],
      snapshots: { research: snapshot('research', []) },
      folderOrder: ['Research', 'General'],
      collapsedFolders: new Set(['Research'])
    })

    await useAppStore.getState().deleteFolder('Research')

    expect(update).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledWith('research', { folder: 'General' })
    expect(update).toHaveBeenCalledWith('pinned', { folder: 'General' })
    expect(useAppStore.getState().sessions.map(session => session.folder)).toEqual(['General', 'General', 'General'])
    expect(useAppStore.getState().snapshots.research.session.folder).toBe('General')
    expect(useAppStore.getState().folderOrder).toEqual(['General'])
    expect(useAppStore.getState().collapsedFolders.has('Research')).toBe(false)
    expect(setPreference).toHaveBeenCalledWith('folderOrder', ['General'])
    expect(setPreference).toHaveBeenCalledWith('collapsedFolders', [])
  })

  it('never deletes the General folder', async () => {
    const update = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { update }, preferences: { set: vi.fn() } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ sessions: [{ ...sessionFor('general'), folder: 'General' }], folderOrder: ['General'] })

    await useAppStore.getState().deleteFolder('General')

    expect(update).not.toHaveBeenCalled()
    expect(useAppStore.getState().folderOrder).toEqual(['General'])
  })

  it('removes an empty folder without issuing chat updates', async () => {
    const update = vi.fn()
    const setPreference = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { update }, preferences: { set: setPreference } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ sessions: [], folderOrder: ['Empty', 'General'], collapsedFolders: new Set(['Empty']) })

    await useAppStore.getState().deleteFolder('Empty')

    expect(update).not.toHaveBeenCalled()
    expect(useAppStore.getState().folderOrder).toEqual(['General'])
    expect(useAppStore.getState().collapsedFolders.has('Empty')).toBe(false)
  })
})

describe('live queue state', () => {
  it('applies only the latest queue request per session', () => {
    const a = snapshot('chat-a', [])
    const b = snapshot('chat-b', [])
    const latestA: QueuedTurn[] = [{
      queued_id: 'latest-a', session_id: 'chat-a', prompt: 'Latest A', file_ids: [], position: 1
    }]
    const latestB: QueuedTurn[] = [{
      queued_id: 'latest-b', session_id: 'chat-b', prompt: 'Latest B', file_ids: [], position: 1
    }]
    useAppStore.setState({ snapshots: { 'chat-a': a, 'chat-b': b } })

    const staleARequest = useAppStore.getState().beginQueuedTurnsRequest('chat-a')
    const bRequest = useAppStore.getState().beginQueuedTurnsRequest('chat-b')
    const latestARequest = useAppStore.getState().beginQueuedTurnsRequest('chat-a')

    expect(useAppStore.getState().applyQueuedTurnsResponse('chat-a', staleARequest, [{
      queued_id: 'stale-a', session_id: 'chat-a', prompt: 'Stale A', file_ids: [], position: 1
    }])).toBe(false)
    expect(useAppStore.getState().applyQueuedTurnsResponse('chat-b', bRequest, latestB)).toBe(true)
    expect(useAppStore.getState().applyQueuedTurnsResponse('chat-a', latestARequest, latestA)).toBe(true)
    expect(useAppStore.getState().snapshots['chat-a'].queuedTurns).toEqual(latestA)
    expect(useAppStore.getState().snapshots['chat-b'].queuedTurns).toEqual(latestB)
  })

  it('invalidates an outstanding queue request when newer queue state is set directly', () => {
    const current: QueuedTurn[] = [{
      queued_id: 'current', session_id: 'chat-a', prompt: 'Current', file_ids: [], position: 1
    }]
    useAppStore.setState({ snapshots: { 'chat-a': snapshot('chat-a', []) } })
    const staleRequest = useAppStore.getState().beginQueuedTurnsRequest('chat-a')

    useAppStore.getState().setQueued('chat-a', current)

    expect(useAppStore.getState().applyQueuedTurnsResponse('chat-a', staleRequest, [{
      queued_id: 'stale', session_id: 'chat-a', prompt: 'Stale', file_ids: [], position: 1
    }])).toBe(false)
    expect(useAppStore.getState().snapshots['chat-a'].queuedTurns).toEqual(current)
  })

  it('rejects an old queue list response after an authoritative timeline updates the queue', async () => {
    const handlers = new Map<string, (payload: any) => void>()
    const staleList = deferred<QueuedTurn[]>()
    const list = vi.fn(() => staleList.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue({
          settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
          health: null, sessions: [], jobs: [], runtimeCatalog: null,
          folderOrder: [], collapsedFolders: [], archivedCollapsed: false,
          inspectorVisible: true
        }),
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        preferences: { get: vi.fn().mockResolvedValue(undefined) },
        queue: { list },
        events: {
          on: vi.fn((channel: string, handler: (payload: any) => void) => {
            handlers.set(channel, handler)
            return () => {}
          })
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false, activeProfileId: null, profileGeneration: 0,
      switchingProfileId: null, selectedSessionId: null, sessions: [], snapshots: {}
    })
    await useAppStore.getState().initialize()
    const oldQueue: QueuedTurn[] = [{
      queued_id: 'queued-old', session_id: 'chat-a', prompt: 'Old queue', file_ids: [], position: 1
    }]
    const authoritativeQueue: QueuedTurn[] = [{
      queued_id: 'queued-new', session_id: 'chat-a', prompt: 'Authoritative queue', file_ids: [], position: 1
    }]
    useAppStore.setState({
      selectedSessionId: 'chat-a', sessions: [sessionFor('chat-a')],
      snapshots: { 'chat-a': { ...snapshot('chat-a', []), queuedTurns: oldQueue } }
    })

    const request = useAppStore.getState().beginQueuedTurnsRequest('chat-a')
    const applyingList = window.agentsDock.queue.list('chat-a').then(turns => (
      useAppStore.getState().applyQueuedTurnsResponse('chat-a', request, turns)
    ))
    handlers.get('server:timeline')?.({
      profileId: null, profileGeneration: 0, sessionId: 'chat-a',
      snapshot: { ...snapshot('chat-a', []), queuedTurns: authoritativeQueue },
      source: 'server', mode: 'replace'
    })
    staleList.resolve(oldQueue)

    await expect(applyingList).resolves.toBe(false)
    expect(useAppStore.getState().snapshots['chat-a'].queuedTurns).toEqual(authoritativeQueue)

    const introducedRequest = useAppStore.getState().beginQueuedTurnsRequest('chat-b')
    handlers.get('server:timeline')?.({
      profileId: null, profileGeneration: 0, sessionId: 'chat-b',
      snapshot: { ...snapshot('chat-b', []), queuedTurns: authoritativeQueue.map(turn => ({ ...turn, session_id: 'chat-b' })) },
      source: 'server', mode: 'replace'
    })
    expect(useAppStore.getState().applyQueuedTurnsResponse('chat-b', introducedRequest, oldQueue)).toBe(false)
    expect(useAppStore.getState().snapshots['chat-b'].queuedTurns).toMatchObject([{ queued_id: 'queued-new' }])
  })

  it('rejects a queue response that predates a queued send result', async () => {
    const send = vi.fn().mockResolvedValue({
      session: sessionFor('chat-a'),
      queued: true,
      event: eventFor('chat-a', 2, {
        type: 'turn_queued', queued_id: 'queued-from-send', prompt: 'Queue this', position: 1
      })
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: null, profileGeneration: 0, switchingProfileId: null,
      selectedSessionId: 'chat-a', chatPanes: { primary: 'chat-a', secondary: null },
      sessions: [sessionFor('chat-a')], health: null, runtimeCatalog: null,
      snapshots: { 'chat-a': snapshot('chat-a', [eventFor('chat-a', 1)]) },
      drafts: {}, uploadsBySession: {}, uploadPathsBySession: {}, turnAdmissionTokens: {}
    })
    const staleRequest = useAppStore.getState().beginQueuedTurnsRequest('chat-a')

    await expect(useAppStore.getState().sendPromptForSession('chat-a', 'Queue this')).resolves.toBe(true)

    expect(useAppStore.getState().applyQueuedTurnsResponse('chat-a', staleRequest, [{
      queued_id: 'stale', session_id: 'chat-a', prompt: 'Stale', file_ids: [], position: 1
    }])).toBe(false)
    expect(useAppStore.getState().snapshots['chat-a'].queuedTurns).toMatchObject([{
      queued_id: 'queued-from-send', prompt: 'Queue this'
    }])
  })

  it('adds, edits, reorders, and removes queued messages from stream events', () => {
    let queue: QueuedTurn[] = []
    queue = updateQueuedTurns(queue, event('turn_queued', { queued_id: 'a', prompt: 'First', position: 1 }))
    queue = updateQueuedTurns(queue, event('turn_queued', { queued_id: 'b', prompt: 'Second', position: 2 }))
    queue = updateQueuedTurns(queue, event('turn_queue_updated', { queued_id: 'b', prompt: 'Edited' }))
    expect(queue.map(turn => turn.prompt)).toEqual(['First', 'Edited'])
    queue = updateQueuedTurns(queue, event('turn_queue_reordered', { positions: [{ queued_id: 'a', position: 2 }, { queued_id: 'b', position: 1 }] }))
    expect(queue.map(turn => turn.queued_id)).toEqual(['b', 'a'])
    queue = updateQueuedTurns(queue, event('turn_started', { queued_id: 'b' }))
    expect(queue.map(turn => turn.queued_id)).toEqual(['a'])
    queue = updateQueuedTurns(queue, event('turn_unqueued', { queued_id: 'a' }))
    expect(queue).toEqual([])
  })

  it('marks only the promoted turn as starting until its provider turn begins', () => {
    let queue: QueuedTurn[] = []
    queue = updateQueuedTurns(queue, event('turn_queued', { queued_id: 'a', prompt: 'First', position: 1 }))
    queue = updateQueuedTurns(queue, event('turn_queued', { queued_id: 'b', prompt: 'Second', position: 2 }))
    queue = updateQueuedTurns(queue, event('turn_queued', { queued_id: 'c', prompt: 'Third', position: 3 }))

    queue = updateQueuedTurns(queue, event('turn_queue_run_now', {
      queued_id: 'b'
    }))

    expect(queue.map(turn => turn.queued_id)).toEqual(['a', 'b', 'c'])
    expect(queue.find(turn => turn.queued_id === 'b')).toMatchObject({
      promoted: true,
      paused: false,
      pause_reason: null
    })
    queue = updateQueuedTurns(queue, event('turn_started', { queued_id: 'b' }))
    expect(queue.map(turn => turn.queued_id)).toEqual(['a', 'c'])
  })

  it('projects durable stopped and delivery-uncertain queue holds', () => {
    let queue: QueuedTurn[] = []
    queue = updateQueuedTurns(queue, event('turn_queued', { queued_id: 'a', prompt: 'First', position: 1 }))
    queue = updateQueuedTurns(queue, event('turn_queued', { queued_id: 'b', prompt: 'Second', position: 2 }))

    const beforePause = queue
    queue = updateQueuedTurns(queue, event('turn_queue_paused', { queued_ids: ['a', 'b'] }))
    expect(queue).not.toBe(beforePause)
    expect(queue).toMatchObject([
      { queued_id: 'a', paused: true, pause_reason: 'stopped' },
      { queued_id: 'b', paused: true, pause_reason: 'stopped' }
    ])
    expect(updateQueuedTurns(queue, event('turn_queue_paused', { queued_ids: ['a', 'b'] }))).toBe(queue)

    queue = updateQueuedTurns(queue, event('turn_unqueued', { queued_id: 'a' }))
    queue = updateQueuedTurns(queue, event('turn_queue_delivery_fenced', {
      queued_id: 'a', prompt: 'First', file_ids: ['proof.png'], position: 1
    }))
    expect(queue).toMatchObject([
      { queued_id: 'a', file_ids: ['proof.png'], paused: true, pause_reason: 'delivery_uncertain' },
      { queued_id: 'b', paused: true, pause_reason: 'stopped' }
    ])

    const beforeRepeatedPause = queue
    queue = updateQueuedTurns(queue, event('turn_queue_paused', { queued_ids: ['a', 'b'] }))
    expect(queue).toBe(beforeRepeatedPause)
    expect(queue[0]).toMatchObject({
      queued_id: 'a',
      paused: true,
      pause_reason: 'delivery_uncertain'
    })
  })

  it('projects exact encrypted peer delivery identity directly from queue events', () => {
    let queue = updateQueuedTurns([], event('turn_queued', {
      queued_id: 'peer-a', prompt: 'Encrypted delivery', position: 1,
      purpose: 'secure_peer_handoff_delivery', secure_peer_envelope_id: 'peer-envelope-a'
    }))
    expect(queue).toMatchObject([{
      queued_id: 'peer-a', secure_peer_envelope_id: 'peer-envelope-a', paused: false
    }])

    queue = updateQueuedTurns(queue, event('turn_queue_delivery_fenced', {
      queued_id: 'peer-a', prompt: 'Encrypted delivery', position: 1,
      purpose: 'secure_peer_handoff_delivery', secure_peer_envelope_id: 'peer-envelope-a'
    }))
    expect(queue).toMatchObject([{
      queued_id: 'peer-a', secure_peer_envelope_id: 'peer-envelope-a',
      paused: true, pause_reason: 'delivery_uncertain'
    }])
  })

  it('updates the requested chat even when another chat is selected', () => {
    const a = snapshot('chat-a', [eventFor('chat-a', 1)])
    const b = snapshot('chat-b', [eventFor('chat-b', 1)])
    useAppStore.setState({ selectedSessionId: 'chat-b', snapshots: { 'chat-a': a, 'chat-b': b } })
    const queue = [{ queued_id: 'qa', prompt: 'For A', display_prompt: 'For A', file_ids: [] }]
    useAppStore.getState().setQueued('chat-a', queue)
    expect(useAppStore.getState().snapshots['chat-a'].queuedTurns).toEqual(queue)
    expect(useAppStore.getState().snapshots['chat-b'].queuedTurns).toEqual([])
  })
})

describe('send rollback', () => {
  afterEach(() => useAppStore.setState({
    agentRoutesBySession: {},
    agentRouteLoadingSessionIds: new Set(),
    agentRouteErrorsBySession: {},
    revokingAgentRouteIds: new Set(),
    chatReferencesBySession: {},
    teamReferencesBySession: {},
    turnAdmissionTokens: {},
    health: null,
    error: null
  }))

  it('rejects direct store sends when the selected Cursor backend contract is unavailable', async () => {
    const send = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 1, switchingProfileId: null,
      selectedSessionId: 'chat-cursor', chatPanes: { primary: 'chat-cursor', secondary: null },
      sessions: [{ ...sessionFor('chat-cursor'), backend: 'cursor', model: 'auto' }],
      health: { ok: true, capabilities: {} },
      runtimeCatalog: { backends: { cursor: { available: true, models: [{ value: 'auto', label: 'Auto' }], efforts: [] } } },
      drafts: { 'chat-cursor': 'Inspect this workspace' },
      uploadsBySession: {}, uploadPathsBySession: {}, snapshots: {}
    })

    await expect(useAppStore.getState().sendPrompt()).resolves.toBe(false)

    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().drafts['chat-cursor']).toBe('Inspect this workspace')
    expect(useAppStore.getState().turnAdmissionTokens['chat-cursor']).toBeUndefined()
    expect(useAppStore.getState().error).toMatch(/Cursor is unavailable/)
  })

  it('rejects direct store sends with more than 16 chat references', async () => {
    const send = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    const tokens = Array.from({ length: 17 }, (_, index) => `@Target${index}`)
    const prompt = tokens.join(' ')
    let offset = 0
    const references: ChatReference[] = tokens.map((token, index) => {
      const reference: ChatReference = {
        session_id: `target-${index}`, display_title_snapshot: `Target${index}`,
        source_text_start: offset, source_text_end: offset + token.length,
        action: 'instruction'
      }
      offset += token.length + 1
      return reference
    })
    useAppStore.setState({
      switchingProfileId: null,
      selectedSessionId: 'chat-a', chatPanes: { primary: 'chat-a', secondary: null },
      sessions: [sessionFor('chat-a')],
      drafts: { 'chat-a': prompt }, chatReferencesBySession: { 'chat-a': references },
      uploadsBySession: {}, uploadPathsBySession: {}, error: null
    })

    await expect(useAppStore.getState().sendPromptForSession('chat-a')).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toMatch(/at most 16 chats/i)
  })

  it('rejects a new pending grant when the known route snapshot is full', async () => {
    const send = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    const existingRoute: AgentCrossChatRoute = {
      route_id: 'route-existing', revision: `rev_${'a'.repeat(32)}`, alias: 'Existing',
      target_session_id: 'chat-existing', actions: ['instruction'],
      created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z',
      target: { title: 'Existing', folder: null, backend: 'codex', available: true, unavailable_reason: null }
    }
    const reference: ChatReference = {
      session_id: 'chat-new', display_title_snapshot: 'New',
      source_text_start: 4, source_text_end: 8, action: 'route', grant_intent: true
    }
    useAppStore.setState({
      switchingProfileId: null,
      selectedSessionId: 'chat-a', chatPanes: { primary: 'chat-a', secondary: null },
      sessions: [sessionFor('chat-a'), { ...sessionFor('chat-new'), title: 'New' }],
      health: durableRouteHealth(),
      drafts: { 'chat-a': 'Ask @New' }, chatReferencesBySession: { 'chat-a': [reference] },
      uploadsBySession: {}, uploadPathsBySession: {},
      agentRoutesBySession: { 'chat-a': { routes: [existingRoute], max_routes: 1 } },
      error: null
    })

    await expect(useAppStore.getState().sendPromptForSession('chat-a')).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toMatch(/route access limit/i)
  })

  it('admits a new pending grant beyond sixteen stored routes when max_routes is null', async () => {
    const routes: AgentCrossChatRoute[] = Array.from({ length: 20 }, (_, index) => ({
      route_id: `route-${index}`, revision: `rev_${'a'.repeat(32)}`, alias: `Existing ${index}`,
      target_session_id: `chat-existing-${index}`, actions: ['instruction'],
      created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z',
      target: { title: `Existing ${index}`, folder: null, backend: 'codex', available: true, unavailable_reason: null }
    }))
    const snapshot = { routes, max_routes: null }
    const send = vi.fn().mockResolvedValue({ session: sessionFor('chat-a'), queued: false })
    const list = vi.fn().mockResolvedValue(snapshot)
    Object.defineProperty(window, 'agentsDock', { configurable: true,
      value: { turns: { send }, agentRoutes: { list } } as unknown as AgentsDockAPI })
    const reference: ChatReference = { session_id: 'chat-new', display_title_snapshot: 'New',
      source_text_start: 4, source_text_end: 8, action: 'route', grant_intent: true }
    useAppStore.setState({ activeProfileId: 'profile-a', profileGeneration: 7, switchingProfileId: null,
      profiles: [{ id: 'profile-a', name: 'Server', serverIdentity: 'server-a' } as PublicServerProfile],
      selectedSessionId: 'chat-a', chatPanes: { primary: 'chat-a', secondary: null },
      sessions: [sessionFor('chat-a'), { ...sessionFor('chat-new'), title: 'New' }], snapshots: {},
      health: durableRouteHealth(), drafts: { 'chat-a': 'Ask @New' }, chatReferencesBySession: { 'chat-a': [reference] },
      uploadsBySession: {}, uploadPathsBySession: {}, agentRoutesBySession: { 'chat-a': snapshot }, error: null })
    await expect(useAppStore.getState().sendPromptForSession('chat-a')).resolves.toBe(true)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ chatReferences: [reference] }))
    expect(useAppStore.getState().error).toBeNull()
  })

  it('persists a pending @ grant only after ordinary turn admission succeeds, then refreshes the scoped grant list', async () => {
    const pendingSend = deferred<{ session: Session; queued: boolean }>()
    const send = vi.fn(() => pendingSend.promise)
    const route: AgentCrossChatRoute = {
      route_id: 'route-1', revision: `rev_${'a'.repeat(32)}`, alias: 'Target', target_session_id: 'chat-b',
      actions: ['instruction', 'request_reply'], created_at: '2026-08-27T00:00:00Z', updated_at: '2026-08-27T00:00:00Z',
      target: { title: 'Target', folder: null, backend: 'codex', available: true, unavailable_reason: null }
    }
    const list = vi.fn().mockResolvedValue({ routes: [route], max_routes: 16 })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send }, agentRoutes: { list } } as unknown as AgentsDockAPI
    })
    const reference: ChatReference = {
      session_id: 'chat-b', display_title_snapshot: 'Target', source_text_start: 4, source_text_end: 11,
      action: 'route', grant_intent: true
    }
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 7, switchingProfileId: null,
      profiles: [{ id: 'profile-a', name: 'Server', serverIdentity: 'server-a' } as PublicServerProfile],
      selectedSessionId: 'chat-a', chatPanes: { primary: 'chat-a', secondary: null },
      sessions: [sessionFor('chat-a'), { ...sessionFor('chat-b'), title: 'Target' }], health: durableRouteHealth(), snapshots: {},
      drafts: { 'chat-a': 'Ask @Target' }, chatReferencesBySession: { 'chat-a': [reference] },
      uploadsBySession: {}, uploadPathsBySession: {}, agentRoutesBySession: {}
    })

    const request = useAppStore.getState().sendPrompt()
    expect(list).not.toHaveBeenCalled()
    pendingSend.resolve({ session: sessionFor('chat-a'), queued: false })
    await expect(request).resolves.toBe(true)

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      chatReferences: [reference],
      clientCapabilities: expect.arrayContaining(['agent_cross_chat_routes_v2'])
    }))
    await vi.waitFor(() => expect(list).toHaveBeenCalledWith({
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a'
    }, 'chat-a'))
    await vi.waitFor(() => expect(useAppStore.getState().agentRoutesBySession['chat-a']?.routes).toEqual([route]))
  })

  it('does not refresh or persist a pending @ grant when admission fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'))
    const list = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send }, agentRoutes: { list } } as unknown as AgentsDockAPI
    })
    const reference: ChatReference = {
      session_id: 'chat-b', display_title_snapshot: 'Target', source_text_start: 4, source_text_end: 11,
      action: 'route', grant_intent: true
    }
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 7, switchingProfileId: null,
      profiles: [{ id: 'profile-a', name: 'Server', serverIdentity: 'server-a' } as PublicServerProfile],
      selectedSessionId: 'chat-a', chatPanes: { primary: 'chat-a', secondary: null },
      sessions: [sessionFor('chat-a'), { ...sessionFor('chat-b'), title: 'Target' }], health: durableRouteHealth(), snapshots: {},
      drafts: { 'chat-a': 'Ask @Target' }, chatReferencesBySession: { 'chat-a': [reference] },
      uploadsBySession: {}, uploadPathsBySession: {}, agentRoutesBySession: {}
    })

    await expect(useAppStore.getState().sendPrompt()).resolves.toBe(false)
    expect(list).not.toHaveBeenCalled()
    expect(useAppStore.getState().chatReferencesBySession['chat-a']).toEqual([reference])
  })

  it('uses revision CAS for explicit revoke and refreshes a conflicting grant without deleting draft text', async () => {
    const oldRoute: AgentCrossChatRoute = {
      route_id: 'route-1', revision: `rev_${'a'.repeat(32)}`, alias: 'Target', target_session_id: 'chat-b',
      actions: ['instruction', 'request_reply'], created_at: '2026-08-27T00:00:00Z', updated_at: '2026-08-27T00:00:00Z',
      target: { title: 'Target', folder: null, backend: 'codex', available: true, unavailable_reason: null }
    }
    const currentRoute = { ...oldRoute, revision: `rev_${'b'.repeat(32)}` }
    const remove = vi.fn().mockResolvedValue({ status: 'revision_conflict' })
    const list = vi.fn().mockResolvedValue({ routes: [currentRoute], max_routes: 16 })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { agentRoutes: { remove, list } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 7, switchingProfileId: null,
      profiles: [{ id: 'profile-a', name: 'Server', serverIdentity: 'server-a' } as PublicServerProfile],
      sessions: [sessionFor('chat-a')], health: durableRouteHealth(), drafts: { 'chat-a': 'Keep this draft' },
      agentRoutesBySession: { 'chat-a': { routes: [oldRoute], max_routes: 16 } }
    })

    await expect(useAppStore.getState().revokeAgentRoute('chat-a', oldRoute.route_id, oldRoute.revision)).resolves.toBe(false)
    expect(remove).toHaveBeenCalledWith({ profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' }, 'chat-a', 'route-1', oldRoute.revision)
    expect(useAppStore.getState().agentRoutesBySession['chat-a'].routes).toEqual([currentRoute])
    expect(useAppStore.getState().agentRouteErrorsBySession['chat-a']).toMatch(/changed on the server/i)
    expect(useAppStore.getState().drafts['chat-a']).toBe('Keep this draft')
  })

  it('fences an old route revoke across a server restart without clearing a newer revoke', async () => {
    const handlers = new Map<string, (payload: any) => void>()
    const oldRemoval = deferred<{ status: 'deleted'; deleted: boolean; route_id: string }>()
    const newRemoval = deferred<{ status: 'deleted'; deleted: boolean; route_id: string }>()
    const remove = vi.fn()
      .mockImplementationOnce(() => oldRemoval.promise)
      .mockImplementationOnce(() => newRemoval.promise)
    const list = vi.fn().mockResolvedValue({ routes: [], max_routes: 16 })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue({
          settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
          health: null, sessions: [], jobs: [], runtimeCatalog: null,
          folderOrder: [], collapsedFolders: [], archivedCollapsed: false, inspectorVisible: true
        }),
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        agentRoutes: { remove, list },
        events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ initialized: false, connected: false, sessions: [], snapshots: {} })
    await useAppStore.getState().initialize()
    const route: AgentCrossChatRoute = {
      route_id: 'route-1', revision: `rev_${'a'.repeat(32)}`, alias: 'Target', target_session_id: 'chat-b',
      actions: ['instruction'], created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z',
      target: { title: 'Target', folder: null, backend: 'codex', available: true, unavailable_reason: null }
    }
    const oldHealth = { ...durableRouteHealth(), server_identity: 'server-a', server_instance_id: 'instance-old' }
    const newHealth = { ...oldHealth, server_instance_id: 'instance-new' }
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 7, switchingProfileId: null, connected: true,
      profiles: [{ id: 'profile-a', name: 'Server', serverIdentity: 'server-a' } as PublicServerProfile],
      sessions: [sessionFor('chat-a')], selectedSessionId: 'chat-a',
      chatPanes: { primary: 'chat-a', secondary: null }, health: oldHealth,
      agentRoutesBySession: { 'chat-a': { routes: [route], max_routes: 16 } }, revokingAgentRouteIds: new Set()
    })

    const oldRequest = useAppStore.getState().revokeAgentRoute('chat-a', route.route_id, route.revision)
    handlers.get('server:connection')?.({
      connected: true, profileId: 'profile-a', profileGeneration: 7, health: newHealth
    })
    const newRequest = useAppStore.getState().revokeAgentRoute('chat-a', route.route_id, route.revision)
    oldRemoval.resolve({ status: 'deleted', deleted: true, route_id: route.route_id })

    await expect(oldRequest).resolves.toBe(false)
    expect(useAppStore.getState().revokingAgentRouteIds).toContain('chat-a:route-1')
    expect(list).toHaveBeenCalledTimes(1)

    newRemoval.resolve({ status: 'deleted', deleted: true, route_id: route.route_id })
    await expect(newRequest).resolves.toBe(true)
    expect(useAppStore.getState().revokingAgentRouteIds).not.toContain('chat-a:route-1')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('sends and consumes structured cross-chat references when the server advertises support', async () => {
    const reference: ChatReference = {
      session_id: 'chat-b',
      display_title_snapshot: 'Target',
      source_text_start: 4,
      source_text_end: 11,
      action: 'instruction'
    }
    const send = vi.fn().mockResolvedValue({ session: sessionFor('chat-a'), queued: false })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-a',
      sessions: [sessionFor('chat-a'), { ...sessionFor('chat-b'), title: 'Target' }],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: {
            available: true,
            required: false,
            message: '',
            action: null,
            version: 1
          }
        }
      },
      snapshots: {},
      drafts: { 'chat-a': 'Ask @Target' },
      chatReferencesBySession: { 'chat-a': [reference] },
      uploadsBySession: {},
      uploadPathsBySession: {}
    })

    await expect(useAppStore.getState().sendPrompt()).resolves.toBe(true)

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-a',
      prompt: 'Ask @Target',
      chatReferences: [reference],
      clientCapabilities: expect.arrayContaining(['cross_chat_handoffs_v1'])
    }))
    expect(useAppStore.getState().chatReferencesBySession['chat-a']).toEqual([])
  })

  it('sends request-reply authority unchanged on v2 and refuses to downgrade it on v1', async () => {
    const reference: ChatReference = {
      session_id: 'chat-b', display_title_snapshot: 'Target',
      source_text_start: 4, source_text_end: 11, action: 'request_reply'
    }
    const send = vi.fn().mockResolvedValue({ session: sessionFor('chat-a'), queued: false })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    const capableHealth = {
      ok: true,
      capabilities: {
        cross_chat_handoffs_v1: {
          available: true, required: false, message: '', action: null,
          version: 2, actions: ['request_reply', 'instruction'],
          supported_target_backends: ['codex', 'claude']
        }
      }
    } satisfies Health
    useAppStore.setState({
      selectedSessionId: 'chat-a',
      sessions: [sessionFor('chat-a'), { ...sessionFor('chat-b'), title: 'Target', backend: 'claude' }],
      health: capableHealth,
      snapshots: {}, drafts: { 'chat-a': 'Ask @Target' },
      chatReferencesBySession: { 'chat-a': [reference] }, uploadsBySession: {}, uploadPathsBySession: {}
    })

    await expect(useAppStore.getState().sendPrompt()).resolves.toBe(true)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      chatReferences: [reference],
      clientCapabilities: expect.arrayContaining(['cross_chat_handoffs_v1', 'cross_chat_handoffs_v2'])
    }))

    send.mockClear()
    useAppStore.setState({
      health: {
        ...capableHealth,
        capabilities: { cross_chat_handoffs_v1: { ...capableHealth.capabilities.cross_chat_handoffs_v1, version: 1 } }
      },
      drafts: { 'chat-a': 'Ask @Target' }, chatReferencesBySession: { 'chat-a': [reference] }
    })
    await expect(useAppStore.getState().sendPrompt()).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().chatReferencesBySession['chat-a']).toEqual([reference])
    expect(useAppStore.getState().error).toContain('not supported')
    useAppStore.setState({ chatReferencesBySession: {}, error: null })
  })

  it('rejects a secure-peer @ route before desktop turn admission', async () => {
    const canonical: ChatReference = {
      session_id: '22e7bb2e-3b47-4be7-89fc-2cecd90f4434',
      display_title_snapshot: 'Studio/training',
      source_text_start: 4,
      source_text_end: 20,
      action: 'request_reply',
      target_kind: 'secure_peer',
      target_server_identity: 'server-studio',
      target_connection_id: '09d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      target_route_id: '22e7bb2e-3b47-4be7-89fc-2cecd90f4434',
      target_route_revision: `rev_${'a'.repeat(32)}`
    }
    const hostile = {
      ...canonical,
      transcript: 'not-authorized',
      file_grants: ['/private/data'],
      remote_hub_token: 'not-authorized'
    } as ChatReference
    const send = vi.fn().mockResolvedValue({ session: sessionFor('chat-a'), queued: false })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-a',
      sessions: [sessionFor('chat-a')],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: {
            available: true, required: false, message: '', action: null,
            version: 2, actions: ['request_reply', 'instruction'],
            supported_target_backends: ['codex', 'claude']
          }
        }
      },
      snapshots: {}, drafts: { 'chat-a': 'Ask @Studio/training' },
      chatReferencesBySession: { 'chat-a': [hostile] }, uploadsBySession: {}, uploadPathsBySession: {}
    })

    await expect(useAppStore.getState().sendPrompt()).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toMatch(/use @@ Team Network Inbox/i)
    expect(useAppStore.getState().drafts['chat-a']).toBe('Ask @Studio/training')
    expect(useAppStore.getState().chatReferencesBySession['chat-a']).toEqual([hostile])
    useAppStore.setState({ chatReferencesBySession: {}, error: null })
  })

  it('advertises Claude SDK interactions on capable Claude chats', async () => {
    const claudeSession: Session = { ...sessionFor('chat-a'), backend: 'claude' }
    const send = vi.fn().mockResolvedValue({ session: claudeSession, queued: false })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-a',
      sessions: [claudeSession],
      health: {
        ok: true,
        capabilities: {
          claude_controls: {
            available: true,
            required: false,
            message: '',
            action: null,
            interactive_client_capability: 'claude_sdk_interactive_v1'
          }
        }
      },
      snapshots: {},
      drafts: { 'chat-a': 'Use the SDK' },
      uploadsBySession: {},
      uploadPathsBySession: {}
    })

    await expect(useAppStore.getState().sendPrompt()).resolves.toBe(true)

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-a',
      clientCapabilities: ['codex_interactive_v1', 'codex_goal_steer_v1', 'claude_sdk_interactive_v1']
    }))
  })

  it('merges failed-send state without overwriting the next draft or attachments', async () => {
    let rejectSend!: (error: Error) => void
    const send = vi.fn(() => new Promise((_resolve, reject) => { rejectSend = reject }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    const oldFile: AgentFile = { id: 'old-file', filename: 'old.txt', content_type: 'text/plain' }
    const newFile: AgentFile = { id: 'new-file', filename: 'new.txt', content_type: 'text/plain' }
    const newPath: NativeFileRef = { path: '/tmp/new.txt', name: 'new.txt' }
    useAppStore.setState({
      selectedSessionId: 'chat-a', sessions: [sessionFor('chat-a')], snapshots: {},
      drafts: { 'chat-a': 'First request' }, uploadsBySession: { 'chat-a': [oldFile] },
      uploadPathsBySession: { 'chat-a': [] }
    })

    const pending = useAppStore.getState().sendPrompt()
    expect(useAppStore.getState().drafts['chat-a']).toBe('')
    expect(useAppStore.getState().turnAdmissionTokens['chat-a']).toBeTruthy()
    useAppStore.setState({
      drafts: { 'chat-a': 'Next request' }, uploadsBySession: { 'chat-a': [newFile] },
      uploadPathsBySession: { 'chat-a': [newPath] }
    })
    const genericIpcError = "Error invoking remote method 'turns:send': Error: connection closed"
    rejectSend(new Error(genericIpcError))

    await expect(pending).resolves.toBe(false)
    expect(useAppStore.getState().drafts['chat-a']).toBe('Next request')
    expect(useAppStore.getState().uploadsBySession['chat-a'].map(file => file.id)).toEqual(['new-file', 'old-file'])
    expect(useAppStore.getState().uploadPathsBySession['chat-a'].map(file => file.path)).toEqual(['/tmp/new.txt'])
    expect(useAppStore.getState().turnAdmissionTokens['chat-a']).toBeUndefined()
    expect(useAppStore.getState().error).toBe(genericIpcError)
  })

  it('turns the screenshot-shaped FastAPI Team reference failure into upgrade guidance', async () => {
    const prompt = 'Then, post the time-critical skill to @@bulletin'
    const sourceStart = prompt.indexOf('@@bulletin')
    const reference = {
      kind: 'recipient' as const,
      recipient_kind: 'all' as const,
      team_id: 'team_93daaefe6a0',
      target_id: 'all',
      display_name_snapshot: 'bulletin',
      source_text_start: sourceStart,
      source_text_end: sourceStart + '@@bulletin'.length,
      grant_intent: true as const
    }
    const detail = [{
      type: 'value_error',
      loc: ['body', 'team_references', 0],
      msg: "Value error, team-wide recipients use the visible token '@@all'",
      input: reference,
      ctx: { error: {} }
    }]
    const send = vi.fn().mockRejectedValue(new Error(
      `Error invoking remote method 'turns:send': Error: ${JSON.stringify(detail)}`
    ))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: null, profileGeneration: 0, switchingProfileId: null,
      selectedSessionId: 'chat-a', chatPanes: { primary: 'chat-a', secondary: null },
      sessions: [sessionFor('chat-a')], snapshots: {},
      health: { ok: true, capabilities: { agent_team_messages_v1: {
        available: true, version: 1, helper: 'team', mention_sigil: '@@', read_always: true,
        send_requires_mention: true, recipient_kinds: ['server', 'human', 'all'],
        reference_kinds: ['recipient', 'skill'], max_sends_per_run: 4,
        max_attachments_per_send: 16, max_body_bytes: 49_152
      } } },
      drafts: { 'chat-a': prompt }, teamReferencesBySession: { 'chat-a': [reference] },
      uploadsBySession: {}, uploadPathsBySession: {}, error: null
    })

    await expect(useAppStore.getState().sendPromptForSession('chat-a')).resolves.toBe(false)

    expect(useAppStore.getState().error).toBe(
      'This AgentsServer does not support @@bulletin yet. Update the server and try again.'
    )
    expect(useAppStore.getState().drafts['chat-a']).toBe(prompt)
  })

  it('keeps an explicit send targeted at its pane when focus changes', async () => {
    const pendingSend = deferred<{ session: Session; queued: boolean }>()
    const send = vi.fn(() => pendingSend.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' }, focusedChatPane: 'primary', selectedSessionId: 'chat-a',
      sessions: [sessionFor('chat-a'), sessionFor('chat-b')], snapshots: {},
      drafts: { 'chat-a': 'Message A', 'chat-b': 'Message B' },
      uploadsBySession: {}, uploadPathsBySession: {}, chatReferencesBySession: {}, turnAdmissionTokens: {}
    })

    const request = useAppStore.getState().sendPromptForSession('chat-a')
    useAppStore.setState({ focusedChatPane: 'secondary', selectedSessionId: 'chat-b' })
    pendingSend.resolve({ session: sessionFor('chat-a'), queued: false })

    await expect(request).resolves.toBe(true)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat-a', prompt: 'Message A' }))
    expect(useAppStore.getState().drafts['chat-a']).toBe('')
    expect(useAppStore.getState().drafts['chat-b']).toBe('Message B')
  })

  it('sends and consumes a ready attachment with an empty prompt', async () => {
    const send = vi.fn().mockResolvedValue({ session: sessionFor('chat-a'), queued: false })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    const image: AgentFile = { id: 'image-1', filename: 'screen.png', content_type: 'image/png' }
    useAppStore.setState({
      selectedSessionId: 'chat-a', sessions: [sessionFor('chat-a')], snapshots: {},
      drafts: { 'chat-a': '' }, uploadsBySession: { 'chat-a': [image] }, uploadPathsBySession: {}
    })

    await expect(useAppStore.getState().sendPrompt()).resolves.toBe(true)

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-a', prompt: '', fileIds: ['image-1']
    }))
    expect(useAppStore.getState().uploadsBySession['chat-a']).toEqual([])
  })

  it('does not send an empty composer or race a pending upload', async () => {
    const send = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    const pending: NativeFileRef = { path: '/tmp/large.png', name: 'large.png', type: 'image/png' }
    useAppStore.setState({
      selectedSessionId: 'chat-a', sessions: [sessionFor('chat-a')], snapshots: {}, drafts: { 'chat-a': '' },
      uploadsBySession: {}, uploadPathsBySession: {}
    })

    await expect(useAppStore.getState().sendPrompt()).resolves.toBe(false)
    useAppStore.setState({ drafts: { 'chat-a': 'Send with file' }, uploadPathsBySession: { 'chat-a': [pending] } })
    await expect(useAppStore.getState().sendPrompt()).resolves.toBe(false)

    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().drafts['chat-a']).toBe('Send with file')
    expect(useAppStore.getState().uploadPathsBySession['chat-a']).toEqual([pending])
  })
})

describe('attachment upload projection', () => {
  it('merges a successful upload into the current snapshot before live events arrive', async () => {
    const file: AgentFile = { id: 'image-1', filename: 'screen.png', content_type: 'image/png' }
    const upload = vi.fn().mockResolvedValue([file])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { upload } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 0, switchingProfileId: null,
      selectedSessionId: 'chat-a', sessions: [sessionFor('chat-a')],
      snapshots: { 'chat-a': snapshot('chat-a', [eventFor('chat-a', 1)]) },
      uploadsBySession: {}, uploadPathsBySession: {}
    })
    const ref: NativeFileRef = { path: '/tmp/screen.png', name: 'screen.png', type: 'image/png' }

    await useAppStore.getState().attachPaths([ref])

    expect(upload).toHaveBeenCalledWith('chat-a', ['/tmp/screen.png'])
    expect(useAppStore.getState().uploadsBySession['chat-a']).toEqual([file])
    expect(useAppStore.getState().snapshots['chat-a'].files).toEqual([file])
    expect(useAppStore.getState().snapshots['chat-a'].filesTotal).toBe(1)
  })
})

describe('Command-Enter steering', () => {
  it('promotes a queued turn when its ID is carried by the queue event', async () => {
    const runNow = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        turns: { send: vi.fn().mockResolvedValue({
          session: sessionFor('chat-a'),
          queued: true,
          event: eventFor('chat-a', 2, { type: 'turn_queued', queued_id: 'event-queue-id', prompt: 'Steer now' })
        }) },
        queue: { runNow, list: vi.fn().mockResolvedValue([]) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-a', sessions: [sessionFor('chat-a')],
      snapshots: { 'chat-a': snapshot('chat-a', [eventFor('chat-a', 1)]) }, error: null
    })

    await expect(useAppStore.getState().sendPrompt('Steer now', true)).resolves.toBe(true)

    expect(runNow).toHaveBeenCalledWith('chat-a', 'event-queue-id')
    expect(useAppStore.getState().error).toBeNull()
  })

  it('resolves the exact newly queued turn when older servers omit the ID from the response', async () => {
    const existing: QueuedTurn = { queued_id: 'existing', session_id: 'chat-a', prompt: 'Earlier', file_ids: [], position: 1 }
    const created: QueuedTurn = { queued_id: 'resolved-new', session_id: 'chat-a', prompt: 'Steer this exact prompt', file_ids: [], position: 2 }
    const runNow = vi.fn().mockResolvedValue(true)
    const list = vi.fn().mockResolvedValueOnce([existing, created]).mockResolvedValueOnce([existing])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        turns: { send: vi.fn().mockResolvedValue({ session: sessionFor('chat-a'), queued: true }) },
        queue: { runNow, list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-a', sessions: [sessionFor('chat-a')],
      snapshots: { 'chat-a': { ...snapshot('chat-a', [eventFor('chat-a', 1)]), queuedTurns: [existing] } }, error: null
    })

    await expect(useAppStore.getState().sendPrompt('Steer this exact prompt', true)).resolves.toBe(true)

    expect(runNow).toHaveBeenCalledWith('chat-a', 'resolved-new')
    expect(list).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().error).toBeNull()
  })
})

describe('older timeline paging', () => {
  it('accepts a proven correction in an overlapping older page without resurrecting its cached user turn', async () => {
    const corrected = providerInterruption({ id: 'chat-a-2', session_id: 'chat-a', seq: 2 })
    const legacy = { ...corrected, type: 'turn_started', provider_origin: undefined, prompt: '[Request interrupted by user]' }
    const first = eventFor('chat-a', 1)
    const last = eventFor('chat-a', 3)
    const older = vi.fn().mockResolvedValue({
      session: sessionFor('chat-a'), events: [first, corrected], queued_turns: [], has_more: false
    } satisfies TimelinePage)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true, value: { timeline: { older } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      selectedSessionId: 'chat-a',
      snapshots: { 'chat-a': snapshot('chat-a', [legacy, last], true) }
    })

    await expect(useAppStore.getState().loadOlder()).resolves.toBe(1)

    expect(useAppStore.getState().snapshots['chat-a'].events).toEqual([first, corrected, last])
  })

  it('uses and advances the persisted semantic boundary instead of the oldest raw event', async () => {
    const older = vi.fn().mockResolvedValue({
      session: sessionFor('chat-a'),
      events: [eventFor('chat-a', 60)],
      has_more: true,
      next_semantic_before: 42
    } satisfies TimelinePage)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { older } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-a',
      snapshots: {
        'chat-a': {
          ...snapshot('chat-a', [eventFor('chat-a', 100)], true),
          nextTimelineBefore: 75,
          semanticPaging: true
        }
      }
    })

    await useAppStore.getState().loadOlder()

    expect(older).toHaveBeenCalledWith('chat-a', 75, 120)
    expect(useAppStore.getState().snapshots['chat-a'].nextTimelineBefore).toBe(42)
  })

  it('merges against the current snapshot so streamed events are not discarded', async () => {
    const session = sessionFor('chat-a')
    let resolvePage!: (page: TimelinePage) => void
    const page = new Promise<TimelinePage>(resolve => { resolvePage = resolve })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { older: vi.fn(() => page) } }
    })
    useAppStore.setState({ selectedSessionId: 'chat-a', snapshots: { 'chat-a': snapshot('chat-a', [eventFor('chat-a', 10)], true) } })
    const pending = useAppStore.getState().loadOlder()
    useAppStore.setState(state => ({ snapshots: {
      ...state.snapshots,
      'chat-a': { ...state.snapshots['chat-a'], events: [...state.snapshots['chat-a'].events, eventFor('chat-a', 11)] }
    } }))
    resolvePage({ session, events: [eventFor('chat-a', 1)], has_more: false })
    await pending
    expect(useAppStore.getState().snapshots['chat-a'].events.map(item => item.seq)).toEqual([1, 10, 11])
  })

  it('loads only one bounded history page per user gesture', async () => {
    const current = [eventFor('chat-a', 100), eventFor('chat-a', 101)]
    const older = vi.fn()
      .mockResolvedValue({ session: sessionFor('chat-a'), events: [eventFor('chat-a', 90)], has_more: true })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { timeline: { older } } as unknown as AgentsDockAPI })
    useAppStore.setState({ selectedSessionId: 'chat-a', snapshots: { 'chat-a': { ...snapshot('chat-a', current, true), generation: 7 } } })
    let publications = 0
    const unsubscribe = useAppStore.subscribe(() => { publications += 1 })
    await useAppStore.getState().loadOlder()
    unsubscribe()
    expect(older).toHaveBeenCalledTimes(1)
    expect(older).toHaveBeenCalledWith('chat-a', 100, 480)
    expect(useAppStore.getState().snapshots['chat-a'].events.map(item => item.seq)).toEqual([90, 100, 101])
    expect(useAppStore.getState().snapshots['chat-a'].generation).toBe(7)
    expect(publications).toBe(1)
  })

  it('allows initial-view autofill to request a smaller semantic page', async () => {
    const older = vi.fn().mockResolvedValue({
      session: sessionFor('chat-a'),
      events: [eventFor('chat-a', 90)],
      has_more: true,
      next_semantic_before: 90
    } satisfies TimelinePage)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { older } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-a',
      snapshots: { 'chat-a': snapshot('chat-a', [eventFor('chat-a', 100)], true) }
    })

    await useAppStore.getState().loadOlder(23)

    expect(older).toHaveBeenCalledWith('chat-a', 100, 23)
  })

  it('keeps explicitly requested older history resident while the chat is selected', async () => {
    const current = Array.from({ length: 720 }, (_, index) => eventFor('chat-a', index + 481))
    const historical = Array.from({ length: 480 }, (_, index) => eventFor('chat-a', index + 1))
    const older = vi.fn().mockResolvedValue({
      session: sessionFor('chat-a'),
      events: historical,
      has_more: false
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { older } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-a',
      snapshots: { 'chat-a': snapshot('chat-a', current, true) }
    })

    await expect(useAppStore.getState().loadOlder()).resolves.toBe(480)

    const events = useAppStore.getState().snapshots['chat-a'].events
    expect(events).toHaveLength(1_200)
    expect(events[0]?.seq).toBe(1)
    expect(events.at(-1)?.seq).toBe(1_200)
    expect(older).toHaveBeenCalledWith('chat-a', 481, 480)
  })
})

describe('provider history refresh', () => {
  it('replaces a proven import repair while preserving a same-prefix manual message', async () => {
    const prompt = 'scheduled monitor '.repeat(800)
    const legacy = eventFor('chat-a', 2, { type: 'turn_started', backend: 'claude',
      imported: true, run_id: 'import_history', prompt })
    const corrected: Event = { ...legacy, prompt: '', provider_history_repair: 'source_proven_import' }
    const manual = eventFor('chat-a', 3, { type: 'turn_started', backend: 'claude', prompt: prompt + ' manual tail' })
    const importHistory = vi.fn().mockResolvedValue({
      session: sessionFor('chat-a'), events: [corrected], has_more: false
    } satisfies TimelinePage)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true, value: { sessions: { importHistory } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      sessions: [sessionFor('chat-a')], snapshots: { 'chat-a': snapshot('chat-a', [legacy, manual]) }
    })
    await useAppStore.getState().importHistory('chat-a')
    expect(useAppStore.getState().snapshots['chat-a'].events).toEqual([corrected, manual])
    expect(mergeEvents([corrected, manual], [legacy])).toEqual([corrected, manual])
  })

  it('accepts a proven same-ID correction without losing live history or remounting the timeline', async () => {
    const corrected = providerInterruption({ id: 'chat-a-2', session_id: 'chat-a', seq: 2 })
    const legacy = { ...corrected, type: 'turn_started', provider_origin: undefined, prompt: '[Request interrupted by user]' }
    const first = eventFor('chat-a', 1)
    const latest = eventFor('chat-a', 3)
    const importHistory = vi.fn().mockResolvedValue({
      session: sessionFor('chat-a'), events: [first, corrected], queued_turns: [], has_more: false
    } satisfies TimelinePage)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true, value: { sessions: { importHistory } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      sessions: [sessionFor('chat-a')],
      snapshots: { 'chat-a': { ...snapshot('chat-a', [first, legacy, latest]), generation: 7, timelineListGeneration: 3 } }
    })

    await useAppStore.getState().importHistory('chat-a')

    const refreshed = useAppStore.getState().snapshots['chat-a']
    expect(refreshed.events).toEqual([first, corrected, latest])
    expect(refreshed.generation).toBe(8)
    expect(refreshed.timelineListGeneration).toBe(3)
  })

  it('requests an incremental refresh instead of force-replaying the transcript', async () => {
    const importHistory = vi.fn().mockResolvedValue({
      session: sessionFor('chat-a'),
      events: [eventFor('chat-a', 2)],
      queued_turns: [],
      has_more: false
    } satisfies TimelinePage)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { importHistory } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      sessions: [sessionFor('chat-a')],
      snapshots: { 'chat-a': snapshot('chat-a', [eventFor('chat-a', 1)]) }
    })

    await useAppStore.getState().importHistory('chat-a')

    expect(importHistory).toHaveBeenCalledWith('chat-a', false)
    expect(useAppStore.getState().snapshots['chat-a'].events.map(item => item.seq)).toEqual([1, 2])
  })
})

describe('authoritative tail detection', () => {
  it('accepts a verified hidden-companion-only tail but still repairs missing or unverified history', () => {
    const companions = [
      providerControlCompanion({ id: 'history', session_id: 'chat-a', seq: 1, type: 'history_imported' }),
      providerControlCompanion({ id: 'terminal', session_id: 'chat-a', seq: 2, result_text: 'Historical import bookkeeping' })
    ]
    const verified = { ...snapshot('chat-a', companions), historyVerified: true, eventsTotal: 2 }
    expect(snapshotNeedsAuthoritativeTail(verified)).toBe(false)
    expect(snapshotNeedsAuthoritativeTail({ ...verified, historyVerified: false })).toBe(true)
    expect(snapshotNeedsAuthoritativeTail({ ...verified, historyDiscontinuity: true })).toBe(true)
    expect(snapshotNeedsAuthoritativeTail({ ...verified, events: [] })).toBe(true)
    expect(snapshotNeedsAuthoritativeTail({
      ...verified, events: [...companions, eventFor('chat-a', 3, { type: 'raw_event' })]
    })).toBe(true)
  })

  it('accepts a control-only authoritative tail without requesting another history recovery', () => {
    const controlOnly = {
      ...snapshot('chat-a', [providerInterruption({ session_id: 'chat-a' })]),
      historyVerified: true,
      eventsTotal: 1
    }
    expect(snapshotNeedsAuthoritativeTail(controlOnly)).toBe(false)
  })

  it('uses event metadata instead of projecting the full timeline', () => {
    const visible = snapshot('chat-a', [
      eventFor('chat-a', 1, { type: 'tool_finished', text: undefined, output: 'x'.repeat(200_000) })
    ])
    expect(snapshotNeedsAuthoritativeTail(visible)).toBe(false)

    const hidden = snapshot('chat-a', [eventFor('chat-a', 1, { type: 'raw_event' })])
    hidden.session = { ...hidden.session, latest_agent_event_seq: 2 }
    expect(snapshotNeedsAuthoritativeTail(hidden)).toBe(true)
  })
})

describe('selected live timeline', () => {
  async function initializeLiveEventHandlers(): Promise<Map<string, (payload: any) => void>> {
    const handlers = new Map<string, (payload: any) => void>()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue({
          settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
          health: null,
          sessions: [],
          jobs: [],
          runtimeCatalog: null,
          folderOrder: [],
          collapsedFolders: [],
          archivedCollapsed: false,
          inspectorVisible: true
        }),
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: {
          on: vi.fn((channel: string, handler: (payload: any) => void) => {
            handlers.set(channel, handler)
            return () => {}
          })
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false,
      activeProfileId: null,
      profileGeneration: 0,
      switchingProfileId: null,
      selectedSessionId: null,
      sessions: [],
      snapshots: {}
    })
    await useAppStore.getState().initialize()
    useAppStore.setState({
      selectedSessionId: 'chat-a',
      chatPanes: { primary: 'chat-a', secondary: null },
      focusedChatPane: 'primary',
      sessions: [sessionFor('chat-a')],
      snapshots: { 'chat-a': snapshot('chat-a', [eventFor('chat-a', 1)]) }
    })
    return handlers
  }

  it('installs wheel tracking as a passive capture listener', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener')
    await initializeLiveEventHandlers()
    expect(addEventListener).toHaveBeenCalledWith(
      'wheel',
      expect.any(Function),
      { capture: true, passive: true }
    )
    addEventListener.mockRestore()
  })

  it('lets emergency alerts interrupt input without pulling an unrelated input batch', async () => {
    vi.useFakeTimers()
    const editor = document.createElement('textarea')
    document.body.append(editor)
    try {
      const handlers = await initializeLiveEventHandlers()
      useAppStore.setState(state => ({
        connected: true,
        sessions: [...state.sessions, sessionFor('chat-b')],
        snapshots: { ...state.snapshots, 'chat-b': snapshot('chat-b', [eventFor('chat-b', 1)]) }
      }))
      editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))
      handlers.get('server:event')?.({
        profileId: null, profileGeneration: 0, event: eventFor('chat-a', 2)
      })
      handlers.get('server:event')?.({
        profileId: null, profileGeneration: 0,
        event: eventFor('chat-b', 2, { type: 'emergency_alert_raised' })
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(useAppStore.getState().snapshots['chat-b'].events.at(-1)?.seq).toBe(2)
      expect(useAppStore.getState().snapshots['chat-a'].events.at(-1)?.seq).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(useAppStore.getState().snapshots['chat-a'].events.at(-1)?.seq).toBe(2)
    } finally {
      editor.remove()
      vi.useRealTimers()
    }
  })

  it('coalesces duplicate ingress and publishes no state for an existing event', async () => {
    vi.useFakeTimers()
    try {
      const handlers = await initializeLiveEventHandlers()
      useAppStore.setState({
        connected: true,
        syncSessionId: 'chat-a',
        syncStatus: 'live',
        syncError: null,
        connectionError: null
      })
      const changed = vi.fn()
      const unsubscribe = useAppStore.subscribe(changed)
      const duplicate = eventFor('chat-a', 1)
      handlers.get('server:event')?.({ profileId: null, profileGeneration: 0, event: duplicate })
      handlers.get('server:event')?.({ profileId: null, profileGeneration: 0, event: { ...duplicate } })
      await vi.advanceTimersByTimeAsync(40)
      expect(changed).not.toHaveBeenCalled()
      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([false, true])('keeps a proven live repair neutral and deduplicated when legacy arrives first: %s', async legacyFirst => {
    vi.useFakeTimers()
    try {
      const handlers = await initializeLiveEventHandlers()
      const activeSessionIds = new Set<string>()
      const session = useAppStore.getState().sessions[0]
      useAppStore.setState({ activeSessionIds })
      const corrected = providerInterruption({ id: 'chat-a-2', session_id: 'chat-a', seq: 2 })
      const legacy = { ...corrected, type: 'turn_started', provider_origin: undefined, prompt: '[Request interrupted by user]' }
      for (const incoming of legacyFirst ? [legacy, corrected] : [corrected, legacy]) {
        handlers.get('server:event')?.({ profileId: null, profileGeneration: 0, event: incoming })
      }
      await vi.advanceTimersByTimeAsync(40)
      expect(useAppStore.getState().activeSessionIds).toBe(activeSessionIds)
      expect(useAppStore.getState().snapshots['chat-a'].events).toEqual([eventFor('chat-a', 1), corrected])
      expect(useAppStore.getState().sessions[0]).toBe(session)

      // A stale subsequent echo cannot restart the chat before the merge
      // preserves the already-proven correction in its resident snapshot.
      handlers.get('server:event')?.({ profileId: null, profileGeneration: 0, event: legacy })
      await vi.advanceTimersByTimeAsync(40)
      expect(useAppStore.getState().activeSessionIds).toBe(activeSessionIds)
      expect(useAppStore.getState().snapshots['chat-a'].events.at(-1)).toBe(corrected)
    } finally {
      vi.useRealTimers()
    }
  })

  it('batches imported interruption metadata as nonurgent history without changing the running session', async () => {
    vi.useFakeTimers()
    try {
      const handlers = await initializeLiveEventHandlers()
      const activeSessionIds = new Set(['chat-a'])
      useAppStore.setState({ activeSessionIds })
      const control = providerInterruption({ session_id: 'chat-a', seq: 2 })
      handlers.get('server:event')?.({ profileId: null, profileGeneration: 0, event: control })
      await vi.advanceTimersByTimeAsync(39)
      expect(useAppStore.getState().snapshots['chat-a'].events).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(useAppStore.getState().snapshots['chat-a'].events.at(-1)).toBe(control)
      expect(useAppStore.getState().activeSessionIds).toBe(activeSessionIds)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['provider_interruption', 'history_imported', 'turn_finished'])('preserves queued turns and a queue request when %s control metadata retains queue fields', async type => {
    vi.useFakeTimers()
    try {
      const handlers = await initializeLiveEventHandlers()
      const queuedTurns: QueuedTurn[] = [
        { queued_id: 'queued-1', session_id: 'chat-a', prompt: 'First', file_ids: [], position: 1, paused: false },
        { queued_id: 'queued-2', session_id: 'chat-a', prompt: 'Second', file_ids: [], position: 2, paused: true, pause_reason: 'stopped' }
      ]
      useAppStore.setState(state => ({
        connected: true,
        activeSessionIds: new Set(['chat-a']),
        snapshots: { ...state.snapshots, 'chat-a': { ...state.snapshots['chat-a'], queuedTurns } }
      }))
      const activeSessionIds = useAppStore.getState().activeSessionIds
      const request = useAppStore.getState().beginQueuedTurnsRequest('chat-a')
      const controlFields: Partial<Event> = {
        session_id: 'chat-a', seq: 2, queued_id: 'queued-1', queued_ids: ['queued-1', 'queued-2'],
        positions: [{ queued_id: 'queued-1', position: 2 }, { queued_id: 'queued-2', position: 1 }]
      }
      const control = type === 'provider_interruption'
        ? providerInterruption(controlFields)
        : providerControlCompanion({ ...controlFields, type })
      const stale: Event = type === 'provider_interruption'
        ? { ...control, type: 'turn_started', provider_origin: undefined }
        : { ...control, metadata_only: undefined, imported: type === 'history_imported' ? undefined : true }
      handlers.get('server:event')?.({ profileId: null, profileGeneration: 0, event: control })
      handlers.get('server:event')?.({ profileId: null, profileGeneration: 0, event: stale })
      await vi.advanceTimersByTimeAsync(40)
      handlers.get('server:event')?.({ profileId: null, profileGeneration: 0, event: stale })
      await vi.advanceTimersByTimeAsync(40)

      expect(useAppStore.getState().snapshots['chat-a'].queuedTurns).toBe(queuedTurns)
      expect(useAppStore.getState().activeSessionIds).toBe(activeSessionIds)
      expect(useAppStore.getState().applyQueuedTurnsResponse('chat-a', request, queuedTurns)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds each ingress flush at 512 events without losing the remainder', async () => {
    vi.useFakeTimers()
    try {
      const handlers = await initializeLiveEventHandlers()
      useAppStore.setState({ connected: true })
      const observedLengths: number[] = []
      const unsubscribe = useAppStore.subscribe(state => {
        observedLengths.push(state.snapshots['chat-a']?.events.length ?? 0)
      })
      for (let seq = 2; seq <= 601; seq += 1) {
        handlers.get('server:event')?.({
          profileId: null, profileGeneration: 0, event: eventFor('chat-a', seq)
        })
      }

      // Capacity is enforced during ingress, before timers get a chance to run.
      expect(useAppStore.getState().snapshots['chat-a'].events).toHaveLength(513)
      expect(observedLengths).toEqual([513])
      await vi.advanceTimersByTimeAsync(39)
      expect(useAppStore.getState().snapshots['chat-a'].events).toHaveLength(513)
      await vi.advanceTimersByTimeAsync(1)
      expect(useAppStore.getState().snapshots['chat-a'].events).toHaveLength(601)
      expect(observedLengths).toEqual([513, 601])
      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a pending live timer and batch when the profile generation changes', async () => {
    vi.useFakeTimers()
    const editor = document.createElement('textarea')
    document.body.append(editor)
    try {
      const handlers = await initializeLiveEventHandlers()
      editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))
      handlers.get('server:event')?.({
        profileId: null, profileGeneration: 0, event: eventFor('chat-a', 2)
      })
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      useAppStore.setState({ selectedSessionId: null, chatPanes: { primary: null, secondary: null } })
      handlers.get('server:profiles')?.({ activeProfileId: null, profiles: [], profileGeneration: 1 })
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(useAppStore.getState().snapshots['chat-a'].events.at(-1)?.seq).toBe(1)
    } finally {
      editor.remove()
      vi.useRealTimers()
    }
  })

  it('defers noncritical live rendering until text input is quiet', async () => {
    vi.useFakeTimers()
    const editor = document.createElement('textarea')
    document.body.append(editor)
    try {
      const handlers = await initializeLiveEventHandlers()
      editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))
      handlers.get('server:event')?.({
        profileId: null,
        profileGeneration: 0,
        event: eventFor('chat-a', 2)
      })

      await vi.advanceTimersByTimeAsync(999)
      expect(useAppStore.getState().snapshots['chat-a'].events.at(-1)?.seq).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(useAppStore.getState().snapshots['chat-a'].events.at(-1)?.seq).toBe(2)
    } finally {
      editor.remove()
      vi.useRealTimers()
    }
  })

  it('never flushes ordinary events through continuous input and resumes after quiet', async () => {
    vi.useFakeTimers()
    const editor = document.createElement('textarea')
    document.body.append(editor)
    try {
      const handlers = await initializeLiveEventHandlers()
      editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))
      handlers.get('server:event')?.({
        profileId: null,
        profileGeneration: 0,
        event: eventFor('chat-a', 2)
      })
      for (let elapsed = 100; elapsed <= 2_000; elapsed += 100) {
        await vi.advanceTimersByTimeAsync(100)
        editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))
      }
      handlers.get('server:event')?.({
        profileId: null,
        profileGeneration: 0,
        event: eventFor('chat-a', 3)
      })
      handlers.get('server:event')?.({
        profileId: null,
        profileGeneration: 0,
        event: eventFor('chat-a', 4, { type: 'turn_finished' })
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(useAppStore.getState().snapshots['chat-a'].events.at(-1)?.seq).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(useAppStore.getState().snapshots['chat-a'].events.at(-1)?.seq).toBe(4)
    } finally {
      editor.remove()
      vi.useRealTimers()
    }
  })

  it('does not publish equivalent connection and sync heartbeats to store subscribers', async () => {
    const handlers = await initializeLiveEventHandlers()
    const health: Health = {
      ok: true,
      api_contract_version: 8,
      websocket_runtime: true,
      active: ['chat-a']
    }
    useAppStore.setState({
      connected: true,
      health,
      activeSessionIds: new Set(['chat-a']),
      syncSessionId: 'chat-a',
      syncStatus: 'live',
      syncError: null,
      syncBySession: { 'chat-a': { status: 'live', error: null } },
      connectionError: null
    })
    const changed = vi.fn()
    const unsubscribe = useAppStore.subscribe(changed)
    try {
      handlers.get('server:sync')?.({
        profileId: null,
        profileGeneration: 0,
        sessionId: 'chat-a',
        state: 'live'
      })
      handlers.get('server:connection')?.({
        profileId: null,
        profileGeneration: 0,
        connected: true,
        health: { ...health, active: ['chat-a'] }
      })
      expect(changed).not.toHaveBeenCalled()
      expect(useAppStore.getState().health).toBe(health)
    } finally {
      unsubscribe()
    }
  })

  it('retains the stable prefix needed for incremental projection while coalescing stream events', async () => {
    vi.useFakeTimers()
    try {
      const handlers = new Map<string, (payload: any) => void>()
      Object.defineProperty(window, 'agentsDock', {
        configurable: true,
        value: {
          bootstrap: vi.fn().mockResolvedValue({
            settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
            health: null,
            sessions: [],
            jobs: [],
            runtimeCatalog: null,
            folderOrder: [],
            collapsedFolders: [],
            archivedCollapsed: false,
            inspectorVisible: true
          }),
          native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
          events: {
            on: vi.fn((channel: string, handler: (payload: any) => void) => {
              handlers.set(channel, handler)
              return () => {}
            })
          }
        } as unknown as AgentsDockAPI
      })
      useAppStore.setState({
        initialized: false,
        activeProfileId: null,
        profileGeneration: 0,
        switchingProfileId: null,
        selectedSessionId: null,
        sessions: [],
        snapshots: {}
      })
      await useAppStore.getState().initialize()
      useAppStore.setState({
        selectedSessionId: 'chat-a',
        sessions: [sessionFor('chat-a')],
        snapshots: { 'chat-a': snapshot('chat-a', []) }
      })

      handlers.get('server:timeline')?.({
        profileId: null,
        profileGeneration: 0,
        sessionId: 'chat-a',
        snapshot: snapshot('chat-a', Array.from({ length: 1_200 }, (_, index) => eventFor('chat-a', index + 1))),
        source: 'server',
        mode: 'replace'
      })

      let events = useAppStore.getState().snapshots['chat-a'].events
      expect(events).toHaveLength(1_200)
      expect(events[0]?.seq).toBe(1)
      expect(events.at(-1)?.seq).toBe(1_200)

      for (let seq = 1_201; seq <= 1_210; seq += 1) {
        handlers.get('server:event')?.({
          profileId: null,
          profileGeneration: 0,
          event: eventFor('chat-a', seq)
        })
      }
      await vi.advanceTimersByTimeAsync(39)
      expect(useAppStore.getState().snapshots['chat-a'].events.at(-1)?.seq).toBe(1_200)
      await vi.advanceTimersByTimeAsync(1)

      events = useAppStore.getState().snapshots['chat-a'].events
      expect(events).toHaveLength(1_210)
      expect(events[0]?.seq).toBe(1)
      expect(events.at(-1)?.seq).toBe(1_210)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a transient target-queue refresh when a cross-chat delivery becomes queued', async () => {
    vi.useFakeTimers()
    try {
      const handlers = new Map<string, (payload: any) => void>()
      const delivery: QueuedTurn = {
        queued_id: 'queued-cross-chat', session_id: 'chat-a',
        prompt: 'Agent-authored same-server handoff',
        display_prompt: 'Agent-authored same-server handoff',
        file_ids: [], position: 2, purpose: 'cross_chat_handoff_delivery'
      }
      const list = vi.fn()
        .mockRejectedValueOnce(new Error('temporary queue read failure'))
        .mockResolvedValue([delivery])
      Object.defineProperty(window, 'agentsDock', {
        configurable: true,
        value: {
          bootstrap: vi.fn().mockResolvedValue({
            settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
            health: null, sessions: [], jobs: [], runtimeCatalog: null,
            folderOrder: [], collapsedFolders: [], archivedCollapsed: false,
            inspectorVisible: true
          }),
          native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
          queue: { list },
          events: {
            on: vi.fn((channel: string, handler: (payload: any) => void) => {
              handlers.set(channel, handler)
              return () => {}
            })
          }
        } as unknown as AgentsDockAPI
      })
      useAppStore.setState({
        initialized: false, activeProfileId: null, profileGeneration: 0,
        switchingProfileId: null, selectedSessionId: null, sessions: [], snapshots: {}
      })
      await useAppStore.getState().initialize()
      useAppStore.setState({
        selectedSessionId: 'chat-a', sessions: [sessionFor('chat-a')], connected: true,
        chatPanes: { primary: 'chat-a', secondary: null }, focusedChatPane: 'primary',
        snapshots: { 'chat-a': snapshot('chat-a', []) }
      })

      handlers.get('server:event')?.({
        profileId: null,
        profileGeneration: 0,
        event: eventFor('chat-a', 4, {
          type: 'cross_chat_handoff_queued', queued_id: delivery.queued_id,
          source_session_id: 'chat-b', target_session_id: 'chat-a'
        })
      })
      await vi.advanceTimersByTimeAsync(40)
      expect(list).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(150)

      expect(list).toHaveBeenCalledTimes(2)
      expect(list).toHaveBeenLastCalledWith('chat-a')
      expect(useAppStore.getState().snapshots['chat-a'].queuedTurns).toEqual([delivery])

      list.mockReset()
      list.mockRejectedValue(new Error('persistent queue read failure'))
      handlers.get('server:event')?.({
        profileId: null,
        profileGeneration: 0,
        event: eventFor('chat-a', 5, {
          type: 'cross_chat_handoff_queued', queued_id: 'queued-cross-chat-2',
          source_session_id: 'chat-b', target_session_id: 'chat-a'
        })
      })
      await vi.advanceTimersByTimeAsync(40 + 150 + 600)
      expect(list).toHaveBeenCalledTimes(3)
      expect(useAppStore.getState().syncBySession['chat-a']).toEqual(expect.objectContaining({
        status: 'live', error: expect.stringMatching(/incoming delivery queue could not be refreshed/i)
      }))

      list.mockReset()
      list.mockResolvedValue([delivery])
      await vi.advanceTimersByTimeAsync(1_000)
      handlers.get('server:sync')?.({
        profileId: null, profileGeneration: 0, sessionId: 'chat-a', state: 'live'
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(list).not.toHaveBeenCalled()
      expect(useAppStore.getState().syncBySession['chat-a']?.error).toMatch(/incoming delivery queue/i)

      await vi.advanceTimersByTimeAsync(4_000)
      handlers.get('server:sync')?.({
        profileId: null, profileGeneration: 0, sessionId: 'chat-a', state: 'live'
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(list).toHaveBeenCalledOnce()
      expect(useAppStore.getState().snapshots['chat-a'].queuedTurns).toEqual([delivery])
      expect(useAppStore.getState().syncBySession['chat-a']).toEqual({ status: 'live', error: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves reconnecting sync state when queue HTTP recovery succeeds before a live stream signal', async () => {
    vi.useFakeTimers()
    try {
      const handlers = new Map<string, (payload: any) => void>()
      const delivery: QueuedTurn = {
        queued_id: 'queued-reconnect-recovery', session_id: 'chat-a', prompt: 'Incoming delivery',
        file_ids: [], position: 1, purpose: 'cross_chat_handoff_delivery'
      }
      const list = vi.fn()
        .mockRejectedValueOnce(new Error('queue unavailable 1'))
        .mockRejectedValueOnce(new Error('queue unavailable 2'))
        .mockRejectedValueOnce(new Error('queue unavailable 3'))
        .mockResolvedValue([delivery])
      Object.defineProperty(window, 'agentsDock', {
        configurable: true,
        value: {
          bootstrap: vi.fn().mockResolvedValue({
            settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
            health: null, sessions: [], jobs: [], runtimeCatalog: null,
            folderOrder: [], collapsedFolders: [], archivedCollapsed: false, inspectorVisible: true
          }),
          native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
          queue: { list },
          events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
        } as unknown as AgentsDockAPI
      })
      useAppStore.setState({
        initialized: false, activeProfileId: null, profileGeneration: 0, switchingProfileId: null,
        selectedSessionId: null, sessions: [], snapshots: {}, syncBySession: {}
      })
      await useAppStore.getState().initialize()
      useAppStore.setState({
        selectedSessionId: 'chat-a', sessions: [sessionFor('chat-a')], connected: true,
        health: { ok: true, api_contract_version: 8, websocket_runtime: true },
        chatPanes: { primary: 'chat-a', secondary: null }, focusedChatPane: 'primary',
        syncSessionId: 'chat-a', syncStatus: 'reconnecting', syncError: null,
        syncBySession: { 'chat-a': { status: 'reconnecting', error: null } },
        snapshots: { 'chat-a': snapshot('chat-a', []) }
      })

      handlers.get('server:event')?.({
        profileId: null, profileGeneration: 0,
        event: eventFor('chat-a', 4, {
          type: 'cross_chat_handoff_queued', queued_id: delivery.queued_id,
          source_session_id: 'chat-b', target_session_id: 'chat-a'
        })
      })
      await vi.advanceTimersByTimeAsync(40 + 150 + 600)
      expect(list).toHaveBeenCalledTimes(3)
      expect(useAppStore.getState().syncBySession['chat-a']).toEqual(expect.objectContaining({
        status: 'reconnecting', error: expect.stringMatching(/incoming delivery queue/i)
      }))

      handlers.get('server:connection')?.({
        connected: false, profileId: null, profileGeneration: 0, error: 'Connection interrupted',
        health: { ok: true, api_contract_version: 8, websocket_runtime: true }
      })
      expect(useAppStore.getState().syncBySession['chat-a']?.status).toBe('offline')

      handlers.get('server:connection')?.({
        connected: true, profileId: null, profileGeneration: 0,
        health: { ok: true, api_contract_version: 8, websocket_runtime: true }
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(list).toHaveBeenCalledTimes(4)
      expect(useAppStore.getState().syncBySession['chat-a']).toEqual({ status: 'syncing', error: null })
      expect(useAppStore.getState()).toEqual(expect.objectContaining({
        syncStatus: 'syncing', syncError: null
      }))
      expect(useAppStore.getState().snapshots['chat-a'].queuedTurns).toEqual([delivery])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps missing WebSocket support authoritative over a pending queue warning and HTTP recovery', async () => {
    vi.useFakeTimers()
    try {
      const handlers = new Map<string, (payload: any) => void>()
      const delivery: QueuedTurn = {
        queued_id: 'queued-websocket-disabled', session_id: 'chat-a', prompt: 'Incoming delivery',
        file_ids: [], position: 1, purpose: 'cross_chat_handoff_delivery'
      }
      const list = vi.fn()
        .mockRejectedValueOnce(new Error('queue unavailable 1'))
        .mockRejectedValueOnce(new Error('queue unavailable 2'))
        .mockRejectedValueOnce(new Error('queue unavailable 3'))
        .mockResolvedValue([delivery])
      Object.defineProperty(window, 'agentsDock', {
        configurable: true,
        value: {
          bootstrap: vi.fn().mockResolvedValue({
            settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
            health: null, sessions: [], jobs: [], runtimeCatalog: null,
            folderOrder: [], collapsedFolders: [], archivedCollapsed: false, inspectorVisible: true
          }),
          native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
          queue: { list },
          events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
        } as unknown as AgentsDockAPI
      })
      useAppStore.setState({
        initialized: false, activeProfileId: null, profileGeneration: 0, switchingProfileId: null,
        selectedSessionId: null, sessions: [], snapshots: {}, syncBySession: {}
      })
      await useAppStore.getState().initialize()
      useAppStore.setState({
        selectedSessionId: 'chat-a', sessions: [sessionFor('chat-a')], connected: true,
        health: { ok: true, api_contract_version: 8, websocket_runtime: true },
        chatPanes: { primary: 'chat-a', secondary: null }, focusedChatPane: 'primary',
        syncSessionId: 'chat-a', syncStatus: 'live', syncError: null,
        syncBySession: { 'chat-a': { status: 'live', error: null } },
        snapshots: { 'chat-a': snapshot('chat-a', []) }
      })

      handlers.get('server:event')?.({
        profileId: null, profileGeneration: 0,
        event: eventFor('chat-a', 4, {
          type: 'cross_chat_handoff_queued', queued_id: delivery.queued_id,
          source_session_id: 'chat-b', target_session_id: 'chat-a'
        })
      })
      await vi.advanceTimersByTimeAsync(40 + 150 + 600)
      expect(useAppStore.getState().syncBySession['chat-a']?.error).toMatch(/incoming delivery queue/i)

      handlers.get('server:connection')?.({
        connected: false, profileId: null, profileGeneration: 0, error: 'Connection interrupted',
        health: { ok: true, api_contract_version: 8, websocket_runtime: true }
      })
      handlers.get('server:connection')?.({
        connected: true, profileId: null, profileGeneration: 0,
        health: { ok: true, api_contract_version: 8, websocket_runtime: false }
      })

      expect(useAppStore.getState().syncBySession['chat-a']).toEqual(expect.objectContaining({
        status: 'error', error: expect.stringMatching(/missing WebSocket support/i)
      }))
      expect(useAppStore.getState()).toEqual(expect.objectContaining({
        syncStatus: 'error', syncError: expect.stringMatching(/missing WebSocket support/i)
      }))

      await vi.advanceTimersByTimeAsync(0)
      expect(list).toHaveBeenCalledTimes(4)
      expect(useAppStore.getState().syncBySession['chat-a']).toEqual(expect.objectContaining({
        status: 'error', error: expect.stringMatching(/missing WebSocket support/i)
      }))

      handlers.get('server:sync')?.({
        profileId: null, profileGeneration: 0, sessionId: 'chat-a', state: 'live'
      })
      expect(useAppStore.getState().syncBySession['chat-a']).toEqual(expect.objectContaining({
        status: 'error', error: expect.stringMatching(/missing WebSocket support/i)
      }))
      expect(useAppStore.getState().syncStatus).toBe('error')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a stale cross-chat queue refresh after a newer live queue event arrives', async () => {
    vi.useFakeTimers()
    try {
      const handlers = new Map<string, (payload: any) => void>()
      let resolveList!: (turns: QueuedTurn[]) => void
      const list = vi.fn(() => new Promise<QueuedTurn[]>(resolve => { resolveList = resolve }))
      Object.defineProperty(window, 'agentsDock', {
        configurable: true,
        value: {
          bootstrap: vi.fn().mockResolvedValue({
            settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
            health: null, sessions: [], jobs: [], runtimeCatalog: null,
            folderOrder: [], collapsedFolders: [], archivedCollapsed: false,
            inspectorVisible: true
          }),
          native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
          queue: { list },
          events: {
            on: vi.fn((channel: string, handler: (payload: any) => void) => {
              handlers.set(channel, handler)
              return () => {}
            })
          }
        } as unknown as AgentsDockAPI
      })
      useAppStore.setState({
        initialized: false, activeProfileId: null, profileGeneration: 0,
        switchingProfileId: null, selectedSessionId: null, sessions: [], snapshots: {}
      })
      await useAppStore.getState().initialize()
      useAppStore.setState({
        selectedSessionId: 'chat-a', sessions: [sessionFor('chat-a')],
        snapshots: { 'chat-a': snapshot('chat-a', []) }
      })

      handlers.get('server:event')?.({
        profileId: null,
        profileGeneration: 0,
        event: eventFor('chat-a', 4, {
          type: 'cross_chat_handoff_queued', queued_id: 'queued-cross-chat',
          source_session_id: 'chat-b', target_session_id: 'chat-a'
        })
      })
      await vi.advanceTimersByTimeAsync(40)
      expect(list).toHaveBeenCalledWith('chat-a')

      handlers.get('server:event')?.({
        profileId: null,
        profileGeneration: 0,
        event: eventFor('chat-a', 5, {
          type: 'turn_queued', queued_id: 'queued-newer', prompt: 'Newer live queue state', position: 1
        })
      })
      resolveList([{
        queued_id: 'queued-stale', session_id: 'chat-a', prompt: 'Stale refresh', file_ids: [], position: 1
      }])
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(40)

      expect(useAppStore.getState().snapshots['chat-a'].queuedTurns).toMatchObject([{
        queued_id: 'queued-newer', prompt: 'Newer live queue state'
      }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('appends a synchronous send response without sliding the active history window', async () => {
    const send = vi.fn().mockResolvedValue({
      session: sessionFor('chat-a'),
      queued: false,
      event: eventFor('chat-a', 1_201)
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { turns: { send } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: null,
      profileGeneration: 0,
      switchingProfileId: null,
      selectedSessionId: 'chat-a',
      sessions: [sessionFor('chat-a')],
      snapshots: {
        'chat-a': snapshot(
          'chat-a',
          Array.from({ length: 1_200 }, (_, index) => eventFor('chat-a', index + 1))
        )
      },
      drafts: {},
      uploadsBySession: {},
      uploadPathsBySession: {}
    })

    await expect(useAppStore.getState().sendPrompt('Continue')).resolves.toBe(true)

    const events = useAppStore.getState().snapshots['chat-a'].events
    expect(events).toHaveLength(1_201)
    expect(events[0]?.seq).toBe(1)
    expect(events.at(-1)?.seq).toBe(1_201)
  })
})

describe('chat selection', () => {
  it('loads split panes independently when their requests resolve out of order', async () => {
    const cacheA = deferred<SessionSnapshot | null>()
    const cacheB = deferred<SessionSnapshot | null>()
    const cached = vi.fn((sessionId: string) => sessionId === 'chat-a' ? cacheA.promise : cacheB.promise)
    const subscribe = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { cached, subscribe, open: vi.fn(), unsubscribe: vi.fn().mockResolvedValue(undefined) } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      chatPanes: { primary: null, secondary: null }, focusedChatPane: 'primary', selectedSessionId: null,
      loadingSessionIds: new Set(), loadingSessionId: null,
      sessions: [sessionFor('chat-a'), sessionFor('chat-b')], snapshots: {}
    })

    const primary = useAppStore.getState().selectSessionInPane('chat-a', 'primary')
    const secondary = useAppStore.getState().selectSessionInPane('chat-b', 'secondary')
    cacheB.resolve(snapshot('chat-b', [eventFor('chat-b', 20)]))
    await secondary
    cacheA.resolve(snapshot('chat-a', [eventFor('chat-a', 10)]))
    await primary
    await settleMicrotasks()

    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: 'chat-b' })
    expect(useAppStore.getState().selectedSessionId).toBe('chat-b')
    expect(useAppStore.getState().snapshots['chat-a'].events[0].seq).toBe(10)
    expect(useAppStore.getState().snapshots['chat-b'].events[0].seq).toBe(20)
    expect(subscribe).toHaveBeenCalledWith('chat-a', 10)
    expect(subscribe).toHaveBeenCalledWith('chat-b', 20)
  })

  it('unsubscribes only the chat removed when replacing a split pane', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn().mockResolvedValue(undefined)
    const snapshots = {
      'chat-a': snapshot('chat-a', [eventFor('chat-a', 1)]),
      'chat-b': snapshot('chat-b', [eventFor('chat-b', 2)]),
      'chat-c': snapshot('chat-c', [eventFor('chat-c', 3)])
    }
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { unsubscribe, subscribe } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' }, focusedChatPane: 'secondary', selectedSessionId: 'chat-b',
      loadingSessionIds: new Set(), loadingSessionId: null,
      sessions: [sessionFor('chat-a'), sessionFor('chat-b'), sessionFor('chat-c')], snapshots
    })

    await useAppStore.getState().selectSessionInPane('chat-c', 'secondary')
    await settleMicrotasks()

    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: 'chat-c' })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledWith('chat-b')
    expect(unsubscribe).not.toHaveBeenCalledWith('chat-a')
    expect(subscribe).toHaveBeenCalledWith('chat-c', 3)
  })

  it('focuses already-live split chats without restarting either stream', async () => {
    const subscribe = vi.fn().mockResolvedValue(undefined)
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { subscribe, unsubscribe } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      chatPanes: { primary: null, secondary: null }, focusedChatPane: 'primary', selectedSessionId: null,
      loadingSessionIds: new Set(), loadingSessionId: null, syncBySession: {},
      sessions: [sessionFor('chat-a'), sessionFor('chat-b')],
      snapshots: {
        'chat-a': snapshot('chat-a', [eventFor('chat-a', 1)]),
        'chat-b': snapshot('chat-b', [eventFor('chat-b', 2)])
      }
    })
    await useAppStore.getState().selectSessionInPane('chat-a', 'primary')
    await useAppStore.getState().selectSessionInPane('chat-b', 'secondary')
    await settleMicrotasks()
    subscribe.mockClear()
    unsubscribe.mockClear()

    await useAppStore.getState().selectSession('chat-a')
    await useAppStore.getState().selectSession('chat-b')
    await settleMicrotasks()

    expect(subscribe).not.toHaveBeenCalled()
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: 'chat-b' })
    expect(useAppStore.getState().selectedSessionId).toBe('chat-b')
  })

  it('opens a chat in primary when no primary pane exists', async () => {
    const subscribe = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { subscribe } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      chatPanes: { primary: null, secondary: null }, focusedChatPane: 'primary', selectedSessionId: null,
      loadingSessionIds: new Set(), loadingSessionId: null,
      sessions: [sessionFor('chat-a')], snapshots: { 'chat-a': snapshot('chat-a', [eventFor('chat-a', 1)]) }
    })

    await useAppStore.getState().openSessionInSplit('chat-a')

    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: null })
    expect(useAppStore.getState().focusedChatPane).toBe('primary')
  })

  it('subscribes a prefetched fallback that becomes visible after deleting the sole pane', async () => {
    const fallbackId = 'prefetched-fallback-c'
    const subscribe = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        sessions: { remove: vi.fn().mockResolvedValue(undefined) },
        timeline: { subscribe, unsubscribe: vi.fn().mockResolvedValue(undefined) },
        preferences: { setScoped: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      profiles: [profileFor('local')],
      chatPanes: { primary: 'chat-a', secondary: null }, focusedChatPane: 'primary', selectedSessionId: 'chat-a',
      loadingSessionIds: new Set(), loadingSessionId: null, syncBySession: {},
      sessions: [sessionFor('chat-a'), sessionFor(fallbackId)],
      snapshots: {
        'chat-a': snapshot('chat-a', [eventFor('chat-a', 1)]),
        [fallbackId]: snapshot(fallbackId, [eventFor(fallbackId, 8)])
      }
    })

    await expect(useAppStore.getState().deleteSession('chat-a')).resolves.toBe(true)
    await settleMicrotasks()

    expect(useAppStore.getState().chatPanes).toEqual({ primary: fallbackId, secondary: null })
    expect(subscribe).toHaveBeenCalledWith(fallbackId, 8)
  })

  it('keeps only a bounded tail when a deeply paged chat moves to the background', async () => {
    const subscribe = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { subscribe } } as unknown as AgentsDockAPI
    })
    const deep = snapshot('chat-a', Array.from({ length: 2_000 }, (_, index) => eventFor('chat-a', index + 1)))
    const target = snapshot('chat-b', [eventFor('chat-b', 1)])
    useAppStore.setState({
      chatPanes: { primary: 'chat-a', secondary: null }, focusedChatPane: 'primary', selectedSessionId: 'chat-a',
      loadingSessionIds: new Set(), loadingSessionId: null,
      sessions: [sessionFor('chat-a'), sessionFor('chat-b')], snapshots: { 'chat-a': deep, 'chat-b': target }
    })

    await useAppStore.getState().selectSession('chat-b')
    await Promise.resolve()

    const background = useAppStore.getState().snapshots['chat-a']
    expect(background.events).toHaveLength(1_440)
    expect(background.events[0]?.seq).toBe(561)
    expect(background.events.at(-1)?.seq).toBe(2_000)
    expect(background.hasMoreEvents).toBe(true)
    expect(subscribe).toHaveBeenCalledWith('chat-b', 1)
  })

  it('does not copy a snapshot that already fits the background window', () => {
    const current = snapshot('chat-a', [eventFor('chat-a', 1)])
    expect(compactSnapshotEvents(current)).toBe(current)
  })

  it('replaces an oversized newest semantic unit with an authoritative-reload sentinel', () => {
    const older = Array.from({ length: 3 }, (_, index) => eventFor('chat-a', index + 1, {
      run_id: 'older-run'
    }))
    const newest = Array.from({ length: 8 }, (_, index) => eventFor('chat-a', index + 4, {
      run_id: 'newest-run'
    }))
    const current = {
      ...snapshot('chat-a', [...older, ...newest], true),
      nextTimelineBefore: 1,
      semanticPaging: true
    }

    const compacted = compactSnapshotEvents(current, 4)

    expect(compacted.events).toEqual([])
    expect(compacted.historyVerified).toBe(false)
    expect(compacted.eventsTotal).toBe(11)
    expect(compacted.nextTimelineBefore).toBeNull()
    expect(compacted.hasMoreEvents).toBe(true)
    expect(snapshotNeedsAuthoritativeTail(compacted)).toBe(true)
  })

  it('bypasses a false-empty memory cache and fetches an authoritative tail', async () => {
    const stale = falseEmptySnapshot('chat-a', 42)
    const fresh = { ...snapshot('chat-a', [eventFor('chat-a', 40)]), historyVerified: true }
    const open = vi.fn().mockResolvedValue(fresh)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { cached: vi.fn().mockResolvedValue(stale), open, subscribe: vi.fn() } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-b', loadingSessionId: null,
      sessions: [sessionFor('chat-a'), sessionFor('chat-b')], snapshots: { 'chat-a': stale }, error: null
    })

    await useAppStore.getState().selectSession('chat-a')

    expect(open).toHaveBeenCalledWith('chat-a', true)
    expect(useAppStore.getState().snapshots['chat-a'].events.map(item => item.seq)).toEqual([40])
    expect(useAppStore.getState().loadingSessionId).toBeNull()
  })

  it('bypasses a false-empty disk cache instead of painting conversation start', async () => {
    const stale = falseEmptySnapshot('chat-a', 42)
    const fresh = { ...snapshot('chat-a', [eventFor('chat-a', 41)]), historyVerified: true }
    const open = vi.fn().mockResolvedValue(fresh)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { cached: vi.fn().mockResolvedValue(stale), open, subscribe: vi.fn() } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ selectedSessionId: null, loadingSessionId: null, sessions: [sessionFor('chat-a')], snapshots: {}, error: null })

    await useAppStore.getState().selectSession('chat-a')

    expect(open).toHaveBeenCalledWith('chat-a', true)
    expect(useAppStore.getState().snapshots['chat-a'].events.map(item => item.seq)).toEqual([41])
  })

  it('accepts a server-verified empty chat without refetching it', async () => {
    const empty = { ...falseEmptySnapshot('chat-a', 42), historyVerified: true, eventsTotal: 0 }
    const subscribe = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { cached: vi.fn(), open, subscribe } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-b', loadingSessionId: null,
      sessions: [sessionFor('chat-a'), sessionFor('chat-b')], snapshots: { 'chat-a': empty }, error: null
    })

    await useAppStore.getState().selectSession('chat-a')
    await Promise.resolve()

    expect(open).not.toHaveBeenCalled()
    expect(subscribe).toHaveBeenCalledWith('chat-a', 0)
  })

  it('repairs a verified cache whose known event total contradicts its empty rows', async () => {
    const stale = { ...falseEmptySnapshot('chat-a', 42), historyVerified: true, eventsTotal: 42 }
    const fresh = { ...snapshot('chat-a', [eventFor('chat-a', 42)]), historyVerified: true, eventsTotal: 42 }
    const open = vi.fn().mockResolvedValue(fresh)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { cached: vi.fn().mockResolvedValue(stale), open, subscribe: vi.fn() } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-b', loadingSessionId: null,
      sessions: [sessionFor('chat-a'), sessionFor('chat-b')], snapshots: { 'chat-a': stale }, error: null
    })

    await useAppStore.getState().selectSession('chat-a')

    expect(open).toHaveBeenCalledWith('chat-a', true)
    expect(useAppStore.getState().snapshots['chat-a'].events.map(item => item.seq)).toEqual([42])
  })

  it('activates an in-memory chat without waiting for the stream subscription', async () => {
    const subscribe = vi.fn(() => new Promise<void>(() => undefined))
    const open = vi.fn()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { timeline: { subscribe, open } } as unknown as AgentsDockAPI })
    const cached = snapshot('chat-a', [eventFor('chat-a', 7)])
    useAppStore.setState({ selectedSessionId: 'chat-b', loadingSessionId: 'chat-a', sessions: [sessionFor('chat-a'), sessionFor('chat-b')], snapshots: { 'chat-a': cached } })
    await useAppStore.getState().selectSession('chat-a')
    await Promise.resolve()
    expect(subscribe).toHaveBeenCalledWith('chat-a', 7)
    expect(open).not.toHaveBeenCalled()
    expect(useAppStore.getState().snapshots['chat-a']).toBe(cached)
    expect(useAppStore.getState().loadingSessionId).toBeNull()
  })

  it('paints a disk-cached chat before starting a server subscription', async () => {
    const diskSnapshot = snapshot('chat-a', [eventFor('chat-a', 9)])
    const cached = vi.fn().mockResolvedValue(diskSnapshot)
    const subscribe = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { timeline: { cached, subscribe, open } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ selectedSessionId: null, loadingSessionId: null, sessions: [sessionFor('chat-a')], snapshots: {}, error: null })

    await useAppStore.getState().selectSession('chat-a')
    await Promise.resolve()

    expect(cached).toHaveBeenCalledWith('chat-a')
    expect(open).not.toHaveBeenCalled()
    expect(subscribe).toHaveBeenCalledWith('chat-a', 9)
    expect(useAppStore.getState().snapshots['chat-a'].events.map(item => item.seq)).toEqual([9])
    expect(useAppStore.getState().loadingSessionId).toBeNull()
  })

  it('keeps one slow cold open alive instead of multiplying full-history requests', async () => {
    vi.useFakeTimers()
    try {
      const slowOpen = deferred<SessionSnapshot>()
      const open = vi.fn(() => slowOpen.promise)
      Object.defineProperty(window, 'agentsDock', {
        configurable: true,
        value: { timeline: { cached: vi.fn().mockResolvedValue(null), open, subscribe: vi.fn() } } as unknown as AgentsDockAPI
      })
      useAppStore.setState({
        chatPanes: { primary: null, secondary: null }, focusedChatPane: 'primary', selectedSessionId: null,
        loadingSessionIds: new Set(), loadingSessionId: null, sessions: [sessionFor('chat-a')], snapshots: {}, error: null
      })

      const pending = useAppStore.getState().selectSession('chat-a')
      await vi.advanceTimersByTimeAsync(8_000)
      expect(open).toHaveBeenCalledTimes(1)
      expect(useAppStore.getState().loadingSessionId).toBe('chat-a')

      slowOpen.resolve(snapshot('chat-a', [eventFor('chat-a', 12)]))
      await pending

      expect(open).toHaveBeenCalledTimes(1)
      expect(useAppStore.getState().snapshots['chat-a'].events.map(item => item.seq)).toEqual([12])
      expect(useAppStore.getState().loadingSessionId).toBeNull()
      expect(useAppStore.getState().error).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an obsolete completion across an A to B to A switch', async () => {
    const resolvers: Array<(value: SessionSnapshot) => void> = []
    const open = vi.fn(() => new Promise<SessionSnapshot>(resolve => resolvers.push(resolve)))
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { timeline: { open, subscribe: vi.fn() } } as unknown as AgentsDockAPI })
    useAppStore.setState({ selectedSessionId: null, loadingSessionId: null, sessions: [sessionFor('a'), sessionFor('b')], snapshots: {} })
    const firstA = useAppStore.getState().selectSession('a')
    const b = useAppStore.getState().selectSession('b')
    const secondA = useAppStore.getState().selectSession('a')
    resolvers[2](snapshot('a', [eventFor('a', 30)]))
    await secondA
    resolvers[0](snapshot('a', [eventFor('a', 10)]))
    resolvers[1](snapshot('b', [eventFor('b', 20)]))
    await Promise.all([firstA, b])
    expect(useAppStore.getState().selectedSessionId).toBe('a')
    expect(useAppStore.getState().snapshots.a.events.map(item => item.seq)).toEqual([30])
    expect(useAppStore.getState().snapshots.b).toBeUndefined()
  })
})

describe('read state', () => {
  it.each(['history_imported', 'turn_finished'])('does not acknowledge a control-only %s companion as agent output', async type => {
    const session: Session = {
      ...sessionFor('chat-a'), latest_agent_event_seq: 10, last_read_agent_event_seq: 10
    }
    const markRead = vi.fn().mockResolvedValue(session)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true, value: { sessions: { markRead } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      sessions: [session],
      snapshots: {
        'chat-a': {
          ...snapshot('chat-a', [providerControlCompanion({
            type, session_id: 'chat-a', seq: 11, result_text: 'Imported bookkeeping', error: 'Historical bookkeeping'
          })]),
          session
        }
      }
    })

    await useAppStore.getState().markRead('chat-a')

    expect(markRead).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions[0]).toBe(session)
  })

  it('does not acknowledge imported interruption metadata as a new agent message', async () => {
    const session: Session = {
      ...sessionFor('chat-a'), latest_agent_event_seq: 10, last_read_agent_event_seq: 10
    }
    const markRead = vi.fn().mockResolvedValue(session)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true, value: { sessions: { markRead } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profileGeneration: 1, switchingProfileId: null,
      sessions: [session],
      snapshots: {
        'chat-a': {
          ...snapshot('chat-a', [providerInterruption({ session_id: 'chat-a', seq: 11, error: 'historical interruption' })]),
          session
        }
      }
    })

    await useAppStore.getState().markRead('chat-a')

    expect(markRead).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions[0]).toBe(session)
  })

  it('clears a manual unread marker when the open chat is read', async () => {
    const unread: Session = {
      ...sessionFor('chat-a'), latest_agent_event_seq: 12, last_read_agent_event_seq: 11, manual_unread: true
    }
    const updated: Session = { ...unread, last_read_agent_event_seq: 12, manual_unread: false }
    const markRead = vi.fn().mockResolvedValue(updated)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { markRead } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-a', sessions: [unread],
      snapshots: { 'chat-a': { ...snapshot('chat-a', [eventFor('chat-a', 12)]), session: unread } }
    })

    await useAppStore.getState().markRead('chat-a')

    expect(markRead).toHaveBeenCalledWith('chat-a', 12)
    expect(useAppStore.getState().sessions[0].manual_unread).toBe(false)
    expect(useAppStore.getState().snapshots['chat-a'].session.manual_unread).toBe(false)
  })

  it('does not let a concurrent markRead response revert a pending pin toggle', async () => {
    const session: Session = { ...sessionFor('chat-a'), pinned: false, latest_agent_event_seq: 12, last_read_agent_event_seq: 11 }
    let resolvePinUpdate!: (value: Session) => void
    const update = vi.fn().mockImplementation(() => new Promise<Session>(resolve => { resolvePinUpdate = resolve }))
    // Simulates the server's markRead response reflecting a snapshot taken just
    // before the pin PATCH committed server-side (still pinned: false).
    const staleAfterRead: Session = { ...session, pinned: false, last_read_agent_event_seq: 12 }
    const markRead = vi.fn().mockResolvedValue(staleAfterRead)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { update, markRead } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-a', sessions: [session],
      snapshots: { 'chat-a': { ...snapshot('chat-a', [eventFor('chat-a', 12)]), session } }
    })

    const pinCall = useAppStore.getState().updateSession('chat-a', { pinned: true })
    expect(useAppStore.getState().sessions[0].pinned).toBe(true)

    await useAppStore.getState().markRead('chat-a')
    expect(useAppStore.getState().sessions[0].pinned).toBe(true)
    expect(useAppStore.getState().snapshots['chat-a'].session.pinned).toBe(true)

    resolvePinUpdate({ ...staleAfterRead, pinned: true })
    await pinCall
    expect(useAppStore.getState().sessions[0].pinned).toBe(true)
  })

  it('forces an explicit read acknowledgement even when the session list is stale', async () => {
    const stale: Session = {
      ...sessionFor('chat-a'), latest_agent_event_seq: 10, last_read_agent_event_seq: 10
    }
    const updated: Session = {
      ...stale, latest_agent_event_seq: 14, last_read_agent_event_seq: 14, manual_unread: false
    }
    const markRead = vi.fn().mockResolvedValue(updated)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { markRead } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [stale],
      snapshots: {
        'chat-a': {
          ...snapshot('chat-a', [eventFor('chat-a', 14)]),
          session: stale
        }
      }
    })

    await useAppStore.getState().markRead('chat-a', true)

    expect(markRead).toHaveBeenCalledWith('chat-a', 14)
  })

  it('acknowledges a newer loaded live agent event than the polled session summary', async () => {
    const stale: Session = {
      ...sessionFor('chat-a'), latest_agent_event_seq: 10, last_read_agent_event_seq: 10
    }
    const updated: Session = {
      ...stale, latest_agent_event_seq: 15, last_read_agent_event_seq: 15
    }
    const markRead = vi.fn().mockResolvedValue(updated)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { markRead } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [stale],
      snapshots: {
        'chat-a': {
          ...snapshot('chat-a', [eventFor('chat-a', 15)]),
          session: stale
        }
      }
    })

    await useAppStore.getState().markRead('chat-a')

    expect(markRead).toHaveBeenCalledWith('chat-a', 15)
  })

  it('ignores an older read receipt that resolves after a newer acknowledgement', async () => {
    const first = deferred<Session>()
    const second = deferred<Session>()
    const markRead = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { markRead } } as unknown as AgentsDockAPI
    })
    const at100 = { ...sessionFor('chat-a'), latest_agent_event_seq: 100, last_read_agent_event_seq: 99 }
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 1, switchingProfileId: null,
      sessions: [at100], snapshots: {}
    })

    const older = useAppStore.getState().markRead('chat-a', true)
    await vi.waitFor(() => expect(markRead).toHaveBeenCalledTimes(1))
    useAppStore.setState({ sessions: [{ ...at100, latest_agent_event_seq: 105 }] })
    const newer = useAppStore.getState().markRead('chat-a', true)
    first.resolve({ ...at100, last_read_agent_event_seq: 100 })
    await older
    await vi.waitFor(() => expect(markRead).toHaveBeenCalledTimes(2))
    second.resolve({ ...at100, latest_agent_event_seq: 105, last_read_agent_event_seq: 105 })
    await newer

    expect(useAppStore.getState().sessions[0].last_read_agent_event_seq).toBe(105)
  })

  it('uses one mutation lease across read and explicit unread receipts', async () => {
    const read = deferred<Session>()
    const unread = deferred<Session>()
    const initial = { ...sessionFor('chat-a'), latest_agent_event_seq: 12, last_read_agent_event_seq: 11 }
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        sessions: {
          markRead: vi.fn(() => read.promise),
          markUnread: vi.fn(() => unread.promise)
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 1, switchingProfileId: null,
      sessions: [initial], snapshots: {}
    })

    const olderRead = useAppStore.getState().markRead('chat-a', true)
    await vi.waitFor(() => expect(window.agentsDock.sessions.markRead).toHaveBeenCalledOnce())
    const newerUnread = useAppStore.getState().markUnread('chat-a')
    read.resolve({ ...initial, last_read_agent_event_seq: 12, manual_unread: false })
    await olderRead
    await vi.waitFor(() => expect(window.agentsDock.sessions.markUnread).toHaveBeenCalledOnce())
    unread.resolve({ ...initial, manual_unread: true })
    await newerUnread

    expect(useAppStore.getState().sessions[0].manual_unread).toBe(true)
  })

  it('applies only read-owned fields when a live session update arrives before the receipt', async () => {
    const receipt = deferred<Session>()
    const initial = { ...sessionFor('chat-a'), title: 'Before', latest_event_seq: 12, last_read_agent_event_seq: 11 }
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { markRead: vi.fn(() => receipt.promise) } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 1, switchingProfileId: null,
      sessions: [initial],
      snapshots: { 'chat-a': { ...snapshot('chat-a', []), session: initial } }
    })

    const pending = useAppStore.getState().markRead('chat-a', true)
    const live = { ...initial, title: 'Live title', latest_event_seq: 18, latest_agent_event_seq: 18 }
    useAppStore.setState({
      sessions: [live],
      snapshots: { 'chat-a': { ...snapshot('chat-a', []), session: live } }
    })
    receipt.resolve({ ...initial, title: 'Stale title', last_read_agent_event_seq: 12, manual_unread: false })
    await pending

    expect(useAppStore.getState().sessions[0]).toMatchObject({
      title: 'Live title', latest_event_seq: 18, latest_agent_event_seq: 18,
      last_read_agent_event_seq: 12, manual_unread: false
    })
    expect(useAppStore.getState().snapshots['chat-a'].session.title).toBe('Live title')
  })
})

describe('event merging', () => {
  it.each(['history_imported', 'turn_finished'])('retains an exact %s companion repair over stale duplicates in either direction', type => {
    const corrected = providerControlCompanion({ type })
    const stale = { ...corrected, imported: type === 'history_imported' ? undefined : true, metadata_only: undefined }
    expect(mergeEvents([stale], [corrected])).toEqual([corrected])
    const repaired = [corrected]
    expect(mergeEvents(repaired, [stale])).toBe(repaired)
    expect(mergeEvents([stale], [corrected, { ...stale, result_text: 'Stale import bookkeeping' }])).toEqual(repaired)
  })

  it('preserves proven interruption repairs in both history merge directions', () => {
    const corrected = providerInterruption({ id: 'stable-imported-event' })
    const legacy = { ...corrected, type: 'turn_started', provider_origin: undefined, prompt: '[Request interrupted by user]' }
    expect(mergeEvents([legacy], [corrected])).toEqual([corrected])
    const repaired = [corrected]
    expect(mergeEvents(repaired, [legacy])).toBe(repaired)
  })

  it('preserves a proven correction before a differing legacy duplicate in one incoming batch', () => {
    const corrected = providerInterruption({ id: 'stable-imported-event' })
    const legacy = { ...corrected, type: 'turn_started', provider_origin: undefined, prompt: '[Request interrupted by user]' }
    const staleDuplicate = { ...legacy, run_id: 'legacy-imported-run' }

    expect(mergeEvents([legacy], [corrected, staleDuplicate])).toEqual([corrected])

    const repaired = [corrected]
    expect(mergeEvents(repaired, [{ ...corrected }, legacy, staleDuplicate])).toBe(repaired)
  })

  it('retains normal merge precedence for malformed repairs and native lookalikes', () => {
    const malformed = providerInterruption({ provider_origin: null })
    const legacy = { ...malformed, type: 'turn_started', provider_origin: undefined }
    expect(mergeEvents([malformed], [legacy])).toEqual([legacy])
    const native = { ...legacy, imported: false, prompt: '[Request interrupted by user]' }
    const corrected = providerInterruption()
    expect(mergeEvents([corrected], [native])).toEqual([native])
    const otherChat = { ...legacy, session_id: 'chat-2' }
    expect(mergeEvents([corrected], [otherChat])).toEqual([otherChat])
  })

  it('bounds deferred live events while remembering that an authoritative repair is still required', () => {
    const events = Array.from({ length: 2_500 }, (_, index) => eventFor('chat-a', index + 1))

    const bounded = boundedDeferredTimelineEvents([], events)

    expect(bounded.events).toHaveLength(2_400)
    expect(bounded.events[0].seq).toBe(101)
    expect(bounded.events.at(-1)?.seq).toBe(2_500)
    expect(bounded.overflowed).toBe(true)
  })

  it('retains the existing array and objects for equivalent server events', () => {
    const existing = [eventFor('chat-a', 1), eventFor('chat-a', 2)]
    const merged = mergeEvents(existing, existing.map(item => ({ ...item })))
    expect(merged).toBe(existing)
    expect(merged[0]).toBe(existing[0])
  })

  it('uses append and prepend fast paths while preserving order', () => {
    const middle = [eventFor('chat-a', 10)]
    expect(mergeEvents(middle, [eventFor('chat-a', 11)]).map(item => item.seq)).toEqual([10, 11])
    expect(mergeEvents(middle, [eventFor('chat-a', 9)]).map(item => item.seq)).toEqual([9, 10])
  })

  it('does not rescan accumulated event ids on each live append', () => {
    let historicalIdReads = 0
    const history = Array.from({ length: 512 }, (_, index) => {
      const value = eventFor('chat-a', index + 1)
      const id = value.id
      Object.defineProperty(value, 'id', {
        configurable: true,
        enumerable: true,
        get: () => {
          historicalIdReads += 1
          return id
        }
      })
      return value
    })

    const firstAppend = mergeEvents(history, [eventFor('chat-a', 513)])
    expect(historicalIdReads).toBe(512)
    historicalIdReads = 0

    const secondAppend = mergeEvents(firstAppend, [eventFor('chat-a', 514)])

    expect(secondAppend).toHaveLength(514)
    expect(historicalIdReads).toBe(0)
  })

  it('replaces and moves one stable synthetic event instead of appending a duplicate', () => {
    const previous = eventFor('chat-a', 10, { id: 'stable-subagent', type: 'subagent_state', text: 'old' })
    const replacement = eventFor('chat-a', 20, { id: 'stable-subagent', type: 'subagent_state', text: 'new' })

    const merged = mergeEvents([previous], [replacement])

    expect(merged).toEqual([replacement])
  })

  it('advances the projection generation only for a boundary-preserving prefix correction', () => {
    const first = eventFor('chat-a', 1)
    const middle = eventFor('chat-a', 2)
    const last = eventFor('chat-a', 3)
    const previous = {
      ...snapshot('chat-a', [first, middle, last]),
      generation: 7,
      timelineListGeneration: 3
    }

    const appended = mergeSnapshots(previous, snapshot('chat-a', [eventFor('chat-a', 4)]))
    expect(appended.generation).toBe(7)
    expect(appended.timelineListGeneration).toBe(3)

    const prepended = mergeSnapshots(previous, snapshot('chat-a', [eventFor('chat-a', 0)]))
    expect(prepended.generation).toBe(7)

    const correctedMiddle = { ...middle, text: 'corrected' }
    const corrected = mergeSnapshots(previous, snapshot('chat-a', [first, correctedMiddle, last]))
    expect(corrected.generation).toBe(8)
    expect(corrected.timelineListGeneration).toBe(3)

    const correctedAndAppended = mergeSnapshots(previous, snapshot('chat-a', [
      first,
      correctedMiddle,
      last,
      eventFor('chat-a', 4),
    ]))
    expect(correctedAndAppended.generation).toBe(8)
  })

  it('keeps a compacted renderer cursor ahead of a stale main-process merge cursor', () => {
    const previous = {
      ...snapshot('chat-a', [eventFor('chat-a', 100), eventFor('chat-a', 110)], true),
      nextTimelineBefore: 100,
      historyVerified: true
    }
    const delta = {
      ...snapshot('chat-a', [eventFor('chat-a', 120)], true),
      nextTimelineBefore: 20,
      historyVerified: true
    }

    expect(mergeSnapshots(previous, delta).nextTimelineBefore).toBe(100)
  })

  it('does not advance a retained history boundary from an unrelated newer delta cursor', () => {
    const previous = {
      ...snapshot('chat-a', [eventFor('chat-a', 100), eventFor('chat-a', 110)], true),
      nextTimelineBefore: 100,
      historyVerified: true
    }
    const delta = {
      ...snapshot('chat-a', [eventFor('chat-a', 600)], true),
      nextTimelineBefore: 500,
      historyVerified: true
    }

    expect(mergeSnapshots(previous, delta).nextTimelineBefore).toBe(100)
  })

  it('allows the cursor to advance older when the incoming page retains older history', () => {
    const previous = {
      ...snapshot('chat-a', [eventFor('chat-a', 100)], true),
      nextTimelineBefore: 100,
      historyVerified: true
    }
    const older = {
      ...snapshot('chat-a', [eventFor('chat-a', 50)], true),
      nextTimelineBefore: 50,
      historyVerified: true
    }

    expect(mergeSnapshots(previous, older).nextTimelineBefore).toBe(50)
  })

  it('retains paged history before a proven-overlapping authoritative replacement tail', () => {
    const overlap = eventFor('chat-a', 100)
    const previous = {
      ...snapshot('chat-a', [eventFor('chat-a', 1), eventFor('chat-a', 50), overlap], true),
      nextTimelineBefore: 1,
      eventsTotal: 150,
      generation: 4,
      timelineListGeneration: 6
    }
    const replacement = {
      ...snapshot('chat-a', [{ ...overlap }, eventFor('chat-a', 150)], true),
      nextTimelineBefore: 100,
      eventsTotal: 150,
      historyVerified: true
    }

    const replaced = replaceSnapshot(previous, replacement)

    expect(replaced.events.map(item => item.seq)).toEqual([1, 50, 100, 150])
    expect(replaced.nextTimelineBefore).toBe(1)
    expect(replaced.generation).toBe(5)
    expect(replaced.timelineListGeneration).toBe(6)
  })

  it('preserves a proven complete older edge when an overlapping tail reports more history', () => {
    const overlap = eventFor('chat-a', 100)
    const previous = {
      ...snapshot('chat-a', [eventFor('chat-a', 1), overlap], false),
      hasMoreEvents: false,
      nextTimelineBefore: null,
      historyVerified: true
    }
    const replacement = {
      ...snapshot('chat-a', [{ ...overlap }, eventFor('chat-a', 150)], true),
      hasMoreEvents: true,
      nextTimelineBefore: 100,
      historyVerified: true
    }

    const replaced = replaceSnapshot(previous, replacement)

    expect(replaced.events.map(item => item.seq)).toEqual([1, 100, 150])
    expect(replaced.hasMoreEvents).toBe(false)
    expect(replaced.nextTimelineBefore).toBeNull()
  })

  it('refuses a disjoint replacement without fabricating adjacency or silently dropping loaded history', () => {
    const previous = {
      ...snapshot('chat-a', [eventFor('chat-a', 1), eventFor('chat-a', 50)], true),
      nextTimelineBefore: 1,
      generation: 4,
      timelineListGeneration: 2
    }
    const replacement = {
      ...snapshot('chat-a', [eventFor('chat-a', 500), eventFor('chat-a', 550)], true),
      nextTimelineBefore: 500,
      historyVerified: true
    }

    expect(timelineReplacementIsDiscontinuous(previous, replacement)).toBe(true)
    const refused = replaceSnapshot(previous, replacement)
    expect(refused.events).toBe(previous.events)
    expect(refused.events.map(item => item.seq)).toEqual([1, 50])
    expect(refused.historyDiscontinuity).toBe(true)
    expect(refused.generation).toBe(4)
    expect(refused.timelineListGeneration).toBe(2)

    const authoritative = replaceSnapshot(refused, replacement, true)
    expect(authoritative.events.map(item => item.seq)).toEqual([500, 550])
    expect(authoritative.historyDiscontinuity).toBe(false)
    expect(authoritative.generation).toBe(5)
    expect(authoritative.timelineListGeneration).toBe(3)
  })

  it('does not let an unrelated merge clear a pending history discontinuity', () => {
    const previous = {
      ...snapshot('chat-a', [eventFor('chat-a', 1), eventFor('chat-a', 50)], true),
      nextTimelineBefore: 1,
      historyDiscontinuity: true
    }
    const unrelated = {
      ...snapshot('chat-a', [eventFor('chat-a', 600)], true),
      nextTimelineBefore: 500,
      historyVerified: true
    }

    const merged = mergeSnapshots(previous, unrelated)

    expect(merged.events).toBe(previous.events)
    expect(merged.nextTimelineBefore).toBe(1)
    expect(merged.historyDiscontinuity).toBe(true)
  })

  it('keeps the proven window and repairs after repeated failures without a reconnect or reselect', async () => {
    const handlers = new Map<string, (payload: any) => void>()
    const previous = {
      ...snapshot('chat-a', [eventFor('chat-a', 1), eventFor('chat-a', 50)], true),
      nextTimelineBefore: 1,
      generation: 4
    }
    const replacement = {
      ...snapshot('chat-a', [eventFor('chat-a', 500), eventFor('chat-a', 550)], true),
      nextTimelineBefore: 500,
      historyVerified: true
    }
    const open = vi.fn()
      .mockRejectedValueOnce(new Error('temporary authoritative refetch failure'))
      .mockRejectedValueOnce(new Error('temporary authoritative refetch failure'))
      .mockRejectedValueOnce(new Error('temporary authoritative refetch failure'))
      .mockRejectedValueOnce(new Error('temporary authoritative refetch failure'))
      .mockRejectedValueOnce(new Error('temporary authoritative refetch failure'))
      .mockResolvedValueOnce(replacement)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue({
          settings: { serverUrl: 'http://local.test', hasAccessToken: false, serverSetupComplete: true },
          health: { ok: true }, sessions: [], jobs: [], runtimeCatalog: null,
          selectedSessionId: null, folderOrder: [], collapsedFolders: [], archivedCollapsed: false,
          inspectorVisible: true, activeProfileId: 'local', profiles: [profileFor('local')], profileGeneration: 1
        }),
        timeline: {
          cached: vi.fn().mockResolvedValue(replacement),
          open,
          subscribe: vi.fn().mockResolvedValue(undefined),
          unsubscribe: vi.fn().mockResolvedValue(undefined)
        },
        preferences: {
          getScoped: vi.fn().mockResolvedValue(null), get: vi.fn().mockResolvedValue(null),
          setScoped: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined)
        },
        servers: { refresh: vi.fn() },
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: {
          on: vi.fn((channel: string, handler: (payload: any) => void) => {
            handlers.set(channel, handler)
            return () => undefined
          })
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false, activeProfileId: null, profileGeneration: 0, switchingProfileId: null,
      chatPanes: { primary: null, secondary: null }, focusedChatPane: 'primary', selectedSessionId: null,
      sessions: [], snapshots: {}, loadingSessionIds: new Set(), loadingSessionId: null
    })
    await useAppStore.getState().initialize()
    useAppStore.setState({
      sessions: [sessionFor('chat-primary'), sessionFor('chat-a')],
      selectedSessionId: 'chat-primary',
      focusedChatPane: 'primary',
      chatPanes: { primary: 'chat-primary', secondary: 'chat-a' },
      snapshots: { 'chat-a': previous }
    })
    vi.useFakeTimers()
    try {

      handlers.get('server:timeline')?.({
        profileId: 'local', profileGeneration: 1, sessionId: 'chat-a',
        snapshot: replacement, source: 'server', mode: 'replace'
      })

      expect(useAppStore.getState().snapshots['chat-a'].events).toBe(previous.events)
      expect(useAppStore.getState().snapshots['chat-a'].historyDiscontinuity).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(open).toHaveBeenCalledTimes(1)
      handlers.get('server:event')?.({
        profileId: 'local', profileGeneration: 1,
        event: eventFor('chat-a', 551)
      })
      await vi.advanceTimersByTimeAsync(40)
      expect(useAppStore.getState().snapshots['chat-a'].events).toBe(previous.events)
      await vi.advanceTimersByTimeAsync(8_000)
      expect(open).toHaveBeenCalledTimes(6)
      expect(open).toHaveBeenLastCalledWith('chat-a', true)
      expect(useAppStore.getState().snapshots['chat-a'].events.map(item => item.seq)).toEqual([500, 550, 551])
      expect(useAppStore.getState().snapshots['chat-a'].historyDiscontinuity).toBe(false)
      expect(useAppStore.getState().focusedChatPane).toBe('primary')
      expect(useAppStore.getState().selectedSessionId).toBe('chat-primary')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('timeline memory cache', () => {
  it('does not invalidate a timeline for an equivalent background session refresh', () => {
    const existing = snapshot('selected', [eventFor('selected', 1)])
    const current = { selected: existing }

    const refreshed = syncSnapshotSessions(current, [{ ...existing.session }])

    expect(refreshed).toBe(current)
    expect(refreshed.selected).toBe(existing)
  })

  it('updates cached timeline metadata when the session actually changes', () => {
    const existing = snapshot('selected', [eventFor('selected', 1)])

    const refreshed = syncSnapshotSessions({ selected: existing }, [{
      ...existing.session,
      title: 'Renamed chat'
    }])

    expect(refreshed.selected).not.toBe(existing)
    expect(refreshed.selected.session.title).toBe('Renamed chat')
  })

  it('keeps the selected chat while evicting least-recently-used prefetched chats', () => {
    let snapshots: Record<string, SessionSnapshot> = {}
    snapshots = cacheSnapshot(snapshots, 'selected', snapshot('selected', []), 'selected')
    for (let index = 0; index < 24; index += 1) {
      const id = `hover-${index}`
      snapshots = cacheSnapshot(snapshots, id, snapshot(id, []), 'selected')
    }
    expect(Object.keys(snapshots).length).toBeLessThanOrEqual(14)
    expect(snapshots.selected).toBeDefined()
    expect(snapshots['hover-23']).toBeDefined()
    expect(snapshots['hover-0']).toBeUndefined()
  })

  it('keeps both visible chats resident and untrimmed', () => {
    const primary = snapshot('primary', Array.from({ length: 1_600 }, (_, index) => eventFor('primary', index + 1)))
    const secondary = snapshot('secondary', Array.from({ length: 1_700 }, (_, index) => eventFor('secondary', index + 1)))
    let snapshots: Record<string, SessionSnapshot> = {}
    snapshots = cacheSnapshot(snapshots, 'primary', primary, ['primary', 'secondary'])
    snapshots = cacheSnapshot(snapshots, 'secondary', secondary, ['primary', 'secondary'])
    for (let index = 0; index < 20; index += 1) {
      snapshots = cacheSnapshot(snapshots, `hover-${index}`, snapshot(`hover-${index}`, []), ['primary', 'secondary'])
    }
    expect(snapshots.primary.events).toHaveLength(1_600)
    expect(snapshots.secondary.events).toHaveLength(1_700)
  })
})

describe('untouched startup chat cleanup', () => {
  const profile: PublicServerProfile = {
    ...profileFor('cleanup-profile'),
    serverIdentity: 'cleanup-server'
  }

  beforeEach(() => {
    useAppStore.setState({
      initialized: false,
      profiles: [],
      activeProfileId: null,
      profileGeneration: 0,
      switchingProfileId: null,
      sessions: [],
      jobs: [],
      selectedSessionId: null,
      chatPanes: { primary: null, secondary: null },
      focusedChatPane: 'primary',
      snapshots: {},
      loadingSessionIds: new Set(),
      syncBySession: {},
      error: null
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it('removes only a marked, fully untouched direct-create placeholder', async () => {
    const placeholder = untouchedStartupChat('untouched')
    const harness = installStartupCleanupHarness(profile, [placeholder])

    await useAppStore.getState().initialize()
    await settleMicrotasks()

    expect(harness.remove).toHaveBeenCalledOnce()
    expect(harness.remove).toHaveBeenCalledWith(placeholder.id)
    expect(harness.setScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: profile.id,
        profileGeneration: 7,
        serverIdentity: profile.serverIdentity
      }),
      `directChatPlaceholder:v1:${placeholder.id}`,
      false
    )
    expect(useAppStore.getState().sessions).toEqual([])
  })

  it('preserves placeholders that have meaningful local or remote state', async () => {
    const sessions = [
      untouchedStartupChat('drafted'),
      untouchedStartupChat('referenced'),
      untouchedStartupChat('history'),
      untouchedStartupChat('queued'),
      untouchedStartupChat('filed'),
      untouchedStartupChat('terminal')
    ]
    const harness = installStartupCleanupHarness(profile, sessions, {
      preferenceValue(key, fallback) {
        if (key === 'draft:drafted') return 'Unsent work'
        if (key === 'draft-chat-references:referenced') return [{ sessionId: 'another-chat' }]
        return fallback
      },
      timelineIndex(sessionId) {
        return Promise.resolve({
          session_id: sessionId,
          landmarks: [],
          latest_seq: sessionId === 'history' ? 2 : 1,
          event_count: sessionId === 'history' ? 2 : 1
        })
      },
      queuedTurns(sessionId) {
        return Promise.resolve(sessionId === 'queued'
          ? [{ queued_id: 'queued-turn', session_id: sessionId, prompt: 'Keep this', file_ids: [], position: 1 }]
          : [])
      },
      fileTotal: sessionId => sessionId === 'filed' ? 1 : 0,
      terminalExists: sessionId => sessionId === 'terminal'
    })

    await useAppStore.getState().initialize()
    await settleMicrotasks()

    expect(harness.remove).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(sessions.map(session => session.id))
  })

  it('preserves a stale marker and a chat that changes during the authoritative re-read', async () => {
    const staleBootstrap = untouchedStartupChat('stale-marker')
    const staleLive = { ...staleBootstrap, cwd: '/work/moved' }
    const staleHarness = installStartupCleanupHarness(profile, [staleBootstrap], {
      sessionsList: () => Promise.resolve([staleLive])
    })

    await useAppStore.getState().initialize()
    await settleMicrotasks()

    expect(staleHarness.remove).not.toHaveBeenCalled()

    useAppStore.setState({
      initialized: false,
      profiles: [],
      activeProfileId: null,
      profileGeneration: 0,
      sessions: [],
      selectedSessionId: null,
      chatPanes: { primary: null, secondary: null },
      snapshots: {}
    })
    const rereadBootstrap = untouchedStartupChat('changed-on-reread')
    let listCount = 0
    const rereadHarness = installStartupCleanupHarness(profile, [rereadBootstrap], {
      sessionsList: () => Promise.resolve(listCount++ === 0
        ? [rereadBootstrap]
        : [{ ...rereadBootstrap, backend_locked: true, session_id: 'provider-session' }])
    })

    await useAppStore.getState().initialize()
    await settleMicrotasks()

    expect(rereadHarness.sessionsList).toHaveBeenCalledTimes(2)
    expect(rereadHarness.remove).not.toHaveBeenCalled()
  })

  it('does not delete when the renderer profile scope changes during cleanup', async () => {
    const placeholder = untouchedStartupChat('profile-transition')
    const indexResult = deferred<{
      session_id: string
      landmarks: []
      latest_seq: number
      event_count: number
    }>()
    const harness = installStartupCleanupHarness(profile, [placeholder], {
      timelineIndex: () => indexResult.promise
    })
    useAppStore.setState({
      initialized: false,
      profiles: [profile],
      activeProfileId: profile.id,
      profileGeneration: 7,
      switchingProfileId: null,
      sessions: [],
      selectedSessionId: null,
      chatPanes: { primary: null, secondary: null },
      snapshots: {}
    })

    const initialize = useAppStore.getState().initialize()
    await vi.waitFor(() => expect(harness.timelineIndex).toHaveBeenCalledWith(placeholder.id))
    useAppStore.setState({
      profiles: [{ ...profile, id: 'other-profile', serverIdentity: 'other-server' }],
      activeProfileId: 'other-profile',
      profileGeneration: 8
    })
    indexResult.resolve({
      session_id: placeholder.id,
      landmarks: [],
      latest_seq: 1,
      event_count: 1
    })
    await initialize

    expect(harness.remove).not.toHaveBeenCalled()
  })

  it('fails safe when cleanup evidence cannot be loaded', async () => {
    const placeholder = untouchedStartupChat('cleanup-error')
    const harness = installStartupCleanupHarness(profile, [placeholder], {
      sessionsList: () => Promise.reject(new Error('sessions unavailable'))
    })

    await useAppStore.getState().initialize()
    await settleMicrotasks()

    expect(harness.remove).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions).toEqual([placeholder])
    expect(harness.log).toHaveBeenCalledWith(
      'bootstrap',
      'untouched new chat cleanup unavailable',
      expect.objectContaining({ error: 'sessions unavailable' })
    )
  })
})

describe('bootstrap', () => {
  it('preserves a matching live connection published while cached bootstrap is pending', async () => {
    const profile = profileFor('profile-live')
    const pendingBootstrap = deferred<ProfileBootstrapPayload>()
    const handlers = new Map<string, (payload: any) => void>()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn(() => pendingBootstrap.promise),
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: {
          on: vi.fn((channel: string, handler: (payload: any) => void) => {
            handlers.set(channel, handler)
            return () => undefined
          })
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false, profiles: [], activeProfileId: null, profileGeneration: 0,
      switchingProfileId: null, connected: false, health: null, activeSessionIds: new Set(),
      sessions: [], selectedSessionId: null, chatPanes: { primary: null, secondary: null },
      focusedChatPane: 'primary', snapshots: {}, syncBySession: {}
    })

    const initializing = useAppStore.getState().initialize()
    const health: Health = {
      ok: true,
      api_contract_version: 8,
      websocket_runtime: true,
      server_identity: 'server-live',
      server_instance_id: 'instance-live',
      active: ['chat-running']
    }
    handlers.get('server:connection')?.({
      connected: true,
      connectionState: 'online',
      profileId: profile.id,
      profileGeneration: 7,
      health
    })
    // A later heartbeat without a Health body retains the authenticated
    // snapshot just as the normal connection reducer does.
    handlers.get('server:connection')?.({
      connected: true,
      connectionState: 'online',
      profileId: profile.id,
      profileGeneration: 7
    })
    // A different profile's concurrent event must not cross the bootstrap
    // scope boundary even if it arrives later.
    handlers.get('server:connection')?.({
      connected: true,
      connectionState: 'online',
      profileId: 'profile-other',
      profileGeneration: 9,
      health: { ...health, active: ['wrong-chat'] }
    })
    pendingBootstrap.resolve(profileBootstrap(profile, [profile], 7))

    await initializing

    expect(useAppStore.getState()).toMatchObject({
      initialized: true,
      activeProfileId: profile.id,
      profileGeneration: 7,
      connected: true,
      health
    })
    expect([...useAppStore.getState().activeSessionIds]).toEqual(['chat-running'])
  })

  it('restores and hydrates both persisted split chats without changing focus', async () => {
    const chatA = sessionFor('chat-a')
    const chatB = sessionFor('chat-b')
    const cached = vi.fn(async (sessionId: string) => snapshot(sessionId, [eventFor(sessionId, sessionId === 'chat-a' ? 10 : 20)]))
    const subscribe = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue({
          settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
          health: { ok: true }, sessions: [chatA, chatB], jobs: [], runtimeCatalog: null,
          selectedSessionId: chatB.id, folderOrder: [], collapsedFolders: [], archivedCollapsed: false,
          inspectorVisible: true, activeProfileId: 'local', profiles: [profileFor('local')], profileGeneration: 1
        }),
        timeline: { cached, subscribe, open: vi.fn(), unsubscribe: vi.fn().mockResolvedValue(undefined) },
        preferences: {
          getScoped: vi.fn().mockResolvedValue({ primary: chatA.id, secondary: chatB.id, focusedPane: 'secondary' }),
          get: vi.fn().mockResolvedValue(null), setScoped: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined)
        },
        servers: { refresh: vi.fn().mockResolvedValue({
          ...profileBootstrap(profileFor('local'), [profileFor('local')], 1, chatA),
          sessions: [chatA, chatB],
          selectedSessionId: chatB.id
        }) },
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn().mockReturnValue(() => {}) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false, profiles: [], activeProfileId: null, profileGeneration: 0,
      sessions: [], chatPanes: { primary: null, secondary: null }, focusedChatPane: 'primary', selectedSessionId: null,
      snapshots: {}, loadingSessionIds: new Set(), syncBySession: {}
    })

    await useAppStore.getState().initialize()
    await settleMicrotasks()

    expect(useAppStore.getState().chatPanes).toEqual({ primary: chatA.id, secondary: chatB.id })
    expect(useAppStore.getState().focusedChatPane).toBe('secondary')
    expect(useAppStore.getState().selectedSessionId).toBe(chatB.id)
    expect(useAppStore.getState().snapshots[chatA.id]).toBeDefined()
    expect(useAppStore.getState().snapshots[chatB.id]).toBeDefined()
    expect(subscribe).toHaveBeenCalledWith(chatA.id, 10)
    expect(subscribe).toHaveBeenCalledWith(chatB.id, 20)
  })

  it('restores an explicitly visible archived chat instead of replacing it with the active fallback', async () => {
    const archived = { ...sessionFor('archived-chat'), archived: true }
    const active = sessionFor('active-chat')
    const subscribe = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue({
          settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
          health: null, sessions: [archived, active], jobs: [], runtimeCatalog: null,
          selectedSessionId: active.id, folderOrder: [], collapsedFolders: [], archivedCollapsed: false,
          inspectorVisible: true, activeProfileId: 'local', profiles: [profileFor('local')], profileGeneration: 1
        }),
        timeline: {
          cached: vi.fn(async (sessionId: string) => snapshot(sessionId, [eventFor(sessionId, 4)])),
          subscribe, open: vi.fn(), unsubscribe: vi.fn().mockResolvedValue(undefined)
        },
        preferences: {
          getScoped: vi.fn().mockResolvedValue({ primary: archived.id, secondary: null, focusedPane: 'primary' }),
          get: vi.fn().mockResolvedValue(null), setScoped: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined)
        },
        servers: { refresh: vi.fn().mockResolvedValue({
          ...profileBootstrap(profileFor('local'), [profileFor('local')], 1, active), sessions: [archived, active]
        }) },
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn().mockReturnValue(() => {}) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false, profiles: [], activeProfileId: null, profileGeneration: 0,
      sessions: [], chatPanes: { primary: null, secondary: null }, focusedChatPane: 'primary', selectedSessionId: null,
      snapshots: {}, loadingSessionIds: new Set(), syncBySession: {}
    })

    await useAppStore.getState().initialize()
    await settleMicrotasks()

    expect(useAppStore.getState().chatPanes).toEqual({ primary: archived.id, secondary: null })
    expect(useAppStore.getState().selectedSessionId).toBe(archived.id)
    expect(useAppStore.getState().snapshots[archived.id]).toBeDefined()
    expect(subscribe).toHaveBeenCalledWith(archived.id, 4)
  })

  it('coalesces concurrent React StrictMode initialization calls', async () => {
    let resolveBootstrap!: (payload: BootstrapPayload) => void
    const bootstrap = vi.fn(() => new Promise<BootstrapPayload>(resolve => { resolveBootstrap = resolve }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap,
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn().mockReturnValue(() => {}) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ initialized: false, sessions: [], selectedSessionId: null })
    const first = useAppStore.getState().initialize()
    const second = useAppStore.getState().initialize()
    expect(bootstrap).toHaveBeenCalledTimes(1)
    resolveBootstrap({
      settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
      health: null,
      sessions: [],
      jobs: [],
      runtimeCatalog: null,
      folderOrder: [],
      collapsedFolders: [],
      archivedCollapsed: false,
      inspectorVisible: true
    })
    await Promise.all([first, second])
    expect(useAppStore.getState().initialized).toBe(true)
  })

  it('reports missing WebSocket support instead of retrying forever', async () => {
    const handlers = new Map<string, (payload: any) => void>()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue({
          settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
          health: null,
          sessions: [],
          jobs: [],
          runtimeCatalog: null,
          folderOrder: [],
          collapsedFolders: [],
          archivedCollapsed: false,
          inspectorVisible: true
        }),
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: {
          on: vi.fn((channel: string, handler: (payload: any) => void) => {
            handlers.set(channel, handler)
            return () => {}
          })
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ initialized: false, selectedSessionId: null, connected: false, syncStatus: 'idle', syncError: null })

    await useAppStore.getState().initialize()
    useAppStore.setState({
      chatPanes: { primary: 'chat-a', secondary: 'chat-b' },
      focusedChatPane: 'primary',
      selectedSessionId: 'chat-a',
      sessions: [sessionFor('chat-a'), sessionFor('chat-b')],
      syncStatus: 'reconnecting',
      syncBySession: {
        'chat-a': { status: 'reconnecting', error: null },
        'chat-b': { status: 'live', error: null }
      }
    })
    handlers.get('server:connection')?.({
      connected: true,
      profileId: useAppStore.getState().activeProfileId,
      profileGeneration: useAppStore.getState().profileGeneration,
      health: { ok: true, api_contract_version: 8, websocket_runtime: false }
    })

    expect(useAppStore.getState().syncStatus).toBe('error')
    expect(useAppStore.getState().syncError).toContain('missing WebSocket support')
    expect(useAppStore.getState().syncBySession['chat-a']).toEqual(expect.objectContaining({ status: 'error' }))
    expect(useAppStore.getState().syncBySession['chat-b']).toEqual(expect.objectContaining({ status: 'error' }))
    expect(useAppStore.getState().syncBySession['chat-b'].error).toContain('missing WebSocket support')
  })

  it('invalidates stale route grants and refreshes visible chats on reconnect', async () => {
    const handlers = new Map<string, (payload: any) => void>()
    const staleRoute: AgentCrossChatRoute = {
      route_id: 'route-stale', revision: `rev_${'a'.repeat(32)}`, alias: 'Stale',
      target_session_id: 'chat-old', actions: ['instruction'],
      created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z',
      target: { title: 'Stale', folder: null, backend: 'codex', available: true, unavailable_reason: null }
    }
    const freshRoute: AgentCrossChatRoute = {
      ...staleRoute, route_id: 'route-fresh', revision: `rev_${'b'.repeat(32)}`,
      alias: 'Fresh', target_session_id: 'chat-fresh', target: { ...staleRoute.target, title: 'Fresh' }
    }
    let resolveRoutes!: (snapshot: { routes: AgentCrossChatRoute[]; max_routes: number }) => void
    const list = vi.fn(() => new Promise<{ routes: AgentCrossChatRoute[]; max_routes: number }>(resolve => {
      resolveRoutes = resolve
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue({
          settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
          health: null, sessions: [], jobs: [], runtimeCatalog: null,
          folderOrder: [], collapsedFolders: [], archivedCollapsed: false, inspectorVisible: true
        }),
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        agentRoutes: { list },
        events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false, profiles: [], activeProfileId: null, profileGeneration: 0,
      sessions: [], selectedSessionId: null, chatPanes: { primary: null, secondary: null },
      snapshots: {}, connected: false, agentRoutesBySession: {}
    })
    await useAppStore.getState().initialize()
    const health = { ...durableRouteHealth(), server_identity: 'server-a', server_instance_id: 'instance-new' }
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 7,
      profiles: [{ id: 'profile-a', name: 'Server', serverIdentity: 'server-a' } as PublicServerProfile],
      sessions: [sessionFor('chat-a')], selectedSessionId: 'chat-a',
      chatPanes: { primary: 'chat-a', secondary: null }, focusedChatPane: 'primary',
      health: { ...health, server_instance_id: 'instance-old' }, connected: false,
      agentRoutesBySession: { 'chat-a': { routes: [staleRoute], max_routes: 16 } }
    })

    handlers.get('server:connection')?.({
      connected: true, profileId: 'profile-a', profileGeneration: 7, health
    })

    expect(useAppStore.getState().agentRoutesBySession).toEqual({})
    expect(list).toHaveBeenCalledWith(
      { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' },
      'chat-a'
    )
    resolveRoutes({ routes: [freshRoute], max_routes: 16 })
    await vi.waitFor(() => expect(useAppStore.getState().agentRoutesBySession['chat-a']?.routes).toEqual([freshRoute]))
  })
})

describe('emergency alert store integration', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends one reason-bearing emergency notification and suppresses the generic message duplicate', async () => {
    const profile = { ...profileFor('profile-emergency'), serverIdentity: 'server-emergency' }
    const handlers = new Map<string, (payload: any) => void>()
    const notify = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue(profileBootstrap(profile, [profile], 3)),
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined), notify },
        events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
      } as unknown as AgentsDockAPI
    })
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    useAppStore.setState({
      initialized: false, profiles: [], activeProfileId: null, profileGeneration: 0,
      sessions: [], selectedSessionId: null, chatPanes: { primary: null, secondary: null },
      focusedChatPane: 'primary', snapshots: {}, collapsedFolders: new Set(), archivedCollapsed: false
    })
    await useAppStore.getState().initialize()
    const previous = { ...sessionFor('deployment-watch'), title: 'Deployment watch', latest_agent_event_seq: 4 }
    const emergency = emergencySessionFor('deployment-watch', {
      title: 'Deployment watch', latest_agent_event_seq: 5
    })
    useAppStore.setState({ sessions: [previous] })

    const payload = { profileId: profile.id, profileGeneration: 3, sessions: [emergency] }
    handlers.get('server:sessions')?.(payload)
    handlers.get('server:sessions')?.(payload)

    expect(notify).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith({
      title: 'EMERGENCY · Deployment watch',
      body: 'Immediate attention is required for deployment-watch.',
      profileId: profile.id,
      serverIdentity: 'server-emergency',
      sessionId: 'deployment-watch',
      emergencyAlertId: emergency.emergency_alert?.id
    })
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ body: 'New agent message' }))
    focus.mockRestore()
  })

  it('expands the exact collapsed folder and archived section when a server session event raises emergencies', async () => {
    const profile = profileFor('profile-emergency-layout')
    const handlers = new Map<string, (payload: any) => void>()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue(profileBootstrap(profile, [profile], 4)),
        native: {
          log: vi.fn().mockResolvedValue(undefined),
          setBadge: vi.fn().mockResolvedValue(undefined),
          notify: vi.fn().mockResolvedValue(undefined)
        },
        events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false, profiles: [], activeProfileId: null, profileGeneration: 0,
      sessions: [], selectedSessionId: null, chatPanes: { primary: null, secondary: null },
      focusedChatPane: 'primary', snapshots: {}
    })
    await useAppStore.getState().initialize()
    const operations = { ...sessionFor('operations-chat'), folder: 'Operations' }
    const archived = { ...sessionFor('archived-chat'), archived: true }
    useAppStore.setState({
      sessions: [operations, archived],
      selectedSessionId: operations.id,
      chatPanes: { primary: operations.id, secondary: null },
      collapsedFolders: new Set(['Operations', 'Research']),
      archivedCollapsed: true
    })

    handlers.get('server:sessions')?.({
      profileId: profile.id,
      profileGeneration: 4,
      sessions: [
        emergencySessionFor(operations.id, { folder: 'Operations' }),
        emergencySessionFor(archived.id, { archived: true })
      ]
    })

    expect([...useAppStore.getState().collapsedFolders]).toEqual(['Research'])
    expect(useAppStore.getState().archivedCollapsed).toBe(false)
  })

  it('expands emergency sections while restoring the bootstrap cache', async () => {
    const operations = emergencySessionFor('bootstrap-operations', { folder: 'Operations' })
    const archived = emergencySessionFor('bootstrap-archived', { archived: true })
    const sessions = new Map([operations, archived].map(session => [session.id, session]))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue({
          settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true },
          health: null,
          sessions: [operations, archived],
          jobs: [],
          runtimeCatalog: null,
          selectedSessionId: operations.id,
          folderOrder: ['Operations', 'Research'],
          collapsedFolders: ['Operations', 'Research'],
          archivedCollapsed: true,
          inspectorVisible: true
        } satisfies BootstrapPayload),
        timeline: {
          cached: vi.fn(async (sessionId: string) => ({
            ...snapshot(sessionId, []),
            session: sessions.get(sessionId) ?? sessionFor(sessionId),
            historyVerified: true
          })),
          subscribe: vi.fn().mockResolvedValue(undefined),
          open: vi.fn(),
          unsubscribe: vi.fn().mockResolvedValue(undefined)
        },
        preferences: {
          get: vi.fn().mockResolvedValue(null),
          set: vi.fn().mockResolvedValue(undefined)
        },
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn().mockReturnValue(() => {}) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false, profiles: [], activeProfileId: null, profileGeneration: 0,
      sessions: [], selectedSessionId: null, chatPanes: { primary: null, secondary: null },
      focusedChatPane: 'primary', snapshots: {}, collapsedFolders: new Set(), archivedCollapsed: false
    })

    await useAppStore.getState().initialize()

    expect([...useAppStore.getState().collapsedFolders]).toEqual(['Research'])
    expect(useAppStore.getState().archivedCollapsed).toBe(false)
  })

  it('reconciles acknowledgement success into both the session list and cached snapshot', async () => {
    const active = emergencySessionFor('ack-success')
    const acknowledged: Session = {
      ...active,
      emergency_alert: { ...active.emergency_alert!, status: 'acknowledged', acknowledged_at: '2026-08-25T12:05:00Z' },
      unacknowledged_emergency_count: 0
    }
    const acknowledgeEmergency = vi.fn().mockResolvedValue(acknowledged)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { acknowledgeEmergency } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profiles: [profileFor('local')], profileGeneration: 7, switchingProfileId: null,
      sessions: [active], snapshots: { [active.id]: { ...snapshot(active.id, []), session: active } }, error: null
    })

    await expect(useAppStore.getState().acknowledgeEmergency(active.id, active.emergency_alert!.id)).resolves.toBe(true)

    expect(acknowledgeEmergency).toHaveBeenCalledWith(active.id, active.emergency_alert!.id)
    expect(useAppStore.getState().sessions[0]).toMatchObject({
      id: active.id,
      emergency_alert: { id: active.emergency_alert!.id, status: 'acknowledged' },
      unacknowledged_emergency_count: 0
    })
    expect(useAppStore.getState().snapshots[active.id].session).toBe(useAppStore.getState().sessions[0])
  })

  it('leaves the active alert intact when acknowledgement fails', async () => {
    const active = emergencySessionFor('ack-failure')
    const acknowledgeEmergency = vi.fn().mockRejectedValue(new Error('Acknowledgement was rejected'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { acknowledgeEmergency } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'local', profiles: [profileFor('local')], profileGeneration: 8, switchingProfileId: null,
      sessions: [active], snapshots: { [active.id]: { ...snapshot(active.id, []), session: active } }, error: null
    })

    await expect(useAppStore.getState().acknowledgeEmergency(active.id, active.emergency_alert!.id)).resolves.toBe(false)

    expect(acknowledgeEmergency).toHaveBeenCalledWith(active.id, active.emergency_alert!.id)
    expect(useAppStore.getState().sessions[0].emergency_alert).toEqual(active.emergency_alert)
    expect(useAppStore.getState().snapshots[active.id].session.emergency_alert).toEqual(active.emergency_alert)
    expect(useAppStore.getState().error).toBe('Acknowledgement was rejected')
  })
})

describe('server profile switching', () => {
  afterEach(() => cancelPendingSteering())

  it('keeps a Force Send lease when flushing or switching fails before profile adoption', async () => {
    const profileA = { ...profileFor('profile-a'), serverIdentity: 'server-a' }
    const profileB = { ...profileFor('profile-b'), serverIdentity: 'server-b' }
    const scope: SteeringScope = {
      profileId: profileA.id,
      profileGeneration: 1,
      serverIdentity: profileA.serverIdentity,
      sessionId: 'chat-a'
    }
    const switchProfile = vi.fn().mockRejectedValue(new Error('Profile B is offline'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        queue: {
          runNow: vi.fn(() => new Promise(() => undefined)),
          list: vi.fn().mockResolvedValue([])
        },
        servers: { switch: switchProfile },
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true,
      profiles: [profileA, profileB],
      activeProfileId: profileA.id,
      profileGeneration: 1,
      switchingProfileId: null,
      selectedSessionId: scope.sessionId,
      sessions: [sessionFor(scope.sessionId)],
      error: null
    })
    const pendingSteer = steerQueuedTurn(scope, 'queued-a')
    const flushFailure = new Error('Draft flush failed')
    const failFlush = (event: globalThis.Event) => {
      const detail = (event as CustomEvent<{ waitUntil(promise: Promise<unknown>): void }>).detail
      detail.waitUntil(Promise.reject(flushFailure))
    }
    window.addEventListener('agentsdock:flush-draft', failFlush)

    try {
      await expect(useAppStore.getState().switchServer(profileB.id)).rejects.toBe(flushFailure)
      expect(switchProfile).not.toHaveBeenCalled()
      expect(isSteeringPending(scope)).toBe(true)

      window.removeEventListener('agentsdock:flush-draft', failFlush)
      await expect(useAppStore.getState().switchServer(profileB.id)).rejects.toThrow('offline')
      expect(isSteeringPending(scope)).toBe(true)
    } finally {
      window.removeEventListener('agentsdock:flush-draft', failFlush)
      cancelPendingSteering()
      await expect(pendingSteer).rejects.toThrow('active server changed')
    }
  })

  it('creates profile-addressed notifications for background agent messages', async () => {
    const profileA = { ...profileFor('profile-a'), serverIdentity: 'server-a' }
    const handlers = new Map<string, (payload: any) => void>()
    const notify = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue(profileBootstrap(profileA, [profileA], 1)),
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined), notify },
        events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
      } as unknown as AgentsDockAPI
    })
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    useAppStore.setState({ initialized: false, sessions: [], selectedSessionId: null })
    await useAppStore.getState().initialize()
    useAppStore.setState({ sessions: [{ ...sessionFor('same'), title: 'Agent result', latest_agent_event_seq: 1 }] })

    handlers.get('server:sessions')?.({
      profileId: profileA.id,
      profileGeneration: 1,
      sessions: [{ ...sessionFor('same'), title: 'Agent result', latest_agent_event_seq: 2 }]
    })

    expect(notify).toHaveBeenCalledWith({
      title: 'Agent result',
      body: 'New agent message',
      profileId: 'profile-a',
      serverIdentity: 'server-a',
      sessionId: 'same'
    })
    vi.restoreAllMocks()
  })

  it('switches and verifies a notification profile before selecting a reused session ID', async () => {
    const profileA = profileFor('profile-a')
    const profileB = profileFor('profile-b')
    const handlers = new Map<string, (payload: any) => void>()
    const switchProfile = vi.fn().mockResolvedValue(profileBootstrap(profileB, [profileA, profileB], 2, { ...sessionFor('same'), title: 'B chat' }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue(profileBootstrap(profileA, [profileA, profileB], 1, { ...sessionFor('same'), title: 'A chat' })),
        servers: { switch: switchProfile },
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ initialized: false, selectedSessionId: null })
    await useAppStore.getState().initialize()
    const originalSelectSession = useAppStore.getState().selectSession
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ selectSession })

    handlers.get('native:notification')?.({ profileId: profileB.id, serverIdentity: null, sessionId: 'same' })

    await vi.waitFor(() => expect(selectSession).toHaveBeenCalledWith('same'))
    expect(switchProfile).toHaveBeenCalledWith(profileB.id)
    expect(switchProfile.mock.invocationCallOrder[0]).toBeLessThan(selectSession.mock.invocationCallOrder[0])
    useAppStore.setState({ selectSession: originalSelectSession })
  })

  it('reports success from the public notification route action only after selecting the exact chat', async () => {
    const profile = { ...profileFor('profile-a'), serverIdentity: 'server-a' }
    const chat = sessionFor('notified')
    const originalSelectSession = useAppStore.getState().selectSession
    const selectSession = vi.fn(async (sessionId: string) => {
      useAppStore.setState({ selectedSessionId: sessionId })
    })
    useAppStore.setState({
      profiles: [profile],
      activeProfileId: profile.id,
      switchingProfileId: null,
      sessions: [chat],
      selectedSessionId: null,
      selectSession,
      error: null
    })

    try {
      await expect(useAppStore.getState().openNotificationRoute({
        profileId: profile.id,
        serverIdentity: profile.serverIdentity ?? null,
        sessionId: chat.id
      })).resolves.toBe(true)

      expect(selectSession).toHaveBeenCalledOnce()
      expect(selectSession).toHaveBeenCalledWith(chat.id)
      expect(useAppStore.getState().selectedSessionId).toBe(chat.id)
    } finally {
      useAppStore.setState({ selectSession: originalSelectSession })
    }
  })

  it('reports failure from the public notification route action when the saved identity changed', async () => {
    const profile = { ...profileFor('profile-a'), serverIdentity: 'new-identity' }
    const chat = sessionFor('notified')
    const originalSelectSession = useAppStore.getState().selectSession
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      profiles: [profile],
      activeProfileId: profile.id,
      switchingProfileId: null,
      sessions: [chat],
      selectedSessionId: null,
      selectSession,
      error: null
    })

    try {
      await expect(useAppStore.getState().openNotificationRoute({
        profileId: profile.id,
        serverIdentity: 'old-identity',
        sessionId: chat.id
      })).resolves.toBe(false)

      expect(selectSession).not.toHaveBeenCalled()
      expect(useAppStore.getState().error).toContain('identity')
    } finally {
      useAppStore.setState({ selectSession: originalSelectSession })
    }
  })

  it('waits for canonical identity adoption before routing a notification', async () => {
    const fallback = profileFor('profile-b')
    const canonical = { ...fallback, serverIdentity: 'server-b' }
    const other = { ...sessionFor('other'), title: 'Other chat' }
    const notified = { ...sessionFor('notified'), title: 'Notified chat' }
    const refresh = deferred<ProfileBootstrapPayload>()
    const handlers = new Map<string, (payload: any) => void>()
    const cached = profileBootstrap(fallback, [fallback], 4)
    const canonicalPayload: ProfileBootstrapPayload = {
      ...profileBootstrap(canonical, [canonical], 4),
      sessions: [other, notified],
      selectedSessionId: other.id
    }
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue(cached),
        servers: { refresh: vi.fn().mockReturnValue(refresh.promise) },
        preferences: {
          get: vi.fn().mockResolvedValue(''),
          set: vi.fn().mockResolvedValue(undefined),
          getScoped: vi.fn().mockResolvedValue(''),
          setScoped: vi.fn().mockResolvedValue(undefined)
        },
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false,
      profiles: [],
      activeProfileId: null,
      profileGeneration: 0,
      switchingProfileId: null,
      selectedSessionId: null,
      sessions: [],
      error: null
    })
    await useAppStore.getState().initialize()
    const originalSelectSession = useAppStore.getState().selectSession
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ selectSession })

    handlers.get('server:profiles')?.({ activeProfileId: fallback.id, profiles: [canonical], profileGeneration: 4 })
    handlers.get('native:notification')?.({ profileId: fallback.id, serverIdentity: 'server-b', sessionId: notified.id })
    await settleMicrotasks()

    expect(useAppStore.getState().switchingProfileId).toBe(fallback.id)
    expect(selectSession).not.toHaveBeenCalled()

    refresh.resolve(canonicalPayload)
    await vi.waitFor(() => expect(selectSession).toHaveBeenCalledWith(notified.id))
    expect(useAppStore.getState().activeProfileId).toBe(fallback.id)
    expect(useAppStore.getState().profiles[0]?.serverIdentity).toBe('server-b')
    useAppStore.setState({ selectSession: originalSelectSession })
  })

  it('actively refreshes an unsolicited canonical identity adoption and unlocks cached chat selection', async () => {
    const fallback = profileFor('profile-a')
    const canonical = { ...fallback, serverIdentity: 'server-a' }
    const chatA = { ...sessionFor('chat-a'), title: 'Alpha chat' }
    const chatB = { ...sessionFor('chat-b'), title: 'Beta chat' }
    const fallbackPayload: ProfileBootstrapPayload = {
      ...profileBootstrap(fallback, [fallback], 4),
      sessions: [chatA, chatB],
      selectedSessionId: chatA.id
    }
    const canonicalPayload: ProfileBootstrapPayload = {
      ...profileBootstrap(canonical, [canonical], 4),
      sessions: [chatA, chatB],
      selectedSessionId: chatA.id
    }
    const adoptionRefresh = deferred<ProfileBootstrapPayload>()
    const handlers = new Map<string, (payload: any) => void>()
    const refresh = vi.fn()
      .mockResolvedValueOnce(fallbackPayload)
      .mockReturnValueOnce(adoptionRefresh.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue(fallbackPayload),
        servers: { refresh },
        timeline: {
          cached: vi.fn((sessionId: string) => Promise.resolve(snapshot(sessionId, [eventFor(sessionId, 1)]))),
          subscribe: vi.fn().mockResolvedValue(undefined)
        },
        preferences: {
          get: vi.fn().mockImplementation((_key: string, fallbackValue: unknown) => Promise.resolve(fallbackValue)),
          set: vi.fn().mockResolvedValue(undefined),
          getScoped: vi.fn().mockImplementation((_scope: unknown, _key: string, fallbackValue: unknown) => Promise.resolve(fallbackValue)),
          setScoped: vi.fn().mockResolvedValue(undefined)
        },
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false,
      profiles: [],
      activeProfileId: null,
      profileGeneration: 0,
      switchingProfileId: null,
      selectedSessionId: null,
      sessions: [],
      snapshots: {},
      error: null
    })

    await useAppStore.getState().initialize()
    await settleMicrotasks()
    expect(refresh).toHaveBeenCalledTimes(1)

    handlers.get('server:profiles')?.({ activeProfileId: fallback.id, profiles: [canonical], profileGeneration: 4 })
    expect(useAppStore.getState().switchingProfileId).toBe(fallback.id)
    await settleMicrotasks()
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenLastCalledWith(fallback.id, 4)

    await useAppStore.getState().selectSession(chatB.id)
    expect(useAppStore.getState().selectedSessionId).toBe(chatA.id)

    adoptionRefresh.resolve(canonicalPayload)
    await vi.waitFor(() => expect(useAppStore.getState().switchingProfileId).toBeNull())
    expect(useAppStore.getState().profiles[0]?.serverIdentity).toBe('server-a')

    await useAppStore.getState().selectSession(chatB.id)
    expect(useAppStore.getState().selectedSessionId).toBe(chatB.id)
    await useAppStore.getState().selectSession(chatA.id)
    expect(useAppStore.getState().selectedSessionId).toBe(chatA.id)
  })

  it('bounds a stalled adoption refresh and releases the inert workspace through a canonical fail-safe', async () => {
    vi.useFakeTimers()
    try {
      const fallback = profileFor('profile-a')
      const canonical = { ...fallback, serverIdentity: 'server-a' }
      const chatA = sessionFor('chat-a')
      const chatB = sessionFor('chat-b')
      const fallbackPayload: ProfileBootstrapPayload = {
        ...profileBootstrap(fallback, [fallback], 5),
        sessions: [chatA, chatB],
        selectedSessionId: chatA.id
      }
      const bootstrap = vi.fn()
        .mockResolvedValueOnce(fallbackPayload)
        .mockRejectedValueOnce(new Error('cache bootstrap unavailable'))
      const refresh = vi.fn()
        .mockResolvedValueOnce(fallbackPayload)
        .mockReturnValueOnce(new Promise<ProfileBootstrapPayload>(() => undefined))
      const handlers = new Map<string, (payload: any) => void>()
      Object.defineProperty(window, 'agentsDock', {
        configurable: true,
        value: {
          bootstrap,
          servers: { refresh },
          timeline: {
            cached: vi.fn((sessionId: string) => Promise.resolve(snapshot(sessionId, [eventFor(sessionId, 1)]))),
            subscribe: vi.fn().mockResolvedValue(undefined)
          },
          preferences: {
            get: vi.fn().mockImplementation((_key: string, fallbackValue: unknown) => Promise.resolve(fallbackValue)),
            set: vi.fn().mockResolvedValue(undefined),
            getScoped: vi.fn().mockImplementation((_scope: unknown, _key: string, fallbackValue: unknown) => Promise.resolve(fallbackValue)),
            setScoped: vi.fn().mockResolvedValue(undefined)
          },
          native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
          events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
        } as unknown as AgentsDockAPI
      })
      useAppStore.setState({
        initialized: false,
        profiles: [],
        activeProfileId: null,
        profileGeneration: 0,
        switchingProfileId: null,
        selectedSessionId: null,
        sessions: [],
        snapshots: {},
        drafts: {},
        error: null
      })

      await useAppStore.getState().initialize()
      await settleMicrotasks()
      handlers.get('server:profiles')?.({ activeProfileId: fallback.id, profiles: [canonical], profileGeneration: 5 })
      await settleMicrotasks()
      expect(refresh).toHaveBeenCalledTimes(2)
      expect(useAppStore.getState().switchingProfileId).toBe(fallback.id)

      await vi.advanceTimersByTimeAsync(45_000)
      await settleMicrotasks()

      expect(useAppStore.getState().switchingProfileId).toBeNull()
      expect(useAppStore.getState().profiles[0]?.serverIdentity).toBe('server-a')
      expect(useAppStore.getState().error).toContain('workspace could not be reloaded')
      await useAppStore.getState().selectSession(chatB.id)
      expect(useAppStore.getState().selectedSessionId).toBe(chatB.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a notification whose saved server identity changed', async () => {
    const profileA = { ...profileFor('profile-a'), serverIdentity: 'new-identity' }
    const handlers = new Map<string, (payload: any) => void>()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue(profileBootstrap(profileA, [profileA], 1, sessionFor('same'))),
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ initialized: false, selectedSessionId: null, error: null })
    await useAppStore.getState().initialize()
    const originalSelectSession = useAppStore.getState().selectSession
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ selectSession })

    handlers.get('native:notification')?.({ profileId: profileA.id, serverIdentity: 'old-identity', sessionId: 'same' })

    await vi.waitFor(() => expect(useAppStore.getState().error).toContain('identity'))
    expect(selectSession).not.toHaveBeenCalled()
    useAppStore.setState({ selectSession: originalSelectSession })
  })

  it('initializes profile state and rejects shaped events from stale profile generations', async () => {
    const profileA = profileFor('profile-a')
    const profileB = profileFor('profile-b')
    const handlers = new Map<string, (payload: any) => void>()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue(profileBootstrap(profileB, [profileA, profileB], 7)),
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: {
          on: vi.fn((channel: string, handler: (payload: any) => void) => {
            handlers.set(channel, handler)
            return () => {}
          })
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false,
      profiles: [],
      activeProfileId: null,
      profileGeneration: 0,
      switchingProfileId: null,
      selectedSessionId: null,
      sessions: [],
      snapshots: {},
      forwardedPorts: [],
      forwardedPortsRevision: 0
    })

    await useAppStore.getState().initialize()
    expect(useAppStore.getState().activeProfileId).toBe(profileB.id)
    expect(useAppStore.getState().profileGeneration).toBe(7)
    expect(useAppStore.getState().profiles.map(profile => profile.id)).toEqual([profileA.id, profileB.id])

    const forwardedPort = {
      sessionId: 'owner-chat', remotePort: 7007, localPort: 49152,
      localUrl: 'http://127.0.0.1:49152', state: 'open' as const, error: null
    }
    handlers.get('ports:changed')?.({
      profileId: profileA.id,
      profileGeneration: 7,
      ports: [forwardedPort]
    })
    expect(useAppStore.getState().forwardedPorts).toEqual([])
    handlers.get('ports:changed')?.({
      profileId: profileB.id,
      profileGeneration: 7,
      ports: [forwardedPort]
    })
    expect(useAppStore.getState().forwardedPorts).toEqual([forwardedPort])

    const replacementPort = { ...forwardedPort, remotePort: 8080, localPort: 49153, localUrl: 'http://127.0.0.1:49153' }
    useAppStore.setState({ switchingProfileId: profileB.id })
    handlers.get('ports:changed')?.({
      profileId: profileB.id,
      profileGeneration: 7,
      ports: [replacementPort]
    })
    expect(useAppStore.getState().forwardedPorts).toEqual([replacementPort])

    useAppStore.setState({ switchingProfileId: profileA.id })
    handlers.get('ports:changed')?.({
      profileId: profileB.id,
      profileGeneration: 7,
      ports: []
    })
    expect(useAppStore.getState().forwardedPorts).toEqual([replacementPort])
    useAppStore.setState({ switchingProfileId: null })

    const current = snapshot('same-id', [eventFor('same-id', 7)])
    useAppStore.setState({ selectedSessionId: 'same-id', sessions: [sessionFor('same-id')], snapshots: { 'same-id': current } })
    handlers.get('server:timeline')?.({
      profileId: profileA.id,
      profileGeneration: 6,
      sessionId: 'same-id',
      snapshot: snapshot('same-id', [eventFor('same-id', 60)]),
      source: 'server',
      mode: 'replace'
    })
    expect(useAppStore.getState().snapshots['same-id']).toBe(current)

    handlers.get('server:profiles')?.({ activeProfileId: profileB.id, profiles: [profileA, profileB], profileGeneration: 8 })
    expect(useAppStore.getState().forwardedPorts).toEqual([])
    handlers.get('server:timeline')?.({
      profileId: profileB.id,
      profileGeneration: 7,
      sessionId: 'same-id',
      snapshot: snapshot('same-id', [eventFor('same-id', 70)]),
      source: 'server',
      mode: 'replace'
    })
    expect(useAppStore.getState().profileGeneration).toBe(8)
    expect(useAppStore.getState().snapshots['same-id']).toBe(current)
  })

  it('waits for synchronous draft flush registrations and atomically replaces profile-scoped state', async () => {
    const profileA = profileFor('profile-a')
    const profileB = profileFor('profile-b')
    let finishDraftPersistence!: () => void
    const draftPersistence = new Promise<void>(resolve => { finishDraftPersistence = resolve })
    let finishTimelinePersistence!: () => void
    const timelinePersistence = new Promise<void>(resolve => { finishTimelinePersistence = resolve })
    const flushListener = (event: globalThis.Event) => {
      const detail = (event as CustomEvent<{ waitUntil(promise: Promise<unknown>): void }>).detail
      detail.waitUntil(draftPersistence)
    }
    const timelineListener = (event: globalThis.Event) => {
      const detail = (event as CustomEvent<{ waitUntil(promise: Promise<unknown>): void }>).detail
      detail.waitUntil(timelinePersistence)
    }
    window.addEventListener('agentsdock:flush-draft', flushListener)
    window.addEventListener('agentsdock:capture-timeline', timelineListener)

    const targetSnapshot = { ...snapshot('shared-chat', [eventFor('shared-chat', 20)]), session: { ...sessionFor('shared-chat'), title: 'Profile B chat' } }
    const switchProfile = vi.fn().mockResolvedValue(profileBootstrap(profileB, [profileA, profileB], 2, targetSnapshot.session))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        servers: { switch: switchProfile },
        timeline: { cached: vi.fn().mockResolvedValue(targetSnapshot), subscribe: vi.fn().mockResolvedValue(undefined) },
        native: { setBadge: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true,
      profiles: [profileA, profileB],
      activeProfileId: profileA.id,
      profileGeneration: 1,
      switchingProfileId: null,
      selectedSessionId: 'shared-chat',
      sessions: [{ ...sessionFor('shared-chat'), title: 'Profile A chat' }],
      snapshots: { 'shared-chat': snapshot('shared-chat', [eventFor('shared-chat', 10)]) },
      drafts: { 'shared-chat': 'A-only draft' },
      uploadsBySession: { 'shared-chat': [{ id: 'a-file', filename: 'a.txt', content_type: 'text/plain' }] },
      uploadPathsBySession: { 'shared-chat': [{ path: '/tmp/a.txt', name: 'a.txt' }] }
    })

    try {
      const switching = useAppStore.getState().switchServer(profileB.id)
      await Promise.resolve()
      expect(switchProfile).not.toHaveBeenCalled()
      expect(useAppStore.getState().switchingProfileId).toBe(profileB.id)

      finishDraftPersistence()
      await Promise.resolve()
      expect(switchProfile).not.toHaveBeenCalled()
      finishTimelinePersistence()
      await switching

      const state = useAppStore.getState()
      expect(switchProfile).toHaveBeenCalledWith(profileB.id)
      expect(state.activeProfileId).toBe(profileB.id)
      expect(state.profileGeneration).toBe(2)
      expect(state.switchingProfileId).toBeNull()
      expect(state.sessions[0]?.title).toBe('Profile B chat')
      expect(state.snapshots['shared-chat'].events.map(item => item.seq)).toEqual([20])
      expect(state.drafts).toEqual({})
      expect(state.uploadsBySession).toEqual({})
      expect(state.uploadPathsBySession).toEqual({})
    } finally {
      window.removeEventListener('agentsdock:flush-draft', flushListener)
      window.removeEventListener('agentsdock:capture-timeline', timelineListener)
    }
  })

  it('lets the newest A to B to A intent win even when switch results resolve out of order', async () => {
    const profileA = profileFor('profile-a')
    const profileB = profileFor('profile-b')
    const resolvers = new Map<string, (payload: ProfileBootstrapPayload) => void>()
    const switchProfile = vi.fn((profileId: string) => new Promise<ProfileBootstrapPayload>(resolve => { resolvers.set(profileId, resolve) }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        servers: { switch: switchProfile },
        native: { setBadge: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true,
      profiles: [profileA, profileB],
      activeProfileId: profileA.id,
      profileGeneration: 1,
      switchingProfileId: null,
      selectedSessionId: null,
      sessions: [],
      snapshots: {},
      drafts: {},
      uploadsBySession: {},
      uploadPathsBySession: {}
    })

    const toB = useAppStore.getState().switchServer(profileB.id)
    await settleMicrotasks()
    const backToA = useAppStore.getState().switchServer(profileA.id)
    await settleMicrotasks()
    expect(switchProfile.mock.calls.map(([profileId]) => profileId)).toEqual([profileB.id, profileA.id])

    resolvers.get(profileA.id)?.(profileBootstrap(profileA, [profileA, profileB], 3))
    await backToA
    resolvers.get(profileB.id)?.(profileBootstrap(profileB, [profileA, profileB], 2))
    await toB

    expect(useAppStore.getState().activeProfileId).toBe(profileA.id)
    expect(useAppStore.getState().profileGeneration).toBe(3)
    expect(useAppStore.getState().switchingProfileId).toBeNull()
  })

  it('does not let an old profile timeline completion overwrite the same session ID after switching', async () => {
    const profileA = profileFor('profile-a')
    const profileB = profileFor('profile-b')
    let resolveProfileA!: (value: SessionSnapshot | null) => void
    const profileACache = new Promise<SessionSnapshot | null>(resolve => { resolveProfileA = resolve })
    const profileBSnapshot = { ...snapshot('same-id', [eventFor('same-id', 200)]), session: { ...sessionFor('same-id'), title: 'B same ID' } }
    const cached = vi.fn()
      .mockImplementationOnce(() => profileACache)
      .mockResolvedValueOnce(profileBSnapshot)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        servers: { switch: vi.fn().mockResolvedValue(profileBootstrap(profileB, [profileA, profileB], 11, profileBSnapshot.session)) },
        timeline: { cached, subscribe: vi.fn().mockResolvedValue(undefined) },
        native: { setBadge: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true,
      profiles: [profileA, profileB],
      activeProfileId: profileA.id,
      profileGeneration: 10,
      switchingProfileId: null,
      selectedSessionId: null,
      sessions: [sessionFor('same-id')],
      snapshots: {},
      drafts: { 'same-id': 'A draft' },
      uploadsBySession: {},
      uploadPathsBySession: {}
    })

    const oldSelection = useAppStore.getState().selectSession('same-id')
    await settleMicrotasks()
    await useAppStore.getState().switchServer(profileB.id)
    resolveProfileA(snapshot('same-id', [eventFor('same-id', 100)]))
    await oldSelection

    const state = useAppStore.getState()
    expect(cached).toHaveBeenCalledTimes(2)
    expect(state.activeProfileId).toBe(profileB.id)
    expect(state.snapshots['same-id'].session.title).toBe('B same ID')
    expect(state.snapshots['same-id'].events.map(item => item.seq)).toEqual([200])
    expect(state.drafts).toEqual({})
  })

  it('atomically adopts a canonical workspace without overwriting its preserved draft', async () => {
    const profileA = profileFor('profile-a')
    const fallbackB = profileFor('profile-b')
    const canonicalB = { ...fallbackB, serverIdentity: 'server-b' }
    const chat = { ...sessionFor('shared-chat'), title: 'Canonical chat' }
    const refreshB = deferred<ProfileBootstrapPayload>()
    const handlers = new Map<string, (payload: any) => void>()
    const bootstrapA = profileBootstrap(profileA, [profileA, fallbackB], 1)
    const fallbackPayload = profileBootstrap(fallbackB, [profileA, fallbackB], 2, chat)
    const canonicalPayload = profileBootstrap(canonicalB, [profileA, canonicalB], 2, chat)
    const getScoped = vi.fn().mockResolvedValue('canonical draft')
    const setScoped = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue(bootstrapA),
        servers: {
          switch: vi.fn().mockResolvedValue(fallbackPayload),
          refresh: vi.fn((profileId: string) => profileId === profileA.id ? Promise.resolve(bootstrapA) : refreshB.promise)
        },
        timeline: {
          cached: vi.fn().mockResolvedValue(snapshot(chat.id, [])),
          subscribe: vi.fn().mockResolvedValue(undefined)
        },
        preferences: {
          get: vi.fn().mockResolvedValue(''),
          set: vi.fn().mockResolvedValue(undefined),
          getScoped,
          setScoped
        },
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false,
      profiles: [],
      activeProfileId: null,
      profileGeneration: 0,
      switchingProfileId: null,
      selectedSessionId: null,
      sessions: [],
      snapshots: {},
      drafts: {},
      error: null
    })

    await useAppStore.getState().initialize()
    await settleMicrotasks()
    await useAppStore.getState().switchServer(fallbackB.id)
    useAppStore.setState({ drafts: { [chat.id]: 'fallback draft typed during connection' } })

    handlers.get('server:profiles')?.({ activeProfileId: fallbackB.id, profiles: [profileA, canonicalB], profileGeneration: 2 })
    expect(useAppStore.getState().switchingProfileId).toBe(fallbackB.id)
    expect(await useAppStore.getState().switchServer(profileA.id)).toBe(false)
    expect(setScoped).not.toHaveBeenCalled()

    refreshB.resolve(canonicalPayload)
    await vi.waitFor(() => expect(useAppStore.getState().profiles.find(profile => profile.id === fallbackB.id)?.serverIdentity).toBe('server-b'))

    expect(useAppStore.getState().switchingProfileId).toBeNull()
    expect(useAppStore.getState().drafts[chat.id]).toBe('canonical draft')
    expect(getScoped).toHaveBeenCalledWith({ profileId: fallbackB.id, profileGeneration: 2, serverIdentity: 'server-b' }, `draft:${chat.id}`, null)
    expect(setScoped).toHaveBeenCalledWith(
      { profileId: fallbackB.id, profileGeneration: 2, serverIdentity: 'server-b' },
      'chatPaneLayout',
      { primary: chat.id, secondary: null, focusedPane: 'primary' }
    )
  })

  it('preserves a split layout and both composers while adopting a canonical server identity', async () => {
    const fallback = profileFor('profile-split')
    const canonical = { ...fallback, serverIdentity: 'server-split' }
    const chatA = sessionFor('chat-a')
    const chatB = sessionFor('chat-b')
    const fallbackPayload: ProfileBootstrapPayload = {
      ...profileBootstrap(fallback, [fallback], 9),
      sessions: [chatA, chatB],
      selectedSessionId: chatB.id
    }
    const canonicalPayload: ProfileBootstrapPayload = {
      ...profileBootstrap(canonical, [canonical], 9),
      sessions: [chatA, chatB],
      selectedSessionId: chatB.id
    }
    const adoption = deferred<ProfileBootstrapPayload>()
    const handlers = new Map<string, (payload: any) => void>()
    const fallbackLayout = { primary: chatA.id, secondary: chatB.id, focusedPane: 'secondary' as const }
    const setScoped = vi.fn().mockResolvedValue(undefined)
    const getScoped = vi.fn().mockImplementation((scope: { serverIdentity: string | null }, key: string, fallbackValue: unknown) => {
      if (scope.serverIdentity == null && key === 'chatPaneLayout') return Promise.resolve(fallbackLayout)
      return Promise.resolve(fallbackValue)
    })
    const refresh = vi.fn()
      .mockResolvedValueOnce(fallbackPayload)
      .mockReturnValueOnce(adoption.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        bootstrap: vi.fn().mockResolvedValue(fallbackPayload),
        servers: { refresh },
        timeline: {
          cached: vi.fn(async (sessionId: string) => snapshot(sessionId, [eventFor(sessionId, 1)])),
          subscribe: vi.fn().mockResolvedValue(undefined)
        },
        preferences: {
          get: vi.fn().mockImplementation((_key: string, fallbackValue: unknown) => Promise.resolve(fallbackValue)),
          set: vi.fn().mockResolvedValue(undefined),
          getScoped,
          setScoped
        },
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn((channel: string, handler: (payload: any) => void) => { handlers.set(channel, handler); return () => {} }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: false, profiles: [], activeProfileId: null, profileGeneration: 0,
      switchingProfileId: null, sessions: [], chatPanes: { primary: null, secondary: null },
      focusedChatPane: 'primary', selectedSessionId: null, snapshots: {}, drafts: {}, chatReferencesBySession: {}
    })

    await useAppStore.getState().initialize()
    await settleMicrotasks()
    const referenceA: ChatReference = {
      session_id: chatB.id, action: 'instruction', display_title_snapshot: 'B', source_text_start: 0, source_text_end: 2
    }
    const referenceB: ChatReference = {
      session_id: chatA.id, action: 'instruction', display_title_snapshot: 'A', source_text_start: 0, source_text_end: 2
    }
    useAppStore.setState({
      drafts: { [chatA.id]: '@B finish A', [chatB.id]: '@A finish B' },
      chatReferencesBySession: { [chatA.id]: [referenceA], [chatB.id]: [referenceB] }
    })

    handlers.get('server:profiles')?.({
      activeProfileId: fallback.id,
      profiles: [canonical],
      profileGeneration: 9
    })
    adoption.resolve(canonicalPayload)
    await vi.waitFor(() => expect(useAppStore.getState().switchingProfileId).toBeNull())

    const state = useAppStore.getState()
    expect(state.chatPanes).toEqual({ primary: chatA.id, secondary: chatB.id })
    expect(state.focusedChatPane).toBe('secondary')
    expect(state.selectedSessionId).toBe(chatB.id)
    expect(state.drafts).toEqual({ [chatA.id]: '@B finish A', [chatB.id]: '@A finish B' })
    expect(state.chatReferencesBySession).toEqual({ [chatA.id]: [referenceA], [chatB.id]: [referenceB] })
    const canonicalScope = { profileId: fallback.id, profileGeneration: 9, serverIdentity: 'server-split' }
    expect(setScoped).toHaveBeenCalledWith(canonicalScope, 'chatPaneLayout', fallbackLayout)
    expect(setScoped).toHaveBeenCalledWith(canonicalScope, `draft:${chatA.id}`, '@B finish A')
    expect(setScoped).toHaveBeenCalledWith(canonicalScope, `draft:${chatB.id}`, '@A finish B')
    expect(setScoped).toHaveBeenCalledWith(canonicalScope, `draft-chat-references:${chatA.id}`, [referenceA])
    expect(setScoped).toHaveBeenCalledWith(canonicalScope, `draft-chat-references:${chatB.id}`, [referenceB])
  })

  it('sends managed restart with the exact canonical workspace scope and adopts only the returned generation', async () => {
    const profileA = { ...profileFor('profile-a'), serverIdentity: 'server-a' }
    const currentChat = { ...sessionFor('chat-a'), title: 'Before restart' }
    const restartedChat = { ...currentChat, title: 'After restart' }
    const restartedPayload: ProfileBootstrapPayload = {
      ...profileBootstrap(profileA, [profileA], 2, restartedChat),
      health: { ok: true, server_identity: 'server-a', server_instance_id: 'boot-new' }
    }
    const response = deferred<ProfileBootstrapPayload>()
    const restart = vi.fn(() => response.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        servers: { restart, refresh: vi.fn().mockResolvedValue(restartedPayload) },
        timeline: { cached: vi.fn().mockResolvedValue(snapshot(currentChat.id, [])), subscribe: vi.fn().mockResolvedValue(undefined) },
        native: { setBadge: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true,
      profiles: [profileA],
      activeProfileId: profileA.id,
      profileGeneration: 1,
      switchingProfileId: null,
      selectedSessionId: currentChat.id,
      sessions: [currentChat],
      snapshots: { [currentChat.id]: snapshot(currentChat.id, [eventFor(currentChat.id, 1)]) },
      drafts: { [currentChat.id]: 'preserve until confirmed' },
      error: null
    })

    const pending = useAppStore.getState().restartServer('boot-old')
    await settleMicrotasks()

    expect(restart).toHaveBeenCalledWith({
      profileId: profileA.id,
      profileGeneration: 1,
      serverIdentity: 'server-a'
    }, 'boot-old')
    expect(useAppStore.getState().switchingProfileId).toBe(profileA.id)
    expect(useAppStore.getState().sessions[0]?.title).toBe('Before restart')
    expect(useAppStore.getState().drafts[currentChat.id]).toBe('preserve until confirmed')

    response.resolve(restartedPayload)
    await expect(pending).resolves.toBe(true)
    expect(useAppStore.getState()).toEqual(expect.objectContaining({
      activeProfileId: profileA.id,
      profileGeneration: 2,
      switchingProfileId: null
    }))
    expect(useAppStore.getState().sessions[0]?.title).toBe('After restart')
  })

  it('forwards an explicitly confirmed force restart without changing its blocker revision', async () => {
    const profileA = { ...profileFor('profile-a'), serverIdentity: 'server-a' }
    const restartedPayload: ProfileBootstrapPayload = {
      ...profileBootstrap(profileA, [profileA], 2),
      health: { ok: true, server_identity: 'server-a', server_instance_id: 'boot-new' }
    }
    const restart = vi.fn().mockResolvedValue(restartedPayload)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        servers: { restart, refresh: vi.fn().mockResolvedValue(restartedPayload) },
        native: { setBadge: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true,
      profiles: [profileA],
      activeProfileId: profileA.id,
      profileGeneration: 1,
      switchingProfileId: null,
      selectedSessionId: null,
      sessions: [],
      snapshots: {},
      drafts: {},
      error: null
    })
    const confirmation = {
      force: true as const,
      forceConfirmed: true as const,
      expectedBlockerRevision: 'a'.repeat(64),
      expectedUpdateScheduleId: '1'.repeat(32)
    }

    await expect(useAppStore.getState().restartServer('boot-old', confirmation)).resolves.toBe(true)

    expect(restart).toHaveBeenCalledWith({
      profileId: profileA.id,
      profileGeneration: 1,
      serverIdentity: 'server-a'
    }, 'boot-old', confirmation)
  })

  it('keeps the current workspace intact when restart cannot be confirmed', async () => {
    const profileA = { ...profileFor('profile-a'), serverIdentity: 'server-a' }
    const currentChat = sessionFor('chat-a')
    const restart = vi.fn().mockRejectedValue(new Error('The restart request was not confirmed.'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        servers: { restart },
        native: { setBadge: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    const currentSnapshot = snapshot(currentChat.id, [eventFor(currentChat.id, 1)])
    useAppStore.setState({
      initialized: true,
      profiles: [profileA],
      activeProfileId: profileA.id,
      profileGeneration: 4,
      switchingProfileId: null,
      selectedSessionId: currentChat.id,
      sessions: [currentChat],
      snapshots: { [currentChat.id]: currentSnapshot },
      drafts: { [currentChat.id]: 'still here' },
      error: null
    })

    await expect(useAppStore.getState().restartServer('boot-old')).rejects.toThrow('not confirmed')

    const state = useAppStore.getState()
    expect(state.profileGeneration).toBe(4)
    expect(state.switchingProfileId).toBeNull()
    expect(state.snapshots[currentChat.id]).toBe(currentSnapshot)
    expect(state.drafts[currentChat.id]).toBe('still here')
    expect(state.error).toContain('not confirmed')
  })

  it('ignores a late restart bootstrap after a newer profile-switch intent wins', async () => {
    const profileA = { ...profileFor('profile-a'), serverIdentity: 'server-a' }
    const profileB = { ...profileFor('profile-b'), serverIdentity: 'server-b' }
    const restartResponse = deferred<ProfileBootstrapPayload>()
    const restart = vi.fn(() => restartResponse.promise)
    const switchProfile = vi.fn().mockResolvedValue(profileBootstrap(profileB, [profileA, profileB], 3))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        servers: { restart, switch: switchProfile },
        native: { setBadge: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true,
      profiles: [profileA, profileB],
      activeProfileId: profileA.id,
      profileGeneration: 1,
      switchingProfileId: null,
      selectedSessionId: null,
      sessions: [],
      snapshots: {},
      drafts: {},
      error: null
    })

    const restarting = useAppStore.getState().restartServer('boot-old')
    await settleMicrotasks()
    const switching = useAppStore.getState().switchServer(profileB.id)
    await expect(switching).resolves.toBe(true)
    restartResponse.resolve(profileBootstrap(profileA, [profileA, profileB], 2))
    await expect(restarting).resolves.toBe(false)

    expect(useAppStore.getState()).toEqual(expect.objectContaining({
      activeProfileId: profileB.id,
      profileGeneration: 3,
      switchingProfileId: null
    }))
  })
})

interface StartupCleanupHarnessOverrides {
  sessionsList?: () => Promise<Session[]>
  preferenceValue?: (key: string, fallback: unknown) => unknown
  timelineIndex?: (sessionId: string) => Promise<{
    session_id: string
    landmarks: []
    latest_seq: number
    event_count: number
  }>
  queuedTurns?: (sessionId: string) => Promise<QueuedTurn[]>
  fileTotal?: (sessionId: string) => number
  terminalExists?: (sessionId: string) => boolean
}

function untouchedStartupChat(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: 'New chat',
    folder: 'General',
    cwd: '/work/project',
    backend: 'codex',
    backend_locked: false,
    model: 'gpt-5.6',
    effort: 'medium',
    created_at: '2026-09-08T12:00:00Z',
    latest_event_seq: 1,
    latest_event_type: 'session_created',
    latest_agent_event_seq: 0,
    ...patch
  }
}

function startupCleanupMarker(session: Session): { version: 1; fingerprint: string } {
  return {
    version: 1,
    fingerprint: JSON.stringify({
      createdAt: session.created_at ?? null,
      title: session.title,
      folder: session.folder?.trim() || 'General',
      cwd: session.cwd?.trim() || '',
      backend: session.backend,
      model: session.model?.trim() || null,
      effort: session.effort?.trim() || null,
      systemPrompt: session.system_prompt ?? null,
      codexApprovalPolicy: session.codex_approval_policy ?? null,
      codexSandboxMode: session.codex_sandbox_mode ?? null,
      codexPermissionProfile: session.codex_permission_profile ?? null,
      codexApprovalsReviewer: session.codex_approvals_reviewer ?? null,
      claudePermissionMode: session.claude_permission_mode ?? null,
      cursorPermissionMode: session.cursor_permission_mode ?? null,
      providerJobsAccess: session.provider_jobs_access ?? null
    })
  }
}

function startupCleanupBootstrap(
  profile: PublicServerProfile,
  sessions: Session[]
): BootstrapPayload {
  return {
    settings: {
      serverUrl: profile.serverUrl,
      hasAccessToken: profile.hasAccessToken,
      serverSetupComplete: profile.serverSetupComplete
    },
    health: null,
    sessions,
    jobs: [],
    runtimeCatalog: null,
    selectedSessionId: sessions[0]?.id ?? null,
    folderOrder: [],
    collapsedFolders: [],
    archivedCollapsed: false,
    inspectorVisible: false,
    activeProfileId: profile.id,
    profiles: [profile],
    profileGeneration: 7
  }
}

function installStartupCleanupHarness(
  profile: PublicServerProfile,
  bootstrapSessions: Session[],
  overrides: StartupCleanupHarnessOverrides = {}
) {
  let currentSessions = bootstrapSessions
  const bootstrapPayload = startupCleanupBootstrap(profile, bootstrapSessions)
  const sessionsList = vi.fn(async () => {
    const sessions = overrides.sessionsList
      ? await overrides.sessionsList()
      : currentSessions
    currentSessions = sessions
    return sessions
  })
  const remove = vi.fn(async (sessionId: string) => {
    currentSessions = currentSessions.filter(session => session.id !== sessionId)
    return true
  })
  const getScoped = vi.fn(async (_scope: unknown, key: string, fallback: unknown) => {
    if (key.startsWith('directChatPlaceholder:v1:')) {
      const sessionId = key.slice('directChatPlaceholder:v1:'.length)
      const session = bootstrapSessions.find(candidate => candidate.id === sessionId)
      return session ? startupCleanupMarker(session) : fallback
    }
    return overrides.preferenceValue ? overrides.preferenceValue(key, fallback) : fallback
  })
  const setScoped = vi.fn().mockResolvedValue(undefined)
  const timelineIndex = vi.fn((sessionId: string) => overrides.timelineIndex
    ? overrides.timelineIndex(sessionId)
    : Promise.resolve({ session_id: sessionId, landmarks: [] as [], latest_seq: 1, event_count: 1 }))
  const queuedTurns = vi.fn((sessionId: string) => overrides.queuedTurns
    ? overrides.queuedTurns(sessionId)
    : Promise.resolve([] as QueuedTurn[]))
  const filesList = vi.fn(async (sessionId: string) => ({
    files: [],
    total: overrides.fileTotal?.(sessionId) ?? 0,
    offset: 0,
    limit: 1,
    has_more: false
  }))
  const terminalWindows = vi.fn(async (_profileId: string, _profileGeneration: number, sessionId: string) => ({
    session_id: sessionId,
    name: '',
    exists: overrides.terminalExists?.(sessionId) ?? false,
    windows: []
  }))
  const jobsList = vi.fn().mockResolvedValue([])
  const portsList = vi.fn().mockResolvedValue([])
  const log = vi.fn().mockResolvedValue(undefined)
  const cachedSnapshot = (sessionId: string): SessionSnapshot => ({
    session: currentSessions.find(session => session.id === sessionId) ?? sessionFor(sessionId),
    events: [eventFor(sessionId, 1, { type: 'session_created' })],
    queuedTurns: [],
    files: [],
    hasMoreEvents: false,
    filesTotal: 0,
    cachedAt: 0,
    historyVerified: true
  })

  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      bootstrap: vi.fn().mockResolvedValue(bootstrapPayload),
      sessions: { list: sessionsList, remove },
      jobs: { list: jobsList },
      ports: { list: portsList },
      preferences: {
        getScoped,
        setScoped,
        get: vi.fn(async (_key: string, fallback: unknown) => fallback),
        set: vi.fn().mockResolvedValue(undefined)
      },
      timeline: {
        index: timelineIndex,
        cached: vi.fn(async (sessionId: string) => cachedSnapshot(sessionId)),
        open: vi.fn(async (sessionId: string) => cachedSnapshot(sessionId)),
        subscribe: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined)
      },
      queue: { list: queuedTurns },
      files: { list: filesList },
      terminal: { windows: terminalWindows },
      servers: {
        refresh: vi.fn(async () => startupCleanupBootstrap(profile, currentSessions))
      },
      native: {
        analyticsDisabled: true,
        log,
        setBadge: vi.fn().mockResolvedValue(undefined)
      },
      events: { on: vi.fn().mockReturnValue(() => {}) }
    } as unknown as AgentsDockAPI
  })

  return { remove, setScoped, sessionsList, timelineIndex, log }
}

function sessionFor(id: string): Session { return { id, title: id, backend: 'codex' } }
function emergencySessionFor(id: string, patch: Partial<Session> = {}): Session {
  return {
    ...sessionFor(id),
    ...patch,
    emergency_alert: {
      id: `emergency-${id}`,
      status: 'active',
      severity: 'critical',
      message: `Immediate attention is required for ${id}.`,
      raised_at: '2026-08-25T12:00:00Z'
    },
    unacknowledged_emergency_count: 1
  }
}
function eventFor(sessionId: string, seq: number, patch: Partial<Event> = {}): Event { return { id: `${sessionId}-${seq}`, session_id: sessionId, seq, type: 'assistant_text', ts: '2026-07-09T10:00:00Z', text: String(seq), ...patch } }
function snapshot(id: string, events: Event[], hasMoreEvents = false): SessionSnapshot {
  return { session: sessionFor(id), events, queuedTurns: [], files: [], hasMoreEvents, filesTotal: 0, cachedAt: 0 }
}
function falseEmptySnapshot(id: string, latestAgentSequence: number): SessionSnapshot {
  return {
    ...snapshot(id, []),
    session: { ...sessionFor(id), latest_agent_event_seq: latestAgentSequence },
    historyVerified: false
  }
}

function profileFor(id: string): PublicServerProfile {
  return {
    id,
    name: id,
    serverUrl: `http://${id}.test`,
    hasAccessToken: false,
    serverSetupComplete: true,
    connectionState: 'offline',
    cachedUnreadCount: 0
  }
}

function profileBootstrap(
  active: PublicServerProfile,
  profiles: PublicServerProfile[],
  profileGeneration: number,
  activeSession?: Session
): ProfileBootstrapPayload {
  return {
    settings: { serverUrl: active.serverUrl, hasAccessToken: active.hasAccessToken, serverSetupComplete: active.serverSetupComplete },
    health: null,
    sessions: activeSession ? [activeSession] : [],
    jobs: [],
    runtimeCatalog: null,
    selectedSessionId: activeSession?.id ?? null,
    folderOrder: [],
    collapsedFolders: [],
    archivedCollapsed: false,
    inspectorVisible: true,
    activeProfileId: active.id,
    profiles,
    profileGeneration
  }
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
