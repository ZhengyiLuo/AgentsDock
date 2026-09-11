import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const composer = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/Composer.tsx'),
  'utf8'
)
const workingDirectoryPopover = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/WorkingDirectoryPopover.tsx'),
  'utf8'
)
const codexControls = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/CodexControls.tsx'),
  'utf8'
)
const app = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.tsx'),
  'utf8'
)
const chatPane = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/ChatPane.tsx'),
  'utf8'
)
const styles = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/styles.css'),
  'utf8'
)
const codexStyles = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/CodexControls.css'),
  'utf8'
)

describe('composer context layout', () => {
  it('places a persistent goal below the folder chip and above the composer', () => {
    const contextRow = composer.indexOf('<div className="composer-context-row">')
    const goal = composer.indexOf('<CodexGoalBar />', contextRow)
    const messageComposer = composer.indexOf('<div className={`composer ${dropActive', goal)

    expect(contextRow).toBeGreaterThan(-1)
    expect(goal).toBeGreaterThan(contextRow)
    expect(messageComposer).toBeGreaterThan(goal)
  })

  it('keeps the goal out of the scrollable shelf in single and split chat views', () => {
    expect(app).not.toContain('<CodexGoalBar')
    expect(chatPane).not.toContain('<CodexGoalBar')
  })

  it('reserves vertical space for both rows instead of overlapping them', () => {
    expect(styles).toMatch(
      /\.composer-context-row \{[^}]*position: relative;[^}]*min-height: 26px;[^}]*margin: 0 auto 4px;[^}]*\}/s
    )
    expect(codexStyles).toMatch(
      /\.codex-goal-bar \{[^}]*margin: 0 auto 4px;[^}]*\}/s
    )
  })

  it('uses the same rounded surface and typography for the folder and goal controls', () => {
    expect(workingDirectoryPopover).toContain('className="composer-context-control cwd-pill"')
    expect(codexControls).toContain('className={`composer-context-control codex-goal-bar')
    expect(styles).toMatch(
      /\.composer-context-control \{[^}]*height: 26px;[^}]*background: var\(--surface-2\);[^}]*border: 1px solid var\(--border\);[^}]*border-radius: var\(--radius-control\);[^}]*font-family: inherit;[^}]*font-size: var\(--text-size-meta\);[^}]*font-weight: var\(--text-weight-body\);[^}]*\}/s
    )
    expect(codexStyles).toMatch(/\.codex-goal-bar-main > strong \{[^}]*font: inherit;/s)
    expect(codexStyles).toMatch(/\.codex-goal-objective \{[^}]*font: inherit;/s)
    expect(codexStyles).toMatch(/\.codex-goal-bar-main > time \{[^}]*font: inherit;/s)
    expect(codexStyles).toMatch(
      /\.codex-goal-bar\.expanded,\s*\.codex-goal-bar\.error \{ height: auto; border-radius: var\(--radius-dialog\); \}/
    )
    expect(codexStyles).toMatch(
      /\.codex-goal-bar-main \{[^}]*height: 24px;[^}]*min-height: 24px;[^}]*gap: 5px;[^}]*padding: 0 4px 0 10px;[^}]*\}/s
    )
    expect(styles.match(/\.composer-context-row \{([^}]*)\}/)?.[1]).not.toContain('padding:')
    expect(codexStyles).toMatch(/\.codex-goal-bar-main > button \{[^}]*width: 24px;[^}]*height: 24px;/s)
    expect(codexStyles).toMatch(/\.codex-goal-bar-main > button:focus-visible \{[^}]*box-shadow: inset 0 0 0 2px/s)
    expect(codexStyles).toMatch(
      /@container chat-pane \(max-width: 340px\) \{[^}]*\.codex-goal-bar-main \{[^}]*gap: 3px;[^}]*\}/s
    )
  })
})
