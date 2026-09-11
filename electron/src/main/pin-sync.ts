import type { PinnedItem, PinnedItemsSnapshot } from '../shared/types'

const PIN_SYNC_STATE_VERSION = 1
const PIN_SYNC_STATE_PREFIX = 'timeline-pins:sync:v1:'
const MAX_REVISION_RETRIES = 4

interface StoredPinSyncState {
  version: 1
  migrated: boolean
  revision: number | null
  pendingPuts: PinnedItem[]
  pendingRemovals: string[]
  quarantinedLegacyIds: string[]
}

export interface PinSyncCache {
  pins(serverId: string, sessionId: string): PinnedItem[]
  putPin(serverId: string, item: PinnedItem): PinnedItem[]
  removePin(serverId: string, sessionId: string, itemId: string): PinnedItem[]
  replacePins(serverId: string, sessionId: string, items: PinnedItem[]): PinnedItem[]
  preference<T>(serverId: string, key: string, fallback: T): T
  putPreference<T>(serverId: string, key: string, value: T): void
}

export interface RemotePins {
  list(sessionId: string): Promise<PinnedItemsSnapshot>
  put(item: PinnedItem, expectedRevision?: number): Promise<PinnedItemsSnapshot>
  remove(sessionId: string, itemId: string, expectedRevision?: number): Promise<PinnedItemsSnapshot>
}

export interface PinSyncContext {
  /** Stable across canonical server-identity adoption for this profile generation. */
  queueKey: string
  sessionId: string
  namespace(): string
  connect(): Promise<RemotePins | null>
  assertCurrent(): void
  isCurrent(): boolean
  shouldDefer(error: unknown): boolean
  deferred(error: unknown): void
  prepareLegacy?(item: PinnedItem): PinnedItem
}

/**
 * A revision conflict is useful state, not a terminal mutation failure. The
 * coordinator rebases the same item-level operation onto this snapshot.
 */
export class PinRevisionConflictError extends Error {
  constructor(readonly snapshot: PinnedItemsSnapshot) {
    super('Pinned items changed on another device.')
    this.name = 'PinRevisionConflictError'
  }
}

/**
 * Keeps the local SQLite table as an offline mirror/outbox while making the
 * server authoritative once the one-time import has completed.
 */
export class PinSyncCoordinator {
  private readonly queues = new Map<string, Promise<PinnedItem[]>>()

  constructor(private readonly cache: PinSyncCache) {}

  list(context: PinSyncContext, minimumRevision?: number): Promise<PinnedItem[]> {
    return this.enqueue(context, async () => {
      context.assertCurrent()
      const state = this.state(context)
      if (
        minimumRevision != null
        && state.migrated
        && state.pendingPuts.length === 0
        && state.pendingRemovals.length === 0
        && state.revision != null
        && state.revision >= minimumRevision
      ) return this.local(context)
      return this.syncOrLocal(context)
    })
  }

  put(context: PinSyncContext, item: PinnedItem): Promise<PinnedItem[]> {
    return this.enqueue(context, async () => {
      context.assertCurrent()
      const state = this.state(context)
      const previousPins = this.local(context)
      const pendingPuts = new Map(state.pendingPuts.map(candidate => [candidate.id, candidate]))
      pendingPuts.set(item.id, item)
      this.writeState(context, {
        ...state,
        pendingPuts: [...pendingPuts.values()],
        pendingRemovals: state.pendingRemovals.filter(itemId => itemId !== item.id)
      })
      // The durable outbox must precede the mirror write. A crash in between is
      // recoverable because the pending PUT will repair the mirror on retry.
      this.cache.putPin(context.namespace(), item)
      return this.syncOrLocal(context, () => {
        this.cache.replacePins(context.namespace(), context.sessionId, previousPins)
        this.writeState(context, state)
      })
    })
  }

  remove(context: PinSyncContext, itemId: string): Promise<PinnedItem[]> {
    return this.enqueue(context, async () => {
      context.assertCurrent()
      const state = this.state(context)
      const previousPins = this.local(context)
      this.writeState(context, {
        ...state,
        pendingPuts: state.pendingPuts.filter(item => item.id !== itemId),
        pendingRemovals: [...new Set([...state.pendingRemovals, itemId])]
      })
      // Persist the tombstone before removing the mirror row so an interrupted
      // unpin cannot be resurrected by the next authoritative GET.
      this.cache.removePin(context.namespace(), context.sessionId, itemId)
      return this.syncOrLocal(context, () => {
        this.cache.replacePins(context.namespace(), context.sessionId, previousPins)
        this.writeState(context, state)
      })
    })
  }

  revision(context: PinSyncContext): number {
    context.assertCurrent()
    return this.state(context).revision ?? 0
  }

  private enqueue(context: PinSyncContext, operation: () => Promise<PinnedItem[]>): Promise<PinnedItem[]> {
    const previous = this.queues.get(context.queueKey)
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(operation)
    this.queues.set(context.queueKey, next)
    void next.finally(() => {
      if (this.queues.get(context.queueKey) === next) this.queues.delete(context.queueKey)
    }).catch(() => undefined)
    return next
  }

  private async syncOrLocal(context: PinSyncContext, rollback?: () => void): Promise<PinnedItem[]> {
    try {
      const remote = await context.connect()
      context.assertCurrent()
      if (!remote) return this.local(context)
      return await this.sync(context, remote)
    } catch (error) {
      if (!context.isCurrent()) throw error
      if (!context.shouldDefer(error)) {
        rollback?.()
        throw error
      }
      context.deferred(error)
      return this.local(context)
    }
  }

  private async sync(context: PinSyncContext, remote: RemotePins): Promise<PinnedItem[]> {
    const localBeforeSync = this.local(context)
    const state = this.state(context)
    let snapshot = await remote.list(context.sessionId)
    context.assertCurrent()

    for (const itemId of state.pendingRemovals) {
      snapshot = await this.mutateAtCurrentRevision(snapshot, revision => (
        remote.remove(context.sessionId, itemId, revision)
      ))
      context.assertCurrent()
    }

    if (!state.migrated) {
      const remoteIds = new Set(snapshot.pins.map(item => item.id))
      const pendingPutIds = new Set(state.pendingPuts.map(item => item.id))
      const removedIds = new Set(state.pendingRemovals)
      const quarantinedLegacyIds = new Set(state.quarantinedLegacyIds)
      const legacyItems = localBeforeSync.filter(item => (
        !remoteIds.has(item.id)
        && !pendingPutIds.has(item.id)
        && !removedIds.has(item.id)
        && !quarantinedLegacyIds.has(item.id)
      ))
      // Omitting If-Match marks these as legacy import attempts. Server-side
      // durable tombstones prevent a stale local database from resurrecting an
      // item that another device already deleted.
      for (const item of legacyItems) {
        const quarantine = () => {
          quarantinedLegacyIds.add(item.id)
          this.writeState(context, {
            ...state,
            quarantinedLegacyIds: [...quarantinedLegacyIds]
          })
        }
        let prepared: PinnedItem
        try {
          prepared = context.prepareLegacy?.(item) ?? item
        } catch {
          // Local legacy validation failures are permanent regardless of the
          // transport retry policy. Quarantine them before making any request.
          context.assertCurrent()
          quarantine()
          continue
        }
        try {
          snapshot = await remote.put(prepared)
          context.assertCurrent()
        } catch (error) {
          context.assertCurrent()
          if (context.shouldDefer(error)) throw error
          // A malformed or no-longer-owned legacy row must not block every
          // valid pin from completing its one-time import forever. Remember
          // the rejected ID durably, leave the server authoritative, and keep
          // processing the remaining legacy rows.
          quarantine()
        }
      }
    }

    for (const item of state.pendingPuts) {
      snapshot = await this.mutateAtCurrentRevision(snapshot, revision => remote.put(item, revision))
      context.assertCurrent()
    }

    const complete: StoredPinSyncState = {
      version: PIN_SYNC_STATE_VERSION,
      migrated: true,
      revision: snapshot.revision,
      pendingPuts: [],
      pendingRemovals: [],
      quarantinedLegacyIds: state.migrated ? state.quarantinedLegacyIds : [
        ...new Set([
          ...state.quarantinedLegacyIds,
          ...localBeforeSync
            .filter(item => !snapshot.pins.some(remoteItem => remoteItem.id === item.id))
            .filter(item => !state.pendingRemovals.includes(item.id))
            .map(item => item.id)
        ])
      ]
    }
    // Commit the marker only after every idempotent server mutation succeeds.
    // Until then the untouched local mirror and durable outbox are retained.
    const pins = this.cache.replacePins(context.namespace(), context.sessionId, snapshot.pins)
    this.writeState(context, complete)
    return pins
  }

  private async mutateAtCurrentRevision(
    initial: PinnedItemsSnapshot,
    operation: (revision: number) => Promise<PinnedItemsSnapshot>
  ): Promise<PinnedItemsSnapshot> {
    let snapshot = initial
    for (let attempt = 0; attempt < MAX_REVISION_RETRIES; attempt += 1) {
      try {
        return await operation(snapshot.revision)
      } catch (error) {
        if (!(error instanceof PinRevisionConflictError)) throw error
        snapshot = error.snapshot
      }
    }
    throw new Error('Pinned items kept changing on another device. The change remains saved locally and will retry.')
  }

  private local(context: PinSyncContext): PinnedItem[] {
    return this.cache.pins(context.namespace(), context.sessionId)
  }

  private state(context: PinSyncContext): StoredPinSyncState {
    const fallback = defaultState()
    const value = this.cache.preference<unknown>(context.namespace(), stateKey(context.sessionId), fallback)
    if (!isRecord(value) || value.version !== PIN_SYNC_STATE_VERSION) return fallback
    const pendingPuts = Array.isArray(value.pendingPuts)
      ? value.pendingPuts.filter(item => isStoredPin(item, context.sessionId))
      : []
    const pendingRemovals = Array.isArray(value.pendingRemovals)
      ? value.pendingRemovals.filter((itemId): itemId is string => typeof itemId === 'string' && itemId.length > 0)
      : []
    const quarantinedLegacyIds = Array.isArray(value.quarantinedLegacyIds)
      ? value.quarantinedLegacyIds.filter((itemId): itemId is string => typeof itemId === 'string' && itemId.length > 0)
      : []
    return {
      version: PIN_SYNC_STATE_VERSION,
      migrated: value.migrated === true,
      revision: Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 ? Number(value.revision) : null,
      pendingPuts,
      pendingRemovals: [...new Set(pendingRemovals)],
      quarantinedLegacyIds: [...new Set(quarantinedLegacyIds)]
    }
  }

  private writeState(context: PinSyncContext, state: StoredPinSyncState): void {
    context.assertCurrent()
    this.cache.putPreference(context.namespace(), stateKey(context.sessionId), state)
  }
}

function stateKey(sessionId: string): string {
  return `${PIN_SYNC_STATE_PREFIX}${sessionId}`
}

function defaultState(): StoredPinSyncState {
  return {
    version: PIN_SYNC_STATE_VERSION,
    migrated: false,
    revision: null,
    pendingPuts: [],
    pendingRemovals: [],
    quarantinedLegacyIds: []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isStoredPin(value: unknown, sessionId: string): value is PinnedItem {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && value.id.length > 0
    && value.sessionId === sessionId
    && (value.kind === 'message' || value.kind === 'file')
    && typeof value.title === 'string'
    && Number.isFinite(value.createdAt)
}
