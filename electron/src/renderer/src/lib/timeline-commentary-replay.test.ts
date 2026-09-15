import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { projectTimeline, renderTimelineItems, TimelineProjector } from './timeline'

const event = (seq: number, type: string, fields: Partial<Event> = {}): Event => ({
  id: `replay-${seq}`, session_id: 'fixture-chat', run_id: 'native-run', seq, type,
  ts: '2026-09-10T12:00:10Z', ...fields
})

function fixture(): Event[] {
  return [
    event(1, 'turn_started', { prompt: 'Inspect the screenshot.', ts: '2026-09-10T12:00:00Z' }),
    event(2, 'reasoning_summary', { phase: 'commentary', text: 'First public update.' }),
    event(3, 'reasoning_summary', { phase: 'commentary', text: 'Second public update.', ts: '2026-09-10T12:01:10Z' }),
    event(4, 'assistant_text', { text: 'Final answer.', ts: '2026-09-10T12:02:00Z' }),
    event(5, 'turn_finished', { backend: 'codex', result_text: 'Final answer.', ts: '2026-09-10T12:02:01Z' }),
    event(6, 'history_imported', { run_id: 'import_replay', backend: 'codex', ts: '2026-09-10T12:03:00Z' }),
    event(7, 'reasoning_summary', { run_id: 'import_replay', imported: true, backend: 'codex', phase: 'commentary',
      text: 'First public update.', ts: '2026-09-10T12:00:10.128Z' }),
    event(8, 'reasoning_summary', { run_id: 'import_replay', imported: true, backend: 'codex', phase: 'commentary',
      text: 'Second public update.', ts: '2026-09-10T12:01:10.008Z' }),
    event(9, 'turn_finished', { run_id: 'import_replay', imported: true, backend: 'codex', ts: '2026-09-10T12:01:10.008Z' })
  ]
}

describe('source-matched public commentary replays', () => {
  it('keeps one original activity above the final for the legacy missing-backend replay shape', () => {
    const source = fixture()
    const projector = new TimelineProjector([])
    projector.append(source.slice(0, 5))
    const original = renderTimelineItems(projector.items)
    for (const record of source.slice(5)) projector.append([record])
    const rows = renderTimelineItems(projector.items)
    expect(rows).toEqual(original)
    expect(rows).toEqual(renderTimelineItems(projectTimeline(source, [])))
    expect(rows.map(row => row.kind)).toEqual(['message', 'progress', 'message'])
    expect(rows[1]).toMatchObject({ active: false, hasFinalResponse: true, events: [{ seq: 2 }, { seq: 3 }] })
    expect(source[1].backend).toBeUndefined()
    expect(source[6].imported).toBe(true)
  })

  it.each([
    ['different full text', { text: 'First public update. Additional genuine content.' }, {}],
    ['different second', { ts: '2026-09-10T12:00:11.128Z' }, {}],
    ['different provider', { backend: 'claude' }, {}],
    ['different chat', { session_id: 'other-chat' }, {}],
    ['not imported', { imported: false }, {}],
    ['not public commentary', { phase: 'analysis' }, {}],
    ['unknown native phase', {}, { phase: null }],
    ['conflicting precise time', {}, { ts: '2026-09-10T12:00:10.001Z' }],
    ['conflicting source identity', { provider_message_id: 'different-item' }, { provider_message_id: 'original-item' }]
  ] as const)('retains %s instead of guessing a replay', (_label, importedFields, nativeFields) => {
    const source = fixture()
    source[1] = { ...source[1], ...nativeFields }
    source[6] = { ...source[6], ...importedFields }
    const turns = projectTimeline(source, [])
    expect(turns.some(turn => turn.kind === 'turn' && turn.trace.some(row => row.id === source[6].id))).toBe(true)
  })

  it('requires unique native evidence and an evidenced provider', () => {
    for (const mode of ['ambiguous', 'unknown-provider'] as const) {
      const source = fixture()
      if (mode === 'ambiguous') source[2] = { ...source[2], text: source[1].text, ts: source[1].ts }
      else source[4] = { ...source[4], backend: undefined }
      const turns = projectTimeline(source, [])
      expect(turns.some(turn => turn.kind === 'turn' && turn.trace.some(row => row.id === source[6].id))).toBe(true)
    }
  })

  it('uses matching source identity when both records provide it', () => {
    const source = fixture()
    source[1] = { ...source[1], provider_message_id: 'source-item' }
    source[6] = { ...source[6], provider_message_id: 'source-item', ts: '2026-09-10T12:00:11.128Z' }
    expect(renderTimelineItems(projectTimeline(source, [])).map(row => row.kind)).toEqual(['message', 'progress', 'message'])
  })

  it('does not turn discarded cache evidence into a unique old match', () => {
    const source = [event(1, 'turn_started', { backend: 'codex', prompt: 'Continue' })]
    for (let index = 2; index < 522; index++) source.push(event(index, 'reasoning_summary', { phase: 'commentary', text: 'Repeated native update.' }))
    const imported = event(522, 'reasoning_summary', { run_id: 'import_large', imported: true, backend: 'codex',
      phase: 'commentary', text: 'Repeated native update.', ts: '2026-09-10T12:00:10.128Z' })
    source.push(imported)
    const turns = projectTimeline(source, [])
    expect(turns.some(turn => turn.kind === 'turn' && turn.trace.some(row => row.id === imported.id))).toBe(true)
  })
})
