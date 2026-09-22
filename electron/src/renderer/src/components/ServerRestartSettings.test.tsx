import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { AppUpdateStatus, Health, ServerRestartBlockerSnapshot, ServerRestartStatus, ServerUpdateStatus } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { SettingsDialog } from './Dialogs'

const originalRestartServer = useAppStore.getState().restartServer

const serverRestartCapability = {
  version: 2,
  available: true,
  required: false,
  message: 'Managed restart is available.',
  action: null,
  force_restart: true,
  force_confirmation_required: true
}

const revisionA = 'a'.repeat(64)

function blockerSnapshot(overrides: Partial<ServerRestartBlockerSnapshot> = {}): ServerRestartBlockerSnapshot {
  const counts = {
    active_count: 0,
    restart_blocking_queued_count: 0,
    provider_background_count: 0,
    tmux_server_in_service_cgroup: false,
    tmux_server_cgroup_unknown: false,
    server_maintenance_count: 0,
    mutation_count: 0,
    deleting_session_count: 0,
    codex_goals_reconfiguring: false,
    ...overrides
  }
  const hasForceable = counts.active_count > 0
    || counts.restart_blocking_queued_count > 0
    || counts.provider_background_count > 0
    || counts.tmux_server_in_service_cgroup
    || counts.tmux_server_cgroup_unknown
  const hasSafety = counts.server_maintenance_count > 0
    || counts.mutation_count > 0
    || counts.deleting_session_count > 0
    || counts.codex_goals_reconfiguring
  return {
    version: 2,
    revision: revisionA,
    ...counts,
    has_forceable_blockers: hasForceable,
    has_safety_blockers: hasSafety,
    has_blockers: hasForceable || hasSafety,
    ...overrides
  }
}

function restartStatus(snapshot = blockerSnapshot()): ServerRestartStatus {
  return {
    phase: 'idle',
    server_identity: 'server-a',
    server_instance_id: 'boot-old',
    message: 'AgentsServer is ready.',
    blocker_snapshot: snapshot
  }
}

const durableQueueCapability = {
  version: 3,
  available: true,
  required: false,
  message: 'Durable queued work survives server maintenance.',
  action: null
}

function restartHealth(overrides: Partial<Health> = {}): Health {
  return {
    ok: true,
    managed_updates: false,
    server_identity: 'server-a',
    server_instance_id: 'boot-old',
    capabilities: {
      server_restart: { ...serverRestartCapability, blocker_snapshot: blockerSnapshot() },
      server_updates: durableQueueCapability
    },
    ...overrides
  }
}

function showSettings(health: Health = restartHealth(), connected = true) {
  useAppStore.setState({
    connected,
    health,
    profiles: [{
      id: 'profile-1',
      name: 'Production east',
      serverUrl: 'https://agents.example.test:7850',
      serverIdentity: 'server-a',
      hasAccessToken: true,
      serverSetupComplete: true,
      connectionState: connected ? 'online' : 'offline',
      cachedUnreadCount: 0
    }],
    activeProfileId: 'profile-1',
    profileGeneration: 7,
    switchingProfileId: null,
    error: null,
    restartServer: originalRestartServer,
    modals: {
      settings: true,
      appSettings: false,
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

function openAppUpdates() {
  act(() => {
    useAppStore.setState(state => ({
      modals: { ...state.modals, settings: false, appSettings: true }
    }))
  })
  fireEvent.click(screen.getByRole('button', { name: 'Updates', hidden: true }))
}

function openServerSettingsFromApp() {
  fireEvent.click(screen.getByRole('button', { name: 'Server' }))
}

function updatesSurface() {
  const panel = document.querySelector('.app-settings-server-updates')
  expect(panel).not.toBeNull()
  return within(panel as HTMLElement)
}

const currentServerUpdate: ServerUpdateStatus = {
  phase: 'current',
  current_version: '0.1.26-beta.51',
  latest_version: '0.1.26-beta.51',
  track: 'beta',
  update_available: false,
  message: 'AgentsServer is up to date.'
}

function recoveryHealth(overrides: Partial<Health> = {}): Health {
  return restartHealth({
    managed_updates: true,
    capabilities: {
      server_restart: { ...serverRestartCapability, blocker_snapshot: blockerSnapshot({ force_restart_available: true }) },
      server_updates: durableQueueCapability
    },
    ...overrides
  })
}

function recoveryNetworkCalls() {
  return [window.agentsDock.serverUpdates.status, window.agentsDock.serverUpdates.check,
    window.agentsDock.serverUpdates.cancel, window.agentsDock.serverUpdates.start,
    window.agentsDock.servers.restartStatus, window.agentsDock.servers.refresh]
    .map(method => vi.mocked(method).mock.calls.length)
}

function installBridge(
  serverUpdateStatus = vi.fn().mockResolvedValue(null),
  serverRestartStatus = vi.fn().mockResolvedValue(restartStatus()),
  refreshServer = vi.fn().mockResolvedValue({
    activeProfileId: 'profile-1',
    profileGeneration: 7,
    profiles: [{
      id: 'profile-1',
      name: 'Production east',
      serverUrl: 'https://agents.example.test:7850',
      serverIdentity: 'server-a'
    }],
    health: restartHealth({ server_instance_id: 'boot-new' })
  })
) {
  // This suite exercises legacy manual server controls before coordinated enrollment.
  const appUpdateStatus: AppUpdateStatus = {
    state: 'not-available', channel: 'direct', track: 'stable', currentVersion: '1.0.0'
  }
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      serverUpdates: {
        status: serverUpdateStatus,
        check: vi.fn(),
        start: vi.fn(),
        cancel: vi.fn()
      },
      servers: {
        restartStatus: serverRestartStatus,
        refresh: refreshServer
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

function delayAppUpdateStatus() {
  let resolve!: (status: AppUpdateStatus) => void
  vi.mocked(window.agentsDock.updates.status).mockReturnValue(new Promise<AppUpdateStatus>(done => {
    resolve = done
  }))
  return () => act(async () => {
    resolve({ state: 'not-available', channel: 'direct', track: 'stable', currentVersion: '1.0.0' })
    await Promise.resolve()
  })
}

const atomicForceUpdateReservation: ServerUpdateStatus = {
  phase: 'pending',
  current_version: '1.0.0-beta.8',
  target_version: '1.0.0',
  latest_version: '1.0.0',
  track: 'stable',
  schedule_id: '5'.repeat(32),
  server_identity: 'server-a',
  server_instance_id: 'boot-old',
  when_idle: true,
  cancelable: true,
  message: 'AgentsServer is waiting for current work to finish.'
}

async function refuseAtomicForceUpdate(
  recovery: () => Promise<ServerUpdateStatus>,
  refusal = 'server_force_update_changed: The queued update started before restart admission.'
) {
  const pending = atomicForceUpdateReservation
  const updateStatus = vi.fn()
    .mockResolvedValueOnce(pending)
    .mockResolvedValueOnce(pending)
    .mockImplementation(recovery)
  const snapshot = blockerSnapshot({ provider_background_count: 1, force_restart_available: true })
  installBridge(updateStatus, vi.fn().mockResolvedValue(restartStatus(snapshot)))
  showSettings(restartHealth({
    managed_updates: true,
    capabilities: {
      server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
      server_updates: { ...durableQueueCapability, version: 11 }
    }
  }))
  const restartServer = vi.fn().mockRejectedValue(new Error(refusal))
  useAppStore.setState({ restartServer })
  render(<SettingsDialog />)
  openAppUpdates()

  fireEvent.click(await screen.findByRole('button', { name: 'Update now' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Interrupt work and update now' }))
  await waitFor(() => expect(restartServer).toHaveBeenCalledTimes(1))
  expect(restartServer).toHaveBeenCalledWith('boot-old', {
    force: true,
    forceConfirmed: true,
    expectedBlockerRevision: revisionA,
    expectedUpdateScheduleId: pending.schedule_id
  })
  return { updateStatus, restartServer }
}

function expectNoForceUpdateRetry(restartServer: ReturnType<typeof vi.fn>) {
  expect(restartServer).toHaveBeenCalledTimes(1)
  expect(window.agentsDock.serverUpdates.start).not.toHaveBeenCalled()
  expect(window.agentsDock.serverUpdates.cancel).not.toHaveBeenCalled()
}

describe('SettingsDialog managed server restart', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    useAppStore.setState(state => ({
      restartServer: originalRestartServer,
      switchingProfileId: null,
      error: null,
      modals: { ...state.modals, settings: false, appSettings: false }
    }))
  })

  it('reads restart status without checking GitHub when opening legacy Server settings', async () => {
    const status = vi.fn().mockResolvedValue({ phase: 'current', current_version: '1.0.3', track: 'stable' })
    installBridge(status)
    showSettings(recoveryHealth({ server_version: '1.0.3' }))
    render(<SettingsDialog />)
    await waitFor(() => expect(status).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Server' })).toHaveAttribute('aria-current', 'page')
    expect(window.agentsDock.serverUpdates.check).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Updates' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Check server' }))
    await waitFor(() => expect(window.agentsDock.serverUpdates.check).toHaveBeenCalledExactlyOnceWith('stable'))
  })

  it('shows scoped paired recovery without opening the legacy update checker', async () => {
    const failure = 'HTTP Error 503: Service Unavailable'
    installBridge(vi.fn().mockResolvedValue({ phase: 'failed', current_version: '1.0.3', message: failure }))
    const enrolled: AppUpdateStatus = {
      state: 'not-available', channel: 'direct', track: 'stable', currentVersion: '1.0.5',
      serverUpdates: [{ profileId: 'profile-1', name: 'Production east', serverIdentity: 'server-a',
        targetVersion: '1.0.5', phase: 'failed', message: failure }]
    }
    vi.mocked(window.agentsDock.updates.status).mockResolvedValue(enrolled)
    vi.mocked(window.agentsDock.updates.check).mockResolvedValue(enrolled)
    showSettings(recoveryHealth({ server_version: '1.0.4-beta.9' }))
    useAppStore.setState(state => ({ modals: { ...state.modals, settings: false, appSettings: true } }))
    render(<SettingsDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Updates' }))
    expect(await screen.findByRole('button', { name: 'Retry server update' })).toBeEnabled()
    expect(screen.queryByText('Advanced server recovery')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Server update channel' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('group', { name: 'App update channel' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Check server' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Force restart server' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Error details'))
    expect(screen.getByText(failure)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'General' }))
    fireEvent.click(screen.getByRole('button', { name: 'Updates' }))
    expect(screen.getByRole('button', { name: 'Retry server update' })).toBeEnabled()
    expect(window.agentsDock.serverUpdates.status).not.toHaveBeenCalled()
    expect(window.agentsDock.serverUpdates.check).not.toHaveBeenCalled()
    expect(window.agentsDock.serverUpdates.start).not.toHaveBeenCalled()
    expect(window.agentsDock.serverUpdates.cancel).not.toHaveBeenCalled()
  })

  it('preserves an open restart confirmation when delayed app update status arrives, then clears it on reopening Settings', async () => {
    installBridge()
    const resolveAppUpdateStatus = delayAppUpdateStatus()
    showSettings()
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)

    const restart = screen.getByRole('button', { name: 'Restart server' })
    expect(restart).toBeEnabled()
    fireEvent.click(restart)
    const confirmation = screen.getByRole('dialog', { name: 'Restart AgentsServer?' })
    expect(confirmation).toHaveTextContent('Production east')

    await resolveAppUpdateStatus()

    expect(screen.getByRole('dialog', { name: 'Restart AgentsServer?' })).toBe(confirmation)
    expect(restartServer).not.toHaveBeenCalled()
    act(() => useAppStore.getState().setModal('settings', false))
    act(() => useAppStore.getState().setModal('settings', true))
    expect(screen.queryByRole('dialog', { name: 'Restart AgentsServer?' })).not.toBeInTheDocument()
    expect(restartServer).not.toHaveBeenCalled()
  })

  it('preserves a force restart refusal when delayed app update status arrives, then clears it on reopening Settings', async () => {
    installBridge()
    const resolveAppUpdateStatus = delayAppUpdateStatus()
    showSettings(recoveryHealth({ managed_updates: false }))
    const refusal = 'The server refused this restart; review its active work before retrying.'
    const restartServer = vi.fn().mockRejectedValue(new Error(refusal))
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    openAppUpdates()

    const restart = updatesSurface().getByRole('button', { name: 'Force restart server' })
    expect(restart).toBeEnabled()
    fireEvent.click(restart)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Force restart AgentsServer?' })).getByRole('button', { name: 'Force Restart' }))
    expect(await screen.findByText(refusal)).toBeInTheDocument()

    await resolveAppUpdateStatus()

    expect(screen.getByText(refusal)).toBeInTheDocument()
    expect(restartServer).toHaveBeenCalledTimes(1)
    expect(restartServer).toHaveBeenCalledWith('boot-old', {
      force: true, forceConfirmed: true, expectedBlockerRevision: revisionA
    })
    act(() => useAppStore.getState().setModal('appSettings', false))
    act(() => useAppStore.getState().setModal('appSettings', true))
    expect(screen.queryByText(refusal)).not.toBeInTheDocument()
    expect(restartServer).toHaveBeenCalledTimes(1)
  })

  it('opens modern force recovery directly beside Check server with no additional preflight calls', async () => {
    installBridge(vi.fn().mockResolvedValue(currentServerUpdate))
    showSettings(recoveryHealth())
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    openAppUpdates()

    expect(await updatesSurface().findByText('0.1.26-beta.51')).toBeInTheDocument()
    const check = updatesSurface().getByRole('button', { name: 'Check server' })
    expect(check).toBeEnabled()
    const restart = updatesSurface().getByRole('button', { name: 'Force restart server' })
    expect(restart).toBeEnabled()
    expect(restart.parentElement).toBe(check.parentElement)
    const callsBeforeRestart = recoveryNetworkCalls()
    fireEvent.click(restart)

    const confirmation = screen.getByRole('dialog', { name: 'Force restart AgentsServer?' })
    expect(confirmation).toHaveTextContent('Force restart “Production east” at https://agents.example.test:7850?')
    expect(confirmation).toHaveTextContent('Active turns, non-durable queued turns, terminals, tunnels')
    expect(within(confirmation).getByRole('button', { name: 'Force Restart' })).toBeEnabled()
    await waitFor(() => expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toHaveFocus())
    expect(restartServer).not.toHaveBeenCalled()
    expect(recoveryNetworkCalls()).toEqual(callsBeforeRestart)
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Force restart AgentsServer?' })).not.toBeInTheDocument()
  })

  it('force restarts without managed updates or any status endpoint request', async () => {
    const updateStatus = vi.fn().mockResolvedValue(null)
    const forceStatus = vi.fn().mockRejectedValue(new Error('Status endpoint is wedged'))
    installBridge(updateStatus, forceStatus)
    showSettings(recoveryHealth({ managed_updates: false }))
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    openAppUpdates()
    await act(async () => { await Promise.resolve() })

    const force = updatesSurface().getByRole('button', { name: 'Force restart server' })
    expect(force).toBeEnabled()
    expect(updatesSurface().queryByRole('button', { name: 'Check server' })).not.toBeInTheDocument()
    expect(updatesSurface().queryByRole('group', { name: 'Server update channel' })).not.toBeInTheDocument()
    expect(updateStatus).not.toHaveBeenCalled()
    fireEvent.click(force)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Force restart AgentsServer?' })).getByRole('button', { name: 'Force Restart' }))
    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('boot-old', {
      force: true, forceConfirmed: true, expectedBlockerRevision: revisionA
    }))
    expect(restartServer).toHaveBeenCalledTimes(1)
    expect(recoveryNetworkCalls()).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('does not advertise an Updates restart action on an old server with no restart capability', async () => {
    installBridge(vi.fn().mockResolvedValue(currentServerUpdate))
    showSettings({ ok: true, managed_updates: true, server_identity: 'server-a', capabilities: {} })
    render(<SettingsDialog />)
    openAppUpdates()

    expect(await updatesSurface().findByRole('button', { name: 'Check server' })).toBeInTheDocument()
    expect(updatesSurface().queryByRole('button', { name: 'Restart server' })).not.toBeInTheDocument()
    expect(updatesSurface().queryByRole('button', { name: 'Force restart server' })).not.toBeInTheDocument()
  })

  it.each(['unavailable', 'offline', 'switching'] as const)('keeps Updates Restart disabled when %s', async state => {
    installBridge(vi.fn().mockResolvedValue(currentServerUpdate))
    const health = recoveryHealth()
    if (state === 'unavailable') health.capabilities!.server_restart = {
      ...serverRestartCapability, available: false, message: 'Restart is disabled by server policy.'
    }
    showSettings(health, state !== 'offline')
    if (state === 'switching') useAppStore.setState({ switchingProfileId: 'profile-2' })
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    openAppUpdates()

    const restart = await updatesSurface().findByRole('button', { name: /^(?:Force restart server|Restart server)$/ })
    expect(restart).toBeDisabled()
    const reason = state === 'unavailable' ? 'Restart is disabled by server policy.'
      : state === 'offline' ? 'Reconnect to this server before restarting it.'
        : 'AgentsDock is already changing the server connection.'
    expect(restart).toHaveAttribute('title', reason)
    fireEvent.click(restart)
    expect(screen.queryByRole('dialog', { name: 'Restart AgentsServer?' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Force restart AgentsServer?' })).not.toBeInTheDocument()
    expect(restartServer).not.toHaveBeenCalled()
  })

  it('force restarts immediately while preserving a pending idle update without reconciliation or cancellation', async () => {
    const pending: ServerUpdateStatus = {
      ...currentServerUpdate, phase: 'pending', target_version: '0.1.26-beta.52',
      schedule_id: '5'.repeat(32), when_idle: true, cancelable: true,
      message: 'AgentsServer will update when current work finishes.'
    }
    installBridge(vi.fn().mockResolvedValue(pending))
    showSettings(recoveryHealth())
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    openAppUpdates()

    expect(await updatesSurface().findByText(pending.message!)).toBeInTheDocument()
    const restart = updatesSurface().getByRole('button', { name: 'Force restart server' })
    expect(restart).toBeEnabled()
    const callsBeforeRestart = recoveryNetworkCalls()
    fireEvent.click(restart)
    const confirmation = screen.getByRole('dialog', { name: 'Force restart AgentsServer?' })
    expect(confirmation).not.toHaveTextContent('The scheduled idle update will be canceled first')
    expect(restartServer).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Force Restart' }))
    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('boot-old', {
      force: true, forceConfirmed: true, expectedBlockerRevision: revisionA
    }))
    expect(restartServer).toHaveBeenCalledTimes(1)
    expect(recoveryNetworkCalls()).toEqual(callsBeforeRestart)
    expect(window.agentsDock.serverUpdates.cancel).not.toHaveBeenCalled()
  })

  it('disables both Updates controls during one confirmed force restart and never retries the busy request', async () => {
    installBridge(vi.fn().mockResolvedValue(currentServerUpdate))
    showSettings(recoveryHealth())
    let finishRestart!: (value: boolean) => void
    const restartServer = vi.fn(() => new Promise<boolean>(resolve => { finishRestart = resolve }))
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    await act(async () => { await Promise.resolve() })
    openAppUpdates()

    fireEvent.click(await updatesSurface().findByRole('button', { name: 'Force restart server' }))
    const confirm = within(screen.getByRole('dialog', { name: 'Force restart AgentsServer?' })).getByRole('button', { name: 'Force Restart' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('boot-old', {
      force: true, forceConfirmed: true, expectedBlockerRevision: revisionA
    }))
    expect(updatesSurface().getByRole('button', { name: /restarting/i, hidden: true })).toBeDisabled()
    expect(updatesSurface().getByRole('button', { name: 'Check server', hidden: true })).toBeDisabled()
    expect(restartServer).toHaveBeenCalledTimes(1)

    await act(async () => { finishRestart(true) })
    expect(await updatesSurface().findByRole('button', { name: 'Force restart server' })).toBeEnabled()
    expect(updatesSurface().getByRole('button', { name: 'Check server' })).toBeEnabled()
    expect(updatesSurface().getByRole('status')).toHaveTextContent('AgentsServer force restarted and reconnected. Active work was interrupted.')
  })

  it('drops an Updates restart confirmation if the target profile generation changes', async () => {
    installBridge(vi.fn().mockResolvedValue(currentServerUpdate))
    showSettings(recoveryHealth())
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    await act(async () => { await Promise.resolve() })
    openAppUpdates()

    fireEvent.click(await updatesSurface().findByRole('button', { name: 'Force restart server' }))
    expect(screen.getByRole('dialog', { name: 'Force restart AgentsServer?' })).toBeInTheDocument()
    act(() => useAppStore.setState({ profileGeneration: 8 }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Force restart AgentsServer?' })).not.toBeInTheDocument())
    expect(restartServer).not.toHaveBeenCalled()
  })

  it('shows an error rather than success when explicit force restart returns false', async () => {
    installBridge()
    showSettings(recoveryHealth({ managed_updates: false }))
    const restartServer = vi.fn(async () => false)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    await act(async () => { await Promise.resolve() })
    openAppUpdates()
    fireEvent.click(updatesSurface().getByRole('button', { name: 'Force restart server' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Force restart AgentsServer?' })).getByRole('button', { name: 'Force Restart' }))
    expect(await updatesSurface().findByRole('alert')).toHaveTextContent('The force restart request could not be confirmed.')
    expect(restartServer).toHaveBeenCalledTimes(1)
    expect(updatesSurface().queryByText(/force restarted and reconnected/)).not.toBeInTheDocument()
  })

  it('keeps v1 Updates recovery explicitly normal rather than claiming force support', () => {
    installBridge()
    showSettings(restartHealth({ capabilities: {
      server_restart: { ...serverRestartCapability, version: 1, force_restart: false, force_confirmation_required: false }
    } }))
    render(<SettingsDialog />)
    openAppUpdates()
    expect(updatesSurface().queryByRole('button', { name: 'Force restart server' })).not.toBeInTheDocument()
    fireEvent.click(updatesSurface().getByRole('button', { name: 'Restart server' }))
    expect(screen.getByRole('dialog', { name: 'Restart AgentsServer?' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Force Restart' })).not.toBeInTheDocument()
  })

  it('fetches exactly one fresh idle legacy-v2 revision before force confirmation', async () => {
    const fresh = blockerSnapshot({ revision: 'b'.repeat(64) })
    const status = vi.fn().mockResolvedValue(restartStatus(fresh))
    installBridge(vi.fn().mockResolvedValue(null), status)
    showSettings(restartHealth({ managed_updates: false }))
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    openAppUpdates()
    fireEvent.click(updatesSurface().getByRole('button', { name: 'Force restart server' }))
    const force = await screen.findByRole('button', { name: 'Force Restart' })
    await waitFor(() => expect(force).toBeEnabled())
    expect(status).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledWith({ profileId: 'profile-1', profileGeneration: 7, serverIdentity: 'server-a' })
    expect(restartServer).not.toHaveBeenCalled()
    fireEvent.click(force)
    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('boot-old', {
      force: true, forceConfirmed: true, expectedBlockerRevision: fresh.revision
    }))
    expect(restartServer).toHaveBeenCalledTimes(1)
    expect(recoveryNetworkCalls()).toEqual([0, 0, 0, 0, 1, 0])
  })

  it.each(['missing', 'failed'] as const)('blocks legacy force when its required status is %s', async outcome => {
    const status = outcome === 'failed'
      ? vi.fn().mockRejectedValue(new Error('Legacy status is unavailable'))
      : vi.fn().mockResolvedValue(null)
    installBridge(vi.fn().mockResolvedValue(null), status)
    showSettings(restartHealth({ managed_updates: false, capabilities: { server_restart: {
      ...serverRestartCapability, blocker_snapshot: undefined
    } } }))
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    openAppUpdates()
    fireEvent.click(updatesSurface().getByRole('button', { name: 'Force restart server' }))
    const force = await screen.findByRole('button', { name: 'Force Restart' })
    await act(async () => { await Promise.resolve() })
    expect(status).toHaveBeenCalledTimes(1)
    expect(force).toBeDisabled()
    fireEvent.click(force)
    expect(restartServer).not.toHaveBeenCalled()
  })

  it.each([true, false])('retires a queued safe restart before force recovery, even when confirmation returns %s', async forceConfirmed => {
    vi.useFakeTimers()
    try {
      const installing: ServerUpdateStatus = {
        ...currentServerUpdate, phase: 'installing', target_version: '0.1.26-beta.52',
        message: 'Installing AgentsServer 0.1.26-beta.52…'
      }
      const updateStatus = vi.fn().mockResolvedValue(installing)
      installBridge(updateStatus)
      showSettings(recoveryHealth())
      const restartServer = vi.fn(async () => forceConfirmed)
      useAppStore.setState({ restartServer })
      render(<SettingsDialog />)
      await act(async () => { await Promise.resolve() })

      fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Restart AgentsServer?' })).getByRole('button', { name: 'Restart server' }))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(screen.getByText(/Restart queued\. It will run as soon as/)).toBeInTheDocument()
      expect(restartServer).not.toHaveBeenCalled()

      openAppUpdates()
      fireEvent.click(updatesSurface().getByRole('button', { name: 'Force restart server' }))
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Force restart AgentsServer?' })).getByRole('button', { name: 'Force Restart' }))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(restartServer).toHaveBeenCalledTimes(1)
      expect(restartServer).toHaveBeenCalledWith('boot-old', {
        force: true, forceConfirmed: true, expectedBlockerRevision: revisionA
      })

      updateStatus.mockResolvedValue({ ...installing, phase: 'complete', current_version: '0.1.26-beta.52' })
      await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
      expect(updatesSurface().getByText('0.1.26-beta.52')).toBeInTheDocument()
      expect(restartServer).toHaveBeenCalledTimes(1)
      expect(window.agentsDock.servers.refresh).not.toHaveBeenCalled()
      expect(window.agentsDock.serverUpdates.cancel).not.toHaveBeenCalled()
      expect(window.agentsDock.serverUpdates.start).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not expose restart on an older server without the capability or boot identifier', () => {
    installBridge()
    showSettings({ ok: true, server_identity: 'server-a', capabilities: {} })

    render(<SettingsDialog />)

    expect(screen.queryByRole('button', { name: 'Restart server' })).not.toBeInTheDocument()
  })

  it('shows an advertised but unavailable capability as disabled with the server reason', () => {
    installBridge()
    showSettings(restartHealth({
      capabilities: {
        server_restart: {
          ...serverRestartCapability,
          available: false,
          message: 'Restart is disabled by server policy.'
        }
      }
    }))

    render(<SettingsDialog />)

    const restart = screen.getByRole('button', { name: 'Restart server' })
    expect(restart).toBeDisabled()
    expect(restart).toHaveAttribute('title', 'Restart is disabled by server policy.')
  })

  it('keeps restart disabled while the active profile is offline', () => {
    installBridge()
    showSettings(restartHealth(), false)

    render(<SettingsDialog />)

    const restart = screen.getByRole('button', { name: 'Restart server' })
    expect(restart).toBeDisabled()
    expect(restart).toHaveAttribute('title', 'Reconnect to this server before restarting it.')
  })

  it('queues restart instead of disabling it while a managed server update is active', async () => {
    const installing: ServerUpdateStatus = {
      phase: 'installing',
      current_version: '0.1.20',
      target_version: '0.1.21',
      message: 'Installing AgentsServer 0.1.21…'
    }
    const complete: ServerUpdateStatus = {
      phase: 'complete',
      current_version: '0.1.21',
      target_version: '0.1.21',
      message: 'AgentsServer 0.1.21 installed.'
    }
    const serverUpdateStatus = vi.fn()
      .mockResolvedValueOnce(installing)
      .mockResolvedValueOnce(installing)
      .mockResolvedValue(complete)
    installBridge(serverUpdateStatus)
    showSettings(restartHealth({ managed_updates: true }))
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })

    render(<SettingsDialog />)

    await waitFor(() => expect(serverUpdateStatus).toHaveBeenCalled())
    const restart = screen.getByRole('button', { name: 'Restart server' })
    expect(restart).toBeEnabled()
    fireEvent.click(restart)
    expect(screen.getByText(/Confirming will queue this restart/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    expect(await screen.findByText(/Restart queued\. It will run as soon as/)).toBeInTheDocument()
    expect(restartServer).not.toHaveBeenCalled()
    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('boot-new'), { timeout: 2_500 })
    expect(window.agentsDock.servers.refresh).toHaveBeenCalledWith('profile-1', 7)
    expect(restartServer).not.toHaveBeenCalledWith('boot-old')
  })

  it('retries a pre-request refresh but never repeats an ambiguous queued restart', async () => {
    vi.useFakeTimers()
    try {
      const installing: ServerUpdateStatus = {
        phase: 'installing',
        current_version: '0.1.20',
        target_version: '0.1.21',
        message: 'Installing AgentsServer 0.1.21…'
      }
      const complete: ServerUpdateStatus = {
        phase: 'complete',
        current_version: '0.1.21',
        target_version: '0.1.21',
        message: 'AgentsServer 0.1.21 installed.'
      }
      const refresh = vi.fn()
        .mockRejectedValueOnce(new Error('connection is still warming up'))
        .mockResolvedValue({
          activeProfileId: 'profile-1',
          profileGeneration: 7,
          profiles: [{
            id: 'profile-1',
            name: 'Production east',
            serverUrl: 'https://agents.example.test:7850',
            serverIdentity: 'server-a'
          }],
          health: restartHealth({ server_instance_id: 'boot-new' })
        })
      installBridge(
        vi.fn()
          .mockResolvedValueOnce(installing)
          .mockResolvedValueOnce(installing)
          .mockResolvedValue(complete),
        vi.fn().mockResolvedValue(restartStatus()),
        refresh
      )
      showSettings(restartHealth({ managed_updates: true }))
      const restartServer = vi.fn(async () => {
        throw new Error('restart outcome is unknown')
      })
      useAppStore.setState({ restartServer })
      render(<SettingsDialog />)

      await act(async () => { await Promise.resolve() })
      fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
      fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(screen.getByText(/Restart queued\. It will run as soon as/)).toBeInTheDocument()

      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(screen.getByText(/AgentsDock will retry automatically/)).toBeInTheDocument()

      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(refresh).toHaveBeenCalledTimes(2)
      expect(restartServer).toHaveBeenCalledTimes(1)
      expect(screen.getByText(/Use Restart server to retry/)).toBeInTheDocument()

      await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
      expect(refresh).toHaveBeenCalledTimes(2)
      expect(restartServer).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps restart actionable while a durable update waits for idle and explains that new work can defer it', async () => {
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.25',
      target_version: '0.1.26-beta.14',
      track: 'beta',
      schedule_id: '11111111111111111111111111111111',
      when_idle: true,
      cancelable: true,
      message: 'AgentsServer 0.1.26-beta.14 will install when current work finishes. Work remains available while this update is pending; starting new work can defer installation.'
    }
    const serverUpdateStatus = vi.fn().mockResolvedValue(pending)
    installBridge(serverUpdateStatus)
    showSettings(restartHealth({
      managed_updates: true,
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: blockerSnapshot() },
        server_updates: { ...durableQueueCapability, version: 7 }
      }
    }))

    render(<SettingsDialog />)
    openAppUpdates()

    expect(await screen.findByText(pending.message!)).toBeInTheDocument()
    expect(screen.queryByText(/AgentsDock remains usable while this update is pending/)).not.toBeInTheDocument()
    openServerSettingsFromApp()
    const restart = screen.getByRole('button', { name: 'Restart server' })
    expect(restart).toBeEnabled()
    fireEvent.click(restart)
    expect(screen.getByRole('dialog', { name: 'Restart AgentsServer?' })).toBeInTheDocument()
  })

  it('requires update capability v10 before offering the verified Update now action', async () => {
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.26-beta.40',
      target_version: '0.1.26-beta.41',
      track: 'beta',
      schedule_id: '1'.repeat(32),
      when_idle: true,
      cancelable: true,
      message: 'AgentsServer is waiting for current work to finish.'
    }
    const restartStatusRequest = vi.fn().mockResolvedValue(restartStatus(blockerSnapshot({
      provider_background_count: 1,
      force_restart_available: true
    })))
    installBridge(vi.fn().mockResolvedValue(pending), restartStatusRequest)
    showSettings(restartHealth({
      managed_updates: true,
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: blockerSnapshot() },
        server_updates: { ...durableQueueCapability, version: 9 }
      }
    }))
    render(<SettingsDialog />)
    openAppUpdates()

    const updateNow = await screen.findByRole('button', { name: 'Update now' })
    expect(updateNow).toBeDisabled()
    expect(updateNow).toHaveAttribute('title', expect.stringContaining('supports verified Update now'))
    expect(restartStatusRequest).not.toHaveBeenCalled()
  })

  it('reconciles a v10 reservation immediately before force restart without sending the v11 schedule field', async () => {
    const scheduleId = '1'.repeat(32)
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.26-beta.39',
      target_version: '0.1.26-beta.40',
      track: 'beta',
      schedule_id: scheduleId,
      when_idle: true,
      cancelable: true,
      message: 'AgentsServer is waiting for current work to finish.'
    }
    const snapshot = blockerSnapshot({
      provider_background_count: 1,
      force_restart_available: true
    })
    const updateStatus = vi.fn().mockResolvedValue(pending)
    const restartStatusRequest = vi.fn().mockResolvedValue(restartStatus(snapshot))
    installBridge(updateStatus, restartStatusRequest)
    showSettings(restartHealth({
      managed_updates: true,
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
        server_updates: { ...durableQueueCapability, version: 10 }
      }
    }))
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    openAppUpdates()

    const updateNow = await screen.findByRole('button', { name: 'Update now' })
    expect(updateNow).toBeEnabled()
    fireEvent.click(updateNow)

    const confirmation = await screen.findByRole('dialog', { name: 'Update AgentsServer now?' })
    expect(confirmation).toHaveTextContent('verify its exact schedule and target again immediately before restarting')
    fireEvent.click(await screen.findByRole('button', { name: 'Interrupt work and update now' }))

    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: revisionA
    }))
    expect(updateStatus).toHaveBeenCalledTimes(2)
    expect(window.agentsDock.serverUpdates.cancel).not.toHaveBeenCalled()
  })

  it('clears a stale Update now confirmation when App Settings reopens', async () => {
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.26-beta.39',
      target_version: '0.1.26-beta.40',
      track: 'beta',
      schedule_id: '1'.repeat(32),
      when_idle: true,
      cancelable: true,
      message: 'AgentsServer is waiting for current work to finish.'
    }
    const snapshot = blockerSnapshot({
      provider_background_count: 1,
      force_restart_available: true
    })
    installBridge(
      vi.fn().mockResolvedValue(pending),
      vi.fn().mockResolvedValue(restartStatus(snapshot))
    )
    showSettings(restartHealth({
      managed_updates: true,
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
        server_updates: { ...durableQueueCapability, version: 10 }
      }
    }))
    render(<SettingsDialog />)
    openAppUpdates()

    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }))
    expect(await screen.findByRole('dialog', { name: 'Update AgentsServer now?' })).toBeInTheDocument()

    act(() => useAppStore.getState().setModal('appSettings', false))
    act(() => useAppStore.getState().setModal('appSettings', true))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Update AgentsServer now?' })).not.toBeInTheDocument())
  })

  it('confirms interruption, preserves the exact reservation, and shows update restart progress', async () => {
    const scheduleId = '2'.repeat(32)
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.26-beta.40',
      target_version: '0.1.26-beta.41',
      track: 'beta',
      schedule_id: scheduleId,
      when_idle: true,
      cancelable: true,
      message: 'AgentsServer is waiting for current work to finish.'
    }
    const snapshot = blockerSnapshot({
      provider_background_count: 2,
      force_restart_available: true
    })
    const updateStatus = vi.fn().mockResolvedValue(pending)
    const restartStatusRequest = vi.fn().mockResolvedValue(restartStatus(snapshot))
    installBridge(updateStatus, restartStatusRequest)
    showSettings(restartHealth({
      managed_updates: true,
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
        server_updates: { ...durableQueueCapability, version: 11 }
      }
    }))
    let finishRestart!: (value: boolean) => void
    const restartServer = vi.fn(() => new Promise<boolean>(resolve => { finishRestart = resolve }))
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    openAppUpdates()

    const updateNow = await screen.findByRole('button', { name: 'Update now' })
    expect(updateNow).toBeEnabled()
    fireEvent.click(updateNow)

    const confirmation = await screen.findByRole('dialog', { name: 'Update AgentsServer now?' })
    expect(restartStatusRequest).toHaveBeenCalledWith({
      profileId: 'profile-1',
      profileGeneration: 7,
      serverIdentity: 'server-a'
    })
    expect(confirmation).toHaveTextContent('force restarts AgentsServer and interrupts current work')
    expect(confirmation).toHaveTextContent('Active turns and provider background tasks are terminated and are not replayed')
    expect(confirmation).toHaveTextContent('2 provider background tasks')
    expect(confirmation).toHaveTextContent('queued update reservation will not be canceled')
    expect(confirmation).toHaveTextContent('0.1.26-beta.41')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Interrupt work and update now' }))
    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: revisionA,
      expectedUpdateScheduleId: scheduleId
    }))
    expect(window.agentsDock.serverUpdates.cancel).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Restarting for update…' })).toBeDisabled()
    expect(screen.getByText(/queued update remains reserved; reconnecting/)).toHaveAttribute('role', 'status')

    await act(async () => { finishRestart(true) })
    expect(await screen.findByText(/preserved 0.1.26-beta.41 update will install automatically/)).toHaveAttribute('role', 'status')
    expect(window.agentsDock.serverUpdates.cancel).not.toHaveBeenCalled()
  })

  it('refuses legacy Update now when the exact reservation changes during confirmation', async () => {
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.26-beta.40',
      target_version: '0.1.26-beta.41',
      track: 'beta',
      schedule_id: '3'.repeat(32),
      when_idle: true,
      cancelable: true,
      message: 'AgentsServer is waiting for current work to finish.'
    }
    const changed = { ...pending, schedule_id: '4'.repeat(32) }
    const updateStatus = vi.fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(changed)
    const snapshot = blockerSnapshot({ provider_background_count: 1, force_restart_available: true })
    installBridge(updateStatus, vi.fn().mockResolvedValue(restartStatus(snapshot)))
    showSettings(restartHealth({
      managed_updates: true,
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
        server_updates: { ...durableQueueCapability, version: 10 }
      }
    }))
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    openAppUpdates()

    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Interrupt work and update now' }))

    expect((await screen.findAllByRole('alert')).some(alert => (
      alert.textContent?.includes('queued update reservation changed before restart')
    ))).toBe(true)
    expect(screen.getByRole('dialog', { name: 'Update AgentsServer now?' })).toBeInTheDocument()
    expect(restartServer).not.toHaveBeenCalled()
    expect(window.agentsDock.serverUpdates.cancel).not.toHaveBeenCalled()
  })

  it('does not retry an atomic force-update refusal and gives a safe recovery path', async () => {
    const { updateStatus, restartServer } = await refuseAtomicForceUpdate(async () => atomicForceUpdateReservation)
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some(alert => /confirm|retry/i.test(alert.textContent || ''))).toBe(true)
    expect(updateStatus).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('dialog', { name: 'Update AgentsServer now?' })).not.toBeInTheDocument()
    expectNoForceUpdateRetry(restartServer)
  })

  it.each(['starting', 'installing', 'restarting'] as const)(
    'follows the exact approved update now %s after stale force confirmation without restarting again',
    async phase => {
      const fresh: ServerUpdateStatus = {
        ...atomicForceUpdateReservation,
        phase,
        cancelable: false,
        update_id: '6'.repeat(32),
        message: `The approved release is now ${phase}.`
      }
      const { updateStatus, restartServer } = await refuseAtomicForceUpdate(async () => fresh)

      expect(await screen.findByText(fresh.message!)).toBeInTheDocument()
      expect(screen.queryAllByRole('alert')).toHaveLength(0)
      expect(screen.queryByRole('dialog', { name: 'Update AgentsServer now?' })).not.toBeInTheDocument()
      expect(updateStatus).toHaveBeenCalledTimes(3)
      expectNoForceUpdateRetry(restartServer)
    }
  )

  it.each(['complete', 'current'] as const)(
    'shows the exact approved installed release after force refusal when its status is %s',
    async phase => {
      const fresh: ServerUpdateStatus = {
        ...atomicForceUpdateReservation,
        phase,
        current_version: '1.0.0',
        installed_version: '1.0.0',
        update_available: false,
        cancelable: false,
        message: 'AgentsServer 1.0.0 is installed and healthy.'
      }
      const { updateStatus, restartServer } = await refuseAtomicForceUpdate(async () => fresh)

      expect(await updatesSurface().findByText(phase === 'current' ? 'This is the latest one.' : fresh.message!)).toBeInTheDocument()
      expect(updatesSurface().getByText('1.0.0')).toBeInTheDocument()
      expect(screen.queryAllByRole('alert')).toHaveLength(0)
      expect(updateStatus).toHaveBeenCalledTimes(3)
      expectNoForceUpdateRetry(restartServer)
    }
  )

  it('recovers the exact legacy refusal prose when the IPC error omitted its server code', async () => {
    const fresh: ServerUpdateStatus = {
      ...atomicForceUpdateReservation,
      phase: 'installing',
      cancelable: false,
      message: 'The approved release is installing after the confirmation race.'
    }
    const { updateStatus, restartServer } = await refuseAtomicForceUpdate(
      async () => fresh,
      'The scheduled server update changed before force update confirmation. AgentsServer was not restarted. Refresh update status and confirm the force update again.'
    )

    expect(await screen.findByText(fresh.message!)).toBeInTheDocument()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(updateStatus).toHaveBeenCalledTimes(3)
    expectNoForceUpdateRetry(restartServer)
  })

  it.each([
    ['schedule', { schedule_id: '7'.repeat(32) }],
    ['target', { target_version: '1.1.0' }],
    ['track', { track: 'beta' }]
  ] as const)('does not adopt an update with a changed %s after force refusal', async (_field, change) => {
    const fresh: ServerUpdateStatus = {
      ...atomicForceUpdateReservation,
      phase: 'installing',
      cancelable: false,
      ...change,
      message: 'A different update is installing; review its reservation.'
    }
    const { updateStatus, restartServer } = await refuseAtomicForceUpdate(async () => fresh)

    expect((await screen.findAllByRole('alert')).some(alert => /changed|confirm/i.test(alert.textContent || ''))).toBe(true)
    expect(updatesSurface().getByRole('button', { name: fresh.track === 'beta' ? 'Beta' : 'Stable' })).toHaveClass('active')
    expect(updatesSurface().getByRole('button', { name: 'Check server' })).toBeDisabled()
    expect(screen.queryByText(/following its install|already updating/i)).not.toBeInTheDocument()
    expect(updateStatus).toHaveBeenCalledTimes(3)
    expectNoForceUpdateRetry(restartServer)
  })

  it.each(['failed', 'available'] as const)('shows the actual preflight failure when the waiter cleared the reservation to %s before force admission', async phase => {
    const fresh: ServerUpdateStatus = {
      ...atomicForceUpdateReservation,
      phase,
      schedule_id: undefined,
      target_version: undefined,
      cancelable: undefined,
      message: 'Installer preflight requires an isolated tmux server.',
      error_code: 'unsafe_tmux_service_cgroup',
      error_action: 'Repair the tmux service isolation before scheduling again.'
    }
    const { updateStatus, restartServer } = await refuseAtomicForceUpdate(async () => fresh)

    expect((await screen.findAllByRole('alert')).some(alert => alert.textContent?.includes(fresh.message!))).toBe(true)
    expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes(fresh.error_action!))).toBe(true)
    expect(screen.queryByText(/remains reserved|still queued|did not cancel the queued update/i)).not.toBeInTheDocument()
    expect(updateStatus).toHaveBeenCalledTimes(3)
    expect(updatesSurface().getByRole('button', { name: 'Check server' })).toBeEnabled()
    expectNoForceUpdateRetry(restartServer)
  })

  it('keeps force-update outcome unconfirmed after a failed recovery read until an explicit status check succeeds', async () => {
    const { updateStatus, restartServer } = await refuseAtomicForceUpdate(async () => {
      throw new Error('Status endpoint is temporarily unreachable.')
    })

    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some(alert => /unconfirmed|could not.*(?:confirm|verify)|unable.*(?:confirm|verify)/i.test(alert.textContent || ''))).toBe(true)
    expect(screen.queryByText(/remains reserved|still queued|did not cancel the queued update/i)).not.toBeInTheDocument()
    expect(updateStatus).toHaveBeenCalledTimes(3)
    expect(updatesSurface().getByRole('button', { name: 'Check server' })).toBeEnabled()
    expectNoForceUpdateRetry(restartServer)

    const checked: ServerUpdateStatus = {
      ...atomicForceUpdateReservation,
      phase: 'available',
      schedule_id: undefined,
      when_idle: false,
      cancelable: false,
      message: 'Fresh verified status: AgentsServer 1.0.0 is available.'
    }
    vi.mocked(window.agentsDock.serverUpdates.check).mockResolvedValue(checked)
    fireEvent.click(updatesSurface().getByRole('button', { name: 'Check server' }))

    expect(await screen.findByText(checked.message!)).toBeInTheDocument()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(window.agentsDock.serverUpdates.check).toHaveBeenCalledExactlyOnceWith('stable')
    expect(updateStatus).toHaveBeenCalledTimes(3)
    expectNoForceUpdateRetry(restartServer)
  })

  it('preserves an unrelated restart failure notice when an explicit update check succeeds', async () => {
    installBridge(vi.fn().mockResolvedValue(currentServerUpdate))
    showSettings(recoveryHealth())
    const restartServer = vi.fn(async () => false)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    await act(async () => { await Promise.resolve() })
    openAppUpdates()
    fireEvent.click(await updatesSurface().findByRole('button', { name: 'Force restart server' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Force restart AgentsServer?' })).getByRole('button', { name: 'Force Restart' }))
    expect(await updatesSurface().findByRole('alert')).toHaveTextContent('The force restart request could not be confirmed.')

    const checked: ServerUpdateStatus = {
      ...currentServerUpdate,
      current_version: '1.0.0-beta.8',
      latest_version: '1.0.0-beta.9',
      phase: 'available',
      message: 'Update availability was checked; the earlier restart remains unconfirmed.'
    }
    const checksBeforeExplicitRefresh = vi.mocked(window.agentsDock.serverUpdates.check).mock.calls.length
    vi.mocked(window.agentsDock.serverUpdates.check).mockResolvedValue(checked)
    fireEvent.click(updatesSurface().getByRole('button', { name: 'Check server' }))

    expect(await updatesSurface().findByText('1.0.0-beta.8')).toBeInTheDocument()
    expect(updatesSurface().getByRole('alert')).toHaveTextContent('The force restart request could not be confirmed.')
    expect(window.agentsDock.serverUpdates.check).toHaveBeenCalledTimes(checksBeforeExplicitRefresh + 1)
    expect(window.agentsDock.serverUpdates.check).toHaveBeenLastCalledWith('beta')
    expectNoForceUpdateRetry(restartServer)
  })

  it('does not publish the old server recovery result after the active server scope changes', async () => {
    let finishRecovery!: (status: ServerUpdateStatus) => void
    const recovery = new Promise<ServerUpdateStatus>(resolve => { finishRecovery = resolve })
    const { updateStatus, restartServer } = await refuseAtomicForceUpdate(() => recovery)
    await waitFor(() => expect(updateStatus).toHaveBeenCalledTimes(3))
    const serverB: ServerUpdateStatus = {
      ...currentServerUpdate,
      phase: 'available',
      server_identity: 'server-b',
      server_instance_id: 'boot-b',
      message: 'Server B is current; no update requested.'
    }
    updateStatus.mockResolvedValue(serverB)
    act(() => useAppStore.setState(state => ({
      activeProfileId: 'profile-2',
      profileGeneration: 8,
      profiles: [...state.profiles, {
        ...state.profiles[0]!,
        id: 'profile-2',
        name: 'Server B',
        serverIdentity: 'server-b',
        serverUrl: 'https://other.example.test:7850'
      }],
      health: restartHealth({ managed_updates: true, server_identity: 'server-b', server_instance_id: 'boot-b' })
    })))
    expect(await screen.findByText(serverB.message!)).toBeInTheDocument()
    await act(async () => finishRecovery({
      ...atomicForceUpdateReservation,
      phase: 'installing',
      cancelable: false,
      message: 'OLD SERVER A UPDATE RESULT MUST NOT APPEAR'
    }))

    expect(screen.getByText(serverB.message!)).toBeInTheDocument()
    expect(screen.queryByText('OLD SERVER A UPDATE RESULT MUST NOT APPEAR')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expectNoForceUpdateRetry(restartServer)
  })

  it.each([
    ['identity', { server_identity: 'foreign-server' }],
    ['instance', { server_instance_id: 'foreign-boot' }]
  ] as const)('does not adopt recovery status carrying a foreign server %s even when the app scope did not change', async (_field, change) => {
    const foreign: ServerUpdateStatus = {
      ...atomicForceUpdateReservation,
      ...change,
      phase: 'installing',
      current_version: '9.9.9',
      message: 'FOREIGN SERVER STATUS MUST NOT APPEAR'
    }
    const { updateStatus, restartServer } = await refuseAtomicForceUpdate(async () => foreign)

    expect((await screen.findAllByRole('alert')).some(alert => /could not verify the current update state/i.test(alert.textContent || ''))).toBe(true)
    expect(screen.queryByText(foreign.message!)).not.toBeInTheDocument()
    expect(screen.queryByText('9.9.9')).not.toBeInTheDocument()
    expect(updatesSurface().getByRole('button', { name: 'Check server' })).toBeEnabled()
    expect(useAppStore.getState().health?.server_identity).toBe('server-a')
    expect(useAppStore.getState().health?.server_instance_id).toBe('boot-old')
    expect(updateStatus).toHaveBeenCalledTimes(3)
    expectNoForceUpdateRetry(restartServer)
  })

  it('preserves a newer unrelated global error while recovering the refused force update', async () => {
    let finishRecovery!: (status: ServerUpdateStatus) => void
    const recovery = new Promise<ServerUpdateStatus>(resolve => { finishRecovery = resolve })
    const { updateStatus, restartServer } = await refuseAtomicForceUpdate(() => recovery)
    await waitFor(() => expect(updateStatus).toHaveBeenCalledTimes(3))
    act(() => useAppStore.setState({ error: 'A separate file request was denied.' }))
    const fresh: ServerUpdateStatus = {
      ...atomicForceUpdateReservation,
      phase: 'installing',
      cancelable: false,
      message: 'The exact update is installing; unrelated errors remain independent.'
    }
    await act(async () => finishRecovery(fresh))

    expect(await screen.findByText(fresh.message!)).toBeInTheDocument()
    expect(useAppStore.getState().error).toBe('A separate file request was denied.')
    expect(updateStatus).toHaveBeenCalledTimes(3)
    expectNoForceUpdateRetry(restartServer)
  })

  it('clears the old recovery notice after the same server reconnects with a new boot', async () => {
    let finishRecovery!: (status: ServerUpdateStatus) => void
    const recovery = new Promise<ServerUpdateStatus>(resolve => { finishRecovery = resolve })
    const { updateStatus, restartServer } = await refuseAtomicForceUpdate(() => recovery)
    await waitFor(() => expect(updateStatus).toHaveBeenCalledTimes(3))
    const reconnected: ServerUpdateStatus = {
      ...atomicForceUpdateReservation,
      phase: 'available',
      schedule_id: undefined,
      server_instance_id: 'boot-new',
      message: 'The newly connected server has fresh update status.'
    }
    updateStatus.mockResolvedValue(reconnected)
    act(() => useAppStore.setState(state => ({
      profileGeneration: 8,
      health: { ...state.health!, server_instance_id: 'boot-new' }
    })))
    await waitFor(() => expect(updateStatus).toHaveBeenCalledTimes(4))
    await act(async () => finishRecovery({
      ...atomicForceUpdateReservation,
      phase: 'installing',
      message: 'STALE PREVIOUS BOOT RESULT'
    }))

    expect(await screen.findByText(reconnected.message!)).toBeInTheDocument()
    expect(screen.queryByText(/Checking the current update state/i)).not.toBeInTheDocument()
    expect(screen.queryByText('STALE PREVIOUS BOOT RESULT')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expectNoForceUpdateRetry(restartServer)
  })

  it('does not recover or retry unrelated force-restart errors', async () => {
    const { updateStatus, restartServer } = await refuseAtomicForceUpdate(
      async () => atomicForceUpdateReservation,
      'Authentication was denied by the server.'
    )

    expect((await screen.findAllByRole('alert')).some(alert => /Authentication was denied/i.test(alert.textContent || ''))).toBe(true)
    expect(updateStatus).toHaveBeenCalledTimes(2)
    expectNoForceUpdateRetry(restartServer)
  })

  it('cancels an exact pending reservation before restarting now', async () => {
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.26-beta.13',
      target_version: '0.1.26-beta.14',
      track: 'beta',
      schedule_id: '22222222222222222222222222222222',
      when_idle: true,
      cancelable: true,
      message: 'AgentsServer is waiting for current work to finish.'
    }
    const serverUpdateStatus = vi.fn().mockResolvedValue(pending)
    installBridge(serverUpdateStatus)
    const cancel = vi.mocked(window.agentsDock.serverUpdates.cancel)
    cancel.mockResolvedValue({
      phase: 'available',
      current_version: pending.current_version,
      latest_version: pending.target_version,
      update_available: true,
      track: 'beta',
      message: 'Scheduled update canceled.'
    })
    showSettings(restartHealth({
      managed_updates: true,
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: blockerSnapshot() },
        server_updates: { ...durableQueueCapability, version: 6 }
      }
    }))
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })

    render(<SettingsDialog />)

    await waitFor(() => expect(serverUpdateStatus).toHaveBeenCalled())
    const restart = screen.getByRole('button', { name: 'Restart server' })
    expect(restart).toBeEnabled()
    fireEvent.click(restart)
    expect(screen.getByText(/scheduled idle update will be canceled first/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(pending.schedule_id))
    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('boot-old'))
  })

  it('settles an in-flight update cancellation and refreshes status before restarting', async () => {
    const pending: ServerUpdateStatus = {
      phase: 'pending',
      current_version: '0.1.26-beta.13',
      target_version: '0.1.26-beta.14',
      track: 'beta',
      schedule_id: '33333333333333333333333333333333',
      when_idle: true,
      cancelable: true,
      message: 'AgentsServer is waiting for current work to finish.'
    }
    const available: ServerUpdateStatus = {
      phase: 'available',
      current_version: pending.current_version,
      latest_version: pending.target_version,
      update_available: true,
      track: 'beta',
      message: 'Scheduled update canceled.'
    }
    const serverUpdateStatus = vi.fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(available)
    installBridge(serverUpdateStatus)
    let finishCancellation!: (status: ServerUpdateStatus) => void
    const cancel = vi.mocked(window.agentsDock.serverUpdates.cancel)
    cancel.mockReturnValue(new Promise(resolve => { finishCancellation = resolve }))
    showSettings(restartHealth({ managed_updates: true }))
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    openAppUpdates()

    expect(await screen.findByText(pending.message!)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued update' }))
    openServerSettingsFromApp()
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    await act(async () => { await Promise.resolve() })
    expect(restartServer).not.toHaveBeenCalled()

    finishCancellation(available)
    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('boot-old'))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(serverUpdateStatus).toHaveBeenCalledTimes(2)
  })

  it('settles an in-flight deferred update check before restarting', async () => {
    window.localStorage.setItem('agentsdock:deferred-server-updates:v1', JSON.stringify({
      'profile-1': {
        profileId: 'profile-1',
        serverIdentity: 'server-a',
        serverUrl: 'https://agents.example.test:7850',
        track: 'beta',
        version: '0.1.26-beta.14',
        queuedAt: '2026-08-28T12:00:00Z',
        waitForQueuedTurns: false
      }
    }))
    const available: ServerUpdateStatus = {
      phase: 'available',
      current_version: '0.1.26-beta.13',
      latest_version: '0.1.26-beta.14',
      update_available: true,
      track: 'beta',
      message: 'AgentsServer beta is available.'
    }
    installBridge(vi.fn().mockResolvedValue(available))
    let finishCheck!: (status: ServerUpdateStatus) => void
    const check = vi.mocked(window.agentsDock.serverUpdates.check)
    check.mockReturnValue(new Promise(resolve => { finishCheck = resolve }))
    showSettings(restartHealth({
      managed_updates: true,
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: blockerSnapshot() },
        server_updates: { ...durableQueueCapability, version: 2 }
      }
    }))
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })

    render(<SettingsDialog />)
    await act(async () => { await Promise.resolve() })

    await waitFor(() => expect(check).toHaveBeenCalledWith('beta'))
    const restart = screen.getByRole('button', { name: 'Restart server' })
    expect(restart).toBeEnabled()
    fireEvent.click(restart)
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    await act(async () => { await Promise.resolve() })
    expect(restartServer).not.toHaveBeenCalled()

    finishCheck(available)
    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('boot-old'))
    expect(window.agentsDock.serverUpdates.start).not.toHaveBeenCalled()
  })

  it('names the exact active profile and URL in an accessible confirmation and focuses Cancel first', async () => {
    installBridge()
    showSettings()
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))

    const confirmation = screen.getByRole('dialog', { name: 'Restart AgentsServer?' })
    expect(confirmation).toHaveTextContent('Restart “Production east” at https://agents.example.test:7850?')
    expect(confirmation).toHaveTextContent('Chats and durable queued work are preserved.')
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(cancel).toHaveFocus())
    fireEvent.click(cancel)
    expect(screen.queryByRole('dialog', { name: 'Restart AgentsServer?' })).not.toBeInTheDocument()
  })

  it('keeps safe Restart available when work is active and still permits durable queued work', () => {
    installBridge()
    showSettings(restartHealth({ active_sessions: ['chat-1'] }))
    const view = render(<SettingsDialog />)

    let restart = screen.getByRole('button', { name: 'Restart server' })
    expect(restart).toBeEnabled()
    expect(restart).toHaveAttribute('title', 'Safely restart Production east')

    act(() => {
      useAppStore.setState({
        health: restartHealth({ queued: { codex: 2 }, update_blocking_queued_count: 1 })
      })
    })
    restart = screen.getByRole('button', { name: 'Restart server' })
    expect(restart).toBeEnabled()

    act(() => {
      useAppStore.setState({
        health: restartHealth({ queued: { codex: 2 }, update_blocking_queued_count: 0 })
      })
    })
    restart = screen.getByRole('button', { name: 'Restart server' })
    expect(restart).toBeEnabled()
    view.unmount()
  })

  it('never exposes Force Restart for a v1 restart capability', () => {
    installBridge()
    const snapshot = blockerSnapshot({ active_count: 1 })
    showSettings(restartHealth({
      capabilities: {
        server_restart: {
          version: 1,
          available: true,
          required: false,
          message: 'Safe restart only.',
          action: null,
          blocker_snapshot: snapshot
        },
        server_updates: durableQueueCapability
      }
    }))
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))

    expect(screen.getByRole('dialog', { name: 'Restart AgentsServer?' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review force restart…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Force Restart' })).not.toBeInTheDocument()
  })

  it('passes the verified boot identifier once and announces successful reconnection', async () => {
    installBridge()
    showSettings()
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))

    await waitFor(() => expect(restartServer).toHaveBeenCalledTimes(1))
    expect(restartServer).toHaveBeenCalledWith('boot-old')
    expect(await screen.findByText('AgentsServer restarted and reconnected.')).toHaveAttribute('role', 'status')
  })

  it('clears restart status when the active server scope changes', async () => {
    installBridge()
    showSettings()
    useAppStore.setState({ restartServer: vi.fn(async () => true) })
    render(<SettingsDialog />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    expect(await screen.findByText('AgentsServer restarted and reconnected.')).toBeInTheDocument()

    act(() => {
      useAppStore.setState({ activeProfileId: 'profile-2', profileGeneration: 8 })
    })

    await waitFor(() => {
      expect(screen.queryByText('AgentsServer restarted and reconnected.')).not.toBeInTheDocument()
    })
  })

  it('keeps the success notice when restart adoption advances only the profile generation', async () => {
    installBridge()
    showSettings()
    useAppStore.setState({
      restartServer: vi.fn(async () => {
        useAppStore.setState({ profileGeneration: 8 })
        return true
      })
    })
    render(<SettingsDialog />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))

    const notice = await screen.findByText('AgentsServer restarted and reconnected.')
    await act(async () => { await Promise.resolve() })
    expect(notice).toBeInTheDocument()
  })

  it('keeps restart and server-update controls disabled while reconnecting', async () => {
    installBridge()
    showSettings()
    let resolveRestart!: (value: boolean) => void
    const restartServer = vi.fn(() => new Promise<boolean>(resolve => { resolveRestart = resolve }))
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Restarting…' })).toBeDisabled())
    openAppUpdates()
    expect(screen.getByRole('button', { name: 'Install or update AgentsServer', hidden: true })).toBeDisabled()
    await waitFor(() => expect(restartServer).toHaveBeenCalled())
    await act(async () => { resolveRestart(true) })
    expect(await screen.findByText('AgentsServer restarted and reconnected.')).toHaveAttribute('role', 'status')
  })

  it('surfaces an unconfirmed timeout in the health row', async () => {
    installBridge()
    showSettings()
    const restartServer = vi.fn(async () => {
      throw new Error('The restart request was not confirmed within 45 seconds. Check the server service before retrying.')
    })
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('restart request was not confirmed')
  })

  it('keeps safe restart as the default and requires a fresh status before showing destructive force confirmation', async () => {
    const snapshot = blockerSnapshot({
      active_count: 5_000_000,
      provider_background_count: 2,
      tmux_server_in_service_cgroup: true
    })
    const status = vi.fn().mockResolvedValue(restartStatus(snapshot))
    installBridge(vi.fn().mockResolvedValue(null), status)
    showSettings(restartHealth({
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
        server_updates: durableQueueCapability
      }
    }))
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))

    expect(screen.getByRole('dialog', { name: 'Restart AgentsServer?' })).toHaveTextContent('Safe restart will refuse to interrupt active work.')
    fireEvent.click(screen.getByRole('button', { name: 'Review force restart…' }))

    const forceDialog = await screen.findByRole('dialog', { name: 'Force restart AgentsServer?' })
    expect(status).toHaveBeenCalledWith({
      profileId: 'profile-1',
      profileGeneration: 7,
      serverIdentity: 'server-a'
    })
    expect(forceDialog).toHaveTextContent('“Production east”')
    expect(forceDialog).toHaveTextContent('authenticated server control endpoint is https://agents.example.test:7850')
    expect(forceDialog).toHaveTextContent('a Teamspace direct-IP route is not an out-of-band restart channel')
    expect(forceDialog).toHaveTextContent('Active turns, non-durable queued turns, terminals, tunnels, and any process inside agents-server.service may be terminated')
    expect(forceDialog).toHaveTextContent('Teamspace disconnects briefly. Saved chats and durable history remain.')
    expect(forceDialog).toHaveTextContent('1,000,000 active turns')
    expect(forceDialog).toHaveTextContent('2 provider background tasks')
    expect(forceDialog).toHaveTextContent('tmux server is inside agents-server.service; its sessions, terminals, tunnels, and loops may be terminated')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
  })

  it('sends an exact explicit force confirmation with the fresh blocker revision', async () => {
    const snapshot = blockerSnapshot({ active_count: 1 })
    installBridge(vi.fn().mockResolvedValue(null), vi.fn().mockResolvedValue(restartStatus(snapshot)))
    showSettings(restartHealth({
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
        server_updates: durableQueueCapability
      }
    }))
    const restartServer = vi.fn(async () => true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review force restart…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Force Restart' }))

    await waitFor(() => expect(restartServer).toHaveBeenCalledWith('boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: revisionA
    }))
    expect(await screen.findByText(/force restarted and reconnected/)).toHaveAttribute('role', 'status')
  })

  it('treats unknown tmux isolation as a displayed, revision-bound forceable risk', async () => {
    const snapshot = blockerSnapshot({ tmux_server_cgroup_unknown: true })
    const status = vi.fn().mockResolvedValue(restartStatus(snapshot))
    installBridge(vi.fn().mockResolvedValue(null), status)
    showSettings(restartHealth({
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
        server_updates: durableQueueCapability
      }
    }))
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    expect(screen.getByText('tmux server isolation could not be verified')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review force restart…' }))

    expect(await screen.findByRole('dialog', { name: 'Force restart AgentsServer?' })).toHaveTextContent('tmux server isolation could not be verified')
    expect(status).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Force Restart' })).toBeEnabled()
  })

  it('offers force confirmation only after an authoritative safe refusal can be reconciled to fresh blockers', async () => {
    const snapshot = blockerSnapshot({ restart_blocking_queued_count: 1 })
    installBridge(vi.fn().mockResolvedValue(null), vi.fn().mockResolvedValue(restartStatus(snapshot)))
    showSettings()
    const restartServer = vi.fn()
      .mockRejectedValueOnce(new Error('AgentsServer cannot restart while queued work remains active.'))
      .mockResolvedValueOnce(true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))

    const forceDialog = await screen.findByRole('dialog', { name: 'Force restart AgentsServer?' })
    expect(forceDialog).toHaveTextContent('1 non-durable queued turn')
    expect(restartServer).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Force Restart' })).toBeEnabled()
  })

  it('does not offer force after a safe refusal when fresh status also reports safety blockers', async () => {
    const snapshot = blockerSnapshot({ active_count: 1, deleting_session_count: 1 })
    installBridge(vi.fn().mockResolvedValue(null), vi.fn().mockResolvedValue(restartStatus(snapshot)))
    showSettings()
    useAppStore.setState({
      restartServer: vi.fn().mockRejectedValue(new Error('AgentsServer is busy.'))
    })
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))

    expect(await screen.findByText('1 session deletion')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Restart AgentsServer?' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review force restart…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Force Restart' })).not.toBeInTheDocument()
  })

  it('shows safety blockers without exposing a force-restart choice', async () => {
    const snapshot = blockerSnapshot({ active_count: 1, mutation_count: 2 })
    installBridge(vi.fn().mockResolvedValue(null), vi.fn().mockResolvedValue(restartStatus(snapshot)))
    showSettings(restartHealth({
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
        server_updates: durableQueueCapability
      }
    }))
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))

    expect(screen.getByText(/Force restart is unavailable while safety-critical server work is active/)).toHaveAttribute('role', 'alert')
    expect(screen.queryByRole('button', { name: 'Review force restart…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Force Restart' })).not.toBeInTheDocument()
  })

  it('offers Force Restart over safety-critical work when the server advertises the override', async () => {
    // beta.30+ servers report force_restart_available so an emergency restart
    // is never fenced by in-flight maintenance or mutations.
    const snapshot = blockerSnapshot({ mutation_count: 1, active_count: 1, force_restart_available: true })
    const status = vi.fn().mockResolvedValue(restartStatus(snapshot))
    installBridge(vi.fn().mockResolvedValue(null), status)
    showSettings(restartHealth({
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
        server_updates: durableQueueCapability
      }
    }))
    const restartServer = vi.fn().mockResolvedValue(true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))

    expect(screen.queryByText(/Force restart is unavailable while safety-critical server work is active/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review force restart…' }))

    const forceDialog = await screen.findByRole('dialog', { name: 'Force restart AgentsServer?' })
    expect(forceDialog).not.toHaveTextContent('cannot bypass safety-critical server work')
    expect(screen.getByRole('button', { name: 'Force Restart' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Force Restart' }))
    await waitFor(() => expect(restartServer).toHaveBeenCalledOnce())
    expect(restartServer).toHaveBeenCalledWith('boot-old', expect.objectContaining({
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: snapshot.revision
    }))
  })

  it('keeps Force Restart reachable when a wedged safe restart has no counted blockers', async () => {
    const snapshot = blockerSnapshot({ force_restart_available: true, snapshot_degraded: true })
    const status = vi.fn().mockResolvedValue(restartStatus(snapshot))
    installBridge(vi.fn().mockResolvedValue(null), status)
    showSettings(restartHealth({
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
        server_updates: durableQueueCapability
      }
    }))
    const restartServer = vi.fn()
      .mockRejectedValueOnce(new Error('AgentsServer safe restart could not acquire its admission lock.'))
      .mockResolvedValueOnce(true)
    useAppStore.setState({ restartServer })
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))

    const forceDialog = await screen.findByRole('dialog', { name: 'Force restart AgentsServer?' })
    expect(forceDialog).toHaveTextContent('blocker snapshot was degraded; some active work may not have been counted')
    expect(status).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Force Restart' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Force Restart' }))
    await waitFor(() => expect(restartServer).toHaveBeenCalledTimes(2))
    expect(restartServer).toHaveBeenLastCalledWith('boot-old', expect.objectContaining({
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: snapshot.revision
    }))
  })

  it('cancels a pending force inspection when the active profile scope changes', async () => {
    const snapshot = blockerSnapshot({ active_count: 1 })
    let resolveStatus!: (value: ServerRestartStatus) => void
    const pendingStatus = new Promise<ServerRestartStatus>(resolve => { resolveStatus = resolve })
    installBridge(vi.fn().mockResolvedValue(null), vi.fn(() => pendingStatus))
    showSettings(restartHealth({
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
        server_updates: durableQueueCapability
      }
    }))
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review force restart…' }))
    act(() => useAppStore.setState({ activeProfileId: 'profile-2', profileGeneration: 8 }))
    resolveStatus(restartStatus(snapshot))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /restart AgentsServer/i })).not.toBeInTheDocument())
  })

  it('refuses a blocker snapshot from a different server instance', async () => {
    const snapshot = blockerSnapshot({ active_count: 1 })
    const staleStatus = { ...restartStatus(snapshot), server_instance_id: 'boot-other' }
    installBridge(vi.fn().mockResolvedValue(null), vi.fn().mockResolvedValue(staleStatus))
    showSettings(restartHealth({
      capabilities: {
        server_restart: { ...serverRestartCapability, blocker_snapshot: snapshot },
        server_updates: durableQueueCapability
      }
    }))
    render(<SettingsDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review force restart…' }))

    expect(await screen.findByText(/changed while restart blockers were being checked/)).toHaveAttribute('role', 'alert')
    expect(screen.getByRole('dialog', { name: 'Restart AgentsServer?' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Force Restart' })).not.toBeInTheDocument()
  })
})
