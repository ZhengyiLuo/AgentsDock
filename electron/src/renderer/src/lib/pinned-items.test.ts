import { describe, expect, it } from 'vitest'
import type { PinnedItem } from '@shared/types'
import { filePinHasExplicitOwner, pinnedItemsForSession } from './pinned-items'

function pin(overrides: Partial<PinnedItem> = {}): PinnedItem {
  return {
    id: 'file:file-1',
    sessionId: 'chat-1',
    kind: 'file',
    fileId: 'file-1',
    title: 'File',
    createdAt: 1,
    ...overrides
  }
}

describe('pinned item ownership', () => {
  it('rejects pins stored under a different chat', () => {
    expect(pinnedItemsForSession([pin({ sessionId: 'chat-2' })], 'chat-1')).toEqual([])
  })

  it('rejects a file pin with explicit ownership by another chat', () => {
    expect(pinnedItemsForSession([pin({ fileSessionId: 'chat-2' })], 'chat-1')).toEqual([])
  })

  it('keeps legacy pins provisional but does not treat them as explicitly owned', () => {
    const legacy = pin({ filename: 'cached-name.txt', source_path: '/foreign/cached-name.txt' })
    expect(pinnedItemsForSession([legacy], 'chat-1')).toEqual([legacy])
    expect(filePinHasExplicitOwner(legacy, 'chat-1')).toBe(false)
  })

  it('recognizes current file pins with persisted ownership', () => {
    const current = pin({ fileSessionId: 'chat-1' })
    expect(pinnedItemsForSession([current], 'chat-1')).toEqual([current])
    expect(filePinHasExplicitOwner(current, 'chat-1')).toBe(true)
  })
})
