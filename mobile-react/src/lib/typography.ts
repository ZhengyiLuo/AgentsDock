export const CHAT_FONT_SCALE_MIN = 0.8
export const CHAT_FONT_SCALE_MAX = 1.4
export const CHAT_FONT_SCALE_STEP = 0.1
export const CHAT_FONT_SCALE_DEFAULT = 1

export function clampChatFontScale(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return CHAT_FONT_SCALE_DEFAULT
  const bounded = Math.min(CHAT_FONT_SCALE_MAX, Math.max(CHAT_FONT_SCALE_MIN, parsed))
  return Math.round(bounded / CHAT_FONT_SCALE_STEP) * CHAT_FONT_SCALE_STEP
}

export function scaleChatFont(size: number, scale: number): number {
  return Math.round(size * clampChatFontScale(scale) * 2) / 2
}
