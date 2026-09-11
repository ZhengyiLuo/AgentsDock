import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { WelcomeChat } from './WelcomeChat'

vi.mock('../assets/agentsdock-icon.png', () => ({ default: 'agentsdock-icon.png' }))

describe('WelcomeChat', () => {
  const openExternal = vi.fn()

  beforeEach(() => {
    openExternal.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { native: { openExternal } } as unknown as AgentsDockAPI
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the intro with a numbered four-step guide and the token command', () => {
    render(<WelcomeChat />)
    expect(screen.getByRole('heading', { name: 'Welcome to AgentsDock' })).toBeInTheDocument()
    expect(screen.getByText(/Set up your server/)).toBeInTheDocument()
    expect(screen.getByText(/Get your access token/)).toBeInTheDocument()
    expect(screen.getByText(/Connect your server/)).toBeInTheDocument()
    expect(screen.getByText(/Start chatting/)).toBeInTheDocument()
    expect(screen.getByText('./install.sh --show-token')).toBeInTheDocument()
    expect(screen.getByRole('list').querySelectorAll('li')).toHaveLength(4)
  })

  it('opens the guided setup dialog and the setup guide', async () => {
    const listener = vi.fn()
    window.addEventListener('agentsdock:server-setup', listener)
    const user = userEvent.setup()
    render(<WelcomeChat />)

    await user.click(screen.getByRole('button', { name: 'Connect to your AgentsServer' }))
    expect(listener).toHaveBeenCalled()
    window.removeEventListener('agentsdock:server-setup', listener)

    await user.click(screen.getByRole('button', { name: /Setup guide/ }))
    expect(openExternal).toHaveBeenCalledWith('https://agentsdock.net/setup.html')
  })

  it('replies locally with a canned message when the user sends something', async () => {
    let frame: FrameRequestCallback | undefined
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frame = callback
      return 1
    })
    const user = userEvent.setup()
    render(<WelcomeChat />)

    const input = screen.getByRole('textbox', { name: /welcome preview/i })
    const list = document.querySelector<HTMLElement>('.welcome-chat-scroll')
    expect(list).not.toBeNull()
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 240 })
    await user.type(input, 'hello{Enter}')

    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(screen.getByText(/isn't connected to a real agent yet/i)).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(() => frame?.(0)).not.toThrow()
    expect(list?.scrollTop).toBe(240)
  })
})
