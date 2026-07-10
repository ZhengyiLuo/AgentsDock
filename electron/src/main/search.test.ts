import { describe, expect, it } from 'vitest'
import type { Event } from '../shared/types'
import { searchEventRole, searchableEventText, searchSnippet, searchTokens } from './search'

const event = (type: string, patch: Partial<Event> = {}): Event => ({
  id: 'event-1', session_id: 'chat-1', seq: 1, type, ts: '2026-07-09T10:00:00Z', ...patch
})

describe('timeline history search', () => {
  it('keeps quoted phrases together and combines them with ordinary terms', () => {
    expect(searchTokens('renderer "force gate" audit')).toEqual(['renderer', 'force gate', 'audit'])
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
})
