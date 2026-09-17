import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '@shared/i18n'
import { SideChatController } from '../lib/side-chat'
import { useAppStore } from '../store/app-store'
import { InspectorWorkspace, type InspectorWorkspaceTab } from './InspectorWorkspace'

const scope = { profileId: 'server-a', profileGeneration: 7 }
const session = { id: 'chat-a', title: 'Research', backend: 'codex' as const }
let controller: SideChatController
let cancel: ReturnType<typeof vi.fn>
let hide: ReturnType<typeof vi.fn<() => void>>

function Workspace({ initialTab = 'details', review = false, focusVersion = 0, onFocusHandled }: {
  initialTab?: InspectorWorkspaceTab; review?: boolean; focusVersion?: number; onFocusHandled?: () => void
}) {
  const [tab, setTab] = useState(initialTab)
  return <InspectorWorkspace session={session} scope={scope} controller={controller} tab={tab} onTabChange={setTab}
    onHide={hide} focusVersion={focusVersion} onFocusHandled={onFocusHandled} visible review={review ? <div>Code review content</div> : undefined} />
}

beforeEach(() => {
  setLocale('en')
  controller = new SideChatController()
  cancel = vi.fn().mockResolvedValue({ status: 'cancelled' })
  hide = vi.fn()
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    sideQuestions: { ask: vi.fn(() => new Promise(() => undefined)), cancel }, native: { openExternal: vi.fn() },
    pins: { list: vi.fn().mockResolvedValue([]) }, files: { list: vi.fn().mockResolvedValue({ files: [], total: 0 }) }
  } })
  useAppStore.setState({ activeProfileId: scope.profileId, profileGeneration: scope.profileGeneration, switchingProfileId: null,
    connected: true, health: { ok: true, capabilities: { side_questions: { available: true, version: 2, native_context: true, backends: ['codex'], max_question_chars: 8000 } } },
    sessions: [session], selectedSessionId: session.id, snapshots: { [session.id]: { session, files: [], queuedTurns: [], hasMoreEvents: false, filesTotal: 0, cachedAt: Date.now(), events: [{
      id: 'agent-event', session_id: session.id, seq: 1, type: 'subagent_state', ts: '2026-09-17T12:00:00Z',
      backend: 'codex', subagent_id: 'child-a', subagent_name: 'Reviewer', subagent_status: 'running'
    }] } } })
})
afterEach(() => { cleanup(); controller.reset(); vi.restoreAllMocks() })

describe('Inspector workspace', () => {
  it('shows Side chat below collapsed or expanded Media & files in one inspector with no side-chat tab or nested aside', async () => {
    const view = await act(async () => render(<Workspace />))
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(view.container.querySelectorAll('aside')).toHaveLength(1)
    const subagents = view.container.querySelector('.subagents-section')!
    const mediaToggle = screen.getByRole('button', { name: /Media & files/ })
    const media = mediaToggle.closest('.inspector-section')!
    const sideChat = view.container.querySelector('.side-chat-section')!
    expect(subagents.nextElementSibling).toBe(media)
    expect(media.nextElementSibling).toBe(sideChat)
    expect(sideChat.parentElement).toBe(media.parentElement)
    expect(screen.getByLabelText('Side message')).toBeVisible()
    expect(screen.getByLabelText('Side message')).not.toHaveFocus()
    expect(window.agentsDock.sideQuestions!.ask).not.toHaveBeenCalled()
    expect(window.agentsDock.files.list).not.toHaveBeenCalled()
    expect(media.querySelector('.media-inspector')).not.toBeInTheDocument()

    await act(async () => fireEvent.click(mediaToggle))
    expect(media.querySelector('.media-inspector')).toBeVisible()
    expect(media.nextElementSibling).toBe(sideChat)
    expect(screen.getByLabelText('Side message')).toBeVisible()
    expect(window.agentsDock.files.list).toHaveBeenCalledOnce()

    fireEvent.click(mediaToggle)
    expect(media.querySelector('.media-inspector')).not.toBeInTheDocument()
    expect(media.nextElementSibling).toBe(sideChat)
  })

  it('restores the shared inspector scroll across Review and dock remounts', async () => {
    const view = await act(async () => render(<Workspace review />))
    view.container.querySelector('.inspector-scroll')!.scrollTop = 280
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    expect(screen.queryByLabelText('Side message')).not.toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Details' })))
    expect(view.container.querySelector('.inspector-scroll')!.scrollTop).toBe(280)
    view.unmount()
    const reopened = await act(async () => render(<Workspace />))
    expect(reopened.container.querySelector('.inspector-scroll')!.scrollTop).toBe(280)
  })

  it('returns from Review and hides without clearing the side draft or cancelling its response', async () => {
    const view = await act(async () => render(<Workspace review />))
    fireEvent.change(screen.getByLabelText('Side message'), { target: { value: 'Question?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send side message' }))
    fireEvent.change(screen.getByLabelText('Side message'), { target: { value: 'Follow-up draft' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    expect(screen.getByText('Code review content')).toBeVisible()
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'Details' })))
    expect(screen.getByLabelText('Side message')).toHaveValue('Follow-up draft')
    expect(screen.getByRole('button', { name: 'Cancel side response' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }))
    expect(hide).toHaveBeenCalledOnce()
    view.unmount()
    expect(cancel).not.toHaveBeenCalled()
    expect(controller.snapshot(scope, session.id).draft).toBe('Follow-up draft')
    expect(controller.snapshot(scope, session.id).pending).toBeTruthy()
    expect(window.agentsDock.sideQuestions!.ask).toHaveBeenCalledOnce()
  })

  it('only focuses and reveals the side composer when explicitly requested', async () => {
    const handled = vi.fn()
    const scrollIntoView = vi.fn()
    const view = await act(async () => render(<Workspace />))
    const input = screen.getByLabelText('Side message')
    input.closest('.side-chat-composer')!.scrollIntoView = scrollIntoView
    view.rerender(<Workspace focusVersion={1} onFocusHandled={handled} />)
    expect(input).toHaveFocus()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(handled).toHaveBeenCalledOnce()
  })

  it('keeps keyboard Review navigation without a separate Side chat destination', async () => {
    await act(async () => render(<Workspace review />))
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Details' }), { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true')
    await act(async () => fireEvent.keyDown(screen.getByRole('tab', { name: 'Review' }), { key: 'ArrowLeft' }))
    expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: 'Side chat' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Side message')).toBeVisible()
    expect(screen.getByLabelText('Side message')).not.toHaveFocus()
  })
})
