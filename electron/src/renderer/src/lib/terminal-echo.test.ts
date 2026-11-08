import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { attachTerminalEcho, TerminalEchoPrediction, type EchoFrame } from './terminal-echo'

const frame = (text = '', extra: Partial<EchoFrame> = {}): EchoFrame => ({
  x: 2 + text.length, y: 3, base: 0, cols: 80, line: `$ ${text}`, eligible: true, ...extra
})
function trained() {
  const echo = new TerminalEchoPrediction()
  echo.input('a', frame(), 10); expect(echo.preview).toBeNull()
  echo.observe(frame('a')); echo.input('b', frame('a'), 20); expect(echo.preview).toBeNull()
  echo.observe(frame('ab'))
  return echo
}
describe('conservative terminal prediction', () => {
  it('previews after confirmed echoes, then removes exactly confirmed prefixes', () => {
    const echo = trained()
    echo.input('c', frame('ab'), 30); echo.input('d', frame('ab'), 40)
    expect(echo.preview).toEqual({text:'cd',x:4,y:3})
    echo.observe(frame('abc')); expect(echo.preview?.text).toBe('d')
    echo.observe(frame('abcd')); expect(echo.preview).toBeNull()
  })
  it.each(['\r', '\x03', '\x1b[A', '\x7f', '\t', '\x1b[200~hello\x1b[201~', 'paste', '中', '😀', '*'])('retires confidence on %j', input => {
    const echo = trained(); echo.input(input, frame('ab'), 30)
    echo.input('z', frame('ab'), 40); expect(echo.preview).toBeNull()
  })
  it('never predicts a non-echoing password after a command boundary', () => {
    const echo = trained(); echo.input('\r', frame('ab'), 30)
    for (const value of 'secret') echo.input(value, frame('', {eligible:false}), 40)
    expect(echo.preview).toBeNull()
  })
  it('repeated mask echoes cannot arm prediction', () => {
    const echo = new TerminalEchoPrediction()
    for (let i=0;i<5;i++) {echo.input('.', frame('.'.repeat(i)),i*10);echo.observe(frame('.'.repeat(i+1)))}
    echo.input('s',frame('.....'),60);expect(echo.preview).toBeNull()
  })
  it('unexpected output drops the overlay, not the authoritative contents', () => {
    const echo = trained(); echo.input('c', frame('ab'), 30)
    echo.observe(frame('abX')); expect(echo.preview).toBeNull()
  })
  it.each([{y:4},{base:1},{cols:40},{eligible:false},{x:1},{line:'unrelated'}])('retires on a changed viewport %j', extra => {
    const echo=trained();echo.input('c',frame('ab'),30);echo.observe(frame('ab',extra));expect(echo.preview).toBeNull()
  })
  it('does not predict across idle periods or line wrapping', () => {
    const echo=trained();echo.input('c',frame('ab'),2000);expect(echo.preview).toBeNull()
    const edge=trained();edge.input('c',frame('ab',{cols:5}),30);expect(edge.preview).toBeNull()
  })
  it('explicit detach/navigation reset discards pending predictions', () => {
    const echo=trained();echo.input('c',frame('ab'),30);echo.reset();expect(echo.preview).toBeNull()
  })
  it.each(['normal', 'alternate'])('reconciles shell echoes in the %s buffer, including tmux attachments', type => {
    const host = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    host.append(screen)
    Object.defineProperties(screen, { clientWidth: { value: 800 }, clientHeight: { value: 240 } })
    let text = ''
    let parsed = () => {}
    const modes = { bracketedPasteMode: true }
    const terminal = {
      cols: 80, rows: 24, options: { fontFamily: 'monospace', fontSize: 14 },
      modes, hasSelection: () => false,
      buffer: { active: {
        type, baseY: 0, viewportY: 0, cursorY: 0,
        get cursorX() { return text.length },
        getLine: () => ({ translateToString: (_trim: boolean, start = 0) => text.slice(start) })
      } },
      onWriteParsed: (callback: () => void) => { parsed = callback; return { dispose() {} } },
      onSelectionChange: () => ({ dispose() {} })
    } as unknown as Terminal
    const echo = attachTerminalEcho(terminal, host)
    try {
      echo.input('a'); text = 'a'; parsed()
      echo.input('b'); text = 'ab'; parsed()
      echo.input('c')
      const overlay = screen.querySelector<HTMLElement>('.terminal-predicted-input')!
      expect(overlay.textContent).toBe('c')
      expect(overlay.style.display).toBe('block')
      text = 'abc'; parsed()
      expect(overlay.textContent).toBe('')
      modes.bracketedPasteMode = false
      echo.input('d')
      expect(overlay.textContent).toBe('')
    } finally { echo.dispose() }
    expect(screen.querySelector('.terminal-predicted-input')).toBeNull()
  })
})
