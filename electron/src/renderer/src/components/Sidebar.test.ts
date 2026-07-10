import { describe, expect, it } from 'vitest'
import { reorderFolderList } from './Sidebar'

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
