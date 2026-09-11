import type { Session } from '@shared/types'
import { useAppStore } from '../store/app-store'

export type CodexPermissionPatch = Pick<
  Session,
  'codex_approval_policy' | 'codex_sandbox_mode' | 'codex_permission_profile' | 'codex_approvals_reviewer'
>

const pendingBySession = new Map<string, Promise<void>>()

export function queueCodexPermissionUpdate(sessionId: string, patch: CodexPermissionPatch): Promise<void> {
  const previous = pendingBySession.get(sessionId) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(async () => {
    // Permission changes may already be queued when a server/profile switch
    // begins. The workspace flush waits for this queue before changing the
    // active server, so let those captured writes finish against the old one.
    await useAppStore.getState().updateSession(sessionId, patch, { allowDuringWorkspaceFlush: true })
    const updated = useAppStore.getState().sessions.find(candidate => candidate.id === sessionId)
    if (!updated || Object.entries(patch).some(([key, value]) => updated[key as keyof Session] !== value)) {
      throw new Error(useAppStore.getState().error || 'Could not update Codex permissions.')
    }
  })
  const tracked = operation.finally(() => {
    if (pendingBySession.get(sessionId) === tracked) pendingBySession.delete(sessionId)
  })
  pendingBySession.set(sessionId, tracked)
  void tracked.catch(() => undefined)
  return operation
}

export function awaitCodexPermissionUpdates(sessionId: string): Promise<void> {
  return pendingBySession.get(sessionId) ?? Promise.resolve()
}

export async function awaitAllCodexPermissionUpdates(): Promise<void> {
  while (pendingBySession.size > 0) {
    await Promise.all([...new Set(pendingBySession.values())])
  }
}
