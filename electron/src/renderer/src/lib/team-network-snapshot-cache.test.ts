import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { TeamHubStatus, TeamHubWorkspace } from '@shared/team-hub'
import {
  invalidateTeamNetworkSnapshot,
  loadTeamNetworkWorkspace,
  peekTeamMessagesSnapshot,
  peekTeamNetworkWorkspace,
  resetTeamNetworkSnapshotCacheForTests,
  teamNetworkSnapshotKey,
  writeTeamMessagesSnapshot
} from './team-network-snapshot-cache'

const status: TeamHubStatus = {
  version: 1,
  profileId: 'profile-a',
  profileGeneration: 3,
  serverIdentity: 'server-a',
  serverName: 'Studio',
  generation: 4,
  hubUrl: 'https://hub.test',
  hubIdentity: 'hub-a',
  savedHubIdentity: 'hub-a',
  transport: 'secure_peer',
  designatedHost: false,
  availabilityMessage: null,
  availabilityAction: null,
  canForgetBinding: false,
  connectionState: 'authenticated',
  authenticated: true,
  authenticationMode: 'paired_node',
  bootstrapRequired: false,
  principal: { id: 'server-principal', display_name: 'Studio', kind: 'service' },
  session: { id: 'session-a', device_label: 'Studio', expires_at: '2027-01-01T00:00:00Z' },
  error: null
}

const workspace: TeamHubWorkspace = {
  status,
  teams: [{ id: 'team-a', kind: 'shared', slug: 'team-a', display_name: 'Team A', role: 'automation', status: 'active' }]
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

describe('Team Network snapshot cache', () => {
  beforeEach(() => resetTeamNetworkSnapshotCacheForTests())

  it('does not let an invalidated in-flight workspace repopulate or satisfy the next load', async () => {
    const first = deferred<TeamHubWorkspace>()
    const loadWorkspace = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(workspace)
    window.agentsDock = { teamHub: { workspace: loadWorkspace } } as unknown as AgentsDockAPI

    const staleLoad = loadTeamNetworkWorkspace(status)
    invalidateTeamNetworkSnapshot(status)
    first.resolve(workspace)
    await staleLoad

    expect(peekTeamNetworkWorkspace(status)).toBeNull()
    await expect(loadTeamNetworkWorkspace(status)).resolves.toEqual(workspace)
    expect(loadWorkspace).toHaveBeenCalledTimes(2)
  })

  it('invalidates message snapshots for only the exact lifecycle and team', () => {
    const lifecycle = teamNetworkSnapshotKey(status)
    const snapshot = { messages: [], nextAfter: 7, hasMore: false, latestSequence: 7 }
    writeTeamMessagesSnapshot(lifecycle, { teamId: 'team-a', box: 'feed' }, snapshot)
    writeTeamMessagesSnapshot(lifecycle, { teamId: 'team-b', box: 'feed' }, snapshot)

    invalidateTeamNetworkSnapshot(status, 'team-a')

    expect(peekTeamMessagesSnapshot(lifecycle, { teamId: 'team-a', box: 'feed' })).toBeNull()
    expect(peekTeamMessagesSnapshot(lifecycle, { teamId: 'team-b', box: 'feed' })).toEqual(snapshot)
  })
})
