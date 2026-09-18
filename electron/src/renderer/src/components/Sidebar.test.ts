import { describe, expect, it } from 'vitest'
import type { Session } from '@shared/types'
import { buildSections, reorderFolderList, resolveSidebarDrop, sidebarFolderAssignmentPatch, sidebarReorderAnalyticsEvent, SIDEBAR_LONG_PRESS } from './Sidebar'

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
  it('separates same-folder reorder analytics from cross-folder movement', () => {
    expect(sidebarReorderAnalyticsEvent({
      kind: 'reorder-session', sessionId: 'a', targetId: 'b', placement: 'after'
    })).toBe('chat_reordered')
    expect(sidebarReorderAnalyticsEvent({
      kind: 'reorder-session', sessionId: 'a', targetId: 'b', placement: 'after', targetFolder: 'General'
    })).toBe('chat_moved_to_folder')
  })

  it('reorders a chat within its current folder', () => {
    expect(resolveSidebarDrop(
      'session:a',
      { type: 'session', section: 'folder:Jobs' },
      'session:b',
      { type: 'session', section: 'folder:Jobs' },
      { id: 'session:b', placement: 'after' },
      ['Jobs', 'General']
    )).toEqual({ kind: 'reorder-session', sessionId: 'a', targetId: 'b', placement: 'after' })
  })

  it('moves a chat directly before or after a chat in another folder', () => {
    expect(resolveSidebarDrop(
      'session:a',
      { type: 'session', section: 'folder:Jobs' },
      'session:b',
      { type: 'session', section: 'folder:General' },
      { id: 'session:b', placement: 'after' },
      ['Jobs', 'General']
    )).toEqual({
      kind: 'reorder-session',
      sessionId: 'a',
      targetId: 'b',
      placement: 'after',
      targetFolder: 'General'
    })
    expect(resolveSidebarDrop(
      'session:a',
      { type: 'session', section: 'folder:Jobs' },
      'session:b',
      { type: 'session', section: 'folder:General' },
      { id: 'session:b', placement: 'before' },
      ['Jobs', 'General']
    )).toEqual({
      kind: 'reorder-session',
      sessionId: 'a',
      targetId: 'b',
      placement: 'before',
      targetFolder: 'General'
    })
  })

  it('assigns pinned chats to a folder without changing their pinned state', () => {
    const patch = sidebarFolderAssignmentPatch('General')
    expect(patch).toEqual({ folder: 'General', archived: false })
    expect(patch).not.toHaveProperty('pinned')

    expect(resolveSidebarDrop(
      'session:pinned',
      { type: 'session', section: 'pinned' },
      'session:general',
      { type: 'session', section: 'folder:General' },
      { id: 'session:general', placement: 'before' },
      ['General']
    )).toEqual({ kind: 'move-session', sessionId: 'pinned', folder: 'General' })
  })

  it('moves archived chats into ordinary folders but not chats into virtual sections', () => {
    expect(resolveSidebarDrop(
      'session:archived',
      { type: 'session', section: 'archived' },
      'session:general',
      { type: 'session', section: 'folder:General' },
      { id: 'session:general', placement: 'before' },
      ['General']
    )).toEqual({
      kind: 'reorder-session',
      sessionId: 'archived',
      targetId: 'general',
      placement: 'before',
      targetFolder: 'General'
    })
    expect(resolveSidebarDrop(
      'session:general',
      { type: 'session', section: 'folder:General' },
      'session:pinned',
      { type: 'session', section: 'pinned' },
      { id: 'session:pinned', placement: 'after' },
      ['General']
    )).toBeNull()
    expect(resolveSidebarDrop(
      'session:general',
      { type: 'session', section: 'folder:General' },
      'session:archived',
      { type: 'session', section: 'archived' },
      { id: 'session:archived', placement: 'after' },
      ['General']
    )).toBeNull()
    expect(resolveSidebarDrop(
      'session:search',
      { type: 'session', section: 'search' },
      'session:general',
      { type: 'session', section: 'folder:General' },
      { id: 'session:general', placement: 'after' },
      ['General']
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
    expect(resolveSidebarDrop(
      'session:a',
      { type: 'session', section: 'folder:Jobs' },
      'folder:Jobs',
      { type: 'folder' },
      { id: 'folder:Jobs', placement: 'inside' },
      ['Jobs', 'General']
    )).toBeNull()
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

  it('reorders a folder when the pointer is over the target folder section', () => {
    expect(resolveSidebarDrop(
      'folder:General',
      { type: 'folder' },
      'folder:Jobs',
      { type: 'folder' },
      { id: 'folder:Jobs', placement: 'after' },
      ['General', 'Jobs', 'Hidden']
    )).toEqual({ kind: 'reorder-folder', order: ['Jobs', 'General', 'Hidden'] })
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

  it('puts chat-name matches ahead of transcript-only matches', () => {
    const sessions: Session[] = [
      { id: 'content', title: 'Training', folder: 'Jobs', backend: 'claude' },
      { id: 'name', title: 'Waterbottle renderer', folder: 'General', backend: 'codex' }
    ]
    const sections = buildSections(sessions, ['Jobs', 'General'], 'waterbottle', new Set(['content']))
    expect(sections).toHaveLength(1)
    expect(sections[0].title).toBe('Matches')
    expect(sections[0].sessions.map(session => session.id)).toEqual(['name', 'content'])
  })
})
