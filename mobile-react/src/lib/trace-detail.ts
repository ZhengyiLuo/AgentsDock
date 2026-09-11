import type { Event } from '../types'
import { foldMarkdownSource } from './math'

export const TRACE_TEXT_LIMIT = 4_000
export const TRACE_DETAIL_LOADED_EVENT_LIMIT = 240
export const TRACE_DETAIL_LOADED_CHARACTER_LIMIT = 1_000_000
export const TRACE_DETAIL_RENDER_EVENT_LIMIT = 240
export const TRACE_DETAIL_RENDER_CHARACTER_LIMIT = 320_000
export const TRACE_DETAIL_RENDER_TAIL_LIMIT = 40
export const TRACE_HEADLINE_LIMIT = 180
export const TRACE_PREVIEW_LIMIT = 480

export interface BoundedTraceEvents {
  events: Event[]
  limited: boolean
}

/**
 * Keep lazy trace state bounded even when a server returns very large
 * reasoning/tool fields. Pages are chronological, so retain the earliest
 * loaded detail and stop paging when the phone reaches its safe window.
 */
export function boundLoadedTraceEvents(events: Event[]): BoundedTraceEvents {
  let characters = 0
  const bounded: Event[] = []
  for (const event of events) {
    const cost = traceEventCharacterCost(event)
    if (!bounded.length && cost > TRACE_DETAIL_LOADED_CHARACTER_LIMIT) {
      return { events: [], limited: true }
    }
    if (
      bounded.length >= TRACE_DETAIL_LOADED_EVENT_LIMIT
      || (bounded.length > 0 && characters + cost > TRACE_DETAIL_LOADED_CHARACTER_LIMIT)
    ) {
      return { events: bounded, limited: true }
    }
    bounded.push(event)
    characters += cost
  }
  return { events, limited: false }
}

/**
 * One FlashList row cannot safely mount an unbounded nested trace. Preserve a
 * useful chronological head plus the newest sampled tail within a fixed view
 * and Markdown-character budget.
 */
export function selectTraceDetailRenderEvents(events: Event[]): BoundedTraceEvents {
  let totalCharacters = 0
  for (const event of events) totalCharacters += boundedTraceText(event).length
  if (
    events.length <= TRACE_DETAIL_RENDER_EVENT_LIMIT
    && totalCharacters <= TRACE_DETAIL_RENDER_CHARACTER_LIMIT
  ) return { events, limited: false }

  const tailBudget = Math.floor(TRACE_DETAIL_RENDER_CHARACTER_LIMIT / 3)
  const tail: Event[] = []
  let tailCharacters = 0
  for (let index = events.length - 1; index >= 0 && tail.length < TRACE_DETAIL_RENDER_TAIL_LIMIT; index -= 1) {
    const event = events[index]
    const cost = boundedTraceText(event).length
    if (tail.length > 0 && tailCharacters + cost > tailBudget) break
    tail.unshift(event)
    tailCharacters += cost
  }

  const tailIds = new Set(tail.map(event => event.id))
  const head: Event[] = []
  let characters = tailCharacters
  for (const event of events) {
    if (tailIds.has(event.id)) break
    const cost = boundedTraceText(event).length
    if (
      head.length + tail.length >= TRACE_DETAIL_RENDER_EVENT_LIMIT
      || (head.length > 0 && characters + cost > TRACE_DETAIL_RENDER_CHARACTER_LIMIT)
    ) break
    head.push(event)
    characters += cost
  }
  const selected = [...head, ...tail]
  return { events: selected, limited: selected.length < events.length }
}

/** Bound Markdown reasoning without slicing through math or code delimiters. */
export function boundedTraceText(event: Event): string {
  const raw = traceTextSource(event)
  const text = typeof raw === 'string'
    ? raw
    : raw == null
      ? ''
      : typeof raw === 'object'
        ? Array.isArray(raw)
          ? `[Structured trace array with ${raw.length} entries omitted]`
          : '[Structured trace object omitted]'
        : String(raw)
  const reportedLength = event.output_truncated && typeof event.output_chars === 'number'
    ? Math.max(text.length, event.output_chars)
    : text.length
  if (text.length <= TRACE_TEXT_LIMIT && reportedLength === text.length) return text

  if (event.type === 'reasoning_summary') {
    const fold = foldMarkdownSource(text, TRACE_TEXT_LIMIT)
    const visible = fold.visible.trimEnd()
    return `${visible}\n\n… ${Math.max(0, reportedLength - fold.cutIndex)} characters hidden`
  }
  const visible = text.slice(0, TRACE_TEXT_LIMIT).trimEnd()
  return `${visible}\n… ${Math.max(0, reportedLength - visible.length)} characters hidden`
}

export function reasoningTraceHeadline(value?: string | null): string {
  if (!value) return ''
  const firstLine = value.split('\n', 1)[0]?.trim() || ''
  const startsBold = firstLine.startsWith('**')
  const endsBold = firstLine.endsWith('**')
  const plain = !startsBold && !endsBold
    ? firstLine
    : firstLine.slice(startsBold ? 2 : 0, endsBold ? -2 : undefined).trim()
  return boundedHeadline(plain)
}

/** Plain, bounded summary for the collapsed disclosure; full Markdown stays in details. */
export function reasoningTracePreview(value?: string | null): string {
  const plain = (value || '')
    .trim()
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
  return boundedPlainText(plain, TRACE_PREVIEW_LIMIT)
}

export function toolTraceHeadline(event?: Pick<Event, 'tool'>): string {
  if (!event) return ''
  const input = event.tool?.input
  const command = input && typeof input === 'object' && !Array.isArray(input) && 'command' in input
    ? String(input.command || '').trim()
    : ''
  return boundedHeadline(command || event.tool?.name || '')
}

function traceTextSource(event: Event): unknown {
  if (event.type === 'tool_started' && event.tool?.input != null) {
    if (typeof event.tool.input === 'string') return event.tool.input
    try {
      return JSON.stringify(event.tool.input, null, 2)
    } catch {
      return '[Tool input could not be displayed]'
    }
  }
  if (event.type === 'tool_finished') {
    return firstNonEmptyText(event.output, event.message, event.result_text, event.text)
      ?? event.error
      ?? ''
  }
  return event.result_text ?? event.text ?? event.prompt ?? event.message ?? event.error ?? event.output ?? ''
}

function firstNonEmptyText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value?.trim()) return value
  }
  return null
}

function boundedHeadline(value: string): string {
  return boundedPlainText(value, TRACE_HEADLINE_LIMIT)
}

function boundedPlainText(value: string, limit: number): string {
  if (value.length <= limit) return value
  let visible = value.slice(0, limit - 1).trimEnd()
  const finalCodeUnit = visible.charCodeAt(visible.length - 1)
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) visible = visible.slice(0, -1)
  return `${visible}…`
}

function traceEventCharacterCost(event: Event): number {
  let total = 256
  for (const value of [
    event.prompt,
    event.text,
    event.result_text,
    event.message,
    event.digest,
    event.output,
  ]) {
    if (typeof value === 'string') total += value.length
  }
  total += jsonLength(event.error)
  total += jsonLength(event.tool?.input)
  total += jsonLength(event.interaction)
  return total
}

function jsonLength(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return TRACE_TEXT_LIMIT
  }
}
