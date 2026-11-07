import { beforeEach, describe, expect, it, vi } from 'vitest'
import { profileSessionKey } from './profile-scope'
import {
  COMPOSER_HISTORY_LIMIT,
  appendComposerHistory,
  caretAllowsHistoryStep,
  loadComposerHistory,
  recordComposerHistory,
  stepComposerHistory
} from './composer-history'

describe('composer history storage', () => {
  beforeEach(() => window.localStorage.clear())

  it('records prompts per chat, newest last, without consecutive duplicates', () => {
    recordComposerHistory('chat-a', 'first')
    recordComposerHistory('chat-a', 'second')
    recordComposerHistory('chat-a', 'second')
    recordComposerHistory('chat-b', 'other')
    expect(loadComposerHistory('chat-a')).toEqual(['first', 'second'])
    expect(loadComposerHistory('chat-b')).toEqual(['other'])
  })

  it('ignores blank prompts and caps the stored history', () => {
    let entries: string[] = []
    for (let index = 0; index < COMPOSER_HISTORY_LIMIT + 5; index++) entries = appendComposerHistory(entries, `prompt ${index}`)
    entries = appendComposerHistory(entries, '   ')
    expect(entries).toHaveLength(COMPOSER_HISTORY_LIMIT)
    expect(entries[0]).toBe('prompt 5')
    expect(entries.at(-1)).toBe(`prompt ${COMPOSER_HISTORY_LIMIT + 4}`)
  })

  it('treats corrupt storage as empty history', () => {
    window.localStorage.setItem('agentsdock:composer-history:v2:chat-a', '{not json')
    expect(loadComposerHistory('chat-a')).toEqual([])
    window.localStorage.setItem('agentsdock:composer-history:v2:chat-a', JSON.stringify(['ok', 3, '']))
    expect(loadComposerHistory('chat-a')).toEqual(['ok'])
  })

  it('isolates servers and unknown-identity profiles but shares aliases of a known server', () => {
    const scope = (profile: string, identity?: string) => profileSessionKey(profile, 'same-chat', identity)
    recordComposerHistory(scope('profile-a', 'server-a'), 'server A only')
    expect(loadComposerHistory(scope('profile-b', 'server-b'))).toEqual([])
    expect(loadComposerHistory(scope('profile-alias', 'server-a'))).toEqual(['server A only'])
    recordComposerHistory(scope('unknown-a'), 'profile A only')
    expect(loadComposerHistory(scope('unknown-b'))).toEqual([])
    // Learning a server identity must not adopt potentially unrelated history.
    expect(loadComposerHistory(scope('unknown-a', 'new-server'))).toEqual([])
  })

  it('does not adopt unscoped legacy history', () => {
    window.localStorage.setItem('agentsdock:composer-history:chat-a', JSON.stringify(['unattributed']))
    expect(loadComposerHistory(profileSessionKey('profile-a', 'chat-a'))).toEqual([])
  })

  it('bounds loaded history and preserves previous data if storage is full', () => {
    const key = 'agentsdock:composer-history:v2:chat-a'
    const saved = JSON.stringify(Array.from({length: 105}, (_, i) => `prompt ${i}`))
    window.localStorage.setItem(key, saved)
    expect(loadComposerHistory('chat-a')).toHaveLength(100)
    const set = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError')
    })
    try {
      expect(() => recordComposerHistory('chat-a', 'new prompt')).not.toThrow()
      expect(set).toHaveBeenCalledOnce()
      expect(window.localStorage.getItem(key)).toBe(saved)
    } finally { set.mockRestore() }
  })
})

describe('stepComposerHistory', () => {
  const entries = ['one', 'two', 'three']

  it('walks older from an empty draft and back to an empty draft', () => {
    let step = stepComposerHistory(entries, null, '', 'older')
    expect(step).toEqual({ cursor: 2, text: 'three' })
    step = stepComposerHistory(entries, step!.cursor, step!.text, 'older')
    expect(step).toEqual({ cursor: 1, text: 'two' })
    step = stepComposerHistory(entries, step!.cursor, step!.text, 'newer')
    expect(step).toEqual({ cursor: 2, text: 'three' })
    step = stepComposerHistory(entries, step!.cursor, step!.text, 'newer')
    expect(step).toEqual({ cursor: null, text: '' })
  })

  it('stops at the oldest entry', () => {
    expect(stepComposerHistory(entries, 0, 'one', 'older')).toBeNull()
  })

  it('never replaces a draft the user typed or edited', () => {
    expect(stepComposerHistory(entries, null, 'unsent work', 'older')).toBeNull()
    expect(stepComposerHistory(entries, 1, 'two, edited', 'older')).toBeNull()
    expect(stepComposerHistory(entries, 1, 'two, edited', 'newer')).toBeNull()
  })

  it('does nothing without history or when ArrowDown is pressed on a fresh draft', () => {
    expect(stepComposerHistory([], null, '', 'older')).toBeNull()
    expect(stepComposerHistory(entries, null, '', 'newer')).toBeNull()
  })
})

describe('caretAllowsHistoryStep', () => {
  it('only recalls from the first line going up and the last line going down', () => {
    const text = 'line one\nline two'
    expect(caretAllowsHistoryStep(text, 3, 3, 'older')).toBe(true)
    expect(caretAllowsHistoryStep(text, 12, 12, 'older')).toBe(false)
    expect(caretAllowsHistoryStep(text, 12, 12, 'newer')).toBe(true)
    expect(caretAllowsHistoryStep(text, 3, 3, 'newer')).toBe(false)
  })

  it('leaves selections alone', () => {
    expect(caretAllowsHistoryStep('abc', 0, 2, 'older')).toBe(false)
  })
})
