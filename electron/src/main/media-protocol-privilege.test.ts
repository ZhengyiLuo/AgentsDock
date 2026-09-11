import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('private media protocol privileges', () => {
  it('supports secure streaming media without exposing the renderer Fetch API or CORS', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const registration = source.slice(
      source.indexOf('protocol.registerSchemesAsPrivileged(['),
      source.indexOf('])', source.indexOf('protocol.registerSchemesAsPrivileged([')) + 2
    )

    expect(registration).toContain("scheme: 'agentsdock-media'")
    expect(registration).toContain('standard: true')
    expect(registration).toContain('secure: true')
    expect(registration).toContain('stream: true')
    expect(registration).not.toContain('supportFetchAPI')
    expect(registration).not.toContain('corsEnabled')
    expect(registration).not.toContain('bypassCSP')
  })
})
