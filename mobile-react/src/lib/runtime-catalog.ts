import type { Backend, Health, RuntimeCatalog, RuntimeOption, Session } from '../types'
import { runtimeDiagnosticFor } from './runtime'

const REQUIRED_BACKENDS = ['claude', 'codex'] as const

/**
 * A chat's backend can only change until a provider session exists. Once the
 * agent has started (server sets `backend_locked`, or any provider session id
 * is present), switching would orphan that transcript, so the picker locks.
 */
export function isBackendLocked(session: Pick<Session, 'backend_locked' | 'session_id' | 'claude_session_id' | 'codex_thread_id' | 'cursor_session_id'>): boolean {
  return Boolean(session.backend_locked || session.session_id || session.claude_session_id || session.codex_thread_id || session.cursor_session_id)
}
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export const CURSOR_BACKEND_CAPABILITY_VERSION = 2

export function runtimeCatalogHasSelectableModels(catalog: RuntimeCatalog | null | undefined): catalog is RuntimeCatalog {
  if (!catalog?.backends) return false
  return REQUIRED_BACKENDS.every(backend => catalog.backends[backend]?.models?.some(option => Boolean(option.value.trim())))
}

export function cursorBackendSupported(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.cursor_backend
  return capability?.available === true && capability.version === CURSOR_BACKEND_CAPABILITY_VERSION
}

export function cursorBackendAvailable(health: Health | null | undefined, catalog: RuntimeCatalog | null | undefined): boolean {
  const backend = catalog?.backends?.cursor
  if (!cursorBackendSupported(health) || !backend) return false
  const diagnostic = runtimeDiagnosticFor(health, catalog, 'cursor')
  return diagnostic ? diagnostic.status === 'ready' && diagnostic.available === true : backend.available === true
}

export function selectableChatBackends(health: Health | null | undefined): Backend[] {
  return cursorBackendSupported(health) ? ['claude', 'codex', 'cursor'] : ['claude', 'codex']
}

export function cursorBackendUnavailableReason(health: Health | null | undefined, catalog: RuntimeCatalog | null | undefined): string | null {
  if (cursorBackendAvailable(health, catalog)) return null
  if (!cursorBackendSupported(health)) return 'Cursor requires the hardened Cursor backend in a newer AgentsServer. Update the server, then reconnect.'
  const diagnostic = runtimeDiagnosticFor(health, catalog, 'cursor')
  const detail = [diagnostic?.message?.trim(), diagnostic?.action?.trim()].filter(Boolean).join(' ')
  if (detail) return `Cursor is unavailable. ${detail}`
  return catalog?.backends?.cursor
    ? 'Cursor is supported, but its CLI is not ready. Install or update Cursor, sign in, then recheck CLIs.'
    : 'Cursor status is still loading. Recheck CLIs if this does not clear.'
}

export function runtimeModelLockReason(catalog: RuntimeCatalog | null | undefined, backend: string, model?: string | null): string | null {
  const selected = model?.trim()
  if (!selected) return null
  const option = catalog?.backends?.[backend]?.models?.find(candidate => candidate.value === selected)
  if (option?.locked !== true) return null
  return option.locked_reason?.trim() || `${option.label?.trim() || selected} is unavailable for this account.`
}

export function runtimeSelectionError(health: Health | null | undefined, catalog: RuntimeCatalog | null | undefined, backend: Backend, model?: string | null): string | null {
  if (backend === 'cursor' && !cursorBackendAvailable(health, catalog)) return cursorBackendUnavailableReason(health, catalog)
  const selected = model?.trim()
  if (backend === 'cursor' && selected && !catalog?.backends.cursor?.models.some(option => option.value === selected)) {
    return `${selected} is not offered by Cursor on this AgentsServer. Choose an available model before running Cursor work.`
  }
  return runtimeModelLockReason(catalog, backend, model)
}

function optionLabel(options: RuntimeOption[], value: string | null | undefined): string {
  const clean = value?.trim()
  if (!clean) return ''
  return options.find(option => option.value === clean)?.label?.trim() || clean
}

/**
 * Produces one unambiguous server-default sentinel followed by concrete
 * runtime choices. The sentinel deliberately remains a distinct empty value:
 * choosing it follows future server-default changes, while choosing the
 * concrete model pins that model for the chat.
 */
export function runtimeCatalogOptions(
  catalog: RuntimeCatalog | null | undefined,
  backend: string,
  type: 'models' | 'efforts',
  current?: string | null,
): RuntimeOption[] {
  const backendCatalog = catalog?.backends[backend]
  const available = backendCatalog?.[type] ?? []
  const configuredDefault = type === 'models' ? backendCatalog?.default_model : backendCatalog?.default_effort
  const advertisedDefault = available.find(option => option.value === '')?.label?.trim()
  const concreteDefault = optionLabel(available, configuredDefault)
  const baseDefaultLabel = advertisedDefault
    || (catalog ? 'Server default' : type === 'models' ? 'Loading model choices…' : 'Loading reasoning choices…')
  const defaultLabel = concreteDefault && !baseDefaultLabel.toLowerCase().includes(concreteDefault.toLowerCase())
    ? `${baseDefaultLabel} (${concreteDefault})`
    : baseDefaultLabel
  const seen = new Set<string>([''])
  const options: RuntimeOption[] = [{ value: '', label: defaultLabel }]
  for (const option of available) {
    if (!option.value || seen.has(option.value)) continue
    seen.add(option.value)
    options.push(option)
  }
  const selected = current?.trim()
  if (selected && !seen.has(selected)) options.push({ value: selected, label: selected })
  return options
}

function modelEfforts(catalog: RuntimeCatalog | null | undefined, backend: string, model?: string | null): RuntimeOption[] | null {
  const backendCatalog = catalog?.backends[backend]
  const selected = model?.trim() || backendCatalog?.default_model?.trim()
  if (!backendCatalog || !selected) return null
  const indexed = backendCatalog.model_efforts?.[selected]
  if (indexed?.length) return indexed
  const embedded = backendCatalog.models.find(option => option.value === selected)?.efforts
  return embedded?.length ? embedded : null
}

export function runtimeEffortOptions(catalog: RuntimeCatalog | null | undefined, backend: string, model?: string | null, current?: string | null): RuntimeOption[] {
  const scoped = modelEfforts(catalog, backend, model)
  if (!scoped) return runtimeCatalogOptions(catalog, backend, 'efforts', current)
  const configuredDefault = catalog?.backends[backend]?.default_effort?.trim()
  return [
    { value: '', label: configuredDefault && scoped.some(option => option.value === configuredDefault) ? `Server default (${configuredDefault})` : 'Server default' },
    ...scoped.filter(option => option.value !== ''),
  ]
}

export function runtimeEffortAfterModelChange(catalog: RuntimeCatalog | null | undefined, backend: string, model: string | null, current?: string | null): string | null {
  if (backend === 'cursor') return null
  const selected = current?.trim() || ''
  const scoped = modelEfforts(catalog, backend, model)
  if (!scoped?.length || !selected) return selected || null
  const supported = scoped.map(option => option.value).filter(Boolean)
  if (supported.includes(selected)) return selected
  const rank = EFFORT_ORDER.indexOf(selected as (typeof EFFORT_ORDER)[number])
  if (rank >= 0) {
    const closest = supported.map(value => ({ value, rank: EFFORT_ORDER.indexOf(value as (typeof EFFORT_ORDER)[number]) }))
      .filter(candidate => candidate.rank >= 0 && candidate.rank <= rank)
      .sort((a, b) => b.rank - a.rank)[0]
    if (closest) return closest.value
  }
  const configuredDefault = catalog?.backends[backend]?.default_effort?.trim()
  return configuredDefault && supported.includes(configuredDefault) ? configuredDefault : supported[0] || null
}
