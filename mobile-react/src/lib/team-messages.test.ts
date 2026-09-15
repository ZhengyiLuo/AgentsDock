import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { parseTeamMessage, parseTeamMessageCapabilities, parseTeamMessagePage, parseTeamReadReceipt, parseTeamDismissal, teamMessageUnread, teamMailReplyAvailable } from './team-messages'
const receiver = { kind: 'server', id: 'own', display_name: 'Own server', state: 'available' }
const body = 'Verified **mail**'
const message = (patch = {}) => ({ id: 'm1', sequence: 1, kind: 'message', title: null, preview: body, body, body_bytes: Buffer.byteLength(body), body_sha256: createHash('sha256').update(body).digest('hex'), body_format: 'markdown', sender: { kind: 'server', id: 'peer', display_name: 'Peer' }, recipients: [receiver], delivery: receiver, attachments: [], skill: null, in_reply_to_message_id: null, created_at: '2026-09-14T12:00:00Z', ...patch })
const page = (patch = {}) => ({ box: 'inbox', address: { kind: 'server', id: 'own' }, messages: [message()], next_after_sequence: 1, has_more: false, ...patch })
test('Mail detail hash and identity are verified; no provider text is inferred', () => {
  assert.equal(parseTeamMessage(message(), 'm1', true).body, body)
  for (const patch of [{ body: 'edited' }, { body_sha256: 'a'.repeat(64) }, { body_bytes: 1 }, { id: 'other' }, { skill: { id: 'skill' } }]) assert.throws(() => parseTeamMessage(message(patch), 'm1', true))
})
test('Mail paging binds mailbox and exact advancing bounded sequence', () => {
  assert.equal(parseTeamMessagePage(page(), 'inbox', 'own').messages.length, 1)
  for (const patch of [{ address: { kind: 'server', id: 'other' } }, { next_after_sequence: 0 }, { messages: [], has_more: true }, { messages: [message(), message()] }, { messages: [message({ delivery: null })] }]) assert.throws(() => parseTeamMessagePage(page(patch), 'inbox', 'own'))
  assert.throws(() => parseTeamMessagePage(page(), 'inbox', 'own', 1))
  assert.throws(() => parseTeamMessagePage(page({ messages: Array.from({ length: 26 }, (_, i) => message({ id: `m${i}`, sequence: i + 1 })), next_after_sequence: 26 }), 'inbox', 'own'))
})
test('revisioned read receipts require exact address, value and next revision', () => {
  const receipt = { message_id: 'm1', recipients: [{ ...receiver, state: 'read' }], mailbox_state: { address_kind: 'server', address_id: 'own', unread: false, version: 2 } }
  assert.equal(parseTeamReadReceipt(receipt, 'm1', 'own', { unread: false, version: 1 }).mailbox_state?.version, 2)
  for (const patch of [{ message_id: 'other' }, { recipients: [{ ...receiver, id: 'other', state: 'read' }] }, { mailbox_state: { ...receipt.mailbox_state, version: 3 } }, { mailbox_state: { ...receipt.mailbox_state, unread: true } }]) assert.throws(() => parseTeamReadReceipt({ ...receipt, ...patch }, 'm1', 'own', { unread: false, version: 1 }))
})
test('dismissal is address-specific and a malformed receipt never removes content', () => {
  const value = { dismissed: true, message_id: 'm1', address: { kind: 'server', id: 'own' } }
  assert.doesNotThrow(() => parseTeamDismissal(value, 'm1', 'own'))
  assert.throws(() => parseTeamDismissal({ ...value, dismissed: false }, 'm1', 'own'))
  assert.throws(() => parseTeamDismissal(value, 'm1', 'other'))
})
test('private unread state overrides old read receipts; Reply requires owned incoming server delivery', () => {
  const value = parseTeamMessage(message({ delivery: { ...receiver, state: 'read' }, mailbox_state: { address_kind: 'server', address_id: 'own', unread: true, version: 3 } }))
  assert.equal(teamMessageUnread(value, 'own'), true)
  assert.equal(teamMailReplyAvailable(value, 'own'), true)
  for (const patch of [{ sender: { kind: 'human', id: 'human', display_name: 'Human' } }, { sender: { ...value.sender, id: 'own' } }, { delivery: null }, { recipients: [{ kind: 'all', id: 'all', display_name: 'All', state: 'available' }], delivery: null }]) assert.equal(teamMailReplyAvailable(parseTeamMessage(message(patch)), 'own'), false)
})
test('optional mailbox capabilities are exact-version and identity gated', () => {
  const hub = { hub_id: 'hub', capabilities: { team_messages_v1: { available: true, version: 1 }, team_mailbox_state_v1: { available: true, version: 1, address_kinds: ['server'] } } }
  assert.equal(parseTeamMessageCapabilities(hub, 'hub').mailboxState, true)
  assert.throws(() => parseTeamMessageCapabilities(hub, 'other'))
  assert.equal(parseTeamMessageCapabilities({ ...hub, capabilities: { ...hub.capabilities, team_mailbox_state_v1: { available: true, version: 2, address_kinds: ['server'] } } }).mailboxState, false)
})
