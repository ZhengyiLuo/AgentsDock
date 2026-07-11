import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import { rankSessionsForSearch, sessionNameMatchRank } from './sessions'

const session = (id: string, title: string, patch: Partial<Session> = {}): Session => ({
  id,
  title,
  backend: 'codex',
  ...patch
})

describe('chat search ranking', () => {
  it('ranks exact, prefix, word-prefix, and substring title matches ahead of content matches', () => {
    const sessions = [
      session('content', 'Unrelated chat'),
      session('substring', 'Prerenderer audit'),
      session('word-prefix', 'Audit Renderer'),
      session('prefix', 'Renderer follow-up'),
      session('exact', 'Renderer')
    ]
    expect(rankSessionsForSearch(sessions, 'renderer', new Set(['content'])).map(item => item.id))
      .toEqual(['exact', 'prefix', 'word-prefix', 'substring', 'content'])
  })

  it('places transcript matches before incidental metadata matches', () => {
    const sessions = [
      session('metadata', 'Other', { cwd: '/work/renderer' }),
      session('content', 'Another')
    ]
    expect(rankSessionsForSearch(sessions, 'renderer', new Set(['content'])).map(item => item.id))
      .toEqual(['content', 'metadata'])
  })

  it('preserves the original order without a query', () => {
    const sessions = [session('a', 'B'), session('b', 'A')]
    expect(rankSessionsForSearch(sessions, '', new Set())).toBe(sessions)
    expect(sessionNameMatchRank(sessions[0], '')).toBe(0)
  })
})
