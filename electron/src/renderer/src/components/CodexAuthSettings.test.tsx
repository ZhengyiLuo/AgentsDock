import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { CodexAuthStatus } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { CodexAuthSettings } from './CodexAuthSettings'

const snapshot = (auth_mode: CodexAuthStatus['auth_mode'] = 'none'): CodexAuthStatus => ({
  available: true, auth_mode, email: auth_mode === 'chatgpt' ? 'person@example.com' : null,
  plan_type: auth_mode === 'chatgpt' ? 'pro' : null, requires_openai_auth: true
})
function bridge(read = vi.fn().mockResolvedValue(snapshot()), write = vi.fn().mockResolvedValue(snapshot('apiKey'))) {
  Object.defineProperty(window, 'agentsDock', { configurable: true,
    value: { codex: { auth: read, loginWithApiKey: write } } as unknown as AgentsDockAPI })
  return { read, write }
}
const props = { connected: true, profileId: 'studio', profileGeneration: 1, serverTitle: 'Studio' }
async function openForm() {
  const open = screen.getByRole('button', { name: 'Use API key' })
  await waitFor(() => expect(open).toBeEnabled())
  fireEvent.click(open)
  return screen.getByLabelText('OpenAI API key') as HTMLInputElement
}
afterEach(() => { cleanup(); setLocale('en'); vi.restoreAllMocks(); vi.useRealTimers() })

describe('Codex account settings', () => {
  it('loads once, opens a masked form, and submits the key only on explicit sign-in', async () => {
    const { read, write } = bridge(vi.fn().mockResolvedValue(snapshot('chatgpt')))
    const persist = vi.spyOn(Storage.prototype, 'setItem')
    render(<CodexAuthSettings {...props} />)
    expect(screen.queryByLabelText('OpenAI API key')).not.toBeInTheDocument()
    await screen.findByText('ChatGPT · person@example.com · pro')
    expect(screen.getByText('Studio')).toBeInTheDocument()
    const input = await openForm()
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveFocus()
    expect(screen.getByText(/all Codex chats on this server/)).toBeInTheDocument()
    expect(screen.getByText(/billed separately from your ChatGPT subscription/)).toBeInTheDocument()
    expect(screen.getByText(/saved by Codex/)).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Sign in with API key' })
    expect(submit).toBeDisabled()
    fireEvent.change(input, { target: { value: '  sk-disposable-test-key  ' } })
    expect(read).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 })
    expect(write).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    fireEvent.click(submit)
    expect(input).toHaveValue('')
    await screen.findByText('API key saved in Codex. Billing and access are checked when you send a message.')
    expect(write).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 }, 'sk-disposable-test-key')
    expect(screen.getByText('API key')).toBeInTheDocument()
    expect(screen.queryByLabelText('OpenAI API key')).not.toBeInTheDocument()
    expect(read).toHaveBeenCalledOnce()
    expect(persist).not.toHaveBeenCalled()
    expect(await openForm()).toHaveValue('')
  })

  it('clears the key on cancel and unmount without signing in', async () => {
    const { write } = bridge()
    const { unmount } = render(<CodexAuthSettings {...props} />)
    const first = await openForm()
    fireEvent.change(first, { target: { value: 'sk-cancelled-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(first).toHaveValue('')
    const second = await openForm()
    expect(second).toHaveValue('')
    fireEvent.change(second, { target: { value: 'sk-unmounted-key' } })
    unmount()
    expect(second).toHaveValue('')
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps typing local and performs no idle polling or reads on unrelated rerenders', async () => {
    const { read, write } = bridge()
    const { rerender } = render(<CodexAuthSettings {...props} />)
    const input = await openForm()
    for (const value of ['s', 'sk', 'sk-', 'sk-local-key']) fireEvent.change(input, { target: { value } })
    expect(input).toHaveValue('sk-local-key')
    rerender(<CodexAuthSettings {...props} serverTitle="Renamed Studio" />)
    vi.useFakeTimers()
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(input).toHaveValue('sk-local-key')
    expect(read).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
    vi.useRealTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(input).toHaveValue('')
    expect(screen.queryByLabelText('OpenAI API key')).not.toBeInTheDocument()
  })

  it('disables duplicate submits and clears the field while a sign-in is pending', async () => {
    let resolveWrite: (value: CodexAuthStatus) => void = () => {}
    const { write } = bridge(undefined, vi.fn().mockImplementation(() => new Promise(resolve => { resolveWrite = resolve })))
    render(<CodexAuthSettings {...props} />)
    const input = await openForm()
    fireEvent.change(input, { target: { value: 'sk-pending-key' } })
    fireEvent.submit(input.closest('form')!)
    expect(input).toHaveValue('')
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Saving API key…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Recheck' })).toBeDisabled()
    fireEvent.submit(input.closest('form')!)
    expect(write).toHaveBeenCalledOnce()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await act(async () => resolveWrite(snapshot('apiKey')))
    expect(screen.getByRole('status')).toHaveTextContent('API key saved in Codex')
  })

  it('ignores a stale status response after switching servers', async () => {
    let resolveRead: (value: CodexAuthStatus) => void = () => {}
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }))
      .mockResolvedValue(snapshot('none'))
    bridge(read)
    const { rerender } = render(<CodexAuthSettings {...props} />)
    rerender(<CodexAuthSettings {...props} profileId="other" profileGeneration={2} />)
    await screen.findByText('Not signed in')
    await act(async () => resolveRead(snapshot('chatgpt')))
    expect(screen.queryByText(/person@example.com/)).not.toBeInTheDocument()
    expect(read).toHaveBeenLastCalledWith({ profileId: 'other', profileGeneration: 2 })
  })

  it.each(['profile', 'generation', 'offline'])('clears a draft when the %s changes', async change => {
    const { write } = bridge()
    const { rerender } = render(<CodexAuthSettings {...props} />)
    const input = await openForm()
    fireEvent.change(input, { target: { value: 'sk-old-profile-key' } })
    rerender(<CodexAuthSettings {...props}
      profileId={change === 'profile' ? 'other' : props.profileId}
      profileGeneration={change === 'generation' ? 2 : props.profileGeneration}
      connected={change !== 'offline'} />)
    expect(input).toHaveValue('')
    expect(screen.queryByLabelText('OpenAI API key')).not.toBeInTheDocument()
    expect(write).not.toHaveBeenCalled()
    if (change !== 'offline') expect(await openForm()).toHaveValue('')
  })

  it.each(['resolve', 'reject'])('ignores a late sign-in %s after a profile generation change', async completion => {
    let resolveWrite: (value: CodexAuthStatus) => void = () => {}
    let rejectWrite: (error: Error) => void = () => {}
    const read = vi.fn().mockResolvedValueOnce(snapshot('chatgpt')).mockResolvedValue(snapshot('none'))
    bridge(read, vi.fn().mockImplementation(() => new Promise((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject })))
    const { rerender } = render(<CodexAuthSettings {...props} />)
    const input = await openForm()
    fireEvent.change(input, { target: { value: 'sk-pending-key' } })
    fireEvent.submit(input.closest('form')!)
    rerender(<CodexAuthSettings {...props} profileGeneration={2} />)
    await screen.findByText('Not signed in')
    await act(async () => {
      if (completion === 'resolve') resolveWrite(snapshot('apiKey'))
      else rejectWrite(new Error('CODEX_AUTH_BUSY'))
    })
    expect(screen.getByText('Not signed in')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(await openForm()).toHaveValue('')
  })

  it.each([
    ['CODEX_AUTH_UPDATE', /Update AgentsDock and AgentsServer/],
    ['403 Forbidden', /connection permission issue, not an API key check/],
    ['CODEX_AUTH_CONNECTION', /Could not reach the server/],
    ['Unexpected sk-private-provider-echo', /Could not check the Codex account/]
  ])('explains read failure safely: %s', async (message, expected) => {
    bridge(vi.fn().mockRejectedValue(new Error(message)))
    render(<CodexAuthSettings {...props} />)
    await screen.findByText(expected)
    expect(screen.getByRole('button', { name: 'Use API key' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Recheck' })).toBeEnabled()
    expect(document.body.textContent).not.toContain('sk-private-provider-echo')
  })

  it.each([
    ['CODEX_AUTH_BUSY', /Running work was not interrupted/],
    ['CODEX_AUTH_INVALID_KEY', /API key format was not accepted/],
    ['Unexpected sk-secret-provider-echo', /Could not confirm the Codex account change/]
  ])('clears the key and offers retry after sign-in failure: %s', async (message, expected) => {
    bridge(undefined, vi.fn().mockRejectedValue(new Error(message)))
    render(<CodexAuthSettings {...props} />)
    const input = await openForm()
    fireEvent.change(input, { target: { value: 'sk-secret-provider-echo' } })
    fireEvent.submit(input.closest('form')!)
    await screen.findByText(expected)
    expect(input).toHaveValue('')
    expect(input).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Sign in with API key' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Recheck' })).toBeEnabled()
    expect(document.body.textContent).not.toContain('sk-secret-provider-echo')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('does not claim success when the returned native account is not using the API key', async () => {
    bridge(undefined, vi.fn().mockResolvedValue(snapshot('none')))
    render(<CodexAuthSettings {...props} />)
    const input = await openForm()
    fireEvent.change(input, { target: { value: 'sk-unconfirmed-key' } })
    fireEvent.submit(input.closest('form')!)
    await screen.findByText(/Could not confirm the Codex account change/)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('explains native runtime unavailability and a missing desktop bridge', async () => {
    bridge(vi.fn().mockResolvedValue({ ...snapshot(), available: false, message: 'sk-hidden-message' }))
    const first = render(<CodexAuthSettings {...props} />)
    await screen.findByText('API key sign-in requires native Codex on this server.')
    expect(screen.getByRole('button', { name: 'Use API key' })).toBeDisabled()
    expect(document.body.textContent).not.toContain('sk-hidden-message')
    first.unmount()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { codex: {} } })
    render(<CodexAuthSettings {...props} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Update AgentsDock and AgentsServer')
  })

  it('makes no request offline and localizes the form and server-wide disclosure', async () => {
    setLocale('zh-CN')
    const { read, write } = bridge()
    const { rerender } = render(<CodexAuthSettings {...props} connected={false} />)
    expect(screen.getByRole('region', { name: 'Codex 账户' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '使用 API 密钥' })).toBeDisabled()
    expect(read).not.toHaveBeenCalled()
    rerender(<CodexAuthSettings {...props} />)
    const open = screen.getByRole('button', { name: '使用 API 密钥' })
    await waitFor(() => expect(open).toBeEnabled())
    fireEvent.click(open)
    expect(screen.getByLabelText('OpenAI API 密钥')).toHaveAttribute('type', 'password')
    expect(screen.getByText(/此服务器上所有 Codex 对话使用的账户/)).toBeInTheDocument()
    expect(screen.getByText(/与 ChatGPT 订阅分开计费/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '使用 API 密钥登录' })).toBeDisabled()
    expect(write).not.toHaveBeenCalled()
  })
})
