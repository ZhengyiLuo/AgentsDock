export const SECURE_PEER_DEFAULT_PORT = 7851
export const SECURE_PEER_DEFAULT_HEARTBEAT_SECONDS = 30
export const SECURE_PEER_DEFAULT_LEASE_SECONDS = 90

export type SecurePeerScope =
  | 'teamspace.read'
  | 'teamspace.write'
  | 'cross_chat.instruction'
  | 'cross_chat.request_reply'

export const SECURE_PEER_SCOPES: readonly SecurePeerScope[] = [
  'teamspace.read',
  'teamspace.write',
  'cross_chat.instruction',
  'cross_chat.request_reply'
]

export type SecurePeerPairingState =
  | 'requesting'
  | 'pending_approval'
  | 'approved'
  | 'connected'
  | 'rejected'
  | 'revoked'
  | 'expired'
  | 'error'

export type SecurePeerTrustState =
  | 'pending'
  | 'approved'
  | 'revoked'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'error'

export type SecurePeerTransportState =
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'disconnected'
  | 'revoked'

export interface SecurePeerProfileScope {
  profileId: string
  profileGeneration: number
  serverIdentity: string
}

export interface SecurePeerHostStatus {
  available: boolean
  enabled: boolean
  listenPort: number
  advertisedHost: string | null
  advertisedHosts: string[]
  caFingerprint: string | null
  pairingLink: string | null
  certificateExpiresAt: string | null
  error: string | null
  errorCode: string | null
  action: string | null
}

export interface SecurePeerPairing {
  id: string
  /** Explicit new Join consent accepted by the guest server, never inferred from approval. */
  completeOnApproval?: boolean
  direction: 'incoming' | 'outgoing'
  status: SecurePeerPairingState
  /** Durable authorization. This must not be inferred from transport presence. */
  trustState: SecurePeerTrustState
  /** Current liveness. Only `online` may be presented as connected. */
  transportState: SecurePeerTransportState
  peerServerIdentity: string
  peerDisplayName: string
  remoteEndpoint: string
  hostServerIdentity: string
  hostCaFingerprint: string
  peerPublicKeyFingerprint: string
  transcriptHash: string
  sasWords: [string, string, string, string, string, string]
  requestedScopes: SecurePeerScope[]
  grantedScopes: SecurePeerScope[]
  teamId: string | null
  teamDisplayName: string | null
  hubIdentity: string | null
  connectionId: string | null
  localProxyBasePath: string | null
  certificateExpiresAt: string | null
  certificateFingerprint: string | null
  lastSeenAt: string | null
  /** Null for a negotiated durable request; observation timeouts do not expire it. */
  expiresAt: string | null
  error: string | null
}

export interface SecurePeerControlStatus {
  version: 1 | 2
  automaticPairingCompletionAvailable?: boolean
  /** Exact member-side endpoint migration contract advertised by authenticated health. */
  endpointUpdateAvailable?: boolean
  /** Terminal observer receipt; ends auto-Join consent, not the retained peer trust. */
  pairingCompletion?: { pairingId: string; transcriptHash: string; state: 'cancelled' | 'expired' }
  heartbeatIntervalSeconds: number
  leaseSeconds: number
  profileId: string
  profileGeneration: number
  serverIdentity: string
  serverInstanceId: string
  activeConnectionId: string | null
  /** Fail-closed until both remote handoff admission and revision CAS commit are implemented. */
  remoteRouteDeliveryAvailable: boolean
  connectionError: string | null
  host: SecurePeerHostStatus
  pairings: SecurePeerPairing[]
  remoteRoutes: SecurePeerRemoteRoute[]
  publishedRoutes: SecurePeerPublishedRoute[]
}

export interface SecurePeerRemoteRoute {
  peerServerIdentity: string
  peerDisplayName: string
  connectionId: string
  routeId: string
  revision: string
  alias: string
  displayTitle: string
  actions: Array<'instruction' | 'request_reply'>
}

export interface SecurePeerPublishedRoute extends SecurePeerRemoteRoute {
  chatId: string
  status: 'publishing' | 'active' | 'revoked'
}

export interface SecurePeerPublishRouteInput {
  connectionId: string
  chatId: string
  alias: string
  displayTitle: string
  actions: Array<'instruction' | 'request_reply'>
}

export interface SecurePeerRevokeRouteInput {
  routeId: string
  expectedConnectionId: string
  expectedRevision: string
}

export interface SecurePeerConfigureHostInput {
  enabled: boolean
  advertisedHost?: string
  listenPort?: number
}

export interface SecurePeerJoinInput {
  host: string
  displayName: string
  requestedScopes: SecurePeerScope[]
  completeOnApproval?: true
  /** Main-only explicit Join consent; never sent to AgentsServer. */
  confirmLocalBindingReplacement?: true
}

export interface SecurePeerCompletionWaitInput {
  pairingId: string
  expectedTranscriptHash: string
  /** Observer identity only; cancelling it does not cancel the durable Join. */
  requestId: string
}

export interface SecurePeerActivateInput {
  pairingId: string
  expectedConnectionId: string
  expectedHostServerIdentity: string
  expectedHubIdentity: string
  /** Main-process-only consent; stripped before the AgentsServer request. */
  confirmLocalBindingReplacement?: true
}

export interface SecurePeerDeactivateInput {
  connectionId: string
  expectedHostServerIdentity: string
  expectedHubIdentity: string
}

export interface SecurePeerForgetConnectionInput extends SecurePeerDeactivateInput {
  expectedCertificateFingerprint: string
}

export interface SecurePeerUpdateEndpointInput extends SecurePeerDeactivateInput {
  expectedServerInstanceId: string
  expectedRemoteEndpoint: string
  /** Explicit replacement literal IPv4 address, optionally followed by :port. */
  host: string
  confirmed: true
}

export interface SecurePeerApproveInput {
  pairingId: string
  teamId: string
  expectedPeerServerIdentity: string
  expectedTranscriptHash: string
  scopes: SecurePeerScope[]
  sasConfirmed: true
}

export interface SecurePeerRejectInput {
  pairingId: string
  expectedPeerServerIdentity: string
  expectedTranscriptHash: string
  reason?: string
}

export interface SecurePeerRevokeInput {
  peerId: string
  idempotencyKey: string
  expectedCertificateFingerprint: string
}

/** Parse a user-entered literal IPv4 endpoint without ever turning it into a renderer fetch target. */
export function normalizeSecurePeerEndpoint(value: string): { host: string; port: number; endpoint: string } {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 64 || /[\s/@?#\\]/.test(value)) {
    throw new Error('Enter a literal IPv4 address, optionally followed by :port.')
  }
  const pieces = value.split(':')
  if (pieces.length > 2) throw new Error('Enter a literal IPv4 address, optionally followed by :port.')
  const host = normalizeSecurePeerIPv4(pieces[0])
  if (pieces.length === 2 && !/^[1-9][0-9]{3,4}$/.test(pieces[1])) {
    throw new Error('Enter a canonical secure pairing port from 1024 through 65535.')
  }
  const port = pieces.length === 2 ? normalizeSecurePeerPort(Number(pieces[1])) : SECURE_PEER_DEFAULT_PORT
  return { host, port, endpoint: `${host}:${port}` }
}

export function normalizeSecurePeerJoinTarget(value: string): {
  host: string
  port: number
  endpoint: string
  expectedCaFingerprint: string | null
} {
  if (!value.startsWith('agentsdock:')) return { ...normalizeSecurePeerEndpoint(value), expectedCaFingerprint: null }
  if (value.length > 512 || value.trim() !== value) throw new Error('The secure pairing link is invalid.')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('The secure pairing link is invalid.') }
  const allowed = ['host', 'port', 'fingerprint']
  if (
    url.protocol !== 'agentsdock:' || url.hostname !== 'secure-peer' || url.pathname !== '/join'
    || url.username || url.password || url.hash || url.searchParams.size !== 3
    || [...url.searchParams.keys()].some(key => !allowed.includes(key))
    || allowed.some(key => url.searchParams.getAll(key).length !== 1)
  ) throw new Error('The secure pairing link is invalid.')
  const host = normalizeSecurePeerIPv4(url.searchParams.get('host'))
  const port = normalizeSecurePeerPort(Number(url.searchParams.get('port')))
  const expectedCaFingerprint = String(url.searchParams.get('fingerprint') ?? '').toLowerCase()
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedCaFingerprint)) throw new Error('The secure pairing link fingerprint is invalid.')
  const canonical = `agentsdock://secure-peer/join?host=${host}&port=${port}&fingerprint=${encodeURIComponent(expectedCaFingerprint)}`
  if (value !== canonical) throw new Error('The secure pairing link is not canonical.')
  return { host, port, endpoint: `${host}:${port}`, expectedCaFingerprint }
}

export function normalizeSecurePeerIPv4(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value) throw new Error('Enter a canonical non-loopback IPv4 address.')
  const parts = value.split('.')
  if (
    parts.length !== 4
    || !parts.every(part => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)
  ) throw new Error('Enter a canonical non-loopback IPv4 address.')
  const first = Number(parts[0])
  if (
    first === 0 || first === 127 || first >= 224
    || first === 169 && Number(parts[1]) === 254
  ) throw new Error('Enter a canonical non-loopback IPv4 address.')
  return value
}

export function normalizeSecurePeerPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1_024 || Number(value) > 65_535) {
    throw new Error('Enter a valid secure pairing port.')
  }
  return Number(value)
}

export function normalizeSecurePeerScopes(value: unknown): SecurePeerScope[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SECURE_PEER_SCOPES.length) {
    throw new Error('Select at least one secure peer permission.')
  }
  const scopes = value.map(item => {
    if (!SECURE_PEER_SCOPES.includes(item as SecurePeerScope)) throw new Error('A secure peer permission is invalid.')
    return item as SecurePeerScope
  })
  if (new Set(scopes).size !== scopes.length) throw new Error('Secure peer permissions must be unique.')
  return scopes
}

export function securePeerProfileScope(value: SecurePeerProfileScope): SecurePeerProfileScope {
  const profileId = boundedIdentifier(value?.profileId, 'AgentsServer profile')
  if (!Number.isSafeInteger(value?.profileGeneration) || value.profileGeneration < 1) {
    throw new Error('The AgentsServer profile generation is invalid.')
  }
  return {
    profileId,
    profileGeneration: value.profileGeneration,
    serverIdentity: boundedIdentifier(value.serverIdentity, 'AgentsServer identity')
  }
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}
