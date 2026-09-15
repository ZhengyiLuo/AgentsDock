import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event } from '../types'
import { subagentsFromEvents, subagentDisplayName, subagentDetailText, subagentLogText, isSubagentActive } from './subagents'

const event = (seq: number, patch: Partial<Event> = {}): Event => ({ id: `e${seq}`, seq, session_id: 'chat', ts: `2026-09-14T10:00:${String(seq % 60).padStart(2, '0')}Z`, type: 'subagent_state', backend: 'codex', run_id: 'run', subagent_id: 'child', subagent_status: 'running', ...patch })
const native = (seq: number, patch: Record<string, unknown> = {}) => event(seq, patch as Partial<Event>)

test('native headings prefer explicit title, task, path leaf, then nickname without changing identity', () => {
  const projected = subagentsFromEvents([native(1, { subagent_title: 'Exact title', subagent_task: 'audit_tests', subagent_nickname: 'Kepler', subagent_path: '/root/worker' })])
  assert.equal(subagentDisplayName(projected[0]), 'Exact title')
  assert.equal(subagentDetailText(projected[0]), 'Kepler')
  const task = subagentsFromEvents([native(1, { subagent_task: 'audit_tests', subagent_nickname: 'Kepler' })])[0]
  assert.equal(subagentDisplayName(task), 'Audit tests')
  assert.equal(task.key, 'codex:subagent:child')
  assert.equal(task.id, 'child')
  assert.equal(subagentDisplayName(subagentsFromEvents([native(1, { subagent_path: '/root/audit_tests', subagent_nickname: 'Kepler' })])[0]), 'Audit tests')
  assert.equal(subagentDisplayName(subagentsFromEvents([native(1, { subagent_name: 'Kepler', subagent_nickname: 'Kepler' })])[0]), 'Kepler')
})
test('omitted title preserves it and explicit clear falls back while keeping selected key', () => {
  const base = native(1, { subagent_title: 'Review', subagent_task: 'check_layout' })
  assert.equal(subagentDisplayName(subagentsFromEvents([base, native(2)])[0]), 'Review')
  for (const clear of [null, '', '  ']) {
    const value = subagentsFromEvents([base, native(2, { subagent_title: clear })])[0]
    assert.equal(subagentDisplayName(value), 'Check layout'); assert.equal(value.key, 'codex:subagent:child')
  }
})
test('native Codex child follows status across parent runs and is not finished by parent completion', () => {
  const rows = subagentsFromEvents([native(1), event(2, { type: 'turn_finished' }), native(3, { run_id: 'new-run', subagent_status: 'completed' })])
  assert.equal(rows.length, 1); assert.equal(rows[0].runId, 'new-run'); assert.equal(isSubagentActive(rows[0]), false)
  assert.equal(isSubagentActive(subagentsFromEvents([native(1), event(2, { type: 'turn_finished' })])[0]), true)
})
test('Claude task identities include owner run; delayed running cannot revive retired owner', () => {
  const rows = subagentsFromEvents([event(1, { backend: 'claude', subagent_status: 'completed' }), event(2, { backend: 'claude' }), event(3, { backend: 'claude', run_id: 'new-run' })])
  assert.equal(rows.length, 2)
  assert.equal(rows.find(value => value.runId === 'run')?.status, 'completed')
  assert.equal(rows.find(value => value.runId === 'new-run')?.status, 'running')
})
test('tool spawn aliases adopt authoritative native identity, title and status without duplication', () => {
  const rows = subagentsFromEvents([
    event(1, { type: 'tool_started', tool: { id: 'tool', name: 'spawn_agent', input: { task_name: 'verify_work' } } }),
    event(2, { type: 'tool_finished', tool_id: 'tool', tool: { id: 'tool', name: 'spawn_agent' }, output: '{"agent_id":"child","agent_nickname":"Ada"}' }),
    native(3, { subagent_tool_id: 'tool', subagent_title: 'Verified work', subagent_status: 'completed' }),
  ])
  assert.equal(rows.length, 1); assert.equal(rows[0].key, 'codex:subagent:child'); assert.equal(rows[0].status, 'completed')
  assert.equal(subagentDisplayName(rows[0]), 'Verified work')
})
test('coordination-only tools never fabricate native children', () => {
  const rows = subagentsFromEvents(['wait', 'list_agents', 'send_message', 'followup_task', 'interrupt_agent', 'resume_agent'].map((operation, index) => event(index, { type: 'tool_started', tool: { id: `tool${index}`, name: 'agent', input: { operation } } })))
  assert.deepEqual(rows, [])
})
test('raw Claude task lifecycle and output are scoped to its exact parent tool', () => {
  const raw = (seq: number, value: unknown) => event(seq, { type: 'raw_event', backend: 'claude', raw: JSON.stringify(value) })
  const rows = subagentsFromEvents([
    raw(1, { type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'task', tool_use_id: 'tool', description: 'Inspect tests' }),
    raw(2, { type: 'assistant', parent_tool_use_id: 'other', message: { content: [{ type: 'text', text: 'Wrong child' }] } }),
    raw(3, { type: 'system', subtype: 'task_notification', task_id: 'task', status: 'completed', summary: 'Passed checks' }),
  ])
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'completed')
  assert.match(subagentLogText(rows[0]), /Passed checks/); assert.doesNotMatch(subagentLogText(rows[0]), /Wrong child/)
})
test('fallback Claude children stop with their parent, but authoritative state remains authoritative', () => {
  const start = event(1, { type: 'tool_started', backend: 'claude', tool: { id: 'tool', name: 'Agent', input: { description: 'Test worker' } } })
  assert.equal(subagentsFromEvents([start, event(2, { backend: 'claude', type: 'turn_stopped' })])[0].status, 'stopped')
  assert.equal(subagentsFromEvents([start, native(2, { backend: 'claude', subagent_tool_id: 'tool' }), event(3, { backend: 'claude', type: 'turn_stopped' })])[0].status, 'running')
})
test('unsorted snapshots yield the same state without mutating their input', () => {
  const input = [native(3, { subagent_status: 'completed' }), native(1), native(2)]
  assert.equal(subagentsFromEvents(input)[0].status, 'completed'); assert.equal(input[0].seq, 3)
})
test('logs cap count and text, preserve tracking-lost, and do not expose context as an agent heading', () => {
  const value = subagentsFromEvents([native(1, { subagent_name: '[AgentsDock context] Internal setup', subagent_status: 'tracking_lost', subagent_log: Array.from({ length: 100 }, (_, n) => ({ ts: String(n), text: 'x'.repeat(2000) })) })])[0]
  assert.equal(value.log.length, 80); assert.equal(value.log[0].text.length, 600)
  assert.equal(value.status, 'tracking_lost'); assert.equal(isSubagentActive(value), false)
  assert.equal(subagentDisplayName(value), 'Codex subagent')
})
