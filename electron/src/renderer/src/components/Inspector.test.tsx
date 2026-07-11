import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { useAppStore } from '../store/app-store'
import { Inspector } from './Inspector'

describe('Inspector', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        pins: { list: vi.fn().mockResolvedValue([]) },
        files: { list: vi.fn().mockResolvedValue({ files: [], total: 0, offset: 0, limit: 60, has_more: false }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Performance check', backend: 'codex' }],
      jobs: [{ id: 'job-1', session_id: 'chat-1', title: 'Status', prompt: 'Status', interval_seconds: 3600 }],
      snapshots: {},
      runtimeCatalog: null
    })
  })

  it('mounts with derived jobs without creating a store render loop', async () => {
    render(<Inspector />)
    expect(screen.getByDisplayValue('Performance check')).toBeInTheDocument()
    expect(screen.getByText('Jobs')).toBeInTheDocument()
    expect(await screen.findByText('Status')).toBeInTheDocument()
  })

  it('renders pinned messages as readable compact previews', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        pins: {
          list: vi.fn().mockResolvedValue([{
            id: 'message:event-1', sessionId: 'chat-1', kind: 'message', eventId: 'event-1',
            title: 'Assistant', body: 'Keep this deployment command for later.', subtitle: '2:29 PM today', createdAt: 1
          }]),
          remove: vi.fn().mockResolvedValue([])
        },
        files: { list: vi.fn().mockResolvedValue({ files: [], total: 0, offset: 0, limit: 60, has_more: false }) }
      } as unknown as AgentsDockAPI
    })
    const view = render(<Inspector />)

    expect(await screen.findByText('Keep this deployment command for later.')).toBeInTheDocument()
    expect(view.container.querySelector('.pin-content')).toHaveTextContent('Assistant · 2:29 PM today')
  })
})
