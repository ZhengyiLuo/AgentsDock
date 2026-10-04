import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateStatus, CoordinatedServerUpdate } from '@shared/types'
import { setLocale, t } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { AppSettingsDialog } from './Dialogs'

const failed: CoordinatedServerUpdate = {
  profileId: 'remote-server', name: 'Studio', serverIdentity: 'identity-studio',
  targetVersion: '1.0.5', phase: 'blocked', paused: true,
  message: 'HTTP 503: the previous server update could not be safely finalized'
}

function show(update: CoordinatedServerUpdate, retryResult?: Promise<AppUpdateStatus>) {
  const status: AppUpdateStatus = { state: 'not-available', channel: 'direct', track: 'stable',
    currentVersion: '1.0.5', serverUpdates: [update] }
  const retryServers = vi.fn().mockReturnValue(retryResult ?? Promise.resolve({ ...status,
    serverUpdates: [{ ...update, phase: 'current', paused: false, message: 'Up to date' }] }))
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    updates: { status: vi.fn().mockResolvedValue(status), check: vi.fn().mockResolvedValue(status), retryServers },
    events: { on: vi.fn().mockReturnValue(() => undefined) }
  } })
  useAppStore.setState(state => ({ profiles: [], activeProfileId: 'another-server', health: null, error: null,
    modals: { ...state.modals, appSettings: true, settings: false } }))
  render(<AppSettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: t('settings.updates') }))
  return { retryServers }
}

afterEach(() => { cleanup(); setLocale('en'); window.localStorage.clear(); Reflect.deleteProperty(window, 'agentsDock') })

describe('paired server recovery in Settings', () => {
  it.each(['failed', 'blocked', 'offline'] as const)('retries an unpaused %s row using its own remote profile', async phase => {
    const { retryServers } = show({ ...failed, phase, paused: false })
    const retry = await screen.findByRole('button', { name: 'Retry server update' })
    expect(screen.queryByText(/npx @agentsdock\/server/)).not.toBeInTheDocument()
    expect(screen.queryByText('Advanced server recovery')).not.toBeInTheDocument()
    fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry server update' })).not.toBeInTheDocument())
    expect(retryServers).toHaveBeenCalledExactlyOnceWith('remote-server')
  })

  it('keeps a retry in flight singular and usable after a failed request', async () => {
    let reject!: (error: Error) => void
    const pending = new Promise<AppUpdateStatus>((_, fail) => { reject = fail })
    const { retryServers } = show(failed, pending)
    const retry = await screen.findByRole('button', { name: 'Retry server update' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(retryServers).toHaveBeenCalledTimes(1)
    expect(retry).toBeDisabled()
    await act(async () => reject(new Error('Connection lost')))
    expect(retry).toBeEnabled()
    expect(useAppStore.getState().error).toBe('Connection lost')
  })

  it.each([
    'HTTP Error 429',
    'signed release check failed: HTTP Error 429: Too Many Requests',
    'GitHub temporarily limited update requests. Your server is still running.'
  ])('explains a release-service rate limit and keeps its original error in optional details: %s', async raw => {
    show({ ...failed, message: raw })
    expect(await screen.findByText('GitHub is limiting update requests. Try again shortly.')).toBeVisible()
    expect(screen.getByText(raw)).not.toBeVisible()
    fireEvent.click(screen.getByText('Error details'))
    expect(screen.getByText(raw)).toBeVisible()
  })

  it('localizes recovery and error details in Chinese', async () => {
    setLocale('zh-CN')
    show(failed)
    expect(await screen.findByText('Studio 上的上一次更新未完成，请重试以恢复。')).toBeVisible()
    expect(screen.getByRole('button', { name: '重试服务器更新' })).toBeEnabled()
    expect(screen.getByText('错误详情')).toBeVisible()
  })

  it.each([
    ['Authentication denied', 'Reconnect to Studio and sign in again to update it.'],
    ["ENOSPC: no space left on device, open '/private/server/update.tgz'", "The server's disk is full. Free up space, then retry."],
    ["EACCES: permission denied, open '/private/server/update.tgz'", 'The server cannot access its update files. Check their permissions, then retry.'],
    ['Server update channel differs from this app release. Its channel was preserved.', 'This older server rejected a switch between Stable and Beta releases. The app can still update. Retry this server afterward.'],
    ['The signed server release descriptor is invalid. Download the application release again.', 'The app’s server update files could not be verified. Download AgentsDock again, then retry.'],
    ['Paired server release signature is invalid.', 'The app’s server update files could not be verified. Download AgentsDock again, then retry.']
  ])('shows a concrete explanation for %s', async (raw, explanation) => {
    show({ ...failed, message: raw })
    expect(await screen.findByText(explanation)).toBeVisible()
    expect(screen.getByText(raw)).not.toBeVisible()
  })

  it('keeps an already readable installation failure visible', async () => {
    const message = 'The package download stopped after the connection was lost. Retry the server update.'
    show({ ...failed, message })
    expect(await screen.findByText(message)).toBeVisible()
    expect(screen.queryByText('Error details')).not.toBeInTheDocument()
  })

  it('preserves a server-reported retry delay instead of replacing it with a vague wait', async () => {
    const message = 'GitHub temporarily limited update requests. Try again in 2349 seconds. Your server is still running.'
    show({ ...failed, message })
    expect(await screen.findByText(message)).toBeVisible()
    expect(screen.queryByText('Error details')).not.toBeInTheDocument()
  })

  it('names the offline server in its reconnect instruction', async () => {
    show({ ...failed, phase: 'offline', message: 'connect ECONNREFUSED 127.0.0.1' })
    expect(await screen.findByText('Cannot connect to Studio. Reconnect, then retry its update.')).toBeVisible()
  })

  it.each(['checking', 'pending', 'updating', 'current'] as const)('does not offer competing recovery controls during %s', async phase => {
    show({ ...failed, phase, paused: false, message: 'Working normally' })
    await screen.findByText('Working normally')
    expect(screen.queryByRole('button', { name: 'Retry server update' })).not.toBeInTheDocument()
    expect(screen.queryByText('Error details')).not.toBeInTheDocument()
  })
})
