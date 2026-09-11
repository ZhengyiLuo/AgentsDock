export interface CodexGoalsConfigurationChangedDetail {
  profileId: string
  profileGeneration: number
  enabled: boolean
}

const listeners = new Set<(detail: CodexGoalsConfigurationChangedDetail) => void>()

export function subscribeCodexGoalsConfiguration(
  listener: (detail: CodexGoalsConfigurationChangedDetail) => void,
): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function announceCodexGoalsConfigurationChanged(
  profileId: string,
  profileGeneration: number,
  enabled: boolean,
): void {
  const detail = { profileId, profileGeneration, enabled }
  for (const listener of [...listeners]) listener(detail)
}
