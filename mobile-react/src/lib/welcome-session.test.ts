import assert from 'node:assert/strict'
import {
  appendWelcomeExchange,
  buildWelcomeSnapshot,
  isWelcomeSession,
  welcomeWorkspacePatch,
  withoutWelcomeRecord,
  WELCOME_SESSION_ID,
} from './welcome-session'

const timestamp = '2026-08-16T20:00:00.000Z'
const snapshot = buildWelcomeSnapshot(timestamp)
assert.equal(snapshot.events.length, 1)
assert.equal(snapshot.latestSeq, 1)
assert.equal(snapshot.events[0]?.session_id, WELCOME_SESSION_ID)
assert.equal(snapshot.events[0]?.ts, timestamp)

const emptyState = {
  sessions: [],
  snapshots: {},
  drafts: {},
  chatReferencesBySession: {},
  selectedSessionId: null,
  historyWindow: null,
}
const installed = welcomeWorkspacePatch(emptyState, true)
assert.ok(installed)
assert.equal(installed.sessions?.length, 1)
assert.ok(installed.snapshots?.[WELCOME_SESSION_ID])
assert.equal(welcomeWorkspacePatch({ ...emptyState, ...installed }, true), null, 'reconciliation must preserve stable store identity')

const exchange = appendWelcomeExchange(snapshot, 'How do I set up a server?', '2026-08-16T20:01:00.000Z')
assert.deepEqual(exchange.events.map(event => event.seq), [1, 2, 3])
assert.equal(exchange.events[1]?.prompt, 'How do I set up a server?')
assert.match(exchange.events[2]?.result_text ?? '', /agentsdock\.net/)
assert.equal(exchange.latestSeq, 3)
assert.equal(exchange.session.manual_unread, false)

const removed = welcomeWorkspacePatch({
  sessions: [exchange.session],
  snapshots: { [WELCOME_SESSION_ID]: exchange },
  drafts: { [WELCOME_SESSION_ID]: 'local-only draft' },
  chatReferencesBySession: { [WELCOME_SESSION_ID]: [] },
  selectedSessionId: WELCOME_SESSION_ID,
  historyWindow: { sessionId: WELCOME_SESSION_ID },
}, false)
assert.ok(removed)
assert.deepEqual(removed.sessions, [])
assert.deepEqual(removed.snapshots, {})
assert.deepEqual(removed.drafts, {})
assert.deepEqual(removed.chatReferencesBySession, {})
assert.equal(removed.selectedSessionId, null)
assert.equal(removed.historyWindow, null)

const ordinary = { 'chat-a': 'draft' }
assert.equal(withoutWelcomeRecord(ordinary), ordinary, 'ordinary persistence should not allocate')
assert.deepEqual(withoutWelcomeRecord({ ...ordinary, [WELCOME_SESSION_ID]: 'ephemeral' }), ordinary)
assert.equal(isWelcomeSession(WELCOME_SESSION_ID), true)
assert.equal(isWelcomeSession('chat-a'), false)

console.log('welcome session regressions passed')
