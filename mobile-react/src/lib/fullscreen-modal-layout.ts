export const FULLSCREEN_HEADER_GUTTER = 8
export const FULLSCREEN_HEADER_MIN_HEIGHT = 64

export interface FullscreenSafeAreaInsets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface FullscreenModalPadding {
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
}

export function fullscreenModalPadding(
  insets: FullscreenSafeAreaInsets,
  platform: string,
): FullscreenModalPadding {
  const top = safeInset(insets.top)
  return {
    paddingTop: Math.max(top, platform === 'ios' ? 20 : 0),
    paddingRight: safeInset(insets.right),
    paddingBottom: safeInset(insets.bottom),
    paddingLeft: safeInset(insets.left),
  }
}

export function fullscreenModalTopPadding(
  insets: FullscreenSafeAreaInsets,
  platform: string,
): number {
  return fullscreenModalPadding(insets, platform).paddingTop + FULLSCREEN_HEADER_GUTTER
}

function safeInset(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}
