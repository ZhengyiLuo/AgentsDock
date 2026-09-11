import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { trackEvent } from '../lib/analytics'
import { ServerManagement } from './ServerManagement'

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }))

const alpha: PublicServerProfile = {
  id: 'alpha',
  name: 'Alpha',
  serverUrl: 'https://alpha.example:7850',
  serverIdentity: 'server-alpha',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'online',
  cachedUnreadCount: 0
}

const beta: PublicServerProfile = {
  id: 'beta',
  name: 'Beta',
  serverUrl: 'https://beta.example:7850',
  serverIdentity: 'server-beta',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'cached',
  cachedUnreadCount: 2
}

const gamma: PublicServerProfile = {
  ...beta,
  id: 'gamma',
  name: 'Gamma',
  serverUrl: 'https://gamma.example:7850',
  serverIdentity: 'server-gamma'
}

describe('ServerManagement', () => {
  const list = vi.fn()
  const add = vi.fn()
  const update = vi.fn()
  const remove = vi.fn()
  const reorder = vi.fn()
  const testConnection = vi.fn()
  const switchServer = vi.fn()

  beforeEach(() => {
    vi.mocked(trackEvent).mockClear()
    list.mockReset().mockResolvedValue([alpha, beta])
    add.mockReset().mockResolvedValue(beta)
    update.mockReset().mockResolvedValue(alpha)
    remove.mockReset().mockResolvedValue(true)
    reorder.mockReset().mockResolvedValue([beta, alpha])
    testConnection.mockReset().mockResolvedValue({ ok: true, server_identity: 'server-beta' })
    switchServer.mockReset().mockImplementation(async (profileId: string) => {
      useAppStore.setState(state => ({ activeProfileId: profileId, profileGeneration: state.profileGeneration + 1 }))
      return true
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { servers: { list, add, update, remove, reorder, testConnection } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      profiles: [alpha],
      activeProfileId: alpha.id,
      profileGeneration: 1,
      switchingProfileId: null,
      switchServer
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('tests a new connection, saves the profile, and switches without reloading', async () => {
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('Name on this Mac'), 'Beta')
    await user.type(screen.getByLabelText('Server URL'), 'https://beta.example:7850')
    await user.type(screen.getByLabelText('Access token'), 'private-token')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    await waitFor(() => expect(testConnection).toHaveBeenCalledWith({
      profileId: undefined,
      serverUrl: 'https://beta.example:7850',
      accessToken: 'private-token'
    }))
    expect(await screen.findByText('Connected · server-beta')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add & switch' }))
    await waitFor(() => expect(add).toHaveBeenCalledWith({
      name: 'Beta',
      serverUrl: 'https://beta.example:7850',
      accessToken: 'private-token',
      serverIdentity: 'server-beta',
      serverSetupComplete: true
    }))
    expect(switchServer).toHaveBeenCalledWith('beta')
    expect(screen.queryByRole('button', { name: 'Add & switch' })).not.toBeInTheDocument()
  })

  it('shows an unavailable health response as a failed connection test', async () => {
    testConnection.mockResolvedValueOnce({ ok: false })
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('Server URL'), 'https://offline.example:7850')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText('Server health check reported unavailable.')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add & switch' })).toBeDisabled()
  })

  it('reveals and focuses the editor when Add server is clicked directly', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Add server' }))

    expect(screen.getByLabelText('Name on this Mac')).toHaveFocus()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('reuses the saved profile when a URL alias resolves to its canonical identity', async () => {
    testConnection.mockResolvedValueOnce({ ok: true, server_identity: alpha.serverIdentity })
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('Name on this Mac'), 'Alpha alias')
    await user.type(screen.getByLabelText('Server URL'), 'https://alpha-alias.example:7850')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText('Already saved as “Alpha”')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Use Alpha' }))

    await waitFor(() => expect(switchServer).toHaveBeenCalledWith(alpha.id))
    expect(add).not.toHaveBeenCalled()
  })

  it('protects the active profile and requires confirmation before removing another profile', async () => {
    useAppStore.setState({ profiles: [alpha, beta] })
    list.mockResolvedValue([alpha])
    const user = userEvent.setup()
    render(<ServerManagement />)

    expect(screen.getByRole('button', { name: 'Cannot remove active server Alpha' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Remove Beta' }))
    expect(remove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remove Beta' }))

    await waitFor(() => expect(remove).toHaveBeenCalledWith('beta'))
    expect(useAppStore.getState().activeProfileId).toBe('alpha')
    expect(useAppStore.getState().profiles.map(profile => profile.id)).toEqual(['alpha'])
  })

  it('gives every server activation action a target-specific accessible name', () => {
    useAppStore.setState({ profiles: [alpha, beta, gamma] })

    render(<ServerManagement />)

    expect(screen.getByRole('button', { name: 'Use Beta' })).toHaveTextContent('Use')
    expect(screen.getByRole('button', { name: 'Use Gamma' })).toHaveTextContent('Use')
    expect(screen.queryByRole('button', { name: 'Use Alpha' })).not.toBeInTheDocument()
  })

  it('shows switching progress and closes Settings after the requested server is active', async () => {
    let finishSwitch!: () => void
    switchServer.mockImplementationOnce(() => new Promise<boolean>(resolve => {
      finishSwitch = () => {
        useAppStore.setState(state => ({ activeProfileId: beta.id, profileGeneration: state.profileGeneration + 1 }))
        resolve(true)
      }
    }))
    useAppStore.setState(state => ({
      profiles: [alpha, beta],
      modals: { ...state.modals, settings: true }
    }))
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Use Beta' }))
    expect(screen.getByRole('button', { name: 'Switching to Beta' })).toHaveTextContent('Switching…')
    expect(useAppStore.getState().modals.settings).toBe(true)

    finishSwitch()
    await waitFor(() => expect(useAppStore.getState().modals.settings).toBe(false))
    expect(useAppStore.getState().activeProfileId).toBe(beta.id)
  })

  it('keeps Settings open and explains a failed server activation inline', async () => {
    switchServer.mockRejectedValueOnce(new Error('Server did not answer'))
    useAppStore.setState(state => ({
      profiles: [alpha, beta],
      modals: { ...state.modals, settings: true }
    }))
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Use Beta' }))

    expect(await screen.findByText('Server did not answer')).toHaveClass('server-management-error')
    expect(useAppStore.getState().modals.settings).toBe(true)
    expect(screen.getByRole('button', { name: 'Use Beta' })).toBeEnabled()
  })

  it('shows reachability independently from the single active selection', () => {
    useAppStore.setState({
      profiles: [alpha, { ...beta, connectionState: 'online' }],
      activeProfileId: alpha.id
    })

    render(<ServerManagement />)

    expect(screen.getAllByRole('img', { name: 'Online' })).toHaveLength(2)
    expect(screen.getAllByText('Active')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Use Beta' })).toBeEnabled()
  })

  it('shows an inactive degraded server and its tmux warning in amber', () => {
    const message = 'tmux is missing; terminal sessions and detached updates are unavailable.'
    useAppStore.setState({
      profiles: [alpha, { ...beta, connectionState: 'degraded', lastConnectionError: message }],
      activeProfileId: alpha.id
    })

    render(<ServerManagement />)

    expect(screen.getByRole('img', { name: `Degraded: ${message}` })).toHaveClass('degraded')
    expect(screen.getByText(message)).toHaveClass('server-management-warning')
    expect(screen.getAllByText('Active')).toHaveLength(1)
  })

  it('shows the last known server version with the canonical identity', () => {
    useAppStore.setState({ profiles: [{ ...alpha, serverVersion: '1.4.2' }] })

    render(<ServerManagement />)

    expect(screen.getByText('Identity: server-alpha · AgentsServer 1.4.2')).toBeInTheDocument()
  })

  it('persists profile order returned by the main process', async () => {
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Move Beta up' }))

    await waitFor(() => expect(reorder).toHaveBeenCalledWith(['beta', 'alpha']))
    expect(useAppStore.getState().profiles.map(profile => profile.id)).toEqual(['beta', 'alpha'])
  })

  it('does not reconnect the active server for a name-only edit', async () => {
    list.mockResolvedValue([{ ...alpha, name: 'Renamed Alpha' }])
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Edit Alpha' }))
    await user.clear(screen.getByLabelText('Name on this Mac'))
    await user.type(screen.getByLabelText('Name on this Mac'), 'Renamed Alpha')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('alpha', { name: 'Renamed Alpha' }))
    expect(switchServer).not.toHaveBeenCalled()
  })

  it('reopens an active profile through the guarded store switch after a connection edit', async () => {
    list.mockResolvedValue([{ ...alpha, serverUrl: 'https://new-alpha.example:7850' }])
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Edit Alpha' }))
    await user.clear(screen.getByLabelText('Server URL'))
    await user.type(screen.getByLabelText('Server URL'), 'https://new-alpha.example:7850')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(switchServer).toHaveBeenCalledWith('alpha', true, { serverUrl: 'https://new-alpha.example:7850' }))
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps an active connection edit pending until the guarded store switch completes', async () => {
    list.mockResolvedValue([{ ...alpha, serverUrl: 'https://new-alpha.example:7850' }])
    let releaseSwitch!: () => void
    switchServer.mockImplementationOnce(() => new Promise<boolean>(resolve => {
      releaseSwitch = () => {
        useAppStore.setState(state => ({ profileGeneration: state.profileGeneration + 1 }))
        resolve(true)
      }
    }))
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Edit Alpha' }))
    await user.clear(screen.getByLabelText('Server URL'))
    await user.type(screen.getByLabelText('Server URL'), 'https://new-alpha.example:7850')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(switchServer).toHaveBeenCalledWith('alpha', true, { serverUrl: 'https://new-alpha.example:7850' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(update).not.toHaveBeenCalled()
    releaseSwitch()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument())
  })

  it('invalidates a successful connection test as soon as connection inputs change', async () => {
    let resolveTest!: (value: { ok: true; server_identity: string }) => void
    testConnection.mockImplementation(() => new Promise(resolve => { resolveTest = resolve }))
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('Server URL'), 'https://first.example:7850')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await user.clear(screen.getByLabelText('Server URL'))
    await user.type(screen.getByLabelText('Server URL'), 'https://second.example:7850')
    resolveTest({ ok: true, server_identity: 'first-server' })

    await waitFor(() => expect(testConnection).toHaveBeenCalled())
    expect(screen.queryByText(/Connected · first-server/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add & switch' })).toBeDisabled()
  })

  it('requires explicit confirmation before clearing a changed canonical identity', async () => {
    const changed = { ...alpha, lastConnectionError: 'Server identity changed from server-alpha to server-new.' }
    useAppStore.setState({ profiles: [changed] })
    list.mockResolvedValue([{ ...changed, serverIdentity: null, lastConnectionError: null }])
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Edit Alpha' }))
    const confirmation = screen.getByLabelText(/I confirm this URL may establish a new server identity/)
    expect(confirmation).not.toBeChecked()
    await user.click(confirmation)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(switchServer).toHaveBeenCalledWith('alpha', true, { resetServerIdentity: true }))
    expect(update).not.toHaveBeenCalled()
  })

  it('tracks a successful connection test and a successful server add', async () => {
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('Server URL'), 'https://beta.example:7850')
    await user.type(screen.getByLabelText('Access token'), 'private-token')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('connection_tested', { success: true }))

    await user.click(screen.getByRole('button', { name: 'Add & switch' }))
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('server_added', { success: true }))
  })

  it('keeps a persisted server add successful when the later activation fails', async () => {
    switchServer.mockResolvedValueOnce(false)
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('Server URL'), 'https://beta.example:7850')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await user.click(screen.getByRole('button', { name: 'Add & switch' }))

    expect(await screen.findByText(/was saved, but AgentsDock could not switch/)).toBeInTheDocument()
    expect(trackEvent).toHaveBeenCalledWith('server_added', { success: true })
    expect(trackEvent).not.toHaveBeenCalledWith('server_added', { success: false })
  })

  it('tracks a failed server add only when persistence fails', async () => {
    add.mockRejectedValueOnce(new Error('Could not save server.'))
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('Server URL'), 'https://beta.example:7850')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await user.click(screen.getByRole('button', { name: 'Add & switch' }))

    expect(await screen.findByText('Could not save server.')).toBeInTheDocument()
    expect(trackEvent).toHaveBeenCalledWith('server_added', { success: false })
    expect(trackEvent).not.toHaveBeenCalledWith('server_added', { success: true })
  })

  it('tracks a failed connection test without recording a server add', async () => {
    testConnection.mockResolvedValueOnce({ ok: false })
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('Server URL'), 'https://offline.example:7850')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('connection_tested', { success: false }))
    expect(trackEvent).not.toHaveBeenCalledWith('server_added', expect.anything())
  })

  it('tracks a successful server switch from the Use button', async () => {
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Use Beta' }))

    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('server_switched', { success: true }))
  })

  it('tracks a failed server switch when activation does not take effect', async () => {
    switchServer.mockResolvedValueOnce(false)
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Use Beta' }))

    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('server_switched', { success: false }))
  })
})
