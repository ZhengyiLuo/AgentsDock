import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
const light = styles.match(/:root\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1] ?? ''
const properties = Object.fromEntries(
  [...light.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()])
)

describe('cool light backgrounds with original message and action colors', () => {
  it('uses a white canvas and cool zinc surfaces instead of yellow-gray neutrals', () => {
    expect(properties).toMatchObject({
      '--bg': '#ffffff',
      '--surface': '#ffffff',
      '--surface-2': '#f4f4f5',
      '--surface-3': '#e4e4e7',
      '--border': '#e4e4e7',
      '--text': '#1a1a1e'
    })
  })

  it('preserves the original blue accent and semantic status colors', () => {
    expect(properties).toMatchObject({
      '--accent': '#0878e8',
      '--accent-hover': '#168bff',
      '--green': '#18854f',
      '--danger': '#c73531',
      '--danger-strong': '#c8413d',
      '--danger-highlight': '#c93c38',
      '--danger-text': '#b52d29'
    })
    expect(styles).toContain(':root[data-theme="light"] .composer-editor > textarea::selection { background: #8ab4d866; }')
    expect(styles).toContain(':root[data-theme="light"] .dialog-form .job-reference-editor > textarea::selection { background: #8ab4d866; }')
  })

  it('keeps sent messages green instead of overriding them with neutral surfaces', () => {
    expect(properties).toMatchObject({ '--green-surface': '#e8f5ec', '--green-border': '#a6d7b6' })
    const bubble = styles.match(/^\.message-row\.user \.message-surface \{([^}]*)\}/m)?.[1] ?? ''
    expect(bubble).toContain('background: var(--green-surface);')
    expect(bubble).toContain('border: 1px solid var(--green-border);')
    expect(styles).not.toMatch(/:root\[data-theme="light"\] \.message-row\.user \.message-surface \{[^}]*background:/)
    expect(styles).toContain(':root[data-theme="light"] .cross-chat-queued-message.right .cross-chat-queued-bubble { background: #edf6f1; border-color: #bdd4c8; }')
    expect(contrast(properties['--text'], properties['--green-surface'])).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps send neutral-dark and disabled neutral, independently of the blue accent', () => {
    expect(styles).toContain(':root[data-theme="light"] .send-button { color: var(--text-on-accent); background: var(--text); }')
    expect(styles).toContain(':root[data-theme="light"] .send-button:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 90%, #fff); }')
    expect(styles).toContain(':root[data-theme="light"] .send-button:disabled { color: var(--faint); background: var(--surface-3); }')
  })

  it('keeps supporting copy and the send icon at normal-text contrast', () => {
    expect(contrast(properties['--muted'], properties['--surface-2'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(properties['--text-on-accent'], properties['--text'])).toBeGreaterThanOrEqual(4.5)
    const hover = rgb(properties['--text']).map(channel => Math.round(channel * 0.9 + 255 * 0.1))
    expect(contrastChannels(rgb(properties['--text-on-accent']), hover)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps hover neutral and separate from action and message colors', () => {
    expect(properties['--interaction-hover']).toBe('rgb(0 0 0 / 6%)')
    expect(properties['--interaction-pressed']).toBe('rgb(0 0 0 / 12%)')
    expect(styles).toMatch(/:root\[data-theme="light"\] \.session-row:hover \{ background: #fafafa; \}/)
    expect(styles).toMatch(/:root\[data-theme="light"\] \.session-row\.selected \{[^}]*background: var\(--surface-3\);/)
  })

  it('keeps light chip, folder-button, and checked-switch states above their base overrides', () => {
    const chipBase = ':root[data-theme="light"] .codex-permission-chip { color: var(--muted); background: var(--surface-2); }'
    const chipHover = ':root[data-theme="light"] :is(.runtime-chip, .backend-chip, .codex-permission-chip):not(:disabled):is(:hover, [data-state="open"]) { color: var(--text); background: var(--interaction-hover); }'
    const folderBase = ':root[data-theme="light"] .working-directory-picker-location > button { color: var(--accent); background: var(--surface-2); }'
    const folderHover = ':root[data-theme="light"] .working-directory-picker-location > button:hover:not(:disabled) { color: var(--accent); background: var(--surface-3); }'
    const switchBase = ':root[data-theme="light"] .settings-switch { background: #d4d4d8; }'
    const switchChecked = ':root[data-theme="light"] .settings-switch[data-state="checked"] { background: var(--accent); }'

    for (const [base, state] of [[chipBase, chipHover], [folderBase, folderHover], [switchBase, switchChecked]]) {
      expect(styles).toContain(base)
      expect(styles).toContain(state)
      expect(styles.indexOf(state)).toBeGreaterThan(styles.indexOf(base))
    }
  })
})

function rgb(hex: string): number[] {
  const value = hex.length === 4 ? hex.slice(1).split('').map(channel => channel + channel).join('') : hex.slice(1)
  return [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16))
}

function contrast(foreground: string, background: string): number {
  return contrastChannels(rgb(foreground), rgb(background))
}

function contrastChannels(foreground: number[], background: number[]): number {
  const luminance = (channels: number[]): number => channels.reduce((sum, value, index) => {
    const channel = value / 255
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    return sum + linear * [0.2126, 0.7152, 0.0722][index]
  }, 0)
  const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
  return (values[1] + 0.05) / (values[0] + 0.05)
}
