import type { Health } from '../types'
import { teamNetworkAvailable } from './team-network'

/** Mobile admits Inbox only through the authenticated Teamspace proxy. */
export function teamNetworkInboxAvailable(health: Health | null | undefined): boolean {
  return teamNetworkAvailable(health)
}

export const TEAM_NETWORK_INBOX_BLOCKER =
  'This server does not advertise an authenticated Teamspace proxy for mobile.'
