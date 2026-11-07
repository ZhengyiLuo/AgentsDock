import type { Terminal } from '@xterm/xterm'

export interface EchoFrame {
  x: number; y: number; base: number; cols: number; line: string; eligible: boolean
}

/** Visual-only prediction: never writes to xterm, the PTY, history or clipboard.
 * Learn two exact echoes within this input burst before predicting. Every
 * command/edit boundary retires confidence; unsupported input passes unchanged.
 */
export class TerminalEchoPrediction {
  private anchor: EchoFrame | null = null
  private pending = ''
  private confirmed = new Set<string>()
  private lastInput = 0

  reset(): void { this.anchor = null; this.pending = ''; this.confirmed.clear() }
  get tracking(): boolean { return this.anchor !== null }

  input(value: string, frame: EchoFrame, now: number): void {
    if (now - this.lastInput > 1_000) this.reset()
    this.lastInput = now
    this.observe(frame)
    // Only single ASCII appends into blank cells. No paste, IME, mask chars,
    // editing or wrapping: these use only the authoritative server output.
    if (!frame.eligible || !/^[\x20-\x7e]$/.test(value) || value === '*' ||
        this.pending.length >= 64 || frame.x + this.pending.length + 1 >= frame.cols) {
      this.reset(); return
    }
    this.anchor ??= { ...frame }
    this.pending += value
  }

  observe(frame: EchoFrame): void {
    const anchor = this.anchor
    if (!anchor) return
    const advanced = frame.x - anchor.x
    if (!frame.eligible || frame.y !== anchor.y || frame.base !== anchor.base || frame.cols !== anchor.cols ||
        advanced < 0 || advanced > this.pending.length ||
        frame.line.slice(0, anchor.x) !== anchor.line.slice(0, anchor.x) ||
        frame.line.slice(anchor.x, frame.x) !== this.pending.slice(0, advanced)) {
      this.reset(); return
    }
    if (advanced) {
      // Repeated masking characters cannot establish confidence, even if the
      // user happened to type that mask character. Require distinct alphanumerics.
      for (const char of this.pending.slice(0, advanced)) if (/[a-zA-Z0-9]/.test(char)) this.confirmed.add(char)
      this.pending = this.pending.slice(advanced)
      this.anchor = { ...frame }
    }
  }

  get preview(): { text: string; x: number; y: number } | null {
    return this.anchor && this.confirmed.size >= 2 && this.pending
      ? { text: this.pending, x: this.anchor.x, y: this.anchor.y } : null
  }
}

/** Cache geometry on resize, not on keystrokes. The overlay is never selectable. */
export function attachTerminalEcho(terminal: Terminal, host: HTMLElement) {
  const screen = host.querySelector<HTMLElement>('.xterm-screen')
  const prediction = new TerminalEchoPrediction()
  const overlay = document.createElement('span')
  overlay.className = 'terminal-predicted-input'
  overlay.setAttribute('aria-hidden', 'true')
  Object.assign(overlay.style, { position: 'absolute', pointerEvents: 'none', userSelect: 'none', whiteSpace: 'pre', opacity: '0.55',
    fontFamily: String(terminal.options.fontFamily), fontSize: `${terminal.options.fontSize}px`, fontWeight: '400',
    zIndex: '4', display: 'none' })
  screen?.append(overlay)
  let width = 0, height = 0, expiry: ReturnType<typeof setTimeout> | undefined
  const frame = (): EchoFrame => {
    const buffer = terminal.buffer.active
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)
    return { x: buffer.cursorX, y: buffer.cursorY, base: buffer.baseY, cols: terminal.cols,
      line: line?.translateToString(false) ?? '',
      // tmux itself uses the alternate buffer even for an ordinary shell.
      // Buffer type alone cannot distinguish shell input from fullscreen apps.
      eligible: terminal.modes.bracketedPasteMode && !terminal.hasSelection() &&
        buffer.viewportY === buffer.baseY && !!line && !line.translateToString(true, buffer.cursorX).trim() }
  }
  const paint = () => {
    const preview = prediction.preview
    overlay.style.display = preview && width && height ? 'block' : 'none'
    const text = preview?.text ?? ''
    if (overlay.textContent !== text) overlay.textContent = text
    if (preview) {
      overlay.style.left = `${preview.x * width}px`; overlay.style.top = `${preview.y * height}px`
      overlay.style.lineHeight = `${height}px`; overlay.style.color = terminal.options.theme?.foreground ?? 'inherit'
    }
  }
  const reset = () => { clearTimeout(expiry); prediction.reset(); paint() }
  const measure = () => {
    reset(); width = (screen?.clientWidth ?? 0) / terminal.cols; height = (screen?.clientHeight ?? 0) / terminal.rows
  }
  const observer = new ResizeObserver(measure)
  if (screen) observer.observe(screen)
  const parsed = terminal.onWriteParsed(() => {
    if (!prediction.tracking) return
    prediction.observe(frame()); paint()
  })
  const selection = terminal.onSelectionChange(reset)
  host.addEventListener('compositionstart', reset); host.addEventListener('paste', reset); host.addEventListener('pointerdown', reset)
  host.addEventListener('focusout', reset)
  document.addEventListener('visibilitychange', reset)
  measure()
  return {
    input(value: string) {
      prediction.input(value, frame(), performance.now()); paint()
      clearTimeout(expiry); expiry = setTimeout(reset, 1_000)
    },
    reset,
    dispose() {
      reset(); parsed.dispose(); selection.dispose(); observer.disconnect(); overlay.remove()
      host.removeEventListener('compositionstart', reset); host.removeEventListener('paste', reset); host.removeEventListener('pointerdown', reset)
      host.removeEventListener('focusout', reset); document.removeEventListener('visibilitychange', reset)
    }
  }
}
