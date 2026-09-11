import { describe, expect, it } from 'vitest'
import { newestBetaVersionFromAtom } from './updater-feed.mjs'

function atom(...tags: string[]): string {
  return `<feed>${tags.map(tag => `<entry><link href="https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/${tag}" /></entry>`).join('')}</feed>`
}

describe('newestBetaVersionFromAtom', () => {
  it('selects the greatest beta when GitHub lists a stable release first', () => {
    expect(newestBetaVersionFromAtom(atom(
      'v0.2.10',
      'android-v0.1.1-beta.4',
      'v0.2.11-beta.2',
      'v0.2.11-beta.10',
      'v0.2.11-beta.3'
    ))).toBe('0.2.11-beta.10')
  })

  it('compares every numeric SemVer component instead of relying on feed or lexical order', () => {
    expect(newestBetaVersionFromAtom(atom(
      'v2.9.99-beta.999',
      'v2.10.0-beta.1',
      'v10.0.0-beta.1'
    ))).toBe('10.0.0-beta.1')
  })

  it('ignores stable, other-channel, malformed, and unrelated tags', () => {
    expect(newestBetaVersionFromAtom(atom(
      'v0.2.11',
      'v0.2.12-alpha.1',
      'v0.2.12-beta.0',
      'v0.02.12-beta.1',
      'android-v0.2.12-beta.1'
    ))).toBeNull()
  })
})
