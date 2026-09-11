import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/styles.css'),
  'utf8'
)
const app = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.tsx'),
  'utf8'
)

describe('app overlay interaction styles', () => {
  it('keeps the update notice clickable over the draggable chat header', () => {
    expect(styles).toMatch(
      /\.top-right-notice-stack \{[^}]*position:\s*fixed;[^}]*right:\s*18px;[^}]*top:\s*50px;[^}]*overflow-y:\s*auto;[^}]*pointer-events:\s*none;/s
    )
    expect(styles).toMatch(
      /\.update-toast \{[^}]*pointer-events:\s*auto;[^}]*-webkit-app-region:\s*no-drag;/s
    )
    expect(styles).toMatch(
      /\.update-toast \.primary-button,\s*\.update-toast \.icon-button \{[^}]*-webkit-app-region:\s*no-drag;/s
    )
  })

  it('stacks the transient emergency notice above the update notice without replacing timeline acknowledgement', () => {
    expect(app).toMatch(
      /<div className="top-right-notice-stack">\s*<EmergencyNotice \/>\s*<UpdateNotice \/>\s*<\/div>/s
    )
    expect(styles).toMatch(
      /\.emergency-toast \{[^}]*pointer-events:\s*auto;[^}]*-webkit-app-region:\s*no-drag;/s
    )
    expect(styles).toMatch(
      /\.emergency-toast \.primary-button,\s*\.emergency-toast \.icon-button \{[^}]*-webkit-app-region:\s*no-drag;/s
    )
  })

  it('covers the split chat layout with a theme-aware transient file workspace', () => {
    expect(styles).toMatch(
      /\.split-workspace-overlay \{[^}]*position:\s*absolute;[^}]*z-index:\s*90;[^}]*inset:\s*0;[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s
    )
    expect(styles).toMatch(
      /:root\[data-theme="light"\] \.split-workspace-overlay,[\s\S]*?background:\s*var\(--surface\);/
    )
  })
})
