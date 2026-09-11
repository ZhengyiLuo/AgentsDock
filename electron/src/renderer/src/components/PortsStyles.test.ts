import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

describe('forwarded ports layout styles', () => {
  it('keeps the ports surface scrollable inside a short terminal dock', () => {
    expect(styles).toMatch(/\.ports-panel \{[^}]*height:\s*100%;[^}]*position:\s*absolute;/s)
    expect(styles).toMatch(/\.ports-panel-scroll \{[^}]*height:\s*100%;[^}]*overflow:\s*auto;/s)
  })

  it('turns wide table rows into a two-column card layout on narrow windows', () => {
    expect(styles).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.ports-row \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/)
    expect(styles).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.ports-row-actions \{[^}]*grid-column:\s*2;[^}]*grid-row:\s*2;/)
  })

  it('keeps ports body and metadata text at a readable minimum size', () => {
    const readableSelectors = [
      '.terminal-port-suggestion > div > span',
      '.ports-panel-title p',
      '.ports-refresh',
      '.ports-unavailable p',
      '.ports-unavailable > div > span',
      '.ports-add-form label',
      '.ports-add-form label small',
      '.ports-forward-button',
      '.ports-error',
      '.ports-section-heading strong',
      '.ports-section-heading span',
      '.ports-detection-copy strong',
      '.ports-detection-copy code',
      '.ports-detection-card .quiet-button',
      '.ports-table-head',
      '.ports-remote code',
      '.ports-local button',
      '.ports-local > span',
      '.ports-status',
      '.ports-row-actions .quiet-button, .ports-stop-button',
      '.ports-row-error',
      '.ports-empty',
      '.ports-empty strong',
      '.ports-empty > div > span',
      '.ports-cell::before'
    ]

    const undersized = readableSelectors
      .map(selector => ({ selector, size: fontPixelSize(selector) }))
      .filter(({ size }) => size < 11)

    expect(undersized).toEqual([])
  })

  it('keeps muted ports metadata at normal-text contrast in the dark theme', () => {
    const contrastPairs = [
      ['.ports-section-heading span', '.ports-panel'],
      ['.ports-table-head', '.ports-table-head'],
      ['.ports-local > span', '.ports-table'],
      ['.ports-empty', '.ports-empty'],
      ['.ports-empty > div > span', '.ports-empty'],
      ['.ports-cell::before', '.ports-table']
    ] as const

    const insufficient = contrastPairs.flatMap(([foregroundSelector, backgroundSelector]) => {
      const foreground = colorDeclaration(foregroundSelector, 'color')
      const background = colorDeclaration(backgroundSelector, 'background')
      const ratio = contrastRatio(foreground, background)
      return ratio < 4.5 ? [{ foregroundSelector, foreground, backgroundSelector, background, ratio }] : []
    })

    expect(insufficient).toEqual([])
  })
})

function ruleBody(selector: string): string {
  return ruleBodies(selector)[0]
}

function ruleBodies(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...styles.matchAll(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)}`, 'gm'))]
  expect(matches.length, `missing CSS rule for ${selector}`).toBeGreaterThan(0)
  return matches.map(match => match[1])
}

function fontPixelSize(selector: string): number {
  const values = ruleBodies(selector).flatMap(body => {
    const explicit = body.match(/font-size:\s*([\d.]+)px/)
    const token = body.match(/font-size:\s*var\((--[\w-]+)\)/)
    const shorthand = body.match(/font:\s*(?:[^;]*?\s)?([\d.]+)px(?:[\/\s])/)
    return explicit?.[1] ?? (token ? resolveFontToken(token[1]) : undefined) ?? shorthand?.[1] ?? []
  })
  const value = values.at(-1)
  expect(value, `missing pixel font size for ${selector}`).toBeDefined()
  return Number(value)
}

function resolveFontToken(property: string, visited = new Set<string>()): string | undefined {
  if (visited.has(property)) throw new Error(`Circular font token: ${property}`)
  visited.add(property)
  const value = styles.match(new RegExp(`${property}:\\s*([^;]+);`))?.[1]
  const pixels = value?.match(/^([\d.]+)px$/)?.[1]
  const alias = value?.match(/^var\((--[\w-]+)\)$/)?.[1]
  return pixels ?? (alias ? resolveFontToken(alias, visited) : undefined)
}

function colorDeclaration(selector: string, property: 'color' | 'background'): string {
  const matches = ruleBodies(selector).flatMap(body => {
    const match = body.match(new RegExp(`(?:^|;)\\s*${property}:\\s*(#[0-9a-f]{6})(?:;|$)`, 'i'))
    return match?.[1] ?? []
  })
  const value = matches.at(-1)
  expect(value, `missing six-digit ${property} for ${selector}`).toBeDefined()
  return value ?? '#000000'
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const [red, green, blue] = channels.map(channel => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ))
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}
