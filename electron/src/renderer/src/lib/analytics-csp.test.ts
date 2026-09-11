import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Regression guard: analytics.ts sends its allow-listed payload directly to
// Mixpanel. The packaged renderer must allow that ingestion endpoint without
// allowing the broader browser-SDK host.
describe('renderer CSP allows Mixpanel analytics', () => {
  const indexHtml = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../index.html'),
    'utf8'
  )
  const connectSrc = indexHtml.match(/connect-src([^;]*);/)?.[1] ?? ''

  it('has a connect-src directive to test against', () => {
    expect(connectSrc).not.toBe('')
  })

  it('allows only the direct Mixpanel ingestion host', () => {
    expect(connectSrc).toContain('https://api.mixpanel.com')
    expect(connectSrc).not.toContain('https://api-js.mixpanel.com')
    expect(connectSrc).not.toContain('agentsdock-media:')
  })
})
