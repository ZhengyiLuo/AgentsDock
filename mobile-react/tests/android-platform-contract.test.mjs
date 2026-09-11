import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const read = relative => fs.readFileSync(path.resolve(relative), 'utf8')
const config = JSON.parse(read('app.json')).expo
const terminal = read('src/components/TerminalView.tsx')
const androidTerminal = read('src/components/terminal/TerminalViewport.android.tsx')
const iosTerminal = read('src/components/terminal/TerminalViewport.ios.tsx')
const terminalModule = JSON.parse(read('modules/agentsdock-native-terminal/expo-module.config.json'))
const sidebar = read('src/components/Sidebar.tsx')
const workspace = read('src/components/file-viewer/WorkspaceFileViewerModal.tsx')
const preview = read('src/components/file-viewer/FilePreview.tsx')
const dialogs = read('src/components/Dialogs.tsx')
const cleartextPlugin = read('plugins/withAndroidCleartextTraffic.cjs')
const releaseSigningPlugin = read('plugins/withAndroidReleaseSigning.cjs')
const sideloadUpdaterPlugin = read('plugins/withAndroidSideloadUpdater.cjs')
const updaterModule = JSON.parse(read('modules/agentsdock-android-updater/expo-module.config.json'))
const updaterNative = read('modules/agentsdock-android-updater/android/src/main/java/com/zhengyiluo/agentsdock/updater/AgentsDockAndroidUpdaterModule.kt')
const updaterUi = read('src/components/AndroidUpdater.tsx')
const updaterStore = read('src/store/useAndroidUpdaterStore.ts')
const chatScreen = read('src/components/ChatScreen.tsx')

test('Android release identity, LAN access, keyboard resize, icon, and notification metadata are explicit', () => {
  assert.equal(config.android.package, 'com.zhengyiluo.agentsdock')
  assert.equal(config.android.versionCode, 10)
  assert.equal(config.android.usesCleartextTraffic, true)
  assert.equal(config.android.allowBackup, false)
  assert.equal(config.android.softwareKeyboardLayoutMode, 'resize')
  assert.deepEqual(config.android.blockedPermissions, [
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
  ])
  assert.ok(config.android.adaptiveIcon.foregroundImage)
  const notifications = config.plugins.find(value => Array.isArray(value) && value[0] === 'expo-notifications')
  assert.ok(notifications)
  assert.equal(notifications[1].defaultChannel, 'default')
  assert.ok(config.plugins.includes('./plugins/withAndroidCleartextTraffic.cjs'))
  assert.ok(config.plugins.includes('./plugins/withAndroidReleaseSigning.cjs'))
  assert.ok(config.plugins.includes('./plugins/withAndroidSideloadUpdater.cjs'))
  assert.match(cleartextPlugin, /require\('expo\/config-plugins'\)/)
  assert.doesNotMatch(cleartextPlugin, /require\('@expo\/config-plugins'\)/)
  assert.match(cleartextPlugin, /android:usesCleartextTraffic.*=.*'true'/)
  assert.match(releaseSigningPlugin, /AGENTSDOCK_ANDROID_KEYSTORE_PATH/)
  assert.match(releaseSigningPlugin, /signingConfig signingConfigs\.release/)
  assert.match(releaseSigningPlugin, /Android release signing is required/)
  const unsafeSigningFallback = /process\.env\.[A-Z_]+\s*\?\?\s*['"][^'"]+['"]/
  assert.doesNotMatch(releaseSigningPlugin, unsafeSigningFallback)
  assert.match(sideloadUpdaterPlugin, /flavorDimensions \+= "distribution"/)
  assert.match(sideloadUpdaterPlugin, /REQUEST_INSTALL_PACKAGES/)
})

test('Android chat body consumes edge-to-edge IME insets instead of sitting under the keyboard', () => {
  assert.equal(config.android.softwareKeyboardLayoutMode, 'resize')
  assert.match(chatScreen, /behavior=\{Platform\.OS === 'ios' \? 'padding' : Platform\.OS === 'android' \? 'height' : undefined\}/)
  assert.match(chatScreen, /automaticOffset=\{Platform\.OS === 'android'\}/)
  assert.match(chatScreen, /paddingBottom: Platform\.OS === 'ios'[\s\S]*?: keyboardVisible \? 0 : insets\.bottom/)
})

test('Android sideload updater is signer-pinned while the Play flavor has no install permission', () => {
  assert.deepEqual(updaterModule.platforms, ['android'])
  assert.match(updaterNative, /EXPECTED_PACKAGE_NAME = "com\.zhengyiluo\.agentsdock"/)
  assert.match(updaterNative, /EXPECTED_SIGNER_SHA256 = "3ff67f11c62187c52f18e48e7ecd3cf25aa1fcf21ba0477c9eb9e3feeab82e5a"/)
  assert.match(updaterNative, /PackageInstaller\.SessionParams/)
  assert.match(updaterNative, /canRequestPackageInstalls/)
  assert.match(updaterNative, /actualSha256\.equals/)
  assert.match(updaterNative, /archiveVersionCode != request\.versionCode/)
  assert.match(updaterUi, /AndroidUpdateCoordinator/)
  assert.match(updaterUi, /AndroidUpdateSettings/)
  assert.match(updaterStore, /latestAndroidUpdate/)
  assert.match(updaterStore, /installAndroidPackageAsync/)
})

test('Android uses the bundled xterm WebView while iOS retains SwiftTerm', () => {
  assert.deepEqual(terminalModule.platforms, ['apple'])
  assert.match(terminal, /<TerminalViewport/)
  assert.match(iosTerminal, /AgentsDockNativeTerminal/)
  assert.match(androidTerminal, /XTERM_JS/)
  assert.match(androidTerminal, /new WebSocket\(config\.socketURL\)/)
  assert.match(androidTerminal, /Content-Security-Policy/)
  assert.match(androidTerminal, /onShouldStartLoadWithRequest/)
  assert.match(androidTerminal, /onRenderProcessGone/)
  assert.match(androidTerminal, /Clipboard\.setStringAsync/)
  assert.doesNotMatch(terminal, /from 'agentsdock-native-terminal'/)
})

test('file and folder text entry no longer depends on iOS-only Alert.prompt', () => {
  assert.doesNotMatch(sidebar, /Alert\.prompt/)
  assert.doesNotMatch(workspace, /Alert\.prompt/)
  assert.match(sidebar, /useTextPrompt\(\)/)
  assert.match(workspace, /useTextPrompt\(\)/)
})

test('Android PDF and build metadata have platform-safe fallbacks', () => {
  assert.match(preview, /kind === 'pdf' && Platform\.OS === 'android'/)
  assert.match(preview, /Android WebView does not include a PDF renderer/)
  assert.match(dialogs, /Platform\.OS === 'android' \? appConfig\.expo\.android\.versionCode : appConfig\.expo\.ios\.buildNumber/)
})
