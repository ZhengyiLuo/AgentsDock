import type { ChatReference, ChatReferenceAction, Event } from '../types'
import { MAX_CHAT_REFERENCES } from './chat-references'
import { messageText } from './format'

export interface InlineRouteSegment {
  text: string
  reference?: ChatReference
}

export interface InlineRouteMarker {
  marker: string
  displayText: string
  reference: ChatReference
}

const EMPTY_INLINE_ROUTE_MARKERS: InlineRouteMarker[] = []
const CHAT_REFERENCE_ACTIONS = new Set<ChatReferenceAction>([
  'direct_message',
  'route',
  'request_reply',
  'instruction',
  'final_result',
])

export interface InlineRoutePresentation {
  text: string
  references: ChatReference[]
  /** Structured route records that are not safe/visible enough to become links. */
  fallbackReferences: ChatReference[]
}

/** Stable across local and secure-peer records with the same visible title. */
export function timelineChatReferenceKey(reference: ChatReference): string {
  return [
    reference.target_kind ?? 'local',
    reference.target_server_identity ?? '',
    reference.target_connection_id ?? '',
    reference.target_route_id ?? '',
    reference.target_route_revision ?? '',
    reference.session_id,
    reference.source_text_start,
    reference.source_text_end,
    reference.action,
    reference.display_title_snapshot,
  ].join('\u0000')
}

export function timelineChatReferenceIsRemote(reference: ChatReference): boolean {
  return reference.target_kind === 'secure_peer'
    || reference.target_server_identity !== undefined
    || reference.target_connection_id !== undefined
    || reference.target_route_id !== undefined
    || reference.target_route_revision !== undefined
}

/** Only same-server route history can navigate inside the current workspace. */
export function inlineRouteReferenceIsInteractive(reference: ChatReference): boolean {
  return reference.action === 'route' && !timelineChatReferenceIsRemote(reference)
}

/**
 * Rebuild the same trimmed, blank-line-separated text used by message rows,
 * while translating each event-local route offset into the combined string.
 * A malformed historical record remains available to a read-only fallback;
 * it must never silently become a local navigation target.
 */
export function inlineRoutePresentation(events: readonly Event[]): InlineRoutePresentation {
  let text = ''
  const references: ChatReference[] = []
  const fallbackReferences: ChatReference[] = []
  for (const event of events) {
    const raw = messageText(event)
    const start = raw.search(/\S/u)
    if (start < 0) continue
    const endMatch = /\s*$/u.exec(raw)
    const end = endMatch?.index ?? raw.length
    const part = raw.slice(start, end)
    if (text) text += '\n\n'
    const partOffset = text.length
    text += part
    for (const reference of safeStoredTimelineReferences(event.chat_references)) {
      if (!inlineRouteCandidate(reference)) continue
      const translated = translateEventReference(reference, partOffset - start)
      const exact = timelineInlineReferencesForText(raw, [reference], event.session_id)
      if (
        exact.length === 1
        && reference.source_text_start >= start
        && reference.source_text_end <= end
      ) references.push(translated)
      else fallbackReferences.push(translated)
    }
  }
  references.sort(compareTimelineReferences)
  fallbackReferences.sort(compareTimelineReferences)
  return { text, references, fallbackReferences }
}

/**
 * Returns exact, non-overlapping inline routes for this particular visible
 * string. Callers use the remainder as inert fallback UI when a long message
 * is folded before its stored marker.
 */
export function timelineInlineReferencesForText(
  text: string,
  references: readonly ChatReference[],
  sourceSessionId?: string | null,
): ChatReference[] {
  if (!wellFormedUtf16(text)) return []
  const accepted: ChatReference[] = []
  const occupied: Array<[number, number]> = []
  const seenAuthority = new Set<string>()
  for (const reference of [...references].slice(0, MAX_CHAT_REFERENCES).sort(compareTimelineReferences)) {
    if (!safeTimelineReferenceShape(reference) || !inlineRouteCandidate(reference)) continue
    if (!validTimelineReferenceTarget(reference, sourceSessionId)) continue
    if (
      reference.source_text_start < 0
      || reference.source_text_end <= reference.source_text_start
      || reference.source_text_end > text.length
      || !timelineReferenceTokenMatches(text, reference)
    ) continue
    if (occupied.some(([start, end]) => reference.source_text_start < end && reference.source_text_end > start)) continue
    const authority = timelineReferenceAuthorityKey(reference)
    if (seenAuthority.has(authority)) continue
    accepted.push(reference)
    occupied.push([reference.source_text_start, reference.source_text_end])
    seenAuthority.add(authority)
  }
  return accepted
}

export function splitInlineRouteText(text: string, references: readonly ChatReference[]): InlineRouteSegment[] {
  const segments: InlineRouteSegment[] = []
  let cursor = 0
  for (const reference of timelineInlineReferencesForText(text, references)) {
    if (reference.source_text_start > cursor) segments.push({ text: text.slice(cursor, reference.source_text_start) })
    segments.push({ text: text.slice(reference.source_text_start, reference.source_text_end), reference })
    cursor = reference.source_text_end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments.length ? segments : [{ text }]
}

export function prepareInlineRouteMarkdown(
  text: string,
  references: readonly ChatReference[],
  sourceSessionId?: string | null,
): { text: string; markers: InlineRouteMarker[] } {
  const valid = timelineInlineReferencesForText(text, references, sourceSessionId)
  if (!valid.length) return { text, markers: EMPTY_INLINE_ROUTE_MARKERS }
  const markers: InlineRouteMarker[] = []
  let nextMarkerCodePoint = 0xe000
  let output = ''
  let cursor = 0
  for (const reference of valid) {
    while (
      nextMarkerCodePoint <= 0xf8ff
      && (text.includes(String.fromCharCode(nextMarkerCodePoint))
        || markers.some(candidate => candidate.marker[0] === String.fromCharCode(nextMarkerCodePoint)))
    ) nextMarkerCodePoint += 1
    if (nextMarkerCodePoint > 0xf8ff) break
    const markerCharacter = String.fromCharCode(nextMarkerCodePoint++)
    const displayText = text.slice(reference.source_text_start, reference.source_text_end)
    const marker = markerCharacter.repeat(displayText.length)
    output += text.slice(cursor, reference.source_text_start)
    output += marker
    cursor = reference.source_text_end
    markers.push({ marker, displayText, reference })
  }
  output += text.slice(cursor)
  return { text: output, markers }
}

export function splitInlineRouteMarkerText(value: string, markers: readonly InlineRouteMarker[]): InlineRouteSegment[] {
  const output: InlineRouteSegment[] = []
  let cursor = 0
  while (cursor < value.length) {
    let nextIndex = -1
    let nextMarker: InlineRouteMarker | null = null
    for (const candidate of markers) {
      const found = value.indexOf(candidate.marker, cursor)
      if (found >= 0 && (nextIndex < 0 || found < nextIndex)) {
        nextIndex = found
        nextMarker = candidate
      }
    }
    if (nextIndex < 0 || !nextMarker) break
    if (nextIndex > cursor) output.push({ text: value.slice(cursor, nextIndex) })
    output.push({ text: nextMarker.displayText, reference: nextMarker.reference })
    cursor = nextIndex + nextMarker.marker.length
  }
  if (cursor < value.length) output.push({ text: value.slice(cursor) })
  return output.length ? output : [{ text: restoreInlineRouteMarkerText(value, markers) }]
}

export function restoreInlineRouteMarkerText(value: string, markers: readonly InlineRouteMarker[]): string {
  return markers.reduce((restored, candidate) => restored.replaceAll(candidate.marker, candidate.displayText), value)
}

function safeStoredTimelineReferences(value: unknown): ChatReference[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_CHAT_REFERENCES).flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const item = candidate as Record<string, unknown>
    if (
      typeof item.session_id !== 'string'
      || typeof item.display_title_snapshot !== 'string'
      || typeof item.source_text_start !== 'number'
      || typeof item.source_text_end !== 'number'
      || !CHAT_REFERENCE_ACTIONS.has(item.action as ChatReferenceAction)
      || (item.target_kind !== undefined && item.target_kind !== 'secure_peer')
    ) return []
    const reference: ChatReference = {
      session_id: item.session_id,
      display_title_snapshot: item.display_title_snapshot,
      source_text_start: item.source_text_start,
      source_text_end: item.source_text_end,
      action: item.action as ChatReferenceAction,
      ...(item.grant_intent === true ? { grant_intent: true as const } : {}),
      ...(item.route_action === 'instruction' || item.route_action === 'request_reply'
        ? { route_action: item.route_action }
        : {}),
      ...(item.target_kind === 'secure_peer' ? { target_kind: 'secure_peer' as const } : {}),
      ...(typeof item.target_server_identity === 'string' ? { target_server_identity: item.target_server_identity } : {}),
      ...(typeof item.target_connection_id === 'string' ? { target_connection_id: item.target_connection_id } : {}),
      ...(typeof item.target_route_id === 'string' ? { target_route_id: item.target_route_id } : {}),
      ...(typeof item.target_route_revision === 'string' ? { target_route_revision: item.target_route_revision } : {}),
    }
    return safeTimelineReferenceShape(reference) ? [reference] : []
  })
}

function safeTimelineReferenceShape(reference: ChatReference): boolean {
  return typeof reference.session_id === 'string'
    && reference.session_id.length > 0
    && reference.session_id === reference.session_id.trim()
    && unicodeScalarLength(reference.session_id) <= 240
    && cleanText(reference.session_id)
    && typeof reference.display_title_snapshot === 'string'
    && reference.display_title_snapshot.length > 0
    && unicodeScalarLength(reference.display_title_snapshot) <= 320
    && !reference.display_title_snapshot.startsWith('@')
    && cleanText(reference.display_title_snapshot)
    && CHAT_REFERENCE_ACTIONS.has(reference.action)
    && Number.isSafeInteger(reference.source_text_start)
    && Number.isSafeInteger(reference.source_text_end)
}

function inlineRouteCandidate(reference: ChatReference): boolean {
  return reference.action === 'route'
    || (reference.target_kind === 'secure_peer' && reference.action === 'instruction')
}

function validTimelineReferenceTarget(reference: ChatReference, sourceSessionId?: string | null): boolean {
  if (reference.target_kind === 'secure_peer') {
    return reference.session_id === reference.target_route_id
      && uuidV4(reference.target_connection_id)
      && uuidV4(reference.target_route_id)
      && typeof reference.target_server_identity === 'string'
      && reference.target_server_identity.length > 0
      && reference.target_server_identity.length <= 240
      && cleanText(reference.target_server_identity)
      && typeof reference.target_route_revision === 'string'
      && /^rev_[0-9a-f]{32}$/u.test(reference.target_route_revision)
      && (reference.action === 'instruction' || reference.action === 'request_reply')
  }
  return reference.session_id !== sourceSessionId
    && !timelineChatReferenceIsRemote(reference)
}

function timelineReferenceTokenMatches(text: string, reference: ChatReference): boolean {
  const previous = reference.source_text_start > 0 ? text[reference.source_text_start - 1] : ''
  const next = reference.source_text_end < text.length ? text[reference.source_text_end] : ''
  const token = text.slice(reference.source_text_start, reference.source_text_end)
  const current = `@${reference.display_title_snapshot}`
  const legacy = reference.action === 'route' ? `@@${reference.display_title_snapshot}` : null
  return (token === current || token === legacy)
    && (!previous || /\s|[([{]/u.test(previous))
    && (!next || /\s/u.test(next))
}

function timelineReferenceAuthorityKey(reference: ChatReference): string {
  return reference.target_kind === 'secure_peer'
    ? `secure_peer\u0000${reference.target_server_identity}\u0000${reference.target_connection_id}\u0000${reference.target_route_id}\u0000${reference.action}`
    : `${reference.session_id}\u0000${reference.action}`
}

function translateEventReference(reference: ChatReference, offset: number): ChatReference {
  return {
    ...reference,
    source_text_start: reference.source_text_start + offset,
    source_text_end: reference.source_text_end + offset,
  }
}

function compareTimelineReferences(left: ChatReference, right: ChatReference): number {
  return left.source_text_start - right.source_text_start
    || left.source_text_end - right.source_text_end
    || left.session_id.localeCompare(right.session_id)
    || left.action.localeCompare(right.action)
}

function cleanText(value: string): boolean {
  return wellFormedUtf16(value) && !/[\u0000-\u001f\u007f]/u.test(value)
}

function wellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

function unicodeScalarLength(value: string): number {
  let length = 0
  for (const _character of value) length += 1
  return length
}

function uuidV4(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
}
