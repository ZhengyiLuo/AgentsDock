import {
  artifactVideoStageCacheKey,
  artifactVideoStageProgress,
  completedArtifactVideoDownload,
  reusableArtifactVideoCache,
  shouldGenerateAutomaticVideoThumbnail,
} from './artifact-video-staging'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(reusableArtifactVideoCache({ exists: true, size: 42 }, 42), 'matching cache should be reused')
assert(!reusableArtifactVideoCache({ exists: true, size: 41 }, 42), 'partial cache must not be reused')
assert(!reusableArtifactVideoCache({ exists: true, isDirectory: true, size: 42 }, 42), 'directory is not a cache file')
assert(!reusableArtifactVideoCache({ exists: true, size: 1 }, null), 'unknown-size cache may be a partial download')
assert(completedArtifactVideoDownload({ exists: true, size: 1 }, null), 'a completed unknown-size response may be used')
assert(!completedArtifactVideoDownload({ exists: true, size: 0 }, null), 'an empty video response is invalid')

assert(artifactVideoStageProgress(25, 100, null) === 0.25, 'response length should drive progress')
assert(artifactVideoStageProgress(25, -1, 50) === 0.5, 'metadata should backstop an absent response length')
assert(artifactVideoStageProgress(125, 100, null) === 1, 'progress should clamp above one')
assert(artifactVideoStageProgress(10, -1, null) === null, 'unknown length should remain indeterminate')

assert(!shouldGenerateAutomaticVideoThumbnail('ios', false), 'iOS must not create timeline AVPlayers')
assert(!shouldGenerateAutomaticVideoThumbnail('android', true), 'an open viewer suspends Android thumbnails')
assert(shouldGenerateAutomaticVideoThumbnail('android', false), 'Android can keep bounded thumbnail generation')

assert(artifactVideoStageCacheKey('server\u0000chat\u0000file') === artifactVideoStageCacheKey('server\u0000chat\u0000file'), 'cache key should be stable')
assert(artifactVideoStageCacheKey('server\u0000chat\u0000file') !== artifactVideoStageCacheKey('other\u0000chat\u0000file'), 'cache key should be server scoped')
