import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import { digestTargetSections, rankSessionsForSearch, sessionNameMatchRank } from './sessions'

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

describe('digest target sections', () => {
  it('matches sidebar order while excluding archived and source chats', () => {
    const sessions = [
      session('source', 'Source', { pinned: true }),
      session('pinned', 'Pinned target', { pinned: true, folder: 'Research' }),
      session('general', 'General target', { folder: 'General' }),
      session('research', 'Research target', { folder: 'Research' }),
      session('archived', 'Archived target', { folder: 'Research', archived: true })
    ]

    expect(digestTargetSections(sessions, ['Research', 'General'], 'source')).toEqual([
      { id: 'pinned', title: 'Pinned', sessions: [sessions[1]] },
      { id: 'folder:Research', title: 'Research', sessions: [sessions[3]] },
      { id: 'folder:General', title: 'General', sessions: [sessions[2]] }
    ])
  })

  it('filters targets without changing their section order', () => {
    const sessions = [
      session('a', 'Renderer audit', { folder: 'Research' }),
      session('b', 'Training status', { folder: 'Jobs' })
    ]
    expect(digestTargetSections(sessions, ['Jobs', 'Research'], null, 'render').flatMap(section => section.sessions).map(item => item.id))
      .toEqual(['a'])
  })
})
