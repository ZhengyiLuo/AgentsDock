import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { restrictMediaSavePermissions } = require('../plugins/withAndroidMediaSave.cjs')
const config = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo

test('save permission is separate from the existing attachment picker and broad Android reads remain blocked', () => {
  const [, options] = config.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-media-library')
  assert.match(options.savePhotosPermission, /save images and videos/)
  assert.deepEqual(options.granularPermissions, [])
  assert.equal(options.isAccessMediaLocationEnabled, false)
  for (const permission of ['READ_EXTERNAL_STORAGE', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_AUDIO', 'READ_MEDIA_VISUAL_USER_SELECTED']) {
    assert.ok(config.android.blockedPermissions.includes(`android.permission.${permission}`))
  }
})

test('Android storage writes are restricted to pre-MediaStore devices, without legacy storage mode', () => {
  const manifest = { manifest: { $: {}, 'uses-permission': [
    { $: { 'android:name': 'android.permission.INTERNET' } },
    { $: { 'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE', 'android:maxSdkVersion': '32' } },
  ], application: [{ $: { 'android:name': '.MainApplication', 'android:requestLegacyExternalStorage': 'true' } }] } }
  restrictMediaSavePermissions(manifest)
  restrictMediaSavePermissions(manifest)
  const permission = manifest.manifest['uses-permission'].filter(item => item.$['android:name'].endsWith('WRITE_EXTERNAL_STORAGE'))
  assert.equal(permission.length, 1)
  assert.equal(permission[0].$['android:maxSdkVersion'], '28')
  assert.equal(permission[0].$['tools:replace'], 'android:maxSdkVersion')
  assert.equal(manifest.manifest.application[0].$['android:requestLegacyExternalStorage'], undefined)
  assert.ok(manifest.manifest['uses-permission'].some(item => item.$['android:name'].endsWith('INTERNET')))
})

test('composed Expo plugins retain QR camera and add-only media permissions without microphone access', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const generated = JSON.parse(execFileSync(process.execPath, ['node_modules/expo/bin/cli', 'config', '--type', 'introspect', '--json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
  }))
  const manifest = generated._internal.modResults.android.manifest.manifest
  const application = manifest.application.find(item => item.$['android:name'].endsWith('MainApplication'))
  assert.equal(application.$['android:requestLegacyExternalStorage'], undefined)
  const permissions = manifest['uses-permission']
  const camera = permissions.find(item => item.$['android:name'] === 'android.permission.CAMERA')
  assert.ok(camera, 'QR scanning requires an Android camera permission declaration')
  assert.notEqual(camera.$['tools:node'], 'remove')
  assert.equal(permissions.find(item => item.$['android:name'] === 'android.permission.RECORD_AUDIO').$['tools:node'], 'remove')
  assert.equal(permissions.find(item => item.$['android:name'].endsWith('WRITE_EXTERNAL_STORAGE')).$['android:maxSdkVersion'], '28')
  for (const name of ['READ_EXTERNAL_STORAGE', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_AUDIO', 'READ_MEDIA_VISUAL_USER_SELECTED']) {
    assert.equal(permissions.find(item => item.$['android:name'] === `android.permission.${name}`).$['tools:node'], 'remove')
  }
  assert.match(generated._internal.modResults.ios.infoPlist.NSPhotoLibraryAddUsageDescription, /save images and videos/)
  assert.equal(generated._internal.modResults.ios.infoPlist.NSCameraUsageDescription, 'Allow AgentsDock to scan a server connection QR code.')
})
