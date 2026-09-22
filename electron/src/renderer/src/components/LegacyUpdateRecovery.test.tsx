import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateStatus, CoordinatedServerUpdate } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { AppSettingsDialog } from './Dialogs'

const command = 'npx @agentsdock/server@1.0.5 recover'
const failed: CoordinatedServerUpdate = {
  profileId: 'remote-server', name: 'Studio', serverIdentity: 'identity-studio',
  targetVersion: '1.0.5', phase: 'blocked', paused: true,
  message: 'HTTP 503: the previous server update could not be safely finalized'
}

function show(update: CoordinatedServerUpdate) {
  const status: AppUpdateStatus = { state: 'not-available', channel: 'direct', track: 'stable',
    currentVersion: '1.0.5', serverUpdates: [update] }
  const writeClipboard = vi.fn().mockResolvedValue(undefined)
  const retryServers = vi.fn().mockResolvedValue({ ...status,
    serverUpdates: [{ ...update, phase: 'current', paused: false, message: 'Up to date' }] })
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    updates: { status: vi.fn().mockResolvedValue(status), check: vi.fn().mockResolvedValue(status), retryServers },
    native: { writeClipboard }, events: { on: vi.fn().mockReturnValue(() => undefined) }
  } })
  useAppStore.setState(state => ({ profiles: [], activeProfileId: 'another-server', health: null,
    modals: { ...state.modals, appSettings: true, settings: false } }))
  render(<AppSettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: 'Updates' }))
  return { writeClipboard, retryServers }
}

afterEach(() => { cleanup(); window.localStorage.clear(); Reflect.deleteProperty(window, 'agentsDock') })

describe('failed 1.0.4 server recovery in Settings', () => {
  it.each([
    failed,
    { ...failed, phase: 'updating' as const, paused: false, operationTargetVersion: '1.0.4', message: 'Installing AgentsServer 1.0.4 (10s elapsed).' }
  ])('copies the pinned repair command and retries only the affected remote profile ($phase)', async update => {
    const { writeClipboard, retryServers } = show(update)
    expect(await screen.findByText(command)).toBeVisible()
    expect(screen.getByText(/computer hosting Studio/)).toBeVisible()
    expect(writeClipboard).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Copy recovery command' }))
    expect(writeClipboard).toHaveBeenCalledWith(command)
    fireEvent.click(screen.getByRole('button', { name: 'Retry server update' }))
    await waitFor(() => expect(screen.queryByText(command)).not.toBeInTheDocument())
    expect(retryServers).toHaveBeenCalledExactlyOnceWith('remote-server')
  })

  it.each([
    { ...failed, phase: 'current' as const },
    { ...failed, message: 'Unable to connect to server' },
    { ...failed, targetVersion: '1.0.4' },
    { ...failed, targetVersion: '1.0.5; touch /tmp/invalid' },
    { ...failed, phase: 'updating' as const, operationTargetVersion: '1.0.5', message: 'Installing' }
  ])('does not offer the repair for unrelated or untrusted state %#', async update => {
    show(update)
    await screen.findByText(update.message)
    expect(screen.queryByText(command)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy recovery command' })).not.toBeInTheDocument()
  })
})
