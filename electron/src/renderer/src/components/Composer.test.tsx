import { cleanup, render, screen } from '@testing-library/react'
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
})
