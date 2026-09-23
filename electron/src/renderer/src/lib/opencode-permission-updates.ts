import { t } from '@shared/i18n'
import type { Session } from '@shared/types'
import { useAppStore } from '../store/app-store'

export type OpenCodePermissionPatch = Pick<Session, 'opencode_permission_mode'>

const pendingBySession = new Map<string, Promise<void>>()

export function queueOpenCodePermissionUpdate(sessionId: string, patch: OpenCodePermissionPatch): Promise<void> {
  const previous = pendingBySession.get(sessionId) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(async () => {
    // Captured writes must be allowed to finish while workspace switching waits
    // for this queue; otherwise the selected mode and the next turn can race.
    await useAppStore.getState().updateSession(sessionId, patch, { allowDuringWorkspaceFlush: true })
    const updated = useAppStore.getState().sessions.find(candidate => candidate.id === sessionId)
    if (!updated || Object.entries(patch).some(([key, value]) => updated[key as keyof Session] !== value)) {
      throw new Error(useAppStore.getState().error || t('opencode.permissions.saveFailed'))
    }
  })
  const tracked = operation.finally(() => {
    if (pendingBySession.get(sessionId) === tracked) pendingBySession.delete(sessionId)
  })
  pendingBySession.set(sessionId, tracked)
  void tracked.catch(() => undefined)
  return operation
}

export function awaitOpenCodePermissionUpdates(sessionId: string): Promise<void> {
  return pendingBySession.get(sessionId) ?? Promise.resolve()
}

export async function awaitAllOpenCodePermissionUpdates(): Promise<void> {
  while (pendingBySession.size > 0) {
    await Promise.all([...new Set(pendingBySession.values())])
  }
}
