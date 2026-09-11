import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/styles.css'),
  'utf8'
)

describe('composer command palette styles', () => {
  it('keeps the command list above the composer and bounded inside split panes', () => {
    expect(styles).toMatch(
      /\.composer-command-palette \{[^}]*max-height: min\(360px, 42vh\);[^}]*position: absolute;[^}]*bottom: calc\(100% \+ 7px\);[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/s
    )
    expect(styles).toMatch(
      /\.chat-split-view\.stacked \.composer-command-palette \{ max-height: min\(180px, 16vh\); \}/
    )
  })

  it('uses clear keyboard selection and light-theme treatments', () => {
    expect(styles).toMatch(
      /\.composer-command-option \{[^}]*display: grid;[^}]*grid-template-columns: 30px minmax\(0, 1fr\) auto;[^}]*border: 1px solid transparent;/s
    )
    expect(styles).toMatch(
      /\.composer-command-option:hover \{[^}]*background: var\(--interaction-hover\);/s
    )
    expect(styles).toMatch(
      /\.composer-command-option\.selected \{[^}]*background: var\(--interaction-pressed\);/s
    )
    expect(styles).toMatch(
      /:root\[data-theme="light"\] \.composer-command-palette \{[^}]*background: #fffffff5;[^}]*border-color: var\(--control-border\);/s
    )
  })

  it('lets the focused working-directory dialog show its completion list', () => {
    expect(styles).toMatch(
      /\.working-directory-command-dialog \{[^}]*width: min\(560px, calc\(100vw - 40px\)\);[^}]*overflow: visible;/s
    )
    expect(styles).toMatch(
      /\.working-directory-command-dialog \.working-directory-results \{ max-height: min\(300px, 38vh\); \}/
    )
  })
})
