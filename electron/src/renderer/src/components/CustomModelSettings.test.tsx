import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { CustomModelSettings } from './CustomModelSettings'

const listed = { backend: 'claude', revision: 1, default_model: null, discovery_status: 'ready', models: [{ value: 'fixture/one', label: 'Friendly model' }] }
function bridge() {
  const api = { read: vi.fn().mockResolvedValue(listed), save: vi.fn().mockResolvedValue({ ...listed, revision: 2, default_model: 'fixture/one' }),
    check: vi.fn().mockResolvedValue({ backend: 'claude', revision: 1, model: 'fixture/one', status: 'verified', scope: 'text_request' }) }
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    customModels: api, native: { openExternal: vi.fn().mockResolvedValue(undefined) },
    providerConnections: { request: vi.fn().mockResolvedValue({ ok: true, status: 'verified' }) },
  } as unknown as AgentsDockAPI })
  return api
}
beforeEach(() => { setLocale('en'); useAppStore.setState({ connected: true, activeProfileId: 'test', profileGeneration: 1 }) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('lists endpoint models without an arbitrary default; saves only model/revision, never a key', async () => {
  const api = bridge(), saved = vi.fn()
  render(<CustomModelSettings backend="claude" active onSaved={saved} />)
  const select = await screen.findByLabelText('Default model')
  expect(select).toHaveValue('')
  expect(screen.getByRole('option', { name: 'Friendly model (fixture/one)' })).toBeVisible()
  fireEvent.change(select, { target: { value: 'fixture/one' } })
  expect(api.read).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'Save default' })).not.toBeInTheDocument()
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(api.save).toHaveBeenCalledExactlyOnceWith({ profileId: 'test', profileGeneration: 1 }, 'claude', { model: 'fixture/one', expected_revision: 1 })
  expect(window.agentsDock.providerConnections!.request).not.toHaveBeenCalled()
})

it('finishes pending setup only after explicit selection using the saved revision, not a random model', async () => {
  const api = bridge(), saved = vi.fn()
  render(<CustomModelSettings backend="claude" active verifyOnSelect baseURL="https://opencode.ai/zen/v1" onSaved={saved} />)
  const select = await screen.findByLabelText('Default model')
  expect(select).toHaveValue('')
  expect(screen.getByText(/short test request that may incur a charge/)).toBeVisible()
  expect(api.save).not.toHaveBeenCalled()
  expect(window.agentsDock.providerConnections!.request).not.toHaveBeenCalled()
  fireEvent.change(select, { target: { value: 'fixture/one' } })
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(window.agentsDock.providerConnections!.request).toHaveBeenCalledExactlyOnceWith(
    { profileId: 'test', profileGeneration: 1 }, 'claude', 'check', { expected_revision: 2 })
})

it('refreshes the list without inference and provides manual fallback only after opening it', async () => {
  const api = bridge(), saved = vi.fn()
  api.read.mockResolvedValue({ ...listed, models: [], discovery_status: 'unavailable' })
  render(<CustomModelSettings backend="claude" active verifyOnSelect baseURL="https://opencode.ai/zen/v1" onSaved={saved} />)
  await screen.findByLabelText('Default model')
  expect(screen.queryByLabelText('Model ID')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Reload models' }))
  await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2))
  fireEvent.click(await screen.findByRole('button', { name: 'Enter an unlisted model ID' }))
  const link = screen.getByRole('link', { name: 'View OpenCode Zen model IDs' })
  fireEvent.click(link)
  expect(window.agentsDock.native.openExternal).toHaveBeenCalledExactlyOnceWith('https://opencode.ai/docs/zen/#endpoints')
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'fixture/manual' } })
  expect(api.save).not.toHaveBeenCalled()
  expect(window.agentsDock.providerConnections!.request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save default' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(api.save).toHaveBeenCalledWith({ profileId: 'test', profileGeneration: 1 }, 'claude', { model: 'fixture/manual', expected_revision: 1 })
})

it('does not check another server after a model write completes late', async () => {
  const api = bridge(), saved = vi.fn()
  let finish!: (value: unknown) => void
  api.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<CustomModelSettings backend="claude" active verifyOnSelect onSaved={saved} />)
  fireEvent.change(await screen.findByLabelText('Default model'), { target: { value: 'fixture/one' } })
  act(() => useAppStore.setState({ activeProfileId: 'other', profileGeneration: 2 }))
  await act(async () => finish({ ...listed, revision: 2, default_model: 'fixture/one' }))
  expect(window.agentsDock.providerConnections!.request).not.toHaveBeenCalled()
  expect(saved).not.toHaveBeenCalled()
})

it('does not fetch collapsed cards or invent a default when listing is unavailable', async () => {
  const api = bridge()
  const props = { backend: 'claude' as const, onSaved: vi.fn() }
  const view = render(<CustomModelSettings {...props} active={false} />)
  expect(api.read).not.toHaveBeenCalled()
  api.read.mockResolvedValue({ ...listed, models: [], discovery_status: 'unavailable' })
  view.rerender(<CustomModelSettings {...props} active />)
  const input = await screen.findByRole('combobox', { name: 'Default model' })
  expect(input).toBeDisabled()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(api.read).toHaveBeenCalledTimes(1)
  expect(api.save).not.toHaveBeenCalled()
})

it('discards old-server catalogs after switching profiles', async () => {
  const api = bridge()
  let finish!: (value: unknown) => void
  api.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<CustomModelSettings backend="claude" active onSaved={vi.fn()} />)
  act(() => useAppStore.setState({ activeProfileId: 'other', profileGeneration: 2 }))
  await screen.findByLabelText('Default model')
  await act(async () => finish({ ...listed, models: [{ value: 'private/old', label: 'Old server model' }] }))
  expect(screen.queryByText(/Old server model/)).not.toBeInTheDocument()
  expect(api.read).toHaveBeenLastCalledWith({ profileId: 'other', profileGeneration: 2 }, 'claude')
})

it('checks only after explicit input, never saves a default or changes connection readiness', async () => {
  const api = bridge(), saved = vi.fn()
  api.read.mockResolvedValue({ ...listed, default_model: 'fixture/one', check_available: true })
  render(<CustomModelSettings backend="claude" active onSaved={saved} />)
  const button = await screen.findByRole('button', { name: 'Test this model' })
  expect(api.check).not.toHaveBeenCalled()
  fireEvent.click(button)
  await waitFor(() => expect(api.check).toHaveBeenCalledExactlyOnceWith(
    { profileId: 'test', profileGeneration: 1 }, 'claude', { model: 'fixture/one', expected_revision: 1 }))
  expect(await screen.findByText(/Text request succeeded/)).toBeVisible()
  expect(api.save).not.toHaveBeenCalled()
  expect(saved).not.toHaveBeenCalled()
  expect(window.agentsDock.providerConnections!.request).not.toHaveBeenCalled()
})

it('does not disable a model for quota errors and discards a late check after switching servers', async () => {
  const api = bridge()
  api.read.mockResolvedValue({ ...listed, default_model: 'fixture/one', check_available: true })
  api.check.mockResolvedValue({ status: 'rate_limited' })
  render(<CustomModelSettings backend="claude" active onSaved={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Test this model' }))
  await screen.findByText(/quota/i)
  expect(screen.getByRole('option', { name: 'Friendly model (fixture/one)' })).not.toBeDisabled()
  let finish!: (result: unknown) => void
  api.check.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Test this model' }))
  act(() => useAppStore.setState({ activeProfileId: 'other', profileGeneration: 2 }))
  await screen.findByRole('button', { name: 'Test this model' })
  await act(async () => finish({ status: 'model_unavailable' }))
  expect(screen.getByRole('option', { name: 'Friendly model (fixture/one)' })).not.toBeDisabled()
})
