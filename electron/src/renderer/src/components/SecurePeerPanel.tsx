import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { CircleAlert, Copy, KeyRound, Link2, LoaderCircle, RefreshCw, Server, ShieldCheck, WifiOff } from 'lucide-react'
import type { TeamHubStatus, TeamHubTeamDetails, TeamHubWorkspace } from '@shared/team-hub'
import type {
  SecurePeerControlStatus,
  SecurePeerPairing,
  SecurePeerProfileScope,
  SecurePeerScope
} from '@shared/secure-peer'
import { normalizeSecurePeerJoinTarget } from '@shared/secure-peer'
import { t, useLocale } from '../lib/i18n'
import { canForgetSecurePeerPairing, reconcileSecurePeerPairings } from '../lib/secure-peer-lifecycle'
import { SecurePeerHostAddressAction } from './SecurePeerHostAddress'

const V1_SCOPES: SecurePeerScope[] = ['teamspace.read', 'teamspace.write']
const CONSENT_PREFIX = 'agentsdock.secure-peer.connect-consent.v2:'
const LEGACY_CONSENT_PREFIX = 'agentsdock.secure-peer.connect-consent.v1:'
const AUTO_ADOPTION_SUPPRESSION_PREFIX = 'agentsdock.secure-peer.auto-adoption-suppression.v1:'
const AUTO_COMPLETION_ATTEMPT_LIMIT = 3

interface AutomaticCompletionAttempts {
  count: number
  markers: Set<string>
}

interface SecurePeerPanelProps {
  status: TeamHubStatus
  details?: TeamHubTeamDetails | null
  workspace?: TeamHubWorkspace | null
  networkError?: string | null
  initialInvite?: string | null
  initialInviteRequestId?: number
  onInitialInviteHandled?: (requestId: number) => void
  onConnectionChanged?: () => Promise<void> | void
  onActivated?: () => Promise<boolean> | boolean
  onRetryConnection?: () => Promise<boolean> | boolean
  connectionAttemptInFlight?: boolean
  onPendingCountChange?: (count: number) => void
}

/**
 * The server connection surface deliberately has only one path per server role.
 * Host servers share and approve; peer servers paste and connect.
 */
export function SecurePeerPanel({
  status,
  details,
  workspace,
  networkError,
  initialInvite,
  initialInviteRequestId,
  onInitialInviteHandled,
  onConnectionChanged,
  onActivated,
  onRetryConnection,
  connectionAttemptInFlight = false,
  onPendingCountChange
}: SecurePeerPanelProps) {
  useLocale()
  const scope = useMemo(() => profileScope(status), [status.profileGeneration, status.profileId, status.serverIdentity])
  const scopeKey = scope ? `${scope.profileId}\0${scope.profileGeneration}\0${scope.serverIdentity}` : ''
  const scopeIdentityKey = scope ? `${scope.profileId}\0${scope.serverIdentity}` : ''
  const epoch = useRef(0)
  const operation = useRef<string | null>(null)
  const statusInFlightEpoch = useRef<number | null>(null)
  const pairingCompletionWait = useRef<(() => void) | null>(null)
  const automaticCompletionAttempts = useRef(new Map<string, AutomaticCompletionAttempts>())
  const completedConnectionAdoptions = useRef(new Set<string>())
  const automaticAdoptionSuppressions = useRef(new Set<string>())
  const automaticCompletionIdentity = useRef(scopeIdentityKey)
  const appliedInviteRequest = useRef<number | null>(null)
  const [control, setControl] = useState<SecurePeerControlStatus | null>(null)
  const [managedPeers, setManagedPeers] = useState<SecurePeerPairing[]>([])
  const [invite, setInvite] = useState('')
  const [hostAddress, setHostAddress] = useState('')
  const [busy, setBusy] = useState<string | null>('status')
  const [error, setError] = useState<unknown>(null)
  const [approvalRefreshError, setApprovalRefreshError] = useState<unknown>(null)
  const [completionNotice, setCompletionNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmedSas, setConfirmedSas] = useState<Set<string>>(() => new Set())
  const [confirmForget, setConfirmForget] = useState<string | null>(null)
  const [confirmDisableHost, setConfirmDisableHost] = useState(false)
  const [completionObservation, setCompletionObservation] = useState(0)

  const humanCanManage = Boolean(details && ['owner', 'admin'].includes(details.membership.role))
  const serverCanManage = Boolean(
    status.authenticationMode === 'server'
    && status.serverManaged === true
    && status.designatedHost
    && status.principal?.kind === 'service'
    && details?.membership.principal_id === status.principal.id
    && details.membership.role === 'automation'
  )
  const canManage = humanCanManage || serverCanManage
  const visiblePairings = useMemo(() => reconcileSecurePeerPairings(
    control?.pairings ?? [], control?.activeConnectionId ?? null
  ), [control?.activeConnectionId, control?.pairings])
  const visibleManagedPeers = useMemo(() => reconcileSecurePeerPairings(managedPeers, null), [managedPeers])
  const pending = useMemo(() => visiblePairings.filter(pairing => (
    pairing.direction === 'incoming' && pairing.status === 'pending_approval'
  )), [visiblePairings])
  const expired = useMemo(() => visiblePairings.filter(pairing => (
    pairing.direction === 'incoming' && pairing.status === 'expired'
  )), [visiblePairings])
  const outgoing = useMemo(() => visiblePairings.filter(pairing => pairing.direction === 'outgoing'), [visiblePairings])
  const activePairing = outgoing.find(pairing => (
    Boolean(pairing.connectionId) && control?.activeConnectionId === pairing.connectionId
  )) ?? null
  // The secure transport and the Teamspace session are separate layers. An
  // online peer tunnel is not enough to enter Team Network: the parent still
  // has to adopt the paired-node session. Never show the terminal green state
  // while that second step is incomplete, otherwise the onboarding surface
  // has no truthful route forward.
  const connected = activePairing
    && status.authenticated
    && status.transport === 'secure_peer'
    && status.connectionId === activePairing.connectionId
    && status.hostServerIdentity === activePairing.hostServerIdentity
    && status.hubIdentity === activePairing.hubIdentity
    && activePairing.trustState === 'approved' && activePairing.transportState === 'online'
    && !activePairing.error && !control?.connectionError && !networkError
    ? activePairing
    : null

  useEffect(() => { onPendingCountChange?.(pending.length) }, [onPendingCountChange, pending.length])

  const run = useCallback(async <T,>(key: string, task: (requestEpoch: number) => Promise<T>): Promise<T | null> => {
    if (operation.current || connectionAttemptInFlight) return null
    operation.current = key
    // A control-plane mutation supersedes any status request that began before
    // the user action. Advancing the existing epoch also lets a later request
    // start without waiting for the stale request to settle.
    const requestEpoch = ++epoch.current
    setBusy(key)
    setError(null)
    try {
      return await task(requestEpoch)
    } catch (cause) {
      if (epoch.current === requestEpoch) setError(cause ?? new LocalizedPeerError('teamNetwork.peer.connectionFailed'))
      return null
    } finally {
      if (epoch.current === requestEpoch && operation.current === key) {
        operation.current = null
        setBusy(null)
      }
    }
  }, [connectionAttemptInFlight])

  const load = useCallback(async () => {
    if (!scope || operation.current) return
    const requestEpoch = epoch.current
    if (statusInFlightEpoch.current === requestEpoch) return
    statusInFlightEpoch.current = requestEpoch
    // Explicit refresh/retry may reopen a failed pending-only observer. There
    // is no timer and an unchanged render never retries a completion wait.
    setCompletionObservation(current => current + 1)
    setBusy('status')
    setError(null)
    try {
      const base = await window.agentsDock.teamHub.securePeerStatus(scope)
      if (epoch.current !== requestEpoch) return
      // Publish the authoritative base snapshot immediately. Pair refreshes
      // are useful enrichment, but a slow or failed refresh must not leave the
      // whole connection surface blank.
      setControl(current => sameSecurePeerControl(current, base) ? current : base)
      setHostAddress(current => current || base.host.advertisedHost || base.host.advertisedHosts[0] || '')
      let next = base
      if (!status.designatedHost) {
        const pendingPairings = base.pairings.filter(pairing => (
          pairing.direction === 'outgoing' && ['requesting', 'pending_approval'].includes(pairing.status)
          && !automaticallyCompletesPairing(base, pairing)
        ))
        const refreshes = await Promise.allSettled(pendingPairings.map(async pendingPairing => {
          const refreshed = await window.agentsDock.teamHub.refreshSecurePeerPairing(scope, pendingPairing.id)
          if (refreshed.id !== pendingPairing.id || refreshed.direction !== 'outgoing') {
            throw new LocalizedPeerError('teamNetwork.peer.mismatchedRequest')
          }
          return refreshed
        }))
        if (epoch.current !== requestEpoch) return
        const refreshedById = new Map<string, SecurePeerPairing>()
        let refreshError: unknown = null
        refreshes.forEach(result => {
          if (result.status === 'fulfilled') refreshedById.set(result.value.id, result.value)
          else refreshError ??= result.reason
        })
        if (refreshedById.size) {
          next = {
            ...next,
            pairings: next.pairings.map(pairing => refreshedById.get(pairing.id) ?? pairing)
          }
        }
        if (refreshError) setError(refreshError)
      }
      setControl(current => sameSecurePeerControl(current, next) ? current : next)
      if (status.designatedHost && workspace && details && canManage) {
        const peers = await window.agentsDock.teamHub.securePeers(teamScope(workspace.status), details.team.id)
        if (epoch.current !== requestEpoch) return
        setManagedPeers(current => sameSecurePeerPairings(current, peers) ? current : peers)
      }
    } catch (cause) {
      if (epoch.current === requestEpoch) setError(cause ?? new LocalizedPeerError('teamNetwork.peer.connectionFailed'))
    } finally {
      if (statusInFlightEpoch.current === requestEpoch) statusInFlightEpoch.current = null
      if (epoch.current === requestEpoch) setBusy(null)
    }
  }, [canManage, details?.team.id, scopeKey, status.designatedHost, workspace?.status.generation])

  useEffect(() => {
    epoch.current += 1
    operation.current = null
    statusInFlightEpoch.current = null
    // Runtime/profile generation advances are expected during activation and
    // failed reconnects. Keep the retry bound across those transitions; reset
    // it only when this surface changes to a genuinely different local server.
    if (automaticCompletionIdentity.current !== scopeIdentityKey) {
      automaticCompletionAttempts.current.clear()
      completedConnectionAdoptions.current.clear()
      automaticAdoptionSuppressions.current.clear()
      automaticCompletionIdentity.current = scopeIdentityKey
    }
    setControl(null)
    setManagedPeers([])
    appliedInviteRequest.current = null
    setInvite('')
    setHostAddress('')
    setCopied(false)
    setConfirmedSas(new Set())
    setConfirmForget(null)
    setConfirmDisableHost(false)
    setError(null)
    setApprovalRefreshError(null)
    setCompletionNotice(null)
    void load()
    return () => {
      pairingCompletionWait.current?.()
      epoch.current += 1
      operation.current = null
      statusInFlightEpoch.current = null
    }
  }, [load, scopeIdentityKey, scopeKey, status.designatedHost])

  useEffect(() => {
    if (
      status.designatedHost
      || !initialInvite
      || initialInviteRequestId === undefined
      || appliedInviteRequest.current === initialInviteRequestId
    ) return
    try {
      const target = normalizeSecurePeerJoinTarget(initialInvite)
      if (!target.expectedCaFingerprint) return
    } catch {
      return
    }
    appliedInviteRequest.current = initialInviteRequestId
    setInvite(initialInvite)
  }, [initialInvite, initialInviteRequestId, scopeKey, status.designatedHost])

  const automaticPendingPairings = outgoing.filter(pairing => (
    control && automaticallyCompletesPairing(control, pairing)
    && ['pending', 'approved'].includes(pairing.trustState)
    && ['requesting', 'pending_approval', 'approved'].includes(pairing.status)
    && control.activeConnectionId === null
  ))
  const automaticPendingKey = JSON.stringify(automaticPendingPairings.map(pairing => [
    pairing.id, pairing.hostServerIdentity, pairing.transcriptHash, pairing.peerPublicKeyFingerprint
  ]))

  useEffect(() => {
    if (!scope || status.designatedHost || control?.activeConnectionId) return
    if (control?.profileId !== scope.profileId || control.profileGeneration !== scope.profileGeneration
      || control.serverIdentity !== scope.serverIdentity) return
    const pairing = automaticPendingPairings.find(candidate => (
      hasConsent(scope, candidate)
      && !hasAutomaticAdoptionSuppression(automaticAdoptionSuppressions.current, scope, candidate)
    ))
    if (!pairing) return
    let active = true
    const requestId = crypto.randomUUID()
    const stop = () => {
      if (!active) return
      active = false
      if (pairingCompletionWait.current === stop) pairingCompletionWait.current = null
      // Dismissal only stops this observer. The server owns the already
      // consented request; canceling the request is a separate explicit action.
      void window.agentsDock.teamHub.stopSecurePeerPairingCompletionWait(scope, requestId).catch(() => undefined)
    }
    pairingCompletionWait.current = stop
    void window.agentsDock.teamHub.waitForSecurePeerPairingCompletion(scope, {
      pairingId: pairing.id,
      expectedTranscriptHash: pairing.transcriptHash,
      requestId
    }).then(next => {
      if (!active) return
      const completed = next.pairings.find(candidate => candidate.id === pairing.id)
      const terminal = completed && ['rejected', 'cancelled', 'expired'].includes(completed.trustState)
      const completionEnded = next.pairingCompletion
        && next.pairingCompletion.pairingId === pairing.id
        && next.pairingCompletion.transcriptHash === pairing.transcriptHash
        && ['cancelled', 'expired'].includes(next.pairingCompletion.state)
      if (next.profileId !== scope.profileId || next.profileGeneration !== scope.profileGeneration
        || next.serverIdentity !== scope.serverIdentity || !completed
        || completed.direction !== 'outgoing' || completed.hostServerIdentity !== pairing.hostServerIdentity
        || completed.transcriptHash !== pairing.transcriptHash
        || completed.peerPublicKeyFingerprint !== pairing.peerPublicKeyFingerprint
        || !terminal && !completionEnded && (completed.completeOnApproval !== true || completed.trustState !== 'approved'
          || !completed.connectionId || !completed.hubIdentity
          || next.activeConnectionId !== completed.connectionId)) {
        throw new LocalizedPeerError('teamNetwork.peer.mismatchedCompletion')
      }
      if (!hasConsent(scope, pairing)
        || hasAutomaticAdoptionSuppression(automaticAdoptionSuppressions.current, scope, pairing)) return
      // A manual status read may have captured pending state before this
      // authoritative receipt. Fence it before publishing completion so its
      // delayed response cannot restore an already-finished request.
      if (statusInFlightEpoch.current !== null && !operation.current) {
        epoch.current += 1
        statusInFlightEpoch.current = null
        setBusy(null)
      }
      if (terminal || completionEnded) {
        rememberAutomaticAdoptionSuppression(automaticAdoptionSuppressions.current, scope, pairing)
        forgetConsent(scope, pairing)
        automaticCompletionAttempts.current.delete(pairingConsentKey(scope, pairing))
        setCompletionNotice(completed.trustState === 'rejected'
          ? 'teamNetwork.peer.hostRejected'
          : completed.trustState === 'expired'
            ? 'teamNetwork.peer.requestExpired'
            : completed.trustState === 'cancelled'
              ? 'teamNetwork.peer.requestCancelled'
              : next.pairingCompletion?.state === 'expired'
                ? 'teamNetwork.peer.automaticExpired'
                : 'teamNetwork.peer.automaticStopped')
      }
      // Successful completion already activated this exact request; terminal
      // receipts instead retain their truthful trust state with consent off.
      setControl(next)
    }).catch(cause => {
      if (active) setError(new LocalizedPeerError('teamNetwork.peer.completionUnconfirmed', cause))
    })
    return stop
  }, [automaticPendingKey, completionObservation, control?.activeConnectionId, scopeKey, status.designatedHost])

  const completeApprovedConnection = useCallback(async (
    pairing: SecurePeerPairing,
    activatePairing: boolean,
    automaticConsentKey?: string
  ): Promise<boolean> => {
    if (!scope || !pairing.connectionId || !pairing.hubIdentity) return false
    const completed = await run(`${activatePairing ? 'activate' : 'finish'}:${pairing.id}`, async requestEpoch => {
      if (activatePairing) {
        const next = await window.agentsDock.teamHub.activateSecurePeerPairing(scope, {
          pairingId: pairing.id,
          expectedConnectionId: pairing.connectionId!,
          expectedHostServerIdentity: pairing.hostServerIdentity,
          expectedHubIdentity: pairing.hubIdentity!,
          confirmLocalBindingReplacement: true
        })
        if (epoch.current !== requestEpoch) throw new StaleSecurePeerResponse()
        setControl(next)
        if (automaticConsentKey) {
          const activatedPairing = next.pairings.find(item => item.id === pairing.id) ?? pairing
          markAutomaticCompletionState(automaticCompletionAttempts.current, automaticConsentKey, next, activatedPairing)
        }
      }
      // Activating the AgentsServer route and authenticating Team Hub are two
      // separate operations. Keep the explicit consent until the parent has
      // connected and adopted the authenticated workspace.
      return onActivated ? await onActivated() : false
    })
    if (completed !== true) return false
    completedConnectionAdoptions.current.add(pairingConsentKey(scope, pairing))
    clearAutomaticAdoptionSuppression(automaticAdoptionSuppressions.current, scope, pairing)
    forgetConsent(scope, pairing)
    automaticCompletionAttempts.current.delete(pairingConsentKey(scope, pairing))
    return true
  }, [onActivated, run, scopeKey])

  const activate = useCallback(async (pairing: SecurePeerPairing): Promise<boolean> => {
    if (!scope || connectionAttemptInFlight) return false
    const consentKey = pairingConsentKey(scope, pairing)
    // Reconnect is fresh, explicit user intent. Preserve it while the secure
    // route comes online so a later heartbeat can finish Team Hub adoption.
    clearAutomaticAdoptionSuppression(automaticAdoptionSuppressions.current, scope, pairing)
    automaticCompletionAttempts.current.delete(consentKey)
    completedConnectionAdoptions.current.delete(consentKey)
    rememberConsent(scope, pairing)
    return completeApprovedConnection(pairing, true, consentKey)
  }, [completeApprovedConnection, connectionAttemptInFlight, scope])

  useEffect(() => {
    if (
      status.designatedHost
      || !scope
      || !control
      || operation.current
      || connectionAttemptInFlight
    ) return
    // TeamNetwork fences this effect with its actual foreground/background
    // connect operation. Once that request settles, an already-selected live
    // peer remains authoritative even if the outer status object did not
    // change (for example, when the first adoption request lost its reply).
    const approved = outgoing.find(pairing => (
      pairing.trustState === 'approved' && ['approved', 'connected'].includes(pairing.status)
      && pairing.connectionId && pairing.hubIdentity
      // A route already selected by the local AgentsServer is safe to adopt
      // without replaying activation. This closes the startup race where the
      // outer Team Hub probe ran before the secure-peer service recovered.
      // An inactive route still needs explicit consent plus background
      // reconnect eligibility. An already-selected active route is stronger
      // lifecycle evidence unless an explicit Disconnect left the stable
      // per-pairing suppression checked below.
      && (
        status.backgroundReconnectAllowed === true && hasConsent(scope, pairing)
          && (!automaticallyCompletesPairing(control, pairing) || control.activeConnectionId === pairing.connectionId)
        || pairing.completeOnApproval === true
          && control.activeConnectionId === pairing.connectionId
          && hasConsent(scope, pairing)
        || !status.authenticated
          && control.activeConnectionId === pairing.connectionId
      )
      && !hasAutomaticAdoptionSuppression(automaticAdoptionSuppressions.current, scope, pairing)
    ))
    if (!approved) return
    const key = pairingConsentKey(scope, approved)
    if (completedConnectionAdoptions.current.has(key)) return
    const activatePairing = control.activeConnectionId === null
    if (!activatePairing && control.activeConnectionId !== approved.connectionId) return
    // Once the route is active, wait for an online heartbeat before retrying
    // Team Hub authentication. A single unchanged heartbeat state is attempted
    // once, and the total is capped so a broken peer can never spin forever.
    if (!activatePairing && approved.transportState !== 'online') return
    const marker = automaticCompletionMarker(control, approved, activatePairing)
    const attempts = automaticCompletionAttempts.current.get(key) ?? { count: 0, markers: new Set<string>() }
    if (attempts.count >= AUTO_COMPLETION_ATTEMPT_LIMIT || attempts.markers.has(marker)) return
    attempts.count += 1
    attempts.markers.add(marker)
    automaticCompletionAttempts.current.set(key, attempts)
    void completeApprovedConnection(approved, activatePairing, key)
  }, [completeApprovedConnection, connectionAttemptInFlight, control, networkError, outgoing, scopeKey, status.authenticated, status.backgroundReconnectAllowed, status.designatedHost])

  if (!scope) return <div className="teamspace-host-help"><strong>{t('teamNetwork.peer.identityUnavailable')}</strong></div>

  const copyServerInvite = async () => {
    if (!control) return
    await run('copy-invite', async requestEpoch => {
      let next = control
      if (next.host.error || next.host.errorCode) {
        const reason = next.host.action || next.host.error
        throw reason ? new Error(reason) : new LocalizedPeerError('teamNetwork.peer.resolveHostError')
      }
      if (!next.host.pairingLink) {
        const advertisedHost = hostAddress.trim() || next.host.advertisedHost || next.host.advertisedHosts[0]
        if (!advertisedHost) throw new LocalizedPeerError('teamNetwork.peer.addressRequired')
        next = await window.agentsDock.teamHub.configureSecurePeerHost(scope, {
          enabled: true,
          advertisedHost,
          listenPort: next.host.listenPort
        })
        if (epoch.current !== requestEpoch) throw new StaleSecurePeerResponse()
        setControl(next)
      }
      if (!next.host.pairingLink) throw new LocalizedPeerError('teamNetwork.peer.inviteNotReady')
      await window.agentsDock.native.writeClipboard(next.host.pairingLink)
      if (epoch.current !== requestEpoch) throw new StaleSecurePeerResponse()
      setCopied(true)
      return next
    })
  }

  const pasteInvite = async () => {
    setError(null)
    try { setInvite((await window.agentsDock.native.readClipboard()).trim()) }
    catch (cause) { setError(cause ?? new LocalizedPeerError('teamNetwork.peer.connectionFailed')) }
  }

  const connectThisServer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const target = invite.trim()
    if (!target) return
    setCompletionNotice(null)
    if (control?.activeConnectionId || status.designatedHost) {
      setError(new LocalizedPeerError('teamNetwork.peer.disconnectBeforeJoin'))
      return
    }
    const submittedInviteRequestId = target === initialInvite?.trim()
      ? initialInviteRequestId
      : undefined
    const pairing = await run('connect', requestEpoch => window.agentsDock.teamHub.requestSecurePeerPairing(scope, {
      host: target,
      displayName: status.serverName?.trim() || 'AgentsServer',
      requestedScopes: [...V1_SCOPES],
      ...(control?.automaticPairingCompletionAvailable === true ? {
        completeOnApproval: true,
        confirmLocalBindingReplacement: true
      } as const : {})
    }).then(value => {
      if (epoch.current !== requestEpoch) throw new StaleSecurePeerResponse()
      return value
    }))
    if (!pairing) return
    if (submittedInviteRequestId !== undefined) onInitialInviteHandled?.(submittedInviteRequestId)
    clearAutomaticAdoptionSuppression(automaticAdoptionSuppressions.current, scope, pairing)
    automaticCompletionAttempts.current.delete(pairingConsentKey(scope, pairing))
    rememberConsent(scope, pairing)
    setControl(current => current ? {
      ...current,
      pairings: [...current.pairings.filter(item => item.id !== pairing.id), pairing]
    } : current)
    setInvite('')
  }

  const cancel = async (pairing: SecurePeerPairing) => {
    if (operation.current || connectionAttemptInFlight) return
    pairingCompletionWait.current?.()
    // An approval may race the Cancel request. Revoke local adoption consent
    // first, even if cancellation later loses its response.
    rememberAutomaticAdoptionSuppression(automaticAdoptionSuppressions.current, scope, pairing)
    forgetConsent(scope, pairing)
    const next = await run(`cancel:${pairing.id}`, requestEpoch => window.agentsDock.teamHub.cancelSecurePeerPairing(scope, pairing.id).then(value => {
      if (epoch.current !== requestEpoch) throw new StaleSecurePeerResponse()
      return value
    }))
    if (!next) return
    forgetConsent(scope, pairing)
    automaticCompletionAttempts.current.delete(pairingConsentKey(scope, pairing))
    setControl(next)
  }

  const checkApproval = async (pairing: SecurePeerPairing) => {
    let responseEpoch = epoch.current
    const refreshed = await run(`check:${pairing.id}`, async requestEpoch => {
      responseEpoch = requestEpoch
      const next = await window.agentsDock.teamHub.refreshSecurePeerPairing(scope, pairing.id)
      if (epoch.current !== requestEpoch) throw new StaleSecurePeerResponse()
      if (next.id !== pairing.id || next.direction !== 'outgoing') {
        throw new LocalizedPeerError('teamNetwork.peer.mismatchedRequest')
      }
      return next
    })
    if (!refreshed || epoch.current !== responseEpoch) return
    // Publish after run releases its operation guard. Background-eligible
    // requests retain the existing consent effect; this explicit action also
    // finishes an already-consented request when background reconnect is off.
    setControl(current => current ? {
      ...current,
      pairings: current.pairings.map(item => item.id === refreshed.id ? refreshed : item)
    } : current)
    if (status.backgroundReconnectAllowed !== true
      && control?.activeConnectionId === null
      && refreshed.trustState === 'approved'
      && ['approved', 'connected'].includes(refreshed.status)
      && refreshed.connectionId && refreshed.hubIdentity
      && hasConsent(scope, refreshed)) {
      // activate acquires run's guard synchronously before the render effects
      // can act, and records completion so adoption cannot be submitted twice.
      await activate(refreshed)
    }
  }

  const refreshApprovedHost = async (requestEpoch: number) => {
    if (!workspace || !details || epoch.current !== requestEpoch) return
    setApprovalRefreshError(null)
    const [peers, directory] = await Promise.allSettled([
      Promise.resolve().then(() => epoch.current === requestEpoch
        ? window.agentsDock.teamHub.securePeers(teamScope(workspace.status), details.team.id)
        : []),
      Promise.resolve().then(() => epoch.current === requestEpoch ? onConnectionChanged?.() : undefined)
    ])
    if (epoch.current !== requestEpoch) return
    if (peers.status === 'fulfilled') {
      setManagedPeers(current => sameSecurePeerPairings(current, peers.value) ? current : peers.value)
    }
    const failure = peers.status === 'rejected' ? peers.reason : directory.status === 'rejected' ? directory.reason : null
    if (failure) setApprovalRefreshError(failure)
  }

  const approve = async (pairing: SecurePeerPairing) => {
    if (!workspace || !details || !confirmedSas.has(pairingConfirmationKey(pairing))) return
    const scopes = V1_SCOPES.filter(permission => pairing.requestedScopes.includes(permission))
    if (!scopes.length) return
    await run(`approve:${pairing.id}`, async requestEpoch => {
      const next = await window.agentsDock.teamHub.approveSecurePeerPairing(scope, {
        pairingId: pairing.id,
        teamId: details.team.id,
        expectedPeerServerIdentity: pairing.peerServerIdentity,
        expectedTranscriptHash: pairing.transcriptHash,
        scopes,
        sasConfirmed: true
      })
      if (epoch.current !== requestEpoch) throw new StaleSecurePeerResponse()
      setControl(next)
      const approved = next.pairings.find(item => item.id === pairing.id && item.direction === 'incoming' && item.trustState === 'approved')
      if (approved) setManagedPeers(current => [approved, ...current.filter(item => item.id !== approved.id)])
      // Approval is durable. A later roster failure is a refresh warning and
      // must never invite the user to submit that approval a second time.
      await refreshApprovedHost(requestEpoch)
    })
  }

  const reject = async (pairing: SecurePeerPairing) => {
    const next = await run(`reject:${pairing.id}`, requestEpoch => window.agentsDock.teamHub.rejectSecurePeerPairing(scope, {
      pairingId: pairing.id,
      expectedPeerServerIdentity: pairing.peerServerIdentity,
      expectedTranscriptHash: pairing.transcriptHash
    }).then(value => {
      if (epoch.current !== requestEpoch) throw new StaleSecurePeerResponse()
      return value
    }))
    if (next) setControl(next)
  }

  const disconnect = async (pairing: SecurePeerPairing) => {
    if (connectionAttemptInFlight || !pairing.connectionId || !pairing.hubIdentity) return
    // Disconnect is an explicit request to stay disconnected. Consume any
    // unfinished automatic-completion consent before the request so even a
    // transport failure cannot immediately reactivate this connection.
    rememberAutomaticAdoptionSuppression(automaticAdoptionSuppressions.current, scope, pairing)
    forgetConsent(scope, pairing)
    automaticCompletionAttempts.current.delete(pairingConsentKey(scope, pairing))
    const next = await run(`disconnect:${pairing.id}`, requestEpoch => window.agentsDock.teamHub.deactivateSecurePeerConnection(scope, {
      connectionId: pairing.connectionId!,
      expectedHostServerIdentity: pairing.hostServerIdentity,
      expectedHubIdentity: pairing.hubIdentity!
    }).then(value => {
      if (epoch.current !== requestEpoch) throw new StaleSecurePeerResponse()
      return value
    }))
    if (!next) return
    setControl(next)
    await onConnectionChanged?.()
  }

  const forget = async (pairing: SecurePeerPairing) => {
    if (connectionAttemptInFlight || !pairing.connectionId || !pairing.hubIdentity || !pairing.certificateFingerprint) return
    // Forget includes a disconnect. Preserve that explicit local intent even
    // if the destructive control-plane request loses its response.
    rememberAutomaticAdoptionSuppression(automaticAdoptionSuppressions.current, scope, pairing)
    const next = await run(`forget:${pairing.id}`, requestEpoch => window.agentsDock.teamHub.forgetSecurePeerConnection(scope, {
      connectionId: pairing.connectionId!,
      expectedHostServerIdentity: pairing.hostServerIdentity,
      expectedHubIdentity: pairing.hubIdentity!,
      expectedCertificateFingerprint: pairing.certificateFingerprint!
    }).then(value => {
      if (epoch.current !== requestEpoch) throw new StaleSecurePeerResponse()
      return value
    }))
    if (!next) return
    forgetConsent(scope, pairing)
    automaticCompletionAttempts.current.delete(pairingConsentKey(scope, pairing))
    setConfirmForget(null)
    setControl(next)
    await onConnectionChanged?.()
  }

  const revoke = async (pairing: SecurePeerPairing) => {
    if (!workspace || !details || !pairing.connectionId || !pairing.certificateFingerprint) return
    const result = await run(`revoke:${pairing.id}`, requestEpoch => window.agentsDock.teamHub.revokeSecurePeer(
      teamScope(workspace.status),
      details.team.id,
      {
        peerId: pairing.connectionId!,
        expectedCertificateFingerprint: pairing.certificateFingerprint!,
        idempotencyKey: crypto.randomUUID()
      }
    ).then(value => {
      if (epoch.current !== requestEpoch) throw new StaleSecurePeerResponse()
      return value
    }))
    if (!result) return
    await load()
  }

  const retryConnection = async () => {
    if (connectionAttemptInFlight) return
    if (!onRetryConnection) {
      await load()
      return
    }
    if (operation.current) return
    const key = 'retry-connection'
    const requestEpoch = ++epoch.current
    if (activePairing) {
      clearAutomaticAdoptionSuppression(automaticAdoptionSuppressions.current, scope, activePairing)
    }
    operation.current = key
    setBusy(key)
    setError(null)
    let retryFinished = false
    try {
      const completed = await onRetryConnection()
      // A successful retry can cause the authenticated parent workspace to
      // replace this panel before this continuation runs. Clear the exact old
      // consent even after that unmount; it has completed its one purpose.
      if (completed === true && activePairing) {
        completedConnectionAdoptions.current.add(pairingConsentKey(scope, activePairing))
        forgetConsent(scope, activePairing)
        automaticCompletionAttempts.current.delete(pairingConsentKey(scope, activePairing))
      }
      retryFinished = epoch.current === requestEpoch
    } catch (cause) {
      if (epoch.current === requestEpoch) setError(cause ?? new LocalizedPeerError('teamNetwork.peer.connectionFailed'))
    } finally {
      if (epoch.current === requestEpoch && operation.current === key) {
        operation.current = null
        setBusy(null)
      }
    }
    if (retryFinished) await load()
  }

  const peerConnectionNeedsAttention = !status.designatedHost && Boolean(control?.activeConnectionId) && !connected
  // Teamspace may fail to restore an unrelated legacy/local Hub while this
  // peer has not started secure pairing yet. That background failure must not
  // turn the fresh invite form into a red blocker. Once an exact secure
  // connection is active, the parent adoption error belongs to this flow and
  // remains visible in its recovery card.
  const secureConnectionIsActive = Boolean(control?.activeConnectionId)
  const peerConnectionError = (error != null ? errorMessage(error) : null)
    ?? control?.connectionError
    ?? (secureConnectionIsActive ? networkError : null)
    ?? null
  const panelError = peerConnectionNeedsAttention ? null : peerConnectionError

  return <section className="secure-peer-panel network-connect-panel" aria-label={t('teamNetwork.peer.connectServers')}>
    <header className="teamspace-section-heading network-connect-heading">
      <KeyRound size={18} />
      <div>
        <h2>{status.designatedHost ? t('teamNetwork.peer.shareInvite') : t('teamNetwork.peer.connectServer')}</h2>
        <span>{status.designatedHost
          ? t('teamNetwork.peer.shareInviteHelp')
          : t('teamNetwork.peer.connectNamed', { name: status.serverName || t('teamNetwork.peer.thisServer') })}</span>
      </div>
      <button type="button" className="quiet-button network-refresh-button" aria-label={t('teamNetwork.peer.refreshStatus')} disabled={Boolean(busy)} onClick={() => void load()}><RefreshCw className={busy === 'status' ? 'spin' : ''} size={15} /><span>{t('teamNetwork.peer.refresh')}</span></button>
    </header>

    {!control && busy === 'status' && <div className="teamspace-empty"><LoaderCircle className="spin" size={16} />{t('teamNetwork.peer.checkingServer')}</div>}

    {control && status.designatedHost && <HostConnectionView
      status={status}
      control={control}
      pending={pending}
      expired={expired}
      managedPeers={visibleManagedPeers}
      canManage={canManage}
      busy={Boolean(busy)}
      copied={copied}
      hostAddress={hostAddress}
      confirmedSas={confirmedSas}
      confirmingDisableHost={confirmDisableHost}
      onCopy={() => void copyServerInvite()}
      onHostAddressChange={setHostAddress}
      onConfirmSas={(pairing, checked) => setConfirmedSas(current => toggleConfirmation(current, pairingConfirmationKey(pairing), checked))}
      onApprove={pairing => void approve(pairing)}
      onReject={pairing => void reject(pairing)}
      onRevoke={pairing => void revoke(pairing)}
      onRequestDisableHost={() => setConfirmDisableHost(true)}
      onCancelDisableHost={() => setConfirmDisableHost(false)}
      onDisableHost={() => void run('disable-host', requestEpoch => window.agentsDock.teamHub.configureSecurePeerHost(scope, { enabled: false }).then(value => {
        if (epoch.current !== requestEpoch) throw new StaleSecurePeerResponse()
        setControl(value)
        setCopied(false)
        setConfirmDisableHost(false)
        return value
      }))}
    />}

    {control && !status.designatedHost && <PeerConnectionView
      control={control}
      outgoing={outgoing}
      activePairing={activePairing}
      connected={connected}
      connectionError={peerConnectionError}
      invite={invite}
      busy={Boolean(busy) || connectionAttemptInFlight}
      confirmForget={confirmForget}
      automaticallyFinishing={new Set(automaticPendingPairings.filter(pairing => (
        hasConsent(scope, pairing)
        && !hasAutomaticAdoptionSuppression(automaticAdoptionSuppressions.current, scope, pairing)
      )).map(pairing => pairing.id))}
      onInviteChange={setInvite}
      onPaste={() => void pasteInvite()}
      onConnect={connectThisServer}
      onCancel={pairing => void cancel(pairing)}
      onCheckApproval={pairing => void checkApproval(pairing)}
      onReconnect={pairing => void activate(pairing)}
      onDisconnect={pairing => void disconnect(pairing)}
      onRequestForget={setConfirmForget}
      onCancelForget={() => setConfirmForget(null)}
      onForget={pairing => void forget(pairing)}
      onRetry={() => void retryConnection()}
      onEndpointUpdated={async next => {
        setControl(next)
        await onConnectionChanged?.()
      }}
    />}

    {panelError && <div className="teamspace-error network-panel-error" role="alert"><span>{panelError}</span><button type="button" className="quiet-button" onClick={() => void load()}>{t('teamNetwork.peer.retry')}</button></div>}
    {completionNotice && <div className="teamspace-host-help" role="status"><strong>{t(completionNotice)}</strong></div>}
    {approvalRefreshError != null && <div className="teamspace-error network-panel-error" role="status"><span>{t('teamNetwork.peer.approvalRefreshFailed', { error: errorMessage(approvalRefreshError) })}</span><button type="button" className="quiet-button" disabled={Boolean(busy)} onClick={() => void run('refresh-approved', refreshApprovedHost)}>{t('teamNetwork.peer.refreshServerList')}</button></div>}
  </section>
}

function sameSecurePeerControl(
  current: SecurePeerControlStatus | null,
  incoming: SecurePeerControlStatus
): boolean {
  return current === incoming || Boolean(current && JSON.stringify(current) === JSON.stringify(incoming))
}

function automaticallyCompletesPairing(control: SecurePeerControlStatus, pairing: SecurePeerPairing): boolean {
  return control.automaticPairingCompletionAvailable === true && pairing.completeOnApproval === true
    && !(control.pairingCompletion?.pairingId === pairing.id
      && control.pairingCompletion.transcriptHash === pairing.transcriptHash)
}

function sameSecurePeerPairings(
  current: readonly SecurePeerPairing[],
  incoming: readonly SecurePeerPairing[]
): boolean {
  return current === incoming || JSON.stringify(current) === JSON.stringify(incoming)
}

function HostConnectionView({ status, control, pending, expired, managedPeers, canManage, busy, copied, hostAddress, confirmedSas, confirmingDisableHost, onCopy, onHostAddressChange, onConfirmSas, onApprove, onReject, onRevoke, onRequestDisableHost, onCancelDisableHost, onDisableHost }: {
  status: TeamHubStatus
  control: SecurePeerControlStatus
  pending: SecurePeerPairing[]
  expired: SecurePeerPairing[]
  managedPeers: SecurePeerPairing[]
  canManage: boolean
  busy: boolean
  copied: boolean
  hostAddress: string
  confirmedSas: Set<string>
  confirmingDisableHost: boolean
  onCopy: () => void
  onHostAddressChange: (value: string) => void
  onConfirmSas: (pairing: SecurePeerPairing, checked: boolean) => void
  onApprove: (pairing: SecurePeerPairing) => void
  onReject: (pairing: SecurePeerPairing) => void
  onRevoke: (pairing: SecurePeerPairing) => void
  onRequestDisableHost: () => void
  onCancelDisableHost: () => void
  onDisableHost: () => void
}) {
  const locale = useLocale()
  const livePeers = managedPeers.filter(pairing => (
    pairing.direction === 'incoming' && ['approved', 'revoked'].includes(pairing.trustState)
  ))
  const hostIdentity = status.serverIdentity || t('teamNetwork.peer.unavailable')
  const hostHasError = Boolean(control.host.error || control.host.errorCode)
  const hostIssueTitle = control.host.errorCode === 'peer_identity_conflict'
    ? t('teamNetwork.peer.conflictingRecords')
    : t('teamNetwork.peer.cannotInvite')
  return <>
    <article className="network-server-identity">
      <Server size={18} />
      <div><strong>{status.serverName || t('teamNetwork.peer.networkHost')}</strong><span title={status.serverIdentity || undefined}>{t('teamNetwork.peer.serverIdentity')} · {compactIdentity(hostIdentity)}</span></div>
      <b>{t('teamNetwork.peer.host')}</b>
    </article>
    {!control.host.pairingLink && !control.host.advertisedHost && control.host.advertisedHosts.length === 0 && <label className="network-host-address">{t('teamNetwork.peer.reachableAddress')}<input required aria-label={t('teamNetwork.peer.reachableAddress')} value={hostAddress} onChange={event => onHostAddressChange(event.target.value)} inputMode="decimal" autoCapitalize="none" spellCheck={false} placeholder="100.x.x.x" /></label>}
    <button type="button" className="primary-button network-copy-invite" disabled={busy || hostHasError || !control.host.available || !control.host.pairingLink && !hostAddress.trim() && !control.host.advertisedHost && control.host.advertisedHosts.length === 0} onClick={onCopy}><Copy size={14} />{copied ? t('teamNetwork.peer.inviteCopied') : t('teamNetwork.peer.copyInvite')}</button>
    {(!control.host.available || hostHasError) && <div className="teamspace-host-help network-host-error" role="alert">
      <strong>{hostIssueTitle}</strong>
      {control.host.error && <span>{control.host.error}</span>}
      {control.host.action && <span>{control.host.action}</span>}
      {control.host.errorCode && <span className="network-error-code">{t('teamNetwork.peer.errorCode')} · <code>{control.host.errorCode}</code></span>}
    </div>}

    <section className="network-approval-list" aria-label={t('teamNetwork.peer.connectionRequests')}>
      <header><h3>{t('teamNetwork.peer.waitingApproval')}</h3><b className="network-pending-count">{pending.length}</b></header>
      {!pending.length && <p>{t('teamNetwork.peer.noWaiting')}</p>}
      {pending.map(pairing => {
        const confirmationKey = pairingConfirmationKey(pairing)
        const allowed = V1_SCOPES.filter(scope => pairing.requestedScopes.includes(scope))
        return <article className="secure-peer-pairing-card" key={pairing.id}>
          <Server size={18} />
          <div>
            <strong>{pairing.peerDisplayName}</strong>
            <span>{t('teamNetwork.peer.compareSix')}</span>
            <SAS pairing={pairing} />
            <label className="secure-peer-sas-confirm"><input type="checkbox" checked={confirmedSas.has(confirmationKey)} onChange={event => onConfirmSas(pairing, event.target.checked)} />{t('teamNetwork.peer.sixMatch')}</label>
            <details className="network-more"><summary>{t('teamNetwork.peer.advanced')}</summary><ConnectionDetails pairing={pairing} /></details>
          </div>
          <div className="secure-peer-card-actions">
            {canManage
              ? <><button type="button" className="primary-button" disabled={busy || !confirmedSas.has(confirmationKey) || !allowed.length} onClick={() => onApprove(pairing)}>{t('teamNetwork.peer.approve')}</button><button type="button" className="quiet-button danger" disabled={busy} onClick={() => onReject(pairing)}>{t('teamNetwork.peer.reject')}</button></>
              : <span>{t('teamNetwork.peer.adminApproval')}</span>}
          </div>
        </article>
      })}
    </section>

    {expired.length > 0 && <details className="network-more network-approval-list">
      <summary>{t('teamNetwork.peer.expiredRequests', { count: expired.length })}</summary>
      <p>{t('teamNetwork.peer.expiredRequestHelp')}</p>
      {expired.map(pairing => <article className="secure-peer-pairing-card" key={pairing.id}>
        <Server size={18} />
        <div><strong>{pairing.peerDisplayName}</strong><span>{t('teamNetwork.peer.expiredRequestStatus')}</span></div>
      </article>)}
    </details>}

    {livePeers.length > 0 && <section className="network-approval-list" aria-label={t('teamNetwork.peer.serverConnections')}>
      <header><h3>{t('teamNetwork.peer.serverConnections')}</h3></header>
      {livePeers.map(pairing => <article className={`secure-peer-pairing-card ${pairing.trustState === 'revoked' ? 'danger' : ''}`} key={pairing.id}>
        <Server size={18} />
        <div>
          <strong>{pairing.peerDisplayName}</strong>
          <span>{hostPeerStateLabel(pairing)}</span>
          <details className="network-more">
            <summary>{t('teamNetwork.peer.connectionDetails')}</summary>
            <ConnectionDetails pairing={pairing} />
            {canManage && pairing.trustState === 'approved' && <button type="button" className="quiet-button danger" disabled={busy || !pairing.connectionId || !pairing.certificateFingerprint} onClick={() => onRevoke(pairing)}>{t('teamNetwork.peer.revokeAccess')}</button>}
          </details>
        </div>
      </article>)}
    </section>}

    <details className="network-more network-connection-manage">
      <summary>{t('teamNetwork.peer.advancedManage')}</summary>
      <div className="secure-peer-request-details">
        <span>{t('teamNetwork.peer.hostIdentity')} · <code>{status.serverIdentity}</code></span>
        {control.host.caFingerprint && <span>{t('teamNetwork.peer.hostFingerprint')} · <code>{control.host.caFingerprint}</code></span>}
        {control.host.certificateExpiresAt && <span>{t('teamNetwork.peer.inviteExpires', { date: new Date(control.host.certificateExpiresAt).toLocaleString(locale) })}</span>}
        {control.host.enabled && !confirmingDisableHost && <button type="button" className="quiet-button danger" disabled={busy} onClick={onRequestDisableHost}>{t('teamNetwork.peer.disableHostingEllipsis')}</button>}
        {control.host.enabled && confirmingDisableHost && <div className="secure-peer-destructive-confirm" role="group" aria-label={t('teamNetwork.peer.disableHosting')}>
          <span>{t('teamNetwork.peer.disableHostingConfirm')}</span>
          <button type="button" className="quiet-button danger" disabled={busy} onClick={onDisableHost}>{t('teamNetwork.peer.disableTakeOffline')}</button>
          <button type="button" className="quiet-button" disabled={busy} onClick={onCancelDisableHost}>{t('teamNetwork.peer.keepHosting')}</button>
        </div>}
      </div>
    </details>
  </>
}

function PeerConnectionView({ control, outgoing, activePairing, connected, connectionError, invite, busy, confirmForget, automaticallyFinishing, onInviteChange, onPaste, onConnect, onCancel, onCheckApproval, onReconnect, onDisconnect, onRequestForget, onCancelForget, onForget, onRetry, onEndpointUpdated }: {
  control: SecurePeerControlStatus
  outgoing: SecurePeerPairing[]
  activePairing: SecurePeerPairing | null
  connected: SecurePeerPairing | null
  connectionError: string | null
  invite: string
  busy: boolean
  confirmForget: string | null
  automaticallyFinishing: ReadonlySet<string>
  onInviteChange: (value: string) => void
  onPaste: () => void
  onConnect: (event: FormEvent<HTMLFormElement>) => void
  onCancel: (pairing: SecurePeerPairing) => void
  onCheckApproval: (pairing: SecurePeerPairing) => void
  onReconnect: (pairing: SecurePeerPairing) => void
  onDisconnect: (pairing: SecurePeerPairing) => void
  onRequestForget: (pairingId: string) => void
  onCancelForget: () => void
  onForget: (pairing: SecurePeerPairing) => void
  onRetry: () => void
  onEndpointUpdated: (control: SecurePeerControlStatus) => Promise<void> | void
}) {
  useLocale()
  const connectionCards = outgoing.filter(pairing => (
    pairing.id !== activePairing?.id
    && ['pending', 'approved', 'revoked'].includes(pairing.trustState)
  ))
  const canStartConnection = !activePairing && control.activeConnectionId === null && connectionCards.length === 0
  const degraded = control.activeConnectionId !== null && !connected
  const teamspaceAdoptionIncomplete = Boolean(
    activePairing?.trustState === 'approved'
    && activePairing.transportState === 'online'
    && !connectionError
    && !activePairing.error
  )
  const activeRevoked = activePairing?.trustState === 'revoked'
  const degradedLabel = teamspaceAdoptionIncomplete
    ? t('teamNetwork.peer.teamspaceIncomplete')
    : activeRevoked
    ? t('teamNetwork.peer.accessRevoked')
    : activePairing?.transportState === 'reconnecting'
      ? t('teamNetwork.peer.reconnecting')
      : activePairing?.transportState === 'offline'
        ? t('teamNetwork.peer.offline')
        : t('teamNetwork.peer.attention')
  const degradedDescription = connectionError || activePairing?.error || (
    teamspaceAdoptionIncomplete
      ? t('teamNetwork.peer.adoptionIncomplete')
      : activeRevoked
      ? t('teamNetwork.peer.revokedDescription')
      : activePairing?.transportState === 'reconnecting'
      ? t('teamNetwork.peer.reconnectingDescription', { seconds: control.heartbeatIntervalSeconds })
      : activePairing?.transportState === 'offline'
        ? t('teamNetwork.peer.offlineDescription', { seconds: control.leaseSeconds })
        : t('teamNetwork.peer.unverifiedDescription')
  )
  return <>
    {canStartConnection && <form className="network-connect-form" onSubmit={onConnect}>
      <div className="network-connect-form-copy">
        <span className="network-step-icon"><Link2 size={20} /></span>
        <div><strong>{t('teamNetwork.peer.pasteHostInvite')}</strong><span>{t('teamNetwork.peer.inviteLinksServer')}</span></div>
      </div>
      <div className="network-invite-field"><label htmlFor="secure-peer-server-invite">{t('teamNetwork.peer.serverInvite')}</label><div className="network-invite-input"><input id="secure-peer-server-invite" required aria-label={t('teamNetwork.peer.serverInvite')} value={invite} onChange={event => onInviteChange(event.target.value)} autoCapitalize="none" spellCheck={false} placeholder="agentsdock://secure-peer/join…" /><button type="button" className="quiet-button" disabled={busy} onClick={onPaste}>{t('teamNetwork.peer.pasteInvite')}</button></div></div>
      <div className="network-connect-form-footer"><p>{control.automaticPairingCompletionAvailable === true ? t('teamNetwork.peer.automaticSwitch') : preservationSentence()}</p><button className="primary-button" disabled={busy || !invite.trim()}>{t('teamNetwork.peer.connectServer')}</button></div>
    </form>}

    {degraded && <article className={`network-connection-state needs-attention is-${activePairing?.transportState ?? 'unknown'}`} role="alert">
      <span className="network-state-icon">{activePairing?.transportState === 'offline' ? <WifiOff size={24} /> : <CircleAlert size={24} />}</span>
      <div className="network-state-copy">
        <span className="network-state-label">{degradedLabel}</span>
        <h3>{activePairing?.peerDisplayName || t('teamNetwork.peer.savedConnection')}</h3>
        <p>{degradedDescription}</p>
      </div>
      <div className="network-state-actions">
        {activePairing && <SecurePeerHostAddressAction control={control} pairing={activePairing} disabled={busy} onUpdated={onEndpointUpdated} />}
        {!activeRevoked && <button type="button" className="primary-button" disabled={busy} onClick={onRetry}><RefreshCw className={busy ? 'spin' : ''} size={15} />{t('teamNetwork.peer.tryAgain')}</button>}
        {!activeRevoked && activePairing?.connectionId && activePairing.hubIdentity && <button type="button" className="quiet-button" disabled={busy} onClick={() => onDisconnect(activePairing)}>{t('teamNetwork.peer.disconnect')}</button>}
        {activePairing && canForgetSecurePeerPairing(activePairing) && <button type="button" className="quiet-button danger" disabled={busy} onClick={() => onRequestForget(activePairing.id)}>{activeRevoked ? t('teamNetwork.peer.forgetLocal') : t('teamNetwork.peer.leaveNetwork')}</button>}
      </div>
      {activePairing && <details className="network-more network-state-details"><summary>{t('teamNetwork.peer.connectionDetails')}</summary><ConnectionDetails pairing={activePairing} /></details>}
      {activePairing && confirmForget === activePairing.id && <ForgetConfirmation pairing={activePairing} busy={busy} onConfirm={onForget} onCancel={onCancelForget} />}
    </article>}

    {connected && <article className="network-connection-state is-connected" role="status">
      <span className="network-state-icon"><ShieldCheck size={24} /></span>
      <div className="network-state-copy"><span className="network-state-label">{t('teamNetwork.peer.connected')}</span><h3>{connected.peerDisplayName}</h3><p>{t('teamNetwork.peer.connectedDescription')}</p></div>
      <div className="network-state-actions"><SecurePeerHostAddressAction control={control} pairing={connected} disabled={busy} onUpdated={onEndpointUpdated} /><button type="button" className="quiet-button" disabled={busy} onClick={() => onDisconnect(connected)}>{t('teamNetwork.peer.disconnect')}</button>{canForgetSecurePeerPairing(connected) && <button type="button" className="quiet-button danger" disabled={busy} onClick={() => onRequestForget(connected.id)}>{t('teamNetwork.peer.leaveNetwork')}</button>}</div>
      <details className="network-more network-state-details"><summary>{t('teamNetwork.peer.connectionDetails')}</summary><ConnectionDetails pairing={connected} /></details>
      {confirmForget === connected.id && <ForgetConfirmation pairing={connected} busy={busy} onConfirm={onForget} onCancel={onCancelForget} />}
    </article>}

    {connectionCards.map(pairing => <article className={`secure-peer-pairing-card ${pairing.trustState === 'revoked' ? 'danger' : ''}`} key={pairing.id}>
      {pairing.trustState === 'revoked' ? <CircleAlert size={18} /> : <KeyRound size={18} />}
      <div>
        <strong>{pairing.peerDisplayName}</strong>
        {pairing.trustState === 'pending' && <>{automaticallyFinishing.has(pairing.id)
          ? <><span role="status">{t('teamNetwork.peer.waitingHostApproval')}</span><span>{t('teamNetwork.peer.compareAutomatic')}</span></>
          : <span>{t('teamNetwork.peer.compareManual')}</span>}<SAS pairing={pairing} /></>}
        {pairing.trustState === 'approved' && <><span>{automaticallyFinishing.has(pairing.id) ? t('teamNetwork.peer.finishingAutomatically') : t('teamNetwork.peer.savedApproved')}</span><p className="network-preservation-note">{preservationSentence()}</p></>}
        {pairing.trustState === 'revoked' && <span>{t('teamNetwork.peer.revokedCannotReconnect')}</span>}
        <details className="network-more"><summary>{t('teamNetwork.peer.advancedManage')}</summary><ConnectionDetails pairing={pairing} /></details>
        {confirmForget === pairing.id && <ForgetConfirmation pairing={pairing} busy={busy} onConfirm={onForget} onCancel={onCancelForget} />}
      </div>
      <div className="secure-peer-card-actions">
        <SecurePeerHostAddressAction control={control} pairing={pairing} disabled={busy} onUpdated={onEndpointUpdated} />
        {pairing.trustState === 'pending' && <>{!automaticallyFinishing.has(pairing.id) && <button type="button" className="primary-button" disabled={busy} onClick={() => onCheckApproval(pairing)}>{t('teamNetwork.peer.checkApproval')}</button>}<button type="button" className="quiet-button" disabled={busy} onClick={() => onCancel(pairing)}>{t('teamNetwork.peer.cancel')}</button></>}
        {pairing.trustState === 'approved' && !automaticallyFinishing.has(pairing.id) && <button type="button" className="primary-button" disabled={busy || Boolean(control.activeConnectionId)} onClick={() => onReconnect(pairing)}>{t('teamNetwork.peer.reconnect')}</button>}
        {['approved', 'revoked'].includes(pairing.trustState) && canForgetSecurePeerPairing(pairing) && <button type="button" className="quiet-button danger" disabled={busy} onClick={() => onRequestForget(pairing.id)}>{pairing.trustState === 'revoked' ? t('teamNetwork.peer.forgetLocal') : t('teamNetwork.peer.leaveNetwork')}</button>}
      </div>
    </article>)}
  </>
}

function ForgetConfirmation({ pairing, busy, onConfirm, onCancel }: {
  pairing: SecurePeerPairing
  busy: boolean
  onConfirm: (pairing: SecurePeerPairing) => void
  onCancel: () => void
}) {
  useLocale()
  return <div className="secure-peer-destructive-confirm network-forget-confirm">
    <span>{pairing.trustState === 'revoked' ? t('teamNetwork.peer.forgetRevokedQuestion') : t('teamNetwork.peer.leaveQuestion')}{' '}{t('teamNetwork.peer.forgetDescription')}</span>
    <button type="button" className="quiet-button danger" disabled={busy} onClick={() => onConfirm(pairing)}>{pairing.trustState === 'revoked' ? t('teamNetwork.peer.confirmForget') : t('teamNetwork.peer.confirmLeave')}</button>
    <button type="button" className="quiet-button" disabled={busy} onClick={onCancel}>{t('teamNetwork.peer.keepIt')}</button>
  </div>
}

function ConnectionDetails({ pairing }: { pairing: SecurePeerPairing }) {
  const locale = useLocale()
  return <div className="secure-peer-request-details">
    <span>{t('teamNetwork.peer.trust')} · <code>{pairing.trustState}</code></span>
    <span>{t('teamNetwork.peer.transport')} · <code>{pairing.transportState}</code></span>
    <span>{t('teamNetwork.peer.serverIdentity')} · <code>{pairing.peerServerIdentity}</code></span>
    <span>{t('teamNetwork.peer.transcript')} · <code>{pairing.transcriptHash}</code></span>
    <span>{t('teamNetwork.peer.publicKey')} · <code>{pairing.peerPublicKeyFingerprint}</code></span>
    {pairing.certificateFingerprint && <span>{t('teamNetwork.peer.certificate')} · <code>{pairing.certificateFingerprint}</code></span>}
    {pairing.certificateExpiresAt && <span>{t('teamNetwork.peer.certificateExpires', { date: new Date(pairing.certificateExpiresAt).toLocaleString(locale) })}</span>}
  </div>
}

function hostPeerStateLabel(pairing: SecurePeerPairing): string {
  if (pairing.trustState === 'revoked') return t('teamNetwork.peer.hostRevokedState')
  if (!pairing.lastSeenAt && ['offline', 'disconnected'].includes(pairing.transportState)) {
    return t('teamNetwork.peer.hostWaitingState')
  }
  switch (pairing.transportState) {
    case 'online': return t('teamNetwork.peer.hostOnlineState')
    case 'reconnecting': return t('teamNetwork.peer.hostReconnectingState')
    case 'offline': return t('teamNetwork.peer.hostOfflineState')
    default: return t('teamNetwork.peer.hostApprovedState')
  }
}

function SAS({ pairing }: { pairing: SecurePeerPairing }) {
  useLocale()
  return <div className="secure-peer-sas" aria-label={t('teamNetwork.peer.sixWordCode')}>{pairing.sasWords.map((word, index) => <b key={`${index}:${word}`}>{word}</b>)}</div>
}

function preservationSentence(): string {
  return t('teamNetwork.peer.preservation')
}

function compactIdentity(identity: string): string {
  return identity.length > 14 ? `${identity.slice(0, 6)}…${identity.slice(-6)}` : identity
}

function profileScope(status: TeamHubStatus): SecurePeerProfileScope | null {
  return status.serverIdentity ? {
    profileId: status.profileId,
    profileGeneration: status.profileGeneration,
    serverIdentity: status.serverIdentity
  } : null
}

function teamScope(status: TeamHubStatus) {
  if (!status.serverIdentity) throw new LocalizedPeerError('teamNetwork.peer.activeIdentityUnavailable')
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

function pairingConfirmationKey(pairing: SecurePeerPairing): string {
  return `${pairing.id}\0${pairing.peerServerIdentity}\0${pairing.transcriptHash}\0${pairing.peerPublicKeyFingerprint}`
}

function pairingConsentKey(scope: SecurePeerProfileScope, pairing: SecurePeerPairing): string {
  return `${CONSENT_PREFIX}${JSON.stringify([scope.profileId, scope.serverIdentity, pairing.id, pairing.hostServerIdentity, pairing.transcriptHash])}`
}

function rememberConsent(scope: SecurePeerProfileScope, pairing: SecurePeerPairing): void {
  try { window.localStorage.setItem(pairingConsentKey(scope, pairing), 'approved') } catch { /* Finish connecting remains available. */ }
}

function hasConsent(scope: SecurePeerProfileScope, pairing: SecurePeerPairing): boolean {
  try {
    const stableKey = pairingConsentKey(scope, pairing)
    if (window.localStorage.getItem(stableKey) === 'approved') return true
    const legacyKeys = matchingLegacyConsentKeys(scope, pairing)
    if (!legacyKeys.length) return false
    window.localStorage.setItem(stableKey, 'approved')
    for (const key of legacyKeys) window.localStorage.removeItem(key)
    return true
  } catch { return false }
}

function forgetConsent(scope: SecurePeerProfileScope, pairing: SecurePeerPairing): void {
  try {
    window.localStorage.removeItem(pairingConsentKey(scope, pairing))
    for (const key of matchingLegacyConsentKeys(scope, pairing)) window.localStorage.removeItem(key)
  } catch { /* Best effort only. */ }
}

function automaticAdoptionSuppressionKey(scope: SecurePeerProfileScope, pairing: SecurePeerPairing): string {
  return `${AUTO_ADOPTION_SUPPRESSION_PREFIX}${JSON.stringify([
    scope.profileId,
    scope.serverIdentity,
    pairing.id,
    pairing.hostServerIdentity,
    pairing.transcriptHash
  ])}`
}

function rememberAutomaticAdoptionSuppression(
  memory: Set<string>,
  scope: SecurePeerProfileScope,
  pairing: SecurePeerPairing
): void {
  const key = automaticAdoptionSuppressionKey(scope, pairing)
  memory.add(key)
  try { window.localStorage.setItem(key, 'disconnected') } catch { /* In-memory suppression still protects this surface. */ }
}

function hasAutomaticAdoptionSuppression(
  memory: Set<string>,
  scope: SecurePeerProfileScope,
  pairing: SecurePeerPairing
): boolean {
  const key = automaticAdoptionSuppressionKey(scope, pairing)
  if (memory.has(key)) return true
  try {
    if (window.localStorage.getItem(key) !== 'disconnected') return false
    memory.add(key)
    return true
  } catch { return false }
}

function clearAutomaticAdoptionSuppression(
  memory: Set<string>,
  scope: SecurePeerProfileScope,
  pairing: SecurePeerPairing
): void {
  const key = automaticAdoptionSuppressionKey(scope, pairing)
  memory.delete(key)
  try { window.localStorage.removeItem(key) } catch { /* Best effort only. */ }
}

function matchingLegacyConsentKeys(scope: SecurePeerProfileScope, pairing: SecurePeerPairing): string[] {
  const matches: string[] = []
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (!key?.startsWith(LEGACY_CONSENT_PREFIX) || window.localStorage.getItem(key) !== 'approved') continue
    try {
      const value = JSON.parse(key.slice(LEGACY_CONSENT_PREFIX.length))
      if (
        Array.isArray(value) && value.length === 6
        && value[0] === scope.profileId
        && value[2] === scope.serverIdentity
        && value[3] === pairing.id
        && value[4] === pairing.hostServerIdentity
        && value[5] === pairing.transcriptHash
      ) matches.push(key)
    } catch { /* Ignore unrelated storage keys. */ }
  }
  return matches
}

function automaticCompletionMarker(
  control: SecurePeerControlStatus,
  pairing: SecurePeerPairing,
  activatePairing: boolean
): string {
  return JSON.stringify([
    activatePairing ? 'activate' : 'connect',
    control.serverInstanceId,
    pairing.status,
    pairing.transportState,
    pairing.lastSeenAt,
    control.connectionError
  ])
}

function markAutomaticCompletionState(
  attemptsByConsent: Map<string, AutomaticCompletionAttempts>,
  consentKey: string,
  control: SecurePeerControlStatus,
  pairing: SecurePeerPairing
): void {
  const attempts = attemptsByConsent.get(consentKey)
  if (!attempts) return
  attempts.markers.add(automaticCompletionMarker(control, pairing, false))
}

function toggleConfirmation(current: Set<string>, key: string, checked: boolean): Set<string> {
  const next = new Set(current)
  checked ? next.add(key) : next.delete(key)
  return next
}

function errorMessage(cause: unknown): string {
  if (cause instanceof LocalizedPeerError) return t(cause.key, { error: errorMessage(cause.details) })
  return cause instanceof Error ? cause.message : t('teamNetwork.peer.connectionFailed')
}

class LocalizedPeerError extends Error {
  constructor(readonly key: string, readonly details?: unknown) { super(t(key)) }
}

class StaleSecurePeerResponse extends LocalizedPeerError {
  constructor() { super('teamNetwork.peer.staleResponse') }
}
