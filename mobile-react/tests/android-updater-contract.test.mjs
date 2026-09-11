import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const read = relative => fs.readFileSync(path.resolve(relative), 'utf8')
const config = JSON.parse(read('app.json')).expo
const packageConfig = JSON.parse(read('package.json'))
const moduleConfig = JSON.parse(read('modules/agentsdock-android-updater/expo-module.config.json'))
const moduleSource = read('modules/agentsdock-android-updater/android/src/main/java/com/zhengyiluo/agentsdock/updater/AgentsDockAndroidUpdaterModule.kt')
const receiverSource = read('modules/agentsdock-android-updater/android/src/main/java/com/zhengyiluo/agentsdock/updater/UpdateInstallReceiver.kt')
const manifestSource = read('modules/agentsdock-android-updater/android/src/main/AndroidManifest.xml')
const updateContract = read('src/lib/android-update.ts')
const updateStore = read('src/store/useAndroidUpdaterStore.ts')
const updateUi = read('src/components/AndroidUpdater.tsx')
const appShell = read('src/components/AppShell.tsx')
const dialogs = read('src/components/Dialogs.tsx')

test('Android beta updater is linked only as an Android native module', () => {
  assert.equal(packageConfig.dependencies['agentsdock-android-updater'], 'file:modules/agentsdock-android-updater')
  assert.deepEqual(moduleConfig.platforms, ['android'])
  assert.deepEqual(moduleConfig.android.modules, ['com.zhengyiluo.agentsdock.updater.AgentsDockAndroidUpdaterModule'])
  assert.match(manifestSource, /UpdateInstallReceiver/)
  assert.match(receiverSource, /STATUS_PENDING_USER_ACTION/)
  assert.match(receiverSource, /Intent\.EXTRA_INTENT/)
})

test('native installation fails closed on package, version, checksum, size, cache path, and signer', () => {
  assert.match(moduleSource, /EXPECTED_PACKAGE_NAME = "com\.zhengyiluo\.agentsdock"/)
  assert.match(moduleSource, /EXPECTED_SIGNER_SHA256 = "3ff67f11c62187c52f18e48e7ecd3cf25aa1fcf21ba0477c9eb9e3feeab82e5a"/)
  assert.match(moduleSource, /file\.length\(\) != request\.sizeBytes/)
  assert.match(moduleSource, /actualSha256\.equals\(request\.sha256/)
  assert.match(moduleSource, /packageInfo\.packageName != EXPECTED_PACKAGE_NAME/)
  assert.match(moduleSource, /archiveVersionCode != request\.versionCode/)
  assert.match(moduleSource, /signers\.size != 1/)
  assert.match(moduleSource, /context\.cacheDir, context\.externalCacheDir/)
  assert.match(moduleSource, /USER_ACTION_REQUIRED/)
})

test('GitHub discovery is bounded, prerelease-only, digest-checked, and infrequent', () => {
  assert.match(updateContract, /per_page=100/)
  assert.match(updateContract, /release\.prerelease/)
  assert.match(updateContract, /release\.tag_name\.startsWith\('android-v'\)/)
  assert.match(updateContract, /slice\(0, 6\)/)
  assert.match(updateContract, /apkAsset\.digest !== `sha256:\$\{manifest\.apk\.sha256\}`/)
  assert.match(updateContract, /12 \* 60 \* 60 \* 1_000/)
  assert.match(updateStore, /AbortController/)
  assert.match(updateStore, /NETWORK_TIMEOUT_MS = 15_000/)
  assert.match(updateStore, /createDownloadResumable/)
  assert.match(updateStore, /installAndroidPackageAsync/)
})

test('updater has automatic and manual accessible surfaces without affecting iOS', () => {
  assert.equal(config.android.versionCode, 10)
  assert.match(appShell, /<AndroidUpdateCoordinator/)
  assert.match(dialogs, /<AndroidUpdateSettings/)
  assert.match(updateUi, /Platform\.OS !== 'android'/)
  assert.match(updateUi, /testID="android-update-banner"/)
  assert.match(updateUi, /testID="android-update-action"/)
  assert.match(updateUi, /AppState\.addEventListener/)
  assert.match(updateUi, /minimum.*44|height: 44|minHeight: 44/s)
})
