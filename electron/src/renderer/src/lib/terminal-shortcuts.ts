export type TerminalClipboardShortcut = 'copy' | 'native-paste' | 'select-all' | null

export function terminalClipboardShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey'>): TerminalClipboardShortcut {
  if (!event.metaKey) return null
  const key = event.key.toLowerCase()
  if (key === 'c') return 'copy'
  if (key === 'v') return 'native-paste'
  if (key === 'a') return 'select-all'
  return null
}

export function containTerminalWheel(event: Pick<WheelEvent, 'stopPropagation'>): true {
  event.stopPropagation()
  return true
}
