const { withAndroidManifest } = require('expo/config-plugins')

const LEGACY_SCHEME = 'com.zhengyiluo.ZenithDock'
const ANDROID_SCHEME = LEGACY_SCHEME.toLowerCase()

function normalizeAndroidReleaseManifest(manifest) {
  // Android matches schemes case-sensitively and requires lower-case schemes.
  // Keep the shared Expo/iOS scheme unchanged; normalize only its Android entry.
  for (const application of manifest.manifest.application ?? []) {
    for (const activity of application.activity ?? []) {
      for (const filter of activity['intent-filter'] ?? []) {
        if (!filter.action?.some(action => action.$['android:name'] === 'android.intent.action.VIEW')) continue
        for (const data of filter.data ?? []) {
          if (data.$['android:scheme'] === LEGACY_SCHEME) data.$['android:scheme'] = ANDROID_SCHEME
        }
      }
    }
  }

  // QR scanning is optional: devices without a camera can connect manually.
  const features = manifest.manifest['uses-feature'] ??= []
  const cameras = features.filter(feature => feature.$['android:name'] === 'android.hardware.camera')
  if (cameras.length === 0) {
    const camera = { $: { 'android:name': 'android.hardware.camera' } }
    features.push(camera)
    cameras.push(camera)
  }
  for (const camera of cameras) camera.$['android:required'] = 'false'
  return manifest
}

// Register early: Android manifest mods run in reverse order, after Expo's
// default Scheme plugin has appended the shared scheme to the native manifest.
module.exports = config => withAndroidManifest(config, next => {
  next.modResults = normalizeAndroidReleaseManifest(next.modResults)
  return next
})
module.exports.normalizeAndroidReleaseManifest = normalizeAndroidReleaseManifest
module.exports.LEGACY_SCHEME = LEGACY_SCHEME
module.exports.ANDROID_SCHEME = ANDROID_SCHEME
