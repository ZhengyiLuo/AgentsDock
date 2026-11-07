import { saveLocalStorage } from './local-storage'

/** Prompts this composer sent, newest last, recalled with ArrowUp/ArrowDown like the Codex and Claude CLIs. */
export const COMPOSER_HISTORY_LIMIT = 100

// Use the same server identity/profile + chat scope as drafts. Never adopt the
// old chat-only key: its originating server cannot be established safely.
const storageKey = (workspaceSessionKey: string): string => `agentsdock:composer-history:v2:${workspaceSessionKey}`

export function loadComposerHistory(workspaceSessionKey: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(workspaceSessionKey)) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).slice(-COMPOSER_HISTORY_LIMIT) : []
  } catch {
    return []
  }
}

export function appendComposerHistory(entries: readonly string[], prompt: string): string[] {
  if (!prompt.trim()) return [...entries]
  const next = entries[entries.length - 1] === prompt ? [...entries] : [...entries, prompt]
  return next.slice(-COMPOSER_HISTORY_LIMIT)
}

export function recordComposerHistory(workspaceSessionKey: string, prompt: string): void {
  const next = appendComposerHistory(loadComposerHistory(workspaceSessionKey), prompt)
  saveLocalStorage(storageKey(workspaceSessionKey), JSON.stringify(next))
}

/** Index into `entries` of the recalled prompt, or null while the user is editing a fresh draft. */
export type ComposerHistoryCursor = number | null

export interface ComposerHistoryStep {
  cursor: ComposerHistoryCursor
  text: string
}

/**
 * Moves through history only when that cannot discard user work: the draft is
 * empty or still exactly the recalled entry. Returns null to let the key act
 * normally (move the caret, or do nothing at the end of history).
 */
export function stepComposerHistory(
  entries: readonly string[],
  cursor: ComposerHistoryCursor,
  draft: string,
  direction: 'older' | 'newer'
): ComposerHistoryStep | null {
  const recalled = cursor !== null && cursor >= 0 && cursor < entries.length ? cursor : null
  const browsing = recalled !== null && entries[recalled] === draft
  if (!browsing && draft !== '') return null
  if (direction === 'older') {
    const next = browsing ? recalled - 1 : entries.length - 1
    if (next < 0) return null
    return { cursor: next, text: entries[next] }
  }
  if (!browsing) return null
  const next = recalled + 1
  return next < entries.length ? { cursor: next, text: entries[next] } : { cursor: null, text: '' }
}

/** ArrowUp recalls only from the first line and ArrowDown only from the last, so multi-line editing is unaffected. */
export function caretAllowsHistoryStep(text: string, selectionStart: number, selectionEnd: number, direction: 'older' | 'newer'): boolean {
  if (selectionStart !== selectionEnd) return false
  return direction === 'older'
    ? !text.slice(0, selectionStart).includes('\n')
    : !text.slice(selectionEnd).includes('\n')
}
