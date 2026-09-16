import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { SideQuestionAnswer } from '@shared/side-questions'
import { setLocale } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { SideQuestionPanel } from './SideQuestionPanel'

const session = { id: 'chat-a', title: 'Research', backend: 'codex' as const }
const scope = { profileId: 'server-a', profileGeneration: 7 }
const capability = { available: true, version: 1, backends: ['codex', 'claude'] as Array<'codex' | 'claude'>, max_question_chars: 8000 }
let ask: ReturnType<typeof vi.fn>
let cancel: ReturnType<typeof vi.fn>
let sendTurn: ReturnType<typeof vi.fn>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function submit(question = 'What does this step mean?') {
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
}

beforeEach(() => {
  setLocale('en')
  ask = vi.fn()
  cancel = vi.fn().mockImplementation((_scope, _sessionId, requestId) => Promise.resolve({ request_id: requestId, status: 'cancelled' }))
  sendTurn = vi.fn()
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    sideQuestions: { ask, cancel }, turns: { send: sendTurn },
    native: { openExternal: vi.fn() }
  } as unknown as AgentsDockAPI })
  useAppStore.setState({ activeProfileId: scope.profileId, profileGeneration: scope.profileGeneration,
    switchingProfileId: null, connected: true, health: { ok: true, capabilities: { side_questions: capability } },
    sessions: [session], selectedSessionId: session.id })
})

afterEach(() => { cleanup(); setLocale('en'); vi.restoreAllMocks() })

describe('SideQuestionPanel', () => {
  it('keeps ask/answer transient and does not mutate chat state or send turns', async () => {
    ask.mockImplementation((_scope, sessionId, input) => Promise.resolve({ request_id: input.request_id,
      session_id: sessionId, backend: 'codex', answer: 'A separate explanation.', context_note: 'Recent visible messages only.' }))
    render(<SideQuestionPanel session={session} onClose={() => undefined} />)
    const before = useAppStore.getState()
    const listener = vi.fn()
    const unsubscribe = useAppStore.subscribe(listener)
    submit()
    expect(await screen.findByText('A separate explanation.')).toBeVisible()
    expect(screen.getByText('Recent visible messages only.')).toBeVisible()
    expect(ask).toHaveBeenCalledExactlyOnceWith(scope, session.id, { request_id: expect.any(String), question: 'What does this step mean?' })
    expect(useAppStore.getState()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    expect(sendTurn).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('cancels only its own request and ignores its eventual answer', async () => {
    const response = deferred<SideQuestionAnswer>()
    ask.mockReturnValue(response.promise)
    render(<SideQuestionPanel session={session} onClose={() => undefined} />)
    submit()
    const requestId = ask.mock.calls[0][2].request_id
    fireEvent.click(screen.getByRole('button', { name: 'Cancel side question' }))
    expect(cancel).toHaveBeenCalledExactlyOnceWith(scope, session.id, requestId)
    await act(async () => response.resolve({ request_id: requestId, session_id: session.id, backend: 'codex', answer: 'Too late' }))
    expect(screen.queryByText('Too late')).not.toBeInTheDocument()
    expect(screen.getByText('Side question cancelled. Your main task continues.')).toBeVisible()
    expect(sendTurn).not.toHaveBeenCalled()
  })

  it('cancels on unmount using the original profile and session', async () => {
    ask.mockReturnValue(new Promise(() => undefined))
    const view = render(<SideQuestionPanel session={session} onClose={() => undefined} />)
    submit()
    const requestId = ask.mock.calls[0][2].request_id
    view.unmount()
    expect(cancel).toHaveBeenCalledExactlyOnceWith(scope, session.id, requestId)
  })

  it('discards an old profile response and resets local text on a server change', async () => {
    const response = deferred<SideQuestionAnswer>()
    ask.mockReturnValue(response.promise)
    render(<SideQuestionPanel session={session} onClose={() => undefined} />)
    submit('Old profile question')
    const requestId = ask.mock.calls[0][2].request_id
    act(() => useAppStore.setState({ activeProfileId: 'server-b', profileGeneration: 8 }))
    expect(cancel).toHaveBeenCalledWith(scope, session.id, requestId)
    await act(async () => response.resolve({ request_id: requestId, session_id: session.id, backend: 'codex', answer: 'Old profile answer' }))
    expect(screen.getByLabelText('Question')).toHaveValue('')
    expect(screen.queryByText('Old profile answer')).not.toBeInTheDocument()
  })

  it('discards a reply after the displayed session changes', async () => {
    const response = deferred<SideQuestionAnswer>()
    ask.mockReturnValue(response.promise)
    const view = render(<SideQuestionPanel session={session} onClose={() => undefined} />)
    submit()
    const requestId = ask.mock.calls[0][2].request_id
    view.rerender(<SideQuestionPanel session={{ ...session, id: 'chat-b', title: 'Other' }} onClose={() => undefined} />)
    expect(cancel).toHaveBeenCalledWith(scope, session.id, requestId)
    await act(async () => response.resolve({ request_id: requestId, session_id: session.id, backend: 'codex', answer: 'Wrong session answer' }))
    expect(screen.queryByText('Wrong session answer')).not.toBeInTheDocument()
  })

  it.each(['old-server', 'cursor', 'shared-guest'] as const)('shows a read-only explanation for %s with no prompt fallback', kind => {
    if (kind === 'old-server') useAppStore.setState({ health: { ok: true } })
    if (kind === 'shared-guest') Object.defineProperty(window.agentsDock, 'sharedChat', { value: true })
    render(<SideQuestionPanel session={kind === 'cursor' ? { ...session, backend: 'cursor' } : session} onClose={() => undefined} />)
    expect(screen.getByRole('status')).toHaveTextContent('Side questions are unavailable')
    expect(screen.queryByLabelText('Question')).not.toBeInTheDocument()
    expect(ask).not.toHaveBeenCalled()
    expect(sendTurn).not.toHaveBeenCalled()
  })

  it('honors the advertised limit and shows useful errors without retries', async () => {
    useAppStore.setState({ health: { ok: true, capabilities: { side_questions: { ...capability, max_question_chars: 8 } } } })
    ask.mockRejectedValue(new Error('side_question_http_429: Too many requests'))
    render(<SideQuestionPanel session={session} onClose={() => undefined} />)
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: '123456789' } })
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled()
    submit('Why?')
    expect(await screen.findByRole('alert')).toHaveTextContent('maximum number of side questions')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled())
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('uses Chinese UI labels', () => {
    setLocale('zh-CN')
    render(<SideQuestionPanel session={session} onClose={() => undefined} />)
    expect(screen.getByRole('dialog', { name: '顺便问一下' })).toBeVisible()
    expect(screen.getByRole('button', { name: '提问' })).toBeDisabled()
  })
})
