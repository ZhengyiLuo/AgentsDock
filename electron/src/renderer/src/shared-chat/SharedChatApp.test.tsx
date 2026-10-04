import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeFileRef } from '@shared/types'
import { createSharedChatBridge, type SharedChatState } from './bridge'
import { SharedChatApp } from './SharedChatApp'

const fixture = vi.hoisted(() => ({
  state: {
    sessions: [{ id: 'shared-one', title: 'Shared chat', backend: 'codex' }],
    health: null,
    error: null as string | null,
    connected: false,
    syncStatus: 'offline',
    syncError: null as string | null,
    selectedSessionId: 'shared-one',
    setError: vi.fn(),
    attachPathsForSession: vi.fn()
  }
}))

vi.mock('../store/app-store', () => ({ useAppStore: Object.assign(
  (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
  { getState: () => fixture.state }
) }))
vi.mock('../lib/i18n', () => ({ useLocale: () => 'en' }))
vi.mock('@shared/i18n', () => ({ t: (key: string) => ({
  'chatShare.web.scope': 'Shared chat',
  'chatShare.web.offline': 'You’re offline. Your draft is safe on this page.',
  'chatShare.web.reconnecting': 'Reconnecting',
  'chatShare.web.disconnected': 'Disconnected',
  'chatShare.web.retry': 'Retry',
  'chatShare.web.settings': 'Settings',
  'chatShare.web.dismiss': 'Dismiss',
  'chatShare.web.settingsHelp': 'Settings help',
  'chatShare.web.close': 'Close'
}[key] ?? key) }))
vi.mock('../components/Timeline', () => ({ Timeline: () => <div>Timeline</div> }))
vi.mock('../components/Composer', () => ({ Composer: ({ writeDisabled, dropActive }: { writeDisabled?: boolean; dropActive?: boolean }) => <div>
  <textarea aria-label="Message" defaultValue="Draft while offline" />
  <button type="button" disabled={writeDisabled}>Send</button>
  {dropActive && <span>Drop to attach</span>}
</div> }))
vi.mock('../components/CodexRuntimeContext', () => ({ CodexRuntimeProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../components/ClaudeRuntimeContext', () => ({ ClaudeRuntimeProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../components/CodexControls', () => ({ CodexStatusButton: () => null }))
vi.mock('../components/CodexInteractionShelf', () => ({ CodexInteractionShelf: () => null }))
vi.mock('../components/ClaudeInteractionShelf', () => ({ ClaudeInteractionShelf: () => null }))
vi.mock('../components/ScheduledJobsPopover', () => ({ ScheduledJobsPopover: () => null }))
vi.mock('../components/Dialogs', () => ({ JobDialog: () => null }))
vi.mock('../components/Inspector', () => ({ SessionPromptField: () => null }))

const previousAPI = window.agentsDock
beforeEach(() => {
  fixture.state.connected = false
  fixture.state.syncStatus = 'offline'
  fixture.state.selectedSessionId = 'shared-one'
})
afterEach(() => {
  cleanup(); vi.clearAllMocks()
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: previousAPI })
})

describe('SharedChatApp connection recovery', () => {
  it('keeps the draft editable, gates Send, and exposes an explicit retry while offline', () => {
    const retry = vi.fn()
    render(<SharedChatApp onRetry={retry} />)
    expect(screen.getByRole('status')).toHaveTextContent('You’re offline')
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Draft while offline')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it.each([1, 6])('uploads %i dropped browser Files through the same bridge as the file chooser', async count => {
    const prefix = '/interactive-chat/interactive_' + '1'.repeat(32)
    const state = { revision: '1111111111111111:1', csrf: 'synthetic-csrf', session: fixture.state.sessions[0],
      events: [], queue: [], active: false, jobs: [], goal: { goal: null } } as unknown as SharedChatState
    let uploads = 0
    const uploadedBodies: File[] = []
    const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/state')) return new Response(JSON.stringify(state))
      const file = init?.body as File
      uploadedBodies.push(file)
      return new Response(JSON.stringify({ id: `upload_${++uploads}`, name: file.name,
        media_type: file.type || 'application/octet-stream', byte_size: file.size }))
    })
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await bridge.refresh()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: bridge.api })
    fixture.state.connected = true
    fixture.state.syncStatus = 'live'
    fixture.state.attachPathsForSession.mockImplementation(async (id: string, refs: NativeFileRef[]) => {
      await bridge.api.files.upload(id, refs.map(ref => ref.path))
    })
    const files = Array.from({ length: count }, (_, index) => new File([
      count > 1 && index === 0 ? new Uint8Array(9 * 1024 * 1024) : 'browser drop'
    ], `dropped-${index}.txt`, { type: 'text/plain' }))
    const { container } = render(<SharedChatApp onRetry={vi.fn()} />)
    const shell = container.querySelector('.shared-chat-shell')!
    const dataTransfer = { types: ['Files'], files, dropEffect: 'none' }
    const drag = createEvent.dragOver(shell, { dataTransfer })
    fireEvent(shell, drag)
    expect(drag.defaultPrevented).toBe(true)
    expect(dataTransfer.dropEffect).toBe('copy')
    expect(screen.getByText('Drop to attach')).toBeInTheDocument()
    const drop = createEvent.drop(screen.getByRole('textbox', { name: 'Message' }), { dataTransfer })
    fireEvent(screen.getByRole('textbox', { name: 'Message' }), drop)
    expect(drop.defaultPrevented).toBe(true)
    await waitFor(() => expect(uploadedBodies).toHaveLength(count))
    expect(uploadedBodies).toEqual(files)
    for (let index = 0; index < count; index++) expect(uploadedBodies[index]).toBe(files[index])
    expect(fixture.state.attachPathsForSession).toHaveBeenCalledTimes(1)
    expect(fixture.state.setError).not.toHaveBeenCalled()
    expect(screen.queryByText('Drop to attach')).toBeNull()
    expect(request).toHaveBeenCalledTimes(count + 1)
    bridge.close()
  })
})
