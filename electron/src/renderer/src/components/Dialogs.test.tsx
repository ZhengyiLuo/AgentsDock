import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale, t } from '@shared/i18n'
import type { AppUpdateStatus, AppUpdateTrack, ChatReference, CrossChatHandoffsCapability, Health, ProfileBootstrapPayload, PublicServerProfile, RuntimeCatalog, Session, TeamReference, TimelineSearchResult } from '@shared/types'
import { clearSessionHistorySearchCache } from '../lib/session-history-search'
import { useAppStore } from '../store/app-store'
import { AppSettingsDialog, DigestDialog, JobDialog, RenameChatDialog, SearchDialog, ServerOnboardingDialog, SessionDialog } from './Dialogs'

afterEach(() => setLocale('en'))

function durableHandoffCapability(overrides: Partial<CrossChatHandoffsCapability> = {}): CrossChatHandoffsCapability {
  return {
    available: true,
    required: false,
    message: 'Ready',
    action: null,
    version: 7,
    actions: ['route', 'instruction', 'request_reply', 'final_result'],
    default_action: 'instruction',
    supported_target_backends: ['codex', 'claude'],
    ...overrides,
    features: {
      route_hint_mentions: true,
      durable_route_grants: true,
      agent_cross_chat_routes: true,
      agent_ambient_local_handoffs: false,
      ...overrides.features
    },
    agent_routes: {
      client_capability: 'agent_cross_chat_routes_v2',
      policy: 'default_deny',
      actions: ['instruction', 'request_reply'],
      default_actions: ['instruction', 'request_reply'],
      ...overrides.agent_routes
    }
  }
}

describe('Dialog close controls', () => {
  afterEach(cleanup)

  it('closes a controlled dialog directly from its X button', async () => {
    const user = userEvent.setup()
    render(<RenameChatDialog />)

    act(() => {
      window.dispatchEvent(new CustomEvent<Session>('agentsdock:rename-chat', {
        detail: { id: 'chat-close-test', title: 'Close me', backend: 'codex' }
      }))
    })
    expect(screen.getByRole('dialog', { name: 'Rename chat' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close Rename chat' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename chat' })).not.toBeInTheDocument())
  })
})

describe('AppSettingsDialog', () => {
  afterEach(cleanup)

  it('keeps app preferences, server controls, and updates in one settings dialog', async () => {
    const updateStatus = { state: 'not-available' as const, channel: 'direct' as const, track: 'stable' as const, currentVersion: '0.2.0', message: 'AgentsDock is up to date.' }
    const check = vi.fn()
      .mockResolvedValueOnce(updateStatus)
      .mockResolvedValue({ ...updateStatus, state: 'downloaded', message: 'Ready to install' })
    const install = vi.fn().mockResolvedValue(true)
    const setTrack = vi.fn().mockResolvedValue({ ...updateStatus, track: 'beta', message: 'AgentsDock is up to date on the beta channel.' })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        updates: {
          status: vi.fn().mockResolvedValue(updateStatus),
          check,
          install,
          setTrack
        },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      health: { ok: true, server_version: '0.1.26' },
      switchingProfileId: null,
      modals: { settings: false, appSettings: true, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })

    render(<AppSettingsDialog serverSettings={<div>Existing server controls</div>} serverUpdates={<div>Existing server updates</div>} />)
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(within(dialog).getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page')
    expect(await within(dialog).findByText('Version 0.2.0')).toBeInTheDocument()
    expect(within(dialog).getByText('Version 0.1.26')).toBeInTheDocument()
    expect(within(dialog).queryByText('AgentsDock is up to date.')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('group', { name: 'App update channel' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Restart to update' })).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Desktop settings')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Desktop information and access to advanced controls.')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Chat font')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Appearance' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'App theme' })).toHaveValue('system')
    expect(within(dialog).queryByText('Set the color theme used throughout AgentsDock.')).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keyboard shortcuts' }))
    expect(within(dialog).getByRole('button', { name: 'Keyboard shortcuts' })).toHaveAttribute('aria-current', 'page')
    expect(within(dialog).getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(23)
    expect(within(dialog).getByText('Toggle chat list')).toBeInTheDocument()

    act(() => window.dispatchEvent(new CustomEvent('agentsdock:app-settings-section', { detail: 'appearance' })))
    expect(within(dialog).getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page')
    expect(within(dialog).getByRole('combobox', { name: 'App theme' })).toHaveValue('system')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Updates' }))
    expect(within(dialog).getByText('This is the latest one.')).toBeInTheDocument()
    expect(check).toHaveBeenCalledOnce()
    const appUpdateChannel = within(dialog).getByRole('group', { name: 'App update channel' })
    fireEvent.click(within(appUpdateChannel).getByRole('button', { name: 'Beta' }))
    await waitFor(() => expect(setTrack).toHaveBeenCalledWith('beta'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check for updates' }))
    expect(check).toHaveBeenCalledTimes(2)
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Restart to update' }))
    expect(install).toHaveBeenCalledOnce()
    expect(within(dialog).queryByRole('button', { name: 'Check for updates' })).not.toBeInTheDocument()
    expect(within(dialog).getByText('Existing server updates')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Server' }))
    expect(within(dialog).getByRole('button', { name: 'Server' })).toHaveAttribute('aria-current', 'page')
    expect(within(dialog).getByText('Existing server controls')).toBeInTheDocument()
    expect(useAppStore.getState().modals).toMatchObject({ appSettings: true, settings: false })
  })

  it('checks releases in development without offering an external installer download', async () => {
    const updateStatus = { state: 'idle' as const, channel: 'development' as const, track: 'stable' as const, currentVersion: '0.2.0', message: 'Ready to check published releases.' }
    let current = updateStatus as AppUpdateStatus
    const check = vi.fn(() => Promise.resolve(current))
    const setTrack = vi.fn((track: AppUpdateTrack) => {
      current = {
        ...updateStatus,
        state: 'available',
        track,
        availableVersion: '0.2.13-beta.13',
        message: 'A newer release is available.'
      }
      return Promise.resolve(current)
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        updates: {
          status: vi.fn().mockResolvedValue(updateStatus),
          check,
          install: vi.fn().mockResolvedValue(false),
          setTrack
        },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      modals: { settings: false, appSettings: true, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })

    render(<AppSettingsDialog serverSettings={<div />} serverUpdates={<div />} />)
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Updates' }))
    const appUpdateChannel = await within(dialog).findByRole('group', { name: 'App update channel' })
    fireEvent.click(within(appUpdateChannel).getByRole('button', { name: 'Beta' }))

    await waitFor(() => expect(setTrack).toHaveBeenCalledWith('beta'))
    expect(within(dialog).queryByRole('button', { name: /Download 0\.2\.13-beta\.13/ })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Restart to update' })).not.toBeInTheDocument()
    const checkButton = within(dialog).getByRole('button', { name: 'Check for updates' })
    expect(checkButton).toBeEnabled()
    fireEvent.click(checkButton)
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
  })
})

describe('ServerOnboardingDialog', () => {
  afterEach(cleanup)

  it('points a fresh install to AgentsServer and accepts connection settings', async () => {
    const get = vi.fn().mockResolvedValue({
      serverUrl: 'http://127.0.0.1:7850',
      hasAccessToken: false,
      serverIdentity: null,
      serverSetupComplete: false
    })
    const switchServer = vi.fn().mockRejectedValue(new Error('Not connected yet'))
    const testConnection = vi.fn().mockResolvedValue({ ok: true, server_identity: 'server-1' })
    const openExternal = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get },
        servers: { testConnection },
        setup: { capabilities: vi.fn().mockResolvedValue({ available: false, local: false, ssh: false, reason: 'Use the guide.' }) },
        native: { openExternal },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ connected: false, activeProfileId: 'default-profile', profileGeneration: 1, switchingProfileId: null, switchServer, error: null })
    const user = userEvent.setup()
    render(<ServerOnboardingDialog />)

    expect(await screen.findByRole('heading', { name: 'Set up AgentsServer' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Open setup guide/ }))
    expect(openExternal).toHaveBeenCalledWith('https://github.com/ZhengyiLuo/AgentsServer/tree/v0.1.20#guided-setup')

    await user.clear(screen.getByLabelText('Server URL'))
    await user.type(screen.getByLabelText('Server URL'), 'server.example.com:7850')
    await user.type(screen.getByLabelText('Access token'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(testConnection).toHaveBeenCalledWith({
      serverUrl: 'server.example.com:7850',
      accessToken: 'secret'
    }))
    await waitFor(() => expect(switchServer).toHaveBeenCalledWith('default-profile', true, {
      serverUrl: 'server.example.com:7850',
      accessToken: 'secret',
      resetServerIdentity: true,
      serverSetupComplete: true
    }))
  })

  it('does not bind setup results to a different profile when the active server changes during health verification', async () => {
    let resolveHealth: (health: Health) => void = () => undefined
    const testConnection = vi.fn(() => new Promise<Health>(resolve => { resolveHealth = resolve }))
    const switchServer = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get: vi.fn().mockResolvedValue({ serverUrl: 'http://127.0.0.1:7850', hasAccessToken: false, serverSetupComplete: false }) },
        servers: { testConnection },
        setup: { capabilities: vi.fn().mockResolvedValue({ available: false, local: false, ssh: false, reason: 'Use the guide.' }) },
        native: { openExternal: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      connected: false,
      activeProfileId: 'default-profile',
      profileGeneration: 1,
      switchingProfileId: null,
      switchServer,
      error: null
    })
    const user = userEvent.setup()
    render(<ServerOnboardingDialog />)

    await user.click(await screen.findByRole('button', { name: /Open setup guide/ }))
    await user.clear(screen.getByLabelText('Server URL'))
    await user.type(screen.getByLabelText('Server URL'), 'server.example.com:7850')
    await user.type(screen.getByLabelText('Access token'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(testConnection).toHaveBeenCalledOnce())

    act(() => {
      useAppStore.setState({ activeProfileId: 'other-profile', profileGeneration: 2 })
      resolveHealth({ ok: true, server_identity: 'server-1' })
    })

    await waitFor(() => expect(useAppStore.getState().error).toMatch(/active server changed while setup was finishing/i))
    expect(switchServer).not.toHaveBeenCalled()
  })

  it('surfaces the no-key terminal guide before the SSH installer', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get: vi.fn().mockResolvedValue({ serverUrl: 'http://127.0.0.1:7850', hasAccessToken: false, serverSetupComplete: false }) },
        setup: { capabilities: vi.fn().mockResolvedValue({ available: true, local: true, ssh: true }) },
        native: { openExternal },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ connected: false, activeProfileId: 'default-profile', profileGeneration: 1, switchingProfileId: null, error: null })
    const user = userEvent.setup()
    render(<ServerOnboardingDialog />)

    const guide = await screen.findByRole('button', { name: /No SSH key\? Install from the server terminal/ })
    const sshHost = screen.getByPlaceholderText('user@server or SSH alias')
    expect(screen.getByRole('button', { name: /Remote machine/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /This computer/ })).toHaveAttribute('aria-pressed', 'false')
    expect(guide.compareDocumentPosition(sshHost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText(/SSH host, key, and connection port come from your SSH config/)).toBeInTheDocument()
    const serverPort = screen.getByLabelText('AgentsServer port')
    await user.clear(serverPort)
    await user.type(serverPort, '22')
    expect(screen.getByRole('button', { name: 'Install over SSH' })).toBeDisabled()
    expect(serverPort).toHaveAttribute('aria-invalid', 'true')

    await user.click(guide)

    expect(openExternal).toHaveBeenCalledWith('https://github.com/ZhengyiLuo/AgentsServer/tree/v0.1.20#guided-setup')
    expect(screen.getByLabelText('Server URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Access token')).toBeInTheDocument()
  })

  it('installs on an SSH host and connects with the generated token', async () => {
    const get = vi.fn().mockResolvedValue({ serverUrl: 'http://127.0.0.1:7850', hasAccessToken: false, serverSetupComplete: false })
    const switchServer = vi.fn(async () => {
      useAppStore.setState(state => ({ profileGeneration: state.profileGeneration + 1 }))
      return true
    })
    const run = vi.fn().mockResolvedValue({
      serverUrl: 'http://100.64.0.10:7850',
      accessToken: 'generated-private-token-0123456789',
      service: 'systemd-user',
      tailscaleIP: '100.64.0.10'
    })
    const testConnection = vi.fn().mockResolvedValue({ ok: true, server_identity: 'server-1' })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get },
        servers: { testConnection },
        setup: { capabilities: vi.fn().mockResolvedValue({ available: true, local: true, ssh: true }), run },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ connected: false, activeProfileId: 'default-profile', profileGeneration: 1, switchingProfileId: null, switchServer, error: null })
    const user = userEvent.setup()
    render(<ServerOnboardingDialog />)

    expect(await screen.findByRole('checkbox', { name: /Start a Team Network on this server/ })).toBeChecked()
    await user.type(await screen.findByPlaceholderText('user@server or SSH alias'), 'user@server')
    await user.click(screen.getByRole('button', { name: 'Install over SSH' }))

    await waitFor(() => expect(run).toHaveBeenCalledWith({ target: 'ssh', sshHost: 'user@server', port: 7850, track: 'stable', teamHubHost: true }))
    expect(testConnection).toHaveBeenCalledWith({
      serverUrl: 'http://100.64.0.10:7850',
      accessToken: 'generated-private-token-0123456789'
    })
    await waitFor(() => expect(switchServer).toHaveBeenCalledWith('default-profile', true, {
      serverUrl: 'http://100.64.0.10:7850',
      accessToken: 'generated-private-token-0123456789',
      resetServerIdentity: true,
      serverSetupComplete: true
    }))
  })

  it('shows a dedicated signed Beta update flow for legacy servers', async () => {
    const run = vi.fn().mockResolvedValue({
      serverUrl: 'http://127.0.0.1:7850',
      accessToken: 'generated-private-token-0123456789',
      service: 'launch-agent',
      tailscaleIP: ''
    })
    const testConnection = vi.fn().mockResolvedValue({ ok: true, server_identity: 'server-1' })
    const switchServer = vi.fn(async () => {
      useAppStore.setState(state => ({ profileGeneration: state.profileGeneration + 1 }))
      return true
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get: vi.fn().mockResolvedValue({ serverUrl: 'http://server.test:7850', hasAccessToken: true, serverSetupComplete: true }) },
        servers: { testConnection },
        setup: { capabilities: vi.fn().mockResolvedValue({ available: true, local: true, ssh: true }), run },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ connected: true, activeProfileId: 'default-profile', profileGeneration: 1, switchingProfileId: null, switchServer, error: null })
    render(<ServerOnboardingDialog />)
    await waitFor(() => expect(window.agentsDock.settings.get).toHaveBeenCalled())

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:server-setup', { detail: { intent: 'update-beta' } }))
    })

    expect(await screen.findByRole('heading', { name: 'Update AgentsServer to Beta' })).toBeInTheDocument()
    expect(screen.getByText('Signed Beta update')).toBeInTheDocument()
    expect(screen.getByText(/verified Beta pinned by this app/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Start a Team Network on this server/ })).not.toBeChecked()
    expect(screen.getByText(/preserve the server’s current Team Network role/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update over SSH' })).toBeDisabled()
    const serverPort = screen.getByLabelText('AgentsServer port')
    fireEvent.change(serverPort, { target: { value: '22' } })
    expect(serverPort).toHaveValue('22')
    expect(screen.getByRole('button', { name: 'Update over SSH' })).toBeDisabled()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:server-setup', { detail: { intent: 'update-beta' } }))
    })
    expect(screen.getByLabelText('AgentsServer port')).toHaveValue('7850')
    fireEvent.click(screen.getByRole('button', { name: /This computer/ }))
    expect(screen.getByRole('button', { name: 'Update this computer' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Update this computer' }))
    await waitFor(() => expect(run).toHaveBeenCalledWith({
      target: 'local',
      sshHost: undefined,
      port: 7850,
      track: 'beta'
    }))
  })

  it('lets a Beta update explicitly designate the server as the Team Network host', async () => {
    const run = vi.fn().mockRejectedValue(new Error('stop after input capture'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get: vi.fn().mockResolvedValue({ serverUrl: 'http://server.test:7850', hasAccessToken: true, serverSetupComplete: true }) },
        setup: { capabilities: vi.fn().mockResolvedValue({ available: true, local: true, ssh: true }), run },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ connected: true, activeProfileId: 'default-profile', profileGeneration: 1, switchingProfileId: null, error: null })
    const user = userEvent.setup()
    render(<ServerOnboardingDialog />)
    await waitFor(() => expect(window.agentsDock.settings.get).toHaveBeenCalled())

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:server-setup', { detail: { intent: 'update-beta' } }))
    })
    await user.click(await screen.findByRole('button', { name: /This computer/ }))
    await user.click(screen.getByRole('checkbox', { name: /Start a Team Network on this server/ }))
    await user.click(screen.getByRole('button', { name: 'Update this computer' }))

    await waitFor(() => expect(run).toHaveBeenCalledWith({
      target: 'local',
      sshHost: undefined,
      port: 7850,
      track: 'beta',
      teamHubHost: true
    }))
  })

  it.each(['en', 'zh-CN'] as const)('creates the Team Network and host on the originating server with localized controls in %s', async locale => {
    setLocale(locale)
    const run = vi.fn()
    const configureServerRole = vi.fn().mockResolvedValue({
      profileId: 'studio', profileGeneration: 2, serverIdentity: 'server-studio', designatedHost: true
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get: vi.fn().mockResolvedValue({ serverUrl: 'http://100.64.0.3:7850', hasAccessToken: true, serverSetupComplete: true }) },
        teamHub: { configureServerRole },
        setup: { capabilities: vi.fn().mockResolvedValue({ available: true, local: true, ssh: true }), run },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      connected: true,
      activeProfileId: 'studio',
      profileGeneration: 2,
      switchingProfileId: null,
      error: null,
      health: { ok: true, server_version: '0.1.26-beta.43' },
      profiles: [{
        id: 'studio',
        name: 'Studio',
        serverUrl: 'http://100.64.0.3:7850',
        serverIdentity: 'server-studio',
        hasAccessToken: true,
        serverSetupComplete: true,
        connectionState: 'online',
        cachedUnreadCount: 0,
        serverVersion: '0.1.26-beta.43'
      }]
    })
    const user = userEvent.setup()
    render(<ServerOnboardingDialog />)
    await waitFor(() => expect(window.agentsDock.settings.get).toHaveBeenCalled())
    const opened = vi.fn()
    window.addEventListener('agentsdock:open-teamspace', opened, { once: true })

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:server-setup', {
        detail: {
          mode: 'configure-active',
          intent: 'host-team-network',
          origin: {
            profileId: 'studio', profileGeneration: 2,
            serverIdentity: 'server-studio', serverName: 'Studio'
          }
        }
      }))
    })

    expect(await screen.findByRole('heading', { name: t('teamNetwork.setup.title') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('ui.Dialogs.Shell.close_31a8910', { name: t('teamNetwork.setup.title') }) })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Studio' })).toBeInTheDocument()
    expect(screen.getByText(t('teamNetwork.setup.liveRole'))).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Role' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Member' })).not.toBeInTheDocument()
    expect(screen.getByText(t('teamNetwork.setup.hostHint'))).toBeInTheDocument()
    expect(screen.getByLabelText(t('teamNetwork.setup.serverName'))).toHaveValue('Studio')
    expect(screen.queryByRole('button', { name: /Remote machine|This computer/ })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('user@server or SSH alias')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('AgentsServer port')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    await user.clear(screen.getByLabelText(t('teamNetwork.setup.serverName')))
    await user.type(screen.getByLabelText(t('teamNetwork.setup.serverName')), 'Mac Studio')
    await user.click(screen.getByRole('button', { name: t('teamNetwork.setup.create') }))

    await waitFor(() => expect(configureServerRole).toHaveBeenCalledWith(
      { profileId: 'studio', profileGeneration: 2, serverIdentity: 'server-studio' },
      { role: 'host', serverName: 'Mac Studio', networkName: 'Mac Studio' }
    ))
    expect(run).not.toHaveBeenCalled()
    await waitFor(() => expect(opened).toHaveBeenCalledOnce())
    expect(screen.queryByRole('heading', { name: t('teamNetwork.setup.title') })).not.toBeInTheDocument()
  })

  it('keeps an unsupported create action host-only instead of exposing the unrelated member role', async () => {
    const configureServerRole = vi.fn().mockRejectedValue(new Error('The connected AgentsServer build does not include Team Network host control. Install a build that includes host control, then reconnect.'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get: vi.fn().mockResolvedValue({ serverUrl: 'http://127.0.0.1:7850', hasAccessToken: true, serverSetupComplete: true }) },
        teamHub: { configureServerRole },
        setup: { capabilities: vi.fn().mockResolvedValue({ available: false, local: false, ssh: false, reason: 'Use the server terminal.' }) },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      connected: true,
      activeProfileId: 'studio',
      profileGeneration: 2,
      profiles: [{
        id: 'studio', name: 'Studio', serverUrl: 'http://127.0.0.1:7850', serverIdentity: 'server-studio',
        hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0,
        serverVersion: '0.1.26-beta.43'
      }]
    })
    const user = userEvent.setup()
    render(<ServerOnboardingDialog />)
    await waitFor(() => expect(window.agentsDock.setup.capabilities).toHaveBeenCalled())

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:server-setup', {
        detail: {
          mode: 'configure-active', intent: 'host-team-network',
          origin: {
            profileId: 'studio', profileGeneration: 2,
            serverIdentity: 'server-studio', serverName: 'Studio'
          }
        }
      }))
    })

    expect(await screen.findByRole('heading', { name: 'Create Team Network on this server' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect manually' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Role' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Member' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create network' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Create network' }))
    expect(configureServerRole).toHaveBeenCalledWith(
      { profileId: 'studio', profileGeneration: 2, serverIdentity: 'server-studio' },
      { role: 'host', serverName: 'Studio', networkName: 'Studio' }
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('The connected AgentsServer build does not include Team Network host control. Install a build that includes host control, then reconnect.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('keeps setup open and does not persist a server that fails the post-install health check', async () => {
    const run = vi.fn().mockResolvedValue({
      serverUrl: 'http://unreachable.test:7850',
      accessToken: 'generated-private-token-0123456789',
      service: 'launch-agent',
      tailscaleIP: ''
    })
    const testConnection = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const switchServer = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get: vi.fn().mockResolvedValue({ serverUrl: 'http://127.0.0.1:7850', hasAccessToken: false, serverSetupComplete: false }) },
        servers: { testConnection },
        setup: { capabilities: vi.fn().mockResolvedValue({ available: true, local: true, ssh: true }), run },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ connected: false, activeProfileId: 'default-profile', profileGeneration: 1, switchingProfileId: null, switchServer, error: null })
    const user = userEvent.setup()
    render(<ServerOnboardingDialog />)

    await user.click(await screen.findByRole('button', { name: /This computer/ }))
    await user.click(screen.getByRole('button', { name: 'Install here' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not connect to AgentsServer at http://unreachable.test:7850: fetch failed'
    )
    expect(testConnection).toHaveBeenCalledWith({
      serverUrl: 'http://unreachable.test:7850',
      accessToken: 'generated-private-token-0123456789'
    })
    expect(switchServer).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Set up AgentsServer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry setup' })).toBeEnabled()
  })

  it('shows a clean setup failure and leaves guided setup ready to retry', async () => {
    const get = vi.fn().mockResolvedValue({ serverUrl: 'http://127.0.0.1:7850', hasAccessToken: false, serverSetupComplete: false })
    const run = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'server-setup:run': Error: macOS could not restart AgentsServer. Running as root is not required."))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get },
        setup: { capabilities: vi.fn().mockResolvedValue({ available: true, local: true, ssh: true }), run },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ connected: false, activeProfileId: 'default-profile', profileGeneration: 1, switchingProfileId: null, error: null })
    const user = userEvent.setup()
    render(<ServerOnboardingDialog />)

    await user.click(await screen.findByRole('button', { name: /This computer/ }))
    await user.click(screen.getByRole('button', { name: 'Install here' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('macOS could not restart AgentsServer. Running as root is not required.')
    expect(useAppStore.getState().error).toBeNull()
    expect(screen.getByRole('heading', { name: 'Set up AgentsServer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry setup' })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('Setup needs attention')
    expect(screen.getByRole('status')).toHaveTextContent('0s')
  })

  it('cancels an active setup and keeps progress visible for retry', async () => {
    let rejectRun: ((error: Error) => void) | undefined
    let progressListener: ((progress: { phase: 'download'; message: string }) => void) | undefined
    const run = vi.fn().mockImplementation(() => new Promise((_resolve, reject) => { rejectRun = reject }))
    const cancel = vi.fn().mockImplementation(() => {
      rejectRun?.(new Error('AgentsServer setup was cancelled.'))
      return Promise.resolve(true)
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get: vi.fn().mockResolvedValue({ serverUrl: 'http://127.0.0.1:7850', hasAccessToken: false, serverSetupComplete: false }) },
        setup: { capabilities: vi.fn().mockResolvedValue({ available: true, local: true, ssh: true }), run, cancel },
        events: {
          on: vi.fn((_name, listener) => {
            progressListener = listener
            return () => undefined
          })
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ connected: false, activeProfileId: 'default-profile', profileGeneration: 1, switchingProfileId: null, error: null })
    const user = userEvent.setup()
    render(<ServerOnboardingDialog />)

    await user.click(await screen.findByRole('button', { name: /This computer/ }))
    await user.click(screen.getByRole('button', { name: 'Install here' }))
    act(() => progressListener?.({ phase: 'download', message: 'Downloading signed release…' }))

    expect(screen.getByRole('status')).toHaveTextContent('Downloading AgentsServer')
    expect(screen.getByLabelText('Setup progress')).toHaveTextContent('Downloading signed release…')
    await user.click(screen.getByRole('button', { name: 'Cancel setup' }))

    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('alert')).toHaveTextContent('Setup cancelled')
    expect(screen.getByRole('button', { name: 'Retry setup' })).toBeEnabled()
    expect(screen.getByLabelText('Setup progress')).toHaveTextContent('Downloading signed release…')
  })

  it('copies setup diagnostics and opens the persistent setup log', async () => {
    const writeClipboard = vi.fn().mockResolvedValue(undefined)
    const openLog = vi.fn().mockResolvedValue(true)
    const diagnostics = vi.fn().mockResolvedValue({
      logPath: '/tmp/agentsdock-server-setup.log',
      state: 'failed',
      target: 'ssh',
      startedAt: '2026-07-24T18:00:00.000Z',
      updatedAt: '2026-07-24T18:00:05.000Z',
      tail: ['Downloading release…', 'SSH connection closed.']
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get: vi.fn().mockResolvedValue({ serverUrl: 'http://127.0.0.1:7850', hasAccessToken: false, serverSetupComplete: false }) },
        setup: {
          capabilities: vi.fn().mockResolvedValue({ available: true, local: true, ssh: true }),
          run: vi.fn().mockRejectedValue(new Error('SSH connection closed.')),
          diagnostics,
          openLog
        },
        native: { writeClipboard },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ connected: false, activeProfileId: 'default-profile', profileGeneration: 1, switchingProfileId: null, error: null })
    const user = userEvent.setup()
    render(<ServerOnboardingDialog />)

    await user.type(await screen.findByPlaceholderText('user@server or SSH alias'), 'user@server')
    await user.click(screen.getByRole('button', { name: 'Install over SSH' }))
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }))

    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(expect.stringContaining('State: failed')))
    expect(writeClipboard).toHaveBeenCalledWith(expect.stringContaining('SSH connection closed.'))
    expect(screen.getByText('Diagnostics copied.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open log' }))
    await waitFor(() => expect(openLog).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Opened the setup log.')).toBeInTheDocument()
  })

  it('does not interrupt an already configured install', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        settings: { get: vi.fn().mockResolvedValue({ serverUrl: 'http://server.test', hasAccessToken: true, serverIdentity: 'server-1', serverSetupComplete: true }) },
        setup: { capabilities: vi.fn().mockResolvedValue({ available: true, local: true, ssh: true }) },
        events: { on: vi.fn().mockReturnValue(() => undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ connected: false })
    render(<ServerOnboardingDialog />)
    await waitFor(() => expect(window.agentsDock.settings.get).toHaveBeenCalled())
    expect(screen.queryByRole('heading', { name: 'Connect your agent server' })).not.toBeInTheDocument()
  })
})

describe('SessionDialog runtime selection', () => {
  afterEach(cleanup)

  const runtimeCatalog: RuntimeCatalog = {
    backends: {
      claude: { models: [{ value: 'sonnet', label: 'Sonnet' }], efforts: [] },
      codex: {
        default_model: 'gpt-5.6-sol', default_effort: 'medium',
        models: [
          { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: [
            { value: 'medium', label: 'Medium' }, { value: 'ultra', label: 'Ultra' }
          ] },
          { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: [
            { value: 'high', label: 'High' }, { value: 'max', label: 'Max' }
          ] }
        ],
        efforts: [
          { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
          { value: 'max', label: 'Max' }, { value: 'ultra', label: 'Ultra' }
        ]
      }
    }
  }

  it('creates a custom Codex chat without replacing normal Codex choices', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'custom-chat' })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      sessions: { create }, preferences: { set: vi.fn().mockResolvedValue(undefined) }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({ profiles: [], activeProfileId: null, profileGeneration: 0, sessions: [],
      health: { ok: true, capabilities: { codex_provider_v1: { per_chat: true, per_chat_models: true } } },
      runtimeCatalog: { backends: { ...runtimeCatalog.backends, codex: { ...runtimeCatalog.backends.codex,
        custom_provider: { configured: true, available: true, model: null, base_url: 'https://inference.example/v1',
          models: [{ value: 'provider/fast', label: 'Provider Fast' }], efforts: [{ value: 'high', label: 'High' }] }
      } } }, refreshSessions: vi.fn().mockResolvedValue(undefined), selectSession: vi.fn().mockResolvedValue(undefined),
      modals: { settings: false, newChat: true, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<SessionDialog mode="newChat" />)
    expect(screen.getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Codex · Custom endpoint' }))
    expect(screen.getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Reasoning')).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'GPT-5.6-Sol' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Model'), 'provider/fast')
    await user.selectOptions(screen.getByLabelText('Reasoning'), 'high')
    await user.selectOptions(screen.getByLabelText('Model'), '__manual__')
    await user.clear(screen.getByLabelText('Model ID'))
    await user.type(screen.getByLabelText('Model ID'), 'provider/unlisted')
    await user.click(screen.getByRole('button', { name: 'Create chat' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ backend: 'codex', codex_provider: 'custom', model: 'provider/unlisted', effort: 'high' })))
  })

  it('opens Settings for an unconfigured custom option without creating a normal Codex chat', async () => {
    const create = vi.fn()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sessions: { create } } as unknown as AgentsDockAPI })
    useAppStore.setState({ sessions: [], runtimeCatalog, health: { ok: true },
      modals: { settings: false, appSettings: false, newChat: true, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<SessionDialog mode="newChat" />)
    await user.click(screen.getByRole('button', { name: /Codex · Custom endpoint · Configure in Settings/ }))
    expect(useAppStore.getState().modals.appSettings).toBe(true)
    expect(useAppStore.getState().modals.newChat).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it.each([{ mode: 'newChat' as const }, { mode: 'resume' as const }])(
    'offers an import-chat entry that opens the importer from the $mode dialog',
    async ({ mode }) => {
      Object.defineProperty(window, 'agentsDock', {
        configurable: true,
        value: { sessions: {} } as unknown as AgentsDockAPI
      })
      useAppStore.setState({
        sessions: [], runtimeCatalog,
        health: {
          ok: true, api_contract_version: 15,
          capabilities: { local_session_import_v1: { available: true, required: false, message: '', action: null, version: 1, max_batch_items: 25, max_list_items: 500 } }
        },
        modals: {
          settings: false, newChat: mode === 'newChat', resume: mode === 'resume', folder: false,
          digest: false, job: false, search: false, review: false, importChats: false
        }
      })
      const user = userEvent.setup()
      render(<SessionDialog mode={mode} />)

      await user.click(screen.getByRole('button', { name: /Import an existing chat from your computer/ }))

      expect(useAppStore.getState().modals.importChats).toBe(true)
      expect(useAppStore.getState().modals[mode]).toBe(false)
    }
  )

  it('hides the import-chat entry when the server lacks local import support', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: {} } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [], runtimeCatalog, health: { ok: true, capabilities: {} },
      modals: {
        settings: false, newChat: true, resume: false, folder: false,
        digest: false, job: false, search: false, review: false, importChats: false
      }
    })
    render(<SessionDialog mode="newChat" />)

    expect(screen.queryByRole('button', { name: /Import an existing chat from your computer/ })).not.toBeInTheDocument()
  })

  it.each([
    { mode: 'newChat' as const, action: 'Create chat' },
    { mode: 'resume' as const, action: 'Resume chat' }
  ])('submits a compatible effort from the $mode dialog', async ({ mode, action }) => {
    const create = vi.fn().mockResolvedValue({ id: 'created-chat' })
    const resume = vi.fn().mockResolvedValue({ id: 'resumed-chat' })
    const setPreference = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { create, resume }, preferences: { set: setPreference } } as unknown as AgentsDockAPI
    })
    const refreshSessions = vi.fn().mockResolvedValue(undefined)
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      profiles: [], activeProfileId: null, profileGeneration: 0,
      sessions: [], runtimeCatalog, health: { ok: true, default_cwd: '/work' },
      refreshSessions, selectSession,
      modals: {
        settings: false, newChat: mode === 'newChat', resume: mode === 'resume', folder: false,
        digest: false, job: false, search: false, review: false, importChats: false
      }
    })
    const user = userEvent.setup()
    render(<SessionDialog mode={mode} />)

    if (mode === 'resume') await user.type(screen.getByLabelText('Claude session or Codex thread ID'), 'thread-123')
    await user.selectOptions(screen.getByLabelText('Model'), 'gpt-5.6-sol')
    await user.selectOptions(screen.getByLabelText('Reasoning'), 'ultra')
    await user.selectOptions(screen.getByLabelText('Model'), 'gpt-5.6-luna')

    expect(screen.getByLabelText('Reasoning')).toHaveValue('max')
    expect(screen.getByRole('option', { name: 'Max' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Ultra' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: action }))

    if (mode === 'resume') {
      await waitFor(() => expect(resume).toHaveBeenCalledWith(expect.objectContaining({
        providerId: 'thread-123', backend: 'codex', model: 'gpt-5.6-luna', effort: 'max'
      })))
    } else {
      await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'codex', model: 'gpt-5.6-luna', effort: 'max', cwd: '/work'
      })))
      expect(setPreference).toHaveBeenCalledWith('newChatDefaults:v1', expect.objectContaining({
        folder: 'General', cwd: '/work', backend: 'codex', model: 'gpt-5.6-luna', effort: 'max'
      }))
    }
    if (mode === 'resume') expect(setPreference).not.toHaveBeenCalled()
  })

  it.each([
    { mode: 'newChat' as const, action: 'Create chat' },
    { mode: 'resume' as const, action: 'Resume chat' }
  ])('browses the active server without submitting the $mode form and submits the chosen folder', async ({ mode, action }) => {
    const create = vi.fn().mockResolvedValue({ id: 'created-chat' })
    const resume = vi.fn().mockResolvedValue({ id: 'resumed-chat' })
    const complete = vi.fn(async (path: string) => ({
      input: path,
      resolved_path: path,
      exists: true,
      base_path: path,
      suggestions: [{ name: 'project', path: `${path}/project/` }],
      truncated: false,
      message: null
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { create, resume }, workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    const refreshSessions = vi.fn().mockResolvedValue(undefined)
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      sessions: [], runtimeCatalog,
      health: { ok: true, default_cwd: '/work', capabilities: { working_directory_completion: { available: true, required: false, message: '', action: null } } },
      refreshSessions, selectSession,
      modals: {
        settings: false, newChat: mode === 'newChat', resume: mode === 'resume', folder: false,
        digest: false, job: false, search: false, review: false, importChats: false
      }
    })
    const user = userEvent.setup()
    render(<SessionDialog mode={mode} />)

    if (mode === 'resume') await user.type(screen.getByLabelText('Claude session or Codex thread ID'), 'thread-123')
    await user.click(screen.getByRole('button', { name: 'Browse folders on active server' }))

    expect(create).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Browse server folders' })).toBeVisible()
    await user.click(await screen.findByRole('button', { name: 'Open folder project' }))
    expect(screen.getByRole('combobox', { name: 'Working directory' })).toHaveValue('/work')
    expect(create).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: 'Use this folder' }))
    expect(screen.getByRole('combobox', { name: 'Working directory' })).toHaveValue('/work/project/')
    expect(screen.queryByRole('dialog', { name: 'Browse server folders' })).not.toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: action }))
    const submit = mode === 'resume' ? resume : create
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/work/project/' })))
  })

  it('cancels server-folder browsing without closing or submitting the New Chat dialog', async () => {
    const create = vi.fn()
    const complete = vi.fn(async (path: string) => ({
      input: path,
      resolved_path: path,
      exists: true,
      base_path: path,
      suggestions: [{ name: 'project', path: '/work/project/' }],
      truncated: false,
      message: null
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { create }, workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [], runtimeCatalog,
      health: { ok: true, default_cwd: '/work', capabilities: { working_directory_completion: { available: true, required: false, message: '', action: null } } },
      modals: {
        settings: false, newChat: true, resume: false, folder: false,
        digest: false, job: false, search: false, review: false, importChats: false
      }
    })
    const user = userEvent.setup()
    render(<SessionDialog mode="newChat" />)

    await user.click(screen.getByRole('button', { name: 'Browse folders on active server' }))
    await user.click(await screen.findByRole('button', { name: 'Open folder project' }))
    const browser = screen.getByRole('dialog', { name: 'Browse server folders' })
    await user.click(within(browser).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog', { name: 'Browse server folders' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'New chat' })).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Working directory' })).toHaveValue('/work')
    expect(create).not.toHaveBeenCalled()
  })

  it('requires server support and runtime readiness before creating a Cursor chat', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'cursor-chat' })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { create } } as unknown as AgentsDockAPI
    })
    const cursorCatalog: RuntimeCatalog = {
      backends: {
        ...runtimeCatalog.backends,
        cursor: {
          available: true,
          default_model: 'auto',
          models: [
            { value: 'auto', label: 'Auto' },
            { value: 'named-model', label: 'Named model', locked: true, locked_reason: 'Requires a paid Cursor plan' }
          ],
          efforts: []
        }
      }
    }
    const refreshSessions = vi.fn().mockResolvedValue(undefined)
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      sessions: [],
      runtimeCatalog: cursorCatalog,
      health: { ok: true, capabilities: {} },
      refreshSessions,
      selectSession,
      modals: {
        settings: false, newChat: true, resume: false, folder: false,
        digest: false, job: false, search: false, review: false, importChats: false
      }
    })
    const user = userEvent.setup()
    render(<SessionDialog mode="newChat" />)

    expect(screen.queryByRole('button', { name: 'Cursor' })).not.toBeInTheDocument()

    act(() => useAppStore.setState({ health: {
      ok: true,
      capabilities: {
        cursor_backend: {
          available: true,
          required: false,
          message: 'Cursor is ready.',
          action: null,
          version: 2,
          permission_modes: ['default', 'full_access', 'plan']
        }
      }
    } }))

    await user.click(await screen.findByRole('button', { name: /Cursor$/ }))
    const locked = screen.getByRole('option', { name: 'Named model (upgrade required)' })
    expect(locked).toBeDisabled()
    expect(locked).toHaveAttribute('title', 'Requires a paid Cursor plan')
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'named-model' } })
    expect(screen.getByRole('button', { name: 'Create chat' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Requires a paid Cursor plan')
    await user.selectOptions(screen.getByLabelText('Model'), 'auto')
    await user.click(screen.getByRole('button', { name: 'Create chat' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'cursor',
      model: 'auto',
      cursor_permission_mode: 'default'
    })))
  })

  it.each(['newChat', 'resume'] as const)(
    'keeps supported Cursor visible with setup guidance in the %s dialog while its catalog loads',
    async mode => {
      Object.defineProperty(window, 'agentsDock', {
        configurable: true,
        value: { sessions: {} } as unknown as AgentsDockAPI
      })
      useAppStore.setState({
        sessions: [],
        runtimeCatalog: null,
        health: {
          ok: true,
          runtimes: {
            cursor: {
              backend: 'cursor', status: 'ready', available: true,
              message: 'Cursor is installed and authenticated.',
              checked_at: '2026-08-30T12:00:00Z'
            }
          },
          capabilities: {
            cursor_backend: {
              available: true, required: false, message: 'Cursor is supported.', action: null,
              version: 2, permission_modes: ['default', 'full_access', 'plan']
            }
          }
        },
        modals: {
          settings: false,
          newChat: mode === 'newChat',
          resume: mode === 'resume',
          folder: false,
          digest: false,
          job: false,
          search: false,
          review: false,
          importChats: false
        }
      })
      const user = userEvent.setup()
      render(<SessionDialog mode={mode} />)

      const cursor = screen.getByRole('button', { name: /Cursor.*Unavailable/ })
      expect(cursor).toBeEnabled()
      await user.click(cursor)

      expect(screen.getByRole('alert')).toHaveTextContent(/model choices are still loading/i)
      expect(screen.getByRole('button', { name: mode === 'newChat' ? 'Create chat' : 'Resume chat' })).toBeDisabled()
    }
  )

  it('explains that Cursor resume binds provider context without importing its transcript', async () => {
    const resume = vi.fn().mockResolvedValue({ id: 'cursor-chat' })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { resume } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [],
      runtimeCatalog: {
        backends: {
          ...runtimeCatalog.backends,
          cursor: { available: true, models: [{ value: 'auto', label: 'Auto' }], efforts: [] }
        }
      },
      health: { ok: true, capabilities: { cursor_backend: {
        available: true, required: false, message: 'Cursor is ready.', action: null,
        version: 2, permission_modes: ['default', 'full_access', 'plan']
      } } },
      refreshSessions: vi.fn().mockResolvedValue(undefined),
      selectSession: vi.fn().mockResolvedValue(undefined),
      modals: {
        settings: false, newChat: false, resume: true, folder: false,
        digest: false, job: false, search: false, review: false, importChats: false
      }
    })
    const user = userEvent.setup()
    render(<SessionDialog mode="resume" />)

    await user.click(screen.getByRole('button', { name: /Cursor$/ }))
    expect(screen.getByText(/Earlier provider messages stay in Cursor and are not imported into this timeline/)).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Cursor session ID/), 'cursor-provider-1')
    await user.click(screen.getByRole('button', { name: 'Resume chat' }))

    await waitFor(() => expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'cursor', providerId: 'cursor-provider-1'
    })))
  })
})

describe('JobDialog', () => {
  afterEach(cleanup)

  it.each(['chat', 'standalone'] as const)('keeps custom Codex job admission and labels in %s mode independent of the normal model lock', async contextMode => {
    const create = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { jobs: { create } } as unknown as AgentsDockAPI })
    useAppStore.setState({ selectedSessionId: 'chat-1', sessions: [{ id: 'chat-1', title: 'Custom chat', backend: 'codex', codex_provider: 'custom', model: 'shared-model' }],
      health: { ok: true, capabilities: { codex_provider_v1: { per_chat: true, per_chat_models: true },
        scheduled_jobs: { available: true, required: false, message: '', action: null, version: 2, context_modes: ['chat', 'standalone'] }
      } }, runtimeCatalog: { backends: { codex: {
        models: [{ value: 'shared-model', label: 'Normal model', locked: true, locked_reason: 'Normal account model locked' }], efforts: [],
        custom_provider: { configured: true, available: true, model: 'shared-model', base_url: 'https://inference.example/v1' }
      } } }, drafts: {}, error: null,
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)
    if (contextMode === 'standalone') await user.click(screen.getByRole('button', { name: /Independent runs/ }))
    expect(within(screen.getByRole('group', { name: 'Backend' })).getByRole('button', { name: 'Codex · Custom endpoint' })).toBeVisible()
    expect(screen.queryByText(/Normal account model locked/)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Title'), 'Custom check')
    await user.type(screen.getByLabelText('Prompt'), 'Check the custom workspace')
    act(() => useAppStore.setState(state => ({ runtimeCatalog: { backends: { codex: {
      ...state.runtimeCatalog!.backends.codex, custom_provider: { configured: false, available: false, model: null, base_url: null }
    } } } })))
    expect(screen.getByRole('button', { name: 'Save job' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('custom endpoint is not ready')
    act(() => useAppStore.setState(state => ({ runtimeCatalog: { backends: { codex: {
      ...state.runtimeCatalog!.backends.codex, custom_provider: { configured: true, available: true, model: 'shared-model', base_url: 'https://inference.example/v1' }
    } } } })))
    await user.click(screen.getByRole('button', { name: 'Save job' }))
    await waitFor(() => expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ session_id: 'chat-1', backend: 'codex', context_mode: contextMode })))
  })

  const renderJobMentionPalette = (create = vi.fn()) => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-source',
      sessions: [
        { id: 'chat-source', title: 'Scheduler', backend: 'codex' },
        { id: 'chat-alpha', title: 'Alpha', backend: 'codex' },
        { id: 'chat-beta', title: 'Beta', backend: 'claude' }
      ],
      folderOrder: ['General'],
      health: { ok: true, capabilities: {
        scheduled_jobs: {
          available: true, required: false, message: 'Ready', action: null,
          version: 5, context_modes: ['chat', 'standalone'],
          features: { chat_references: true, route_hint_mentions: true }
        },
        cross_chat_handoffs_v1: durableHandoffCapability({
          actions: ['route', 'instruction', 'request_reply']
        })
      } },
      drafts: {},
      chatReferencesBySession: {},
      error: null,
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    render(<JobDialog />)
    return create
  }

  it('hard-gates scheduled @Chat authoring on jobs v5 and durable handoffs v7 route-hint features', async () => {
    renderJobMentionPalette()
    const currentHealth = useAppStore.getState().health!
    act(() => useAppStore.setState({ health: {
      ...currentHealth,
      capabilities: {
        ...currentHealth.capabilities!,
        scheduled_jobs: { ...currentHealth.capabilities!.scheduled_jobs!, version: 4 }
      }
    } }))
    const user = userEvent.setup()
    const prompt = screen.getByLabelText('Prompt')

    await user.type(prompt, '@')
    expect(screen.queryByRole('listbox', { name: 'Scheduled job chats' })).not.toBeInTheDocument()
    await user.clear(prompt)
    act(() => useAppStore.setState({ health: {
      ...currentHealth,
      capabilities: {
        ...currentHealth.capabilities!,
        cross_chat_handoffs_v1: { ...currentHealth.capabilities!.cross_chat_handoffs_v1!, version: 5 }
      }
    } }))
    await user.type(prompt, '@')
    expect(screen.queryByRole('listbox', { name: 'Scheduled job chats' })).not.toBeInTheDocument()
    await user.clear(prompt)
    act(() => useAppStore.setState({ health: currentHealth }))
    await user.type(prompt, '@')
    await user.click(await screen.findByRole('option', { name: /Alpha/ }))
    expect(document.querySelector('span[title="@Alpha · Route hint"]')).toHaveClass('composer-inline-reference', 'action-route')
    expect(screen.queryByText(/Scheduled action for/)).not.toBeInTheDocument()
  })

  it('does not throw when a scheduled target title begins with @', async () => {
    renderJobMentionPalette()
    act(() => useAppStore.setState({
      sessions: [...useAppStore.getState().sessions, { id: 'chat-ops', title: '@Ops', backend: 'codex' }]
    }))
    const user = userEvent.setup()
    const prompt = screen.getByLabelText('Prompt')

    await user.type(prompt, '@')
    await user.click(await screen.findByRole('option', { name: /@Ops/ }))

    expect(prompt).toHaveValue('@')
    expect(screen.queryByLabelText(/Scheduled action for @Ops/)).not.toBeInTheDocument()
    expect(useAppStore.getState().error).toMatch(/names beginning with @ cannot be referenced/i)
  })

  it('keeps a selected target visible and blocks save if its scheduled capability disappears', async () => {
    const create = vi.fn().mockResolvedValue({})
    renderJobMentionPalette(create)
    const user = userEvent.setup()
    const prompt = screen.getByLabelText('Prompt')
    await user.type(screen.getByLabelText('Title'), 'Keep authority')
    await user.type(prompt, 'Notify @Alp')
    await user.click(await screen.findByRole('option', { name: /Alpha/ }))
    expect(document.querySelector('span[title="@Alpha · Route hint"]')).toHaveClass('composer-inline-reference', 'action-route')

    const currentHealth = useAppStore.getState().health!
    act(() => useAppStore.setState({ health: {
      ...currentHealth,
      capabilities: {
        ...currentHealth.capabilities!,
        scheduled_jobs: {
          ...currentHealth.capabilities!.scheduled_jobs!,
          features: { chat_references: true, route_hint_mentions: false }
        }
      }
    } }))
    expect(document.querySelector('span[title="@Alpha · Route hint"]')).toHaveClass('unsupported')

    await user.click(screen.getByRole('button', { name: 'Save job' }))

    expect(create).not.toHaveBeenCalled()
    expect(prompt).toHaveValue('Notify @Alpha ')
    expect(document.querySelector('span[title="@Alpha · Route hint"]')).toBeInTheDocument()
    expect(useAppStore.getState().error).toMatch(/before saving scheduled @Chat route hints/i)
  })

  it('closes the scheduled-chat palette when the prompt loses focus', async () => {
    renderJobMentionPalette()
    const user = userEvent.setup()
    const prompt = screen.getByLabelText('Prompt')

    await user.type(prompt, '@')
    expect(await screen.findByRole('listbox', { name: 'Scheduled job chats' })).toBeVisible()
    await user.click(screen.getByLabelText('Title'))

    expect(screen.queryByRole('listbox', { name: 'Scheduled job chats' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Schedule a job' })).toBeVisible()
  })

  it('uses the first Escape for the palette and resets the first result when the same mention reopens', async () => {
    renderJobMentionPalette()
    const prompt = screen.getByLabelText('Prompt')

    fireEvent.change(prompt, { target: { value: '@', selectionStart: 1 } })
    const palette = await screen.findByRole('listbox', { name: 'Scheduled job chats' })
    const options = within(palette).getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(prompt, { key: 'ArrowDown' })
    expect(options[1]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(prompt, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Scheduled job chats' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Schedule a job' })).toBeVisible()

    fireEvent.click(prompt)
    const reopenedPalette = await screen.findByRole('listbox', { name: 'Scheduled job chats' })
    const reopened = within(reopenedPalette).getAllByRole('option')
    expect(reopened[0]).toHaveAttribute('aria-selected', 'true')
    expect(reopened[1]).toHaveAttribute('aria-selected', 'false')
  })

  it('does not navigate or select a scheduled-chat target during IME composition', async () => {
    renderJobMentionPalette()
    const prompt = screen.getByLabelText('Prompt')

    fireEvent.change(prompt, { target: { value: '@', selectionStart: 1 } })
    const palette = await screen.findByRole('listbox', { name: 'Scheduled job chats' })
    const options = within(palette).getAllByRole('option')
    fireEvent.keyDown(prompt, { key: 'ArrowDown', isComposing: true })
    fireEvent.keyDown(prompt, { key: 'Enter', isComposing: true })

    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('listbox', { name: 'Scheduled job chats' })).toBeVisible()
    expect(prompt).toHaveValue('@')
    expect(screen.queryByLabelText(/Scheduled action for/)).not.toBeInTheDocument()
  })

  it('caps scheduled chat targets at 16 and ignores a seventeenth selection', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create: vi.fn() } } as unknown as AgentsDockAPI
    })
    const targets = Array.from({ length: 17 }, (_, index) => ({
      id: `chat-target-${index + 1}`,
      title: `Chat ${String(index + 1).padStart(2, '0')}`,
      backend: 'codex' as const
    }))
    let promptText = ''
    const references: ChatReference[] = targets.slice(0, 16).map((target, index) => {
      if (index > 0) promptText += ' '
      const sourceTextStart = promptText.length
      promptText += `@${target.title}`
      return {
        session_id: target.id,
        display_title_snapshot: target.title,
        source_text_start: sourceTextStart,
        source_text_end: promptText.length,
        action: 'route'
      }
    })
    promptText += ' @Chat 17'
    useAppStore.setState({
      selectedSessionId: 'chat-source',
      sessions: [{ id: 'chat-source', title: 'Scheduler', backend: 'codex' }, ...targets],
      folderOrder: ['General'],
      health: { ok: true, capabilities: {
        scheduled_jobs: {
          available: true, required: false, message: 'Ready', action: null,
          version: 5, context_modes: ['chat', 'standalone'],
          features: { chat_references: true, route_hint_mentions: true }
        },
        cross_chat_handoffs_v1: durableHandoffCapability({ actions: ['route', 'instruction'] })
      } },
      drafts: { 'chat-source': promptText },
      chatReferencesBySession: { 'chat-source': references },
      error: null,
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    render(<JobDialog />)
    const prompt = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    prompt.setSelectionRange(promptText.length, promptText.length)
    fireEvent.click(prompt)

    const palette = await screen.findByRole('listbox', { name: 'Scheduled job chats' })
    expect(within(palette).getByRole('status')).toHaveTextContent('Maximum 16 chats')
    const seventeenth = within(palette).getByRole('option', { name: /Chat 17/ })
    expect(seventeenth).toBeDisabled()
    fireEvent.click(seventeenth)
    fireEvent.keyDown(prompt, { key: 'Enter' })

    expect(prompt).toHaveValue(promptText)
    expect(screen.queryByLabelText('Scheduled action for Chat 17')).not.toBeInTheDocument()
    expect(useAppStore.getState().error).toBe('Maximum 16 chats can be selected for a scheduled job.')
  })

  it('strips secure-peer chat references when hydrating and saving a scheduled job', async () => {
    const create = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create } } as unknown as AgentsDockAPI
    })
    const prompt = 'Ask @Studio/training'
    const routeId = '22e7bb2e-3b47-4be7-89fc-2cecd90f4434'
    useAppStore.setState({
      selectedSessionId: 'chat-source',
      sessions: [{ id: 'chat-source', title: 'Scheduler', backend: 'codex' }],
      folderOrder: ['General'],
      health: { ok: true, capabilities: {
        scheduled_jobs: {
          available: true, required: false, message: 'Ready', action: null,
          version: 4, context_modes: ['chat', 'standalone'],
          features: { chat_references: true, direct_message_mentions: true, route_mentions: true }
        },
        cross_chat_handoffs_v1: {
          available: true, required: false, message: 'Ready', action: null,
          version: 2, actions: ['instruction', 'request_reply'],
          default_action: 'instruction', supported_target_backends: ['codex', 'claude']
        }
      } },
      drafts: { 'chat-source': prompt },
      chatReferencesBySession: { 'chat-source': [{
        session_id: routeId,
        display_title_snapshot: 'Studio/training',
        source_text_start: 4,
        source_text_end: 20,
        action: 'instruction',
        target_kind: 'secure_peer',
        target_server_identity: 'server-studio',
        target_connection_id: '12e7bb2e-3b47-4be7-89fc-2cecd90f4434',
        target_route_id: routeId,
        target_route_revision: `rev_${'a'.repeat(32)}`
      }] },
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)

    expect(screen.getByLabelText('Prompt')).toHaveValue(prompt)
    expect(screen.queryByLabelText('Scheduled action for Studio/training')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Title'), 'Local schedule')
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'chat-source',
      prompt,
      chat_references: []
    })))
  })

  it('stores an inline @ route hint for future runs without contacting the target on save', async () => {
    const create = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [
        { id: 'chat-1', title: 'Scheduler', backend: 'codex' },
        { id: 'chat-mobile', title: 'Mobile', backend: 'claude', folder: 'Personal' }
      ],
      folderOrder: ['Personal'],
      health: { ok: true, capabilities: {
        scheduled_jobs: {
          available: true, required: false, message: 'Ready', action: null,
          version: 5, context_modes: ['chat', 'standalone'],
          features: { chat_references: true, route_hint_mentions: true }
        },
        cross_chat_handoffs_v1: durableHandoffCapability({ default_action: 'request_reply' })
      } },
      drafts: {},
      chatReferencesBySession: {},
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)

    await user.type(screen.getByLabelText('Title'), 'Route later')
    await user.type(screen.getByLabelText('Prompt'), 'Send report to @Mob')
    await user.click(await screen.findByRole('option', { name: /Mobile/ }))
    expect(screen.getByLabelText('Prompt')).toHaveValue('Send report to @Mobile ')
    expect(document.querySelector('span[title="@Mobile · Route hint"]')).toHaveClass('composer-inline-reference', 'action-route')
    expect(document.querySelector('.chat-reference-shelf')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'chat-1',
      prompt: 'Send report to @Mobile',
      chat_references: [{
        session_id: 'chat-mobile',
        display_title_snapshot: 'Mobile',
        source_text_start: 15,
        source_text_end: 22,
        action: 'route'
      }]
    })))
  })

  it.each([
    { mention: 'bulletin', recipientKind: 'all' },
    { mention: 'all', recipientKind: 'all_servers' }
  ] as const)('keeps a legacy Team recipient readable and adds @@$mention through the shared picker', async ({ mention, recipientKind }) => {
    const create = vi.fn().mockResolvedValue({})
    const status = {
      version: 1, profileId: 'profile-a', profileGeneration: 4,
      serverIdentity: 'server-local', serverName: 'Local', serverUrl: 'http://127.0.0.1:7850',
      generation: 3, hubUrl: 'https://hub.test', hubIdentity: 'hub-1', savedHubIdentity: 'hub-1',
      connectionState: 'authenticated', authenticated: true, error: null
    }
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        jobs: { create },
        teamHub: {
          status: vi.fn().mockResolvedValue(status),
          teamMessagesCapabilities: vi.fn().mockResolvedValue({ available: true, version: 1,
            all_servers: { available: true, version: 1, mention: '@@all', recipient_kind: 'all_servers', max_recipients_per_message: 1024 }
          }),
          workspace: vi.fn().mockResolvedValue({
            status,
            teams: [{ id: 'team-1', kind: 'shared', slug: 'core', display_name: 'Core', role: 'owner', status: 'active' }]
          }),
          team: vi.fn().mockResolvedValue({
            team: { id: 'team-1' }, membership: { principal_id: 'person-0', role: 'owner', status: 'active', display_name: 'Pat' },
            members: [{ principal_id: 'person-1', role: 'member', status: 'active', display_name: 'DPark' }],
            nodes: [], channels: []
          }),
          network: vi.fn().mockResolvedValue({ servers: [], agents: [], next_after_server_id: null, has_more: false }),
          teamSkills: vi.fn().mockResolvedValue({ skills: [{
            id: 'skill-1', team_id: 'team-1', slug: 'incident-response', title: 'Incident response', summary: '', tags: [], current_version: 1,
            created_by_principal_id: 'person-1', pinned_at: null, pinned_by: null, archived_at: null, archived_by: null,
            created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:00Z'
          }] })
        }
      } as unknown as AgentsDockAPI
    })
    const promptText = '  Tell @@DPark about @@raw; use @@'
    const recipient: TeamReference = {
      kind: 'recipient', recipient_kind: 'human', team_id: 'team-1', target_id: 'person-1',
      display_name_snapshot: 'DPark', source_text_start: 7, source_text_end: 14, grant_intent: true
    }
    useAppStore.setState({
      activeProfileId: 'profile-a', profileGeneration: 4,
      profiles: [{
        id: 'profile-a', name: 'Local', serverUrl: 'http://127.0.0.1:7850', serverIdentity: 'server-local',
        hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0
      }],
      selectedSessionId: 'chat-source', sessions: [{ id: 'chat-source', title: 'Scheduler', backend: 'codex' }],
      health: { ok: true, capabilities: {
        scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 5, context_modes: ['chat'] },
        agent_team_messages_v1: {
          available: true, required: false, message: 'Ready', action: null,
          version: 1, helper: 'team', mention_sigil: '@@', read_always: true, send_requires_mention: true,
          recipient_kinds: ['server', 'human', 'all'], reference_kinds: ['recipient', 'skill'],
          max_sends_per_run: 4, max_attachments_per_send: 16, max_body_bytes: 49_152
        },
        team_bulletin_alias_v1: {
          available: true, required: false, version: 1,
          mention: '@@bulletin', legacy_mention: '@@all'
        },
        team_all_servers_alias_v1: {
          available: true, version: 1, mention: '@@all', recipient_kind: 'all_servers',
          max_recipients_per_message: 1024
        }
      } },
      drafts: { 'chat-source': promptText }, chatReferencesBySession: {},
      teamReferencesBySession: { 'chat-source': [recipient] }, error: null,
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)

    expect(document.querySelector('span[title="@@DPark · Team member"]')).toHaveClass('team-reference')
    const prompt = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    prompt.setSelectionRange(promptText.length, promptText.length)
    fireEvent.click(prompt)
    const palette = await screen.findByRole('listbox', { name: 'Team Network destinations' })
    expect(screen.queryByRole('listbox', { name: 'Scheduled job chats' })).not.toBeInTheDocument()
    expect(within(palette).queryByRole('option', { name: /DPark/ })).not.toBeInTheDocument()
    expect(within(palette).queryByRole('option', { name: /Incident response/ })).not.toBeInTheDocument()
    expect(within(palette).getByRole('option', { name: /All servers.*@@all/i })).toBeVisible()
    await user.click(within(palette).getByRole('option', { name: mention === 'bulletin' ? /Bulletin.*@@bulletin/i : /All servers.*@@all/i }))
    await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())))
    await user.type(screen.getByLabelText('Title'), 'Team runbook')
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      prompt: `Tell @@DPark about @@raw; use @@${mention}`,
      team_references: [
        { ...recipient, source_text_start: 5, source_text_end: 12 },
        {
          kind: 'recipient', recipient_kind: recipientKind, team_id: 'team-1', target_id: recipientKind, display_name_snapshot: mention,
          source_text_start: 30, source_text_end: 32 + mention.length, grant_intent: true
        }
      ]
    })))
  })

  it('keeps an edited job Team reference atomic, capability-gated, and aligned after trim', async () => {
    const update = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { update } } as unknown as AgentsDockAPI
    })
    const teamHealth: Health = { ok: true, capabilities: {
      scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 5, context_modes: ['chat'] },
      agent_team_messages_v1: {
        available: true, required: false, message: 'Ready', action: null,
        version: 1, helper: 'team', mention_sigil: '@@', read_always: true, send_requires_mention: true,
        recipient_kinds: ['server', 'human', 'all'], reference_kinds: ['recipient', 'skill'],
        max_sends_per_run: 4, max_attachments_per_send: 16, max_body_bytes: 49_152
      }
    } }
    useAppStore.setState({
      selectedSessionId: 'chat-source', sessions: [{ id: 'chat-source', title: 'Scheduler', backend: 'codex' }],
      health: teamHealth, error: null,
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:edit-job', { detail: {
      id: 'job-team', session_id: 'chat-source', title: 'Notify team', prompt: 'Notify @@DPark weekly',
      team_references: [{
        kind: 'recipient', recipient_kind: 'human', team_id: 'team-1', target_id: 'person-1',
        display_name_snapshot: 'DPark', source_text_start: 7, source_text_end: 14, grant_intent: true
      }],
      interval_seconds: 3600, schedule_kind: 'interval', loop: true, enabled: true
    } })))

    const prompt = await screen.findByLabelText('Prompt')
    fireEvent.change(prompt, { target: { value: '  Please notify @@DPark weekly', selectionStart: 30 } })
    expect(document.querySelector('span[title="@@DPark · Team member"]')).toHaveClass('team-reference')
    act(() => useAppStore.setState({ health: { ...teamHealth, capabilities: { scheduled_jobs: teamHealth.capabilities!.scheduled_jobs } } }))
    await user.click(screen.getByRole('button', { name: 'Save job' }))
    expect(update).not.toHaveBeenCalled()
    expect(useAppStore.getState().error).toMatch(/before saving scheduled @@ Team Network hints/i)

    act(() => useAppStore.setState({ health: teamHealth, error: null }))
    await user.click(screen.getByRole('button', { name: 'Save job' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('job-team', {
      prompt: 'Please notify @@DPark weekly',
      team_references: [{
        kind: 'recipient', recipient_kind: 'human', team_id: 'team-1', target_id: 'person-1',
        display_name_snapshot: 'DPark', source_text_start: 14, source_text_end: 21, grant_intent: true
      }]
    }))
  })

  it('strips an ordinary draft grant intent when prefilling an independent scheduled route', async () => {
    const create = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-source',
      sessions: [
        { id: 'chat-source', title: 'Scheduler', backend: 'codex' },
        { id: 'chat-target', title: 'Target', backend: 'claude' }
      ],
      health: { ok: true, capabilities: {
        scheduled_jobs: {
          available: true, required: false, message: 'Ready', action: null,
          version: 5, context_modes: ['chat'],
          features: { chat_references: true, route_hint_mentions: true }
        },
        cross_chat_handoffs_v1: durableHandoffCapability()
      } },
      drafts: { 'chat-source': 'Ask @Target' },
      chatReferencesBySession: { 'chat-source': [{
        session_id: 'chat-target', display_title_snapshot: 'Target',
        source_text_start: 4, source_text_end: 11, action: 'route', grant_intent: true
      }] },
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)

    expect(screen.getByLabelText('Prompt')).toHaveValue('Ask @Target')
    await user.type(screen.getByLabelText('Title'), 'Scheduled ask')
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Ask @Target',
      chat_references: [{
        session_id: 'chat-target', display_title_snapshot: 'Target',
        source_text_start: 4, source_text_end: 11, action: 'route'
      }]
    })))
  })

  it('uses /chat as an alias for the same @ route hint and explains that saving contacts nobody', async () => {
    const create = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [
        { id: 'chat-1', title: 'Scheduler', backend: 'codex' },
        { id: 'chat-mobile', title: 'Mobile', backend: 'claude' }
      ],
      health: { ok: true, capabilities: {
        scheduled_jobs: {
          available: true, required: false, message: 'Ready', action: null,
          version: 5, context_modes: ['chat'],
          features: { chat_references: true, route_hint_mentions: true }
        },
        cross_chat_handoffs_v1: durableHandoffCapability({ actions: ['route', 'instruction'] })
      } },
      drafts: {},
      chatReferencesBySession: {},
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)

    expect(screen.getByText(/@chat gives the scheduled agent that route.*may send, ask, or make no contact.*Saving the job contacts nobody/i)).toBeVisible()
    await user.type(screen.getByLabelText('Title'), 'Route later')
    await user.type(screen.getByLabelText('Prompt'), 'Consult /chat Mob')
    await user.click(await screen.findByRole('option', { name: /Mobile/ }))
    expect(screen.getByLabelText('Prompt')).toHaveValue('Consult @Mobile ')
    expect(document.querySelector('span[title="@Mobile · Route hint"]')).toHaveClass('action-route')
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Consult @Mobile',
      chat_references: [expect.objectContaining({
        session_id: 'chat-mobile', source_text_start: 8, source_text_end: 15, action: 'route'
      })]
    })))
  })

  it('does not wipe an in-progress job when server health refreshes', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create: vi.fn() } } as unknown as AgentsDockAPI
    })
    const health: Health = { ok: true, capabilities: {
      scheduled_jobs: {
        available: true, required: false, message: 'Ready', action: null,
        version: 3, context_modes: ['chat', 'standalone'], features: { chat_references: true }
      },
      cross_chat_handoffs_v1: {
        available: true, required: false, message: 'Ready', action: null,
        version: 4, actions: ['instruction', 'request_reply', 'final_result'],
        default_action: 'instruction', supported_target_backends: ['codex', 'claude']
      }
    } }
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Scheduler', backend: 'codex' }],
      health,
      drafts: {},
      chatReferencesBySession: {},
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)

    await user.type(screen.getByLabelText('Title'), 'Do not erase me')
    await user.type(screen.getByLabelText('Prompt'), 'Keep this prompt')
    act(() => useAppStore.setState({ health: {
      ...health,
      capabilities: {
        ...health.capabilities!,
        scheduled_jobs: { ...health.capabilities!.scheduled_jobs!, message: 'Still ready' }
      }
    } }))

    expect(screen.getByLabelText('Title')).toHaveValue('Do not erase me')
    expect(screen.getByLabelText('Prompt')).toHaveValue('Keep this prompt')
  })

  it('hydrates and updates a scheduled chat target without resolving it by title', async () => {
    const update = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { update } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [
        { id: 'chat-1', title: 'Scheduler', backend: 'codex' },
        { id: 'chat-mobile', title: 'Mobile renamed', backend: 'claude' }
      ],
      health: { ok: true, capabilities: {
        scheduled_jobs: {
          available: true, required: false, message: 'Ready', action: null,
          version: 5, context_modes: ['chat', 'standalone'], features: { chat_references: true, route_hint_mentions: true }
        },
        cross_chat_handoffs_v1: durableHandoffCapability()
      } },
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:edit-job', { detail: {
      id: 'job-route', session_id: 'chat-1', title: 'Notify later', prompt: 'Notify @Mobile',
      chat_references: [{
        session_id: 'chat-mobile', display_title_snapshot: 'Mobile',
        source_text_start: 7, source_text_end: 14, action: 'direct_message'
      }],
      interval_seconds: 3600, schedule_kind: 'interval', loop: true, enabled: true
    } })))

    expect(await screen.findByTitle('@Mobile · Route hint')).toHaveClass('composer-inline-reference', 'action-route')
    expect(screen.getByLabelText('Prompt')).toHaveValue('Notify @Mobile')
    expect(screen.queryByRole('combobox', { name: /Scheduled action/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('job-route', {
      chat_references: [{
        session_id: 'chat-mobile', display_title_snapshot: 'Mobile',
        source_text_start: 7, source_text_end: 14, action: 'route'
      }]
    }))
  })

  it('creates a timezone-aware cron job with inactive schedule fields cleared', async () => {
    const create = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Status', backend: 'codex', model: 'gpt-5', effort: 'medium' }],
      health: { ok: true, capabilities: { scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 2, context_modes: ['chat', 'standalone'] } } },
      drafts: {},
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)

    await user.type(screen.getByLabelText('Title'), 'Weekday status')
    await user.click(screen.getByRole('button', { name: 'Cron' }))
    await user.clear(screen.getByLabelText('Cron expression'))
    await user.type(screen.getByLabelText('Cron expression'), '0 9 * * 1-5')
    await user.clear(screen.getByLabelText('Timezone'))
    await user.type(screen.getByLabelText('Timezone'), 'America/Los_Angeles')
    await user.type(screen.getByLabelText('Prompt'), 'Check the full status.')
    expect(screen.getByRole('button', { name: /Continue in this chat/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      session_id: 'chat-1', title: 'Weekday status', prompt: 'Check the full status.',
      schedule_kind: 'cron', interval_seconds: null, cron_expression: '0 9 * * 1-5', rrule: null,
      timezone: 'America/Los_Angeles', first_run_at: null, loop: true, max_runs: null, enabled: true,
      context_mode: 'chat', backend: 'codex'
    }))
  })

  it('can create a job whose runs use fresh provider contexts', async () => {
    const create = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Status', backend: 'codex' }],
      health: { ok: true, capabilities: { scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 2, context_modes: ['chat', 'standalone'] } } },
      drafts: {},
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)

    await user.type(screen.getByLabelText('Title'), 'Fresh status')
    await user.type(screen.getByLabelText('Prompt'), 'Inspect current state.')
    await user.click(screen.getByRole('button', { name: /Independent runs/ }))
    expect(screen.getByRole('button', { name: /Independent runs/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'chat-1',
      context_mode: 'standalone'
    })))
  })

  it('offers Cursor for independent scheduled runs only with the complete backend contract', async () => {
    const create = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create } } as unknown as AgentsDockAPI
    })
    const cursorHealth: Health = {
      ok: true,
      capabilities: {
        scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 2, context_modes: ['chat', 'standalone'] },
        cursor_backend: {
          available: true, required: false, message: 'Cursor is ready.', action: null,
          version: 2, permission_modes: ['default', 'full_access', 'plan']
        }
      }
    }
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Status', backend: 'codex' }],
      health: cursorHealth,
      runtimeCatalog: null,
      drafts: {},
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)

    await user.click(screen.getByRole('button', { name: /Independent runs/ }))
    const unavailableCursor = within(screen.getByRole('group', { name: 'Backend' })).getByRole('button', { name: /Cursor.*Unavailable/ })
    expect(unavailableCursor).toBeDisabled()
    expect(unavailableCursor).toHaveAttribute('title', expect.stringContaining('status is still loading'))
    expect(screen.getByText(/status is still loading/)).toHaveAttribute('id', 'job-cursor-runtime-help')

    act(() => useAppStore.setState({ runtimeCatalog: {
      backends: {
        cursor: { available: true, models: [{ value: 'auto', label: 'Auto' }], efforts: [] }
      }
    } }))
    await user.click(await screen.findByRole('button', { name: /^Cursor$/ }))
    await user.type(screen.getByLabelText('Title'), 'Fresh Cursor report')
    await user.type(screen.getByLabelText('Prompt'), 'Inspect the workspace.')
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      context_mode: 'standalone', backend: 'cursor'
    })))
  })

  it('blocks a same-backend independent job when its inherited Cursor model is locked but clears the model after a backend switch', async () => {
    const create = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Cursor status', backend: 'cursor', model: 'named-model' }],
      health: { ok: true, capabilities: {
        scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 2, context_modes: ['chat', 'standalone'] },
        cursor_backend: {
          available: true, required: false, message: 'Cursor is ready.', action: null,
          version: 2, permission_modes: ['default', 'full_access', 'plan']
        }
      } },
      runtimeCatalog: { backends: {
        codex: { available: true, models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }], efforts: [] },
        cursor: { available: true, models: [
          { value: 'auto', label: 'Auto' },
          { value: 'named-model', label: 'Named model', locked: true, locked_reason: 'Requires a paid Cursor plan' }
        ], efforts: [] }
      } },
      drafts: {},
      error: null,
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)

    await user.type(screen.getByLabelText('Title'), 'Fresh report')
    await user.type(screen.getByLabelText('Prompt'), 'Inspect the workspace.')
    await user.click(screen.getByRole('button', { name: /Independent runs/ }))

    expect(screen.getByRole('alert')).toHaveTextContent('Requires a paid Cursor plan')
    expect(screen.getByRole('button', { name: 'Save job' })).toBeDisabled()
    expect(create).not.toHaveBeenCalled()

    await user.click(within(screen.getByRole('group', { name: 'Backend' })).getByRole('button', { name: /Codex/ }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'chat-1', context_mode: 'standalone', backend: 'codex'
    })))
  })

  it('applies inherited Cursor model locks while editing same-backend independent jobs', async () => {
    const update = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { update } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Cursor status', backend: 'cursor', model: 'named-model' }],
      health: { ok: true, capabilities: {
        scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 2, context_modes: ['chat', 'standalone'] },
        cursor_backend: {
          available: true, required: false, message: 'Cursor is ready.', action: null,
          version: 2, permission_modes: ['default', 'full_access', 'plan']
        }
      } },
      runtimeCatalog: { backends: {
        codex: { available: true, models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }], efforts: [] },
        cursor: { available: true, models: [
          { value: 'auto', label: 'Auto' },
          { value: 'named-model', label: 'Named model', locked: true, locked_reason: 'Requires a paid Cursor plan' }
        ], efforts: [] }
      } },
      error: null,
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:edit-job', { detail: {
      id: 'job-cursor', session_id: 'chat-1', title: 'Fresh report', prompt: 'Inspect the workspace.',
      interval_seconds: 3600, schedule_kind: 'interval', loop: true, enabled: true,
      context_mode: 'standalone', backend: 'cursor'
    } })))

    expect(await screen.findByRole('alert')).toHaveTextContent('Requires a paid Cursor plan')
    expect(screen.getByRole('button', { name: 'Save job' })).toBeDisabled()
    expect(update).not.toHaveBeenCalled()

    await user.click(within(screen.getByRole('group', { name: 'Backend' })).getByRole('button', { name: /Codex/ }))
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('job-cursor', { backend: 'codex' }))
  })

  it('blocks an enabled Cursor job after capability loss but still lets it be paused', async () => {
    const update = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { update } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Status', backend: 'codex' }],
      health: { ok: true, capabilities: {
        scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 2, context_modes: ['chat', 'standalone'] },
        cursor_backend: { available: true, required: false, message: 'Ready', action: null, version: 2, permission_modes: ['default', 'full_access', 'plan'] }
      } },
      runtimeCatalog: { backends: { cursor: { available: true, models: [{ value: 'auto', label: 'Auto' }], efforts: [] } } },
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:edit-job', { detail: {
      id: 'job-cursor', session_id: 'chat-1', title: 'Fresh Cursor status', prompt: 'Check status',
      interval_seconds: 3600, schedule_kind: 'interval', loop: true, enabled: true,
      context_mode: 'standalone', backend: 'cursor'
    } })))
    expect(await screen.findByRole('button', { name: /Cursor$/ })).toHaveClass('active')

    act(() => useAppStore.setState({ health: { ok: true, capabilities: {
      scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 2, context_modes: ['chat', 'standalone'] }
    } } }))

    expect(screen.getByRole('alert')).toHaveTextContent(/Cursor is unavailable/)
    expect(screen.getByRole('button', { name: 'Save job' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'Enabled' }))
    await user.click(screen.getByRole('button', { name: 'Save job' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('job-cursor', { enabled: false }))
  })

  it('only allows another backend for independent runs and resets it in chat mode', async () => {
    const create = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Status', backend: 'codex' }],
      health: { ok: true, capabilities: { scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 2, context_modes: ['chat', 'standalone'] } } },
      drafts: {},
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)

    const backendPicker = within(screen.getByRole('group', { name: 'Backend' }))
    expect(backendPicker.queryByRole('button', { name: /Claude/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Independent runs/ }))
    await user.click(backendPicker.getByRole('button', { name: /Claude/ }))
    expect(backendPicker.getByRole('button', { name: /Claude/ })).toHaveClass('active')
    await user.click(screen.getByRole('button', { name: /Continue in this chat/ }))
    expect(backendPicker.queryByRole('button', { name: /Claude/ })).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Title'), 'Parent context')
    await user.type(screen.getByLabelText('Prompt'), 'Use this chat.')
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      context_mode: 'chat', backend: 'codex'
    })))
  })

  it('keeps legacy servers on the compatible in-chat mode', async () => {
    const create = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Status', backend: 'codex' }],
      health: { ok: true, capabilities: {} },
      drafts: {},
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)

    expect(screen.getByRole('button', { name: /Continue in this chat/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: /Independent runs/ })).not.toBeInTheDocument()
    expect(screen.getByText('Update AgentsServer to add independent runs.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Title'), 'Compatible status')
    await user.type(screen.getByLabelText('Prompt'), 'Check status.')
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create.mock.calls[0][0]).not.toHaveProperty('context_mode')
  })

  it('sends a recurrence first run as wall time in the selected timezone', async () => {
    const create = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { create } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Status', backend: 'codex' }],
      drafts: {},
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: true, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)
    await user.type(screen.getByLabelText('Title'), 'Morning status')
    await user.type(screen.getByLabelText('Prompt'), 'Check status')
    await user.click(screen.getByRole('button', { name: 'Cron' }))
    await user.clear(screen.getByLabelText('Timezone'))
    await user.type(screen.getByLabelText('Timezone'), 'America/Los_Angeles')
    await user.click(screen.getByRole('button', { name: 'At a time, then schedule' }))
    fireEvent.change(screen.getByLabelText('First run time'), { target: { value: '2026-07-22T09:00' } })
    await user.click(screen.getByRole('button', { name: 'Save job' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      timezone: 'America/Los_Angeles',
      first_run_at: '2026-07-22T09:00'
    })))
  })

  it('saves an edited cron next-run wall time instead of preserving the old occurrence', async () => {
    const update = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { update } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Status', backend: 'codex' }],
      health: { ok: true, capabilities: {} },
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:edit-job', { detail: {
      id: 'job-cron-time', session_id: 'chat-1', title: 'Weekday status', prompt: 'Check status',
      interval_seconds: null, schedule_kind: 'cron', cron_expression: '0 9 * * 1-5',
      rrule: null, timezone: 'America/Los_Angeles', next_run_at_iso: '2026-07-22T09:00',
      loop: true, enabled: true
    } })))

    await user.click(await screen.findByRole('button', { name: 'At a time, then schedule' }))
    fireEvent.change(screen.getByLabelText('Next run time'), { target: { value: '2026-07-23T10:15' } })
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('job-cron-time', {
      next_run_at: '2026-07-23T10:15'
    }))
  })

  it('sends an edited interval next run so the server can reanchor its recurring cadence', async () => {
    const update = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { update } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Status', backend: 'codex' }],
      health: { ok: true, capabilities: {} },
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:edit-job', { detail: {
      id: 'job-daily-time', session_id: 'chat-1', title: 'Daily status', prompt: 'Check status',
      interval_seconds: 86_400, schedule_kind: 'interval', next_run_at_iso: '2026-07-22T17:00:00Z',
      loop: true, max_runs: null, enabled: true
    } })))

    await user.click(await screen.findByRole('button', { name: 'At a time' }))
    fireEvent.change(screen.getByLabelText('Next run time'), { target: { value: '2026-07-23T10:15' } })
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('job-daily-time', {
      next_run_at: new Date('2026-07-23T10:15').toISOString()
    }))
  })

  it('clears the old expression when changing recurrence kinds', async () => {
    const update = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { update } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Status', backend: 'codex' }],
      health: { ok: true, capabilities: {} },
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:edit-job', { detail: {
      id: 'job-1', session_id: 'chat-1', title: 'Weekday status', prompt: 'Check status',
      interval_seconds: null, schedule_kind: 'cron', cron_expression: '0 9 * * 1-5',
      rrule: null, timezone: 'America/Los_Angeles', loop: true, enabled: true
    } })))

    await user.click(await screen.findByRole('button', { name: 'RRULE' }))
    await user.clear(screen.getByLabelText('RRULE'))
    await user.type(screen.getByLabelText('RRULE'), 'FREQ=WEEKLY;BYDAY=MO,WE')
    await user.click(screen.getByRole('button', { name: 'Next match' }))
    await user.click(screen.getByRole('button', { name: 'Save job' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('job-1', {
      schedule_kind: 'rrule', cron_expression: null, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
      next_run_at: null, enabled: true
    }))
  })

  it('treats a legacy job without a context mode as continuing in this chat', async () => {
    const update = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { update } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Status', backend: 'codex' }],
      health: { ok: true, capabilities: { scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 2, context_modes: ['chat', 'standalone'] } } },
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:edit-job', { detail: {
      id: 'job-legacy', session_id: 'chat-1', title: 'Legacy status', prompt: 'Check status',
      interval_seconds: 3600, schedule_kind: 'interval', loop: true, enabled: true
    } })))

    expect(await screen.findByRole('button', { name: /Continue in this chat/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Save job' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('job-legacy', {}))
  })

  it('persists a context-mode change when editing a standalone job', async () => {
    const update = vi.fn().mockResolvedValue({})
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { update } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Status', backend: 'codex' }],
      health: { ok: true, capabilities: { scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 2, context_modes: ['chat', 'standalone'] } } },
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    const user = userEvent.setup()
    render(<JobDialog />)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:edit-job', { detail: {
      id: 'job-standalone', session_id: 'chat-1', title: 'Fresh status', prompt: 'Check status',
      interval_seconds: 3600, schedule_kind: 'interval', loop: true, enabled: true,
      context_mode: 'standalone'
    } })))

    expect(await screen.findByRole('button', { name: /Independent runs/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: /Continue in this chat/ }))
    await user.click(screen.getByRole('button', { name: 'Save job' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('job-standalone', { context_mode: 'chat' }))
  })

  it('resolves an edited job backend from its current parent chat after chat switches', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { update: vi.fn().mockResolvedValue({}) } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-codex',
      sessions: [
        { id: 'chat-codex', title: 'Codex chat', backend: 'codex' },
        { id: 'chat-claude', title: 'Claude chat', backend: 'claude' }
      ],
      health: { ok: true, capabilities: { scheduled_jobs: { available: true, required: false, message: 'Ready', action: null, version: 2, context_modes: ['chat', 'standalone'] } } },
      modals: { settings: false, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
    })
    render(<JobDialog />)

    act(() => useAppStore.setState({ selectedSessionId: 'chat-claude' }))
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:edit-job', { detail: {
      id: 'job-claude', session_id: 'chat-claude', title: 'Fresh Claude status', prompt: 'Check status',
      interval_seconds: 3600, schedule_kind: 'interval', loop: true, enabled: true,
      context_mode: 'standalone'
    } })))

    const backendPicker = within(await screen.findByRole('group', { name: 'Backend' }))
    expect(backendPicker.getByRole('button', { name: /Claude/ })).toHaveClass('active')
  })
})

const preview = vi.fn()
const send = vi.fn()

describe('DigestDialog', () => {
  afterEach(cleanup)

  beforeEach(() => {
    preview.mockReset().mockResolvedValue('# AgentsDock Context Digest\n\nReady.')
    send.mockReset().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { digest: { preview, send } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'source', title: 'Source chat', backend: 'codex', folder: 'Research' }],
      selectedSessionId: 'source',
      folderOrder: ['Research', 'Jobs'],
      runtimeCatalog: null,
      switchingProfileId: null,
      error: null,
      modals: {
        settings: false,
        newChat: false,
        resume: false,
        folder: false,
        digest: true,
        job: false,
        search: false,
        review: false,
        importChats: false
      }
    })
  })

  it('selects the first valid target when sessions arrive after the dialog opens', async () => {
    render(<DigestDialog />)
    expect(screen.getByRole('button', { name: 'Send to chat' })).toBeDisabled()

    useAppStore.setState({
      sessions: [
        { id: 'source', title: 'Source chat', backend: 'codex', folder: 'Research' },
        { id: 'target', title: 'Target chat', backend: 'claude', folder: 'Jobs' }
      ]
    })

    expect(await screen.findByRole('option', { name: /Target chat/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Send to chat' })).toBeEnabled()
  })

  it('keeps the header close button usable while server content is switching', async () => {
    useAppStore.setState({ switchingProfileId: 'profile-b' })
    render(<DigestDialog />)

    const close = screen.getByRole('button', { name: 'Close Create context digest' })
    const previewButton = screen.getByRole('button', { name: 'Preview' })
    expect(close.closest('[inert]')).toBeNull()
    expect(previewButton.closest('[inert]')).not.toBeNull()

    await userEvent.setup().click(close)
    expect(useAppStore.getState().modals.digest).toBe(false)
  })

  it('keeps the dialog open and reports a rejected background request', async () => {
    send.mockResolvedValue(false)
    useAppStore.setState({
      sessions: [
        { id: 'source', title: 'Source chat', backend: 'codex' },
        { id: 'target', title: 'Target chat', backend: 'claude' }
      ]
    })
    render(<DigestDialog />)
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: 'Send to chat' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)

    expect(await screen.findByText('The server did not accept the digest request.')).toBeInTheDocument()
    expect(useAppStore.getState().modals.digest).toBe(true)
  })

  it('renders the LLM preview and sends the selected detail and prompt', async () => {
    useAppStore.setState({
      sessions: [
        { id: 'source', title: 'Source chat', backend: 'codex' },
        { id: 'target', title: 'Target chat', backend: 'claude' }
      ]
    })
    render(<DigestDialog />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('What should the target agent focus on?'), 'Focus on deployment')
    await user.click(screen.getByRole('button', { name: 'Deep' }))
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    expect(await screen.findByText(/# AgentsDock Context Digest/)).toBeInTheDocument()
    expect(preview).toHaveBeenCalledWith({
      sourceSessionId: 'source',
      targetSessionId: 'target',
      detail: 'deep',
      userPrompt: 'Focus on deployment'
    })
  })
})

const searchSessions: Session[] = [
  { id: 'alpha', title: 'Alpha', backend: 'codex', folder: 'Pinned' },
  { id: 'beta', title: 'Beta', backend: 'claude', folder: 'General' },
  { id: 'gamma', title: 'Gamma', backend: 'codex', folder: 'General' },
]
const realSwitchServer = useAppStore.getState().switchServer
const realSelectSession = useAppStore.getState().selectSession

describe('SearchDialog keyboard navigation', () => {
  afterEach(() => { cleanup(); clearSessionHistorySearchCache(); vi.restoreAllMocks() })

  beforeEach(() => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        sessions: { searchHistory: vi.fn().mockResolvedValue([]) },
      } as unknown as AgentsDockAPI,
    })
    useAppStore.setState(state => ({
      sessions: searchSessions,
      selectedSessionId: null,
      runtimeCatalog: null,
      modals: { ...state.modals, digest: false, search: true },
    }))
  })

  it('moves the active result with arrow keys and opens it with Enter', async () => {
    const selectSession = vi.spyOn(useAppStore.getState(), 'selectSession').mockImplementation(async selectedSessionId => { useAppStore.setState({ selectedSessionId }) })
    const user = userEvent.setup()
    render(<SearchDialog />)

    const input = screen.getByRole('combobox')
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    await user.click(input)
    await user.keyboard('{ArrowDown}')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveAttribute('aria-activedescendant', 'command-search-option-1')

    await user.keyboard('{Enter}')
    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('beta'))
    expect(useAppStore.getState().modals.search).toBe(false)
  })

  it('wraps ArrowUp from the first result to the last result', async () => {
    const user = userEvent.setup()
    render(<SearchDialog />)

    const input = screen.getByRole('combobox')
    await user.click(input)
    await user.keyboard('{ArrowUp}')

    const options = screen.getAllByRole('option')
    expect(options[options.length - 1]).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveAttribute('aria-activedescendant', `command-search-option-${options.length - 1}`)
  })

  it('restores search focus without closing or resetting an already-open switcher', async () => {
    const user = userEvent.setup()
    render(<SearchDialog />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'beta')
    screen.getByRole('button', { name: 'Close Search chats' }).focus()
    expect(input).not.toHaveFocus()

    window.dispatchEvent(new Event('agentsdock:focus-chat-switcher'))

    expect(input).toHaveFocus()
    expect(input).toHaveValue('beta')
    expect(useAppStore.getState().modals.search).toBe(true)
  })

  it('opens the result that was clicked', async () => {
    const selectSession = vi.spyOn(useAppStore.getState(), 'selectSession').mockImplementation(async selectedSessionId => { useAppStore.setState({ selectedSessionId }) })
    const user = userEvent.setup()
    render(<SearchDialog />)

    await user.click(screen.getByRole('option', { name: /Beta/ }))

    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('beta'))
    expect(useAppStore.getState().modals.search).toBe(false)
  })

  it('keeps the selected chat stable when late history results reorder the list', async () => {
    let resolveHistory: (results: TimelineSearchResult[]) => void = () => undefined
    const searchHistory = vi.fn(() => new Promise<TimelineSearchResult[]>(resolve => { resolveHistory = resolve }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { searchHistory } } as unknown as AgentsDockAPI,
    })
    const selectSession = vi.spyOn(useAppStore.getState(), 'selectSession').mockImplementation(async selectedSessionId => { useAppStore.setState({ selectedSessionId }) })
    const user = userEvent.setup()
    render(<SearchDialog />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'General')
    await waitFor(() => expect(searchHistory).toHaveBeenCalledWith('General', 100))
    expect(screen.getByRole('option', { name: /Beta/ })).toHaveAttribute('aria-selected', 'true')

    resolveHistory([{ session_id: 'gamma', event_id: 'gamma-event', seq: 1, role: 'assistant', snippet: 'General history match' }])
    await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveTextContent('Gamma'))
    expect(screen.getByRole('option', { name: /Beta/ })).toHaveAttribute('aria-selected', 'true')

    await user.click(input)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('beta'))
  })

  it('switches profiles before opening a cached result from another server', async () => {
    const searchAllProfiles = vi.fn().mockResolvedValue([{
      profileId: 'remote-profile',
      profileName: 'Remote Lab',
      serverIdentity: 'remote-server',
      session: { id: 'shared-session-id', title: 'Remote deployment notes', backend: 'claude', folder: 'Ops' },
      source: 'content',
      history: { session_id: 'shared-session-id', event_id: 'remote-event', seq: 7, role: 'assistant', snippet: 'deployment finished safely' }
    }])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        sessions: { searchHistory: vi.fn().mockResolvedValue([]), searchAllProfiles }
      } as unknown as AgentsDockAPI
    })
    const switchServer = vi.fn(async (profileId: string) => {
      useAppStore.setState(state => ({
        activeProfileId: profileId,
        profileGeneration: state.profileGeneration + 1,
        sessions: [{ id: 'shared-session-id', title: 'Remote deployment notes', backend: 'claude', folder: 'Ops' }]
      }))
      return true
    })
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      activeProfileId: 'local-profile',
      profileGeneration: 3,
      profiles: [
        { id: 'local-profile', name: 'Local', serverUrl: 'http://local', hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 },
        { id: 'remote-profile', name: 'Remote Lab', serverUrl: 'http://remote', serverIdentity: 'remote-server', hasAccessToken: true, serverSetupComplete: true, connectionState: 'cached', cachedUnreadCount: 0 }
      ],
      switchServer,
      selectSession
    })
    const user = userEvent.setup()
    render(<SearchDialog />)

    await user.type(screen.getByRole('combobox'), 'deployment')
    expect(await screen.findByRole('option', { name: /Remote deployment notes/ })).toHaveTextContent('Remote Lab')
    await user.click(screen.getByRole('option', { name: /Remote deployment notes/ }))

    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('shared-session-id'))
    expect(switchServer).toHaveBeenCalledWith('remote-profile')
    expect(switchServer.mock.invocationCallOrder[0]).toBeLessThan(selectSession.mock.invocationCallOrder[0])
  })

  it('waits for canonical identity adoption before opening a cached cross-profile result', async () => {
    const local: PublicServerProfile = { id: 'local-profile', name: 'Local', serverUrl: 'http://local', hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 }
    const fallback: PublicServerProfile = { id: 'remote-profile', name: 'Remote Lab', serverUrl: 'http://remote', hasAccessToken: true, serverSetupComplete: true, connectionState: 'cached', cachedUnreadCount: 0 }
    const canonical: PublicServerProfile = { ...fallback, serverIdentity: 'remote-server' }
    const defaultSession: Session = { id: 'remote-default', title: 'Remote default', backend: 'codex' }
    const routedSession: Session = { id: 'remote-result', title: 'Remote deployment notes', backend: 'claude' }
    const cachedPayload: ProfileBootstrapPayload = {
      settings: { serverUrl: fallback.serverUrl, hasAccessToken: true, serverSetupComplete: true },
      health: null,
      sessions: [defaultSession, routedSession],
      jobs: [],
      runtimeCatalog: null,
      selectedSessionId: defaultSession.id,
      folderOrder: [],
      collapsedFolders: [],
      archivedCollapsed: false,
      inspectorVisible: true,
      activeProfileId: fallback.id,
      profiles: [local, fallback],
      profileGeneration: 2
    }
    const canonicalPayload: ProfileBootstrapPayload = { ...cachedPayload, profiles: [local, canonical] }
    let resolveRefresh!: (payload: ProfileBootstrapPayload) => void
    const refresh = vi.fn(() => new Promise<ProfileBootstrapPayload>(resolve => { resolveRefresh = resolve }))
    const searchAllProfiles = vi.fn().mockResolvedValue([{
      profileId: fallback.id,
      profileName: fallback.name,
      serverIdentity: null,
      session: routedSession,
      source: 'content',
      history: { session_id: routedSession.id, event_id: 'remote-event', seq: 7, role: 'assistant', snippet: 'deployment finished safely' }
    }])
    const cached = vi.fn(async (sessionId: string) => ({
      session: sessionId === routedSession.id ? routedSession : defaultSession,
      events: [], queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
    }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        servers: { switch: vi.fn().mockResolvedValue(cachedPayload), refresh },
        sessions: { searchHistory: vi.fn().mockResolvedValue([]), searchAllProfiles },
        timeline: { cached, subscribe: vi.fn().mockResolvedValue(undefined) },
        preferences: {
          get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined),
          getScoped: vi.fn().mockResolvedValue(''), setScoped: vi.fn().mockResolvedValue(undefined)
        },
        native: { setBadge: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState(state => ({
      initialized: true,
      activeProfileId: local.id,
      profileGeneration: 1,
      switchingProfileId: null,
      sessions: [{ id: 'local-chat', title: 'Local chat', backend: 'codex' }],
      profiles: [local, fallback],
      selectedSessionId: null,
      snapshots: {},
      drafts: {},
      uploadsBySession: {},
      uploadPathsBySession: {},
      switchServer: realSwitchServer,
      selectSession: realSelectSession,
      error: null,
      modals: { ...state.modals, search: true }
    }))
    const user = userEvent.setup()
    render(<SearchDialog />)

    await user.type(screen.getByRole('combobox'), 'deployment')
    await user.click(await screen.findByRole('option', { name: /Remote deployment notes/ }))
    await waitFor(() => expect(refresh).toHaveBeenCalledWith(fallback.id, 2))
    expect(useAppStore.getState().selectedSessionId).toBe(defaultSession.id)

    resolveRefresh(canonicalPayload)
    await waitFor(() => expect(useAppStore.getState().selectedSessionId).toBe(routedSession.id))
    expect(useAppStore.getState().profiles.find(profile => profile.id === fallback.id)?.serverIdentity).toBe('remote-server')
    expect(useAppStore.getState().modals.search).toBe(false)
  })

  it('does not open a reused session ID when a cross-profile switch fails', async () => {
    const searchAllProfiles = vi.fn().mockResolvedValue([{
      profileId: 'remote-profile',
      profileName: 'Remote Lab',
      session: { id: 'same', title: 'Remote only', backend: 'codex' },
      source: 'title'
    }])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { searchHistory: vi.fn().mockResolvedValue([]), searchAllProfiles } } as unknown as AgentsDockAPI
    })
    const switchServer = vi.fn().mockResolvedValue(undefined)
    const selectSession = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      activeProfileId: 'local-profile',
      profileGeneration: 5,
      sessions: [{ id: 'same', title: 'Local same ID', backend: 'claude' }],
      profiles: [
        { id: 'local-profile', name: 'Local', serverUrl: 'http://local', hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 },
        { id: 'remote-profile', name: 'Remote Lab', serverUrl: 'http://remote', hasAccessToken: true, serverSetupComplete: true, connectionState: 'cached', cachedUnreadCount: 0 }
      ],
      switchServer,
      selectSession,
      error: null
    })
    const user = userEvent.setup()
    render(<SearchDialog />)

    await user.type(screen.getByRole('combobox'), 'Remote only')
    await user.click(await screen.findByRole('option', { name: /Remote only/ }))

    await waitFor(() => expect(useAppStore.getState().error).toContain('cached chat was not opened'))
    expect(selectSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().modals.search).toBe(true)
  })
})
