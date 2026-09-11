export const MOBILE_CODE_EDITOR_BASE_URL = 'https://agentsdock.local/editor/'

export function mobileCodeEditorNavigationAllowed(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const candidate = new URL(url)
    const base = new URL(MOBILE_CODE_EDITOR_BASE_URL)
    return candidate.origin === base.origin && candidate.pathname.startsWith(base.pathname)
  } catch {
    return false
  }
}
