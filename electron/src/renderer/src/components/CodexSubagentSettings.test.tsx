import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { CodexSubagentsConfiguration } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { CodexSubagentSettings } from './CodexSubagentSettings'

const snapshot = (limit: number | null): CodexSubagentsConfiguration => ({
  configurable: true, max_concurrent_threads_per_session: limit, message: 'Saved',
  applies_to: 'new_or_reloaded_threads', scope: 'server'
})
function bridge(read = vi.fn().mockResolvedValue(snapshot(null)), write = vi.fn().mockImplementation(async (_scope, limit) => snapshot(limit))) {
  Object.defineProperty(window, 'agentsDock', { configurable: true,
    value: { codex: { serverSubagents: read, setServerSubagents: write } } as unknown as AgentsDockAPI })
  return { read, write }
}
const props = { connected: true, profileId: 'studio', profileGeneration: 1 }
afterEach(() => { cleanup(); setLocale('en'); vi.useRealTimers() })

describe('Codex subagent settings', () => {
  it('loads once, keeps typing local and saves only on explicit submit', async () => {
    const { read, write } = bridge()
    render(<CodexSubagentSettings {...props} />)
    const input = screen.getByRole('textbox', { name: 'Codex subagent limit' })
    await waitFor(() => expect(input).toBeEnabled())
    expect(input).toHaveValue('')
    expect(screen.getByText(/Codex default—not unlimited/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(input, { target: { value: '32' } })
    expect(write).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved. Running agents were not changed.')
    expect(write).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 }, 32)
    expect(read).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 })
    expect(input).toHaveValue('32')
    expect(screen.getByText(/Reload provider when idle/)).toBeInTheDocument()
  })

  it('clears the override with null, never zero or a fabricated unlimited value', async () => {
    const { write } = bridge(vi.fn().mockResolvedValue(snapshot(4)))
    render(<CodexSubagentSettings {...props} />)
    const input = await screen.findByDisplayValue('4')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 }, null))
  })

  it.each(['0', '-1', '2.5', 'no', '9007199254740992'])('rejects invalid limit %s without an API write', async value => {
    const { write } = bridge()
    render(<CodexSubagentSettings {...props} />)
    const input = screen.getByRole('textbox')
    await waitFor(() => expect(input).toBeEnabled())
    fireEvent.change(input, { target: { value } })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(write).not.toHaveBeenCalled()
  })

  it('waits for save acknowledgment and retains the draft on a write failure', async () => {
    let reject: (error: Error) => void = () => {}
    bridge(undefined, vi.fn().mockImplementation(() => new Promise((_resolve, fail) => { reject = fail })))
    render(<CodexSubagentSettings {...props} />)
    const input = screen.getByRole('textbox')
    await waitFor(() => expect(input).toBeEnabled())
    fireEvent.change(input, { target: { value: '16' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(input).toBeDisabled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await act(async () => reject(new Error('Disk full')))
    expect(screen.getByRole('alert')).toHaveTextContent('Disk full')
    expect(input).toHaveValue('16')
    expect(input).toBeEnabled()
  })

  it('ignores stale read and save responses when switching servers', async () => {
    let resolveRead: (value: CodexSubagentsConfiguration) => void = () => {}
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }))
      .mockResolvedValue(snapshot(12))
    let resolveWrite: (value: CodexSubagentsConfiguration) => void = () => {}
    bridge(read, vi.fn().mockImplementation(() => new Promise(resolve => { resolveWrite = resolve })))
    const { rerender } = render(<CodexSubagentSettings {...props} />)
    rerender(<CodexSubagentSettings {...props} profileId="sonic" profileGeneration={2} />)
    const input = await screen.findByDisplayValue('12')
    await act(async () => resolveRead(snapshot(4)))
    expect(input).toHaveValue('12')
    fireEvent.change(input, { target: { value: '24' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    rerender(<CodexSubagentSettings {...props} profileId="third" profileGeneration={3} />)
    await screen.findByDisplayValue('12')
    await act(async () => resolveWrite(snapshot(24)))
    expect(input).toHaveValue('12')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it.each([
    ['404 Not Found', 'Update AgentsServer to change this setting.'],
    ['403 Forbidden', 'Connect as the server administrator to change this setting.']
  ])('explains unavailable settings: %s', async (error, text) => {
    bridge(vi.fn().mockRejectedValue(new Error(error)))
    render(<CodexSubagentSettings {...props} />)
    await screen.findByText(text)
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.queryByText(/Codex default—not unlimited/)).not.toBeInTheDocument()
  })

  it('shows unsupported-provider response without pretending the user lacks admin rights', async () => {
    bridge(vi.fn().mockResolvedValue({ ...snapshot(null), configurable: false, message: 'Requires native Codex transport.' }))
    render(<CodexSubagentSettings {...props} />)
    await screen.findByText('Requires native Codex transport.')
    expect(screen.getByRole('textbox')).toBeDisabled()
  })

  it('does not poll after loading or write while idle', async () => {
    const { read, write } = bridge()
    render(<CodexSubagentSettings {...props} />)
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
    vi.useFakeTimers()
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(read).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
  })

  it('makes no request offline and translates the setting', () => {
    setLocale('zh-CN')
    const { read } = bridge()
    render(<CodexSubagentSettings {...props} connected={false} />)
    expect(screen.getByRole('textbox', { name: 'Codex 子代理数量上限' })).toBeDisabled()
    expect(read).not.toHaveBeenCalled()
  })
})
