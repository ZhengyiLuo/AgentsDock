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

export function shortcutDisplay(id: AppShortcutId, platform: ShortcutPlatform): string {
  return APP_SHORTCUTS[id][platform]
}

export function shortcutAccelerator(id: AppShortcutId): string {
  const shortcut = APP_SHORTCUTS[id] as { accelerator?: string }
  if (!shortcut.accelerator) throw new Error(`${id} is not registered as a native menu accelerator.`)
  return shortcut.accelerator
}
