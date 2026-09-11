import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

function section(value, start, end) {
  const startIndex = value.indexOf(start)
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`)
  const endIndex = value.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`)
  return value.slice(startIndex, endIndex)
}

const store = source('src/store/useAppStore.ts')
const cache = source('src/storage/cache.ts')
const appShell = source('src/components/AppShell.tsx')
const mediaGrid = source('src/components/MediaGrid.tsx')
const terminalView = source('src/components/TerminalView.tsx')

test('connection installation is validation-gated, advances generation, and disposes the superseded client', () => {
  assert.match(store, /interface ConnectionScope \{[\s\S]*?readonly profileId: string[\s\S]*?readonly generation: number[\s\S]*?namespace: string[\s\S]*?namespaceAdopting: boolean[\s\S]*?readonly client: AgentServerClient/)
  assert.match(store, /function connectionIsCurrent\(scope: ConnectionScope\): boolean \{ return activeConnection === scope \}/)
  assert.match(store, /client: new AgentServerClient\(DEFAULT_SERVER_URL, '', \{ requireValidation: true \}\)/)

  const install = section(store, 'function installConnection(', '\n}\n\nexport type ChatSyncStatus')
  assert.match(install, /const previous = activeConnection/)
  assert.match(install, /generation: \+\+connectionGeneration/)
  assert.match(install, /namespaceAdopting: false/)
  assert.match(install, /client: new AgentServerClient\(serverURL, token, \{[\s\S]*?requireValidation: true,[\s\S]*?onAuthorizationFailure:/)
  assert.ok(install.indexOf('activeConnection = next') < install.indexOf('previous.client.dispose()'))
  assert.match(install, /previous\.client\.dispose\(\)/)

  const validated = section(store, 'function captureValidatedConnection(', '\n}\n\nfunction validatedConnectionOrReport(')
  assert.match(validated, /state\.profileGeneration !== scope\.generation/)
  assert.match(validated, /state\.activeProfileId !== scope\.profileId/)
  assert.match(validated, /!scope\.client\.isValidated \|\| !state\.connected \|\| state\.connecting \|\| state\.switchingProfileId/)
})

test('reconnect validates health, contract, and identity before fetching sessions', () => {
  assert.match(store, /const MIN_API_CONTRACT = 8/)
  const reconnect = section(store, '  async reconnect() {', '\n  async retryConnection() {')
  const health = reconnect.indexOf('health = await scope.client.health()')
  const contract = reconnect.indexOf('health.api_contract_version')
  const identity = reconnect.indexOf('await acceptHealthIdentity(scope, health,')
  const sessions = reconnect.indexOf('scope.client.sessions()')
  assert.ok(health >= 0, 'Reconnect must fetch health')
  assert.ok(contract > health, 'Reconnect must validate the API contract after health')
  assert.ok(identity > contract, 'Reconnect must validate canonical identity after the API contract')
  assert.ok(sessions > identity, 'Session requests must begin only after health and identity validation')
  assert.match(reconnect, /if \(health\.ok !== true\) throw new Error/)
  assert.match(reconnect, /if \(contract < MIN_API_CONTRACT\) throw new Error/)

  const identityValidation = section(store, 'async function acceptHealthIdentity(', '\nfunction requiredServerIdentity(')
  assert.match(identityValidation, /if \(health\.ok !== true\) throw new Error/)
  assert.match(identityValidation, /health\.api_contract_version/)
  assert.match(identityValidation, /const identity = requiredServerIdentity\(health\)/)
  assert.match(identityValidation, /profile\.serverIdentity && profile\.serverIdentity !== identity/)
  assert.match(identityValidation, /findDuplicateProfileByIdentity\(get\(\)\.profiles, identity, profile\.id\)/)
  assert.match(identityValidation, /scope\.client\.markValidated\(\)/)
  assert.match(store, /const identity = typeof health\.server_identity === 'string' \? health\.server_identity\.trim\(\) : ''/)

  const probe = section(store, 'async function probeServerHealth(', '\nasync function acceptHealthIdentity(')
  assert.match(probe, /await probe\.health\(\)/)
  assert.match(probe, /health\.api_contract_version/)
  assert.match(probe, /requiredServerIdentity\(health\)/)
  assert.match(probe, /finally \{[\s\S]*?probe\.dispose\(\)/)
})

test('every durable workspace cache call is namespace-scoped', () => {
  const names = [
    'loadCachedSessions', 'saveCachedSessions', 'loadSnapshot', 'saveSnapshot', 'removeSnapshot',
    'loadPins', 'savePins', 'loadWorkspacePreferences', 'saveWorkspacePreferences',
    'cachedServerSummary', 'migrateCacheNamespace', 'cleanupCacheNamespace', 'purgeCacheNamespace',
  ]
  const calls = [...store.matchAll(new RegExp(`\\b(${names.join('|')})\\(([^,\\n]+)`, 'g'))]
  assert.ok(calls.length >= 20, `Expected namespace-scoped cache coverage, found ${calls.length} calls`)
  for (const call of calls) {
    const firstArgument = call[2].trim()
    assert.match(firstArgument, /namespace/i, `${call[1]} is not passed an explicit namespace: ${firstArgument}`)
    assert.doesNotMatch(firstArgument, /serverURL|serverUrl/, `${call[1]} regressed to URL-scoped cache ownership`)
  }
  assert.match(store, /const namespace = profileNamespace\(activeProfile\)/)
  assert.match(store, /const namespace = profileNamespace\(profile\)/)
  assert.match(store, /migrateCacheNamespace\(sourceNamespace, targetNamespace\)/)
  assert.match(store, /purgeCacheNamespace\(fallbackToPurge\.namespace, fallbackToPurge\.verifiedSourceKeys\)/)
})

test('profile activation serializes durable preparation and releases cached state before background validation', () => {
  const activate = section(store, 'async function activateServerProfile(', '\nasync function completeServerProfileActivation(')
  assert.match(activate, /activation = await withProfileMutation\(\(\) => withActiveConnectionMutation\([\s\S]*?\(\) => prepareServerProfileActivation\(profileId, force, set, get\),[\s\S]*?\)\)/)
  assert.match(activate, /if \(!activation\) return true/)
  assert.match(activate, /return completeServerProfileActivation\(activation, set, get\)/)

  const complete = section(store, 'async function completeServerProfileActivation(', '\nasync function prepareServerProfileActivation(')
  assert.match(complete, /set\(\{ switchingProfileId: null \}\)/)
  assert.match(complete, /void get\(\)\.reconnect\(\)/)
  assert.ok(complete.indexOf('set({ switchingProfileId: null })') < complete.indexOf('void get().reconnect()'), 'Cached activation must release the selector before background health validation')
  assert.match(complete, /activation\.intent === profileSwitchIntent/)
  assert.match(complete, /connectionIsCurrent\(activation\.scope\)/)
  assert.match(complete, /get\(\)\.activeProfileId === activation\.scope\.profileId/)

  const prepare = section(store, 'async function prepareServerProfileActivation(', '\nasync function probeServerHealth(')
  assert.match(prepare, /const intent = \+\+profileSwitchIntent/)
  assert.match(prepare, /await saveProfileSettings\(/)
  assert.match(prepare, /stopSelectedStream\(\)/)
  assert.match(prepare, /selectionEpoch \+= 1/)
  assert.match(prepare, /syncInFlight = null/)
  assert.match(prepare, /foregroundRepairInFlight = null/)
  assert.match(prepare, /if \(readReceiptTimer\) clearTimeout\(readReceiptTimer\)/)
  assert.match(prepare, /const scope = installConnection\(profileId, profile\.serverURL, token, namespace, set\)/)
  assert.match(prepare, /catch \(error\) \{[\s\S]*?intent === profileSwitchIntent[\s\S]*?switchingProfileId: null/)
  assert.match(prepare, /scope\.client\.revokeValidation\(\)/)
  assert.ok(prepare.indexOf('await saveProfileSettings(') < prepare.indexOf('const scope = installConnection('), 'Active-profile metadata must commit before installing its connection')

  const resets = [
    /activeProfileId: profileId/,
    /profileGeneration: scope\.generation/,
    /connected: false/,
    /connecting: false/,
    /liveConnected: false/,
    /health: null/,
    /runtime: null/,
    /snapshots: selected && snapshot \? \{ \[selected\]: snapshot \} : \{\}/,
    /loadingSessionId: null/,
    /loadingOlder: \{\}/,
    /activeSessionIds: new Set\(\)/,
    /jobs: \[\]/,
    /drafts: workspace\.drafts/,
    /uploads: \{\}/,
    /uploadPending: \{\}/,
    /uploadFailed: \{\}/,
    /pins,/,
    /collapsedFolders: workspace\.collapsedFolders/,
    /searchResults: \[\]/,
    /searchBusy: false/,
    /timelineIndex: \{\}/,
    /processes: \{\}/,
    /tmuxPanes: \{\}/,
    /lastTimelineSyncAt: null/,
  ]
  for (const reset of resets) assert.match(prepare, reset)

  const serialization = section(store, 'function withProfileMutation<T>(', '\n}\n\nfunction installAppLifecycle(')
  assert.match(serialization, /profileMutationQueue\.catch\(\(\) => undefined\)\.then\(operation\)/)
  assert.match(serialization, /profileMutationQueue = result\.then\(\(\) => undefined, \(\) => undefined\)/)
})

test('canonical namespace adoption releases interaction before delete-only source maintenance', () => {
  const identityValidation = section(store, 'async function acceptHealthIdentity(', '\nfunction requiredServerIdentity(')
  assert.match(identityValidation, /await withProfileMutation\(async \(\) =>/)
  assert.match(identityValidation, /const sourceNamespace = scope\.namespace/)
  assert.match(identityValidation, /scope\.namespaceAdopting = true/)
  assert.match(identityValidation, /set\(\{ workspaceAdopting: true \}\)/)
  assert.match(identityValidation, /finally \{[\s\S]*?scope\.namespaceAdopting = false/)
  assert.match(identityValidation, /set\(\{ workspaceAdopting: false \}\)/)
  assert.match(identityValidation, /await saveCurrentWorkspace\(get\)/)
  assert.match(identityValidation, /savePins\(sourceNamespace, workspaceState\.pins\)/)

  const barrier = identityValidation.indexOf('scope.namespaceAdopting = true')
  const sourceFlush = identityValidation.indexOf('await saveCurrentWorkspace(get)')
  const copy = identityValidation.indexOf('migrateCacheNamespace(sourceNamespace, targetNamespace)')
  const metadata = identityValidation.indexOf('await saveProfileSettings({')
  const adopt = identityValidation.indexOf('scope.namespace = targetNamespace')
  const purge = identityValidation.indexOf('purgeCacheNamespace(fallbackToPurge.namespace, fallbackToPurge.verifiedSourceKeys)')
  const validate = identityValidation.lastIndexOf('scope.client.markValidated()')
  const unlock = identityValidation.indexOf('set({ workspaceAdopting: false })')
  assert.ok(sourceFlush >= 0 && barrier > sourceFlush, 'The current debounce must flush before the namespace write barrier closes')
  assert.ok(copy > barrier, 'Canonical cache copying must follow the source flush and write barrier')
  assert.ok(metadata > copy, 'Canonical profile metadata must commit after the fallback copy is verified')
  assert.ok(adopt > metadata, 'The connection cannot adopt the canonical namespace before metadata commits')
  assert.ok(validate > adopt, 'Validation must follow canonical namespace adoption')
  assert.ok(unlock > validate, 'The source-write barrier must open only after canonical validation')
  assert.ok(purge > unlock, 'Fallback source deletion must begin only after interaction is released')
  assert.doesNotMatch(identityValidation, /await purgeCacheNamespace/)
  assert.doesNotMatch(identityValidation, /cleanupCacheNamespace\(/)

  assert.match(store, /if \(scope\.namespaceAdopting\) return false/)
  assert.match(store, /if \(captureConnection\(\)\.namespaceAdopting\) return/g)
  assert.match(store, /if \(scope\.namespaceAdopting\) return Promise\.resolve\(\)/)

  const stagedMigration = section(cache, 'export async function migrateCacheNamespace(', '\n}\n\n/**')
  assert.match(stagedMigration, /performCacheNamespaceMigration\(sourceNamespace, targetNamespace, false\)/)
  const cleanupMigration = section(cache, 'export async function cleanupCacheNamespace(', '\n}\n\nasync function performCacheNamespaceMigration(')
  assert.match(cleanupMigration, /performCacheNamespaceMigration\(sourceNamespace, targetNamespace, true\)/)
  const purgeMigration = section(cache, 'export async function purgeCacheNamespace(', '\n}\n\nasync function performCacheNamespaceMigration(')
  assert.match(purgeMigration, /uniqueStrings\(verifiedSourceKeys\)/)
  assert.match(purgeMigration, /Fallback cleanup received a key outside its cache namespace/)
  assert.match(purgeMigration, /AsyncStorage\.multiRemove\(sourceKeys\)/)
  assert.doesNotMatch(purgeMigration, /targetNamespace|multiSet|readNamespacePayload|getAllKeys/)
  const migration = section(cache, 'async function performCacheNamespaceMigration(', '\ninterface ReadNamespacePayload')
  const verifyWrite = migration.indexOf('if (verifiedByKey.get(key) !== expected)')
  const cleanupGuard = migration.indexOf('if (cleanupSource)')
  const removeSource = migration.indexOf('await AsyncStorage.multiRemove(source.presentKeys)')
  assert.ok(verifyWrite >= 0 && cleanupGuard > verifyWrite && removeSource > cleanupGuard, 'Source removal must be cleanup-only and follow target verification')
})

test('notifications resolve both profile ID and canonical identity before selecting a reused session ID', () => {
  const notify = section(store, 'async function notifyOnce(', '\n}')
  assert.match(notify, /const key = `\$\{scope\.profileId\}:\$\{scope\.namespace\}:\$\{session\.id\}:\$\{seq\}`/)
  assert.match(notify, /data: \{ profileId: scope\.profileId, serverIdentity: scope\.namespace, sessionId: session\.id \}/)

  const responseHandler = section(appShell, '    const openNotification = async', '\n    const subscription = Notifications.addNotificationResponseReceivedListener')
  assert.match(responseHandler, /const profileId = typeof data\.profileId === 'string' \? data\.profileId : null/)
  assert.match(responseHandler, /const serverIdentity = typeof data\.serverIdentity === 'string' \? data\.serverIdentity : null/)
  assert.match(responseHandler, /const sessionId = typeof data\.sessionId === 'string' \? data\.sessionId : null/)
  assert.match(responseHandler, /const target = before\.profiles\.find\(profile => profile\.id === profileId\)/)
  assert.match(responseHandler, /if \(!target \|\| profileNamespace\(target\) !== serverIdentity\) return/)
  const identityChecks = [...responseHandler.matchAll(/profileNamespace\(currentTarget\) !== serverIdentity/g)]
  assert.ok(identityChecks.length >= 3, 'Notification routing must revalidate canonical identity after every asynchronous navigation step')
  const switchIndex = responseHandler.indexOf('await before.switchServerProfile(profileId)')
  const refreshIndex = responseHandler.indexOf('await current.refreshSessions()')
  const selectIndex = responseHandler.indexOf('selectSession(sessionId)')
  assert.ok(switchIndex >= 0 && selectIndex > switchIndex, 'Notification navigation must switch profile before session selection')
  assert.ok(refreshIndex > switchIndex && selectIndex > refreshIndex, 'Notification navigation must refresh the selected profile before selecting a missing session')
  assert.match(responseHandler, /current\.selectedSessionId !== sessionId[\s\S]*?profileNamespace\(currentTarget\) !== serverIdentity[\s\S]*?openMobileChat\(\)/)
})

test('profile generation participates in UI identity and direct-client guards', () => {
  assert.match(appShell, /const connectionKey = `\$\{activeProfileId \?\? 'none'\}:\$\{profileGeneration\}`/)
  assert.match(appShell, /<Sidebar key=\{`sidebar:\$\{connectionKey\}`\}/)
  assert.match(appShell, /<ChatScreen key=\{`\$\{connectionKey\}:\$\{selected\.id\}`\}/)

  assert.match(mediaGrid, /const connectionKey = `\$\{activeProfileId \?\? 'none'\}:\$\{profileGeneration\}`/)
  assert.match(mediaGrid, /key=\{`\$\{connectionKey\}:\$\{sessionId\}:\$\{ownerKey\}:\$\{compact \? 'compact' : 'timeline'\}`\}/)
  assert.match(mediaGrid, /!connection\.client\.isDisposed[\s\S]*?client === connection\.client[\s\S]*?state\.activeProfileId === connection\.profileId[\s\S]*?state\.profileGeneration === connection\.generation/)

  assert.match(terminalView, /const connectionKey = `\$\{activeProfileId \?\? 'none'\}:\$\{profileGeneration\}`/)
  assert.match(terminalView, /key=\{`\$\{connectionKey\}:\$\{session\.id\}`\}/)
  assert.match(terminalView, /!connection\.isDisposed[\s\S]*?client === connection[\s\S]*?state\.activeProfileId === profileId[\s\S]*?state\.profileGeneration === generation/)
})

test('legacy singleton reconfigure and unscoped settings/token APIs stay removed', () => {
  assert.doesNotMatch(store, /\.configure\(/)
  for (const legacyName of ['loadSettings', 'saveSettings', 'loadToken', 'saveToken']) {
    assert.doesNotMatch(store, new RegExp(`\\b${legacyName}\\b`))
    assert.doesNotMatch(cache, new RegExp(`export\\s+(?:async\\s+)?function\\s+${legacyName}\\b`))
  }
  assert.match(store, /loadProfileSettings/)
  assert.match(store, /loadProfileToken/)
  assert.match(store, /saveProfileSettings/)
  assert.match(store, /saveProfileToken/)
})
