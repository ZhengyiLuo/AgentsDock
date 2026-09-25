import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, WorkspaceProfileScope } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { SessionSubagentSettings } from './SessionSubagentSettings'

const scope: WorkspaceProfileScope = { profileId: 'one', profileGeneration: 4, serverIdentity: 'server-one' }
const session: Session = { id: 'chat', title: 'Chat', backend: 'codex', subagent_limit: 3,
  subagent_limit_control: { supported: true, scope: 'chat', mode: 'native_concurrent', applies_to: 'new_or_reloaded_threads' } }
const update = vi.fn()
beforeEach(() => {
  update.mockReset().mockImplementation(async (_id, patch) => ({ ...session, ...patch }))
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sessions: { update } } })
  useAppStore.setState({ activeProfileId: 'one', profileGeneration: 4, switchingProfileId: null, selectedSessionId: 'chat',
    profiles: [{ id: 'one', serverIdentity: 'server-one' }] as any, connected: true,
    health: { capabilities: { subagent_limit_v1: { version: 1, backends: ['codex', 'claude'] } } } as any,
    activeSessionIds: new Set(['chat']) })
})
afterEach(cleanup)
const mount = (value = session) => render(<SessionSubagentSettings session={value} profileScope={scope} />)
describe('chat sub-agent limit', () => {
  it('saves an active chat only on submit with its original server identity', async () => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '5' } })
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('status')
    expect(update).toHaveBeenCalledExactlyOnceWith('chat', { subagent_limit: 5 }, scope)
    expect(screen.getByText(/Reload provider when idle/)).toBeInTheDocument()
  })
  it('clears only this chat override with null', async () => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('status')
    expect(update).toHaveBeenCalledExactlyOnceWith('chat', { subagent_limit: null }, scope)
  })
  it.each(['0', '-1', '1.5', '9007199254740992'])('rejects invalid limit %s before a request', value => {
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value } })
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button')).toBeDisabled()
    expect(update).not.toHaveBeenCalled()
  })
  it('retains the draft on failure and requires an acknowledged value', async () => {
    update.mockResolvedValueOnce({ ...session, subagent_limit: 3 })
    mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button'))
    await screen.findByRole('alert')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('8')
    expect(screen.getByRole('button')).toBeEnabled()
  })
  it('ignores an old reply after server navigation', async () => {
    let resolve!: (value: Session) => void
    update.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const view = mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button'))
    act(() => useAppStore.setState({ activeProfileId: 'two', profileGeneration: 5 }))
    view.unmount()
    mount({ ...session, subagent_limit: 6 })
    await act(async () => resolve({ ...session, subagent_limit: 8 }))
    expect(screen.getByRole('textbox')).toHaveValue('6')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it('blocks old servers and explains native Claude application timing', async () => {
    act(() => useAppStore.setState({ health: { capabilities: {} } as any }))
    const view = mount()
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByText(/Update AgentsServer/)).toBeInTheDocument()
    act(() => useAppStore.setState({ health: { capabilities: { subagent_limit_v1: { version: 1 } } } as any }))
    view.rerender(<SessionSubagentSettings profileScope={scope} session={{ ...session, backend: 'claude', subagent_limit_control: { ...session.subagent_limit_control!, applies_to: 'next_idle_provider_start' } }} />)
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
    expect(screen.getByText(/background agents finish/)).toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })
  it('reports a pending native default reset without promising that thread reload applies it', () => {
    mount({ ...session, subagent_limit: null, subagent_limit_control: {
      ...session.subagent_limit_control!, applies_to: 'next_provider_process_start'
    } })
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByText(/keeps its previous limit until then/)).toBeInTheDocument()
    expect(screen.queryByText(/Reload provider when idle/)).not.toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })
})
