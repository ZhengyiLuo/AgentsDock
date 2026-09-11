import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = resolve(process.cwd(), 'src/renderer/src')

// These variables represent live layout state supplied by WorkspaceEditor.tsx
// or Radix. They are not design tokens and intentionally have no global value.
const runtimeCustomProperties = new Set([
  '--workspace-editor-width',
  '--workspace-explorer-width',
  '--workspace-markdown-source-percent',
  '--radix-dropdown-menu-content-transform-origin'
])

const designSystemCustomProperties = [
  '--font-ui',
  '--font-mono',
  '--text-size-caption',
  '--text-size-meta',
  '--text-size-label',
  '--text-size-ui',
  '--text-size-title',
  '--text-size-heading',
  '--text-weight-body',
  '--text-weight-label',
  '--text-weight-title',
  '--text-weight-emphasis',
  '--interaction-hover',
  '--interaction-pressed',
  '--motion-control',
  '--font-size-xs',
  '--font-size-sm',
  '--font-size-md',
  '--font-size-lg',
  '--font-size-xl',
  '--font-size-2xl',
  '--font-size-3xl',
  '--font-size-display',
  '--font-weight-regular',
  '--font-weight-medium',
  '--font-weight-semibold',
  '--font-weight-strong',
  '--font-weight-bold',
  '--line-height-tight',
  '--line-height-ui',
  '--line-height-body',
  '--line-height-relaxed',
  '--space-1',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-7',
  '--space-8',
  '--radius-compact',
  '--radius-icon',
  '--radius-control',
  '--radius-selection',
  '--radius-popover',
  '--radius-dialog',
  '--radius-dialog-large',
  '--radius-circle',
  '--radius-pill',
  '--control-height-sm',
  '--control-height-md',
  '--control-height-lg',
  '--shadow-tooltip',
  '--shadow-popover',
  '--shadow-dialog',
  '--shadow-dialog-large'
] as const

const styleSheets = cssFiles(rendererRoot)
const sources = styleSheets.map(file => ({
  file,
  source: withoutComments(readFileSync(file, 'utf8'))
}))
const declarations = new Set(
  sources.flatMap(({ source }) => (
    [...source.matchAll(/(?:^|[;{])\s*(--[\w-]+)\s*:/gm)].map(match => match[1])
  ))
)

describe('renderer CSS custom properties', () => {
  it('defines the design-system foundation', () => {
    expect(designSystemCustomProperties.filter(property => !declarations.has(property))).toEqual([])
  })

  it('keeps inline source badges subordinate and job output outside the UI type scale', () => {
    const shell = sources.find(({ file }) => file === join(rendererRoot, 'styles.css'))?.source ?? ''
    expect(shell).toMatch(/\.command-results strong em \{[^}]*font-size: var\(--text-size-caption\);/)
    expect(shell).toMatch(/\.job-history-run-body > pre \{ font-size: 10px; \}/)
  })

  it('does not reference undefined custom properties', () => {
    const missing = new Map<string, string[]>()

    for (const { file, source } of sources) {
      for (const match of source.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const property = match[1]
        if (declarations.has(property) || runtimeCustomProperties.has(property)) continue

        const line = source.slice(0, match.index).split('\n').length
        const locations = missing.get(property) ?? []
        locations.push(`${relative(rendererRoot, file)}:${line}`)
        missing.set(property, locations)
      }
    }

    expect(
      [...missing].map(([property, locations]) => `${property}: ${locations.join(', ')}`)
    ).toEqual([])
  })
})

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return cssFiles(path)
      return entry.isFile() && entry.name.endsWith('.css') ? [path] : []
    })
    .sort()
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
}
