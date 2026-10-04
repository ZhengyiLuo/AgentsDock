import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { projectTimeline, renderTimelineItems } from '../lib/timeline'
import { isSharedFileId, isSharedVideoId, projectSharedVideoEvents } from './videos'

const video = { id: `video_c3ludGhldGljLW9ubHk.${'a'.repeat(64)}`, filename: 'synthetic clip.mp4', content_type: 'video/mp4', size: 1234 }
const event = (type: string, shared_videos: unknown = [video]) => ({
  id: 'original-event', seq: 8, session_id: 'shared-one', run_id: 'original-run', ts: '2026-09-13T00:00:00Z',
  type, prompt: 'Synthetic prompt', shared_videos
}) as unknown as Event

describe('shared video descriptors', () => {
  it.each(['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'])('accepts exact signed %s metadata without paths or synthetic events', content_type => {
    const input = event('artifact_created', [{ ...video, content_type }])
    const projected = projectSharedVideoEvents([input], 'shared-one')
    expect(projected.files).toEqual([{ ...video, content_type, session_id: 'shared-one' }])
    expect(projected.events).toHaveLength(1)
    expect(projected.events[0]).toMatchObject({ id: input.id, seq: input.seq, run_id: input.run_id, artifact: projected.files[0] })
    expect(projected.events[0]).not.toHaveProperty('shared_videos')
    expect(projected.events[0].artifact).not.toHaveProperty('path')
  })
  it.each([
    null, [], 'video', { ...video, id: 'file-original' }, { ...video, id: '../private.mp4' },
    { ...video, id: `video_${'a'.repeat(1000)}.${'b'.repeat(64)}` },
    { ...video, id: `video_valid.${'A'.repeat(64)}` }, { ...video, id: `video_valid=.${'a'.repeat(64)}` },
    { ...video, filename: '/private/movie.mp4' }, { ...video, filename: '..\\movie.mp4' },
    { ...video, filename: '..' }, { ...video, filename: '' }, { ...video, filename: 'a'.repeat(256) },
    { ...video, filename: 'bad\u0000.mp4' }, { ...video, content_type: 'text/html' },
    { ...video, content_type: 'video/mp4;anything' }, { ...video, size: 0 }, { ...video, size: -1 },
    { ...video, size: 1.1 }, { ...video, size: '1234' }, { ...video, size: Number.MAX_SAFE_INTEGER + 1 },
    { ...video, path: '/private/movie.mp4' }, { ...video, session_id: 'another-chat' }
  ])('discards malformed metadata without granting a file URL: %j', invalid => {
    const projected = projectSharedVideoEvents([event('turn_started', [invalid])], 'shared-one')
    expect(projected.files).toEqual([])
    expect(projected.events[0].file_ids).toBeUndefined()
  })
  it('never promotes raw native files, unused uploads, or another chat', () => {
    const raw = { ...event('file_uploaded'), file: { id: 'native-file', filename: 'private.mp4', path: '/private/video' },
      artifact: { id: 'native-artifact', filename: 'private.mp4' }, file_ids: ['native-file'],
      display_file_ids: ['raw-display'], files: [{ path: '/private' }], attachments: 3 }
    const projected = projectSharedVideoEvents([raw, { ...event('turn_started'), session_id: 'another-chat' }], 'shared-one')
    expect(projected.files).toEqual([])
    for (const value of projected.events) {
      expect(value.file).toBeUndefined(); expect(value.artifact).toBeUndefined(); expect(value.file_ids).toBeUndefined()
      expect(value).not.toHaveProperty('display_file_ids'); expect(value).not.toHaveProperty('files'); expect(value).not.toHaveProperty('attachments')
    }
  })
  it.each([undefined, null, ''])('normalizes an absent/empty owner from an already-scoped envelope: %s', session_id => {
    const input = { ...event('artifact_created'), session_id } as unknown as Event
    const projected = projectSharedVideoEvents([input], 'shared-one')
    expect(projected.events[0]).toMatchObject({ id: input.id, seq: input.seq, session_id: 'shared-one', artifact: { id: video.id } })
    expect(projected.files[0].session_id).toBe('shared-one')
    expect(renderTimelineItems(projectTimeline(projected.events, projected.files)).some(row => row.kind === 'media' && row.files[0]?.id === video.id)).toBe(true)
  })
  it('preserves attachments beyond the old shared-chat-only count limit', () => {
    const descriptors = Array.from({ length: 33 }, () => video)
    const projected = projectSharedVideoEvents([event('turn_started', descriptors)], 'shared-one')
    expect(projected.files).toHaveLength(1); expect(projected.events[0].file_ids).toEqual([video.id])
    expect(projectSharedVideoEvents([event('turn_started', descriptors.slice(0, 32))], 'shared-one').files).toHaveLength(1)
  })
  it('rejects multiple artifact descriptors instead of inventing chronology', () => {
    const input = event('artifact_created', [video, { ...video, id: `video_c2Vjb25k.${'b'.repeat(64)}` }])
    const projected = projectSharedVideoEvents([input], 'shared-one')
    expect(projected.events).toHaveLength(1)
    expect(projected.events[0].artifact).toBeUndefined()
    expect(projected.files).toEqual([])
  })
  it('maps actually sent video attachments into native input media, including native goal steering', () => {
    for (const type of ['turn_started', 'turn_steered']) {
      const input = { ...event(type), ...(type === 'turn_steered' ? { native_goal_steer: true, native_steer: true,
        backend: 'codex', purpose: 'codex_goal_resume', provider_user_authored: true, queued_id: 'queue-one' } : {}) } as Event
      const projected = projectSharedVideoEvents([input], 'shared-one')
      expect(projected.events[0].file_ids).toEqual([video.id])
      const rows = renderTimelineItems(projectTimeline(projected.events, projected.files))
      expect(rows.some(row => row.kind === 'message' && row.role === 'user' && row.files[0]?.id === video.id)).toBe(true)
    }
  })
  it('bounds the opaque identifier without requiring native file_ identifiers', () => {
    expect(isSharedVideoId(`video_${'a'.repeat(953)}.${'b'.repeat(64)}`)).toBe(true)
    expect(isSharedVideoId(`video_${'a'.repeat(954)}.${'b'.repeat(64)}`)).toBe(false)
  })

  it.each(['text/plain', 'application/pdf', 'application/zip', 'image/png', 'text/html'])('projects sent %s files into native attachments and published artifacts', content_type => {
    const file = { id: `shared_file_YXR0YWNobWVudA.${'c'.repeat(64)}`, filename: 'attachment.bin', content_type, size: 0 }
    for (const type of ['turn_started', 'turn_steered', 'artifact_created']) {
      const input = { ...event(type, []), shared_files: [file] } as Event
      const projected = projectSharedVideoEvents([input], 'shared-one')
      expect(projected.files).toEqual([{ ...file, session_id: 'shared-one' }])
      expect(projected.events[0]).not.toHaveProperty('shared_files')
      if (type === 'artifact_created') expect(projected.events[0].artifact).toEqual(projected.files[0])
      else expect(projected.events[0].file_ids).toEqual([file.id])
    }
  })

  it('only accepts scoped file descriptors, never native IDs or paths', () => {
    const file = { id: `shared_file_YXR0YWNobWVudA.${'c'.repeat(64)}`, filename: 'attachment.txt', content_type: 'text/plain', size: 12 }
    expect(isSharedFileId(file.id)).toBe(true)
    for (const invalid of [{ ...file, id: 'file_native' }, { ...file, path: '/private/file' },
      { ...file, filename: '../private' }, { ...file, content_type: 'text/plain\r\nHeader: value' }]) {
      expect(projectSharedVideoEvents([{ ...event('turn_started', []), shared_files: [invalid] } as Event], 'shared-one').files).toEqual([])
    }
    expect(projectSharedVideoEvents([{ ...event('file_uploaded', []), shared_files: [file] } as Event], 'shared-one').files).toEqual([])
  })
})
