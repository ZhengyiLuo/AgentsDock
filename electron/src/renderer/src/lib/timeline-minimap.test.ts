import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@shared/i18n'
import type { AgentFile, Event, TimelineIndexLandmark } from '@shared/types'
import { projectTimeline, renderTimelineItems } from './timeline'
import { buildTimelineLandmarks, cachedTimelineLandmarks, compactPreview, countOlderTimelineLandmarks, hasOlderTimelineContent, mergeTimelineLandmarks, retainTimelineLandmarkSpine, TIMELINE_TICK_PITCH, timelineTickY, visibleLoadedPositions } from './timeline-minimap'
afterEach(() => setLocale('en'))

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'chat-1', seq, type, ts: `2026-07-09T10:00:${String(seq).padStart(2, '0')}Z`, ...patch
})

describe('timeline minimap landmarks', () => {
  it('refreshes cached generated labels by language while preserving provider error text', () => {
    const rows = renderTimelineItems(projectTimeline([event(1, 'error', { error: 'Provider unavailable' })], []))
    const english = cachedTimelineLandmarks(rows)
    expect(english[0].title).toBe('Error')
    setLocale('zh-CN')
    const chinese = cachedTimelineLandmarks(rows)
    expect(chinese[0].title).toBe('错误')
    expect(chinese[0].preview).toBe('Provider unavailable')
    expect(chinese).not.toBe(english)
    expect(cachedTimelineLandmarks(rows)).toBe(chinese)
    setLocale('en')
    expect(cachedTimelineLandmarks(rows)).toBe(english)
  })

  it('projects messages, traces, media, jobs, and errors in row order', () => {
    const file: AgentFile = { id: 'video-1', filename: 'result.mp4', content_type: 'video/mp4', seq: 4 }
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Render the result' }),
      event(2, 'assistant_text', { run_id: 'run-1', text: 'I am rendering it now.' }),
      event(3, 'tool_started', { run_id: 'run-1', tool: { name: 'Bash' } }),
      event(4, 'artifact_created', { run_id: 'run-1', artifact: file }),
      event(5, 'turn_finished', { run_id: 'run-1', result_text: 'Done.' }),
      event(6, 'job_finished', { job_id: 'job-1', message: 'Health check passed' }),
      event(7, 'error', { error: 'Provider unavailable' })
    ], [file]))

    const landmarks = buildTimelineLandmarks(rows)
    expect(landmarks.map(item => item.kind)).toEqual(['user', 'job', 'error'])
    // Activity after an earlier answer now has its own row for every provider.
    // Keep one minimap turn spanning those rows and preview its latest answer.
    expect(rows.filter(item => item.kind === 'message' && item.role === 'assistant')).toHaveLength(2)
    expect(landmarks[0]).toMatchObject({ index: 0, endIndex: 4, title: 'Render the result', preview: 'Done.' })
    expect(landmarks[0]).toMatchObject({ start_seq: 1, end_seq: 5 })
    expect(landmarks[0].meta).toContain('result.mp4')
    expect(landmarks.find(item => item.kind === 'error')?.preview).toBe('Provider unavailable')
  })

  it('groups completed run activity with its user and final message', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Inspect the renderer' }),
      event(2, 'reasoning_summary', { run_id: 'run-1', text: 'Checking timeline activity.' }),
      event(3, 'tool_started', { run_id: 'run-1', tool: { name: 'exec' } }),
      event(4, 'turn_finished', { run_id: 'run-1', result_text: 'The renderer is healthy.' })
    ], []))

    expect(rows.map(item => item.kind)).toEqual(['message', 'progress', 'message'])
    expect(buildTimelineLandmarks(rows)).toMatchObject([{
      key: 'turn:run-1', index: 0, endIndex: 2,
      title: 'Inspect the renderer', preview: 'The renderer is healthy.',
      meta: 'Ran 1 command', start_seq: 1, end_seq: 4
    }])
  })

  it('keeps empty stopped activity ranges finite', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Wait' }),
      event(2, 'turn_stopped', { run_id: 'run-1', message: 'Stopped by user.' })
    ], []))

    const landmarks = buildTimelineLandmarks(rows)
    expect(landmarks).toHaveLength(1)
    expect(landmarks[0]).toMatchObject({ key: 'turn:run-1', start_seq: 1, end_seq: 1 })
    expect(Number.isFinite(landmarks[0].start_seq)).toBe(true)
    expect(Number.isFinite(landmarks[0].end_seq)).toBe(true)
  })

  it('keeps hover previews compact without discarding the source row', () => {
    const preview = compactPreview(`Start\n${'long '.repeat(100)}`, 60)
    expect(preview.length).toBeLessThanOrEqual(60)
    expect(preview).toMatch(/^Start long/)
    expect(preview.endsWith('…')).toBe(true)
  })

  it('keeps a late scheduled-job update anchored at the card first firing', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'job_created', { job_id: 'job-1', job: {
        id: 'job-1', session_id: 'chat-1', title: 'Status check', prompt: 'Check status', interval_seconds: 3600
      } }),
      event(2, 'turn_started', { run_id: 'job-run', prompt: 'Check status' }),
      event(3, 'job_ran', { run_id: 'job-run', job_id: 'job-1' }),
      event(4, 'turn_started', { run_id: 'user-run', prompt: 'What changed?' }),
      event(5, 'turn_finished', { run_id: 'user-run', result_text: 'Nothing yet.' }),
      event(6, 'reasoning_summary', { run_id: 'job-run', text: 'Checking the live run' }),
      event(7, 'turn_finished', { run_id: 'job-run', job_id: 'job-1', result_text: 'Everything is healthy.' })
    ], []))

    const landmarks = buildTimelineLandmarks(rows)
    expect(landmarks.map(item => item.key)).toEqual(['job:job-1', 'turn:user-run'])
    expect(landmarks[0]).toMatchObject({ kind: 'job', index: 0, start_seq: 1, end_seq: 1, preview: 'Everything is healthy.' })
  })

  it('enriches loaded rows without changing the whole-chat coordinate spine', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(101, 'turn_started', { run_id: 'run-latest', prompt: 'Latest prompt' }),
      event(102, 'turn_finished', { run_id: 'run-latest', result_text: 'Latest answer' })
    ], []))
    const loaded = buildTimelineLandmarks(rows)
    const merged = mergeTimelineLandmarks([
      { key: 'turn:run-old', kind: 'user', start_seq: 1, end_seq: 8, title: 'Old prompt', preview: 'Old answer' },
      { key: 'turn:run-latest', kind: 'user', start_seq: 101, end_seq: 102, title: 'Stale title', preview: 'Stale answer' }
    ], loaded)

    expect(merged.map(landmark => landmark.key)).toEqual(['turn:run-old', 'turn:run-latest'])
    expect(merged[0].index).toBeUndefined()
    expect(merged[1]).toMatchObject({
      index: 0,
      endIndex: 1,
      title: 'Latest prompt',
      preview: 'Latest answer',
      start_seq: 101,
      end_seq: 102
    })
  })

  it('does not remap a fixed rail coordinate when a historical window loads', () => {
    const remote = Array.from({ length: 100 }, (_, index) => ({
      key: `turn:remote-${index}`,
      kind: 'user' as const,
      start_seq: index * 10 + 1,
      end_seq: index * 10 + 2,
      title: `Remote ${index}`,
      preview: `Answer ${index}`
    }))
    const before = mergeTimelineLandmarks(remote, [])
    const fixedPosition = 72
    const fixedKey = before[fixedPosition].key
    const loadedWindow = [
      {
        ...remote[70], index: 0, endIndex: 1,
        key: 'turn:locally-projected-alias'
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        key: `turn:window-only-${index}`,
        kind: 'assistant' as const,
        start_seq: 703 + index,
        end_seq: 703 + index,
        title: `Window only ${index}`,
        preview: 'Temporary loaded row',
        index: index + 2,
        endIndex: index + 2
      }))
    ]

    const after = mergeTimelineLandmarks(remote, loadedWindow)

    expect(after).toHaveLength(before.length)
    expect(after.map(landmark => landmark.key)).toEqual(before.map(landmark => landmark.key))
    expect(after[fixedPosition].key).toBe(fixedKey)
    expect(after[70]).toMatchObject({
      key: 'turn:remote-70',
      title: 'Remote 70',
      index: 0,
      endIndex: 1
    })
  })

  it('adds only genuinely newer live turns beyond a cached server spine', () => {
    const remote = [
      { key: 'turn:remote-1', kind: 'user' as const, start_seq: 1, end_seq: 4, title: 'First', preview: 'First answer' },
      { key: 'turn:remote-2', kind: 'user' as const, start_seq: 5, end_seq: 8, title: 'Second', preview: 'Second answer' }
    ]
    const loaded = [
      { key: 'turn:historical-window-only', kind: 'assistant' as const, start_seq: 3, end_seq: 3, title: 'Transient history', preview: 'Hidden', index: 0, endIndex: 0 },
      { key: 'turn:remote-2', kind: 'user' as const, start_seq: 5, end_seq: 8, title: 'Second local', preview: 'Second local answer', index: 1, endIndex: 2 },
      { key: 'turn:new-live', kind: 'user' as const, start_seq: 9, end_seq: 12, title: 'New live turn', preview: 'New answer', index: 3, endIndex: 4 }
    ]

    const merged = mergeTimelineLandmarks(remote, loaded)

    expect(merged.map(landmark => landmark.key)).toEqual([
      'turn:remote-1',
      'turn:remote-2',
      'turn:new-live'
    ])
    expect(merged[1]).toMatchObject({ title: 'Second local', index: 1, endIndex: 2 })
  })

  it('overlays localized display copy without retaining it in the server coordinate spine', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Keep this prompt literal' }),
      event(2, 'tool_started', { run_id: 'run-1', tool: { name: 'exec' } }),
      event(3, 'turn_finished', { run_id: 'run-1', result_text: 'Keep this answer literal' }),
      event(4, 'error')
    ], []))
    const english = cachedTimelineLandmarks(rows)
    const remote = retainTimelineLandmarkSpine(english).map(landmark => ({ ...landmark, timestamp: 'server timestamp' }))
    const coordinates = (landmarks: TimelineIndexLandmark[]) => landmarks.map(({ key, kind, start_seq, end_seq, timestamp }, position) => (
      { key, kind, start_seq, end_seq, timestamp, y: timelineTickY(position) }
    ))
    setLocale('zh-CN')
    const chinese = cachedTimelineLandmarks(rows)
    const merged = mergeTimelineLandmarks(remote, chinese)
    expect(merged.map(({ title, preview, meta }) => ({ title, preview, meta }))).toEqual(
      chinese.map(({ title, preview, meta }) => ({ title, preview, meta }))
    )
    expect(merged[0]).toMatchObject({ title: 'Keep this prompt literal', preview: 'Keep this answer literal' })
    expect(merged[0].meta).not.toBe(english[0].meta)
    expect(merged[1].title).toBe('错误')
    expect(merged[1].preview).not.toBe(english[1].preview)
    expect(coordinates(merged)).toEqual(coordinates(remote))
    const retained = retainTimelineLandmarkSpine(merged)
    expect(retained).toEqual(remote)
    expect(mergeTimelineLandmarks(retained, [])).toEqual(remote)
    setLocale('en')
    const switched = mergeTimelineLandmarks(retained, cachedTimelineLandmarks(rows))
    expect(switched.map(({ title, preview, meta }) => ({ title, preview, meta }))).toEqual(
      english.map(({ title, preview, meta }) => ({ title, preview, meta }))
    )
    expect(coordinates(switched)).toEqual(coordinates(remote))
  })

  it.each([
    { key: 'turn:whole', kind: 'user' as const, start_seq: 11, end_seq: 12 },
    { key: 'turn:whole', kind: 'assistant' as const, start_seq: 10, end_seq: 14 },
    { key: 'turn:broad-alias', kind: 'user' as const, start_seq: 9, end_seq: 15 }
  ])('keeps complete remote display copy for partial or ambiguous loaded rows: %j', partial => {
    const remote = [{ key: 'turn:whole', kind: 'user' as const, start_seq: 10, end_seq: 14,
      title: 'Full prompt', preview: 'Full answer', meta: 'Ran 7 commands' }]
    const merged = mergeTimelineLandmarks(remote, [{ ...partial, index: 2, endIndex: 3,
      title: 'Partial answer', preview: 'Only part of the answer', meta: 'Ran 1 command' }])
    expect(merged).toEqual([{ ...remote[0], index: 2, endIndex: 3 }])
    expect(retainTimelineLandmarkSpine(merged)).toEqual(remote)
  })

  it('overlays a complete sequence alias without replacing its remote identity or extra fields', () => {
    const remote = [{ key: 'turn:remote', kind: 'error' as const, start_seq: 10, end_seq: 10,
      title: 'Error', preview: 'Provider unavailable', meta: 'Server display', serverExtension: 'retain me' }]
    const merged = mergeTimelineLandmarks(remote, [{ key: 'event:local', kind: 'error', start_seq: 10, end_seq: 10,
      title: '错误', preview: 'Provider unavailable', meta: '', index: 5, endIndex: 5 }])
    expect(merged).toEqual([{ ...remote[0], title: '错误', meta: '', index: 5, endIndex: 5 }])
    expect(retainTimelineLandmarkSpine(merged)).toEqual(remote)
  })

  it('retains a discovered live tail while an older window replaces loaded rows', () => {
    const remote = [
      { key: 'turn:remote-1', kind: 'user' as const, start_seq: 1, end_seq: 4, title: 'First', preview: 'First answer' },
      { key: 'turn:remote-2', kind: 'user' as const, start_seq: 5, end_seq: 8, title: 'Second', preview: 'Second answer' }
    ]
    const live = mergeTimelineLandmarks(remote, [
      { key: 'turn:new-live', kind: 'user', start_seq: 9, end_seq: 12, title: 'New live turn', preview: 'New answer', index: 2, endIndex: 3 }
    ])
    const retained = retainTimelineLandmarkSpine(live)
    const historical = mergeTimelineLandmarks(retained, [
      { key: 'turn:remote-1', kind: 'user', start_seq: 1, end_seq: 4, title: 'First loaded', preview: 'First loaded answer', index: 0, endIndex: 1 }
    ])

    expect(historical.map(landmark => landmark.key)).toEqual(live.map(landmark => landmark.key))
    expect(historical[0]).toMatchObject({ index: 0, endIndex: 1 })
    expect(historical[2]).toMatchObject({ key: 'turn:new-live' })
    expect(historical[2].index).toBeUndefined()
    expect(historical[2].endIndex).toBeUndefined()
  })

  it('matches sequence ranges safely when loaded rows arrive out of order', () => {
    const remote = [
      { key: 'turn:remote-1', kind: 'user' as const, start_seq: 1, end_seq: 4, title: 'First', preview: 'First answer' },
      { key: 'turn:remote-2', kind: 'user' as const, start_seq: 10, end_seq: 14, title: 'Second', preview: 'Second answer' }
    ]
    const loaded = [
      { key: 'turn:local-second', kind: 'user' as const, start_seq: 10, end_seq: 14, title: 'Second local', preview: 'Second local answer', index: 4, endIndex: 5 },
      { key: 'turn:local-first', kind: 'user' as const, start_seq: 1, end_seq: 4, title: 'First local', preview: 'First local answer', index: 0, endIndex: 1 }
    ]

    expect(mergeTimelineLandmarks(remote, loaded)).toMatchObject([
      { key: 'turn:remote-1', index: 0, endIndex: 1 },
      { key: 'turn:remote-2', index: 4, endIndex: 5 }
    ])
  })

  it('keeps rail spacing fixed regardless of conversation length', () => {
    expect(timelineTickY(1) - timelineTickY(0)).toBe(TIMELINE_TICK_PITCH)
    expect(timelineTickY(10_000) - timelineTickY(9_999)).toBe(TIMELINE_TICK_PITCH)
    expect(timelineTickY(50, 240) - timelineTickY(49, 240)).toBe(TIMELINE_TICK_PITCH)
  })

  it('reuses landmarks for an unchanged rendered timeline', () => {
    const rows = renderTimelineItems(projectTimeline([
      event(1, 'turn_started', { run_id: 'run-1', prompt: 'Hello' }),
      event(2, 'turn_finished', { run_id: 'run-1', result_text: 'Hi' })
    ], []))

    expect(cachedTimelineLandmarks(rows)).toBe(cachedTimelineLandmarks(rows))
  })

  it('finds the loaded viewport inside a sparse whole-chat navigator', () => {
    const positions = [
      { position: 8, index: 0, endIndex: 2 },
      { position: 9, index: 3, endIndex: 4 },
      { position: 10, index: 5, endIndex: 9 },
      { position: 11, index: 10, endIndex: 10 }
    ]

    expect(visibleLoadedPositions(positions, 4, 7)).toEqual([9, 10])
    expect(visibleLoadedPositions(positions, 10, 10)).toEqual([11, 11])
    expect(visibleLoadedPositions(positions, 20, 30)).toBeNull()
  })

  it('counts semantic older messages from the server paging boundary', () => {
    const landmarks = [
      { key: 'turn:old', kind: 'user' as const, start_seq: 1, end_seq: 8, title: 'Old turn', preview: 'Old answer' },
      { key: 'job:long', kind: 'job' as const, start_seq: 9, end_seq: 200, title: 'Long job', preview: 'Latest status' },
      { key: 'turn:new', kind: 'user' as const, start_seq: 201, end_seq: 205, title: 'New turn', preview: 'New answer' }
    ]

    expect(countOlderTimelineLandmarks(landmarks, 150)).toBe(2)
    expect(hasOlderTimelineContent(landmarks, 150)).toBe(true)
  })

  it('does not count the landmark containing the earliest loaded event as older', () => {
    const landmarks = [
      { key: 'turn:boundary', kind: 'user' as const, start_seq: 100, end_seq: 100, title: 'Boundary turn', preview: 'Loaded' },
      { key: 'job:loaded', kind: 'job' as const, start_seq: 100, end_seq: 100, title: 'Loaded job', preview: 'Loaded' }
    ]

    expect(countOlderTimelineLandmarks(landmarks, 100)).toBe(0)
    expect(hasOlderTimelineContent(landmarks, 100)).toBe(false)
  })

  it('keeps paging available when the loaded tail cuts through one ordinary turn', () => {
    const landmarks = [
      { key: 'turn:large', kind: 'user' as const, start_seq: 1, end_seq: 200, title: 'Large turn', preview: 'Still running' }
    ]

    expect(countOlderTimelineLandmarks(landmarks, 150)).toBe(1)
    expect(hasOlderTimelineContent(landmarks, 150)).toBe(true)
  })
})
