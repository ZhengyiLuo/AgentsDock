import type { CodeDiffFileSummary, Event } from '../types'

const PATCH_CHANGE_SIGNAL = /diff --git |\*\*\* (?:begin patch|update file:|add file:|delete file:)/iu
const MAX_FALLBACK_REVIEWS = 8
export const MAX_REVIEW_SOURCE_CHARACTERS = 512 * 1024
export const MAX_REVIEW_SOURCE_LINES = 600
export const MAX_REVIEW_LINE_CHARACTERS = 4_000
export const MAX_REVIEW_FILES = 64

interface StructuredToolChange {
  path: string
  operation: 'Add' | 'Update' | 'Delete'
  diffs: string[]
  additions: number
  deletions: number
}

export interface StructuredToolDiffSummary {
  files: CodeDiffFileSummary[]
  filesChanged: number
  additions: number
  deletions: number
}

export type DiffConflictSide = 'ours' | 'base' | 'theirs'
export type DiffConflictMarker = 'start' | 'base' | 'separator' | 'end'

export interface DiffLine {
  kind: 'add' | 'remove' | 'context' | 'header' | 'hunk'
  text: string
  oldLine?: number
  newLine?: number
  oldStart?: number
  oldCount?: number
  newStart?: number
  newCount?: number
  conflictBlock?: number
  conflictSide?: DiffConflictSide
  conflictMarker?: DiffConflictMarker
  conflictLabel?: string
}

export interface DiffFile {
  path: string
  additions: number
  deletions: number
  conflictCount: number
  isCombinedDiff: boolean
  lines: DiffLine[]
}

export interface CodeReviewFallback {
  profileGeneration: number
  sessionId: string
  runId: string
  source: string
  files: CodeDiffFileSummary[]
  additions: number
  deletions: number
  truncated: boolean
}

export interface LimitedReviewSource {
  source: string
  truncated: boolean
}

const reviewFallbacks = new Map<string, CodeReviewFallback>()

export function extractUnifiedDiff(events: Event[]): string {
  const structured = extractStructuredToolDiff(events)
  const candidates = [structured]
  for (const event of events) candidates.push(...[event.output, event.text, event.message, ...toolInputTexts(event)].filter((value): value is string => Boolean(value)))
  const seen = new Set<string>()
  let source = ''
  for (const candidate of candidates) {
    if (!candidate) continue
    const boundedCandidate = limitReviewSource(candidate).source
    if (!hasTimelineChangeSignal(boundedCandidate) || seen.has(boundedCandidate)) continue
    seen.add(boundedCandidate)
    const next = limitReviewSource(`${source}${source ? '\n\n---\n\n' : ''}${boundedCandidate}`)
    source = next.source
    if (next.truncated) break
  }
  return source
}

/** Recover Codex app-server fileChange/apply_patch hunks when code_diff is absent. */
export function extractStructuredToolDiff(events: Event[]): string {
  let source = ''
  for (const change of structuredToolChanges(events).values()) {
    const candidate = [`*** ${change.operation} File: ${change.path}`, ...change.diffs].join('\n')
    const next = limitReviewSource(`${source}${source ? '\n\n' : ''}${candidate}`)
    source = next.source
    if (next.truncated) break
  }
  return source
}

export function summarizeStructuredToolDiff(events: Event[]): StructuredToolDiffSummary | null {
  const changes = [...structuredToolChanges(events).values()]
  if (!changes.length) return null
  const files = changes.map(change => ({
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
    binary: false,
  }))
  return {
    files,
    filesChanged: files.length,
    additions: changes.reduce((sum, change) => sum + change.additions, 0),
    deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
  }
}

export function reviewFallbackForEvents(profileGeneration: number, sessionId: string, runId: string, events: Event[]): CodeReviewFallback | null {
  const source = limitReviewSource(extractUnifiedDiff(events)).source
  const parsed = parseReviewableDiff(source)
  if (!parsed.length) return null
  return {
    profileGeneration,
    sessionId,
    runId,
    source,
    files: parsed.map(file => ({ path: file.path, additions: file.additions, deletions: file.deletions, binary: false })),
    additions: parsed.reduce((sum, file) => sum + file.additions, 0),
    deletions: parsed.reduce((sum, file) => sum + file.deletions, 0),
    truncated: reviewSourceAtLimit(source),
  }
}

export function registerCodeReviewFallback(fallback: CodeReviewFallback): void {
  const key = reviewFallbackKey(fallback.profileGeneration, fallback.sessionId, fallback.runId)
  const limited = limitReviewSource(fallback.source)
  const parsed = parseReviewableDiff(limited.source)
  const boundedFallback: CodeReviewFallback = {
    ...fallback,
    source: limited.source,
    files: parsed.map(file => ({ path: file.path, additions: file.additions, deletions: file.deletions, binary: false })),
    additions: parsed.reduce((sum, file) => sum + file.additions, 0),
    deletions: parsed.reduce((sum, file) => sum + file.deletions, 0),
    truncated: fallback.truncated || limited.truncated,
  }
  reviewFallbacks.delete(key)
  reviewFallbacks.set(key, boundedFallback)
  while (reviewFallbacks.size > MAX_FALLBACK_REVIEWS) {
    const oldest = reviewFallbacks.keys().next().value as string | undefined
    if (!oldest) break
    reviewFallbacks.delete(oldest)
  }
}

export function codeReviewFallback(profileGeneration: number, sessionId: string, runId: string): CodeReviewFallback | null {
  return reviewFallbacks.get(reviewFallbackKey(profileGeneration, sessionId, runId)) ?? null
}

export function clearCodeReviewFallbacks(): void {
  reviewFallbacks.clear()
}

function reviewFallbackKey(profileGeneration: number, sessionId: string, runId: string): string {
  return `${profileGeneration}\0${sessionId}\0${runId}`
}

function structuredToolChanges(events: Event[]): Map<string, StructuredToolChange> {
  const changesByPath = new Map<string, StructuredToolChange>()
  const seenChanges = new Set<string>()
  let remainingCharacters = MAX_REVIEW_SOURCE_CHARACTERS
  for (const event of events) {
    const tool = event.tool
    if (!tool || !isApplyPatchTool(tool.name) || !tool.input || Array.isArray(tool.input) || typeof tool.input !== 'object') continue
    const changes = (tool.input as Record<string, unknown>).changes
    if (!Array.isArray(changes)) continue
    const toolId = String(tool.id || event.tool_id || '')
    for (const candidateValue of changes) {
      if (!candidateValue || Array.isArray(candidateValue) || typeof candidateValue !== 'object') continue
      const candidate = candidateValue as Record<string, unknown>
      const rawPath = typeof candidate.path === 'string' ? candidate.path : candidate.filePath
      const path = typeof rawPath === 'string' ? rawPath.trim() : ''
      if (!path || /[\r\n\0]/u.test(path)) continue
      if (!changesByPath.has(path) && changesByPath.size >= MAX_REVIEW_FILES) continue
      const rawDiff = typeof candidate.diff === 'string' ? candidate.diff : ''
      if (!rawDiff) continue
      if (!remainingCharacters) return changesByPath
      const operation = structuredChangeOperation(candidate.kind)
      const identity = `${toolId || event.id}\0${path}\0${operation}\0${rawDiff.length}\0${rawDiff.slice(0, 128)}\0${rawDiff.slice(-128)}`
      if (seenChanges.has(identity)) continue
      seenChanges.add(identity)
      const diff = limitReviewSource(rawDiff.slice(0, remainingCharacters)).source.trim()
      if (!diff) continue
      remainingCharacters = Math.max(0, remainingCharacters - diff.length)
      let additions = 0
      let deletions = 0
      for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
        else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
      }
      const existing = changesByPath.get(path)
      if (existing) {
        existing.diffs.push(diff)
        existing.additions += additions
        existing.deletions += deletions
        if (operation === 'Delete') existing.operation = 'Delete'
        else if (operation === 'Add' && existing.operation === 'Delete') existing.operation = 'Update'
      } else {
        changesByPath.set(path, { path, operation, diffs: [diff], additions, deletions })
      }
      if (!remainingCharacters) return changesByPath
    }
  }
  return changesByPath
}

function isApplyPatchTool(name: string): boolean {
  const leaf = name.trim().toLocaleLowerCase().replaceAll('-', '_').split(/[/.]/u).at(-1)
  return leaf === 'apply_patch' || leaf === 'applypatch' || leaf === 'patch'
}

function structuredChangeOperation(value: unknown): 'Add' | 'Update' | 'Delete' {
  const raw = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string'
      ? String((value as { type: string }).type)
      : ''
  const normalized = raw.trim().toLocaleLowerCase()
  if (normalized === 'add' || normalized === 'create') return 'Add'
  if (normalized === 'delete' || normalized === 'remove') return 'Delete'
  return 'Update'
}

function hasTimelineChangeSignal(value: string): boolean {
  return PATCH_CHANGE_SIGNAL.test(value)
    || (/^---\s/mu.test(value) && /^\+\+\+\s/mu.test(value))
    || /^(?: M|M |MM|AM| A|A |\?\?| D|D | R|R )\s+\S+/mu.test(value)
}

function toolInputTexts(event: Event): string[] {
  const input = event.tool?.input
  if (!input) return []
  if (typeof input === 'string') return [input]
  if (Array.isArray(input)) return input.filter((item): item is string => typeof item === 'string')
  if (typeof input === 'object') return Object.values(input).filter((item): item is string => typeof item === 'string')
  return []
}

export function parseReviewableDiff(source: string): DiffFile[] {
  return parseUnifiedDiff(source).filter(file => file.lines.some(line => (
    line.kind === 'hunk'
    || line.kind === 'add'
    || line.kind === 'remove'
    || (line.kind === 'header' && (
      /^diff --git /u.test(line.text)
      || /^\*\*\* (?:Update|Add|Delete) File:/u.test(line.text)
      || /^Binary files /u.test(line.text)
      || /^(?:old|new) mode \d+/u.test(line.text)
    ))
  )))
}

export function limitReviewSource(source: string): LimitedReviewSource {
  const characterLimit = Math.min(source.length, MAX_REVIEW_SOURCE_CHARACTERS)
  const lines: string[] = []
  let lineStart = 0
  let truncated = source.length > characterLimit
  for (let index = 0; index <= characterLimit && lines.length < MAX_REVIEW_SOURCE_LINES; index += 1) {
    if (index < characterLimit && source.charCodeAt(index) !== 10) continue
    const rawLength = index - lineStart
    if (rawLength > MAX_REVIEW_LINE_CHARACTERS) truncated = true
    lines.push(source.slice(lineStart, Math.min(index, lineStart + MAX_REVIEW_LINE_CHARACTERS)))
    lineStart = index + 1
  }
  if (lineStart <= characterLimit || characterLimit < source.length) truncated = true
  return { source: lines.join('\n'), truncated }
}

function reviewSourceAtLimit(source: string): boolean {
  if (source.length >= MAX_REVIEW_SOURCE_CHARACTERS) return true
  let lineLength = 0
  let lineCount = 1
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      if (lineLength >= MAX_REVIEW_LINE_CHARACTERS) return true
      lineLength = 0
      lineCount += 1
      if (lineCount >= MAX_REVIEW_SOURCE_LINES) return true
    } else {
      lineLength += 1
    }
  }
  return lineLength >= MAX_REVIEW_LINE_CHARACTERS
}

export function parseUnifiedDiff(source: string): DiffFile[] {
  const limitedSource = limitReviewSource(source).source
  if (!limitedSource.trim()) return []
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of limitedSource.split('\n')) {
    const patchFile = line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.+)$/iu)
    if (patchFile) {
      if (files.length >= MAX_REVIEW_FILES) break
      current = createDiffFile(cleanDiffPath(patchFile[2]), line)
      files.push(current); oldLine = 1; newLine = 1; inHunk = true; continue
    }
    const combinedFile = line.match(/^diff --(?:cc|combined)\s+(.+)$/u)
    if (combinedFile) {
      if (files.length >= MAX_REVIEW_FILES) break
      current = { ...createDiffFile(cleanDiffPath(combinedFile[1]), line), isCombinedDiff: true }
      files.push(current); inHunk = false; continue
    }
    if (line.startsWith('diff --git ')) {
      if (files.length >= MAX_REVIEW_FILES) break
      const match = line.match(/\s"?b\/(.+?)"?$/u)
      current = createDiffFile(cleanDiffPath(match?.[1] ?? 'Changes'), line)
      files.push(current); inHunk = false; continue
    }
    if (!current) {
      if (line.startsWith('--- ')) {
        if (files.length >= MAX_REVIEW_FILES) break
        current = createDiffFile(cleanDiffPath(line.slice(4)))
        files.push(current)
      } else {
        const status = line.match(/^(?: M|M |MM|AM| A|A |\?\?| D|D | R|R )\s+(.+)$/u)
        if (status && files.length < MAX_REVIEW_FILES) files.push(createDiffFile(cleanDiffPath(status[1]), line))
        continue
      }
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]); inHunk = true
      current.lines.push({
        kind: 'hunk', text: line,
        oldStart: oldLine, oldCount: Number(hunk[2] ?? 1),
        newStart: newLine, newCount: Number(hunk[4] ?? 1),
      })
      continue
    }
    if (line.startsWith('@@')) {
      inHunk = true
      current.lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (!inHunk) {
      current.lines.push({ kind: 'header', text: line })
      if (line.startsWith('+++ ') && current.path === '/dev/null') current.path = cleanDiffPath(line.slice(4))
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.additions += 1; current.lines.push({ kind: 'add', text: line.slice(1), newLine: newLine++ }); continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions += 1; current.lines.push({ kind: 'remove', text: line.slice(1), oldLine: oldLine++ }); continue
    }
    if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ }); continue
    }
    current.lines.push({ kind: 'header', text: line })
  }
  files.forEach(annotateDiffConflicts)
  return files
}

function createDiffFile(path: string, header?: string): DiffFile {
  return {
    path,
    additions: 0,
    deletions: 0,
    conflictCount: 0,
    isCombinedDiff: false,
    lines: header ? [{ kind: 'header', text: header }] : [],
  }
}

interface DiffConflictBoundary {
  marker: DiffConflictMarker
  width: number
  label?: string
}

function diffConflictBoundary(text: string): DiffConflictBoundary | null {
  const normalized = text.endsWith('\r') ? text.slice(0, -1) : text
  const start = normalized.match(/^(<{7,})(?:[\t ]+(.+))?$/u)
  if (start) return { marker: 'start', width: start[1].length, label: start[2]?.trim() || undefined }
  const base = normalized.match(/^(\|{7,})(?:[\t ]+(.+))?$/u)
  if (base) return { marker: 'base', width: base[1].length, label: base[2]?.trim() || undefined }
  const separator = normalized.match(/^(={7,})[\t ]*$/u)
  if (separator) return { marker: 'separator', width: separator[1].length }
  const end = normalized.match(/^(>{7,})(?:[\t ]+(.+))?$/u)
  if (end) return { marker: 'end', width: end[1].length, label: end[2]?.trim() || undefined }
  return null
}

function annotateDiffConflicts(file: DiffFile): void {
  if (file.isCombinedDiff) return
  type PendingLine = { line: DiffLine; side: DiffConflictSide; boundary: DiffConflictBoundary | null }
  let candidate: { width: number; side: DiffConflictSide; phase: DiffConflictSide; lines: PendingLine[] } | null = null
  for (const line of file.lines) {
    if (line.kind !== 'add' && line.kind !== 'context') continue
    const boundary = diffConflictBoundary(line.text)
    if (!candidate) {
      if (boundary?.marker === 'start') candidate = { width: boundary.width, side: 'ours', phase: 'ours', lines: [{ line, side: 'ours', boundary }] }
      continue
    }
    let valid = true
    if (boundary) {
      valid = boundary.width === candidate.width
      if (valid && boundary.marker === 'base') {
        valid = candidate.phase === 'ours'
        if (valid) candidate.phase = candidate.side = 'base'
      } else if (valid && boundary.marker === 'separator') {
        valid = candidate.phase === 'ours' || candidate.phase === 'base'
        if (valid) candidate.phase = candidate.side = 'theirs'
      } else if (valid && boundary.marker === 'end') {
        valid = candidate.phase === 'theirs'
      } else if (boundary.marker === 'start') valid = false
    }
    if (!valid) {
      candidate = null
      continue
    }
    candidate.lines.push({ line, side: candidate.side, boundary })
    if (boundary?.marker !== 'end') continue
    const block = file.conflictCount + 1
    for (const pending of candidate.lines) {
      pending.line.conflictBlock = block
      pending.line.conflictSide = pending.side
      if (pending.boundary) {
        pending.line.conflictMarker = pending.boundary.marker
        pending.line.conflictLabel = pending.boundary.label
      }
    }
    file.conflictCount = block
    candidate = null
  }
}

function cleanDiffPath(value: string): string {
  return value.trim().replace(/^[ab]\//u, '').replace(/^["'`]|["'`]$/gu, '')
}
