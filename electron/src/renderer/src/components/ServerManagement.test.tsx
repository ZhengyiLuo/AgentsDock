import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { trackEvent } from '../lib/analytics'
import { ServerManagement } from './ServerManagement'
import { ServerConnectionQr } from './ServerConnectionQr'

vi.mock('../lib/analytics', () => {
  const trackEvent = vi.fn()
  return { trackEvent, trackOperation: async (name: string, action: () => Promise<unknown>, succeeded: (value: unknown) => boolean = () => true) => {
    try { const value = await action(); trackEvent(name, { success: succeeded(value) }); return value }
    catch (error) { trackEvent(name, { success: false }); throw error }
  } }
})

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

function renderExpanded(element: Parameters<typeof render>[0]) {
  const view = render(element)
  for (const button of screen.getAllByRole('button', { name: /^Server details for / })) fireEvent.click(button)
  return view
}

describe('ServerManagement', () => {
  const list = vi.fn()
  const add = vi.fn()
  const update = vi.fn()
  const remove = vi.fn()
  const testConnection = vi.fn()
  const copyToken = vi.fn()
  const tokenPreview = vi.fn()
  const connectionQr = vi.fn()
  const saveConnectionQr = vi.fn()
  const switchServer = vi.fn()

  beforeEach(() => {
    vi.mocked(trackEvent).mockClear()
    list.mockReset().mockResolvedValue([alpha, beta])
    add.mockReset().mockResolvedValue(beta)
    update.mockReset().mockResolvedValue(alpha)
    remove.mockReset().mockResolvedValue(true)
    testConnection.mockReset().mockResolvedValue({ ok: true, server_identity: 'server-beta' })
    copyToken.mockReset().mockResolvedValue(undefined)
    tokenPreview.mockReset().mockResolvedValue('abcd••••••••')
    connectionQr.mockReset().mockResolvedValue({ dataUrl: 'data:image/png;base64,fixture', serverUrl: 'http://127.0.0.1:7851', localOnly: true, revision: 7 })
    saveConnectionQr.mockReset().mockResolvedValue(true)
    switchServer.mockReset().mockImplementation(async (profileId: string) => {
      useAppStore.setState(state => ({ activeProfileId: profileId, profileGeneration: state.profileGeneration + 1 }))
      return true
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { servers: { list, add, update, remove, testConnection, copyToken, tokenPreview, connectionQr, saveConnectionQr } } as unknown as AgentsDockAPI
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

  it('starts folded and reads a masked token only when expanded, without connecting', async () => {
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    render(<ServerManagement activeServerControls={<button>Restart server</button>} />)
    expect(screen.getByRole('button', { name: 'Add server' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Server details for Alpha' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Connected')).toBeVisible()
    expect(screen.getAllByText('Active')).toHaveLength(1)
    expect(screen.getByText(alpha.serverUrl)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Edit Alpha' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restart server' })).not.toBeInTheDocument()
    expect(tokenPreview).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Server details for Alpha' }))
    expect(await screen.findByText('abcd••••••••')).toBeVisible()
    expect(tokenPreview).toHaveBeenCalledExactlyOnceWith('alpha')
    expect(screen.getByText(alpha.serverUrl)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Edit Alpha' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy access token for Alpha' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Connection QR code for Alpha' })).toBeVisible()
    expect(screen.getByText('Connect another device')).toBeVisible()
    expect(screen.queryByRole('img', { name: 'Connection QR code for Alpha' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restart server' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Edit Beta' })).not.toBeInTheDocument()
    expect(list).not.toHaveBeenCalled()
    expect(testConnection).not.toHaveBeenCalled()
    expect(copyToken).not.toHaveBeenCalled()
    expect(connectionQr).not.toHaveBeenCalled()
    expect(switchServer).not.toHaveBeenCalled()
  })

  it('discards a late preview after folding and fetches a fresh preview on reopening', async () => {
    let resolveOld!: (value: string) => void
    tokenPreview.mockReturnValueOnce(new Promise<string>(resolve => { resolveOld = resolve }))
    tokenPreview.mockResolvedValueOnce('new1••••••••')
    const user = userEvent.setup()
    render(<ServerManagement />)
    const header = screen.getByRole('button', { name: 'Server details for Alpha' })
    await user.click(header)
    await user.click(header)
    await user.click(header)
    expect(await screen.findByText('new1••••••••')).toBeVisible()
    await act(async () => { resolveOld('old1••••••••') })
    expect(screen.queryByText('old1••••••••')).not.toBeInTheDocument()
    expect(tokenPreview).toHaveBeenCalledTimes(2)
  })

  it('does not read absent tokens and keeps preview errors free of credential details', async () => {
    useAppStore.setState({ profiles: [alpha, { ...beta, hasAccessToken: false }] })
    tokenPreview.mockRejectedValueOnce(new Error('secret-bearing-credential-error'))
    renderExpanded(<ServerManagement />)
    expect(await screen.findByText('Token preview unavailable. Reopen this card to retry.')).toBeVisible()
    expect(screen.queryByText(/secret-bearing/)).not.toBeInTheDocument()
    expect(screen.getByText('No saved access token')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy access token for Beta' })).toBeDisabled()
    expect(tokenPreview).toHaveBeenCalledExactlyOnceWith('alpha')
  })

  it('refreshes the preview after saving a replacement token without reading on each keystroke', async () => {
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    render(<ServerManagement />)
    await user.click(screen.getByRole('button', { name: 'Server details for Beta' }))
    expect(await screen.findByText('abcd••••••••')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Edit Beta' }))
    await user.type(screen.getByLabelText('Access token'), 'replaced-token-fixture')
    expect(tokenPreview).toHaveBeenCalledTimes(1)
    tokenPreview.mockResolvedValueOnce('repl••••••••')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('repl••••••••')).toBeVisible()
    expect(tokenPreview).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledWith('beta', { accessToken: 'replaced-token-fixture' })
  })

  it('preserves an unfinished edit when folded and clears removal confirmation', async () => {
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    render(<ServerManagement />)
    const header = screen.getByRole('button', { name: 'Server details for Beta' })
    await user.click(header)
    await user.click(screen.getByRole('button', { name: 'Edit Beta' }))
    await user.clear(screen.getByLabelText('Name on this Mac'))
    await user.type(screen.getByLabelText('Name on this Mac'), 'Work in progress')
    await user.click(screen.getByRole('button', { name: 'Remove Beta' }))
    await user.click(header)
    expect(screen.queryByRole('img', { name: 'Connection QR code for Beta' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Name on this Mac')).not.toBeInTheDocument()
    await user.click(header)
    expect(screen.getByLabelText('Name on this Mac')).toHaveValue('Work in progress')
    expect(screen.queryByText('Confirm removal')).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Connection QR code for Beta' })).not.toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('copies an inactive server token without switching, testing, or changing its profile', async () => {
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    renderExpanded(<ServerManagement />)
    expect(copyToken).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Copy access token for Beta' }))
    const betaCopy = screen.getByRole('button', { name: 'Copy access token for Beta' })
    expect(betaCopy).toHaveAttribute('title', 'Access token copied')
    expect(betaCopy).toHaveTextContent(/^Copy$/)
    expect(betaCopy.querySelector('.lucide-check')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(copyToken).toHaveBeenCalledExactlyOnceWith('beta')
    expect(switchServer).not.toHaveBeenCalled()
    expect(testConnection).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Copy access token for Alpha' }))
    await waitFor(() => expect(copyToken).toHaveBeenLastCalledWith('alpha'))
    expect(betaCopy.querySelector('.lucide-check')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy access token for Alpha' }).querySelector('.lucide-check')).toBeInTheDocument()
    expect(useAppStore.getState().activeProfileId).toBe('alpha')
  })

  it('shows the selected saved server QR on demand without switching, and clears it on close, fold and edit', async () => {
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    renderExpanded(<ServerManagement />)
    const show = screen.getByRole('button', { name: 'Connection QR code for Beta' })
    await user.click(show)
    expect(await screen.findByRole('img', { name: 'Connection QR code for Beta' })).toBeVisible()
    expect(show).toHaveAttribute('aria-expanded', 'true')
    expect(connectionQr).toHaveBeenCalledExactlyOnceWith('beta')
    expect(switchServer).not.toHaveBeenCalled()
    expect(testConnection).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeProfileId).toBe('alpha')
    await user.click(screen.getByRole('button', { name: 'Close connection QR code' }))
    expect(screen.queryByRole('img', { name: /^Connection QR code/ })).not.toBeInTheDocument()
    await user.click(show)
    expect(await screen.findByRole('img', { name: 'Connection QR code for Beta' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Server details for Beta' }))
    await user.click(screen.getByRole('button', { name: 'Server details for Beta' }))
    expect(screen.queryByRole('img', { name: /^Connection QR code/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Connection QR code for Beta' }))
    expect(await screen.findByRole('img', { name: 'Connection QR code for Beta' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Edit Beta' }))
    expect(screen.queryByRole('img', { name: /^Connection QR code/ })).not.toBeInTheDocument()
  })

  it('keeps QR failures credential-free and allows closing and retrying', async () => {
    connectionQr.mockRejectedValueOnce(new Error('private-token-keychain-diagnostics'))
    const user = userEvent.setup()
    renderExpanded(<ServerManagement />)
    await user.click(screen.getByRole('button', { name: 'Connection QR code for Alpha' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not generate or save this QR code')
    expect(screen.queryByText('private-token-keychain-diagnostics')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close connection QR code' }))
    await user.click(screen.getByRole('button', { name: 'Connection QR code for Alpha' }))
    expect(await screen.findByRole('img', { name: 'Connection QR code for Alpha' })).toBeVisible()
  })

  it('generates a QR when mounted, explains local-only addresses, and saves the selected revision', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    expect(connectionQr).not.toHaveBeenCalled()
    render(<ServerConnectionQr profile={beta} onClose={onClose} />)
    expect(await screen.findByRole('img', { name: 'Connection QR code for Beta' })).toBeInTheDocument()
    expect(connectionQr).toHaveBeenCalledExactlyOnceWith('beta')
    expect(screen.getByRole('note')).toHaveTextContent('only on this computer')
    await user.click(screen.getByRole('button', { name: 'Save QR image…' }))
    expect(saveConnectionQr).toHaveBeenCalledExactlyOnceWith('beta', 7)
    expect(await screen.findByText('QR image saved')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close connection QR code' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(switchServer).not.toHaveBeenCalled()
  })

  it('does not show a late QR from a previously selected server', async () => {
    let finish!: (value: unknown) => void
    connectionQr.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const view = render(<ServerConnectionQr key={alpha.id} profile={alpha} onClose={() => {}} />)
    view.rerender(<ServerConnectionQr key={beta.id} profile={beta} onClose={() => {}} />)
    expect(await screen.findByRole('img', { name: 'Connection QR code for Beta' })).toHaveAttribute('src', 'data:image/png;base64,fixture')
    finish({ dataUrl: 'data:image/png;base64,stale', revision: 0 })
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Connection QR code for Alpha' })).not.toBeInTheDocument())
    expect(screen.getByRole('img', { name: 'Connection QR code for Beta' })).toHaveAttribute('src', 'data:image/png;base64,fixture')
  })

  it('disables copying absent tokens and shows a retryable error without raw credential-store details', async () => {
    useAppStore.setState({ profiles: [alpha, { ...beta, hasAccessToken: false }] })
    copyToken.mockRejectedValueOnce(new Error('Sensitive keychain diagnostics'))
    const user = userEvent.setup()
    renderExpanded(<ServerManagement />)
    expect(screen.getByRole('button', { name: 'Copy access token for Beta' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Connection QR code for Beta' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Copy access token for Alpha' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Could not copy the saved token')
    expect(screen.queryByText('Sensitive keychain diagnostics')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy access token for Alpha' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Copy access token for Alpha' }))
    expect(screen.getByRole('button', { name: 'Copy access token for Alpha' })).toHaveAttribute('title', 'Access token copied')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('tests a new connection, saves the profile, and switches without reloading', async () => {
    const user = userEvent.setup()
    renderExpanded(<ServerManagement addRequest={1} />)

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
    renderExpanded(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('Server URL'), 'https://offline.example:7850')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    expect(await screen.findByText('Server health check reported unavailable.')).toBeInTheDocument()
    expect(screen.getByRole('status')).not.toHaveTextContent('Connected')
    expect(screen.getByRole('button', { name: 'Add & switch' })).toBeDisabled()
  })

  it('reveals and focuses the editor when Add server is clicked directly', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    const user = userEvent.setup()
    renderExpanded(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Add server' }))

    expect(screen.getByLabelText('Name on this Mac')).toHaveFocus()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('reuses the saved profile when a URL alias resolves to its canonical identity', async () => {
    testConnection.mockResolvedValueOnce({ ok: true, server_identity: alpha.serverIdentity })
    const user = userEvent.setup()
    renderExpanded(<ServerManagement addRequest={1} />)

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
    renderExpanded(<ServerManagement />)

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

    renderExpanded(<ServerManagement />)

    expect(screen.getByRole('button', { name: 'Use Beta' })).toHaveTextContent('Use server')
    expect(screen.getByRole('button', { name: 'Use Gamma' })).toHaveTextContent('Use server')
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
    renderExpanded(<ServerManagement />)

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
    renderExpanded(<ServerManagement />)

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

    renderExpanded(<ServerManagement />)

    expect(screen.getAllByRole('img', { name: 'Online' })).toHaveLength(2)
    expect(screen.getAllByText('Active')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Use Beta' })).toBeEnabled()
  })

  it('shows an inactive degraded server and its tmux warning in amber', () => {
    const message = 'tmux is missing; terminal sessions and detached updates are unavailable.'
    useAppStore.setState({
      profiles: [alpha, { ...beta, serverVersion: '1.4.2', connectionState: 'degraded', lastConnectionError: message }],
      activeProfileId: alpha.id
    })

    renderExpanded(<ServerManagement />)

    expect(screen.getByRole('img', { name: `Degraded: ${message}` })).toHaveClass('degraded')
    expect(screen.getByText(message)).toHaveClass('server-management-warning')
    expect(screen.getByText('server-beta')).toBeVisible()
    expect(screen.getByText('1.4.2')).toBeVisible()
    expect(screen.getAllByText('Active')).toHaveLength(1)
  })

  it('shows the last known server version with the canonical identity', () => {
    useAppStore.setState({ profiles: [{ ...alpha, serverVersion: '1.4.2' }] })

    renderExpanded(<ServerManagement />)

    expect(screen.getByText('server-alpha')).toBeVisible()
    expect(screen.getByText('1.4.2')).toBeVisible()
  })

  it('does not reconnect the active server for a name-only edit', async () => {
    list.mockResolvedValue([{ ...alpha, name: 'Renamed Alpha' }])
    const user = userEvent.setup()
    renderExpanded(<ServerManagement />)

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
    renderExpanded(<ServerManagement />)

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
    renderExpanded(<ServerManagement />)

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
    renderExpanded(<ServerManagement addRequest={1} />)

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
    renderExpanded(<ServerManagement />)

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
    renderExpanded(<ServerManagement addRequest={1} />)

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
    renderExpanded(<ServerManagement addRequest={1} />)

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
    renderExpanded(<ServerManagement addRequest={1} />)

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
    renderExpanded(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('Server URL'), 'https://offline.example:7850')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))

    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('connection_tested', { success: false }))
    expect(trackEvent).not.toHaveBeenCalledWith('server_added', expect.anything())
  })

  it('tracks a successful server switch from the Use button', async () => {
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    renderExpanded(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Use Beta' }))

    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('server_switched', { success: true }))
  })

  it('tracks a failed server switch when activation does not take effect', async () => {
    switchServer.mockResolvedValueOnce(false)
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    renderExpanded(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Use Beta' }))

    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('server_switched', { success: false }))
  })
})
