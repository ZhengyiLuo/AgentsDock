type WorkspaceShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>

export type WorkspaceTabNavigation =
  | { kind: 'cycle'; direction: -1 | 1 }
  | { kind: 'select'; index: number }

export function isTerminalToggleShortcut(event: WorkspaceShortcutEvent): boolean {
  return event.ctrlKey
    && !event.repeat
    && !event.metaKey
    && !event.altKey
    && !event.shiftKey
    && (event.code === 'Backquote' || event.key === '`')
}

export function workspaceTabNavigationShortcut(event: WorkspaceShortcutEvent): WorkspaceTabNavigation | null {
  if (event.repeat) return null
  if (event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey) {
    if (event.code === 'ArrowLeft' || event.key === 'ArrowLeft') return { kind: 'cycle', direction: -1 }
    if (event.code === 'ArrowRight' || event.key === 'ArrowRight') return { kind: 'cycle', direction: 1 }
  }
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') {
    return { kind: 'cycle', direction: event.shiftKey ? -1 : 1 }
  }
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null
  return /^[1-9]$/.test(event.key)
    ? { kind: 'select', index: Number(event.key) - 1 }
    : null
}

export function workspaceTabNavigationTarget(
  activePath: string | null,
  openPaths: string[],
  navigation: WorkspaceTabNavigation
): string | null | undefined {
  const tabs: Array<string | null> = [null, ...openPaths]
  if (navigation.kind === 'select') return tabs[navigation.index]
  const activeIndex = activePath === null ? 0 : tabs.indexOf(activePath)
  const current = activeIndex < 0 ? 0 : activeIndex
  return tabs[(current + navigation.direction + tabs.length) % tabs.length]
}
