export type AppearanceMode = 'system' | 'light' | 'dark'
export type ResolvedAppearance = 'light' | 'dark'

const STORAGE_KEY = 'agentsdock.appearance'
const APPEARANCE_EVENT = 'agentsdock:appearance'
let mediaQuery: MediaQueryList | null = null
let initialized = false

export function resolveAppearance(mode: AppearanceMode, prefersDark: boolean): ResolvedAppearance {
  if (mode === 'system') return prefersDark ? 'dark' : 'light'
  return mode
}

export function readAppearance(): AppearanceMode {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function applyAppearance(mode: AppearanceMode): void {
  const prefersDark = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true
  const resolved = resolveAppearance(mode, prefersDark)
  document.documentElement.dataset.appearance = mode
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
}

export function setAppearanceMode(mode: AppearanceMode): void {
  try { window.localStorage.setItem(STORAGE_KEY, mode) } catch { /* keep the active in-memory theme */ }
  applyAppearance(mode)
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: mode }))
}

export function initializeAppearance(): void {
  applyAppearance(readAppearance())
  if (initialized || typeof window.matchMedia !== 'function') return
  initialized = true
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  mediaQuery.addEventListener('change', () => {
    if (readAppearance() === 'system') applyAppearance('system')
  })
}
