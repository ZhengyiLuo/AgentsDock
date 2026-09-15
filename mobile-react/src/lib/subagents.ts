// Native child projection mirrors desktop 2ce43b9; display text is English on Mobile.
import type { Event, JsonValue } from '../types'

export type SubagentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped' | 'killed' | 'tracking_lost'

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
  title?: string | null
  nickname?: string
  path?: string
  task?: string
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
const CODEX_COORDINATION_OPERATIONS = new Set([
  'wait',
  'waitagent',
  'listagents',
  'sendinput',
  'sendmessage',
  'followuptask',
  'interruptagent',
  'resumeagent',
  'closeagent'
])
const LOG_LIMIT = 80

export function subagentsFromEvents(events: Event[], ownerBackend?: 'claude' | 'codex'): SubagentActivity[] {
  const agents = new Map<string, SubagentActivity>()
  const taskKeys = new Map<string, string>()
  const toolKeys = new Map<string, string>()
  const runBackends = new Map<string, 'claude' | 'codex'>()
  const authoritativeKeys = new Set<string>()
  const agentStartSeqs = new Map<string, number>()

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

  const rekey = (agent: SubagentActivity, key: string): SubagentActivity => {
    if (agent.key === key) return agent
    const previousKey = agent.key
    agents.delete(previousKey)
    agent.key = key
    agents.set(key, agent)
    const startSeq = agentStartSeqs.get(previousKey)
    agentStartSeqs.delete(previousKey)
    if (startSeq != null) agentStartSeqs.set(key, startSeq)
    for (const [alias, mappedKey] of taskKeys) {
      if (mappedKey === previousKey) taskKeys.set(alias, key)
    }
    for (const [alias, mappedKey] of toolKeys) {
      if (mappedKey === previousKey) toolKeys.set(alias, key)
    }
    return agent
  }

  let orderedEvents = events
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].seq <= events[index].seq) continue
    orderedEvents = [...events].sort((a, b) => a.seq - b.seq)
    break
  }

  for (const event of orderedEvents) {
    const runId = String(event.run_id || '')
    const eventBackend = event.backend === 'claude' || event.backend === 'codex' ? event.backend : undefined
    if (runId && eventBackend) runBackends.set(runId, eventBackend)
    const backend = eventBackend || runBackends.get(runId) || ownerBackend || 'codex'
    const tool = event.tool || undefined
    const toolName = String(tool?.name || '').toLowerCase()
    const input = asRecord(tool?.input)
    const toolId = String(event.tool_id || input.id || '')
    const normalizedAgentOperation = String(
      input.description || input.operation || ''
    ).replace(/[^a-z0-9]/gi, '').toLowerCase()
    const isLegacyCodexSpawn = (
      toolName === 'agent'
      && backend === 'codex'
      && normalizedAgentOperation === 'spawnagent'
    )
    const isCoordinationOnlyAgent = (
      toolName === 'agent'
      && backend === 'codex'
      && CODEX_COORDINATION_OPERATIONS.has(normalizedAgentOperation)
    )
    const isClaudeAgentTool = toolName === 'agent' && backend === 'claude' && !isCoordinationOnlyAgent

    if (event.type === 'subagent_state' && event.subagent_id) {
      const childId = String(event.subagent_id)
      const projectedToolId = String(event.subagent_tool_id || '')
      const identity = subagentEventIdentity(event)
      const key = backend === 'claude' ? `${backend}:${runId}:subagent:${childId}` : `${backend}:subagent:${childId}`
      const existingKey = (
        taskKeys.get(taskAlias(backend, childId, runId))
        || (projectedToolId ? toolKeys.get(toolAlias(backend, runId, projectedToolId)) : undefined)
      )
      const fallback = [...agents.values()]
        .filter(candidate => (
          candidate.backend === backend
          && candidate.status === 'running'
          && !authoritativeKeys.has(candidate.key)
          && !candidate.key.startsWith(`${backend}:subagent:`)
          && (!runId || candidate.runId === runId)
          && (agentStartSeqs.get(candidate.key) ?? Number.MAX_SAFE_INTEGER) <= event.seq
        ))
        .sort((a, b) => (agentStartSeqs.get(b.key) ?? 0) - (agentStartSeqs.get(a.key) ?? 0))[0]
      const existing = agents.get(key) || (existingKey ? agents.get(existingKey) : undefined) || fallback
      // A retired Claude execution cannot become live again from a delayed
      // snapshot. A new owner has its own key, even if a task ID is reused.
      if (backend === 'claude' && existing && !ACTIVE_STATUSES.has(existing.status)
        && ACTIVE_STATUSES.has(normalizedStatus(event.subagent_status))) continue
      const agent = existing ? rekey(existing, key) : ensure(key, {
        id: childId,
        runId,
        backend,
        name: preferredIdentityName(identity, backend),
        ...identity,
        kind: event.subagent_kind || 'agent',
        status: normalizedStatus(event.subagent_status),
        startedAt: event.subagent_started_at || event.ts,
        updatedAt: event.ts
      })
      agent.id = childId
      agent.runId = runId || agent.runId
      agent.backend = backend
      applySubagentIdentity(agent, identity)
      agent.kind = event.subagent_kind || agent.kind
      agent.status = normalizedStatus(event.subagent_status)
      agent.startedAt = event.subagent_started_at || agent.startedAt
      agent.updatedAt = event.ts
      agent.summary = event.subagent_summary || agent.summary
      agent.providerRef = event.subagent_provider_ref || agent.providerRef
      if (Array.isArray(event.subagent_log) && event.subagent_log.length) agent.log = event.subagent_log.slice(-LOG_LIMIT)
        .filter(entry => entry && typeof entry.ts === 'string' && typeof entry.text === 'string')
        .map(entry => ({ ts: entry.ts, text: compactText(entry.text) }))
      authoritativeKeys.add(key)
      agentStartSeqs.set(key, Math.min(agentStartSeqs.get(key) ?? event.seq, event.seq))
      taskKeys.set(taskAlias(backend, childId, runId), key)
      if (projectedToolId) toolKeys.set(toolAlias(backend, runId, projectedToolId), key)
      note(agent, event.ts, event.subagent_activity)
    }

    if (event.type === 'tool_started' && (isClaudeAgentTool || isLegacyCodexSpawn)) {
      const id = String(tool?.id || toolId || event.id)
      const alias = toolAlias(backend, runId, id)
      const key = toolKeys.get(alias) || `${backend}:${runId}:${id}`
      const task = cleanIdentityText(input.description || input.subagent_type)
      const agent = ensure(key, {
        id,
        runId,
        backend,
        name: task || (backend === 'claude' ? 'Claude subagent' : 'Codex subagent'),
        task: task || undefined,
        kind: backend === 'claude' ? String(input.subagent_type || 'agent') : 'collaborator',
        status: 'starting',
        startedAt: event.ts,
        updatedAt: event.ts
      })
      if (!agentStartSeqs.has(agent.key)) agentStartSeqs.set(agent.key, event.seq)
      toolKeys.set(alias, key)
      if (!authoritativeKeys.has(agent.key)) note(agent, event.ts, `Starting ${agent.name}`)
    }

    if (event.type === 'tool_started' && toolName === 'spawn_agent') {
      const id = String(tool?.id || toolId || event.id)
      const alias = toolAlias('codex', runId, id)
      const key = toolKeys.get(alias) || `codex:${runId}:${id}`
      const task = cleanIdentityText(input.task_name)
      const agent = ensure(key, {
        id,
        runId,
        backend: 'codex',
        name: task || 'Codex subagent',
        task: task || undefined,
        kind: 'collaborator',
        status: 'starting',
        startedAt: event.ts,
        updatedAt: event.ts
      })
      if (!agentStartSeqs.has(agent.key)) agentStartSeqs.set(agent.key, event.seq)
      toolKeys.set(alias, key)
      if (!authoritativeKeys.has(agent.key)) note(agent, event.ts, `Starting ${agent.name}`)
    }

    if (
      event.type === 'tool_finished'
      && (isClaudeAgentTool || isLegacyCodexSpawn || toolName === 'spawn_agent')
    ) {
      const id = String(event.tool_id || tool?.id || '')
      const key = toolKeys.get(toolAlias(backend, runId, id))
      const agent = key ? agents.get(key) : undefined
      if (agent) {
        if (!authoritativeKeys.has(agent.key)) {
          agent.status = event.is_error ? 'failed' : agent.backend === 'claude' ? 'completed' : 'running'
        }
        if (agent.backend === 'codex') {
          const providerIdentity = parseProviderIdentity(event.output)
          agent.providerRef = providerIdentity.providerRef || agent.providerRef
          applySubagentIdentity(agent, providerIdentity)
        }
        if (agent.status !== 'tracking_lost') note(agent, event.ts, event.is_error ? event.output || 'Subagent failed' : agent.backend === 'claude' ? event.output || 'Subagent completed' : 'Attached to subagent')
      }
    }

    if (event.type === 'raw_event' && event.backend === 'claude') {
      const raw = parseRawEvent(event.raw)
      const subtype = String(raw.subtype || '')
      const taskId = String(raw.task_id || '')
      const parentToolId = String(raw.parent_tool_use_id || '')
      const rawToolId = String(raw.tool_use_id || '')

      if (raw.type === 'system' && subtype === 'task_started' && raw.task_type === 'local_agent' && taskId) {
        const key = taskKeys.get(taskAlias('claude', taskId, runId))
          || toolKeys.get(toolAlias('claude', runId, rawToolId)) || `claude:${runId}:${rawToolId || taskId}`
        const task = cleanIdentityText(raw.description)
        const fallbackName = task || cleanIdentityText(raw.subagent_type) || 'Claude subagent'
        const agent = ensure(key, {
          id: taskId,
          runId,
          backend: 'claude',
          name: fallbackName,
          task: task || undefined,
          kind: String(raw.subagent_type || 'agent'),
          status: 'running',
          startedAt: event.ts,
          updatedAt: event.ts
        })
        if (!ACTIVE_STATUSES.has(agent.status)) continue
        agent.id = taskId
        if (task) {
          agent.name = task
          agent.task = task
        }
        agent.kind = String(raw.subagent_type || agent.kind || 'agent')
        agent.status = 'running'
        taskKeys.set(taskAlias('claude', taskId, runId), key)
        if (rawToolId) toolKeys.set(toolAlias('claude', runId, rawToolId), key)
        note(agent, event.ts, raw.description || 'Subagent started')
      } else if (raw.type === 'system' && subtype === 'task_progress' && taskId) {
        const agent = agents.get(taskKeys.get(taskAlias('claude', taskId, runId)) || '')
        if (agent && ACTIVE_STATUSES.has(agent.status)) {
          agent.status = 'running'
          note(agent, event.ts, raw.description || 'Working')
        }
      } else if (raw.type === 'system' && subtype === 'task_notification' && taskId) {
        const agent = agents.get(taskKeys.get(taskAlias('claude', taskId, runId)) || '')
        if (agent) {
          const nextStatus = normalizedStatus(raw.status)
          if (!ACTIVE_STATUSES.has(agent.status) && ACTIVE_STATUSES.has(nextStatus)) continue
          agent.status = nextStatus
          agent.summary = compactText(raw.summary)
          note(agent, event.ts, raw.summary || `Subagent ${subagentStatusLabel(agent.status)}`)
        }
      } else if (parentToolId) {
        const agent = agents.get(toolKeys.get(toolAlias('claude', runId, parentToolId)) || '')
        if (agent && ACTIVE_STATUSES.has(agent.status)) note(agent, event.ts, childActivity(raw))
      }
    }

    if (event.type === 'turn_finished' || event.type === 'turn_stopped' || event.type === 'error') {
      for (const agent of agents.values()) {
        if (
          agent.backend !== 'claude'
          || authoritativeKeys.has(agent.key)
          || agent.runId !== runId
          || !ACTIVE_STATUSES.has(agent.status)
        ) continue
        const parentStopped = event.type === 'turn_stopped' || (event.type === 'turn_finished' && event.stopped === true)
        const parentFailed = event.type === 'error' || (event.exit_code != null && event.exit_code !== 0)
        agent.status = parentStopped ? 'stopped' : parentFailed ? 'failed' : 'completed'
        note(agent, event.ts, (agent.status === 'stopped' ? 'Parent turn stopped' : agent.status === 'failed' ? 'Parent turn failed' : 'Parent turn completed'))
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

export function subagentStatusLabel(status: SubagentStatus): string {
  return status === 'tracking_lost' ? 'Tracking lost' : status
}

export function subagentLogText(agent: SubagentActivity): string {
  const task = subagentTaskLabel(agent)
  const header = [
    subagentDisplayName(agent),
    agent.nickname && agent.nickname !== subagentDisplayName(agent) ? agent.nickname : '',
    agent.path && agent.path !== subagentDisplayName(agent) ? `Path: ${agent.path}` : '',
    task && task !== agent.name && task !== agent.path ? `Task: ${task}` : '',
    `${agent.backend} · ${agent.kind || 'subagent'} · ${subagentStatusLabel(agent.status)}`,
    agent.providerRef ? `Provider: ${agent.providerRef}` : ''
  ].filter(Boolean)
  return [...header, '', ...agent.log.map(entry => `${formatLogTime(entry.ts)}  ${entry.text}`)].join('\n')
}

export function subagentDisplayName(agent: SubagentActivity): string {
  if (agent.title) return agent.title
  const task = subagentTaskLabel(agent)
  if (task) return readableSubagentTask(task)
  if (agent.path) {
    const segments = agent.path.split('/').filter(Boolean)
    const leaf = segments.length > 1 ? segments.at(-1) : undefined
    if (leaf && leaf !== agent.id) return readableSubagentTask(leaf)
  }
  if (agent.nickname) return agent.nickname
  return cleanIdentityText(agent.name) || (agent.backend === 'claude' ? 'Claude subagent' : 'Codex subagent')
}

function subagentTaskLabel(agent: SubagentActivity): string {
  const task = cleanIdentityText(agent.task)
  // Older state records also copy the nickname into subagent_name, which the
  // parser retains as a legacy task fallback. That is not a task description.
  return task && task !== agent.id && task !== agent.nickname && !subagentPath(task) ? task : ''
}

function readableSubagentTask(task: string): string {
  // Format task identifiers for display only; never rename the provider thread
  // or alter the stored path, nickname, identity, or selected output panel.
  const label = task.replace(/[_-]+/g, ' ').trim() || task
  if (!task.includes(' ') || task.includes('_')) return label.charAt(0).toUpperCase() + label.slice(1)
  return task
}

export function subagentDetailText(agent: SubagentActivity): string {
  const displayName = subagentDisplayName(agent)
  if (agent.nickname && agent.nickname !== displayName) return agent.nickname
  if (agent.path && agent.path !== displayName) return agent.path
  const task = subagentTaskLabel(agent)
  if (task && task !== displayName) return task
  const activity = cleanIdentityText(agent.latestActivity)
  return activity || agent.kind || 'subagent'
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
  if (status === 'tracking_lost' || status === 'killed') return status
  if (status === 'completed' || status === 'complete' || status === 'done') return 'completed'
  if (status === 'failed' || status === 'error' || status === 'errored' || status === 'systemerror' || status === 'notfound') return 'failed'
  if (status === 'stopped' || status === 'cancelled' || status === 'canceled' || status === 'interrupted' || status === 'shutdown' || status === 'closed') return 'stopped'
  if (status === 'starting' || status === 'pending' || status === 'pendinginit' || status === 'queued') return 'starting'
  return 'running'
}

interface SubagentIdentity {
  title?: string | null
  nickname?: string
  path?: string
  task?: string
  providerRef?: string
}

function subagentEventIdentity(event: Event): SubagentIdentity {
  const identityEvent = event as Event & {
    subagent_nickname?: string | null
    subagent_path?: string | null
    subagent_task?: string | null
    agent_nickname?: string | null
    agent_path?: string | null
    task_name?: string | null
  }
  const nickname = cleanIdentityText(identityEvent.subagent_nickname || identityEvent.agent_nickname)
  const explicitPath = cleanIdentityText(identityEvent.subagent_path || identityEvent.agent_path)
  const explicitTask = cleanIdentityText(identityEvent.subagent_task || identityEvent.task_name)
  const projectedName = cleanIdentityText(event.subagent_name)
  const projectedPath = subagentPath(projectedName)
  // Omitted fields from older servers preserve identity; an explicit clear
  // falls back to task/path, then nickname, without changing child identity.
  const title = event.subagent_title === null
    || typeof event.subagent_title === 'string' && !event.subagent_title.trim() ? null
    : typeof event.subagent_title === 'string' ? cleanIdentityText(event.subagent_title) || undefined
      : undefined
  return {
    title,
    nickname: nickname || undefined,
    path: explicitPath || projectedPath || undefined,
    task: explicitTask || (!projectedPath && projectedName !== nickname ? projectedName : '') || undefined
  }
}

function applySubagentIdentity(agent: SubagentActivity, identity: SubagentIdentity): void {
  if (identity.title !== undefined) agent.title = identity.title
  if (identity.nickname) agent.nickname = identity.nickname
  if (identity.path) agent.path = identity.path
  if (identity.task) agent.task = identity.task
  agent.name = agent.nickname || agent.task || agent.path || cleanIdentityText(agent.name)
    || (agent.backend === 'claude' ? 'Claude subagent' : 'Codex subagent')
}

function preferredIdentityName(identity: SubagentIdentity, backend: 'claude' | 'codex'): string {
  return identity.nickname || identity.task || identity.path
    || (backend === 'claude' ? 'Claude subagent' : 'Codex subagent')
}

function parseProviderIdentity(output?: string | null): SubagentIdentity {
  if (!output) return {}
  try {
    const parsed = asRecord(JSON.parse(output))
    const taskName = cleanIdentityText(parsed.task_name)
    return {
      nickname: cleanIdentityText(parsed.agent_nickname || parsed.nickname) || undefined,
      path: cleanIdentityText(parsed.agent_path) || subagentPath(taskName) || undefined,
      task: cleanIdentityText(parsed.task || (!subagentPath(taskName) ? taskName : '')) || undefined,
      providerRef: cleanIdentityText(parsed.agent_id || parsed.thread_id || parsed.task_name) || undefined
    }
  } catch {
    return {}
  }
}

function asRecord(value: JsonValue | unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function taskAlias(backend: 'claude' | 'codex', id: string, runId: string): string {
  return backend === 'claude' ? `${backend}:${runId}:${id}` : `${backend}:${id}`
}

function toolAlias(backend: 'claude' | 'codex', runId: string, id: string): string {
  return `${backend}:${runId}:${id}`
}

function compactText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 600)
}

function cleanIdentityText(value: unknown): string {
  const clean = compactText(value)
  if (
    !clean
    || /^(?:Codex|Claude) subagent$/i.test(clean)
    || /^\[AgentsDock context\](?:\s|$)/i.test(clean)
  ) return ''
  return clean
}

function subagentPath(value: string): string {
  return /^\/root(?:\/[^\s]+)*$/.test(value) ? value : ''
}

function formatLogTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
