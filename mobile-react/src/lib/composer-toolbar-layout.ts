export const COMPOSER_WIDE_CONTROLS_MIN_WIDTH = 600
export const COMPOSER_DENSE_CONTROLS_MAX_WIDTH = 332
export const COMPOSER_TOOLBAR_TOUCH_SIZE = 44
export const COMPOSER_COMPACT_TOOLBAR_HEIGHT = 44
export const COMPOSER_COMPACT_TOOLBAR_PADDING = 4
export const COMPOSER_COMPACT_TOOLBAR_GAP = 2
export const COMPOSER_COMPACT_BACKEND_SLOT_WIDTH = 44
export const COMPOSER_DENSE_TOOLBAR_PADDING = 2
export const COMPOSER_DENSE_TOOLBAR_GAP = 0
export const COMPOSER_DENSE_BACKEND_SLOT_WIDTH = 28
export const COMPOSER_PERMISSION_FACE_SIZE = 28
export const COMPOSER_STOP_FACE_SIZE = 30
export const COMPOSER_SEND_FACE_SIZE = 32
export const COMPOSER_EMPTY_CARD_MIN_HEIGHT = 90
export const COMPOSER_CARD_MAX_HEIGHT = 278
export const COMPOSER_SHELL_PADDING = 10

interface CompactToolbarState {
  backend: 'codex' | 'claude' | null
  active: boolean
  hasReadyContent: boolean
}

export function isCompactComposerToolbar(width: number): boolean {
  return width < COMPOSER_WIDE_CONTROLS_MIN_WIDTH
}

export function isDenseComposerToolbar(width: number): boolean {
  return width < COMPOSER_DENSE_CONTROLS_MAX_WIDTH
}

export function compactComposerToolbarRequiredWidth(state: CompactToolbarState, dense: boolean): number {
  // Active chats put labeled Stop / Steer / Queue in a separate pinned row.
  // The tool row retains Attach and quick messages, plus a keyboard-dismiss
  // target. Idle chats additionally keep a labeled Send target in this row.
  let width = state.active ? COMPOSER_TOOLBAR_TOUCH_SIZE * 3 : COMPOSER_TOOLBAR_TOUCH_SIZE * 2 + 82
  // The zero-width spacer remains a flex child and participates in `gap`.
  let childCount = 4
  if (state.backend) {
    // An idle provider icon opens the reload action and therefore needs a full
    // 44pt hit target. During an active turn the control is passive, so the
    // narrow dense mark preserves room for Stop, Steer, and Send.
    width += dense
      ? state.active ? COMPOSER_DENSE_BACKEND_SLOT_WIDTH : COMPOSER_TOOLBAR_TOUCH_SIZE
      : COMPOSER_COMPACT_BACKEND_SLOT_WIDTH
    childCount += 1
  }
  if (state.backend) {
    width += COMPOSER_TOOLBAR_TOUCH_SIZE
    childCount += 1
  }
  const padding = dense ? COMPOSER_DENSE_TOOLBAR_PADDING : COMPOSER_COMPACT_TOOLBAR_PADDING
  const gap = dense ? COMPOSER_DENSE_TOOLBAR_GAP : COMPOSER_COMPACT_TOOLBAR_GAP
  return width + padding * 2 + Math.max(0, childCount - 1) * gap
}

export function compactComposerToolbarAvailableWidth(composerWidth: number): number {
  // Count both card hairlines as one point to keep this check conservative.
  return Math.max(0, composerWidth - 2)
}

export function compactComposerToolbarFits(composerWidth: number, state: CompactToolbarState): boolean {
  const dense = isDenseComposerToolbar(composerWidth)
  return compactComposerToolbarRequiredWidth(state, dense) <= compactComposerToolbarAvailableWidth(composerWidth)
}
