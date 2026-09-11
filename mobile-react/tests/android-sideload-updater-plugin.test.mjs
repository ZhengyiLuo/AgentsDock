import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  applyAndroidSideloadUpdater,
  MARKER,
  SIDELOAD_MANIFEST,
} = require('../plugins/withAndroidSideloadUpdater.cjs')

const generatedGradle = `android {
    defaultConfig {
        applicationId 'com.zhengyiluo.agentsdock'
    }
    packagingOptions {
        jniLibs {
            useLegacyPackaging false
        }
    }
}
`

test('generated Android project separates sideload and Play distribution channels', () => {
  const result = applyAndroidSideloadUpdater(generatedGradle)
  assert.match(result, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(result, /flavorDimensions \+= "distribution"/)
  assert.match(result, /sideload \{[\s\S]*?AGENTSDOCK_SIDELOAD_UPDATER", "true"/)
  assert.match(result, /play \{[\s\S]*?AGENTSDOCK_SIDELOAD_UPDATER", "false"/)
  assert.equal(result.split(MARKER).length - 1, 1)
  assert.equal(applyAndroidSideloadUpdater(result), result)
})

test('only the sideload flavor declares package-install authority', () => {
  assert.match(SIDELOAD_MANIFEST, /android\.permission\.REQUEST_INSTALL_PACKAGES/)
})

test('updater transform fails closed when Expo changes its Gradle template', () => {
  assert.throws(
    () => applyAndroidSideloadUpdater('android {\n}\n'),
    /packagingOptions block/,
  )
})
