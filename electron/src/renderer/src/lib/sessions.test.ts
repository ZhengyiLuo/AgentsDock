import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import { digestTargetSections, isUntouchedNewChat, rankSessionsForSearch, sessionNameMatchRank } from './sessions'

const session = (id: string, title: string, patch: Partial<Session> = {}): Session => ({
  id,
  title,
  backend: 'codex',
  ...patch
})

describe('untouched new chat detection', () => {
  const placeholder = (): Session => session('placeholder', 'New chat', {
    backend_locked: false,
    latest_event_seq: 1,
    latest_event_type: 'session_created'
  })

  it('recognizes only a pristine direct-create placeholder', () => {
    expect(isUntouchedNewChat(placeholder())).toBe(true)
    expect(isUntouchedNewChat({ ...placeholder(), latest_event_seq: undefined, latest_event_type: undefined })).toBe(true)
    expect(isUntouchedNewChat({ ...placeholder(), title: 'Renamed' })).toBe(false)
    expect(isUntouchedNewChat({ ...placeholder(), latest_event_seq: 2, latest_event_type: 'user_message' })).toBe(false)
    expect(isUntouchedNewChat({ ...placeholder(), pinned: true })).toBe(false)
  })

  it('preserves a first turn before its provider ID has arrived', () => {
    expect(isUntouchedNewChat({ ...placeholder(), backend_locked: true })).toBe(false)
    expect(isUntouchedNewChat({ ...placeholder(), codex_thread_id: 'thread-1' })).toBe(false)
  })
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

  it('finds a chat by its immutable AgentsDock session ID', () => {
    const sessions = [session('sess_abc123', 'Renamed chat'), session('sess_other', 'Other')]
    expect(rankSessionsForSearch(sessions, 'sess_abc123', new Set()).map(item => item.id))
      .toEqual(['sess_abc123'])
  })

  it('preserves the original order without a query', () => {
    const sessions = [session('a', 'B'), session('b', 'A')]
    expect(rankSessionsForSearch(sessions, '', new Set())).toBe(sessions)
    expect(sessionNameMatchRank(sessions[0], '')).toBe(0)
  })

  it('searches archived chats by title only', () => {
    const sessions = [
      session('archived-title', 'Renderer archive', { archived: true }),
      session('archived-content', 'Old work', { archived: true, cwd: '/work/renderer' }),
      session('active-content', 'Current work')
    ]
    expect(rankSessionsForSearch(sessions, 'renderer', new Set(['archived-content', 'active-content'])).map(item => item.id))
      .toEqual(['archived-title', 'active-content'])
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
