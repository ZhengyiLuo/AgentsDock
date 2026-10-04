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
const goalStyles = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/GoalDialog.css'),
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
    expect(goalStyles).toMatch(
      /\.goal-summary-bar \{[^}]*margin: 0 auto var\(--space-3\);[^}]*\}/s
    )
  })

  it('uses one goal surface for both providers with theme tokens, readable labels and keyboard focus', () => {
    const claude = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/ClaudeGoalControls.tsx'), 'utf8')
    expect(workingDirectoryPopover).toContain('className="composer-context-control cwd-pill"')
    expect(codexControls).toContain('<GoalSummaryBar')
    expect(claude).toContain('<GoalSummaryBar')
    expect(codexControls).toContain('<GoalProgress')
    expect(claude).toContain('<GoalProgress')
    expect(goalStyles).toMatch(/\.goal-summary-bar \{[^}]*border: 1px solid var\(--border\);[^}]*border-radius: var\(--radius-control\);[^}]*background: var\(--surface\);/s)
    expect(goalStyles).toMatch(/\.goal-summary-condition \{[^}]*font-size: var\(--text-size-label\);/s)
    expect(goalStyles).toMatch(/\.goal-summary-meta \{[^}]*font-size: var\(--text-size-meta\);/s)
    expect(goalStyles).toMatch(/\.goal-summary:focus-visible \{[^}]*outline: 2px solid var\(--accent\);/s)
    expect(goalStyles).toMatch(/@container chat-pane \(max-width: 540px\) \{[^}]*\.goal-summary-bar \{ flex-wrap: wrap; \}/s)
    expect(goalStyles).toMatch(/\.goal-summary-actions \{[^}]*flex-wrap: wrap;[^}]*max-width: 100%;/s)
  })
})
