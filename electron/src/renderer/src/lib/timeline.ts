import type { AgentFile, CodeDiffFileSummary, Event } from '@shared/types'

export type TimelineItem = TurnItem | SystemItem | JobItem
export type RenderTimelineItem = MessageItem | TraceItem | MediaItem | SystemItem | JobItem

export interface MessageItem {
  kind: 'message'
  id: string
  key: string
  seq: number
  event: Event
  events: Event[]
  role: 'user' | 'assistant'
  files: AgentFile[]
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
  'session_created', 'idle_warning', 'code_diff'
])
const hiddenTypes = new Set(['turn_queued', 'turn_unqueued', 'queue_snapshot', 'subagent_state'])
const jobTypes = new Set(['job_created', 'job_ran', 'job_started', 'job_deferred', 'job_finished', 'job_error'])

export function isHandoffDigestEvent(event: Event): boolean {
  return Boolean(event.digest_job_id) &&
    (event.purpose === 'handoff_digest' || event.type.startsWith('handoff_digest_'))
}

export function projectTimeline(events: Event[], knownFiles: AgentFile[]): TimelineItem[] {
  const filesById = new Map(knownFiles.map(file => [file.id, file]))
  const items: TimelineItem[] = []
  const turnByRun = new Map<string, TurnItem>()
  const jobById = new Map<string, JobItem>()
  const jobByRun = new Map<string, string>()
  const jobTitles = new Map<string, string>()
  const digestById = new Map<string, SystemItem>()
  let activeTurn: TurnItem | null = null

  for (const event of events) {
    const jobId = String(event.job_id || event.job?.id || '').trim()
    if (!jobId) continue
    const title = String(event.job_title || event.job?.title || '').trim()
    if (title) jobTitles.set(jobId, title)
    if (event.run_id && (jobTypes.has(event.type) || event.purpose === 'scheduled_job')) {
      jobByRun.set(event.run_id, jobId)
    }
  }

  const appendJobEvent = (event: Event, jobId: string): void => {
    const existing = jobById.get(jobId)
    const title = event.job_title || event.job?.title || jobTitles.get(jobId) || event.message || 'Scheduled job'
    if (existing) {
      if (!existing.events.some(candidate => candidate.id === event.id)) existing.events.push(event)
      if (event.seq >= existing.latest.seq) existing.latest = event
      existing.seq = Math.max(existing.seq, event.seq)
      if (title && existing.title === 'Scheduled job') existing.title = title
      return
    }
    const job: JobItem = {
      kind: 'job', id: `job:${jobId}`, key: `job:${jobId}`, seq: event.seq,
      title, events: [event], latest: event
    }
    jobById.set(jobId, job)
    items.push(job)
  }

  const appendDigestEvent = (event: Event): void => {
    const digestId = String(event.digest_job_id || '').trim()
    if (!digestId) return
    const existing = digestById.get(digestId)
    if (existing) {
      // Keep one stable row at the point where creation began, while its
      // visible status advances from queued/running to sent or failed. Late
      // provider events must not regress a terminal lifecycle state.
      const nextPriority = digestDisplayPriority(event)
      const currentPriority = digestDisplayPriority(existing.event)
      if (nextPriority > currentPriority || nextPriority === currentPriority && event.seq >= existing.event.seq) {
        existing.event = event
      }
      return
    }
    const item: SystemItem = {
      kind: 'system', id: `digest:${digestId}`, key: `digest:${digestId}`, seq: event.seq, event
    }
    digestById.set(digestId, item)
    items.push(item)
  }

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
    const legacyDigest = legacyDigestBody(event)
    if (legacyDigest) {
      appendDigestEvent({
        ...event,
        type: 'handoff_digest_received',
        digest_job_id: `legacy-${event.run_id || event.id}`,
        digest: legacyDigest,
        message: 'Context digest was delivered to this chat.'
      })
    }
    // Digest generation intentionally runs as a real turn in the source
    // provider session so it can use that chat's context. It is workflow
    // plumbing, though, not a user/assistant exchange. Collapse every event
    // from that internal turn and its lifecycle into one status row.
    if (isHandoffDigestEvent(event)) {
      appendDigestEvent(event)
      continue
    }
    if (hiddenTypes.has(event.type)) continue
    const explicitJobId = String(event.job_id || event.job?.id || '').trim()
    const jobId = jobTypes.has(event.type) || event.purpose === 'scheduled_job'
      ? explicitJobId || jobByRun.get(event.run_id || '') || event.run_id || `job-${event.seq}`
      : jobByRun.get(event.run_id || '')
    if (jobId) {
      appendJobEvent(event, jobId)
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
      if (!isDigestDeliveryTurn(event)) activeTurn.user = event
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
      if (text?.trim()) appendAssistantOutput(turn.assistant, event, text, event.type === 'turn_finished')
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

function legacyDigestBody(event: Event): string {
  if (event.type !== 'turn_started') return ''
  const prompt = event.prompt?.trim() || ''
  return prompt.startsWith('# ZenithDock Context Digest') ? prompt : ''
}

function isDigestDeliveryTurn(event: Event): boolean {
  return event.purpose === 'handoff_digest_delivery' || Boolean(legacyDigestBody(event))
}

function digestDisplayPriority(event: Event): number {
  if (event.type === 'handoff_digest_error') return 50
  if (event.type === 'handoff_digest_sent' || event.type === 'handoff_digest_received') return 40
  if (event.type === 'handoff_digest_ready' || event.type === 'handoff_digest_submitted') return 30
  if (event.type === 'handoff_digest_started') return 20
  return event.purpose === 'handoff_digest' ? 10 : 0
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
        seq: item.user.seq, event: item.user, events: [item.user], role: 'user',
        files: item.files.filter(file => item.user?.file_ids?.includes(file.id))
      })
    }
    if (item.assistant.length) {
      const event = item.assistant[item.assistant.length - 1]
      rows.push({
        kind: 'message', id: `${item.id}:assistant`, key: `${item.key}:assistant`,
        seq: item.assistant[0].seq, event, events: item.assistant, role: 'assistant', files: item.files
      })
    }
    if (traceHasVisibleContent(item.trace)) {
      rows.push({ kind: 'trace', id: `${item.id}:trace`, key: `${item.key}:trace`, seq: item.trace[0].seq, events: item.trace })
    }
    if (item.files.length) rows.push({ kind: 'media', id: `${item.id}:media`, key: `${item.key}:media`, seq: item.files[0].seq ?? item.seq, files: item.files })
  }
  return rows
}

export function traceHasVisibleContent(events: Event[]): boolean {
  return events.some(event => event.type === 'reasoning_summary' && Boolean(messageText(event).trim())) ||
    events.some(event => event.type === 'tool_started' || event.type === 'tool_finished') ||
    events.some(event => event.type === 'code_diff' && Boolean(event.run_id)) ||
    Boolean(extractUnifiedDiff(events).trim())
}

export function reconcileRenderTimelineItems(previous: RenderTimelineItem[], next: RenderTimelineItem[]): RenderTimelineItem[] {
  if (!previous.length) return next
  const previousByKey = new Map(previous.map(item => [item.key, item]))
  return next.map(item => {
    const before = previousByKey.get(item.key)
    if (!before || before.kind !== item.kind) return item
    if (before === item) return before
    if (before.kind === 'message' && item.kind === 'message' && before.event === item.event &&
      before.role === item.role && sameReferences(before.events, item.events) &&
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

function appendAssistantOutput(previous: Event[], event: Event, candidate: string, aggregate: boolean): void {
  const normalized = normalizeAssistantOutput(candidate)
  if (!normalized) return
  const prior = previous.map(event => normalizeAssistantOutput(messageText(event))).filter(Boolean)
  if (prior.includes(normalized)) return
  if (aggregate && prior.length > 0) {
    if (prior.join(' ') === normalized) return
    if (containsInOrder(normalized, prior)) {
      previous.splice(0, previous.length, event)
      return
    }
  }
  previous.push(event)
}

function containsInOrder(value: string, parts: string[]): boolean {
  let cursor = 0
  for (const part of parts) {
    const position = value.indexOf(part, cursor)
    if (position < 0) return false
    cursor = position + part.length
  }
  return true
}

function normalizeAssistantOutput(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function messageText(event: Event): string {
  return event.result_text || event.text || event.prompt || printableEventValue(event.message) || printableEventValue(event.error) || event.output || ''
}

export function eventErrorText(event: Event): string {
  return printableEventValue(event.error) || printableEventValue(event.message) || event.output || event.text || ''
}

export function messageItemText(item: MessageItem): string {
  return item.events.map(messageText).map(value => value.trim()).filter(Boolean).join('\n\n')
}

export function jobDisplayEvents(events: Event[]): Event[] {
  const standalone: Event[] = []
  const byRun = new Map<string, Event>()
  for (const event of events) {
    const runId = String(event.run_id || '').trim()
    if (!runId) {
      if (jobTypes.has(event.type)) standalone.push(event)
      continue
    }
    const priority = jobDisplayPriority(event)
    if (!priority) continue
    const current = byRun.get(runId)
    const currentPriority = current ? jobDisplayPriority(current) : 0
    if (!current || priority > currentPriority || priority === currentPriority && event.seq >= current.seq) {
      byRun.set(runId, event)
    }
  }
  return [...standalone, ...byRun.values()].sort((left, right) => left.seq - right.seq)
}

function jobDisplayPriority(event: Event): number {
  if (isTimelineError(event) || event.type === 'turn_stopped' || event.type === 'job_error') return 5
  if (event.type === 'turn_finished' && messageText(event).trim()) return 4
  if (event.type === 'assistant_text' && messageText(event).trim()) return 3
  if (event.type === 'job_finished') return 3
  if (event.type === 'job_ran' || event.type === 'job_started') return 2
  if (event.type === 'turn_started') return 1
  return 0
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
  lines: DiffLine[]
}

export interface DiffLine {
  kind: 'add' | 'remove' | 'context' | 'header' | 'hunk'
  text: string
  oldLine?: number
  newLine?: number
  oldStart?: number
  oldCount?: number
  newStart?: number
  newCount?: number
}

export interface CodeReviewTarget {
  sessionId: string
  runId?: string | null
  source?: string | null
  files?: CodeDiffFileSummary[] | null
  additions?: number | null
  deletions?: number | null
  repositoryRoot?: string | null
}

export function reviewTargetBelongsToSession(target: CodeReviewTarget | null, sessionId: string | null): boolean {
  return Boolean(target && sessionId && target.sessionId === sessionId)
}

export function parseUnifiedDiff(source: string): DiffFile[] {
  if (!source.trim()) return []
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of source.split('\n')) {
    const patchFile = line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.+)$/i)
    if (patchFile) {
      current = { path: cleanDiffPath(patchFile[2]), additions: 0, deletions: 0, lines: [{ kind: 'header', text: line }] }
      files.push(current); oldLine = 1; newLine = 1; inHunk = false; continue
    }
    if (line.startsWith('diff --git ')) {
      const match = line.match(/\s"?b\/(.+?)"?$/)
      current = { path: cleanDiffPath(match?.[1] ?? 'Changes'), additions: 0, deletions: 0, lines: [{ kind: 'header', text: line }] }
      files.push(current); inHunk = false; continue
    }
    if (!current) {
      if (line.startsWith('--- ')) { current = { path: cleanDiffPath(line.slice(4)), additions: 0, deletions: 0, lines: [] }; files.push(current) }
      else {
        const status = line.match(/^(?: M|M |MM|AM| A|A |\?\?| D|D | R|R )\s+(.+)$/)
        if (status) files.push({ path: cleanDiffPath(status[1]), additions: 0, deletions: 0, lines: [{ kind: 'header', text: line }] })
        continue
      }
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]); inHunk = true
      current.lines.push({
        kind: 'hunk', text: line,
        oldStart: oldLine, oldCount: Number(hunk[2] ?? 1),
        newStart: newLine, newCount: Number(hunk[4] ?? 1)
      })
      continue
    }
    if (line.startsWith('@@')) {
      inHunk = true
      current.lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (!inHunk) {
      current.lines.push({ kind: 'header', text: line })
      if (line.startsWith('+++ ') && current.path === '/dev/null') current.path = cleanDiffPath(line.slice(4))
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.additions++; current.lines.push({ kind: 'add', text: line.slice(1), newLine: newLine++ }); continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions++; current.lines.push({ kind: 'remove', text: line.slice(1), oldLine: oldLine++ }); continue
    }
    if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ }); continue
    }
    current.lines.push({ kind: 'header', text: line })
  }
  return files
}

export function parseReviewableDiff(source: string): DiffFile[] {
  return parseUnifiedDiff(source).filter(file => file.lines.some(line =>
    line.kind === 'hunk' || line.kind === 'add' || line.kind === 'remove' ||
    (line.kind === 'header' && (/^diff --git /.test(line.text) || /^\*\*\* (?:Update|Add|Delete) File:/.test(line.text) || /^Binary files /.test(line.text) || /^(?:old|new) mode \d+/.test(line.text)))
  ))
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
