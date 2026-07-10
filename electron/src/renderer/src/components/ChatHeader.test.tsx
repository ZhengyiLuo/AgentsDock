import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { useAppStore } from '../store/app-store'
import { ChatHeader } from './ChatHeader'

describe('ChatHeader', () => {
  afterEach(cleanup)

  beforeEach(() => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: {
          get: vi.fn().mockImplementation((_key: string, fallback: unknown) => Promise.resolve(fallback)),
          set: vi.fn().mockResolvedValue(undefined)
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      connected: false,
      connectionError: 'Server unavailable',
      sessions: [],
      selectedSessionId: null,
      modals: {
        settings: false,
        newChat: false,
        resume: false,
        folder: false,
        digest: false,
        job: false,
        search: false,
        review: false
      }
    })
  })

  it('opens connection settings from the disconnected startup header', async () => {
    render(<ChatHeader />)

    const button = screen.getByRole('button', { name: 'Server connection: Offline' })
    expect(button).toHaveClass('offline')

    await userEvent.setup().click(button)

    expect(useAppStore.getState().modals.settings).toBe(true)
  })

  it('toggles the docked terminal without replacing the chat workspace', async () => {
    const toggle = vi.fn()
    useAppStore.setState({
      sessions: [{ id: 'chat', title: 'Chat', backend: 'codex' }],
      selectedSessionId: 'chat'
    })
    render(<ChatHeader terminalOpen={false} onTerminalToggle={toggle} />)

    const button = screen.getByRole('button', { name: 'Open terminal panel' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.setup().click(button)
    expect(toggle).toHaveBeenCalledOnce()
    expect(screen.queryByRole('navigation', { name: 'Chat workspace' })).not.toBeInTheDocument()
  })
})
