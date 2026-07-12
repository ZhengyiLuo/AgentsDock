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

  it('shows a compact live subagent section only when the chat has subagents', () => {
    const session = { id: 'chat-1', title: 'Performance check', backend: 'claude' as const }
    useAppStore.setState({
      sessions: [session],
      snapshots: {
        'chat-1': {
          session,
          events: [{
            id: 'agent-start', seq: 1, session_id: 'chat-1', run_id: 'run-1',
            type: 'tool_started', ts: '2026-07-12T10:00:00Z', backend: 'claude',
            tool: { id: 'agent-1', name: 'Agent', input: { description: 'Audit timeline performance' } }
          }],
          queuedTurns: [], files: [], hasMoreEvents: false, eventsTotal: 1, filesTotal: 0, cachedAt: 1
        }
      }
    })

    const view = render(<Inspector />)

    const section = view.container.querySelector('.subagents-section')
    expect(section).toHaveTextContent('Subagents')
    expect(section).toHaveTextContent('Audit timeline performance')
    expect(section).toHaveTextContent('1 active')
  })
})
