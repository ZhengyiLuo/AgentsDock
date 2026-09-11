import type { Health, ProviderJobsAccess, Session } from '@shared/types'

export const PROVIDER_JOBS_ACCESS_MODES = ['full', 'read_only', 'blocked'] as const satisfies readonly ProviderJobsAccess[]

const MODE_SET = new Set<ProviderJobsAccess>(PROVIDER_JOBS_ACCESS_MODES)

export interface ProviderJobsAccessState {
  available: boolean
  effective: ProviderJobsAccess
  inheritedDefault: boolean
}

export function providerJobsAccessState(
  session: Pick<Session, 'provider_jobs_access'>,
  health: Health | null | undefined
): ProviderJobsAccessState {
  const capability = health?.capabilities?.provider_jobs_access_control_v1
  const advertisedModes = Array.isArray(capability?.modes)
    ? capability.modes.filter(isProviderJobsAccess)
    : []
  const available = capability?.available === true
    && Number(capability.version ?? 0) >= 1
    && PROVIDER_JOBS_ACCESS_MODES.every(mode => advertisedModes.includes(mode))
  const inheritedDefault = !isProviderJobsAccess(session.provider_jobs_access)
  const advertisedDefault = isProviderJobsAccess(capability?.default) ? capability.default : 'full'
  return {
    available,
    effective: available && isProviderJobsAccess(session.provider_jobs_access)
      ? session.provider_jobs_access
      : available ? advertisedDefault : 'full',
    inheritedDefault: available ? inheritedDefault : true
  }
}

export function isProviderJobsAccess(value: unknown): value is ProviderJobsAccess {
  return typeof value === 'string' && MODE_SET.has(value as ProviderJobsAccess)
}

export function providerJobsAccessLabel(mode: ProviderJobsAccess): string {
  if (mode === 'read_only') return 'Read-only'
  if (mode === 'blocked') return 'Blocked'
  return 'Full access'
}

export function providerJobsAccessDescription(mode: ProviderJobsAccess): string {
  if (mode === 'read_only') return 'The agent can inspect scheduled jobs, but cannot create, change, enable, disable, or delete them.'
  if (mode === 'blocked') return 'The agent cannot access scheduled jobs for this chat.'
  return 'The agent can inspect, create, change, enable, disable, and delete scheduled jobs. Agent run-now remains unavailable.'
}
