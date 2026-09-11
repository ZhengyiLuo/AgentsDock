import { describe, expect, it } from 'vitest'
import type { SecurePeerPairing } from '@shared/secure-peer'
import { reconcileSecurePeerPairings } from './secure-peer-lifecycle'

function pairing(overrides: Partial<SecurePeerPairing> = {}): SecurePeerPairing {
  return {
    id: '09d7bb2e-3b47-4be7-89fc-2cecd90f4434',
    direction: 'outgoing',
    status: 'approved',
    trustState: 'approved',
    transportState: 'disconnected',
    peerServerIdentity: 'server-host',
    peerDisplayName: 'TargetApp',
    remoteEndpoint: '100.64.0.1:7851',
    hostServerIdentity: 'server-host',
    hostCaFingerprint: `sha256:${'a'.repeat(64)}`,
    peerPublicKeyFingerprint: `sha256:${'b'.repeat(64)}`,
    transcriptHash: 'c'.repeat(64),
    sasWords: ['amber', 'birch', 'cobalt', 'delta', 'ember', 'forest'],
    requestedScopes: ['teamspace.read', 'teamspace.write'],
    grantedScopes: ['teamspace.read', 'teamspace.write'],
    teamId: 'team-1',
    teamDisplayName: 'Team',
    hubIdentity: 'hub-1',
    connectionId: '22e7bb2e-3b47-4be7-89fc-2cecd90f4434',
    localProxyBasePath: null,
    certificateExpiresAt: '2027-01-01T00:00:00Z',
    certificateFingerprint: `sha256:${'d'.repeat(64)}`,
    lastSeenAt: null,
    expiresAt: null,
    error: null,
    ...overrides
  }
}

describe('reconcileSecurePeerPairings', () => {
  it('presents one logical card and prefers the exact active connection', () => {
    const activeConnectionId = '32e7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const newestInactive = pairing({ id: '19d7bb2e-3b47-4be7-89fc-2cecd90f4434' })
    const active = pairing({
      id: '29d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      status: 'connected',
      transportState: 'online',
      connectionId: activeConnectionId,
      localProxyBasePath: `/api/team-hub-secure/${activeConnectionId}`
    })

    expect(reconcileSecurePeerPairings([newestInactive, active], activeConnectionId)).toEqual([active])
  })

  it('suppresses a revoked certificate when an approved replacement exists', () => {
    const revoked = pairing({
      id: '39d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      status: 'revoked', trustState: 'revoked', transportState: 'revoked'
    })
    const replacement = pairing({
      id: '49d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      certificateExpiresAt: '2028-01-01T00:00:00Z'
    })

    expect(reconcileSecurePeerPairings([revoked, replacement], null)).toEqual([replacement])
    expect(reconcileSecurePeerPairings([revoked], null)).toEqual([revoked])
  })

  it('retains the revoked tombstone when an older approved certificate is ambiguous', () => {
    const oldApproved = pairing({ certificateExpiresAt: '2027-01-01T00:00:00Z' })
    const revoked = pairing({
      id: '69d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      status: 'revoked', trustState: 'revoked', transportState: 'revoked',
      certificateExpiresAt: '2028-01-01T00:00:00Z'
    })

    expect(reconcileSecurePeerPairings([oldApproved, revoked], null)).toEqual([revoked])
  })

  it('keeps a new pending attempt actionable beside a stale approved certificate', () => {
    const pending = pairing({
      id: '79d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      status: 'pending_approval',
      trustState: 'pending',
      teamId: null,
      certificateExpiresAt: null,
      certificateFingerprint: null,
      expiresAt: '2026-09-01T00:00:00Z'
    })
    const staleApproved = pairing({
      id: '89d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      teamId: 'team-1',
      certificateExpiresAt: '2028-01-01T00:00:00Z'
    })

    expect(reconcileSecurePeerPairings([pending, staleApproved], null)).toEqual([pending])
  })

  it('does not collapse different remote incoming servers on the same host and team', () => {
    const first = pairing({ direction: 'incoming', peerServerIdentity: 'server-studio' })
    const second = pairing({
      id: '59d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      direction: 'incoming',
      peerServerIdentity: 'server-mba'
    })

    expect(reconcileSecurePeerPairings([first, second], null)).toEqual([first, second])
  })
})
