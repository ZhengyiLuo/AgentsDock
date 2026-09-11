import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/WorkspaceEditor.css'),
  'utf8'
)

describe('workspace editor light theme', () => {
  it.each([
    '.workspace-editor-tab-strip',
    '.workspace-editor-content',
    '.workspace-editor-explorer',
    '.workspace-editor-editor-toolbar',
    '.workspace-editor-markdown-preview',
    '.workspace-editor-status-bar',
    '.workspace-editor-palette'
  ])('overrides the dark surface for %s', (selector) => {
    expect(styles).toContain(`:root[data-theme="light"] ${selector}`)
  })

  it('leaves CodeMirror palette changes to its live theme configuration', () => {
    expect(styles).not.toMatch(
      /:root\[data-theme="light"\][^{]*\.workspace-editor-codemirror/
    )
  })

  it('uses app surfaces rather than warm off-white literals for light editor chrome', () => {
    const lightStyles = styles.slice(styles.indexOf(':root[data-theme="light"]'))
    expect(lightStyles).not.toMatch(/#(?:fbfbfa|e5e5e1)\b/i)
    expect(lightStyles).toMatch(
      /\.workspace-editor-content \{[^}]*background:\s*var\(--surface\);/s
    )
    expect(lightStyles).toMatch(
      /\.workspace-editor-image-viewer \{[^}]*linear-gradient\(45deg, var\(--surface-3\)/s
    )
  })

  it('keeps light menu selection distinct from neutral hover and primary save actions accented', () => {
    const lightStyles = styles.slice(styles.indexOf(':root[data-theme="light"]'))
    expect(lightStyles).toMatch(
      /\.workspace-editor-palette-result:focus-visible \{[^}]*background:\s*var\(--interaction-hover\);/s
    )
    expect(lightStyles).toMatch(
      /\.workspace-editor-palette-result-active \{[^}]*background:\s*var\(--surface-3\);/s
    )
    expect(lightStyles).toMatch(
      /\.workspace-editor-confirm-save \{[^}]*background:\s*var\(--accent\);[^}]*border-color:\s*var\(--accent\);/s
    )
  })

  it('preserves usable editor space when a wide explorer preference is restored', () => {
    expect(styles).toMatch(
      /\.workspace-editor-editor-panel \{[^}]*minmax\(160px, min\(var\(--workspace-explorer-width, 232px\), calc\(100% - 245px\)\)\)[^}]*5px[^}]*minmax\(0, 1fr\);/s
    )
  })

  it('allows Markdown preview text to be selected and copied', () => {
    expect(styles).toMatch(
      /\.workspace-editor-markdown-preview \{[^}]*user-select:\s*text;/s
    )
  })

  it('reserves palette layout space for a late workspace alert', () => {
    expect(styles).toMatch(
      /\.workspace-editor-palette-with-alert \{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto auto auto minmax\(0, 1fr\);/s
    )
    expect(styles).toMatch(
      /\.workspace-editor-palette-with-alert > \.workspace-editor-workspace-error \{[^}]*position:\s*static;[^}]*transform:\s*none;/s
    )
  })
})
