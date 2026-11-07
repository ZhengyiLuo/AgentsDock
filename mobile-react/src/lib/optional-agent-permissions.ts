import type { Health, RuntimeCatalog, Session } from '../types'

export type OptionalAgent = 'opencode' | 'gemini'
export type OptionalPermission = 'default' | 'full_access' | 'plan' | 'autoEdit' | 'yolo'
export const permissionLabels: Record<OptionalPermission, string> = { default: 'Default', full_access: 'Full access', plan: 'Plan only', autoEdit: 'Auto edit', yolo: 'YOLO' }

export function optionalPermissionModes(session: Session, health: Health | null, runtime: RuntimeCatalog | null): OptionalPermission[] {
  const known: OptionalPermission[] = session.backend === 'gemini' ? ['default', 'autoEdit', 'yolo', 'plan'] : ['default', 'full_access', 'plan']
  const advertised = session.backend === 'gemini'
    ? session.gemini_permission_modes ?? health?.capabilities?.gemini_backend?.permission_modes
    : runtime?.backends.opencode?.permission_modes ?? health?.capabilities?.opencode_backend?.permission_modes
  return known.filter(mode => (advertised ?? ['default']).includes(mode))
}

export interface OptionalPermissionScope { profileId: string; profileGeneration: number; sessionId: string }
const pending = new Map<string, Promise<void>>()
const keyOf = (scope: OptionalPermissionScope) => `${scope.profileId}:${scope.profileGeneration}:${scope.sessionId}`

export function queueOptionalPermissionUpdate(scope: OptionalPermissionScope, update: () => Promise<void>): Promise<void> {
  const key = keyOf(scope)
  const operation = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(update)
  const tracked = operation.finally(() => { if (pending.get(key) === tracked) pending.delete(key) })
  pending.set(key, tracked)
  void tracked.catch(() => undefined)
  return operation
}

export function awaitOptionalPermissionUpdates(scope: OptionalPermissionScope): Promise<void> {
  return pending.get(keyOf(scope)) ?? Promise.resolve()
}
