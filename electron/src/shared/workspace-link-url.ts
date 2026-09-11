const WORKSPACE_LINK_SCHEME = 'agentsdock-workspace:'

/** Prevent Chromium from resolving workspace-relative links against app.asar. */
export function internalWorkspaceLinkURL(target: string): string {
  return `${WORKSPACE_LINK_SCHEME}${encodeURIComponent(target)}`
}

/** Recover the user-authored path for the native Copy Path context action. */
export function workspacePathFromInternalLink(value: string): string | null {
  if (!value.startsWith(WORKSPACE_LINK_SCHEME)) return null
  try {
    const path = decodeURIComponent(value.slice(WORKSPACE_LINK_SCHEME.length))
    return path && !/[\r\n\0]/.test(path) ? path : null
  } catch {
    return null
  }
}
