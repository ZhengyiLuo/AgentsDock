import { ArtifactNativeVideoPlayer } from './ArtifactNativeVideoPlayer'
import type { ArtifactPlatformVideoPlayerProps, ArtifactPlatformVideoSource } from './ArtifactPlatformVideoPlayer'

export type { ArtifactPlatformVideoSource }

export function ArtifactPlatformVideoPlayer(props: ArtifactPlatformVideoPlayerProps) {
  return <ArtifactNativeVideoPlayer {...props} />
}
