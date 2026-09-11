import type { SecurePeerPairing } from '@shared/secure-peer'

/**
 * The control plane exposes certificate attempts, while the product presents
 * logical server connections. The server orders pairings newest-first; retain
 * that order within each logical connection while preferring its exact active
 * transport and then durable approved trust.
 */
export function reconcileSecurePeerPairings(
  pairings: readonly SecurePeerPairing[],
  activeConnectionId: string | null
): SecurePeerPairing[] {
  const groups = new Map<string, SecurePeerPairing[]>()
  const order: string[] = []

  for (const pairing of pairings) {
    const key = securePeerLogicalConnectionKey(pairing)
    const existing = groups.get(key)
    if (existing) existing.push(pairing)
    else {
      groups.set(key, [pairing])
      order.push(key)
    }
  }

  return order.map(key => {
    const candidates = groups.get(key)!
    const active = activeConnectionId
      ? candidates.find(pairing => (
        pairing.connectionId === activeConnectionId
        && pairing.trustState === 'approved'
        && pairing.transportState !== 'revoked'
      ))
      : undefined
    if (active) return active

    // A pending request is a newer attempt for the same server/hub. Keep that
    // actionable request visible instead of letting an older approved
    // certificate hide its Cancel/Approve controls.
    const pending = candidates.find(pairing => pairing.trustState === 'pending')
    if (pending) return pending

    const approved = newestLifecycleCandidate(candidates, 'approved')
    const revoked = newestLifecycleCandidate(candidates, 'revoked')
    if (approved && revoked) {
      // The status wire places actionable records before terminal records, so
      // array order alone cannot tell whether approval replaced revocation or
      // revocation superseded an old certificate. Certificate/heartbeat dates
      // disambiguate; on a tie, retain the revoked tombstone fail-closed.
      return pairingFreshness(approved) > pairingFreshness(revoked) ? approved : revoked
    }
    return approved ?? revoked ?? candidates[0]
  })
}

function newestLifecycleCandidate(
  candidates: readonly SecurePeerPairing[],
  trustState: 'approved' | 'revoked'
): SecurePeerPairing | undefined {
  return candidates
    .filter(pairing => pairing.trustState === trustState)
    .reduce<SecurePeerPairing | undefined>((newest, pairing) => (
      !newest || pairingFreshness(pairing) > pairingFreshness(newest) ? pairing : newest
    ), undefined)
}

function pairingFreshness(pairing: SecurePeerPairing): number {
  return Math.max(
    timestamp(pairing.lastSeenAt),
    timestamp(pairing.certificateExpiresAt),
    timestamp(pairing.expiresAt)
  )
}

function timestamp(value: string | null): number {
  const parsed = value ? Date.parse(value) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

export function securePeerLogicalConnectionKey(pairing: SecurePeerPairing): string {
  const remoteServerIdentity = pairing.direction === 'incoming'
    ? pairing.peerServerIdentity
    : pairing.hostServerIdentity
  return JSON.stringify([
    pairing.direction,
    remoteServerIdentity,
    pairing.hubIdentity ?? ''
  ])
}

export function canForgetSecurePeerPairing(pairing: SecurePeerPairing): boolean {
  return Boolean(pairing.connectionId && pairing.hubIdentity && pairing.certificateFingerprint)
}
