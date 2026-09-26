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

export function isSharedFileId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1024
    && /^shared_file_[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value)
}

function sharedFile(value: unknown, sessionId: string, videoOnly: boolean): AgentFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const file = value as Record<string, unknown>
  if (Object.keys(file).some(key => !['id', 'filename', 'content_type', 'size'].includes(key))
    || typeof file.id !== 'string' || !(videoOnly ? isSharedVideoId(file.id) : isSharedFileId(file.id))
    || typeof file.filename !== 'string' || !file.filename.trim()
    || [...file.filename].length > 255 || /[\u0000-\u001f\u007f/\\]/.test(file.filename)
    || file.filename === '.' || file.filename === '..' || typeof file.content_type !== 'string'
    || (videoOnly ? !['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'].includes(file.content_type)
      : !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.content_type))
    || !Number.isSafeInteger(file.size) || Number(file.size) < (videoOnly ? 1 : 0)) return null
  return { id: file.id, session_id: sessionId, filename: file.filename,
    content_type: file.content_type, size: Number(file.size) }
}

/** Keep native chronology intact; never promote raw files, paths, or unused uploads. */
export function projectSharedVideoEvents(events: Event[], sessionId: string): { events: Event[]; files: AgentFile[] } {
  const files = new Map<string, AgentFile>()
  const projected = events.map(event => {
    const raw = event as Event & { shared_videos?: unknown; shared_files?: unknown; display_file_ids?: unknown; files?: unknown }
    const { shared_videos: videoDescriptors, shared_files: fileDescriptors, file: _file, artifact: _artifact, file_ids: _fileIds,
      display_file_ids: _displayIds, files: _files, attachments: _attachments, ...rest } = raw
    // Older already-scoped server pages can omit the redundant owner field.
    const safe = { ...rest, session_id: event.session_id || sessionId }
    const attached = event.type === 'turn_started' || event.type === 'turn_steered'
    const published = event.type === 'artifact_created'
    const descriptors = [
      ...(Array.isArray(videoDescriptors) ? videoDescriptors.map(value => sharedFile(value, sessionId, true)) : []),
      ...(Array.isArray(fileDescriptors) ? fileDescriptors.map(value => sharedFile(value, sessionId, false)) : [])
    ]
    if ((event.session_id && event.session_id !== sessionId)
      || (!attached && !published) || (published && descriptors.length > 1)) return safe as Event
    const videos = descriptors.filter((file): file is AgentFile => file !== null)
    for (const file of videos) files.set(file.id, file)
    return { ...safe, ...(published && videos[0] ? { artifact: videos[0] } : {}),
      ...(attached && videos.length ? { file_ids: [...new Set(videos.map(file => file.id))] } : {}) } as Event
  })
  return { events: projected, files: [...files.values()] }
}
