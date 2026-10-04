import { describe, expect, it, vi } from 'vitest'
import { LazyTeamHubService } from './team-hub-lazy-service'
import type { TeamHubService } from './team-hub-service'

describe('LazyTeamHubService', () => {
  it('delegates member rename only on explicit invocation with the original scope', async () => {
    const scope = { profileId: 'profile-1', profileGeneration: 1, generation: 1,
      serverIdentity: 'server-1', hubIdentity: 'hub-1', connectionId: 'connection-1', hostServerIdentity: 'host-1' }
    const input = { teamId: 'team-1', serverId: 'node-1', displayName: 'New name' }
    const result = { id: 'node-1', server_identity: 'server-1', display_name: 'New name' }
    const renameNetworkServer = vi.fn().mockResolvedValue(result)
    const create = vi.fn(() => ({ renameNetworkServer }) as unknown as TeamHubService)
    const service = new LazyTeamHubService(create)
    expect(create).not.toHaveBeenCalled()
    await expect(service.renameNetworkServer(scope, input)).resolves.toEqual(result)
    expect(renameNetworkServer).toHaveBeenCalledExactlyOnceWith(scope, input)
  })
  it('delegates exact mailbox attention input only when explicitly requested', async () => {
    const scope = { profileId: 'profile-1', profileGeneration: 1, generation: 1, serverIdentity: 'server-1', hubIdentity: 'hub-1' }
    const input = { teamId: 'team-1', messageId: 'message-1', addressKind: 'server' as const,
      addressId: 'server-1', unread: true, expectedVersion: 1, idempotencyKey: 'attention-key' }
    const delegate = { setTeamMessageMailboxState: vi.fn().mockResolvedValue({ message_id: 'message-1' }) }
    const create = vi.fn(() => delegate as unknown as TeamHubService)
    const service = new LazyTeamHubService(create)
    expect(create).not.toHaveBeenCalled()
    await service.setTeamMessageMailboxState(scope, input)
    expect(create).toHaveBeenCalledTimes(1)
    expect(delegate.setTeamMessageMailboxState).toHaveBeenCalledWith(scope, input)
  })

  it('does not touch Team Hub settings during legacy app construction', () => {
    const create = vi.fn(() => { throw new Error('settings volume is read-only') })
    const service = new LazyTeamHubService(create)

    expect(create).not.toHaveBeenCalled()
    expect(service.status()).toMatchObject({
      connectionState: 'error',
      authenticated: false,
      error: 'settings volume is read-only'
    })
  })

  it('delegates after first Teamspace access and stops only an initialized service', () => {
    const delegate = { status: vi.fn(() => ({ connectionState: 'disconnected' })), stop: vi.fn() }
    const create = vi.fn(() => delegate as unknown as TeamHubService)
    const service = new LazyTeamHubService(create)

    expect(service.status()).toEqual({ connectionState: 'disconnected' })
    expect(service.status()).toEqual({ connectionState: 'disconnected' })
    expect(create).toHaveBeenCalledTimes(1)
    service.stop()
    expect(delegate.stop).toHaveBeenCalledTimes(1)
  })
})
