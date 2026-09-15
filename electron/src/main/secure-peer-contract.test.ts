import { describe, expect, it } from 'vitest'
import { automaticPairingCompletionAvailable, parseSecurePeerControlStatus, parseSecurePeerPairing } from './secure-peer-contract'

const scope = { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-local' }
const pairingId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
const connectionId = '22e7bb2e-3b47-4be7-89fc-2cecd90f4434'
const routeId = '42e7bb2e-3b47-4be7-89fc-2cecd90f4434'
const fpA = `sha256:${'a'.repeat(64)}`
const fpB = `sha256:${'b'.repeat(64)}`

function host(overrides: Record<string, unknown> = {}) {
  return {
    available: false,
    enabled: false,
    listen_port: 7851,
    advertised_host: null,
    advertised_hosts: [],
    ca_fingerprint: null,
    pairing_link: null,
    certificate_expires_at: null,
    error: 'No designated Hub is attached.',
    error_code: null,
    action: 'Attach this AgentsServer to a designated Hub.',
    ...overrides
  }
}

function pairing(overrides: Record<string, unknown> = {}) {
  return {
    id: pairingId,
    direction: 'outgoing',
    status: 'pending_approval',
    trust_state: 'pending',
    transport_state: 'disconnected',
    peer_server_identity: 'server-remote',
    peer_display_name: 'Remote server',
    remote_endpoint: '100.64.0.1:7851',
    host_server_identity: 'server-remote',
    host_ca_fingerprint: fpA,
    peer_public_key_fingerprint: fpB,
    transcript_hash: 'c'.repeat(64),
    sas_words: ['amber', 'birch', 'cobalt', 'delta', 'ember', 'forest'],
    requested_scopes: ['teamspace.read', 'cross_chat.instruction'],
    granted_scopes: [],
    team_id: null,
    team_display_name: null,
    hub_id: null,
    connection_id: null,
    local_proxy_base_path: null,
    certificate_expires_at: null,
    certificate_fingerprint: null,
    last_seen_at: null,
    expires_at: '2026-08-24T00:00:00Z',
    error: null,
    ...overrides
  }
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    heartbeat_interval_seconds: 30,
    lease_seconds: 90,
    server_identity: 'server-local',
    server_instance_id: 'instance-local',
    active_connection_id: null,
    host: host(),
    pairings: [],
    remote_routes: [],
    published_routes: [],
    ...overrides
  }
}

describe('secure peer control contract', () => {
  it('preserves null expiry for durable pending requests without changing lifecycle or consent', () => {
    const durable = pairing({ expires_at: null, complete_on_approval: true })
    const parsed = parseSecurePeerControlStatus(status({ pairings: [durable] }), scope)
    expect(parsed.pairings[0]).toMatchObject({ id: pairingId, status: 'pending_approval', trustState: 'pending',
      transportState: 'disconnected', completeOnApproval: true, expiresAt: null })
    expect(parsed.activeConnectionId).toBeNull()
    expect(parsed.pairingCompletion).toBeUndefined()
    expect(parseSecurePeerPairing(pairing()).expiresAt).toBe('2026-08-24T00:00:00Z')
  })

  it('requires the exact separate automatic-completion contract, not status v2 or listener availability', () => {
    const capability = { available: true, version: 1, completion_path: '/api/admin/secure-peers/v1/pairings/{pairing_id}/completion', max_wait_seconds: 600 }
    expect(automaticPairingCompletionAvailable(capability)).toBe(true)
    for (const value of [undefined, true, { version: 2 }, { ...capability, available: false }, { ...capability, completion_path: 'https://other.invalid/completion' }, { ...capability, max_wait_seconds: 601 }]) {
      expect(automaticPairingCompletionAvailable(value)).toBe(false)
    }
    expect(parseSecurePeerPairing(pairing()).completeOnApproval).toBeUndefined()
    expect(parseSecurePeerPairing(pairing({ complete_on_approval: true })).completeOnApproval).toBe(true)
    expect(() => parseSecurePeerPairing(pairing({ complete_on_approval: 'true' }))).toThrow()
  })
  it('keeps an unavailable/client-only host explicit without inventing a CA identity', () => {
    const parsed = parseSecurePeerControlStatus(status(), scope)
    expect(parsed.host).toEqual({
      available: false,
      enabled: false,
      listenPort: 7851,
      advertisedHost: null,
      advertisedHosts: [],
      caFingerprint: null,
      pairingLink: null,
      certificateExpiresAt: null,
      error: 'No designated Hub is attached.',
      errorCode: null,
      action: 'Attach this AgentsServer to a designated Hub.'
    })
    expect(parsed.connectionError).toBeNull()
    expect(parseSecurePeerControlStatus(status({ connection_error: 'Certificate renewal failed.' }), scope).connectionError).toBe('Certificate renewal failed.')
    expect(() => parseSecurePeerControlStatus(status({ host: host({
      certificate_expires_at: '2027-01-01T00:00:00Z'
    }) }), scope)).toThrow(/invalid secure peer response/i)
  })

  it('accepts only a canonical enabled-host pairing link that binds address, port, and CA fingerprint', () => {
    const link = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=${encodeURIComponent(fpA)}`
    expect(parseSecurePeerControlStatus(status({ host: host({
      available: true,
      enabled: true,
      advertised_host: '100.64.0.1',
      advertised_hosts: ['100.64.0.1'],
      ca_fingerprint: fpA,
      pairing_link: link,
      error: null,
      action: null
    }) }), scope).host.pairingLink).toBe(link)

    expect(() => parseSecurePeerControlStatus(status({ host: host({
      available: true,
      enabled: true,
      advertised_host: '100.64.0.1',
      advertised_hosts: ['100.64.0.1'],
      ca_fingerprint: fpA,
      pairing_link: link.replace('100.64.0.1', '10.0.0.2'),
      error: null,
      action: null
    }) }), scope)).toThrow(/invalid secure peer response/i)
  })

  it('requires connected pairings to carry one exact UUID-bound local proxy path', () => {
    expect(parseSecurePeerPairing(pairing({
      status: 'connected',
      trust_state: 'approved',
      transport_state: 'online',
      connection_id: connectionId,
      local_proxy_base_path: `/api/team-hub-secure/${connectionId}`,
      hub_id: 'hub-remote',
      granted_scopes: ['teamspace.read']
    }))).toMatchObject({ connectionId, localProxyBasePath: `/api/team-hub-secure/${connectionId}` })
    expect(() => parseSecurePeerPairing(pairing({
      status: 'connected',
      trust_state: 'approved',
      transport_state: 'online',
      connection_id: connectionId,
      local_proxy_base_path: '/api/team-hub-secure/42e7bb2e-3b47-4be7-89fc-2cecd90f4434',
      hub_id: 'hub-remote'
    }))).toThrow(/invalid secure peer response/i)
  })

  it('separates durable trust from transport liveness and parses host recovery guidance', () => {
    const parsed = parseSecurePeerControlStatus(status({
      host: host({
        error: 'An existing secure peer connection could not be reconciled safely.',
        error_code: 'peer_identity_conflict',
        action: 'Review or remove the conflicting logical server connection, then retry host recovery.'
      }),
      pairings: [pairing({
        status: 'connected',
        trust_state: 'approved',
        transport_state: 'reconnecting',
        connection_id: connectionId,
        local_proxy_base_path: `/api/team-hub-secure/${connectionId}`,
        hub_id: 'hub-remote'
      })]
    }), scope)

    expect(parsed).toMatchObject({ version: 2, heartbeatIntervalSeconds: 30, leaseSeconds: 90 })
    expect(parsed.host.errorCode).toBe('peer_identity_conflict')
    expect(parsed.pairings[0]).toMatchObject({ trustState: 'approved', transportState: 'reconnecting' })
    expect(parseSecurePeerControlStatus(status({
      version: 1,
      heartbeat_interval_seconds: undefined,
      lease_seconds: undefined,
      host: host({ error_code: undefined }),
      pairings: [pairing({ trust_state: undefined, transport_state: undefined })]
    }), scope)).toMatchObject({
      version: 1,
      heartbeatIntervalSeconds: 30,
      leaseSeconds: 90,
      pairings: [{ trustState: 'pending', transportState: 'disconnected' }]
    })
    expect(() => parseSecurePeerControlStatus(status({ heartbeat_interval_seconds: undefined }), scope)).toThrow(/invalid secure peer response/i)
    expect(() => parseSecurePeerControlStatus(status({ lease_seconds: 20 }), scope)).toThrow(/invalid secure peer response/i)
    expect(() => parseSecurePeerControlStatus(status({ host: host({ error_code: 'Peer Identity Conflict' }) }), scope)).toThrow()
    expect(() => parseSecurePeerPairing(pairing({ trust_state: 'revoked', transport_state: 'online' }))).toThrow()
    expect(() => parseSecurePeerPairing(pairing({ trust_state: 'trusted' }))).toThrow()
    expect(() => parseSecurePeerPairing(pairing({ transport_state: 'connected' }))).toThrow()
    expect(() => parseSecurePeerPairing(pairing({ status: 'revoked', trust_state: 'approved', transport_state: 'disconnected' }))).toThrow()
  })

  it('rejects non-UUID public IDs and non-opaque route revisions', () => {
    expect(() => parseSecurePeerPairing(pairing({ id: 'pair_123' }))).toThrow(/invalid secure peer response/i)
    expect(() => parseSecurePeerPairing(pairing({ id: pairingId.toUpperCase() }))).toThrow(/invalid secure peer response/i)
    expect(() => parseSecurePeerPairing(pairing({ transcript_hash: 'C'.repeat(64) }))).toThrow(/invalid secure peer response/i)
    expect(() => parseSecurePeerPairing(pairing({ host_ca_fingerprint: `sha256:${'A'.repeat(64)}` }))).toThrow(/invalid secure peer response/i)
    expect(() => parseSecurePeerControlStatus(status({
      remote_routes: [{
        peer_server_identity: 'server-remote', peer_display_name: 'Remote server',
        connection_id: connectionId, route_id: routeId, revision: 2,
        alias: 'training', display_title: 'Training', actions: ['instruction']
      }]
    }), scope)).toThrow()
  })

  it('accepts only the frozen lowercase route alias grammar', () => {
    const route = {
      peer_server_identity: 'server-remote', peer_display_name: 'Remote server',
      connection_id: connectionId, route_id: routeId, revision: `rev_${'a'.repeat(32)}`,
      alias: 'training_agent-2', display_title: 'Training', actions: ['instruction']
    }
    expect(parseSecurePeerControlStatus(status({ remote_routes: [route] }), scope).remoteRoutes[0].alias).toBe('training_agent-2')
    expect(parseSecurePeerControlStatus(status({
      published_routes: [{ ...route, chat_id: 'chat-training', status: 'publishing' }]
    }), scope).publishedRoutes[0].status).toBe('publishing')
    expect(() => parseSecurePeerControlStatus(status({ remote_routes: [{ ...route, alias: 'training.agent' }] }), scope)).toThrow()
    expect(() => parseSecurePeerControlStatus(status({ remote_routes: [{ ...route, alias: `a${'b'.repeat(32)}` }] }), scope)).toThrow()
    expect(() => parseSecurePeerControlStatus(status({ remote_routes: [{ ...route, alias: '2training' }] }), scope)).toThrow()
    expect(() => parseSecurePeerControlStatus(status({ remote_routes: [{ ...route, alias: 'Training' }] }), scope)).toThrow()
  })

  it('rejects response scope escalation, duplication, and profile identity substitution', () => {
    expect(() => parseSecurePeerPairing(pairing({ requested_scopes: ['teamspace.read', 'admin'] }))).toThrow()
    expect(() => parseSecurePeerPairing(pairing({ requested_scopes: ['teamspace.read', 'teamspace.read'] }))).toThrow()
    expect(() => parseSecurePeerControlStatus(status({ server_identity: 'server-attacker' }), scope)).toThrow(/different AgentsServer identity/i)
    expect(() => parseSecurePeerControlStatus(status(), scope, 'different-instance')).toThrow(/different AgentsServer instance/i)
  })
})
