import type {
  SecurePeerControlStatus,
  SecurePeerHostStatus,
  SecurePeerPairing,
  SecurePeerProfileScope,
  SecurePeerScope
} from '../shared/secure-peer'

export function automaticPairingCompletionAvailable(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const capability = value as Record<string, unknown>
  return capability.available === true && capability.version === 1
    && capability.completion_path === '/api/admin/secure-peers/v1/pairings/{pairing_id}/completion'
    && capability.max_wait_seconds === 600
}

export function securePeerEndpointUpdateAvailable(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const capability = value as Record<string, unknown>
  return capability.available === true && capability.version === 1
    && capability.endpoint_update_version === 1
    && capability.endpoint_update_path === '/api/admin/secure-peers/v1/connections/{connection_id}/endpoint'
}
import {
  SECURE_PEER_DEFAULT_HEARTBEAT_SECONDS,
  SECURE_PEER_DEFAULT_LEASE_SECONDS,
  normalizeSecurePeerEndpoint,
  normalizeSecurePeerIPv4,
  normalizeSecurePeerPort,
  normalizeSecurePeerScopes
} from '../shared/secure-peer'

export interface SecurePeerControlStatusWire {
  version: 1 | 2
  heartbeat_interval_seconds?: number
  lease_seconds?: number
  server_identity: string
  server_instance_id: string
  active_connection_id: string | null
  remote_route_delivery_available?: boolean
  connection_error?: string | null
  host: unknown
  pairings: unknown[]
  remote_routes?: unknown[]
  published_routes?: unknown[]
}

export function parseSecurePeerControlStatus(
  value: unknown,
  scope: SecurePeerProfileScope,
  expectedServerInstanceId?: string
): SecurePeerControlStatus {
  const item = record(value)
  if (item.version !== 1 && item.version !== 2) throw invalidResponse()
  const version = item.version
  const heartbeatIntervalSeconds = version === 2
    ? positiveInteger(item.heartbeat_interval_seconds, 3_600)
    : SECURE_PEER_DEFAULT_HEARTBEAT_SECONDS
  const leaseSeconds = version === 2
    ? positiveInteger(item.lease_seconds, 86_400)
    : SECURE_PEER_DEFAULT_LEASE_SECONDS
  if (leaseSeconds < heartbeatIntervalSeconds) throw invalidResponse()
  const serverIdentity = identifier(item.server_identity, 'server identity')
  if (serverIdentity !== scope.serverIdentity) throw new Error('Secure peer response came from a different AgentsServer identity.')
  const serverInstanceId = identifier(item.server_instance_id, 'server instance')
  if (expectedServerInstanceId !== undefined && serverInstanceId !== expectedServerInstanceId) {
    throw new Error('Secure peer response came from a different AgentsServer instance.')
  }
  if (item.remote_route_delivery_available !== undefined && typeof item.remote_route_delivery_available !== 'boolean') {
    throw invalidResponse()
  }
  return {
    version,
    heartbeatIntervalSeconds,
    leaseSeconds,
    profileId: scope.profileId,
    profileGeneration: scope.profileGeneration,
    serverIdentity,
    serverInstanceId,
    activeConnectionId: nullableUUID(item.active_connection_id, 'active connection'),
    remoteRouteDeliveryAvailable: item.remote_route_delivery_available === true,
    connectionError: nullableString(item.connection_error, 'connection error', 400),
    host: parseHost(item.host, version === 2),
    pairings: boundedArray(item.pairings, 512).map(pairing => parseSecurePeerPairing(pairing, version === 2)),
    remoteRoutes: boundedArray(item.remote_routes ?? [], 2_000).map(parseRemoteRoute),
    publishedRoutes: boundedArray(item.published_routes ?? [], 2_000).map(parsePublishedRoute)
  }
}

function parseRemoteRoute(value: unknown) {
  const item = record(value)
  const actions = boundedArray(item.actions, 2).map(action => enumValue(
    action, ['instruction', 'request_reply'] as const, 'remote route action'
  ))
  if (!actions.length || new Set(actions).size !== actions.length) throw invalidResponse()
  const revision = string(item.revision, 'remote route revision', 36)
  if (!/^rev_[0-9a-f]{32}$/.test(revision)) throw invalidResponse()
  const alias = string(item.alias, 'remote route alias', 32)
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(alias)) throw invalidResponse()
  return {
    peerServerIdentity: identifier(item.peer_server_identity, 'peer server identity'),
    peerDisplayName: string(item.peer_display_name, 'peer display name', 160),
    connectionId: uuid(item.connection_id, 'remote route connection'),
    routeId: uuid(item.route_id, 'remote route'),
    revision,
    alias,
    displayTitle: string(item.display_title, 'remote route title', 240),
    actions
  }
}

function parsePublishedRoute(value: unknown) {
  const item = record(value)
  const route = parseRemoteRoute(value)
  return {
    ...route,
    chatId: identifier(item.chat_id, 'published route chat'),
    status: enumValue(item.status, ['publishing', 'active', 'revoked'] as const, 'published route status')
  }
}

export function parseSecurePeerPairing(value: unknown, requireLifecycle = false): SecurePeerPairing {
  const item = record(value)
  if (item.complete_on_approval !== undefined && typeof item.complete_on_approval !== 'boolean') throw invalidResponse()
  const status = enumValue(item.status, [
    'requesting', 'pending_approval', 'approved', 'connected', 'rejected', 'revoked', 'expired', 'error'
  ] as const, 'pairing status')
  if ((item.trust_state == null) !== (item.transport_state == null)) throw invalidResponse()
  if (requireLifecycle && (item.trust_state == null || item.transport_state == null)) throw invalidResponse()
  const trustState = item.trust_state == null
    ? legacyTrustState(status)
    : enumValue(item.trust_state, [
      'pending', 'approved', 'revoked', 'rejected', 'cancelled', 'expired', 'error'
    ] as const, 'pairing trust state')
  const transportState = item.transport_state == null
    ? legacyTransportState(status)
    : enumValue(item.transport_state, [
      'online', 'reconnecting', 'offline', 'disconnected', 'revoked'
    ] as const, 'pairing transport state')
  if ((trustState === 'revoked') !== (transportState === 'revoked')) throw invalidResponse()
  if (['online', 'reconnecting', 'offline'].includes(transportState) && trustState !== 'approved') throw invalidResponse()
  if (!legacyStatusMatchesTrust(status, trustState)) throw invalidResponse()
  if (status === 'connected' && transportState === 'disconnected') throw invalidResponse()
  const direction = enumValue(item.direction, ['incoming', 'outgoing'] as const, 'pairing direction')
  const connectionId = nullableUUID(item.connection_id, 'connection')
  const proxy = nullableString(item.local_proxy_base_path, 'local proxy path', 240)
  if (proxy !== null) {
    if (!connectionId || proxy !== `/api/team-hub-secure/${connectionId}`) throw invalidResponse()
  }
  if (status === 'connected' && (!connectionId || !proxy || item.hub_id == null)) throw invalidResponse()
  const sas = boundedArray(item.sas_words, 6)
  if (sas.length !== 6) throw invalidResponse()
  const sasWords = sas.map(word => {
    const clean = string(word, 'SAS word', 32)
    if (!/^[a-z][a-z-]{1,31}$/.test(clean)) throw invalidResponse()
    return clean
  }) as [string, string, string, string, string, string]
  return {
    id: uuid(item.id, 'pairing'),
    ...(item.complete_on_approval !== undefined ? { completeOnApproval: item.complete_on_approval === true } : {}),
    direction,
    status,
    trustState,
    transportState,
    peerServerIdentity: identifier(item.peer_server_identity, 'peer server identity'),
    peerDisplayName: string(item.peer_display_name, 'peer display name', 160),
    remoteEndpoint: normalizeSecurePeerEndpoint(string(item.remote_endpoint, 'remote endpoint', 64)).endpoint,
    hostServerIdentity: identifier(item.host_server_identity, 'host server identity'),
    hostCaFingerprint: fingerprint(item.host_ca_fingerprint),
    peerPublicKeyFingerprint: fingerprint(item.peer_public_key_fingerprint),
    transcriptHash: hash(item.transcript_hash, 'transcript hash'),
    sasWords,
    requestedScopes: normalizeSecurePeerScopes(boundedArray(item.requested_scopes, 4)),
    grantedScopes: item.granted_scopes == null ? [] : optionalScopes(item.granted_scopes),
    teamId: nullableIdentifier(item.team_id, 'team'),
    teamDisplayName: nullableString(item.team_display_name, 'team display name', 160),
    hubIdentity: nullableIdentifier(item.hub_id, 'Hub'),
    connectionId,
    localProxyBasePath: proxy,
    certificateExpiresAt: nullableTimestamp(item.certificate_expires_at),
    certificateFingerprint: item.certificate_fingerprint == null ? null : fingerprint(item.certificate_fingerprint),
    lastSeenAt: nullableTimestamp(item.last_seen_at),
    expiresAt: nullableTimestamp(item.expires_at),
    error: nullableString(item.error, 'pairing error', 400)
  }
}

export function parseSecurePeerHostPeers(value: unknown): SecurePeerPairing[] {
  const item = record(value)
  return boundedArray(item.peers, 512).map(peer => parseSecurePeerPairing(peer, true))
}

export function parseSecurePeerHostPeerRevocation(value: unknown): SecurePeerPairing {
  return parseSecurePeerPairing(record(value).peer, true)
}

function parseHost(value: unknown, requireErrorCode: boolean): SecurePeerHostStatus {
  const item = record(value)
  if (requireErrorCode && !Object.prototype.hasOwnProperty.call(item, 'error_code')) throw invalidResponse()
  if (typeof item.available !== 'boolean' || typeof item.enabled !== 'boolean') throw invalidResponse()
  const advertisedHost = item.advertised_host == null ? null : normalizeSecurePeerIPv4(item.advertised_host)
  const advertisedHosts = boundedArray(item.advertised_hosts, 16).map(normalizeSecurePeerIPv4)
  if (new Set(advertisedHosts).size !== advertisedHosts.length) throw invalidResponse()
  if (item.enabled && (!item.available || !advertisedHost || !advertisedHosts.includes(advertisedHost))) throw invalidResponse()
  const caFingerprint = item.ca_fingerprint == null ? null : fingerprint(item.ca_fingerprint)
  const pairingLink = nullableString(item.pairing_link, 'pairing link', 512)
  if (pairingLink !== null) {
    if (!caFingerprint) throw invalidResponse()
    validatePairingLink(pairingLink, advertisedHost, normalizeSecurePeerPort(item.listen_port), caFingerprint)
  }
  if (item.enabled && (!caFingerprint || !pairingLink)) throw invalidResponse()
  if ((!item.available || !item.enabled) && pairingLink !== null) throw invalidResponse()
  const certificateExpiresAt = nullableTimestamp(item.certificate_expires_at)
  if ((!item.available || !item.enabled) && certificateExpiresAt !== null) throw invalidResponse()
  return {
    available: item.available,
    enabled: item.enabled,
    listenPort: normalizeSecurePeerPort(item.listen_port),
    advertisedHost,
    advertisedHosts,
    caFingerprint,
    pairingLink,
    certificateExpiresAt,
    error: nullableString(item.error, 'host error', 400),
    errorCode: nullableErrorCode(item.error_code),
    action: nullableString(item.action, 'host action', 400)
  }
}

function validatePairingLink(value: string, host: string | null, port: number, expectedFingerprint: string): void {
  let url: URL
  try { url = new URL(value) } catch { throw invalidResponse() }
  if (
    url.protocol !== 'agentsdock:'
    || url.hostname !== 'secure-peer'
    || url.pathname !== '/join'
    || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some(key => !['host', 'port', 'fingerprint'].includes(key))
    || url.searchParams.size !== 3
    || !host
    || url.searchParams.get('host') !== host
    || Number(url.searchParams.get('port')) !== port
    || url.searchParams.get('fingerprint') !== expectedFingerprint
    || value !== `agentsdock://secure-peer/join?host=${host}&port=${port}&fingerprint=${encodeURIComponent(expectedFingerprint)}`
  ) throw invalidResponse()
}

function optionalScopes(value: unknown): SecurePeerScope[] {
  const array = boundedArray(value, 4)
  return array.length ? normalizeSecurePeerScopes(array) : []
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse()
  return value as Record<string, unknown>
}

function boundedArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalidResponse()
  return value
}

function string(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Secure peer ${label} is invalid.`)
  }
  return value
}

function nullableString(value: unknown, label: string, max: number): string | null {
  return value == null ? null : string(value, label, max)
}

function identifier(value: unknown, label: string): string {
  return string(value, label, 240)
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value == null ? null : identifier(value, label)
}

function uuid(value: unknown, label: string): string {
  const clean = string(value, label, 64)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clean)) throw invalidResponse()
  return clean
}

function nullableUUID(value: unknown, label: string): string | null {
  return value == null ? null : uuid(value, label)
}

function hash(value: unknown, label: string): string {
  const clean = string(value, label, 80)
  if (!/^[0-9a-f]{64}$/.test(clean)) throw invalidResponse()
  return clean
}

function fingerprint(value: unknown): string {
  const clean = string(value, 'fingerprint', 80)
  if (!/^sha256:[0-9a-f]{64}$/.test(clean)) throw invalidResponse()
  return clean
}

function nullableTimestamp(value: unknown): string | null {
  if (value == null) return null
  const clean = string(value, 'timestamp', 64)
  if (!Number.isFinite(Date.parse(clean))) throw invalidResponse()
  return clean
}

function positiveInteger(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw invalidResponse()
  return Number(value)
}

function nullableErrorCode(value: unknown): string | null {
  if (value == null) return null
  const clean = string(value, 'host error code', 64)
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(clean)) throw invalidResponse()
  return clean
}

function legacyTrustState(status: SecurePeerPairing['status']): SecurePeerPairing['trustState'] {
  switch (status) {
    case 'requesting':
    case 'pending_approval': return 'pending'
    case 'approved':
    case 'connected': return 'approved'
    case 'revoked': return 'revoked'
    case 'rejected': return 'rejected'
    case 'expired': return 'expired'
    default: return 'error'
  }
}

function legacyTransportState(status: SecurePeerPairing['status']): SecurePeerPairing['transportState'] {
  if (status === 'connected') return 'online'
  if (status === 'revoked') return 'revoked'
  return 'disconnected'
}

function legacyStatusMatchesTrust(
  status: SecurePeerPairing['status'],
  trustState: SecurePeerPairing['trustState']
): boolean {
  switch (trustState) {
    case 'pending': return status === 'requesting' || status === 'pending_approval'
    case 'approved': return status === 'approved' || status === 'connected'
    case 'revoked': return status === 'revoked'
    case 'rejected':
    case 'cancelled': return status === 'rejected'
    case 'expired': return status === 'expired'
    case 'error': return status === 'error'
  }
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`Secure peer ${label} is invalid.`)
  return value as T[number]
}

function invalidResponse(): Error {
  return new Error('AgentsServer returned an invalid secure peer response.')
}
