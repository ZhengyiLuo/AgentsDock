import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/styles.css'),
  'utf8'
)

describe('sidebar action layout styles', () => {
  it('wraps narrow action controls onto a second row instead of clipping them', () => {
    expect(styles).toMatch(
      /\.sidebar-actions \{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*5px;/s
    )
  })

  it('matches the chat-count label to the folder-heading typography', () => {
    expect(styles).toMatch(
      /\.sidebar-project-label \{[^}]*font-size:\s*var\(--text-size-meta\);[^}]*font-weight:\s*var\(--text-weight-label\);[^}]*line-height:\s*16px;/s
    )
  })

  it('keeps sorting next to the count and separates pins with space and a quiet solid line', () => {
    expect(styles).toMatch(/\.sidebar-project-heading \{[^}]*display:\s*flex;[^}]*gap:\s*var\(--space-2\);/s)
    expect(styles).toMatch(/\.sidebar-project-label \{[^}]*flex:\s*0 1 auto;/s)
    expect(styles).toMatch(/\.sidebar-section\[data-section-id="pinned"\] \{[^}]*margin-bottom:\s*var\(--space-6\);/s)
    expect(styles).toMatch(/\.sidebar-section\[data-section-id="pinned"\] \+ \.sidebar-section \{[^}]*padding-top:\s*var\(--space-6\);[^}]*border-top:\s*1px solid var\(--border\);/s)
  })

  it('keeps the chat search popup centered in the app window', () => {
    expect(styles).toMatch(
      /\.form-dialog \{[^}]*max-height:\s*calc\(100vh - 70px\);[^}]*top:\s*50%;[^}]*left:\s*50%;[^}]*transform:\s*translate\(-50%, -50%\);/s
    )
    expect(styles).not.toMatch(/\.command-dialog \{[^}]*top:/s)
  })

  it('shows compact regular-weight sort feedback in shared semantic green without overlapping other actions', () => {
    expect(styles).toMatch(/\.sidebar-sort-feedback \{[^}]*min-width:\s*0;[^}]*flex:\s*0 1 auto;[^}]*overflow:\s*hidden;[^}]*color:\s*var\(--green\);[^}]*font-size:\s*var\(--text-size-caption\);[^}]*font-weight:\s*var\(--text-weight-body\);[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s)
  })

  it('removes the pointer focus halo only from the sort control and retains the shared keyboard focus rule', () => {
    expect(styles).toMatch(/\.sidebar-sort-trigger\[data-pointer-focus="true"\]:focus \{[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/s)
    expect(styles).toMatch(/button:focus-visible[^}]*outline:\s*2px solid/)
  })
})
