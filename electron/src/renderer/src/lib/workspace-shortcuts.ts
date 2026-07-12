type WorkspaceShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>

export function isTerminalToggleShortcut(event: WorkspaceShortcutEvent): boolean {
  return event.ctrlKey
    && !event.repeat
    && !event.metaKey
    && !event.altKey
    && !event.shiftKey
    && (event.code === 'Backquote' || event.key === '`')
}
