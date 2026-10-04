import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/styles.css'),
  'utf8'
)

function declarations(selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = styles.indexOf('}', start)
  expect(end).toBeGreaterThan(start)
  return styles.slice(start, end)
}

describe('inspector media card styles', () => {
  it('wraps crowded media actions without overlapping file metadata', () => {
    const card = declarations('.inspector-media-grid article')
    const thumbnail = declarations('.inspector-thumb')
    const title = declarations('.inspector-media-grid article > strong')
    const actions = declarations('.inspector-media-grid article > div')
    const actionButton = declarations('.inspector-media-grid article > div button')

    expect(card).toMatch(/display:\s*flex;/)
    expect(card).toMatch(/flex-wrap:\s*wrap;/)
    expect(thumbnail).toMatch(/flex:\s*0 0 100%;/)
    expect(title).toMatch(/flex:\s*0 0 100%;/)
    expect(actions).toMatch(/max-width:\s*100%;/)
    expect(actions).toMatch(/flex-wrap:\s*wrap;/)
    expect(actions).toMatch(/justify-content:\s*flex-end;/)
    expect(actions).not.toMatch(/position:\s*absolute;/)
    expect(actionButton).toMatch(/flex:\s*0 0 20px;/)
  })
})
