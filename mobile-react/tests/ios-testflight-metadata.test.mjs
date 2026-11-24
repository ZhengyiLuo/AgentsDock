import assert from 'node:assert/strict'
import test from 'node:test'
import { assertUnusedBuild, assertOpenVersion, releaseConfig, verifyInternalGroup } from '../scripts/ios-testflight-metadata.mjs'

const app = { expo: { version: '0.1.2', ios: { bundleIdentifier: 'com.zhengyiluo.ZenithDock', buildNumber: '189' } } }
const config = releaseConfig(app)
const versions = [{ id: 'v1', attributes: { version: '0.1.2', platform: 'IOS' } }]
const build = version => ({ attributes: { version }, relationships: { preReleaseVersion: { data: { id: 'v1' } } } })

test('production metadata excludes the development app and invalid versions', () => {
  assert.deepEqual(config, { bundleId: 'com.zhengyiluo.ZenithDock', version: '0.1.2', build: '189' })
  assert.throws(() => releaseConfig({ expo: { ...app.expo, ios: { ...app.expo.ios, bundleIdentifier: 'com.zhengyiluo.ZenithDock.dev' } } }))
  assert.throws(() => releaseConfig({ expo: { ...app.expo, version: '0.1.2-dev' } }))
})

test('new build follows Apple history, not the stale source number', () => {
  assert.doesNotThrow(() => assertUnusedBuild(config, [build('188'), build('187')], versions))
  assert.throws(() => assertUnusedBuild({ ...config, build: '172' }, [build('188')], versions))
  assert.throws(() => assertUnusedBuild(config, [build('189')], versions))
  assert.throws(() => assertUnusedBuild(config, [build('188'), build('190')], versions))
})

test('unexpected version lines, platforms and numbering fail closed', () => {
  assert.throws(() => assertUnusedBuild({ ...config, version: '0.1.1' }, [build('188')], versions))
  assert.throws(() => assertUnusedBuild(config, [build('188')], [{ id: 'v1', attributes: { version: '0.1.2', platform: 'MAC_OS' } }]))
  assert.throws(() => assertUnusedBuild(config, [build('188.1')], versions))
  assert.throws(() => assertUnusedBuild(config, [], versions))
})

test('older iOS marketing versions may use independent timestamp build numbers', () => {
  const older = { ...build('202605151902'), relationships: { preReleaseVersion: { data: { id: 'old' } } } }
  assert.doesNotThrow(() => assertUnusedBuild(config, [build('188'), older], [
    ...versions, { id: 'old', attributes: { version: '0.1.0', platform: 'IOS' } },
  ]))
  assert.throws(() => assertUnusedBuild(config, [build('188'), older], versions))
})

test('a closed App Store version requires a new marketing version before compiling', () => {
  const approved = [{ attributes: { versionString: '0.1.2', appStoreState: 'READY_FOR_SALE' } }]
  assert.throws(() => assertOpenVersion(config, approved))
  assert.doesNotThrow(() => assertOpenVersion({ ...config, version: '0.1.3' }, approved))
  assert.doesNotThrow(() => assertUnusedBuild({ ...config, version: '0.1.3' }, [build('188')], versions))
  assert.throws(() => assertOpenVersion(config, [{ attributes: { versionString: '0.1.2', appStoreState: 'PENDING_DEVELOPER_RELEASE' } }]))
  assert.doesNotThrow(() => assertOpenVersion(config, [{ attributes: { versionString: '0.1.2', appStoreState: 'PREPARE_FOR_SUBMISSION' } }]))
})

function groupFixture() {
  const target = { ...config, version: '0.1.3', build: '190' }
  const responses = {
    '/v1/builds': {
      data: [{
        id: 'exact-build', type: 'builds',
        attributes: { version: '190', processingState: 'VALID', expired: false },
        relationships: {
          preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'version' } },
          buildBetaDetail: { data: { type: 'buildBetaDetails', id: 'beta' } },
        },
      }],
      included: [
        { type: 'preReleaseVersions', id: 'version', attributes: { version: '0.1.3', platform: 'IOS' } },
        { type: 'buildBetaDetails', id: 'beta', attributes: { internalBuildState: 'IN_BETA_TESTING', externalBuildState: 'READY_FOR_BETA_SUBMISSION', autoNotifyEnabled: true } },
      ],
    },
    '/v1/betaGroups': { data: [{
      id: 'existing-internal', attributes: { name: 'Zenith Tester', isInternalGroup: true },
    }] },
    '/v1/betaGroups/existing-internal/builds': { data: [{
      id: 'exact-build', attributes: { version: '190' },
    }] },
  }
  const calls = []
  const request = async (resource, query) => {
    calls.push({ resource, query })
    assert.ok(Object.hasOwn(responses, resource), `Unexpected metadata read: ${resource}`)
    return structuredClone(responses[resource])
  }
  return { target, responses, calls, request }
}

test('internal availability requires exact existing group and exact build ID without querying members', async () => {
  const fixture = groupFixture()
  const report = await verifyInternalGroup(fixture.target, 'app', fixture.request)
  assert.equal(report.verifiedInternalTestingAndGroup, true)
  assert.equal(report.exactBuildAssociated, true)
  assert.equal(report.mutations, false)
  assert.equal(report.testerMembershipQueried, false)
  assert.equal(report.externalBuildState, 'READY_FOR_BETA_SUBMISSION')
  assert.deepEqual(fixture.calls.map(call => call.resource), [
    '/v1/builds', '/v1/betaGroups', '/v1/betaGroups/existing-internal/builds',
  ])
  assert.equal(fixture.calls[0].query['filter[preReleaseVersion.version]'], '0.1.3')
  assert.equal(fixture.calls[0].query['filter[version]'], '190')
})

test('VALID alone, expired builds, another build ID, and another version cannot claim availability', async () => {
  for (const mutate of [
    f => { f.responses['/v1/builds'].data[0].attributes.processingState = 'PROCESSING' },
    f => { f.responses['/v1/builds'].data[0].attributes.expired = true },
    f => { f.responses['/v1/builds'].included[1].attributes.internalBuildState = 'PROCESSING' },
    f => { f.responses['/v1/builds'].included[0].attributes.version = '0.1.2' },
    f => { f.responses['/v1/builds'].included[0].attributes.platform = 'MAC_OS' },
    f => { f.responses['/v1/betaGroups/existing-internal/builds'].data[0].id = 'different-build' },
    f => { f.responses['/v1/betaGroups/existing-internal/builds'].data = [] },
  ]) {
    const fixture = groupFixture()
    mutate(fixture)
    assert.equal((await verifyInternalGroup(fixture.target, 'app', fixture.request)).verifiedInternalTestingAndGroup, false)
  }
})

test('missing, external-only or ambiguous group fails closed without creating or editing a group', async () => {
  for (const mutate of [
    f => { f.responses['/v1/betaGroups'].data = [] },
    f => { f.responses['/v1/betaGroups'].data[0].attributes.isInternalGroup = false },
    f => { f.responses['/v1/betaGroups'].data.push(structuredClone(f.responses['/v1/betaGroups'].data[0])) },
    f => { f.responses['/v1/builds'].data.push(structuredClone(f.responses['/v1/builds'].data[0])) },
  ]) {
    const fixture = groupFixture()
    mutate(fixture)
    await assert.rejects(verifyInternalGroup(fixture.target, 'app', fixture.request))
    assert.ok(fixture.calls.every(call => !/testers|relationships/.test(call.resource)))
  }
})

test('group membership pagination is completed and cannot redirect to another origin or resource', async () => {
  const fixture = groupFixture()
  const next = 'https://api.appstoreconnect.apple.com/v1/betaGroups/existing-internal/builds?cursor=next'
  fixture.responses['/v1/betaGroups/existing-internal/builds'] = { data: [], links: { next } }
  fixture.responses[next] = { data: [{ id: 'exact-build', attributes: { version: '190' } }] }
  assert.equal((await verifyInternalGroup(fixture.target, 'app', fixture.request)).verifiedInternalTestingAndGroup, true)
  assert.equal(fixture.calls.at(-1).resource, next)
  for (const changed of [
    'https://example.invalid/v1/betaGroups/existing-internal/builds?cursor=next',
    'https://api.appstoreconnect.apple.com/v1/betaGroups/another/builds?cursor=next',
    'https://user@api.appstoreconnect.apple.com/v1/betaGroups/existing-internal/builds?cursor=next',
  ]) {
    const invalid = groupFixture()
    invalid.responses['/v1/betaGroups/existing-internal/builds'].links = { next: changed }
    await assert.rejects(verifyInternalGroup(invalid.target, 'app', invalid.request))
    assert.equal(invalid.calls.length, 3)
  }
})
