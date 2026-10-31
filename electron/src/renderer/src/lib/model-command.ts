import type { RuntimeCatalog, RuntimeOption, Session } from '@shared/types'
import { runtimeEffortAfterModelChange } from '@shared/runtime-catalog'

/** null means ordinary text; empty means open the same picker as /model. */
export function modelCommandArgument(text: string): string | null {
  const match = /^\/model(?:\s+([\s\S]*))?$/i.exec(text.trim())
  return match ? (match[1] ?? '').trim() : null
}

/** Exact advertised ID first, then a unique display label. Never guess a model
 * from a prefix or submit an unknown argument to the provider as a prompt. */
export function resolveModelCommand(argument: string, options: RuntimeOption[]): RuntimeOption | undefined {
  if (/\r|\n/.test(argument)) return undefined
  const normalized = argument.toLowerCase()
  const byId = options.filter(option => option.value && option.value.toLowerCase() === normalized)
  const matches = byId.length ? byId : normalized === 'default'
    ? options.filter(option => option.value === '')
    : options.filter(option => option.value && option.label.toLowerCase() === normalized)
  return matches.length === 1 && !matches[0].locked ? matches[0] : undefined
}

/** Shared by the model picker and typed /model; keep reasoning compatibility. */
export function sessionModelPatch(session: Session, catalog: RuntimeCatalog | null, value: string): Pick<Session, 'model' | 'effort'> {
  const model = value || null
  const effort = runtimeEffortAfterModelChange(catalog, session.backend, model, session.effort,
    session.provider_connection === 'custom' ? 'custom' : session.codex_provider,
    session.provider_connection_catalog ?? session.codex_provider_catalog)
  return { model, effort }
}
