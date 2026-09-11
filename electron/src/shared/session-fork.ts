import type { Backend, Health } from './types'

export const RUNNING_FORK_UNAVAILABLE = 'Update AgentsServer to fork a running chat through its last completed turn, or wait for this turn to finish.'
export const RUNNING_FORK_DESCRIPTION = 'Fork through the last completed turn; the source chat keeps running.'

export function completedPrefixForkAvailable(health: Health | null | undefined, backend: Backend | undefined): boolean {
  const capability = health?.capabilities?.session_fork_completed_prefix_v1
  return health?.ok === true
    && capability?.available === true
    && capability.version === 1
    && backend !== undefined
    && Array.isArray(capability.supported_backends)
    && capability.supported_backends.includes(backend)
}
