import assert from 'node:assert/strict'
import type { Event } from '../types'
import {
  inlineRoutePresentation,
  inlineRouteReferenceIsInteractive,
  prepareInlineRouteMarkdown,
  restoreInlineRouteMarkerText,
  splitInlineRouteMarkerText,
  splitInlineRouteText,
  timelineChatReferenceIsRemote,
  timelineInlineReferencesForText,
} from './timeline-inline-references'

const events: Event[] = [
  {
    id: 'one', seq: 1, session_id: 'source', type: 'user_text', ts: '2026-09-02T12:00:00Z',
    text: '  Ask @Alpha now  ',
    chat_references: [{ session_id: 'alpha', display_title_snapshot: 'Alpha', source_text_start: 6, source_text_end: 12, action: 'route', grant_intent: true }],
  },
  {
    id: 'two', seq: 2, session_id: 'source', type: 'user_text', ts: '2026-09-02T12:00:01Z',
    text: 'Then @Beta',
    chat_references: [{ session_id: 'beta', display_title_snapshot: 'Beta', source_text_start: 5, source_text_end: 10, action: 'route', grant_intent: true }],
  },
]

const presentation = inlineRoutePresentation(events)
assert.equal(presentation.text, 'Ask @Alpha now\n\nThen @Beta')
assert.deepEqual(presentation.references.map(reference => [reference.session_id, reference.source_text_start, reference.source_text_end]), [
  ['alpha', 4, 10],
  ['beta', 21, 26],
])
assert.deepEqual(splitInlineRouteText(presentation.text, presentation.references).map(segment => [segment.text, segment.reference?.session_id]), [
  ['Ask ', undefined],
  ['@Alpha', 'alpha'],
  [' now\n\nThen ', undefined],
  ['@Beta', 'beta'],
])

assert.deepEqual(
  splitInlineRouteText('Ask @Al', presentation.references).map(segment => segment.text),
  ['Ask @Al'],
  'a folded marker boundary must stay plain text instead of becoming a partial route',
)

const markdown = prepareInlineRouteMarkdown(presentation.text, presentation.references, 'source')
assert.equal(markdown.markers.length, 2)
assert(!markdown.text.includes('@Alpha'))
assert.deepEqual(splitInlineRouteMarkerText(markdown.text, markdown.markers).map(segment => [segment.text, segment.reference?.session_id]), [
  ['Ask ', undefined],
  ['@Alpha', 'alpha'],
  [' now\n\nThen ', undefined],
  ['@Beta', 'beta'],
])
assert.equal(restoreInlineRouteMarkerText(markdown.text, markdown.markers), presentation.text)

const formattedText = '**Ask @Alpha** and keep `code` plus [a link](https://example.com).'
const formattedReference = [{
  session_id: 'alpha', display_title_snapshot: 'Alpha', source_text_start: 6, source_text_end: 12, action: 'route' as const, grant_intent: true as const,
}]
const formatted = prepareInlineRouteMarkdown(formattedText, formattedReference, 'source')
assert(formatted.text.startsWith('**Ask '), 'Markdown delimiters surrounding a route must remain in the source')
assert(formatted.text.endsWith('and keep `code` plus [a link](https://example.com).'))
assert.equal(restoreInlineRouteMarkerText(formatted.text, formatted.markers), formattedText)

const legacyText = 'Review @@Archive now'
const legacyReference = {
  session_id: 'archive', display_title_snapshot: 'Archive', source_text_start: 7, source_text_end: 16,
  action: 'route' as const,
}
const legacy = prepareInlineRouteMarkdown(legacyText, [legacyReference], 'source')
assert.equal(legacy.markers.length, 1, 'historical @@ routes remain structured timeline references')
assert.equal(legacy.markers[0]?.displayText, '@@Archive', 'the authored historical marker must not be rewritten')
assert.equal(restoreInlineRouteMarkerText(legacy.text, legacy.markers), legacyText)
assert.equal(inlineRouteReferenceIsInteractive(legacyReference), true, 'same-server legacy history can navigate by immutable id')

const remoteText = 'Ask @Studio reviewer to verify this.'
const remoteReference = {
  session_id: 'a778341c-a5bd-411c-8a6a-4ace41d913ea',
  display_title_snapshot: 'Studio reviewer',
  source_text_start: 4,
  source_text_end: 20,
  action: 'instruction' as const,
  target_kind: 'secure_peer' as const,
  target_server_identity: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  target_connection_id: '09d7bb2e-3b47-4be7-89fc-2cecd90f4434',
  target_route_id: 'a778341c-a5bd-411c-8a6a-4ace41d913ea',
  target_route_revision: 'rev_0123456789abcdef0123456789abcdef',
}
const remote = prepareInlineRouteMarkdown(remoteText, [remoteReference], 'source')
assert.equal(remote.markers.length, 1, 'an exact bound secure-peer instruction remains inline')
assert.equal(remote.markers[0]?.displayText, '@Studio reviewer')
assert.equal(timelineChatReferenceIsRemote(remoteReference), true)
assert.equal(inlineRouteReferenceIsInteractive(remoteReference), false, 'remote routes must never attempt local navigation')

const modernText = 'Ask @Local reviewer now'
const modernReference = {
  session_id: 'local', display_title_snapshot: 'Local reviewer', source_text_start: 4, source_text_end: 19,
  action: 'route' as const, grant_intent: true as const,
}
assert.deepEqual(timelineInlineReferencesForText(modernText, [modernReference], 'source'), [modernReference])
assert.equal(inlineRouteReferenceIsInteractive(modernReference), true)

const invalidEvent: Event = {
  id: 'invalid', seq: 3, session_id: 'source', type: 'user_text', ts: '2026-09-02T12:00:02Z',
  text: modernText,
  chat_references: [{ ...modernReference, source_text_start: 5, source_text_end: 20 }],
}
const invalid = inlineRoutePresentation([invalidEvent])
assert.equal(invalid.references.length, 0, 'span-mismatched history must not become interactive')
assert.equal(invalid.fallbackReferences.length, 1, 'span-mismatched structured history remains visible as a fallback')

const foldedText = `${'x'.repeat(3_400)} @Later`
const laterStart = foldedText.indexOf('@Later')
const laterReference = {
  session_id: 'later', display_title_snapshot: 'Later', source_text_start: laterStart,
  source_text_end: laterStart + '@Later'.length, action: 'route' as const,
}
assert.equal(timelineInlineReferencesForText(foldedText, [laterReference], 'source').length, 1)
assert.equal(
  timelineInlineReferencesForText(`${foldedText.slice(0, 3_200)}\n\n…`, [laterReference], 'source').length,
  0,
  'a route beyond the folded preview must remain noninteractive until expansion',
)
