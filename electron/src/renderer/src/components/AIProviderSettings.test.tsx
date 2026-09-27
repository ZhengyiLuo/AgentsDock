import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { AppSettingsDialog, SettingsDialog } from './Dialogs'

function bridge() {
  const api = {
    updates: { status: vi.fn().mockResolvedValue({ state: 'disabled', channel: 'development', currentVersion: '0.2.0' }) },
    events: { on: vi.fn().mockReturnValue(() => undefined) },
    runtime: { catalog: vi.fn() },
    codex: {
      auth: vi.fn().mockResolvedValue({ available: true, auth_mode: 'chatgpt', email: 'fixture@example.test', plan_type: 'pro', requires_openai_auth: true }),
      provider: vi.fn().mockResolvedValue({ available: true, configured: false, base_url: null, model: null, has_api_key: false, wire_api: 'responses' }),
      setProvider: vi.fn(), testProvider: vi.fn(), resetProvider: vi.fn()
    }
  }
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: api as unknown as AgentsDockAPI })
  return api
}

beforeEach(() => {
  setLocale('en')
  window.localStorage.clear()
  useAppStore.setState({
    connected: true,
    profiles: [{ id: 'studio', name: 'Studio server', serverUrl: 'https://studio.example.test', serverIdentity: 'studio-id', hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 }],
    activeProfileId: 'studio', profileGeneration: 1, switchingProfileId: null,
    sessions: [], runtimeCatalog: null, error: null,
    health: { ok: true, managed_updates: false, runtimes: {
      claude: { backend: 'claude', available: true, status: 'unknown', message: 'Authentication has not been verified.' },
      codex: { backend: 'codex', available: true, status: 'ready', message: 'Native Codex is ready.' }
    } },
    modals: { settings: false, appSettings: true, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
  })
})

afterEach(() => { cleanup(); setLocale('en'); vi.restoreAllMocks() })

it('opens existing provider controls on their own page without probing or changing credentials', async () => {
  const api = bridge()
  render(<AppSettingsDialog />)
  expect(api.codex.auth).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'AI Providers' }))
  expect(screen.getByRole('button', { name: 'AI Providers' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('heading', { name: 'AI Providers' })).toBeVisible()
  expect(screen.getByText('Current server: Studio server')).toBeVisible()
  expect(screen.getByText('Authentication has not been verified.')).toBeVisible()
  await screen.findByText('ChatGPT · fixture@example.test · pro')
  expect(api.codex.auth).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 })
  expect(api.runtime.catalog).not.toHaveBeenCalled()
  expect(api.codex.provider).toHaveBeenCalledOnce()

  fireEvent.click(screen.getAllByRole('button', { name: 'Configure API' })[0])
  const input = await screen.findByLabelText('API key for this endpoint')
  await waitFor(() => expect(input).toBeEnabled())
  fireEvent.change(input, { target: { value: 'synthetic-unsaved-key' } })
  expect(api.codex.provider).toHaveBeenLastCalledWith({ profileId: 'studio', profileGeneration: 1 })
  fireEvent.click(screen.getByRole('button', { name: 'General' }))
  expect(input).toHaveValue('')
  fireEvent.click(screen.getByRole('button', { name: 'AI Providers' }))
  await waitFor(() => expect(api.codex.auth).toHaveBeenCalledTimes(2))
  expect(screen.queryByLabelText('API key for this endpoint')).not.toBeInTheDocument()
  expect(api.codex.setProvider).not.toHaveBeenCalled()
  expect(api.codex.testProvider).not.toHaveBeenCalled()
  expect(api.codex.resetProvider).not.toHaveBeenCalled()
  expect(api.runtime.catalog).not.toHaveBeenCalled()
})

it('keeps legacy Server navigation and moves account/runtime controls only', async () => {
  const api = bridge()
  useAppStore.setState(state => ({ modals: { ...state.modals, settings: true, appSettings: false } }))
  render(<SettingsDialog />)
  expect(screen.getByRole('button', { name: 'Server' })).toHaveAttribute('aria-current', 'page')
  expect(screen.queryByText('Codex · Native account')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Recheck CLIs' })).not.toBeInTheDocument()
  expect(api.codex.auth).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'AI Providers' }))
  await screen.findByText('Codex · Native account')
  expect(screen.getByRole('button', { name: 'Recheck CLIs' })).toBeEnabled()
})

it('discards stale account information when the selected server changes', async () => {
  const api = bridge()
  let resolveOld!: (value: unknown) => void
  api.codex.auth.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  render(<AppSettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: 'AI Providers' }))
  api.codex.auth.mockResolvedValue({ available: true, auth_mode: 'none', email: null, plan_type: null, requires_openai_auth: true })
  act(() => useAppStore.setState({ activeProfileId: 'other', profileGeneration: 2, profiles: [{ id: 'other', name: 'Other server', serverUrl: 'https://other.example.test', hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 }] }))
  await screen.findByText('Not signed in')
  expect(screen.getByText('Current server: Other server')).toBeVisible()
  await act(async () => resolveOld({ available: true, auth_mode: 'chatgpt', email: 'stale@example.test', plan_type: 'pro', requires_openai_auth: true }))
  expect(screen.queryByText(/stale@example/)).not.toBeInTheDocument()
  expect(api.codex.auth).toHaveBeenLastCalledWith({ profileId: 'other', profileGeneration: 2 })
})

it('supports the provider deep link and keeps disconnected controls read-only', async () => {
  const api = bridge()
  useAppStore.setState({ connected: false })
  render(<AppSettingsDialog />)
  act(() => window.dispatchEvent(new CustomEvent('agentsdock:app-settings-section', { detail: 'providers' })))
  expect(screen.getByRole('button', { name: 'AI Providers' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getAllByRole('button', { name: 'Configure API' })[0]).toBeDisabled()
  expect(api.codex.auth).not.toHaveBeenCalled()
  expect(api.runtime.catalog).not.toHaveBeenCalled()
})

it('localizes the provider navigation and selected-server context', () => {
  bridge()
  setLocale('zh-CN')
  render(<AppSettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: 'AI 服务商' }))
  expect(screen.getByRole('heading', { name: 'AI 服务商' })).toBeVisible()
  expect(screen.getByText('当前服务端：Studio server')).toBeVisible()
})
