import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '@shared/i18n'
import { SideChatController } from '../lib/side-chat'
import { useAppStore } from '../store/app-store'
import { InspectorWorkspace, type InspectorWorkspaceTab } from './InspectorWorkspace'

vi.mock('./Inspector', () => ({ Inspector: () => <aside className="inspector"><div className="inspector-scroll">Session details</div></aside> }))

const scope = { profileId: 'server-a', profileGeneration: 7 }
const session = { id: 'chat-a', title: 'Research', backend: 'codex' as const }
let controller: SideChatController
let cancel: ReturnType<typeof vi.fn>
let hide: ReturnType<typeof vi.fn<() => void>>

function Workspace({ initialTab = 'sidechat', review = false }: { initialTab?: InspectorWorkspaceTab; review?: boolean }) {
  const [tab, setTab] = useState(initialTab)
  return <InspectorWorkspace session={session} scope={scope} controller={controller} tab={tab} onTabChange={setTab}
    onHide={hide} focusVersion={0} visible review={review ? <div>Code review content</div> : undefined} />
}

beforeEach(() => {
  setLocale('en')
  controller = new SideChatController()
  cancel = vi.fn().mockResolvedValue({ status: 'cancelled' })
  hide = vi.fn()
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    sideQuestions: { ask: vi.fn(() => new Promise(() => undefined)), cancel }, native: { openExternal: vi.fn() }
  } })
  useAppStore.setState({ activeProfileId: scope.profileId, profileGeneration: scope.profileGeneration, switchingProfileId: null,
    connected: true, health: { ok: true, capabilities: { side_questions: { available: true, version: 1, backends: ['codex'], history: true, max_question_chars: 8000 } } },
    sessions: [session], selectedSessionId: session.id })
})
afterEach(() => { cleanup(); controller.reset(); vi.restoreAllMocks() })

describe('Inspector workspace', () => {
  it('loads Details only while active and restores its scroll across tab switches and dock remounts', () => {
    const view = render(<Workspace />)
    expect(screen.queryByText('Session details')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
    const scroll = screen.getByText('Session details')
    scroll.scrollTop = 280
    fireEvent.click(screen.getByRole('tab', { name: 'Side chat' }))
    expect(screen.queryByText('Session details')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
    expect(screen.getByText('Session details').scrollTop).toBe(280)
    view.unmount()
    render(<Workspace initialTab="details" />)
    expect(screen.getByText('Session details').scrollTop).toBe(280)
  })

  it('returns from Review and hides without clearing the side draft or cancelling its response', () => {
    const view = render(<Workspace review />)
    fireEvent.change(screen.getByLabelText('Side message'), { target: { value: 'Question?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send side message' }))
    fireEvent.change(screen.getByLabelText('Side message'), { target: { value: 'Follow-up draft' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    expect(screen.getByText('Code review content')).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'Side chat' }))
    expect(screen.queryByText('Code review content')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Side message')).toHaveValue('Follow-up draft')
    expect(screen.getByRole('button', { name: 'Cancel side response' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }))
    expect(hide).toHaveBeenCalledOnce()
    view.unmount()
    expect(cancel).not.toHaveBeenCalled()
    expect(controller.snapshot(scope, session.id).draft).toBe('Follow-up draft')
    expect(controller.snapshot(scope, session.id).pending).toBeTruthy()
  })

  it('supports keyboard selection of all available tabs', () => {
    render(<Workspace initialTab="details" review />)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Details' }), { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Review' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Side chat' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Side message')).toHaveFocus()
  })
})
