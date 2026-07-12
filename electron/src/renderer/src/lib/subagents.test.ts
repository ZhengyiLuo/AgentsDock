import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { subagentsFromEvents } from './subagents'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  seq,
  id: `event-${seq}`,
  session_id: 'chat-1',
  run_id: 'run-1',
  type,
  ts: `2026-07-12T10:00:${String(seq).padStart(2, '0')}Z`,
  ...patch
})

describe('subagentsFromEvents', () => {
  it('tracks a Claude local agent through progress, child tools, and completion', () => {
    const tool = { id: 'tool-agent', name: 'Agent', input: { description: 'Audit the renderer', subagent_type: 'general-purpose' } }
    const agents = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'claude', tool }),
      event(2, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tool-agent', description: 'Audit the renderer', subagent_type: 'general-purpose', task_type: 'local_agent' }) }),
      event(3, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'system', subtype: 'task_progress', task_id: 'task-1', description: 'Reading Timeline.tsx' }) }),
      event(4, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'assistant', parent_tool_use_id: 'tool-agent', message: { content: [{ type: 'tool_use', name: 'Bash', input: { description: 'Running timeline tests' } }] } }) }),
      event(5, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', summary: 'Found one scroll race' }) })
    ])

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ id: 'task-1', name: 'Audit the renderer', backend: 'claude', status: 'completed', latestActivity: 'Found one scroll race' })
    expect(agents[0].log.map(item => item.text)).toEqual(expect.arrayContaining(['Reading Timeline.tsx', 'Running timeline tests', 'Found one scroll race']))
  })

  it('ignores Claude background bash tasks that are not subagents', () => {
    const agents = subagentsFromEvents([
      event(1, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'bash-1', task_type: 'local_bash', description: 'Render video' }) })
    ])
    expect(agents).toEqual([])
  })

  it('merges a projected live state into the durable Claude tool lifecycle', () => {
    const tool = { id: 'tool-agent', name: 'Agent', input: { description: 'Audit the renderer' } }
    const agents = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'claude', tool }),
      event(4, 'subagent_state', {
        backend: 'claude',
        subagent_id: 'task-1',
        subagent_tool_id: 'tool-agent',
        subagent_name: 'Audit the renderer',
        subagent_kind: 'general-purpose',
        subagent_status: 'running',
        subagent_activity: 'Running timeline tests',
        subagent_started_at: '2026-07-12T10:00:01Z',
        subagent_log: [{ ts: '2026-07-12T10:00:04Z', text: 'Running timeline tests' }]
      })
    ])
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ id: 'task-1', status: 'running', latestActivity: 'Running timeline tests' })
  })

  it('keeps a Codex collaborator live after spawn and closes it with the parent turn', () => {
    const tool = { id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'scroll_audit', fork_turns: 'all' } }
    const running = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'codex', tool }),
      event(2, 'tool_finished', { backend: 'codex', tool_id: 'spawn-1', tool, output: '{"task_name":"/root/scroll_audit"}' })
    ])
    expect(running[0]).toMatchObject({ name: 'scroll_audit', backend: 'codex', status: 'running', providerRef: '/root/scroll_audit' })

    const finished = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'codex', tool }),
      event(2, 'tool_finished', { backend: 'codex', tool_id: 'spawn-1', tool, output: '{"task_name":"/root/scroll_audit"}' }),
      event(3, 'turn_finished', { backend: 'codex', exit_code: 0 })
    ])
    expect(finished[0].status).toBe('completed')
  })

  it('stops active collaborators when the parent turn is stopped', () => {
    const tool = { id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'scroll_audit' } }
    const agents = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'codex', tool }),
      event(2, 'turn_stopped', { backend: 'codex' })
    ])
    expect(agents[0].status).toBe('stopped')
  })
})
