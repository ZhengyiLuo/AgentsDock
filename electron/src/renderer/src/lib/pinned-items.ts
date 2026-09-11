import type { PinnedItem, WorkspaceProfileScope } from '@shared/types'

export function requirePinnedItemsScope(scope: WorkspaceProfileScope | null): WorkspaceProfileScope {
  if (!scope) throw new Error('The server profile changed. Reopen this chat before changing pinned items.')
  return scope
}

export function pinnedItemBelongsToSession(item: PinnedItem, sessionId: string): boolean {
  if (item.sessionId !== sessionId) return false
  if (item.kind !== 'file') return true
  const fileOwner = String(item.fileSessionId ?? '').trim()
  return !fileOwner || fileOwner === sessionId
}

export function pinnedItemsForSession(items: PinnedItem[], sessionId: string): PinnedItem[] {
  return items.filter(item => pinnedItemBelongsToSession(item, sessionId))
}

export function filePinHasExplicitOwner(item: PinnedItem, sessionId: string): boolean {
  return item.kind === 'file' && item.fileSessionId === sessionId
}
