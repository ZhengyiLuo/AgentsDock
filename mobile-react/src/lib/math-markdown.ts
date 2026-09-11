import { matchMathAt, type MathDelimiter } from './math'

const FORMULA_COUNT_KEY = '__agentsdockMathFormulaCount'
export const MATH_MARKDOWN_FORMULA_LIMIT = 32
const MATH_DISPLAY_BLOCK_SOURCE_LIMIT = 4_100

interface MarkdownTokenLike {
  block: boolean
  content: string
  markup: string
  meta: unknown
  map: [number, number] | null
}

interface MarkdownInlineStateLike {
  src: string
  pos: number
  posMax: number
  pending: string
  env: Record<string, unknown>
  push: (type: string, tag: string, nesting: number) => MarkdownTokenLike
}

type MarkdownInlineRule = (state: MarkdownInlineStateLike, silent: boolean) => boolean

interface MarkdownBlockStateLike {
  src: string
  bMarks: number[]
  eMarks: number[]
  tShift: number[]
  sCount: number[]
  blkIndent: number
  line: number
  env: Record<string, unknown>
  push: (type: string, tag: string, nesting: number) => MarkdownTokenLike
}

type MarkdownBlockRule = (
  state: MarkdownBlockStateLike,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean

interface MarkdownItLike {
  block: {
    ruler: {
      before: (
        beforeName: string,
        ruleName: string,
        rule: MarkdownBlockRule,
        options: { alt: string[] },
      ) => void
    }
  }
  inline: {
    ruler: {
      before: (beforeName: string, ruleName: string, rule: MarkdownInlineRule) => void
    }
  }
}

/** Add lossless chat-math tokens before Markdown's backslash escaping rule. */
export function installMathMarkdown<T extends MarkdownItLike>(markdown: T): T {
  markdown.block.ruler.before('paragraph', 'agentsdock_math_display', mathMarkdownBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })
  markdown.inline.ruler.before('escape', 'agentsdock_math', mathMarkdownInlineRule)
  return markdown
}

/** Promote standalone display delimiters to a structurally safe block token. */
export const mathMarkdownBlockRule: MarkdownBlockRule = (state, startLine, endLine, silent) => {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false
  const start = state.bMarks[startLine]! + state.tShift[startLine]!
  const firstEnd = trimLineEnd(state.src, state.bMarks[startLine]!, state.eMarks[startLine]!)
  const opening = displayOpeningAt(state.src, start)
  if (!opening || start + opening.length > firstEnd) return false

  for (let line = startLine; line < endLine; line += 1) {
    const candidateEnd = trimLineEnd(state.src, state.bMarks[line]!, state.eMarks[line]!)
    if (candidateEnd - start > MATH_DISPLAY_BLOCK_SOURCE_LIMIT) return false
    const candidate = state.src.slice(start, candidateEnd)
    const match = matchMathAt(candidate, 0)
    if (!match || !match.display || match.end !== candidate.length) continue
    if (silent) return true

    const count = formulaCount(state.env)
    const token = state.push('math_display', 'math', 0)
    token.block = true
    token.content = count < MATH_MARKDOWN_FORMULA_LIMIT ? match.content : ''
    token.markup = opening
    token.meta = { raw: match.raw, display: true }
    token.map = [startLine, line + 1]
    if (count < MATH_MARKDOWN_FORMULA_LIMIT) setFormulaCount(state.env, count + 1)
    state.line = line + 1
    return true
  }
  return false
}

export const mathMarkdownInlineRule: MarkdownInlineRule = (state, silent) => {
  const match = matchMathAt(state.src, state.pos)
  if (!match || match.end > state.posMax) {
    // Markdown normally consumes the slash from unmatched \(...\) / \[...\].
    // Preserve all legacy delimiter fragments verbatim when they are not a
    // valid formula so malformed model output never changes silently.
    const fragment = state.src.slice(state.pos, state.pos + 2)
    if (!['\\(', '\\)', '\\[', '\\]'].includes(fragment)) return false
    if (!silent) state.pending += fragment
    state.pos += fragment.length
    return true
  }

  if (silent) {
    state.pos = match.end
    return true
  }

  const currentCount = formulaCount(state.env)
  if (currentCount >= MATH_MARKDOWN_FORMULA_LIMIT) {
    state.pending += match.raw
    state.pos = match.end
    return true
  }

  // Display delimiters embedded inside prose/emphasis cannot safely become a
  // block in Markdown's inline token stream. Render their TeX style inline;
  // standalone display delimiters are promoted by the block rule above.
  const token = state.push('math_inline', 'math', 0)
  token.block = false
  token.content = match.content
  token.markup = openingDelimiter(match.delimiter)
  token.meta = { raw: match.raw, display: match.display }
  setFormulaCount(state.env, currentCount + 1)
  state.pos = match.end
  return true
}

function displayOpeningAt(source: string, start: number): '$$' | '\\[' | null {
  if (source.startsWith('$$', start) && source[start + 2] !== '$') return '$$'
  if (source.startsWith('\\[', start)) return '\\['
  return null
}

function trimLineEnd(source: string, start: number, end: number): number {
  let cursor = end
  while (cursor > start && (source[cursor - 1] === ' ' || source[cursor - 1] === '\t' || source[cursor - 1] === '\r')) cursor -= 1
  return cursor
}

function formulaCount(environment: Record<string, unknown>): number {
  const count = environment[FORMULA_COUNT_KEY]
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0
}

function setFormulaCount(environment: Record<string, unknown>, count: number): void {
  environment[FORMULA_COUNT_KEY] = count
}

function openingDelimiter(delimiter: MathDelimiter): string {
  if (delimiter === 'dollar-display') return '$$'
  if (delimiter === 'legacy-display') return '\\['
  if (delimiter === 'legacy-inline') return '\\('
  return '$'
}
