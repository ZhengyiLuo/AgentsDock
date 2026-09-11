import {
  foldMarkdownSource,
  mathSegmentsSource,
  matchMathAt,
  scanMath,
  scanMathSegments,
} from './math'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function formulaContents(source: string): string[] {
  return scanMathSegments(source)
    .filter(segment => segment.kind === 'math')
    .map(segment => segment.kind === 'math' ? segment.content : '')
}

const delimiters = scanMath('Inline $x+1$, display $$\\sum_i x_i$$, legacy \\( y \\), and \\[z^2\\].')
assert(delimiters.formulaCount === 4, 'all supported delimiters must be recognized')
assert(mathSegmentsSource(delimiters.segments) === 'Inline $x+1$, display $$\\sum_i x_i$$, legacy \\( y \\), and \\[z^2\\].', 'scanning must be lossless')
assert(formulaContents('\\( x + y \\)')[0] === ' x + y ', 'legacy inline math may contain delimiter-adjacent whitespace')

const protectedMarkdown = '`$inline$`\n```tex\n$$block$$\n```\nReal $value$'
assert(formulaContents(protectedMarkdown).join(',') === 'value', 'code spans and fences must remain literal')
assert(formulaContents('Escaped \\$value$ and \\\\(legacy\\)').length === 0, 'escaped openers must remain literal')

assert(formulaContents('It costs $5 today, not $x$.').join(',') === 'x', 'currency must not become math')
assert(formulaContents('Arithmetic $2+2=4$ and ratio $1/n$.').join(',') === '2+2=4,1/n', 'numeric-leading TeX must be recognized')
assert(formulaContents('A literal formula $5$.').join(',') === '5', 'a closed numeric formula must not be mistaken for open-ended currency')
assert(scanMath('$ x$ and $x $').formulaCount === 0, 'dollar delimiters with adjacent whitespace must remain literal')
assert(scanMath('$$$ambiguous$$$').formulaCount === 0, 'ambiguous dollar runs must remain literal')
assert(scanMath('$open only').formulaCount === 0, 'unmatched delimiters must remain literal')
assert(scanMath('$line\nbreak$').formulaCount === 0, 'inline math may not cross a line break')
assert(formulaContents('$$line\nbreak$$')[0] === 'line\nbreak', 'display math may span lines')

assert(matchMathAt('$abc$', 0, { maxFormulaLength: 2 }) === null, 'formula length limit must be enforced')
const countLimited = scanMath('$a$ $b$', { maxFormulas: 1 })
assert(countLimited.formulaCount === 1 && countLimited.limited, 'formula count limit must preserve the unparsed tail')
assert(mathSegmentsSource(countLimited.segments) === '$a$ $b$', 'limited scanning must remain lossless')
const sourceLimited = scanMath('$x$', { maxSourceLength: 2 })
assert(sourceLimited.formulaCount === 0 && sourceLimited.limited, 'source length limit must fail closed')

const formulaFold = foldMarkdownSource(`before $${'x'.repeat(30)}$ after`, 15)
assert(formulaFold.visible === 'before ', 'folding must move before a formula instead of splitting it')
const codeFold = foldMarkdownSource('before `literal code` after', 14)
assert(codeFold.visible === 'before ', 'folding must move before an inline code span')
const fenceFold = foldMarkdownSource('before\n```\nlong code\n```\nafter', 16)
assert(fenceFold.visible === 'before\n', 'folding must move before a fenced code block')
const emojiSource = `abc😀def`
const emojiFold = foldMarkdownSource(emojiSource, 4)
assert(!emojiFold.visible.endsWith('\uD83D'), 'folding must not split a surrogate pair')

console.log('Math scanning and folding regressions passed')
