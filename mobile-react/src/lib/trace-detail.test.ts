import type { Event } from '../types'
import {
  TRACE_DETAIL_LOADED_EVENT_LIMIT,
  TRACE_DETAIL_RENDER_EVENT_LIMIT,
  TRACE_HEADLINE_LIMIT,
  TRACE_PREVIEW_LIMIT,
  TRACE_TEXT_LIMIT,
  boundLoadedTraceEvents,
  boundedTraceText,
  reasoningTraceHeadline,
  reasoningTracePreview,
  selectTraceDetailRenderEvents,
  toolTraceHeadline,
} from './trace-detail'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function event(seq: number, text: string, type = 'reasoning_summary'): Event {
  return {
    id: `trace-${seq}`,
    session_id: 'chat',
    run_id: 'run',
    seq,
    type,
    ts: '2026-07-30T00:00:00Z',
    text,
  }
}

const small = [event(1, 'First'), event(2, 'Second')]
const unchanged = boundLoadedTraceEvents(small)
assert(unchanged.events === small && !unchanged.limited, 'small loaded traces should preserve their array identity')

const numerous = Array.from({ length: 300 }, (_, index) => event(index + 1, `Thought ${index + 1}`))
const boundedLoaded = boundLoadedTraceEvents(numerous)
assert(boundedLoaded.limited, 'large loaded traces should report their bounded state')
assert(
  boundedLoaded.events.length === TRACE_DETAIL_LOADED_EVENT_LIMIT,
  'loaded trace state must obey its event ceiling',
)

const heavy = Array.from({ length: 30 }, (_, index) => event(index + 1, 'x'.repeat(60_000)))
const boundedHeavy = boundLoadedTraceEvents(heavy)
assert(
  boundedHeavy.limited && boundedHeavy.events.length < heavy.length,
  'loaded trace state must obey its character ceiling too',
)
const oversized = boundLoadedTraceEvents([event(399, 'x'.repeat(1_100_000))])
assert(
  oversized.limited && oversized.events.length === 0,
  'one oversized trace event must not bypass the loaded-state memory ceiling',
)

const renderWindow = selectTraceDetailRenderEvents(numerous)
assert(renderWindow.limited, 'large trace views should report hidden events')
assert(renderWindow.events.length === TRACE_DETAIL_RENDER_EVENT_LIMIT, 'trace rendering must obey its event ceiling')
assert(renderWindow.events[0].id === 'trace-1', 'bounded rendering should retain the chronological head')
assert(renderWindow.events.at(-1)?.id === 'trace-300', 'bounded rendering should retain the newest tail')

const formula = `before ${'a'.repeat(3_980)} $${'x'.repeat(100)}$ after`
const formulaText = boundedTraceText(event(400, formula))
assert(!formulaText.includes('$'), 'reasoning truncation must not expose a partial math delimiter')
assert(formulaText.includes('characters hidden'), 'reasoning truncation should report omitted content')

const fenced = `before\n${'b'.repeat(3_970)}\n\`\`\`ts\n${'const x = 1\\n'.repeat(30)}\`\`\`\nafter`
const fencedText = boundedTraceText(event(401, fenced))
assert(!fencedText.includes('```'), 'reasoning truncation must not expose a partial fenced-code block')

const plainTool = boundedTraceText(event(402, 'z'.repeat(5_000), 'tool_finished'))
assert(plainTool.startsWith('z'.repeat(TRACE_TEXT_LIMIT)), 'plain tool text should retain a direct prefix')

const startedTool = boundedTraceText({
  ...event(403, '', 'tool_started'),
  tool: { id: 'tool-started', name: 'exec', input: { command: 'pwd', timeout_ms: 10_000 } },
})
assert(
  startedTool.includes('"command": "pwd"') && startedTool.includes('\n  "timeout_ms": 10000'),
  'tool-start traces should pretty-print their input like Mac',
)

const finishedTool = boundedTraceText({
  ...event(404, 'fallback text', 'tool_finished'),
  message: 'Process finished.',
  output: 'actual stdout',
})
assert(
  finishedTool === 'actual stdout',
  'tool-finish traces should prefer actual output over their status message',
)

const longReasoningHeadline = reasoningTraceHeadline(`**${'r'.repeat(48_000)}**`)
assert(
  longReasoningHeadline.length <= TRACE_HEADLINE_LIMIT && longReasoningHeadline.endsWith('…'),
  'reasoning headlines and accessibility labels must bound long single-line text',
)
const reasoningPreview = reasoningTracePreview('## **Inspecting the renderer**\n\nThe `second` line remains readable.')
assert(
  reasoningPreview === 'Inspecting the renderer\n\nThe second line remains readable.',
  'collapsed reasoning previews should remove presentation markers without dropping later lines',
)
assert(
  reasoningTracePreview('p'.repeat(48_000)).length <= TRACE_PREVIEW_LIMIT,
  'collapsed reasoning previews must remain bounded',
)
const longToolHeadline = toolTraceHeadline({
  tool: { id: 'long-command', name: 'exec', input: { command: 'x'.repeat(8_000) } },
})
assert(
  longToolHeadline.length <= TRACE_HEADLINE_LIMIT && longToolHeadline.endsWith('…'),
  'tool headlines and accessibility labels must bound long commands',
)

console.log('trace detail bounds passed')
