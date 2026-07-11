import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { useAppStore } from '../store/app-store'
import { Composer } from './Composer'

describe('Composer', () => {
  afterEach(cleanup)

  beforeEach(() => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Chat', backend: 'codex' }],
      snapshots: {},
      uploadsBySession: {},
      uploadPathsBySession: {},
      drafts: {},
      activeSessionIds: new Set(),
      runtimeCatalog: null
    })
  })

  it('mounts with empty per-chat upload state without an external-store render loop', () => {
    render(<Composer />)
    expect(screen.getByPlaceholderText('Message')).toBeInTheDocument()
  })

  it('renders queued turns in a compact action shelf above the editor', () => {
    useAppStore.setState({
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
          events: [],
          queuedTurns: [{ queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Check the latest training status', display_prompt: 'Check the latest training status', file_ids: [], position: 1 }],
          files: [],
          hasMoreEvents: false,
          filesTotal: 0,
          cachedAt: 0
        }
      }
    })

    render(<Composer />)

    expect(screen.getByText('Queued turns')).toBeInTheDocument()
    expect(screen.getByText('Check the latest training status')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Steer' })).toBeInTheDocument()
    expect(screen.getByTitle('Drag to reorder')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Message')).toBeInTheDocument()
  })

  it('reports queue action failures instead of leaving an unhandled rejection', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        queue: {
          runNow: vi.fn().mockRejectedValue(new Error('Queued turn not found')),
          list: vi.fn().mockResolvedValue([{ queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Run this', file_ids: [] }])
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      error: null,
      snapshots: {
        'chat-1': {
          session: { id: 'chat-1', title: 'Chat', backend: 'codex' }, events: [],
          queuedTurns: [{ queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Run this', file_ids: [], position: 1 }],
          files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
        }
      }
    })
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByRole('button', { name: 'Steer' }))

    await waitFor(() => expect(useAppStore.getState().error).toBe('Queued turn not found'))
  })

  it('preserves text typed while a failed send is still in flight', async () => {
    let rejectSend!: (error: Error) => void
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send: vi.fn(() => new Promise((_resolve, reject) => { rejectSend = reject })) }
      } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')

    await user.type(editor, 'First request')
    await user.click(screen.getByTitle('Send message'))
    await user.type(editor, 'Next request')
    await act(async () => rejectSend(new Error('offline')))

    await waitFor(() => expect(editor).toHaveValue('First request\n\nNext request'))
  })

  it('uses Command-Enter to steer a new message immediately', async () => {
    const send = vi.fn().mockResolvedValue({
      session: { id: 'chat-1', title: 'Chat', backend: 'codex' },
      queued: true,
      queued_id: 'queued-steer'
    })
    const runNow = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
        turns: { send },
        queue: { runNow, list: vi.fn().mockResolvedValue([]) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ activeSessionIds: new Set(['chat-1']) })
    render(<Composer />)
    const editor = screen.getByPlaceholderText('Message')
    fireEvent.change(editor, { target: { value: 'Steer this now' } })
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })

    await waitFor(() => expect(runNow).toHaveBeenCalledWith('chat-1', 'queued-steer'))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat-1', prompt: 'Steer this now' }))
    expect(editor).toHaveValue('')
  })
})
