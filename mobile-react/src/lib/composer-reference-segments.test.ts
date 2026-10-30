import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composerReferenceSegments } from './composer-reference-segments'
import { insertChatReference, reconcileChatReferences } from './chat-references'

test('attributed references preserve exact UTF-16 draft text, Unicode and surrounding whitespace', () => {
  const initial = '🐳 hello @ and more\n'
  const start = initial.indexOf('@')
  const inserted = insertChatReference(initial, { kind: '@', start, end: start + 1, query: '' }, { id: 'target', title: '中文 🐈' }, 'route')
  const parts = composerReferenceSegments(inserted.text, [inserted.reference], 'source')
  assert.equal(parts.map(part => part.text).join(''), inserted.text)
  assert.equal(parts.filter(part => part.reference).length, 1)
  assert.equal(parts.find(part => part.reference)?.text, '@中文 🐈')
})

test('editing inside a name revokes styling and authority, while a plain @ string is not a reference', () => {
  const inserted = insertChatReference('@', { kind: '@', start: 0, end: 1, query: '' }, { id: 'target', title: 'Peer' }, 'route')
  const edited = '@Other '
  const references = reconcileChatReferences(inserted.text, edited, [inserted.reference])
  assert.deepEqual(references, [])
  assert.deepEqual(composerReferenceSegments(edited, references, 'source'), [{ key: 'text:0', text: edited, reference: false }])
  assert.deepEqual(composerReferenceSegments('', references, 'source'), [])
})
