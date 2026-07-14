import type { Backend, Health, RuntimeCatalog, RuntimeDiagnostic, RuntimeOption } from './types'

const REQUIRED_BACKENDS = ['claude', 'codex'] as const

export function runtimeCatalogHasSelectableModels(catalog: RuntimeCatalog | null | undefined): catalog is RuntimeCatalog {
  if (!catalog?.backends) return false
  return REQUIRED_BACKENDS.every(backend =>
    catalog.backends[backend]?.models?.some(option => Boolean(option.value.trim()))
  )
}

export function runtimeCatalogOptions(
  catalog: RuntimeCatalog | null | undefined,
  backend: string,
  type: 'models' | 'efforts',
  current?: string | null
): RuntimeOption[] {
  const backendCatalog = catalog?.backends[backend]
  const available = backendCatalog?.[type] ?? []
  const configuredDefault = type === 'models' ? backendCatalog?.default_model : backendCatalog?.default_effort
  const advertisedDefault = available.find(option => option.value === '')
  const defaultLabel = advertisedDefault?.label?.trim()
    || (configuredDefault?.trim() ? `Server default (${configuredDefault.trim()})` : '')
    || (catalog ? 'Server default' : type === 'models' ? 'Loading model choices…' : 'Loading reasoning choices…')
  const options: RuntimeOption[] = [
    { value: '', label: defaultLabel },
    ...available.filter(option => option.value !== '')
  ]
  const selected = current?.trim()
  if (selected && !options.some(option => option.value === selected)) {
    options.push({ value: selected, label: selected })
  }
  return options
}

export function runtimeDiagnosticFor(
  health: Health | null | undefined,
  catalog: RuntimeCatalog | null | undefined,
  backend: Backend
): RuntimeDiagnostic | null {
  const fromHealth = health?.runtimes?.[backend] ?? null
  const fromCatalog = catalog?.backends?.[backend]?.diagnostic ?? null
  if (!fromHealth) return fromCatalog
  if (!fromCatalog) return fromHealth
  const healthTime = Date.parse(fromHealth.checked_at ?? '')
  const catalogTime = Date.parse(fromCatalog.checked_at ?? '')
  return Number.isFinite(catalogTime) && (!Number.isFinite(healthTime) || catalogTime > healthTime) ? fromCatalog : fromHealth
}

export function runtimeDiagnosticNeedsAttention(diagnostic: RuntimeDiagnostic | null | undefined): boolean {
  return Boolean(diagnostic && (diagnostic.status !== 'ready' || diagnostic.last_error))
}

export function runtimeDiagnosticLabel(diagnostic: RuntimeDiagnostic | null | undefined): string {
  if (!diagnostic) return 'Not checked'
  if (diagnostic.status === 'ready' && diagnostic.last_error) return 'Latest run failed'
  if (diagnostic.status === 'ready') return 'Ready'
  if (diagnostic.status === 'missing') return 'Not installed'
  if (diagnostic.status === 'unauthenticated') return 'Sign-in required'
  if (diagnostic.status === 'error') return 'Check failed'
  return 'Not checked'
}

export function runtimeDiagnosticTone(diagnostic: RuntimeDiagnostic | null | undefined): 'ready' | 'warning' | 'error' | 'unknown' {
  if (!diagnostic || diagnostic.status === 'unknown') return 'unknown'
  if (diagnostic.status === 'ready') return diagnostic.last_error ? 'warning' : 'ready'
  return diagnostic.status === 'error' ? 'warning' : 'error'
}
