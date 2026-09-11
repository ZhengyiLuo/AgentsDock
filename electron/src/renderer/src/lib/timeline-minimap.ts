import type { Event, TimelineIndexLandmark, TimelineLandmarkKind } from '@shared/types'
import type { RenderTimelineItem } from './timeline'
import { isHandoffDigestEvent, isTimelineError, jobDisplaySelection, messageItemText, messageText } from './timeline'
import { getLocale, t, type Locale } from '@shared/i18n'
import { timelineCount, timelineEventLabel } from './timeline-labels'

export interface TimelineLandmark extends TimelineIndexLandmark {
  index: number
  endIndex: number
}

export interface TimelineNavigatorLandmark extends TimelineIndexLandmark {
  index?: number
  endIndex?: number
}

export interface LoadedTimelinePosition {
  position: number
  index: number
  endIndex: number
}

export const TIMELINE_TICK_PITCH = 12
const landmarkCache = new WeakMap<RenderTimelineItem[], Partial<Record<Locale, TimelineLandmark[]>>>()
// Localized display overlays are transient. Retaining the coordinate spine
// must not freeze a loaded window's language into the canonical server copy.
const landmarkDisplaySources = new WeakMap<TimelineNavigatorLandmark, TimelineIndexLandmark>()

export function timelineTickY(position: number, scrollOffset = 0, trackTop = 10): number {
  return trackTop + position * TIMELINE_TICK_PITCH - scrollOffset
}

export function buildTimelineLandmarks(items: RenderTimelineItem[]): TimelineLandmark[] {
  const landmarks: TimelineLandmark[] = []
  let index = 0
  while (index < items.length) {
    const item = items[index]
    if (item.kind === 'progress' && item.active !== false) {
      index++
      continue
    }
    const groupKey = turnGroupKey(item)
    if (groupKey) {
      let endIndex = index
      while (endIndex + 1 < items.length && turnGroupKey(items[endIndex + 1]) === groupKey) endIndex++
      landmarks.push(turnLandmark(items.slice(index, endIndex + 1), index, endIndex, groupKey))
      index = endIndex + 1
      continue
    }
    landmarks.push(standaloneLandmark(item, index))
    index++
  }
  return landmarks
}

export function cachedTimelineLandmarks(items: RenderTimelineItem[]): TimelineLandmark[] {
  const locale = getLocale()
  const cache = landmarkCache.get(items) ?? {}
  const cached = cache[locale]
  if (cached) return cached
  const landmarks = buildTimelineLandmarks(items)
  cache[locale] = landmarks
  landmarkCache.set(items, cache)
  return landmarks
}

export function visibleLoadedPositions(
  positions: LoadedTimelinePosition[],
  startIndex: number,
  endIndex: number
): [number, number] | null {
  let low = 0
  let high = positions.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (positions[middle].endIndex < startIndex) low = middle + 1
    else high = middle
  }

  let first = -1
  let last = -1
  for (let index = low; index < positions.length; index += 1) {
    const candidate = positions[index]
    if (candidate.index > endIndex) break
    if (first < 0) first = candidate.position
    last = candidate.position
  }
  return first < 0 ? null : [first, last]
}

export function countOlderTimelineLandmarks(
  landmarks: TimelineIndexLandmark[],
  pagingBoundary: number
): number {
  return landmarks.reduce(
    (count, landmark) => count + (landmark.start_seq < pagingBoundary ? 1 : 0),
    0
  )
}

export function hasOlderTimelineContent(
  landmarks: TimelineIndexLandmark[],
  pagingBoundary: number
): boolean {
  return landmarks.some(landmark => landmark.start_seq < pagingBoundary)
}

export function mergeTimelineLandmarks(remote: TimelineIndexLandmark[] | undefined, loaded: TimelineLandmark[]): TimelineNavigatorLandmark[] {
  if (!remote?.length) return loaded
  const loadedByKey = new Map(loaded.map(landmark => [landmark.key, landmark]))
  const loadedBySequence = [...loaded].sort((left, right) => left.start_seq - right.start_seq || left.end_seq - right.end_seq)
  const remoteKeys = new Set(remote.map(landmark => landmark.key))
  const remoteEndSeq = Math.max(...remote.map(landmark => landmark.end_seq))
  let loadedCursor = 0

  // The server index is the full-chat coordinate spine. A historical window
  // is only a temporary loaded slice, so it may enrich a spine entry with its
  // local row position and complete display copy, but must never insert,
  // reorder, or change the identity or sequence range of existing entries.
  // Otherwise opening that slice changes every proportional pointer target.
  const spine = remote.map(landmark => {
    let local = loadedByKey.get(landmark.key)
    while (!local && loadedCursor < loadedBySequence.length && loadedBySequence[loadedCursor].end_seq < landmark.start_seq) {
      loadedCursor += 1
    }
    if (!local) {
      for (let index = loadedCursor; index < loadedBySequence.length && loadedBySequence[index].start_seq <= landmark.end_seq; index += 1) {
        const candidate = loadedBySequence[index]
        if (rangesOverlap(landmark, candidate) && compatibleKinds(landmark.kind, candidate.kind)) {
          local = candidate
          break
        }
      }
    }
    if (!local) return { ...landmark }
    const merged = { ...landmark, index: local.index, endIndex: local.endIndex }
    // A partial turn (or a broad sequence-overlap alias) can locate a row but
    // cannot replace the full turn's prompt, answer or command/run counts.
    const completeDisplay = local.kind === landmark.kind
      && local.start_seq <= landmark.start_seq && local.end_seq >= landmark.end_seq
      && (local.key === landmark.key
        || (local.start_seq === landmark.start_seq && local.end_seq === landmark.end_seq))
    if (completeDisplay) {
      merged.title = local.title
      merged.preview = local.preview
      merged.meta = local.meta
      landmarkDisplaySources.set(merged, landmarkDisplaySources.get(landmark) ?? landmark)
    }
    return merged
  })
  // The index is fetched once when a chat opens. Preserve later live turns,
  // but never admit temporary historical-window rows into its interior.
  const liveTail = loaded
    .filter(landmark => landmark.start_seq > remoteEndSeq && !remoteKeys.has(landmark.key))
    .sort((left, right) => left.start_seq - right.start_seq || left.end_seq - right.end_seq)
  return [...spine, ...liveTail]
}

export function retainTimelineLandmarkSpine(
  landmarks: TimelineNavigatorLandmark[]
): TimelineIndexLandmark[] {
  return landmarks.map(landmark => {
    const retained: TimelineNavigatorLandmark = { ...(landmarkDisplaySources.get(landmark) ?? landmark) }
    delete retained.index
    delete retained.endIndex
    return retained
  })
}

export function compactPreview(value: string, limit = 240): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return t('timeline.minimap.noPreview')
  return compact.length <= limit ? compact : `${compact.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

function turnGroupKey(item: RenderTimelineItem): string | null {
  if (item.kind === 'system' || item.kind === 'job') return null
  if (item.kind === 'progress' && item.active !== false) return null
  return item.key.match(/^(turn:.*?):(?:user|assistant|trace|activity|media)(?::|$)/)?.[1] ?? item.key
}

function turnLandmark(items: RenderTimelineItem[], index: number, endIndex: number, key: string): TimelineLandmark {
  const messages = items.filter((item): item is Extract<RenderTimelineItem, { kind: 'message' }> => item.kind === 'message')
  const user = messages.find(item => item.role === 'user')
  const assistants = messages.filter(item => item.role === 'assistant')
  const latestAssistant = assistants.at(-1)
  const traces = items.filter((item): item is Extract<RenderTimelineItem, { kind: 'trace' }> => item.kind === 'trace')
  const activities = items.filter((item): item is Extract<RenderTimelineItem, { kind: 'progress' }> => item.kind === 'progress')
  const media = items.filter((item): item is Extract<RenderTimelineItem, { kind: 'media' }> => item.kind === 'media')
  const files = media.flatMap(item => item.files)
  const activityEvents = [...traces, ...activities].flatMap(item => item.events)
  const tools = activityEvents.filter(event => event.type === 'tool_started')
  const prompt = user ? messageText(user.event) : ''
  const response = latestAssistant ? messageItemText(latestAssistant) : ''
  const tracePreview = activityEvents.map(event => messageText(event) || event.tool?.name || '').find(Boolean) || ''
  const fileNames = files.map(file => file.title || file.filename).filter(Boolean)
  const title = compactPreview(prompt || response || tracePreview || fileNames[0] || t('timeline.minimap.agentTurn'), 72)
  const preview = compactPreview(response || tracePreview || fileNames.join(', ') || prompt)
  const meta = fileNames.length
    ? `${fileNames.slice(0, 2).join(' · ')}${fileNames.length > 2 ? ` · +${fileNames.length - 2}` : ''}`
    : tools.length ? timelineCount('commands', tools.length) : ''
  return {
    index,
    endIndex,
    key,
    kind: user?.event.purpose === 'handoff_digest' ? 'digest' : user ? 'user' : 'assistant',
    title,
    preview,
    meta,
    start_seq: Math.min(...items.map(itemStartSeq)),
    end_seq: Math.max(...items.map(itemEndSeq)),
    timestamp: latestAssistant?.event.ts || user?.event.ts || activityEvents[0]?.ts || activities[0]?.startedAt
  }
}

function standaloneLandmark(item: RenderTimelineItem, index: number): TimelineLandmark {
  if (item.kind === 'job') {
    const { latest, updates } = jobDisplaySelection(item)
    // A contiguous scheduled-job segment stays where its first firing entered
    // the chat. Late completion updates that card in place, so the minimap
    // must keep the same immutable chronological anchor as the rendered row.
    const anchorSeq = item.startSeq
    const anchorEvent = item.events.reduce<Event | undefined>(
      (earliest, event) => !earliest || event.seq < earliest.seq ? event : earliest,
      undefined
    )
    return {
      index,
      endIndex: index,
      key: item.key,
      kind: 'job',
      title: item.title || t('timeline.minimap.scheduledJob'),
      preview: compactPreview(messageText(latest)),
      meta: timelineCount('runs', item.runCount || updates.length),
      start_seq: anchorSeq,
      end_seq: anchorSeq,
      timestamp: anchorEvent?.ts || item.latest.ts
    }
  }
  if (item.kind === 'system') {
    if (item.crossChatMessage) {
      const incoming = item.event.target_session_id === item.event.session_id
        && item.event.source_session_id !== item.event.session_id
      const title = incoming
        ? t('timeline.exchange.importedMessageFrom', { sender: item.event.source_title || t('timeline.ui.unknownAgent') })
        : t('timeline.handoff.sent', { title: item.event.target_title || t('timeline.ui.unknownAgent') })
      return {
        index, endIndex: index, key: item.key, kind: 'system', title,
        preview: compactPreview(item.event.handoff_preview || ''), meta: '',
        start_seq: item.seq, end_seq: item.seq, timestamp: item.anchorTs || item.event.ts
      }
    }
    const digest = isHandoffDigestEvent(item.event)
    return {
      index,
      endIndex: index,
      key: item.key,
      kind: isTimelineError(item.event) ? 'error' : digest ? 'digest' : 'system',
      title: timelineEventLabel(item.event.type),
      preview: compactPreview(messageText(item.event)),
      meta: '',
      start_seq: item.seq,
      end_seq: item.event.seq,
      timestamp: item.event.ts
    }
  }
  return turnLandmark([item], index, index, item.key)
}

function itemStartSeq(item: RenderTimelineItem): number {
  if (item.kind === 'message') return Math.min(...item.events.map(event => event.seq))
  if (item.kind === 'system') return item.event.seq
  if (item.kind === 'progress') return item.events.length
    ? Math.min(...item.events.map(event => event.seq))
    : item.seq
  if (item.kind === 'job') return item.startSeq
  if (item.kind === 'trace') return Math.min(...item.events.map(event => event.seq))
  return Math.min(...item.files.map(file => file.seq ?? item.seq))
}

function itemEndSeq(item: RenderTimelineItem): number {
  if (item.kind === 'message') return Math.max(...item.events.map(event => event.seq))
  if (item.kind === 'system') return item.event.seq
  if (item.kind === 'progress') return item.events.length
    ? Math.max(...item.events.map(event => event.seq))
    : item.seq
  if (item.kind === 'job') return item.endSeq
  if (item.kind === 'trace') return Math.max(...item.events.map(event => event.seq))
  return Math.max(...item.files.map(file => file.seq ?? item.seq))
}

function rangesOverlap(left: TimelineIndexLandmark, right: TimelineIndexLandmark): boolean {
  return left.start_seq <= right.end_seq && right.start_seq <= left.end_seq
}

function compatibleKinds(left: TimelineLandmarkKind, right: TimelineLandmarkKind): boolean {
  if (left === right) return true
  const turnKinds = new Set<TimelineLandmarkKind>(['user', 'assistant', 'trace', 'media', 'digest'])
  return turnKinds.has(left) && turnKinds.has(right)
}
