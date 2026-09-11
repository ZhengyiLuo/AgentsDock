export const IOS_VIDEO_STAGE_STALL_MS = 30_000
export const IOS_VIDEO_STAGE_PLAYER_DELAY_MS = 300

export interface ArtifactVideoCacheInfo {
  readonly exists: boolean
  readonly isDirectory?: boolean
  readonly size?: number
}

export function reusableArtifactVideoCache(
  info: ArtifactVideoCacheInfo,
  expectedBytes: number | null | undefined,
): boolean {
  if (!info.exists || info.isDirectory) return false
  // Without authoritative metadata an old partial download is
  // indistinguishable from a complete cache entry, so never reuse it.
  if (expectedBytes == null) return false
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) return false
  return info.size === expectedBytes
}

export function completedArtifactVideoDownload(
  info: ArtifactVideoCacheInfo,
  expectedBytes: number | null | undefined,
): boolean {
  if (!info.exists || info.isDirectory || !Number.isSafeInteger(info.size) || (info.size ?? 0) <= 0) return false
  return expectedBytes == null ? true : reusableArtifactVideoCache(info, expectedBytes)
}

export function artifactVideoStageProgress(
  bytesWritten: number,
  responseExpectedBytes: number,
  metadataExpectedBytes: number | null | undefined,
): number | null {
  if (!Number.isFinite(bytesWritten) || bytesWritten < 0) return null
  const expected = Number.isFinite(responseExpectedBytes) && responseExpectedBytes > 0
    ? responseExpectedBytes
    : Number.isFinite(metadataExpectedBytes) && (metadataExpectedBytes ?? 0) > 0
      ? Number(metadataExpectedBytes)
      : 0
  if (!expected) return null
  return Math.max(0, Math.min(1, bytesWritten / expected))
}

export function shouldGenerateAutomaticVideoThumbnail(platform: string, viewerActive: boolean): boolean {
  return platform !== 'ios' && !viewerActive
}

export function artifactVideoStageCacheKey(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}
