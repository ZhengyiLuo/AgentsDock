import type { AgentFile, Event } from '@shared/types'

/** These opaque, signed IDs name only media already attached/published in this share. */
export interface SharedVideo {
  id: string
  filename: string
  content_type: 'video/mp4' | 'video/webm' | 'video/quicktime' | 'video/ogg'
  size: number
}

export function isSharedVideoId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1024
    && /^video_[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value)
}

function videoFile(value: unknown, sessionId: string): AgentFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const video = value as Record<string, unknown>
  if (Object.keys(video).some(key => !['id', 'filename', 'content_type', 'size'].includes(key))
    || !isSharedVideoId(video.id)
    || typeof video.filename !== 'string' || !video.filename.trim()
    || [...video.filename].length > 255 || /[\u0000-\u001f\u007f/\\]/.test(video.filename)
    || video.filename === '.' || video.filename === '..'
    || !['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'].includes(String(video.content_type))
    || !Number.isSafeInteger(video.size) || Number(video.size) <= 0) return null
  return { id: video.id, session_id: sessionId, filename: video.filename,
    content_type: video.content_type as SharedVideo['content_type'], size: Number(video.size) }
}

/** Keep native chronology intact; never promote raw files, paths, or unused uploads. */
export function projectSharedVideoEvents(events: Event[], sessionId: string): { events: Event[]; files: AgentFile[] } {
  const files = new Map<string, AgentFile>()
  const projected = events.map(event => {
    const raw = event as Event & { shared_videos?: unknown; display_file_ids?: unknown; files?: unknown }
    const { shared_videos: descriptors, file: _file, artifact: _artifact, file_ids: _fileIds,
      display_file_ids: _displayIds, files: _files, attachments: _attachments, ...rest } = raw
    // Older already-scoped server pages can omit the redundant owner field.
    const safe = { ...rest, session_id: event.session_id || sessionId }
    const attached = event.type === 'turn_started' || event.type === 'turn_steered'
    const published = event.type === 'artifact_created'
    if ((event.session_id && event.session_id !== sessionId) || !Array.isArray(descriptors) || descriptors.length > 32
      || (!attached && !published) || (published && descriptors.length > 1)) return safe as Event
    const videos = descriptors.map(value => videoFile(value, sessionId)).filter((file): file is AgentFile => file !== null)
    for (const file of videos) files.set(file.id, file)
    return { ...safe, ...(published && videos[0] ? { artifact: videos[0] } : {}),
      ...(attached && videos.length ? { file_ids: [...new Set(videos.map(file => file.id))] } : {}) } as Event
  })
  return { events: projected, files: [...files.values()] }
}
