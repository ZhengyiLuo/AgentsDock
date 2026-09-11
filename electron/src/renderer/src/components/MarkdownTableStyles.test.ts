import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/styles.css'),
  'utf8'
)

describe('Markdown table styles', () => {
  it('lets wide tables scroll inside their message without adding a vertical scroll surface', () => {
    expect(styles).toMatch(
      /\.table-scroll \{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s
    )
  })

  it('keeps columns readable instead of squeezing the table to the message width', () => {
    expect(styles).toMatch(
      /\.markdown table \{[^}]*width:\s*max-content;[^}]*min-width:\s*100%;[^}]*max-width:\s*none;/s
    )
    expect(styles).toMatch(
      /\.markdown th, \.markdown td \{[^}]*min-width:\s*7rem;[^}]*max-width:\s*32rem;[^}]*overflow-wrap:\s*break-word;[^}]*word-break:\s*normal;/s
    )
    expect(styles).toMatch(
      /\.markdown th \{[^}]*white-space:\s*nowrap;/s
    )
  })
})
