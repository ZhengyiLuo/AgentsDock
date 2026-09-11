import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  applyAndroidReleaseSigning,
  MARKER,
} = require('../plugins/withAndroidReleaseSigning.cjs')

const generatedGradle = `plugins {
    id 'com.android.application'
}

android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
`

test('generated Android releases require environment-backed production signing', () => {
  const result = applyAndroidReleaseSigning(generatedGradle)

  assert.match(result, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(result, /AGENTSDOCK_ANDROID_KEYSTORE_PATH/)
  assert.match(result, /AGENTSDOCK_ANDROID_KEYSTORE_PASSWORD/)
  assert.match(result, /AGENTSDOCK_ANDROID_KEY_ALIAS/)
  assert.match(result, /AGENTSDOCK_ANDROID_KEY_PASSWORD/)
  assert.match(result, /signingConfig signingConfigs\.release/)
  assert.match(result, /Android release signing is required/)
  assert.equal(result.split(MARKER).length - 1, 1)
  assert.equal(applyAndroidReleaseSigning(result), result)
})

test('signing transform fails closed when Expo changes its Gradle template', () => {
  assert.throws(
    () => applyAndroidReleaseSigning('android {\n}\n'),
    /generated debug signing block/,
  )
})
