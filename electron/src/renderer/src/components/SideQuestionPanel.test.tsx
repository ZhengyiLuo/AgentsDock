import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { SideQuestionAnswer } from '@shared/side-questions'
import { setLocale } from '@shared/i18n'
import { SideChatController } from '../lib/side-chat'
import { useAppStore } from '../store/app-store'
import { SideQuestionPanel } from './SideQuestionPanel'

const session = { id: 'chat-a', title: 'Research', backend: 'codex' as const }
const scope = { profileId: 'server-a', profileGeneration: 7 }
const capability = { available: true, version: 1, backends: ['codex', 'claude'] as Array<'codex' | 'claude'>,
  max_question_chars: 8000, history: true, max_history_items: 32, max_history_chars: 60000 }
let controller: SideChatController
let ask: ReturnType<typeof vi.fn>
let cancel: ReturnType<typeof vi.fn>
let sendTurn: ReturnType<typeof vi.fn>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}
function submit(question = 'What does this step mean?') {
  fireEvent.change(screen.getByLabelText('Side message'), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: 'Send side message' }))
}
function panel(target = session) { return <SideQuestionPanel session={target} scope={scope} controller={controller} /> }

beforeEach(() => {
  setLocale('en')
  controller = new SideChatController()
  ask = vi.fn()
  cancel = vi.fn().mockImplementation((_scope, _sessionId, requestId) => Promise.resolve({ request_id: requestId, status: 'cancelled' }))
  sendTurn = vi.fn()
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    sideQuestions: { ask, cancel }, turns: { send: sendTurn }, native: { openExternal: vi.fn() }
  } as unknown as AgentsDockAPI })
  useAppStore.setState({ activeProfileId: scope.profileId, profileGeneration: scope.profileGeneration,
    switchingProfileId: null, connected: true, health: { ok: true, capabilities: { side_questions: capability } },
    sessions: [session], selectedSessionId: session.id })
})
afterEach(() => { cleanup(); controller.reset(); setLocale('en'); vi.restoreAllMocks() })

describe('Side chat panel', () => {
  it('shows an inline multi-turn conversation and sends prior complete pairs without app-store writes', async () => {
    ask.mockImplementation((_scope, sessionId, input) => Promise.resolve({ request_id: input.request_id,
      session_id: sessionId, backend: 'codex', answer: input.history?.length ? 'Follow-up answer.' : 'First answer.', context_note: 'Recent messages only.' }))
    render(panel())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Side message')).toHaveFocus()
    const listener = vi.fn()
    const unsubscribe = useAppStore.subscribe(listener)
    submit('First question?')
    expect(await screen.findByText('First answer.')).toBeVisible()
    submit('And why?')
    expect(await screen.findByText('Follow-up answer.')).toBeVisible()
    expect(screen.getByText('First answer.')).toBeVisible()
    expect(ask.mock.calls[1][2].history).toEqual([{ role: 'user', text: 'First question?' }, { role: 'assistant', text: 'First answer.' }])
    expect(listener).not.toHaveBeenCalled()
    expect(sendTurn).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('retains an active answer and a next-message draft while the view is unmounted', async () => {
    const response = deferred<SideQuestionAnswer>()
    ask.mockReturnValue(response.promise)
    const view = render(panel())
    submit()
    const requestId = ask.mock.calls[0][2].request_id
    fireEvent.change(screen.getByLabelText('Side message'), { target: { value: 'Next draft' } })
    view.unmount()
    expect(cancel).not.toHaveBeenCalled()
    await act(async () => response.resolve({ request_id: requestId, session_id: session.id, backend: 'codex', answer: 'Completed while hidden.' }))
    render(panel())
    expect(screen.getByText('Completed while hidden.')).toBeVisible()
    expect(screen.getByLabelText('Side message')).toHaveValue('Next draft')
  })

  it('cancels only its request and ignores the eventual response without erasing messages', async () => {
    const response = deferred<SideQuestionAnswer>()
    ask.mockReturnValue(response.promise)
    render(panel())
    submit()
    const requestId = ask.mock.calls[0][2].request_id
    fireEvent.click(screen.getByRole('button', { name: 'Cancel side response' }))
    expect(cancel).toHaveBeenCalledExactlyOnceWith(scope, session.id, requestId)
    await act(async () => response.resolve({ request_id: requestId, session_id: session.id, backend: 'codex', answer: 'Too late' }))
    expect(screen.queryByText('Too late')).not.toBeInTheDocument()
    expect(screen.getByText('What does this step mean?')).toBeVisible()
    expect(screen.getByText('Response cancelled.')).toBeVisible()
  })

  it('keeps another session separate and restores the original session conversation', async () => {
    ask.mockImplementation((_scope, sessionId, input) => Promise.resolve({ request_id: input.request_id, session_id: sessionId, backend: 'codex', answer: 'Owned answer.' }))
    const view = render(panel())
    submit()
    await screen.findByText('Owned answer.')
    view.rerender(panel({ ...session, id: 'chat-b', title: 'Other' }))
    expect(screen.queryByText('Owned answer.')).not.toBeInTheDocument()
    view.rerender(panel())
    expect(screen.getByText('Owned answer.')).toBeVisible()
  })

  it('rejects followups on older servers without silently losing their context', async () => {
    useAppStore.setState({ health: { ok: true, capabilities: { side_questions: { ...capability, history: false } } } })
    ask.mockImplementation((_scope, sessionId, input) => Promise.resolve({ request_id: input.request_id, session_id: sessionId, backend: 'codex', answer: 'First answer.' }))
    render(panel())
    submit()
    await screen.findByText('First answer.')
    submit('Follow up')
    expect(await screen.findByRole('alert')).toHaveTextContent('Update AgentsServer')
    expect(ask).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Side message')).toHaveValue('Follow up')
  })

  it.each(['old-server', 'cursor', 'shared-guest'] as const)('keeps %s read-only without fallback', kind => {
    if (kind === 'old-server') useAppStore.setState({ health: { ok: true } })
    if (kind === 'shared-guest') Object.defineProperty(window.agentsDock, 'sharedChat', { value: true })
    render(<SideQuestionPanel session={kind === 'cursor' ? { ...session, backend: 'cursor' } : session} scope={scope} controller={controller} />)
    expect(screen.getByRole('status')).toHaveTextContent('Side questions are unavailable')
    expect(screen.queryByLabelText('Side message')).not.toBeInTheDocument()
    expect(sendTurn).not.toHaveBeenCalled()
  })

  it('sends Enter, preserves Shift+Enter and does not send during IME composition', async () => {
    ask.mockReturnValue(new Promise(() => undefined))
    render(panel())
    const field = screen.getByLabelText('Side message')
    fireEvent.change(field, { target: { value: 'Why?' } })
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    expect(ask).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('uses Chinese side-chat labels', () => {
    setLocale('zh-CN')
    render(panel())
    expect(screen.getByRole('region', { name: '侧边对话' })).toBeVisible()
    expect(screen.getByRole('button', { name: '发送侧边消息' })).toBeDisabled()
  })
})
