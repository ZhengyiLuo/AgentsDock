import type { AgentFile, CodexPendingInteraction, Event, JsonValue, Snapshot } from '../types'
import { mergeEvents, mergeFiles, stripInjectedProviderAuthority } from './format'
import { boundImportedCrossChatDeliveryPrompt } from './imported-cross-chat-delivery'

export const LIVE_TIMELINE_EVENT_LIMIT = 720
export const HISTORY_WINDOW_EVENT_LIMIT = 2_400
export const TIMELINE_CHARACTER_BUDGET = 8_000_000
export const HISTORY_TIMELINE_CHARACTER_BUDGET = 16_000_000
export const IN_MEMORY_SNAPSHOT_LIMIT = 4

const MESSAGE_FIELD_LIMIT = 48_000
const TRACE_FIELD_LIMIT = 8_000
const FILE_TEXT_LIMIT = 12_000
const TIMELINE_LABEL_LIMIT = 1_000
const TRUNCATION_SUFFIX = '\n\n[Content truncated on mobile.]'
// Timeline events are immutable after sanitizing. Their size is consulted for
// every live append, so retain the result instead of repeatedly serializing the
// same tool and interaction payloads while a long chat is active.
const eventCharacterCosts = new WeakMap<Event, number>()

const historicalTraceTypes = new Set([
  'raw_event',
  'reasoning_summary',
  'tool_started',
  'tool_finished',
  'process_started',
  'provider_session',
  'cwd_fallback',
  'history_imported',
  'backend_changed',
  'artifact_error',
  'session_created',
  'idle_warning',
  'code_diff',
  'codex_thread_status',
])
const historicalTraceAnchorTypes = new Set([
  'reasoning_summary',
  'tool_started',
  'tool_finished',
  'code_diff',
])

/**
 * Older-message paging is conversation-first. Preserve only public commentary
 * that a later native steer explicitly links to its interrupted run.
 */
export function historicalTimelineEvents(events: Event[], contextEvents: readonly Event[] = []): Event[] {
  const successorSeqByRun = new Map<string, number>()
  const latestTraceAnchorByRun = new Map<string, Event>()
  const completedRunIds = new Set(
    [...contextEvents, ...events]
      .filter(event => ['turn_finished', 'turn_stopped', 'error'].includes(event.type))
      .map(event => event.run_id?.trim())
      .filter((value): value is string => Boolean(value)),
  )
  const collectSuccessors = (source: readonly Event[]) => {
    for (const event of source) {
      const runId = event.steer_interrupted_run_id?.trim()
      if (!runId || !Number.isFinite(event.seq)) continue
      successorSeqByRun.set(runId, Math.max(successorSeqByRun.get(runId) ?? -Infinity, event.seq))
    }
  }
  collectSuccessors(contextEvents)
  collectSuccessors(events)

  for (const event of events) {
    const runId = event.run_id?.trim()
    if (!runId || !completedRunIds.has(runId) || !historicalTraceAnchorTypes.has(event.type)) continue
    if (event.type === 'reasoning_summary' && !event.text?.trim()) continue
    const current = latestTraceAnchorByRun.get(runId)
    if (!current || event.seq > current.seq) latestTraceAnchorByRun.set(runId, event)
  }
  const traceAnchorIds = new Set([...latestTraceAnchorByRun.values()].map(event => event.id))

  return events.filter(event => {
    if (!historicalTraceTypes.has(event.type)) return true
    const runId = event.run_id?.trim()
    // Server semantic pages classify reviewable diffs as essential output.
    // Preserve them independently of the single lazy-trace anchor so a later
    // tool packet cannot remove the Review entry point on mobile.
    if (event.type === 'code_diff' && runId && completedRunIds.has(runId)) return true
    if (traceAnchorIds.has(event.id)) return true
    if (
      event.type !== 'reasoning_summary'
      || event.phase !== 'commentary'
      || !event.text?.trim()
      || !event.run_id?.trim()
    ) return false
    const successorSeq = successorSeqByRun.get(event.run_id)
    return successorSeq != null && event.seq < successorSeq
  })
}

/** Bound untrusted server text before it enters long-lived state or native views. */
export function sanitizeTimelineEvent(event: Event): Event {
  const next: Event = {
    ...event,
    // Remove launch-only provider authority while the complete suffix and its
    // end marker are still available. Truncating first could retain a partial
    // internal block that the display-level defense can no longer verify.
    prompt: boundImportedCrossChatDeliveryPrompt(event, MESSAGE_FIELD_LIMIT, TRUNCATION_SUFFIX) ?? sanitizePromptText(event.prompt),
    request_prompt: sanitizePromptText(event.request_prompt),
    display_prompt: sanitizePromptText(event.display_prompt),
    text: truncateText(event.text, MESSAGE_FIELD_LIMIT),
    result_text: truncateText(event.result_text, MESSAGE_FIELD_LIMIT),
    message: truncateText(event.message, MESSAGE_FIELD_LIMIT),
    digest: truncateText(event.digest, MESSAGE_FIELD_LIMIT),
    handoff_preview: truncateText(event.handoff_preview, MESSAGE_FIELD_LIMIT),
    source_title: truncateText(event.source_title, TIMELINE_LABEL_LIMIT),
    target_title: truncateText(event.target_title, TIMELINE_LABEL_LIMIT),
    requester_title: truncateText(event.requester_title, TIMELINE_LABEL_LIMIT),
    responder_title: truncateText(event.responder_title, TIMELINE_LABEL_LIMIT),
    output: truncateText(event.output, TRACE_FIELD_LIMIT),
    // Raw provider packets are transport data, not timeline presentation.
    raw: undefined,
    error: truncateJSON(event.error, TRACE_FIELD_LIMIT),
    argv: event.argv?.slice(0, 64).map(value => truncateRequiredText(value, 1_000)),
    tool: event.tool ? {
      ...event.tool,
      input: truncateJSON(event.tool.input, TRACE_FIELD_LIMIT),
    } : event.tool,
    interaction: sanitizeTimelineInteraction(event.interaction),
    file: sanitizeTimelineFile(event.file),
    artifact: sanitizeTimelineFile(event.artifact),
    // Compact timeline job payloads intentionally omit the private prompt.
    // Normalize that valid server shape before any string-length work.
    job: event.job ? {
      ...event.job,
      prompt: truncateRequiredText(typeof event.job.prompt === 'string' ? event.job.prompt : '', FILE_TEXT_LIMIT),
    } : event.job,
  }
  return next
}

export function boundLiveTimelineEvents(events: Event[]): Event[] {
  return takeWithinBudget(
    retainLatestThreadStatus(events),
    'newest',
    LIVE_TIMELINE_EVENT_LIMIT,
    TIMELINE_CHARACTER_BUDGET,
  )
}

/** Distinguish real tail eviction from intentional transient-status coalescing. */
export function liveTimelineEventsWereTrimmed(source: Event[], bounded: Event[]): boolean {
  let threadStatusCount = 0
  for (const event of source) if (event.type === 'codex_thread_status') threadStatusCount += 1
  const compactedLength = source.length - Math.max(0, threadStatusCount - 1)
  return bounded.length < compactedLength
}

export function boundHistoricalTimelineEvents(events: Event[]): Event[] {
  return takeWithinBudget(
    events,
    'newest',
    HISTORY_WINDOW_EVENT_LIMIT,
    HISTORY_TIMELINE_CHARACTER_BUDGET,
  )
}

/**
 * History paging owns the older-page cursor, while the live snapshot owns the
 * current tail. Combine them for presentation so scrolling to the bottom never
 * lands on a stale history-only copy of the chat.
 */
export function mergeHistoryWithLiveSnapshot(
  history: Snapshot,
  live?: Snapshot | null,
): Snapshot {
  if (!live || live.session.id !== history.session.id) return history

  const events = mergeEvents(history.events, live.events)
  const files = mergeFiles(history.files, live.files)
  return {
    ...history,
    session: live.session,
    events,
    queuedTurns: live.queuedTurns,
    files,
    filesTotal: Math.max(history.filesTotal, live.filesTotal, files.length),
    latestSeq: Math.max(
      finiteNumber(history.latestSeq),
      finiteNumber(live.latestSeq),
      events.at(-1)?.seq ?? 0,
    ),
    cachedAt: Math.max(finiteNumber(history.cachedAt), finiteNumber(live.cachedAt)),
  }
}

export function snapshotMapWith(
  snapshots: Record<string, Snapshot>,
  sessionId: string,
  snapshot: Snapshot,
): Record<string, Snapshot> {
  const candidates = Object.entries({ ...snapshots, [sessionId]: snapshot })
    .sort(([leftId, left], [rightId, right]) => {
      if (leftId === sessionId) return -1
      if (rightId === sessionId) return 1
      return (right.cachedAt ?? 0) - (left.cachedAt ?? 0) || leftId.localeCompare(rightId)
    })
    .slice(0, IN_MEMORY_SNAPSHOT_LIMIT)
  return Object.fromEntries(candidates)
}

function takeWithinBudget(
  events: Event[],
  edge: 'oldest' | 'newest',
  limit: number,
  characterBudget: number,
): Event[] {
  const source = edge === 'newest' ? [...events].reverse() : events
  const selected: Event[] = []
  let characters = 0
  for (const event of source) {
    if (selected.length >= limit) break
    const cost = eventCharacterCost(event)
    if (selected.length && characters + cost > characterBudget) break
    selected.push(event)
    characters += cost
  }
  return edge === 'newest' ? selected.reverse() : selected
}

function finiteNumber(value?: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * One newest thread-status event is enough to trigger Codex runtime refresh.
 * Superseded transitions are not conversation content and should not evict
 * user/assistant messages from the bounded live tail.
 */
function retainLatestThreadStatus(events: Event[]): Event[] {
  let retained = false
  const result: Event[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'codex_thread_status') {
      if (retained) continue
      retained = true
    }
    result.push(event)
  }
  return result.reverse()
}

function eventCharacterCost(event: Event): number {
  const cached = eventCharacterCosts.get(event)
  if (cached != null) return cached
  let total = 256
  for (const value of [event.prompt, event.request_prompt, event.display_prompt, event.text, event.result_text, event.message, event.digest, event.handoff_preview, event.source_title, event.target_title, event.requester_title, event.responder_title, event.output]) {
    if (typeof value === 'string') total += value.length
  }
  total += jsonLength(event.error)
  total += jsonLength(event.tool?.input)
  total += jsonLength(event.interaction?.params)
  total += event.file?.text?.length ?? 0
  total += event.artifact?.text?.length ?? 0
  total += event.job?.prompt?.length ?? 0
  eventCharacterCosts.set(event, total)
  return total
}

export function sanitizeTimelineFile(file?: AgentFile | null): AgentFile | null | undefined {
  return file ? { ...file, text: truncateText(file.text, FILE_TEXT_LIMIT) } : file
}

function sanitizeTimelineInteraction(
  interaction?: CodexPendingInteraction | null,
): CodexPendingInteraction | null | undefined {
  if (!interaction) return interaction
  return {
    ...interaction,
    params: truncateJSONObject(interaction.params, TRACE_FIELD_LIMIT),
  }
}

function truncateJSONObject(value: Record<string, JsonValue>, limit: number): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { _mobile_truncated: '[Invalid interaction parameters omitted on mobile.]' }
  }
  let serialized = ''
  try { serialized = JSON.stringify(value) }
  catch { return { _mobile_truncated: '[Unserializable interaction parameters omitted on mobile.]' } }
  if (serialized.length <= limit) return value

  const suffix = '\n[Interaction parameters truncated on mobile.]'
  const candidate = (prefixLength: number): Record<string, JsonValue> => ({
    _mobile_truncated: `${serialized.slice(0, prefixLength).trimEnd()}${suffix}`,
  })
  let lower = 0
  let upper = serialized.length
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2)
    if (JSON.stringify(candidate(middle)).length <= limit) lower = middle
    else upper = middle - 1
  }
  return candidate(lower)
}

function truncateJSON(value: JsonValue | undefined, limit: number): JsonValue | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return truncateRequiredText(value, limit)
  let serialized = ''
  try { serialized = JSON.stringify(value) }
  catch { return '[Unserializable content omitted on mobile.]' }
  return serialized.length <= limit ? value : truncateRequiredText(serialized, limit)
}

function truncateText(value: string | null | undefined, limit: number): string | null | undefined {
  return typeof value === 'string' ? truncateRequiredText(value, limit) : value
}

function sanitizePromptText(value: string | null | undefined): string | null | undefined {
  return typeof value === 'string'
    ? truncateRequiredText(stripInjectedProviderAuthority(value), MESSAGE_FIELD_LIMIT)
    : value
}

function truncateRequiredText(value: string, limit: number): string {
  if (value.length <= limit) return value
  const headLength = Math.max(0, limit - TRUNCATION_SUFFIX.length)
  return `${value.slice(0, headLength).trimEnd()}${TRUNCATION_SUFFIX}`
}

function jsonLength(value: JsonValue | undefined): number {
  if (value === undefined) return 0
  if (typeof value === 'string') return value.length
  try { return JSON.stringify(value).length }
  catch { return 0 }
}
