import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, WorkspaceProfileScope } from '@shared/types'
import { setLocale } from '@shared/i18n'
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
afterEach(() => { cleanup(); setLocale('en') })
const mount = (value = session) => render(<SessionSubagentSettings session={value} profileScope={scope} />)
const automaticSession = (limit: number | null, state: 'applied' | 'pending' | 'next_start', effective: number | null, requested = limit): Session => ({
  ...session, subagent_limit: limit, subagent_limit_control: {
    ...session.subagent_limit_control!, applies_to: 'automatically_when_idle',
    application_state: state, effective_limit: effective, requested_limit: requested
  }
})
describe('chat sub-agent limit', () => {
  it('shows the saved and active limits separately until the server applies the change', async () => {
    const pending = automaticSession(64, 'pending', 16)
    update.mockResolvedValueOnce(pending)
    const view = mount(automaticSession(16, 'applied', 16))
    expect(screen.getByRole('status')).toHaveTextContent('Active limit: 16.')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '64' } })
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Limit saved: 64. Active limit: 16.'))
    expect(screen.getByRole('status')).toHaveTextContent('after this chat and its sub-agents finish their current work')
    expect(screen.queryByText(/Reload provider/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(update).toHaveBeenCalledExactlyOnceWith('chat', { subagent_limit: 64 }, scope)

    view.rerender(<SessionSubagentSettings profileScope={scope} session={pending} />)
    expect(screen.getByRole('status')).toHaveTextContent('Limit saved: 64. Active limit: 16.')
    view.rerender(<SessionSubagentSettings profileScope={scope} session={automaticSession(64, 'applied', 64)} />)
    expect(screen.getByRole('status')).toHaveTextContent('Active limit: 64.')
    expect(screen.getByRole('status')).not.toHaveTextContent('Limit saved')
    expect(update).toHaveBeenCalledOnce()

    // A later setting from another client must replace the old save reply.
    view.rerender(<SessionSubagentSettings profileScope={scope} session={automaticSession(32, 'pending', 64)} />)
    expect(screen.getByRole('status')).toHaveTextContent('Limit saved: 32. Active limit: 64.')
    expect(screen.getByRole('textbox')).toHaveValue('32')
  })
  it('does not overwrite a newer applied update with an older pending save reply', async () => {
    let resolve!: (value: Session) => void
    update.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const view = mount(automaticSession(16, 'applied', 16))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '64' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    view.rerender(<SessionSubagentSettings profileScope={scope} session={automaticSession(64, 'applied', 64)} />)
    await act(async () => resolve(automaticSession(64, 'pending', 16)))
    expect(screen.getByRole('status')).toHaveTextContent('Active limit: 64.')
    expect(screen.getByRole('status')).not.toHaveTextContent('Active limit: 16.')
    expect(screen.getByRole('textbox')).toHaveValue('64')
  })
  it('keeps the real active limit and editable draft when an automatic save fails', async () => {
    update.mockRejectedValueOnce(new Error('Unable to save'))
    mount(automaticSession(16, 'applied', 16))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '64' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to save')
    expect(screen.getByRole('status')).toHaveTextContent('Active limit: 16.')
    expect(screen.getByRole('status')).not.toHaveTextContent('64')
    expect(screen.getByRole('textbox')).toHaveValue('64')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })
  it('shows the resolved server default when clearing a chat override', async () => {
    update.mockResolvedValueOnce(automaticSession(null, 'pending', 64, 32))
    mount(automaticSession(64, 'applied', 64))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Limit saved: 32. Active limit: 64.'))
    expect(update).toHaveBeenCalledExactlyOnceWith('chat', { subagent_limit: null }, scope)
    expect(screen.getByRole('textbox')).toHaveValue('')
  })
  it('does not fabricate an active number when the server cannot report one', () => {
    mount(automaticSession(null, 'pending', null))
    expect(screen.getByRole('status')).toHaveTextContent('Limit saved: Default.')
    expect(screen.getByRole('status')).not.toHaveTextContent('Active limit:')
    expect(screen.getByRole('status')).not.toHaveTextContent(/null|undefined/)
    expect(update).not.toHaveBeenCalled()
  })
  it('describes an unloaded chat limit without requiring a manual reload', () => {
    mount(automaticSession(64, 'next_start', null))
    expect(screen.getByRole('status')).toHaveTextContent('Limit saved: 64. Applies automatically when this chat next starts.')
    expect(screen.queryByText(/Reload provider/)).not.toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })
  it('translates pending and active limits', () => {
    setLocale('zh-CN')
    mount(automaticSession(64, 'pending', 16))
    expect(screen.getByRole('status')).toHaveTextContent('已保存上限：64。当前生效的上限：16。')
    expect(screen.getByRole('status')).toHaveTextContent('完成当前任务后将自动应用')
  })
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
