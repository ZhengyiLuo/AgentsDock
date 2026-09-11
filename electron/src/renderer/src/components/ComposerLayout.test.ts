import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
const composer = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/Composer.tsx'), 'utf8')
const app = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
const pane = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/ChatPane.tsx'), 'utf8')

describe('composer queue layout', () => {
  it('contains long steer prompts inside the conversation column', () => {
    expect(styles).toMatch(/\.queue-shelf \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow: hidden;/s)
    expect(styles).toMatch(/\.queued-row \{[^}]*display: grid;[^}]*grid-template-columns: 26px minmax\(0, 1fr\) auto;[^}]*overflow: hidden;/s)
    expect(styles).toMatch(/\.queue-prompt \{[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;[^}]*-webkit-line-clamp: 3;/s)
    expect(styles).toMatch(/\.inline-editor \{[^}]*max-width: 100%;[^}]*overflow: hidden;/s)
  })

  it('lets the native textarea paint plain drafts and enables the mirror only for inline references', () => {
    expect(styles).toMatch(/\.composer-editor > textarea \{[^}]*color: #f2f2f0;[^}]*-webkit-text-fill-color: currentColor;/s)
    expect(styles).toMatch(/\.composer-editor-mirror \{[^}]*color: transparent;/s)
    expect(styles).toMatch(/\.composer-editor-mirror \.composer-inline-reference \{[^}]*color: transparent;/s)
    expect(styles).toMatch(/:root\[data-theme="light"\] \.composer-editor > textarea \{[^}]*color: var\(--text\);[^}]*caret-color: var\(--text\);/s)
    expect(styles).toMatch(/:root\[data-theme="light"\] \.composer-editor-mirror \.composer-inline-reference \{[^}]*color: transparent;/s)
    expect(styles).toMatch(/\.inline-editor \.inline-queue-reference-editor\.has-inline-references > textarea \{[^}]*background: transparent;/s)
    expect(styles).toMatch(/\.inline-queue-reference-editor \.composer-editor-mirror \{[^}]*padding: 8px;[^}]*overflow-wrap: anywhere;[^}]*background: #181818;[^}]*border: 1px solid #383838;/s)
    expect(styles).not.toMatch(/\.inline-editor \.inline-queue-reference-editor > textarea \{[^}]*background: transparent;/s)
    expect(styles).not.toMatch(/\.composer-editor\.has-inline-references > textarea \{[^}]*color: transparent;/s)
  })

  it('keeps the Stop/send rail fixed while narrow panes discard secondary labels first', () => {
    expect(composer).toMatch(/<div className="composer-secondary-controls">[\s\S]*<div className="composer-actions">/)
    expect(composer).toMatch(/className="stop-button"[\s\S]*aria-label=\{stopping \? t\("ui\.Composer\.Composer\.stopping_[a-z0-9]+"\) : t\("ui\.Composer\.Composer\.stop_[a-z0-9]+"\)\}/)
    expect(styles).toMatch(/\.composer-actions \{[^}]*flex: none;[^}]*display: flex;[^}]*margin-left: auto;/s)
    expect(styles).toMatch(/@container composer \(max-width: 360px\) \{[^}]*\.composer-secondary-controls > :not\(\.composer-add-button\) \{ display: none; \}/s)
    expect(styles).toMatch(/@container composer \(max-width: 160px\) \{[^}]*\.composer-secondary-controls \{ display: none; \}[^}]*\.steering-pending \{[^}]*position: absolute;[^}]*clip-path: inset\(50%\);/s)
  })

  it('reserves an invariant bottom control rail and bounds expandable content in short or stacked panes', () => {
    expect(app).toMatch(/<div className="chat-workspace-history">\s*<Timeline[^>]*\/>\s*<\/div>\s*<div className="chat-workspace-shelves">/)
    expect(pane).toMatch(/<div className="chat-workspace-history">\s*<Timeline[^>]*\/>\s*<\/div>\s*<div className="chat-workspace-shelves">/)
    expect(styles).toMatch(/\.chat-workspace \{[^}]*grid-template-rows: minmax\(0, 1fr\) auto auto auto;[^}]*overflow: hidden;/s)
    expect(styles).toMatch(/\.chat-workspace-shelves \{[^}]*max-height: min\(44vh, 460px\);[^}]*overflow-y: auto;/s)
    expect(readFileSync(resolve(process.cwd(), 'src/renderer/src/components/CodexControls.css'), 'utf8')).toMatch(/\.codex-goal-bar \{[^}]*margin: 0 auto 4px;/s)
    expect(styles).toMatch(/\.chat-split-view\.stacked \.composer,\s*\.chat-split-view\.short \.composer \{[^}]*max-height: 75px;[^}]*grid-template-rows: minmax\(0, 1fr\) auto;[^}]*margin-bottom: 3px;/s)
    expect(styles).toMatch(/\.chat-split-view\.stacked \.emergency-timeline-dock,\s*\.chat-split-view\.short \.emergency-timeline-dock \{[^}]*height: 40px;[^}]*margin-bottom: 1px;[^}]*overflow: hidden;/s)
  })

  it.each([
    ['stacked primary at 28%', 0, 168],
    ['stacked secondary at 72%', 441, 159],
    ['terminal-open horizontal pane', 0, 280]
  ])('keeps Emergency and Stop inside the %s pane', (_label, top, height) => {
    // These dimensions are the actual compact CSS track contract:
    // 36px header + 40px Emergency + 1px gap + 75px composer + 3px gap.
    const paneBottom = top + height
    const composer = { top: paneBottom - 3 - 75, bottom: paneBottom - 3 }
    const emergency = { top: composer.top - 1 - 40, bottom: composer.top - 1 }
    const workspaceTop = top + 36

    expect(emergency.top).toBeGreaterThanOrEqual(workspaceTop)
    expect(emergency.bottom).toBeLessThanOrEqual(paneBottom)
    expect(composer.top).toBeGreaterThanOrEqual(workspaceTop)
    expect(composer.bottom).toBeLessThanOrEqual(paneBottom)
  })

  it('fits compact Emergency and Stop/send actions inside the 520x280 terminal-open worst-case pane', () => {
    // At 72%, CSS leaves the smaller pane 520 - (520 * .72) - 9 = 136.6px.
    const paneWidth = 136.6
    const surfaceWidth = paneWidth - 34
    const composerContentWidth = surfaceWidth - 18 // 8px inline padding + 1px border per side
    const compactActionsWidth = 32 + 5 + 32 // Stop + gap + Send; pending status is screen-reader-only
    const compactEmergencyWidth = 14 + 24 + 5 + 30 + 2 // padding + icon + gap + action + borders

    expect(compactActionsWidth).toBeLessThanOrEqual(composerContentWidth)
    expect(compactEmergencyWidth).toBeLessThanOrEqual(surfaceWidth)
    expect(styles).toMatch(/@container chat-pane \(max-width: 220px\) \{[\s\S]*?\.emergency-timeline-dock-copy \{ display: none; \}[\s\S]*?\.emergency-timeline-dock > button \{ width: 30px;/)
  })
})
