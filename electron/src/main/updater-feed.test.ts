import { describe, expect, it } from 'vitest'
import { newestBetaVersionFromAtom, newestCompatibleReleaseFromAtom } from './updater-feed.mjs'

function atom(...tags: string[]): string {
  return `<feed>${tags.map(tag => `<entry><link href="https://github.com/ZhengyiLuo/AgentsDock/releases/tag/${tag}" /></entry>`).join('')}</feed>`
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

describe('newestCompatibleReleaseFromAtom', () => {
  it('selects the migration bridge ahead of the old stable and beta releases', () => {
    expect(newestCompatibleReleaseFromAtom(atom('v0.2.12', 'v0.2.13-beta.33', 'v1.0.0-beta.1')))
      .toEqual({ version: '1.0.0-beta.1', track: 'beta' })
  })

  it('promotes Beta users to stable without requiring a track change', () => {
    expect(newestCompatibleReleaseFromAtom(atom('v1.0.0-beta.2', 'v1.0.0', 'v1.0.0-beta.100')))
      .toEqual({ version: '1.0.0', track: 'stable' })
  })

  it('continues offering newer-core betas after stable promotion', () => {
    expect(newestCompatibleReleaseFromAtom(atom('v1.0.0', 'v1.1.0-beta.2', 'v1.1.0-beta.10')))
      .toEqual({ version: '1.1.0-beta.10', track: 'beta' })
  })

  it('does not mistake recently edited old releases for the latest version', () => {
    expect(newestCompatibleReleaseFromAtom(atom('v0.2.12', 'v10.0.0-beta.1', 'v2.10.0', 'v2.9.99')))
      .toEqual({ version: '10.0.0-beta.1', track: 'beta' })
  })

  it('handles stable-only feeds and duplicate release links', () => {
    expect(newestCompatibleReleaseFromAtom(atom('v1.0.0', 'v1.0.0', 'v0.2.12')))
      .toEqual({ version: '1.0.0', track: 'stable' })
  })

  it('ignores unsupported channels, unrelated assets, and malformed versions', () => {
    expect(newestCompatibleReleaseFromAtom(atom(
      'v1.0.0-rc.1', 'android-v1.0.0', 'v01.0.0', 'v1.0.0-beta.0', 'v1.0.0+build.1', 'v1.0'
    ))).toBeNull()
    expect(newestCompatibleReleaseFromAtom('<html>GitHub is unavailable</html>')).toBeNull()
    expect(newestCompatibleReleaseFromAtom('<feed><entry><link href="unterminated')).toBeNull()
  })

  it('compares identifiers without loss of integer precision', () => {
    expect(newestCompatibleReleaseFromAtom(atom('v1.0.0-beta.9007199254740993', 'v1.0.0-beta.9007199254740992')))
      .toEqual({ version: '1.0.0-beta.9007199254740993', track: 'beta' })
  })
})
