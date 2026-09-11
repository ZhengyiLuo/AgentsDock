export interface MediaResourceIdentity {
  profileId: string
  profileGeneration: number
  sessionId: string
  fileId: string
}

export interface WorkspaceMediaResourceIdentity {
  profileId: string
  profileGeneration: number
  sessionId: string
  path: string
}

export interface TeamAttachmentMediaResourceIdentity {
  profileId: string
  profileGeneration: number
  hubGeneration: number
  authCacheEpoch: string
  teamId: string
  attachmentId: string
}

export type ParsedMediaResource = MediaResourceIdentity | WorkspaceMediaResourceIdentity | TeamAttachmentMediaResourceIdentity

const MEDIA_SCHEME = 'agentsdock-media:'
const FILE_MEDIA_HOST = 'file'
const WORKSPACE_MEDIA_HOST = 'workspace'
const TEAM_MEDIA_HOST = 'team'
const MAX_MEDIA_IDENTIFIER_LENGTH = 2_048
const MAX_WORKSPACE_MEDIA_PATH_LENGTH = 4_096
const INVALID_MEDIA_IDENTIFIER = /[\u0000-\u001f\u007f]/

export function isValidMediaIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_MEDIA_IDENTIFIER_LENGTH
    && value.trim() === value
    && !INVALID_MEDIA_IDENTIFIER.test(value)
    && value !== '.'
    && value !== '..'
}

export function buildMediaURL(
  profileId: string,
  profileGeneration: number,
  sessionId: string,
  fileId: string
): string {
  if (
    !isValidMediaIdentifier(profileId)
    || !Number.isSafeInteger(profileGeneration)
    || profileGeneration < 0
    || !isValidMediaIdentifier(sessionId)
    || !isValidMediaIdentifier(fileId)
  ) {
    throw new TypeError('Invalid media resource identity')
  }
  return `${MEDIA_SCHEME}//${FILE_MEDIA_HOST}/${encodeURIComponent(profileId)}/${profileGeneration}/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileId)}`
}

export function isValidWorkspaceMediaPath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_WORKSPACE_MEDIA_PATH_LENGTH
    || INVALID_MEDIA_IDENTIFIER.test(value)
    || value.startsWith('/')
    || value.includes('\\')
    || /^[A-Za-z]:\//.test(value)
  ) return false
  const segments = value.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

export function buildWorkspaceMediaURL(
  profileId: string,
  profileGeneration: number,
  sessionId: string,
  path: string
): string {
  if (
    !isValidMediaIdentifier(profileId)
    || !Number.isSafeInteger(profileGeneration)
    || profileGeneration < 0
    || !isValidMediaIdentifier(sessionId)
    || !isValidWorkspaceMediaPath(path)
  ) {
    throw new TypeError('Invalid workspace media resource identity')
  }
  return `${MEDIA_SCHEME}//${WORKSPACE_MEDIA_HOST}/${encodeURIComponent(profileId)}/${profileGeneration}/${encodeURIComponent(sessionId)}/${encodeURIComponent(path)}`
}

export function buildTeamAttachmentMediaURL(
  profileId: string,
  profileGeneration: number,
  hubGeneration: number,
  authCacheEpoch: string,
  teamId: string,
  attachmentId: string
): string {
  if (
    !isValidMediaIdentifier(profileId)
    || !Number.isSafeInteger(profileGeneration)
    || profileGeneration < 0
    || !Number.isSafeInteger(hubGeneration)
    || hubGeneration < 0
    || !isValidMediaIdentifier(authCacheEpoch)
    || !isValidMediaIdentifier(teamId)
    || !isValidMediaIdentifier(attachmentId)
  ) throw new TypeError('Invalid Team attachment media identity')
  return `${MEDIA_SCHEME}//${TEAM_MEDIA_HOST}/${encodeURIComponent(profileId)}/${profileGeneration}/${hubGeneration}/${encodeURIComponent(authCacheEpoch)}/${encodeURIComponent(teamId)}/${encodeURIComponent(attachmentId)}`
}

export function parseMediaURL(value: string): ParsedMediaResource | null {
  try {
    const url = new URL(value)
    if (url.protocol !== MEDIA_SCHEME || url.username || url.password || url.search || url.hash) return null
    const segments = url.pathname.split('/')
    if (segments[0] !== '') return null
    if (url.host === FILE_MEDIA_HOST) return parseFileMediaSegments(segments)
    if (url.host === WORKSPACE_MEDIA_HOST) return parseWorkspaceMediaSegments(segments)
    if (url.host === TEAM_MEDIA_HOST) return parseTeamMediaSegments(segments)
    return null
  } catch {
    return null
  }
}

function parseTeamMediaSegments(segments: string[]): TeamAttachmentMediaResourceIdentity | null {
  try {
    if (segments.length !== 7 || !segments[1] || !segments[2] || !segments[3] || !segments[4] || !segments[5] || !segments[6]) return null
    const profileId = decodeURIComponent(segments[1])
    const profileGeneration = Number(segments[2])
    const hubGeneration = Number(segments[3])
    const authCacheEpoch = decodeURIComponent(segments[4])
    const teamId = decodeURIComponent(segments[5])
    const attachmentId = decodeURIComponent(segments[6])
    return isValidMediaIdentifier(profileId)
      && Number.isSafeInteger(profileGeneration)
      && profileGeneration >= 0
      && String(profileGeneration) === segments[2]
      && Number.isSafeInteger(hubGeneration)
      && hubGeneration >= 0
      && String(hubGeneration) === segments[3]
      && isValidMediaIdentifier(authCacheEpoch)
      && isValidMediaIdentifier(teamId)
      && isValidMediaIdentifier(attachmentId)
      ? { profileId, profileGeneration, hubGeneration, authCacheEpoch, teamId, attachmentId }
      : null
  } catch {
    return null
  }
}

function parseFileMediaSegments(segments: string[]): MediaResourceIdentity | null {
  try {
    if (segments.length !== 5 || !segments[1] || !segments[2] || !segments[3] || !segments[4]) return null
    const profileId = decodeURIComponent(segments[1])
    const profileGeneration = Number(segments[2])
    const sessionId = decodeURIComponent(segments[3])
    const fileId = decodeURIComponent(segments[4])
    return isValidMediaIdentifier(profileId)
      && Number.isSafeInteger(profileGeneration)
      && profileGeneration >= 0
      && String(profileGeneration) === segments[2]
      && isValidMediaIdentifier(sessionId)
      && isValidMediaIdentifier(fileId)
      ? { profileId, profileGeneration, sessionId, fileId }
      : null
  } catch {
    return null
  }
}

function parseWorkspaceMediaSegments(segments: string[]): WorkspaceMediaResourceIdentity | null {
  try {
    if (segments.length !== 5 || !segments[1] || !segments[2] || !segments[3] || !segments[4]) return null
    const profileId = decodeURIComponent(segments[1])
    const profileGeneration = Number(segments[2])
    const sessionId = decodeURIComponent(segments[3])
    const path = decodeURIComponent(segments[4])
    return isValidMediaIdentifier(profileId)
      && Number.isSafeInteger(profileGeneration)
      && profileGeneration >= 0
      && String(profileGeneration) === segments[2]
      && isValidMediaIdentifier(sessionId)
      && isValidWorkspaceMediaPath(path)
      ? { profileId, profileGeneration, sessionId, path }
      : null
  } catch {
    return null
  }
}
