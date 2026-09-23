import { act, cleanup, fireEvent, render as renderView, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { AppUpdateStatus, ServerUpdateStatus } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { SettingsDialog } from './Dialogs'
import { serverUpdateIntentKey } from '../lib/server-update-intent'

const submittedStorageKey = 'agentsdock:submitted-server-updates:v1'
const unknownCopy = /Update outcome is not confirmed/
const availableForUnknown: ServerUpdateStatus = {
  phase: 'available', current_version: '0.1.12', latest_version: '0.1.13', track: 'stable',
  update_available: true, checked_at: '2026-09-09T10:00:00Z'
}

function seedUnknownIntent() {
  const intent = {
    attemptId: 'unknown-attempt', profileId: 'profile-1', serverIdentity: 'test-server',
    serverUrl: 'http://test-server.test:7850', version: '0.1.13', track: 'stable',
    submittedAt: Date.now(), startingVersion: '0.1.12',
    baselineUpdateId: 'old-update', baselineTimestamp: '2026-09-09T10:00:00Z'
  }
  const key = serverUpdateIntentKey(intent.profileId, intent.serverIdentity, intent.serverUrl)
  window.localStorage.setItem(submittedStorageKey, JSON.stringify({ [key]: intent }))
  return intent
}

const installingStatus: ServerUpdateStatus = {
  phase: 'installing',
  current_version: '0.1.12',
  target_version: '0.1.13',
  message: 'Installing AgentsServer 0.1.13…'
}

const queueSafeServerUpdates = {
  available: true,
  required: false,
  message: 'Durable queued turns survive managed updates.',
  action: null,
  version: 3
}

const durableReservationServerUpdates = {
  available: true,
  required: false,
  message: 'The server can passively reserve an update until it becomes idle.',
  action: null,
  version: 7
}

const scopedServerUpdates = {
  ...durableReservationServerUpdates,
  version: 9
}

function showSettings() {
  useAppStore.setState({
    connected: true,
    health: {
      ok: true,
      managed_updates: true,
      server_version: '0.1.12',
      server_identity: 'test-server',
      capabilities: {
        server_updates: scopedServerUpdates
      }
    },
    profiles: [{
      id: 'profile-1',
      name: 'Test server',
      serverUrl: 'http://test-server.test:7850',
      hasAccessToken: false,
      serverSetupComplete: true,
      connectionState: 'online',
      cachedUnreadCount: 0
    }],
    activeProfileId: 'profile-1',
    profileGeneration: 1,
    switchingProfileId: null,
    error: null,
    modals: {
      settings: false,
      appSettings: true,
      newChat: false,
      resume: false,
      folder: false,
      digest: false,
      job: false,
      search: false,
      review: false,
      importChats: false
    }
  })
}

function render(ui: Parameters<typeof renderView>[0]) {
  const view = renderView(ui)
  fireEvent.click(screen.getByRole('button', { name: 'Updates' }))
  return view
}

function installBridge(serverUpdates: Partial<AgentsDockAPI['serverUpdates']>) {
  // App-only releases return an empty list of coordinated server updates.
  const appUpdateStatus: AppUpdateStatus = {
    state: 'not-available', channel: 'direct', track: 'stable', currentVersion: '1.0.6', serverUpdates: []
  }
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      serverUpdates: {
        status: vi.fn().mockResolvedValue(null),
        check: vi.fn(),
        start: vi.fn(),
        cancel: vi.fn(),
        ...serverUpdates
      },
      updates: {
        status: vi.fn().mockResolvedValue(appUpdateStatus),
        check: vi.fn().mockResolvedValue(appUpdateStatus),
        install: vi.fn(),
        setTrack: vi.fn()
      },
      events: { on: vi.fn().mockReturnValue(() => undefined) }
    } as unknown as AgentsDockAPI
  })
}

function serverUpdateSurface() {
  const panel = document.querySelector('.app-settings-server-updates')
  expect(panel).not.toBeNull()
  return within(panel as HTMLElement)
}

function serverUpdateChannel() {
  return within(serverUpdateSurface().getByRole('group', { name: 'Server update channel' }))
}

async function findServerUpdateChannelButton(name: 'Stable' | 'Beta') {
  const group = await screen.findByRole('group', { name: 'Server update channel' })
  return within(group).findByRole('button', { name })
}

describe('SettingsDialog server updates', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    window.localStorage.clear()
    useAppStore.setState(state => ({
      error: null,
      modals: { ...state.modals, settings: false, appSettings: false }
    }))
  })

  it('waits for each status request to settle before scheduling another poll', async () => {
    vi.useFakeTimers()
    let resolvePoll: ((status: ServerUpdateStatus) => void) | undefined
    const status = vi.fn()
      .mockResolvedValueOnce(installingStatus)
      .mockImplementationOnce(() => new Promise<ServerUpdateStatus>(resolve => { resolvePoll = resolve }))
      .mockResolvedValue(installingStatus)
    installBridge({
      status,
      check: vi.fn(),
      start: vi.fn()
    })
    showSettings()

    render(<SettingsDialog />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(status).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1_500)
      await Promise.resolve()
    })
    expect(status).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(15_000)
      await Promise.resolve()
    })
    expect(status).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolvePoll?.(installingStatus)
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(1_500)
      await Promise.resolve()
    })
    expect(status).toHaveBeenCalledTimes(3)
  })

  it('keeps polling a pending reservation while leaving cancellation available', async () => {
    vi.useFakeTimers()
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.25',
      target_version: '0.1.26-beta.14',
      track: 'beta',
      schedule_id: '14141414141414141414141414141414',
      when_idle: true,
      cancelable: true,
      message: 'AgentsServer 0.1.26-beta.14 will install when current work finishes.'
    }
    const status = vi.fn().mockResolvedValue(pending)
    installBridge({ status, check: vi.fn(), start: vi.fn() })
    showSettings()

    render(<SettingsDialog />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(status).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Cancel queued update' })).toBeEnabled()

    await act(async () => {
      vi.advanceTimersByTime(1_500)
      await Promise.resolve()
    })
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('labels a server-owned pending update and shows every blocker count without clipped copy', async () => {
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.26-beta.40',
      target_version: '0.1.26-beta.41',
      track: 'beta',
      schedule_id: '41414141414141414141414141414141',
      when_idle: true,
      cancelable: true,
      blocker_counts: {
        active_runs: 0,
        queued_turns: 0,
        provider_background_tasks: 1,
        in_flight_server_changes: 0
      },
      message: 'AgentsServer 0.1.26-beta.41 is scheduled and will install when current work finishes.'
    }
    installBridge({ status: vi.fn().mockResolvedValue(pending), check: vi.fn(), start: vi.fn() })
    showSettings()
    useAppStore.setState(state => ({
      health: state.health ? {
        ...state.health,
        server_version: '0.1.26-beta.40',
        capabilities: {
          ...state.health.capabilities,
          server_updates: durableReservationServerUpdates
        }
      } : state.health
    }))

    render(<SettingsDialog />)

    expect(await screen.findByRole('button', { name: 'Cancel queued update' })).toBeEnabled()
    const blockerCopy = 'Blockers: 0 active runs · 0 queued turns · 1 provider background task · 0 in-flight server changes.'
    expect(screen.getByText(new RegExp(blockerCopy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeVisible()
    const statusCopy = screen.getAllByRole('status').find(node => node.classList.contains('server-update-pending'))
    expect(statusCopy).toHaveTextContent(blockerCopy)
  })

  it('reconciles server status after a start timeout without reporting a false failure', async () => {
    const available: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.12',
      latest_version: '0.1.13',
      update_available: true,
      message: 'AgentsServer 0.1.13 is available.'
    }
    const status = vi.fn()
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce(installingStatus)
    const start = vi.fn().mockRejectedValue(new Error('Server update request timed out.'))
    installBridge({ status, check: vi.fn(), start })
    showSettings()

    render(<SettingsDialog />)
    const install = await screen.findByRole('button', { name: /Install 0.1.13/ })
    fireEvent.click(install)

    await waitFor(() => expect(start).toHaveBeenCalledWith('0.1.13', 'stable', true))
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect(useAppStore.getState().error).toBeNull()
    expect(screen.getByText('Installing AgentsServer 0.1.13…')).toBeInTheDocument()
  })

  it('preserves the start failure when reconciliation only repeats update availability', async () => {
    const available: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.12',
      latest_version: '0.1.13',
      update_available: true,
      message: 'AgentsServer 0.1.13 is available.'
    }
    const startFailure = 'Update or reconnect AgentsServer before starting a managed update.'
    const status = vi.fn().mockResolvedValue(available)
    const start = vi.fn().mockRejectedValue(new Error(startFailure))
    installBridge({ status, check: vi.fn(), start })
    showSettings()

    render(<SettingsDialog />)
    fireEvent.click(await screen.findByRole('button', { name: /Install 0.1.13/ }))

    await waitFor(() => expect(start).toHaveBeenCalledWith('0.1.13', 'stable', true))
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect(useAppStore.getState().error).toBe(startFailure)
    expect(useAppStore.getState().error).not.toBe(available.message)
  })

  it('retains unknown acceptance when reconciliation finds a different channel update', async () => {
    const available: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.18',
      latest_version: '0.1.19-beta.8',
      track: 'beta',
      update_available: true,
      message: 'AgentsServer 0.1.19-beta.8 is available.'
    }
    const otherUpdate: ServerUpdateStatus = {
      phase: 'installing',
      current_version: '0.1.18',
      target_version: '0.1.18',
      track: 'stable',
      message: 'Another client is installing stable.'
    }
    const status = vi.fn()
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce(otherUpdate)
    const start = vi.fn().mockRejectedValue(new Error('Server update request timed out.'))
    installBridge({ status, check: vi.fn(), start })
    showSettings()

    render(<SettingsDialog />)
    fireEvent.click(await screen.findByRole('button', { name: /Install 0.1.19-beta.8/ }))

    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect(useAppStore.getState().error).toBeNull()
    expect(screen.getByText(unknownCopy)).toBeVisible()
    expect(JSON.parse(window.localStorage.getItem(submittedStorageKey) || '{}')).not.toEqual({})
  })

  it('persists before start and never retries a timeout mentioning queued turns after status also fails', async () => {
    const status = vi.fn().mockResolvedValueOnce(availableForUnknown).mockRejectedValue(new Error('offline'))
    const check = vi.fn()
    const start = vi.fn().mockImplementation(() => {
      expect(Object.keys(JSON.parse(window.localStorage.getItem(submittedStorageKey) || '{}'))).toHaveLength(1)
      return Promise.reject(new Error('Network timeout while checking queued turns and active agent runs'))
    })
    installBridge({ status, check, start })
    showSettings()
    render(<SettingsDialog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install 0.1.13' }))
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect(screen.getByText(unknownCopy)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Install 0.1.13' })).not.toBeInTheDocument()
    expect(window.localStorage.getItem('agentsdock:deferred-server-updates:v1')).toBeNull()
    expect(useAppStore.getState().error).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }))
    await waitFor(() => expect(status).toHaveBeenCalledTimes(3))
    expect(start).toHaveBeenCalledOnce()
  })

  it('keeps a successful HTTP response with only old availability unresolved', async () => {
    const start = vi.fn().mockResolvedValue(availableForUnknown)
    installBridge({ status: vi.fn().mockResolvedValue(availableForUnknown), check: vi.fn(), start })
    showSettings()
    render(<SettingsDialog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install 0.1.13' }))
    await waitFor(() => expect(start).toHaveBeenCalledOnce())
    expect(screen.getByText(unknownCopy)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Check status' })).toBeEnabled()
  })

  it('does not submit when durable intent persistence fails', async () => {
    const start = vi.fn()
    installBridge({ status: vi.fn().mockResolvedValue(availableForUnknown), check: vi.fn(), start })
    showSettings()
    render(<SettingsDialog />)
    const button = await screen.findByRole('button', { name: 'Install 0.1.13' })
    await waitFor(() => expect(button).toBeEnabled())
    const storage = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    try {
      fireEvent.click(button)
      await waitFor(() => expect(useAppStore.getState().error).toContain('Storage unavailable'))
      expect(start).not.toHaveBeenCalled()
    } finally { storage.mockRestore() }
  })

  it('clears the latch on authoritative HTTP rejection, not on transport errors', async () => {
    installBridge({ status: vi.fn().mockResolvedValue(availableForUnknown), check: vi.fn(), start: vi.fn().mockRejectedValue(new Error('HTTP 403: Server token is invalid.')) })
    showSettings()
    render(<SettingsDialog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install 0.1.13' }))
    await waitFor(() => expect(useAppStore.getState().error).toBe('HTTP 403: Server token is invalid.'))
    expect(JSON.parse(window.localStorage.getItem(submittedStorageKey) || '{}')).toEqual({})
    expect(screen.getByRole('button', { name: 'Install 0.1.13' })).toBeEnabled()
  })

  it('restores unknown intent without checking a channel and rejects old terminal receipts', async () => {
    seedUnknownIntent()
    const stale = { ...availableForUnknown, phase: 'failed' as const, target_version: '0.1.13', update_id: 'old-update', started_at: '2026-09-09T09:59:00Z' }
    const status = vi.fn().mockResolvedValue(stale)
    const check = vi.fn()
    const start = vi.fn()
    installBridge({ status, check, start })
    showSettings()
    render(<SettingsDialog />)
    expect(screen.getByText(unknownCopy)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }))
    await waitFor(() => expect(status).toHaveBeenCalledOnce())
    expect(screen.getByText(unknownCopy)).toBeVisible()
    expect(check).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('resolves a new same-second terminal receipt after reopening', async () => {
    seedUnknownIntent()
    const status = vi.fn().mockResolvedValue({ ...availableForUnknown, phase: 'complete', target_version: '0.1.13', current_version: '0.1.13', update_id: 'new-update', started_at: '2026-09-09T10:00:00Z' })
    const check = vi.fn()
    installBridge({ status, check, start: vi.fn() })
    showSettings()
    render(<SettingsDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }))
    await waitFor(() => expect(screen.queryByText(unknownCopy)).not.toBeInTheDocument())
    expect(JSON.parse(window.localStorage.getItem(submittedStorageKey) || '{}')).toEqual({})
    expect(check).not.toHaveBeenCalled()
  })

  it('pauses unknown status checks while closed or offline and preserves its offline row', async () => {
    vi.useFakeTimers()
    seedUnknownIntent()
    const status = vi.fn().mockRejectedValue(new Error('offline'))
    installBridge({ status, check: vi.fn(), start: vi.fn() })
    showSettings()
    useAppStore.setState(state => ({ profiles: state.profiles.map(profile => ({ ...profile, serverIdentity: 'test-server' })) }))
    render(<SettingsDialog />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(1_500); await Promise.resolve() })
    expect(status).toHaveBeenCalledOnce()
    act(() => useAppStore.setState(state => ({ modals: { ...state.modals, appSettings: false } })))
    await act(async () => { vi.advanceTimersByTime(30_000); await Promise.resolve() })
    expect(status).toHaveBeenCalledOnce()
    act(() => useAppStore.setState(state => ({ connected: false, health: null, modals: { ...state.modals, appSettings: true } })))
    expect(screen.getByText(unknownCopy)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Check status' })).toBeDisabled()
    await act(async () => { vi.advanceTimersByTime(30_000); await Promise.resolve() })
    expect(status).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'service-owned daemon',
      'Managed update cannot start because the detached tmux server is inside agents-server.service and would be terminated by the restart. Finish terminal work, stop the tmux daemon, then retry.'
    ],
    [
      'failed isolated bootstrap',
      'Managed update cannot safely start because AgentsServer could not create the default tmux server outside agents-server.service. From a login shell, start a detached tmux session, then retry.'
    ],
    [
      'unverifiable cgroup',
      "Managed update cannot safely start because AgentsServer could not verify the detached tmux server's cgroup. Retry after confirming tmux is running from a login shell."
    ],
    [
      'untracked service child',
      'Managed update cannot safely start because an untracked process remains inside agents-server.service. Let current provider cleanup finish, then retry.'
    ],
    [
      'legacy wrapped service child',
      "Could not start detached updater: 409: {'code': 'unsafe_update_service_cgroup', 'message': 'An attachment is still closing.'}"
    ]
  ])('surfaces an unsafe update topology (%s) as an actionable amber warning', async (_variant, blocker) => {
    const available: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.21',
      latest_version: '0.1.22',
      track: 'stable',
      update_available: true,
      message: 'AgentsServer 0.1.22 is available.'
    }
    const status = vi.fn().mockResolvedValue(available)
    const start = vi.fn().mockRejectedValue(new Error(blocker))
    installBridge({ status, check: vi.fn(), start })
    showSettings()

    render(<SettingsDialog />)
    fireEvent.click(await screen.findByRole('button', { name: /Install 0.1.22/ }))

    const warning = await screen.findByText(blocker)
    expect(warning).toHaveAttribute('role', 'status')
    expect(warning).toHaveTextContent(blocker)
    expect(warning).toHaveClass('server-update-warning')
    expect(useAppStore.getState().error).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel queued update' })).not.toBeInTheDocument()
  })

  it('prefers structured update recovery text over a raw HTTP error wrapper', async () => {
    const available: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.21',
      latest_version: '0.1.22',
      track: 'stable',
      update_available: true,
      message: 'AgentsServer 0.1.22 is available.'
    }
    const failed: ServerUpdateStatus = {
      phase: 'failed',
      current_version: '0.1.21',
      target_version: '0.1.22',
      track: 'stable',
      message: 'AgentsServer could not finish stopping its idle provider supervisors before the update deadline.',
      error_code: 'provider_quiesce_timeout',
      error_action: 'Retry the update after current provider cleanup finishes.',
      retryable: true
    }
    const status = vi.fn()
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce(failed)
    const start = vi.fn().mockRejectedValue(new Error(
      "Could not start detached updater: 409: {'code': 'unsafe_update_service_cgroup'}"
    ))
    installBridge({ status, check: vi.fn(), start })
    showSettings()

    render(<SettingsDialog />)
    fireEvent.click(await screen.findByRole('button', { name: /Install 0.1.22/ }))

    const warning = await screen.findByText(
      'AgentsServer could not finish stopping its idle provider supervisors before the update deadline. Retry the update after current provider cleanup finishes.'
    )
    expect(warning).toHaveTextContent(
      'AgentsServer could not finish stopping its idle provider supervisors before the update deadline. Retry the update after current provider cleanup finishes.'
    )
    expect(warning).not.toHaveTextContent('Could not start detached updater')
    expect(useAppStore.getState().error).toBeNull()
  })

  it('renders a detached runner failure from status as an actionable warning', async () => {
    const failed: ServerUpdateStatus = {
      phase: 'failed',
      current_version: '0.1.21',
      target_version: '0.1.22',
      track: 'stable',
      message: 'The signed server archive could not be verified.',
      error_code: 'release_verification_failed',
      error_action: 'Check network access and retry the update.',
      retryable: true
    }
    installBridge({
      status: vi.fn().mockResolvedValue(failed),
      check: vi.fn(),
      start: vi.fn()
    })
    showSettings()

    render(<SettingsDialog />)

    const warning = await screen.findByText(
      'The signed server archive could not be verified. Check network access and retry the update.'
    )
    expect(warning).toHaveAttribute('role', 'status')
    expect(warning).toHaveClass('server-update-warning')
    expect(useAppStore.getState().error).toBeNull()
  })

  it('preserves a failed attempt after checking and explicitly retries the verified latest version', async () => {
    const failed: ServerUpdateStatus = {
      phase: 'failed',
      current_version: '0.1.26-beta.49',
      target_version: '0.1.26-beta.50',
      track: 'beta',
      message: 'Native listener was not ready.',
      error_code: 'readiness_failed',
      error_action: 'Retry the update.',
      retryable: true
    }
    const checked: ServerUpdateStatus = {
      ...failed,
      latest_version: '0.1.26-beta.51',
      update_available: true
    }
    let resolveStart!: (value: ServerUpdateStatus) => void
    const start = vi.fn().mockImplementation(() => new Promise(resolve => { resolveStart = resolve }))
    installBridge({
      status: vi.fn().mockResolvedValue(failed),
      check: vi.fn().mockResolvedValue(checked),
      start
    })
    showSettings()
    render(<SettingsDialog />)
    const warning = await screen.findByText('Native listener was not ready. Retry the update.')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check server' })).toBeEnabled())
    expect(screen.queryByRole('button', { name: /Retry update/ })).not.toBeInTheDocument()
    expect(window.agentsDock.serverUpdates.check).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Check server' }))
    const retry = await screen.findByRole('button', { name: 'Retry update (0.1.26-beta.51)' })
    expect(retry).toBeEnabled()
    expect(warning).toBeVisible()
    expect(start).not.toHaveBeenCalled()
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(screen.queryByRole('button', { name: 'Retry update (0.1.26-beta.51)' })).not.toBeInTheDocument()
    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith('0.1.26-beta.51', 'beta', true)

    await act(async () => {
      resolveStart({ ...installingStatus, target_version: checked.latest_version, track: 'beta' })
      await Promise.resolve()
    })
    expect(screen.queryByText('Native listener was not ready. Retry the update.')).not.toBeInTheDocument()
  })

  it.each([
    { update_available: false, latest_version: '0.1.26-beta.50' },
    { update_available: undefined, latest_version: '0.1.26-beta.50' },
    { update_available: true, latest_version: null }
  ])('does not offer a failed-update retry without verified availability: %j', async availability => {
    installBridge({ status: vi.fn().mockResolvedValue({
      phase: 'failed',
      current_version: '0.1.26-beta.49',
      target_version: '0.1.26-beta.50',
      track: 'beta',
      message: 'Update failed.',
      ...availability
    }) })
    showSettings()
    render(<SettingsDialog />)
    await screen.findByText('Update failed.')
    expect(screen.queryByRole('button', { name: /Retry update/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check server' })).toBeEnabled()
  })

  it('checks and installs from the selected beta server channel', async () => {
    const stable: ServerUpdateStatus = {
      phase: 'current',
      current_version: '0.1.18',
      latest_version: '0.1.18',
      track: 'stable',
      update_available: false,
      message: 'AgentsServer 0.1.18 is current.'
    }
    const beta: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.18',
      latest_version: '0.1.19-beta.7',
      track: 'beta',
      update_available: true,
      message: 'AgentsServer 0.1.19-beta.7 is available.',
      checked_at: '2026-09-08T23:33:30Z'
    }
    const check = vi.fn((track: 'stable' | 'beta') => Promise.resolve(track === 'beta' ? beta : stable))
    const start = vi.fn().mockResolvedValue({ ...installingStatus, track: 'beta' })
    installBridge({
      status: vi.fn().mockResolvedValue(stable),
      check,
      start
    })
    showSettings()

    render(<SettingsDialog />)
    await waitFor(() => expect(check).toHaveBeenCalledWith('stable'))
    expect(await serverUpdateSurface().findByText('This is the latest one.')).toBeInTheDocument()
    const betaButton = await findServerUpdateChannelButton('Beta')
    await waitFor(() => expect(betaButton).toBeEnabled())
    fireEvent.click(betaButton)

    await waitFor(() => expect(check).toHaveBeenCalledWith('beta'))
    await waitFor(() => expect(betaButton).toHaveClass('active'))

    const install = await screen.findByRole('button', { name: /Install 0.1.19-beta.7/ })
    await waitFor(() => expect(install).toBeEnabled())
    expect(screen.getByText(/Checked \d{1,2}:\d{2}:\d{2}/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check server' })).toBeEnabled()
    fireEvent.click(install)
    await waitFor(() => expect(start).toHaveBeenCalledWith('0.1.19-beta.7', 'beta', true))
  })

  it('refreshes the selected channel from Check server and exposes the discovered update', async () => {
    const current: ServerUpdateStatus = {
      phase: 'current',
      current_version: '0.1.18',
      latest_version: '0.1.18',
      track: 'stable',
      update_available: false,
      message: 'AgentsServer 0.1.18 is current.'
    }
    const available: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.18',
      latest_version: '0.1.19',
      track: 'stable',
      update_available: true,
      message: 'AgentsServer 0.1.19 is available.',
      checked_at: '2026-09-09T00:15:00Z'
    }
    const check = vi.fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(available)
    installBridge({ status: vi.fn().mockResolvedValue(current), check, start: vi.fn() })
    showSettings()

    render(<SettingsDialog />)
    // The IPC call starts before its response commits to the panel. Wait for
    // the displayed result and usable control before requesting another check.
    await waitFor(() => {
      expect(check).toHaveBeenCalledTimes(1)
      expect(serverUpdateSurface().getByText('This is the latest one.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Check server' })).toBeEnabled()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Check server' }))

    await waitFor(() => expect(check).toHaveBeenNthCalledWith(2, 'stable'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install 0.1.19' })).toBeEnabled())
    expect(screen.getByText(/Checked \d{1,2}:\d{2}:\d{2}/)).toBeInTheDocument()
    expect(serverUpdateChannel().getByRole('button', { name: 'Stable' })).toHaveClass('active')
  })

  it('switches to a current Beta without starting or offering an update', async () => {
    const stableCurrent: ServerUpdateStatus = {
      phase: 'current',
      current_version: '0.1.18',
      latest_version: '0.1.18',
      track: 'stable',
      update_available: false,
      message: 'AgentsServer Stable is current.'
    }
    const betaCurrent: ServerUpdateStatus = {
      phase: 'current',
      current_version: '0.1.19-beta.8',
      latest_version: '0.1.19-beta.8',
      track: 'beta',
      update_available: false,
      message: 'AgentsServer Beta is current.'
    }
    const check = vi.fn((track: 'stable' | 'beta') => Promise.resolve(track === 'beta' ? betaCurrent : stableCurrent))
    const start = vi.fn()
    installBridge({ status: vi.fn().mockResolvedValue(stableCurrent), check, start })
    showSettings()

    render(<SettingsDialog />)
    await waitFor(() => expect(check).toHaveBeenCalledWith('stable'))
    await waitFor(() => expect(serverUpdateChannel().getByRole('button', { name: 'Beta' })).toBeEnabled())
    fireEvent.click(serverUpdateChannel().getByRole('button', { name: 'Beta' }))

    await waitFor(() => expect(check).toHaveBeenCalledWith('beta'))
    await waitFor(() => expect(serverUpdateChannel().getByRole('button', { name: 'Beta' })).toHaveClass('active'))
    expect(serverUpdateSurface().getByText('This is the latest one.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install 0.1.19-beta.8' })).not.toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps the current channel selected and restores controls when a channel check fails', async () => {
    const stableCurrent: ServerUpdateStatus = {
      phase: 'current',
      current_version: '0.1.18',
      latest_version: '0.1.18',
      track: 'stable',
      update_available: false,
      message: 'AgentsServer Stable is current.'
    }
    const check = vi.fn()
      .mockResolvedValueOnce(stableCurrent)
      .mockRejectedValueOnce(new Error('Beta release service is unavailable.'))
    installBridge({ status: vi.fn().mockResolvedValue(stableCurrent), check, start: vi.fn() })
    showSettings()

    render(<SettingsDialog />)
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(serverUpdateChannel().getByRole('button', { name: 'Beta' })).toBeEnabled())
    fireEvent.click(serverUpdateChannel().getByRole('button', { name: 'Beta' }))

    await waitFor(() => expect(check).toHaveBeenNthCalledWith(2, 'beta'))
    await waitFor(() => expect(useAppStore.getState().error).toBe('Beta release service is unavailable.'))
    expect(serverUpdateChannel().getByRole('button', { name: 'Stable' })).toHaveClass('active')
    expect(serverUpdateChannel().getByRole('button', { name: 'Beta' })).not.toHaveClass('active')
    expect(screen.getByRole('button', { name: 'Check server' })).toBeEnabled()
    expect(serverUpdateSurface().getByText('This is the latest one.')).toBeInTheDocument()
  })

  it('keeps known status and shows an inline warning when the automatic release check fails', async () => {
    const current: ServerUpdateStatus = {
      phase: 'current',
      current_version: '0.1.18',
      latest_version: '0.1.18',
      track: 'stable',
      update_available: false,
      message: 'AgentsServer Stable is current.'
    }
    const check = vi.fn().mockRejectedValue(new Error('release service timed out'))
    installBridge({ status: vi.fn().mockResolvedValue(current), check, start: vi.fn() })
    showSettings()

    render(<SettingsDialog />)

    const warning = await screen.findByText('Could not check for updates: release service timed out')
    expect(warning).toHaveAttribute('role', 'status')
    expect(warning).toHaveClass('server-update-warning')
    expect(check).toHaveBeenCalledOnce()
    expect(check).toHaveBeenCalledWith('stable')
    expect(serverUpdateChannel().getByRole('button', { name: 'Stable' })).toHaveClass('active')
    expect(screen.getByRole('button', { name: 'Check server' })).toBeEnabled()
    expect(useAppStore.getState().error).toBeNull()
  })

  it('installs an available Beta on a remote v7 server through its native idle scheduler', async () => {
    const available: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.18',
      latest_version: '0.1.19-beta.8',
      track: 'beta',
      update_available: true,
      message: 'AgentsServer 0.1.19-beta.8 is available.'
    }
    const start = vi.fn().mockResolvedValue({ ...installingStatus, track: 'beta', target_version: available.latest_version })
    installBridge({ status: vi.fn().mockResolvedValue(available), check: vi.fn(), start })
    const setup = vi.fn()
    window.addEventListener('agentsdock:server-setup', setup)
    showSettings()
    useAppStore.setState(state => ({
      health: state.health ? {
        ...state.health,
        capabilities: { ...state.health.capabilities, server_updates: durableReservationServerUpdates }
      } : state.health
    }))

    try {
      render(<SettingsDialog />)
      const install = await screen.findByRole('button', { name: `Install ${available.latest_version}` })
      expect(screen.queryByRole('button', { name: /Update server to Beta/ })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Install or update AgentsServer|Set up your server/ })).not.toBeInTheDocument()
      fireEvent.click(install)

      await waitFor(() => expect(start).toHaveBeenCalledWith(available.latest_version, 'beta', true))
      expect(setup).not.toHaveBeenCalled()
      expect(useAppStore.getState().modals.appSettings).toBe(true)
    } finally {
      window.removeEventListener('agentsdock:server-setup', setup)
    }
  })

  it.each(['http://test-server.test:7850', 'https://test-server.test', 'http://127.0.0.1:7850'])(
    'installs an available update directly on a v3 server at %s', async serverUrl => {
    const available: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.25',
      latest_version: '0.1.26-beta.48',
      track: 'beta',
      update_available: true,
      message: 'AgentsServer 0.1.26-beta.48 is available.'
    }
    const start = vi.fn().mockResolvedValue({ ...installingStatus, track: 'beta', target_version: available.latest_version })
    installBridge({ status: vi.fn().mockResolvedValue(available), check: vi.fn(), start })
    const setup = vi.fn()
    window.addEventListener('agentsdock:server-setup', setup)
    showSettings()
    useAppStore.setState(state => ({
      health: state.health ? {
        ...state.health,
        server_version: available.current_version,
        capabilities: { ...state.health.capabilities, server_updates: queueSafeServerUpdates }
      } : state.health,
      profiles: state.profiles.map(profile => profile.id === state.activeProfileId
        ? { ...profile, serverUrl }
        : profile)
    }))

    try {
      render(<SettingsDialog />)
      const install = await screen.findByRole('button', { name: `Install ${available.latest_version}` })
      expect(screen.queryByRole('button', { name: /Open guided Beta update/ })).not.toBeInTheDocument()
      fireEvent.click(install)

      await waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith(available.latest_version, 'beta'))
      expect(setup).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('agentsdock:server-setup', setup)
    }
  })

  it('keeps a busy remote v3 update local until idle and preserves its check across health refreshes', async () => {
    const available: ServerUpdateStatus = {
      phase: 'available', current_version: '0.1.25', latest_version: '0.1.26',
      track: 'stable', update_available: true
    }
    let resolveIdleCheck!: (status: ServerUpdateStatus) => void
    const check = vi.fn().mockResolvedValueOnce(available).mockImplementationOnce(
      () => new Promise<ServerUpdateStatus>(resolve => { resolveIdleCheck = resolve })
    )
    const start = vi.fn().mockResolvedValue({ ...installingStatus, target_version: available.latest_version })
    installBridge({ status: vi.fn().mockResolvedValue(available), check, start })
    showSettings()
    useAppStore.setState(state => ({ health: {
      ...state.health!, active: ['chat-1'],
      capabilities: { ...state.health!.capabilities, server_updates: queueSafeServerUpdates }
    } }))

    render(<SettingsDialog />)
    const install = await screen.findByRole('button', { name: 'Install latest Stable when idle' })
    await waitFor(() => expect(install).toBeEnabled())
    fireEvent.click(install)
    expect(start).not.toHaveBeenCalled()
    expect(JSON.parse(window.localStorage.getItem('agentsdock:deferred-server-updates:v1')!))
      .toMatchObject({ 'profile-1': { version: '0.1.26', serverIdentity: 'test-server' } })
    expect(await screen.findByRole('button', { name: 'Cancel queued update' })).toBeEnabled()

    act(() => useAppStore.setState(state => ({ health: { ...state.health!, active: [] } })))
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
    act(() => useAppStore.setState(state => ({ health: {
      ...state.health!, capabilities: { ...state.health!.capabilities, server_updates: { ...queueSafeServerUpdates } }
    } })))
    await act(async () => { resolveIdleCheck(available); await Promise.resolve() })
    await waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith('0.1.26', 'stable'))
    expect(check).toHaveBeenLastCalledWith('stable')
    expect(window.localStorage.getItem('agentsdock:deferred-server-updates:v1')).toBeNull()
  })

  it('delegates a busy v9 update to the server once without creating a local retry', async () => {
    const available: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.25',
      latest_version: '0.1.26-beta.10',
      track: 'beta',
      update_available: true,
      message: 'AgentsServer 0.1.26-beta.10 is available.'
    }
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.25',
      target_version: '0.1.26-beta.10',
      track: 'beta',
      schedule_id: '11111111111111111111111111111111',
      when_idle: true,
      cancelable: true,
      blocker_counts: {
        active_runs: 1,
        queued_turns: 0,
        provider_background_tasks: 0,
        in_flight_server_changes: 0
      },
      message: 'AgentsServer 0.1.26-beta.10 will install when current work finishes.'
    }
    const start = vi.fn().mockResolvedValue(pending)
    installBridge({ status: vi.fn().mockResolvedValue(available), check: vi.fn(), start })
    showSettings()
    useAppStore.setState(state => ({
      health: state.health ? {
        ...state.health,
        active_sessions: ['chat-1'],
        capabilities: {
          ...state.health.capabilities,
          server_updates: scopedServerUpdates
        }
      } : state.health
    }))

    render(<SettingsDialog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install latest Beta when idle' }))

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(start).toHaveBeenCalledWith('0.1.26-beta.10', 'beta', true)
    expect(window.localStorage.getItem('agentsdock:deferred-server-updates:v1')).toBeNull()
    expect(await screen.findByText(/AgentsServer 0\.1\.26-beta\.10 will install when current work finishes\./)).toBeInTheDocument()
  })

  it('accepts and renders a reconciled pending v9 reservation after a start timeout', async () => {
    const available: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.25',
      latest_version: '0.1.26-beta.10',
      track: 'beta',
      update_available: true,
      message: 'AgentsServer 0.1.26-beta.10 is available.'
    }
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.25',
      target_version: '0.1.26-beta.10',
      track: 'beta',
      schedule_id: '22222222222222222222222222222222',
      when_idle: true,
      cancelable: true,
      pending_at: '2026-08-27T23:55:00Z',
      blocker_counts: {
        active_runs: 1,
        queued_turns: 0,
        provider_background_tasks: 0,
        in_flight_server_changes: 0
      },
      message: 'Update reserved safely; waiting for one active run.'
    }
    const status = vi.fn()
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce(pending)
    const start = vi.fn().mockRejectedValue(new Error('Server update request timed out.'))
    installBridge({ status, check: vi.fn(), start })
    showSettings()
    useAppStore.setState(state => ({
      health: state.health ? {
        ...state.health,
        active_sessions: ['chat-1'],
        capabilities: {
          ...state.health.capabilities,
          server_updates: scopedServerUpdates
        }
      } : state.health
    }))

    render(<SettingsDialog />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install latest Beta when idle' }))

    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    expect(start).toHaveBeenCalledWith('0.1.26-beta.10', 'beta', true)
    expect(useAppStore.getState().error).toBeNull()
    expect(await screen.findByText(/Update reserved safely; waiting for one active run\./)).toBeInTheDocument()
    expect(window.localStorage.getItem('agentsdock:deferred-server-updates:v1')).toBeNull()
  })

  it('cancels the exact pending server reservation exposed by v9 status', async () => {
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.25',
      target_version: '0.1.26-beta.10',
      track: 'beta',
      schedule_id: '33333333333333333333333333333333',
      when_idle: true,
      cancelable: true,
      pending_at: '2026-08-27T23:55:00Z',
      blocker_counts: {
        active_runs: 2,
        queued_turns: 0,
        provider_background_tasks: 0,
        in_flight_server_changes: 0
      },
      message: 'Update reserved safely; waiting for two active runs.'
    }
    const cancelled: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.25',
      latest_version: '0.1.26-beta.10',
      track: 'beta',
      update_available: true,
      message: 'Queued server update cancelled.'
    }
    const cancel = vi.fn().mockResolvedValue(cancelled)
    installBridge({ status: vi.fn().mockResolvedValue(pending), check: vi.fn(), cancel })
    showSettings()
    useAppStore.setState(state => ({
      health: state.health ? {
        ...state.health,
        active_sessions: ['chat-1', 'chat-2'],
        capabilities: {
          ...state.health.capabilities,
          server_updates: scopedServerUpdates
        }
      } : state.health
    }))

    render(<SettingsDialog />)
    fireEvent.click(await screen.findByRole('button', { name: /Cancel (?:queued|scheduled) update/i }))

    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    expect(cancel).toHaveBeenCalledWith('33333333333333333333333333333333')
    expect(await screen.findByText('Queued server update cancelled.')).toBeInTheDocument()
    expect(window.localStorage.getItem('agentsdock:deferred-server-updates:v1')).toBeNull()
  })

  it('opens guided setup when a legacy server cannot select the beta channel', async () => {
    const legacy: ServerUpdateStatus = {
      phase: 'current',
      current_version: '0.1.18',
      latest_version: '0.1.18',
      update_available: false,
      message: 'AgentsServer 0.1.18 is current.'
    }
    const check = vi.fn().mockResolvedValue(legacy)
    installBridge({
      status: vi.fn().mockResolvedValue(legacy),
      check,
      start: vi.fn()
    })
    const setup = vi.fn()
    window.addEventListener('agentsdock:server-setup', setup)
    showSettings()

    try {
      render(<SettingsDialog />)
      await waitFor(() => expect(check).toHaveBeenCalledWith('stable'))
      const beta = await findServerUpdateChannelButton('Beta')
      await waitFor(() => expect(beta).toBeEnabled())
      fireEvent.click(beta)

      await waitFor(() => expect(check).toHaveBeenCalledWith('beta'))
      await waitFor(() => expect(setup).toHaveBeenCalledOnce())
      expect(useAppStore.getState().modals.settings).toBe(false)
      expect(useAppStore.getState().error).toContain('cannot switch channels in place')
    } finally {
      window.removeEventListener('agentsdock:server-setup', setup)
    }
  })

  it('opens guided setup before switching a legacy beta server back to stable', async () => {
    const legacyBeta: ServerUpdateStatus = {
      phase: 'current',
      current_version: '0.1.19-beta.7',
      latest_version: '0.1.18',
      update_available: false,
      message: 'AgentsServer 0.1.19-beta.7 is current.'
    }
    const check = vi.fn().mockResolvedValue(legacyBeta)
    installBridge({
      status: vi.fn().mockResolvedValue(legacyBeta),
      check,
      start: vi.fn()
    })
    const setup = vi.fn()
    window.addEventListener('agentsdock:server-setup', setup)
    showSettings()

    try {
      render(<SettingsDialog />)
      const stableButton = await findServerUpdateChannelButton('Stable')
      await waitFor(() => expect(serverUpdateChannel().getByRole('button', { name: 'Beta' })).toHaveClass('active'))
      await waitFor(() => expect(stableButton).toBeEnabled())
      fireEvent.click(stableButton)
      await waitFor(() => expect(check).toHaveBeenCalledWith('stable'))
      await waitFor(() => expect(setup).toHaveBeenCalledOnce())
      expect(useAppStore.getState().error).toContain('channel-aware beta')
    } finally {
      window.removeEventListener('agentsdock:server-setup', setup)
    }
  })

  it('uses the same legacy guard for the ordinary Check server action', async () => {
    const legacyBeta: ServerUpdateStatus = {
      phase: 'current',
      current_version: '0.1.19-beta.7',
      latest_version: '0.1.18',
      update_available: false,
      message: 'AgentsServer 0.1.19-beta.7 is current.'
    }
    const check = vi.fn().mockResolvedValue(legacyBeta)
    installBridge({
      status: vi.fn().mockResolvedValue(legacyBeta),
      check,
      start: vi.fn()
    })
    const setup = vi.fn()
    window.addEventListener('agentsdock:server-setup', setup)
    showSettings()

    try {
      render(<SettingsDialog />)
      await act(async () => { await Promise.resolve() })
      fireEvent.click(await screen.findByRole('button', { name: 'Check server' }))

      await waitFor(() => expect(check).toHaveBeenCalledWith('beta'))
      await waitFor(() => expect(setup).toHaveBeenCalledOnce())
    } finally {
      window.removeEventListener('agentsdock:server-setup', setup)
    }
  })

  it('ignores a delayed status response from the previous server profile', async () => {
    const stable: ServerUpdateStatus = {
      phase: 'current',
      current_version: '0.1.18',
      track: 'stable',
      update_available: false,
      message: 'Stable profile.'
    }
    const beta: ServerUpdateStatus = {
      phase: 'current',
      current_version: '0.1.19-beta.8',
      track: 'beta',
      update_available: false,
      message: 'Beta profile.'
    }
    let resolveStable: ((status: ServerUpdateStatus) => void) | undefined
    let resolveBeta: ((status: ServerUpdateStatus) => void) | undefined
    const status = vi.fn()
      .mockImplementationOnce(() => new Promise<ServerUpdateStatus>(resolve => { resolveStable = resolve }))
      .mockImplementationOnce(() => new Promise<ServerUpdateStatus>(resolve => { resolveBeta = resolve }))
    installBridge({ status, check: vi.fn(), start: vi.fn() })
    showSettings()
    useAppStore.setState({
      profiles: [{
        id: 'profile-a', name: 'A', serverUrl: 'http://a.test', hasAccessToken: false,
        serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0
      }],
      activeProfileId: 'profile-a',
      profileGeneration: 1
    })

    render(<SettingsDialog />)
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1))
    act(() => {
      useAppStore.setState({
        profiles: [{
          id: 'profile-b', name: 'B', serverUrl: 'http://b.test', hasAccessToken: false,
          serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0
        }],
        activeProfileId: 'profile-b',
        profileGeneration: 2
      })
    })
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    await act(async () => { resolveBeta?.(beta); await Promise.resolve() })
    await waitFor(() => expect(screen.getByText('0.1.19-beta.8')).toBeInTheDocument())
    await act(async () => { resolveStable?.(stable); await Promise.resolve() })

    expect(screen.getByText('0.1.19-beta.8')).toBeInTheDocument()
    expect(screen.queryByText('0.1.18')).not.toBeInTheDocument()
    expect(serverUpdateChannel().getByRole('button', { name: 'Beta' })).toHaveClass('active')
  })

  it('loads fresh status after reopening while the previous view was polling an active update', async () => {
    vi.useFakeTimers()
    const current: ServerUpdateStatus = {
      phase: 'current',
      current_version: '0.1.19-beta.8',
      track: 'beta',
      update_available: false,
      message: 'AgentsServer beta is current.'
    }
    const status = vi.fn()
      .mockResolvedValueOnce({ ...installingStatus, track: 'beta' })
      .mockResolvedValueOnce(current)
    installBridge({ status, check: vi.fn(), start: vi.fn() })
    showSettings()

    render(<SettingsDialog />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(status).toHaveBeenCalledTimes(1)

    act(() => {
      useAppStore.setState(state => ({
        modals: { ...state.modals, appSettings: false }
      }))
    })
    act(() => {
      useAppStore.setState(state => ({
        modals: { ...state.modals, appSettings: true }
      }))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(status).toHaveBeenCalledTimes(2)
    expect(serverUpdateSurface().getByText('This is the latest one.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check server' })).toBeEnabled()
  })

  it('disables server channel changes while an update is active', async () => {
    installBridge({
      status: vi.fn().mockResolvedValue({ ...installingStatus, track: 'beta' }),
      check: vi.fn(),
      start: vi.fn()
    })
    showSettings()

    render(<SettingsDialog />)

    await waitFor(() => expect(serverUpdateChannel().getByRole('button', { name: 'Stable' })).toBeDisabled())
    expect(serverUpdateChannel().getByRole('button', { name: 'Beta' })).toBeDisabled()
  })

  it('keeps channel recovery clickable when the initial update status fails', async () => {
    const check = vi.fn().mockResolvedValue({
      phase: 'current',
      current_version: '0.1.26-beta.41',
      latest_version: '0.1.26-beta.41',
      track: 'beta',
      update_available: false,
      message: 'AgentsServer 0.1.26-beta.41 is current on beta.'
    })
    installBridge({
      status: vi.fn().mockRejectedValue(new Error('403 forbidden')),
      check,
      start: vi.fn()
    })
    showSettings()
    useAppStore.setState(state => ({
      health: state.health ? { ...state.health, server_version: '0.1.26-beta.41' } : state.health
    }))

    render(<SettingsDialog />)

    expect(await screen.findByText(/Choose a channel or Check server to retry/)).toBeInTheDocument()
    const beta = await findServerUpdateChannelButton('Beta')
    await waitFor(() => expect(beta).toBeEnabled())
    expect(beta).toHaveClass('active')

    fireEvent.click(beta)
    await waitFor(() => expect(check).toHaveBeenCalledWith('beta'))
    expect(await serverUpdateSurface().findByText('This is the latest one.')).toBeInTheDocument()
  })
})
