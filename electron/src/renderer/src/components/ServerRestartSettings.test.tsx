import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { AppUpdateStatus, Health, ServerRestartStatus } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { SettingsDialog } from './Dialogs'

const originalRestartServer = useAppStore.getState().restartServer

const restartStatus: ServerRestartStatus = {
  phase: 'idle', server_identity: 'server-a', server_instance_id: 'boot-old',
  message: 'AgentsServer is ready.',
  blocker_snapshot: {
    version: 2, revision: 'a'.repeat(64), active_count: 0,
    restart_blocking_queued_count: 0, provider_background_count: 0,
    tmux_server_in_service_cgroup: false, tmux_server_cgroup_unknown: false,
    server_maintenance_count: 0, mutation_count: 0, deleting_session_count: 0,
    codex_goals_reconfiguring: false, has_forceable_blockers: false,
    has_safety_blockers: false, has_blockers: false
  }
}

function showSettings(healthOverrides: Partial<Health> = {}, appStatus: Partial<AppUpdateStatus> = {}) {
  const health: Health = {
    ok: true, managed_updates: true, server_identity: 'server-a',
    server_instance_id: 'boot-old', server_version: '1.0.11-beta.10',
    capabilities: {
      server_restart: {
        version: 2, available: true, required: false, message: 'Managed restart is available.',
        action: null, force_restart: true, force_confirmation_required: true,
        blocker_snapshot: restartStatus.blocker_snapshot
      },
      server_updates: { version: 12, available: true, required: false, message: 'Managed updates are available.', action: null }
    },
    ...healthOverrides
  }
  const update: AppUpdateStatus = {
    state: 'not-available', channel: 'direct', track: 'beta',
    currentVersion: '1.0.11-beta.10', serverUpdates: [], ...appStatus
  }
  const serverUpdateStatus = vi.fn().mockResolvedValue({ phase: 'current',
    current_version: '1.0.11-beta.10', track: 'beta',
    server_identity: 'server-a', server_instance_id: 'boot-old' })
  const serverUpdateCheck = vi.fn()
  const serverUpdateStart = vi.fn()
  const restartServer = vi.fn(async () => true)
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    serverUpdates: { status: serverUpdateStatus, check: serverUpdateCheck, start: serverUpdateStart, cancel: vi.fn() },
    servers: {
      tokenPreview: vi.fn().mockResolvedValue('test••••••••'),
      restartStatus: vi.fn().mockResolvedValue(restartStatus),
      refresh: vi.fn().mockResolvedValue({ activeProfileId: 'profile-1', profileGeneration: 7,
        profiles: [{ id: 'profile-1', name: 'Test server', serverUrl: 'http://127.0.0.1:7851', serverIdentity: 'server-a' }],
        health: { ...health, server_instance_id: 'boot-new' } })
    },
    updates: { status: vi.fn().mockResolvedValue(update), check: vi.fn().mockResolvedValue(update),
      install: vi.fn(), setTrack: vi.fn() },
    events: { on: vi.fn().mockReturnValue(() => undefined) }
  } as unknown as AgentsDockAPI })
  useAppStore.setState(state => ({
    connected: true, health, profiles: [{ id: 'profile-1', name: 'Test server',
      serverUrl: 'http://127.0.0.1:7851', serverIdentity: 'server-a', hasAccessToken: true,
      serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 }],
    activeProfileId: 'profile-1', profileGeneration: 7, switchingProfileId: null,
    restartServer, error: null,
    modals: { ...state.modals, settings: true, appSettings: false }
  }))
  render(<SettingsDialog />)
  const toggle = screen.queryByRole('button', { name: 'Server details for Test server' })
  if (toggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
  return { restartServer, serverUpdateStatus, serverUpdateCheck, serverUpdateStart }
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  Reflect.deleteProperty(window, 'agentsDock')
  useAppStore.setState(state => ({ restartServer: originalRestartServer,
    modals: { ...state.modals, settings: false, appSettings: false } }))
})

describe('unified product updates and server restart', () => {
  it('keeps safe restart in Server settings without exposing a standalone server updater', async () => {
    const { restartServer, serverUpdateStatus, serverUpdateCheck, serverUpdateStart } = showSettings()
    expect(screen.getByRole('button', { name: 'Restart server' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Server update channel' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Restart server' }))
    const confirmation = screen.getByRole('dialog', { name: 'Restart AgentsServer?' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Restart server' }))
    await waitFor(() => expect(restartServer).toHaveBeenCalledExactlyOnceWith('boot-old'))
    expect(serverUpdateCheck).not.toHaveBeenCalled()
    expect(serverUpdateStart).not.toHaveBeenCalled()
    expect(serverUpdateStatus).toHaveBeenCalledOnce()
  })

  it('shows the product channel and status in Updates, with no server update action', async () => {
    const { serverUpdateCheck, serverUpdateStart } = showSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Updates' }))
    await screen.findByText('v1.0.11-beta.10')
    expect(screen.getByRole('group', { name: 'App update channel' })).toBeInTheDocument()
    expect(screen.getByText('AgentsServer 1.0.11-beta.10')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Server update channel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check server' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument()
    expect(serverUpdateCheck).not.toHaveBeenCalled()
    expect(serverUpdateStart).not.toHaveBeenCalled()
  })

  it('keeps one product retry for an incomplete paired update', async () => {
    showSettings({}, { serverUpdates: [{ profileId: 'profile-1', name: 'Test server',
      serverIdentity: 'server-a', targetVersion: '1.0.11-beta.11',
      phase: 'failed', paused: true, message: 'Update failed' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Updates' }))
    expect(await screen.findByRole('button', { name: 'Retry AgentsDock update' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Retry server update' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Server update channel' })).not.toBeInTheDocument()
  })
})
