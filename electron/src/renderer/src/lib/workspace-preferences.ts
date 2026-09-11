import type { PublicServerProfile, WorkspaceProfileScope } from '@shared/types'

interface WorkspaceState {
  activeProfileId: string | null
  profileGeneration: number
  profiles: PublicServerProfile[]
}

export function captureWorkspaceScope(state: WorkspaceState): WorkspaceProfileScope | null {
  if (!state.activeProfileId) return null
  return {
    profileId: state.activeProfileId,
    profileGeneration: state.profileGeneration,
    serverIdentity: state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null
  }
}

export function getWorkspacePreference<T>(scope: WorkspaceProfileScope | null, key: string, fallback: T): Promise<T> {
  if (scope && typeof window.agentsDock.preferences.getScoped === 'function') {
    return window.agentsDock.preferences.getScoped(scope, key, fallback)
  }
  return window.agentsDock.preferences.get(key, fallback)
}

export function setWorkspacePreference<T>(scope: WorkspaceProfileScope | null, key: string, value: T): Promise<void> {
  if (scope && typeof window.agentsDock.preferences.setScoped === 'function') {
    return window.agentsDock.preferences.setScoped(scope, key, value)
  }
  return window.agentsDock.preferences.set(key, value)
}
