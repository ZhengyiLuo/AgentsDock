import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { CustomModelSettings } from './CustomModelSettings'

const listed = { backend: 'claude', revision: 1, default_model: null, discovery_status: 'ready', models: [{ value: 'fixture/one', label: 'Friendly model' }] }
function bridge() {
  const api = { read: vi.fn().mockResolvedValue(listed), save: vi.fn().mockResolvedValue({ ...listed, revision: 2, default_model: 'fixture/one' }) }
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { customModels: api } as unknown as AgentsDockAPI })
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
