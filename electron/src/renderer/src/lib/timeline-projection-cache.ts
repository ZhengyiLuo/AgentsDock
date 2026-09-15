import type { AgentFile, Event } from '@shared/types'
import { crossChatSemanticKey } from '@shared/semantic-timeline'
import { isChatMailboxEvent } from '@shared/chat-inbox'
import {
  TimelineProjector,
  reconcileRenderTimelineItems,
  renderTimelineItems,
  type RenderTimelineItem,
  type TimelineItem,
  type TimelineProjectionScope
} from './timeline'

interface TimelineProjection {
  eventCount: number
  firstEvent: Event | null
  lastEvent: Event | null
  files: AgentFile[]
  projector: TimelineProjector
  semantic: TimelineItem[]
  rendered: RenderTimelineItem[]
  scope: TimelineProjectionScope
}

interface TimelineProjectionResult {
  semantic: TimelineItem[]
  rendered: RenderTimelineItem[]
  strategy: 'reuse' | 'append' | 'files' | 'rebuild'
  /** Number of semantic items traversed by the renderer for this update. */
  renderedSemanticCount: number
}

const MAX_CACHED_PROJECTIONS = 16
const MAX_INCREMENTAL_RENDER_SEMANTIC_ITEMS = 64
const projections = new Map<string, TimelineProjection>()

/**
 * `key` is also the source-prefix revision. Callers must change it when an
 * interior event is corrected without changing the cached first/last append
 * boundary; the renderer store encodes that revision in snapshot.generation.
 */
export function cachedTimelineProjection(
  key: string,
  events: Event[],
  files: AgentFile[],
  scope: TimelineProjectionScope = {}
): TimelineProjectionResult {
  const cached = projections.get(key)
  if (cached && projectionMatches(cached, events, files, scope)) {
    touch(key, cached)
    return { semantic: cached.semantic, rendered: cached.rendered, strategy: 'reuse', renderedSemanticCount: 0 }
  }

  if (cached && sameScope(cached.scope, scope) && eventsMatch(cached, events)) {
    const changed = cached.projector.updateKnownFiles(files)
    const semantic = cached.projector.items
    const rendered = changed
      ? reconcileRenderTimelineItems(cached.rendered, renderTimelineItems(semantic))
      : cached.rendered
    const next = projectionRecord(events, files, scope, cached.projector, semantic, rendered)
    touch(key, next)
    trimCache()
    return {
      semantic,
      rendered,
      strategy: changed ? 'files' : 'reuse',
      renderedSemanticCount: changed ? semantic.length : 0
    }
  }

  if (cached && sameScope(cached.scope, scope) && isAppendOnly(cached, events)) {
    cached.projector.updateKnownFiles(files)
    const appended = events.slice(cached.eventCount)
    if (cached.projector.append(appended)) {
      const semantic = cached.projector.items
      const incremental = renderAppendedTimeline(cached, semantic, appended)
      const next = projectionRecord(events, files, scope, cached.projector, semantic, incremental.rendered)
      touch(key, next)
      trimCache()
      return {
        semantic,
        rendered: incremental.rendered,
        strategy: 'append',
        renderedSemanticCount: incremental.renderedSemanticCount
      }
    }
  }

  const projector = new TimelineProjector(files, scope)
  if (!projector.append(events)) throw new Error('Timeline projection rebuild failed')
  const semantic = projector.items
  const rendered = reconcileRenderTimelineItems(cached?.rendered ?? [], renderTimelineItems(semantic))
  const next = projectionRecord(events, files, scope, projector, semantic, rendered)
  touch(key, next)
  trimCache()
  return { semantic, rendered, strategy: 'rebuild', renderedSemanticCount: semantic.length }
}

/**
 * TimelineProjector keeps unchanged semantic items referentially stable. Use
 * that copy-on-write boundary to render only the affected tail rather than
 * walking every historical turn for each live event.
 */
function renderAppendedTimeline(
  cached: TimelineProjection,
  semantic: TimelineItem[],
  appended: Event[]
): { rendered: RenderTimelineItem[]; renderedSemanticCount: number } {
  let renderStart = firstChangedSemanticIndex(cached.semantic, semantic)
  // A new mailbox arrival may join the immediately preceding sender group.
  // Include that one group, not the rest of the historical timeline.
  if (appended.some(isChatMailboxEvent) && renderStart > 0) {
    const previous = semantic[renderStart - 1]
    if (previous?.kind === 'system' && isChatMailboxEvent(previous.event)) {
      const grouped = cached.rendered.find(row => row.kind === 'system'
        && row.mailboxMessages?.some(message => message.key === previous.key))
      const first = grouped?.kind === 'system' ? grouped.mailboxMessages?.[0].key : previous.key
      const index = semantic.findIndex(item => item.key === first)
      if (index >= 0) renderStart = Math.min(renderStart, index)
    }
  }
  // A newly sent message changes a system owner, not the sender's TurnItem.
  // Re-render the overlapping turn too: it now has an activity boundary.
  // This also preserves its final answer when an old receipt is updated.
  if (appended.some(event => crossChatSemanticKey(event) !== null)) {
    const anchors = renderTimelineItems(semantic.slice(renderStart).filter(item =>
      item.kind === 'system' && crossChatSemanticKey(item.event) !== null))
      .filter(row => row.kind === 'system').map(row => row.seq)
    for (let index = 0; index < renderStart && anchors.length; index++) {
      const item = semantic[index]
      if (item.kind !== 'turn') continue
      const end = item.finishedAt
        ? item.terminalSeq ?? Math.max(item.seq, ...item.assistant.map(event => event.seq), ...item.trace.map(event => event.seq))
        : Number.POSITIVE_INFINITY
      if (anchors.some(seq => seq >= item.seq && seq <= end)) { renderStart = index; break }
    }
  }
  if (renderStart === semantic.length && semantic.length === cached.semantic.length) {
    return { rendered: cached.rendered, renderedSemanticCount: 0 }
  }

  const suffixSemanticCount = semantic.length - renderStart
  if (
    suffixSemanticCount > MAX_INCREMENTAL_RENDER_SEMANTIC_ITEMS
    || appended.some(isCompactionEvent)
  ) {
    return {
      rendered: reconcileRenderTimelineItems(cached.rendered, renderTimelineItems(semantic)),
      renderedSemanticCount: semantic.length
    }
  }

  const cut = renderStart < cached.semantic.length
    ? renderedCutForSemanticTail(cached.semantic, cached.rendered, renderStart)
    : cached.rendered.length
  const suffixSemantic = semantic.slice(renderStart)
  const previousSuffix = cached.rendered.slice(cut)
  // One earlier exchange can own both an early request and a later reply.
  // Chronological placement may put that reply inside the changed turn's
  // rendered suffix. Carry only those crossing system owners, not all the
  // intervening historical turns, into the incremental render.
  const crossingOwnerKeys = new Set(previousSuffix.flatMap(row =>
    row.kind === 'system' && crossChatSemanticKey(row.event) !== null ? systemRowOwnerKeys(row) : []))
  const crossingOwners = crossingOwnerKeys.size
    ? cached.semantic.slice(0, renderStart).filter(item =>
      item.kind === 'system' && crossingOwnerKeys.has(item.key))
    : []
  const carriedKeys = new Set(crossingOwners.map(item => item.key))
  const previousSuffixKeys = new Set(previousSuffix.map(row => row.key))
  const renderedSemantic = [...crossingOwners, ...suffixSemantic]
  const suffixRendered = reconcileRenderTimelineItems(
    previousSuffix,
    renderTimelineItems(renderedSemantic).filter(row =>
      row.kind !== 'system' || !carriedKeys.has(systemRowOwnerKey(row))
      || previousSuffixKeys.has(row.key))
  )
  return {
    rendered: [...cached.rendered.slice(0, cut), ...suffixRendered],
    renderedSemanticCount: renderedSemantic.length
  }
}

function firstChangedSemanticIndex(previous: TimelineItem[], next: TimelineItem[]): number {
  const limit = Math.min(previous.length, next.length)
  let index = 0
  while (index < limit && previous[index] === next[index]) index += 1
  return index
}

function renderedCutForSemanticTail(
  semantic: TimelineItem[],
  rendered: RenderTimelineItem[],
  startIndex: number
): number {
  let cut = rendered.length
  for (let semanticIndex = startIndex; semanticIndex < semantic.length; semanticIndex += 1) {
    const rowIndex = rendered.findIndex(row => renderedRowBelongsTo(semantic[semanticIndex], row))
    if (rowIndex >= 0) cut = Math.min(cut, rowIndex)
  }
  return cut
}

function renderedRowBelongsTo(item: TimelineItem, row: RenderTimelineItem): boolean {
  if (item.kind !== 'turn') return row.key === item.key
    || row.kind === 'system' && systemRowOwnerKeys(row).includes(item.key)
  return row.key === `${item.key}:trace`
    || row.key === `${item.key}:activity`
    || row.key.startsWith(`${item.key}:activity:after:`)
    || row.key === `${item.key}:assistant`
    || row.key.startsWith(`${item.key}:assistant:after:`)
    || row.key === `${item.key}:media`
    || row.key === `${item.key}:delivery-files`
    || Boolean(item.user && row.kind === 'system' && row.importedDelivery
      && row.key === `imported-cross-chat-delivery:${item.user.id}`)
    || row.key === `${item.key}:user:${item.user?.id ?? ''}`
}

function systemRowOwnerKey(row: Extract<RenderTimelineItem, { kind: 'system' }>): string {
  const suffix = row.crossChatLegId ? `:message:${row.crossChatLegId}` : ''
  return suffix && row.key.endsWith(suffix) ? row.key.slice(0, -suffix.length) : row.key
}

function systemRowOwnerKeys(row: Extract<RenderTimelineItem, { kind: 'system' }>): string[] {
  return row.mailboxMessages?.map(systemRowOwnerKey) ?? [systemRowOwnerKey(row)]
}

function isCompactionEvent(event: Event): boolean {
  return event.type === 'codex_compaction_started' || event.type === 'codex_compaction_completed'
}

export function clearTimelineProjectionCache(): void {
  projections.clear()
}

export function dropTimelineProjectionCache(sessionId: string): void {
  const prefix = `${sessionId}:`
  for (const key of projections.keys()) {
    if (key.startsWith(prefix)) projections.delete(key)
  }
}

function touch(key: string, value: TimelineProjection): void {
  projections.delete(key)
  projections.set(key, value)
}

function projectionMatches(
  cached: TimelineProjection,
  events: Event[],
  files: AgentFile[],
  scope: TimelineProjectionScope
): boolean {
  return sameReferences(cached.files, files) && sameScope(cached.scope, scope) && eventsMatch(cached, events)
}

function sameScope(left: TimelineProjectionScope, right: TimelineProjectionScope): boolean {
  return (left.rootThreadId?.trim() || '') === (right.rootThreadId?.trim() || '')
    && (left.activeRunId?.trim() || '') === (right.activeRunId?.trim() || '')
}

function eventsMatch(cached: TimelineProjection, events: Event[]): boolean {
  return cached.eventCount === events.length && cached.firstEvent === (events[0] ?? null) &&
    cached.lastEvent === (events.at(-1) ?? null)
}

function sameReferences<T>(left: T[], right: T[]): boolean {
  return left === right || left.length === right.length && left.every((value, index) => value === right[index])
}

function isAppendOnly(cached: TimelineProjection, events: Event[]): boolean {
  if (cached.eventCount <= 0 || events.length <= cached.eventCount) return false
  if (events[0] !== cached.firstEvent || events[cached.eventCount - 1] !== cached.lastEvent) return false
  const firstAppended = events[cached.eventCount]
  return Boolean(firstAppended && cached.lastEvent && firstAppended.seq >= cached.lastEvent.seq)
}

function projectionRecord(
  events: Event[],
  files: AgentFile[],
  scope: TimelineProjectionScope,
  projector: TimelineProjector,
  semantic: TimelineItem[],
  rendered: RenderTimelineItem[]
): TimelineProjection {
  return {
    eventCount: events.length,
    firstEvent: events[0] ?? null,
    lastEvent: events.at(-1) ?? null,
    files,
    scope: { ...scope },
    projector,
    semantic,
    rendered
  }
}

function trimCache(): void {
  while (projections.size > MAX_CACHED_PROJECTIONS) {
    const oldest = projections.keys().next().value
    if (oldest == null) break
    projections.delete(oldest)
  }
}
