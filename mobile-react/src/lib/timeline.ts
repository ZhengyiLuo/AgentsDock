import type { AgentFile, Event } from '../types'
import { messageText } from './format'

export type TimelineRow = MessageRow | TraceRow | MediaRow | SystemRow | JobRow
export interface MessageRow { kind: 'message'; key: string; seq: number; role: 'user' | 'assistant'; events: Event[]; files: AgentFile[] }
export interface TraceRow { kind: 'trace'; key: string; seq: number; events: Event[]; runId?: string | null }
export interface MediaRow { kind: 'media'; key: string; seq: number; files: AgentFile[] }
export interface SystemRow { kind: 'system'; key: string; seq: number; event: Event }
export interface JobRow { kind: 'job'; key: string; seq: number; title: string; events: Event[] }

interface Turn {
  key: string
  runId?: string | null
  seq: number
  user?: Event
  assistant: Event[]
  trace: Event[]
  files: AgentFile[]
}

const hidden = new Set(['turn_queued', 'turn_unqueued', 'queue_snapshot'])
const traces = new Set([
  'reasoning_summary', 'tool_started', 'tool_finished', 'raw_event', 'process_started',
  'provider_session', 'cwd_fallback', 'history_imported', 'backend_changed', 'session_created', 'code_diff',
])
const jobs = new Set(['job_created', 'job_ran', 'job_started', 'job_deferred', 'job_finished', 'job_error'])

export function projectTimeline(events: Event[], knownFiles: AgentFile[]): TimelineRow[] {
  const filesById = new Map(knownFiles.map(file => [file.id, file]))
  const items: Array<Turn | SystemRow | JobRow> = []
  const turns = new Map<string, Turn>()
  const jobRows = new Map<string, JobRow>()
  let active: Turn | null = null

  const turnFor = (event: Event): Turn => {
    const id = event.run_id || active?.runId || `seq-${event.seq}`
    const existing = turns.get(id)
    if (existing) return existing
    const turn: Turn = { key: `turn:${id}`, runId: event.run_id, seq: event.seq, assistant: [], trace: [], files: [] }
    turns.set(id, turn)
    items.push(turn)
    return turn
  }

  for (const event of events) {
    if (hidden.has(event.type)) continue
    if (jobs.has(event.type) || event.purpose === 'scheduled_job') {
      const id = event.job_id || event.job?.id || event.run_id || `seq-${event.seq}`
      const existing = jobRows.get(id)
      if (existing) { existing.events.push(event); existing.seq = Math.min(existing.seq, event.seq) }
      else {
        const row: JobRow = { kind: 'job', key: `job:${id}`, seq: event.seq, title: event.job_title || event.job?.title || 'Scheduled job', events: [event] }
        jobRows.set(id, row)
        items.push(row)
      }
      continue
    }
    if (isTimelineError(event)) {
      items.push({ kind: 'system', key: `event:${event.id}`, seq: event.seq, event })
      continue
    }
    if (event.type === 'turn_started') {
      active = turnFor(event)
      active.user = event
      for (const id of event.file_ids ?? []) {
        const file = filesById.get(id)
        if (file && !active.files.some(value => value.id === id)) active.files.push(file)
      }
      continue
    }
    if (event.type === 'assistant_text' || event.type === 'turn_finished') {
      const turn = turnFor(event)
      const text = event.type === 'turn_finished' ? event.result_text : event.text
      if (text?.trim()) appendAssistant(turn.assistant, event, text, event.type === 'turn_finished')
      if (event.type === 'turn_finished' && active?.key === turn.key) active = null
      continue
    }
    if (traces.has(event.type)) { turnFor(event).trace.push(event); continue }
    if (event.type === 'artifact_created' || event.type === 'file_uploaded') {
      const file = event.artifact || event.file
      if (!file || event.type === 'file_uploaded' && !event.run_id && !active) continue
      const turn = active ?? turnFor(event)
      if (!turn.files.some(value => value.id === file.id)) turn.files.push(file)
      continue
    }
    if (event.run_id && active) { active.trace.push(event); continue }
    if (messageText(event).trim() || event.type === 'turn_stopped') {
      items.push({ kind: 'system', key: `event:${event.id}`, seq: event.seq, event })
    }
  }

  const rows: TimelineRow[] = []
  for (const item of items.sort((a, b) => a.seq - b.seq)) {
    if ('kind' in item) { rows.push(item); continue }
    if (item.user) rows.push({ kind: 'message', key: `${item.key}:user`, seq: item.user.seq, role: 'user', events: [item.user], files: item.files.filter(file => item.user?.file_ids?.includes(file.id)) })
    if (item.assistant.length) rows.push({ kind: 'message', key: `${item.key}:assistant`, seq: item.assistant[0].seq, role: 'assistant', events: item.assistant, files: [] })
    if (traceHasContent(item.trace)) rows.push({ kind: 'trace', key: `${item.key}:trace`, seq: item.trace[0].seq, events: item.trace, runId: item.runId })
    if (item.files.length) rows.push({ kind: 'media', key: `${item.key}:media`, seq: item.files[0].seq ?? item.seq, files: item.files })
  }
  return rows
}

export function rowText(row: TimelineRow): string {
  if (row.kind === 'message') return row.events.map(messageText).map(value => value.trim()).filter(Boolean).join('\n\n')
  if (row.kind === 'trace') return row.events.map(messageText).filter(Boolean).join('\n')
  if (row.kind === 'system') return messageText(row.event)
  if (row.kind === 'job') return messageText(row.events.at(-1)!) || row.title
  return row.files.map(file => file.title || file.filename).join(', ')
}

export function isTimelineError(event: Event): boolean {
  if (event.type === 'tool_started' || event.type === 'tool_finished' || event.type === 'raw_event') return false
  return event.type === 'error' || event.type.endsWith('_error') || event.is_error === true || event.error != null
}

function traceHasContent(events: Event[]): boolean {
  return events.some(event => ['reasoning_summary', 'tool_started', 'tool_finished', 'code_diff'].includes(event.type) || messageText(event).trim())
}

function appendAssistant(previous: Event[], event: Event, candidate: string, aggregate: boolean): void {
  const normalized = candidate.replace(/\s+/g, ' ').trim()
  const prior = previous.map(value => messageText(value).replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (!normalized || prior.includes(normalized)) return
  if (aggregate && prior.length && prior.every(part => normalized.includes(part))) previous.splice(0, previous.length, event)
  else previous.push(event)
}
