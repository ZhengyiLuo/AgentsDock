import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
const imageRule = /(?:^|\n)\.markdown img\s*\{([^}]+)\}/.exec(styles)?.[1] ?? ''

describe('Markdown image sizing', () => {
  it('bounds images to their containing content, including lists and quotes', () => {
    expect(imageRule).toMatch(/(?:^|;)\s*max-width:\s*100%\s*;/)
  })

  it('preserves the image aspect ratio, including authored HTML dimensions', () => {
    expect(imageRule).toMatch(/(?:^|;)\s*height:\s*auto\s*;/)
  })

  it('does not stretch small inline images or crop large ones', () => {
    expect(imageRule).not.toBe('')
    expect(imageRule).not.toMatch(/(?:^|;)\s*(?:width|min-width|overflow|object-fit)\s*:/)
  })
})
