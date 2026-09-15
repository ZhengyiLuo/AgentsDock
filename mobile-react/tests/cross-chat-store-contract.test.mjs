import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

function section(value, start, end) {
  const startIndex = value.indexOf(start)
  assert.notEqual(startIndex, -1, `Missing source section start: ${start}`)
  const endIndex = value.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `Missing source section end: ${end}`)
  return value.slice(startIndex, endIndex)
}

const store = source('src/store/useAppStore.ts')
const references = source('src/lib/chat-references.ts')
const cacheMigration = source('src/lib/cache-migration.ts')

test('structured grants stay profile-scoped and are pruned with their source chat', () => {
  assert.match(store, /setChatReferencesForSession\(sessionId, references, expectedGeneration\)[\s\S]*?expectedGeneration !== get\(\)\.profileGeneration/)
  assert.match(store, /chatReferencesBySession: workspace\.chatReferencesBySession \?\? \{\}/g)
  assert.match(store, /removeChatReferencesForSession\(state\.chatReferencesBySession, sessionId\)/)
  assert.match(store, /currentWorkspacePreferences[\s\S]*?chatReferencesBySession: withoutWelcomeRecord\(state\.chatReferencesBySession\)/)
})

test('send admission validates exact authority and restores only inside its captured connection', () => {
  const send = section(store, '  async sendPrompt(', '\n\n  async stopTurn(')
  assert.match(send, /validChatReferences\(prompt, requestedReferences, sessionId\)/)
  assert.match(send, /routeHintMentionsAvailable\(get\(\)\.health\)/)
  assert.match(send, /complete v7 default-deny contract/)
  assert.match(send, /localChatReferenceContractSupported\(state\.health, reference\)/)
  assert.match(send, /supportedCrossChatTargetBackends\(state\.health\)/)
  assert.match(send, /chatReferencesEqual\(state\.chatReferencesBySession\[sessionId\] \?\? \[\], rawReferences\)/)
  assert.match(send, /scope\.client\.sendTurn\([\s\S]*?clientCapabilities,[\s\S]*?chatReferences/)
  assert.match(send, /if \(consumeComposer && consumedDraft && connectionIsCurrent\(scope\)\)/)
  assert.match(send, /restoreFailedChatComposer\(/)
})

test('queued edits refresh capability authority, preserve valid spans, and fence stale results', () => {
  const queued = section(store, '  async updateQueued(', '\n  async removeQueued(')
  assert.match(queued, /validatedConnectionOrReport\(get, set, expectedGeneration\)/)
  assert.match(queued, /reconcileChatReferences\(/)
  assert.match(queued, /validChatReferences\(normalizedPrompt, requestedReferences, sessionId\)/)
  assert.match(queued, /const dispatch = get\(\)[\s\S]*?interactiveClientCapabilities\(dispatch\.sessions\.find\([\s\S]*?dispatch\.health\)/)
  assert.ok(queued.indexOf('await requireTeamReferenceSupport') < queued.indexOf('const dispatch = get()'),
    'capabilities must be negotiated from current state after awaited Team validation')
  assert.match(queued, /capabilityOnly \? scope\.client\.updateQueuedCapabilities\(sessionId, queuedId, capabilities\)/)
  assert.match(queued, /scope\.client\.updateQueued\([\s\S]*?validReferences/)
  const action = section(store, 'async function queueAction(', '\nasync function refreshSnapshotQueue(')
  assert.match(action, /const current = captureAgentRouteGuard\(scope, get\)/)
  assert.match(action, /await action\(\)[\s\S]*?if \(!current\(\)\) return false[\s\S]*?refreshSnapshotQueue\(scope, sessionId, set, get, current\)/)
  const refresh = section(store, 'async function refreshSnapshotQueue(', '\nfunction setSnapshotQueue(')
  assert.match(refresh, /queueState\.revision !== revision \|\| get\(\)\.snapshots\[sessionId\]\?\.queuedTurns !== before\) continue/)
  assert.match(refresh, /await scope\.client\.queue\(sessionId\)[\s\S]*?if \(!current\(\)\) return null/)
})

test('limits and migration ownership fail closed instead of creating partial authority', () => {
  assert.match(references, /if \(references\.length > MAX_CHAT_REFERENCES \|\| !hasWellFormedUtf16\(text\)\) return \[\]/)
  assert.match(references, /reference\.session_id !== reference\.session_id\.trim\(\)/)
  assert.match(references, /hasWellFormedUtf16\(reference\.display_title_snapshot\)/)
  assert.match(cacheMigration, /hasOwnProperty\.call\(target\.drafts, sessionId\)[\s\S]*?targetReferences\[sessionId\][\s\S]*?: sourceReferences\[sessionId\]/)
  assert.match(cacheMigration, /return normalizeWorkspacePreferences\(/)
})
