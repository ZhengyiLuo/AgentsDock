import type { ShortcutPlatform } from '@shared/shortcuts'

export type ChatSwitcherShortcutTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

export function chatSwitcherShortcutPlatform(navigatorLike: Pick<Navigator, 'platform' | 'userAgent'>): ShortcutPlatform {
  return /Mac|iPhone|iPad|iPod/i.test(`${navigatorLike.platform} ${navigatorLike.userAgent}`) ? 'mac' : 'other'
}

export function isChatSwitcherShortcut(event: KeyboardEvent, platform: ShortcutPlatform): boolean {
  if (event.repeat || event.isComposing || event.altKey || event.shiftKey) return false
  const exactModifier = platform === 'mac'
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
  if (!exactModifier) return false
  return event.key.toLocaleLowerCase() === 'p' || event.code === 'KeyP'
}

/**
 * Install before React mounts so editor capture handlers cannot take Cmd/Ctrl+P.
 * Electron's native menu command remains a fallback for non-keyboard invocation.
 */
export function installChatSwitcherShortcut(
  target: ChatSwitcherShortcutTarget,
  openChatSwitcher: () => void,
  platform: ShortcutPlatform
): () => void {
  const handleKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || !isChatSwitcherShortcut(event, platform)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    openChatSwitcher()
  }
  target.addEventListener('keydown', handleKeyDown, true)
  return () => target.removeEventListener('keydown', handleKeyDown, true)
}
