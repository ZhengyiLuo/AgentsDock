import { describe, expect, it } from 'vitest'
import { terminalClipboardShortcut } from './terminal-shortcuts'

describe('terminalClipboardShortcut', () => {
  it('leaves Control-C with the shell while reserving Command-C for local copying', () => {
    expect(terminalClipboardShortcut({ key: 'c', metaKey: false })).toBeNull()
    expect(terminalClipboardShortcut({ key: 'c', metaKey: true })).toBe('copy')
  })

  it('uses Electron and xterm native paste exactly once', () => {
    expect(terminalClipboardShortcut({ key: 'v', metaKey: true })).toBe('native-paste')
  })

  it('maps Command-A to the terminal scrollback selection', () => {
    expect(terminalClipboardShortcut({ key: 'a', metaKey: true })).toBe('select-all')
  })
})
