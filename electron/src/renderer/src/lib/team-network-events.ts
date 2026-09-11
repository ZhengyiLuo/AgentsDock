import type { TeamHubScope } from '@shared/team-hub'

export const TEAM_NETWORK_MESSAGE_DELETED_EVENT = 'agentsdock:team-network-message-deleted'

export interface TeamNetworkMessageDeletedEventDetail {
  scopeKey: string
  profileId: string
  profileGeneration: number
  serverIdentity: string
  teamId: string
  messageId: string
}

export function dispatchTeamNetworkMessageDeleted(
  scope: TeamHubScope,
  teamId: string,
  messageId: string
): void {
  window.dispatchEvent(new CustomEvent<TeamNetworkMessageDeletedEventDetail>(
    TEAM_NETWORK_MESSAGE_DELETED_EVENT,
    {
      detail: {
        scopeKey: JSON.stringify(scope),
        profileId: scope.profileId,
        profileGeneration: scope.profileGeneration,
        serverIdentity: scope.serverIdentity,
        teamId,
        messageId
      }
    }
  ))
}

export function teamNetworkMessageDeletedDetail(event: Event): TeamNetworkMessageDeletedEventDetail | null {
  const value = (event as CustomEvent<unknown>).detail
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const detail = value as Partial<TeamNetworkMessageDeletedEventDetail>
  if (
    typeof detail.scopeKey !== 'string'
    || typeof detail.profileId !== 'string'
    || !Number.isSafeInteger(detail.profileGeneration)
    || detail.profileGeneration! < 0
    || typeof detail.serverIdentity !== 'string'
    || typeof detail.teamId !== 'string'
    || detail.teamId.length === 0
    || typeof detail.messageId !== 'string'
    || detail.messageId.length === 0
  ) return null
  return detail as TeamNetworkMessageDeletedEventDetail
}
