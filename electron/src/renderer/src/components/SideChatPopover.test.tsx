import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '@shared/i18n'
import type { SyncedSideChat } from '@shared/side-questions'
import { SideChatController } from '../lib/side-chat'
import { useAppStore } from '../store/app-store'
import { SideChatPopover } from './SideChatPopover'

const scope = { profileId: 'a', profileGeneration: 7, serverIdentity: 'server-a' }
const session = { id: 'parent', title: 'Research', backend: 'codex' as const }
function chat(id: string, question?: string): SyncedSideChat {
  return { session_id: session.id, side_chat_id: id, conversation_id: id, revision: question ? 1 : 0, last_request_id: question ? id : null,
    exchanges: question ? [{ request_id: id, question, status: 'completed', answer: `Answer for ${question}`, created_at: 'now', updated_at: 'now' }] : [] }
}
beforeEach(() => {
  localStorage.clear()
  setLocale('en')
  useAppStore.setState({ activeProfileId: 'a', profileGeneration: 7, switchingProfileId: null, connected: true,
    syncBySession: {}, syncSessionId: null, syncStatus: 'idle', runtimeCatalog: null,
    profiles: [{ id: 'a', name: 'A', serverUrl: 'http://server-a', serverIdentity: 'server-a', hasAccessToken: true,
      connectionState: 'online', serverSetupComplete: true, cachedUnreadCount: 0 }],
    health: { ok: true, capabilities: { side_questions: { available: true, version: 2, native_context: true, sync: true, multiple: true, max_question_chars: 8000, backends: ['codex', 'claude'] } } } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('multiple side-chat tabs', () => {
  it('resizes from the corner, clamps to the window, and restores size after reopening', async () => {
    const api = { list: vi.fn().mockResolvedValue({ session_id: session.id, side_chats: [chat('original')] }) }
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: api, events: { on: () => () => undefined } } })
    const controller = new SideChatController()
    const view = render(<SideChatPopover session={session} scope={scope} controller={controller} open focusVersion={0} onOpenChange={() => undefined} />)
    await screen.findByRole('tab', { name: 'Chat 1' })
    const handle = screen.getByRole('button', { name: /Resize side chat/ })
    const popup = handle.closest('.side-chat-popover') as HTMLElement
    vi.spyOn(popup, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 300 } as DOMRect)
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 500, clientY: 300 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 100 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(popup.style.width).toBe('600px')
    expect(popup.style.height).toBe('500px')
    view.unmount()
    render(<SideChatPopover session={session} scope={scope} controller={controller} open focusVersion={0} onOpenChange={() => undefined} />)
    const reopened = screen.getByRole('button', { name: /Resize side chat/ }).closest('.side-chat-popover') as HTMLElement
    expect(reopened.style.width).toBe('600px')
    expect(reopened.style.height).toBe('500px')
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(400)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(350)
    fireEvent(window, new Event('resize'))
    expect(reopened.style.width).toBe('376px')
    expect(reopened.style.height).toBe('326px')
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('shows Clear as unavailable until the selected server history has loaded', async () => {
    let resolve!: (value: unknown) => void
    const api = { list: vi.fn().mockReturnValue(new Promise(done => { resolve = done })), read: vi.fn() }
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: api, events: { on: () => () => undefined } } })
    render(<SideChatPopover session={session} scope={scope} controller={new SideChatController()} open focusVersion={0} onOpenChange={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Clear side chat' })).toBeDisabled()
    await act(async () => { resolve({ session_id: session.id, side_chats: [chat('original')] }) })
    expect(screen.getByRole('button', { name: 'Clear side chat' })).toBeEnabled()
  })

  it.each(['codex', 'claude'] as const)('creates a %s tab without erasing the original history and restores drafts on selection', async backend => {
    const api = { list: vi.fn().mockResolvedValue({ session_id: session.id, side_chats: [chat('original', 'Original question')] }),
      create: vi.fn().mockImplementation((_scope, _sessionId, id) => Promise.resolve(chat(id))), read: vi.fn(),
      clear: vi.fn(), close: vi.fn(), ask: vi.fn(), cancel: vi.fn() }
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: api, native: { openExternal: vi.fn() }, events: { on: () => () => undefined } } })
    const controller = new SideChatController()
    render(<SideChatPopover session={{ ...session, backend }} scope={scope} controller={controller} open focusVersion={0} onOpenChange={() => undefined} />)
    await screen.findByText('Answer for Original question')
    const input = screen.getByRole('textbox', { name: 'Side message' })
    fireEvent.change(input, { target: { value: 'Original draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'New side chat' }))
    const second = await screen.findByRole('tab', { name: 'Chat 2' })
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveValue('')
    fireEvent.change(input, { target: { value: 'Second draft' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Chat 1' }))
    expect(input).toHaveValue('Original draft')
    expect(screen.getByText('Answer for Original question')).toBeVisible()
    fireEvent.click(second)
    expect(input).toHaveValue('Second draft')
    expect(screen.queryByText('Answer for Original question')).not.toBeInTheDocument()
    expect(api.clear).not.toHaveBeenCalled()
    expect(api.close).not.toHaveBeenCalled()
    // Tab keyboard navigation keeps a single tab stop and does not submit anything.
    fireEvent.keyDown(second, { key: 'Home' })
    expect(screen.getByRole('tab', { name: 'Chat 1' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Chat 1' })).toHaveAttribute('tabindex', '0')
    expect(second).toHaveAttribute('tabindex', '-1')
  })

  it('shows independent running activity and keeps the selected tab while the other finishes', async () => {
    const original = chat('original')
    original.revision = 1
    original.exchanges = [{ request_id: 'running', question: 'Background question', status: 'running',
      activity: [{ id: 'thinking', kind: 'reasoning', text: 'Background reasoning', status: 'running' }], created_at: 'now', updated_at: 'now' }]
    const api = { list: vi.fn().mockResolvedValue({ session_id: session.id, side_chats: [original, chat('second')] }), read: vi.fn(), ask: vi.fn(), cancel: vi.fn() }
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { sideQuestions: api, native: { openExternal: vi.fn() }, events: { on: () => () => undefined } } })
    const controller = new SideChatController()
    render(<SideChatPopover session={session} scope={scope} controller={controller} open focusVersion={0} onOpenChange={() => undefined} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Activity details' }))
    expect(screen.getByText('Background reasoning')).toBeVisible()
    expect(screen.getByLabelText('Working')).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'Chat 2' }))
    expect(screen.queryByText('Background reasoning')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel side response' })).not.toBeInTheDocument()
    api.list.mockResolvedValue({ session_id: session.id, side_chats: [chat('original', 'Completed background question'), chat('second')] })
    await act(() => controller.refresh(scope, session.id))
    expect(screen.getByRole('tab', { name: 'Chat 2' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByLabelText('Working')).not.toBeInTheDocument()
  })
})
