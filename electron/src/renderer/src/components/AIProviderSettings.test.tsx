import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { AppSettingsDialog, SettingsDialog } from './Dialogs'
import type { RuntimeCatalog } from '@shared/types'

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

it('shows supported Gemini with API only, not a Google CLI login card', () => {
  bridge()
  setLocale('zh-CN')
  useAppStore.setState(state => ({ health: { ...state.health!, capabilities: {
    gemini_backend: { available: true, required: false, message: 'Configure Gemini API in My Agents.', action: null, version: 1, transport: 'acp' }
  } } }))
  render(<AppSettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: '我的 Agent' }))
  expect(document.querySelectorAll('.provider-group')).toHaveLength(5)
  expect(screen.queryByRole('region', { name: /Gemini.*CLI 登录/, hidden: true })).not.toBeInTheDocument()
  expect(screen.getByText('使用 Gemini API key 连接。服务器仍需安装 Gemini CLI 作为运行引擎。')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Gemini 自定义接口', hidden: true })).toBeInTheDocument()
})

it('opens existing provider controls on their own page without probing or changing credentials', async () => {
  const api = bridge()
  render(<AppSettingsDialog />)
  expect(api.codex.auth).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'My Agents' }))
  expect(screen.getByRole('button', { name: 'My Agents' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('heading', { name: 'My Agents' })).toBeVisible()
  expect(screen.getByText('Current server: Studio server')).toBeVisible()
  expect(document.querySelectorAll('.provider-group')).toHaveLength(4)
  expect(document.querySelectorAll('.provider-group[open]')).toHaveLength(0)
  fireEvent.click(screen.getByText('Codex', { selector: 'summary strong' }))
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
  fireEvent.click(screen.getByRole('button', { name: 'My Agents' }))
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
  expect(screen.queryByText('CLI Login')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Recheck CLIs' })).not.toBeInTheDocument()
  expect(api.codex.auth).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'My Agents' }))
  await screen.findAllByText('CLI Login')
  expect(screen.getAllByRole('button', { name: 'Reload settings' })[0]).toBeEnabled()
})

it('discards stale account information when the selected server changes', async () => {
  const api = bridge()
  let resolveOld!: (value: unknown) => void
  api.codex.auth.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  render(<AppSettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: 'My Agents' }))
  api.codex.auth.mockResolvedValue({ available: true, auth_mode: 'none', email: null, plan_type: null, requires_openai_auth: true })
  act(() => useAppStore.setState({ activeProfileId: 'other', profileGeneration: 2, profiles: [{ id: 'other', name: 'Other server', serverUrl: 'https://other.example.test', hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 }] }))
  await waitFor(() => expect(screen.getAllByText('Not signed in').length).toBeGreaterThan(0))
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
  expect(screen.getByRole('button', { name: 'My Agents' })).toHaveAttribute('aria-current', 'page')
  fireEvent.click(screen.getByText('Codex', { selector: 'summary strong' }))
  expect(screen.getAllByRole('button', { name: 'Configure API' })[0]).toBeDisabled()
  expect(api.codex.auth).not.toHaveBeenCalled()
  expect(api.runtime.catalog).not.toHaveBeenCalled()
})

it('localizes the provider navigation and selected-server context', () => {
  bridge()
  setLocale('zh-CN')
  render(<AppSettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: '我的 Agent' }))
  expect(screen.getByRole('heading', { name: '我的 Agent' })).toBeVisible()
  expect(screen.getByText('当前服务端：Studio server')).toBeVisible()
  expect(screen.getByRole('region', { name: 'Claude Code CLI 登录', hidden: true })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Claude Code 自定义接口', hidden: true })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Cursor API 密钥', hidden: true })).toBeInTheDocument()
})

it('uses matching CLI cards and loads only the expanded signed-in account without mixing API details', async () => {
  bridge()
  const read = vi.fn().mockResolvedValue({ backend: 'claude', email: 'cli@example.test', plan_type: 'max', source: 'local_profile' })
  window.agentsDock.providerAccounts = { read }
  useAppStore.setState({ runtimeCatalog: { backends: { claude: { native_credentials_present: true } } } as never })
  render(<AppSettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: 'My Agents' }))
  expect(document.querySelectorAll('.cli-account-card.codex-auth-settings')).toHaveLength(3)
  expect(read).not.toHaveBeenCalled()
  const group = screen.getByText('Claude Code', { selector: 'summary strong' }).closest('details')!
  group.open = true
  fireEvent(group, new Event('toggle'))
  expect(await screen.findByText('Email: cli@example.test')).toBeVisible()
  expect(screen.getByText('Plan: max')).toBeVisible()
  expect(read).toHaveBeenCalledExactlyOnceWith({ profileId: 'studio', profileGeneration: 1 }, 'claude')
  fireEvent.click(screen.getByRole('button', { name: 'General' }))
  expect(screen.queryByText('Email: cli@example.test')).not.toBeInTheDocument()
})

function claudeCatalog(authenticated: boolean | null): RuntimeCatalog {
  return { backends: { claude: {
    models: [], efforts: [], native_credentials_present: true,
    diagnostic: { backend: 'claude', installed: true, authenticated, available: authenticated === true,
      status: authenticated === null ? 'unknown' : authenticated ? 'ready' : 'unauthenticated',
      message: '', checked_at: authenticated ? '2026-10-01T12:01:00Z' : '2026-10-01T12:00:00Z' }
  } } }
}

it.each(['en', 'zh-CN'] as const)('does not mark expired Claude credentials connected after Recheck (%s)', async locale => {
  const api = bridge()
  setLocale(locale)
  useAppStore.setState({ runtimeCatalog: claudeCatalog(false) })
  api.runtime.catalog.mockResolvedValue(claudeCatalog(false))
  render(<AppSettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'My Agents' : '我的 Agent' }))
  const check = () => {
    const group = screen.getByText('Claude Code', { selector: 'summary strong' }).closest('details')!
    expect(group).not.toHaveClass('is-connected')
    expect(group.querySelector('.cli-account-card')).not.toHaveClass('connection-connected')
    expect(within(group).getByText(locale === 'en' ? 'Not signed in' : '未登录')).toBeInTheDocument()
    expect(within(group).getByText('claude auth login')).toBeInTheDocument()
  }
  check()
  fireEvent.click(document.querySelector('.app-settings-provider-context button')!)
  await waitFor(() => expect(api.runtime.catalog).toHaveBeenCalledExactlyOnceWith(true))
  await waitFor(() => expect(document.querySelector('.app-settings-provider-context button')).toBeEnabled())
  check()
})

it('shows detected credentials as unverified without a green check or mandatory re-login', () => {
  bridge()
  useAppStore.setState({ runtimeCatalog: claudeCatalog(null) })
  render(<AppSettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: 'My Agents' }))
  const group = screen.getByText('Claude Code', { selector: 'summary strong' }).closest('details')!
  expect(group).not.toHaveClass('is-connected')
  expect(within(group).getAllByText('Sign-in not confirmed')).toHaveLength(2)
  expect(within(group).getByText('Credentials found on the server. Sign-in is checked when you send a message.')).toBeInTheDocument()
  expect(within(group).queryByText('claude auth login')).not.toBeInTheDocument()
})

it('restores the verified check after a later successful native authentication result', async () => {
  const api = bridge()
  useAppStore.setState({ runtimeCatalog: claudeCatalog(false) })
  api.runtime.catalog.mockResolvedValue(claudeCatalog(true))
  render(<AppSettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: 'My Agents' }))
  fireEvent.click(document.querySelector('.app-settings-provider-context button')!)
  await waitFor(() => expect(screen.getByText('Claude Code', { selector: 'summary strong' }).closest('details')).toHaveClass('is-connected'))
  const group = screen.getByText('Claude Code', { selector: 'summary strong' }).closest('details')!
  expect(group.querySelector('.cli-account-card')).toHaveClass('connection-connected')
  expect(within(group).getByText('Signed in')).toBeInTheDocument()
  expect(within(group).queryByText('claude auth login')).not.toBeInTheDocument()
})

it('keeps a verified custom API connected without claiming that the native CLI is signed in', async () => {
  bridge()
  window.agentsDock.providerConnections = { request: vi.fn().mockResolvedValue({ configuration: {
    backend: 'claude', scope: 'per_chat', revision: 1, configured: true, has_api_key: true,
    base_url: 'https://api.example.test', model: 'test-model', protocol: 'anthropic', auth_header: 'x-api-key',
    checked_at: '2026-10-01T12:00:00Z', last_result: 'verified'
  } }) }
  useAppStore.setState({ runtimeCatalog: claudeCatalog(false) })
  render(<AppSettingsDialog />)
  fireEvent.click(screen.getByRole('button', { name: 'My Agents' }))
  const group = screen.getByText('Claude Code', { selector: 'summary strong' }).closest('details')!
  await waitFor(() => expect(group).toHaveClass('is-connected'))
  expect(within(group).getByRole('region', { name: 'Claude Code custom endpoint', hidden: true })).toHaveClass('connection-connected')
  expect(group.querySelector('.cli-account-card')).not.toHaveClass('connection-connected')
  expect(within(group).getByText('Not signed in')).toBeInTheDocument()
})
