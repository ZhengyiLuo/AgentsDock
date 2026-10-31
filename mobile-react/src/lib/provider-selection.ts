import type { Backend, Health, RuntimeCatalog, Session } from '../types'
import { runtimeDiagnosticFor } from './runtime'
import { isBackendLocked, runtimeModelLockReason, runtimeSelectionError, selectableChatBackends } from './runtime-catalog'

export type ChatBackendChoice = Backend | `${Backend}-custom`
type ProviderSelection = Pick<Session, 'backend' | 'codex_provider' | 'provider_connection'>
type CatalogSelection = ProviderSelection & Partial<Session>

export function isCustomProvider(selection: ProviderSelection): boolean {
  return (selection.backend === 'codex' ? selection.codex_provider : selection.provider_connection) === 'custom'
}

export function chatBackendChoice(selection: ProviderSelection): ChatBackendChoice {
  return isCustomProvider(selection) ? `${selection.backend}-custom` as ChatBackendChoice : selection.backend
}

export function chatBackendSelection(choice: ChatBackendChoice): Required<ProviderSelection> {
  return {
    backend: choice.replace(/-custom$/, '') as Backend,
    codex_provider: choice === 'codex-custom' ? 'custom' : 'default',
    provider_connection: choice !== 'codex-custom' && choice.endsWith('-custom') ? 'custom' : 'default',
  }
}

export function chatBackendLabel(choice: ChatBackendChoice): string {
  const backend = choice.replace(/-custom$/, '')
  const name = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor', opencode: 'OpenCode', gemini: 'Gemini' }[backend] ?? backend
  return choice.endsWith('-custom') ? `${name} - Custom API` : name
}

export function nativeProviderAvailable(health: Health | null, catalog: RuntimeCatalog | null, backend: string): boolean {
  // OpenCode's free models work without account credentials; Gemini is API-only.
  if (backend === 'opencode') return health?.capabilities?.opencode_backend?.available === true && catalog?.backends.opencode?.available === true
  if (backend === 'gemini') return false
  const diagnostic = runtimeDiagnosticFor(health, catalog, backend)
  if (diagnostic && (diagnostic.installed === false || diagnostic.authenticated === false
    || ['missing', 'unauthenticated', 'error'].includes(diagnostic.status))) return false
  const native = catalog?.backends[backend]?.native_credentials_present
  if (native !== undefined) return native && catalog?.backends[backend]?.available !== false
  if (diagnostic?.authenticated != null) return diagnostic.authenticated && diagnostic.available
  // Older servers do not distinguish credential sources. Keep their native UI usable.
  return diagnostic ? diagnostic.status === 'ready' && diagnostic.available : catalog?.backends[backend]?.available === true
}

export function customProviderSupported(health: Health | null | undefined, backend: string): boolean {
  if (backend === 'codex') return health?.capabilities?.codex_provider_v1?.per_chat === true
    && health.capabilities.codex_provider_v1.per_chat_models === true
  const capability = health?.capabilities?.provider_connections_v1
  return ['claude', 'opencode', 'cursor', 'gemini'].includes(backend) && capability?.per_chat === true
    && (!capability.backends || capability.backends.includes(backend))
}

export function customProviderAvailable(health: Health | null, catalog: RuntimeCatalog | null, backend: string): boolean {
  const custom = catalog?.backends[backend]?.custom_provider
  return customProviderSupported(health, backend) && custom?.configured === true && custom.available === true
}

export function selectableChatBackendChoices(health: Health | null, catalog: RuntimeCatalog | null): ChatBackendChoice[] {
  return selectableChatBackends(health).flatMap(backend => {
    const legacyUnknown = (backend === 'claude' || backend === 'codex') && catalog?.backends[backend]?.native_credentials_present === undefined
      && catalog?.backends[backend]?.available === undefined && !runtimeDiagnosticFor(health, catalog, backend)
    return [
      ...(nativeProviderAvailable(health, catalog, backend) || legacyUnknown ? [backend] : []),
      ...(customProviderAvailable(health, catalog, backend) ? [`${backend}-custom` as ChatBackendChoice] : []),
    ]
  }).filter(choice => !providerSelectionError(health, catalog, chatBackendSelection(choice), true))
}

/** Custom chats never inherit a native account's model catalog or a different saved binding. */
export function providerRuntimeCatalog(catalog: RuntimeCatalog | null, selection: CatalogSelection): RuntimeCatalog | null {
  if (!isCustomProvider(selection)) return catalog
  const bound = selection.backend === 'codex' ? selection.codex_provider_catalog : selection.provider_connection_catalog
  const custom = bound ?? (!isBackendLocked(selection) ? catalog?.backends[selection.backend]?.custom_provider : undefined)
  return { backends: { [selection.backend]: {
    models: custom?.models ?? (custom?.model ? [{ value: custom.model, label: custom.model }] : []),
    efforts: custom?.efforts ?? [],
    model_efforts: custom?.model_efforts,
    default_model: custom?.default_model ?? custom?.model,
    default_effort: custom?.default_effort,
  } } }
}

export function providerSelectionError(health: Health | null, catalog: RuntimeCatalog | null, selection: CatalogSelection, changingProvider = false): string | null {
  if ((selection.backend === 'opencode' || selection.backend === 'gemini') && !selectableChatBackends(health).includes(selection.backend)) return 'Update AgentsServer to use this agent.'
  if (!isCustomProvider(selection)) return runtimeSelectionError(health, catalog, selection.backend, selection.model)
  if (changingProvider) {
    if (!customProviderSupported(health, selection.backend)) return 'Update AgentsServer to select Custom API chats.'
    if (!customProviderAvailable(health, catalog, selection.backend)) return 'This Custom API is unavailable. Check its configuration on the server machine.'
  }
  // Existing bindings are admitted by the server, even when the current global API was removed.
  return runtimeModelLockReason(providerRuntimeCatalog(catalog, selection), selection.backend, selection.model)
}
