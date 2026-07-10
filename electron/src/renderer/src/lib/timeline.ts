import type { AgentFile, Event } from '@shared/types'

export type TimelineItem = TurnItem | SystemItem | JobItem
export type RenderTimelineItem = MessageItem | TraceItem | MediaItem | SystemItem | JobItem

export interface MessageItem {
  kind: 'message'
  id: string
  key: string
  seq: number
  event: Event
  role: 'user' | 'assistant'
  files: AgentFile[]
  groupPosition: 'only' | 'first' | 'middle' | 'last'
  groupIndex: number
  groupCount: number
}

export interface TraceItem {
  kind: 'trace'
  id: string
  key: string
  seq: number
  events: Event[]
}

export interface MediaItem {
  kind: 'media'
  id: string
  key: string
  seq: number
  files: AgentFile[]
}

export interface TurnItem {
  kind: 'turn'
  id: string
  key: string
  runId?: string | null
  seq: number
  user?: Event
  assistant: Event[]
  trace: Event[]
  files: AgentFile[]
  startedAt?: string
  finishedAt?: string
  purpose?: string | null
}

export interface SystemItem {
  kind: 'system'
  id: string
  key: string
  seq: number
  event: Event
}

export interface JobItem {
  kind: 'job'
  id: string
  key: string
  seq: number
  title: string
  events: Event[]
  latest: Event
}

const traceTypes = new Set([
  'reasoning_summary', 'tool_started', 'tool_finished', 'raw_event', 'process_started',
  'provider_session', 'cwd_fallback', 'history_imported', 'backend_changed', 'artifact_error',
  'session_created', 'idle_warning'
])
const hiddenTypes = new Set(['turn_queued', 'turn_unqueued', 'queue_snapshot'])
const jobTypes = new Set(['job_created', 'job_ran', 'job_started', 'job_deferred', 'job_finished', 'job_error'])

export function projectTimeline(events: Event[], knownFiles: AgentFile[]): TimelineItem[] {
  const filesById = new Map(knownFiles.map(file => [file.id, file]))
  const items: TimelineItem[] = []
  const turnByRun = new Map<string, TurnItem>()
  const jobById = new Map<string, JobItem>()
  let activeTurn: TurnItem | null = null

  const ensureTurn = (event: Event, forceNew = false): TurnItem => {
    const runKey = event.run_id || activeTurn?.runId || `seq-${event.seq}`
    const existing = turnByRun.get(runKey)
    if (existing && !forceNew) return existing
    const itemKey = forceNew ? `${runKey}:start-${event.seq}` : runKey
    const turn: TurnItem = {
      kind: 'turn', id: `turn:${itemKey}`, key: `turn:${itemKey}`, runId: event.run_id,
      seq: event.seq, assistant: [], trace: [], files: [], startedAt: event.ts, purpose: event.purpose
    }
    turnByRun.set(runKey, turn)
    items.push(turn)
    return turn
  }

  for (const event of events) {
    if (hiddenTypes.has(event.type)) continue
    if (jobTypes.has(event.type) || event.job_id) {
      const jobId = event.job_id || event.job?.id || event.run_id || `job-${event.seq}`
      const existing = jobById.get(jobId)
      if (existing) {
        existing.events.push(event); existing.latest = event; existing.seq = Math.max(existing.seq, event.seq)
      } else {
        const job: JobItem = {
          kind: 'job', id: `job:${jobId}`, key: `job:${jobId}`, seq: event.seq,
          title: event.job?.title || event.message || 'Scheduled job', events: [event], latest: event
        }
        jobById.set(jobId, job); items.push(job)
      }
      continue
    }

    // Errors belong in the visible timeline even when they carry the active
    // run ID. Handle them before the generic run/trace branches below.
    if (isTimelineError(event)) {
      items.push({ kind: 'system', id: `event:${event.id}`, key: `event:${event.id}`, seq: event.seq, event })
      if (event.type === 'turn_finished' && activeTurn?.runId === event.run_id) activeTurn = null
      continue
    }

    if (event.type === 'turn_started') {
      const prior = event.run_id ? turnByRun.get(event.run_id) : activeTurn
      activeTurn = ensureTurn(event, Boolean(prior?.user))
      activeTurn.user = event
      activeTurn.seq = Math.min(activeTurn.seq, event.seq)
      activeTurn.startedAt = event.ts
      activeTurn.purpose = event.purpose
      for (const id of event.file_ids ?? []) {
        const file = filesById.get(id)
        if (file && !activeTurn.files.some(candidate => candidate.id === id)) activeTurn.files.push(file)
      }
      continue
    }

    if (event.type === 'assistant_text' || event.type === 'turn_finished') {
      const turn = ensureTurn(event)
      const text = event.type === 'turn_finished' ? event.result_text : event.text
      if (text?.trim() && !turn.assistant.some(previous => messageText(previous) === text)) turn.assistant.push(event)
      if (event.type === 'turn_finished') {
        turn.finishedAt = event.ts
        if (activeTurn?.id === turn.id) activeTurn = null
      }
      continue
    }

    if (traceTypes.has(event.type)) {
      const turn = ensureTurn(event)
      turn.trace.push(event)
      continue
    }

    if (event.type === 'artifact_created' || event.type === 'file_uploaded') {
      const file = event.artifact || event.file
      if (file) {
        if (event.type === 'file_uploaded' && !event.run_id && !activeTurn) continue
        const turn = activeTurn ?? ensureTurn(event)
        if (!turn.files.some(candidate => candidate.id === file.id)) turn.files.push(file)
      }
      continue
    }

    if (event.run_id && activeTurn) {
      activeTurn.trace.push(event)
      continue
    }

    items.push({ kind: 'system', id: `event:${event.id}`, key: `event:${event.id}`, seq: event.seq, event })
  }

  return items.sort((a, b) => a.seq - b.seq)
}

export function reconcileTimelineItems(previous: TimelineItem[], next: TimelineItem[]): TimelineItem[] {
  if (!previous.length) return next
  const previousByKey = new Map(previous.map(item => [item.key, item]))
  return next.map(item => {
    const before = previousByKey.get(item.key)
    return before && timelineItemEqual(before, item) ? before : item
  })
}

export function renderTimelineItems(items: TimelineItem[]): RenderTimelineItem[] {
  const rows: RenderTimelineItem[] = []
  for (const item of items) {
    if (item.kind !== 'turn') { rows.push(item); continue }
    if (item.user) {
      rows.push({
        kind: 'message', id: `${item.id}:user`, key: `${item.key}:user:${item.user.id}`,
        seq: item.user.seq, event: item.user, role: 'user',
        files: item.files.filter(file => item.user?.file_ids?.includes(file.id)),
        groupPosition: 'only', groupIndex: 0, groupCount: 1
      })
    }
    for (const [index, event] of item.assistant.entries()) {
      const count = item.assistant.length
      const groupPosition = count === 1 ? 'only' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle'
      rows.push({
        kind: 'message', id: `${item.id}:assistant:${event.id}`, key: `${item.key}:assistant:${event.id}`,
        seq: event.seq, event, role: 'assistant', files: item.files,
        groupPosition, groupIndex: index, groupCount: count
      })
    }
    if (item.trace.length) rows.push({ kind: 'trace', id: `${item.id}:trace`, key: `${item.key}:trace`, seq: item.trace[0].seq, events: item.trace })
    if (item.files.length) rows.push({ kind: 'media', id: `${item.id}:media`, key: `${item.key}:media`, seq: item.files[0].seq ?? item.seq, files: item.files })
  }
  return rows
}

export function reconcileRenderTimelineItems(previous: RenderTimelineItem[], next: RenderTimelineItem[]): RenderTimelineItem[] {
  if (!previous.length) return next
  const previousByKey = new Map(previous.map(item => [item.key, item]))
  return next.map(item => {
    const before = previousByKey.get(item.key)
    if (!before || before.kind !== item.kind) return item
    if (before === item) return before
    if (before.kind === 'message' && item.kind === 'message' && before.event === item.event &&
      before.groupPosition === item.groupPosition && before.groupIndex === item.groupIndex && before.groupCount === item.groupCount &&
      sameReferences(before.files, item.files)) return before
    if (before.kind === 'trace' && item.kind === 'trace' && sameReferences(before.events, item.events)) return before
    if (before.kind === 'media' && item.kind === 'media' && sameReferences(before.files, item.files)) return before
    return item
  })
}

function timelineItemEqual(a: TimelineItem, b: TimelineItem): boolean {
  if (a.kind !== b.kind || a.seq !== b.seq) return false
  if (a.kind === 'system' && b.kind === 'system') return a.event === b.event
  if (a.kind === 'job' && b.kind === 'job') {
    return a.title === b.title && a.latest === b.latest && sameReferences(a.events, b.events)
  }
  if (a.kind === 'turn' && b.kind === 'turn') {
    return a.user === b.user && a.startedAt === b.startedAt && a.finishedAt === b.finishedAt &&
      a.purpose === b.purpose && sameReferences(a.assistant, b.assistant) &&
      sameReferences(a.trace, b.trace) && sameReferences(a.files, b.files)
  }
  return false
}

function sameReferences<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function messageText(event: Event): string {
  return event.result_text || event.text || event.prompt || printableEventValue(event.message) || printableEventValue(event.error) || event.output || ''
}

export function eventFile(event: Event): AgentFile | null {
  return event.artifact || event.file || null
}

export function isAgentVisibleEvent(event: Event): boolean {
  return event.type === 'assistant_text' ||
    (event.type === 'turn_finished' && Boolean(event.result_text?.trim())) ||
    event.type === 'artifact_created' || event.type === 'file_uploaded' ||
    isTimelineError(event) || event.type.startsWith('handoff_digest_') || jobTypes.has(event.type)
}

export function isTimelineError(event: Event): boolean {
  // Tool failures stay inside the folded trace; run/provider/artifact failures
  // need a first-class red row so the user cannot miss a failed turn.
  if (event.type === 'tool_started' || event.type === 'tool_finished' || event.type === 'raw_event') return false
  return event.type === 'error' || event.type.endsWith('_error') || event.is_error === true || Boolean(printableEventValue(event.error))
}

function printableEventValue(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const nested = printableEventValue(JSON.parse(trimmed))
        if (nested) return nested
      } catch { /* plain text that happens to begin with JSON punctuation */ }
    }
    return value
  }
  if (value == null) return ''
  if (typeof value === 'object' && !Array.isArray(value)) {
    if ('message' in value && typeof value.message === 'string') return value.message
    if ('error' in value) {
      const nested = printableEventValue(value.error)
      if (nested) return nested
    }
  }
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}

export function extractUnifiedDiff(events: Event[]): string {
  const candidates = events.flatMap(event => [event.output, event.text, event.message, ...toolInputTexts(event)]).filter((value): value is string => Boolean(value))
  return candidates.filter(hasChangeSignal).join('\n\n---\n\n')
}

export interface DiffFile {
  path: string
  additions: number
  deletions: number
  lines: Array<{ kind: 'add' | 'remove' | 'context' | 'header'; text: string; oldLine?: number; newLine?: number }>
}

export function parseUnifiedDiff(source: string): DiffFile[] {
  if (!source.trim()) return []
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let oldLine = 0; let newLine = 0
  for (const line of source.split('\n')) {
    const patchFile = line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.+)$/i)
    if (patchFile) {
      current = { path: cleanDiffPath(patchFile[2]), additions: 0, deletions: 0, lines: [{ kind: 'header', text: line }] }
      files.push(current); oldLine = 1; newLine = 1; continue
    }
    if (line.startsWith('diff --git ')) {
      const match = line.match(/ b\/(.+)$/)
      current = { path: match?.[1] ?? 'Changes', additions: 0, deletions: 0, lines: [{ kind: 'header', text: line }] }
      files.push(current); continue
    }
    if (!current) {
      if (line.startsWith('--- ')) { current = { path: line.slice(4), additions: 0, deletions: 0, lines: [] }; files.push(current) }
      else {
        const status = line.match(/^(?: M|M |MM|AM| A|A |\?\?| D|D | R|R )\s+(.+)$/)
        if (status) files.push({ path: cleanDiffPath(status[1]), additions: 0, deletions: 0, lines: [{ kind: 'header', text: line }] })
        continue
      }
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); current.lines.push({ kind: 'header', text: line }); continue }
    if (line.startsWith('+') && !line.startsWith('+++')) { current.additions++; current.lines.push({ kind: 'add', text: line.slice(1), newLine: newLine++ }); continue }
    if (line.startsWith('-') && !line.startsWith('---')) { current.deletions++; current.lines.push({ kind: 'remove', text: line.slice(1), oldLine: oldLine++ }); continue }
    current.lines.push({ kind: line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++') ? 'header' : 'context', text: line.replace(/^ /, ''), oldLine: oldLine++, newLine: newLine++ })
  }
  return files
}

function toolInputTexts(event: Event): string[] {
  const input = event.tool?.input
  if (!input) return []
  if (typeof input === 'string') return [input]
  if (Array.isArray(input)) return input.filter((item): item is string => typeof item === 'string')
  if (typeof input === 'object') return Object.values(input).filter((item): item is string => typeof item === 'string')
  return []
}

function hasChangeSignal(value: string): boolean {
  const lower = value.toLocaleLowerCase()
  return lower.includes('diff --git ') || lower.includes('*** begin patch') || lower.includes('*** update file:') ||
    lower.includes('*** add file:') || lower.includes('*** delete file:') || /^---\s/m.test(value) && /^\+\+\+\s/m.test(value) ||
    /^(?: M|M |MM|AM| A|A |\?\?| D|D | R|R )\s+\S+/m.test(value)
}

function cleanDiffPath(value: string): string { return value.trim().replace(/^[ab]\//, '').replace(/^["'`]|["'`]$/g, '') }
