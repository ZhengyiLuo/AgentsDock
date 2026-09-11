import { describe, expect, it, vi } from 'vitest'
import type { PinnedItem, PinnedItemsSnapshot } from '../shared/types'
import {
  PinRevisionConflictError,
  PinSyncCoordinator,
  type PinSyncCache,
  type PinSyncContext,
  type RemotePins
} from './pin-sync'

function pin(id = 'message:event-1', overrides: Partial<PinnedItem> = {}): PinnedItem {
  return {
    id,
    sessionId: 'chat-1',
    kind: 'message',
    eventId: id.replace(/^message:/, ''),
    title: 'Pinned message',
    body: 'Keep this',
    createdAt: 10,
    ...overrides
  }
}

function snapshot(pins: PinnedItem[], revision: number): PinnedItemsSnapshot {
  return {
    pins,
    revision,
    updatedAt: revision === 0 ? null : `2026-08-25T00:00:0${revision}Z`,
    capabilityVersion: 1
  }
}

class MemoryPinCache implements PinSyncCache {
  readonly items = new Map<string, PinnedItem[]>()
  readonly preferences = new Map<string, unknown>()
  readonly order: string[] = []

  pins(serverId: string, sessionId: string): PinnedItem[] {
    return [...(this.items.get(`${serverId}:${sessionId}`) ?? [])]
  }

  putPin(serverId: string, item: PinnedItem): PinnedItem[] {
    this.order.push(`mirror:put:${item.id}`)
    const key = `${serverId}:${item.sessionId}`
    const items = this.pins(serverId, item.sessionId).filter(candidate => candidate.id !== item.id)
    this.items.set(key, [item, ...items])
    return this.pins(serverId, item.sessionId)
  }

  removePin(serverId: string, sessionId: string, itemId: string): PinnedItem[] {
    this.order.push(`mirror:remove:${itemId}`)
    this.items.set(`${serverId}:${sessionId}`, this.pins(serverId, sessionId).filter(item => item.id !== itemId))
    return this.pins(serverId, sessionId)
  }

  replacePins(serverId: string, sessionId: string, items: PinnedItem[]): PinnedItem[] {
    this.order.push('mirror:replace')
    this.items.set(`${serverId}:${sessionId}`, [...items])
    return this.pins(serverId, sessionId)
  }

  preference<T>(serverId: string, key: string, fallback: T): T {
    return (this.preferences.has(`${serverId}:${key}`) ? this.preferences.get(`${serverId}:${key}`) : fallback) as T
  }

  putPreference<T>(serverId: string, key: string, value: T): void {
    const state = value as { pendingPuts?: PinnedItem[]; pendingRemovals?: string[]; migrated?: boolean }
    this.order.push(state.migrated
      ? 'outbox:complete'
      : state.pendingRemovals?.length
        ? 'outbox:remove'
        : state.pendingPuts?.length
          ? 'outbox:put'
          : 'outbox:write')
    this.preferences.set(`${serverId}:${key}`, structuredClone(value))
  }
}

function remoteState(initial: PinnedItem[] = [], initialRevision = 0) {
  let pins = [...initial]
  let revision = initialRevision
  const list = vi.fn(async () => snapshot(pins, revision))
  const put = vi.fn(async (item: PinnedItem, expectedRevision?: number) => {
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      throw new PinRevisionConflictError(snapshot(pins, revision))
    }
    const existing = pins.find(candidate => candidate.id === item.id)
    if (!existing || (expectedRevision !== undefined && JSON.stringify(existing) !== JSON.stringify(item))) {
      pins = [item, ...pins.filter(candidate => candidate.id !== item.id)]
      revision += 1
    }
    return snapshot(pins, revision)
  })
  const remove = vi.fn(async (_sessionId: string, itemId: string, expectedRevision?: number) => {
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      throw new PinRevisionConflictError(snapshot(pins, revision))
    }
    if (pins.some(candidate => candidate.id === itemId)) {
      pins = pins.filter(candidate => candidate.id !== itemId)
      revision += 1
    }
    return snapshot(pins, revision)
  })
  return { remote: { list, put, remove } satisfies RemotePins, pins: () => pins, replace: (next: PinnedItem[], nextRevision: number) => { pins = [...next]; revision = nextRevision } }
}

function context(remote: RemotePins | null, overrides: Partial<PinSyncContext> = {}): PinSyncContext {
  let current = true
  return {
    queueKey: 'profile-1:1:chat-1',
    sessionId: 'chat-1',
    namespace: () => 'server-1',
    connect: async () => remote,
    assertCurrent: () => { if (!current) throw new Error('stale profile') },
    isCurrent: () => current,
    shouldDefer: () => true,
    deferred: vi.fn(),
    ...overrides
  }
}

describe('server-backed pinned items', () => {
  it('imports local pins into a pristine revision-0 server once, then treats remote GET as authoritative', async () => {
    const cache = new MemoryPinCache()
    const local = pin()
    cache.putPin('server-1', local)
    cache.order.length = 0
    const server = remoteState()
    const coordinator = new PinSyncCoordinator(cache)
    const scope = context(server.remote)

    await expect(coordinator.list(scope)).resolves.toEqual([local])
    expect(server.remote.put).toHaveBeenCalledWith(local)
    expect(cache.order.slice(-2)).toEqual(['mirror:replace', 'outbox:complete'])

    server.replace([], 2)
    await expect(coordinator.list(scope)).resolves.toEqual([])
    expect(server.remote.put).toHaveBeenCalledTimes(1)
    expect(cache.pins('server-1', 'chat-1')).toEqual([])
  })

  it('keeps an offline pin in a durable outbox and syncs it later with If-Match', async () => {
    const cache = new MemoryPinCache()
    const coordinator = new PinSyncCoordinator(cache)
    const added = pin()
    let online = false
    const server = remoteState()
    const scope = context(server.remote, {
      connect: async () => {
        if (!online) throw new TypeError('fetch failed')
        return server.remote
      }
    })

    await expect(coordinator.put(scope, added)).resolves.toEqual([added])
    expect(cache.order.slice(0, 2)).toEqual(['outbox:put', `mirror:put:${added.id}`])
    expect(server.remote.put).not.toHaveBeenCalled()

    online = true
    await expect(coordinator.list(scope)).resolves.toEqual([added])
    expect(server.remote.put).toHaveBeenCalledWith(added, 0)
  })

  it('persists an offline unpin tombstone before the mirror delete and never reimports it', async () => {
    const existing = pin()
    const cache = new MemoryPinCache()
    cache.putPin('server-1', existing)
    cache.order.length = 0
    const server = remoteState([existing], 1)
    const coordinator = new PinSyncCoordinator(cache)
    let online = false
    const scope = context(server.remote, {
      connect: async () => online ? server.remote : Promise.reject(new TypeError('offline'))
    })

    await expect(coordinator.remove(scope, existing.id)).resolves.toEqual([])
    expect(cache.order.slice(0, 2)).toEqual(['outbox:remove', `mirror:remove:${existing.id}`])

    online = true
    await expect(coordinator.list(scope)).resolves.toEqual([])
    expect(server.remote.remove).toHaveBeenCalledWith('chat-1', existing.id, 1)
    expect(server.remote.put).not.toHaveBeenCalled()
  })

  it('lets an explicit repin clear a pending local tombstone', async () => {
    const existing = pin()
    const cache = new MemoryPinCache()
    cache.putPin('server-1', existing)
    const server = remoteState([existing], 1)
    const coordinator = new PinSyncCoordinator(cache)
    const offline = context(null)

    await coordinator.remove(offline, existing.id)
    const repinned = { ...existing, body: 'Repinned', createdAt: 20 }
    await coordinator.put(offline, repinned)

    const online = context(server.remote)
    await expect(coordinator.list(online)).resolves.toEqual([repinned])
    expect(server.remote.remove).not.toHaveBeenCalled()
    expect(server.remote.put).toHaveBeenCalledWith(repinned, 1)
  })

  it('rebases an ordinary mutation on a revision conflict', async () => {
    const cache = new MemoryPinCache()
    const coordinator = new PinSyncCoordinator(cache)
    const added = pin()
    const remotePins: PinnedItem[] = []
    const remote: RemotePins = {
      list: vi.fn(async () => snapshot(remotePins, 1)),
      put: vi.fn()
        .mockRejectedValueOnce(new PinRevisionConflictError(snapshot(remotePins, 2)))
        .mockResolvedValueOnce(snapshot([added], 3)),
      remove: vi.fn()
    }

    await expect(coordinator.put(context(remote), added)).resolves.toEqual([added])
    expect(remote.put).toHaveBeenNthCalledWith(1, added, 1)
    expect(remote.put).toHaveBeenNthCalledWith(2, added, 2)
  })

  it('keeps the durable outbox when revision conflicts exhaust the retry budget', async () => {
    const cache = new MemoryPinCache()
    const coordinator = new PinSyncCoordinator(cache)
    const added = pin()
    let conflictRevision = 1
    const remote: RemotePins = {
      list: vi.fn(async () => snapshot([], conflictRevision)),
      put: vi.fn(async () => {
        conflictRevision += 1
        throw new PinRevisionConflictError(snapshot([], conflictRevision))
      }),
      remove: vi.fn()
    }
    const deferred = vi.fn()
    const scope = context(remote, { deferred })

    await expect(coordinator.put(scope, added)).resolves.toEqual([added])

    expect(remote.put).toHaveBeenCalledTimes(4)
    expect(deferred).toHaveBeenCalledOnce()
    expect(cache.order).not.toContain('mirror:replace')
    expect([...cache.preferences.values()]).toContainEqual(expect.objectContaining({
      migrated: false,
      pendingPuts: [added]
    }))
  })

  it('quarantines a malformed legacy row without blocking valid one-time imports', async () => {
    const cache = new MemoryPinCache()
    const valid = pin('message:valid')
    const malformed = pin('message:malformed', { eventId: undefined })
    cache.putPin('server-1', valid)
    cache.putPin('server-1', malformed)
    const server = remoteState()
    const coordinator = new PinSyncCoordinator(cache)
    const scope = context(server.remote, {
      prepareLegacy: item => {
        if (!item.eventId) throw new Error('Pinned message event is invalid.')
        return item
      }
    })

    await expect(coordinator.list(scope)).resolves.toEqual([valid])
    expect(server.remote.put).toHaveBeenCalledTimes(1)
    expect(server.remote.put).toHaveBeenCalledWith(valid)
    expect([...cache.preferences.values()]).toContainEqual(expect.objectContaining({
      migrated: true,
      quarantinedLegacyIds: [malformed.id]
    }))

    await expect(coordinator.list(scope)).resolves.toEqual([valid])
    expect(server.remote.put).toHaveBeenCalledTimes(1)
  })

  it('rolls back a permanent rejected mutation instead of reporting local-only success', async () => {
    const cache = new MemoryPinCache()
    const coordinator = new PinSyncCoordinator(cache)
    const failure = new Error('Pinned item event does not exist.')
    const remote: RemotePins = {
      list: vi.fn(async () => snapshot([], 0)),
      put: vi.fn(async () => { throw failure }),
      remove: vi.fn()
    }
    const scope = context(remote, { shouldDefer: () => false })

    await expect(coordinator.put(scope, pin())).rejects.toBe(failure)
    expect(cache.pins('server-1', 'chat-1')).toEqual([])
  })
})
