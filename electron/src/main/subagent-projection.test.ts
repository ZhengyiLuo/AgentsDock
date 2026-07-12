import { describe, expect, it } from 'vitest'
import type { Event } from '../shared/types'
import { SubagentEventProjector } from './subagent-projection'

const rawEvent = (seq: number, raw: object): Event => ({
  seq,
  id: `raw-${seq}`,
  session_id: 'chat-1',
  run_id: 'run-1',
  backend: 'claude',
  type: 'raw_event',
  ts: `2026-07-12T10:00:${String(seq).padStart(2, '0')}Z`,
  raw: JSON.stringify(raw)
})

describe('SubagentEventProjector', () => {
  it('keeps one bounded live record updated across Claude child events', () => {
    const projector = new SubagentEventProjector()
    const started = projector.project(rawEvent(1, { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tool-1', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Audit timeline' }))
    const activity = projector.project(rawEvent(2, { type: 'assistant', parent_tool_use_id: 'tool-1', message: { content: [{ type: 'tool_use', name: 'Bash', input: { description: 'Run timeline tests' } }] } }))
    const finished = projector.project(rawEvent(3, { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', summary: 'Found the race' }))

    expect(started).toMatchObject({ id: 'subagent:chat-1:run-1:task-1', type: 'subagent_state', subagent_status: 'running' })
    expect(activity).toMatchObject({ id: started?.id, subagent_activity: 'Run timeline tests' })
    expect(finished).toMatchObject({ id: started?.id, subagent_status: 'completed', subagent_summary: 'Found the race' })
    expect(finished?.subagent_log?.map(entry => entry.text)).toEqual(['Audit timeline', 'Run timeline tests', 'Found the race'])
    expect(finished?.raw).toBeUndefined()
  })

  it('does not project local bash background tasks', () => {
    const projector = new SubagentEventProjector()
    expect(projector.project(rawEvent(1, { type: 'system', subtype: 'task_started', task_id: 'bash-1', task_type: 'local_bash', description: 'Render' }))).toBeNull()
  })
})
