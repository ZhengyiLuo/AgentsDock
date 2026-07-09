import type { TimelineIndexLandmark, TimelineLandmarkKind } from '@shared/types'
import type { RenderTimelineItem } from './timeline'
import { isTimelineError, messageText } from './timeline'

export interface TimelineLandmark extends TimelineIndexLandmark {
  index: number
  endIndex: number
}

export interface TimelineNavigatorLandmark extends TimelineIndexLandmark {
  index?: number
  endIndex?: number
}

export const TIMELINE_TICK_PITCH = 12

export function timelineTickY(position: number, scrollOffset = 0, trackTop = 10): number {
  return trackTop + position * TIMELINE_TICK_PITCH - scrollOffset
}

export function buildTimelineLandmarks(items: RenderTimelineItem[]): TimelineLandmark[] {
  const landmarks: TimelineLandmark[] = []
  let index = 0
  while (index < items.length) {
    const item = items[index]
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

export function mergeTimelineLandmarks(remote: TimelineIndexLandmark[] | undefined, loaded: TimelineLandmark[]): TimelineNavigatorLandmark[] {
  if (!remote?.length) return loaded
  const merged: TimelineNavigatorLandmark[] = remote.map(landmark => ({ ...landmark }))
  const positions = new Map(merged.map((landmark, index) => [landmark.key, index]))
  for (const landmark of loaded) {
    let position = positions.get(landmark.key)
    if (position == null) {
      position = merged.findIndex(candidate => rangesOverlap(candidate, landmark) && compatibleKinds(candidate.kind, landmark.kind))
    }
    if (position >= 0) {
      merged[position] = { ...merged[position], ...landmark }
      positions.set(landmark.key, position)
    } else {
      merged.push(landmark)
    }
  }
  return merged.sort((left, right) => left.start_seq - right.start_seq || left.end_seq - right.end_seq)
}

export function compactPreview(value: string, limit = 240): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return 'No text preview'
  return compact.length <= limit ? compact : `${compact.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

function humanizeType(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase())
}

function turnGroupKey(item: RenderTimelineItem): string | null {
  if (item.kind === 'system' || item.kind === 'job') return null
  return item.key.match(/^(turn:.*?):(?:user|assistant|trace|media)(?::|$)/)?.[1] ?? item.key
}

function turnLandmark(items: RenderTimelineItem[], index: number, endIndex: number, key: string): TimelineLandmark {
  const messages = items.filter((item): item is Extract<RenderTimelineItem, { kind: 'message' }> => item.kind === 'message')
  const user = messages.find(item => item.role === 'user')
  const assistants = messages.filter(item => item.role === 'assistant')
  const latestAssistant = assistants.at(-1)
  const traces = items.filter((item): item is Extract<RenderTimelineItem, { kind: 'trace' }> => item.kind === 'trace')
  const media = items.filter((item): item is Extract<RenderTimelineItem, { kind: 'media' }> => item.kind === 'media')
  const files = media.flatMap(item => item.files)
  const tools = traces.flatMap(item => item.events).filter(event => event.type === 'tool_started')
  const prompt = user ? messageText(user.event) : ''
  const response = latestAssistant ? messageText(latestAssistant.event) : ''
  const tracePreview = traces.flatMap(item => item.events).map(event => messageText(event) || event.tool?.name || '').find(Boolean) || ''
  const fileNames = files.map(file => file.title || file.filename).filter(Boolean)
  const title = compactPreview(prompt || response || tracePreview || fileNames[0] || 'Agent turn', 72)
  const preview = compactPreview(response || tracePreview || fileNames.join(', ') || prompt)
  const meta = fileNames.length
    ? `${fileNames.slice(0, 2).join(' · ')}${fileNames.length > 2 ? ` · +${fileNames.length - 2}` : ''}`
    : tools.length ? `Ran ${tools.length} command${tools.length === 1 ? '' : 's'}` : ''
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
    timestamp: latestAssistant?.event.ts || user?.event.ts || traces[0]?.events[0]?.ts
  }
}

function standaloneLandmark(item: RenderTimelineItem, index: number): TimelineLandmark {
  if (item.kind === 'job') {
    return {
      index,
      endIndex: index,
      key: item.key,
      kind: 'job',
      title: item.title || 'Scheduled job',
      preview: compactPreview(messageText(item.latest)),
      meta: `${item.events.length} update${item.events.length === 1 ? '' : 's'}`,
      start_seq: Math.min(...item.events.map(event => event.seq)),
      end_seq: Math.max(...item.events.map(event => event.seq)),
      timestamp: item.latest.ts
    }
  }
  if (item.kind === 'system') {
    const digest = item.event.type.startsWith('handoff_digest_')
    return {
      index,
      endIndex: index,
      key: item.key,
      kind: isTimelineError(item.event) ? 'error' : digest ? 'digest' : 'system',
      title: humanizeType(item.event.type),
      preview: compactPreview(messageText(item.event)),
      meta: '',
      start_seq: item.event.seq,
      end_seq: item.event.seq,
      timestamp: item.event.ts
    }
  }
  return turnLandmark([item], index, index, item.key)
}

function itemStartSeq(item: RenderTimelineItem): number {
  if (item.kind === 'message' || item.kind === 'system') return item.event.seq
  if (item.kind === 'trace' || item.kind === 'job') return Math.min(...item.events.map(event => event.seq))
  return Math.min(...item.files.map(file => file.seq ?? item.seq))
}

function itemEndSeq(item: RenderTimelineItem): number {
  if (item.kind === 'message' || item.kind === 'system') return item.event.seq
  if (item.kind === 'trace' || item.kind === 'job') return Math.max(...item.events.map(event => event.seq))
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
