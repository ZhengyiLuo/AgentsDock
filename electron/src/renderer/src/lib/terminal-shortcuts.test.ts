import { describe, expect, it, vi } from 'vitest'
import { accumulateTerminalWheel, containTerminalWheel, terminalClipboardShortcut } from './terminal-shortcuts'

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

  it('keeps wheel input inside xterm while allowing xterm to process it', () => {
    const stopPropagation = vi.fn()
    expect(containTerminalWheel({ stopPropagation })).toBe(true)
    expect(stopPropagation).toHaveBeenCalledOnce()
  })

  it('accumulates trackpad pixels into bounded tmux history lines', () => {
    const first = accumulateTerminalWheel(0, { deltaY: -8, deltaMode: 0 })
    expect(first).toEqual({ lines: 0, remainder: -1 / 3 })
    const second = accumulateTerminalWheel(first.remainder, { deltaY: -20, deltaMode: 0 })
    expect(second.lines).toBe(-1)
    expect(second.remainder).toBeCloseTo(-1 / 6)
    expect(accumulateTerminalWheel(0, { deltaY: 200, deltaMode: 1 }).lines).toBe(80)
  })
})
