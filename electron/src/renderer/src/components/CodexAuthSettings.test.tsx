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
  model: null, has_api_key: configured, wire_api: 'responses'
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
  const open = screen.getByRole('button', { name: 'Custom endpoint' })
  await waitFor(() => expect(open).toBeEnabled())
  fireEvent.click(open)
  const key = screen.getByLabelText('API key for this endpoint') as HTMLInputElement
  await waitFor(() => expect(key).toBeEnabled())
  return key
}
async function openCustomForm() {
  const key = await openForm()
  return { key, endpoint: screen.getByLabelText('Endpoint base URL') }
}
function fillProvider(fields: Awaited<ReturnType<typeof openCustomForm>>) {
  fireEvent.change(fields.endpoint, { target: { value: 'https://inference.example/v1' } })
  fireEvent.change(fields.key, { target: { value: 'synthetic-provider-key' } })
}
afterEach(() => { cleanup(); setLocale('en'); vi.restoreAllMocks(); vi.useRealTimers() })

describe('Codex account settings', () => {
  it('shows the existing account read-only and has one separate endpoint action', async () => {
    const api = bridge(vi.fn().mockResolvedValue(snapshot('chatgpt')))
    render(<CodexAuthSettings {...props} />)
    await screen.findByText('ChatGPT · person@example.com · pro')
    expect(screen.getByText('Studio')).toBeVisible()
    expect(screen.getByText(/Manage that login with Codex on the server/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Use API key' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in with API key' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('OpenAI API key')).not.toBeInTheDocument()
    expect(api.read).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 })
    expect(api.provider).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }))
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2))
    expect(api.write).not.toHaveBeenCalled()
  })

  it('clears an endpoint key on cancel and unmount', async () => {
    const api = bridge()
    const { unmount } = render(<CodexAuthSettings {...props} />)
    const first = await openForm()
    fireEvent.change(first, { target: { value: 'synthetic-cancelled-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(first).toHaveValue('')
    const second = await openForm()
    expect(second).toHaveValue('')
    fireEvent.change(second, { target: { value: 'synthetic-unmounted-key' } })
    unmount()
    expect(second).toHaveValue('')
    expect(api.write).not.toHaveBeenCalled()
    expect(api.testProvider).not.toHaveBeenCalled()
    expect(api.setProvider).not.toHaveBeenCalled()
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
    const api = bridge()
    const { rerender } = render(<CodexAuthSettings {...props} />)
    const input = await openForm()
    fireEvent.change(input, { target: { value: 'synthetic-old-profile-key' } })
    rerender(<CodexAuthSettings {...props}
      profileId={change === 'profile' ? 'other' : props.profileId}
      profileGeneration={change === 'generation' ? 2 : props.profileGeneration}
      connected={change !== 'offline'} />)
    expect(input).toHaveValue('')
    expect(screen.queryByLabelText('API key for this endpoint')).not.toBeInTheDocument()
    expect(api.write).not.toHaveBeenCalled()
    if (change !== 'offline') expect(await openForm()).toHaveValue('')
  })

  it.each([
    ['CODEX_AUTH_UPDATE', /Update AgentsDock and AgentsServer/],
    ['403 Forbidden', /Connect as the server administrator/],
    ['CODEX_AUTH_CONNECTION', /Could not reach the server/],
    ['Unexpected synthetic-private-provider-echo', /Could not check the Codex account/]
  ])('explains account read failure safely while allowing independent endpoint checks: %s', async (message, expected) => {
    bridge(vi.fn().mockRejectedValue(new Error(message)))
    render(<CodexAuthSettings {...props} />)
    await screen.findByText(expected)
    expect(screen.getByRole('button', { name: 'Custom endpoint' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Recheck' })).toBeEnabled()
    expect(document.body.textContent).not.toContain('synthetic-private-provider-echo')
    expect(await openForm()).toBeEnabled()
  })

  it('makes no request offline and localizes the independent endpoint entry', async () => {
    setLocale('zh-CN')
    const api = bridge()
    const { rerender } = render(<CodexAuthSettings {...props} connected={false} />)
    expect(screen.getByRole('region', { name: 'Codex 账户' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '自定义端点' })).toBeDisabled()
    expect(api.read).not.toHaveBeenCalled()
    rerender(<CodexAuthSettings {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '自定义端点' }))
    await waitFor(() => expect(screen.getByLabelText('此端点的 API 密钥')).toBeEnabled())
    expect(screen.getByText(/自定义端点设置不会更改该登录状态/)).toBeVisible()
    expect(api.write).not.toHaveBeenCalled()
  })
})

describe('Codex custom endpoint settings', () => {
  it.each(['untested', 'pending', 'failed'] as const)('saves endpoint and key when the optional test is %s', async state => {
    const api = bridge(undefined, undefined, { testProvider: vi.fn().mockImplementation(() => state === 'pending'
      ? new Promise(() => {}) : Promise.resolve({ ok: false, status: 'connection_failed', message: '' })) })
    render(<CodexAuthSettings {...props} />)
    const fields = await openCustomForm()
    fillProvider(fields)
    expect(screen.queryByLabelText('Model ID')).not.toBeInTheDocument()
    if (state !== 'untested') {
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
      if (state === 'failed') await screen.findByText(/Could not reach the endpoint/)
    }
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }))
    await screen.findByText(/Endpoint saved. Choose Codex/)
    expect(api.setProvider).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 }, {
      base_url: 'https://inference.example/v1', api_key: 'synthetic-provider-key'
    })
    expect(api.write).not.toHaveBeenCalled()
  })

  it('ignores provider metadata after a profile change', async () => {
    let resolve: (value: CodexProviderConfiguration) => void = () => {}
    bridge(undefined, undefined, { provider: vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue(providerSnapshot()) })
    const { rerender } = render(<CodexAuthSettings {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Custom endpoint' }))
    expect(screen.getByLabelText('API key for this endpoint')).toBeDisabled()
    rerender(<CodexAuthSettings {...props} profileId="other" profileGeneration={2} />)
    await openForm()
    await act(async () => resolve(providerSnapshot(true)))
    expect(screen.getByLabelText('API key for this endpoint')).toBeEnabled()
    expect(screen.getByLabelText('Endpoint base URL')).toHaveValue('https://api.openai.com/v1')
    expect(screen.queryByText('Custom endpoint · https://inference.example/v1')).not.toBeInTheDocument()
  })

  it('tests endpoint/key optionally and saves without pinning a model', async () => {
    const api = bridge()
    const persist = vi.spyOn(Storage.prototype, 'setItem')
    render(<CodexAuthSettings {...props} />)
    expect(api.provider).not.toHaveBeenCalled()
    const fields = await openCustomForm()
    expect(api.provider).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 })
    expect(fields.endpoint).toHaveValue('https://api.openai.com/v1')
    expect(fields.key).toHaveAttribute('type', 'password')
    expect(screen.getByText(/Testing is optional/)).toBeInTheDocument()
    expect(screen.getByText('Choose Codex · Custom endpoint for a new chat. Existing chats keep the endpoint and credentials they started with.')).toBeVisible()
    fillProvider(fields)
    expect(api.testProvider).not.toHaveBeenCalled()
    expect(api.setProvider).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeEnabled()
    expect(api.setProvider).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(/Endpoint model discovery succeeded/)
    const expected = { base_url: 'https://inference.example/v1', api_key: 'synthetic-provider-key' }
    expect(api.testProvider).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 }, expected)
    expect(fields.key).toHaveValue('synthetic-provider-key')
    expect(api.setProvider).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }))
    await screen.findByText(/Endpoint saved. Choose Codex/)
    expect(fields.key).toHaveValue('')
    expect(api.setProvider).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 }, expected)
    expect(api.write).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('API key for this endpoint')).not.toBeInTheDocument()
    expect(screen.getByText('Custom endpoint · https://inference.example/v1')).toBeInTheDocument()
    expect(persist).not.toHaveBeenCalled()
  })

  it('reopens saved endpoint metadata without reusing its saved key or exposing normal sign-in', async () => {
    const api = bridge(undefined, undefined, { provider: vi.fn().mockResolvedValue(providerSnapshot(true)) })
    render(<CodexAuthSettings {...props} />)
    await openCustomForm()
    const input = await screen.findByLabelText('API key for this endpoint')
    expect(input).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Sign in with API key' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Endpoint base URL')).toHaveValue('https://inference.example/v1')
    expect(screen.queryByLabelText('Model ID')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Endpoint base URL'), { target: { value: 'https://different.example/v1' } })
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeDisabled()
    expect(api.testProvider).not.toHaveBeenCalled()
    expect(api.setProvider).not.toHaveBeenCalled()
    expect(api.write).not.toHaveBeenCalled()
  })

  it.each(['endpoint', 'key'] as const)('invalidates a successful test when the %s changes', async field => {
    const api = bridge()
    render(<CodexAuthSettings {...props} />)
    const fields = await openCustomForm()
    fillProvider(fields)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(/Endpoint model discovery succeeded/)
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeEnabled()
    fireEvent.change(fields[field], { target: { value: field === 'endpoint' ? 'https://changed.example/v1' : 'changed-value' } })
    expect(screen.queryByText(/Endpoint model discovery succeeded/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeEnabled()
    expect(api.testProvider).toHaveBeenCalledOnce()
    expect(api.setProvider).not.toHaveBeenCalled()
  })

  it.each(['endpoint', 'key'] as const)('ignores late test results after the %s changes', async field => {
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
    expect(screen.queryByText(/Endpoint model discovery succeeded/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeEnabled()
  })

  it.each([
    ['unsupported', /does not provide a compatible model list/],
    ['authentication_failed', /endpoint rejected authentication/],
    ['connection_failed', /Could not reach the endpoint/],
    ['model_unavailable', /endpoint could not use this model/],
    ['failed', /endpoint check did not complete/]
  ] as const)('distinguishes %s without displaying provider-supplied messages', async (status, expected) => {
    const api = bridge(undefined, undefined, { testProvider: vi.fn().mockResolvedValue({ ok: false, status, message: 'Echoed synthetic-provider-key' }) })
    render(<CodexAuthSettings {...props} />)
    const fields = await openCustomForm()
    fillProvider(fields)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(expected)
    expect(document.body.textContent).not.toContain('synthetic-provider-key')
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeEnabled()
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
    await screen.findByText(/Endpoint model discovery succeeded/)
    fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }))
    rerender(<CodexAuthSettings {...props} profileGeneration={2} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Custom endpoint' })).toBeEnabled())
    await act(async () => resolve(providerSnapshot(true)))
    expect(fields.key).toHaveValue('')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Custom endpoint · https://inference.example/v1')).not.toBeInTheDocument()
  })

  it('retains the endpoint draft after a busy save and permits retry without a test', async () => {
    bridge(undefined, undefined, { setProvider: vi.fn().mockRejectedValue(new Error('CODEX_PROVIDER_BUSY')) })
    render(<CodexAuthSettings {...props} />)
    const fields = await openCustomForm()
    fillProvider(fields)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(/Endpoint model discovery succeeded/)
    fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }))
    await screen.findByText(/server could not apply this change yet/)
    expect(fields.key).toHaveValue('synthetic-provider-key')
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeEnabled()
    fireEvent.change(fields.key, { target: { value: 'replacement-key' } })
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled()
  })

  it('resets the custom endpoint explicitly without signing in or sending a saved key', async () => {
    const api = bridge(undefined, undefined, { provider: vi.fn().mockResolvedValue(providerSnapshot(true)) })
    render(<CodexAuthSettings {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Custom endpoint' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Custom endpoint' }))
    await screen.findByRole('button', { name: 'Remove custom endpoint' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove custom endpoint' }))
    await screen.findByText('Endpoint removed for new chats. Existing custom chats keep their saved endpoint credentials.')
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Custom endpoint' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Custom endpoint' }))
    const reset = await screen.findByRole('button', { name: 'Remove custom endpoint' })
    expect(reset).toBeEnabled()
    expect(screen.getByLabelText('API key for this endpoint')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeDisabled()
    expect(document.body.textContent).not.toContain('synthetic-private-file-detail')
    fireEvent.click(reset)
    await screen.findByText(/server could not apply this change yet/)
    expect(reset).toBeEnabled()
    expect(screen.getByLabelText('API key for this endpoint')).toBeDisabled()
    fireEvent.click(reset)
    await screen.findByText('Endpoint removed for new chats. Existing custom chats keep their saved endpoint credentials.')
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
    fireEvent.click(await screen.findByRole('button', { name: 'Custom endpoint' }))
    const reset = await screen.findByRole('button', { name: 'Remove custom endpoint' })
    expect(reset).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Sign in with API key' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('API key for this endpoint')).toBeDisabled()
    fireEvent.click(reset)
    await screen.findByText('Endpoint removed for new chats. Existing custom chats keep their saved endpoint credentials.')
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
    fireEvent.click(await screen.findByRole('button', { name: 'Custom endpoint' }))
    const key = await screen.findByLabelText('API key for this endpoint') as HTMLInputElement
    await waitFor(() => expect(key).toBeEnabled())
    const fields = { key, endpoint: screen.getByLabelText('Endpoint base URL') }
    fillProvider(fields)
    expect(screen.queryByRole('button', { name: 'Sign in with API key' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(/Endpoint model discovery succeeded/)
    fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }))
    await screen.findByText(/Endpoint saved. Choose Codex/)
    expect(screen.getByText('Custom endpoint · https://inference.example/v1')).toBeInTheDocument()
    expect(api.write).not.toHaveBeenCalled()
    expect(api.setProvider).toHaveBeenCalledOnce()
  })

  it.each(['CODEX_PROVIDER_ADMIN', 'CODEX_PROVIDER_UPDATE', 'CODEX_PROVIDER_CONNECTION'])('does not offer metadata recovery for %s', async error => {
    const api = bridge(undefined, undefined, { provider: vi.fn().mockRejectedValue(new Error(error)) })
    render(<CodexAuthSettings {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Custom endpoint' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Custom endpoint' }))
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
    expect(screen.queryByLabelText('模型 ID')).not.toBeInTheDocument()
    expect(screen.getByLabelText('此端点的 API 密钥')).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: '测试连接' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '保存端点' })).toBeEnabled()
  })
})
