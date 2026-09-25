import type { Backend, CodexProvider, Health, RuntimeBackendCatalog, RuntimeCatalog, RuntimeDiagnostic, RuntimeOption } from './types'
import { t } from './i18n'

/** UI identity only: the native runtime remains Codex for both choices. */
export type ChatBackendChoice = Backend | 'codex-custom'

export function chatBackendChoice(session: { backend: Backend; codex_provider?: CodexProvider }): ChatBackendChoice {
  return session.backend === 'codex' && session.codex_provider === 'custom' ? 'codex-custom' : session.backend
}

export function chatBackendSelection(choice: ChatBackendChoice): { backend: Backend; codex_provider: CodexProvider } {
  return { backend: choice === 'codex-custom' ? 'codex' : choice, codex_provider: choice === 'codex-custom' ? 'custom' : 'default' }
}

export function codexCustomProviderSupported(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.codex_provider_v1
  return capability?.per_chat === true && capability.per_chat_models === true
}

export function codexCustomProviderAvailable(health: Health | null | undefined, catalog: RuntimeCatalog | null | undefined, customCatalog?: RuntimeBackendCatalog['custom_provider']): boolean {
  const custom = customCatalog ?? catalog?.backends?.codex?.custom_provider
  return codexCustomProviderSupported(health) && custom?.configured === true && custom.available === true
}

/** Keep endpoint discovery separate from the normal Codex account's catalog. */
export function runtimeBackendCatalogFor(catalog: RuntimeCatalog | null | undefined, backend: string, codexProvider?: CodexProvider, customCatalog?: RuntimeBackendCatalog['custom_provider']): RuntimeBackendCatalog | undefined {
  const standard = catalog?.backends[backend]
  if (backend !== 'codex' || codexProvider !== 'custom') return standard
  const custom = customCatalog ?? standard?.custom_provider
  if (!custom) return undefined
  return {
    ...custom,
    models: custom.models ?? (custom.model ? [{ value: custom.model, label: custom.model }] : []),
    efforts: custom.efforts ?? [],
    default_model: custom.default_model ?? custom.model
  }
}

export function selectableChatBackendChoices(health: Health | null | undefined, catalog: RuntimeCatalog | null | undefined): ChatBackendChoice[] {
  return selectableChatBackends(health, catalog).flatMap(backend => backend === 'codex' ? ['codex', 'codex-custom'] as ChatBackendChoice[] : [backend])
}

// Claude and Codex are always expected on every server; Cursor is optional
// (many servers won't have it configured/authenticated yet). Keeping it out
// of this "is the catalog trustworthy" sanity gate means a server without
// Cursor still loads normally - runtimeCatalogOptions() itself already
// surfaces Cursor's models generically wherever the server does have them.
const REQUIRED_BACKENDS = ['claude', 'codex'] as const
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export function runtimeCatalogHasSelectableModels(catalog: RuntimeCatalog | null | undefined): catalog is RuntimeCatalog {
  if (!catalog?.backends) return false
  return REQUIRED_BACKENDS.every(backend =>
    catalog.backends[backend]?.models?.some(option => Boolean(option.value.trim()))
  )
}

/** True when this server understands the Cursor backend contract.
 *
 * Support and readiness are deliberately separate. A current server should
 * keep Cursor discoverable while its CLI is missing, outdated, or signed out;
 * the runtime catalog remains the admission gate for actually running work.
 */
export function cursorBackendSupported(
  health: Health | null | undefined
): boolean {
  const capability = health?.capabilities?.cursor_backend
  return capability?.available === true
    && Number.isInteger(capability.version)
    && capability.version >= 2
}

/** True only when a supported Cursor backend is ready to accept work. */
export function cursorBackendAvailable(
  health: Health | null | undefined,
  catalog: RuntimeCatalog | null | undefined
): boolean {
  const backend = catalog?.backends?.cursor
  if (!cursorBackendSupported(health) || !backend) return false
  const diagnostic = runtimeDiagnosticFor(health, catalog, 'cursor')
  return diagnostic
    ? diagnostic.status === 'ready' && diagnostic.available === true
    : backend.available === true
}

export function selectableChatBackends(
  health: Health | null | undefined,
  _catalog: RuntimeCatalog | null | undefined
): Backend[] {
  return cursorBackendSupported(health)
    ? ['claude', 'codex', 'cursor']
    : ['claude', 'codex']
}

export function cursorBackendUnavailableReason(
  health: Health | null | undefined,
  catalog: RuntimeCatalog | null | undefined
): string | null {
  if (cursorBackendAvailable(health, catalog)) return null
  if (!cursorBackendSupported(health)) {
    return 'Cursor is unavailable because this AgentsServer does not support it yet. Update the server, then reconnect.'
  }
  const diagnostic = runtimeDiagnosticFor(health, catalog, 'cursor')
  if (!catalog?.backends?.cursor && diagnostic?.status === 'ready') {
    return 'Cursor is unavailable while model choices are still loading. Recheck CLIs if this does not clear.'
  }
  const message = diagnostic?.message?.trim()
  const action = diagnostic?.action?.trim()
  if (message || action) return ['Cursor is unavailable.', message, action].filter(Boolean).join(' ')
  if (!catalog?.backends?.cursor) {
    return 'Cursor is unavailable while status is still loading. Recheck CLIs if this does not clear.'
  }
  return 'Cursor is unavailable. It is supported, but its CLI is not ready. Install or update Cursor, sign in, then recheck CLIs.'
}

export function runtimeCatalogOptions(
  catalog: RuntimeCatalog | null | undefined,
  backend: string,
  type: 'models' | 'efforts',
  current?: string | null,
  codexProvider?: CodexProvider,
  customCatalog?: RuntimeBackendCatalog['custom_provider']
): RuntimeOption[] {
  const backendCatalog = runtimeBackendCatalogFor(catalog, backend, codexProvider, customCatalog)
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
  if (backend === 'codex' && codexProvider === 'custom' && type === 'models') {
    return options.map(option => {
      const model = option.value || backendCatalog?.default_model
      if (!model) return option
      const compatibility = backendCatalog?.model_capabilities?.[model]?.compatibility ?? 'unverified'
      return { ...option, label: `${option.label} · ${t(`codexProvider.compatibility.${compatibility}`)}`,
        ...(compatibility === 'unsupported' ? { locked: true, locked_reason: t('codexProvider.modelUnsupported') } : {}) }
    })
  }
  return options
}

/**
 * Return a human-readable failure when an explicit model is advertised but
 * unavailable to the current account. Unknown custom values remain a server
 * concern for providers that support them; Cursor's UI does not expose its
 * custom-model escape hatch.
 */
export function runtimeModelLockReason(
  catalog: RuntimeCatalog | null | undefined,
  backend: string,
  model?: string | null
): string | null {
  const selected = model?.trim()
  if (!selected) return null
  const option = catalog?.backends?.[backend]?.models?.find(candidate => candidate.value === selected)
  if (option?.locked !== true) return null
  return option.locked_reason?.trim()
    || `${option.label?.trim() || selected} is unavailable for this account.`
}

/**
 * Fail closed before an action is admitted when its backend contract is not
 * available or its explicit model is currently locked.
 */
export function runtimeSelectionError(
  health: Health | null | undefined,
  catalog: RuntimeCatalog | null | undefined,
  backend: Backend,
  model?: string | null,
  codexProvider?: CodexProvider,
  customCatalog?: RuntimeBackendCatalog['custom_provider']
): string | null {
  if (backend === 'codex' && codexProvider === 'custom') {
    if (!codexCustomProviderSupported(health)) return t('codexProvider.update')
    if (!codexCustomProviderAvailable(health, catalog, customCatalog)) return t('codexProvider.unavailable')
    const custom = runtimeBackendCatalogFor(catalog, backend, codexProvider, customCatalog)
    const selected = model?.trim() || custom?.default_model?.trim()
    if (selected && custom?.model_capabilities?.[selected]?.compatibility === 'unsupported') return t('codexProvider.modelUnsupported')
    return null
  }
  if (backend === 'cursor' && !cursorBackendAvailable(health, catalog)) {
    return cursorBackendUnavailableReason(health, catalog)
  }
  const selected = model?.trim()
  if (backend === 'cursor' && selected && !catalog?.backends.cursor?.models.some(option => option.value === selected)) {
    return `${selected} is not offered by Cursor on this AgentsServer. Choose an available model before running Cursor work.`
  }
  return runtimeModelLockReason(catalog, backend, model)
}

function modelEfforts(
  catalog: RuntimeCatalog | null | undefined,
  backend: string,
  model?: string | null,
  codexProvider?: CodexProvider,
  customCatalog?: RuntimeBackendCatalog['custom_provider']
): RuntimeOption[] | null {
  const backendCatalog = runtimeBackendCatalogFor(catalog, backend, codexProvider, customCatalog)
  const selectedModel = model?.trim() || backendCatalog?.default_model?.trim()
  const custom = backend === 'codex' && codexProvider === 'custom'
  if (!backendCatalog || !selectedModel) return custom ? [] : null
  const indexed = backendCatalog.model_efforts?.[selectedModel]
  if (indexed !== undefined) return indexed
  if (custom) return []
  const embedded = backendCatalog.models.find(option => option.value === selectedModel)?.efforts
  return embedded ?? null
}

export function runtimeEffortOptions(
  catalog: RuntimeCatalog | null | undefined,
  backend: string,
  model?: string | null,
  current?: string | null,
  codexProvider?: CodexProvider,
  customCatalog?: RuntimeBackendCatalog['custom_provider']
): RuntimeOption[] {
  const scoped = modelEfforts(catalog, backend, model, codexProvider, customCatalog)
  if (!scoped) return runtimeCatalogOptions(catalog, backend, 'efforts', current, codexProvider, customCatalog)
  const backendCatalog = runtimeBackendCatalogFor(catalog, backend, codexProvider, customCatalog)
  const configuredDefault = backendCatalog?.default_effort?.trim()
  const defaultLabel = configuredDefault && scoped.some(option => option.value === configuredDefault)
    ? `Server default (${configuredDefault})`
    : 'Server default'
  return [
    { value: '', label: defaultLabel },
    ...scoped.filter(option => option.value !== '')
  ]
}

export function runtimeEffortAfterModelChange(
  catalog: RuntimeCatalog | null | undefined,
  backend: string,
  model: string | null,
  current?: string | null,
  codexProvider?: CodexProvider,
  customCatalog?: RuntimeBackendCatalog['custom_provider']
): string | null {
  if (backend === 'cursor') return null
  const selected = current?.trim() || ''
  const scoped = modelEfforts(catalog, backend, model, codexProvider, customCatalog)
  if (scoped === null || !selected) return selected || null
  if (!scoped.length) return null
  const supported = scoped.map(option => option.value).filter(Boolean)
  if (supported.includes(selected)) return selected

  const selectedRank = EFFORT_ORDER.indexOf(selected as (typeof EFFORT_ORDER)[number])
  if (selectedRank >= 0) {
    const closest = supported
      .map(value => ({ value, rank: EFFORT_ORDER.indexOf(value as (typeof EFFORT_ORDER)[number]) }))
      .filter(candidate => candidate.rank >= 0 && candidate.rank <= selectedRank)
      .sort((left, right) => right.rank - left.rank)[0]
    if (closest) return closest.value
  }

  const configuredDefault = runtimeBackendCatalogFor(catalog, backend, codexProvider, customCatalog)?.default_effort?.trim()
  if (configuredDefault && supported.includes(configuredDefault)) return configuredDefault
  return supported[0] || null
}

export function runtimeDiagnosticFor(
  health: Health | null | undefined,
  catalog: RuntimeCatalog | null | undefined,
  backend: Backend,
  codexProvider?: CodexProvider,
  customCatalog?: RuntimeBackendCatalog['custom_provider']
): RuntimeDiagnostic | null {
  if (backend === 'codex' && codexProvider === 'custom') {
    const available = codexCustomProviderAvailable(health, catalog, customCatalog)
    return { backend, available, status: available ? 'ready' : 'error', message: available ? '' : t('codexProvider.unavailable') }
  }
  const fromHealth = health?.runtimes?.[backend] ?? null
  const fromCatalog = catalog?.backends?.[backend]?.diagnostic ?? null
  if (!fromHealth) return fromCatalog
  if (!fromCatalog) return fromHealth
  const healthTime = Date.parse(fromHealth.checked_at ?? '')
  const catalogTime = Date.parse(fromCatalog.checked_at ?? '')
  return Number.isFinite(catalogTime) && (!Number.isFinite(healthTime) || catalogTime > healthTime) ? fromCatalog : fromHealth
}

export function runtimeDiagnosticNeedsAttention(diagnostic: RuntimeDiagnostic | null | undefined): boolean {
  return Boolean(diagnostic && (diagnostic.status !== 'ready' || runtimeDiagnosticCurrentError(diagnostic)))
}

export function runtimeDiagnosticLabel(diagnostic: RuntimeDiagnostic | null | undefined): string {
  if (!diagnostic) return 'Not checked'
  if (diagnostic.status === 'ready' && runtimeDiagnosticCurrentError(diagnostic)) return 'Latest run failed'
  if (diagnostic.status === 'ready') return 'Ready'
  if (diagnostic.status === 'missing') return 'Not installed'
  if (diagnostic.status === 'unauthenticated') return 'Sign-in required'
  if (diagnostic.status === 'error') return 'Check failed'
  return 'Not checked'
}

export function runtimeDiagnosticTone(diagnostic: RuntimeDiagnostic | null | undefined): 'ready' | 'warning' | 'error' | 'unknown' {
  if (!diagnostic || diagnostic.status === 'unknown') return 'unknown'
  if (diagnostic.status === 'ready') return runtimeDiagnosticCurrentError(diagnostic) ? 'warning' : 'ready'
  return diagnostic.status === 'error' ? 'warning' : 'error'
}

export function runtimeDiagnosticCurrentError(diagnostic: RuntimeDiagnostic | null | undefined): string {
  if (!diagnostic?.last_error) return ''
  const failureAt = Date.parse(diagnostic.last_error_at ?? '')
  const checkedAt = Date.parse(diagnostic.checked_at ?? '')
  if (Number.isFinite(failureAt) && Number.isFinite(checkedAt) && failureAt < checkedAt) return ''
  return diagnostic.last_error
}
