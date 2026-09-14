import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@shared/i18n'
import type { Event } from '@shared/types'
import { isSubagentActive, subagentDetailText, subagentDisplayName, subagentLogText, subagentStatusLabel, subagentsFromEvents } from './subagents'
afterEach(() => setLocale('en'))

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
  it('uses the exact Codex display title and retains its nickname and path separately', () => {
    const [agent] = subagentsFromEvents([event(1, 'subagent_state', {
      backend: 'codex', subagent_id: 'child-1', subagent_status: 'running',
      subagent_title: 'Public resources', subagent_nickname: 'Kepler the 2nd',
      subagent_name: 'Kepler the 2nd', subagent_path: '/root/public_resources'
    })])
    expect(subagentDisplayName(agent)).toBe('Public resources')
    expect(subagentDetailText(agent)).toBe('Kepler the 2nd')
    expect(subagentLogText(agent)).toContain('Kepler the 2nd')
    expect(subagentLogText(agent)).toContain('/root/public_resources')
    setLocale('zh-CN')
    expect(subagentDisplayName(agent)).toBe('Public resources')
  })

  it('keeps one child through rename, missing or malformed titles, and explicit clear', () => {
    const state = (seq: number, extra: Partial<Event> = {}) => event(seq, 'subagent_state', {
      backend: 'codex', subagent_id: 'child-1', subagent_status: 'completed',
      subagent_started_at: '2026-07-12T09:00:00Z', ...extra
    })
    const events = [
      state(1, { subagent_title: 'Initial audit', subagent_nickname: 'Kepler the 2nd' }),
      state(2, { subagent_title: 'Review letters audit' }),
      state(3), state(4, { subagent_title: { wrong: 'shape' } as unknown as string }),
      state(5, { subagent_title: '[AgentsDock context] internal context' })
    ]
    const [agent] = subagentsFromEvents(events)
    expect(subagentsFromEvents(events)).toHaveLength(1)
    expect(subagentDisplayName(agent)).toBe('Review letters audit')
    expect(agent).toMatchObject({ key: 'codex:subagent:child-1', status: 'completed',
      startedAt: '2026-07-12T09:00:00Z' })
    for (const cleared of [null, '', '  ']) {
      const [after] = subagentsFromEvents([...events, state(6, { subagent_title: cleared }), state(7)])
      expect(subagentDisplayName(after)).toBe('Kepler the 2nd')
      expect(after.key).toBe(agent.key)
      expect(isSubagentActive(after)).toBe(false)
    }
  })

  it('does not turn a cleared title into a persistent fallback name', () => {
    const [agent] = subagentsFromEvents([
      event(1, 'subagent_state', { subagent_id: 'child-1', subagent_status: 'running',
        subagent_title: 'Publications audit', subagent_name: 'Codex subagent' }),
      event(2, 'subagent_state', { subagent_id: 'child-1', subagent_status: 'running', subagent_title: null })
    ])
    expect(subagentDisplayName(agent)).toBe('Codex subagent')
  })

  it('renames a completed child without changing its original lifecycle time or key', () => {
    const completed = event(1, 'subagent_state', { backend: 'codex', subagent_id: 'child-1',
      subagent_title: 'Initial audit', subagent_nickname: 'Kepler the 2nd', subagent_status: 'completed',
      subagent_started_at: '2026-07-12T09:59:00Z', subagent_activity: 'Audit complete' })
    // Identity snapshots carry a new sequence but the server retains lifecycle ts.
    const renamed = { ...completed, seq: 2, id: 'event-2', subagent_title: 'Public resources' }
    const [before] = subagentsFromEvents([completed])
    const [after] = subagentsFromEvents([completed, renamed])
    expect(subagentDisplayName(after)).toBe('Public resources')
    expect(after).toMatchObject({ key: before.key, startedAt: before.startedAt,
      updatedAt: before.updatedAt, status: 'completed', log: before.log })
    expect(isSubagentActive(after)).toBe(false)
  })

  it('keeps exact-owner tracking loss inactive despite late raw or structured progress', () => {
    const raw = (seq: number, subtype: string, run = 'run-1') => event(seq, 'raw_event', {
      backend: 'claude', run_id: run,
      raw: JSON.stringify({ type: 'system', subtype, task_id: 'same-task', task_type: 'local_agent', tool_use_id: 'tool-one', description: 'Late progress' })
    })
    const state = (seq: number, status: string) => event(seq, 'subagent_state', {
      backend: 'claude', run_id: 'run-1', subagent_id: 'same-task', subagent_tool_id: 'tool-one',
      subagent_status: status, subagent_activity: 'Completion is not confirmed'
    })
    const agents = subagentsFromEvents([
      raw(1, 'task_started'), state(2, 'tracking_lost'), raw(3, 'task_progress'),
      raw(4, 'task_started'), state(5, 'running'), raw(6, 'task_started', 'new-owner'), raw(7, 'task_progress')
    ])
    expect(agents).toHaveLength(2)
    const lost = agents.find(agent => agent.runId === 'run-1')!
    expect(lost.status).toBe('tracking_lost')
    expect(lost.latestActivity).toBe('Completion is not confirmed')
    expect(isSubagentActive(lost)).toBe(false)
    expect(isSubagentActive(agents.find(agent => agent.runId === 'new-owner')!)).toBe(true)
    setLocale('en')
    expect(subagentStatusLabel(lost.status)).toBe('Tracking lost')
    expect(subagentLogText(lost)).toContain('Tracking lost')
  })

  it('recognizes an explicitly observed killed task as inactive', () => {
    const [agent] = subagentsFromEvents([event(1, 'subagent_state', { backend: 'claude', subagent_id: 'task', subagent_status: 'killed' })])
    expect(agent.status).toBe('killed')
    expect(isSubagentActive(agent)).toBe(false)
  })
  it('localizes generated progress and logs without translating names, statuses, or provider output', () => {
    const events = [
      event(1, 'tool_started', { backend: 'claude', tool: { id: 'tool-a', name: 'Agent', input: { description: 'Review Prompt' } } }),
      event(2, 'tool_finished', { backend: 'claude', tool_id: 'tool-a', tool: { id: 'tool-a', name: 'Agent' }, output: 'Working on /tmp/Agent.txt' })
    ]
    setLocale('zh-CN')
    const [agent] = subagentsFromEvents(events)
    expect(agent.name).toBe('Review Prompt')
    expect(agent.status).toBe('completed')
    expect(agent.log.map(entry => entry.text)).toEqual(['正在启动 Review Prompt', 'Working on /tmp/Agent.txt'])
    expect(subagentLogText(agent)).toContain('已完成')
    expect(subagentLogText(agent)).toContain('Working on /tmp/Agent.txt')
    setLocale('en')
    expect(subagentsFromEvents(events)[0].log[0].text).toBe('Starting Review Prompt')
  })

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

  it.each([
    ['turn_finished', { exit_code: 0 }],
    ['turn_stopped', {}],
    ['error', { error: 'parent failed' }]
  ])('keeps a Codex collaborator live after parent %s', (terminalType, patch) => {
    const tool = { id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'scroll_audit', fork_turns: 'all' } }
    const agents = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'codex', tool }),
      event(2, 'tool_finished', { backend: 'codex', tool_id: 'spawn-1', tool, output: '{"task_name":"/root/scroll_audit"}' }),
      event(3, terminalType, { backend: 'codex', ...patch })
    ])
    expect(agents[0]).toMatchObject({ name: 'scroll_audit', backend: 'codex', status: 'running', providerRef: '/root/scroll_audit' })
  })

  it('uses a stopped parent turn only for a non-authoritative Claude fallback', () => {
    const tool = { id: 'claude-agent', name: 'Agent', input: { description: 'Audit the renderer' } }
    const agents = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'claude', tool }),
      event(2, 'turn_finished', { backend: 'claude', stopped: true })
    ])
    expect(agents[0].status).toBe('stopped')
  })

  it('treats projected state as provider-neutral and keys it by child thread ID', () => {
    const tool = { id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'lifecycle_audit' } }
    const agents = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'codex', run_id: 'logical-run-1', tool }),
      event(2, 'subagent_state', {
        backend: 'codex',
        run_id: 'logical-run-1',
        subagent_id: 'child-thread-1',
        subagent_tool_id: 'spawn-1',
        subagent_name: 'Inspect lifecycle',
        subagent_kind: 'collaborator',
        subagent_status: 'pendingInit',
        subagent_provider_ref: 'child-thread-1'
      }),
      event(3, 'tool_finished', {
        backend: 'codex',
        run_id: 'logical-run-1',
        tool_id: 'spawn-1',
        tool,
        output: '{"task_name":"/root/lifecycle_audit"}'
      }),
      event(4, 'subagent_state', {
        backend: 'codex',
        run_id: 'logical-run-2',
        subagent_id: 'child-thread-1',
        subagent_tool_id: 'spawn-1',
        subagent_name: 'Inspect lifecycle',
        subagent_kind: 'collaborator',
        subagent_status: 'running',
        subagent_provider_ref: 'child-thread-1'
      })
    ])

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      key: 'codex:subagent:child-thread-1',
      id: 'child-thread-1',
      runId: 'logical-run-2',
      backend: 'codex',
      status: 'running',
      providerRef: 'child-thread-1'
    })
  })

  it('merges a cold-upgrade child snapshot with its prior Codex spawn card', () => {
    const tool = { id: 'spawn-legacy', name: 'spawn_agent', input: { task_name: 'lifecycle_audit' } }
    const agents = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'codex', run_id: 'old-run', tool }),
      event(2, 'tool_finished', {
        backend: 'codex',
        run_id: 'old-run',
        tool_id: 'spawn-legacy',
        tool,
        output: '{"task_name":"/root/lifecycle_audit"}'
      }),
      event(10, 'subagent_state', {
        backend: 'codex',
        run_id: null,
        subagent_id: 'child-thread-1',
        subagent_tool_id: 'child-thread-1',
        subagent_name: 'Inspect lifecycle',
        subagent_status: 'running',
        subagent_provider_ref: 'child-thread-1'
      })
    ])

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      key: 'codex:subagent:child-thread-1',
      id: 'child-thread-1',
      name: 'Inspect lifecycle',
      status: 'running',
      providerRef: 'child-thread-1'
    })
  })

  it('preserves a new unmatched spawn after a cold-upgrade child snapshot', () => {
    const legacy = { id: 'spawn-legacy', name: 'spawn_agent', input: { task_name: 'legacy_audit' } }
    const fresh = { id: 'spawn-fresh', name: 'spawn_agent', input: { task_name: 'fresh_audit' } }
    const agents = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'codex', run_id: 'old-run', tool: legacy }),
      event(2, 'tool_finished', {
        backend: 'codex',
        run_id: 'old-run',
        tool_id: 'spawn-legacy',
        tool: legacy,
        output: '{"task_name":"/root/legacy_audit"}'
      }),
      event(10, 'subagent_state', {
        backend: 'codex',
        run_id: null,
        subagent_id: 'legacy-child',
        subagent_tool_id: 'legacy-child',
        subagent_status: 'completed'
      }),
      event(11, 'tool_started', { backend: 'codex', run_id: 'new-run', tool: fresh }),
      event(12, 'tool_finished', {
        backend: 'codex',
        run_id: 'new-run',
        tool_id: 'spawn-fresh',
        tool: fresh,
        output: '{"task_name":"/root/fresh_audit"}'
      })
    ])

    expect(agents).toHaveLength(2)
    expect(agents.map(agent => agent.id)).toEqual(expect.arrayContaining(['legacy-child', 'spawn-fresh']))
    expect(agents.find(agent => agent.id === 'spawn-fresh')).toMatchObject({
      name: 'fresh_audit',
      status: 'running'
    })
  })

  it('applies an explicit targeted state update to only that child', () => {
    const state = (seq: number, childId: string, status: string): Event => event(seq, 'subagent_state', {
      backend: 'codex',
      subagent_id: childId,
      subagent_tool_id: childId,
      subagent_name: childId,
      subagent_status: status,
      subagent_provider_ref: childId
    })
    const agents = subagentsFromEvents([
      state(1, 'child-a', 'running'),
      state(2, 'child-b', 'running'),
      state(3, 'child-a', 'interrupted')
    ])
    const byId = new Map(agents.map(agent => [agent.id, agent]))

    expect(byId.get('child-a')?.status).toBe('stopped')
    expect(byId.get('child-b')?.status).toBe('running')
  })

  it('does not let a parent terminal event override authoritative Claude state', () => {
    const agents = subagentsFromEvents([
      event(1, 'subagent_state', {
        backend: 'claude',
        subagent_id: 'task-1',
        subagent_tool_id: 'tool-agent',
        subagent_status: 'running'
      }),
      event(2, 'turn_finished', { backend: 'claude', stopped: true })
    ])

    expect(agents[0].status).toBe('running')
  })

  it('ignores generic Codex coordination calls while preserving explicit spawned agents', () => {
    const operations = [
      'wait',
      'wait_agent',
      'list_agents',
      'sendInput',
      'send_message',
      'followup_task',
      'interrupt_agent',
      'resumeAgent',
      'closeAgent'
    ]
    const coordinationEvents = operations.map((description, index) => event(index + 2, 'tool_started', {
      tool: { id: `coordination-${index}`, name: 'Agent', input: { description } }
    }))
    const spawn = { id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'real_audit' } }

    const agents = subagentsFromEvents([
      event(1, 'turn_started', { backend: 'codex' }),
      ...coordinationEvents,
      event(20, 'tool_started', { tool: spawn }),
      event(21, 'tool_finished', {
        tool_id: 'spawn-1',
        tool: spawn,
        output: '{"task_name":"/root/real_audit"}'
      })
    ], 'codex')

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      name: 'real_audit',
      backend: 'codex',
      status: 'running',
      providerRef: '/root/real_audit'
    })
  })

  it('uses the owning chat backend for provider events that omit backend metadata', () => {
    const tool = { id: 'tool-agent', name: 'Agent', input: { description: 'Audit the renderer' } }
    const agents = subagentsFromEvents([
      event(1, 'tool_started', { backend: undefined, tool })
    ], 'claude')

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      name: 'Audit the renderer',
      backend: 'claude',
      status: 'starting'
    })
  })

  it('keeps legacy Codex spawnAgent events while hiding legacy coordination calls', () => {
    const spawn = {
      id: 'legacy-spawn',
      name: 'Agent',
      input: { description: 'spawnAgent' }
    }
    const agents = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'codex', tool: spawn }),
      event(2, 'tool_finished', {
        backend: 'codex',
        tool_id: 'legacy-spawn',
        tool: spawn,
        output: '{"task_name":"/root/legacy_audit"}'
      }),
      event(3, 'tool_started', {
        backend: 'codex',
        tool: { id: 'legacy-wait', name: 'Agent', input: { description: 'wait' } }
      })
    ], 'codex')

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      backend: 'codex',
      status: 'running',
      providerRef: '/root/legacy_audit'
    })
  })

  it('does not hide a Claude agent merely because its description is wait', () => {
    const agents = subagentsFromEvents([
      event(1, 'tool_started', {
        backend: 'claude',
        tool: { id: 'claude-wait', name: 'Agent', input: { description: 'wait' } }
      })
    ], 'claude')

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      backend: 'claude',
      name: 'wait',
      status: 'starting'
    })
  })

  it('keeps a useful agent path when a later projected preview contains AgentsDock context', () => {
    const agents = subagentsFromEvents([
      event(1, 'subagent_state', {
        backend: 'codex',
        subagent_id: 'child-1',
        subagent_name: '/root/crash_log_correlation',
        subagent_status: 'running'
      }),
      event(2, 'subagent_state', {
        backend: 'codex',
        subagent_id: 'child-1',
        subagent_name: '[AgentsDock context] You are responding through AgentsDock.',
        subagent_status: 'completed'
      })
    ])

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      name: '/root/crash_log_correlation',
      path: '/root/crash_log_correlation',
      status: 'completed'
    })
    expect(subagentDisplayName(agents[0])).toBe('crash_log_correlation')
    expect(subagentDetailText(agents[0])).toBe('/root/crash_log_correlation')
    expect(agents[0].name).not.toContain('[AgentsDock context]')
  })

  it('keeps a useful spawn identity when a later projected name is only a provider placeholder', () => {
    const tool = { id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'readonly_round2' } }
    const [agent] = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'codex', tool }),
      event(2, 'tool_finished', {
        backend: 'codex',
        tool_id: 'spawn-1',
        tool,
        output: '{"task_name":"/root/readonly_round2"}'
      }),
      event(3, 'subagent_state', {
        backend: 'codex',
        subagent_id: 'child-1',
        subagent_tool_id: 'spawn-1',
        subagent_name: 'Codex subagent',
        subagent_status: 'running'
      })
    ])

    expect(agent).toMatchObject({
      name: 'readonly_round2',
      task: 'readonly_round2',
      path: '/root/readonly_round2'
    })
    expect(subagentDisplayName(agent)).toBe('readonly_round2')
    expect(subagentDetailText(agent)).toBe('/root/readonly_round2')
  })

  it('does not let a native child-thread placeholder outrank an authoritative agent path', () => {
    const tool = { id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'child-thread-1' } }
    const [agent] = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'codex', tool }),
      event(2, 'subagent_state', {
        backend: 'codex',
        subagent_id: 'child-thread-1',
        subagent_tool_id: 'spawn-1',
        subagent_name: '/root/readonly_round2',
        subagent_path: '/root/readonly_round2',
        subagent_status: 'running'
      })
    ])

    expect(agent).toMatchObject({
      task: 'child-thread-1',
      path: '/root/readonly_round2'
    })
    expect(subagentDisplayName(agent)).toBe('readonly_round2')
    expect(subagentDetailText(agent)).toBe('/root/readonly_round2')
    expect(subagentLogText(agent)).not.toContain('Task: child-thread-1')
  })

  it('updates a Claude task label from its authoritative task-started event', () => {
    const tool = {
      id: 'tool-agent',
      name: 'Agent',
      input: { description: 'Initial wrapper description', subagent_type: 'general-purpose' }
    }
    const [agent] = subagentsFromEvents([
      event(1, 'tool_started', { backend: 'claude', tool }),
      event(2, 'raw_event', {
        backend: 'claude',
        raw: JSON.stringify({
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-1',
          tool_use_id: 'tool-agent',
          description: 'Authoritative task description',
          subagent_type: 'general-purpose',
          task_type: 'local_agent'
        })
      })
    ])

    expect(agent).toMatchObject({
      name: 'Authoritative task description',
      task: 'Authoritative task description'
    })
    expect(subagentDisplayName(agent)).toBe('Authoritative task description')
  })

  it('prefers explicit authoritative nicknames while retaining path and task labels', () => {
    const state = event(1, 'subagent_state', {
      backend: 'codex',
      subagent_id: 'child-1',
      subagent_status: 'running'
    })
    Object.assign(state, {
      subagent_nickname: 'Leibniz the 2nd',
      subagent_path: '/root/readonly_round2',
      subagent_task: 'Investigate read-only files'
    })

    const [agent] = subagentsFromEvents([state])

    expect(agent).toMatchObject({
      name: 'Leibniz the 2nd',
      nickname: 'Leibniz the 2nd',
      path: '/root/readonly_round2',
      task: 'Investigate read-only files'
    })
    expect(subagentDisplayName(agent)).toBe('Leibniz the 2nd')
    expect(subagentDetailText(agent)).toBe('/root/readonly_round2')
  })
})
