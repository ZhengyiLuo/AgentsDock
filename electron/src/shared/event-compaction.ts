import type { Event } from './types'
import { hasTimelineChangeSignal } from './timeline-change-signal'

export const TOOL_OUTPUT_PREVIEW_CHARS = 12_000

const TOOL_OUTPUT_OMISSION_PREFIX = '\n\n[AgentsDock omitted '
const TOOL_OUTPUT_OMISSION_SUFFIX = ' characters from this tool output]'
const TOOL_OUTPUT_OMISSION_PATTERN = /^\n\n\[AgentsDock omitted \d+ characters from this tool output\]$/

export function compactTimelineEvent(event: Event): Event {
  if (event.type !== 'tool_finished' || typeof event.output !== 'string') return event
  if (hasTimelineChangeSignal(event.output)) return event

  const output = compactToolOutputPreview(event.output)
  return output === event.output ? event : { ...event, output }
}

export function compactTimelineEvents(events: Event[]): Event[] {
  let changed = false
  const compacted = events.map(event => {
    const next = compactTimelineEvent(event)
    if (next !== event) changed = true
    return next
  })
  return changed ? compacted : events
}

export function compactToolOutputPreview(output: string): string {
  if (output.length <= TOOL_OUTPUT_PREVIEW_CHARS || isCompactedToolOutput(output)) return output
  const omittedCharacters = output.length - TOOL_OUTPUT_PREVIEW_CHARS
  return output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS)
    + TOOL_OUTPUT_OMISSION_PREFIX
    + omittedCharacters
    + TOOL_OUTPUT_OMISSION_SUFFIX
}

function isCompactedToolOutput(output: string): boolean {
  const marker = output.slice(TOOL_OUTPUT_PREVIEW_CHARS)
  return marker.startsWith(TOOL_OUTPUT_OMISSION_PREFIX)
    && marker.endsWith(TOOL_OUTPUT_OMISSION_SUFFIX)
    && TOOL_OUTPUT_OMISSION_PATTERN.test(marker)
}
