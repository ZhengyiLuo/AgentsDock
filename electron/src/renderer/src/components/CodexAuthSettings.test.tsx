import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { CodexAuthStatus, CodexProviderConfiguration, CodexProviderTestResult } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { CodexAuthSettings } from './CodexAuthSettings'

const snapshot = (auth_mode: CodexAuthStatus['auth_mode'] = 'none'): CodexAuthStatus => ({
  available: true, auth_mode, email: auth_mode === 'chatgpt' ? 'person@example.com' : null,
  plan_type: auth_mode === 'chatgpt' ? 'pro' : null, requires_openai_auth: true
})
const providerSnapshot = (configured = false): CodexProviderConfiguration => ({
  available: true, configured, base_url: configured ? 'https://inference.example/v1' : null,
  model: configured ? 'gpt-6-astra' : null, has_api_key: configured, wire_api: 'responses'
})
const readyResult: CodexProviderTestResult = { ok: true, status: 'ready', message: 'Unused provider response' }
function bridge(read = vi.fn().mockResolvedValue(snapshot()), write = vi.fn().mockResolvedValue(snapshot('apiKey')), overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const provider = {
    provider: vi.fn().mockResolvedValue(providerSnapshot()),
    testProvider: vi.fn().mockResolvedValue(readyResult),
    setProvider: vi.fn().mockResolvedValue(providerSnapshot(true)),
    resetProvider: vi.fn().mockResolvedValue(providerSnapshot()), ...overrides
  }
  Object.defineProperty(window, 'agentsDock', { configurable: true,
    value: { codex: { auth: read, loginWithApiKey: write, ...provider } } as unknown as AgentsDockAPI })
  return { read, write, ...provider }
}
const props = { connected: true, profileId: 'studio', profileGeneration: 1, serverTitle: 'Studio' }
async function openForm() {
  const open = screen.getByRole('button', { name: 'Use API key' })
  await waitFor(() => expect(open).toBeEnabled())
  fireEvent.click(open)
  const input = screen.getByLabelText('OpenAI API key') as HTMLInputElement
  await waitFor(() => expect(input).toBeEnabled())
  return input
}
async function openCustomForm() {
  await openForm()
  fireEvent.click(screen.getByRole('button', { name: 'Custom endpoint' }))
  const key = screen.getByLabelText('API key for this endpoint') as HTMLInputElement
  await waitFor(() => expect(key).toBeEnabled())
  return { key, endpoint: screen.getByLabelText('Endpoint base URL'), model: screen.getByLabelText('Model ID') }
}
function fillProvider(fields: Awaited<ReturnType<typeof openCustomForm>>) {
  fireEvent.change(fields.endpoint, { target: { value: 'https://inference.example/v1' } })
  fireEvent.change(fields.model, { target: { value: 'gpt-6-astra' } })
  fireEvent.change(fields.key, { target: { value: 'synthetic-provider-key' } })
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
    expect(screen.getByText(/normal Codex chats on this server/)).toBeInTheDocument()
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
    if (message.startsWith('Unexpected')) expect(screen.getByRole('button', { name: 'Endpoint settings' })).toBeEnabled()
    else expect(screen.getByRole('button', { name: 'Use API key' })).toBeDisabled()
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
    expect(screen.getByText(/此服务器上普通 Codex 对话使用的账户/)).toBeInTheDocument()
    expect(screen.getByText(/与 ChatGPT 订阅分开计费/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '使用 API 密钥登录' })).toBeDisabled()
    expect(write).not.toHaveBeenCalled()
  })
})

describe('Codex custom endpoint settings', () => {
  it('clears the OpenAI key when switching to a custom endpoint', async () => {
    const api = bridge()
    render(<CodexAuthSettings {...props} />)
    const input = await openForm()
    fireEvent.change(input, { target: { value: 'synthetic-openai-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Custom endpoint' }))
    expect(screen.getByLabelText('API key for this endpoint')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled()
    expect(api.testProvider).not.toHaveBeenCalled()
    expect(api.write).not.toHaveBeenCalled()
    expect(api.provider).toHaveBeenCalledOnce()
  })

  it('ignores provider metadata after a profile change and does not enable default sign-in while loading', async () => {
    let resolve: (value: CodexProviderConfiguration) => void = () => {}
    bridge(undefined, undefined, { provider: vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue(providerSnapshot()) })
    const { rerender } = render(<CodexAuthSettings {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use API key' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Use API key' }))
    expect(screen.getByLabelText('OpenAI API key')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Sign in with API key' })).toBeDisabled()
    rerender(<CodexAuthSettings {...props} profileId="other" profileGeneration={2} />)
    await openForm()
    await act(async () => resolve(providerSnapshot(true)))
    expect(screen.getByLabelText('OpenAI API key')).toBeEnabled()
    expect(screen.queryByLabelText('Endpoint base URL')).not.toBeInTheDocument()
    expect(screen.queryByText('Custom endpoint · gpt-6-astra')).not.toBeInTheDocument()
  })

  it('tests exact endpoint/model/key without saving, then saves only after a successful current test', async () => {
    const api = bridge()
    const persist = vi.spyOn(Storage.prototype, 'setItem')
    render(<CodexAuthSettings {...props} />)
    expect(api.provider).not.toHaveBeenCalled()
    const fields = await openCustomForm()
    expect(api.provider).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 })
    expect(fields.endpoint).toHaveValue('https://api.openai.com/v1')
    expect(fields.key).toHaveAttribute('type', 'password')
    expect(screen.getByText(/may incur a small API charge/)).toBeInTheDocument()
    expect(screen.getByText(/Native Codex · Responses API required/)).toHaveAttribute('title', 'Normal Codex keeps its own account and models. Choose Codex · Custom endpoint for a new chat. A started chat cannot change provider.')
    fillProvider(fields)
    expect(api.testProvider).not.toHaveBeenCalled()
    expect(api.setProvider).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeDisabled()
    fireEvent.submit(fields.key.closest('form')!)
    expect(api.setProvider).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(/Connection test passed using native Codex/)
    const expected = { base_url: 'https://inference.example/v1', model: 'gpt-6-astra', api_key: 'synthetic-provider-key' }
    expect(api.testProvider).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 }, expected)
    expect(fields.key).toHaveValue('synthetic-provider-key')
    expect(api.setProvider).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }))
    expect(fields.key).toHaveValue('')
    await screen.findByText(/Endpoint saved. Choose Codex/)
    expect(api.setProvider).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 }, expected)
    expect(api.write).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('API key for this endpoint')).not.toBeInTheDocument()
    expect(screen.getByText('Custom endpoint · gpt-6-astra')).toBeInTheDocument()
    expect(persist).not.toHaveBeenCalled()
  })

  it('keeps normal sign-in available beside a configured custom endpoint and never reuses its saved key', async () => {
    const api = bridge(undefined, undefined, { provider: vi.fn().mockResolvedValue(providerSnapshot(true)) })
    render(<CodexAuthSettings {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use API key' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Use API key' }))
    await waitFor(() => expect(screen.getByLabelText('OpenAI API key')).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Custom endpoint' }))
    const input = await screen.findByLabelText('API key for this endpoint')
    expect(input).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Sign in with API key' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Endpoint base URL')).toHaveValue('https://inference.example/v1')
    expect(screen.getByLabelText('Model ID')).toHaveValue('gpt-6-astra')
    fireEvent.change(screen.getByLabelText('Endpoint base URL'), { target: { value: 'https://different.example/v1' } })
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeDisabled()
    expect(api.testProvider).not.toHaveBeenCalled()
    expect(api.setProvider).not.toHaveBeenCalled()
    expect(api.write).not.toHaveBeenCalled()
  })

  it.each(['endpoint', 'model', 'key'] as const)('invalidates a successful test when the %s changes', async field => {
    const api = bridge()
    render(<CodexAuthSettings {...props} />)
    const fields = await openCustomForm()
    fillProvider(fields)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(/Connection test passed using native Codex/)
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeEnabled()
    fireEvent.change(fields[field], { target: { value: field === 'endpoint' ? 'https://changed.example/v1' : 'changed-value' } })
    expect(screen.queryByText(/Connection test passed using native Codex/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeDisabled()
    expect(api.testProvider).toHaveBeenCalledOnce()
    expect(api.setProvider).not.toHaveBeenCalled()
  })

  it.each(['endpoint', 'model', 'key'] as const)('ignores late test results after the %s changes', async field => {
    let resolve: (value: CodexProviderTestResult) => void = () => {}
    bridge(undefined, undefined, { testProvider: vi.fn().mockImplementation(() => new Promise(done => { resolve = done })) })
    render(<CodexAuthSettings {...props} />)
    const fields = await openCustomForm()
    fillProvider(fields)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(screen.getByRole('button', { name: 'Testing connection…' })).toBeDisabled()
    expect(fields[field]).toBeEnabled()
    fireEvent.change(fields[field], { target: { value: field === 'endpoint' ? 'https://changed.example/v1' : 'changed-value' } })
    await act(async () => resolve(readyResult))
    expect(screen.queryByText(/Connection test passed using native Codex/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeDisabled()
  })

  it.each([
    ['unsupported', /did not support the Responses API behavior/],
    ['authentication_failed', /endpoint rejected authentication/],
    ['connection_failed', /Could not reach the endpoint/],
    ['model_unavailable', /endpoint could not use this model/],
    ['failed', /native Codex connection test did not complete/]
  ] as const)('distinguishes %s without displaying provider-supplied messages', async (status, expected) => {
    const api = bridge(undefined, undefined, { testProvider: vi.fn().mockResolvedValue({ ok: false, status, message: 'Echoed synthetic-provider-key' }) })
    render(<CodexAuthSettings {...props} />)
    const fields = await openCustomForm()
    fillProvider(fields)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(expected)
    expect(document.body.textContent).not.toContain('synthetic-provider-key')
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled()
    expect(api.setProvider).not.toHaveBeenCalled()
  })

  it('clears canceled test input and ignores a result after closing the form', async () => {
    let resolve: (value: CodexProviderTestResult) => void = () => {}
    const api = bridge(undefined, undefined, { testProvider: vi.fn().mockImplementation(() => new Promise(done => { resolve = done })) })
    render(<CodexAuthSettings {...props} />)
    const fields = await openCustomForm()
    fillProvider(fields)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(fields.key).toHaveValue('')
    await act(async () => resolve(readyResult))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('API key for this endpoint')).not.toBeInTheDocument()
    expect(api.setProvider).not.toHaveBeenCalled()
  })

  it('does not apply late save success to another profile generation', async () => {
    let resolve: (value: CodexProviderConfiguration) => void = () => {}
    bridge(undefined, undefined, { setProvider: vi.fn().mockImplementation(() => new Promise(done => { resolve = done })) })
    const { rerender } = render(<CodexAuthSettings {...props} />)
    const fields = await openCustomForm()
    fillProvider(fields)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(/Connection test passed using native Codex/)
    fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }))
    rerender(<CodexAuthSettings {...props} profileGeneration={2} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use API key' })).toBeEnabled())
    await act(async () => resolve(providerSnapshot(true)))
    expect(fields.key).toHaveValue('')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Custom endpoint · gpt-6-astra')).not.toBeInTheDocument()
  })

  it('clears a submitted key after busy save and requires a new test before retrying', async () => {
    bridge(undefined, undefined, { setProvider: vi.fn().mockRejectedValue(new Error('CODEX_PROVIDER_BUSY')) })
    render(<CodexAuthSettings {...props} />)
    const fields = await openCustomForm()
    fillProvider(fields)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(/Connection test passed using native Codex/)
    fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }))
    await screen.findByText(/Codex work or another connection test is still running/)
    expect(fields.key).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeDisabled()
    fireEvent.change(fields.key, { target: { value: 'replacement-key' } })
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled()
  })

  it('resets the custom endpoint explicitly without signing in or sending a saved key', async () => {
    const api = bridge(undefined, undefined, { provider: vi.fn().mockResolvedValue(providerSnapshot(true)) })
    render(<CodexAuthSettings {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use API key' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Custom endpoint' }))
    await screen.findByRole('button', { name: 'Remove custom endpoint' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove custom endpoint' }))
    await screen.findByText('Custom endpoint removed. Normal Codex and its login are unchanged.')
    expect(api.resetProvider).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 })
    expect(api.testProvider).not.toHaveBeenCalled()
    expect(api.setProvider).not.toHaveBeenCalled()
    expect(api.write).not.toHaveBeenCalled()
  })

  it('recovers unreadable provider settings with explicit reset and permits retry after busy rejection', async () => {
    const api = bridge(undefined, undefined, {
      provider: vi.fn().mockRejectedValue(new Error('CODEX_PROVIDER_FAILED synthetic-private-file-detail')),
      resetProvider: vi.fn().mockRejectedValueOnce(new Error('CODEX_PROVIDER_BUSY')).mockResolvedValue(providerSnapshot())
    })
    render(<CodexAuthSettings {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use API key' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Use API key' }))
    const reset = await screen.findByRole('button', { name: 'Remove custom endpoint' })
    expect(reset).toBeEnabled()
    expect(screen.getByLabelText('OpenAI API key')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Sign in with API key' })).toBeDisabled()
    expect(document.body.textContent).not.toContain('synthetic-private-file-detail')
    fireEvent.click(reset)
    await screen.findByText(/Codex work or another connection test is still running/)
    expect(reset).toBeEnabled()
    expect(screen.getByLabelText('OpenAI API key')).toBeDisabled()
    fireEvent.click(reset)
    await screen.findByText('Custom endpoint removed. Normal Codex and its login are unchanged.')
    expect(api.resetProvider.mock.calls).toEqual([[{ profileId: 'studio', profileGeneration: 1 }], [{ profileId: 'studio', profileGeneration: 1 }]])
    expect(api.write).not.toHaveBeenCalled()
    expect(api.testProvider).not.toHaveBeenCalled()
    expect(api.setProvider).not.toHaveBeenCalled()
  })

  it('reaches endpoint recovery after both account and provider metadata fail, without a key login', async () => {
    const api = bridge(vi.fn().mockRejectedValueOnce(new Error('CODEX_AUTH_FAILED')).mockResolvedValue(snapshot()), undefined, {
      provider: vi.fn().mockRejectedValueOnce(new Error('CODEX_PROVIDER_FAILED')).mockResolvedValue(providerSnapshot())
    })
    render(<CodexAuthSettings {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Endpoint settings' }))
    const reset = await screen.findByRole('button', { name: 'Remove custom endpoint' })
    expect(reset).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Sign in with API key' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('API key for this endpoint')).toBeDisabled()
    fireEvent.click(reset)
    await screen.findByText('Custom endpoint removed. Normal Codex and its login are unchanged.')
    expect(api.resetProvider).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 })
    expect(api.write).not.toHaveBeenCalled()
    expect(api.testProvider).not.toHaveBeenCalled()
    expect(api.setProvider).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }))
    expect(await openForm()).toBeEnabled()
    expect(api.write).not.toHaveBeenCalled()
  })

  it('allows guarded provider editing after a generic account-status failure, without enabling normal sign-in', async () => {
    const api = bridge(vi.fn().mockRejectedValue(new Error('CODEX_AUTH_FAILED')))
    render(<CodexAuthSettings {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Endpoint settings' }))
    const key = await screen.findByLabelText('API key for this endpoint') as HTMLInputElement
    await waitFor(() => expect(key).toBeEnabled())
    const fields = { key, endpoint: screen.getByLabelText('Endpoint base URL'), model: screen.getByLabelText('Model ID') }
    fillProvider(fields)
    expect(screen.queryByRole('button', { name: 'Sign in with API key' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(/Connection test passed using native Codex/)
    fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }))
    await screen.findByText(/Endpoint saved. Choose Codex/)
    expect(screen.getByText('Custom endpoint · gpt-6-astra')).toBeInTheDocument()
    expect(api.write).not.toHaveBeenCalled()
    expect(api.setProvider).toHaveBeenCalledOnce()
  })

  it.each(['CODEX_PROVIDER_ADMIN', 'CODEX_PROVIDER_UPDATE', 'CODEX_PROVIDER_CONNECTION'])('does not offer metadata recovery for %s', async error => {
    const api = bridge(undefined, undefined, { provider: vi.fn().mockRejectedValue(new Error(error)) })
    render(<CodexAuthSettings {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use API key' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Use API key' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Remove custom endpoint' })).not.toBeInTheDocument()
    expect(api.resetProvider).not.toHaveBeenCalled()
  })

  it('does not mistake a failed endpoint test for unreadable saved settings', async () => {
    bridge(undefined, undefined, { testProvider: vi.fn().mockRejectedValue(new Error('CODEX_PROVIDER_FAILED')) })
    render(<CodexAuthSettings {...props} />)
    const fields = await openCustomForm()
    fillProvider(fields)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Remove custom endpoint' })).not.toBeInTheDocument()
  })

  it('performs no requests on custom field edits or while idle and translates the controls', async () => {
    const api = bridge()
    render(<CodexAuthSettings {...props} />)
    const fields = await openCustomForm()
    fillProvider(fields)
    fireEvent.change(fields.endpoint, { target: { value: 'https://changed.example/v1' } })
    vi.useFakeTimers()
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(api.provider).toHaveBeenCalledOnce()
    expect(api.read).toHaveBeenCalledOnce()
    expect(api.testProvider).not.toHaveBeenCalled()
    expect(api.setProvider).not.toHaveBeenCalled()
    await act(async () => setLocale('zh-CN'))
    expect(screen.getByLabelText('端点基础 URL')).toHaveValue('https://changed.example/v1')
    expect(screen.getByLabelText('模型 ID')).toHaveValue('gpt-6-astra')
    expect(screen.getByLabelText('此端点的 API 密钥')).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '保存端点' })).toBeDisabled()
  })
})
