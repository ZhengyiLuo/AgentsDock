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

export function accumulateTerminalWheel(
  remainder: number,
  event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  viewportRows = 30
): { lines: number; remainder: number } {
  const normalized = event.deltaMode === 1
    ? event.deltaY
    : event.deltaMode === 2
      ? event.deltaY * Math.max(1, viewportRows)
      : event.deltaY / 24
  const total = remainder + normalized
  const rawLines = Math.trunc(total) || 0
  const lines = Math.max(-80, Math.min(80, rawLines))
  return {
    lines,
    remainder: Math.abs(rawLines) > 80 ? 0 : total - rawLines
  }
}
