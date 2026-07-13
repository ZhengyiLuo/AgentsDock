import { describe, expect, it } from 'vitest'
import type { Event } from '../shared/types'
import { mergeTimelineSearchResults, searchEventRole, searchableEventText, searchEventsAcrossSessions, searchFtsQuery, searchSnippet, searchTokens } from './search'

const event = (type: string, patch: Partial<Event> = {}): Event => ({
  id: 'event-1', session_id: 'chat-1', seq: 1, type, ts: '2026-07-09T10:00:00Z', ...patch
})

describe('timeline history search', () => {
  it('keeps quoted phrases together and combines them with ordinary terms', () => {
    expect(searchTokens('renderer "force gate" audit')).toEqual(['renderer', 'force gate', 'audit'])
    expect(searchFtsQuery('renderer "force gate" audit')).toBe('"renderer"* AND "force gate" AND "audit"*')
  })

  it('indexes complete assistant and structured error text', () => {
    expect(searchableEventText(event('assistant_text', { text: 'The full renderer audit passed.' })))
      .toBe('The full renderer audit passed.')
    expect(searchableEventText(event('error', { error: { error: { message: 'Provider overloaded' } } })))
      .toContain('Provider overloaded')
    expect(searchEventRole(event('error'))).toBe('error')
  })

  it('centers a bounded snippet around the matching text', () => {
    const text = `${'before '.repeat(30)}needle ${'after '.repeat(30)}`
    const snippet = searchSnippet(text, ['needle'], 90)
    expect(snippet).toContain('needle')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('returns the newest matching event once per chat', () => {
    const events = [
      event('assistant_text', { id: 'new-a', session_id: 'chat-a', seq: 8, text: 'Force gate audit complete.' }),
      event('assistant_text', { id: 'old-a', session_id: 'chat-a', seq: 2, text: 'Force gate setup.' }),
      event('turn_started', { id: 'user-b', session_id: 'chat-b', seq: 4, prompt: 'Run the force gate audit.' }),
      event('assistant_text', { id: 'other', session_id: 'chat-c', seq: 9, text: 'Unrelated.' })
    ]
    expect(searchEventsAcrossSessions(events, '"force gate" audit', 10)).toEqual([
      expect.objectContaining({ session_id: 'chat-a', event_id: 'new-a', role: 'assistant' }),
      expect.objectContaining({ session_id: 'chat-b', event_id: 'user-b', role: 'user' })
    ])
  })

  it('keeps every in-chat match but collapses the global result list by chat', () => {
    const first = { session_id: 'chat-a', event_id: 'first', seq: 1, role: 'assistant' as const, snippet: 'first' }
    const second = { session_id: 'chat-a', event_id: 'second', seq: 2, role: 'assistant' as const, snippet: 'second' }
    expect(mergeTimelineSearchResults([first, second], [], 10, false).map(result => result.event_id))
      .toEqual(['second', 'first'])
    expect(mergeTimelineSearchResults([first, second], [], 10, true).map(result => result.event_id))
      .toEqual(['second'])
  })
})
