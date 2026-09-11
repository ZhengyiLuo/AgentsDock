import type { CodeEditorThemeId } from './codeEditorTheme'
import { isCodeEditorThemeId } from './codeEditorTheme'

export const CODE_EDITOR_PROTOCOL_VERSION = 1 as const
export const CODE_EDITOR_NATIVE_SOURCE = 'agentsdock-native' as const
export const CODE_EDITOR_ENGINE_SOURCE = 'agentsdock-code-editor' as const

export interface CodeEditorChange {
  from: number
  to: number
  insert: string
}

export interface CodeEditorFoldRange {
  from: number
  to: number
}

export interface CodeEditorViewState {
  anchor: number
  head: number
  scrollTop: number
  scrollLeft: number
  folds?: CodeEditorFoldRange[]
  foldDocument?: string
}

export interface CodeEditorSnapshot {
  content: string
  utf8Bytes: number
  lines: number
  viewState: CodeEditorViewState
}

export type CodeEditorExecuteAction =
  | 'undo'
  | 'redo'
  | 'find'
  | 'replace'
  | 'gotoLine'
  | 'deleteLine'
  | 'indent'
  | 'fold'
  | 'unfold'
  | 'toggleFold'
  | 'foldAll'
  | 'unfoldAll'

interface CodeEditorDocumentCommand {
  path: string
  content: string
  readOnly: boolean
  maxBytes: number
  viewState?: CodeEditorViewState
}

export type CodeEditorHostCommand =
  | ({ type: 'initialize'; theme: CodeEditorThemeId; fontSize: number } & CodeEditorDocumentCommand)
  | ({ type: 'replaceDocument' } & CodeEditorDocumentCommand)
  | { type: 'setReadOnly'; readOnly: boolean }
  | { type: 'setAppearance'; theme: CodeEditorThemeId; fontSize: number }
  | { type: 'focus' }
  | { type: 'blur' }
  | { type: 'flush' }
  | { type: 'flushAndBlur' }
  | { type: 'execute'; action: CodeEditorExecuteAction; line?: number; column?: number }

export interface CodeEditorHostMessage {
  source: typeof CODE_EDITOR_NATIVE_SOURCE
  version: typeof CODE_EDITOR_PROTOCOL_VERSION
  sequence: number
  requestId?: string
  command: CodeEditorHostCommand
}

export type CodeEditorEngineEvent =
  | { type: 'ready' }
  | { type: 'initialized'; snapshot: CodeEditorSnapshot }
  | { type: 'changed'; changes: CodeEditorChange[]; utf8Bytes: number; lines: number; viewState: CodeEditorViewState }
  | { type: 'snapshot'; snapshot: CodeEditorSnapshot }
  | { type: 'blurred'; snapshot: CodeEditorSnapshot }
  | { type: 'ack'; command: CodeEditorHostCommand['type'] }
  | { type: 'focusChanged'; focused: boolean }
  | { type: 'limitExceeded'; maxBytes: number; attemptedBytes: number }
  | { type: 'error'; code: string; message: string }

export interface CodeEditorEngineMessage {
  source: typeof CODE_EDITOR_ENGINE_SOURCE
  version: typeof CODE_EDITOR_PROTOCOL_VERSION
  sequence: number
  requestId?: string
  event: CodeEditorEngineEvent
}

export function parseCodeEditorHostMessage(raw: unknown): CodeEditorHostMessage | null {
  const value = parsedJSONValue(raw)
  if (!isRecord(value)
    || value.source !== CODE_EDITOR_NATIVE_SOURCE
    || value.version !== CODE_EDITOR_PROTOCOL_VERSION
    || !isSequence(value.sequence)
    || !isOptionalRequestId(value.requestId)
    || !isCodeEditorHostCommand(value.command)) return null
  return value as unknown as CodeEditorHostMessage
}

export function parseCodeEditorEngineMessage(raw: unknown): CodeEditorEngineMessage | null {
  const value = parsedJSONValue(raw)
  if (!isRecord(value)
    || value.source !== CODE_EDITOR_ENGINE_SOURCE
    || value.version !== CODE_EDITOR_PROTOCOL_VERSION
    || !isSequence(value.sequence)
    || !isOptionalRequestId(value.requestId)
    || !isCodeEditorEngineEvent(value.event)) return null
  return value as unknown as CodeEditorEngineMessage
}

export function serializeCodeEditorHostMessage(message: CodeEditorHostMessage): string {
  return JSON.stringify(message)
}

export function serializeCodeEditorEngineMessage(message: CodeEditorEngineMessage): string {
  return JSON.stringify(message)
}

export function codeEditorSequenceIsNewer(lastAccepted: number, candidate: number): boolean {
  return isSequence(candidate) && candidate > lastAccepted
}

export function codeEditorUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function applyCodeEditorChanges(document: string, changes: readonly CodeEditorChange[]): string {
  assertCodeEditorChanges(document, changes)
  let cursor = 0
  let result = ''
  for (const change of changes) {
    result += document.slice(cursor, change.from)
    result += change.insert
    cursor = change.to
  }
  return result + document.slice(cursor)
}

export function codeEditorUtf8BytesAfterChanges(
  document: string,
  currentBytes: number,
  changes: readonly CodeEditorChange[],
): number {
  if (!Number.isSafeInteger(currentBytes) || currentBytes < 0) throw new Error('Current UTF-8 byte count is invalid.')
  assertCodeEditorChanges(document, changes)
  let nextBytes = currentBytes
  for (const change of changes) {
    nextBytes -= codeEditorUtf8ByteLength(document.slice(change.from, change.to))
    nextBytes += codeEditorUtf8ByteLength(change.insert)
  }
  return nextBytes
}

function parsedJSONValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isCodeEditorHostCommand(value: unknown): value is CodeEditorHostCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'initialize') {
    return isDocumentCommand(value)
      && isCodeEditorThemeId(value.theme)
      && isFiniteNumber(value.fontSize)
  }
  if (value.type === 'replaceDocument') return isDocumentCommand(value)
  if (value.type === 'setReadOnly') return typeof value.readOnly === 'boolean'
  if (value.type === 'setAppearance') return isCodeEditorThemeId(value.theme) && isFiniteNumber(value.fontSize)
  if (['focus', 'blur', 'flush', 'flushAndBlur'].includes(value.type)) return true
  if (value.type !== 'execute' || !isCodeEditorExecuteAction(value.action)) return false
  return (value.line === undefined || isPositiveInteger(value.line))
    && (value.column === undefined || isPositiveInteger(value.column))
}

function isDocumentCommand(value: Record<string, unknown>): boolean {
  return typeof value.path === 'string'
    && typeof value.content === 'string'
    && typeof value.readOnly === 'boolean'
    && isNonnegativeInteger(value.maxBytes)
    && (value.viewState === undefined || isCodeEditorViewState(value.viewState))
}

function isCodeEditorExecuteAction(value: unknown): value is CodeEditorExecuteAction {
  return typeof value === 'string' && [
    'undo', 'redo', 'find', 'replace', 'gotoLine', 'deleteLine', 'indent',
    'fold', 'unfold', 'toggleFold', 'foldAll', 'unfoldAll',
  ].includes(value)
}

function isCodeEditorEngineEvent(value: unknown): value is CodeEditorEngineEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'ready') return true
  if (value.type === 'initialized' || value.type === 'snapshot' || value.type === 'blurred') {
    return isCodeEditorSnapshot(value.snapshot)
  }
  if (value.type === 'changed') {
    return Array.isArray(value.changes)
      && value.changes.every(isCodeEditorChange)
      && changesAreOrdered(value.changes)
      && isNonnegativeInteger(value.utf8Bytes)
      && isPositiveInteger(value.lines)
      && isCodeEditorViewState(value.viewState)
  }
  if (value.type === 'ack') return typeof value.command === 'string' && [
    'initialize', 'replaceDocument', 'setReadOnly', 'setAppearance', 'focus',
    'blur', 'flush', 'flushAndBlur', 'execute',
  ].includes(value.command)
  if (value.type === 'focusChanged') return typeof value.focused === 'boolean'
  if (value.type === 'limitExceeded') return isNonnegativeInteger(value.maxBytes) && isNonnegativeInteger(value.attemptedBytes)
  return value.type === 'error' && typeof value.code === 'string' && typeof value.message === 'string'
}

function isCodeEditorSnapshot(value: unknown): value is CodeEditorSnapshot {
  return isRecord(value)
    && typeof value.content === 'string'
    && isNonnegativeInteger(value.utf8Bytes)
    && isPositiveInteger(value.lines)
    && isCodeEditorViewState(value.viewState)
}

function isCodeEditorViewState(value: unknown): value is CodeEditorViewState {
  if (!isRecord(value)
    || !isNonnegativeInteger(value.anchor)
    || !isNonnegativeInteger(value.head)
    || !isNonnegativeFiniteNumber(value.scrollTop)
    || !isNonnegativeFiniteNumber(value.scrollLeft)
    || (value.foldDocument !== undefined && typeof value.foldDocument !== 'string')) return false
  return value.folds === undefined
    || Array.isArray(value.folds) && value.folds.every(isCodeEditorFoldRange)
}

function isCodeEditorFoldRange(value: unknown): value is CodeEditorFoldRange {
  return isRecord(value)
    && isNonnegativeInteger(value.from)
    && isNonnegativeInteger(value.to)
    && value.from < value.to
}

function isCodeEditorChange(value: unknown): value is CodeEditorChange {
  return isRecord(value)
    && isNonnegativeInteger(value.from)
    && isNonnegativeInteger(value.to)
    && value.from <= value.to
    && typeof value.insert === 'string'
}

function assertCodeEditorChanges(document: string, changes: readonly CodeEditorChange[]): void {
  if (!changesAreOrdered(changes)) throw new Error('Editor changes must be ordered and non-overlapping.')
  if (changes.some(change => change.to > document.length)) throw new Error('Editor change exceeds the document bounds.')
}

function changesAreOrdered(changes: readonly CodeEditorChange[]): boolean {
  let previousTo = 0
  for (const change of changes) {
    if (!isCodeEditorChange(change) || change.from < previousTo) return false
    previousTo = change.to
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalRequestId(value: unknown): boolean {
  return value === undefined || typeof value === 'string' && value.length > 0
}

function isSequence(value: unknown): value is number {
  return isPositiveInteger(value) && Number.isSafeInteger(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}
