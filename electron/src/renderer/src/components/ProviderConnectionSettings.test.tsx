import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import { ProviderConnectionSettings } from './ProviderConnectionSettings'

const props = { backend: 'claude' as const, connected: true, profileId: 'test', profileGeneration: 1 }
const empty = { backend: 'claude', scope: 'settings_only', revision: 0, configured: false, has_api_key: false,
  base_url: null, model: null, protocol: null, auth_header: null, checked_at: null, last_result: null }
const saved = { ...empty, revision: 1, configured: true, has_api_key: true, base_url: 'https://openrouter.ai/api', model: 'test/model',
  protocol: 'anthropic', auth_header: 'bearer', checked_at: '2026-09-27T20:00:00Z', last_result: 'verified' }
function bridge() {
  const request = vi.fn().mockResolvedValue({ configuration: empty })
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { providerConnections: { request } } as unknown as AgentsDockAPI })
  return request
}
async function fill() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Configure API' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Configure API' }))
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'test/model' } })
  const key = screen.getByLabelText('API key')
  fireEvent.change(key, { target: { value: 'synthetic-test-key' } })
  return key
}
afterEach(() => { cleanup(); localStorage.clear(); setLocale('en'); vi.restoreAllMocks() })

it.each(['claude', 'opencode', 'cursor'] as const)('localizes %s configuration and validation errors in Chinese', async backend => {
  const request = bridge().mockResolvedValue({ configuration: { ...empty, backend, scope: 'per_chat' } })
  setLocale('zh-CN')
  render(<ProviderConnectionSettings {...props} backend={backend} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '配置 API' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '配置 API' }))
  expect(screen.getByLabelText('API 密钥')).toBeVisible()
  if (backend !== 'cursor') {
    expect(screen.getByLabelText('API 协议')).toBeVisible()
    expect(screen.getByLabelText('认证请求头')).toBeVisible()
    fireEvent.change(screen.getByLabelText('API 基础地址'), { target: { value: 'https://api.example.test' } })
  }
  fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'synthetic-invalid-key' } })
  request.mockResolvedValueOnce({ ok: false, status: 'authentication_failed' })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('接口拒绝了认证，请检查密钥和认证请求头。')
  expect(screen.getByRole('button', { name: '取消' })).toBeVisible()
})

it('localizes the Cursor forget menu and confirmation without forgetting on cancel', async () => {
  const request = bridge().mockResolvedValue({ configuration: { ...saved, backend: 'cursor' } })
  setLocale('zh-CN')
  render(<ProviderConnectionSettings {...props} backend="cursor" />)
  await screen.findByText('已连接')
  fireEvent.keyDown(screen.getByRole('button', { name: '接口选项' }), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitem', { name: '移除 API 密钥' }))
  expect(screen.getByRole('dialog', { name: '确认移除' })).toHaveTextContent('会话记录保留')
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(request).toHaveBeenCalledTimes(1)
})

it('connects with URL and key using visible fixed protocol and separate authentication fields', async () => {
  const request = bridge()
  render(<ProviderConnectionSettings {...props} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Configure API' })).toBeEnabled())
  expect(screen.getByRole('region', { name: 'Claude Code custom endpoint' })).toHaveClass('connection-unconfirmed')
  expect(screen.getByText('Not connected')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Configure API' }))
  expect(screen.queryByText('Advanced (optional)')).not.toBeInTheDocument()
  expect(screen.getByLabelText('API protocol')).toHaveValue('anthropic')
  expect(screen.getByLabelText('API protocol')).toBeDisabled()
  expect(screen.getByLabelText('Authentication header')).toHaveValue('x-api-key')
  expect(screen.getByLabelText('Model ID')).not.toBeRequired()
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-read-only-key' } })
  let sent: unknown
  request.mockImplementationOnce((_scope, _backend, _action, input) => {
    sent = { ...input }; return Promise.resolve({ ok: true, status: 'verified', configuration: { ...saved, model: null } })
  })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByText('Connected')
  expect(screen.getByRole('region', { name: 'Claude Code custom endpoint' })).toHaveClass('connection-connected')
  expect(sent).toMatchObject({ model: null, api_key: 'synthetic-read-only-key' })
})

it('only checks on submit, shows a bounded API check and clears the key', async () => {
  const request = bridge()
  render(<ProviderConnectionSettings {...props} />)
  const key = await fill()
  expect(request).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  let submitted: unknown
  request.mockImplementationOnce((_scope, _backend, _action, input) => {
    submitted = { ...input }; return Promise.resolve({ ok: true, status: 'verified', configuration: saved })
  })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByText('Connected')
  expect(submitted).toEqual({ base_url: 'https://api.anthropic.com', model: 'test/model', api_key: 'synthetic-test-key',
    protocol: 'anthropic', auth_header: 'x-api-key', expected_revision: 0 })
  expect(key).toHaveValue('')
  expect(screen.getByText('Settings only — not used by chats yet.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Endpoint options' })).toBeEnabled()
})

it('does not show success after rejection and keeps a retry path', async () => {
  const request = bridge()
  render(<ProviderConnectionSettings {...props} />)
  const key = await fill()
  request.mockResolvedValueOnce({ ok: false, status: 'authentication_failed' })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('rejected authentication')
  expect(screen.getByRole('region', { name: 'Claude Code custom endpoint' })).toHaveClass('connection-unconfirmed')
  expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  expect(key).toHaveValue('')
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
})

it('clears drafts on close and rejects late responses after a server switch', async () => {
  const request = bridge()
  const { rerender, unmount } = render(<ProviderConnectionSettings {...props} />)
  const key = await fill()
  let finish!: (value: unknown) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  rerender(<ProviderConnectionSettings {...props} profileId="other" profileGeneration={2} />)
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ profileId: 'other', profileGeneration: 2 }, 'claude', 'get'))
  await act(async () => finish({ ok: true, status: 'verified', configuration: saved }))
  expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  expect(key).toHaveValue('')
  const second = await fill()
  unmount(); expect(second).toHaveValue('')
})

it('offers forgetting only in the menu, confirms it and never logs out CLI', async () => {
  const request = bridge().mockResolvedValueOnce({ configuration: saved })
  render(<ProviderConnectionSettings {...props} />)
  await screen.findByText('Connected')
  expect(screen.queryByRole('button', { name: 'Check saved API' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Forget endpoint' })).not.toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Endpoint options' }), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Forget endpoint' }))
  expect(request).toHaveBeenCalledTimes(1)
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  expect(request).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Endpoint options' }), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Forget endpoint' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Forget endpoint' }))
  await screen.findByText('Not connected')
  expect(request).toHaveBeenLastCalledWith({ profileId: 'test', profileGeneration: 1 }, 'claude', 'forget', { expected_revision: 1 })
})

it('makes old-server limitations visible without fake success', async () => {
  bridge().mockRejectedValue(new Error('PROVIDER_CONNECTION_UPDATE'))
  render(<ProviderConnectionSettings {...props} backend="cursor" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('does not expose these endpoint settings yet')
  expect(screen.getByRole('button', { name: 'Configure API' })).toBeDisabled()
  expect(screen.getByText('Connection status unavailable')).toBeVisible()
  expect(screen.queryByText('Connected')).not.toBeInTheDocument()
})

it('connects Cursor with a key only, verifies before showing connected, and forgets with confirmation', async () => {
  const request = bridge().mockResolvedValue({ configuration: { ...empty, backend: 'cursor', scope: 'per_chat' } })
  render(<ProviderConnectionSettings {...props} backend="cursor" />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Configure API' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Configure API' }))
  expect(screen.queryByLabelText('API base URL')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Model ID')).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-cursor-key' } })
  let sent: unknown
  request.mockImplementationOnce((_scope, backend, action, input) => {
    sent = { backend, action, ...input }
    return Promise.resolve({ ok: true, status: 'verified', configuration: { ...saved, backend: 'cursor', scope: 'per_chat', base_url: 'https://api2.cursor.sh', protocol: 'cursor', model: 'auto' } })
  })
  expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByText('Connected')
  expect(sent).toEqual({ backend: 'cursor', action: 'save', base_url: 'https://api2.cursor.sh', protocol: 'cursor', auth_header: 'bearer', model: null, api_key: 'synthetic-cursor-key', expected_revision: 0 })
  expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Endpoint options' }), { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Forget API key' }))
  expect(screen.getByText(/CLI login and other servers are unchanged/)).toBeVisible()
  expect(request).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Forget API key' }))
  await screen.findByText('Not connected')
  expect(request).toHaveBeenLastCalledWith({ profileId: 'test', profileGeneration: 1 }, 'cursor', 'forget', { expected_revision: 1 })
})

it('does not silently choose OpenRouter for OpenCode', async () => {
  bridge().mockResolvedValue({ configuration: { ...empty, backend: 'opencode' } })
  render(<ProviderConnectionSettings {...props} backend="opencode" />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Configure API' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Configure API' }))
  expect(screen.getByLabelText('API base URL')).toHaveValue('')
  expect(screen.getByText(/OpenCode Zen and Go are official options/)).toBeVisible()
})

it('keeps failed non-secret drafts across cancel, reopen and remount without checking again', async () => {
  const request = bridge()
  const mounted = render(<ProviderConnectionSettings {...props} />)
  await fill()
  fireEvent.change(screen.getByLabelText('API base URL'), { target: { value: 'https://gateway.example/v1' } })
  fireEvent.change(screen.getByLabelText('Authentication header'), { target: { value: 'bearer' } })
  request.mockResolvedValueOnce({ ok: false, status: 'authentication_failed' })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Configure API' }))
  expect(screen.getByLabelText('API base URL')).toHaveValue('https://gateway.example/v1')
  mounted.unmount()
  render(<ProviderConnectionSettings {...props} profileGeneration={2} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Configure API' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Configure API' }))
  expect(screen.getByLabelText('API base URL')).toHaveValue('https://gateway.example/v1')
  expect(screen.getByLabelText('Model ID')).toHaveValue('test/model')
  expect(screen.getByLabelText('Authentication header')).toHaveValue('bearer')
  expect(screen.getByLabelText('API key')).toHaveValue('')
  expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  expect(request).toHaveBeenCalledTimes(3) // two reads, one explicit save
  const persisted = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i)!)).join('')
  expect(persisted).not.toContain('synthetic-test-key')
})

it('requires a model for Zen, separates protocol and auth rows, and keeps another server empty', async () => {
  const request = bridge().mockResolvedValue({ configuration: { ...empty, backend: 'opencode' } })
  const mounted = render(<ProviderConnectionSettings {...props} backend="opencode" />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Configure API' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Configure API' }))
  fireEvent.change(screen.getByLabelText('API base URL'), { target: { value: 'https://opencode.ai/zen/v1' } })
  fireEvent.change(screen.getByLabelText('API protocol'), { target: { value: 'anthropic' } })
  const protocol = screen.getByLabelText('API protocol'), auth = screen.getByLabelText('Authentication header')
  expect(auth).toHaveValue('x-api-key')
  expect(protocol.closest('.provider-connection-field')).not.toBe(auth.closest('.provider-connection-field'))
  expect(screen.getByLabelText('API base URL')).toBeRequired()
  expect(screen.getByLabelText('API key')).toBeRequired()
  expect(screen.getByLabelText('Model ID')).toBeRequired()
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-key' } })
  expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'test-model' } })
  expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
  expect(request).toHaveBeenCalledTimes(1)
  mounted.rerender(<ProviderConnectionSettings {...props} backend="opencode" profileId="other" profileGeneration={2} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Configure API' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Configure API' }))
  expect(screen.getByLabelText('API base URL')).toHaveValue('')
  expect(screen.getByLabelText('API protocol')).toHaveValue('chat_completions')
  expect(screen.getByLabelText('Authentication header')).toHaveValue('bearer')
  expect(screen.getByLabelText('API key')).toHaveValue('')
  mounted.rerender(<ProviderConnectionSettings {...props} backend="opencode" profileGeneration={3} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Configure API' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Configure API' }))
  expect(screen.getByLabelText('API base URL')).toHaveValue('https://opencode.ai/zen/v1')
  expect(screen.getByLabelText('API protocol')).toHaveValue('anthropic')
  expect(screen.getByLabelText('Authentication header')).toHaveValue('x-api-key')
})
