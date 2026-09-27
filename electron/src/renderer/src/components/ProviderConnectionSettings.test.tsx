import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import { CursorEndpointNotice, ProviderConnectionSettings } from './ProviderConnectionSettings'

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
  await screen.findByText('Connected · last check passed')
  expect(screen.getByRole('region', { name: 'Claude Code custom endpoint' })).toHaveClass('connection-connected')
  expect(sent).toMatchObject({ model: null, api_key: 'synthetic-read-only-key' })
})

it('only checks on submit, shows a bounded API check and clears the key', async () => {
  const request = bridge()
  render(<ProviderConnectionSettings {...props} />)
  const key = await fill()
  expect(request).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('Connected · last check passed')).not.toBeInTheDocument()
  let submitted: unknown
  request.mockImplementationOnce((_scope, _backend, _action, input) => {
    submitted = { ...input }; return Promise.resolve({ ok: true, status: 'verified', configuration: saved })
  })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByText('Connected · last check passed')
  expect(submitted).toEqual({ base_url: 'https://openrouter.ai/api', model: 'test/model', api_key: 'synthetic-test-key',
    protocol: 'anthropic', auth_header: 'bearer', expected_revision: 0 })
  expect(key).toHaveValue('')
  expect(screen.getByText('Settings only — not used by chats yet.')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Configure API' }))
  expect(screen.queryByText('Connected · last check passed')).not.toBeInTheDocument()
})

it('does not show success after rejection and keeps a retry path', async () => {
  const request = bridge()
  render(<ProviderConnectionSettings {...props} />)
  const key = await fill()
  request.mockResolvedValueOnce({ ok: false, status: 'authentication_failed' })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('rejected authentication')
  expect(screen.getByRole('region', { name: 'Claude Code custom endpoint' })).toHaveClass('connection-unconfirmed')
  expect(screen.queryByText('Connected · last check passed')).not.toBeInTheDocument()
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
  expect(screen.queryByText('Connected · last check passed')).not.toBeInTheDocument()
  expect(key).toHaveValue('')
  const second = await fill()
  unmount(); expect(second).toHaveValue('')
})

it('rechecks without resending a key and explicitly confirms forgetting', async () => {
  const request = bridge().mockResolvedValueOnce({ configuration: saved })
  render(<ProviderConnectionSettings {...props} />)
  await screen.findByText('Connected · last check passed')
  request.mockResolvedValueOnce({ ok: false, status: 'rate_limited', configuration: { ...saved, revision: 2, last_result: 'rate_limited' } })
  fireEvent.click(screen.getByRole('button', { name: 'Check saved API' }))
  await screen.findByRole('alert')
  expect(request).toHaveBeenLastCalledWith({ profileId: 'test', profileGeneration: 1 }, 'claude', 'check', { expected_revision: 1 })
  fireEvent.click(screen.getByRole('button', { name: 'Forget endpoint' }))
  expect(request).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Confirm forget' }))
  await screen.findByText('Not connected')
  expect(request).toHaveBeenLastCalledWith({ profileId: 'test', profileGeneration: 1 }, 'claude', 'forget', { expected_revision: 2 })
})

it('makes old-server and Cursor limitations visible without fake success', async () => {
  bridge().mockRejectedValue(new Error('PROVIDER_CONNECTION_UPDATE'))
  render(<><ProviderConnectionSettings {...props} /><CursorEndpointNotice /></>)
  expect(await screen.findByRole('alert')).toHaveTextContent('does not expose these endpoint settings yet')
  expect(screen.getByRole('button', { name: 'Configure API' })).toBeDisabled()
  expect(screen.getByText(/Custom model APIs are not supported here by Cursor CLI/)).toBeVisible()
  expect(screen.getByText('Connection status unavailable')).toBeVisible()
  expect(screen.getByText('Custom API not supported')).toBeVisible()
  expect(screen.queryByText('Connected · last check passed')).not.toBeInTheDocument()
})
