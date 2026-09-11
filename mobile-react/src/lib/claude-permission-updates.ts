export interface ClaudePermissionUpdateScope {
  profileId: string
  profileGeneration: number
  sessionId: string
}

const pendingByScope = new Map<string, Promise<void>>()

export function claudePermissionScopeKey(scope: ClaudePermissionUpdateScope): string {
  return `${scope.profileId}:${scope.profileGeneration}:${scope.sessionId}`
}

export function queueClaudePermissionUpdate(
  scope: ClaudePermissionUpdateScope,
  update: () => Promise<void>,
): Promise<void> {
  const key = claudePermissionScopeKey(scope)
  const previous = pendingByScope.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(update)
  const tracked = operation.finally(() => {
    if (pendingByScope.get(key) === tracked) pendingByScope.delete(key)
  })
  pendingByScope.set(key, tracked)
  void tracked.catch(() => undefined)
  return operation
}

export function awaitClaudePermissionUpdates(scope: ClaudePermissionUpdateScope): Promise<void> {
  return pendingByScope.get(claudePermissionScopeKey(scope)) ?? Promise.resolve()
}

export async function awaitAllClaudePermissionUpdates(): Promise<void> {
  while (pendingByScope.size > 0) {
    await Promise.all([...new Set(pendingByScope.values())])
  }
}
