import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

describe('emergency alert styles', () => {
  it('gives emergency rows persistent red priority and a composited flashing treatment', () => {
    const actionNeededIndex = styles.indexOf('.session-row.action-needed {')
    const emergencyIndex = styles.indexOf('.session-row.emergency {')

    expect(actionNeededIndex).toBeGreaterThanOrEqual(0)
    expect(emergencyIndex).toBeGreaterThan(actionNeededIndex)
    expect(styles).toMatch(
      /\.session-row\.emergency \{[^}]*background:[^;}]*var\(--danger\)[^;}]*;[^}]*border:[^;}]*var\(--danger\)[^;}]*;[^}]*box-shadow:\s*inset\s+3px\s+0\s+0\s+var\(--danger\),[^}]*;/s
    )
    const emergencyBlock = styles.slice(emergencyIndex, styles.indexOf('}', emergencyIndex) + 1)
    expect(emergencyBlock).not.toContain('animation:')
    expect(styles).toMatch(
      /\.status-dot\.emergency \{[^}]*will-change:\s*opacity,\s*transform;[^}]*animation:\s*emergency-chat-pulse\s+1\.6s\s+ease-in-out\s+infinite;/s
    )
    const pulse = styles.match(/@keyframes\s+emergency-chat-pulse\s*\{[^}]*50%\s*\{[^}]*opacity:\s*\.48;[^}]*transform:\s*scale\(\.78\);[^}]*\}\s*\}/s)?.[0]
    expect(pulse).toBeTruthy()
    expect(pulse).not.toContain('box-shadow')
    expect(styles).not.toContain('.session-row.emergency::before')
    expect(styles).not.toContain('.session-row.emergency::after')
    expect(styles).toMatch(/\.status-dot\.emergency \{[^}]*background:\s*#ff625d;[^}]*box-shadow:/s)
  })

  it('stops flashing for reduced motion while preserving a durable danger marker', () => {
    expect(styles).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.status-dot\.emergency\s*\{[^}]*animation:\s*none;[^}]*opacity:\s*1;[^}]*transform:\s*none;/
    )
  })

  it('keeps acknowledgement in the inline emergency card instead of a header banner', () => {
    expect(styles).toContain('.emergency-event-actions {')
    expect(styles).toMatch(/\.emergency-event-actions\s*>\s*button\s*\{[^}]*background:\s*#b83b37;/s)
    expect(styles).not.toContain('.emergency-banner')
    expect(styles).not.toContain('.chat-header.emergency-active')
  })

  it('keeps the persistent emergency dock in workspace flow above the composer', () => {
    expect(styles).toMatch(
      /\.emergency-timeline-dock \{[^}]*width:\s*calc\(100% - 34px\);[^}]*display:\s*grid;[^}]*margin:\s*0 auto 8px;/s
    )
    expect(styles).not.toMatch(/\.emergency-timeline-dock \{[^}]*(?:position:\s*(?:fixed|absolute)|(?:^|[;{])\s*(?:inset|bottom):)/s)
  })
})
