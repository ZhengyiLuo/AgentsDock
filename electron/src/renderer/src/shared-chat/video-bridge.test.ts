// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Event } from '@shared/types'
import { createSharedChatBridge, type SharedChatState } from './bridge'
import { receiveSharedChatState } from './SharedChatApp'
import { useAppStore } from '../store/app-store'
import { projectTimeline, renderTimelineItems } from '../lib/timeline'

const prefix = '/interactive-chat/interactive_' + '1'.repeat(32)
const video = { id: `video_c3ludGhldGlj.${'a'.repeat(64)}`, filename: 'published.mp4', content_type: 'video/mp4', size: 4096 }
const other = { ...video, id: `video_c2Vjb25k.${'b'.repeat(64)}`, filename: 'attached.webm', content_type: 'video/webm' }
const state: SharedChatState = { revision: '1111111111111111:1', session: { id: 'shared-one', title: 'Synthetic video chat', backend: 'codex' },
  events: [], queue: [], active: false, goal: { goal: null, time_budget_seconds: null }, jobs: [], codex_runtime: null, claude_runtime: null, health: null, runtime_catalog: null }
const event = (seq: number, type: string, descriptor = video) => ({
  id: `event-${seq}`, seq, type, session_id: state.session.id, run_id: `run-${seq}`, ts: '2026-09-13T00:00:00Z',
  prompt: 'Synthetic prompt', shared_videos: [descriptor]
}) as unknown as Event
const url = (bridge: ReturnType<typeof createSharedChatBridge>, id = video.id, sessionId = state.session.id, profile = 'shared-chat', generation = 1) =>
  bridge.api.files.mediaURL(profile, generation, sessionId, id)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('shared video bridge admission', () => {
  it('exposes only event-advertised videos through the same share path, without any extra request', async () => {
    const initial = { ...state, events: [event(3, 'artifact_created')], files: [{ id: 'raw-server-file', filename: 'private.mp4' }] }
    const request = vi.fn(async () => new Response(JSON.stringify(initial)))
    const receive = vi.fn()
    const bridge = createSharedChatBridge(prefix, receive, vi.fn(), request)
    await bridge.refresh()
    expect(url(bridge)).toBe(`${prefix}/media/${video.id}`)
    const attempts: Array<[string, string?, string?, number?]> = [
      [other.id], ['../private.mp4'], ['native-file-id'], [video.id, 'another-chat'],
      [video.id, state.session.id, 'native-profile'], [video.id, state.session.id, 'shared-chat', 2]
    ]
    for (const args of attempts) expect(url(bridge, ...args)).toBe('')
    expect(bridge.snapshot().files).toEqual([{ ...video, session_id: state.session.id }])
    expect(receive.mock.calls[0][0].events[0].artifact).toEqual(bridge.snapshot().files[0])
    expect(await bridge.api.files.list(state.session.id)).toMatchObject({ files: bridge.snapshot().files, total: 1, has_more: false })
    await expect(bridge.api.files.list('another-chat')).rejects.toThrow('not available')
    await expect(bridge.api.files.open(state.session.id, bridge.snapshot().files[0])).rejects.toThrow('not available')
    await expect(bridge.api.files.openLinked(state.session.id, '/private/movie.mp4')).rejects.toThrow('not available')
    expect(request).toHaveBeenCalledTimes(1)
    bridge.close(); expect(url(bridge)).toBe('')
  })
  it('does not grant unused uploads or malformed descriptors', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ...state, events: [
      event(1, 'file_uploaded'), event(2, 'artifact_created', { ...video, filename: '/private/movie.mp4' }),
      { ...event(3, 'turn_started'), file_ids: ['native-id'], shared_videos: [{ ...video, path: '/private/movie.mp4' }] }
    ] })))
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await bridge.refresh()
    expect(url(bridge)).toBe(''); expect(bridge.snapshot().files).toEqual([])
    expect(bridge.snapshot().events.some(event => event.file || event.artifact || event.file_ids)).toBe(false)
  })
  it('retains historical attachment metadata through native store paging and later live tails', async () => {
    let initial = { ...state, events: [event(5, 'artifact_created')], hasMoreEvents: true, nextTimelineBefore: 5 }
    const page = { events: [event(1, 'turn_started', other)], has_more: false, next_before: null, semantic_paging: true }
    const request = vi.fn(async (requestUrl: RequestInfo | URL) => new Response(JSON.stringify(String(requestUrl).endsWith('/state') ? initial : { result: page })))
    const previous = useAppStore.getState(), previousAPI = window.agentsDock
    const bridge = createSharedChatBridge(prefix, value => receiveSharedChatState(value, prefix), vi.fn(), request)
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: bridge.api })
    try {
      useAppStore.setState({ switchingProfileId: null, snapshots: {} })
      await bridge.refresh()
      expect(await useAppStore.getState().loadOlderForSession(state.session.id)).toBe(1)
      let snapshot = useAppStore.getState().snapshots[state.session.id]
      expect(snapshot.events.map(event => [event.id, event.seq])).toEqual([['event-1', 1], ['event-5', 5]])
      expect(snapshot.files.map(file => file.id)).toEqual([video.id, other.id])
      const rows = renderTimelineItems(projectTimeline(snapshot.events, snapshot.files))
      expect(rows.some(row => row.kind === 'message' && row.role === 'user' && row.files[0]?.id === other.id)).toBe(true)
      expect(url(bridge, other.id)).toBe(`${prefix}/media/${other.id}`)
      initial = { ...initial, revision: '1111111111111111:2' }
      await bridge.refresh()
      snapshot = useAppStore.getState().snapshots[state.session.id]
      expect(snapshot.events.map(event => event.seq)).toEqual([1, 5])
      expect(snapshot.files.map(file => file.id)).toEqual([video.id, other.id])
      expect(request).toHaveBeenCalledTimes(3)
    } finally {
      bridge.close(); useAppStore.setState(previous, true)
      Object.defineProperty(window, 'agentsDock', { configurable: true, value: previousAPI })
    }
  })
  it.each(['older', 'historicalOlder', 'around', 'trace'] as const)('projects video metadata on %s reads without extra fetching', async method => {
    const request = vi.fn(async (requestUrl: RequestInfo | URL) => new Response(JSON.stringify(String(requestUrl).endsWith('/state') ? state : {
      result: { events: [event(1, 'artifact_created')], has_more: false, next_after: null }
    })))
    const receive = vi.fn()
    const bridge = createSharedChatBridge(prefix, receive, vi.fn(), request)
    await bridge.refresh()
    const page = method === 'trace' ? await bridge.api.timeline.trace(state.session.id, 'run-1', 1)
      : await bridge.api.timeline[method](state.session.id, 5)
    expect(page.events[0]).toMatchObject({ id: 'event-1', seq: 1, artifact: { id: video.id, session_id: state.session.id } })
    expect(url(bridge)).toBe(`${prefix}/media/${video.id}`)
    expect(receive).toHaveBeenCalledTimes(2)
    expect(receive.mock.calls[1][0].files).toEqual(bridge.snapshot().files)
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('rejects foreign-chat trace metadata and drops admitted URLs on a new history identity', async () => {
    let initial = { ...state, events: [event(3, 'artifact_created')] }
    const request = vi.fn(async (requestUrl: RequestInfo | URL) => new Response(JSON.stringify(String(requestUrl).endsWith('/state') ? initial : {
      result: { events: [{ ...event(1, 'artifact_created', other), session_id: 'foreign-chat' }], has_more: false }
    })))
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await bridge.refresh()
    await expect(bridge.api.timeline.trace(state.session.id, 'run-1', 1)).rejects.toThrow('Invalid shared chat history page')
    expect(url(bridge, other.id)).toBe('')
    initial = { ...state, revision: '2222222222222222:1', events: [] }
    await bridge.refresh()
    expect(url(bridge)).toBe(''); expect(bridge.snapshot().files).toEqual([])
  })
  it('does not strip adapted artifacts on catalog-only updates', async () => {
    const request = vi.fn(async (requestUrl: RequestInfo | URL) => new Response(JSON.stringify(String(requestUrl).endsWith('/state')
      ? { ...state, events: [event(3, 'artifact_created')] } : { result: { backends: {} } })))
    const bridge = createSharedChatBridge(prefix, vi.fn(), vi.fn(), request)
    await bridge.refresh(); await bridge.catalog()
    expect(bridge.snapshot().events[0].artifact?.id).toBe(video.id)
    expect(url(bridge)).toBe(`${prefix}/media/${video.id}`)
  })
})
