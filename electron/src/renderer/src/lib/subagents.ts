import type { Event, JsonValue } from '@shared/types'

export type SubagentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped'

export interface SubagentLogEntry {
  ts: string
  text: string
}

export interface SubagentActivity {
  key: string
  id: string
  runId: string
  backend: 'claude' | 'codex'
  name: string
  kind?: string
  status: SubagentStatus
  startedAt: string
  updatedAt: string
  latestActivity?: string
  summary?: string
  providerRef?: string
  log: SubagentLogEntry[]
}

const ACTIVE_STATUSES = new Set<SubagentStatus>(['starting', 'running'])
const LOG_LIMIT = 80

export function subagentsFromEvents(events: Event[]): SubagentActivity[] {
  const agents = new Map<string, SubagentActivity>()
  const taskKeys = new Map<string, string>()
  const toolKeys = new Map<string, string>()

  const ensure = (key: string, seed: Omit<SubagentActivity, 'key' | 'log'>): SubagentActivity => {
    const current = agents.get(key)
    if (current) return current
    const created = { key, log: [], ...seed }
    agents.set(key, created)
    return created
  }

  const note = (agent: SubagentActivity, ts: string, text: unknown): void => {
    const clean = compactText(text)
    if (!clean) return
    agent.updatedAt = ts || agent.updatedAt
    agent.latestActivity = clean
    if (agent.log.at(-1)?.text !== clean) agent.log = [...agent.log, { ts, text: clean }].slice(-LOG_LIMIT)
  }

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const runId = String(event.run_id || '')
    const backend = event.backend === 'claude' ? 'claude' : 'codex'
    const tool = event.tool || undefined
    const toolName = String(tool?.name || '').toLowerCase()
    const input = asRecord(tool?.input)
    const toolId = String(event.tool_id || input.id || '')

    if (event.type === 'subagent_state' && event.subagent_id) {
      const projectedToolId = String(event.subagent_tool_id || event.subagent_id)
      const key = `claude:${runId}:${projectedToolId}`
      const agent = ensure(key, {
        id: event.subagent_id,
        runId,
        backend: 'claude',
        name: event.subagent_name || 'Claude subagent',
        kind: event.subagent_kind || 'agent',
        status: normalizedStatus(event.subagent_status),
        startedAt: event.subagent_started_at || event.ts,
        updatedAt: event.ts
      })
      agent.id = event.subagent_id
      agent.name = event.subagent_name || agent.name
      agent.kind = event.subagent_kind || agent.kind
      agent.status = normalizedStatus(event.subagent_status)
      agent.startedAt = event.subagent_started_at || agent.startedAt
      agent.updatedAt = event.ts
      agent.summary = event.subagent_summary || agent.summary
      if (event.subagent_log?.length) agent.log = event.subagent_log.slice(-LOG_LIMIT)
      taskKeys.set(event.subagent_id, key)
      if (event.subagent_tool_id) toolKeys.set(event.subagent_tool_id, key)
      note(agent, event.ts, event.subagent_activity)
    }

    if (event.type === 'tool_started' && toolName === 'agent') {
      const id = String(tool?.id || toolId || event.id)
      const key = `claude:${runId}:${id}`
      const agent = ensure(key, {
        id,
        runId,
        backend: 'claude',
        name: String(input.description || input.subagent_type || 'Claude subagent'),
        kind: String(input.subagent_type || 'agent'),
        status: 'starting',
        startedAt: event.ts,
        updatedAt: event.ts
      })
      toolKeys.set(id, key)
      note(agent, event.ts, `Starting ${agent.name}`)
    }

    if (event.type === 'tool_started' && toolName === 'spawn_agent') {
      const id = String(tool?.id || toolId || event.id)
      const key = `codex:${runId}:${id}`
      const agent = ensure(key, {
        id,
        runId,
        backend: 'codex',
        name: String(input.task_name || 'Codex subagent'),
        kind: 'collaborator',
        status: 'starting',
        startedAt: event.ts,
        updatedAt: event.ts
      })
      toolKeys.set(id, key)
      note(agent, event.ts, `Starting ${agent.name}`)
    }

    if (event.type === 'tool_finished' && (toolName === 'agent' || toolName === 'spawn_agent')) {
      const id = String(event.tool_id || tool?.id || '')
      const key = toolKeys.get(id)
      const agent = key ? agents.get(key) : undefined
      if (agent) {
        if (agent.backend === 'claude') agent.status = event.is_error ? 'failed' : 'completed'
        else {
          agent.status = event.is_error ? 'failed' : 'running'
          agent.providerRef = parseProviderRef(event.output)
        }
        note(agent, event.ts, event.is_error ? event.output || 'Subagent failed' : agent.backend === 'claude' ? event.output || 'Subagent completed' : 'Subagent attached')
      }
    }

    if (event.type === 'raw_event' && event.backend === 'claude') {
      const raw = parseRawEvent(event.raw)
      const subtype = String(raw.subtype || '')
      const taskId = String(raw.task_id || '')
      const parentToolId = String(raw.parent_tool_use_id || '')
      const rawToolId = String(raw.tool_use_id || '')

      if (raw.type === 'system' && subtype === 'task_started' && raw.task_type === 'local_agent' && taskId) {
        const key = toolKeys.get(rawToolId) || `claude:${runId}:${rawToolId || taskId}`
        const agent = ensure(key, {
          id: taskId,
          runId,
          backend: 'claude',
          name: String(raw.description || raw.subagent_type || 'Claude subagent'),
          kind: String(raw.subagent_type || 'agent'),
          status: 'running',
          startedAt: event.ts,
          updatedAt: event.ts
        })
        agent.id = taskId
        agent.name = String(raw.description || agent.name)
        agent.kind = String(raw.subagent_type || agent.kind || 'agent')
        agent.status = 'running'
        taskKeys.set(taskId, key)
        if (rawToolId) toolKeys.set(rawToolId, key)
        note(agent, event.ts, raw.description || 'Subagent started')
      } else if (raw.type === 'system' && subtype === 'task_progress' && taskId) {
        const agent = agents.get(taskKeys.get(taskId) || '')
        if (agent) {
          agent.status = 'running'
          note(agent, event.ts, raw.description || 'Working')
        }
      } else if (raw.type === 'system' && subtype === 'task_notification' && taskId) {
        const agent = agents.get(taskKeys.get(taskId) || '')
        if (agent) {
          agent.status = normalizedStatus(raw.status)
          agent.summary = compactText(raw.summary)
          note(agent, event.ts, raw.summary || `Subagent ${agent.status}`)
        }
      } else if (parentToolId) {
        const agent = agents.get(toolKeys.get(parentToolId) || '')
        if (agent) note(agent, event.ts, childActivity(raw))
      }
    }

    if (event.type === 'turn_finished' || event.type === 'turn_stopped' || event.type === 'error') {
      for (const agent of agents.values()) {
        if (agent.runId !== runId || !ACTIVE_STATUSES.has(agent.status)) continue
        agent.status = event.type === 'turn_stopped' ? 'stopped' : event.type === 'error' || event.exit_code && event.exit_code !== 0 ? 'failed' : 'completed'
        note(agent, event.ts, agent.status === 'stopped' ? 'Parent turn stopped' : agent.status === 'failed' ? 'Parent turn ended with an error' : 'Parent turn completed')
      }
    }
  }

  return [...agents.values()].sort((a, b) => {
    const active = Number(ACTIVE_STATUSES.has(b.status)) - Number(ACTIVE_STATUSES.has(a.status))
    return active || Date.parse(b.startedAt || '0') - Date.parse(a.startedAt || '0')
  })
}

export function isSubagentActive(agent: SubagentActivity): boolean {
  return ACTIVE_STATUSES.has(agent.status)
}

export function subagentLogText(agent: SubagentActivity): string {
  const header = [agent.name, `${agent.backend} · ${agent.kind || 'subagent'} · ${agent.status}`, agent.providerRef ? `Provider: ${agent.providerRef}` : ''].filter(Boolean)
  return [...header, '', ...agent.log.map(entry => `${formatLogTime(entry.ts)}  ${entry.text}`)].join('\n')
}

function parseRawEvent(value?: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return asRecord(parsed)
  } catch {
    return {}
  }
}

function childActivity(raw: Record<string, unknown>): string {
  const message = asRecord(raw.message)
  const content = Array.isArray(message.content) ? message.content : []
  for (const value of content) {
    const block = asRecord(value)
    if (block.type === 'tool_use') {
      const input = asRecord(block.input)
      return String(input.description || input.command || `Using ${block.name || 'tool'}`)
    }
    if (block.type === 'text' && block.text) return String(block.text)
    if (block.type === 'tool_result' && block.is_error === true) return String(block.content || 'Tool failed')
  }
  return ''
}

function normalizedStatus(value: unknown): SubagentStatus {
  const status = String(value || '').toLowerCase()
  if (status === 'completed' || status === 'complete' || status === 'done') return 'completed'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'stopped' || status === 'cancelled' || status === 'canceled') return 'stopped'
  return 'running'
}

function parseProviderRef(output?: string | null): string | undefined {
  if (!output) return undefined
  try {
    const parsed = asRecord(JSON.parse(output))
    return String(parsed.task_name || parsed.agent_id || '') || undefined
  } catch {
    return undefined
  }
}

function asRecord(value: JsonValue | unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function compactText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 600)
}

function formatLogTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
