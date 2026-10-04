import type { Event } from '../shared/types'

interface LiveSubagentState {
  seq: number
  sessionId: string
  runId: string
  taskId: string
  toolId: string
  name: string
  kind: string
  status: string
  startedAt: string
  updatedAt: string
  activity: string
  summary: string
  log: Array<{ ts: string; text: string }>
}

const LOG_LIMIT = 80
const STATE_LIMIT = 256

/** Projects provider-native child events into one bounded renderer record. */
export class SubagentEventProjector {
  private states = new Map<string, LiveSubagentState>()
  private taskByTool = new Map<string, string>()

  reset(): void {
    this.states.clear()
    this.taskByTool.clear()
  }

  project(event: Event): Event | null {
    if (event.type === 'subagent_state' && event.backend === 'claude' && event.subagent_id && event.run_id) {
      const stateKey = key(event.session_id, event.run_id, event.subagent_id)
      const previous = this.states.get(stateKey)
      const status = normalizeStatus(event.subagent_status)
      if (previous && event.seq < previous.seq) return null
      if (previous && !isActiveStatus(previous.status) && isActiveStatus(status)) return null
      const state: LiveSubagentState = {
        seq: event.seq,
        sessionId: event.session_id, runId: event.run_id, taskId: event.subagent_id,
        toolId: event.subagent_tool_id || previous?.toolId || '',
        name: event.subagent_name || previous?.name || 'Claude subagent',
        kind: event.subagent_kind || previous?.kind || 'agent', status,
        startedAt: event.subagent_started_at || previous?.startedAt || event.ts,
        updatedAt: event.ts, activity: event.subagent_activity || previous?.activity || '',
        summary: event.subagent_summary || previous?.summary || '',
        log: event.subagent_log?.slice(-LOG_LIMIT) || previous?.log || []
      }
      this.states.set(stateKey, state)
      if (state.toolId) this.taskByTool.set(key(event.session_id, event.run_id, state.toolId), stateKey)
      this.prune()
      return event // Hydration persists only structured states accepted above.
    }
    if (event.type === 'turn_finished' || event.type === 'turn_stopped' || event.type === 'error') {
      this.releaseRun(event.session_id, String(event.run_id || ''))
      return null
    }
    if (event.type !== 'raw_event' || event.backend !== 'claude' || !event.raw) return null

    const raw = parseRecord(event.raw)
    const subtype = String(raw.subtype || '')
    const taskId = String(raw.task_id || '')
    const toolId = String(raw.tool_use_id || '')
    const parentToolId = String(raw.parent_tool_use_id || '')
    const runId = String(event.run_id || '')

    if (raw.type === 'system' && subtype === 'task_started' && raw.task_type === 'local_agent' && taskId) {
      const stateKey = key(event.session_id, runId, taskId)
      const previous = this.states.get(stateKey)
      if (previous && event.seq < previous.seq) return null
      if (previous && !isActiveStatus(previous.status)) return null
      const state: LiveSubagentState = {
        seq: event.seq,
        sessionId: event.session_id,
        runId,
        taskId,
        toolId,
        name: compact(raw.description) || compact(raw.subagent_type) || 'Claude subagent',
        kind: compact(raw.subagent_type) || 'agent',
        status: 'running',
        startedAt: event.ts,
        updatedAt: event.ts,
        activity: '',
        summary: '',
        log: []
      }
      this.states.set(stateKey, state)
      if (toolId) this.taskByTool.set(key(event.session_id, runId, toolId), stateKey)
      this.note(state, event, raw.description || 'Subagent started')
      this.prune()
      return projectedEvent(event, state)
    }

    if (raw.type === 'system' && subtype === 'task_progress' && taskId) {
      const state = this.states.get(key(event.session_id, runId, taskId))
      if (!state || event.seq < state.seq || !isActiveStatus(state.status)) return null
      state.status = 'running'
      this.note(state, event, raw.description || 'Working')
      return projectedEvent(event, state)
    }

    if (raw.type === 'system' && (subtype === 'task_notification' || subtype === 'task_updated') && taskId) {
      const state = this.states.get(key(event.session_id, runId, taskId))
      if (!state || event.seq < state.seq) return null
      const patch = subtype === 'task_updated' && raw.patch && typeof raw.patch === 'object' ? raw.patch : {}
      const status = normalizeStatus(patch.status || raw.status || state.status)
      if (!isActiveStatus(state.status) && isActiveStatus(status)) return null
      state.status = status
      state.summary = compact(patch.summary || raw.summary) || state.summary
      this.note(state, event, patch.description || patch.message || patch.summary || raw.summary || `Subagent ${state.status}`)
      return projectedEvent(event, state)
    }

    if (parentToolId) {
      const stateKey = this.taskByTool.get(key(event.session_id, runId, parentToolId))
      const state = stateKey ? this.states.get(stateKey) : undefined
      const activity = childActivity(raw)
      if (!state || event.seq < state.seq || !activity || !isActiveStatus(state.status)) return null
      this.note(state, event, activity)
      return projectedEvent(event, state)
    }

    return null
  }

  private note(state: LiveSubagentState, event: Event, value: unknown): void {
    state.seq = event.seq
    const text = compact(value)
    if (!text) return
    state.updatedAt = event.ts || state.updatedAt
    state.activity = text
    if (state.log.at(-1)?.text !== text) state.log = [...state.log, { ts: event.ts, text }].slice(-LOG_LIMIT)
  }

  private releaseRun(sessionId: string, runId: string): void {
    if (!runId) return
    const prefix = `${sessionId}:${runId}:`
    for (const toolKey of this.taskByTool.keys()) {
      if (toolKey.startsWith(prefix)) this.taskByTool.delete(toolKey)
    }
  }

  private prune(): void {
    if (this.states.size <= STATE_LIMIT) return
    for (const [stateKey, state] of this.states) {
      if (state.status === 'running' || state.status === 'starting') continue
      this.states.delete(stateKey)
      if (this.states.size <= STATE_LIMIT) return
    }
    while (this.states.size > STATE_LIMIT) this.states.delete(this.states.keys().next().value as string)
  }
}

function projectedEvent(source: Event, state: LiveSubagentState): Event {
  return {
    seq: source.seq,
    id: `subagent:${state.sessionId}:${state.runId}:${state.taskId}`,
    session_id: state.sessionId,
    run_id: state.runId,
    backend: 'claude',
    type: 'subagent_state',
    ts: state.updatedAt,
    subagent_id: state.taskId,
    subagent_tool_id: state.toolId,
    subagent_name: state.name,
    subagent_kind: state.kind,
    subagent_status: state.status,
    subagent_activity: state.activity,
    subagent_summary: state.summary,
    subagent_started_at: state.startedAt,
    subagent_log: state.log
  }
}

function parseRecord(value: string): Record<string, any> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function childActivity(raw: Record<string, any>): string {
  const message = raw.message && typeof raw.message === 'object' ? raw.message : {}
  const content = Array.isArray(message.content) ? message.content : []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'tool_use') {
      const input = block.input && typeof block.input === 'object' ? block.input : {}
      return compact(input.description || input.command || `Using ${block.name || 'tool'}`)
    }
    if (block.type === 'text' && block.text) return compact(block.text)
    if (block.type === 'tool_result' && block.is_error === true) return compact(block.content || 'Tool failed')
  }
  return ''
}

function normalizeStatus(value: unknown): string {
  const status = String(value || '').toLowerCase()
  if (status === 'tracking_lost' || status === 'killed') return status
  if (status === 'completed' || status === 'complete' || status === 'done') return 'completed'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'stopped' || status === 'cancelled' || status === 'canceled') return 'stopped'
  return 'running'
}

function isActiveStatus(status: string): boolean {
  return status === 'running' || status === 'starting'
}

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 600)
}

function key(sessionId: string, runId: string, id: string): string {
  return `${sessionId}:${runId}:${id}`
}
