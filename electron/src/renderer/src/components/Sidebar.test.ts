import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import { buildSections, reorderFolderList, resolveSidebarDrop, SIDEBAR_LONG_PRESS } from './Sidebar'

describe('gesture reorder activation', () => {
  it('requires a deliberate hold while tolerating small pointer movement', () => {
    expect(SIDEBAR_LONG_PRESS).toEqual({ delay: 280, tolerance: 6 })
  })
})

describe('folder ordering', () => {
  it('moves a folder before another folder', () => {
    expect(reorderFolderList(['Pinned work', 'Jobs', 'General'], 'General', 'Jobs', 'before'))
      .toEqual(['Pinned work', 'General', 'Jobs'])
  })

  it('moves a folder after another folder', () => {
    expect(reorderFolderList(['Pinned work', 'Jobs', 'General'], 'Pinned work', 'Jobs', 'after'))
      .toEqual(['Jobs', 'Pinned work', 'General'])
  })

  it('does not corrupt the order for stale or self drops', () => {
    const folders = ['Pinned work', 'Jobs', 'General']
    expect(reorderFolderList(folders, 'Jobs', 'Jobs', 'after')).toBe(folders)
    expect(reorderFolderList(folders, 'Missing', 'Jobs', 'before')).toBe(folders)
  })
})

describe('sidebar drop resolution', () => {
  it('commits a chat reorder only after a same-section drop', () => {
    expect(resolveSidebarDrop(
      'session:a',
      { type: 'session', section: 'folder:Jobs' },
      'session:b',
      { type: 'session', section: 'folder:Jobs' },
      { id: 'session:b', placement: 'after' },
      ['Jobs', 'General']
    )).toEqual({ kind: 'reorder-session', sessionId: 'a', targetId: 'b', placement: 'after' })
    expect(resolveSidebarDrop(
      'session:a',
      { type: 'session', section: 'folder:Jobs' },
      'session:b',
      { type: 'session', section: 'folder:General' },
      { id: 'session:b', placement: 'after' },
      ['Jobs', 'General']
    )).toBeNull()
  })

  it('moves a chat onto a folder header', () => {
    expect(resolveSidebarDrop(
      'session:a',
      { type: 'session', section: 'folder:Jobs' },
      'folder:General',
      { type: 'folder' },
      { id: 'folder:General', placement: 'inside' },
      ['Jobs', 'General']
    )).toEqual({ kind: 'move-session', sessionId: 'a', folder: 'General' })
  })

  it('preserves hidden folders when a visible folder is reordered', () => {
    expect(resolveSidebarDrop(
      'folder:General',
      { type: 'folder' },
      'folder:Jobs',
      { type: 'folder' },
      { id: 'folder:Jobs', placement: 'before' },
      ['Pinned work', 'Jobs', 'General', 'Hidden']
    )).toEqual({ kind: 'reorder-folder', order: ['Pinned work', 'General', 'Jobs', 'Hidden'] })
  })

  it('does nothing for canceled and self drops', () => {
    expect(resolveSidebarDrop('session:a', { type: 'session', section: 'folder:Jobs' }, null, undefined, null, ['Jobs'])).toBeNull()
    expect(resolveSidebarDrop('session:a', { type: 'session', section: 'folder:Jobs' }, 'session:a', { type: 'session', section: 'folder:Jobs' }, { id: 'session:a', placement: 'after' }, ['Jobs'])).toBeNull()
  })
})

describe('sidebar history filtering', () => {
  it('keeps a chat whose transcript matches even when its metadata does not', () => {
    const sessions: Session[] = [
      { id: 'render', title: 'Renderer work', folder: 'Jobs', backend: 'codex' },
      { id: 'training', title: 'Training', folder: 'Jobs', backend: 'claude' }
    ]
    const sections = buildSections(sessions, ['Jobs'], 'waterbottle', new Set(['training']))
    expect(sections.flatMap(section => section.sessions).map(session => session.id)).toEqual(['training'])
  })
})
