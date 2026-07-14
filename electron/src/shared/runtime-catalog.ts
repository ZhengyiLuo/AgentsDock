import type { RuntimeCatalog, RuntimeOption } from './types'

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
