export type MathDelimiter = 'dollar-inline' | 'dollar-display' | 'legacy-inline' | 'legacy-display'

export interface MathScanLimits {
  maxSourceLength: number
  maxFormulaLength: number
  maxFormulas: number
}

export const DEFAULT_MATH_SCAN_LIMITS: Readonly<MathScanLimits> = Object.freeze({
  maxSourceLength: 100_000,
  maxFormulaLength: 4_096,
  maxFormulas: 128,
})

export interface MathMatch {
  kind: 'math'
  delimiter: MathDelimiter
  display: boolean
  start: number
  end: number
  contentStart: number
  contentEnd: number
  content: string
  raw: string
}

export interface MathTextSegment { kind: 'text'; start: number; end: number; value: string }
export type MathSegment = MathTextSegment | MathMatch
export interface MathScanResult { segments: MathSegment[]; formulaCount: number; limited: boolean }
export interface MarkdownFoldResult { visible: string; cutIndex: number; folded: boolean }

interface DelimiterDefinition {
  delimiter: MathDelimiter
  opening: string
  closing: string
  display: boolean
}

interface MatchAttempt { match: MathMatch | null; limited: boolean }

const DELIMITERS: readonly DelimiterDefinition[] = [
  { delimiter: 'dollar-display', opening: '$$', closing: '$$', display: true },
  { delimiter: 'legacy-display', opening: '\\[', closing: '\\]', display: true },
  { delimiter: 'legacy-inline', opening: '\\(', closing: '\\)', display: false },
  { delimiter: 'dollar-inline', opening: '$', closing: '$', display: false },
]

export function matchMathAt(source: string, start: number, limits: Partial<MathScanLimits> = {}): MathMatch | null {
  const resolved = resolveLimits(limits)
  if (source.length > resolved.maxSourceLength || start < 0 || start >= source.length) return null
  return attemptMathAt(source, start, resolved).match
}

/** Losslessly split Markdown around valid formulas while leaving code literal. */
export function scanMath(source: string, limits: Partial<MathScanLimits> = {}): MathScanResult {
  const resolved = resolveLimits(limits)
  if (!source) return { segments: [], formulaCount: 0, limited: false }
  if (source.length > resolved.maxSourceLength || resolved.maxFormulas === 0) {
    return { segments: [textSegment(source, 0, source.length)], formulaCount: 0, limited: source.length > resolved.maxSourceLength }
  }

  const segments: MathSegment[] = []
  let textStart = 0
  let index = 0
  let formulaCount = 0
  let limited = false
  while (index < source.length) {
    const codeEnd = protectedCodeEnd(source, index)
    if (codeEnd != null) { index = codeEnd; continue }
    const attempt = attemptMathAt(source, index, resolved)
    limited ||= attempt.limited
    if (!attempt.match) { index += 1; continue }
    if (formulaCount >= resolved.maxFormulas) { limited = true; break }
    if (textStart < index) segments.push(textSegment(source, textStart, index))
    segments.push(attempt.match)
    formulaCount += 1
    index = attempt.match.end
    textStart = index
  }
  if (textStart < source.length) segments.push(textSegment(source, textStart, source.length))
  return { segments, formulaCount, limited }
}

export function scanMathSegments(source: string, limits: Partial<MathScanLimits> = {}): MathSegment[] {
  return scanMath(source, limits).segments
}

export function mathSegmentsSource(segments: readonly MathSegment[]): string {
  return segments.map(segment => segment.kind === 'math' ? segment.raw : segment.value).join('')
}

/** Fold without cutting through a valid formula, inline code, or fenced code. */
export function foldMarkdownSource(source: string, limit: number, limits: Partial<MathScanLimits> = {}): MarkdownFoldResult {
  const requested = safeCodeUnitBoundary(source, clampInteger(limit, 0, source.length))
  if (requested >= source.length) return { visible: source, cutIndex: source.length, folded: false }
  const protectedStart = protectedStartContaining(source, requested, resolveLimits(limits))
  const cutIndex = safeCodeUnitBoundary(source, protectedStart ?? requested)
  return { visible: source.slice(0, cutIndex), cutIndex, folded: true }
}

function attemptMathAt(source: string, start: number, limits: MathScanLimits): MatchAttempt {
  const definition = delimiterAt(source, start)
  if (!definition) return { match: null, limited: false }
  const contentStart = start + definition.opening.length
  if (definition.delimiter === 'dollar-inline' && isWhitespace(source[contentStart])) return { match: null, limited: false }

  let cursor = contentStart
  while (cursor < source.length) {
    if (!definition.display && isLineBreak(source[cursor])) return { match: null, limited: false }
    if (cursor - contentStart > limits.maxFormulaLength) return { match: null, limited: true }
    if (source.startsWith(definition.closing, cursor) && isValidClosing(source, cursor, definition)) {
      const content = source.slice(contentStart, cursor)
      if (!content.trim()) return { match: null, limited: false }
      if (definition.delimiter === 'dollar-inline' && content.includes('`')) {
        return { match: null, limited: false }
      }
      // An earlier unescaped dollar that could not close (for example the
      // second currency amount in "$5 today, not $x$") must not be swallowed
      // into one large numeric-leading formula.
      if (definition.delimiter === 'dollar-inline' && containsUnescapedDollar(source, contentStart, cursor)) {
        return { match: null, limited: false }
      }
      const end = cursor + definition.closing.length
      return {
        limited: false,
        match: {
          kind: 'math', delimiter: definition.delimiter, display: definition.display,
          start, end, contentStart, contentEnd: cursor, content, raw: source.slice(start, end),
        },
      }
    }
    cursor += 1
  }
  return { match: null, limited: false }
}

function containsUnescapedDollar(source: string, start: number, end: number): boolean {
  for (let cursor = start; cursor < end; cursor += 1) {
    if (source[cursor] === '$' && !isEscapedAt(source, cursor)) return true
  }
  return false
}

function delimiterAt(source: string, start: number): DelimiterDefinition | null {
  if (isEscapedAt(source, start)) return null
  for (const definition of DELIMITERS) {
    if (!source.startsWith(definition.opening, start)) continue
    if (definition.delimiter === 'dollar-display' && dollarRunLength(source, start) !== 2) continue
    if (definition.delimiter === 'dollar-inline') {
      if (dollarRunLength(source, start) !== 1) continue
      const next = source[start + 1]
      // A closing delimiter is required, which already leaves ordinary
      // currency such as "$5" literal while allowing valid `$2+2=4$` TeX.
      if (next == null || isWhitespace(next)) continue
    }
    return definition
  }
  return null
}

function isValidClosing(source: string, start: number, definition: DelimiterDefinition): boolean {
  if (isEscapedAt(source, start)) return false
  if (definition.delimiter === 'dollar-display') return dollarRunLength(source, start) === 2
  if (definition.delimiter !== 'dollar-inline') return true
  if (dollarRunLength(source, start) !== 1) return false
  const previous = source[start - 1]
  const next = source[start + 1]
  return previous != null && !isWhitespace(previous) && (next == null || !isAsciiDigit(next))
}

function protectedStartContaining(source: string, cutIndex: number, limits: MathScanLimits): number | null {
  let index = 0
  while (index < cutIndex) {
    const codeEnd = protectedCodeEnd(source, index)
    if (codeEnd != null) {
      if (index < cutIndex && cutIndex < codeEnd) return index
      index = codeEnd
      continue
    }
    const match = attemptMathAt(source, index, limits).match
    if (match) {
      if (index < cutIndex && cutIndex < match.end) return index
      index = match.end
      continue
    }
    index += 1
  }
  return null
}

function protectedCodeEnd(source: string, start: number): number | null {
  const fence = fenceAtLineStart(source, start)
  if (fence) return findFenceEnd(source, fence.contentStart, fence.character, fence.length)
  if (source[start] !== '`') return null
  const length = runLength(source, start, '`')
  let cursor = start + length
  while (cursor < source.length) {
    const candidate = source.indexOf('`', cursor)
    if (candidate < 0) return null
    const candidateLength = runLength(source, candidate, '`')
    if (candidateLength === length) return candidate + length
    cursor = candidate + candidateLength
  }
  return null
}

function fenceAtLineStart(source: string, start: number): { character: '`' | '~'; length: number; contentStart: number } | null {
  if (start !== 0 && source[start - 1] !== '\n') return null
  let cursor = start
  let indentation = 0
  while (source[cursor] === ' ' && indentation < 4) { cursor += 1; indentation += 1 }
  if (indentation > 3) return null
  const character = source[cursor]
  if (character !== '`' && character !== '~') return null
  const length = runLength(source, cursor, character)
  if (length < 3) return null
  const lineEnd = source.indexOf('\n', cursor + length)
  return { character, length, contentStart: lineEnd < 0 ? source.length : lineEnd + 1 }
}

function findFenceEnd(source: string, start: number, character: '`' | '~', openingLength: number): number {
  let lineStart = start
  while (lineStart < source.length) {
    let cursor = lineStart
    let indentation = 0
    while (source[cursor] === ' ' && indentation < 4) { cursor += 1; indentation += 1 }
    if (indentation <= 3 && source[cursor] === character) {
      const length = runLength(source, cursor, character)
      const lineEnd = source.indexOf('\n', cursor + length)
      const end = lineEnd < 0 ? source.length : lineEnd
      const trailing = source.slice(cursor + length, end).replace(/\r$/, '')
      if (length >= openingLength && !trailing.trim()) return lineEnd < 0 ? source.length : lineEnd + 1
    }
    const lineEnd = source.indexOf('\n', lineStart)
    if (lineEnd < 0) break
    lineStart = lineEnd + 1
  }
  return source.length
}

function textSegment(source: string, start: number, end: number): MathTextSegment {
  return { kind: 'text', start, end, value: source.slice(start, end) }
}

function resolveLimits(limits: Partial<MathScanLimits>): MathScanLimits {
  return {
    maxSourceLength: positiveInteger(limits.maxSourceLength, DEFAULT_MATH_SCAN_LIMITS.maxSourceLength),
    maxFormulaLength: positiveInteger(limits.maxFormulaLength, DEFAULT_MATH_SCAN_LIMITS.maxFormulaLength),
    maxFormulas: nonNegativeInteger(limits.maxFormulas, DEFAULT_MATH_SCAN_LIMITS.maxFormulas),
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

function safeCodeUnitBoundary(source: string, index: number): number {
  if (index <= 0 || index >= source.length) return index
  const previous = source.charCodeAt(index - 1)
  const current = source.charCodeAt(index)
  return previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF ? index - 1 : index
}

function isEscapedAt(source: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) backslashes += 1
  return backslashes % 2 === 1
}

function dollarRunLength(source: string, start: number): number {
  let beginning = start
  while (beginning > 0 && source[beginning - 1] === '$') beginning -= 1
  return runLength(source, beginning, '$')
}

function runLength(source: string, start: number, character: string): number {
  let cursor = start
  while (source[cursor] === character) cursor += 1
  return cursor - start
}

function isWhitespace(character: string | undefined): boolean { return character != null && /\s/u.test(character) }
function isLineBreak(character: string): boolean { return character === '\n' || character === '\r' }
function isAsciiDigit(character: string): boolean { return character >= '0' && character <= '9' }
