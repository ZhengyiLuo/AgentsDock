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
afterEach(() => { cleanup(); setLocale('en'); vi.restoreAllMocks() })

it('connects with only URL and key by default; advanced fields remain collapsed', async () => {
  const request = bridge()
  render(<ProviderConnectionSettings {...props} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Configure API' })).toBeEnabled())
  expect(screen.getByRole('region', { name: 'Claude Code custom endpoint' })).toHaveClass('connection-unconfirmed')
  expect(screen.getByText('Not connected')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Configure API' }))
  expect(screen.getByText('Advanced (optional)').parentElement).not.toHaveAttribute('open')
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
