import type { Backend, Health, RuntimeCatalog, RuntimeDiagnostic } from '../types'

export function runtimeDiagnosticFor(
  health: Health | null | undefined,
  catalog: RuntimeCatalog | null | undefined,
  backend: Backend,
): RuntimeDiagnostic | null {
  const fromHealth = health?.runtimes?.[backend] ?? null
  const fromCatalog = catalog?.backends?.[backend]?.diagnostic ?? null
  if (!fromHealth) return fromCatalog
  if (!fromCatalog) return fromHealth
  const healthTime = Date.parse(fromHealth.checked_at ?? '')
  const catalogTime = Date.parse(fromCatalog.checked_at ?? '')
  return Number.isFinite(catalogTime) && (!Number.isFinite(healthTime) || catalogTime > healthTime) ? fromCatalog : fromHealth
}

export function runtimeNeedsAttention(value: RuntimeDiagnostic | null | undefined): boolean {
  return Boolean(value && (value.status !== 'ready' || value.last_error))
}

export function runtimeLabel(value: RuntimeDiagnostic | null | undefined): string {
  if (!value) return 'Not checked'
  if (value.status === 'ready' && value.last_error) return 'Latest run failed'
  if (value.status === 'ready') return 'Ready'
  if (value.status === 'missing') return 'Not installed'
  if (value.status === 'unauthenticated') return 'Sign-in required'
  if (value.status === 'error') return 'Check failed'
  return 'Not checked'
}
