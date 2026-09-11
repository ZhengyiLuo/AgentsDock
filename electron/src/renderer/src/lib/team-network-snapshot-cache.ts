import type { TeamHubScope, TeamHubStatus, TeamHubTeamDetails, TeamHubWorkspace } from '@shared/team-hub'
import type {
  TeamMessagesCapability,
  TeamMessageBox,
  TeamMessageSummary,
  TeamNetworkBulletinPost,
  TeamNetworkCapabilities,
  TeamNetworkProjectionPage,
  TeamNetworkServer
} from '@shared/team-network'

const SNAPSHOT_FRESH_MS = 30_000
const SNAPSHOT_STALE_WHILE_REVALIDATE_MS = 5 * 60_000
const SNAPSHOT_MAX_ENTRIES = 12
const MESSAGE_SNAPSHOT_MAX_ENTRIES = 48
const ROSTER_MAX_PAGES = 256

export interface TeamNetworkExpectedIdentity {
  profileId: string
  profileGeneration: number
  serverIdentity: string
}

export interface TeamNetworkCoreSnapshot {
  details: TeamHubTeamDetails
  capabilities: TeamNetworkCapabilities
  teamMessagesCapability: TeamMessagesCapability | null
  projectionPage: TeamNetworkProjectionPage
  legacyBulletin: {
    posts: TeamNetworkBulletinPost[]
    next_after_sequence: number
  }
  loadedAt: number
}

/**
 * A complete, previously verified lifecycle that can be painted before the
 * next status IPC resolves. The expected identity is supplied by the active
 * renderer profile; the exact Hub/session lifecycle remains part of the
 * indexed cache key and is revalidated immediately after mount.
 */
export interface TeamNetworkOpeningSnapshot {
  status: TeamHubStatus
  workspace: TeamHubWorkspace
  teamId: string
  core: TeamNetworkCoreSnapshot
}

export interface TeamMessagesSnapshotQuery {
  teamId: string
  box: TeamMessageBox
  addressKind?: 'server' | 'human'
  addressId?: string
}

export interface TeamMessagesSnapshot {
  messages: TeamMessageSummary[]
  nextAfter: number | null
  hasMore: boolean
  latestSequence: number
}

interface CacheEntry<T> {
  value: T
  loadedAt: number
}

interface RosterSnapshot {
  servers: TeamNetworkServer[]
  nextAfterServerId: string | null
  hasMore: boolean
  complete: boolean
  loadedAt: number
}

const workspaceCache = new Map<string, CacheEntry<TeamHubWorkspace>>()
const workspaceInFlight = new Map<string, Promise<TeamHubWorkspace>>()
const coreCache = new Map<string, CacheEntry<TeamNetworkCoreSnapshot>>()
const coreInFlight = new Map<string, Promise<TeamNetworkCoreSnapshot>>()
const rosterCache = new Map<string, RosterSnapshot>()
const rosterInFlight = new Map<string, Promise<TeamNetworkServer[]>>()
const latestLifecycleByExpectedIdentity = new Map<string, { lifecycleKey: string; teamId: string | null }>()
const messageCache = new Map<string, CacheEntry<TeamMessagesSnapshot>>()
let cacheRevision = 0

export function teamNetworkCacheRevision(): number { return cacheRevision }

export function teamNetworkScope(status: TeamHubStatus): TeamHubScope {
  if (!status.serverIdentity) throw new Error('The active AgentsServer identity is unavailable.')
  return {
    profileId: status.profileId,
    profileGeneration: status.profileGeneration,
    serverIdentity: status.serverIdentity,
    generation: status.generation,
    hubIdentity: status.hubIdentity,
    ...(status.connectionId ? { connectionId: status.connectionId } : {}),
    ...(status.hostServerIdentity ? { hostServerIdentity: status.hostServerIdentity } : {})
  }
}

/**
 * Exact authority/lifecycle key. Cached Team Network data is never reused
 * across a profile generation, AgentsServer identity, Hub generation,
 * authenticated principal/session, or secure-peer route.
 */
export function teamNetworkSnapshotKey(status: TeamHubStatus): string {
  return JSON.stringify([
    status.profileId,
    status.profileGeneration,
    status.serverIdentity,
    status.generation,
    status.hubIdentity,
    status.connectionId ?? null,
    status.hostServerIdentity ?? null,
    status.authenticationMode ?? null,
    status.principal?.id ?? null,
    status.session?.id ?? null
  ])
}

export function assertTeamNetworkExpectedIdentity(
  status: TeamHubStatus,
  expected: TeamNetworkExpectedIdentity
): void {
  if (
    status.profileId !== expected.profileId
    || status.profileGeneration !== expected.profileGeneration
    || status.serverIdentity !== expected.serverIdentity
  ) throw new Error('The active AgentsServer changed while Team Network was loading.')
}

export function peekTeamNetworkOpeningSnapshot(
  expected: TeamNetworkExpectedIdentity,
  preferredTeamId?: string | null
): TeamNetworkOpeningSnapshot | null {
  const indexed = latestLifecycleByExpectedIdentity.get(expectedIdentityKey(expected))
  if (!indexed) return null
  const workspaceEntry = workspaceCache.get(indexed.lifecycleKey)
  if (!workspaceEntry || !isUsableStale(workspaceEntry.loadedAt)) return null
  const workspace = workspaceEntry.value
  if (
    teamNetworkSnapshotKey(workspace.status) !== indexed.lifecycleKey
    || !matchesExpectedIdentity(workspace.status, expected)
  ) return null
  const teamId = preferredTeamId && workspace.teams.some(team => team.id === preferredTeamId)
    ? preferredTeamId
    : indexed.teamId && workspace.teams.some(team => team.id === indexed.teamId)
      ? indexed.teamId
      : workspace.teams[0]?.id ?? null
  if (!teamId) return null
  const coreEntry = coreCache.get(`${indexed.lifecycleKey}\u0000${teamId}`)
  if (!coreEntry || !isUsableStale(coreEntry.loadedAt)) return null
  if (
    coreEntry.value.details.team.id !== teamId
    || coreEntry.value.projectionPage.network.id !== teamId
  ) return null
  // Refresh recency/order without extending the underlying snapshot lifetime.
  putBounded(latestLifecycleByExpectedIdentity, expectedIdentityKey(expected), {
    lifecycleKey: indexed.lifecycleKey,
    teamId
  })
  return { status: workspace.status, workspace, teamId, core: coreEntry.value }
}

export function peekTeamMessagesSnapshot(
  lifecycleKey: string,
  query: TeamMessagesSnapshotQuery
): TeamMessagesSnapshot | null {
  const cached = messageCache.get(teamMessagesCacheKey(lifecycleKey, query))
  return cached && isUsableStale(cached.loadedAt) ? cached.value : null
}

export function writeTeamMessagesSnapshot(
  lifecycleKey: string,
  query: TeamMessagesSnapshotQuery,
  snapshot: TeamMessagesSnapshot
): void {
  putBounded(messageCache, teamMessagesCacheKey(lifecycleKey, query), {
    value: snapshot,
    loadedAt: Date.now()
  }, MESSAGE_SNAPSHOT_MAX_ENTRIES)
}

export function peekTeamNetworkWorkspace(status: TeamHubStatus): TeamHubWorkspace | null {
  const cached = workspaceCache.get(teamNetworkSnapshotKey(status))
  return cached && isUsableStale(cached.loadedAt) ? cached.value : null
}

export async function loadTeamNetworkWorkspace(
  status: TeamHubStatus,
  options: { force?: boolean } = {}
): Promise<TeamHubWorkspace> {
  const key = teamNetworkSnapshotKey(status)
  const cached = workspaceCache.get(key)
  if (!options.force && cached && isFresh(cached.loadedAt)) return cached.value
  const active = workspaceInFlight.get(key)
  if (active) return active
  const revision = cacheRevision
  const scope = teamNetworkScope(status)
  const operation = window.agentsDock.teamHub.workspace(scope).then(workspace => {
    if (teamNetworkSnapshotKey(workspace.status) !== key) {
      throw new Error('The Team Network workspace changed while it was loading.')
    }
    if (cacheRevision === revision) {
      putBounded(workspaceCache, key, { value: workspace, loadedAt: Date.now() })
      rememberOpeningLifecycle(workspace.status, key)
    }
    return workspace
  }).finally(() => {
    if (workspaceInFlight.get(key) === operation) workspaceInFlight.delete(key)
  })
  workspaceInFlight.set(key, operation)
  return operation
}

export function peekTeamNetworkCore(status: TeamHubStatus, teamId: string): TeamNetworkCoreSnapshot | null {
  const cached = coreCache.get(teamCacheKey(status, teamId))
  return cached && isUsableStale(cached.loadedAt) ? cached.value : null
}

/**
 * Loads the expensive first Team Network view in one remote phase. Team
 * details and the first roster page are independent and deliberately begin
 * together; capability reads are local main-process fences.
 */
export async function loadTeamNetworkCore(
  status: TeamHubStatus,
  teamId: string,
  options: {
    force?: boolean
    teamMessagesRequest?: Promise<TeamMessagesCapability | null>
  } = {}
): Promise<TeamNetworkCoreSnapshot> {
  const key = teamCacheKey(status, teamId)
  const cached = coreCache.get(key)
  if (!options.force && cached && isFresh(cached.loadedAt)) return cached.value
  const active = coreInFlight.get(key)
  if (active) return active
  const revision = cacheRevision
  const scope = teamNetworkScope(status)
  const capabilityRequest = Promise.resolve(window.agentsDock.teamHub.networkCapabilities(scope))
  const teamMessagesRequest = options.teamMessagesRequest ?? loadTeamMessagesCapability(scope)
  const projectionRequest = capabilityRequest.then(capability => (
    window.agentsDock.teamHub.network(scope, { teamId, limit: capability.max_page_items })
  ))
  const bulletinRequest = teamMessagesRequest.then(capability => capability
    ? { posts: [] as TeamNetworkBulletinPost[], next_after_sequence: 0 }
    : window.agentsDock.teamHub.bulletin(scope, { teamId, afterSequence: 0 }))
  const operation = Promise.all([
    capabilityRequest,
    teamMessagesRequest,
    window.agentsDock.teamHub.team(scope, teamId),
    projectionRequest,
    bulletinRequest
  ]).then(([capabilities, teamMessagesCapability, details, projectionPage, legacyBulletin]) => {
    const snapshot: TeamNetworkCoreSnapshot = {
      capabilities,
      teamMessagesCapability,
      details,
      projectionPage,
      legacyBulletin,
      loadedAt: Date.now()
    }
    if (cacheRevision === revision) {
      putBounded(coreCache, key, { value: snapshot, loadedAt: snapshot.loadedAt })
      seedTeamNetworkRoster(status, teamId, projectionPage)
      rememberOpeningLifecycle(status, teamNetworkSnapshotKey(status), teamId)
    }
    return snapshot
  }).finally(() => {
    if (coreInFlight.get(key) === operation) coreInFlight.delete(key)
  })
  coreInFlight.set(key, operation)
  return operation
}

export function peekTeamNetworkServers(status: TeamHubStatus, teamId: string): TeamNetworkServer[] | null {
  const cached = rosterCache.get(teamCacheKey(status, teamId))
  return cached && isUsableStale(cached.loadedAt) ? cached.servers : null
}

export function seedTeamNetworkRoster(
  status: TeamHubStatus,
  teamId: string,
  page: TeamNetworkProjectionPage
): void {
  const key = teamCacheKey(status, teamId)
  putBounded(rosterCache, key, {
    servers: page.servers,
    nextAfterServerId: page.next_after_server_id,
    hasMore: page.has_more,
    complete: !page.has_more,
    loadedAt: Date.now()
  })
}

/** Complete recipient roster, shared and singleflighted across split composers. */
export async function loadTeamNetworkServers(
  status: TeamHubStatus,
  teamId: string,
  options: { force?: boolean } = {}
): Promise<TeamNetworkServer[]> {
  const key = teamCacheKey(status, teamId)
  const cached = rosterCache.get(key)
  if (!options.force && cached && cached.complete && isFresh(cached.loadedAt)) return cached.servers
  const active = rosterInFlight.get(key)
  if (active) return active
  const revision = cacheRevision
  const scope = teamNetworkScope(status)
  const operation = (async () => {
    const capability = typeof window.agentsDock.teamHub.networkCapabilities === 'function'
      ? await window.agentsDock.teamHub.networkCapabilities(scope)
      : { max_page_items: 100 }
    const continueCachedPage = Boolean(
      !options.force
      && cached
      && !cached.complete
      && cached.hasMore
      && cached.nextAfterServerId
      && isFresh(cached.loadedAt)
    )
    let servers: TeamNetworkServer[] = continueCachedPage ? cached!.servers : []
    let afterServerId: string | undefined = continueCachedPage
      ? cached!.nextAfterServerId ?? undefined
      : undefined
    const cursors = new Set<string>(afterServerId ? [afterServerId] : [])
    for (let pageIndex = 0; pageIndex < ROSTER_MAX_PAGES; pageIndex += 1) {
      const page = await window.agentsDock.teamHub.network(scope, {
        teamId,
        afterServerId,
        limit: capability.max_page_items
      })
      servers = mergeServers(servers, page.servers)
      if (!page.has_more || !page.next_after_server_id) {
        if (cacheRevision === revision) {
          putBounded(rosterCache, key, {
            servers,
            nextAfterServerId: page.next_after_server_id,
            hasMore: page.has_more,
            complete: true,
            loadedAt: Date.now()
          })
        }
        return servers
      }
      if (cursors.has(page.next_after_server_id)) {
        throw new Error('Team Network returned a stalled recipient continuation.')
      }
      cursors.add(page.next_after_server_id)
      afterServerId = page.next_after_server_id
    }
    throw new Error('Team Network recipients exceed the supported roster limit.')
  })().finally(() => {
    if (rosterInFlight.get(key) === operation) rosterInFlight.delete(key)
  })
  rosterInFlight.set(key, operation)
  return operation
}

export function invalidateTeamNetworkSnapshot(status?: TeamHubStatus, teamId?: string): void {
  cacheRevision += 1
  if (!status) {
    workspaceCache.clear()
    coreCache.clear()
    rosterCache.clear()
    workspaceInFlight.clear()
    coreInFlight.clear()
    rosterInFlight.clear()
    latestLifecycleByExpectedIdentity.clear()
    messageCache.clear()
  } else if (!teamId) {
    const lifecycle = teamNetworkSnapshotKey(status)
    workspaceCache.delete(lifecycle)
    deletePrefix(coreCache, `${lifecycle}\u0000`)
    deletePrefix(rosterCache, `${lifecycle}\u0000`)
    workspaceInFlight.delete(lifecycle)
    deletePrefix(coreInFlight, `${lifecycle}\u0000`)
    deletePrefix(rosterInFlight, `${lifecycle}\u0000`)
    deleteOpeningLifecycle(lifecycle)
    deletePrefix(messageCache, `${lifecycle}\u0000`)
  } else {
    const key = teamCacheKey(status, teamId)
    coreCache.delete(key)
    rosterCache.delete(key)
    coreInFlight.delete(key)
    rosterInFlight.delete(key)
    for (const [expectedKey, indexed] of latestLifecycleByExpectedIdentity) {
      if (indexed.lifecycleKey === teamNetworkSnapshotKey(status) && indexed.teamId === teamId) {
        latestLifecycleByExpectedIdentity.delete(expectedKey)
      }
    }
    deleteTeamMessageSnapshots(teamNetworkSnapshotKey(status), teamId)
  }
  window.dispatchEvent(new CustomEvent('agentsdock:team-network-cache-invalidated'))
}

export function resetTeamNetworkSnapshotCacheForTests(): void {
  cacheRevision += 1
  workspaceCache.clear()
  workspaceInFlight.clear()
  coreCache.clear()
  coreInFlight.clear()
  rosterCache.clear()
  rosterInFlight.clear()
  latestLifecycleByExpectedIdentity.clear()
  messageCache.clear()
}

async function loadTeamMessagesCapability(scope: TeamHubScope): Promise<TeamMessagesCapability | null> {
  if (typeof window.agentsDock.teamHub.teamMessagesCapabilities !== 'function') return null
  try {
    return await window.agentsDock.teamHub.teamMessagesCapabilities(scope)
  } catch (cause) {
    if (errorMessage(cause).includes('does not support Team Messages yet')) return null
    throw cause
  }
}

function teamCacheKey(status: TeamHubStatus, teamId: string): string {
  return `${teamNetworkSnapshotKey(status)}\u0000${teamId}`
}

function teamMessagesCacheKey(lifecycleKey: string, query: TeamMessagesSnapshotQuery): string {
  return `${lifecycleKey}\u0000${JSON.stringify([
    query.teamId,
    query.box,
    query.addressKind ?? null,
    query.addressId ?? null
  ])}`
}

function deleteTeamMessageSnapshots(lifecycleKey: string, teamId: string): void {
  const prefix = `${lifecycleKey}\u0000`
  for (const key of messageCache.keys()) {
    if (!key.startsWith(prefix)) continue
    try {
      const query = JSON.parse(key.slice(prefix.length)) as unknown
      if (Array.isArray(query) && query[0] === teamId) messageCache.delete(key)
    } catch {
      // A malformed internal key is never reusable and should be discarded.
      messageCache.delete(key)
    }
  }
}

function expectedIdentityKey(expected: TeamNetworkExpectedIdentity): string {
  return JSON.stringify([expected.profileId, expected.profileGeneration, expected.serverIdentity])
}

function matchesExpectedIdentity(status: TeamHubStatus, expected: TeamNetworkExpectedIdentity): boolean {
  return status.profileId === expected.profileId
    && status.profileGeneration === expected.profileGeneration
    && status.serverIdentity === expected.serverIdentity
}

function rememberOpeningLifecycle(status: TeamHubStatus, lifecycleKey: string, teamId?: string): void {
  if (!status.serverIdentity) return
  const key = expectedIdentityKey({
    profileId: status.profileId,
    profileGeneration: status.profileGeneration,
    serverIdentity: status.serverIdentity
  })
  const current = latestLifecycleByExpectedIdentity.get(key)
  putBounded(latestLifecycleByExpectedIdentity, key, {
    lifecycleKey,
    teamId: teamId ?? (current?.lifecycleKey === lifecycleKey ? current.teamId : null)
  })
}

function deleteOpeningLifecycle(lifecycleKey: string): void {
  for (const [key, indexed] of latestLifecycleByExpectedIdentity) {
    if (indexed.lifecycleKey === lifecycleKey) latestLifecycleByExpectedIdentity.delete(key)
  }
}

function isFresh(loadedAt: number): boolean {
  return Date.now() - loadedAt <= SNAPSHOT_FRESH_MS
}

function isUsableStale(loadedAt: number): boolean {
  return Date.now() - loadedAt <= SNAPSHOT_STALE_WHILE_REVALIDATE_MS
}

function mergeServers(current: TeamNetworkServer[], incoming: TeamNetworkServer[]): TeamNetworkServer[] {
  const byId = new Map(current.map(server => [server.id, server]))
  for (const server of incoming) byId.set(server.id, server)
  return [...byId.values()]
}

function putBounded<T>(cache: Map<string, T>, key: string, value: T, maxEntries = SNAPSHOT_MAX_ENTRIES): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== 'string') return
    cache.delete(oldest)
  }
}

function deletePrefix<T>(cache: Map<string, T>, prefix: string): void {
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Team Network request failed.'
}
