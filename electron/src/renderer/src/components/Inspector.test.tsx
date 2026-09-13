import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Health, RuntimeCatalog, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { Inspector } from './Inspector'

describe('Inspector', () => {
  afterEach(cleanup)

  beforeEach(() => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        pins: { list: vi.fn().mockResolvedValue([]) },
        files: { list: vi.fn().mockResolvedValue({ files: [], total: 0, offset: 0, limit: 60, has_more: false }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      activeProfileId: 'profile-a',
      profileGeneration: 0,
      selectedSessionId: 'chat-1',
      sessions: [{ id: 'chat-1', title: 'Performance check', backend: 'codex' }],
      activeSessionIds: new Set(),
      turnAdmissionTokens: {},
      jobs: [{ id: 'job-1', session_id: 'chat-1', title: 'Status', prompt: 'Status', interval_seconds: 3600 }],
      snapshots: {},
      runtimeCatalog: null,
      health: null
    })
  })

  it('does not expose route setup for automatic ambient cross-chat access', () => {
    useAppStore.setState({
      health: {
        ok: true,
        capabilities: {
          cross_chat_handoffs_v1: {
            available: true, required: false, message: '', action: null,
            version: 4, actions: ['request_reply', 'instruction'],
            supported_target_backends: ['codex', 'claude'],
            features: { agent_cross_chat_routes: false, agent_ambient_local_handoffs: true },
            ambient_local_handoffs: {
              enabled: true, policy: 'automatic', scope: 'all_same_server_chats', setup_required: false
            }
          }
        }
      }
    })

    render(<Inspector />)

    expect(screen.queryByText(/Agent handoff routes/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add agent handoff route/i })).not.toBeInTheDocument()
  })

  it('renders session-scoped sections without duplicate React keys', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      render(<Inspector />)
      const output = consoleError.mock.calls.flat().map(String).join('\n')
      expect(output).not.toMatch(/same key|duplicate key/i)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('does not show Reasoning for a Cursor chat with stale effort state', () => {
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Cursor chat', backend: 'cursor', model: 'auto', effort: 'high' }],
      health: {
        ok: true,
        capabilities: {
          cursor_backend: {
            available: true, required: false, message: 'Ready', action: null,
            version: 2, permission_modes: ['default', 'full_access', 'plan']
          }
        }
      },
      runtimeCatalog: {
        backends: {
          cursor: {
            available: true,
            models: [{ value: 'auto', label: 'Auto' }],
            efforts: []
          }
        }
      }
    })

    render(<Inspector />)

    expect(screen.queryByText('Reasoning')).not.toBeInTheDocument()
  })

  it('keeps relocated chat actions and runtime controls out of the inspector during a live admission', () => {
    useAppStore.setState({
      activeSessionIds: new Set(['chat-1']), turnAdmissionTokens: { 'chat-1': 'admission-1' },
      health: { ok: true, capabilities: { session_fork_completed_prefix_v1: {
        available: true, version: 1, supported_backends: ['codex']
      } } }
    })
    const { container } = render(<Inspector />)

    expect(screen.queryByRole('button', { name: 'Fork chat' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create digest' })).not.toBeInTheDocument()
    expect(container.querySelectorAll('.inspector-backend button')).toHaveLength(0)
    expect(screen.getByLabelText('System prompt')).toBeInTheDocument()
  })

  it('honors the durable backend lock before a provider ID is reconciled', () => {
    useAppStore.setState({
      sessions: [{
        id: 'chat-1', title: 'Performance check', backend: 'claude', backend_locked: true
      }],
      activeSessionIds: new Set(),
      turnAdmissionTokens: {}
    })

    const { container } = render(<Inspector />)

    expect(container.querySelectorAll('.inspector-backend button')).toHaveLength(0)
  })

  it('treats a reconciled Cursor session ID as a durable backend lock', () => {
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Cursor check', backend: 'cursor', cursor_session_id: 'cursor-provider-1' }]
    })

    const { container } = render(<Inspector />)

    expect(container.querySelectorAll('.inspector-backend button')).toHaveLength(0)
  })

  it('does not render a delayed file response after switching chats', async () => {
    let resolveFiles!: (page: {
      files: Array<{ id: string; session_id: string; filename: string; content_type: string }>
      total: number
      offset: number
      limit: number
      has_more: boolean
    }) => void
    const delayedFiles = new Promise<Parameters<typeof resolveFiles>[0]>(resolve => { resolveFiles = resolve })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        pins: { list: vi.fn().mockResolvedValue([]) },
        files: {
          list: vi.fn().mockReturnValue(delayedFiles),
          mediaURL: vi.fn()
        }
      } as unknown as AgentsDockAPI
    })
    const chat1 = { id: 'chat-1', title: 'First chat', backend: 'codex' as const }
    const chat2 = { id: 'chat-2', title: 'Second chat', backend: 'codex' as const }
    useAppStore.setState({
      selectedSessionId: chat1.id,
      sessions: [chat1, chat2],
      jobs: [],
      snapshots: {
        [chat1.id]: {
          session: chat1, events: [], queuedTurns: [], files: [],
          hasMoreEvents: false, filesTotal: 0, cachedAt: 1
        },
        [chat2.id]: {
          session: chat2, events: [], queuedTurns: [], files: [],
          hasMoreEvents: false, filesTotal: 0, cachedAt: 1
        }
      }
    })
    render(<Inspector />)
    fireEvent.click(screen.getByText('Media & files'))

    act(() => useAppStore.setState({ selectedSessionId: chat2.id }))
    await act(async () => {
      resolveFiles({
        files: [{
          id: 'chat-1-file',
          session_id: chat1.id,
          filename: 'first-chat-only.txt',
          content_type: 'text/plain'
        }],
        total: 1,
        offset: 0,
        limit: 60,
        has_more: false
      })
      await delayedFiles
    })

    expect(screen.queryByText('first-chat-only.txt')).not.toBeInTheDocument()
  })

  it('uses the active profile for inspector media with a reused file ID', async () => {
    const mediaURL = vi.fn((profileId: string, generation: number, sessionId: string, fileId: string) => `agentsdock-media://file/${profileId}/${generation}/${sessionId}/${fileId}`)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        pins: { list: vi.fn().mockResolvedValue([]) },
        files: {
          mediaURL,
          list: vi.fn().mockResolvedValue({ files: [], total: 0, offset: 0, limit: 60, has_more: false })
        }
      } as unknown as AgentsDockAPI
    })
    const session = { id: 'chat-1', title: 'Performance check', backend: 'codex' as const }
    useAppStore.setState({
      sessions: [session],
      snapshots: {
        'chat-1': {
          session,
          events: [], queuedTurns: [],
          files: [{ id: 'same-file', filename: 'result.png', content_type: 'image/png' }],
          hasMoreEvents: false, filesTotal: 1, cachedAt: 1
        }
      }
    })
    render(<Inspector />)
    fireEvent.click(screen.getByText('Media & files'))

    await waitFor(() => expect(mediaURL).toHaveBeenCalledWith('profile-a', 0, 'chat-1', 'same-file'))
    act(() => useAppStore.setState({ activeProfileId: 'profile-b' }))
    await waitFor(() => expect(mediaURL).toHaveBeenCalledWith('profile-b', 0, 'chat-1', 'same-file'))
  })

  it('opens workspace files and downloaded text artifacts from their inspector titles', async () => {
    const workspaceFile = {
      id: 'workspace-source',
      filename: 'policy_runner.py',
      source_path: '/work/project/robot/control/atlas_vla/policy_runner.py',
      content_type: 'text/x-python'
    }
    const artifactFile = {
      id: 'artifact-source',
      filename: 'migration-audit.md',
      source_path: '/Users/dev/.agentsdock/files/artifact-source/migration-audit.md',
      content_type: 'text/markdown'
    }
    const files = [workspaceFile, artifactFile]
    const openExternally = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        pins: {
          list: vi.fn().mockResolvedValue([]),
          put: vi.fn().mockResolvedValue([]),
          remove: vi.fn().mockResolvedValue([])
        },
        files: {
          list: vi.fn().mockResolvedValue({
            files,
            total: files.length,
            offset: 0,
            limit: 60,
            has_more: false
          }),
          mediaURL: vi.fn(),
          open: openExternally,
          save: vi.fn(),
          reveal: vi.fn()
        }
      } as unknown as AgentsDockAPI
    })
    const session = {
      id: 'chat-1',
      title: 'Performance check',
      backend: 'codex' as const,
      cwd: '/work/project'
    }
    useAppStore.setState({
      sessions: [session],
      snapshots: {
        'chat-1': {
          session,
          events: [],
          queuedTurns: [],
          files,
          hasMoreEvents: false,
          filesTotal: files.length,
          cachedAt: 1
        }
      }
    })
    const artifactOpen = vi.fn()
    window.addEventListener('agentsdock:open-agent-file', artifactOpen)
    render(<Inspector />)

    fireEvent.click(screen.getByText('Media & files'))
    fireEvent.click(await screen.findByRole('button', { name: /policy_runner\.py/i }))
    fireEvent.click(await screen.findByRole('button', { name: /migration-audit\.md/i }))

    expect(artifactOpen).toHaveBeenCalledTimes(2)
    expect((artifactOpen.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-1',
      file: workspaceFile
    })
    expect((artifactOpen.mock.calls[1][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-1',
      file: artifactFile
    })
    expect(screen.getAllByTitle('Open in Editor')).toHaveLength(2)
    expect(openExternally).not.toHaveBeenCalled()

    window.removeEventListener('agentsdock:open-agent-file', artifactOpen)
  })

  it('opens a pinned text artifact in the internal editor', async () => {
    const file = {
      id: 'pinned-source',
      filename: 'source-policy.yaml',
      source_path: '/Users/dev/.agentsdock/files/pinned-source/source-policy.yaml',
      content_type: 'application/yaml'
    }
    const session = {
      id: 'chat-1',
      title: 'Performance check',
      backend: 'codex' as const,
      cwd: '/work/project'
    }
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        pins: {
          list: vi.fn().mockResolvedValue([{
            id: `file:${file.id}`,
            sessionId: 'chat-1',
            kind: 'file',
            fileId: file.id,
            title: 'Source policy',
            createdAt: 1
          }]),
          remove: vi.fn().mockResolvedValue([])
        },
        files: {
          list: vi.fn().mockResolvedValue({
            files: [file],
            total: 1,
            offset: 0,
            limit: 60,
            has_more: false
          }),
          open: vi.fn()
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [session],
      snapshots: {
        'chat-1': {
          session,
          events: [],
          queuedTurns: [],
          files: [file],
          hasMoreEvents: false,
          filesTotal: 1,
          cachedAt: 1
        }
      }
    })
    const open = vi.fn()
    window.addEventListener('agentsdock:open-agent-file', open)
    render(<Inspector />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open Source policy' }))

    expect(open).toHaveBeenCalledOnce()
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-1',
      file
    })
    expect(screen.getByTitle('Open in Editor')).toBeInTheDocument()
    expect(window.agentsDock.files.open).not.toHaveBeenCalled()
    window.removeEventListener('agentsdock:open-agent-file', open)
  })

  it('recovers an older pinned file outside the loaded file page', async () => {
    const file = {
      id: 'legacy-pinned-source',
      filename: 'source-policy.yaml',
      source_path: '/Users/dev/.agentsdock/files/legacy-pinned-source/source-policy.yaml',
      content_type: 'application/yaml'
    }
    const session = {
      id: 'chat-1',
      title: 'Performance check',
      backend: 'codex' as const,
      cwd: '/work/project'
    }
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        pins: {
          list: vi.fn().mockResolvedValue([{
            id: `file:${file.id}`,
            sessionId: 'chat-1',
            kind: 'file',
            fileId: file.id,
            title: 'Source policy',
            createdAt: 1
          }]),
          remove: vi.fn().mockResolvedValue([])
        },
        files: {
          list: vi.fn().mockResolvedValue({ files: [], total: 0, offset: 0, limit: 60, has_more: false }),
          findEvent: vi.fn().mockResolvedValue({
            id: 'event-1',
            seq: 1,
            session_id: 'chat-1',
            type: 'artifact_created',
            ts: '2026-07-25T00:00:00Z',
            artifact: file
          }),
          open: vi.fn()
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      sessions: [session],
      snapshots: {
        'chat-1': {
          session,
          events: [],
          queuedTurns: [],
          files: [],
          hasMoreEvents: false,
          filesTotal: 0,
          cachedAt: 1
        }
      }
    })
    const open = vi.fn()
    window.addEventListener('agentsdock:open-agent-file', open)
    render(<Inspector />)

    await screen.findByTitle('Open in Editor')
    fireEvent.click(screen.getByRole('button', { name: 'Open Source policy' }))

    await waitFor(() => expect(open).toHaveBeenCalledOnce())
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-1',
      file
    })
    expect(screen.getByTitle('Open in Editor')).toBeInTheDocument()
    window.removeEventListener('agentsdock:open-agent-file', open)
  })

  it('edits the per-chat system prompt from the session inspector', () => {
    useAppStore.setState({
      sessions: [{ id: 'chat-1', title: 'Performance check', backend: 'codex', system_prompt: 'Use staging.' }]
    })
    const update = vi.spyOn(useAppStore.getState(), 'updateSession').mockResolvedValue(undefined)
    const view = render(<Inspector />)

    const prompt = view.container.querySelector('.session-prompt-field textarea') as HTMLTextAreaElement
    expect(prompt).toHaveValue('Use staging.')
    fireEvent.change(prompt, { target: { value: 'Use production only after verification.' } })
    fireEvent.blur(prompt)

    expect(update).toHaveBeenCalledWith('chat-1', { system_prompt: 'Use production only after verification.' })
    update.mockRestore()
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
    const findEvent = vi.fn()
    window.addEventListener('agentsdock:find-event', findEvent)
    try {
      const view = render(<Inspector />)

      expect(await screen.findByText('Keep this deployment command for later.')).toBeInTheDocument()
      expect(view.container.querySelector('.pin-content')).toHaveTextContent('Assistant · 2:29 PM today')
      await userEvent.setup().click(screen.getByRole('button', { name: 'Open Assistant' }))
      expect(findEvent).toHaveBeenCalledOnce()
      expect((findEvent.mock.calls[0][0] as CustomEvent).detail).toEqual({
        sessionId: 'chat-1',
        eventId: 'event-1',
        query: 'Keep this deployment command for later.'
      })
    } finally {
      window.removeEventListener('agentsdock:find-event', findEvent)
    }
  })

  it('removes a pinned item from its X button', async () => {
    const remove = vi.fn().mockResolvedValue([])
    const pinnedItem = {
      id: 'message:event-1', sessionId: 'chat-1', kind: 'message' as const, eventId: 'event-1',
      title: 'Assistant', body: 'Pinned deployment result', createdAt: 1
    }
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        pins: {
          list: vi.fn().mockResolvedValueOnce([pinnedItem]).mockResolvedValue([]),
          remove
        },
        files: { list: vi.fn().mockResolvedValue({ files: [], total: 0, offset: 0, limit: 60, has_more: false }) }
      } as unknown as AgentsDockAPI
    })
    render(<Inspector />)

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Unpin Assistant' }))

    expect(remove).toHaveBeenCalledWith(
      { profileId: 'profile-a', profileGeneration: 0, serverIdentity: null },
      'chat-1',
      'message:event-1'
    )
    await waitFor(() => expect(screen.queryByText('Pinned deployment result')).not.toBeInTheDocument())
  })

  it('reports a rejected unpin and keeps the X button usable', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('Could not unpin item'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        pins: {
          list: vi.fn().mockResolvedValue([{
            id: 'message:event-1', sessionId: 'chat-1', kind: 'message', eventId: 'event-1',
            title: 'Assistant', body: 'Pinned deployment result', createdAt: 1
          }]),
          remove
        },
        files: { list: vi.fn().mockResolvedValue({ files: [], total: 0, offset: 0, limit: 60, has_more: false }) }
      } as unknown as AgentsDockAPI
    })
    render(<Inspector />)

    const unpin = await screen.findByRole('button', { name: 'Unpin Assistant' })
    await userEvent.setup().click(unpin)

    await waitFor(() => expect(useAppStore.getState().error).toBe('Could not unpin item'))
    expect(screen.getByText('Pinned deployment result')).toBeInTheDocument()
    expect(unpin).toBeEnabled()
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

  it('shows active subagents first and keeps completed or stopped history collapsed', async () => {
    const session = { id: 'chat-1', title: 'Performance check', backend: 'codex' as const }
    useAppStore.setState({
      sessions: [session],
      snapshots: {
        'chat-1': {
          session,
          events: [
            {
              id: 'active-agent', seq: 1, session_id: 'chat-1', run_id: 'run-1',
              type: 'subagent_state', ts: '2026-07-12T10:00:00Z', backend: 'codex',
              subagent_id: 'active-1', subagent_name: 'Active audit', subagent_status: 'running'
            },
            {
              id: 'completed-agent', seq: 2, session_id: 'chat-1', run_id: 'run-1',
              type: 'subagent_state', ts: '2026-07-12T10:00:01Z', backend: 'codex',
              subagent_id: 'completed-1', subagent_name: 'Completed audit', subagent_status: 'completed'
            },
            {
              id: 'stopped-agent', seq: 3, session_id: 'chat-1', run_id: 'run-1',
              type: 'subagent_state', ts: '2026-07-12T10:00:02Z', backend: 'codex',
              subagent_id: 'stopped-1', subagent_name: 'Stopped audit', subagent_status: 'stopped'
            }
          ],
          queuedTurns: [], files: [], hasMoreEvents: false, eventsTotal: 3, filesTotal: 0, cachedAt: 1
        }
      }
    })
    const user = userEvent.setup()

    render(<Inspector />)

    expect(screen.getByRole('button', { name: /Subagents 1 active/i })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Active audit')).toBeInTheDocument()
    expect(screen.queryByText('Completed audit')).not.toBeInTheDocument()
    expect(screen.queryByText('Stopped audit')).not.toBeInTheDocument()
    const history = screen.getByRole('button', { name: /History 2 records/i })
    expect(history).toHaveAttribute('aria-expanded', 'false')

    await user.click(history)

    expect(screen.getByText('Completed audit')).toBeInTheDocument()
    expect(screen.getByText('Stopped audit')).toBeInTheDocument()
  })

  it('labels a history-only section as zero active and leaves its history closed by default', async () => {
    const session = { id: 'chat-1', title: 'Performance check', backend: 'codex' as const }
    useAppStore.setState({
      sessions: [session],
      snapshots: {
        'chat-1': {
          session,
          events: [{
            id: 'completed-agent', seq: 1, session_id: 'chat-1', run_id: 'run-1',
            type: 'subagent_state', ts: '2026-07-12T10:00:00Z', backend: 'codex',
            subagent_id: 'completed-1', subagent_name: 'Past audit', subagent_status: 'completed'
          }],
          queuedTurns: [], files: [], hasMoreEvents: false, eventsTotal: 1, filesTotal: 0, cachedAt: 1
        }
      }
    })
    const user = userEvent.setup()

    render(<Inspector />)

    const sectionToggle = screen.getByRole('button', { name: /Subagents 0 active/i })
    expect(sectionToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Past audit')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /History/i })).not.toBeInTheDocument()

    await user.click(sectionToggle)

    expect(screen.getByText('No active subagents.')).toBeInTheDocument()
    const history = screen.getByRole('button', { name: /History 1 records/i })
    expect(history).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Past audit')).not.toBeInTheDocument()

    await user.click(history)
    expect(screen.getByText('Past audit')).toBeInTheDocument()
  })

  it('does not show Codex coordination waits as subagents', () => {
    const session = { id: 'chat-1', title: 'Performance check', backend: 'codex' as const }
    useAppStore.setState({
      sessions: [session],
      snapshots: {
        'chat-1': {
          session,
          events: [{
            id: 'wait-start', seq: 1, session_id: 'chat-1', run_id: 'run-1',
            type: 'tool_started', ts: '2026-07-12T10:00:00Z',
            tool: { id: 'wait-1', name: 'Agent', input: { description: 'wait' } }
          }],
          queuedTurns: [], files: [], hasMoreEvents: false, eventsTotal: 1, filesTotal: 0, cachedAt: 1
        }
      }
    })

    const view = render(<Inspector />)

    expect(view.container.querySelector('.subagents-section')).not.toBeInTheDocument()
  })

})

function jobsAccessHealth(): Health {
  return {
    ok: true,
    capabilities: {
      provider_jobs_access_control_v1: {
        available: true,
        required: false,
        message: 'Ready',
        action: null,
        version: 1,
        modes: ['full', 'read_only', 'blocked'],
        default: 'full'
      }
    }
  }
}
