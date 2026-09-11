import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

describe('routed message link editing styles', () => {
  it('does not swap a readable preview for raw Markdown when the editor is focused', () => {
    expect(styles).not.toContain('.composer-message-preview')
    expect(styles).not.toContain(':has(> textarea:focus)')
    expect(styles).toMatch(/\.composer-editor > textarea \{[^}]*caret-color:[^}]*background: transparent;/s)
  })

  it('raises only the projected link decorations without stealing ordinary input', () => {
    expect(styles).toMatch(/\.composer-editor-mirror \{[^}]*pointer-events: none;/s)
    expect(styles).toContain(':root .composer-editor.has-message-links > .composer-editor-mirror { z-index: 2; color: var(--text); }')
    expect(styles).toContain('.composer-editor.has-message-links:has(> .composer-editor-mirror[data-composer-mirror-aligned="true"]) > textarea { -webkit-text-fill-color: transparent; }')
    expect(styles).toContain(':root .composer-editor.has-message-links > .composer-editor-mirror .composer-inline-reference { color: var(--text); }')
    expect(styles).toMatch(/\.composer-editor-mirror \.composer-inline-message-link \{[^}]*padding: 0; margin: 0;[^}]*font: inherit; letter-spacing: inherit;[^}]*pointer-events: auto;/s)
    expect(styles).toContain(':root[data-theme="light"] .composer-editor-mirror .composer-inline-message-link')
  })
})
