import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const fail = message => {
  console.error(`Android native verification failed: ${message}`)
  process.exitCode = 1
}

const config = JSON.parse(read('app.json')).expo
const android = config.android ?? {}
const manifest = read('android/app/src/main/AndroidManifest.xml')
const appGradle = read('android/app/build.gradle')
const settingsGradle = read('android/settings.gradle')
const releaseSigningPlugin = './plugins/withAndroidReleaseSigning.cjs'
const sideloadUpdaterPlugin = './plugins/withAndroidSideloadUpdater.cjs'
const sideloadManifest = read('android/app/src/sideload/AndroidManifest.xml')

if (android.package !== 'com.zhengyiluo.agentsdock') fail(`unexpected package ${String(android.package)}`)
if (!Number.isSafeInteger(android.versionCode) || android.versionCode < 1) fail('versionCode must be a positive integer')
if (android.allowBackup !== false) fail('app backup must remain disabled')
if (android.usesCleartextTraffic !== true) fail('LAN/Tailscale cleartext intent is missing from app config')
if (!appGradle.includes(`namespace '${android.package}'`)) fail('Gradle namespace does not match app config')
if (!appGradle.includes(`applicationId '${android.package}'`)) fail('Gradle applicationId does not match app config')
if (!appGradle.includes(`versionCode ${android.versionCode}`)) fail('Gradle versionCode does not match app config')
if (!appGradle.includes(`versionName "${config.version}"`)) fail('Gradle versionName does not match app config')
if (!settingsGradle.includes("rootProject.name = 'AgentsDock'")) fail('native project name is not AgentsDock')
if (!config.plugins.includes(releaseSigningPlugin)) fail('release signing config plugin is missing')
if (!config.plugins.includes(sideloadUpdaterPlugin)) fail('sideload updater config plugin is missing')
for (const environmentName of [
  'AGENTSDOCK_ANDROID_KEYSTORE_PATH',
  'AGENTSDOCK_ANDROID_KEYSTORE_PASSWORD',
  'AGENTSDOCK_ANDROID_KEY_ALIAS',
  'AGENTSDOCK_ANDROID_KEY_PASSWORD',
]) {
  if (!appGradle.includes(environmentName)) fail(`Gradle does not consume ${environmentName}`)
}
if (!appGradle.includes('signingConfig signingConfigs.release')) fail('release build does not use the release signing config')
const releaseBuildType = appGradle.match(/buildTypes\s*\{[\s\S]*?release \{([\s\S]*?)def enableShrinkResources/)?.[1] ?? ''
if (releaseBuildType.includes('signingConfigs.debug')) fail('release build still selects the debug signing config')
if (!appGradle.includes('Android release signing is required')) fail('missing fail-closed release signing guard')
if (!appGradle.includes('flavorDimensions += "distribution"')) fail('Android distribution flavor dimension is missing')
if (!appGradle.includes('sideload {') || !appGradle.includes('AGENTSDOCK_SIDELOAD_UPDATER", "true"')) fail('sideload updater flavor is missing')
if (!appGradle.includes('play {') || !appGradle.includes('AGENTSDOCK_SIDELOAD_UPDATER", "false"')) fail('Play distribution flavor is missing')
if (!sideloadManifest.includes('android.permission.REQUEST_INSTALL_PACKAGES')) fail('sideload flavor lacks package-install permission')
if (manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES')) fail('Play-compatible main manifest includes sideload package-install permission')

const application = manifest.match(/<application\b[^>]*>/)?.[0] ?? ''
if (!application.includes('android:usesCleartextTraffic="true"')) fail('release application does not allow LAN/Tailscale HTTP and WebSocket profiles')
if (!application.includes('android:allowBackup="false"')) fail('release application permits OS backup')
if (!manifest.includes('android:windowSoftInputMode="adjustResize"')) fail('keyboard resize mode is missing')

for (const permission of [
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
]) {
  const escaped = permission.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declaration = manifest.match(new RegExp(`<uses-permission[^>]+android:name="${escaped}"[^>]*>`))?.[0] ?? ''
  if (!declaration.includes('tools:node="remove"')) fail(`${permission} is not explicitly removed`)
}

const mainApplication = path.join('android', 'app', 'src', 'main', 'java', ...android.package.split('.'), 'MainApplication.kt')
if (!fs.existsSync(path.join(root, mainApplication))) fail(`missing package-scoped ${mainApplication}`)

if (!process.exitCode) {
  console.log(`Android native project verified: ${android.package} ${config.version} (${android.versionCode})`)
}
