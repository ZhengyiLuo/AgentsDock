import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { SecurePeerControlStatus, SecurePeerPairing } from '@shared/secure-peer'
import type { TeamHubStatus } from '@shared/team-hub'
import { setLocale } from '@shared/i18n'
import { SecurePeerHostAddressAction, TeamNetworkHostAddressAction } from './SecurePeerHostAddress'
import { SecurePeerPanel } from './SecurePeerPanel'
import { useAppStore } from '../store/app-store'

const status: TeamHubStatus = {
  version: 1, profileId: 'profile-peer', profileGeneration: 4, serverIdentity: 'server-peer',
  serverName: 'Studio', generation: 2, hubUrl: 'http://127.0.0.1:7850/api/team-hub-secure/connection-1',
  hubIdentity: 'hub-team', savedHubIdentity: null, transport: 'secure_peer', designatedHost: false,
  availabilityMessage: 'Host offline', availabilityAction: null, canForgetBinding: false,
  backgroundReconnectAllowed: false, connectionState: 'offline', authenticated: false,
  bootstrapRequired: false, principal: null, session: null, error: 'Host offline',
  connectionId: 'connection-1', hostServerIdentity: 'server-host'
}

const pairing: SecurePeerPairing = {
  id: 'pairing-1', direction: 'outgoing', status: 'approved', trustState: 'approved', transportState: 'offline',
  peerServerIdentity: 'server-host', peerDisplayName: 'Team host', remoteEndpoint: '100.64.0.1:7851',
  hostServerIdentity: 'server-host', hostCaFingerprint: `sha256:${'a'.repeat(64)}`,
  peerPublicKeyFingerprint: `sha256:${'b'.repeat(64)}`, transcriptHash: 'c'.repeat(64),
  sasWords: ['amber', 'birch', 'cobalt', 'delta', 'ember', 'forest'],
  requestedScopes: ['teamspace.read', 'teamspace.write'], grantedScopes: ['teamspace.read', 'teamspace.write'],
  teamId: 'team-1', teamDisplayName: 'Core team', hubIdentity: 'hub-team', connectionId: 'connection-1',
  localProxyBasePath: '/api/team-hub-secure/connection-1', certificateExpiresAt: '2027-01-01T00:00:00Z',
  certificateFingerprint: `sha256:${'d'.repeat(64)}`, lastSeenAt: null, expiresAt: null, error: null
}

function control(overrides: Partial<SecurePeerControlStatus> = {}): SecurePeerControlStatus {
  return {
    version: 2, endpointUpdateAvailable: true, heartbeatIntervalSeconds: 30, leaseSeconds: 90,
    profileId: status.profileId, profileGeneration: status.profileGeneration, serverIdentity: status.serverIdentity!,
    serverInstanceId: 'instance-1', activeConnectionId: pairing.connectionId, remoteRouteDeliveryAvailable: false,
    connectionError: 'Host offline', host: {
      available: true, enabled: false, listenPort: 7851, advertisedHost: null, advertisedHosts: [],
      caFingerprint: null, pairingLink: null, certificateExpiresAt: null, error: null, errorCode: null, action: null
    },
    pairings: [pairing], remoteRoutes: [], publishedRoutes: [], ...overrides
  }
}

function updatedControl(): SecurePeerControlStatus {
  return control({ connectionError: null, pairings: [{ ...pairing, remoteEndpoint: '100.64.0.9:8851', transportState: 'online' }] })
}

function installAPI(snapshot = control()) {
  const api = {
    securePeerStatus: vi.fn().mockResolvedValue(snapshot),
    updateSecurePeerConnectionEndpoint: vi.fn().mockResolvedValue(updatedControl()),
    requestSecurePeerPairing: vi.fn(), activateSecurePeerPairing: vi.fn(),
    forgetSecurePeerConnection: vi.fn(), mailbox: vi.fn(), messages: vi.fn()
  }
  window.agentsDock = { teamHub: api } as unknown as AgentsDockAPI
  return api
}

async function openEditor() {
  fireEvent.click(await screen.findByRole('button', { name: 'Change host address' }))
  return screen.findByRole('dialog', { name: 'Change host address' })
}

function changeAddress(dialog: HTMLElement, value = '100.64.0.9:8851') {
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Host address (IP[:port])' }), { target: { value } })
}

beforeEach(() => {
  setLocale('en')
  useAppStore.setState({ activeProfileId: status.profileId, profileGeneration: status.profileGeneration, switchingProfileId: null, profiles: [] })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); setLocale('en') })

describe('Change host address', () => {
  it('recovers an offline current host through one explicitly saved, immutable request', async () => {
    const api = installAPI()
    const onUpdated = vi.fn()
    let finish!: (value: SecurePeerControlStatus) => void
    api.updateSecurePeerConnectionEndpoint.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<TeamNetworkHostAddressAction status={status} onUpdated={onUpdated} />)
    const dialog = await openEditor()
    expect(within(dialog).getByRole('textbox')).toHaveValue(pairing.remoteEndpoint)
    expect(within(dialog).queryByText(/rejoin|sign up|forget/i)).not.toBeInTheDocument()
    changeAddress(dialog)
    expect(api.updateSecurePeerConnectionEndpoint).not.toHaveBeenCalled()
    expect(api.securePeerStatus).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    fireEvent.submit(within(dialog).getByRole('textbox').closest('form')!)
    expect(api.updateSecurePeerConnectionEndpoint).toHaveBeenCalledExactlyOnceWith({
      profileId: status.profileId, profileGeneration: status.profileGeneration, serverIdentity: status.serverIdentity
    }, {
      connectionId: pairing.connectionId, expectedHostServerIdentity: pairing.hostServerIdentity,
      expectedHubIdentity: pairing.hubIdentity, expectedServerInstanceId: 'instance-1',
      expectedRemoteEndpoint: pairing.remoteEndpoint, host: '100.64.0.9:8851', confirmed: true
    })
    expect(screen.getByTitle('Current host address: 100.64.0.1:7851')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Saving…' })).toBeDisabled()
    await act(async () => { finish(updatedControl()) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTitle('Current host address: 100.64.0.9:8851')).toBeInTheDocument()
    expect(onUpdated).toHaveBeenCalledTimes(1)
    expect(api.requestSecurePeerPairing).not.toHaveBeenCalled()
    expect(api.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(api.forgetSecurePeerConnection).not.toHaveBeenCalled()
    expect(api.mailbox).not.toHaveBeenCalled()
    expect(api.messages).not.toHaveBeenCalled()
  })

  it('retains the old endpoint and draft after a failed pinned TLS check', async () => {
    const api = installAPI()
    api.updateSecurePeerConnectionEndpoint.mockRejectedValue(new Error('Pinned host certificate does not match.'))
    const onUpdated = vi.fn()
    render(<TeamNetworkHostAddressAction status={status} onUpdated={onUpdated} />)
    const dialog = await openEditor()
    changeAddress(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Pinned host certificate does not match.')
    expect(within(dialog).getByRole('textbox')).toHaveValue('100.64.0.9:8851')
    expect(screen.getByTitle('Current host address: 100.64.0.1:7851')).toBeInTheDocument()
    expect(onUpdated).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('cancels without changing the endpoint or contacting the candidate', async () => {
    const api = installAPI()
    render(<TeamNetworkHostAddressAction status={status} onUpdated={vi.fn()} />)
    let dialog = await openEditor()
    changeAddress(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.updateSecurePeerConnectionEndpoint).not.toHaveBeenCalled()
    dialog = await openEditor()
    expect(within(dialog).getByRole('textbox')).toHaveValue(pairing.remoteEndpoint)
  })

  it('explains that an old AgentsServer needs an update without attempting migration', async () => {
    const api = installAPI(control({ endpointUpdateAvailable: undefined }))
    render(<TeamNetworkHostAddressAction status={status} onUpdated={vi.fn()} />)
    const dialog = await openEditor()
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Update this AgentsServer to change a saved host address.')
    expect(within(dialog).getByRole('textbox')).toHaveValue(pairing.remoteEndpoint)
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(api.updateSecurePeerConnectionEndpoint).not.toHaveBeenCalled()
  })

  it('closes the editor and discards an in-flight response after profile selection changes', async () => {
    const api = installAPI()
    const onUpdated = vi.fn()
    let finish!: (value: SecurePeerControlStatus) => void
    api.updateSecurePeerConnectionEndpoint.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<TeamNetworkHostAddressAction status={status} onUpdated={onUpdated} />)
    const dialog = await openEditor()
    changeAddress(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    act(() => useAppStore.setState({ activeProfileId: 'different-profile', profileGeneration: 5 }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => { finish(updatedControl()) })
    expect(onUpdated).not.toHaveBeenCalled()
    expect(screen.queryByTitle('Current host address: 100.64.0.9:8851')).not.toBeInTheDocument()
  })

  it('discards an in-flight result when a different current connection is selected', async () => {
    const api = installAPI()
    const onUpdated = vi.fn()
    let finish!: (value: SecurePeerControlStatus) => void
    api.updateSecurePeerConnectionEndpoint.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = render(<TeamNetworkHostAddressAction status={status} onUpdated={onUpdated} />)
    const dialog = await openEditor()
    changeAddress(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    view.rerender(<TeamNetworkHostAddressAction status={{ ...status, connectionId: 'different-connection' }} onUpdated={onUpdated} />)
    await act(async () => { finish(updatedControl()) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('rejects an invalid IP before IPC and rejects a changed host pin in the response', async () => {
    const api = installAPI()
    const next = updatedControl()
    api.updateSecurePeerConnectionEndpoint.mockResolvedValue({ ...next, pairings: [{ ...next.pairings[0], hostCaFingerprint: 'different-pin' }] })
    const onUpdated = vi.fn()
    render(<TeamNetworkHostAddressAction status={status} onUpdated={onUpdated} />)
    const dialog = await openEditor()
    changeAddress(dialog, 'https://host.example.test')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a literal IPv4 address')
    expect(api.updateSecurePeerConnectionEndpoint).not.toHaveBeenCalled()
    changeAddress(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('The updated host address could not be verified.'))
    expect(onUpdated).not.toHaveBeenCalled()
    expect(screen.getByTitle('Current host address: 100.64.0.1:7851')).toBeInTheDocument()
  })

  it('offers the same editor on an inactive approved saved connection', async () => {
    const api = installAPI(control({ activeConnectionId: null, connectionError: null }))
    const onConnectionChanged = vi.fn()
    render(<SecurePeerPanel status={{ ...status, connectionId: undefined, transport: null }} onConnectionChanged={onConnectionChanged} />)
    const dialog = await openEditor()
    changeAddress(dialog)
    api.updateSecurePeerConnectionEndpoint.mockResolvedValue({ ...updatedControl(), activeConnectionId: null })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onConnectionChanged).toHaveBeenCalledTimes(1))
    expect(api.activateSecurePeerPairing).not.toHaveBeenCalled()
    expect(api.requestSecurePeerPairing).not.toHaveBeenCalled()
    expect(screen.getByTitle('Current host address: 100.64.0.9:8851')).toBeInTheDocument()
  })

  it('does not offer migration for pending or revoked trust', () => {
    installAPI()
    const view = render(<SecurePeerHostAddressAction control={control()} pairing={{ ...pairing, trustState: 'pending' }} onUpdated={vi.fn()} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    view.rerender(<SecurePeerHostAddressAction control={control()} pairing={{ ...pairing, trustState: 'revoked' }} onUpdated={vi.fn()} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('rejects an unchanged canonical address and a stale selected profile before submission', async () => {
    const api = installAPI()
    render(<TeamNetworkHostAddressAction status={status} onUpdated={vi.fn()} />)
    const dialog = await openEditor()
    changeAddress(dialog, '100.64.0.1')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a different host address.')
    expect(api.updateSecurePeerConnectionEndpoint).not.toHaveBeenCalled()
    act(() => useAppStore.setState({ switchingProfileId: 'different-profile' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change host address' })).not.toBeInTheDocument()
    expect(api.updateSecurePeerConnectionEndpoint).not.toHaveBeenCalled()
  })
})
