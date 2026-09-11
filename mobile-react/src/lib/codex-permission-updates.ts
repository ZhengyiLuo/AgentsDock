export interface CodexPermissionUpdateScope {
  profileId: string
  profileGeneration: number
  sessionId: string
}

const pendingByScope = new Map<string, Promise<void>>()

export function codexPermissionScopeKey(scope: CodexPermissionUpdateScope): string {
  return `${scope.profileId}:${scope.profileGeneration}:${scope.sessionId}`
}

export function queueCodexPermissionUpdate(
  scope: CodexPermissionUpdateScope,
  update: () => Promise<void>,
): Promise<void> {
  const key = codexPermissionScopeKey(scope)
  const previous = pendingByScope.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(update)
  const tracked = operation.finally(() => {
    if (pendingByScope.get(key) === tracked) pendingByScope.delete(key)
  })
  pendingByScope.set(key, tracked)
  void tracked.catch(() => undefined)
  return operation
}

export function awaitCodexPermissionUpdates(scope: CodexPermissionUpdateScope): Promise<void> {
  return pendingByScope.get(codexPermissionScopeKey(scope)) ?? Promise.resolve()
}

export async function awaitAllCodexPermissionUpdates(): Promise<void> {
  while (pendingByScope.size > 0) {
    await Promise.all([...new Set(pendingByScope.values())])
  }
}
