import type { Health, ProviderJobsAccess, Session } from '../types'

export const PROVIDER_JOBS_ACCESS_MODES = ['full', 'read_only', 'blocked'] as const satisfies readonly ProviderJobsAccess[]
const MODES = new Set<ProviderJobsAccess>(PROVIDER_JOBS_ACCESS_MODES)

export function isProviderJobsAccess(value: unknown): value is ProviderJobsAccess {
  return typeof value === 'string' && MODES.has(value as ProviderJobsAccess)
}

export function providerJobsAccessState(session: Pick<Session, 'provider_jobs_access'>, health: Health | null | undefined) {
  const capability = health?.capabilities?.provider_jobs_access_control_v1
  const advertised = Array.isArray(capability?.modes) ? capability.modes.filter(isProviderJobsAccess) : []
  const available = capability?.available === true && Number(capability.version ?? 0) >= 1 && PROVIDER_JOBS_ACCESS_MODES.every(mode => advertised.includes(mode))
  const inheritedDefault = !isProviderJobsAccess(session.provider_jobs_access)
  const defaultMode = isProviderJobsAccess(capability?.default) ? capability.default : 'full'
  return { available, inheritedDefault: available ? inheritedDefault : true, effective: available && isProviderJobsAccess(session.provider_jobs_access) ? session.provider_jobs_access : available ? defaultMode : 'full' as ProviderJobsAccess }
}

export function providerJobsAccessLabel(mode: ProviderJobsAccess): string {
  return mode === 'read_only' ? 'Read-only' : mode === 'blocked' ? 'Blocked' : 'Full access'
}

export function providerJobsAccessDescription(mode: ProviderJobsAccess): string {
  if (mode === 'read_only') return 'The agent can inspect scheduled jobs, but cannot create, change, enable, disable, or delete them.'
  if (mode === 'blocked') return 'The agent cannot access scheduled jobs for this chat.'
  return 'The agent can inspect and manage scheduled jobs. Human job controls are unchanged.'
}
