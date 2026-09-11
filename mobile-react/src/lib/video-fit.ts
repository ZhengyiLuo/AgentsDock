export type VideoContentFitMode = 'contain' | 'cover'

export function nextVideoContentFit(current: VideoContentFitMode): VideoContentFitMode {
  return current === 'contain' ? 'cover' : 'contain'
}

export function isVideoFilled(current: VideoContentFitMode): boolean {
  return current === 'cover'
}
