import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import type { TeamHubStatus, TeamHubTeamDetails, TeamHubWorkspace } from '@shared/team-hub'
import type { AgentCrossChatRoute, AgentFile, ChatReference, ClaudeRuntimeSnapshot, CodexRuntimeSnapshot, CrossChatHandoffsCapability, Health, PublicServerProfile, QueuedTurn, RuntimeCatalog, Session, TeamReference } from '@shared/types'
import { queueClaudePermissionUpdate } from '../lib/claude-permission-updates'
import { queueCodexPermissionUpdate } from '../lib/codex-permission-updates'
import { closeTopTransient, resetTransientCloseStackForTests } from '../lib/transient-close'
import { loadTeamNetworkCore, loadTeamNetworkWorkspace, resetTeamNetworkSnapshotCacheForTests, seedTeamNetworkRoster } from '../lib/team-network-snapshot-cache'
import { flushActiveWorkspace, useAppStore } from '../store/app-store'
import { teamMessageLinkURL } from '../lib/team-message-links'
import { projectTeamMessageComposer } from '../lib/team-message-composer'
import { Composer, TeamMentionPalette } from './Composer'
import { ClaudeRuntimeProvider } from './ClaudeRuntimeContext'
import { CodexRuntimeProvider } from './CodexRuntimeContext'
import { CodexStatusButton } from './CodexControls'

const secureConnectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
const secureRouteId = '22e7bb2e-3b47-4be7-89fc-2cecd90f4434'

function securePeerChatReference(start = 0): ChatReference {
  return {
    session_id: secureRouteId,
    display_title_snapshot: 'Studio/training',
    source_text_start: start,
    source_text_end: start + 16,
    action: 'instruction',
    target_kind: 'secure_peer',
    target_server_identity: 'server-studio',
    target_connection_id: secureConnectionId,
    target_route_id: secureRouteId,
    target_route_revision: `rev_${'a'.repeat(32)}`
  }
}

function durableComposerCapability(overrides: Partial<CrossChatHandoffsCapability> = {}): CrossChatHandoffsCapability {
  return {
    available: true,
    required: false,
    message: '',
    action: null,
    version: 7,
    actions: ['route', 'request_reply', 'instruction', 'final_result'],
    supported_target_backends: ['codex', 'claude'],
    ...overrides,
    features: {
      route_hint_mentions: true,
      durable_route_grants: true,
      agent_cross_chat_routes: true,
      agent_ambient_local_handoffs: false,
      ...overrides.features
    },
    agent_routes: {
      client_capability: 'agent_cross_chat_routes_v2',
      policy: 'default_deny',
      actions: ['instruction', 'request_reply'],
      default_actions: ['instruction', 'request_reply'],
      ...overrides.agent_routes
    }
  }
}

function asyncAgentQueuedTurn(patch: Partial<QueuedTurn> = {}): QueuedTurn {
  return {
    queued_id: 'queued-agent', session_id: 'chat-1', source_session_id: 'chat-sender',
    source_title: 'Research agent', prompt: 'Authenticated agent message', file_ids: [], position: 1,
    purpose: 'cross_chat_handoff_delivery', conversation_mode: 'async_route_v1',
    cross_chat_envelope_id: 'envelope-1', ...patch
  }
}

function setAsyncAgentQueue(turns: QueuedTurn[]): void {
  useAppStore.setState({
    health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability({
      version: 9, features: { exact_queued_delivery_skip: true, exact_queued_delivery_reorder: true }
    }) } },
    sessions: [
      { id: 'chat-1', title: 'Chat', backend: 'codex' },
      { id: 'chat-sender', title: 'Renamed research agent', backend: 'claude' }
    ],
    snapshots: { 'chat-1': {
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      events: [], queuedTurns: turns, files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
    } }
  })
}

function grantedComposerRoute(
  targetSessionId = 'chat-2',
  title = 'Target',
  actions: AgentCrossChatRoute['actions'] = ['instruction', 'request_reply']
): AgentCrossChatRoute {
  return {
    route_id: `route-${targetSessionId}`,
    revision: `rev_${'a'.repeat(32)}`,
    alias: title.toLowerCase().replace(/\s+/g, '-'),
    target_session_id: targetSessionId,
    actions,
    created_at: '2026-08-27T00:00:00Z',
    updated_at: '2026-08-27T00:00:00Z',
    target: {
      title,
      folder: null,
      backend: 'claude',
      available: true,
      unavailable_reason: null
    }
  }
}

function teamMessagesHealth(): Health {
  return {
    ok: true,
    capabilities: {
      agent_team_messages_v1: {
        available: true, required: false, message: 'ready', action: null,
        version: 1, helper: 'team' as const, mention_sigil: '@@' as const,
        read_always: true as const, send_requires_mention: true as const,
        recipient_kinds: ['server', 'human', 'all'] as const,
        reference_kinds: ['recipient', 'skill'] as const,
        max_sends_per_run: 4, max_attachments_per_send: 16, max_body_bytes: 49_152
      },
      team_bulletin_alias_v1: {
        available: true, required: false, version: 1,
        mention: '@@bulletin', legacy_mention: '@@all'
      },
      team_all_servers_alias_v1: {
        available: true, version: 1, mention: '@@all', recipient_kind: 'all_servers',
        max_recipients_per_message: 1024
      }
    }
  }
}

function teamRecipientReference(start: number): TeamReference {
  return {
    kind: 'recipient', recipient_kind: 'human', team_id: 'team-1', target_id: 'person-1',
    display_name_snapshot: 'DPark', source_text_start: start, source_text_end: start + 7, grant_intent: true
  }
}

const realRequestNewChat = useAppStore.getState().requestNewChat

describe('Composer', () => {
  afterEach(() => {
    cleanup()
    setLocale('en')
    resetTransientCloseStackForTests()
    useAppStore.setState({ requestNewChat: realRequestNewChat })
    vi.useRealTimers()
  })

  beforeEach(() => {
    resetTeamNetworkSnapshotCacheForTests()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a',
      profileGeneration: 0,
      profiles: [],
      switchingProfileId: null,
      connected: false,
      connectionGeneration: 0,
      syncStatus: 'live',
      syncError: null,
      syncBySession: { 'chat-1': { status: 'live', error: null } },
      selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: null },
      focusedChatPane: 'primary',
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      snapshots: {},
      uploadsBySession: {},
      uploadPathsBySession: {},
      drafts: {},
      chatReferencesBySession: {},
      teamReferencesBySession: {},
      agentRoutesBySession: {},
      agentRouteLoadingSessionIds: new Set(),
      agentRouteErrorsBySession: {},
      revokingAgentRouteIds: new Set(),
      activeSessionIds: new Set(),
      turnAdmissionTokens: {},
      pendingTurnSubmissions: {},
      stoppingSessionIds: new Set(),
      runtimeCatalog: null,
      health: null,
      error: null,
    })
  })

  it('mounts with empty per-chat upload state without an external-store render loop', () => {
    render(<Composer />)
    expect(screen.getByPlaceholderText('Message')).toBeInTheDocument()
  })

  it('shows an active-turn submission immediately in the queue shelf', () => {
    useAppStore.setState({
      activeSessionIds: new Set(['chat-1']),
      pendingTurnSubmissions: {
        'chat-1': {
          token: 'queue-admission', prompt: 'Follow up after the current task', files: [], uploadPaths: [],
          chatReferences: [], teamReferences: [], createdAt: Date.now(), afterSeq: 4,
          mode: 'queue', phase: 'submitting', consumeComposer: true
        }
      }
    })

    const view = render(<Composer />)

    expect(view.container.querySelector('.queue-shelf')).toHaveTextContent('Queued turns1')
    expect(view.container.querySelector('.queued-row.local-pending')).toHaveTextContent('Follow up after the current task')
    expect(view.container.querySelector('.queued-row.local-pending')).toHaveTextContent('Adding to queue…')
    expect(view.container.querySelector('.queued-row.local-pending button')).toBeNull()
  })

  it('keeps an offline shared-chat draft editable while gating message and attachment writes', () => {
    const send = vi.fn()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      ...window.agentsDock,
      sharedChat: true,
      turns: { send } as unknown as AgentsDockAPI['turns']
    } })
    const view = render(<Composer writeDisabled />)
    const editor = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(editor, { target: { value: 'Draft while offline' } })
    expect(editor).toBeEnabled()
    expect(editor).toHaveValue('Draft while offline')
    expect(view.container.querySelector('.send-button')).toBeDisabled()
    expect(view.container.querySelector('.composer-add-button')).toBeDisabled()
    expect(view.container.querySelector('.composer-goal-controls')).toBeDisabled()
    expect(view.container.querySelector('.composer-queue-controls')).toBeDisabled()
    expect(view.container.querySelector('.composer-write-controls')).toBeDisabled()
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(send).not.toHaveBeenCalled()
  })

  it('does no Team Network work on ordinary chat mount, typing, or idle', async () => {
    vi.useFakeTimers()
    const status = vi.fn()
    const connect = vi.fn()
    window.agentsDock.teamHub = { status, connect } as unknown as AgentsDockAPI['teamHub']
    useAppStore.setState({
      connected: true, health: teamMessagesHealth(),
      profiles: [{ id: 'profile-a', name: 'A', serverUrl: 'http://localhost:7850', serverIdentity: 'server-a', hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 }]
    })
    render(<Composer />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'An ordinary message' } })
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(status).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it.each([true, false])('opens @@ after switching to an existing managed host and respects reconnect permission=%s', async allowed => {
    const disconnected: TeamHubStatus = {
      version: 1, profileId: 'profile-b', profileGeneration: 9, serverIdentity: 'server-b', serverName: 'B', generation: 2,
      hubUrl: null, hubIdentity: null, savedHubIdentity: null, transport: null, designatedHost: false,
      availabilityMessage: null, availabilityAction: null, canForgetBinding: false, serverManaged: true,
      backgroundReconnectAllowed: allowed, connectionState: allowed ? 'disconnected' : 'signed-out', authenticated: false,
      bootstrapRequired: false, principal: null, session: null, error: null
    }
    const ready: TeamHubStatus = {
      ...disconnected, generation: 3, connectionState: 'authenticated', authenticated: true,
      hubIdentity: 'hub-b', hubUrl: 'https://hub.test', transport: 'loopback',
      principal: { id: 'service-b', display_name: 'B' },
      session: { id: 'session-b', device_label: 'B', expires_at: '2027-01-01T00:00:00Z' }
    }
    const connect = vi.fn().mockResolvedValue(ready)
    const workspace = vi.fn().mockResolvedValue({ status: ready, teams: [{ id: 'team-b', kind: 'shared', slug: 'b', display_name: 'B', role: 'owner', status: 'active' }] })
    window.agentsDock.teamHub = {
      status: vi.fn().mockResolvedValue(disconnected), connect, workspace,
      teamMessagesCapabilities: vi.fn().mockResolvedValue({ available: true, version: 1 }),
      network: vi.fn().mockResolvedValue({
        network: { id: 'team-b', display_name: 'B', hub_id: 'hub-b' },
        servers: [{ id: 'node-other', server_identity: 'server-other', display_name: 'Other server', status: 'active', is_host: false, owned_by_caller: false }],
        agents: [], next_after_server_id: null, has_more: false
      })
    } as unknown as AgentsDockAPI['teamHub']
    useAppStore.setState({ activeProfileId: 'profile-b', profileGeneration: 9, health: teamMessagesHealth() })
    render(<StrictMode><TeamMentionPalette
      id="switched-host-destinations" mention={{ kind: '@@', start: 0, end: 2, query: '' }} selectedIndex={0} supported
      profileId="profile-b" profileGeneration={9} serverIdentity="server-b"
      onCandidates={vi.fn()} onHighlight={vi.fn()} onSelect={vi.fn()}
    /></StrictMode>)
    if (allowed) {
      expect(await screen.findByRole('option', { name: /Other server/ })).toBeVisible()
      expect(connect).toHaveBeenCalledExactlyOnceWith({ surfaceReconnect: {
        profileId: 'profile-b', profileGeneration: 9, serverIdentity: 'server-b', generation: 2
      } })
    } else {
      expect(await screen.findByText('Connect to Team Network to choose a recipient.')).toBeVisible()
      expect(connect).not.toHaveBeenCalled()
      expect(workspace).not.toHaveBeenCalled()
    }
  })

  it.each([false, true])('shows source-scoped Mail grants and revokes without selecting a mention (revision conflict=%s)', async conflict => {
    const status: TeamHubStatus = {
      version: 1, profileId: 'profile-a', profileGeneration: 0, serverIdentity: 'server-a', serverName: 'A', generation: 1,
      hubUrl: 'https://hub.test', hubIdentity: 'hub-a', savedHubIdentity: 'hub-a', transport: 'loopback', designatedHost: true,
      availabilityMessage: null, availabilityAction: null, canForgetBinding: true, connectionState: 'authenticated', authenticated: true,
      bootstrapRequired: false, principal: { id: 'service-a', display_name: 'A' },
      session: { id: 'session-a', device_label: 'A', expires_at: '2027-01-01T00:00:00Z' }, error: null
    }
    window.agentsDock.teamHub = {
      status: vi.fn().mockResolvedValue(status),
      teamMessagesCapabilities: vi.fn().mockResolvedValue({ available: true, version: 1 }),
      workspace: vi.fn().mockResolvedValue({ status, teams: [{ id: 'team-mail', kind: 'shared', slug: 'mail', display_name: 'Mail', role: 'owner', status: 'active' }] }),
      network: vi.fn().mockResolvedValue({ network: { id: 'team-mail', display_name: 'Mail', hub_id: 'hub-a' },
        servers: [{ id: 'node-mail', server_identity: 'server-mail', display_name: 'Recipient', status: 'active', is_host: false, owned_by_caller: false }],
        agents: [], next_after_server_id: null, has_more: false })
    } as unknown as AgentsDockAPI['teamHub']
    const grant = { route_id: 'mailgrant-one', revision: 'rev-one', display_name: 'Recipient', recipient_kind: 'server' as const,
      team_id: 'team-mail', target_id: 'node-mail', available: true, unavailable_reason: null, created_at: '', updated_at: '' }
    const detached = { ...grant, route_id: 'mailgrant-two', target_id: 'node-gone', display_name: 'Departed server', available: false, unavailable_reason: 'target_unavailable' as const }
    const list = vi.fn().mockResolvedValueOnce({ routes: [grant, detached], max_routes: 16 })
      .mockResolvedValue({ routes: conflict ? [{ ...grant, revision: 'rev-new' }, detached] : [detached], max_routes: 16 })
    const remove = vi.fn().mockResolvedValue(conflict ? { status: 'revision_conflict' } : { status: 'deleted', deleted: true, route_id: grant.route_id })
    window.agentsDock.agentTeamMailRoutes = { list, remove }
    useAppStore.setState({ health: { ...teamMessagesHealth(), capabilities: { ...teamMessagesHealth().capabilities,
      agent_team_mail_routes_v1: { available: true, version: 1, max_routes: 16 } } },
      profiles: [{ id: 'profile-a', name: 'A', serverUrl: 'http://localhost:7850', serverIdentity: 'server-a', hasAccessToken: true,
        serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 }] })
    const onSelect = vi.fn()
    const props = { id: 'mail-grants', sourceSessionId: 'chat-1', mention: { kind: '@@' as const, start: 0, end: 2, query: '' },
      selectedIndex: 0, supported: true, profileId: 'profile-a', profileGeneration: 0, serverIdentity: 'server-a',
      onCandidates: vi.fn(), onHighlight: vi.fn(), onSelect }
    const view = render(<StrictMode><TeamMentionPalette {...props} /></StrictMode>)
    expect(await screen.findByRole('option', { name: /Recipient.*Mail granted/ })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Revoke Mail access to Departed server' })).toBeVisible()
    expect(list).toHaveBeenCalledTimes(1)
    const networkReads = vi.mocked(window.agentsDock.teamHub.network).mock.calls.length
    act(() => setLocale('zh-CN'))
    expect(screen.getByRole('listbox', { name: '团队网络目标' })).toBeVisible()
    expect(screen.getByRole('button', { name: '撤销对Recipient的信箱访问权限' })).toBeVisible()
    expect(list).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(window.agentsDock.teamHub.network).toHaveBeenCalledTimes(networkReads)
    act(() => setLocale('en'))
    view.rerender(<StrictMode><TeamMentionPalette {...props} mention={{ ...props.mention, query: 'Recipient' }} /></StrictMode>)
    expect(list).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Mail access to Recipient' }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(remove).toHaveBeenCalledExactlyOnceWith({ profileId: 'profile-a', profileGeneration: 0, serverIdentity: 'server-a' }, 'chat-1', 'mailgrant-one', 'rev-one')
    if (conflict) expect(await screen.findByText('This Mail grant changed. Review it and revoke again.')).toBeVisible()
    else await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke Mail access to Recipient' })).not.toBeInTheDocument())
    expect(onSelect).not.toHaveBeenCalled()
  })

  it.each(['workspace', 'roster', 'alias-only'] as const)('revalidates a cached negative %s once on explicit @@ opening', async negativeCache => {
    const status: TeamHubStatus = {
      version: 1, profileId: 'profile-a', profileGeneration: 4, serverIdentity: 'server-local', serverName: 'Local', generation: 3,
      hubUrl: 'https://hub.test', hubIdentity: 'hub-1', savedHubIdentity: 'hub-1', transport: 'loopback', designatedHost: true,
      availabilityMessage: null, availabilityAction: null, canForgetBinding: true, connectionState: 'authenticated', authenticated: true,
      bootstrapRequired: false, principal: { id: 'service-local', display_name: 'Local' },
      session: { id: 'session-local', device_label: 'Local', expires_at: '2027-01-01T00:00:00Z' }, error: null
    }
    const workspace: TeamHubWorkspace = { status, teams: [{ id: 'team-1', kind: 'shared', slug: 'core', display_name: 'Core', role: 'owner', status: 'active' }] }
    const selfOnly = {
      network: { id: 'team-1', display_name: 'Core', hub_id: 'hub-1' },
      servers: [{ id: 'local', server_identity: 'server-local', display_name: 'Local', status: 'active' as const, owned_by_caller: true, is_host: true }],
      agents: [], next_after_server_id: null, has_more: false
    }
    const joined = { ...selfOnly, servers: [...selfOnly.servers, {
      id: 'new-offline', server_identity: 'server-new', display_name: 'New guest server', status: 'offline' as const, owned_by_caller: false, is_host: false
    }] }
    const loadWorkspace = vi.fn().mockResolvedValue(negativeCache === 'workspace' ? { status, teams: [] } : workspace)
    const loadNetwork = vi.fn().mockResolvedValue(negativeCache === 'alias-only' ? selfOnly : joined)
    window.agentsDock.teamHub = {
      status: vi.fn().mockResolvedValue(status), workspace: loadWorkspace, network: loadNetwork,
      teamMessagesCapabilities: vi.fn().mockResolvedValue({ available: true, version: 1 })
    } as unknown as AgentsDockAPI['teamHub']
    useAppStore.setState({ health: teamMessagesHealth() })
    await loadTeamNetworkWorkspace(status)
    loadWorkspace.mockResolvedValue(workspace)
    if (negativeCache === 'roster') seedTeamNetworkRoster(status, 'team-1', selfOnly)
    const props = {
      id: 'negative-cache', mention: { kind: '@@' as const, start: 0, end: 2, query: '' }, selectedIndex: 0, supported: true,
      profileId: 'profile-a', profileGeneration: 4, serverIdentity: 'server-local',
      onCandidates: vi.fn(), onHighlight: vi.fn(), onSelect: vi.fn()
    }
    let view = render(<StrictMode><TeamMentionPalette {...props} /></StrictMode>)
    if (negativeCache === 'alias-only') {
      expect(await screen.findByRole('option', { name: /Bulletin.*@@bulletin/ })).toBeVisible()
      expect(screen.queryByRole('option', { name: /New guest server/ })).not.toBeInTheDocument()
      expect(loadNetwork).toHaveBeenCalledOnce()
      view.unmount()
      loadNetwork.mockResolvedValue(joined)
      view = render(<StrictMode><TeamMentionPalette {...props} /></StrictMode>)
    }
    expect(await screen.findByRole('option', { name: /New guest server/ })).toHaveTextContent('Offline · inbox available')
    expect(loadNetwork).toHaveBeenCalledTimes(negativeCache === 'alias-only' ? 2 : 1)
    expect(loadWorkspace).toHaveBeenCalledTimes(negativeCache === 'workspace' ? 2 : 1)
    if (negativeCache === 'alias-only') {
      const reads = loadNetwork.mock.calls.length
      act(() => setLocale('zh-CN'))
      view.rerender(<StrictMode><TeamMentionPalette {...props} mention={{ ...props.mention, query: '公告' }} /></StrictMode>)
      fireEvent.click(screen.getByRole('option', { name: /公告.*@@bulletin/ }))
      expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({
        label: 'Bulletin', code: '@@bulletin',
        target: { kind: 'recipient', recipient_kind: 'all', team_id: 'team-1', target_id: 'all', display_name_snapshot: 'bulletin' }
      }))
      expect(loadNetwork).toHaveBeenCalledTimes(reads)
      act(() => setLocale('en'))
    }
    view.rerender(<StrictMode><TeamMentionPalette {...props} mention={{ ...props.mention, query: 'New' }} /></StrictMode>)
    expect(screen.getByRole('option', { name: /New guest server/ })).toBeVisible()
    expect(loadNetwork).toHaveBeenCalledTimes(negativeCache === 'alias-only' ? 2 : 1)
  })

  it.each(['feed', 'mail'] as const)('opens the exact routed %s message from a blue link inside the input without sending or changing the draft', section => {
    const target = {
      section, teamId: 'team-1', messageId: 'message-original',
      mailboxBox: 'inbox' as const, serverIdentity: 'server-a'
    }
    const send = vi.fn()
    window.agentsDock.turns = { send } as unknown as AgentsDockAPI['turns']
    const draft = `Existing note\n\nRead [Original message](${teamMessageLinkURL(target)}) from @@Studio`
    const displayed = 'Existing note\n\nRead Original message from @@Studio'
    useAppStore.setState({ drafts: { 'chat-1': draft } })
    const opened = vi.fn()
    window.addEventListener('agentsdock:open-teamspace', opened, { once: true })
    render(<Composer />)

    const link = screen.getByRole('link', { name: 'Original message' })
    expect(link.closest('.composer-editor')).not.toBeNull()
    const preview = link.parentElement!
    expect(preview).toHaveClass('composer-editor-mirror')
    expect(preview.textContent).toBe('Existing note\n\nRead Original message from @@Studio')
    expect(preview.textContent).not.toContain('agentsdock://')
    fireEvent.click(link)

    expect(opened).toHaveBeenCalledOnce()
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual(target)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(displayed)
    expect(useAppStore.getState().drafts['chat-1']).toBe(draft)
    expect(send).not.toHaveBeenCalled()

    const editor = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.click(preview)
    expect(editor).toHaveFocus()
    expect(link).toBeVisible()
    expect(editor).toHaveValue(displayed)
    fireEvent.change(editor, { target: { value: `${displayed} edited` } })
    fireEvent.blur(editor)
    expect(screen.getByLabelText('Message preview').textContent).toBe('Existing note\n\nRead Original message from @@Studio edited')
    expect(screen.getByRole('textbox', { name: 'Message' })).toBe(editor)
    expect(editor).toHaveValue(`${displayed} edited`)
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps a focused routed bulletin readable and preserves the exact source, recipient and attachment through edits', async () => {
    vi.useFakeTimers()
    const target = { section: 'feed' as const, teamId: 'team-1', messageId: 'run01', serverIdentity: `server-${'a'.repeat(60)}` }
    const label = 'DEMO-A Run01 runbook (queue-driven ATLAS integration-test recovery)'
    const draft = `Read [${label}](${teamMessageLinkURL(target)}) from @@bulletin`
    const mentionStart = draft.indexOf('@@bulletin')
    const reference: TeamReference = {
      kind: 'recipient', recipient_kind: 'all', team_id: 'team-1', target_id: 'all',
      display_name_snapshot: 'bulletin', source_text_start: mentionStart,
      source_text_end: mentionStart + '@@bulletin'.length, grant_intent: true
    }
    const attachment: AgentFile = { id: 'file-1', filename: 'notes.txt', size: 42, content_type: 'text/plain' }
    useAppStore.setState({
      drafts: { 'chat-1': draft }, health: teamMessagesHealth(),
      teamReferencesBySession: { 'chat-1': [reference] }, uploadsBySession: { 'chat-1': [attachment] }
    })
    render(<Composer />)
    const editor = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    fireEvent.focus(editor)
    expect(editor).toHaveValue(`Read ${label} from @@bulletin`)
    expect(editor.parentElement).toHaveClass('has-message-links', 'has-inline-references')
    expect(screen.queryByRole('group', { name: 'Selected message references' })).not.toBeInTheDocument()
    const link = screen.getByRole('link', { name: label })
    expect(link).toHaveAttribute('href', teamMessageLinkURL(target))
    const appended = `${editor.value}\nPlease review.`
    fireEvent.change(editor, { target: { value: appended, selectionStart: appended.length, selectionEnd: appended.length } })
    const next = `🧭 Notes\n\n${editor.value}`
    fireEvent.change(editor, { target: { value: next, selectionStart: next.length, selectionEnd: next.length } })
    expect(editor.selectionStart).toBe(next.length)
    await act(async () => vi.advanceTimersByTimeAsync(450))
    const stored = useAppStore.getState().drafts['chat-1']
    expect(stored).toBe(`🧭 Notes\n\n${draft}\nPlease review.`)
    expect(useAppStore.getState().teamReferencesBySession['chat-1']).toEqual([{
      ...reference, source_text_start: mentionStart + '🧭 Notes\n\n'.length,
      source_text_end: reference.source_text_end + '🧭 Notes\n\n'.length
    }])
    expect(useAppStore.getState().uploadsBySession['chat-1']).toEqual([attachment])
    expect(projectTeamMessageComposer(stored!).text).toBe(editor.value)
  })

  it('navigates and deletes projected links atomically without exposing or corrupting their URLs', () => {
    const href = teamMessageLinkURL({ section: 'mail', teamId: 'team-1', messageId: 'message-1', mailboxBox: 'sent' })
    const draft = `🧭 Read [Original](${href}) now`
    useAppStore.setState({ drafts: { 'chat-1': draft } })
    render(<Composer />)
    const editor = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    const start = editor.value.indexOf('Original')
    editor.setSelectionRange(start, start)
    fireEvent.keyDown(editor, { key: 'ArrowRight' })
    expect(editor.selectionStart).toBe(start + 'Original'.length)
    fireEvent.keyDown(editor, { key: 'ArrowLeft' })
    expect(editor.selectionStart).toBe(start)
    fireEvent.keyDown(editor, { key: 'Delete' })
    expect(editor).toHaveValue('🧭 Read now')
    expect(editor.selectionStart).toBe(start)
    expect(screen.queryByRole('link', { name: 'Original' })).not.toBeInTheDocument()
  })

  it('normalizes native partial-label replacement and preserves the resulting UTF-16 selection', () => {
    const href = teamMessageLinkURL({ section: 'feed', teamId: 'team-1', messageId: 'message-1' })
    useAppStore.setState({ drafts: { 'chat-1': `🧭 Read [Original](${href}) now` } })
    render(<Composer />)
    const editor = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    const offset = editor.value.indexOf('rig')
    const next = editor.value.slice(0, offset) + '🧪' + editor.value.slice(offset + 3)
    fireEvent.change(editor, { target: { value: next, selectionStart: offset + 2, selectionEnd: offset + 2 } })
    expect(editor).toHaveValue('🧭 Read 🧪 now')
    expect(editor.selectionStart).toBe('🧭 Read 🧪'.length)
    expect(editor.selectionEnd).toBe(editor.selectionStart)
  })

  it('keeps the second exact target after a native cut removes the first identical link label', async () => {
    vi.useFakeTimers()
    const first = teamMessageLinkURL({ section: 'feed', teamId: 'team-1', messageId: 'first' })
    const second = teamMessageLinkURL({ section: 'feed', teamId: 'team-1', messageId: 'second' })
    useAppStore.setState({ drafts: { 'chat-1': `[Same](${first})[Same](${second})` } })
    render(<Composer />)
    const editor = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    editor.setSelectionRange(0, 4)
    fireEvent.cut(editor)
    fireEvent.change(editor, { target: { value: 'Same', selectionStart: 0, selectionEnd: 0 } })
    expect(editor).toHaveValue('Same')
    expect(editor.selectionStart).toBe(0)
    expect(screen.getByRole('link', { name: 'Same' })).toHaveAttribute('href', second)
    await act(async () => vi.advanceTimersByTimeAsync(450))
    expect(useAppStore.getState().drafts['chat-1']).toBe(`[Same](${second})`)
  })

  it('keeps an existing link on the correct occurrence when native paste inserts an identical title before it', async () => {
    vi.useFakeTimers()
    const href = teamMessageLinkURL({ section: 'feed', teamId: 'team-1', messageId: 'original' })
    useAppStore.setState({ drafts: { 'chat-1': `[Same](${href})` } })
    render(<Composer />)
    const editor = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    editor.setSelectionRange(0, 0)
    fireEvent.paste(editor, { clipboardData: { files: [], getData: () => 'Same' } })
    fireEvent.change(editor, { target: { value: 'SameSame', selectionStart: 4, selectionEnd: 4 } })
    expect(editor).toHaveValue('SameSame')
    expect(editor.selectionStart).toBe(4)
    expect(screen.getByRole('link', { name: 'Same' }).previousSibling?.textContent).toBe('Same')
    await act(async () => vi.advanceTimersByTimeAsync(450))
    expect(useAppStore.getState().drafts['chat-1']).toBe(`Same[Same](${href})`)
  })

  it('removes the target when native paste replaces a selected link with the same plain title', async () => {
    vi.useFakeTimers()
    const href = teamMessageLinkURL({ section: 'feed', teamId: 'team-1', messageId: 'original' })
    useAppStore.setState({ drafts: { 'chat-1': `[Same](${href})` } })
    render(<Composer />)
    const editor = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    editor.setSelectionRange(0, 4)
    fireEvent.paste(editor, { clipboardData: { files: [], getData: () => 'Same' } })
    editor.setSelectionRange(4, 4)
    fireEvent.input(editor, { inputType: 'insertFromPaste', data: 'Same' })
    expect(editor).toHaveValue('Same')
    expect(editor.selectionStart).toBe(4)
    expect(screen.queryByRole('link', { name: 'Same' })).not.toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(450))
    expect(useAppStore.getState().drafts['chat-1']).toBe('Same')
  })

  it('discards a delayed slash-command picker result after its profile changes', async () => {
    const chosen = deferred<Array<{ path: string; name: string }>>()
    const attachPathsForSession = vi.fn().mockResolvedValue(undefined)
    const originalAttach = useAppStore.getState().attachPathsForSession
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        files: { choose: vi.fn(() => chosen.promise) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ attachPathsForSession })
    render(<Composer />)

    const editor = screen.getByPlaceholderText('Message')
    fireEvent.change(editor, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('option', { name: /Attach files/ }))
    expect(window.agentsDock.files.choose).toHaveBeenCalledOnce()

    act(() => useAppStore.setState({ activeProfileId: 'profile-b', profileGeneration: 1 }))
    await act(async () => chosen.resolve([{ path: '/tmp/stale.txt', name: 'stale.txt' }]))

    expect(attachPathsForSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toBeNull()
    useAppStore.setState({ attachPathsForSession: originalAttach })
  })

  it('contains a delayed Add-menu picker rejection after the composer unmounts', async () => {
    const chosen = deferred<Array<{ path: string; name: string }>>()
    const user = userEvent.setup()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        files: { choose: vi.fn(() => chosen.promise) }
      } as unknown as AgentsDockAPI
    })
    const view = render(<Composer />)

    await user.click(screen.getByTitle('Add'))
    await user.click(await screen.findByRole('menuitem', { name: 'Attach files' }))
    expect(window.agentsDock.files.choose).toHaveBeenCalledOnce()

    view.unmount()
    await act(async () => chosen.reject(new Error('Picker closed during teardown')))

    expect(useAppStore.getState().error).toBeNull()
  })

  it('uses the native textarea for pasted plain text so its glyphs stay aligned with the caret', async () => {
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message') as HTMLTextAreaElement
    const pasted = [
      'This is the first pasted paragraph and it wraps naturally in the composer.',
      '',
      'This is the second paragraph after a deliberate blank line.',
      '/Volumes/Dev/agi/ZenithDock-cross-chat-dedupe/electron/src/renderer/src/components/Composer.tsx'
    ].join('\n')
    Object.defineProperty(editor, 'scrollHeight', { configurable: true, get: () => 260 })
    Object.defineProperty(editor, 'clientHeight', {
      configurable: true,
      get: () => Number.parseFloat(editor.style.height) || 46
    })
    editor.scrollTop = 214

    fireEvent.change(editor, {
      target: { value: pasted, selectionStart: pasted.length, selectionEnd: pasted.length }
    })

    expect(editor).toHaveValue(pasted)
    await waitFor(() => expect(editor.style.height).toBe('190px'))
    expect(editor.style.overflowY).toBe('auto')
    expect(editor.scrollTop).toBe(70)
    expect(editor.selectionStart).toBe(pasted.length)
    expect(editor.selectionEnd).toBe(pasted.length)
    expect(editor.parentElement).toHaveClass('composer-editor')
    expect(editor.parentElement).not.toHaveClass('has-inline-references')
    expect(editor.parentElement?.querySelector('.composer-editor-mirror')).not.toBeInTheDocument()
  })

  it('keeps ordinary typing local until the idle draft sync', async () => {
    vi.useFakeTimers()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')
    const appStoreChange = vi.fn()
    const unsubscribe = useAppStore.subscribe(appStoreChange)

    fireEvent.change(editor, { target: { value: 'Fast typing', selectionStart: 11 } })

    expect(editor).toHaveValue('Fast typing')
    expect(useAppStore.getState().drafts['chat-1']).toBeUndefined()
    expect(appStoreChange).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(449))
    expect(useAppStore.getState().drafts['chat-1']).toBeUndefined()
    expect(appStoreChange).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(useAppStore.getState().drafts['chat-1']).toBe('Fast typing')
    expect(appStoreChange).toHaveBeenCalled()
    unsubscribe()
  })

  it('does not restore a consumed message from a late persisted-draft read', async () => {
    const persistedDraft = deferred<string>()
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, queued: false
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: {
          get: vi.fn((key: string, fallback: unknown) => key === 'draft:chat-1'
            ? persistedDraft.promise
            : Promise.resolve(fallback)),
          set: vi.fn().mockResolvedValue(undefined)
        },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, 'Already sent')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(editor).toHaveValue('')
    expect(useAppStore.getState().drafts['chat-1']).toBe('')

    await act(async () => persistedDraft.resolve('Already sent'))

    expect(editor).toHaveValue('')
    expect(useAppStore.getState().drafts['chat-1']).toBe('')
  })

  it('leaves text paste native and preserves whitespace plus UTF-16 selection offsets', () => {
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message') as HTMLTextAreaElement
    const pasted = 'alpha\tbeta\nnon-breaking:\u00a0space\nzero-width:\u200bmarker'

    expect(fireEvent.paste(editor, {
      clipboardData: { files: [], getData: () => pasted }
    })).toBe(true)
    fireEvent.change(editor, {
      target: { value: pasted, selectionStart: pasted.length, selectionEnd: pasted.length }
    })

    expect(editor).toHaveValue(pasted)
    expect(editor.selectionStart).toBe(pasted.length)
    expect(editor.selectionEnd).toBe(pasted.length)
    expect(editor.parentElement?.querySelector('.composer-editor-mirror')).not.toBeInTheDocument()
  })

  it('surfaces an asynchronous native staging rejection from an image paste', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        files: { stageNativeFile: vi.fn().mockRejectedValue(new Error('Clipboard staging denied')) }
      } as unknown as AgentsDockAPI
    })
    render(<Composer />)

    fireEvent.paste(screen.getByPlaceholderText('Message'), {
      clipboardData: { files: [new File(['image'], 'private.png', { type: 'image/png' })], getData: () => '' }
    })

    await waitFor(() => expect(useAppStore.getState().error).toBe('Clipboard staging denied'))
  })

  it('keeps a structured route hint visible after a long pasted checkpoint path', () => {
    const checkpoint = `demo:/fixtures/checkpoints/${'synthetic-model-variant/'.repeat(8)}exports/model_step_001000`
    expect(checkpoint.length).toBeGreaterThan(200)
    const draft = [
      'Set up the sample environment using the demo branch.',
      '',
      `Evaluate ${checkpoint} with the synthetic dataset and compare the three demo configurations. Produce one report for each configuration: baseline version 1, baseline version 2, and the candidate version.`,
      '',
      'Talk to @TargetApp to gather information about the synthetic checkpoint structure.'
    ].join('\n')
    const mentionStart = draft.indexOf('@TargetApp')
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'TargetApp', backend: 'claude' }
      ],
      drafts: { 'chat-1': draft },
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability() } },
      chatReferencesBySession: { 'chat-1': [{
        session_id: 'chat-2', display_title_snapshot: 'TargetApp',
        source_text_start: mentionStart, source_text_end: mentionStart + '@TargetApp'.length, action: 'route', grant_intent: true
      }] }
    })

    render(<Composer />)

    const editor = screen.getByPlaceholderText('Message') as HTMLTextAreaElement
    editor.setSelectionRange(mentionStart + '@TargetApp'.length, mentionStart + '@TargetApp'.length)
    expect(editor).toHaveValue(draft)
    expect(editor.parentElement).not.toHaveClass('has-inline-references')
    expect(editor.parentElement?.querySelector('.composer-editor-mirror')).not.toBeInTheDocument()
    const fallback = screen.getByRole('group', { name: 'Selected message references' })
    expect(within(fallback).getByTitle('@TargetApp · Route hint')).toHaveClass('composer-inline-reference', 'action-route')
    expect(editor.selectionStart).toBe(mentionStart + '@TargetApp'.length)
    expect(editor.selectionEnd).toBe(mentionStart + '@TargetApp'.length)
  })

  it('shows the structured-reference fallback when measured mirror geometry diverges', () => {
    const draft = 'Talk to @TargetApp'
    const mentionStart = draft.indexOf('@TargetApp')
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'TargetApp', backend: 'claude' }
      ],
      drafts: { 'chat-1': draft },
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability() } },
      chatReferencesBySession: { 'chat-1': [{
        session_id: 'chat-2', display_title_snapshot: 'TargetApp',
        source_text_start: mentionStart, source_text_end: mentionStart + '@TargetApp'.length, action: 'route', grant_intent: true
      }] }
    })

    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message') as HTMLTextAreaElement
    const mirror = editor.parentElement?.querySelector('.composer-editor-mirror') as HTMLDivElement
    editor.setSelectionRange(8, 8)
    Object.defineProperties(editor, {
      clientWidth: { configurable: true, get: () => 470 },
      clientHeight: { configurable: true, get: () => 46 },
      scrollHeight: { configurable: true, get: () => 46 },
      scrollWidth: { configurable: true, get: () => 470 }
    })
    Object.defineProperties(mirror, {
      scrollHeight: { configurable: true, get: () => 68 },
      scrollWidth: { configurable: true, get: () => 470 }
    })

    fireEvent.scroll(editor)

    expect(mirror).toHaveStyle({ visibility: 'hidden' })
    expect(within(screen.getByRole('group', { name: 'Selected message references' })).getByText('@TargetApp')).toBeVisible()
    expect(editor.selectionStart).toBe(8)
    expect(editor.selectionEnd).toBe(8)
  })

  it('preserves single-@ chat and double-@@ Team Network labels in the fallback rail', () => {
    const draft = `${'checkpoint/'.repeat(8)}\nAsk @Training and notify @@Pat`
    const chatStart = draft.indexOf('@Training')
    const teamStart = draft.indexOf('@@Pat')
    const teamHealth = teamMessagesHealth()
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ],
      drafts: { 'chat-1': draft },
      health: { ...teamHealth, capabilities: {
        ...teamHealth.capabilities,
        cross_chat_handoffs_v1: durableComposerCapability()
      } },
      chatReferencesBySession: { 'chat-1': [{
        session_id: 'chat-2', display_title_snapshot: 'Training',
        source_text_start: chatStart, source_text_end: chatStart + 9, action: 'route', grant_intent: true
      }] },
      teamReferencesBySession: { 'chat-1': [{
        kind: 'recipient', recipient_kind: 'server', team_id: 'team-1', target_id: 'node-atlas',
        display_name_snapshot: 'Pat', source_text_start: teamStart, source_text_end: teamStart + 5, grant_intent: true
      }] }
    })

    render(<Composer />)

    const fallback = screen.getByRole('group', { name: 'Selected message references' })
    expect(within(fallback).getByTitle('@Training · Route hint')).toHaveAttribute('data-chat-reference-action', 'route')
    expect(within(fallback).getByTitle('@@Pat · Team server')).toHaveAttribute('data-team-reference-kind', 'recipient')
    expect(screen.getByPlaceholderText('Message')).toHaveValue(draft)
  })

  it('separates Bulletin, all-server Team Mail, and individual server references', async () => {
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, queued: false
    })
    const storedPreferences = new Map<string, unknown>()
    const persist = vi.fn(async (key: string, value: unknown) => { storedPreferences.set(key, value) })
    const readPreference = vi.fn(async (key: string, fallback: unknown) => (
      storedPreferences.has(key) ? storedPreferences.get(key) : fallback
    ))
    const status = {
      version: 1 as const,
      profileId: 'profile-a', profileGeneration: 4, serverIdentity: 'server-local', serverName: 'Local', serverUrl: 'http://127.0.0.1:7850',
      generation: 3, hubUrl: 'https://hub.test', hubIdentity: 'hub-1', savedHubIdentity: 'hub-1',
      transport: 'secure_peer' as const, designatedHost: false, availabilityMessage: null, availabilityAction: null,
      canForgetBinding: true, connectionState: 'authenticated' as const, authenticated: true, bootstrapRequired: false,
      principal: { id: 'person-0', display_name: 'Pat' }, session: { id: 'hub-session', device_label: 'Studio', expires_at: '2026-12-01T00:00:00Z' }, error: null
    }
    let authoritativeHostName = 'Atlas'
    let authoritativeHostIdentity = 'server-atlas'
    let authoritativeRecipientName: string | undefined = 'Pat'
    const loadTeam = vi.fn().mockResolvedValue({
      scope: {}, team: { id: 'team-1' }, membership: { principal_id: 'person-0', role: 'owner', status: 'active', display_name: 'Pat' },
      members: [
        { principal_id: 'person-0', role: 'owner', status: 'active', display_name: 'Pat' },
        { principal_id: 'person-1', role: 'member', status: 'active', display_name: 'DPark', email: 'dpark@example.com' }
      ], nodes: [], channels: []
    })
    const loadTeamSkills = vi.fn().mockResolvedValue({ skills: [{
      id: 'skill-1', team_id: 'team-1', slug: 'incident-response', title: 'Incident response', summary: '', tags: [], current_version: 1,
      created_by_principal_id: 'person-1', pinned_at: null, pinned_by: null, archived_at: null, archived_by: null,
      created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:00Z'
    }] })
    const loadNetwork = vi.fn().mockImplementation(async () => ({
      network: { id: 'team-1', display_name: 'Core', hub_id: 'hub-1' },
      servers: [
        { id: 'node-host', server_identity: authoritativeHostIdentity, display_name: authoritativeHostName, recipient_display_name: authoritativeRecipientName, status: 'active', is_host: true, owned_by_caller: false },
        { id: 'node-owned', server_identity: 'server-local', display_name: "Pat's Studio", status: 'active', is_host: false, owned_by_caller: true },
        { id: 'node-current', server_identity: 'server-local', display_name: 'Duplicate local server', status: 'active', is_host: false, owned_by_caller: false },
        { id: 'node-remote', server_identity: 'server-lab', display_name: 'Remote Lab', status: 'active', is_host: false, owned_by_caller: false },
        { id: 'node-offline', server_identity: 'server-offline', display_name: 'Offline Lab', status: 'offline', is_host: false, owned_by_caller: false },
        { id: 'node-suspended', server_identity: 'server-suspended', display_name: 'Suspended Lab', status: 'suspended', is_host: false, owned_by_caller: false }
      ],
      agents: [], next_after_server_id: null, has_more: false
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: readPreference, set: persist },
        turns: { send },
        teamHub: {
          status: vi.fn().mockResolvedValue(status),
          teamMessagesCapabilities: vi.fn().mockResolvedValue({ available: true, version: 1,
            all_servers: { available: true, version: 1, mention: '@@all', recipient_kind: 'all_servers', max_recipients_per_message: 1024 }
          }),
          workspace: vi.fn().mockResolvedValue({ status, teams: [{ id: 'team-1', kind: 'shared', slug: 'core', display_name: 'Core', role: 'owner', status: 'active' }] }),
          team: loadTeam,
          network: loadNetwork,
          teamSkills: loadTeamSkills
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4,
      profiles: [{
        id: 'profile-a', name: 'Local', serverUrl: 'http://127.0.0.1:7850', serverIdentity: 'server-local',
        hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0
      }],
      health: teamMessagesHealth()
    })
    const user = userEvent.setup()
    let view = render(<Composer />)

    let editor = screen.getByPlaceholderText('Message')
    await user.type(editor, 'Tell @@')
    const palette = await screen.findByRole('listbox', { name: 'Team Network destinations' })
    expect(within(palette).getAllByRole('option')).toHaveLength(5)
    expect(within(palette).getByRole('option', { name: /Bulletin.*@@bulletin/i })).toBeInTheDocument()
    expect(within(palette).getByRole('option', { name: /All servers.*@@all/i })).toHaveTextContent('including offline servers')
    expect(within(palette).queryByRole('option', { name: /DPark/ })).not.toBeInTheDocument()
    expect(within(palette).getByRole('option', { name: /Pat.*@@Pat/ })).toBeInTheDocument()
    expect(within(palette).queryByRole('option', { name: /Atlas.*@@Atlas/ })).not.toBeInTheDocument()
    expect(within(palette).queryByRole('option', { name: /Team Hub host/ })).not.toBeInTheDocument()
    expect(within(palette).getByRole('option', { name: /Remote Lab.*@@Remote Lab/ })).toBeInTheDocument()
    expect(within(palette).queryByRole('option', { name: /Pat's Studio/ })).not.toBeInTheDocument()
    expect(within(palette).queryByRole('option', { name: /Duplicate local server/ })).not.toBeInTheDocument()
    expect(within(palette).getByRole('option', { name: /Offline Lab/ })).toHaveTextContent('Offline · inbox available')
    expect(within(palette).queryByRole('option', { name: /Suspended Lab/ })).not.toBeInTheDocument()
    expect(within(palette).queryByRole('option', { name: /Incident response/ })).not.toBeInTheDocument()
    expect(loadTeam).not.toHaveBeenCalled()
    expect(loadTeamSkills).not.toHaveBeenCalled()
    await user.click(within(palette).getByRole('option', { name: /Bulletin.*@@bulletin/i }))
    expect(editor).toHaveValue('Tell @@bulletin ')
    expect(useAppStore.getState().teamReferencesBySession['chat-1']).toEqual([{
      kind: 'recipient', recipient_kind: 'all', team_id: 'team-1', target_id: 'all',
      display_name_snapshot: 'bulletin', source_text_start: 5, source_text_end: 15, grant_intent: true
    }])
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1', prompt: 'Tell @@bulletin', teamReferences: [{
        kind: 'recipient', recipient_kind: 'all', team_id: 'team-1', target_id: 'all',
        display_name_snapshot: 'bulletin', source_text_start: 5, source_text_end: 15, grant_intent: true
      }]
    })))
    await waitFor(() => expect(editor).toHaveValue(''))

    await user.type(editor, 'Tell @@all')
    const allPalette = await screen.findByRole('listbox', { name: 'Team Network destinations' })
    expect(within(allPalette).queryByRole('option', { name: /Bulletin/i })).not.toBeInTheDocument()
    await user.click(within(allPalette).getByRole('option', { name: /All servers.*@@all/i }))
    expect(editor).toHaveValue('Tell @@all ')
    expect(useAppStore.getState().teamReferencesBySession['chat-1']).toEqual([{
      kind: 'recipient', recipient_kind: 'all_servers', team_id: 'team-1', target_id: 'all_servers',
      display_name_snapshot: 'all', source_text_start: 5, source_text_end: 10, grant_intent: true
    }])
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1', prompt: 'Tell @@all', teamReferences: [{
        kind: 'recipient', recipient_kind: 'all_servers', team_id: 'team-1', target_id: 'all_servers',
        display_name_snapshot: 'all', source_text_start: 5, source_text_end: 10, grant_intent: true
      }]
    })))
    await waitFor(() => expect(editor).toHaveValue(''))

    await user.type(editor, 'Tell @@')
    const serverPalette = await screen.findByRole('listbox', { name: 'Team Network destinations' })
    await user.click(within(serverPalette).getByRole('option', { name: /Pat/ }))
    expect(editor).toHaveValue('Tell @@Pat ')
    expect(useAppStore.getState().teamReferencesBySession['chat-1']).toEqual([{
      kind: 'recipient', recipient_kind: 'server', team_id: 'team-1', target_id: 'node-host',
      display_name_snapshot: 'Pat', source_text_start: 5, source_text_end: 10, grant_intent: true
    }])
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1', prompt: 'Tell @@Pat', teamReferences: [{
        kind: 'recipient', recipient_kind: 'server', team_id: 'team-1', target_id: 'node-host',
        display_name_snapshot: 'Pat', source_text_start: 5, source_text_end: 10, grant_intent: true
      }]
    })))
    await waitFor(() => expect(editor).toHaveValue(''))

    view.unmount()
    authoritativeHostName = 'Team Hub host'
    authoritativeHostIdentity = 'server-legacy'
    authoritativeRecipientName = undefined
    status.generation += 1
    view = render(<Composer />)
    editor = screen.getByPlaceholderText('Message')
    await user.type(editor, 'Tell @@Team')
    const legacyPalette = await screen.findByRole('listbox', { name: 'Team Network destinations' })
    await user.click(within(legacyPalette).getByRole('option', { name: /Team Hub host/ }))
    expect(editor).toHaveValue('Tell @@Team Hub host ')
    expect(useAppStore.getState().teamReferencesBySession['chat-1']).toEqual([{
      kind: 'recipient', recipient_kind: 'server', team_id: 'team-1', target_id: 'node-host',
      display_name_snapshot: 'Team Hub host', source_text_start: 5, source_text_end: 20, grant_intent: true
    }])
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1', prompt: 'Tell @@Team Hub host', teamReferences: [{
        kind: 'recipient', recipient_kind: 'server', team_id: 'team-1', target_id: 'node-host',
        display_name_snapshot: 'Team Hub host', source_text_start: 5, source_text_end: 20, grant_intent: true
      }]
    })))
    await waitFor(() => expect(editor).toHaveValue(''))

    expect(loadTeam).not.toHaveBeenCalled()
    expect(loadTeamSkills).not.toHaveBeenCalled()
    // Reopening @@ within one exact lifecycle reuses the shared roster; the
    // generation change above is the only reason for a second network read.
    expect(loadNetwork).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it('stages only Bulletin before status and adopts cached server recipients after verification', async () => {
    const status: TeamHubStatus = {
      version: 1,
      profileId: 'profile-a',
      profileGeneration: 4,
      serverIdentity: 'server-local',
      serverName: 'Local',
      generation: 3,
      hubUrl: 'https://hub.test',
      hubIdentity: 'hub-1',
      savedHubIdentity: 'hub-1',
      transport: 'secure_peer',
      designatedHost: false,
      availabilityMessage: null,
      availabilityAction: null,
      canForgetBinding: true,
      connectionState: 'authenticated',
      authenticated: true,
      authenticationMode: 'paired_node',
      bootstrapRequired: false,
      principal: { id: 'server-principal', display_name: 'Local', kind: 'service' },
      session: { id: 'hub-session', device_label: 'Studio', expires_at: '2026-12-01T00:00:00Z' },
      error: null
    }
    const workspace: TeamHubWorkspace = {
      status,
      teams: [{ id: 'team-1', kind: 'shared', slug: 'core', display_name: 'Core', role: 'automation', status: 'active' }]
    }
    const details: TeamHubTeamDetails = {
      scope: {
        profileId: status.profileId,
        profileGeneration: status.profileGeneration,
        serverIdentity: status.serverIdentity!,
        generation: status.generation,
        hubIdentity: status.hubIdentity
      },
      team: { ...workspace.teams[0]!, role: 'automation' },
      membership: { principal_id: 'server-principal', display_name: 'Local', role: 'automation', status: 'active' },
      members: [],
      nodes: [],
      channels: []
    }
    const projection = {
      network: { id: 'team-1', display_name: 'Core', hub_id: 'hub-1' },
      servers: [
        { id: 'node-atlas', server_identity: 'server-atlas', display_name: 'TargetApp', recipient_display_name: 'Pat', status: 'active' as const, is_host: true, owned_by_caller: false },
        { id: 'node-local', server_identity: 'server-local', display_name: 'Local', status: 'active' as const, is_host: false, owned_by_caller: true }
      ],
      agents: [],
      next_after_server_id: null,
      has_more: false
    }
    const pendingStatus = deferred<TeamHubStatus>()
    const statusRequest = vi.fn(() => pendingStatus.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        teamHub: {
          status: statusRequest,
          workspace: vi.fn().mockResolvedValue(workspace),
          team: vi.fn().mockResolvedValue(details),
          networkCapabilities: vi.fn().mockResolvedValue({
            available: true, version: 1, logical_servers: true, agent_registry: true,
            bulletin: true, mailbox: true, delivery_receipts: ['delivered', 'read'],
            passive_requests: true, server_invites: false, skill_attachments: false,
            dispatch: false, max_agents_per_server: 256, max_page_items: 100, max_body_bytes: 8_192
          }),
          teamMessagesCapabilities: vi.fn().mockResolvedValue({ available: true, version: 1 }),
          network: vi.fn().mockResolvedValue(projection)
        }
      } as unknown as AgentsDockAPI
    })
    await loadTeamNetworkWorkspace(status)
    await loadTeamNetworkCore(status, 'team-1')
    useAppStore.setState({ health: teamMessagesHealth() })
    const onSelect = vi.fn()

    render(<TeamMentionPalette
      id="cached-team-destinations"
      mention={{ kind: '@@', start: 0, end: 2, query: '' }}
      selectedIndex={0}
      supported
      profileId="profile-a"
      profileGeneration={4}
      serverIdentity="server-local"
      onCandidates={vi.fn()}
      onHighlight={vi.fn()}
      onSelect={onSelect}
    />)

    const palette = screen.getByRole('listbox', { name: 'Team Network destinations' })
    expect(within(palette).getByRole('option', { name: /Bulletin.*@@bulletin/i })).toBeVisible()
    expect(within(palette).queryByRole('option', { name: /Pat.*@@Pat/i })).not.toBeInTheDocument()
    expect(within(palette).queryByText('Loading Team Network…')).not.toBeInTheDocument()
    expect(statusRequest).toHaveBeenCalledTimes(1)
    await act(async () => pendingStatus.resolve(status))
    const recipient = await within(palette).findByRole('option', { name: /Pat.*@@Pat/i })
    expect(within(palette).queryByRole('option', { name: /All servers.*@@all/i })).not.toBeInTheDocument()
    fireEvent.click(recipient)
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ target_id: 'node-atlas', display_name_snapshot: 'Pat' })
    }))
  })

  it('omits Bulletin on older AgentsServer health while keeping server recipients usable', async () => {
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, queued: false
    })
    const status = {
      version: 1 as const,
      profileId: 'profile-a', profileGeneration: 41, serverIdentity: 'server-local',
      serverName: 'Local', serverUrl: 'http://127.0.0.1:7850', generation: 41,
      hubUrl: 'https://hub.test', hubIdentity: 'hub-beta41', savedHubIdentity: 'hub-beta41',
      transport: 'secure_peer' as const, designatedHost: false,
      availabilityMessage: null, availabilityAction: null, canForgetBinding: true,
      connectionState: 'authenticated' as const, authenticated: true, bootstrapRequired: false,
      principal: { id: 'person-0', display_name: 'Pat' },
      session: { id: 'hub-session', device_label: 'Studio', expires_at: '2026-12-01T00:00:00Z' },
      error: null
    }
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send },
        teamHub: {
          status: vi.fn().mockResolvedValue(status),
          teamMessagesCapabilities: vi.fn().mockResolvedValue({ available: true, version: 1 }),
          workspace: vi.fn().mockResolvedValue({
            status,
            teams: [{ id: 'team-1', kind: 'shared', slug: 'core', display_name: 'Core', role: 'owner', status: 'active' }]
          }),
          network: vi.fn().mockResolvedValue({
            network: { id: 'team-1', display_name: 'Core', hub_id: 'hub-beta41' },
            servers: [{
              id: 'node-atlas', server_identity: 'server-atlas', display_name: 'Atlas',
              status: 'active', is_host: true, owned_by_caller: false
            }],
            agents: [], next_after_server_id: null, has_more: false
          })
        }
      } as unknown as AgentsDockAPI
    })
    const legacyHealth = teamMessagesHealth()
    legacyHealth.capabilities = {
      agent_team_messages_v1: legacyHealth.capabilities!.agent_team_messages_v1
    }
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 41,
      profiles: [{
        id: 'profile-a', name: 'Local', serverUrl: 'http://127.0.0.1:7850', serverIdentity: 'server-local',
        hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0
      }],
      health: legacyHealth
    })
    const user = userEvent.setup()
    render(<Composer />)

    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, 'Tell @@')
    const palette = await screen.findByRole('listbox', { name: 'Team Network destinations' })
    expect(within(palette).queryByRole('option', { name: /Bulletin|@@bulletin/i })).not.toBeInTheDocument()
    expect(within(palette).getAllByRole('option')).toHaveLength(1)
    await user.click(within(palette).getByRole('option', { name: /Atlas.*@@Atlas/i }))

    expect(editor).toHaveValue('Tell @@Atlas ')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Tell @@Atlas',
      teamReferences: [expect.objectContaining({
        recipient_kind: 'server', target_id: 'node-atlas', display_name_snapshot: 'Atlas'
      })]
    })))
  })

  it('clears Bulletin immediately when its capability is lost without reloading the unchanged roster', async () => {
    const status = {
      version: 1 as const,
      profileId: 'profile-a', profileGeneration: 42, serverIdentity: 'server-local',
      serverName: 'Local', serverUrl: 'http://127.0.0.1:7850', generation: 42,
      hubUrl: 'https://hub.test', hubIdentity: 'hub-beta42', savedHubIdentity: 'hub-beta42',
      transport: 'secure_peer' as const, designatedHost: false,
      availabilityMessage: null, availabilityAction: null, canForgetBinding: true,
      connectionState: 'authenticated' as const, authenticated: true, bootstrapRequired: false,
      principal: { id: 'person-0', display_name: 'Pat' },
      session: { id: 'hub-session', device_label: 'Studio', expires_at: '2026-12-01T00:00:00Z' },
      error: null
    }
    const capabilityRefresh = deferred<{ available: true; version: 1 }>()
    const loadCapability = vi.fn()
      .mockResolvedValueOnce({ available: true, version: 1 })
      .mockImplementationOnce(() => capabilityRefresh.promise)
    const network = vi.fn().mockResolvedValue({
        network: { id: 'team-1', display_name: 'Core', hub_id: 'hub-beta42' },
        servers: [{
          id: 'node-atlas', server_identity: 'server-atlas', display_name: 'Atlas',
          status: 'active', is_host: true, owned_by_caller: false
        }],
        agents: [], next_after_server_id: null, has_more: false
      })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        teamHub: {
          status: vi.fn().mockResolvedValue(status),
          teamMessagesCapabilities: loadCapability,
          workspace: vi.fn().mockResolvedValue({
            status,
            teams: [{ id: 'team-1', kind: 'shared', slug: 'core', display_name: 'Core', role: 'owner', status: 'active' }]
          }),
          network
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 42,
      profiles: [{
        id: 'profile-a', name: 'Local', serverUrl: 'http://127.0.0.1:7850', serverIdentity: 'server-local',
        hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0
      }],
      health: teamMessagesHealth()
    })
    const user = userEvent.setup()
    const view = render(<Composer />)

    await user.type(screen.getByPlaceholderText('Message'), 'Tell @@')
    const palette = await screen.findByRole('listbox', { name: 'Team Network destinations' })
    expect(within(palette).getByRole('option', { name: /Bulletin.*@@bulletin/i })).toBeInTheDocument()
    expect(within(palette).getByRole('option', { name: /Atlas.*@@Atlas/i })).toBeInTheDocument()

    const healthWithoutBulletin = teamMessagesHealth()
    healthWithoutBulletin.capabilities!.team_bulletin_alias_v1 = {
      ...healthWithoutBulletin.capabilities!.team_bulletin_alias_v1!,
      available: false
    }
    act(() => useAppStore.setState({ health: healthWithoutBulletin }))
    view.rerender(<Composer />)

    expect(within(palette).queryByRole('option', { name: /Bulletin|@@bulletin/i })).not.toBeInTheDocument()
    // The prior recipient is auth-scoped and is not carried through a new
    // capability/status verification boundary.
    expect(within(palette).queryByRole('option', { name: /Atlas.*@@Atlas/i })).not.toBeInTheDocument()
    capabilityRefresh.resolve({ available: true, version: 1 })
    const verifiedAtlas = await within(palette).findByRole('option', { name: /Atlas.*@@Atlas/i })
    expect(verifiedAtlas).toBeEnabled()
    await user.click(verifiedAtlas)
    expect(screen.getByPlaceholderText('Message')).toHaveValue('Tell @@Atlas ')
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('keeps legacy human, all-team, and skill references readable after the @@ picker is narrowed', () => {
    const draft = '@@DPark @@All team @@Incident response'
    const legacyReferences: TeamReference[] = [{
      kind: 'recipient', recipient_kind: 'human', team_id: 'team-1', target_id: 'person-1',
      display_name_snapshot: 'DPark', source_text_start: 0, source_text_end: 7, grant_intent: true
    }, {
      kind: 'recipient', recipient_kind: 'all', team_id: 'team-1', target_id: 'all',
      display_name_snapshot: 'All team', source_text_start: 8, source_text_end: 18, grant_intent: true
    }, {
      kind: 'skill', team_id: 'team-1', target_id: 'skill-1',
      display_name_snapshot: 'Incident response', source_text_start: 19, source_text_end: 38, grant_intent: true
    }]
    useAppStore.setState({
      drafts: { 'chat-1': draft },
      teamReferencesBySession: { 'chat-1': legacyReferences },
      health: teamMessagesHealth()
    })

    render(<Composer />)

    expect(screen.getByPlaceholderText('Message')).toHaveValue(draft)
    expect(document.querySelector('span[title="@@DPark · Team member"]')).toHaveClass('team-reference')
    expect(document.querySelector('span[title="@@All team · Bulletin"]')).toHaveClass('team-reference')
    expect(document.querySelector('span[title="@@Incident response · Team skill"]')).toHaveClass('team-reference')
  })

  it('preserves a saved all-server inbox reference when the native server or Hub is too old', async () => {
    const send = vi.fn()
    const status = vi.fn().mockResolvedValue({
      profileId: 'profile-a', profileGeneration: 0, serverIdentity: 'server-local',
      authenticated: true, connectionState: 'authenticated', generation: 1, hubIdentity: 'hub-1'
    })
    const capabilities = vi.fn().mockResolvedValue({ available: true, version: 1 })
    window.agentsDock.turns = { send } as unknown as AgentsDockAPI['turns']
    window.agentsDock.teamHub = { status, teamMessagesCapabilities: capabilities } as unknown as AgentsDockAPI['teamHub']
    const reference: TeamReference = {
      kind: 'recipient', recipient_kind: 'all_servers', team_id: 'team-1', target_id: 'all_servers',
      display_name_snapshot: 'all', source_text_start: 5, source_text_end: 10, grant_intent: true
    }
    const oldNativeHealth = teamMessagesHealth()
    delete oldNativeHealth.capabilities!.team_all_servers_alias_v1
    useAppStore.setState({
      health: oldNativeHealth,
      profiles: [{ id: 'profile-a', name: 'Local', serverIdentity: 'server-local' } as PublicServerProfile],
      drafts: { 'chat-1': 'Tell @@all later' },
      teamReferencesBySession: { 'chat-1': [reference] }
    })
    render(<Composer />)

    const editor = screen.getByPlaceholderText('Message')
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.getByText(/@@all inbox broadcasts require a newer AgentsServer/)).toBeInTheDocument()
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(status).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()

    act(() => useAppStore.setState({ health: teamMessagesHealth(), error: null }))
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(useAppStore.getState().error).toContain('Update the Hub'))
    expect(capabilities).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
    expect(editor).toHaveValue('Tell @@all later')
    expect(useAppStore.getState().drafts['chat-1']).toBe('Tell @@all later')
    expect(useAppStore.getState().teamReferencesBySession['chat-1']).toEqual([reference])
  })

  it('hides the legacy /mail command as soon as Team Messages is advertised', () => {
    useAppStore.setState({ health: teamMessagesHealth() })
    render(<Composer />)

    const editor = screen.getByPlaceholderText('Message')
    fireEvent.change(editor, { target: { value: '/', selectionStart: 1 } })

    expect(screen.getByText('Attach files')).toBeInTheDocument()
    expect(screen.queryByText('Send Team Network mail')).not.toBeInTheDocument()
  })

  it('does not offer Cursor backend switching on a legacy server', async () => {
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByTitle('Change backend'))

    expect(screen.getByRole('menuitemcheckbox', { name: /Claude$/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: /Codex$/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemcheckbox', { name: /Cursor$/ })).not.toBeInTheDocument()
  })

  it('offers normal and custom Codex separately and sends the explicit provider selection', async () => {
    const update = vi.fn().mockImplementation(async (id, patch) => ({ id, title: 'Chat', ...patch }))
    window.agentsDock.sessions = { update } as unknown as AgentsDockAPI['sessions']
    useAppStore.setState({ health: { ok: true, capabilities: { codex_provider_v1: { per_chat: true, per_chat_models: true } } }, runtimeCatalog: {
      backends: { codex: { models: [], efforts: [], custom_provider: {
        configured: true, available: true, model: 'gpt-6-astra', base_url: 'https://inference.example/v1'
      } } }
    } })
    const user = userEvent.setup()
    render(<Composer />)
    await user.click(screen.getByTitle('Change backend'))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Codex' })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Codex runtime · Custom endpoint' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('chat-1', expect.objectContaining({ backend: 'codex', codex_provider: 'custom', model: null, effort: null })))
    expect(screen.getByTitle('Change backend')).toHaveTextContent('Codex · Custom')
    expect(screen.getByTitle('Change backend')).toHaveAccessibleName('Codex runtime · Custom endpoint')
    await user.click(screen.getByTitle('Change backend'))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Codex' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('chat-1', expect.objectContaining({ backend: 'codex', codex_provider: 'default' })))
  })

  it('routes an unconfigured custom choice to Settings without changing the chat', async () => {
    const update = vi.fn()
    window.agentsDock.sessions = { update } as unknown as AgentsDockAPI['sessions']
    const user = userEvent.setup()
    render(<Composer />)
    await user.click(screen.getByTitle('Change backend'))
    await user.click(screen.getByRole('menuitem', { name: 'Codex runtime · Custom endpoint Configure in Settings' }))
    expect(useAppStore.getState().modals.appSettings).toBe(true)
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps the custom provider fixed once the native thread starts', () => {
    useAppStore.setState({ sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex', codex_provider: 'custom', codex_thread_id: 'native-custom' }] })
    render(<Composer />)
    const chip = screen.getByTitle('Backend is fixed after the provider session starts')
    expect(chip).toBeDisabled()
    expect(chip).toHaveTextContent('Codex · Custom')
    expect(chip).toHaveAccessibleName('Codex runtime · Custom endpoint')
  })

  it('changes custom endpoint models and effort in the usual picker and permits an unlisted model', async () => {
    const session: Session = { id: 'chat-1', title: 'Chat', backend: 'codex', codex_provider: 'custom', model: 'provider/first', effort: 'high' }
    const update = vi.fn().mockImplementation(async (_id, patch) => ({ ...useAppStore.getState().sessions.find(item => item.id === session.id), ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) }))
    window.agentsDock.sessions = { update } as unknown as AgentsDockAPI['sessions']
    useAppStore.setState({ sessions: [session], runtimeCatalog: { backends: { codex: { models: [], efforts: [], custom_provider: {
      configured: true, available: true, model: null, base_url: 'https://inference.example/v1',
      models: [{ value: 'provider/first', label: 'First' }, { value: 'provider/next', label: 'Next' }],
      efforts: [], model_efforts: { 'provider/next': [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }
    } } } } })
    const user = userEvent.setup()
    const { container } = render(<Composer />)
    await user.click(container.querySelector<HTMLButtonElement>('.runtime-chip')!)
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Next · Unverified' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('chat-1', { model: 'provider/next', effort: 'high' }))
    await user.click(container.querySelector<HTMLButtonElement>('.runtime-chip')!)
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Low' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('chat-1', { effort: 'low' }))
    await user.click(container.querySelector<HTMLButtonElement>('.runtime-chip')!)
    await user.click(screen.getByRole('menuitem', { name: 'Enter model ID…' }))
    await user.clear(screen.getByLabelText('Model ID'))
    await user.type(screen.getByLabelText('Model ID'), 'provider/unlisted')
    await user.click(screen.getByRole('button', { name: 'Use model' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('chat-1', { model: 'provider/unlisted', effort: null }))
  })

  it('sends a custom Codex chat independently of normal OpenAI sign-in', async () => {
    const session: Session = { id: 'chat-1', title: 'Chat', backend: 'codex', codex_provider: 'custom', model: 'gpt-6-astra' }
    const send = vi.fn().mockResolvedValue({ session: { ...session, backend_locked: true }, queued: false })
    window.agentsDock.turns = { send } as unknown as AgentsDockAPI['turns']
    useAppStore.setState({ sessions: [session], health: { ok: true, capabilities: { codex_provider_v1: { per_chat: true, per_chat_models: true } }, runtimes: {
      codex: { backend: 'codex', status: 'unauthenticated', available: false, message: 'Sign in to normal Codex' }
    } }, runtimeCatalog: { backends: { codex: { models: [], efforts: [], custom_provider: {
      configured: true, available: true, model: 'gpt-6-astra', base_url: 'https://inference.example/v1'
    } } } } })
    const user = userEvent.setup()
    render(<Composer />)
    expect(screen.queryByText('Sign in to normal Codex')).not.toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Message'), 'A custom endpoint message')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(useAppStore.getState().error).toBeNull()
  })

  it('offers OpenCode explicitly and sends only its selected native skill capability', async () => {
    const session: Session = { id: 'chat-1', title: 'OpenCode chat', backend: 'opencode', opencode_permission_mode: 'default' }
    const list = vi.fn().mockResolvedValue({ backend: 'opencode', revision: 'skills-open-rev', support: { available: true, mode: 'native' }, commands: [{
      id: 'skill-open-id', name: 'review', label: 'OpenCode review', description: 'Review a file', kind: 'skill', invocation: '/review'
    }] })
    const send = vi.fn().mockResolvedValue({ session, queued: false })
    window.agentsDock.providerCommands = { list }
    window.agentsDock.turns = { send } as unknown as AgentsDockAPI['turns']
    useAppStore.setState({ connected: true, profileGeneration: 818, sessions: [session], health: { ok: true, capabilities: {
      opencode_backend: { available: true, required: false, action: null, message: 'Supported', version: 1 },
      local_provider_commands_v1: { available: true, required: false, action: null, message: 'Skills', version: 1, supported_backends: ['opencode'] }
    } }, runtimeCatalog: { backends: { opencode: { available: true, models: [{ value: '', label: 'OpenCode default' }], efforts: [] } } } })
    const user = userEvent.setup()
    render(<Composer />)
    expect(list).not.toHaveBeenCalled()
    await user.click(screen.getByTitle('Change backend'))
    expect(screen.getByRole('menuitemcheckbox', { name: 'OpenCode' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, '/')
    await user.click(await screen.findByRole('option', { name: /^OpenCode review/ }))
    await user.type(editor, 'inspect this change')
    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id, prompt: '/review inspect this change',
      clientCapabilities: ['opencode_provider_commands_v1'], skillSelection: { id: 'skill-open-id', revision: 'skills-open-rev' }
    })))
  })

  it('keeps OpenCode visible but fails closed on an old server without fetching skills', async () => {
    const list = vi.fn()
    window.agentsDock.providerCommands = { list }
    useAppStore.setState({ connected: true, profileGeneration: 819, sessions: [{ id: 'chat-1', title: 'OpenCode', backend: 'opencode' }], health: { ok: true } })
    const user = userEvent.setup()
    render(<Composer />)
    await user.click(screen.getByTitle('Change backend'))
    expect(screen.getByRole('menuitem', { name: /OpenCode.*Unavailable/ })).toHaveAttribute('aria-disabled', 'true')
    await user.keyboard('{Escape}')
    await user.type(screen.getByPlaceholderText('Message'), '/')
    expect(list).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.getAllByText(/Update the server, then reconnect/).length).toBeGreaterThan(0)
  })

  it('offers ready Cursor backend switching when its runtime catalog is available', async () => {
    useAppStore.setState({
      health: {
        ok: true,
        api_contract_version: 15,
        capabilities: {
          cursor_backend: {
            available: true,
            required: false,
            message: 'Cursor is ready.',
            action: null,
            version: 2,
            permission_modes: ['default', 'full_access', 'plan']
          }
        }
      },
      runtimeCatalog: {
        backends: {
          cursor: {
            available: true,
            models: [{ value: 'auto', label: 'Auto' }],
            efforts: []
          }
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByTitle('Change backend'))

    expect(screen.getByRole('menuitemcheckbox', { name: /Cursor$/ })).toBeInTheDocument()
  })

  it('keeps supported Cursor discoverable with setup guidance while its catalog loads', async () => {
    useAppStore.setState({
      health: {
        ok: true,
        capabilities: {
          cursor_backend: {
            available: true,
            required: false,
            message: 'Cursor is supported.',
            action: null,
            version: 2,
            permission_modes: ['default', 'full_access', 'plan']
          }
        },
        runtimes: {
          cursor: {
            backend: 'cursor',
            status: 'ready',
            available: true,
            message: 'Cursor is installed and authenticated.',
            checked_at: '2026-08-30T12:00:00Z'
          }
        }
      },
      runtimeCatalog: null
    })
    const user = userEvent.setup()
    const { unmount } = render(<Composer />)

    await user.click(screen.getByTitle('Change backend'))

    const unavailableItem = screen.getByRole('menuitem', { name: /Cursor.*Unavailable/ })
    expect(unavailableItem).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByText(/model choices are still loading/i)).not.toBeInTheDocument()
    await user.hover(unavailableItem)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/model choices are still loading/i)

    unmount()
    render(<Composer />)
    await user.click(screen.getByTitle('Change backend'))
    const unavailableByKeyboard = screen.getByRole('menuitem', { name: /Cursor.*Unavailable/ })
    await user.keyboard('{End}{ArrowUp}')
    expect(unavailableByKeyboard).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/model choices are still loading/i)
  })

  it('never exposes a Cursor reasoning control from stale stored effort', async () => {
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'cursor', model: 'auto', effort: 'high' }],
      health: {
        ok: true,
        capabilities: {
          cursor_backend: {
            available: true, required: false, message: 'Ready', action: null,
            version: 2, permission_modes: ['default', 'full_access', 'plan']
          }
        }
      },
      runtimeCatalog: {
        backends: {
          cursor: {
            available: true,
            models: [{ value: 'auto', label: 'Auto' }],
            efforts: []
          }
        }
      }
    })
    const user = userEvent.setup()
    const { container } = render(<Composer />)

    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, '/reasoning')
    expect(screen.queryByRole('option', { name: /^Reasoning/ })).not.toBeInTheDocument()
    await user.clear(editor)
    await user.click(container.querySelector<HTMLButtonElement>('.runtime-chip')!)

    expect(screen.queryByText('Reasoning')).not.toBeInTheDocument()
  })

  it('disables backend switching during the first active turn before a provider ID exists', () => {
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude' }],
      activeSessionIds: new Set(['chat-1'])
    })

    render(<Composer />)

    const backend = screen.getByTitle('Wait for the active turn to finish before changing backend')
    expect(backend).toBeDisabled()
    expect(backend.querySelector('svg.lucide-chevron-down')).not.toBeInTheDocument()
  })

  it('keeps backend switching locked after admission before the provider ID arrives', async () => {
    let resolveSend!: (result: {
      session: { id: string; title: string; backend: 'claude'; backend_locked: boolean }
      queued: boolean
    }) => void
    const send = vi.fn(() => new Promise<Parameters<typeof resolveSend>[0]>(resolve => { resolveSend = resolve }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude' }] })
    render(<Composer />)

    fireEvent.change(screen.getByPlaceholderText('Message'), { target: { value: 'Start the first turn' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect((screen.getByTitle('Wait for the message to be accepted before changing backend') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled).toBe(true)
    expect(useAppStore.getState().turnAdmissionTokens['chat-1']).toBeTruthy()
    expect(useAppStore.getState().pendingTurnSubmissions['chat-1']?.prompt).toBe('Start the first turn')
    expect(screen.getByRole('status').textContent).toContain('Starting…')
    act(() => useAppStore.setState({
      activeSessionIds: new Set(['chat-1']),
      pendingTurnSubmissions: {}
    }))
    expect(screen.getByRole('status').textContent).toContain('Running')
    expect(screen.getByRole('status').textContent).not.toContain('Waiting to start')
    act(() => useAppStore.setState({ activeSessionIds: new Set() }))

    await act(async () => resolveSend({
      session: { id: 'chat-1', title: 'Chat', backend: 'claude', backend_locked: true },
      queued: false
    }))

    await waitFor(() => expect(useAppStore.getState().turnAdmissionTokens['chat-1']).toBeUndefined())
    expect(screen.queryByRole('status')).toBeNull()
    expect((screen.getByTitle('Backend is fixed after the provider session starts') as HTMLButtonElement).disabled).toBe(true)
  }, 15_000)

  it('reloads the selected chat provider from the composer runtime menu', async () => {
    const reloadProvider = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      reloaded: true,
      message: 'Codex restarted with the latest settings.'
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { reloadProvider }
      } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByRole('button', { name: 'GPT' }))
    await user.click(screen.getByRole('menuitem', { name: 'Reload Codex' }))

    await waitFor(() => expect(reloadProvider).toHaveBeenCalledWith('chat-1'))
    expect(await screen.findByRole('status')).toHaveTextContent('Codex restarted with the latest settings.')
    await user.click(screen.getByRole('button', { name: 'Dismiss agent reload message' }))
    expect(screen.queryByText('Codex restarted with the latest settings.')).not.toBeInTheDocument()
  })

  it('does not reload a provider while that chat has active work', async () => {
    const reloadProvider = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { reloadProvider }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ activeSessionIds: new Set(['chat-1']) })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByRole('button', { name: 'GPT' }))
    const reload = screen.getByRole('menuitem', { name: 'Reload Codex' })
    expect(reload).toHaveAttribute('data-disabled')
    expect(reload).toHaveAttribute('title', 'Stop or wait for the active turn before reloading')
    await user.click(reload)
    expect(reloadProvider).not.toHaveBeenCalled()
  })

  it('shows a useful compatibility error for an older server', async () => {
    const reloadProvider = vi.fn().mockRejectedValue(new Error(
      "Error invoking remote method 'sessions:provider:reload': Error: This AgentsServer version does not support reloading a chat agent. Update the server and try again."
    ))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { reloadProvider }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude' }] })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByRole('button', { name: 'Sonnet' }))
    await user.click(screen.getByRole('menuitem', { name: 'Reload Claude' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This AgentsServer version does not support reloading a chat agent. Update the server and try again.'
    )
  })

  it('shows Stop as pending only while the request is in flight', async () => {
    let resolveStop!: (result: { stopped: boolean; pending: boolean; message: string }) => void
    const stop = vi.fn(() => new Promise<{ stopped: boolean; pending: boolean; message: string }>(resolve => { resolveStop = resolve }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { stop }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ activeSessionIds: new Set(['chat-1']), stoppingSessionIds: new Set() })
    const confirm = vi.spyOn(window, 'confirm')
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled()

    resolveStop({ stopped: false, pending: true, message: 'Still stopping. Retry Stop.' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled())
    expect(useAppStore.getState().activeSessionIds).toContain('chat-1')
    expect(useAppStore.getState().error).toBe('Still stopping. Retry Stop.')
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it.each(['idle', 'cached', 'syncing', 'reconnecting', 'offline', 'error'] as const)(
    'shows only a neutral sync status for an unknown active origin while chat sync is %s', status => {
      useAppStore.setState({
        activeSessionIds: new Set(['chat-1']),
        syncBySession: { 'chat-1': { status, error: null } }
      })
      render(<Composer />)
      const notice = screen.getByText('Syncing…')
      expect(notice).toHaveAttribute('role', 'status')
      expect(notice).toHaveClass('composer-sync-status')
      expect(notice).not.toHaveClass('chat-reference-warning')
      expect(screen.queryByText(/An active turn is running while chat sync is not live/)).not.toBeInTheDocument()

      act(() => useAppStore.setState({ syncBySession: { 'chat-1': { status: 'live', error: null } } }))
      expect(screen.queryByText('Syncing…')).not.toBeInTheDocument()
      expect(useAppStore.getState().activeSessionIds).toContain('chat-1')
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    }
  )

  it('localizes the neutral unknown-origin sync status without inventing activity for an idle chat', () => {
    setLocale('zh-CN')
    useAppStore.setState({ syncBySession: { 'chat-1': { status: 'syncing', error: null } } })
    render(<Composer />)
    expect(screen.queryByText('同步中…')).not.toBeInTheDocument()
    act(() => useAppStore.setState({ activeSessionIds: new Set(['chat-1']) }))
    expect(screen.getByText('同步中…')).toHaveClass('composer-sync-status')
    act(() => useAppStore.setState({ activeSessionIds: new Set() }))
    expect(screen.queryByText('同步中…')).not.toBeInTheDocument()
  })

  it('keeps explicit Stop and Send now confirmations for an unknown origin despite its neutral status', async () => {
    const stop = vi.fn()
    const runNow = vi.fn()
    window.agentsDock.turns = { stop } as unknown as AgentsDockAPI['turns']
    window.agentsDock.queue = { runNow } as unknown as AgentsDockAPI['queue']
    useAppStore.setState({
      activeSessionIds: new Set(['chat-1']),
      syncBySession: { 'chat-1': { status: 'cached', error: null } },
      snapshots: { 'chat-1': {
        session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [],
        queuedTurns: [{ queued_id: 'queued-user', session_id: 'chat-1', prompt: 'User follow-up', file_ids: [], position: 1 }],
        files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
      } }
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      render(<Composer />)
      expect(screen.getByText('Syncing…')).toHaveClass('composer-sync-status')
      await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
      await userEvent.click(screen.getByRole('button', { name: 'Send now' }))
      expect(confirm).toHaveBeenCalledTimes(2)
      expect(confirm.mock.calls[0]?.[0]).toMatch(/chat sync is not live.*Stop anyway\?/)
      expect(confirm.mock.calls[1]?.[0]).toMatch(/chat sync is not live.*Send now anyway\?/)
      expect(stop).not.toHaveBeenCalled()
      expect(runNow).not.toHaveBeenCalled()
    } finally { confirm.mockRestore() }
  })

  it.each([
    ['cross_chat_handoff_delivery', 'chat-to-chat', 'live'],
    ['secure_peer_handoff_delivery', 'encrypted peer', 'live'],
    ['cross_chat_handoff_delivery', 'chat-to-chat', 'reconnecting'],
    ['secure_peer_handoff_delivery', 'encrypted peer', 'reconnecting']
  ] as const)('warns and confirms before Stop or Send now interrupts an active %s (%s) run while sync is %s', async (purpose, label, syncStatus) => {
    const stop = vi.fn().mockResolvedValue({ stopped: true, pending: false, message: '' })
    const runNow = vi.fn().mockResolvedValue(true)
    const list = vi.fn().mockResolvedValue([])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { stop },
        queue: { runNow, list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeSessionIds: new Set(['chat-1']),
      stoppingSessionIds: new Set(),
      syncBySession: { 'chat-1': { status: syncStatus, error: null } },
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [{
            id: 'incoming-run', session_id: 'chat-1', seq: 1, type: 'turn_started',
            ts: '2026-09-05T00:00:00Z', run_id: 'incoming-run', purpose
          }],
          queuedTurns: [{
            queued_id: 'queued-user', session_id: 'chat-1', prompt: 'User follow-up', file_ids: [], position: 1
          }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const confirm = vi.spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
    try {
      const user = userEvent.setup()
      render(<Composer />)
      expect(screen.getByText(new RegExp(`incoming ${label} delivery is running`, 'i'))).toHaveClass('chat-reference-warning')
      expect(screen.queryByText('Syncing…')).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Stop' }))
      expect(stop).not.toHaveBeenCalled()
      await user.click(screen.getByRole('button', { name: 'Send now' }))
      expect(runNow).not.toHaveBeenCalled()

      await user.click(screen.getByRole('button', { name: 'Send now' }))
      await waitFor(() => expect(runNow).toHaveBeenCalledWith('chat-1', 'queued-user'))
      await user.click(screen.getByRole('button', { name: 'Stop' }))
      await waitFor(() => expect(stop).toHaveBeenCalledWith('chat-1'))
      expect(confirm).toHaveBeenCalledTimes(4)
      expect(confirm.mock.calls[0]?.[0]).toMatch(/Stopping it may cancel or fail that exchange/)
      expect(confirm.mock.calls[1]?.[0]).toMatch(/Sending now will interrupt it/)
    } finally {
      confirm.mockRestore()
    }
  })

  it('keeps model and effort compatible when the selected model changes', async () => {
    const update = vi.fn().mockResolvedValue({
      id: 'chat-1', title: 'Chat', backend: 'codex', model: 'gpt-5.6-luna', effort: 'max'
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        codex: composerCodexBridge(vi.fn().mockResolvedValue([]), {
          approval_policy: 'on-request', sandbox_mode: 'workspace-write', approvals_reviewer: 'user'
        }),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    const runtimeCatalog: RuntimeCatalog = {
      backends: {
        claude: { models: [{ value: 'sonnet', label: 'Sonnet' }], efforts: [] },
        codex: {
          default_model: 'gpt-5.6-sol',
          default_effort: 'medium',
          models: [
            { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: [
              { value: 'medium', label: 'Medium' }, { value: 'ultra', label: 'Ultra' }
            ] },
            { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: [
              { value: 'high', label: 'High' }, { value: 'max', label: 'Max' }
            ] }
          ],
          efforts: [
            { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' }, { value: 'ultra', label: 'Ultra' }
          ]
        }
      }
    }
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' }],
      runtimeCatalog
    })
    const user = userEvent.setup()
    render(<CodexComposerHarness />)

    await user.click(screen.getByRole('button', { name: 'GPT-5.6-Sol · Ultra' }))
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'GPT-5.6-Luna' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      model: 'gpt-5.6-luna', effort: 'max'
    })))
    await waitFor(() => expect(screen.getByRole('button', { name: 'GPT-5.6-Luna · Max' })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'GPT-5.6-Luna · Max' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Max' })).toBeChecked()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Ultra' })).not.toBeInTheDocument()
  })

  it('keeps consequential Codex permissions visible and edits them from the composer under Strict Mode', async () => {
    const update = vi.fn(async (_sessionId: string, patch: Record<string, unknown>) => ({
      ...useAppStore.getState().sessions.find(session => session.id === 'chat-1'),
      ...definedValues(patch)
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        codex: composerCodexBridge(vi.fn().mockResolvedValue([]), {
          approval_policy: 'on-request', sandbox_mode: 'workspace-write', approvals_reviewer: 'user'
        }),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{
        id: 'chat-1',
        title: 'Chat',
        backend: 'codex',
        codex_sandbox_mode: 'danger-full-access',
        codex_approval_policy: 'never',
        codex_approvals_reviewer: 'auto_review'
      }]
    })
    const user = userEvent.setup()
    render(<StrictMode><CodexComposerHarness /></StrictMode>)

    const trigger = screen.getByRole('button', {
      name: 'Codex permissions: Full access; approval prompts: never prompt; reviewer: Automatic reviewer'
    })
    expect(trigger).toHaveTextContent('Full access')
    expect(trigger).toHaveTextContent('No prompts')
    expect(trigger).not.toHaveClass('warning')

    await user.click(trigger)
    expect(screen.getByRole('heading', { name: 'Codex permissions' })).toBeInTheDocument()
    expect(screen.getByText('Applies to future turns in this chat.')).toBeInTheDocument()
    expect(screen.getByLabelText('Approval prompts')).toHaveDisplayValue('Never prompt')
    expect(screen.getByLabelText('Who approves?')).toHaveDisplayValue('Automatic reviewer')
    expect(screen.getByText('Codex can run commands anywhere without prompting.')).toHaveClass('codex-permission-hint')
    expect(screen.getByText('The selected reviewer is inactive while approval prompts are disabled.')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Filesystem sandbox'), 'workspace-write')

    await waitFor(() => expect(update).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      codex_sandbox_mode: 'workspace-write'
    })))
    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Codex permissions: Workspace write; approval prompts: never prompt; reviewer: Automatic reviewer'
    })).toBeInTheDocument())
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('shows exact Codex context usage beside the composer controls and opens thread controls', async () => {
    const runtimeBridge = composerCodexBridge()
    runtimeBridge.runtime.mockResolvedValue({
      available: true,
      transport: 'app_server',
      interactive_capability: 'codex_interactive_v1',
      thread_loaded: true,
      status: { type: 'idle' },
      goal: null,
      time_budget_seconds: null,
      pending_interactions: [],
      permission_profiles: [],
      background_terminals_supported: true,
      token_usage_snapshot: {
        context_tokens: 92_400,
        context_window: 100_000,
        context_percent: 92.4,
        input_tokens: 90_000,
        cached_input_tokens: 80_000,
        output_tokens: 2_400
      }
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        codex: runtimeBridge,
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<CodexComposerHarness />)

    const indicator = await screen.findByRole('button', { name: 'Open Codex controls for context usage' })
    expect(indicator).toHaveAttribute('data-context-percent', '91.36')
    expect(screen.getByRole('progressbar', { name: 'Codex context usage' })).toHaveAttribute('aria-valuenow', '91.36')
    expect(screen.getByRole('progressbar', { name: 'Codex context usage' })).toHaveAttribute(
      'aria-valuetext',
      '91.4% context used · 80.4k / 88k usable tokens · 90k input · 80k cached · 2.4k output'
    )

    await user.hover(indicator)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('91.4%')
    await user.unhover(indicator)

    await user.click(indicator)
    expect(await screen.findByRole('heading', { name: 'Codex thread controls' })).toBeInTheDocument()
    expect(runtimeBridge.runtime).toHaveBeenCalled()
  })

  it('discovers profile names lazily and keeps custom sandbox state while a profile is active', async () => {
    const permissionProfiles = vi.fn().mockResolvedValue([{ id: ':workspace', name: 'Workspace', allowed: true }])
    const update = vi.fn(async (_sessionId: string, patch: Record<string, unknown>) => ({
      ...useAppStore.getState().sessions.find(session => session.id === 'chat-1'),
      ...definedValues(patch)
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        codex: composerCodexBridge(permissionProfiles),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{
        id: 'chat-1',
        title: 'Chat',
        backend: 'codex',
        codex_sandbox_mode: 'read-only',
        codex_approval_policy: 'on-request',
        codex_approvals_reviewer: 'user'
      }]
    })
    const user = userEvent.setup()
    render(<CodexComposerHarness />)

    await user.click(screen.getByRole('button', { name: /Codex permissions: Read only/ }))
    expect(screen.getByLabelText('Approval prompts')).toHaveDisplayValue('Ask when more access is needed')
    expect(screen.getByLabelText('Who approves?')).toHaveDisplayValue('Me (Codex default)')
    expect(screen.getByText('Codex asks before it needs to cross the current sandbox boundary.')).toBeInTheDocument()
    expect(screen.getByText('Approval requests pause for your decision.')).toBeInTheDocument()
    const profileOption = await screen.findByRole('option', { name: 'Workspace' })
    expect(permissionProfiles).toHaveBeenCalledWith('chat-1')
    await user.selectOptions(screen.getByLabelText('Permission profile'), profileOption)

    await waitFor(() => expect(screen.getByRole('button', { name: /Codex permissions: Workspace/ })).toBeInTheDocument())
    expect(screen.getByLabelText('Filesystem sandbox')).toBeDisabled()
    expect(screen.getByLabelText('Filesystem sandbox')).toHaveValue('read-only')

    await user.selectOptions(screen.getByLabelText('Permission profile'), '')
    await waitFor(() => expect(screen.getByLabelText('Filesystem sandbox')).toBeEnabled())
    expect(screen.getByLabelText('Filesystem sandbox')).toHaveValue('read-only')
  })

  it('finishes serialized rapid permission edits after switching chats', async () => {
    const firstResponse = deferred<void>()
    const update = vi.fn(async (_sessionId: string, patch: Record<string, unknown>) => {
      const response = {
        ...useAppStore.getState().sessions.find(session => session.id === 'chat-1'),
        ...definedValues(patch)
      }
      if (update.mock.calls.length === 1) await firstResponse.promise
      return response
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        codex: composerCodexBridge(),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [
        {
          id: 'chat-1', title: 'Chat', backend: 'codex',
          codex_sandbox_mode: 'danger-full-access', codex_approval_policy: 'never',
          codex_approvals_reviewer: 'user'
        },
        { id: 'chat-2', title: 'Other chat', backend: 'claude' }
      ]
    })
    const user = userEvent.setup()
    render(<CodexComposerHarness />)

    await user.click(screen.getByRole('button', { name: /Codex permissions: Full access/ }))
    await user.selectOptions(screen.getByLabelText('Filesystem sandbox'), 'workspace-write')
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    await user.selectOptions(screen.getByLabelText('Approval prompts'), 'on-request')
    expect(update).toHaveBeenCalledTimes(1)
    act(() => useAppStore.setState({ selectedSessionId: 'chat-2' }))

    firstResponse.resolve()
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update).toHaveBeenLastCalledWith('chat-1', expect.objectContaining({
      codex_sandbox_mode: 'workspace-write',
      codex_approval_policy: 'on-request',
      codex_approvals_reviewer: 'user'
    }))
    await waitFor(() => expect(useAppStore.getState().sessions.find(session => session.id === 'chat-1')).toEqual(
      expect.objectContaining({
        codex_sandbox_mode: 'workspace-write',
        codex_approval_policy: 'on-request',
        codex_approvals_reviewer: 'user'
      })
    ))
  })

  it('keeps an explicit custom profile when the runtime snapshot still reports an older profile', async () => {
    const codex = composerCodexBridge(vi.fn().mockResolvedValue([]), {
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access',
      permission_profile: ':workspace',
      approvals_reviewer: 'user'
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        codex,
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Chat', backend: 'codex',
        codex_sandbox_mode: 'danger-full-access', codex_approval_policy: 'never',
        codex_permission_profile: null, codex_approvals_reviewer: 'user'
      }]
    })

    render(<CodexComposerHarness />)

    await waitFor(() => expect(codex.runtime).toHaveBeenCalledWith('chat-1'))
    expect(screen.getByRole('button', {
      name: 'Codex permissions: Full access; approval prompts: never prompt; reviewer: Me (Codex default)'
    })).toBeInTheDocument()
  })

  it('waits for a permission update before sending the next Codex turn', async () => {
    const permissionResponse = deferred<void>()
    const update = vi.fn(async (_sessionId: string, patch: Record<string, unknown>) => {
      await permissionResponse.promise
      return {
        ...useAppStore.getState().sessions.find(session => session.id === 'chat-1'),
        ...definedValues(patch)
      }
    })
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      queued: false
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        turns: { send },
        codex: composerCodexBridge(),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Chat', backend: 'codex',
        codex_sandbox_mode: 'danger-full-access', codex_approval_policy: 'never',
        codex_approvals_reviewer: 'user'
      }]
    })
    const user = userEvent.setup()
    render(<CodexComposerHarness />)

    await user.type(screen.getByPlaceholderText('Message'), 'Use the new policy')
    await user.click(screen.getByRole('button', { name: /Codex permissions: Full access/ }))
    await user.selectOptions(screen.getByLabelText('Filesystem sandbox'), 'workspace-write')
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingTurnSubmissions['chat-1']?.prompt).toBe('Use the new policy')
    expect(screen.getByRole('status').textContent).toContain('Starting…')
    expect((screen.getByPlaceholderText('Message') as HTMLTextAreaElement).value).toBe('')
    expect((screen.getByTitle('Wait for the message to be accepted before changing backend') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText('Message'), { target: { value: 'Draft the next request' } })
    permissionResponse.resolve()
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1', prompt: 'Use the new policy'
    })))
    expect((screen.getByPlaceholderText('Message') as HTMLTextAreaElement).value).toBe('Draft the next request')
  }, 30_000)

  it('restores the authoritative permission policy when auto-save fails', async () => {
    const update = vi.fn().mockRejectedValue(new Error('Policy update denied'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        codex: composerCodexBridge(),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Chat', backend: 'codex',
        codex_sandbox_mode: 'danger-full-access', codex_approval_policy: 'never',
        codex_approvals_reviewer: 'user'
      }]
    })
    const user = userEvent.setup()
    render(<CodexComposerHarness />)

    await user.click(screen.getByRole('button', { name: /Codex permissions: Full access/ }))
    await user.selectOptions(screen.getByLabelText('Filesystem sandbox'), 'workspace-write')

    expect(await screen.findByText('Not saved')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Policy update denied')
    expect(screen.getByRole('button', {
      name: 'Codex permissions: Full access; approval prompts: never prompt; reviewer: Me (Codex default)'
    })).toBeInTheDocument()
  })

  it('shows a loading state rather than guessing a missing Codex policy', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        codex: composerCodexBridge(vi.fn().mockResolvedValue([]), {}),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })

    render(<CodexComposerHarness />)

    const trigger = screen.getByRole('button', { name: 'Codex permissions loading' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveTextContent('Loading permissions')
  })

  it('does not show Codex permissions for Claude chats', () => {
    useAppStore.setState({ sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude' }] })
    render(<Composer />)

    expect(screen.queryByRole('button', { name: /Codex permissions/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Codex controls for context usage' })).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar', { name: 'Codex context usage' })).not.toBeInTheDocument()
  })

  it('explains when the connected server cannot apply interactive Codex permissions', () => {
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Chat', backend: 'codex',
        codex_sandbox_mode: 'danger-full-access', codex_approval_policy: 'never', codex_approvals_reviewer: 'user'
      }]
    })
    render(<Composer />)

    expect(screen.getByRole('button', {
      name: 'Codex permissions unavailable; update AgentsServer and use Codex app-server'
    })).toBeDisabled()
  })

  it('shows every native Claude permission mode and persists the selected mode', async () => {
    const update = vi.fn(async (_sessionId: string, patch: Record<string, unknown>) => ({
      ...useAppStore.getState().sessions.find(session => session.id === 'chat-1'),
      ...definedValues(patch)
    }))
    const claude = composerClaudeBridge({ permission_mode: 'default' })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        claude,
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude' }] })
    const user = userEvent.setup()
    render(<ClaudeComposerHarness />)

    const trigger = await screen.findByRole('button', { name: 'Claude permissions: Ask for access' })
    await user.click(trigger)
    expect(screen.getByRole('heading', { name: 'Claude permissions' })).toBeInTheDocument()
    expect(screen.getByText('Applies to future interactive Claude SDK turns in this chat.')).toBeInTheDocument()
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'Ask for access',
      'Auto-approve edits',
      'Plan only',
      'Bypass permissions',
      "Don't ask; deny unapproved",
      'Automatic approvals'
    ])

    await user.selectOptions(screen.getByLabelText('Permission mode'), 'acceptEdits')

    await waitFor(() => expect(update).toHaveBeenCalledWith('chat-1', {
      claude_permission_mode: 'acceptEdits'
    }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Claude permissions: Auto-approve edits' })).toBeInTheDocument()
  })

  it('changes future Claude permissions while preserving the active turn access', async () => {
    const update = vi.fn(async (_sessionId: string, patch: Record<string, unknown>) => ({
      ...useAppStore.getState().sessions.find(session => session.id === 'chat-1'),
      ...definedValues(patch)
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        claude: composerClaudeBridge({ permission_mode: 'default' }),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude', claude_permission_mode: 'default' }],
      activeSessionIds: new Set(['chat-1'])
    })
    const user = userEvent.setup()
    render(<ClaudeComposerHarness />)

    const trigger = await screen.findByRole('button', { name: 'Claude permissions: Ask for access' })
    expect(trigger).toBeEnabled()
    await user.click(trigger)

    const mode = screen.getByLabelText('Permission mode')
    expect(mode).toBeEnabled()
    expect(screen.getByText('This change applies to the next turn; the active turn keeps its current access.')).toBeInTheDocument()
    await user.selectOptions(mode, 'plan')
    await waitFor(() => expect(update).toHaveBeenCalledWith('chat-1', {
      claude_permission_mode: 'plan'
    }))
    const close = screen.getByRole('button', { name: 'Close Claude permissions' })
    expect(close).toBeEnabled()
    await user.click(close)
    expect(screen.queryByRole('heading', { name: 'Claude permissions' })).not.toBeInTheDocument()
  })

  it('does not write Claude permission fields to an older server without the explicit feature gate', async () => {
    const update = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        claude: composerClaudeBridge({ permission_mode: 'default' }, false),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude', claude_permission_mode: 'default' }]
    })
    render(<ClaudeComposerHarness />)

    const trigger = await screen.findByRole('button', {
      name: 'Claude permission modes unavailable; update AgentsServer'
    })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveTextContent('Update server')
    expect(update).not.toHaveBeenCalled()
  })

  it('fails closed when a runtime advertises control without its authoritative mode list', async () => {
    const update = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        claude: composerClaudeBridge({ permission_mode: 'default' }, true, null),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude', claude_permission_mode: 'default' }]
    })
    render(<ClaudeComposerHarness />)

    expect(await screen.findByRole('button', {
      name: 'Claude permission modes unavailable; update AgentsServer'
    })).toBeDisabled()
    expect(update).not.toHaveBeenCalled()
  })

  it('waits for a Claude permission update before sending the next turn', async () => {
    const permissionResponse = deferred<void>()
    const update = vi.fn(async (_sessionId: string, patch: Record<string, unknown>) => {
      await permissionResponse.promise
      return {
        ...useAppStore.getState().sessions.find(session => session.id === 'chat-1'),
        ...definedValues(patch)
      }
    })
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'claude' },
      queued: false
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        turns: { send },
        claude: composerClaudeBridge({ permission_mode: 'default' }),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude', claude_permission_mode: 'default' }]
    })
    const user = userEvent.setup()
    render(<ClaudeComposerHarness />)

    await user.type(screen.getByPlaceholderText('Message'), 'Use the new Claude policy')
    await user.click(await screen.findByRole('button', { name: 'Claude permissions: Ask for access' }))
    await user.selectOptions(screen.getByLabelText('Permission mode'), 'acceptEdits')
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingTurnSubmissions['chat-1']?.prompt).toBe('Use the new Claude policy')
    expect(screen.getByRole('status').textContent).toContain('Starting…')
    expect((screen.getByPlaceholderText('Message') as HTMLTextAreaElement).value).toBe('')
    permissionResponse.resolve()
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1', prompt: 'Use the new Claude policy'
    })))
  }, 30_000)

  it('restores the authoritative Claude permission mode when auto-save fails', async () => {
    const update = vi.fn().mockRejectedValue(new Error('Claude policy update denied'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        claude: composerClaudeBridge({ permission_mode: 'default' }),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude', claude_permission_mode: 'default' }]
    })
    const user = userEvent.setup()
    render(<ClaudeComposerHarness />)

    await user.click(await screen.findByRole('button', { name: 'Claude permissions: Ask for access' }))
    await user.selectOptions(screen.getByLabelText('Permission mode'), 'acceptEdits')

    expect(await screen.findByText('Not saved')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Claude policy update denied')
    expect(screen.getByRole('button', { name: 'Claude permissions: Ask for access' })).toBeInTheDocument()
  })

  it('scopes an image attachment URL by the active profile', () => {
    const mediaURL = vi.fn((profileId: string, generation: number, sessionId: string, fileId: string) => `agentsdock-media://file/${profileId}/${generation}/${sessionId}/${fileId}`)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        files: { mediaURL }
      } as unknown as AgentsDockAPI
    })
    const image: AgentFile = { id: 'same-file', filename: 'preview.png', content_type: 'application/octet-stream' }
    useAppStore.setState({ uploadsBySession: { 'chat-1': [image] } })
    const view = render(<Composer />)

    expect(mediaURL).toHaveBeenCalledWith('profile-a', 0, 'chat-1', 'same-file')
    expect(view.container.querySelector('.attachment-chip img')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove preview.png' })).toBeInTheDocument()
    act(() => useAppStore.setState({ activeProfileId: 'profile-b' }))
    expect(mediaURL).toHaveBeenCalledWith('profile-b', 0, 'chat-1', 'same-file')
  })

  it('shows calm accessible feedback while a dropped file is uploading', () => {
    useAppStore.setState({
      uploadPathsBySession: {
        'chat-1': [{ path: '/tmp/research.pdf', name: 'research.pdf', size: 2048, type: 'application/pdf' }]
      }
    })
    const view = render(<Composer dropActive />)

    expect(screen.getByRole('status', { name: 'Drop to attach' })).toBeInTheDocument()
    const pending = screen.getByRole('status', { name: 'Uploading research.pdf' })
    expect(pending.querySelector('.attachment-file-icon')).toBeInTheDocument()
    expect(screen.getByText('Uploading…')).toBeInTheDocument()
    expect(view.container.querySelector('.mini-spinner')).not.toBeInTheDocument()
  })

  it('sends a ready image without requiring message text', async () => {
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      queued: false,
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send },
        files: { mediaURL: vi.fn().mockReturnValue('agentsdock-media://file/image-1') },
      } as unknown as AgentsDockAPI,
    })
    const image: AgentFile = { id: 'image-1', filename: 'screen.png', content_type: 'image/png' }
    useAppStore.setState({ uploadsBySession: { 'chat-1': [image] } })
    const user = userEvent.setup()
    render(<Composer />)

    const button = screen.getByRole('button', { name: 'Send message' })
    expect(button).toBeEnabled()
    await user.click(button)

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1', prompt: '', fileIds: ['image-1'],
    })))
    expect(useAppStore.getState().uploadsBySession['chat-1']).toEqual([])
  })

  it('steers a ready image-only turn with Command-Enter', async () => {
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      queued: true,
      queued_id: 'queued-image',
    })
    const runNow = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send },
        queue: { runNow, list: vi.fn().mockResolvedValue([]) },
        files: { mediaURL: vi.fn().mockReturnValue('agentsdock-media://file/image-1') },
      } as unknown as AgentsDockAPI,
    })
    const image: AgentFile = { id: 'image-1', filename: 'screen.png', content_type: 'image/png' }
    useAppStore.setState({
      activeSessionIds: new Set(['chat-1']),
      uploadsBySession: { 'chat-1': [image] },
    })
    render(<Composer />)

    fireEvent.keyDown(screen.getByPlaceholderText('Message'), { key: 'Enter', metaKey: true })

    await waitFor(() => expect(runNow).toHaveBeenCalledWith('chat-1', 'queued-image'))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1', prompt: '', fileIds: ['image-1'],
    }))
  })

  it('waits for pending uploads before enabling a send or steer', () => {
    const send = vi.fn()
    const runNow = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send },
        queue: { runNow, list: vi.fn().mockResolvedValue([]) },
      } as unknown as AgentsDockAPI,
    })
    useAppStore.setState({
      activeSessionIds: new Set(['chat-1']),
      uploadPathsBySession: {
        'chat-1': [{ path: '/tmp/large.png', name: 'large.png', type: 'image/png' }],
      },
    })
    render(<Composer />)

    expect(screen.getByRole('button', { name: 'Queue message' })).toBeDisabled()
    fireEvent.keyDown(screen.getByPlaceholderText('Message'), { key: 'Enter', metaKey: true })
    expect(send).not.toHaveBeenCalled()
    expect(runNow).not.toHaveBeenCalled()
  })

  it('adds draft persistence to the profile-switch flush promises', async () => {
    let releasePersistence: (() => void) | undefined
    const persist = vi.fn(() => new Promise<void>(resolve => { releasePersistence = resolve }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: persist }
      } as unknown as AgentsDockAPI
    })
    render(<Composer />)
    fireEvent.change(screen.getByPlaceholderText('Message'), { target: { value: 'Keep this on profile A' } })
    const promises: Promise<unknown>[] = []

    act(() => window.dispatchEvent(new CustomEvent('agentsdock:flush-draft', { detail: { promises } })))

    expect(promises).toHaveLength(1)
    await waitFor(() => expect(persist).toHaveBeenCalledWith('draft:chat-1', 'Keep this on profile A'))
    releasePersistence?.()
    await promises[0]
  })

  it('includes queued Codex permission writes in the workspace flush while a profile switch is marked', async () => {
    const releaseUpdate = deferred<void>()
    const update = vi.fn(async (_sessionId: string, patch: Record<string, unknown>) => {
      await releaseUpdate.promise
      return {
        id: 'chat-1',
        title: 'Chat',
        backend: 'codex' as const,
        ...definedValues(patch)
      }
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Chat', backend: 'codex',
        codex_approval_policy: 'never', codex_sandbox_mode: 'danger-full-access',
        codex_permission_profile: null, codex_approvals_reviewer: 'user'
      }]
    })
    render(<Composer />)

    const queued = queueCodexPermissionUpdate('chat-1', {
      codex_approval_policy: 'on-request',
      codex_sandbox_mode: 'workspace-write',
      codex_permission_profile: null,
      codex_approvals_reviewer: 'auto_review'
    })
    act(() => useAppStore.setState({ switchingProfileId: 'profile-b' }))
    const promises: Promise<unknown>[] = []
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:flush-draft', { detail: { promises } })))

    expect(promises).toHaveLength(1)
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    let flushFinished = false
    void promises[0].then(() => { flushFinished = true })
    await Promise.resolve()
    expect(flushFinished).toBe(false)

    releaseUpdate.resolve()
    await expect(queued).resolves.toBeUndefined()
    await expect(promises[0]).resolves.toBeUndefined()
    expect(update).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      codex_approval_policy: 'on-request',
      codex_sandbox_mode: 'workspace-write',
      codex_approvals_reviewer: 'auto_review'
    }))
  })

  it('includes queued Claude permission writes in the workspace flush while a profile switch is marked', async () => {
    const releaseUpdate = deferred<void>()
    const update = vi.fn(async (_sessionId: string, patch: Record<string, unknown>) => {
      await releaseUpdate.promise
      return {
        id: 'chat-1',
        title: 'Chat',
        backend: 'claude' as const,
        ...definedValues(patch)
      }
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude', claude_permission_mode: 'default' }]
    })
    render(<Composer />)

    const queued = queueClaudePermissionUpdate('chat-1', { claude_permission_mode: 'plan' })
    act(() => useAppStore.setState({ switchingProfileId: 'profile-b' }))
    const promises: Promise<unknown>[] = []
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:flush-draft', { detail: { promises } })))

    expect(promises).toHaveLength(1)
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    let flushFinished = false
    void promises[0].then(() => { flushFinished = true })
    await Promise.resolve()
    expect(flushFinished).toBe(false)

    releaseUpdate.resolve()
    await expect(queued).resolves.toBeUndefined()
    await expect(promises[0]).resolves.toBeUndefined()
    expect(update).toHaveBeenCalledWith('chat-1', { claude_permission_mode: 'plan' })
  })

  it('propagates a failed queued Codex permission write through the workspace flush', async () => {
    const update = vi.fn().mockRejectedValue(new Error('Policy update denied'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Chat', backend: 'codex',
        codex_approval_policy: 'never', codex_sandbox_mode: 'danger-full-access',
        codex_permission_profile: null, codex_approvals_reviewer: 'user'
      }]
    })
    render(<Composer />)

    const queued = queueCodexPermissionUpdate('chat-1', {
      codex_approval_policy: 'on-request',
      codex_sandbox_mode: 'workspace-write',
      codex_permission_profile: null,
      codex_approvals_reviewer: 'user'
    })
    const queuedFailure = expect(queued).rejects.toThrow('Policy update denied')
    const flushFailure = expect(flushActiveWorkspace()).rejects.toThrow('Policy update denied')

    await queuedFailure
    await flushFailure
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('ignores a late draft load from another profile with the same session ID', async () => {
    let resolveProfileA: ((value: string) => void) | undefined
    const get = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(resolve => { resolveProfileA = resolve }))
      .mockResolvedValueOnce('Profile B draft')
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get, set: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    render(<Composer />)
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))

    act(() => useAppStore.setState({ activeProfileId: 'profile-b', drafts: {} }))
    await waitFor(() => expect(screen.getByPlaceholderText('Message')).toHaveValue('Profile B draft'))
    await act(async () => { resolveProfileA?.('Profile A draft'); await Promise.resolve() })

    expect(screen.getByPlaceholderText('Message')).toHaveValue('Profile B draft')
  })

  it('sends a frequent phrase immediately without consuming the current composer', async () => {
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      queued: false,
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send },
      } as unknown as AgentsDockAPI,
    })
    const attachment: AgentFile = { id: 'file-1', filename: 'notes.txt', content_type: 'text/plain' }
    useAppStore.setState({
      drafts: { 'chat-1': 'Unfinished draft' },
      uploadsBySession: { 'chat-1': [attachment] },
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByTitle('Add'))
    await user.click(await screen.findByText('Status report'))

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1', prompt: 'Status report', fileIds: [],
    })))
    expect(screen.getByPlaceholderText('Message')).toHaveValue('Unfinished draft')
    expect(useAppStore.getState().uploadsBySession['chat-1']).toEqual([attachment])
  })

  it('shows an actionable provider warning and preserves the draft when the CLI is unavailable', async () => {
    useAppStore.setState({
      health: {
        ok: true,
        runtimes: {
          codex: {
            backend: 'codex', status: 'missing', available: false, installed: false, authenticated: false,
            message: 'Codex is not installed on the server.', action: 'Install Codex and refresh runtime status.',
          },
        },
      },
    })
    const user = userEvent.setup()
    render(<Composer />)
    expect(screen.getByText('Codex is not installed on the server.')).toBeInTheDocument()
    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, 'Keep this draft')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(editor).toHaveValue('Keep this draft')
    expect(useAppStore.getState().error).toContain('Install Codex')
  })

  it('prefers the current chat provider error over a generic runtime failure banner', () => {
    useAppStore.setState({
      health: {
        ok: true,
        runtimes: {
          codex: {
            backend: 'codex', status: 'ready', available: true, installed: true, authenticated: true,
            message: 'Codex is ready.',
            last_error: 'The latest provider run failed. Open the chat error for details, then retry or refresh runtime status.',
          },
        },
      },
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [{
            id: 'err-1', seq: 12, session_id: 'chat-1', type: 'error', ts: '2026-07-14T19:00:00Z',
            backend: 'codex', message: 'Invalid value: max. Supported values are: none, minimal, low, medium, high, and xhigh.',
          }],
          queuedTurns: [],
          files: [],
          hasMoreEvents: false,
          filesTotal: 0,
          cachedAt: 0
        }
      }
    })

    render(<Composer />)

    expect(screen.getByText('Latest chat error')).toBeInTheDocument()
    expect(screen.getByText(/Invalid value: max/)).toBeInTheDocument()
    expect(screen.queryByText(/Open the chat error/)).not.toBeInTheDocument()
  })

  it('does not leak a backend-wide previous run failure into another chat', () => {
    useAppStore.setState({
      health: {
        ok: true,
        runtimes: {
          codex: {
            backend: 'codex', status: 'ready', available: true, installed: true, authenticated: true,
            message: 'Codex is ready.', last_error: 'Selected model is at capacity.',
          },
        },
      },
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [], queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0,
        },
        'other-chat': {
          session: { id: 'other-chat', title: 'Other', backend: 'codex' },
          events: [{
            id: 'other-error', seq: 8, session_id: 'other-chat', type: 'error', ts: '2026-07-14T19:00:00Z',
            backend: 'codex', run_id: 'other-run', message: 'Selected model is at capacity.',
          }],
          queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0,
        },
      },
    })

    render(<Composer />)

    expect(screen.queryByText('Latest chat error')).not.toBeInTheDocument()
    expect(screen.queryByText('Selected model is at capacity.')).not.toBeInTheDocument()
  })

  it('clears an older chat error after a newer run succeeds', () => {
    useAppStore.setState({
      health: { ok: true, runtimes: { codex: { backend: 'codex', status: 'ready', available: true, message: 'Codex is ready.' } } },
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [
            { id: 'old-error', seq: 1, session_id: 'chat-1', type: 'error', ts: '2026-07-14T19:00:00Z', backend: 'codex', run_id: 'run-1', message: 'Old failure.' },
            { id: 'old-finished', seq: 2, session_id: 'chat-1', type: 'turn_finished', ts: '2026-07-14T19:00:01Z', backend: 'codex', run_id: 'run-1' },
            { id: 'new-answer', seq: 3, session_id: 'chat-1', type: 'assistant_text', ts: '2026-07-14T19:01:00Z', backend: 'codex', run_id: 'run-2', text: 'Recovered.' },
            { id: 'new-finished', seq: 4, session_id: 'chat-1', type: 'turn_finished', ts: '2026-07-14T19:01:01Z', backend: 'codex', run_id: 'run-2', result_text: 'Recovered.' },
          ],
          queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0,
        },
      },
    })

    render(<Composer />)

    expect(screen.queryByText('Latest chat error')).not.toBeInTheDocument()
    expect(screen.queryByText('Old failure.')).not.toBeInTheDocument()
  })

  it('renders queued turns in a compact action shelf above the editor', () => {
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [{ queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Check the latest training status', display_prompt: 'Check the latest training status', file_ids: [], position: 1 }],
          files: [],
          hasMoreEvents: false,
          filesTotal: 0,
          cachedAt: 0
        }
      }
    })

    render(<Composer />)

    expect(screen.getByText('Queued turns')).toBeInTheDocument()
    expect(screen.getByText('Check the latest training status')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send now' })).toHaveAttribute('title', 'Send this queued message now')
    expect(screen.getByTitle('Drag to reorder')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Message')).toBeInTheDocument()
  })

  it('shows incoming cross-chat deliveries in the shelf and skips the exact FIFO owner once', async () => {
    const first = { queued_id: 'queued-user', session_id: 'chat-1', prompt: 'First user follow-up', file_ids: [], position: 1 }
    const later = { queued_id: 'queued-later', session_id: 'chat-1', prompt: 'Later user follow-up', file_ids: [], position: 3 }
    const skipCrossChatDelivery = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { skipCrossChatDelivery, list: vi.fn().mockResolvedValue([first, later]) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability({
        version: 9, features: { exact_queued_delivery_skip: true }
      }) } },
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [
            first,
            {
              queued_id: 'queued-cross-chat', session_id: 'chat-1',
              prompt: 'Agent-authored same-server request', display_prompt: 'Agent-authored same-server request',
              file_ids: [], position: 2, purpose: 'cross_chat_handoff_delivery',
              cross_chat_exchange_id: 'exchange-1', cross_chat_exchange_leg_id: 'leg-1'
            },
            later
          ],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })

    render(<Composer />)

    const queueLabel = screen.getByText('Queued turns').parentElement
    expect(queueLabel).not.toBeNull()
    expect(within(queueLabel!).getByText('3')).toBeInTheDocument()
    expect(screen.getByText('First user follow-up')).toBeInTheDocument()
    expect(screen.getByText('Later user follow-up')).toBeInTheDocument()
    const deliveryRow = screen.getByText('Agent-authored same-server request').closest('.queued-row')!
    expect(screen.getByText(/Cross-chat delivery · position 2/i)).toBeInTheDocument()
    expect(within(deliveryRow as HTMLElement).queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument()
    expect(within(deliveryRow as HTMLElement).queryByTitle('More queue actions')).not.toBeInTheDocument()
    expect(within(deliveryRow as HTMLElement).queryByTitle('Drag to reorder')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Skip incoming delivery' })).toHaveLength(1)
    const laterRow = screen.getByText('Later user follow-up').closest('.queued-row')!
    expect(within(laterRow as HTMLElement).queryByRole('button', { name: 'Skip incoming delivery' })).not.toBeInTheDocument()
    const sendNow = screen.getAllByRole('button', { name: 'Send now' })
    expect(sendNow).toHaveLength(2)
    expect(sendNow[0]).toBeEnabled()
    expect(sendNow[1]).toBeDisabled()
    expect(sendNow[1]).toHaveAttribute('title', 'An incoming cross-chat delivery must run before this queued message')

    await userEvent.click(screen.getByRole('button', { name: 'Skip incoming delivery' }))

    expect(skipCrossChatDelivery).toHaveBeenCalledWith('chat-1', 'queued-cross-chat', {
      cross_chat_envelope_id: null,
      cross_chat_exchange_id: 'exchange-1',
      cross_chat_exchange_leg_id: 'leg-1'
    })
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Send now' })[1]).toBeEnabled())
  })

  it.each([
    { cross_chat_envelope_id: 'envelope-1', cross_chat_exchange_id: null, cross_chat_exchange_leg_id: null },
    { cross_chat_envelope_id: 'envelope-2', cross_chat_exchange_id: null, cross_chat_exchange_leg_id: null }
  ])('removes an async agent message through its exact envelope identity: %j', async identity => {
    const ordinary = { queued_id: 'queued-user', prompt: 'User follow-up', file_ids: [], position: 2 }
    const agent = asyncAgentQueuedTurn(identity)
    const skipCrossChatDelivery = vi.fn().mockResolvedValue(true)
    const remove = vi.fn()
    const update = vi.fn()
    const runNow = vi.fn()
    window.agentsDock.queue = { skipCrossChatDelivery, remove, update, runNow, list: vi.fn().mockResolvedValue([ordinary]) } as unknown as AgentsDockAPI['queue']
    setAsyncAgentQueue([agent, ordinary])
    render(<Composer />)

    const row = screen.getByRole('status', { name: 'Research agent: Authenticated agent message' })
    expect(row).toHaveClass('agent-message')
    expect(within(row).getByText('Research agent')).toHaveClass('queue-agent-sender')
    expect(within(row).queryByText('Renamed research agent')).not.toBeInTheDocument()
    expect(within(row).queryByText(/Cross-chat delivery/)).not.toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Send now' })).toBeDisabled()
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(within(row).getByRole('button', { name: 'Send now' })).toHaveAttribute('title', 'Update AgentsServer to edit or send this agent message now.')
    expect(within(row).queryByRole('button', { name: 'Skip incoming delivery' })).not.toBeInTheDocument()
    expect(within(row).getByTitle('Drag to reorder')).toBeEnabled()
    expect(screen.getByText('User follow-up').closest('.queued-row')).not.toHaveClass('agent-message')
    await userEvent.click(within(row).getByTitle('More queue actions'))
    expect(screen.queryByRole('menuitem', { name: 'Edit message' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Move later' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await userEvent.click(within(row).getByRole('button', { name: 'Remove from queue' }))

    expect(skipCrossChatDelivery).toHaveBeenCalledExactlyOnceWith('chat-1', 'queued-agent', identity)
    expect(remove).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(runNow).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Authenticated agent message')).not.toBeInTheDocument())
    expect(screen.getByText('User follow-up')).toBeVisible()
  })

  it.each([false, true])('edits only the exact async body revision without grants or mandatory refresh (conflict=%s)', async conflict => {
    const body = 'KD Dev result: ' + 'Measured rollout detail. '.repeat(35) + 'END-EXACT-BODY'
    const agent = asyncAgentQueuedTurn({ source_title: 'KD Dev', prompt: 'Agent-authored same-server handoff',
      message_body: body, message_revision: 0, message_edited_by_user: false })
    setAsyncAgentQueue([agent])
    useAppStore.setState({ health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability({
      features: { async_queued_message_controls: true, exact_queued_delivery_skip: true } }) } } })
    const update = conflict ? vi.fn().mockRejectedValue(new Error('message revision changed')) : vi.fn().mockResolvedValue(true)
    const list = vi.fn().mockRejectedValue(new Error('unavailable optional refresh'))
    const handoffGet = vi.fn()
    window.agentsDock.queue = { update, list, runNow: vi.fn() } as unknown as AgentsDockAPI['queue']
    window.agentsDock.handoffs = { get: handoffGet } as unknown as AgentsDockAPI['handoffs']
    render(<Composer />)
    const row = screen.getByText('KD Dev').closest('.queued-row') as HTMLElement
    expect(row).toHaveClass('agent-message')
    expect(within(row).queryByText('Agent-authored same-server handoff')).not.toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Send now' })).toBeEnabled()
    expect(within(row).queryByText(/END-EXACT-BODY/)).not.toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: 'View message' }))
    expect(await within(row).findByText(body)).toBeVisible()
    expect(handoffGet).not.toHaveBeenCalled()
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))
    const editor = await screen.findByRole('textbox', { name: 'Edit agent message' })
    expect(editor).toHaveValue(body)
    const changed = 'My exact edit @Local @@Remote is plain message text.'
    fireEvent.change(editor, { target: { value: changed } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith('chat-1', 'queued-agent', changed, undefined, undefined, undefined, 0))
    if (conflict) {
      await waitFor(() => expect(useAppStore.getState().error).toBe('message revision changed'))
      expect(editor).toHaveValue(changed)
      expect(useAppStore.getState().snapshots['chat-1'].queuedTurns[0].message_revision).toBe(0)
    } else {
      await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit agent message' })).not.toBeInTheDocument())
      expect(within(row).getByText('Edited by you')).toBeVisible()
      expect(useAppStore.getState().snapshots['chat-1'].queuedTurns[0]).toMatchObject({
        message_body: changed, message_revision: 1, message_edited_by_user: true, source_title: 'KD Dev', purpose: 'cross_chat_handoff_delivery'
      })
    }
    expect(list).not.toHaveBeenCalled()
  })

  it('prioritizes a user message without deleting the earlier agent message on a capable server', async () => {
    const agent = asyncAgentQueuedTurn({ message_body: 'Earlier agent body', message_revision: 0 })
    const ordinary = { queued_id: 'later-user', prompt: 'Prioritize this user message', file_ids: [], position: 2 }
    setAsyncAgentQueue([agent, ordinary])
    useAppStore.setState({ health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability({
      features: { async_queued_message_controls: true, exact_queued_delivery_skip: true } }) } } })
    const runNow = vi.fn().mockResolvedValue({ ok: true })
    const skipCrossChatDelivery = vi.fn()
    window.agentsDock.queue = { runNow, skipCrossChatDelivery, list: vi.fn().mockResolvedValue([agent]) } as unknown as AgentsDockAPI['queue']
    render(<Composer />)
    const userRow = screen.getByText(ordinary.prompt).closest('.queued-row') as HTMLElement
    fireEvent.click(within(userRow).getByRole('button', { name: 'Send now' }))
    await waitFor(() => expect(runNow).toHaveBeenCalledExactlyOnceWith('chat-1', 'later-user'))
    await waitFor(() => expect(screen.queryByText(ordinary.prompt)).not.toBeInTheDocument())
    expect(screen.getByText('Earlier agent body')).toBeVisible()
    expect(skipCrossChatDelivery).not.toHaveBeenCalled()
  })

  it('loads an old-server async body only on View and keeps unsupported actions disabled', async () => {
    const agent = asyncAgentQueuedTurn({ source_title: 'KD Dev', prompt: 'Agent-authored same-server handoff' })
    setAsyncAgentQueue([agent])
    const get = vi.fn().mockResolvedValue({ id: 'envelope-1', target_session_id: 'chat-1', source_session_id: 'chat-sender',
      queued_id: 'queued-agent', conversation_mode: 'async_route_v1', body: 'Actual older-server message body.' })
    window.agentsDock.handoffs = { get } as unknown as AgentsDockAPI['handoffs']
    render(<Composer />)
    expect(screen.getByText('Message from KD Dev')).toBeVisible()
    expect(get).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'View message' }))
    expect(await screen.findByText('Actual older-server message body.')).toBeVisible()
    expect(get).toHaveBeenCalledExactlyOnceWith('envelope-1')
  })

  it.each([
    ['chat-sender', 'Renamed research agent'],
    ['missing-sender', 'Unknown agent']
  ])('resolves a missing sender snapshot for %s without fetching chats', (sourceSessionId, title) => {
    setAsyncAgentQueue([asyncAgentQueuedTurn({ source_title: ' ', source_session_id: sourceSessionId })])
    render(<Composer />)
    expect(screen.getByRole('status', { name: `${title}: Authenticated agent message` })).toBeVisible()
    expect(screen.getByText(title)).toHaveClass('queue-agent-sender')
  })

  it.each([
    { purpose: 'cross_chat_handoff_delivery', conversation_mode: null },
    { purpose: 'cross_chat_handoff_delivery', conversation_mode: 'future_mode' },
    { purpose: 'secure_peer_handoff_delivery', conversation_mode: 'async_route_v1' },
    { purpose: null, conversation_mode: 'async_route_v1' }
  ])('keeps non-async rows in their existing presentation: %j', fields => {
    setAsyncAgentQueue([asyncAgentQueuedTurn(fields as Partial<QueuedTurn>)])
    render(<Composer />)
    const row = screen.getByText('Authenticated agent message').closest('.queued-row') as HTMLElement
    expect(row).not.toHaveClass('agent-message')
    expect(row.querySelector('.queue-agent-sender')).toBeNull()
    if (fields.purpose === 'cross_chat_handoff_delivery') {
      expect(within(row).getByRole('button', { name: 'Skip incoming delivery' })).toBeVisible()
      expect(within(row).queryByRole('button', { name: 'Remove from queue' })).not.toBeInTheDocument()
    }
  })

  it.each(['capability', 'identity'])('does not remove async agent messages without exact %s', missing => {
    setAsyncAgentQueue([asyncAgentQueuedTurn(missing === 'identity' ? {
      cross_chat_envelope_id: null
    } : {})])
    if (missing === 'capability') useAppStore.setState({ health: null })
    const skipCrossChatDelivery = vi.fn()
    window.agentsDock.queue = { skipCrossChatDelivery } as unknown as AgentsDockAPI['queue']
    render(<Composer />)
    expect(screen.getByRole('button', { name: 'Remove from queue' })).toBeDisabled()
    expect(skipCrossChatDelivery).not.toHaveBeenCalled()
  })

  it('refreshes an async agent message removal lost to promotion and removes stale queue actions', async () => {
    const agent = asyncAgentQueuedTurn()
    const skipCrossChatDelivery = vi.fn().mockRejectedValue(new Error('This delivery is already starting'))
    const remove = vi.fn()
    const list = vi.fn().mockResolvedValue([{ ...agent, promoted: true }])
    window.agentsDock.queue = { skipCrossChatDelivery, remove, list } as unknown as AgentsDockAPI['queue']
    setAsyncAgentQueue([agent])
    render(<Composer />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove from queue' }))

    await waitFor(() => expect(useAppStore.getState().error).toBe('This delivery is already starting'))
    expect(list).toHaveBeenCalledTimes(1)
    expect(skipCrossChatDelivery).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    const row = screen.getByText('Authenticated agent message').closest('.queued-row') as HTMLElement
    expect(row).toHaveClass('agent-message', 'promoted')
    expect(within(row).getByText('Research agent')).toBeVisible()
    expect(within(row).getByText('Starting…')).toBeVisible()
    expect(within(row).queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows a one-item composer shelf when the only queued turn is an incoming cross-chat delivery', () => {
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [{
            queued_id: 'queued-cross-chat', session_id: 'chat-1',
            prompt: 'Agent-authored same-server request', display_prompt: 'Agent-authored same-server request',
            file_ids: [], position: 1, purpose: 'cross_chat_handoff_delivery'
          }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })

    render(<Composer />)

    expect(within(screen.getByText('Queued turns').parentElement!).getByText('1')).toBeInTheDocument()
    expect(screen.getByText('Agent-authored same-server request')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument()
    expect(screen.queryByTitle('More queue actions')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Drag to reorder')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('Message')).toBeInTheDocument()
  })

  it('shows a scheduled occurrence in the queue and cancels only that occurrence', async () => {
    const remove = vi.fn().mockResolvedValue(true)
    const deleteSchedule = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { remove, list: vi.fn().mockResolvedValue([]) },
        jobs: { remove: deleteSchedule }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [], queuedTurns: [{
            queued_id: 'queued-job-1', session_id: 'chat-1', purpose: 'scheduled_job',
            prompt: 'Check nightly deployment', file_ids: [], position: 1,
            job_id: 'job-1', job_title: 'Nightly check', job_scheduled_run_at: 1_789_000_000
          }], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    render(<Composer />)
    expect(within(screen.getByText('Queued turns').parentElement!).getByText('1')).toBeInTheDocument()
    expect(screen.getByText('Nightly check', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Check nightly deployment')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument()
    expect(screen.queryByTitle('More queue actions')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Drag to reorder')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel queued job' }))
    expect(remove).toHaveBeenCalledExactlyOnceWith('chat-1', 'queued-job-1')
    expect(deleteSchedule).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Queued turns')).not.toBeInTheDocument())
  })

  it('shows and safely skips an exact encrypted peer delivery queue owner', async () => {
    const peerDelivery = {
      queued_id: 'queued-peer', session_id: 'chat-1',
      prompt: 'Encrypted message from a paired server',
      display_prompt: 'Encrypted message from a paired server',
      file_ids: [], position: 1, purpose: 'secure_peer_handoff_delivery',
      secure_peer_envelope_id: 'peer-envelope-1'
    }
    const skipCrossChatDelivery = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { skipCrossChatDelivery, list: vi.fn().mockResolvedValue([]) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability({
        version: 10,
        features: {
          exact_queued_delivery_skip: true,
          exact_queued_peer_delivery_skip: true
        }
      }) } },
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [], queuedTurns: [peerDelivery], files: [], hasMoreEvents: false,
          filesTotal: 0, cachedAt: 0
        }
      }
    })

    render(<Composer />)

    expect(screen.getByText('Encrypted message from a paired server')).toBeInTheDocument()
    expect(screen.getByText(/Encrypted peer delivery · position 1/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Skip encrypted peer delivery' }))
    expect(skipCrossChatDelivery).toHaveBeenCalledWith('chat-1', 'queued-peer', {
      secure_peer_envelope_id: 'peer-envelope-1'
    })
    await waitFor(() => expect(screen.queryByText('Queued turns')).not.toBeInTheDocument())
  })

  it('fails closed for queued Cursor Send now actions when the backend contract is unavailable', async () => {
    const queued = { queued_id: 'queued-cursor', session_id: 'chat-1', prompt: 'Inspect the workspace', file_ids: [], position: 1 }
    const runNow = vi.fn().mockResolvedValue(true)
    const list = vi.fn().mockResolvedValue([queued])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { runNow, list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Cursor chat', backend: 'cursor', model: 'auto' }],
      health: { ok: true, capabilities: {} },
      runtimeCatalog: { backends: { cursor: { available: true, models: [{ value: 'auto', label: 'Auto' }], efforts: [] } } },
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Cursor chat', backend: 'cursor', model: 'auto' },
          events: [], queuedTurns: [queued], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    render(<Composer />)

    const sendNow = screen.getByRole('button', { name: 'Send now' })
    expect(sendNow).toBeDisabled()
    expect(sendNow).toHaveAttribute('title', expect.stringContaining('Cursor is unavailable'))
    fireEvent.keyDown(screen.getByPlaceholderText('Message'), { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(useAppStore.getState().error).toMatch(/Cursor is unavailable/))
    expect(list).toHaveBeenCalledWith('chat-1')
    expect(runNow).not.toHaveBeenCalled()
  })

  it('blocks a previously selected locked model instead of sending through it', async () => {
    const send = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex', model: 'premium' }],
      runtimeCatalog: { backends: { codex: {
        models: [{ value: 'premium', label: 'Premium', locked: true, locked_reason: 'Upgrade required.' }],
        efforts: []
      } } }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.type(screen.getByPlaceholderText('Message'), 'Run this')
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.getByText('Upgrade required.')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByPlaceholderText('Message'), { key: 'Enter' })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not reinterpret a blocked draft shortcut as Send now for a queued turn', async () => {
    const list = vi.fn().mockResolvedValue([{
      queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Queued work', file_ids: [], position: 1
    }])
    const runNow = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { list, runNow }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex', model: 'premium' }],
      runtimeCatalog: { backends: { codex: {
        models: [{ value: 'premium', label: 'Premium', locked: true, locked_reason: 'Upgrade required.' }],
        efforts: []
      } } }
    })
    const user = userEvent.setup()
    render(<Composer />)

    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, 'Keep this draft')
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })

    expect(list).not.toHaveBeenCalled()
    expect(runNow).not.toHaveBeenCalled()
  })

  it('keeps the explicit queue action labeled Send now while the chat is running', () => {
    useAppStore.setState({
      activeSessionIds: new Set(['chat-1']),
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [{ queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Change course', file_ids: [], position: 1 }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })

    render(<Composer />)

    expect(screen.getByRole('button', { name: 'Send now' })).toHaveAttribute(
      'title',
      'Send this message into the active turn now; other queued messages keep their order (⌘↩ while editing)'
    )
  })

  it('describes Send now without claiming it changes goal status, including on older servers', async () => {
    const goalSession: Session = {
      id: 'chat-1', title: 'Chat', backend: 'codex',
      codex_goal: {
        threadId: 'thread-1', objective: 'Finish the integration', status: 'active',
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0
      }
    }
    useAppStore.setState({
      sessions: [goalSession],
      activeSessionIds: new Set(['chat-1']),
      drafts: { 'chat-1': 'New instruction' },
      snapshots: {
        'chat-1': {
          session: goalSession,
          events: [],
          queuedTurns: [{ queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Change course', file_ids: [], position: 1 }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    render(<Composer />)

    expect(screen.getByRole('button', { name: 'Send now' })).toHaveAttribute(
      'title', 'Send this message to the running agent'
    )
    const user = userEvent.setup()
    await user.hover(screen.getByRole('button', { name: 'Queue message' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Queue message · Send now sends it to the running agent'
    )
    await user.unhover(screen.getByRole('button', { name: 'Queue message' }))

    act(() => {
      useAppStore.setState({
        sessions: [{ ...goalSession, codex_goal: { ...goalSession.codex_goal!, status: 'paused' } }]
      })
    })
    expect(screen.getByRole('button', { name: 'Send now' })).toHaveAttribute(
      'title', 'Send this message into the active turn now; other queued messages keep their order (⌘↩ while editing)'
    )
  })

  it.each(['button', 'enter', 'command-enter'] as const)('keeps an active goal follow-up on the intended %s send path without a goal mutation', async path => {
    const goalSession: Session = {
      id: 'chat-1', title: 'Chat', backend: 'codex',
      codex_goal: { threadId: 'thread-1', objective: 'Keep working overnight', status: 'active',
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 }
    }
    const queuedId = 'queued-followup'
    const send = vi.fn().mockResolvedValue({ session: goalSession, queued: true, queued_id: queuedId,
      event: { id: 'queued-event', session_id: 'chat-1', seq: 1, ts: '2026-09-10T10:00:00Z',
        type: 'turn_queued', queued_id: queuedId, prompt: 'Additional context', file_ids: [], position: 1 } })
    const runNow = vi.fn().mockResolvedValue({ ok: true, queued_id: queuedId })
    const list = vi.fn().mockResolvedValue([])
    const setGoal = vi.fn()
    Object.assign(window.agentsDock, { turns: { send }, queue: { runNow, list }, codex: { setGoal } })
    useAppStore.setState({ sessions: [goalSession], activeSessionIds: new Set(['chat-1']), drafts: { 'chat-1': 'Additional context' },
      snapshots: { 'chat-1': { session: goalSession, events: [], queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0 } } })
    render(<Composer />)
    if (path === 'button') fireEvent.click(screen.getByRole('button', { name: 'Queue message' }))
    else fireEvent.keyDown(screen.getByPlaceholderText('Message'), { key: 'Enter', metaKey: path === 'command-enter' })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      clientCapabilities: expect.arrayContaining(['codex_goal_steer_v1'])
    }))
    await waitFor(() => expect(useAppStore.getState().turnAdmissionTokens['chat-1']).toBeUndefined())
    if (path === 'command-enter') {
      expect(runNow).toHaveBeenCalledExactlyOnceWith('chat-1', queuedId)
      expect(list).toHaveBeenCalledExactlyOnceWith('chat-1')
    } else {
      expect(runNow).not.toHaveBeenCalled()
      expect(list).not.toHaveBeenCalled()
      expect(useAppStore.getState().snapshots['chat-1'].queuedTurns).toMatchObject([{ queued_id: queuedId }])
    }
    expect(setGoal).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions[0].codex_goal?.status).toBe('active')
  })

  it.each([
    { path: 'Send now', outcome: 'accepted' },
    { path: 'Send now', outcome: 'rejected' },
    { path: 'Command-Enter', outcome: 'accepted' },
    { path: 'Command-Enter', outcome: 'rejected' }
  ] as const)('preserves an active goal and its queued instruction while $path is pending then $outcome', async ({ path, outcome }) => {
    const goalSession: Session = {
      id: 'chat-1', title: 'Chat', backend: 'codex',
      codex_goal: { threadId: 'thread-1', objective: 'Finish the integration', status: 'active',
        tokensUsed: 120, timeUsedSeconds: 30, createdAt: 0, updatedAt: 0 }
    }
    const unrelated: QueuedTurn = {
      queued_id: 'queued-other', session_id: 'chat-1', prompt: 'Other queued work', file_ids: [], position: 1
    }
    const instruction: QueuedTurn = {
      queued_id: 'queued-followup', session_id: 'chat-1', prompt: 'Check the retry behavior first', file_ids: [], position: 2
    }
    const pendingRunNow = deferred<{ ok: boolean; queued_id: string }>()
    const runNow = vi.fn(() => pendingRunNow.promise)
    const list = vi.fn().mockResolvedValue([unrelated])
    const send = vi.fn().mockResolvedValue({
      session: goalSession, queued: true, queued_id: instruction.queued_id,
      event: { id: 'queued-event', seq: 1, ts: '2026-09-13T10:00:00Z',
        type: 'turn_queued', ...instruction }
    })
    const setGoal = vi.fn()
    const stop = vi.fn()
    Object.assign(window.agentsDock, { turns: { send, stop }, queue: { runNow, list }, codex: { setGoal } })
    useAppStore.setState({
      sessions: [goalSession], activeSessionIds: new Set(['chat-1']),
      drafts: path === 'Command-Enter' ? { 'chat-1': instruction.prompt } : {},
      snapshots: { 'chat-1': {
        session: goalSession, events: [],
        queuedTurns: path === 'Command-Enter' ? [unrelated] : [unrelated, instruction],
        files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
      } }
    })
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')
    const instructionRow = () => within(screen.getByText(instruction.prompt).closest('.queued-row') as HTMLElement)
    if (path === 'Command-Enter') fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })
    else fireEvent.click(instructionRow().getByRole('button', { name: 'Send now' }))

    try {
      await waitFor(() => expect(runNow).toHaveBeenCalledExactlyOnceWith('chat-1', instruction.queued_id))
      expect(instructionRow().getByRole('button', { name: 'Send now' })).toBeDisabled()
      expect(screen.getByText('Sending now…')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
      expect(useAppStore.getState().snapshots['chat-1'].queuedTurns).toMatchObject([unrelated, instruction])
      expect(useAppStore.getState().sessions[0].codex_goal).toEqual(goalSession.codex_goal)

      fireEvent.click(instructionRow().getByRole('button', { name: 'Send now' }))
      fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })
      expect(runNow).toHaveBeenCalledTimes(1)
      expect(list).not.toHaveBeenCalled()
    } finally {
      await act(async () => {
        if (outcome === 'accepted') pendingRunNow.resolve({ ok: true, queued_id: instruction.queued_id })
        else pendingRunNow.reject(new Error('Codex rejected this goal steering request. The message remains queued.'))
      })
    }

    await waitFor(() => expect(screen.queryByText('Sending now…')).not.toBeInTheDocument())
    expect(useAppStore.getState().turnAdmissionTokens['chat-1']).toBeUndefined()
    expect(useAppStore.getState().sessions[0].codex_goal).toEqual(goalSession.codex_goal)
    expect(useAppStore.getState().activeSessionIds.has('chat-1')).toBe(true)
    expect(setGoal).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(runNow).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(path === 'Command-Enter' ? 1 : 0)
    expect(editor).toHaveValue('')
    if (outcome === 'accepted') {
      expect(list).toHaveBeenCalledExactlyOnceWith('chat-1')
      expect(useAppStore.getState().snapshots['chat-1'].queuedTurns).toEqual([unrelated])
      expect(screen.queryByText(instruction.prompt)).not.toBeInTheDocument()
      expect(useAppStore.getState().error).toBeNull()
    } else {
      expect(list).not.toHaveBeenCalled()
      expect(useAppStore.getState().snapshots['chat-1'].queuedTurns).toMatchObject([unrelated, instruction])
      expect(screen.getAllByText(instruction.prompt)).toHaveLength(1)
      expect(instructionRow().getByRole('button', { name: 'Send now' })).toBeEnabled()
      expect(useAppStore.getState().error).toBe('Codex rejected this goal steering request. The message remains queued.')
    }
  })

  it('explains why an idle queued turn is paused and offers Send now', () => {
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [{
            queued_id: 'queued-paused', session_id: 'chat-1', prompt: 'Continue after the stop', file_ids: [], position: 1,
            paused: true, pause_reason: 'stopped'
          }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })

    render(<Composer />)

    expect(screen.getByText('Paused after Stop')).toBeInTheDocument()
    expect(screen.getByText('Paused')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send now' })).toHaveAttribute('title', 'Send this queued message now')
    expect(screen.queryByText('Working')).not.toBeInTheDocument()
  })

  it('warns before retrying an unconfirmed delivery', () => {
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [{
            queued_id: 'queued-uncertain', session_id: 'chat-1', prompt: 'Potentially delivered', file_ids: [], position: 1,
            paused: true, pause_reason: 'delivery_uncertain'
          }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })

    render(<Composer />)

    expect(screen.getByText('Delivery unconfirmed — review before retrying')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send now' })).toHaveAttribute(
      'title',
      'Delivery was not confirmed. Review the message, then send it again only if needed.'
    )
  })

  it('preserves and shifts an inline queued route hint while the save is pending', async () => {
    let finishUpdate!: () => void
    const update = vi.fn(() => new Promise<boolean>(resolve => { finishUpdate = () => resolve(true) }))
    const list = vi.fn().mockResolvedValue([])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { update, list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Target', backend: 'claude' }
      ],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: durableComposerCapability()
        }
      },
      agentRoutesBySession: {
        'chat-1': { routes: [grantedComposerRoute()], max_routes: 16 }
      },
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [{
            queued_id: 'queued-ref', session_id: 'chat-1', prompt: 'Raw provider prompt', display_prompt: 'Ask @Target now', file_ids: [], position: 1,
            chat_references: [{
              session_id: 'chat-2', display_title_snapshot: 'Target',
              source_text_start: 4, source_text_end: 11, action: 'route'
            }]
          }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByTitle('More queue actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
    const editor = document.querySelector('.inline-editor textarea') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'Please Ask @Target now' } })
    expect(document.querySelector('.inline-editor span[title="@Target · Route hint"]')).toHaveClass('composer-inline-reference', 'action-route')
    expect(document.querySelector('.inline-editor .chat-reference-shelf')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('chat-1', 'queued-ref', 'Please Ask @Target now', [{
      session_id: 'chat-2', display_title_snapshot: 'Target',
      source_text_start: 11, source_text_end: 18, action: 'route'
    }], ['codex_interactive_v1', 'codex_goal_steer_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2', 'agent_cross_chat_routes_v2']))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    await act(async () => finishUpdate())
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument())
    expect(screen.getByText('Please Ask @Target now')).toBeInTheDocument()
    expect(list).not.toHaveBeenCalled()
  })

  it('saves a projected queued message with its exact link, recipient and existing attachment IDs', async () => {
    const update = vi.fn().mockResolvedValue(true)
    window.agentsDock.queue = { update, list: vi.fn().mockResolvedValue([]) } as unknown as AgentsDockAPI['queue']
    const href = teamMessageLinkURL({ section: 'mail', teamId: 'team-1', messageId: 'queued-source', mailboxBox: 'sent', serverIdentity: 'server-a' })
    const prompt = `Read [Original](${href}) from @@DPark`
    const reference = teamRecipientReference(prompt.indexOf('@@DPark'))
    useAppStore.setState({
      health: teamMessagesHealth(),
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [],
          queuedTurns: [{
            queued_id: 'queued-link', session_id: 'chat-1', prompt, file_ids: ['file-existing'], position: 1,
            team_references: [reference]
          }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)
    await user.click(screen.getByTitle('More queue actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
    const editor = document.querySelector('.inline-editor textarea') as HTMLTextAreaElement
    await user.click(editor)
    expect(editor).toHaveFocus()
    expect(editor).toHaveValue('Read Original from @@DPark')
    expect(screen.getByRole('link', { name: 'Original' })).toHaveAttribute('href', href)
    const next = `🧭\n${editor.value}`
    fireEvent.change(editor, { target: { value: next, selectionStart: 3, selectionEnd: 3 } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(
      'chat-1', 'queued-link', `🧭\n${prompt}`, [], ['codex_interactive_v1', 'codex_goal_steer_v1'], [{
        ...reference, source_text_start: reference.source_text_start + 3,
        source_text_end: reference.source_text_end + 3
      }]
    ))
    expect(useAppStore.getState().snapshots['chat-1']?.queuedTurns?.[0]?.file_ids).toEqual(['file-existing'])
  })

  it('preserves and shifts structured Team references through a queued edit', async () => {
    const update = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { update, list: vi.fn().mockResolvedValue([]) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      health: teamMessagesHealth(),
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [],
          queuedTurns: [{
            queued_id: 'queued-team', session_id: 'chat-1', prompt: 'Tell @@DPark later', file_ids: [], position: 1,
            team_references: [teamRecipientReference(5)]
          }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByTitle('More queue actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
    const editor = document.querySelector('.inline-editor textarea') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'Please Tell @@DPark later', selectionStart: 25 } })
    expect(document.querySelector('.inline-editor span[title="@@DPark · Team member"]')).toHaveClass('team-reference')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith(
      'chat-1',
      'queued-team',
      'Please Tell @@DPark later',
      [],
      ['codex_interactive_v1', 'codex_goal_steer_v1'],
      [teamRecipientReference(12)]
    ))
  })

  it('selects @@bulletin while editing a queue item and preserves exact whitespace offsets', async () => {
    const update = vi.fn().mockResolvedValue(true)
    const status = {
      version: 1 as const,
      profileId: 'profile-a', profileGeneration: 17, serverIdentity: 'server-queued-team',
      serverName: 'Local', serverUrl: 'http://127.0.0.1:7850', generation: 9,
      hubUrl: 'https://hub.test', hubIdentity: 'hub-queued-team', savedHubIdentity: 'hub-queued-team',
      transport: 'secure_peer' as const, designatedHost: false,
      availabilityMessage: null, availabilityAction: null, canForgetBinding: true,
      connectionState: 'authenticated' as const, authenticated: true, bootstrapRequired: false,
      principal: { id: 'person-0', display_name: 'Pat' },
      session: { id: 'hub-session', device_label: 'Studio', expires_at: '2026-12-01T00:00:00Z' },
      error: null
    }
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { update, list: vi.fn().mockResolvedValue([]) },
        teamHub: {
          status: vi.fn().mockResolvedValue(status),
          teamMessagesCapabilities: vi.fn().mockResolvedValue({ available: true, version: 1 }),
          workspace: vi.fn().mockResolvedValue({
            status,
            teams: [{ id: 'team-1', kind: 'shared', slug: 'core', display_name: 'Core', role: 'owner', status: 'active' }]
          }),
          team: vi.fn().mockResolvedValue({
            members: [{ principal_id: 'person-1', role: 'member', status: 'active', display_name: 'DPark' }]
          }),
          network: vi.fn().mockResolvedValue({ servers: [], next_after_server_id: null, has_more: false }),
          teamSkills: vi.fn().mockResolvedValue({ skills: [] })
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 17,
      profiles: [{
        id: 'profile-a', name: 'Local', serverUrl: 'http://127.0.0.1:7850',
        serverIdentity: 'server-queued-team', hasAccessToken: true, serverSetupComplete: true,
        connectionState: 'online', cachedUnreadCount: 0
      }],
      health: teamMessagesHealth(),
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [],
          queuedTurns: [{
            queued_id: 'queued-team-new', session_id: 'chat-1', prompt: 'Draft later',
            file_ids: [], position: 1
          }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByTitle('More queue actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
    const editor = document.querySelector('.inline-editor textarea') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '  Tell @@bu', selectionStart: 11, selectionEnd: 11 } })
    const palette = await screen.findByRole('listbox', { name: 'Team Network destinations' })
    expect(within(palette).queryByRole('option', { name: /DPark/ })).not.toBeInTheDocument()
    await user.click(within(palette).getByRole('option', { name: /Bulletin.*@@bulletin/i }))

    expect(editor).toHaveValue('  Tell @@bulletin ')
    expect(document.querySelector('.inline-editor span[title="@@bulletin · Bulletin"]')).toHaveClass('team-reference')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith(
      'chat-1',
      'queued-team-new',
      '  Tell @@bulletin ',
      [],
      ['codex_interactive_v1', 'codex_goal_steer_v1'],
      [{
        kind: 'recipient', recipient_kind: 'all', team_id: 'team-1', target_id: 'all',
        display_name_snapshot: 'bulletin', source_text_start: 7, source_text_end: 17, grant_intent: true
      }]
    ))
  })

  it('shows queue edit progress and admits only one Save while the commit is pending', async () => {
    let finishUpdate!: () => void
    const update = vi.fn(() => new Promise<boolean>(resolve => { finishUpdate = () => resolve(true) }))
    const list = vi.fn().mockRejectedValue(new Error('redundant refresh'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { update, list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [{
            queued_id: 'queued-edit', session_id: 'chat-1', prompt: 'Old raw prompt',
            display_prompt: 'Old visible prompt', file_ids: [], position: 1
          }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByTitle('More queue actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
    expect(document.querySelector('.inline-queue-reference-editor')).not.toHaveClass('has-inline-references')
    expect(document.querySelector('.inline-editor .composer-editor-mirror')).not.toBeInTheDocument()
    fireEvent.change(document.querySelector('.inline-editor textarea') as HTMLTextAreaElement, {
      target: { value: 'New visible prompt' }
    })
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Saving…' }))
    expect(update).toHaveBeenCalledTimes(1)

    await act(async () => finishUpdate())
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument())
    expect(screen.getByText('New visible prompt')).toBeInTheDocument()
    expect(list).not.toHaveBeenCalled()
  })

  it('keeps a committed queue edit visible when a new inbound delivery cancels its separate Send now promotion', async () => {
    let finishUpdate!: () => void
    const update = vi.fn(() => new Promise<boolean>(resolve => { finishUpdate = () => resolve(true) }))
    const runNow = vi.fn()
    const list = vi.fn().mockResolvedValue([])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { update, runNow, list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [{
            queued_id: 'queued-edit-promote', session_id: 'chat-1', prompt: 'Old prompt',
            file_ids: [], position: 1
          }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      const user = userEvent.setup()
      render(<Composer />)

      await user.click(screen.getByTitle('More queue actions'))
      await user.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
      const editor = document.querySelector('.inline-editor textarea') as HTMLTextAreaElement
      fireEvent.change(editor, { target: { value: 'Updated before promotion' } })
      fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })
      await waitFor(() => expect(update).toHaveBeenCalledOnce())

      const snapshot = useAppStore.getState().snapshots['chat-1']
      act(() => useAppStore.setState({
        activeSessionIds: new Set(['chat-1']),
        snapshots: {
          ...useAppStore.getState().snapshots,
          'chat-1': {
            ...snapshot,
            events: [{
              id: 'incoming-after-edit-started', session_id: 'chat-1', seq: 10,
              type: 'turn_started', ts: '2026-09-05T00:00:00Z', run_id: 'incoming-after-edit-started',
              purpose: 'cross_chat_handoff_delivery'
            }]
          }
        }
      }))
      await act(async () => finishUpdate())

      await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument())
      expect(screen.getByText('Updated before promotion')).toBeInTheDocument()
      expect(confirm).toHaveBeenCalledOnce()
      expect(runNow).not.toHaveBeenCalled()
      expect(list).not.toHaveBeenCalled()
    } finally {
      confirm.mockRestore()
    }
  })

  it('canonicalizes legacy queued @ direct and @@ route records to one inline @ route contract', async () => {
    const update = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { update, list: vi.fn().mockResolvedValue([]) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Target', backend: 'claude' }
      ],
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability({
        actions: ['route', 'instruction']
      }) } },
      agentRoutesBySession: {
        'chat-1': { routes: [grantedComposerRoute()], max_routes: 16 }
      },
      snapshots: { 'chat-1': {
        session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [],
        queuedTurns: [{
          queued_id: 'queued-addressed', session_id: 'chat-1', prompt: '@Target then @@Target', file_ids: [], position: 1,
          chat_references: [
            { session_id: 'chat-2', display_title_snapshot: 'Target', source_text_start: 0, source_text_end: 7, action: 'direct_message' },
            { session_id: 'chat-2', display_title_snapshot: 'Target', source_text_start: 13, source_text_end: 21, action: 'route' }
          ]
        }],
        files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
      } }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByTitle('More queue actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
    expect(document.querySelector('.inline-editor span[title="@Target · Route hint"]')).toHaveClass('composer-inline-reference', 'action-route')
    expect(document.querySelectorAll('.inline-editor .composer-inline-reference')).toHaveLength(1)
    const editor = document.querySelector('.inline-editor textarea') as HTMLTextAreaElement
    expect(editor).toHaveValue('@Target then @Target')
    fireEvent.change(editor, { target: { value: 'Please @Target then @Target' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('chat-1', 'queued-addressed', 'Please @Target then @Target', [
      { session_id: 'chat-2', display_title_snapshot: 'Target', source_text_start: 7, source_text_end: 14, action: 'route' }
    ], expect.any(Array)))
  })

  it('offers only already-granted Send targets while editing a queued turn and never mints access', async () => {
    const update = vi.fn().mockResolvedValue(true)
    const granted = grantedComposerRoute('chat-2', 'Training', ['instruction'])
    const listRoutes = vi.fn().mockResolvedValue({ routes: [granted], max_routes: 16 })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { update, list: vi.fn().mockResolvedValue([]) },
        agentRoutes: { list: listRoutes }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      connected: true,
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' },
        { id: 'chat-3', title: 'Mobile', backend: 'codex' }
      ],
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability() } },
      agentRoutesBySession: { 'chat-1': { routes: [granted], max_routes: 16 } },
      snapshots: { 'chat-1': {
        session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [],
        queuedTurns: [{ queued_id: 'queued-edit-route', session_id: 'chat-1', prompt: 'Ask later', file_ids: [], position: 1 }],
        files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
      } }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByTitle('More queue actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
    const editor = document.querySelector('.inline-editor textarea') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'Ask @' } })
    const palette = await screen.findByRole('listbox', { name: 'Granted chats' })
    expect(within(palette).getByRole('option', { name: /Training.*Granted.*Send/i })).toBeInTheDocument()
    expect(within(palette).queryByRole('option', { name: /Mobile/ })).not.toBeInTheDocument()
    await user.click(within(palette).getByRole('option', { name: /Training/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('chat-1', 'queued-edit-route', 'Ask @Training ', [{
      session_id: 'chat-2', display_title_snapshot: 'Training',
      source_text_start: 4, source_text_end: 13, action: 'route', grant_intent: true
    }], expect.arrayContaining(['agent_cross_chat_routes_v2'])))
    expect(listRoutes).toHaveBeenCalled()
  })

  it('keeps a downgraded queued request-reply edit open and does not mutate it', async () => {
    const update = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { update, list: vi.fn().mockResolvedValue([]) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }, { id: 'chat-2', title: 'Target', backend: 'claude' }],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: {
            available: true, required: false, message: '', action: null,
            version: 1, actions: ['instruction', 'final_result'], supported_target_backends: ['codex', 'claude']
          }
        }
      },
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [],
          queuedTurns: [{
            queued_id: 'queued-ref', session_id: 'chat-1', prompt: 'Ask @Target now', file_ids: [], position: 1,
            chat_references: [{
              session_id: 'chat-2', display_title_snapshot: 'Target',
              source_text_start: 4, source_text_end: 11, action: 'request_reply'
            }]
          }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByTitle('More queue actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(update).not.toHaveBeenCalled()
    expect(document.querySelector('.inline-editor span[title="@Target · Reply expected"]')).toHaveClass('unsupported')
    expect(screen.getByText('One or more legacy chat references cannot be used on this server.')).toBeInTheDocument()
  })

  it('keeps a queued secure-peer @ reference readable but blocks Save and Send now without mutating IPC', async () => {
    const reference = securePeerChatReference(4)
    const queued: QueuedTurn = {
      queued_id: 'queued-secure-peer', session_id: 'chat-1', prompt: 'Ask @Studio/training',
      file_ids: [], position: 1, chat_references: [reference]
    }
    const update = vi.fn()
    const runNow = vi.fn()
    const list = vi.fn().mockResolvedValue([queued])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { update, runNow, list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability() } },
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [], queuedTurns: [queued],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    const sendNow = screen.getByRole('button', { name: 'Send now' })
    expect(sendNow).toBeDisabled()
    expect(sendNow).toHaveAttribute('title', expect.stringMatching(/use @@ Team Network Inbox/i))
    fireEvent.click(sendNow)
    expect(runNow).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()

    await user.click(screen.getByTitle('More queue actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
    const editor = document.querySelector('.inline-editor textarea') as HTMLTextAreaElement
    expect(editor).toBeEnabled()
    expect(editor).toHaveValue('Ask @Studio/training')
    expect(document.querySelector('.inline-editor span[title="@Studio/training · Agent may send"]')).toHaveClass('unsupported')
    expect(screen.getByText(/Remote agent routes cannot be used from @Chat.*use @@ Team Network Inbox/i)).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.click(save)

    fireEvent.change(editor, { target: { value: 'Please Ask @Studio/training' } })
    expect(editor).toHaveValue('Please Ask @Studio/training')
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(useAppStore.getState().error).toMatch(/use @@ Team Network Inbox/i))
    expect(update).not.toHaveBeenCalled()
    expect(runNow).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })

  it('labels an image-only queued turn by its attachment count', () => {
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [{ queued_id: 'queued-image', session_id: 'chat-1', prompt: '', file_ids: ['image-1'], position: 1 }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0,
        }
      }
    })

    render(<Composer />)

    expect(screen.getByText('1 attachment')).toBeInTheDocument()
  })

  it('renders a promoted queue row as immutable provider handoff work', () => {
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [
            {
              queued_id: 'queued-starting', session_id: 'chat-1', prompt: 'Hand this off',
              file_ids: [], position: 1, promoted: true
            },
            {
              queued_id: 'queued-later', session_id: 'chat-1', prompt: 'Later work',
              file_ids: [], position: 2
            }
          ],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })

    render(<Composer />)

    const starting = screen.getByRole('status', { name: 'Hand this off, starting provider handoff' })
    expect(within(starting).getByText('Starting…')).toBeVisible()
    expect(within(starting).getByText(/handed to the provider/)).toBeVisible()
    expect(within(starting).queryByTitle('Drag to reorder')).not.toBeInTheDocument()
    expect(within(starting).queryByTitle('Remove from queue')).not.toBeInTheDocument()
    expect(within(starting).queryByTitle('More queue actions')).not.toBeInTheDocument()
    expect(within(starting).queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send now' })).toHaveAttribute(
      'title',
      'A queued message is already starting'
    )
  })

  it('keeps a long steer prompt in the bounded queue prompt surface', () => {
    const longPrompt = `Inspect ${'/workspace/a-very-long-unbroken-worktree-name/'.repeat(12)} and report the exact status.`
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [{ queued_id: 'queued-long', session_id: 'chat-1', prompt: longPrompt, display_prompt: longPrompt, file_ids: [], position: 1 }],
          files: [],
          hasMoreEvents: false,
          filesTotal: 0,
          cachedAt: 0
        }
      }
    })

    render(<Composer />)

    const prompt = screen.getByText(longPrompt)
    expect(prompt).toHaveClass('queue-prompt')
    expect(prompt).toHaveAttribute('title', longPrompt)
    expect(prompt.closest('.queued-row')).toBeInTheDocument()
  })

  it('reports queue action failures instead of leaving an unhandled rejection', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: {
          runNow: vi.fn().mockRejectedValue(new Error('Queued turn not found')),
          list: vi.fn().mockResolvedValue([{ queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Run this', file_ids: [] }])
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      error: null,
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [],
          queuedTurns: [{ queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Run this', file_ids: [], position: 1 }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByRole('button', { name: 'Send now' }))

    await waitFor(() => expect(useAppStore.getState().error).toBe('Queued turn not found'))
  })

  it('disables duplicate steer requests and shows a calm pending state', async () => {
    let accept!: () => void
    const runNow = vi.fn(() => new Promise<void>(resolve => { accept = resolve }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: {
          runNow,
          list: vi.fn().mockResolvedValue([])
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [],
          queuedTurns: [{ queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Run this', file_ids: [], position: 1 }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByRole('button', { name: 'Send now' }))

    expect(screen.getByRole('button', { name: 'Send now' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send now' })).toHaveAttribute('title', 'A queued turn action is already in progress')
    expect(screen.getAllByText('Starting…').length).toBeGreaterThan(0)
    expect(runNow).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Send now' }))
    expect(runNow).toHaveBeenCalledTimes(1)

    await act(async () => accept())
    await waitFor(() => expect(screen.queryByText('Starting…')).not.toBeInTheDocument())
  })

  it('keeps the running Stop control in the trailing action rail and keyboard reachable during a pending steer', async () => {
    let accept!: () => void
    const runNow = vi.fn(() => new Promise<void>(resolve => { accept = resolve }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { runNow, list: vi.fn().mockResolvedValue([]) },
        turns: { stop: vi.fn().mockResolvedValue({ stopped: true, pending: false, message: '' }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeSessionIds: new Set(['chat-1']),
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [],
          queuedTurns: [{ queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Run this', file_ids: [], position: 1 }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const user = userEvent.setup()
    const view = render(<Composer />)

    await user.click(screen.getByRole('button', { name: 'Send now' }))

    expect(screen.getByText('Sending now…').closest('[role="status"]')).toHaveClass('steering-pending')
    const stop = screen.getByRole('button', { name: 'Stop' })
    const actions = stop.closest('.composer-actions')
    expect(actions).not.toBeNull()
    expect(actions?.parentElement).toHaveClass('composer-bar')
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Queue message' }))
    expect(view.container.querySelector('.composer-bar')?.lastElementChild).toBe(actions)

    for (let index = 0; index < 30 && document.activeElement !== stop; index += 1) await user.tab()
    expect(stop).toHaveFocus()

    await act(async () => accept())
    await waitFor(() => expect(screen.queryByText('Sending now…')).not.toBeInTheDocument())
  })

  it.each([
    ['Next request', 'First request\n\nNext request'],
    ['First request', 'First request'],
    ['  First request  ', '  First request  ']
  ])('preserves next draft %j while a failed send is still in flight', async (newerDraft, restoredDraft) => {
    let rejectSend!: (error: Error) => void
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send: vi.fn(() => new Promise((_resolve, reject) => { rejectSend = reject })) }
      } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, 'First request')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(screen.getByTitle('Wait for the message to be accepted before changing backend')).toBeDisabled()
    await user.type(editor, newerDraft)
    await act(async () => rejectSend(new Error('offline')))

    await waitFor(() => expect(editor).toHaveValue(restoredDraft))
    expect(useAppStore.getState().drafts['chat-1']).toBe(restoredDraft)
    expect(window.agentsDock.turns.send).toHaveBeenCalledTimes(1)
    expect(screen.getByTitle('Change backend')).toBeEnabled()
    expect(useAppStore.getState().turnAdmissionTokens['chat-1']).toBeUndefined()
  })

  it('does not restore an accepted prompt when the HTTP response is lost', async () => {
    const pendingSend = deferred<never>()
    const send = vi.fn(() => pendingSend.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, 'Accepted request')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await act(async () => {
      useAppStore.setState({ snapshots: { 'chat-1': {
        session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
        events: [{ id: 'accepted', session_id: 'chat-1', seq: 1, type: 'turn_started', ts: '2026-09-22T00:00:00Z', prompt: 'Accepted request', file_ids: [] }],
        queuedTurns: [], files: [], filesTotal: 0, hasMoreEvents: false, cachedAt: 0
      } } })
      pendingSend.reject(new Error('HTTP response lost'))
    })

    await waitFor(() => expect(useAppStore.getState().turnAdmissionTokens['chat-1']).toBeUndefined())
    expect(editor).toHaveValue('')
    expect(useAppStore.getState().drafts['chat-1']).toBe('')
    expect(useAppStore.getState().error).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('uses Command-Enter to steer a new message immediately', async () => {
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      queued: true,
      queued_id: 'queued-steer'
    })
    const runNow = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send },
        queue: { runNow, list: vi.fn().mockResolvedValue([]) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ activeSessionIds: new Set(['chat-1']) })
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')
    fireEvent.change(editor, { target: { value: 'Steer this now' } })
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })

    await waitFor(() => expect(runNow).toHaveBeenCalledWith('chat-1', 'queued-steer'))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat-1', prompt: 'Steer this now' }))
    expect(editor).toHaveValue('')
  })

  it('rechecks a new inbound delivery after the send is admitted but before promotion', async () => {
    const pendingSend = deferred<{ session: Session; queued: boolean; queued_id: string }>()
    const send = vi.fn(() => pendingSend.promise)
    const runNow = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send },
        queue: { runNow, list: vi.fn().mockResolvedValue([]) }
      } as unknown as AgentsDockAPI
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')
    fireEvent.change(editor, { target: { value: 'Steer after admission' } })
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(send).toHaveBeenCalledOnce())

    act(() => useAppStore.setState({
      activeSessionIds: new Set(['chat-1']),
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [{
            id: 'new-inbound', session_id: 'chat-1', seq: 5, type: 'turn_started',
            ts: '2026-09-05T00:00:00Z', run_id: 'new-inbound', purpose: 'cross_chat_handoff_delivery'
          }],
          queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    }))
    await act(async () => pendingSend.resolve({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      queued: true,
      queued_id: 'queued-steer'
    }))

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(runNow).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('uses Control-Enter with an empty editor to steer the first queued message on Windows/Linux', async () => {
    const first = { queued_id: 'queued-first', session_id: 'chat-1', prompt: 'First queued turn', file_ids: [], position: 1 }
    const second = { queued_id: 'queued-second', session_id: 'chat-1', prompt: 'Second queued turn', file_ids: [], position: 2 }
    const runNow = vi.fn().mockResolvedValue(true)
    const list = vi.fn().mockResolvedValueOnce([second, first]).mockResolvedValueOnce([second])
    const send = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send },
        queue: { runNow, list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [], queuedTurns: [first, second],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    render(<Composer />)

    fireEvent.keyDown(screen.getByPlaceholderText('Message'), { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(runNow).toHaveBeenCalledWith('chat-1', 'queued-first'))
    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().snapshots['chat-1'].queuedTurns).toEqual([second])
  })

  it('rechecks a new inbound delivery after loading the first queued message', async () => {
    const first = { queued_id: 'queued-first', session_id: 'chat-1', prompt: 'First queued turn', file_ids: [], position: 1 }
    const pendingList = deferred<QueuedTurn[]>()
    const runNow = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: { runNow, list: vi.fn(() => pendingList.promise) }
      } as unknown as AgentsDockAPI
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<Composer />)
    fireEvent.keyDown(screen.getByPlaceholderText('Message'), { key: 'Enter', ctrlKey: true })

    act(() => useAppStore.setState({
      activeSessionIds: new Set(['chat-1']),
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [{
            id: 'new-peer-inbound', session_id: 'chat-1', seq: 6, type: 'turn_started',
            ts: '2026-09-05T00:00:00Z', run_id: 'new-peer-inbound', purpose: 'secure_peer_handoff_delivery'
          }],
          queuedTurns: [first], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    }))
    await act(async () => pendingList.resolve([first]))

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(runNow).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('exposes an accessible slash palette and filters commands by provider and server capability', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        codex: composerCodexBridge(vi.fn().mockResolvedValue([]), {
          approval_policy: 'on-request', sandbox_mode: 'workspace-write', approvals_reviewer: 'user'
        }),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      // Summary session payloads intentionally omit permission fields. The
      // live runtime policy still makes Permissions actionable.
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      chatPanes: { primary: 'chat-1', secondary: null },
      focusedChatPane: 'primary',
      health: {
        ok: true,
        api_contract_version: 15,
        capabilities: {
          codex_controls: {
            available: true, required: false, message: '', action: null,
            features: { goals: true, approvals: true }
          },
          scheduled_jobs: { available: false, required: false, message: 'Update required', action: null },
          cross_chat_handoffs_v1: durableComposerCapability(),
          local_session_import_v1: {
            available: true, required: false, message: '', action: null,
            version: 1, max_batch_items: 25, max_list_items: 500
          }
        }
      }
    })
    const user = userEvent.setup()
    render(<CodexComposerHarness />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, '/')

    const palette = screen.getByRole('listbox', { name: 'Codex chat commands' })
    const first = screen.getByRole('option', { name: /Attach files/ })
    expect(editor).toHaveAttribute('aria-expanded', 'true')
    expect(editor).toHaveAttribute('aria-controls', palette.id)
    expect(editor).toHaveAttribute('aria-activedescendant', first.id)
    expect(screen.getByRole('option', { name: /Contact another chat/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Send Team Network mail/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^Goal/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /^MCP servers/ })).not.toBeInTheDocument()
    expect(await screen.findByRole('option', { name: /^Permissions/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Plan mode/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /^Schedule/ })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^Import Chat/ })).toBeInTheDocument()

    act(() => {
      useAppStore.setState({ health: { ...useAppStore.getState().health!, api_contract_version: 14 } })
    })
    await waitFor(() => expect(screen.queryByRole('option', { name: /^Import Chat/ })).not.toBeInTheDocument())
  })

  it('lazily lists Codex skills, collapses exact duplicates, distinguishes variants, and sends the selected opaque binding', async () => {
    const list = vi.fn().mockResolvedValue({
      backend: 'codex',
      revision: 'skills-rev-4',
      support: { available: true, mode: 'native' },
      commands: [
        {
          id: 'opaque-project', name: 'review-code', label: 'Review code',
          description: 'Review this change', scope: 'project', source: '.agents',
          kind: 'skill', invocation: '/review-code'
        },
        {
          id: 'opaque-project-mirror', name: 'review-code', label: 'Review code',
          description: 'Review this change', scope: 'project', source: '.agents',
          kind: 'skill', invocation: '/review-code'
        },
        {
          id: 'opaque-user', name: 'review-code', label: 'Review code',
          description: 'Review using personal guidance', scope: 'user', source: 'Codex',
          kind: 'skill', invocation: '/review-code'
        },
        {
          id: 'opaque-collision', name: 'model', label: 'Provider model command',
          description: 'Must not replace AgentsDock model', scope: 'user', source: 'Codex',
          kind: 'skill', invocation: '/model'
        },
        {
          id: 'opaque-path', name: 'unsafe', label: 'Unsafe', description: 'Invalid invocation',
          scope: 'user', source: 'Codex', kind: 'skill', invocation: '/Users/me/unsafe'
        },
        {
          id: 'opaque-safe', name: 'safe', label: 'No path leak', description: 'Valid command',
          scope: 'project', source: '/Users/me/.codex/skills/safe', kind: 'skill', invocation: '/safe'
        }
      ]
    })
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, queued: false
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        providerCommands: { list }, turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      connected: true,
      health: {
        ok: true,
        api_contract_version: 15,
        capabilities: {
          local_session_import_v1: {
            available: true, required: false, message: '', action: null,
            version: 1, max_batch_items: 25, max_list_items: 500
          }
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)
    expect(list).not.toHaveBeenCalled()

    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, '  /')
    const skills = await screen.findAllByRole('option', { name: /^Review code/ })

    expect(list).toHaveBeenCalledOnce()
    expect(screen.getByRole('group', { name: 'Skills' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^Import Chat/ }).closest('[role="group"]')).toHaveAttribute('aria-label', 'AgentsDock')
    expect(skills).toHaveLength(2)
    expect(skills[0]).toHaveTextContent('project · .agents')
    expect(skills[1]).toHaveTextContent('user · Codex')
    expect(screen.queryByRole('option', { name: /^Provider model command/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /^Unsafe/ })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^No path leak/ })).not.toHaveTextContent('/Users/me')

    await user.click(skills[0])
    expect(editor).toHaveFocus()
    expect(editor).toHaveValue('/review-code ')
    await user.type(editor, 'focus on concurrency')
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '/review-code focus on concurrency',
      skillSelection: { id: 'opaque-project', revision: 'skills-rev-4' }
    })))
  })

  it('clears a selected provider-command binding when its leading token is edited or displaced', async () => {
    const list = vi.fn().mockResolvedValue({
      backend: 'claude', revision: 'commands-rev-1',
      support: { available: true, mode: 'sdk' },
      commands: [{
        id: 'opaque-claude', name: 'plugin:review_code.v2', label: 'Review code',
        description: 'Claude command', scope: 'plugin', source: 'reviewer',
        kind: 'command', invocation: '/plugin:review_code.v2'
      }]
    })
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'claude' }, queued: false
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        providerCommands: { list }, turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      connected: true,
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude' }]
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, '/plugin:review')
    expect(await screen.findByRole('group', { name: 'Claude commands' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: /^Review code/ }))
    fireEvent.change(editor, {
      target: { value: '/plugin:review_code.v3 explain', selectionStart: 35, selectionEnd: 35 }
    })
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('skillSelection')

    send.mockClear()
    await user.type(editor, '/plugin:review')
    await user.click(screen.getByRole('option', { name: /^Review code/ }))
    fireEvent.change(editor, {
      target: { value: '\ufeff/plugin:review_code.v2 explain', selectionStart: 31, selectionEnd: 31 }
    })
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('skillSelection')

    for (const invalidBoundary of ['\v', '\f']) {
      send.mockClear()
      await user.clear(editor)
      await user.type(editor, '/plugin:review')
      await user.click(screen.getByRole('option', { name: /^Review code/ }))
      const prompt = `/plugin:review_code.v2${invalidBoundary}explain`
      fireEvent.change(editor, {
        target: { value: prompt, selectionStart: prompt.length, selectionEnd: prompt.length }
      })
      fireEvent.keyDown(editor, { key: 'Enter' })

      await waitFor(() => expect(send).toHaveBeenCalledOnce())
      expect(send.mock.calls[0]?.[0]).not.toHaveProperty('skillSelection')
    }
  })

  it('refreshes stale provider commands after a selected send fails without rebinding the restored draft', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({
        backend: 'codex', revision: 'stale-rev',
        support: { available: true, mode: 'native' },
        commands: [{
          id: 'opaque-stale', name: 'review-code', label: 'Review code',
          description: 'Stale command', scope: 'user', source: 'Codex',
          kind: 'skill', invocation: '/review-code'
        }]
      })
      .mockResolvedValueOnce({
        backend: 'codex', revision: 'fresh-rev',
        support: { available: true, mode: 'native' },
        commands: [{
          id: 'opaque-fresh', name: 'review-code', label: 'Review code',
          description: 'Fresh command', scope: 'user', source: 'Codex',
          kind: 'skill', invocation: '/review-code'
        }]
      })
    const send = vi.fn()
      .mockRejectedValueOnce(new Error(
        "Error invoking remote method 'turns:send': Error: the provider command list changed; choose the command again"
      ))
      .mockResolvedValueOnce({ session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, queued: false })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        providerCommands: { list }, turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      connected: true,
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex', cwd: '/test/provider-stale' }]
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, '/review')
    await user.click(await screen.findByRole('option', { name: /^Review code/ }))
    await user.type(editor, 'focus on races')
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => expect(editor).toHaveValue('/review-code focus on races'))
    await waitFor(() => expect(list).toHaveBeenNthCalledWith(2, 'chat-1', true))
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      skillSelection: { id: 'opaque-stale', revision: 'stale-rev' }
    }))
    expect(send.mock.calls[1]?.[0]).not.toHaveProperty('skillSelection')
  })

  it('keeps static commands usable when discovery fails and retries with an explicit refresh', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('endpoint temporarily unavailable'))
      .mockResolvedValueOnce({
        backend: 'codex', revision: 'retry-rev',
        support: { available: true, mode: 'native' },
        commands: [{
          id: 'opaque-retry', name: 'after-retry', label: 'After retry',
          description: 'Loaded after refreshing', scope: 'user', source: 'Codex',
          kind: 'skill', invocation: '/after-retry'
        }]
      })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        providerCommands: { list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      connected: true,
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex', cwd: '/test/provider-retry' }]
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.type(screen.getByPlaceholderText('Message'), '/')
    expect(screen.getByRole('option', { name: /Attach files/ })).toBeInTheDocument()
    expect(await screen.findByText('Couldn’t load provider commands.')).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Message'), 'after')
    expect(screen.getByText('Couldn’t load provider commands.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('option', { name: /^After retry/ })).toBeInTheDocument()
    expect(list).toHaveBeenNthCalledWith(1, 'chat-1', false)
    expect(list).toHaveBeenNthCalledWith(2, 'chat-1', true)
  })

  it('refreshes an expired provider-command cache when the slash palette is reopened', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const list = vi.fn().mockResolvedValue({
      backend: 'codex', revision: 'ttl-rev',
      support: { available: true, mode: 'native' },
      commands: [{
        id: 'opaque-ttl', name: 'ttl-skill', label: 'TTL skill',
        description: 'Reloaded after expiry', scope: 'user', source: 'Codex',
        kind: 'skill', invocation: '/ttl-skill'
      }]
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        providerCommands: { list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      connected: true,
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex', cwd: '/test/provider-ttl' }]
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, '/')
    expect(await screen.findByRole('option', { name: /^TTL skill/ })).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(editor, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    await user.clear(editor)
    now.mockReturnValue(40_001)
    await user.type(editor, '/')

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(list).toHaveBeenLastCalledWith('chat-1', true)
    now.mockRestore()
  })

  it('discards provider commands returned after the active chat changes', async () => {
    const first = deferred<{
      backend: 'codex'; revision: string
      support: { available: true; mode: string }
      commands: Array<{ id: string; name: string; label: string; description: string; kind: string; invocation: string }>
    }>()
    const list = vi.fn((sessionId: string) => sessionId === 'chat-1'
      ? first.promise
      : Promise.resolve({
          backend: 'codex' as const, revision: 'second-rev',
          support: { available: true as const, mode: 'native' },
          commands: [{
            id: 'opaque-second', name: 'second-chat', label: 'Second chat command',
            description: 'Current inventory', kind: 'skill', invocation: '/second-chat'
          }]
        }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        providerCommands: { list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      connected: true,
      sessions: [
        { id: 'chat-1', title: 'First', backend: 'codex', cwd: '/test/first' },
        { id: 'chat-2', title: 'Second', backend: 'codex', cwd: '/test/second' }
      ]
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, '/')
    expect(list).toHaveBeenCalledWith('chat-1', false)

    act(() => useAppStore.setState({
      selectedSessionId: 'chat-2',
      chatPanes: { primary: 'chat-2', secondary: null },
      focusedChatPane: 'primary'
    }))
    await waitFor(() => expect(editor).toHaveValue(''))
    await user.type(editor, '/')
    expect(await screen.findByRole('option', { name: /^Second chat command/ })).toBeInTheDocument()

    await act(async () => first.resolve({
      backend: 'codex', revision: 'first-rev', support: { available: true, mode: 'native' },
      commands: [{
        id: 'opaque-first', name: 'first-chat', label: 'First chat command',
        description: 'Stale inventory', kind: 'skill', invocation: '/first-chat'
      }]
    }))
    expect(screen.queryByRole('option', { name: /^First chat command/ })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^Second chat command/ })).toBeInTheDocument()
  })

  it('offers Claude plan controls only when the server and session make them actionable', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        claude: composerClaudeBridge({ permission_mode: 'plan' }),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude' }],
      chatPanes: { primary: 'chat-1', secondary: null },
      focusedChatPane: 'primary',
      health: {
        ok: true,
        capabilities: {
          claude_controls: {
            available: true, required: false, message: '', action: null,
            version: 3,
            features: { permission_mode_control: true, mcp_management: true },
            permission_modes: ['default', 'plan']
          }
        }
      }
    })
    const user = userEvent.setup()
    render(<ClaudeComposerHarness />)

    await user.type(screen.getByPlaceholderText('Message'), '/')

    expect(screen.getByRole('option', { name: /^Permissions/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Plan mode.*On/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^MCP servers/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /^Goal/ })).not.toBeInTheDocument()
  })

  it.each(['shortcut', 'add menu'] as const)('opens the selected Codex chat goal from the %s and only starts work on submission', async path => {
    const send = vi.fn()
    const setGoal = vi.fn().mockResolvedValue({
      goal: { threadId: 'thread-2', objective: 'Finish the selected chat task', status: 'active',
        tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null, updatedAt: 0 },
      time_budget_seconds: null
    })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
      turns: { send },
      codex: { ...composerCodexBridge(), setGoal, clearGoal: vi.fn() },
      events: { on: vi.fn().mockReturnValue(() => undefined) }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({
      selectedSessionId: 'chat-2',
      chatPanes: { primary: 'chat-2', secondary: null },
      sessions: [
        { id: 'chat-1', title: 'Other chat', backend: 'codex' },
        { id: 'chat-2', title: 'Selected chat', backend: 'codex' }
      ],
      health: { ok: true, capabilities: { codex_controls: {
        available: true, required: false, message: '', action: null, features: { goals: true }
      } } }
    })
    const user = userEvent.setup()
    render(<CodexGoalComposerHarness />)

    const shortcut = await screen.findByRole('button', { name: 'Codex goal' })
    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, 'Keep this unsent Codex draft')
    expect(shortcut).toHaveClass('composer-icon')
    if (path === 'shortcut') await user.click(shortcut)
    else {
      await user.click(screen.getByTitle('Add'))
      await user.click(await screen.findByRole('menuitem', { name: 'Codex goal' }))
    }

    const dialog = await screen.findByRole('dialog', { name: 'Codex goal' })
    expect(editor).toHaveValue('Keep this unsent Codex draft')
    await user.type(within(dialog).getByRole('textbox', { name: 'Completion condition' }), 'Finish the selected chat task')
    expect(send).not.toHaveBeenCalled()
    expect(setGoal).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Start goal' }))
    await waitFor(() => expect(setGoal).toHaveBeenCalledExactlyOnceWith('chat-2', {
      objective: 'Finish the selected chat task', status: 'active', token_budget: null, time_budget_seconds: null
    }))
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['shortcut', 'add menu'] as const)('keeps the Claude goal %s equivalent to Codex without sending a model turn', async path => {
    const send = vi.fn()
    const setGoal = vi.fn()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
      turns: { send },
      claude: { runtime: vi.fn().mockResolvedValue({ available: true, transport: 'sdk',
        interactive_capability: 'claude_sdk_interactive_v1', session_loaded: true,
        pending_interactions: [], features: { goals: true }, goal: null }), setGoal, clearGoal: vi.fn() },
      events: { on: vi.fn().mockReturnValue(() => undefined) }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({ sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude' }] })
    const user = userEvent.setup()
    render(<ClaudeComposerHarness />)

    const shortcut = await screen.findByRole('button', { name: 'Claude goal' })
    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, 'Keep this unsent Claude draft')
    expect(shortcut).toHaveClass('composer-icon')
    if (path === 'shortcut') await user.click(shortcut)
    else {
      await user.click(screen.getByTitle('Add'))
      await user.click(await screen.findByRole('menuitem', { name: 'Claude goal' }))
    }
    const dialog = await screen.findByRole('dialog', { name: 'Claude goal' })
    expect(editor).toHaveValue('Keep this unsent Claude draft')
    expect(within(dialog).getByRole('textbox', { name: 'Completion condition' })).toBeVisible()
    expect(send).not.toHaveBeenCalled()
    expect(setGoal).not.toHaveBeenCalled()
  })

  it.each(['codex', 'claude'] as const)('removes the unvalidated %s account usage popup without requesting quota', async backend => {
    const usage = vi.fn().mockResolvedValue({
      backend, status: 'available', source: backend === 'codex' ? 'codex-account' : 'claude-events',
      account_kind: 'subscription', observed_at: '2026-09-24T12:00:00Z',
      windows: [{ id: 'primary', label: '5 hours', used_percent: 25, resets_at: 1790254800,
        window_minutes: 300, observed_at: '2026-09-24T12:00:00Z' }]
    })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
      runtime: { usage },
      events: { on: vi.fn().mockReturnValue(() => undefined) }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({ connected: true,
      sessions: [{ id: 'chat-1', title: 'Chat', backend }],
      health: { ok: true, server_identity: 'server-a', server_instance_id: 'instance-a',
        capabilities: { provider_usage: { available: true, version: 1 } } }
    })
    render(<Composer />)
    await userEvent.setup().type(screen.getByPlaceholderText('Message'), 'Keep writing')
    expect(screen.queryByRole('button', { name: /^Account usage:/ })).not.toBeInTheDocument()
    expect(usage).not.toHaveBeenCalled()
  })

  it.each([
    ['keyboard selection', 'enter'],
    ['send-button fallback', 'send']
  ] as const)('opens native Claude goal controls by %s without creating a model turn', async (_label, path) => {
    const send = vi.fn()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
      turns: { send },
      claude: { runtime: vi.fn().mockResolvedValue({ available: true, transport: 'sdk',
        interactive_capability: 'claude_sdk_interactive_v1', session_loaded: true,
        pending_interactions: [], features: { goals: true }, goal: null }), setGoal: vi.fn(), clearGoal: vi.fn() },
      events: { on: vi.fn().mockReturnValue(() => undefined) }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({ sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude' }] })
    const user = userEvent.setup()
    render(<ClaudeComposerHarness />)
    expect(await screen.findByRole('button', { name: 'Claude goal' })).toBeInTheDocument()
    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, path === 'enter' ? '/goal' : '/goal  ')
    if (path === 'enter') {
      expect(screen.getByRole('option', { name: /Set or inspect a Claude completion condition/ })).toBeInTheDocument()
      fireEvent.keyDown(editor, { key: 'Enter' })
    } else await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await screen.findByRole('dialog', { name: 'Claude goal' })).toBeInTheDocument()
    expect(editor).toHaveValue('')
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ['keyboard selection', 'enter'],
    ['palette click', 'option'],
    ['send-button fallback', 'send']
  ] as const)('opens Claude MCP management by %s without creating a model turn', async (_label, path) => {
    const send = vi.fn()
    const mcp = vi.fn().mockResolvedValue({
      version: 1,
      available: true,
      transport: 'agent-sdk',
      generation: 'owner-a:sdk-1',
      session_loaded: true,
      servers: [],
      truncated: false,
      reason: null,
      action: null
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send },
        claude: { mcp, controlMcp: vi.fn() }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'claude' }],
      health: {
        ok: true,
        capabilities: {
          claude_controls: {
            available: true, required: false, message: '', action: null, version: 3,
            features: { mcp_management: true }
          }
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, path === 'send' ? '/mcp  ' : '/mcp')
    if (path === 'enter') fireEvent.keyDown(editor, { key: 'Enter' })
    else if (path === 'option') await user.click(screen.getByRole('option', { name: /^MCP servers/ }))
    else await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByRole('dialog', { name: 'Claude MCP servers' })).toBeInTheDocument()
    expect(editor).toHaveValue('')
    expect(send).not.toHaveBeenCalled()
    await waitFor(() => expect(mcp).toHaveBeenCalledWith('chat-1'))
  })

  it('never sends exact /mcp from a non-Claude chat', async () => {
    const send = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Composer />)

    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, '/mcp')
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toBe('/mcp is available in Claude chats only.')
  })

  it('supports slash keyboard navigation, Escape, Enter, Tab, and ignores composing Enter', async () => {
    const send = vi.fn()
    const requestNewChat = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      chatPanes: { primary: 'chat-1', secondary: null },
      focusedChatPane: 'primary',
      inspectorVisible: false,
      requestNewChat,
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, '/')
    const options = screen.getAllByRole('option')
    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    expect(editor).toHaveAttribute('aria-activedescendant', options[1].id)
    fireEvent.keyDown(editor, { key: 'End' })
    expect(editor).toHaveAttribute('aria-activedescendant', options.at(-1)!.id)
    fireEvent.keyDown(editor, { key: 'Home' })
    expect(editor).toHaveAttribute('aria-activedescendant', options[0].id)
    fireEvent.keyDown(editor, { key: 'ArrowUp' })
    expect(editor).toHaveAttribute('aria-activedescendant', options.at(-1)!.id)
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: /chat commands/ })).not.toBeInTheDocument()
    expect(editor).toHaveValue('/')

    await user.clear(editor)
    await user.type(editor, '/new')
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true })
    expect(screen.getByRole('listbox', { name: /chat commands/ })).toBeInTheDocument()
    expect(editor).toHaveValue('/new')
    expect(useAppStore.getState().modals.newChat).toBe(false)
    expect(send).not.toHaveBeenCalled()

    fireEvent.keyDown(editor, { key: 'Tab' })
    expect(requestNewChat).toHaveBeenCalledOnce()
    expect(editor).toHaveValue('')

    useAppStore.setState(state => ({
      inspectorVisible: false,
      modals: { ...state.modals, newChat: false }
    }))
    await user.click(editor)
    await user.type(editor, '/status')
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(useAppStore.getState().inspectorVisible).toBe(true)
    expect(editor).toHaveValue('')
    expect(send).not.toHaveBeenCalled()
  })

  it('gives the /chat command precedence and hands its replacement to the existing mention picker', async () => {
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude', folder: 'Research' }
      ],
      chatPanes: { primary: 'chat-1', secondary: null },
      focusedChatPane: 'primary',
      folderOrder: ['Research', 'General'],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: durableComposerCapability({ default_action: 'request_reply' })
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, '/chat')
    expect(screen.getByRole('listbox', { name: 'Codex chat commands' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Contact another chat/ })).toBeInTheDocument()
    expect(screen.queryByRole('listbox', { name: 'Chats' })).not.toBeInTheDocument()

    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(editor).toHaveValue('/chat ')
    expect(screen.queryByRole('listbox', { name: /chat commands/ })).not.toBeInTheDocument()
    const training = await screen.findByRole('option', { name: /Training/ })
    await user.click(training)
    expect(editor).toHaveValue('@Training ')
    expect(useAppStore.getState().chatReferencesBySession['chat-1']).toEqual([
      expect.objectContaining({ session_id: 'chat-2', action: 'route', source_text_start: 0, source_text_end: 9 })
    ])
  })

  it('inserts the server-mail syntax as an explicit mail-authority command', async () => {
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      queued: false
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      chatPanes: { primary: 'chat-1', secondary: null },
      focusedChatPane: 'primary',
      health: {
        ok: true,
        capabilities: {
          agent_team_mail_v1: {
            available: true,
            required: false,
            message: 'Ready',
            action: null,
            version: 1,
            explicit_command: '/mail',
            command_syntax: '/mail server <name> <message>',
            max_sends_per_run: 4,
            max_body_bytes: 8_192,
            features: { deterministic_server_message_command: true }
          }
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, '/mail')
    expect(screen.getByRole('option', { name: /Send Team Network mail/ })).toHaveTextContent('/mail server <name> <message>')
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(editor).toHaveValue('/mail server ')
    expect(screen.queryByRole('listbox', { name: /chat commands/ })).not.toBeInTheDocument()

    await user.type(editor, 'MBA hello from Studio')
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1',
      prompt: '/mail server MBA hello from Studio'
    })))
  })

  it('keeps /mail discoverable but blocks it against an older server', async () => {
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      chatPanes: { primary: 'chat-1', secondary: null },
      focusedChatPane: 'primary',
      health: { ok: true, capabilities: {} },
      error: null
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, '/mail')
    expect(screen.getByRole('option', { name: /Send Team Network mail/ })).toBeInTheDocument()
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(editor).toHaveValue('/mail')
    expect(useAppStore.getState().error).toMatch(/update AgentsServer/i)
  })

  it('rejects malformed deterministic mail before starting an agent turn', async () => {
    const send = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      chatPanes: { primary: 'chat-1', secondary: null },
      focusedChatPane: 'primary',
      health: {
        ok: true,
        capabilities: {
          agent_team_mail_v1: {
            available: true,
            required: false,
            message: 'Ready',
            action: null,
            version: 1,
            explicit_command: '/mail',
            command_syntax: '/mail server <name> <message>',
            max_sends_per_run: 1,
            max_body_bytes: 8_192,
            features: { deterministic_server_message_command: true }
          }
        }
      },
      error: null
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, '/mail server MBA')
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(send).not.toHaveBeenCalled()
    expect(editor).toHaveValue('/mail server MBA')
    expect(useAppStore.getState().error).toMatch(/message cannot be empty/i)
  })

  it('does not advertise deterministic mail against the legacy mail capability', async () => {
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      chatPanes: { primary: 'chat-1', secondary: null },
      focusedChatPane: 'primary',
      health: {
        ok: true,
        capabilities: {
          agent_team_mail_v1: {
            available: true,
            required: false,
            message: 'Explicitly authorized agent Team Network mail is available.',
            action: null,
            version: 1,
            explicit_command: '/mail',
            max_sends_per_run: 4,
            max_body_bytes: 8_192
          }
        }
      },
      error: null
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, '/mail')
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(editor).toHaveValue('/mail')
    expect(useAppStore.getState().error).toMatch(/deterministic Team Network mail/i)
  })

  it('shows every matching same-server chat in the scrollable @ picker', async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    try {
      const targets = Array.from({ length: 12 }, (_, index) => ({
      id: `chat-${index + 2}`,
      title: `Target ${String(index + 1).padStart(2, '0')}`,
      backend: index % 2 === 0 ? 'codex' as const : 'claude' as const,
      folder: 'All chats'
      }))
      useAppStore.setState({
        sessions: [{ id: 'chat-1', title: 'Source', backend: 'codex' }, ...targets],
        chatPanes: { primary: 'chat-1', secondary: null },
        focusedChatPane: 'primary',
        health: {
          ok: true,
          capabilities: {
            cross_chat_handoffs_v1: durableComposerCapability({
              actions: ['route', 'request_reply', 'instruction']
            })
          }
        }
      })
      const user = userEvent.setup()
      render(<Composer />)

      const editor = screen.getByPlaceholderText('Message')
      await user.type(editor, '@Target')

      const picker = screen.getByRole('listbox', { name: 'Chats' })
      expect(picker).toHaveClass('chat-mention-palette')
      expect(screen.getAllByRole('option')).toHaveLength(12)
      expect(screen.getByRole('option', { name: /Target 12/ })).toBeInTheDocument()
      scrollIntoView.mockClear()
      fireEvent.keyDown(editor, { key: 'ArrowDown' })
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    } finally {
      if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('shows a Cursor chat only when the server advertises ready Cursor delivery', async () => {
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Source', backend: 'codex' },
        { id: 'chat-cursor', title: 'Cursor worker', backend: 'cursor' }
      ],
      chatPanes: { primary: 'chat-1', secondary: null },
      focusedChatPane: 'primary',
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: durableComposerCapability()
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, '@Cursor')
    expect(screen.queryByRole('option', { name: /Cursor worker/ })).not.toBeInTheDocument()

    act(() => useAppStore.setState({
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: durableComposerCapability({
            supported_target_backends: ['codex', 'claude', 'cursor']
          })
        }
      }
    }))
    expect(await screen.findByRole('option', { name: /Cursor worker/ })).toBeInTheDocument()
  })

  it('does not expose the retired Route button, command, or picker', async () => {
    useAppStore.setState({
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: {
            available: true, required: false, message: '', action: null, version: 4,
            actions: ['request_reply', 'instruction'],
            supported_target_backends: ['codex', 'claude'],
            features: { agent_cross_chat_routes: false, agent_ambient_local_handoffs: true },
            ambient_local_handoffs: {
              enabled: true, policy: 'automatic', scope: 'all_same_server_chats', setup_required: false
            }
          }
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    expect(screen.queryByRole('button', { name: 'Use agent route' })).not.toBeInTheDocument()
    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, '/route')

    expect(editor).toHaveValue('/route')
    expect(screen.queryByRole('option', { name: /Use agent route/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('listbox', { name: 'Agent routes' })).not.toBeInTheDocument()
  })

  it('opens /model and /reasoning for the explicit split-pane session and focuses reasoning', async () => {
    const sessions = [
      { id: 'chat-1', title: 'Alpha', backend: 'codex' as const, model: 'gpt-sol', effort: 'medium' },
      { id: 'chat-2', title: 'Beta', backend: 'codex' as const, model: 'gpt-sol', effort: 'medium' }
    ]
    const update = vi.fn(async (sessionId: string, patch: Record<string, unknown>) => ({
      ...sessions.find(session => session.id === sessionId)!,
      ...definedValues(patch)
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        codex: composerCodexBridge(),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    const runtimeCatalog: RuntimeCatalog = {
      backends: {
        claude: { models: [{ value: 'sonnet', label: 'Sonnet' }], efforts: [] },
        codex: {
          default_model: 'gpt-sol', default_effort: 'medium',
          models: [
            { value: 'gpt-sol', label: 'GPT Sol', efforts: [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
            { value: 'gpt-luna', label: 'GPT Luna', efforts: [{ value: 'high', label: 'High' }] }
          ],
          efforts: [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]
        }
      }
    }
    useAppStore.setState({
      sessions,
      selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: 'chat-2' },
      focusedChatPane: 'primary',
      runtimeCatalog
    })
    const user = userEvent.setup()
    render(<ScopedCodexComposerHarness sessionId="chat-2" />)
    const editor = screen.getByRole('textbox', { name: 'Message Beta' })

    await user.type(editor, '/model')
    fireEvent.keyDown(editor, { key: 'Enter' })
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'GPT Luna' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('chat-2', expect.objectContaining({ model: 'gpt-luna' })))
    expect(useAppStore.getState().selectedSessionId).toBe('chat-2')

    await user.click(editor)
    await user.type(editor, '/reasoning')
    await new Promise(resolve => window.setTimeout(resolve, 150))
    expect(screen.getByRole('option', { name: /^Reasoning/ })).toBeInTheDocument()
    fireEvent.keyDown(editor, { key: 'Enter' })
    const reasoning = await screen.findByRole('menuitemcheckbox', { name: 'High' })
    await waitFor(() => expect(reasoning).toHaveFocus())
    expect(useAppStore.getState().focusedChatPane).toBe('secondary')
  })

  it('focuses a secondary command session before opening its global status surface', () => {
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Alpha', backend: 'codex' },
        { id: 'chat-2', title: 'Beta', backend: 'claude' }
      ],
      selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: 'chat-2' },
      focusedChatPane: 'primary',
      inspectorVisible: false
    })
    const transitions: Array<{ selected: string | null; focused: string; inspector: boolean }> = []
    const unsubscribe = useAppStore.subscribe(state => transitions.push({
      selected: state.selectedSessionId,
      focused: state.focusedChatPane,
      inspector: state.inspectorVisible
    }))
    render(<Composer sessionId="chat-2" />)
    const editor = screen.getByRole('textbox', { name: 'Message Beta' })

    fireEvent.change(editor, { target: { value: '/status' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    unsubscribe()

    const focusedTransition = transitions.findIndex(state => state.selected === 'chat-2' && state.focused === 'secondary' && !state.inspector)
    const inspectorTransition = transitions.findIndex(state => state.selected === 'chat-2' && state.inspector)
    expect(focusedTransition).toBeGreaterThanOrEqual(0)
    expect(inspectorTransition).toBeGreaterThan(focusedTransition)
  })

  it('saves /workdir completion to the explicit split-pane session', async () => {
    const sessions = [
      { id: 'chat-1', title: 'Alpha', backend: 'codex' as const, cwd: '/alpha' },
      { id: 'chat-2', title: 'Beta', backend: 'claude' as const, cwd: '/srv' }
    ]
    const update = vi.fn(async (sessionId: string, patch: Record<string, unknown>) => ({
      ...sessions.find(session => session.id === sessionId)!,
      ...definedValues(patch)
    }))
    const complete = vi.fn(async (input: string) => ({
      input,
      resolved_path: input,
      exists: false,
      base_path: '/srv',
      suggestions: [{ name: 'project', path: '/srv/project' }],
      truncated: false
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        sessions: { update },
        workingDirectories: { complete }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions,
      selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: 'chat-2' },
      focusedChatPane: 'primary',
      health: {
        ok: true,
        default_cwd: '/srv',
        capabilities: {
          working_directory_completion: { available: true, required: false, message: '', action: null }
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer sessionId="chat-2" />)
    const editor = screen.getByRole('textbox', { name: 'Message Beta' })

    await user.type(editor, '/workdir')
    fireEvent.keyDown(editor, { key: 'Enter' })
    const input = await screen.findByRole('combobox', { name: 'Working directory' })
    await user.clear(input)
    await user.type(input, '/srv/pro')
    await user.click(await screen.findByRole('option', { name: /project/ }))
    expect(input).toHaveValue('/srv/project')
    await user.click(screen.getByRole('button', { name: 'Use folder' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('chat-2', { cwd: '/srv/project' }))
    expect(screen.queryByRole('heading', { name: 'Working directory' })).not.toBeInTheDocument()
    expect(useAppStore.getState().selectedSessionId).toBe('chat-2')
  })

  it('registers slash, runtime, and permissions as close-first Cmd/Ctrl+W transients', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        codex: composerCodexBridge(vi.fn().mockResolvedValue([]), {
          approval_policy: 'on-request', sandbox_mode: 'workspace-write', approvals_reviewer: 'user'
        }),
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Chat', backend: 'codex',
        codex_approval_policy: 'on-request', codex_sandbox_mode: 'workspace-write', codex_approvals_reviewer: 'user'
      }],
      selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: null },
      focusedChatPane: 'primary',
      health: {
        ok: true,
        capabilities: {
          codex_controls: {
            available: true, required: false, message: '', action: null,
            features: { goals: true, permission_profiles: true }
          }
        }
      }
    })
    const user = userEvent.setup()
    render(<CodexComposerHarness />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, '/')
    expect(screen.getByRole('listbox', { name: /chat commands/ })).toBeInTheDocument()
    act(() => { expect(closeTopTransient()).toBe(true) })
    expect(screen.queryByRole('listbox', { name: /chat commands/ })).not.toBeInTheDocument()

    await user.clear(editor)
    await user.type(editor, '/model')
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(await screen.findByRole('menuitem', { name: 'Reload Codex' })).toBeInTheDocument()
    act(() => { expect(closeTopTransient()).toBe(true) })
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Reload Codex' })).not.toBeInTheDocument())

    await user.click(editor)
    await user.type(editor, '/permissions')
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: 'Codex permissions' })).toBeInTheDocument()
    act(() => { expect(closeTopTransient()).toBe(true) })
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Codex permissions' })).not.toBeInTheDocument())
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-1', secondary: null })
  })

  it('uses unique command ids for split composers and targets the invoked pane', () => {
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Alpha', backend: 'codex' },
        { id: 'chat-2', title: 'Beta', backend: 'claude' }
      ],
      selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: 'chat-2' },
      focusedChatPane: 'primary',
      inspectorVisible: false
    })
    render(<StrictMode>
      <Composer sessionId="chat-1" />
      <Composer sessionId="chat-2" />
    </StrictMode>)
    const alpha = screen.getByRole('textbox', { name: 'Message Alpha' })
    const beta = screen.getByRole('textbox', { name: 'Message Beta' })

    fireEvent.change(alpha, { target: { value: '/' } })
    fireEvent.change(beta, { target: { value: '/' } })
    const alphaPalette = screen.getByRole('listbox', { name: 'Codex chat commands' })
    const betaPalette = screen.getByRole('listbox', { name: 'Claude chat commands' })
    expect(alpha).toHaveAttribute('aria-controls', alphaPalette.id)
    expect(beta).toHaveAttribute('aria-controls', betaPalette.id)
    expect(alphaPalette.id).not.toBe(betaPalette.id)
    expect(alpha.getAttribute('aria-activedescendant')).toMatch(new RegExp(`^${alphaPalette.id}-`))
    expect(beta.getAttribute('aria-activedescendant')).toMatch(new RegExp(`^${betaPalette.id}-`))

    fireEvent.change(beta, { target: { value: '/status' } })
    fireEvent.keyDown(beta, { key: 'Enter' })
    expect(useAppStore.getState()).toEqual(expect.objectContaining({
      selectedSessionId: 'chat-2', focusedChatPane: 'secondary', inspectorVisible: true
    }))
  })

  it('inserts and sends an authority-bearing chat reference from the mention palette', async () => {
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      queued: false
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude', folder: 'Research' },
        { id: 'chat-3', title: 'Archived training', backend: 'codex', archived: true }
      ],
      folderOrder: ['Research', 'General'],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: durableComposerCapability()
        }
      },
      chatReferencesBySession: {}
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, 'Ask @Tra')
    const target = await screen.findByRole('option', { name: /Training/ })
    expect(screen.queryByRole('option', { name: /Archived training/ })).not.toBeInTheDocument()
    await user.click(target)

    expect(editor).toHaveValue('Ask @Training ')
    expect(editor.parentElement).toHaveClass('composer-editor', 'has-inline-references')
    expect(editor.parentElement?.querySelector('.composer-editor-mirror')).toBeInTheDocument()
    expect(screen.getByTitle('@Training · Route hint')).toHaveClass('composer-inline-reference', 'action-route')
    expect(screen.queryByLabelText('Cross-chat actions')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1',
      prompt: 'Ask @Training',
      chatReferences: [{
        session_id: 'chat-2',
        display_title_snapshot: 'Training',
        source_text_start: 4,
        source_text_end: 13,
        action: 'route',
        grant_intent: true
      }]
    })))
  })

  it('blocks a seventeenth chat reference with an explicit picker limit', async () => {
    const targetSessions = Array.from({ length: 16 }, (_, index) => ({
      id: `target-${index}`, title: `Target${index}`, backend: 'codex' as const
    }))
    const tokens = targetSessions.map(target => `@${target.title}`)
    const draft = tokens.join(' ')
    let offset = 0
    const references = targetSessions.map((target, index) => {
      const token = tokens[index]
      const reference = {
        session_id: target.id, display_title_snapshot: target.title,
        source_text_start: offset, source_text_end: offset + token.length,
        action: 'route' as const, grant_intent: true as const
      }
      offset += token.length + 1
      return reference
    })
    const routeSnapshot = { routes: [], max_routes: 99 }
    const list = vi.fn().mockResolvedValue(routeSnapshot)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        agentRoutes: { list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 7, connected: true,
      profiles: [{ id: 'profile-a', name: 'Server', serverIdentity: 'server-a' } as PublicServerProfile],
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        ...targetSessions,
        { id: 'target-new', title: 'New target', backend: 'claude' }
      ],
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability() } },
      drafts: { 'chat-1': draft },
      chatReferencesBySession: { 'chat-1': references },
      agentRoutesBySession: { 'chat-1': routeSnapshot }
    })
    const user = userEvent.setup()
    render(<Composer />)
    await waitFor(() => expect(list).toHaveBeenCalled())

    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, ' @New')
    const picker = await screen.findByRole('listbox', { name: 'Chats' })
    expect(within(picker).getByRole('status')).toHaveTextContent('Maximum 16 chats')
    expect(within(picker).getByRole('option', { name: /New target/ })).toBeDisabled()
    fireEvent.keyDown(editor, { key: 'Enter' })

    expect(useAppStore.getState().chatReferencesBySession['chat-1']).toHaveLength(16)
    expect(useAppStore.getState().error).toMatch(/at most 16 chats/i)
  })

  it('keeps granted chats usable while disabling new targets at route capacity', async () => {
    const granted = grantedComposerRoute('chat-2', 'Granted target')
    const routeSnapshot = { routes: [granted], max_routes: 1 }
    const list = vi.fn().mockResolvedValue(routeSnapshot)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        agentRoutes: { list }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 7, connected: true,
      profiles: [{ id: 'profile-a', name: 'Server', serverIdentity: 'server-a' } as PublicServerProfile],
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Granted target', backend: 'claude' },
        { id: 'chat-3', title: 'New target', backend: 'codex' }
      ],
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability() } },
      agentRoutesBySession: { 'chat-1': routeSnapshot }
    })
    const user = userEvent.setup()
    render(<Composer />)
    await waitFor(() => expect(list).toHaveBeenCalled())

    await user.type(screen.getByPlaceholderText('Message'), '@')
    const picker = await screen.findByRole('listbox', { name: 'Chats' })
    expect(within(picker).getByText('Route access limit reached')).toBeInTheDocument()
    expect(within(picker).getByRole('option', { name: /Granted target/ })).toBeEnabled()
    expect(within(picker).getByRole('option', { name: /New target/ })).toBeDisabled()
    expect(within(picker).getByRole('option', { name: /New target/ })).toHaveAttribute('title', expect.stringMatching(/Revoke a granted route/))
  })

  it('selects and sends a new chat after twenty stored routes when max_routes is null', async () => {
    const routes = Array.from({ length: 20 }, (_, index) => grantedComposerRoute(`granted-${index}`, `Granted ${index}`))
    const routeSnapshot = { routes, max_routes: null }
    const list = vi.fn().mockResolvedValue(routeSnapshot)
    const send = vi.fn().mockResolvedValue({ session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, queued: false })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
      agentRoutes: { list }, turns: { send }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({ activeProfileId: 'profile-a', profileGeneration: 7, connected: true,
      profiles: [{ id: 'profile-a', name: 'Server', serverIdentity: 'server-a' } as PublicServerProfile],
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }, { id: 'chat-new', title: 'New target', backend: 'claude' }],
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability() } },
      agentRoutesBySession: { 'chat-1': routeSnapshot }, chatReferencesBySession: {} })
    const user = userEvent.setup()
    render(<Composer />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    await user.type(screen.getByPlaceholderText('Message'), 'Ask @New')
    const target = await screen.findByRole('option', { name: /New target/ })
    expect(target).toBeEnabled()
    expect(screen.queryByText('Route access limit reached')).not.toBeInTheDocument()
    await user.click(target)
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat-1',
      chatReferences: [expect.objectContaining({ session_id: 'chat-new', grant_intent: true, action: 'route' })] })))
    expect(useAppStore.getState().error).toBeNull()
  })

  it('labels existing grants in the inline picker and revokes by revision without changing draft text', async () => {
    const route = grantedComposerRoute('chat-2', 'Training')
    const list = vi.fn()
      .mockResolvedValueOnce({ routes: [route], max_routes: 16 })
      .mockResolvedValueOnce({ routes: [], max_routes: 16 })
    const remove = vi.fn().mockResolvedValue({ status: 'deleted', deleted: true, route_id: route.route_id })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        agentRoutes: { list, remove }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a',
      profileGeneration: 7,
      connected: true,
      profiles: [{ id: 'profile-a', name: 'Server', serverIdentity: 'server-a' } as PublicServerProfile],
      selectedSessionId: 'chat-1',
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ],
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability() } },
      agentRoutesBySession: { 'chat-1': { routes: [route], max_routes: 16 } }
    })
    const user = userEvent.setup()
    render(<Composer />)
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))

    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, '@Tra')
    expect(screen.getByRole('option', { name: /Training.*Granted.*Send \+ Ask/i })).toBeInTheDocument()
    expect(screen.getByText(/scheduled-job routes are managed separately/i)).toBeVisible()
    await user.click(screen.getByRole('button', { name: /Revoke Send \+ Ask access to Training/i }))

    await waitFor(() => expect(remove).toHaveBeenCalledWith(
      { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' },
      'chat-1', route.route_id, route.revision
    ))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Revoke .* access to Training/i })).not.toBeInTheDocument())
    expect(editor).toHaveValue('@Tra')
    expect(useAppStore.getState().chatReferencesBySession['chat-1'] ?? []).toEqual([])
  })

  it('surfaces a safe error when a selected chat title begins with @', async () => {
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: '@Ops', backend: 'claude' }
      ],
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability({
        actions: ['route']
      }) } }
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, '@')
    await user.click(await screen.findByRole('option', { name: /@Ops/ }))

    expect(editor).toHaveValue('@')
    expect(useAppStore.getState().chatReferencesBySession['chat-1'] ?? []).toEqual([])
    expect(useAppStore.getState().error).toMatch(/names beginning with @ cannot be referenced/i)
  })

  it('does not silently downgrade new @ semantics on an older server while legacy references remain readable', async () => {
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ],
      drafts: { 'chat-1': 'Legacy @Training' },
      chatReferencesBySession: { 'chat-1': [{
        session_id: 'chat-2', display_title_snapshot: 'Training',
        source_text_start: 7, source_text_end: 16, action: 'instruction'
      }] },
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: {
        available: true, required: false, message: '', action: null, version: 4,
        actions: ['instruction', 'request_reply', 'final_result'], supported_target_backends: ['codex', 'claude']
      } } }
    })
    const user = userEvent.setup()
    render(<Composer />)

    expect(screen.getByTitle('@Training · Agent may send')).toHaveClass('composer-inline-reference', 'unsupported')
    expect(screen.queryByLabelText('Cross-chat actions')).not.toBeInTheDocument()
    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, ' @Tra')

    expect(editor).toHaveValue('Legacy @Training @Tra')
    expect(useAppStore.getState().chatReferencesBySession['chat-1']).toHaveLength(1)
    expect(screen.getByRole('listbox', { name: 'Chats' })).toBeInTheDocument()
    expect(screen.getByText('Server update required')).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Training/ })).not.toBeInTheDocument()
    expect(screen.getByText(/one or more legacy chat references cannot be used/i)).toBeInTheDocument()
  })

  it('canonicalizes restored local @ direct and @@ route references to inline @ route hints', async () => {
    const send = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' },
        { id: 'chat-3', title: 'Mobile', backend: 'codex' }
      ],
      drafts: { 'chat-1': '@Training then @@Mobile' },
      chatReferencesBySession: { 'chat-1': [
        {
          session_id: 'chat-2', display_title_snapshot: 'Training',
          source_text_start: 0, source_text_end: 9, action: 'direct_message'
        },
        {
          session_id: 'chat-3', display_title_snapshot: 'Mobile',
          source_text_start: 15, source_text_end: 23, action: 'route'
        }
      ] },
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability({
        actions: ['route']
      }) } }
    })

    render(<Composer />)

    await waitFor(() => expect(screen.getByPlaceholderText('Message')).toHaveValue('@Training then @Mobile'))
    expect(useAppStore.getState().chatReferencesBySession['chat-1']).toEqual([
      {
        session_id: 'chat-2', display_title_snapshot: 'Training',
        source_text_start: 0, source_text_end: 9, action: 'route'
      },
      {
        session_id: 'chat-3', display_title_snapshot: 'Mobile',
        source_text_start: 15, source_text_end: 22, action: 'route'
      }
    ])
    expect(screen.getByTitle('@Training · Route hint')).toHaveClass('composer-inline-reference', 'action-route')
    expect(screen.getByTitle('@Mobile · Route hint')).toHaveClass('composer-inline-reference', 'action-route')
    expect(document.querySelector('.chat-reference-shelf')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send message' }))
    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toMatch(/legacy route hint.*remove it and select @Chat again/i)
  })

  it('queues a resolved @ chat message normally while its source chat is busy', async () => {
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      queued: true,
      queued_id: 'queued-reference'
    })
    const runNow = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send },
        queue: { runNow, list: vi.fn().mockResolvedValue([]) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Mobile', backend: 'claude' }
      ],
      activeSessionIds: new Set(['chat-1']),
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: durableComposerCapability({
            actions: ['route', 'instruction'], default_action: 'instruction'
          })
        }
      },
      chatReferencesBySession: {}
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.type(screen.getByPlaceholderText('Message'), 'Tell @Mob')
    await user.click(await screen.findByRole('option', { name: /Mobile/ }))
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Queue message' }))

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Tell @Mobile',
      chatReferences: [expect.objectContaining({ session_id: 'chat-2', action: 'route' })]
    })))
    expect(runNow).not.toHaveBeenCalled()
  })

  it('keeps @Chat discovery same-server-only and never reads secure-peer routes', async () => {
    const securePeerStatus = vi.fn().mockResolvedValue({
      remoteRouteDeliveryAvailable: true,
      remoteRoutes: [{
        peerServerIdentity: 'server-studio', peerDisplayName: 'Studio',
        connectionId: secureConnectionId, routeId: secureRouteId,
        revision: `rev_${'a'.repeat(32)}`, alias: 'training',
        displayTitle: 'Training remote', actions: ['instruction']
      }]
    })
    const listRoutes = vi.fn().mockResolvedValue({ routes: [], max_routes: 16 })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        teamHub: { securePeerStatus },
        agentRoutes: { list: listRoutes }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 7, connected: true,
      profiles: [{ id: 'profile-a', name: 'Local', serverIdentity: 'server-local' } as PublicServerProfile],
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-local', title: 'Training local', backend: 'claude' }
      ],
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability() } },
      chatReferencesBySession: {}
    })
    const user = userEvent.setup()
    render(<Composer />)
    await waitFor(() => expect(listRoutes).toHaveBeenCalled())

    const editor = screen.getByPlaceholderText('Message')
    await user.type(editor, '@train')
    let picker = await screen.findByRole('listbox', { name: 'Chats' })
    expect(within(picker).getByRole('option', { name: /Training local/ })).toBeInTheDocument()
    expect(within(picker).queryByRole('option', { name: /Training remote|secure paired server|Studio/ })).not.toBeInTheDocument()

    await user.clear(editor)
    await user.type(editor, '/chat')
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(editor).toHaveValue('/chat ')
    await user.type(editor, 'train')
    picker = await screen.findByRole('listbox', { name: 'Chats' })
    expect(within(picker).queryByRole('option', { name: /Training remote|secure paired server|Studio/ })).not.toBeInTheDocument()
    await user.click(within(picker).getByRole('option', { name: /Training local/ }))

    expect(useAppStore.getState().chatReferencesBySession['chat-1']).toEqual([
      expect.objectContaining({ session_id: 'chat-local', action: 'route' })
    ])
    expect(useAppStore.getState().chatReferencesBySession['chat-1'][0].target_kind).toBeUndefined()
    expect(securePeerStatus).not.toHaveBeenCalled()
  })

  it('renders a stored secure-peer @ reference as unsupported and cannot send it', () => {
    const send = vi.fn()
    const reference = securePeerChatReference(4)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      health: { ok: true, capabilities: { cross_chat_handoffs_v1: durableComposerCapability() } },
      drafts: { 'chat-1': 'Ask @Studio/training' },
      chatReferencesBySession: { 'chat-1': [reference] }
    })
    render(<Composer />)

    const editor = screen.getByPlaceholderText('Message')
    expect(editor).toHaveValue('Ask @Studio/training')
    expect(screen.getByTitle('@Studio/training · Agent may send')).toHaveClass('composer-inline-reference', 'unsupported')
    expect(screen.getByText(/Remote agent routes cannot be used from @Chat.*use @@ Team Network Inbox/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()

    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(send).not.toHaveBeenCalled()
    expect(useAppStore.getState().drafts['chat-1']).toBe('Ask @Studio/training')
    expect(useAppStore.getState().chatReferencesBySession['chat-1']).toEqual([reference])
  })

  it('uses one inline @ route hint and leaves @@ as ordinary text without an action menu', async () => {
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      queued: false
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude', folder: 'Research' }
      ],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: durableComposerCapability({
            default_action: 'request_reply',
            required_target_transports: { codex: 'codex_app_server_v1', claude: 'claude_sdk_v1' },
            default_exchange_legs: 6,
            max_exchange_legs: 6,
            default_exchange_ttl_seconds: 259200
          })
        }
      },
      chatReferencesBySession: {}
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, '@Training')
    await user.click(await screen.findByRole('option', { name: /Training/ }))
    expect(screen.getByTitle('@Training · Route hint')).toHaveClass('composer-inline-reference', 'action-route')
    expect(screen.queryByRole('button', { name: /Cross-chat action for Training.*Change action/ })).not.toBeInTheDocument()

    await user.type(editor, '@@Training')
    expect(screen.queryByRole('listbox', { name: 'Chats' })).not.toBeInTheDocument()
    expect(screen.queryByTitle('@@Training · Route hint')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Cross-chat actions')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1',
      prompt: '@Training @@Training',
      chatReferences: [expect.objectContaining({ session_id: 'chat-2', action: 'route' })]
    })))
  })

  it('keeps inline @ destinations inserted by @ and /chat atomic for caret movement and deletion', async () => {
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: durableComposerCapability({ actions: ['route'] })
        }
      },
      chatReferencesBySession: {}
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message') as HTMLTextAreaElement

    await user.type(editor, 'Ask @Training')
    await user.click(await screen.findByRole('option', { name: /Training/ }))
    const direct = useAppStore.getState().chatReferencesBySession['chat-1'][0]
    expect(screen.getByTitle('@Training · Route hint')).toHaveClass('action-route')
    expect(screen.queryByLabelText('Cross-chat actions')).not.toBeInTheDocument()

    editor.setSelectionRange(direct.source_text_end, direct.source_text_end)
    fireEvent.keyDown(editor, { key: 'ArrowLeft' })
    expect(editor.selectionStart).toBe(direct.source_text_start)
    fireEvent.keyDown(editor, { key: 'ArrowRight' })
    expect(editor.selectionStart).toBe(direct.source_text_end)
    fireEvent.keyDown(editor, { key: 'Backspace' })
    expect(editor).toHaveValue('Ask ')
    expect(useAppStore.getState().chatReferencesBySession['chat-1']).toEqual([])
    expect(screen.queryByTitle('@Training · Route hint')).not.toBeInTheDocument()

    await user.type(editor, 'then /chat Training')
    await user.click(await screen.findByRole('option', { name: /Training/ }))
    const route = useAppStore.getState().chatReferencesBySession['chat-1'][0]
    expect(editor).toHaveValue('Ask then @Training ')
    expect(screen.getByTitle('@Training · Route hint')).toHaveClass('action-route')
    editor.setSelectionRange(route.source_text_start, route.source_text_start)
    fireEvent.keyDown(editor, { key: 'Delete' })
    expect(editor).toHaveValue('Ask then ')
    expect(useAppStore.getState().chatReferencesBySession['chat-1']).toEqual([])
  })

  it('never downgrades a stored request-reply reference on a v1 server', () => {
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Target', backend: 'claude' }
      ],
      drafts: { 'chat-1': 'Ask @Target' },
      chatReferencesBySession: { 'chat-1': [{
        session_id: 'chat-2', display_title_snapshot: 'Target',
        source_text_start: 4, source_text_end: 11, action: 'request_reply'
      }] },
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: {
            available: true, required: false, message: '', action: null,
            version: 1, actions: ['instruction', 'final_result']
          }
        }
      }
    })

    render(<Composer />)

    expect(screen.getByTitle('@Target · Reply expected')).toHaveClass('composer-inline-reference', 'unsupported')
    expect(screen.queryByLabelText('Cross-chat actions')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  })

  it('offers a route hint even when the active source cannot receive a legacy reply', async () => {
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Legacy source', backend: 'claude' },
        { id: 'chat-2', title: 'Native target', backend: 'codex' }
      ],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: durableComposerCapability({
            default_action: 'request_reply', supported_target_backends: ['codex']
          })
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.type(screen.getByPlaceholderText('Message'), '@Native')
    const target = await screen.findByRole('option', { name: /Native target/ })
    expect(target).toHaveTextContent('Will grant Send when sent')
    expect(target).not.toHaveTextContent('Send + Ask')
    await user.click(target)

    expect(screen.getByTitle('@Native target · Route hint')).toHaveClass('composer-inline-reference', 'action-route')
  })

  it('does not offer targets whose provider transport cannot accept a native handoff', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Claude target', backend: 'claude' },
        { id: 'chat-3', title: 'Codex target', backend: 'codex' }
      ],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: durableComposerCapability({
            actions: ['route'], supported_target_backends: ['codex']
          })
        }
      },
      chatReferencesBySession: {}
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.type(screen.getByPlaceholderText('Message'), '@target')

    expect(await screen.findByRole('option', { name: /Codex target/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Claude target/ })).not.toBeInTheDocument()
  })

  it('blocks a restored reference when its target transport is no longer supported', () => {
    const reference = {
      session_id: 'chat-2',
      display_title_snapshot: 'Claude target',
      source_text_start: 4,
      source_text_end: 18,
      action: 'instruction' as const
    }
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Claude target', backend: 'claude' }
      ],
      drafts: { 'chat-1': 'Ask @Claude target' },
      chatReferencesBySession: { 'chat-1': [reference] },
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: {
            available: true,
            required: false,
            message: '',
            action: null,
            version: 1,
            supported_target_backends: ['codex']
          }
        }
      }
    })

    render(<Composer />)

    expect(screen.getByText(/one or more legacy chat references cannot be used/i)).toBeInTheDocument()
    expect(screen.getByTitle('@Claude target · Agent may send')).toHaveClass('composer-inline-reference', 'unsupported')
    expect(screen.queryByLabelText('Cross-chat actions')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  })

  it('keeps Enter bound to send after a resolved mention on the same line', async () => {
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      queued: false
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'CMA @ES', backend: 'claude' }
      ],
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: durableComposerCapability()
        }
      },
      chatReferencesBySession: {}
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, 'Ask @CMA')
    await user.click(await screen.findByRole('option', { name: /CMA @ES/ }))
    await user.type(editor, 'to verify this{Enter}')

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-1',
      prompt: 'Ask @CMA @ES to verify this',
      chatReferences: [expect.objectContaining({ session_id: 'chat-2', action: 'route' })]
    })))
  })

  it('keeps two explicit chat composers scoped and uniquely labelled under Strict Mode', async () => {
    const splitSessions = [
      { id: 'chat-1', title: 'Alpha', backend: 'codex' as const },
      { id: 'chat-2', title: 'Beta', backend: 'claude' as const }
    ]
    const send = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      session: splitSessions.find(session => session.id === sessionId)!,
      queued: false
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: splitSessions,
      selectedSessionId: 'chat-1',
      chatPanes: { primary: 'chat-1', secondary: 'chat-2' },
      focusedChatPane: 'primary',
      drafts: {},
      chatReferencesBySession: {}
    })
    const user = userEvent.setup()
    render(<StrictMode>
      <Composer sessionId="chat-1" />
      <Composer sessionId="chat-2" />
    </StrictMode>)

    const alpha = screen.getByRole('textbox', { name: 'Message Alpha' })
    const beta = screen.getByRole('textbox', { name: 'Message Beta' })
    await user.type(alpha, '@')
    expect(alpha).toHaveAttribute('aria-controls')
    const alphaControls = alpha.getAttribute('aria-controls')
    await user.type(beta, '@')
    expect(beta).toHaveAttribute('aria-controls')
    expect(beta.getAttribute('aria-controls')).not.toBe(alphaControls)

    await user.clear(beta)
    await user.type(beta, 'Reply from the right pane')
    await user.click(screen.getByRole('button', { name: 'Send message to Beta' }))

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'chat-2',
      prompt: 'Reply from the right pane'
    })))
    expect(useAppStore.getState().selectedSessionId).toBe('chat-1')
  })

  it('does not resurrect a removed reference after a quick chat switch', async () => {
    const staleReference = {
      session_id: 'chat-2',
      display_title_snapshot: 'Training',
      source_text_start: 4,
      source_text_end: 13,
      action: 'instruction' as const
    }
    const get = vi.fn(async (key: string) => {
      if (key === 'draft:chat-1') return 'Ask @Training '
      if (key === 'draft-chat-references:chat-1') return [staleReference]
      return ''
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get, set: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [
        { id: 'chat-1', title: 'Chat', backend: 'codex' },
        { id: 'chat-2', title: 'Training', backend: 'claude' }
      ],
      drafts: { 'chat-1': 'Ask @Training ' },
      chatReferencesBySession: { 'chat-1': [staleReference] }
    })
    render(<Composer />)

    const editor = screen.getByPlaceholderText('Message') as HTMLTextAreaElement
    editor.setSelectionRange(staleReference.source_text_end, staleReference.source_text_end)
    fireEvent.keyDown(editor, { key: 'Backspace' })
    expect(editor).toHaveValue('Ask ')
    expect(useAppStore.getState().chatReferencesBySession['chat-1']).toEqual([])

    act(() => useAppStore.setState({ selectedSessionId: 'chat-2' }))
    act(() => useAppStore.setState({ selectedSessionId: 'chat-1' }))

    await waitFor(() => expect(screen.getByPlaceholderText('Message')).toHaveValue('Ask '))
    expect(screen.queryByTitle('@Training · Agent may send')).not.toBeInTheDocument()
    expect(useAppStore.getState().chatReferencesBySession['chat-1']).toEqual([])
    expect(get).not.toHaveBeenCalledWith('draft-chat-references:chat-1', expect.anything())
  })
})

function definedValues(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function CodexComposerHarness() {
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === state.selectedSessionId) ?? null)
  return <CodexRuntimeProvider session={session} capability={{ available: true }}>
    <Composer />
  </CodexRuntimeProvider>
}

function CodexGoalComposerHarness() {
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === state.selectedSessionId) ?? null)
  return <CodexRuntimeProvider session={session} capability={{ available: true }}>
    <CodexStatusButton />
    <Composer />
  </CodexRuntimeProvider>
}

function ScopedCodexComposerHarness({ sessionId }: { sessionId: string }) {
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === sessionId) ?? null)
  return <CodexRuntimeProvider session={session} capability={{ available: true }}>
    <Composer sessionId={sessionId} />
  </CodexRuntimeProvider>
}

function ClaudeComposerHarness() {
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === state.selectedSessionId) ?? null)
  return <ClaudeRuntimeProvider
    session={session}
    capability={{ available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }}
  >
    <Composer />
  </ClaudeRuntimeProvider>
}

function composerCodexBridge(
  permissionProfiles = vi.fn().mockResolvedValue([]),
  policy?: CodexRuntimeSnapshot['policy']
) {
  const runtime: CodexRuntimeSnapshot = {
    available: true,
    transport: 'app_server',
    interactive_capability: 'codex_interactive_v1',
    thread_loaded: true,
    status: { type: 'idle' },
    goal: null,
    time_budget_seconds: null,
    pending_interactions: [],
    permission_profiles: [],
    ...(policy === undefined ? {} : { policy }),
    background_terminals_supported: true
  }
  return {
    runtime: vi.fn().mockResolvedValue(runtime),
    permissionProfiles
  }
}

function composerClaudeBridge(
  policy: ClaudeRuntimeSnapshot['policy'] = { permission_mode: 'default' },
  permissionModeControl = true,
  permissionModes: ClaudeRuntimeSnapshot['permission_modes'] | null = [
    'default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'
  ]
) {
  const runtime: ClaudeRuntimeSnapshot = {
    available: true,
    transport: 'sdk',
    interactive_capability: 'claude_sdk_interactive_v1',
    persisted_session: true,
    session_loaded: true,
    status: { type: 'idle' },
    pending_interactions: [],
    policy,
    ...(permissionModeControl ? {
      features: { permission_mode_control: true },
      ...(permissionModes ? { permission_modes: permissionModes } : {})
    } : {})
  }
  return { runtime: vi.fn().mockResolvedValue(runtime) }
}
