export const CODEX_GOALS_CONFIGURATION_CHANGED_EVENT = 'agentsdock:codex-goals-configuration-changed'

export interface CodexGoalsConfigurationChangedDetail {
  profileId: string | null
  profileGeneration: number
  enabled: boolean
}

export function announceCodexGoalsConfigurationChanged(
  profileId: string | null,
  profileGeneration: number,
  enabled: boolean
): void {
  window.dispatchEvent(new CustomEvent<CodexGoalsConfigurationChangedDetail>(
    CODEX_GOALS_CONFIGURATION_CHANGED_EVENT,
    { detail: { profileId, profileGeneration, enabled } }
  ))
}
