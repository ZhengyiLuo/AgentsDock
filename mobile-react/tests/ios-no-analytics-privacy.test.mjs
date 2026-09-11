import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const config = JSON.parse(fs.readFileSync(path.resolve('app.json'), 'utf8')).expo
const pluginSource = fs.readFileSync(path.resolve('plugins/withIosNoAnalyticsPrivacy.cjs'), 'utf8')
const { loadExpoPlist, sanitizePrivacyInfo } = require('../plugins/withIosNoAnalyticsPrivacy.cjs')

test('iOS configuration declares no analytics collection or tracking', () => {
  assert.equal(config.ios.privacyManifests.NSPrivacyTracking, false)
  assert.deepEqual(config.ios.privacyManifests.NSPrivacyCollectedDataTypes, [])
  assert.ok(config.plugins.includes('./plugins/withIosNoAnalyticsPrivacy.cjs'))
})

test('the finalized privacy pass clears stale analytics declarations and preserves required API reasons', () => {
  const accessedAPITypes = [{
    NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
    NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
  }]
  const sanitized = sanitizePrivacyInfo({
    NSPrivacyAccessedAPITypes: accessedAPITypes,
    NSPrivacyCollectedDataTypes: [{
      NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeProductInteraction',
      NSPrivacyCollectedDataTypeLinked: true,
      NSPrivacyCollectedDataTypeTracking: false,
      NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAnalytics'],
    }],
    NSPrivacyTracking: true,
    NSPrivacyTrackingDomains: ['example.invalid'],
  })

  assert.deepEqual(sanitized.NSPrivacyAccessedAPITypes, accessedAPITypes)
  assert.deepEqual(sanitized.NSPrivacyCollectedDataTypes, [])
  assert.equal(sanitized.NSPrivacyTracking, false)
  assert.deepEqual(sanitized.NSPrivacyTrackingDomains, [])
  assert.match(pluginSource, /withFinalizedMod/)
})

test('the privacy pass loads Expo plist through this install layout', () => {
  const plist = loadExpoPlist()
  assert.equal(typeof plist.parse, 'function')
  assert.equal(typeof plist.build, 'function')
})
