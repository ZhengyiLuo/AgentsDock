export const APP_FONT_SCALE_MIN = 0.8
export const APP_FONT_SCALE_MAX = 1.4
export const APP_FONT_SCALE_STEP = 0.1
export const APP_FONT_SCALE_DEFAULT = 1

export function clampAppFontScale(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return APP_FONT_SCALE_DEFAULT
  const bounded = Math.min(APP_FONT_SCALE_MAX, Math.max(APP_FONT_SCALE_MIN, parsed))
  return Number((Math.round(bounded / APP_FONT_SCALE_STEP) * APP_FONT_SCALE_STEP).toFixed(1))
}

export function scaleAppFont(size: number, scale: number): number {
  return Math.round(size * clampAppFontScale(scale) * 2) / 2
}

// Compatibility aliases keep persisted profile migration and the Markdown
// renderer stable while the preference expands from chat-only to app-wide.
export const CHAT_FONT_SCALE_MIN = APP_FONT_SCALE_MIN
export const CHAT_FONT_SCALE_MAX = APP_FONT_SCALE_MAX
export const CHAT_FONT_SCALE_STEP = APP_FONT_SCALE_STEP
export const CHAT_FONT_SCALE_DEFAULT = APP_FONT_SCALE_DEFAULT
export const clampChatFontScale = clampAppFontScale
export const scaleChatFont = scaleAppFont
