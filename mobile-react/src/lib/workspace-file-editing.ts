export interface WorkspaceEditableText {
  content: string
  truncated?: boolean
  revision?: string
  writable?: boolean
}

export type WorkspaceFileDepartureDecision =
  | { kind: 'leave' }
  | { kind: 'confirm_discard' }
  | { kind: 'confirm_saving'; hasNewerDraft: boolean }

export function workspaceTextIsDirectlyEditable(value: WorkspaceEditableText, saveAvailable: boolean, limit: number): boolean {
  return Boolean(
    saveAvailable
      && value.writable
      && !value.truncated
      && utf8ByteLength(value.content) <= limit
      && typeof value.revision === 'string'
      && /^[a-f0-9]{64}$/i.test(value.revision),
  )
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function workspaceFileDepartureDecision(saving: boolean, dirty: boolean, hasNewerDraft: boolean): WorkspaceFileDepartureDecision {
  if (saving) return { kind: 'confirm_saving', hasNewerDraft }
  if (dirty) return { kind: 'confirm_discard' }
  return { kind: 'leave' }
}
