import type { WorkspaceProfileScope } from '@shared/types'

export const COMPOSER_DRAFT_APPEND_EVENT = 'agentsdock:append-composer-draft'

export interface ComposerDraftAppendDetail {
  scope: WorkspaceProfileScope
  sessionId: string
  text: string
}

/** Let the matching mounted composer append to its current, possibly unsaved text. */
export function appendComposerDraft(source: HTMLElement, scope: WorkspaceProfileScope, sessionId: string, text: string): boolean {
  if (!source.isConnected || !text.trim()) return false
  const event = new CustomEvent<ComposerDraftAppendDetail>(COMPOSER_DRAFT_APPEND_EVENT, {
    bubbles: true, cancelable: true, detail: { scope: { ...scope }, sessionId, text }
  })
  source.dispatchEvent(event)
  return event.defaultPrevented
}
