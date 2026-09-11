import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

describe('Team Network layout styles', () => {
  it('lets each full-height surface scroll without growing the workspace', () => {
    expect(styles).toMatch(/\.conversation-pane\.teamspace-pane \{[^}]*grid-template-rows:\s*minmax\(0, 1fr\);[^}]*overflow:\s*hidden;/s)
    expect(styles).toMatch(/\.team-network-content \{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s)
    expect(styles).toMatch(/\.network-surface \{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*grid-template-rows:\s*80px minmax\(0, 1fr\) auto;/s)
    expect(styles).toMatch(/\.network-scroll-region \{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s)
  })

  it('keeps the Mail Board grid and opened bundle inside the available height', () => {
    expect(styles).toMatch(/\.network-mailbox \{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s)
    expect(styles).toMatch(/\.network-mail-board-grid \{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(230px, 1fr\)\);/s)
    expect(styles).toMatch(/\.network-mail-bundle-detail \{[^}]*min-height:\s*0;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s)
  })

  it('uses compact navigation and a one-column Mail Board on narrow windows', () => {
    expect(styles).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.team-network-body \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/)
    expect(styles).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.network-mailbox-switcher \{[^}]*grid-column:\s*1 \/ -1;/)
    expect(styles).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.network-mail-board-grid \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/)
  })
})
