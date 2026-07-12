import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { useAppStore } from '../store/app-store'
import { DigestDialog } from './Dialogs'

const preview = vi.fn()
const send = vi.fn()

describe('DigestDialog', () => {
  afterEach(cleanup)

  beforeEach(() => {
    preview.mockReset().mockResolvedValue('# ZenithDock Context Digest\n\nReady.')
    send.mockReset().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { digest: { preview, send } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [{ id: 'source', title: 'Source chat', backend: 'codex', folder: 'Research' }],
      selectedSessionId: 'source',
      folderOrder: ['Research', 'Jobs'],
      runtimeCatalog: null,
      error: null,
      modals: {
        settings: false,
        newChat: false,
        resume: false,
        folder: false,
        digest: true,
        job: false,
        search: false,
        review: false
      }
    })
  })

  it('selects the first valid target when sessions arrive after the dialog opens', async () => {
    render(<DigestDialog />)
    expect(screen.getByRole('button', { name: 'Send to chat' })).toBeDisabled()

    useAppStore.setState({
      sessions: [
        { id: 'source', title: 'Source chat', backend: 'codex', folder: 'Research' },
        { id: 'target', title: 'Target chat', backend: 'claude', folder: 'Jobs' }
      ]
    })

    expect(await screen.findByRole('option', { name: /Target chat/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Send to chat' })).toBeEnabled()
  })

  it('keeps the dialog open and reports a rejected background request', async () => {
    send.mockResolvedValue(false)
    useAppStore.setState({
      sessions: [
        { id: 'source', title: 'Source chat', backend: 'codex' },
        { id: 'target', title: 'Target chat', backend: 'claude' }
      ]
    })
    render(<DigestDialog />)
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: 'Send to chat' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)

    expect(await screen.findByText('The server did not accept the digest request.')).toBeInTheDocument()
    expect(useAppStore.getState().modals.digest).toBe(true)
  })

  it('renders the LLM preview and sends the selected detail and prompt', async () => {
    useAppStore.setState({
      sessions: [
        { id: 'source', title: 'Source chat', backend: 'codex' },
        { id: 'target', title: 'Target chat', backend: 'claude' }
      ]
    })
    render(<DigestDialog />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('What should the target agent focus on?'), 'Focus on deployment')
    await user.click(screen.getByRole('button', { name: 'Deep' }))
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    expect(await screen.findByText(/# ZenithDock Context Digest/)).toBeInTheDocument()
    expect(preview).toHaveBeenCalledWith({
      sourceSessionId: 'source',
      targetSessionId: 'target',
      detail: 'deep',
      userPrompt: 'Focus on deployment'
    })
  })
})
