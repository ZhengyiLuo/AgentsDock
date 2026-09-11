import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import type { CrossChatHandoff } from '../types'
import { authenticatedChatMessageBody, chatMessageBodyHashMatches } from './chat-message-body'

const identity = { messageId: 'message', sourceSessionId: 'source', targetSessionId: 'target', conversationId: 'pair', incoming: true, messageRevision: 0 }
const detail = { id: 'message', message_id: 'message', source_session_id: 'source', target_session_id: 'target', conversation_id: 'pair', conversation_mode: 'async_route_v1', body: 'Original message', message_revision: 0 } as CrossChatHandoff

await test('authenticated body rejects other participants, messages, revisions and mailbox modes', () => {
  assert.equal(authenticatedChatMessageBody(detail, identity), detail.body)
  for (const patch of [{ id: 'other' }, { message_id: 'other' }, { source_session_id: 'other' }, { target_session_id: 'other' }, { conversation_id: 'other' }, { conversation_mode: undefined }, { message_revision: 1 }]) {
    assert.throws(() => authenticatedChatMessageBody({ ...detail, ...patch }, identity))
  }
  assert.throws(() => authenticatedChatMessageBody(detail, { ...identity, mailbox: true }))
  assert.equal(authenticatedChatMessageBody({ ...detail, delivery_mode: 'mailbox' }, { ...identity, mailbox: true }), detail.body)
})

await test('recipient edits use only the matching target body while sender content remains original', () => {
  const edited = { ...detail, message_revision: 2, message_edited_by_user: true, target_body: 'Edited target message' }
  assert.equal(authenticatedChatMessageBody(edited, { ...identity, messageRevision: 2, editedByUser: true }), edited.target_body)
  assert.equal(authenticatedChatMessageBody(edited, { ...identity, incoming: false, messageRevision: 2 }), detail.body)
  assert.equal(authenticatedChatMessageBody(edited, { ...identity, incoming: false, messageRevision: 0 }), detail.body)
  assert.throws(() => authenticatedChatMessageBody({ ...edited, target_body: undefined }, { ...identity, messageRevision: 2 }))
  assert.throws(() => authenticatedChatMessageBody({ ...edited, message_edited_by_user: false }, { ...identity, messageRevision: 2 }))
  assert.throws(() => authenticatedChatMessageBody(edited, { ...identity, messageRevision: undefined }))
  for (const message_revision of [2, -1, 1.5, NaN]) {
    assert.throws(() => authenticatedChatMessageBody({ ...detail, message_revision }, { ...identity, messageRevision: undefined }))
  }
  assert.throws(() => authenticatedChatMessageBody({ ...edited, message_edited_by_user: undefined }, { ...identity, messageRevision: undefined }))
})

await test('queue legacy detail accepts an omitted queue identifier but rejects a different owner', () => {
  assert.equal(authenticatedChatMessageBody({ ...detail, message_id: undefined }, { ...identity, queuedId: 'queue' }), detail.body)
  assert.throws(() => authenticatedChatMessageBody({ ...detail, queued_id: 'other' }, { ...identity, queuedId: 'queue' }))
  assert.throws(() => authenticatedChatMessageBody({ ...detail, message_id: 'other' }, { ...identity, queuedId: 'queue' }))
})

await test('SHA-256 validates UTF-8 bodies, not previews, stale source bodies, or malformed digests', () => {
  for (const body of ['', 'abc', '跨聊天🙂\n**hello**']) {
    const hash = createHash('sha256').update(body).digest('hex')
    assert.equal(chatMessageBodyHashMatches(body, hash), true)
    assert.equal(chatMessageBodyHashMatches(body, hash.toUpperCase()), true)
    assert.equal(chatMessageBodyHashMatches(`${body}x`, hash), false)
    assert.equal(authenticatedChatMessageBody({ ...detail, body }, { ...identity, bodyHash: hash }), body)
    assert.throws(() => authenticatedChatMessageBody({ ...detail, body: `${body}x` }, { ...identity, bodyHash: hash }))
  }
  assert.equal(chatMessageBodyHashMatches('abc', 'not-a-hash'), false)
})
