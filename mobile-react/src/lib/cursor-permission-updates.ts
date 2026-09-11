export interface CursorPermissionUpdateScope {
  profileId: string
  profileGeneration: number
  sessionId: string
}

const pendingByScope = new Map<string, Promise<void>>()

export function cursorPermissionScopeKey(scope: CursorPermissionUpdateScope): string {
  return `${scope.profileId}:${scope.profileGeneration}:${scope.sessionId}`
}

export function queueCursorPermissionUpdate(
  scope: CursorPermissionUpdateScope,
  update: () => Promise<void>,
): Promise<void> {
  const key = cursorPermissionScopeKey(scope)
  const previous = pendingByScope.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(update)
  const tracked = operation.finally(() => {
    if (pendingByScope.get(key) === tracked) pendingByScope.delete(key)
  })
  pendingByScope.set(key, tracked)
  void tracked.catch(() => undefined)
  return operation
}

export function awaitCursorPermissionUpdates(scope: CursorPermissionUpdateScope): Promise<void> {
  return pendingByScope.get(cursorPermissionScopeKey(scope)) ?? Promise.resolve()
}

export async function awaitAllCursorPermissionUpdates(): Promise<void> {
  while (pendingByScope.size > 0) {
    await Promise.all([...new Set(pendingByScope.values())])
  }
}
