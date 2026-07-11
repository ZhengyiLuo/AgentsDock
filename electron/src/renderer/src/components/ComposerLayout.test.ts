import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

describe('composer queue layout', () => {
  it('contains long steer prompts inside the conversation column', () => {
    expect(styles).toMatch(/\.queue-shelf \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow: hidden;/s)
    expect(styles).toMatch(/\.queued-row \{[^}]*display: grid;[^}]*grid-template-columns: 26px minmax\(0, 1fr\) auto;[^}]*overflow: hidden;/s)
    expect(styles).toMatch(/\.queue-prompt \{[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;[^}]*-webkit-line-clamp: 3;/s)
    expect(styles).toMatch(/\.inline-editor \{[^}]*max-width: 100%;[^}]*overflow: hidden;/s)
  })
})
