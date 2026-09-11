const UNIDENTIFIED_PROFILE = 'unidentified-profile'

export function rendererProfileKey(profileId: string | null | undefined): string {
  return profileId || UNIDENTIFIED_PROFILE
}

export function rendererWorkspaceKey(profileId: string | null | undefined, serverIdentity: string | null | undefined): string {
  return serverIdentity ? `server:${serverIdentity}` : rendererProfileKey(profileId)
}

export function profileSessionKey(profileId: string | null | undefined, sessionId: string, serverIdentity?: string | null): string {
  return `${rendererWorkspaceKey(profileId, serverIdentity)}:${sessionId}`
}
