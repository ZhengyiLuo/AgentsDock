import { beforeEach, describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { projectTimeline, renderTimelineItems, type RenderTimelineItem } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'

const event = (seq: number, type: string, time: string, patch: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'chat', seq, type, backend: 'claude',
  ts: `2026-10-27T${time}Z`, ...patch
})
const imported = (seq: number, type: string, time: string, patch: Partial<Event> = {}): Event => event(seq, type, '17:29:40', {
  run_id: 'import_batch', imported: true,
  provider_origin: { provider: 'claude', event_id: `native-${seq}`, session_id: 'native-session', timestamp: `2026-10-27T${time}Z` },
  ...patch
})
const messages = (rows: RenderTimelineItem[]) => rows.filter(row => row.kind === 'message').map(row => row.event.id)
const nativeTurns = () => [
  event(1, 'turn_started', '16:52:32', { run_id: 'earlier', prompt: 'Earlier question.' }),
  event(2, 'turn_finished', '16:53:18', { run_id: 'earlier', result_text: 'Earlier answer.' }),
  event(3, 'turn_started', '17:13:20', { run_id: 'middle', prompt: 'Next question.' }),
  event(4, 'turn_finished', '17:16:06', { run_id: 'middle', result_text: 'Next answer.' }),
  event(5, 'turn_started', '17:19:50', { run_id: 'latest', prompt: 'Latest question.' }),
  event(6, 'turn_finished', '17:21:07', { run_id: 'latest', result_text: 'Latest answer.' })
]

function checkLiveAndCold(events: Event[]) {
  let result = cachedTimelineProjection('live', [], [])
  for (let length = 1; length <= events.length; length++) {
    const prefix = events.slice(0, length)
    result = cachedTimelineProjection('live', prefix, [])
    expect(result.rendered, `prefix ${length}`).toEqual(renderTimelineItems(projectTimeline(prefix, [])))
    expect(new Set(result.rendered.map(row => row.key)).size).toBe(result.rendered.length)
  }
  return result
}

describe('source-proven imported message chronology', () => {
  beforeEach(clearTimelineProjectionCache)

  it.each(['claude', 'codex'] as const)('places older %s replies before later native turns and keeps a genuinely newer reply last', backend => {
    const events = [...nativeTurns(),
      imported(7, 'assistant_text', '16:55:50.065', { text: 'Background follow-up one.' }),
      imported(8, 'assistant_text', '16:58:05.074', { text: 'Background follow-up two.' }),
      imported(9, 'assistant_text', '17:16:17.017', { text: 'Another follow-up.' }),
      imported(10, 'assistant_text', '17:26:19.748', { text: 'The newest follow-up.' }),
      event(11, 'turn_finished', '17:29:40', { run_id: 'import_batch', imported: true })
    ].map(item => ({ ...item, backend, provider_origin: item.provider_origin ? {
      provider: backend, kind: 'assistant' as const, event_id: item.provider_origin.event_id,
      session_id: item.provider_origin.session_id, timestamp: item.provider_origin.timestamp
    } : undefined }))
    const original = structuredClone(events)
    const result = checkLiveAndCold(events)
    expect(messages(result.rendered)).toEqual(['event-1', 'event-2', 'event-7', 'event-8', 'event-3', 'event-4', 'event-9', 'event-5', 'event-6', 'event-10'])
    expect(events).toEqual(original)
    expect(result.rendered.filter(row => row.kind === 'message').map(row => row.seq)).toEqual([1, 2, 7, 8, 3, 4, 9, 5, 6, 10])
  })

  it('retains equal text from distinct native message identities as distinct chronological replies', () => {
    const events = [...nativeTurns(),
      imported(7, 'assistant_text', '16:58:00', { text: 'Still checking.' }),
      imported(8, 'assistant_text', '17:26:00', { text: 'Still checking.' })]
    const rows = checkLiveAndCold(events).rendered
    expect(messages(rows)).toEqual(['event-1', 'event-2', 'event-7', 'event-3', 'event-4', 'event-5', 'event-6', 'event-8'])
  })

  it('keeps a genuine imported user, answer and files together without changing live turn order', () => {
    const file = { id: 'upload', session_id: 'chat', filename: 'notes.txt', content_type: 'text/plain' }
    const events = [...nativeTurns(),
      imported(7, 'turn_started', '16:56:00', { prompt: 'A native-client question.', provider_user_authored: true, file_ids: ['upload'] }),
      imported(8, 'assistant_text', '16:58:00', { text: 'A native-client answer.' })]
    const rows = renderTimelineItems(projectTimeline(events, [file]))
    expect(messages(rows)).toEqual(['event-1', 'event-2', 'event-7', 'event-8', 'event-3', 'event-4', 'event-5', 'event-6'])
    expect(rows.find(row => row.kind === 'message' && row.event.id === 'event-7')).toMatchObject({ files: [file] })
  })

  it.each([
    { imported: false },
    { run_id: 'ordinary-run' },
    { provider_origin: undefined },
    { provider_origin: { provider: 'claude' as const, event_id: 'native-7', session_id: 'native-session', timestamp: '2026-10-27T16:58:00' } },
    { provider_origin: { provider: 'codex' as const, event_id: 'native-7', session_id: 'native-session', timestamp: '2026-10-27T16:58:00Z' } },
    { session_id: 'another-chat' }
  ])('does not infer placement from unproven or unrelated source metadata: %j', patch => {
    const rows = renderTimelineItems(projectTimeline([...nativeTurns(),
      imported(7, 'assistant_text', '16:58:00', { text: 'Retain this message.', ...patch })], []))
    expect(messages(rows).at(-1)).toBe('event-7')
  })

  it('does not retire the active native goal when a historical user turn arrives', () => {
    const events = [
      event(1, 'turn_started', '17:19:50', { run_id: 'goal-run', prompt: 'Continue the goal.' }),
      event(2, 'reasoning_summary', '17:20:00', { run_id: 'goal-run', phase: 'commentary', text: 'Working on the goal.' }),
      imported(3, 'turn_started', '16:52:00', { prompt: 'Historical question.', provider_user_authored: true }),
      imported(4, 'assistant_text', '16:58:00', { text: 'Historical answer.' }),
      event(5, 'turn_finished', '16:58:00', { run_id: 'import_batch', imported: true }),
      event(6, 'reasoning_summary', '17:22:00', { run_id: 'goal-run', phase: 'commentary', text: 'The goal is still running.' })
    ]
    const rows = checkLiveAndCold(events).rendered
    expect(messages(rows)).toEqual(['event-3', 'event-4', 'event-1'])
    expect(rows.at(-1)).toMatchObject({ kind: 'progress', active: true, events: [{ seq: 2 }, { seq: 6 }] })
  })

  it('retains the ordinary native order even when its clock moves backwards', () => {
    const native = nativeTurns()
    native[4] = { ...native[4], ts: '2026-10-27T16:40:00Z' }
    const rows = renderTimelineItems(projectTimeline([...native,
      imported(7, 'assistant_text', '16:58:00', { text: 'Recovered answer.' })], []))
    expect(messages(rows)).toEqual(['event-1', 'event-2', 'event-7', 'event-3', 'event-4', 'event-5', 'event-6'])
  })

  it('retains silent replay boundaries and reaches the same order when older pages load', () => {
    const events = [...nativeTurns(),
      imported(7, 'turn_started', '16:52:32', { prompt: '', provider_history_repair: 'source_proven_import' }),
      imported(8, 'assistant_text', '16:58:00', { text: 'Unique older follow-up.' }),
      imported(9, 'turn_started', '17:19:50', { prompt: '', provider_history_repair: 'source_proven_import' }),
      imported(10, 'assistant_text', '17:26:00', { text: 'Unique latest follow-up.' })]
    const expected = checkLiveAndCold(events).rendered
    cachedTimelineProjection('paged', events.slice(4), [])
    cachedTimelineProjection('paged', events.slice(2), [])
    const loaded = cachedTimelineProjection('paged', events, [])
    expect(loaded.rendered).toEqual(expected)
    expect(messages(loaded.rendered)).toEqual(['event-1', 'event-2', 'event-8', 'event-3', 'event-4', 'event-5', 'event-6', 'event-10'])
  })

  it('interleaves a large imported journal without changing native turn order', () => {
    const native: Event[] = []
    const history: Event[] = []
    const expected: string[] = []
    const at = (seconds: number) => new Date(Date.UTC(2026, 9, 27, 0, 0, seconds)).toISOString().slice(11, -1)
    for (let index = 0; index < 3000; index++) {
      const start = index * 2 + 1
      const recovered = 6001 + index
      native.push(
        event(start, 'turn_started', at(index * 10), { run_id: `native-${index}`, prompt: 'Question.' }),
        event(start + 1, 'turn_finished', at(index * 10 + 1), { run_id: `native-${index}`, result_text: 'Answer.' }))
      history.push(imported(recovered, 'assistant_text', at(index * 10 + 5), { text: `Follow-up ${index}.` }))
      expected.push(`event-${start}`, `event-${start + 1}`, `event-${recovered}`)
    }
    expect(messages(renderTimelineItems(projectTimeline([...native, ...history], [])))).toEqual(expected)
  })

  it('keeps ordinary live deltas incremental after older history is inserted', () => {
    const events: Event[] = []
    for (let index = 0; index < 200; index++) events.push(
      event(index * 2 + 1, 'turn_started', '16:00:00', { run_id: `past-${index}`, prompt: 'Earlier question.' }),
      event(index * 2 + 2, 'turn_finished', '16:01:00', { run_id: `past-${index}`, result_text: 'Earlier answer.' }))
    events.push(
      event(401, 'turn_started', '17:19:50', { run_id: 'live-run', prompt: 'Current question.' }),
      imported(402, 'assistant_text', '16:58:00', { text: 'Recovered older answer.' }))
    const before = cachedTimelineProjection('large-live', events, [])
    const after = cachedTimelineProjection('large-live', [...events,
      event(403, 'reasoning_summary', '17:22:00', { run_id: 'live-run', phase: 'commentary', text: 'Current progress.' })], [])
    expect(after.strategy).toBe('append')
    expect(after.renderedSemanticCount).toBe(1)
    expect(after.rendered[0]).toBe(before.rendered[0])
    expect(after.rendered.at(-1)).toMatchObject({ kind: 'progress', active: true })
  })
})
