import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = fs.readFileSync(path.resolve('src/components/ServerProfiles.tsx'), 'utf8')
const appShell = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf8')
const dialogs = fs.readFileSync(path.resolve('src/components/Dialogs.tsx'), 'utf8')
const firstLaunch = fs.readFileSync(path.resolve('src/lib/first-launch.ts'), 'utf8')
const store = fs.readFileSync(path.resolve('src/store/useAppStore.ts'), 'utf8')

test('first launch presents setup without probing localhost and hands off after dismissal', () => {
  assert.match(firstLaunch, /state\.initialized[\s\S]*?!state\.connected[\s\S]*?isServerSetupRequired\(state\)[\s\S]*?!state\.setupDismissed/)
  assert.match(store, /if \(NativeAppState\.currentState === 'active' && shouldAutoConnectServer\(get\(\)\)\) \{[\s\S]*?await get\(\)\.reconnect\(\)/)
  assert.match(store, /async reconnect\(\) \{\s*if \(NativeAppState\.currentState !== 'active' \|\| !shouldAutoConnectServer\(get\(\)\)\) return/)
  assert.match(appShell, /shouldPresentServerSetup\(\{ initialized, connected, serverConfigured, serverURL, setupDismissed \}\)/)
  assert.match(appShell, /setupNextMode\.current = 'edit-active'/)
  assert.match(appShell, /onDidDismiss=\{finishSetupDismissal\}/)
  assert.match(appShell, /if \(Platform\.OS !== 'ios'\) requestAnimationFrame\(finishSetupDismissal\)/)
  assert.doesNotMatch(appShell, /openServersAfterSetup/)
  assert.match(dialogs, /onDismiss=\{didDismiss\}/)
  assert.match(source, /initialServerProfileDraft\(initialMode, profiles, activeProfileId\)/)
})

test('server selector permanently exposes profile status, host, and unread count', () => {
  assert.match(source, /testID="server-profile-selector"/)
  assert.match(source, /<ServerConnectionDot/)
  assert.match(source, /profileHostSubtitle\(active\)/)
  assert.match(source, /<ServerUnreadBadge count=\{active\.cachedUnreadCount\}/)
  assert.match(source, /<MenuView[\s\S]*?onPressAction=/)
})

test('server switching tracks resolved and thrown failures without swallowing the error', () => {
  const switchCallback = appShell.match(/const switchServer = useCallback\(async \(profileId: string\) => \{[\s\S]*?\n  \}, \[switchServerProfile\]\)/)?.[0]
  assert.ok(switchCallback)
  assert.match(switchCallback, /const success = await switchServerProfile\(profileId\)[\s\S]*?trackEvent\('server_switched', \{ success \}\)[\s\S]*?return success/)
  assert.match(switchCallback, /catch \(error\) \{[\s\S]*?trackEvent\('server_switched', \{ success: false \}\)[\s\S]*?throw error/)
})

test('new profiles stay gated on a successful connection test', () => {
  assert.match(source, /if \(!draft\.profileId && !tested\?\.ok\)/)
  assert.match(source, /\(!draft\.profileId && !tested\?\.ok\)/)
  assert.match(source, /did not report a stable server identity/)
  assert.match(source, /Already saved as/)
})

test('connection edits carry only the freshly tested identity', () => {
  assert.match(source, /updateConnectionChanged && !tested\?\.server_identity\?\.trim\(\)/)
  assert.match(source, /buildUpdateServerProfileInput\(editedProfile, draft, tested\?\.server_identity\)/)
  assert.match(source, /identityResetUnconfirmed/)
})

test('server removal and identity reset require native confirmation', () => {
  assert.match(source, /Alert\.alert\([\s\S]*?Remove server/)
  assert.match(source, /Alert\.alert\([\s\S]*?Allow identity reset/)
  assert.match(source, /attributes: \{ disabled: disabled \|\| active, destructive: !active \}/)
})

test('server management controls retain touch-safe minimum dimensions', () => {
  assert.match(source, /input: \{ minHeight: 44/)
  assert.match(source, /primaryButton: \{ minHeight: 44/)
  assert.match(source, /secondaryButton: \{ minHeight: 44/)
  assert.match(source, /moreButton: \{ width: 44, height: 44/)
})
