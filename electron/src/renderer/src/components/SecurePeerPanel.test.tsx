import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import type { AgentsDockAPI } from '@shared/ipc'
import type { SecurePeerControlStatus, SecurePeerPairing } from '@shared/secure-peer'
import type { TeamHubStatus, TeamHubTeamDetails, TeamHubWorkspace } from '@shared/team-hub'
import { SecurePeerPanel } from './SecurePeerPanel'
import { setLocale } from '@shared/i18n'

const fingerprint = `sha256:${'a'.repeat(64)}`
const certificate = `sha256:${'b'.repeat(64)}`
const pairingId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
const connectionId = '22e7bb2e-3b47-4be7-89fc-2cecd90f4434'

const hostStatus: TeamHubStatus = {
  version: 1,
  profileId: 'profile-host',
  profileGeneration: 4,
  serverIdentity: 'server-host',
  serverName: 'TargetApp',
  generation: 2,
  hubUrl: 'http://127.0.0.1:7850/api/team-hub',
  hubIdentity: 'hub-team',
  savedHubIdentity: 'hub-team',
  transport: 'loopback',
  designatedHost: true,
  availabilityMessage: 'Ready',
  availabilityAction: null,
  canForgetBinding: true,
  backgroundReconnectAllowed: true,
  connectionState: 'authenticated',
  authenticated: true,
  bootstrapRequired: false,
  principal: { id: 'owner', display_name: 'Owner', email: 'owner@example.test' },
  session: { id: 'session', device_label: 'Desktop', expires_at: '2027-01-01T00:00:00Z' },
  error: null
}

const peerStatus: TeamHubStatus = {
  ...hostStatus,
  profileId: 'profile-peer',
  serverIdentity: 'server-peer',
  serverName: 'Studio',
  transport: 'secure_peer',
  connectionId,
  hostServerIdentity: 'server-host',
  designatedHost: false,
  canForgetBinding: true
}

const workspace: TeamHubWorkspace = {
  status: hostStatus,
  teams: [{ id: 'team-1', kind: 'shared', slug: 'team', display_name: 'Team', role: 'owner', status: 'active' }]
}

const details: TeamHubTeamDetails = {
  scope: {
    profileId: hostStatus.profileId,
    profileGeneration: hostStatus.profileGeneration,
    serverIdentity: hostStatus.serverIdentity!,
    generation: hostStatus.generation,
    hubIdentity: hostStatus.hubIdentity
  },
  team: workspace.teams[0],
  membership: { principal_id: 'owner', display_name: 'Owner', email: 'owner@example.test', role: 'owner', status: 'active' },
  members: [],
  nodes: [],
  channels: []
}

function pairing(overrides: Partial<SecurePeerPairing> = {}): SecurePeerPairing {
  const pairingStatus = overrides.status ?? 'pending_approval'
  const trustState: SecurePeerPairing['trustState'] = overrides.trustState ?? (() => {
    switch (pairingStatus) {
      case 'requesting':
      case 'pending_approval': return 'pending'
      case 'approved':
      case 'connected': return 'approved'
      case 'revoked': return 'revoked'
      case 'rejected': return 'rejected'
      case 'expired': return 'expired'
      default: return 'error'
    }
  })()
  const transportState = overrides.transportState ?? (
    pairingStatus === 'connected' ? 'online' : pairingStatus === 'revoked' ? 'revoked' : 'disconnected'
  )
  return {
    id: pairingId,
    direction: 'outgoing',
    status: pairingStatus,
    trustState,
    transportState,
    peerServerIdentity: 'server-host',
    peerDisplayName: 'TargetApp',
    remoteEndpoint: '100.64.0.1:7851',
    hostServerIdentity: 'server-host',
    hostCaFingerprint: fingerprint,
    peerPublicKeyFingerprint: fingerprint,
    transcriptHash: 'c'.repeat(64),
    sasWords: ['amber', 'birch', 'cobalt', 'delta', 'ember', 'forest'],
    requestedScopes: ['teamspace.read', 'teamspace.write'],
    grantedScopes: [],
    teamId: null,
    teamDisplayName: null,
    hubIdentity: null,
    connectionId: null,
    localProxyBasePath: null,
    certificateExpiresAt: null,
    certificateFingerprint: null,
    lastSeenAt: null,
    expiresAt: '2026-08-25T00:00:00Z',
    error: null,
    ...overrides
  }
}

function control(overrides: Partial<SecurePeerControlStatus> = {}): SecurePeerControlStatus {
  return {
    version: 2,
    heartbeatIntervalSeconds: 30,
    leaseSeconds: 90,
    profileId: peerStatus.profileId,
    profileGeneration: peerStatus.profileGeneration,
    serverIdentity: peerStatus.serverIdentity!,
    serverInstanceId: 'instance-1',
    activeConnectionId: null,
    remoteRouteDeliveryAvailable: false,
    connectionError: null,
    host: {
      available: true,
      enabled: false,
      listenPort: 7851,
      advertisedHost: null,
      advertisedHosts: [],
      caFingerprint: null,
      pairingLink: null,
      certificateExpiresAt: null,
      error: null,
      errorCode: null,
      action: null
    },
    pairings: [],
    remoteRoutes: [],
    publishedRoutes: [],
    ...overrides
  }
}

function installAPI(overrides: Record<string, unknown> = {}) {
  const teamHub = {
    securePeerStatus: vi.fn().mockResolvedValue(control()),
    configureSecurePeerHost: vi.fn().mockResolvedValue(control()),
    securePeers: vi.fn().mockResolvedValue([]),
    requestSecurePeerPairing: vi.fn().mockResolvedValue(pairing()),
    refreshSecurePeerPairing: vi.fn().mockResolvedValue(pairing()),
    waitForSecurePeerPairingCompletion: vi.fn().mockImplementation(() => new Promise(() => undefined)),
    stopSecurePeerPairingCompletionWait: vi.fn().mockResolvedValue(undefined),
    cancelSecurePeerPairing: vi.fn().mockResolvedValue(control()),
    activateSecurePeerPairing: vi.fn().mockResolvedValue(control()),
    deactivateSecurePeerConnection: vi.fn().mockResolvedValue(control()),
    forgetSecurePeerConnection: vi.fn().mockResolvedValue(control()),
    approveSecurePeerPairing: vi.fn().mockResolvedValue(control()),
    rejectSecurePeerPairing: vi.fn().mockResolvedValue(control()),
    revokeSecurePeer: vi.fn(),
    ...overrides
  }
  const native = {
    readClipboard: vi.fn().mockResolvedValue(''),
    writeClipboard: vi.fn().mockResolvedValue(undefined)
  }
  window.agentsDock = { teamHub, native } as unknown as AgentsDockAPI
  return { teamHub, native }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

beforeEach(() => {
  setLocale('en')
  window.localStorage.clear()
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => '42e7bb2e-3b47-4be7-89fc-2cecd90f4434') })
})

afterEach(() => {
  cleanup()
  setLocale('en')
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('automatic secure peer approval completion', () => {
  const autoPairing = (overrides: Partial<SecurePeerPairing> = {}) => pairing({ completeOnApproval: true, ...overrides })
  const autoControl = (overrides: Partial<SecurePeerControlStatus> = {}) => control({ automaticPairingCompletionAvailable: true, ...overrides })
  const completedControl = () => autoControl({ activeConnectionId: connectionId, pairings: [autoPairing({
    status: 'connected', connectionId, hubIdentity: 'hub-team', certificateFingerprint: certificate
  })] })
  const consentKey = () => `agentsdock.secure-peer.connect-consent.v2:${JSON.stringify([
    peerStatus.profileId, peerStatus.serverIdentity, pairingId, 'server-host', 'c'.repeat(64)
  ])}`
  async function join() {
    fireEvent.change(await screen.findByLabelText('Server invite'), { target: { value: 'agentsdock://secure-peer/invite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect this server' }))
    await screen.findByText('Waiting for host approval')
  }

  it.each([true, false])('finishes one explicitly consented Join without Check approval or another activation (background %s)', async backgroundReconnectAllowed => {
    const completion = deferred<SecurePeerControlStatus>()
    const finish = vi.fn().mockResolvedValue(true)
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(autoControl()),
      requestSecurePeerPairing: vi.fn().mockResolvedValue(autoPairing()),
      waitForSecurePeerPairingCompletion: vi.fn().mockReturnValue(completion.promise)
    })
    render(<SecurePeerPanel status={{ ...peerStatus, backgroundReconnectAllowed }} onActivated={finish} />)
    await join()
    expect(teamHub.requestSecurePeerPairing).toHaveBeenCalledWith(
      { profileId: 'profile-peer', profileGeneration: 4, serverIdentity: 'server-peer' },
      { host: 'agentsdock://secure-peer/invite', displayName: 'Studio', requestedScopes: ['teamspace.read', 'teamspace.write'],
        completeOnApproval: true, confirmLocalBindingReplacement: true }
    )
    expect(screen.queryByRole('button', { name: 'Check approval' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    expect(teamHub.waitForSecurePeerPairingCompletion).toHaveBeenCalledTimes(1)
    expect(teamHub.waitForSecurePeerPairingCompletion).toHaveBeenCalledWith(
      { profileId: 'profile-peer', profileGeneration: 4, serverIdentity: 'server-peer' },
      { pairingId, expectedTranscriptHash: 'c'.repeat(64), requestId: expect.any(String) }
    )
    await act(async () => completion.resolve(completedControl()))
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(teamHub.refreshSecurePeerPairing).not.toHaveBeenCalled()
    expect(teamHub.securePeerStatus).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(consentKey())).toBeNull()
  })

  it('does not confuse a non-host listener with an active host role', async () => {
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(autoControl({ host: { ...control().host, enabled: true } })),
      requestSecurePeerPairing: vi.fn().mockResolvedValue(autoPairing())
    })
    render(<SecurePeerPanel status={peerStatus} />)
    await join()
    expect(teamHub.requestSecurePeerPairing).toHaveBeenCalledTimes(1)
    expect(teamHub.waitForSecurePeerPairingCompletion).toHaveBeenCalledTimes(1)
  })

  it('keeps unsupported or unaccepted requests on the manual legacy path', async () => {
    const { teamHub } = installAPI({ securePeerStatus: vi.fn().mockResolvedValue(autoControl()) })
    render(<SecurePeerPanel status={peerStatus} />)
    fireEvent.change(await screen.findByLabelText('Server invite'), { target: { value: 'agentsdock://secure-peer/invite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect this server' }))
    expect(await screen.findByRole('button', { name: 'Check approval' })).toBeVisible()
    expect(teamHub.waitForSecurePeerPairingCompletion).not.toHaveBeenCalled()
  })

  it('observes only exact local consent and never polls a supported pending request on mount', async () => {
    const { teamHub } = installAPI({ securePeerStatus: vi.fn().mockResolvedValue(autoControl({ pairings: [autoPairing()] })) })
    render(<SecurePeerPanel status={peerStatus} />)
    expect(await screen.findByRole('button', { name: 'Check approval' })).toBeVisible()
    expect(teamHub.waitForSecurePeerPairingCompletion).not.toHaveBeenCalled()
    expect(teamHub.refreshSecurePeerPairing).not.toHaveBeenCalled()
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
  })

  it('does not duplicate Join/activation under StrictMode or start a renderer polling timer', async () => {
    const completion = deferred<SecurePeerControlStatus>()
    const finish = vi.fn().mockResolvedValue(true)
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(autoControl()), requestSecurePeerPairing: vi.fn().mockResolvedValue(autoPairing()),
      waitForSecurePeerPairingCompletion: vi.fn().mockReturnValue(completion.promise)
    })
    render(<StrictMode><SecurePeerPanel status={peerStatus} onActivated={finish} /></StrictMode>)
    await join()
    const statusReads = teamHub.securePeerStatus.mock.calls.length
    vi.useFakeTimers()
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    vi.useRealTimers()
    expect(teamHub.securePeerStatus).toHaveBeenCalledTimes(statusReads)
    expect(teamHub.waitForSecurePeerPairingCompletion).toHaveBeenCalledTimes(1)
    expect(teamHub.requestSecurePeerPairing).toHaveBeenCalledTimes(1)
    await act(async () => completion.resolve(completedControl()))
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
  })

  it('stops only the current observer on dismissal and resumes the exact request on reopen', async () => {
    const firstCompletion = deferred<SecurePeerControlStatus>()
    const secondCompletion = deferred<SecurePeerControlStatus>()
    const finish = vi.fn().mockResolvedValue(true)
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValueOnce(autoControl()).mockResolvedValue(autoControl({ pairings: [autoPairing()] })),
      requestSecurePeerPairing: vi.fn().mockResolvedValue(autoPairing()),
      waitForSecurePeerPairingCompletion: vi.fn().mockReturnValueOnce(firstCompletion.promise).mockReturnValue(secondCompletion.promise)
    })
    const first = render(<SecurePeerPanel status={peerStatus} onActivated={finish} />)
    await join()
    const input = teamHub.waitForSecurePeerPairingCompletion.mock.calls[0][1]
    first.unmount()
    expect(teamHub.stopSecurePeerPairingCompletionWait).toHaveBeenCalledWith(
      { profileId: 'profile-peer', profileGeneration: 4, serverIdentity: 'server-peer' }, input.requestId
    )
    await act(async () => firstCompletion.resolve(completedControl()))
    expect(finish).not.toHaveBeenCalled()
    expect(localStorage.getItem(consentKey())).toBe('approved')
    render(<SecurePeerPanel status={peerStatus} onActivated={finish} />)
    await screen.findByText('Waiting for host approval')
    expect(teamHub.waitForSecurePeerPairingCompletion).toHaveBeenCalledTimes(2)
    expect(teamHub.requestSecurePeerPairing).toHaveBeenCalledTimes(1)
    await act(async () => secondCompletion.resolve(completedControl()))
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
  })

  it('suppresses late completion immediately when Cancel starts, even if cancellation fails', async () => {
    const completion = deferred<SecurePeerControlStatus>()
    let rejectCancel!: (error: Error) => void
    const cancellation = new Promise<SecurePeerControlStatus>((_resolve, reject) => { rejectCancel = reject })
    const finish = vi.fn()
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(autoControl()), requestSecurePeerPairing: vi.fn().mockResolvedValue(autoPairing()),
      waitForSecurePeerPairingCompletion: vi.fn().mockReturnValue(completion.promise),
      cancelSecurePeerPairing: vi.fn().mockReturnValue(cancellation)
    })
    render(<SecurePeerPanel status={peerStatus} onActivated={finish} />)
    await join()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(teamHub.stopSecurePeerPairingCompletionWait).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(consentKey())).toBeNull()
    await act(async () => { completion.resolve(completedControl()); rejectCancel(new Error('Cancel response unavailable')) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancel response unavailable')
    expect(finish).not.toHaveBeenCalled()
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
  })

  it('ignores a late result after profile or identity changes', async () => {
    const completion = deferred<SecurePeerControlStatus>()
    const finish = vi.fn()
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValueOnce(autoControl()).mockResolvedValue(autoControl({ profileId: 'next-profile', profileGeneration: 5, serverIdentity: 'next-server' })),
      requestSecurePeerPairing: vi.fn().mockResolvedValue(autoPairing()),
      waitForSecurePeerPairingCompletion: vi.fn().mockReturnValue(completion.promise)
    })
    const view = render(<SecurePeerPanel status={peerStatus} onActivated={finish} />)
    await join()
    view.rerender(<SecurePeerPanel status={{ ...peerStatus, profileId: 'next-profile', profileGeneration: 5, serverIdentity: 'next-server' }} onActivated={finish} />)
    await screen.findByLabelText('Server invite')
    await act(async () => completion.resolve(completedControl()))
    expect(teamHub.waitForSecurePeerPairingCompletion).toHaveBeenCalledTimes(1)
    expect(teamHub.stopSecurePeerPairingCompletionWait).toHaveBeenCalledTimes(1)
    expect(finish).not.toHaveBeenCalled()
  })

  it.each(['scope', 'transcript', 'host', 'connection'] as const)('rejects mismatched %s in a completion result', async mismatch => {
    const completion = deferred<SecurePeerControlStatus>()
    const finish = vi.fn()
    installAPI({ securePeerStatus: vi.fn().mockResolvedValue(autoControl()), requestSecurePeerPairing: vi.fn().mockResolvedValue(autoPairing()),
      waitForSecurePeerPairingCompletion: vi.fn().mockReturnValue(completion.promise) })
    render(<SecurePeerPanel status={peerStatus} onActivated={finish} />)
    await join()
    const result = completedControl()
    if (mismatch === 'scope') result.serverIdentity = 'other-server'
    if (mismatch === 'transcript') result.pairings[0].transcriptHash = 'd'.repeat(64)
    if (mismatch === 'host') result.pairings[0].hostServerIdentity = 'other-host'
    if (mismatch === 'connection') result.activeConnectionId = null
    await act(async () => completion.resolve(result))
    expect(await screen.findByRole('alert')).toHaveTextContent('mismatched automatic connection completion')
    expect(finish).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'expired', 'cancelled'] as const)('shows a proven %s request terminal without adopting it', async trustState => {
    const completion = deferred<SecurePeerControlStatus>()
    const finish = vi.fn()
    const { teamHub } = installAPI({ securePeerStatus: vi.fn().mockResolvedValue(autoControl()), requestSecurePeerPairing: vi.fn().mockResolvedValue(autoPairing()),
      waitForSecurePeerPairingCompletion: vi.fn().mockReturnValue(completion.promise) })
    render(<SecurePeerPanel status={peerStatus} onActivated={finish} />)
    await join()
    await act(async () => completion.resolve(autoControl({ pairings: [autoPairing({ trustState, status: trustState === 'cancelled' ? 'error' : trustState })] })))
    expect(await screen.findByLabelText('Server invite')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(trustState)
    expect(screen.queryByText('Waiting for host approval')).not.toBeInTheDocument()
    expect(finish).not.toHaveBeenCalled()
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(localStorage.getItem(consentKey())).toBeNull()
  })

  it.each(['expired', 'cancelled'] as const)('ends automatic %s consent without rewriting retained approved trust or adopting', async state => {
    const completion = deferred<SecurePeerControlStatus>()
    const finish = vi.fn()
    const { teamHub } = installAPI({ securePeerStatus: vi.fn().mockResolvedValue(autoControl()), requestSecurePeerPairing: vi.fn().mockResolvedValue(autoPairing()),
      waitForSecurePeerPairingCompletion: vi.fn().mockReturnValue(completion.promise) })
    render(<SecurePeerPanel status={peerStatus} onActivated={finish} />)
    await join()
    await act(async () => completion.resolve(autoControl({
      pairings: [autoPairing({ status: 'approved', connectionId, hubIdentity: 'hub-team', certificateFingerprint: certificate })],
      pairingCompletion: { pairingId, transcriptHash: 'c'.repeat(64), state }
    })))
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent(state === 'expired' ? 'Automatic connection expired.' : 'Automatic connection stopped.')
    expect(screen.getByText(/Saved and approved/)).toBeVisible()
    expect(localStorage.getItem(consentKey())).toBeNull()
    expect(finish).not.toHaveBeenCalled()
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(teamHub.waitForSecurePeerPairingCompletion).toHaveBeenCalledTimes(1)
  })

  it('keeps observing approved-but-inactive automatic requests without issuing a legacy activation', async () => {
    localStorage.setItem(consentKey(), 'approved')
    const { teamHub } = installAPI({ securePeerStatus: vi.fn().mockResolvedValue(autoControl({ pairings: [autoPairing({
      status: 'approved', connectionId, hubIdentity: 'hub-team', certificateFingerprint: certificate
    })] })) })
    render(<SecurePeerPanel status={peerStatus} />)
    expect(await screen.findByText('Host approved. Finishing connection automatically…')).toBeVisible()
    expect(teamHub.waitForSecurePeerPairingCompletion).toHaveBeenCalledTimes(1)
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument()
  })

  it.each(['connected', 'expired'] as const)('fences an older explicit Refresh snapshot after authoritative %s completion', async state => {
    const refresh = deferred<SecurePeerControlStatus>()
    const completion = deferred<SecurePeerControlStatus>()
    const finish = vi.fn().mockResolvedValue(true)
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValueOnce(autoControl()).mockReturnValue(refresh.promise),
      requestSecurePeerPairing: vi.fn().mockResolvedValue(autoPairing()),
      waitForSecurePeerPairingCompletion: vi.fn().mockImplementationOnce(() => new Promise(() => undefined)).mockReturnValue(completion.promise)
    })
    render(<SecurePeerPanel status={peerStatus} onActivated={finish} />)
    await join()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    await waitFor(() => expect(teamHub.waitForSecurePeerPairingCompletion).toHaveBeenCalledTimes(2))
    await act(async () => {
      completion.resolve(state === 'connected' ? completedControl() : autoControl({
        pairings: [autoPairing({ status: 'expired' })]
      }))
      refresh.resolve(autoControl({ pairings: [autoPairing()] }))
    })
    expect(screen.queryByText('Waiting for host approval')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh connection status' })).toBeEnabled()
    if (state === 'connected') await waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
    else {
      expect(screen.getByLabelText('Server invite')).toBeVisible()
      expect(screen.getByRole('status')).toHaveTextContent('request expired')
      expect(finish).not.toHaveBeenCalled()
    }
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
  })
})

describe('SecurePeerPanel', () => {
  it('switches host approval copy without changing names, pairing codes or request counts', async () => {
    const incoming = pairing({ direction: 'incoming', peerDisplayName: 'Exact QA server' })
    const { teamHub } = installAPI({ securePeerStatus: vi.fn().mockResolvedValue(control({
      profileId: hostStatus.profileId, serverIdentity: hostStatus.serverIdentity!, pairings: [incoming]
    })) })
    render(<SecurePeerPanel status={hostStatus} details={details} workspace={workspace} />)
    await screen.findByRole('button', { name: 'Approve' })
    const counts = Object.fromEntries(Object.entries(teamHub).map(([key, fn]) => [key, vi.mocked(fn).mock.calls.length]))
    act(() => setLocale('zh-CN'))
    expect(screen.getByRole('button', { name: '批准' })).toBeDisabled()
    expect(screen.getByLabelText('六词配对码')).toHaveTextContent(incoming.sasWords.join(''))
    expect(screen.getByText('Exact QA server')).toBeVisible()
    expect(screen.getByRole('button', { name: '刷新连接状态' })).toBeEnabled()
    act(() => setLocale('en'))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(Object.fromEntries(Object.entries(teamHub).map(([key, fn]) => [key, vi.mocked(fn).mock.calls.length]))).toEqual(counts)
  })

  it('switches a saved local error message without retrying the failed operation', async () => {
    const { teamHub, native } = installAPI()
    native.readClipboard.mockRejectedValue(null)
    render(<SecurePeerPanel status={peerStatus} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Paste invite' }))
    await screen.findByText('Server connection failed.')
    act(() => setLocale('zh-CN'))
    expect(screen.getByText('服务器连接失败。')).toBeVisible()
    expect(native.readClipboard).toHaveBeenCalledTimes(1)
    expect(teamHub.securePeerStatus).toHaveBeenCalledTimes(1)
  })
  it('gives a fresh designated host one reachable-address field and one Copy invite link path', async () => {
    const link = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=${encodeURIComponent(fingerprint)}`
    const enabled = control({
      profileId: hostStatus.profileId,
      serverIdentity: hostStatus.serverIdentity!,
      host: {
        ...control().host,
        enabled: true,
        advertisedHost: '100.64.0.1',
        advertisedHosts: ['100.64.0.1'],
        pairingLink: link,
        caFingerprint: fingerprint
      }
    })
    const { teamHub, native } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({ profileId: hostStatus.profileId, serverIdentity: hostStatus.serverIdentity! })),
      configureSecurePeerHost: vi.fn().mockResolvedValue(enabled)
    })
    render(<SecurePeerPanel status={hostStatus} workspace={workspace} details={details} />)

    const address = await screen.findByLabelText('Reachable server address')
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeDisabled()
    expect(screen.queryByLabelText('Server invite')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect this server' })).not.toBeInTheDocument()

    fireEvent.change(address, { target: { value: '100.64.0.1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy invite link' }))

    await waitFor(() => expect(teamHub.configureSecurePeerHost).toHaveBeenCalledWith(
      { profileId: 'profile-host', profileGeneration: 4, serverIdentity: 'server-host' },
      { enabled: true, advertisedHost: '100.64.0.1', listenPort: 7851 }
    ))
    expect(native.writeClipboard).toHaveBeenCalledWith(link)
    expect(await screen.findByRole('button', { name: 'Invite link copied' })).toBeVisible()
  })

  it('gives a peer only Paste invite and Connect this server with fixed V1 access', async () => {
    const link = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=${encodeURIComponent(fingerprint)}`
    const { teamHub, native } = installAPI()
    native.readClipboard.mockResolvedValue(link)
    render(<SecurePeerPanel status={peerStatus} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Paste invite' }))
    await waitFor(() => expect(screen.getByLabelText('Server invite')).toHaveValue(link))
    expect(screen.getByText(/current local network stays saved/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: /copy invite link/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connect this server' }))

    await waitFor(() => expect(teamHub.requestSecurePeerPairing).toHaveBeenCalledWith(
      { profileId: 'profile-peer', profileGeneration: 4, serverIdentity: 'server-peer' },
      { host: link, displayName: 'Studio', requestedScopes: ['teamspace.read', 'teamspace.write'] }
    ))
    expect(screen.queryByLabelText('Server invite')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect this server' })).not.toBeInTheDocument()
    expect(screen.queryByText(/agent route|channel|dispatch|attachment/i)).not.toBeInTheDocument()
  })

  it('does not offer another invite while a live request or unmatched active connection exists', async () => {
    const waiting = pairing({ status: 'pending_approval' })
    const api = installAPI({ securePeerStatus: vi.fn().mockResolvedValue(control({ pairings: [waiting] })) })
    const view = render(<SecurePeerPanel status={peerStatus} />)

    expect(await screen.findByText('Compare these six words with the host. After they approve, choose Check approval to finish connecting this server.')).toBeVisible()
    expect(screen.queryByLabelText('Server invite')).not.toBeInTheDocument()
    expect(api.teamHub.requestSecurePeerPairing).not.toHaveBeenCalled()

    api.teamHub.securePeerStatus.mockResolvedValue(control({
      profileGeneration: 5,
      activeConnectionId: connectionId,
      pairings: []
    }))
    view.rerender(<SecurePeerPanel status={{ ...peerStatus, profileGeneration: 5 }} />)

    expect(await screen.findByText('Connection needs attention')).toBeVisible()
    expect(screen.queryByLabelText('Server invite')).not.toBeInTheDocument()
  })

  it('publishes base status while pending refreshes settle and preserves successful refreshes when another fails', async () => {
    const first = pairing({
      id: '19d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      peerDisplayName: 'Studio one'
    })
    const second = pairing({
      id: '29d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      peerDisplayName: 'Studio two',
      peerServerIdentity: 'server-host-two',
      hostServerIdentity: 'server-host-two'
    })
    const secondRefresh = deferred<SecurePeerPairing>()
    const refreshSecurePeerPairing = vi.fn((_scope, id: string) => (
      id === first.id
        ? Promise.reject(new Error('First pairing refresh failed'))
        : secondRefresh.promise
    ))
    installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({ pairings: [first, second] })),
      refreshSecurePeerPairing
    })
    render(<SecurePeerPanel status={peerStatus} />)

    expect(await screen.findByText('Studio one')).toBeVisible()
    expect(screen.getByText('Studio two')).toBeVisible()
    expect(refreshSecurePeerPairing).toHaveBeenCalledTimes(2)

    await act(async () => {
      secondRefresh.resolve(pairing({
        ...second,
        status: 'approved',
        trustState: 'approved'
      }))
      await Promise.resolve()
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('First pairing refresh failed')
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeVisible()
    expect(screen.getByText('Studio one')).toBeVisible()
  })

  it.each([true, false])('keeps Check approval behind connection consent with background reconnect %s', async backgroundReconnectAllowed => {
    const pending = pairing()
    const approved = pairing({ status: 'approved', connectionId, hubIdentity: 'hub-team', certificateFingerprint: certificate })
    const finish = vi.fn().mockResolvedValue(true)
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({ pairings: [pending] })),
      refreshSecurePeerPairing: vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(approved),
      activateSecurePeerPairing: vi.fn().mockResolvedValue(control({
        activeConnectionId: connectionId,
        pairings: [{ ...approved, status: 'connected', transportState: 'online' }]
      }))
    })
    render(<SecurePeerPanel status={{ ...peerStatus, backgroundReconnectAllowed }} onActivated={finish} />)
    const check = await screen.findByRole('button', { name: 'Check approval' })
    await waitFor(() => expect(check).toBeEnabled())
    fireEvent.click(check)
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeEnabled()
    expect(teamHub.refreshSecurePeerPairing).toHaveBeenCalledTimes(2)
    expect(teamHub.refreshSecurePeerPairing).toHaveBeenLastCalledWith(
      { profileId: 'profile-peer', profileGeneration: 4, serverIdentity: 'server-peer' }, pairingId
    )
    expect(teamHub.securePeerStatus).toHaveBeenCalledTimes(1)
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
    expect(teamHub.activateSecurePeerPairing).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('finishes a requested connection after Check approval with background reconnect %s', async backgroundReconnectAllowed => {
    const approved = pairing({ status: 'approved', connectionId, hubIdentity: 'hub-team', certificateFingerprint: certificate })
    const finish = vi.fn().mockResolvedValue(true)
    const { teamHub } = installAPI({
      refreshSecurePeerPairing: vi.fn().mockResolvedValue(approved),
      activateSecurePeerPairing: vi.fn().mockResolvedValue(control({
        activeConnectionId: connectionId,
        pairings: [{ ...approved, status: 'connected', transportState: 'online' }]
      }))
    })
    render(<SecurePeerPanel status={{ ...peerStatus, backgroundReconnectAllowed }} onActivated={finish} />)
    fireEvent.change(await screen.findByLabelText('Server invite'), { target: { value: 'agentsdock://secure-peer/invite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect this server' }))
    const check = await screen.findByRole('button', { name: 'Check approval' })
    fireEvent.click(check)
    fireEvent.click(check)
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
    expect(teamHub.refreshSecurePeerPairing).toHaveBeenCalledTimes(1)
    expect(teamHub.activateSecurePeerPairing).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(window.localStorage).toHaveLength(0))
  })

  it('discards a delayed Check approval result after the selected server changes', async () => {
    const pending = pairing()
    const checked = deferred<SecurePeerPairing>()
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValueOnce(control({ pairings: [pending] })).mockResolvedValue(control({
        profileId: 'profile-next', profileGeneration: 5, serverIdentity: 'server-next'
      })),
      refreshSecurePeerPairing: vi.fn().mockResolvedValueOnce(pending).mockImplementationOnce(() => checked.promise)
    })
    const finish = vi.fn()
    const view = render(<SecurePeerPanel status={peerStatus} onActivated={finish} />)
    const check = await screen.findByRole('button', { name: 'Check approval' })
    await waitFor(() => expect(check).toBeEnabled())
    fireEvent.click(check)
    view.rerender(<SecurePeerPanel status={{ ...peerStatus, profileId: 'profile-next', profileGeneration: 5, serverIdentity: 'server-next' }} onActivated={finish} />)
    await screen.findByLabelText('Server invite')
    await act(async () => checked.resolve(pairing({ status: 'approved', connectionId, hubIdentity: 'hub-team', peerDisplayName: 'Stale host' })))
    expect(screen.queryByText('Stale host')).not.toBeInTheDocument()
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
  })

  it('does not replace another active connection when checking a consented request with background reconnect off', async () => {
    const pending = pairing()
    const approved = pairing({ status: 'approved', connectionId, hubIdentity: 'hub-team', certificateFingerprint: certificate })
    const otherConnectionId = '32e7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const other = pairing({
      id: '42e7bb2e-3b47-4be7-89fc-2cecd90f4434', status: 'connected',
      connectionId: otherConnectionId, hubIdentity: 'other-hub', hostServerIdentity: 'other-host', peerDisplayName: 'Other host'
    })
    window.localStorage.setItem(`agentsdock.secure-peer.connect-consent.v2:${JSON.stringify([
      peerStatus.profileId, peerStatus.serverIdentity, pending.id, pending.hostServerIdentity, pending.transcriptHash
    ])}`, 'approved')
    const finish = vi.fn()
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({ activeConnectionId: otherConnectionId, pairings: [pending, other] })),
      refreshSecurePeerPairing: vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(approved)
    })
    render(<SecurePeerPanel status={{ ...peerStatus, backgroundReconnectAllowed: false }} onActivated={finish} />)
    const check = await screen.findByRole('button', { name: 'Check approval' })
    await waitFor(() => expect(check).toBeEnabled())
    fireEvent.click(check)
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeDisabled()
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
    expect(window.localStorage).toHaveLength(1)
  })

  it('shows one recovery state instead of marking an unhealthy active connection as connected', async () => {
    const stale = pairing({
      status: 'connected',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write']
    })
    installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({
        activeConnectionId: connectionId,
        connectionError: 'Peer authentication is unavailable',
        pairings: [stale]
      }))
    })
    render(<SecurePeerPanel
      status={peerStatus}
      networkError="The active secure peer connection is unavailable."
    />)

    expect(await screen.findByText('Connection needs attention')).toBeVisible()
    expect(screen.getByText('Peer authentication is unavailable')).toBeVisible()
    expect(screen.queryByText('The active secure peer connection is unavailable.')).not.toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeVisible()
  })

  it('does not claim an online peer tunnel is connected before Teamspace adoption finishes', async () => {
    const active = pairing({
      status: 'connected',
      trustState: 'approved',
      transportState: 'online',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write'],
      lastSeenAt: '2026-08-28T12:00:00Z'
    })
    const retryConnection = vi.fn().mockResolvedValue(true)
    installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({
        activeConnectionId: connectionId,
        pairings: [active]
      }))
    })

    render(<SecurePeerPanel
      status={{
        ...peerStatus,
        authenticated: false,
        authenticationMode: undefined,
        principal: null,
        session: null,
        connectionState: 'signed-out',
        backgroundReconnectAllowed: false,
        error: null
      }}
      onRetryConnection={retryConnection}
    />)

    expect(await screen.findByText('Teamspace connection incomplete')).toBeVisible()
    expect(screen.getByText(/secure server link is online/i)).toBeVisible()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(retryConnection).toHaveBeenCalledTimes(1))
  })

  it('does not claim a peer is connected when Teamspace authenticated through a different route', async () => {
    const active = pairing({
      status: 'connected',
      trustState: 'approved',
      transportState: 'online',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write'],
      lastSeenAt: '2026-08-28T12:00:00Z'
    })
    installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({
        activeConnectionId: connectionId,
        pairings: [active]
      }))
    })

    render(<SecurePeerPanel
      status={{ ...peerStatus, connectionId: 'different-connection' }}
      onRetryConnection={vi.fn().mockResolvedValue(true)}
    />)

    expect(await screen.findByText('Teamspace connection incomplete')).toBeVisible()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  })

  it('disables peer mutations while the parent Teamspace adoption request is in flight', async () => {
    const activePairing = pairing({
      status: 'connected',
      trustState: 'approved',
      transportState: 'online',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write'],
      lastSeenAt: '2026-08-28T12:00:00Z'
    })
    const active = control({ activeConnectionId: connectionId, pairings: [activePairing] })
    const retry = vi.fn().mockResolvedValue(false)
    const firstAPI = installAPI({ securePeerStatus: vi.fn().mockResolvedValue(active) })
    const strandedStatus: TeamHubStatus = {
      ...peerStatus,
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null,
      connectionState: 'connecting',
      backgroundReconnectAllowed: true
    }
    const first = render(<SecurePeerPanel
      status={strandedStatus}
      connectionAttemptInFlight
      onRetryConnection={retry}
    />)

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Leave network…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(firstAPI.teamHub.deactivateSecurePeerConnection).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()

    first.unmount()
    const approved = pairing({
      status: 'approved',
      trustState: 'approved',
      transportState: 'disconnected',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate
    })
    installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({ pairings: [approved] }))
    })
    render(<SecurePeerPanel status={strandedStatus} connectionAttemptInFlight />)

    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeDisabled()
  })

  it('keeps a fresh peer invite clean when unrelated local Teamspace restoration failed', async () => {
    installAPI({ securePeerStatus: vi.fn().mockResolvedValue(control()) })
    render(<SecurePeerPanel
      status={{
        ...peerStatus,
        authenticated: false,
        authenticationMode: undefined,
        principal: null,
        session: null,
        connectionState: 'offline',
        error: 'Legacy plaintext Direct IP Teamspace bindings are no longer supported.'
      }}
      networkError="Legacy plaintext Direct IP Teamspace bindings are no longer supported."
    />)

    expect(await screen.findByLabelText('Server invite')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Connect this server' })).toBeVisible()
    expect(screen.queryByText('Legacy plaintext Direct IP Teamspace bindings are no longer supported.')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('prefills a canonical deep-link invite for a peer without connecting until the button is pressed', async () => {
    const link = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=${encodeURIComponent(fingerprint)}`
    const handled = vi.fn()
    const { teamHub } = installAPI()

    render(<SecurePeerPanel
      status={peerStatus}
      initialInvite={link}
      initialInviteRequestId={7}
      onInitialInviteHandled={handled}
    />)

    expect(await screen.findByLabelText('Server invite')).toHaveValue(link)
    expect(handled).not.toHaveBeenCalled()
    expect(teamHub.requestSecurePeerPairing).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Connect this server' }))
    await waitFor(() => expect(teamHub.requestSecurePeerPairing).toHaveBeenCalledWith(
      { profileId: 'profile-peer', profileGeneration: 4, serverIdentity: 'server-peer' },
      { host: link, displayName: 'Studio', requestedScopes: ['teamspace.read', 'teamspace.write'] }
    ))
    await waitFor(() => expect(handled).toHaveBeenCalledWith(7))
  })

  it('does not consume or expose a peer deep-link invite on a designated host', async () => {
    const link = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=${encodeURIComponent(fingerprint)}`
    const handled = vi.fn()
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({ profileId: hostStatus.profileId, serverIdentity: hostStatus.serverIdentity! }))
    })

    render(<SecurePeerPanel
      status={hostStatus}
      workspace={workspace}
      details={details}
      initialInvite={link}
      initialInviteRequestId={8}
      onInitialInviteHandled={handled}
    />)

    expect(await screen.findByRole('button', { name: 'Copy invite link' })).toBeVisible()
    expect(screen.queryByLabelText('Server invite')).not.toBeInTheDocument()
    expect(handled).not.toHaveBeenCalled()
    expect(teamHub.requestSecurePeerPairing).not.toHaveBeenCalled()
  })

  it('auto-activates an exactly preauthorized pairing, consumes consent, and stays disconnected after remount', async () => {
    const pending = pairing()
    const approved = pairing({
      status: 'approved',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write']
    })
    const active = control({ activeConnectionId: connectionId, pairings: [{ ...approved, status: 'connected' }] })
    const disconnected = control({ pairings: [approved] })
    const securePeerStatus = vi.fn().mockResolvedValueOnce(control()).mockResolvedValue(disconnected)
    const { teamHub } = installAPI({
      securePeerStatus,
      requestSecurePeerPairing: vi.fn().mockResolvedValue(pending),
      activateSecurePeerPairing: vi.fn().mockResolvedValue(active),
      deactivateSecurePeerConnection: vi.fn().mockResolvedValue(disconnected)
    })
    const connectedWorkspace = vi.fn().mockResolvedValue(true)
    const first = render(<SecurePeerPanel status={peerStatus} onActivated={connectedWorkspace} />)

    fireEvent.change(await screen.findByLabelText('Server invite'), { target: { value: 'agentsdock://secure-peer/invite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect this server' }))
    await waitFor(() => expect(teamHub.requestSecurePeerPairing).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))

    await waitFor(() => expect(teamHub.activateSecurePeerPairing).toHaveBeenCalledWith(
      { profileId: 'profile-peer', profileGeneration: 4, serverIdentity: 'server-peer' },
      {
        pairingId,
        expectedConnectionId: connectionId,
        expectedHostServerIdentity: 'server-host',
        expectedHubIdentity: 'hub-team',
        confirmLocalBindingReplacement: true
      }
    ))
    expect(connectedWorkspace).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(window.localStorage).toHaveLength(0))
    expect(await screen.findByRole('button', { name: 'Leave network…' })).toBeVisible()
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(teamHub.deactivateSecurePeerConnection).toHaveBeenCalledTimes(1))

    first.unmount()
    installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(disconnected),
      activateSecurePeerPairing: teamHub.activateSecurePeerPairing
    })
    render(<SecurePeerPanel status={peerStatus} />)
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeVisible()
    await new Promise(resolve => window.setTimeout(resolve, 20))
    expect(teamHub.activateSecurePeerPairing).toHaveBeenCalledTimes(1)
  })

  it('adopts an already-active route once even without a saved binding or recognized startup error', async () => {
    const approved = pairing({
      status: 'connected',
      trustState: 'approved',
      transportState: 'online',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write'],
      lastSeenAt: '2026-08-28T12:00:00Z'
    })
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({
        activeConnectionId: connectionId,
        pairings: [approved]
      }))
    })
    const finish = vi.fn().mockResolvedValue(true)

    render(<SecurePeerPanel
      status={{
        ...peerStatus,
        authenticated: false,
        backgroundReconnectAllowed: false,
        connectionState: 'unavailable',
        principal: null,
        session: null,
        error: 'Paired Teamspace session is not ready.'
      }}
      networkError="Paired Teamspace session is not ready."
      onActivated={finish}
    />)

    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(window.localStorage).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    await new Promise(resolve => window.setTimeout(resolve, 20))
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('does not reactivate a disconnected route with stale consent after a persisted disconnect tombstone', async () => {
    const approved = pairing({
      status: 'approved',
      trustState: 'approved',
      transportState: 'disconnected',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write'],
      lastSeenAt: '2026-08-28T12:00:00Z'
    })
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({
        activeConnectionId: null,
        pairings: [approved]
      }))
    })
    const finish = vi.fn().mockResolvedValue(true)
    window.localStorage.setItem(
      `agentsdock.secure-peer.connect-consent.v2:${JSON.stringify([
        peerStatus.profileId,
        peerStatus.serverIdentity,
        approved.id,
        approved.hostServerIdentity,
        approved.transcriptHash
      ])}`,
      'approved'
    )

    render(<SecurePeerPanel
      status={{
        ...peerStatus,
        authenticated: false,
        backgroundReconnectAllowed: false,
        connectionState: 'unavailable',
        principal: null,
        session: null,
        error: 'This AgentsServer is not the designated Team Hub host.'
      }}
      networkError="This AgentsServer is not the designated Team Hub host."
      onActivated={finish}
    />)

    await waitFor(() => expect(teamHub.securePeerStatus).toHaveBeenCalled())
    await new Promise(resolve => window.setTimeout(resolve, 20))
    expect(finish).not.toHaveBeenCalled()
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(window.localStorage).toHaveLength(1)
  })

  it('honors explicit Disconnect after Team Hub completion fails without automatically reactivating', async () => {
    const pending = pairing()
    const approved = pairing({
      status: 'approved',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write']
    })
    const active = control({
      activeConnectionId: connectionId,
      pairings: [{ ...approved, status: 'connected', transportState: 'online', lastSeenAt: '2026-08-28T12:00:00Z' }]
    })
    const disconnected = control({
      pairings: [{ ...approved, lastSeenAt: '2026-08-28T12:00:30Z' }]
    })
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn()
        .mockResolvedValueOnce(control())
        .mockResolvedValue(control({ pairings: [approved] })),
      requestSecurePeerPairing: vi.fn().mockResolvedValue(pending),
      activateSecurePeerPairing: vi.fn().mockResolvedValue(active),
      deactivateSecurePeerConnection: vi.fn().mockResolvedValue(disconnected)
    })
    const finishFailed = vi.fn().mockResolvedValue(false)
    const view = render(<SecurePeerPanel status={peerStatus} onActivated={finishFailed} />)

    fireEvent.change(await screen.findByLabelText('Server invite'), { target: { value: 'agentsdock://secure-peer/invite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect this server' }))
    await waitFor(() => expect(teamHub.requestSecurePeerPairing).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    await waitFor(() => expect(teamHub.activateSecurePeerPairing).toHaveBeenCalledTimes(1))
    expect(finishFailed).toHaveBeenCalledTimes(1)
    expect(window.localStorage).toHaveLength(1)

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(teamHub.deactivateSecurePeerConnection).toHaveBeenCalledTimes(1))
    // The completed Disconnect removes activation consent but leaves a sticky
    // suppression for lagging active snapshots and future remounts.
    expect(window.localStorage).toHaveLength(1)
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeVisible()
    await new Promise(resolve => window.setTimeout(resolve, 20))
    expect(teamHub.activateSecurePeerPairing).toHaveBeenCalledTimes(1)
    expect(finishFailed).toHaveBeenCalledTimes(1)

    view.unmount()
    const lagging = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(active)
    })
    render(<SecurePeerPanel
      status={{
        ...peerStatus,
        authenticated: false,
        authenticationMode: undefined,
        principal: null,
        session: null,
        connectionState: 'disconnected',
        backgroundReconnectAllowed: false
      }}
      onActivated={finishFailed}
    />)

    await waitFor(() => expect(lagging.teamHub.securePeerStatus).toHaveBeenCalled())
    await new Promise(resolve => window.setTimeout(resolve, 20))
    expect(finishFailed).toHaveBeenCalledTimes(1)
  })

  it('allows leaving an approved connection after Disconnect without reconnecting it', async () => {
    const activePairing = pairing({
      status: 'connected',
      trustState: 'approved',
      transportState: 'online',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write'],
      lastSeenAt: '2026-08-28T12:00:00Z'
    })
    const active = control({ activeConnectionId: connectionId, pairings: [activePairing] })
    const disconnected = control({
      pairings: [{ ...activePairing, status: 'approved', transportState: 'disconnected' }]
    })
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(active),
      deactivateSecurePeerConnection: vi.fn().mockResolvedValue(disconnected),
      forgetSecurePeerConnection: vi.fn()
        .mockRejectedValueOnce(new Error('The host is offline.'))
        .mockResolvedValue(control())
    })

    render(<SecurePeerPanel status={peerStatus} onConnectionChanged={vi.fn()} />)

    await screen.findByRole('button', { name: 'Disconnect' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh connection status' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(teamHub.deactivateSecurePeerConnection).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Leave network…' }))
    expect(screen.getByText(/host must be reachable to revoke access first/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm leave' }))
    expect(await screen.findByText('The host is offline.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm leave' }))
    await waitFor(() => expect(teamHub.forgetSecurePeerConnection).toHaveBeenCalledTimes(2))
    expect(teamHub.forgetSecurePeerConnection).toHaveBeenLastCalledWith(
      { profileId: 'profile-peer', profileGeneration: 4, serverIdentity: 'server-peer' },
      { connectionId, expectedHostServerIdentity: 'server-host', expectedHubIdentity: 'hub-team', expectedCertificateFingerprint: certificate }
    )
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
  })

  it('does not poll and only refreshes status on explicit request', async () => {
    vi.useFakeTimers()
    const first = deferred<SecurePeerControlStatus>()
    const second = deferred<SecurePeerControlStatus>()
    const securePeerStatus = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValue(control())
    installAPI({ securePeerStatus })

    const view = render(<SecurePeerPanel status={peerStatus} />)
    expect(securePeerStatus).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(securePeerStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve(control())
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(securePeerStatus).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    expect(securePeerStatus).toHaveBeenCalledTimes(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(securePeerStatus).toHaveBeenCalledTimes(2)

    view.unmount()
    await act(async () => {
      second.resolve(control())
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(securePeerStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed Disconnect suppressed across remount until explicit Try again', async () => {
    const activePairing = pairing({
      status: 'connected',
      trustState: 'approved',
      transportState: 'online',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write'],
      lastSeenAt: '2026-08-28T12:00:00Z'
    })
    const active = control({ activeConnectionId: connectionId, pairings: [activePairing] })
    const failed = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(active),
      deactivateSecurePeerConnection: vi.fn().mockRejectedValue(new Error('Deactivate failed'))
    })
    const strandedStatus: TeamHubStatus = {
      ...peerStatus,
      authenticated: false,
      authenticationMode: undefined,
      principal: null,
      session: null,
      connectionState: 'disconnected',
      backgroundReconnectAllowed: false
    }
    const first = render(<SecurePeerPanel
      status={peerStatus}
      onActivated={vi.fn().mockResolvedValue(false)}
    />)

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByText('Deactivate failed')).toBeVisible()
    expect(failed.teamHub.deactivateSecurePeerConnection).toHaveBeenCalledTimes(1)
    expect(window.localStorage).toHaveLength(1)

    first.unmount()
    const finish = vi.fn().mockResolvedValue(false)
    const retry = vi.fn().mockResolvedValue(true)
    const restored = installAPI({ securePeerStatus: vi.fn().mockResolvedValue(active) })
    render(<SecurePeerPanel
      status={strandedStatus}
      onActivated={finish}
      onRetryConnection={retry}
    />)

    await waitFor(() => expect(restored.teamHub.securePeerStatus).toHaveBeenCalled())
    await new Promise(resolve => window.setTimeout(resolve, 20))
    expect(finish).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
    expect(window.localStorage).toHaveLength(0)
  })

  it('consumes unfinished consent when explicit Try again completes Team Hub adoption', async () => {
    const pending = pairing()
    const approved = pairing({
      status: 'approved',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write']
    })
    let currentControl = control()
    const activeOffline = control({
      activeConnectionId: connectionId,
      pairings: [{ ...approved, status: 'connected', transportState: 'offline' }]
    })
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockImplementation(() => Promise.resolve(currentControl)),
      requestSecurePeerPairing: vi.fn().mockResolvedValue(pending),
      refreshSecurePeerPairing: vi.fn().mockResolvedValue(approved),
      activateSecurePeerPairing: vi.fn().mockImplementation(async () => {
        currentControl = activeOffline
        return activeOffline
      })
    })
    const finishFailed = vi.fn().mockResolvedValue(false)
    const retrySucceeded = vi.fn().mockResolvedValue(true)
    render(<SecurePeerPanel
      status={peerStatus}
      onActivated={finishFailed}
      onRetryConnection={retrySucceeded}
    />)

    fireEvent.change(await screen.findByLabelText('Server invite'), { target: { value: 'agentsdock://secure-peer/invite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect this server' }))
    await waitFor(() => expect(teamHub.requestSecurePeerPairing).toHaveBeenCalledTimes(1))
    currentControl = control({ pairings: [pending] })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    await waitFor(() => expect(finishFailed).toHaveBeenCalledTimes(1))
    expect(window.localStorage).toHaveLength(1)

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(retrySucceeded).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(window.localStorage).toHaveLength(0))
  })

  it('keeps explicit consent across profile generation changes until Team Hub finishes connecting', async () => {
    const pending = pairing()
    const approved = pairing({
      status: 'approved',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write']
    })
    const firstAPI = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control()),
      requestSecurePeerPairing: vi.fn().mockResolvedValue(pending)
    })
    const first = render(<SecurePeerPanel status={peerStatus} />)

    fireEvent.change(await screen.findByLabelText('Server invite'), { target: { value: 'agentsdock://secure-peer/invite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect this server' }))
    await waitFor(() => expect(firstAPI.teamHub.requestSecurePeerPairing).toHaveBeenCalledTimes(1))
    expect(window.localStorage).toHaveLength(1)
    first.unmount()

    const nextStatus = { ...peerStatus, profileGeneration: peerStatus.profileGeneration + 1 }
    const activeOffline = control({
      profileGeneration: nextStatus.profileGeneration,
      activeConnectionId: connectionId,
      pairings: [{ ...approved, status: 'connected', transportState: 'offline' }]
    })
    const finishFailed = vi.fn().mockResolvedValue(false)
    const secondAPI = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({
        profileGeneration: nextStatus.profileGeneration,
        pairings: [approved]
      })),
      activateSecurePeerPairing: vi.fn().mockResolvedValue(activeOffline)
    })
    const second = render(<SecurePeerPanel status={nextStatus} onActivated={finishFailed} />)

    await waitFor(() => expect(secondAPI.teamHub.activateSecurePeerPairing).toHaveBeenCalledWith(
      { profileId: 'profile-peer', profileGeneration: 5, serverIdentity: 'server-peer' },
      expect.objectContaining({ pairingId })
    ))
    expect(finishFailed).toHaveBeenCalledTimes(1)
    expect(window.localStorage).toHaveLength(1)
    second.unmount()

    const finalStatus = { ...nextStatus, profileGeneration: nextStatus.profileGeneration + 1 }
    const finishSucceeded = vi.fn().mockResolvedValue(true)
    const finalAPI = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({
        profileGeneration: finalStatus.profileGeneration,
        pairings: [approved]
      })),
      activateSecurePeerPairing: vi.fn().mockResolvedValue(control({
        profileGeneration: finalStatus.profileGeneration,
        activeConnectionId: connectionId,
        pairings: [{ ...approved, status: 'connected', transportState: 'online' }]
      }))
    })
    render(<SecurePeerPanel status={finalStatus} onActivated={finishSucceeded} />)

    await waitFor(() => expect(finalAPI.teamHub.activateSecurePeerPairing).toHaveBeenCalledWith(
      { profileId: 'profile-peer', profileGeneration: 6, serverIdentity: 'server-peer' },
      expect.objectContaining({ pairingId })
    ))
    expect(finishSucceeded).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(window.localStorage).toHaveLength(0))
  })

  it('retries unfinished Team Hub completion only on fresh online heartbeats and stops at the bound', async () => {
    const pending = pairing()
    const approved = pairing({
      status: 'approved',
      connectionId,
      hubIdentity: 'hub-team',
      certificateFingerprint: certificate,
      grantedScopes: ['teamspace.read', 'teamspace.write']
    })
    let currentControl = control()
    const securePeerStatus = vi.fn().mockImplementation(() => Promise.resolve(currentControl))
    const finish = vi.fn().mockResolvedValue(false)
    const activeOffline = control({
      activeConnectionId: connectionId,
      pairings: [{ ...approved, status: 'connected', transportState: 'offline' }]
    })
    const { teamHub } = installAPI({
      securePeerStatus,
      requestSecurePeerPairing: vi.fn().mockResolvedValue(pending),
      refreshSecurePeerPairing: vi.fn().mockResolvedValue(approved),
      activateSecurePeerPairing: vi.fn().mockResolvedValue(activeOffline)
    })
    const view = render(<SecurePeerPanel status={peerStatus} onActivated={finish} />)

    fireEvent.change(await screen.findByLabelText('Server invite'), { target: { value: 'agentsdock://secure-peer/invite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect this server' }))
    await waitFor(() => expect(teamHub.requestSecurePeerPairing).toHaveBeenCalledTimes(1))
    currentControl = control({ pairings: [pending] })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    await waitFor(() => expect(teamHub.activateSecurePeerPairing).toHaveBeenCalledTimes(1))
    expect(finish).toHaveBeenCalledTimes(1)

    currentControl = control({
      profileGeneration: peerStatus.profileGeneration + 1,
      activeConnectionId: connectionId,
      pairings: [{ ...approved, status: 'connected', transportState: 'online', lastSeenAt: '2026-08-28T12:00:00Z' }]
    })
    view.rerender(<SecurePeerPanel status={{ ...peerStatus, profileGeneration: peerStatus.profileGeneration + 1 }} onActivated={finish} />)
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    await new Promise(resolve => window.setTimeout(resolve, 20))
    expect(finish).toHaveBeenCalledTimes(2)

    currentControl = control({
      profileGeneration: peerStatus.profileGeneration + 1,
      activeConnectionId: connectionId,
      pairings: [{ ...approved, status: 'connected', transportState: 'online', lastSeenAt: '2026-08-28T12:00:30Z' }]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(3))
    currentControl = control({
      profileGeneration: peerStatus.profileGeneration + 1,
      activeConnectionId: connectionId,
      pairings: [{ ...approved, status: 'connected', transportState: 'online', lastSeenAt: '2026-08-28T12:01:00Z' }]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    await new Promise(resolve => window.setTimeout(resolve, 20))
    expect(finish).toHaveBeenCalledTimes(3)
    expect(teamHub.activateSecurePeerPairing).toHaveBeenCalledTimes(1)
    expect(window.localStorage).toHaveLength(1)
  })

  it('uses explicit Reconnect consent to finish automatically after a later online heartbeat', async () => {
    const approved = pairing({ status: 'approved', connectionId, hubIdentity: 'hub-team', certificateFingerprint: certificate })
    let currentControl = control({ pairings: [approved] })
    const activeOffline = control({
      activeConnectionId: connectionId,
      pairings: [{ ...approved, status: 'connected', transportState: 'offline' }]
    })
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockImplementation(() => Promise.resolve(currentControl)),
      activateSecurePeerPairing: vi.fn().mockImplementation(async () => {
        currentControl = activeOffline
        return activeOffline
      })
    })
    const finish = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<SecurePeerPanel status={peerStatus} onActivated={finish} />)

    const reconnect = await screen.findByRole('button', { name: 'Reconnect' })
    expect(screen.getAllByText(/current local network stays saved/i)).not.toHaveLength(0)
    expect(teamHub.activateSecurePeerPairing).not.toHaveBeenCalled()
    fireEvent.click(reconnect)

    await waitFor(() => expect(teamHub.activateSecurePeerPairing).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ pairingId, confirmLocalBindingReplacement: true })
    ))
    expect(finish).toHaveBeenCalledTimes(1)
    expect(window.localStorage).toHaveLength(1)

    currentControl = control({
      activeConnectionId: connectionId,
      pairings: [{ ...approved, status: 'connected', transportState: 'online', lastSeenAt: '2026-08-28T12:00:00Z' }]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(window.localStorage).toHaveLength(0))
  })

  it('shows one logical server card and suppresses a stale revoked certificate after replacement', async () => {
    const revoked = pairing({
      id: '19d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      status: 'revoked',
      trustState: 'revoked',
      transportState: 'revoked',
      teamId: 'team-1',
      hubIdentity: 'hub-team',
      connectionId: '32e7bb2e-3b47-4be7-89fc-2cecd90f4434',
      certificateFingerprint: fingerprint,
      certificateExpiresAt: '2027-01-01T00:00:00Z'
    })
    const replacement = pairing({
      id: '29d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      status: 'approved',
      trustState: 'approved',
      transportState: 'disconnected',
      teamId: 'team-1',
      hubIdentity: 'hub-team',
      connectionId,
      certificateFingerprint: certificate,
      certificateExpiresAt: '2028-01-01T00:00:00Z'
    })
    installAPI({ securePeerStatus: vi.fn().mockResolvedValue(control({ pairings: [revoked, replacement] })) })
    render(<SecurePeerPanel status={peerStatus} />)

    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeVisible()
    expect(screen.getAllByText('TargetApp')).toHaveLength(1)
    expect(screen.queryByText(/host revoked this server/i)).not.toBeInTheDocument()
  })

  it('keeps a remote-revoked tombstone visible until explicit Forget succeeds', async () => {
    const revoked = pairing({
      status: 'revoked',
      trustState: 'revoked',
      transportState: 'revoked',
      teamId: 'team-1',
      hubIdentity: 'hub-team',
      connectionId,
      certificateFingerprint: certificate
    })
    const { teamHub } = installAPI({ securePeerStatus: vi.fn().mockResolvedValue(control({ pairings: [revoked] })) })
    render(<SecurePeerPanel status={peerStatus} />)

    expect(await screen.findByText(/host revoked this server/i)).toBeVisible()
    expect(screen.queryByLabelText('Server invite')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Forget local connection…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm forget' }))

    await waitFor(() => expect(teamHub.forgetSecurePeerConnection).toHaveBeenCalledWith(
      { profileId: 'profile-peer', profileGeneration: 4, serverIdentity: 'server-peer' },
      {
        connectionId,
        expectedHostServerIdentity: 'server-host',
        expectedHubIdentity: 'hub-team',
        expectedCertificateFingerprint: certificate
      }
    ))
  })

  it('uses transport liveness for active labels and never calls reconnecting or offline Connected', async () => {
    const reconnecting = pairing({
      status: 'connected',
      trustState: 'approved',
      transportState: 'reconnecting',
      teamId: 'team-1',
      hubIdentity: 'hub-team',
      connectionId,
      localProxyBasePath: `/api/team-hub-secure/${connectionId}`,
      certificateFingerprint: certificate
    })
    const offline = { ...reconnecting, transportState: 'offline' as const }
    const securePeerStatus = vi.fn()
      .mockResolvedValueOnce(control({ activeConnectionId: connectionId, pairings: [reconnecting] }))
      .mockResolvedValue(control({ activeConnectionId: connectionId, pairings: [offline] }))
    installAPI({ securePeerStatus })
    render(<SecurePeerPanel status={peerStatus} />)

    expect(await screen.findByText('Reconnecting')).toBeVisible()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Leave network…' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh connection status' }))
    expect(await screen.findByText('Offline')).toBeVisible()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.getByText(/within 90 seconds/i)).toBeVisible()
  })

  it('renders typed host recovery guidance and disables invites even if available is true', async () => {
    const hostControl = control({
      profileId: hostStatus.profileId,
      serverIdentity: hostStatus.serverIdentity!,
      host: {
        ...control().host,
        available: true,
        error: 'An existing secure peer connection could not be reconciled safely.',
        errorCode: 'peer_identity_conflict',
        action: 'Review or remove the conflicting logical server connection, then retry host recovery.'
      }
    })
    installAPI({ securePeerStatus: vi.fn().mockResolvedValue(hostControl) })
    render(<SecurePeerPanel status={hostStatus} workspace={workspace} details={details} />)

    expect(await screen.findByText('Conflicting server connection records')).toBeVisible()
    expect(screen.getByText(/review or remove the conflicting logical server connection/i)).toBeVisible()
    expect(screen.getByText('peer_identity_conflict')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeDisabled()
  })

  it('accurately warns and confirms before turning off hosting and taking peers offline', async () => {
    const enabled = control({
      profileId: hostStatus.profileId,
      serverIdentity: hostStatus.serverIdentity!,
      host: {
        ...control().host,
        enabled: true,
        advertisedHost: '100.64.0.1',
        advertisedHosts: ['100.64.0.1'],
        pairingLink: 'agentsdock://secure-peer/join',
        caFingerprint: fingerprint
      }
    })
    const disabled = control({
      ...enabled,
      host: { ...enabled.host, enabled: false, pairingLink: null }
    })
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(enabled),
      configureSecurePeerHost: vi.fn().mockResolvedValue(disabled)
    })
    render(<SecurePeerPanel status={hostStatus} workspace={workspace} details={details} />)

    fireEvent.click(await screen.findByText('Advanced / Manage'))
    fireEvent.click(screen.getByRole('button', { name: 'Turn off secure peer hosting…' }))

    expect(teamHub.configureSecurePeerHost).not.toHaveBeenCalled()
    expect(screen.getByRole('group', { name: 'Turn off secure peer hosting' })).toHaveTextContent(
      'stops accepting invites and takes connected peer servers offline'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Turn off & take peers offline' }))
    await waitFor(() => expect(teamHub.configureSecurePeerHost).toHaveBeenCalledWith(
      { profileId: 'profile-host', profileGeneration: 4, serverIdentity: 'server-host' },
      { enabled: false }
    ))
    expect(screen.queryByRole('group', { name: 'Turn off secure peer hosting' })).not.toBeInTheDocument()
  })

  it('requires an exact six-word comparison before a host approval', async () => {
    const incoming = pairing({ direction: 'incoming', peerServerIdentity: 'server-peer', peerDisplayName: 'Studio' })
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({ profileId: hostStatus.profileId, serverIdentity: hostStatus.serverIdentity!, pairings: [incoming] }))
    })
    render(<SecurePeerPanel status={hostStatus} workspace={workspace} details={details} />)

    expect(await screen.findByText('amber')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'The six words match.' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(teamHub.approveSecurePeerPairing).toHaveBeenCalledWith(
      { profileId: 'profile-host', profileGeneration: 4, serverIdentity: 'server-host' },
      {
        pairingId,
        teamId: 'team-1',
        expectedPeerServerIdentity: 'server-peer',
        expectedTranscriptHash: 'c'.repeat(64),
        scopes: ['teamspace.read', 'teamspace.write'],
        sasConfirmed: true
      }
    ))
  })

  it('refreshes approved host peers and the parent directory once after successful approval', async () => {
    const incoming = pairing({ direction: 'incoming', peerServerIdentity: 'server-peer', peerDisplayName: 'Studio' })
    const approved = pairing({ ...incoming, status: 'approved', trustState: 'approved', transportState: 'offline', connectionId, hubIdentity: 'hub-team', certificateFingerprint: certificate })
    const base = control({ profileId: hostStatus.profileId, serverIdentity: hostStatus.serverIdentity!, pairings: [incoming] })
    const approval = deferred<SecurePeerControlStatus>()
    const refreshDirectory = vi.fn().mockResolvedValue(undefined)
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(base),
      securePeers: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([approved]),
      approveSecurePeerPairing: vi.fn().mockImplementation(() => approval.promise)
    })
    render(<SecurePeerPanel status={hostStatus} workspace={workspace} details={details} onConnectionChanged={refreshDirectory} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'The six words match.' }))
    const approve = screen.getByRole('button', { name: 'Approve' })
    await waitFor(() => expect(approve).toBeEnabled())
    fireEvent.click(approve)
    fireEvent.click(approve)
    expect(refreshDirectory).not.toHaveBeenCalled()
    expect(teamHub.approveSecurePeerPairing).toHaveBeenCalledTimes(1)
    await act(async () => approval.resolve({ ...base, pairings: [approved] }))
    await waitFor(() => expect(refreshDirectory).toHaveBeenCalledTimes(1))
    expect(teamHub.securePeers).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.getByText('Studio')).toBeVisible()
    expect(screen.getByText('Approved · waiting for this server to connect.')).toBeVisible()
    expect(screen.queryByText('Offline · the heartbeat lease expired.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Revoke access' })).not.toBeVisible()
    expect(screen.getByText(approved.transcriptHash)).not.toBeVisible()
  })

  it.each([
    ['online', 'approved', 'Online · heartbeat is current.'],
    ['offline', 'approved', 'Offline · the heartbeat lease expired.'],
    ['reconnecting', 'approved', 'Reconnecting · the server is retrying automatically.'],
    ['revoked', 'revoked', 'Access revoked. This certificate is no longer trusted.']
  ] as const)('keeps a host %s server row visible with truthful status and collapsed technical details', async (transportState, trustState, label) => {
    const peer = pairing({
      direction: 'incoming', peerServerIdentity: 'server-peer', peerDisplayName: 'Studio',
      status: trustState === 'revoked' ? 'revoked' : 'approved', trustState, transportState,
      connectionId, hubIdentity: 'hub-team', certificateFingerprint: certificate, lastSeenAt: '2026-09-09T12:00:00Z'
    })
    installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(control({ profileId: hostStatus.profileId, serverIdentity: hostStatus.serverIdentity! })),
      securePeers: vi.fn().mockResolvedValue([peer])
    })
    render(<SecurePeerPanel status={hostStatus} workspace={workspace} details={details} />)
    expect(await screen.findByText('Studio')).toBeVisible()
    expect(screen.getByText(label)).toBeVisible()
    expect(screen.getByText(peer.transcriptHash)).not.toBeVisible()
    if (trustState === 'approved') expect(screen.getByRole('button', { name: 'Revoke access' })).not.toBeVisible()
    else expect(screen.queryByRole('button', { name: 'Revoke access' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Connection details'))
    expect(screen.getByText(peer.transcriptHash)).toBeVisible()
    if (trustState === 'approved') expect(screen.getByRole('button', { name: 'Revoke access' })).toBeVisible()
    else expect(screen.queryByRole('button', { name: 'Revoke access' })).not.toBeInTheDocument()
  })

  it.each(['peers', 'directory'] as const)('reports a %s refresh failure as already approved and retries only the lists', async failure => {
    const incoming = pairing({ direction: 'incoming', peerServerIdentity: 'server-peer', peerDisplayName: 'Studio' })
    const approved = pairing({ ...incoming, status: 'approved', trustState: 'approved', connectionId, hubIdentity: 'hub-team', certificateFingerprint: certificate })
    const base = control({ profileId: hostStatus.profileId, serverIdentity: hostStatus.serverIdentity!, pairings: [incoming] })
    const refreshDirectory = vi.fn().mockImplementationOnce(() => failure === 'directory'
      ? Promise.reject(new Error('Directory unavailable')) : Promise.resolve()).mockResolvedValue(undefined)
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValue(base),
      securePeers: vi.fn().mockResolvedValueOnce([]).mockImplementationOnce(() => failure === 'peers'
        ? Promise.reject(new Error('Peers unavailable')) : Promise.resolve([approved])).mockResolvedValue([approved]),
      approveSecurePeerPairing: vi.fn().mockResolvedValue({ ...base, pairings: [approved] })
    })
    render(<SecurePeerPanel status={hostStatus} workspace={workspace} details={details} onConnectionChanged={refreshDirectory} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'The six words match.' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Approval succeeded, but the server list could not be refreshed:')
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh server list' }))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(teamHub.approveSecurePeerPairing).toHaveBeenCalledTimes(1)
    expect(refreshDirectory).toHaveBeenCalledTimes(2)
  })

  it.each(['profile', 'team'] as const)('discards a late approval before refreshing a different %s', async changed => {
    const incoming = pairing({ direction: 'incoming', peerServerIdentity: 'server-peer', peerDisplayName: 'Old peer' })
    const base = control({ profileId: hostStatus.profileId, serverIdentity: hostStatus.serverIdentity!, pairings: [incoming] })
    const approval = deferred<SecurePeerControlStatus>()
    const refreshDirectory = vi.fn()
    const { teamHub } = installAPI({
      securePeerStatus: vi.fn().mockResolvedValueOnce(base).mockResolvedValue({ ...base, pairings: [] }),
      approveSecurePeerPairing: vi.fn().mockImplementation(() => approval.promise)
    })
    const view = render(<SecurePeerPanel status={hostStatus} workspace={workspace} details={details} onConnectionChanged={refreshDirectory} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'The six words match.' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    const nextStatus = changed === 'profile' ? { ...hostStatus, profileId: 'next-profile', profileGeneration: 5, serverIdentity: 'next-server' } : hostStatus
    const nextDetails = changed === 'team' ? { ...details, team: { ...details.team, id: 'next-team' } } : details
    view.rerender(<SecurePeerPanel status={nextStatus} workspace={{ ...workspace, status: nextStatus }} details={nextDetails} onConnectionChanged={refreshDirectory} />)
    await waitFor(() => expect(teamHub.securePeerStatus).toHaveBeenCalledTimes(2))
    const peersBefore = teamHub.securePeers.mock.calls.length
    await act(async () => approval.resolve({ ...base, pairings: [pairing({ ...incoming, status: 'approved', trustState: 'approved' })] }))
    expect(refreshDirectory).not.toHaveBeenCalled()
    expect(teamHub.securePeers).toHaveBeenCalledTimes(peersBefore)
    expect(screen.queryByText('Old peer')).not.toBeInTheDocument()
  })

  it('ignores a stale status response after the profile changes', async () => {
    const old = deferred<SecurePeerControlStatus>()
    const nextControl = control({ profileId: 'profile-next', serverIdentity: 'server-next' })
    const securePeerStatus = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(nextControl)
    installAPI({ securePeerStatus })
    const view = render(<SecurePeerPanel status={peerStatus} />)
    const nextStatus = { ...peerStatus, profileId: 'profile-next', profileGeneration: 5, serverIdentity: 'server-next' }
    view.rerender(<SecurePeerPanel status={nextStatus} />)

    expect(await screen.findByLabelText('Server invite')).toBeVisible()
    old.resolve(control({ pairings: [pairing({ peerDisplayName: 'Stale server' })] }))
    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(screen.queryByText('Stale server')).not.toBeInTheDocument()
  })

  it('does not let a stale profile poll unlock the current profile poll', async () => {
    vi.useFakeTimers()
    const old = deferred<SecurePeerControlStatus>()
    const current = deferred<SecurePeerControlStatus>()
    const nextControl = control({ profileId: 'profile-next', serverIdentity: 'server-next' })
    const securePeerStatus = vi.fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise)
      .mockResolvedValue(nextControl)
    installAPI({ securePeerStatus })
    const view = render(<SecurePeerPanel status={peerStatus} />)
    await act(async () => { await Promise.resolve() })

    const nextStatus = { ...peerStatus, profileId: 'profile-next', profileGeneration: 5, serverIdentity: 'server-next' }
    view.rerender(<SecurePeerPanel status={nextStatus} />)
    await act(async () => { await Promise.resolve() })
    expect(securePeerStatus).toHaveBeenCalledTimes(2)

    await act(async () => {
      old.resolve(control())
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(securePeerStatus).toHaveBeenCalledTimes(2)

    await act(async () => {
      current.resolve(nextControl)
      await Promise.resolve()
    })
    expect(screen.getByLabelText('Server invite')).toBeVisible()
  })
})
