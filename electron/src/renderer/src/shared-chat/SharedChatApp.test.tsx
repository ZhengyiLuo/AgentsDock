import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    setError: vi.fn()
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
vi.mock('../components/Composer', () => ({ Composer: ({ writeDisabled }: { writeDisabled?: boolean }) => <div>
  <textarea aria-label="Message" defaultValue="Draft while offline" />
  <button type="button" disabled={writeDisabled}>Send</button>
</div> }))
vi.mock('../components/CodexRuntimeContext', () => ({ CodexRuntimeProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../components/ClaudeRuntimeContext', () => ({ ClaudeRuntimeProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../components/CodexControls', () => ({ CodexStatusButton: () => null }))
vi.mock('../components/CodexInteractionShelf', () => ({ CodexInteractionShelf: () => null }))
vi.mock('../components/ClaudeInteractionShelf', () => ({ ClaudeInteractionShelf: () => null }))
vi.mock('../components/ScheduledJobsPopover', () => ({ ScheduledJobsPopover: () => null }))
vi.mock('../components/Dialogs', () => ({ JobDialog: () => null }))
vi.mock('../components/Inspector', () => ({ SessionPromptField: () => null }))
vi.mock('../lib/native-files', () => ({ nativeFileRefsFromFiles: vi.fn() }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

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
})
