export const APP_SHORTCUTS = {
  newChat: { label: 'New chat', accelerator: 'CmdOrCtrl+N', mac: '⌘N', other: 'Ctrl+N' },
  openWorkspaceFile: { label: 'Open workspace file', accelerator: 'CmdOrCtrl+O', mac: '⌘O', other: 'Ctrl+O' },
  attachFiles: { label: 'Attach files', accelerator: 'CmdOrCtrl+Shift+O', mac: '⇧⌘O', other: 'Ctrl+Shift+O' },
  settings: { label: 'Settings', accelerator: 'CmdOrCtrl+,', mac: '⌘,', other: 'Ctrl+,' },
  findChat: { label: 'Switch chat', accelerator: 'CmdOrCtrl+P', mac: '⌘P', other: 'Ctrl+P' },
  findInChat: { label: 'Find in chat', accelerator: 'CmdOrCtrl+F', mac: '⌘F', other: 'Ctrl+F' },
  nextWorkspaceTab: { label: 'Next workspace tab', accelerator: 'Control+Tab', mac: '⌃⇥', other: 'Ctrl+Tab' },
  previousWorkspaceTab: { label: 'Previous workspace tab', accelerator: 'Control+Shift+Tab', mac: '⌃⇧⇥', other: 'Ctrl+Shift+Tab' },
  focusLeftChatPane: { label: 'Focus left chat pane', mac: '⌥⌘←', other: 'Ctrl+Alt+←' },
  focusRightChatPane: { label: 'Focus right chat pane', mac: '⌥⌘→', other: 'Ctrl+Alt+→' },
  nextServer: { label: 'Next server', accelerator: 'CmdOrCtrl+Shift+]', mac: '⇧⌘]', other: 'Ctrl+Shift+]' },
  previousServer: { label: 'Previous server', accelerator: 'CmdOrCtrl+Shift+[', mac: '⇧⌘[', other: 'Ctrl+Shift+[' },
  toggleSidebar: { label: 'Toggle chat list', mac: '⌘/', other: 'Ctrl+/' },
  toggleInspector: { label: 'Toggle inspector', accelerator: 'CmdOrCtrl+L', mac: '⌘L', other: 'Ctrl+L' },
  jumpLatest: { label: 'Jump to latest', accelerator: 'CmdOrCtrl+Down', mac: '⌘↓', other: 'Ctrl+↓' },
  closeSurface: { label: 'Close', accelerator: 'CmdOrCtrl+W', mac: '⌘W', other: 'Ctrl+W' },
  toggleTerminal: { label: 'Toggle terminal', mac: '⌃`', other: 'Ctrl+`' },
  terminalNewWindow: { label: 'New tmux window', mac: '⌘T', other: 'Ctrl+T' },
  terminalSplitRight: { label: 'Split pane right', mac: '⌘D', other: 'Ctrl+D' },
  terminalSplitDown: { label: 'Split pane down', mac: '⇧⌘D', other: 'Ctrl+Shift+D' },
  terminalFind: { label: 'Find in terminal', mac: '⌘F', other: 'Ctrl+F' },
  sendMessage: { label: 'Send message', mac: '↩', other: 'Enter' },
  steerMessage: { label: 'Steer now', mac: '⌘↩', other: 'Ctrl+Enter' }
} as const

export type AppShortcutId = keyof typeof APP_SHORTCUTS
export type ShortcutPlatform = 'mac' | 'other'
export type AppShortcutGroupId = 'general' | 'navigation' | 'terminal' | 'messaging'

const MAC_ONLY_SHORTCUTS = new Set<AppShortcutId>([
  'terminalNewWindow',
  'terminalSplitRight',
  'terminalSplitDown'
])

export const APP_SHORTCUT_GROUPS = [
  {
    id: 'general',
    shortcuts: ['newChat', 'openWorkspaceFile', 'attachFiles', 'settings', 'findChat', 'findInChat', 'closeSurface']
  },
  {
    id: 'navigation',
    shortcuts: ['nextWorkspaceTab', 'previousWorkspaceTab', 'focusLeftChatPane', 'focusRightChatPane', 'nextServer', 'previousServer', 'toggleSidebar', 'toggleInspector', 'jumpLatest']
  },
  {
    id: 'terminal',
    shortcuts: ['toggleTerminal', 'terminalNewWindow', 'terminalSplitRight', 'terminalSplitDown', 'terminalFind']
  },
  {
    id: 'messaging',
    shortcuts: ['sendMessage', 'steerMessage']
  }
] as const satisfies ReadonlyArray<{
  id: AppShortcutGroupId
  shortcuts: readonly AppShortcutId[]
}>

export function shortcutTranslationKey(id: AppShortcutId): string {
  return `shortcuts.action.${id}`
}

export function shortcutIsAvailable(id: AppShortcutId, platform: ShortcutPlatform): boolean {
  return platform === 'mac' || !MAC_ONLY_SHORTCUTS.has(id)
}

export function shortcutDisplay(id: AppShortcutId, platform: ShortcutPlatform): string {
  return APP_SHORTCUTS[id][platform]
}

export function shortcutKeycaps(id: AppShortcutId, platform: ShortcutPlatform): readonly string[] {
  const display = shortcutDisplay(id, platform)
  if (platform === 'other') return display.split('+')

  const characters = Array.from(display)
  const keycaps: string[] = []
  while (characters.length && ['⌘', '⌥', '⌃', '⇧'].includes(characters[0])) {
    keycaps.push(characters.shift()!)
  }
  if (characters.length) keycaps.push(characters.join(''))
  return keycaps
}

export function shortcutAccelerator(id: AppShortcutId): string {
  const shortcut = APP_SHORTCUTS[id] as { accelerator?: string }
  if (!shortcut.accelerator) throw new Error(`${id} is not registered as a native menu accelerator.`)
  return shortcut.accelerator
}
