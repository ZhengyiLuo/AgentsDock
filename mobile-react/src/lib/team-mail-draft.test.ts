import assert from 'node:assert/strict'
import test from 'node:test'
import { appendTeamMailDraft, type TeamMailDraftMessage } from './team-mail-draft'
const message: TeamMailDraftMessage = { teamId: 'team', messageId: 'message', senderId: 'sender', senderName: 'Peer', senderKind: 'server', title: 'Subject [safe]', section: 'mail', mailboxBox: 'inbox' }
test('Reply preserves draft and stages exact link and UTF-16 sender reference only', () => {
  const value = appendTeamMailDraft('🧭 Existing text', [], { message, intent: 'reply', expectedServerIdentity: 'server' })
  assert.match(value.text, /^🧭 Existing text\n\nReply to/)
  assert.match(value.text, /teamId=team&messageId=message&mailboxBox=inbox&serverIdentity=server/)
  assert.equal(value.text.slice(value.references[0].source_text_start, value.references[0].source_text_end), '@@Peer')
  assert.equal(value.references[0].target_id, 'sender')
})
test('unverified IDs, human senders and Bulletin replies never gain a sender grant', () => {
  for (const patch of [{ senderKind: 'human' }, { senderName: '@Peer' }, { senderName: 'bad\nname' }, { teamId: '../ team' }, { section: 'feed' }]) assert.throws(() => appendTeamMailDraft('', [], { message: { ...message, ...patch } as TeamMailDraftMessage, intent: 'reply', expectedServerIdentity: 'server' }))
})
