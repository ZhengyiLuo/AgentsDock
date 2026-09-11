import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateElectronReleaseVersion } from '../validate_electron_release_version.mjs'

const published = (...tags) => tags.map(tag_name => ({ tag_name, draft: false }))

describe('validateElectronReleaseVersion', () => {
  it('rejects a beta from a release line that is already stable', () => {
    assert.throws(
      () => validateElectronReleaseVersion('0.2.10-beta.13', 'beta', published('v0.2.10', 'v0.2.10-beta.12')),
      /must be greater than public AgentsDock 0\.2\.10/
    )
  })

  it('accepts the first beta on the next release line', () => {
    assert.deepEqual(
      validateElectronReleaseVersion('0.2.11-beta.1', 'beta', [
        ...published('v0.2.10', 'v0.2.10-beta.13', 'android-v0.1.1-beta.4'),
        { tag_name: 'v9.0.0', draft: true }
      ]),
      { candidate: '0.2.11-beta.1', latestStable: '0.2.10', latestPublic: '0.2.10' }
    )
  })

  it('requires later betas to advance beyond every public beta', () => {
    const releases = published('v0.2.10', 'v0.2.11-beta.10')
    assert.throws(
      () => validateElectronReleaseVersion('0.2.11-beta.9', 'beta', releases),
      /must be greater than public AgentsDock 0\.2\.11-beta\.10/
    )
    assert.equal(validateElectronReleaseVersion('0.2.11-beta.11', 'beta', releases).candidate, '0.2.11-beta.11')
  })

  it('accepts stable promotion because stable outranks its prereleases', () => {
    const result = validateElectronReleaseVersion(
      '0.2.11',
      'stable',
      published('v0.2.10', 'v0.2.11-beta.99')
    )
    assert.deepEqual(result, {
      candidate: '0.2.11',
      latestStable: '0.2.10',
      latestPublic: '0.2.11-beta.99'
    })
  })

  it('enforces canonical track-specific version forms', () => {
    assert.throws(() => validateElectronReleaseVersion('v0.2.11-beta.1', 'beta', []), /Beta versions/)
    assert.throws(() => validateElectronReleaseVersion('0.2.11-beta.1', 'stable', []), /Stable versions/)
    assert.throws(() => validateElectronReleaseVersion('0.2.11-beta.0', 'beta', []), /Beta versions/)
  })
})
