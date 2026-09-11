import {
  applyCodeEditorChanges,
  codeEditorUtf8ByteLength,
  codeEditorUtf8BytesAfterChanges,
  type CodeEditorEngineMessage,
  type CodeEditorSnapshot,
  type CodeEditorViewState,
} from './codeEditorProtocol'

export type MobileCodeEditorRecoveryReason =
  | 'sequence-gap'
  | 'invalid-change'
  | 'metadata-mismatch'

export interface MobileCodeEditorMirror {
  content: string
  cleanContent: string
  utf8Bytes: number
  lines: number
  viewState: CodeEditorViewState
  sequence: number
  engineReady: boolean
  initialized: boolean
  focused: boolean
  recovering: boolean
  dirty: boolean
  error: string | null
}

export interface MobileCodeEditorTransition {
  mirror: MobileCodeEditorMirror
  accepted: boolean
  contentChanged: boolean
  needsSnapshot: boolean
  recoveryReason?: MobileCodeEditorRecoveryReason
  acknowledgedSnapshot?: CodeEditorSnapshot
}

const EMPTY_VIEW_STATE: CodeEditorViewState = {
  anchor: 0,
  head: 0,
  scrollTop: 0,
  scrollLeft: 0,
}

export function createMobileCodeEditorMirror(
  content: string,
  viewState: CodeEditorViewState = EMPTY_VIEW_STATE,
): MobileCodeEditorMirror {
  return {
    content,
    cleanContent: content,
    utf8Bytes: codeEditorUtf8ByteLength(content),
    lines: countDocumentLines(content),
    viewState,
    sequence: 0,
    engineReady: false,
    initialized: false,
    focused: false,
    recovering: false,
    dirty: false,
    error: null,
  }
}

export function resetMobileCodeEditorEngine(
  mirror: MobileCodeEditorMirror,
): MobileCodeEditorMirror {
  return {
    ...mirror,
    sequence: 0,
    engineReady: false,
    initialized: false,
    focused: false,
    recovering: true,
    error: null,
  }
}

export function replaceMobileCodeEditorDocument(
  mirror: MobileCodeEditorMirror,
  content: string,
  clean = true,
): MobileCodeEditorMirror {
  return {
    ...mirror,
    content,
    cleanContent: clean ? content : mirror.cleanContent,
    utf8Bytes: codeEditorUtf8ByteLength(content),
    lines: countDocumentLines(content),
    dirty: clean ? false : content !== mirror.cleanContent,
    error: null,
  }
}

export function markMobileCodeEditorClean(
  mirror: MobileCodeEditorMirror,
  content = mirror.content,
): MobileCodeEditorMirror {
  return {
    ...mirror,
    cleanContent: content,
    dirty: mirror.content !== content,
  }
}

export function acceptMobileCodeEditorMessage(
  mirror: MobileCodeEditorMirror,
  message: CodeEditorEngineMessage,
): MobileCodeEditorTransition {
  if (message.sequence <= mirror.sequence) return unchanged(mirror)

  const event = message.event
  const fullSnapshot = event.type === 'initialized' || event.type === 'snapshot' || event.type === 'blurred'
  if (message.sequence !== mirror.sequence + 1 && !fullSnapshot) {
    return recover(mirror, 'sequence-gap')
  }

  if (event.type === 'ready') {
    return accepted({
      ...mirror,
      sequence: message.sequence,
      engineReady: true,
      error: null,
    })
  }

  if (fullSnapshot) {
    const next = mirrorFromSnapshot(mirror, message.sequence, event.snapshot)
    return {
      mirror: next,
      accepted: true,
      contentChanged: next.content !== mirror.content,
      needsSnapshot: false,
      acknowledgedSnapshot: event.snapshot,
    }
  }

  if (event.type === 'changed') {
    let content: string
    let utf8Bytes: number
    try {
      content = applyCodeEditorChanges(mirror.content, event.changes)
      utf8Bytes = codeEditorUtf8BytesAfterChanges(mirror.content, mirror.utf8Bytes, event.changes)
    } catch {
      return recover(mirror, 'invalid-change')
    }
    const lines = lineCountAfterChanges(mirror.content, mirror.lines, event.changes)
    if (utf8Bytes !== event.utf8Bytes || lines !== event.lines) {
      return recover(mirror, 'metadata-mismatch')
    }
    return {
      mirror: {
        ...mirror,
        content,
        utf8Bytes,
        lines,
        viewState: event.viewState,
        sequence: message.sequence,
        initialized: true,
        recovering: false,
        dirty: content !== mirror.cleanContent,
        error: null,
      },
      accepted: true,
      contentChanged: content !== mirror.content,
      needsSnapshot: false,
    }
  }

  if (event.type === 'focusChanged') {
    return accepted({ ...mirror, sequence: message.sequence, focused: event.focused })
  }

  if (event.type === 'error') {
    return accepted({ ...mirror, sequence: message.sequence, error: event.message })
  }

  return accepted({ ...mirror, sequence: message.sequence })
}

export function snapshotFromMobileCodeEditorMirror(mirror: MobileCodeEditorMirror): CodeEditorSnapshot {
  return {
    content: mirror.content,
    utf8Bytes: mirror.utf8Bytes,
    lines: mirror.lines,
    viewState: mirror.viewState,
  }
}

export function countDocumentLines(content: string): number {
  return countNewlines(content) + 1
}

function mirrorFromSnapshot(
  mirror: MobileCodeEditorMirror,
  sequence: number,
  snapshot: CodeEditorSnapshot,
): MobileCodeEditorMirror {
  return {
    ...mirror,
    content: snapshot.content,
    utf8Bytes: snapshot.utf8Bytes,
    lines: snapshot.lines,
    viewState: snapshot.viewState,
    sequence,
    engineReady: true,
    initialized: true,
    recovering: false,
    dirty: snapshot.content !== mirror.cleanContent,
    error: null,
  }
}

function lineCountAfterChanges(
  content: string,
  currentLines: number,
  changes: readonly { from: number; to: number; insert: string }[],
): number {
  let lines = currentLines
  for (const change of changes) {
    lines -= countNewlines(content.slice(change.from, change.to))
    lines += countNewlines(change.insert)
  }
  return Math.max(1, lines)
}

function countNewlines(value: string): number {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1
  }
  return count
}

function unchanged(mirror: MobileCodeEditorMirror): MobileCodeEditorTransition {
  return { mirror, accepted: false, contentChanged: false, needsSnapshot: false }
}

function accepted(mirror: MobileCodeEditorMirror): MobileCodeEditorTransition {
  return { mirror, accepted: true, contentChanged: false, needsSnapshot: false }
}

function recover(
  mirror: MobileCodeEditorMirror,
  recoveryReason: MobileCodeEditorRecoveryReason,
): MobileCodeEditorTransition {
  return {
    mirror: { ...mirror, recovering: true },
    accepted: false,
    contentChanged: false,
    needsSnapshot: true,
    recoveryReason,
  }
}
