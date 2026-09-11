import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
const lightRoot = ':root[data-theme="light"]'

// Inspect only the server surfaces that previously kept dark backgrounds in light
// mode. Grouping, whitespace, unrelated rules, and the dark palette may change.
function lightDeclarations(selector: string): Record<string, string> {
  const declarations: Record<string, string> = {}
  const target = `${lightRoot} ${selector}`
  for (const [, selectorGroup, body] of styles.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = selectorGroup.split(/,\s*(?=:root\[)/).map(value => value.trim().replace(/\s+/g, ' '))
    if (!selectors.includes(target)) continue
    for (const [, property, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+)(?:;|$)/g)) {
      declarations[property] = value.trim()
    }
  }
  return declarations
}

function expectAdaptiveColor(value: string | undefined): void {
  expect(value).toBeDefined()
  expect(value).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i)
  expect(value === 'transparent' || value === 'none' || /var\(--[\w-]+\)/.test(value ?? '')).toBe(true)
}

describe('light server management and Team Network surfaces', () => {
  it.each([
    '.server-management',
    '.server-management-editor',
    '.server-setup-guide',
    '.server-setup-progress',
    '.server-setup-fields input'
  ])('retains an explicit light background for existing %s', selector => {
    // Existing light neutrals such as #fafafa remain valid; this test does not
    // require rewriting the established Settings palette.
    expect(lightDeclarations(selector).background).toBeDefined()
  })

  it.each([
    '.team-network-body',
    '.team-network-nav',
    '.team-network-nav > button.active',
    '.team-network-nav-footer',
    '.team-network-nav-server-icon',
    '.network-surface',
    '.network-people-directory article',
    '.network-add-person-help',
    '.network-people-directory .network-mail-bundle-icon',
    '.network-invite-sheet',
    '.network-server-identity',
    '.network-server-icon',
    '.network-server-identity b',
    '.network-connect-form',
    '.network-connect-form input',
    '.network-connection-state.is-connected',
    '.network-connection-state.needs-attention',
    '.network-binding-forget-confirm',
    '.network-roster-server > .network-server-remove-confirm',
    '.secure-peer-panel',
    '.secure-peer-host-card',
    '.secure-peer-pairing-card',
    '.secure-peer-pairing-card.danger',
    '.network-connect-panel .secure-peer-pairing-card',
    '.network-connect-panel .secure-peer-pairing-card.danger',
    '.secure-peer-destructive-confirm',
    '.secure-peer-sas b'
  ])('uses a theme-derived light background for %s', selector => {
    const declarations = lightDeclarations(selector)
    expectAdaptiveColor(declarations.background ?? declarations['background-color'])
    for (const [property, value] of Object.entries(declarations)) {
      if (property === 'color' || /^border(?:-(?:top|right|bottom|left))?(?:-color)?$/.test(property)) {
        expectAdaptiveColor(value)
      }
    }
  })

  it.each([
    '.team-network-nav-server-icon',
    '.network-server-icon',
    '.network-server-identity b',
    '.secure-peer-host-card code',
    '.secure-peer-pairing-card code',
    '.secure-peer-destructive-confirm span',
    '.secure-peer-sas b',
    '.secure-peer-sas-confirm'
  ])('replaces dark-palette foregrounds on %s in light mode', selector => {
    expectAdaptiveColor(lightDeclarations(selector).color)
  })

  it('overrides the existing important SAS confirmation color', () => {
    expect(lightDeclarations('.secure-peer-sas-confirm').color).toMatch(/!important$/)
  })

  it.each([
    '.network-people-directory',
    '.network-admin-row > .network-admin-confirm'
  ])('uses a light divider in server administration %s', selector => {
    const declarations = lightDeclarations(selector)
    expectAdaptiveColor(declarations['border-top-color'] ?? declarations['border-color'] ?? declarations['border-top'])
  })
})
