import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { normalizeAndroidReleaseManifest, LEGACY_SCHEME, ANDROID_SCHEME } = require('../plugins/withAndroidReleaseManifest.cjs')

test('Android manifest normalization is scoped and idempotent, with optional camera hardware', () => {
  const manifest = { manifest: {
    'uses-permission': [{ $: { 'android:name': 'android.permission.CAMERA' } }],
    'uses-feature': [{ $: { 'android:name': 'android.hardware.nfc', 'android:required': 'true' } }],
    application: [{ $: { 'android:name': '.MainApplication' }, activity: [{ 'intent-filter': [{
      action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
      data: [{ $: { 'android:scheme': LEGACY_SCHEME } }, { $: { 'android:scheme': 'other-provider' } }],
    }] }] }],
  } }
  normalizeAndroidReleaseManifest(manifest)
  const once = structuredClone(manifest)
  normalizeAndroidReleaseManifest(manifest)
  assert.deepEqual(manifest, once)
  const data = manifest.manifest.application[0].activity[0]['intent-filter'][0].data
  assert.deepEqual(data.map(item => item.$['android:scheme']), [ANDROID_SCHEME, 'other-provider'])
  assert.deepEqual(manifest.manifest['uses-permission'], [{ $: { 'android:name': 'android.permission.CAMERA' } }])
  assert.deepEqual(manifest.manifest['uses-feature'], [
    { $: { 'android:name': 'android.hardware.nfc', 'android:required': 'true' } },
    { $: { 'android:name': 'android.hardware.camera', 'android:required': 'false' } },
  ])
})

test('an existing camera feature becomes optional without losing its metadata', () => {
  const manifest = { manifest: { 'uses-feature': [{ $: {
    'android:name': 'android.hardware.camera', 'android:required': 'true', 'android:version': '1',
  } }] } }
  normalizeAndroidReleaseManifest(manifest)
  assert.deepEqual(manifest.manifest['uses-feature'], [{ $: {
    'android:name': 'android.hardware.camera', 'android:required': 'false', 'android:version': '1',
  } }])
})

test('composed Expo manifest applies normalization after default schemes without changing iOS', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const generated = JSON.parse(execFileSync(process.execPath, ['node_modules/expo/bin/cli', 'config', '--type', 'introspect', '--json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
    env: { ...process.env, AGENTSDOCK_APP_VARIANT: 'production' },
  }))
  const manifest = generated._internal.modResults.android.manifest.manifest
  const schemes = manifest.application.flatMap(application => application.activity ?? [])
    .flatMap(activity => activity['intent-filter'] ?? []).flatMap(filter => filter.data ?? [])
    .map(data => data.$['android:scheme']).filter(Boolean)
  assert.ok(schemes.includes(ANDROID_SCHEME))
  assert.ok(!schemes.includes(LEGACY_SCHEME), 'Expo default Scheme plugin must not reintroduce the mixed-case Android scheme')
  assert.equal(manifest['uses-feature'].find(feature => feature.$['android:name'] === 'android.hardware.camera').$['android:required'], 'false')
  assert.notEqual(manifest['uses-permission'].find(permission => permission.$['android:name'] === 'android.permission.CAMERA').$['tools:node'], 'remove')
  assert.equal(generated.scheme, LEGACY_SCHEME)
  const ios = generated._internal.modResults.ios.infoPlist
  assert.ok(ios.CFBundleURLTypes.flatMap(type => type.CFBundleURLSchemes).includes(LEGACY_SCHEME))
})
