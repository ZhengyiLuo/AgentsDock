import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/styles.css'),
  'utf8'
)

describe('timeline live-progress styles', () => {
  it('uses a compact, bounded activity rail for reasoning and tools', () => {
    expect(styles).not.toContain('.trace-progress-card')
    expect(styles).not.toContain('.message-live-activity')
    expect(styles).toMatch(/\.trace-summary-preview \{[^}]*-webkit-line-clamp: 2;/s)
    expect(styles).toMatch(/\.trace-details \{[^}]*max-height: min\(520px, 55vh\);[^}]*overflow-y: auto;[^}]*scrollbar-gutter: stable;/s)
    expect(styles).toMatch(/\.trace-detail-actions \{[^}]*position: sticky;[^}]*bottom: 0;/s)
    expect(styles).toMatch(/\.trace-reasoning-preview \{[^}]*white-space: pre-line;[^}]*-webkit-line-clamp: 2;/s)
    expect(styles).toContain(':root[data-theme="light"] .trace-summary-action { color: var(--accent); }')
    expect(styles).toContain(':root[data-theme="light"] .trace-details { background: var(--surface-2); border-color: var(--border); }')
    expect(styles).toContain(':root[data-theme="light"] .tool-event-status.success { color: #21643f; }')
    expect(styles).toContain(':root[data-theme="light"] .tool-event-status.running { color: #715015; }')
    expect(styles).toContain(':root[data-theme="light"] .tool-event-status.error { color: #9b302b; }')
  })
})

describe('cross-chat conversation styles', () => {
  it('keeps message and source-request paragraphs at Markdown body size in both themes', () => {
    // These selectors outrank both the generic system-row paragraph styles and
    // their later light-theme overrides, without introducing a second palette.
    const bodyRule = styles.match(/\.system-row\.cross-chat\.exchange-conversation \.cross-chat-leg-body \.markdown \{[^}]*\}/s)?.[0] ?? ''
    const paragraphRule = styles.match(/\.system-row\.cross-chat\.exchange-conversation \.cross-chat-leg-body \.markdown p,\s*\.system-row\.cross-chat\.exchange-conversation \.cross-chat-exchange-details \.markdown p \{[^}]*\}/s)?.[0] ?? ''
    for (const rule of [bodyRule, paragraphRule]) {
      expect(rule).toContain('color: inherit;')
      expect(rule).toContain('font-size: inherit;')
      expect(rule).toContain('line-height: inherit;')
      expect(rule).not.toContain('!important')
    }
    expect(styles).toMatch(/\.cross-chat-leg-body \{[^}]*font-size: var\(--text-size-label\);[^}]*line-height: 1\.55;/s)
    expect(styles).toContain(':root[data-theme="light"] .cross-chat-leg-body,')
  })

  it('renders one purple conversation surface with compact, correctly aligned message bubbles', () => {
    const previewRule = styles.match(/\.system-row\.cross-chat\.exchange-conversation \.cross-chat-leg-preview \{[^}]*\}/s)?.[0] ?? ''
    const conversationRule = styles.match(/\.system-row\.cross-chat\.exchange-conversation \{[^}]*\}/s)?.[0] ?? ''
    const participantRule = styles.match(/\.cross-chat-participants \{[^}]*\}/s)?.[0] ?? ''
    const legRule = styles.match(/\.cross-chat-conversation-leg \{[^}]*\}/s)?.[0] ?? ''
    const stateRule = styles.match(/\.cross-chat-exchange-state \{[^}]*\}/s)?.[0] ?? ''
    expect(previewRule).not.toContain('-webkit-line-clamp')
    expect(styles).not.toMatch(/\.cross-chat-leg-body\.collapsed \{[^}]*(?:overflow: hidden|-webkit-mask-image|mask-image)/s)
    expect(conversationRule).toContain('background: linear-gradient')
    expect(participantRule).toContain('background: transparent')
    expect(participantRule).toContain('border: 0')
    expect(legRule).toContain('width: fit-content')
    expect(legRule).toContain('background: #302640')
    expect(legRule).toContain('border: 1px solid #4d3e61')
    expect(legRule).toContain('border-radius: 12px 12px 12px 4px')
    expect(stateRule).not.toContain('background:')
    expect(stateRule).not.toContain('border:')
    expect(styles).toContain('.cross-chat-exchange-state.failed { color: #ffb4af; }')
    expect(styles).toMatch(/\.cross-chat-exchange-state\.cancelled,\s*\.cross-chat-exchange-state\.expired \{ color: #b7a9d6; \}/s)
    expect(styles).toMatch(/\.cross-chat-conversation-leg\.left \{[^}]*align-self: flex-start;/s)
    expect(styles).toMatch(/\.cross-chat-conversation-leg\.right \{[^}]*align-self: flex-end;/s)
    expect(styles).not.toContain('.cross-chat-leg-meta')
    expect(styles).not.toContain('.cross-chat-leg-sequence')
    expect(styles).not.toContain('.cross-chat-exchange-meta span')
    expect(styles).toContain('.cross-chat-conversation-leg.current')
    expect(styles).toContain(':root[data-theme="light"] .cross-chat-leg-body-toggle { color: #67458f; }')
    expect(styles).toContain(':root[data-theme="light"] .cross-chat-conversation-fold button')
  })
})
