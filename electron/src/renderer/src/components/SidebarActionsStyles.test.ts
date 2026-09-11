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

  it('keeps the chat search popup centered in the app window', () => {
    expect(styles).toMatch(
      /\.form-dialog \{[^}]*max-height:\s*calc\(100vh - 70px\);[^}]*top:\s*50%;[^}]*left:\s*50%;[^}]*transform:\s*translate\(-50%, -50%\);/s
    )
    expect(styles).not.toMatch(/\.command-dialog \{[^}]*top:/s)
  })
})
