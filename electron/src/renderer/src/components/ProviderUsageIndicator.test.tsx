import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '@shared/i18n'
import type { ProviderUsageSnapshot } from '@shared/provider-usage'
import type { Health, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { ProviderUsageIndicator } from './ProviderUsageIndicator'

const chat = { id: 'chat-a', backend: 'codex', codex_provider: 'default' } as Session
const snapshot: ProviderUsageSnapshot = {
  backend: 'codex', status: 'available', source: 'codex-account', account_kind: 'chatgpt',
  observed_at: '2026-09-24T12:00:00Z',
  windows: [{ id: 'primary', label: '5 hours', used_percent: 25, resets_at: 1790254800,
    window_minutes: 300, observed_at: '2026-09-24T12:00:00Z' }],
  credits: { balance: '124.5', has_credits: true, unlimited: false }
}
const scope = { profileId: 'server-a', profileGeneration: 3, serverIdentity: 'identity-a' }

function fixture(value: ProviderUsageSnapshot = snapshot) {
  const listeners = new Map<string, (value: any) => void>()
  const usage = vi.fn().mockResolvedValue(value)
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    runtime: { usage }, events: { on: vi.fn((key, fn) => { listeners.set(key, fn); return () => listeners.delete(key) }) }
  } })
  useAppStore.setState({ activeProfileId: scope.profileId, profileGeneration: scope.profileGeneration, connected: true,
    health: { server_identity: scope.serverIdentity, server_instance_id: 'instance-a',
      capabilities: { provider_usage: { available: true, version: 1 } } } as Health })
  return { usage, listeners }
}

afterEach(() => { cleanup(); setLocale('en'); vi.useRealTimers(); Reflect.deleteProperty(window, 'agentsDock') })

describe('provider account usage', () => {
  it('shows remaining allowance and credits, refreshes on opening, and makes no request while typing elsewhere', async () => {
    const { usage } = fixture()
    const view = render(<><input aria-label="Main message" /><ProviderUsageIndicator session={chat} /></>)
    const button = await screen.findByRole('button', { name: 'Account usage: 75% left' })
    expect(usage).toHaveBeenCalledExactlyOnceWith(scope, 'codex', 'chat-a', false)
    fireEvent.click(button)
    expect(await screen.findByText('124.5')).toBeVisible()
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '75')
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(2))
    expect(usage).toHaveBeenLastCalledWith(scope, 'codex', 'chat-a', true)
    fireEvent.change(screen.getByLabelText('Main message'), { target: { value: 'Keep typing' } })
    view.rerender(<><input aria-label="Main message" /><ProviderUsageIndicator session={{ ...chat }} /></>)
    expect(usage).toHaveBeenCalledTimes(2)
  })

  it('does not show fabricated quota for unavailable custom API endpoints or older servers', async () => {
    const { usage } = fixture({ ...snapshot, status: 'unavailable', account_kind: 'custom', windows: [], credits: undefined })
    render(<ProviderUsageIndicator session={{ ...chat, codex_provider: 'custom' }} />)
    await waitFor(() => expect(usage).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    act(() => useAppStore.setState({ health: { capabilities: {} } as Health }))
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(usage).toHaveBeenCalledOnce()
  })

  it('drops a late response from another server before displaying quota', async () => {
    const { usage } = fixture()
    let finish!: (value: ProviderUsageSnapshot) => void
    usage.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    render(<ProviderUsageIndicator session={chat} />)
    act(() => useAppStore.setState({ activeProfileId: 'server-b', profileGeneration: 4,
      health: { server_identity: 'identity-b', server_instance_id: 'instance-b', capabilities: { provider_usage: { available: true, version: 1 } } } as Health }))
    await screen.findByRole('button', { name: 'Account usage: 75% left' })
    await act(async () => finish({ ...snapshot, windows: [{ ...snapshot.windows[0], used_percent: 99 }] }))
    expect(screen.queryByRole('button', { name: 'Account usage: 1% left' })).not.toBeInTheDocument()
    expect(usage).toHaveBeenLastCalledWith({ profileId: 'server-b', profileGeneration: 4, serverIdentity: 'identity-b' }, 'codex', 'chat-a', false)
  })

  it('refreshes only on a matching usage notice and coalesces concurrent notices', async () => {
    const { usage, listeners } = fixture()
    render(<ProviderUsageIndicator session={chat} />)
    await screen.findByRole('button')
    act(() => listeners.get('provider-usage:changed')!({ ...scope, sessionId: 'different', backend: 'codex' }))
    expect(usage).toHaveBeenCalledOnce()
    let finish!: (value: ProviderUsageSnapshot) => void
    usage.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    act(() => {
      for (let count = 0; count < 4; count++) listeners.get('provider-usage:changed')!({ ...scope, sessionId: chat.id, backend: 'codex' })
    })
    expect(usage).toHaveBeenCalledTimes(2)
    await act(async () => finish(snapshot))
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(3))
    expect(usage).toHaveBeenLastCalledWith(scope, 'codex', 'chat-a', false)
  })

  it('labels partial Claude observations without turning a missing percentage into zero', async () => {
    fixture({ ...snapshot, backend: 'claude', source: 'claude-events', account_kind: 'subscription', credits: undefined,
      windows: [{ ...snapshot.windows[0], label: 'Weekly', used_percent: null, status: 'rejected' }] })
    render(<ProviderUsageIndicator session={{ ...chat, backend: 'claude' }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Account usage: Limit reached' }))
    expect(await screen.findAllByText('Limit reached')).toHaveLength(2)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByText(/other windows may not have been reported/)).toBeVisible()
  })

  it('prioritizes a reported reached limit over remaining allowance in another window', async () => {
    fixture({ ...snapshot, backend: 'claude', source: 'claude-events', credits: undefined,
      windows: [snapshot.windows[0], { ...snapshot.windows[0], id: 'seven_day', window_minutes: 10080,
        label: null, used_percent: null, status: 'rejected' }] })
    render(<ProviderUsageIndicator session={{ ...chat, backend: 'claude' }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Account usage: Limit reached' }))
    expect(screen.getByText('75% left')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Account usage: 75% left' })).not.toBeInTheDocument()
  })

  it('keeps the last observation clearly labelled on offline and refresh failure', async () => {
    const { usage } = fixture()
    render(<ProviderUsageIndicator session={chat} />)
    const button = await screen.findByRole('button')
    usage.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(button)
    expect(await screen.findByText('Could not refresh. Showing the last report.')).toBeVisible()
    act(() => useAppStore.setState({ connected: false }))
    expect(screen.getByText('Offline — showing the last report.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Refresh usage' })).toBeDisabled()
  })
})
