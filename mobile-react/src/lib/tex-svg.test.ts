import assert from 'node:assert/strict'

import { TEX_SVG_LIMITS, texToSvg } from './tex-svg'

const inline = texToSvg(String.raw`x^2 + y^2 = z^2`, false)
assert(inline, 'ordinary inline TeX should render')
assert.match(inline.xml, /^<svg\b/)
assert(!/<mjx-container/.test(inline.xml), 'the browser-only MathJax container must be removed')
assert(!/\bstyle=/.test(inline.xml.slice(0, inline.xml.indexOf('>') + 1)), 'browser-only root styles must be removed')
assert.match(inline.xml, /currentColor/)
assert.match(inline.xml, /<defs>/, 'local font caching should keep glyph definitions in each SVG')
assert.match(inline.xml, /<use\b/, 'local font caching should reuse glyph definitions')
assert(inline.widthEm > inline.heightEm)
assert(inline.heightEm > 0)
assert(inline.depthEm >= 0 && inline.depthEm < inline.heightEm)

const viewBox = inline.xml.match(/\bviewBox="([^"]+)"/)?.[1]?.split(/[\s,]+/u).map(Number)
assert(viewBox && viewBox.length === 4)
assert.equal(inline.widthEm, viewBox[2]! / 1_000, 'width should come from MathJax viewBox units')
assert.equal(inline.heightEm, viewBox[3]! / 1_000, 'height should come from MathJax viewBox units')
assert.equal(inline.depthEm, Math.max(0, (viewBox[3]! + viewBox[1]!) / 1_000), 'depth should come from the viewBox baseline')

const display = texToSvg(String.raw`\begin{aligned}a&=b+c\\d&=e+f\end{aligned}`, true)
assert(display, 'AMS display environments should render')
assert(display.heightEm > inline.heightEm)

const customMacro = texToSvg(String.raw`\newcommand{\R}{\mathbb{R}}\R^2`, false)
assert(customMacro, 'bounded custom macros should render')

assert.equal(texToSvg(String.raw`\qty{x}`, false), null, 'packages outside base, AMS, and newcommand should stay literal')
assert.equal(texToSvg(String.raw`\frac{missing`, false), null, 'malformed TeX should stay literal')
assert.equal(texToSvg('   ', false), null, 'empty TeX should stay literal')
assert.equal(texToSvg(`x${' '.repeat(TEX_SVG_LIMITS.maxSourceLength)}`, false), null, 'oversized TeX should be rejected before conversion')

const tooWide = texToSvg('x'.repeat(600), false)
assert.equal(tooWide, null, 'formulas exceeding SVG node or dimension limits should stay literal')

const tallMatrix = `${String.raw`\begin{matrix}`}${Array.from({ length: 60 }, () => '1').join(String.raw`\\`)}${String.raw`\end{matrix}`}`
assert(tallMatrix.length < TEX_SVG_LIMITS.maxSourceLength)
assert.equal(texToSvg(tallMatrix, true), null, 'pathologically tall formulas should stay literal')

assert.equal(texToSvg(String.raw`x^2 + y^2 = z^2`, false), inline, 'identical formulas should reuse the LRU entry')

const firstEvictionCandidate = texToSvg('q_0', false)
assert(firstEvictionCandidate)
for (let index = 1; index <= TEX_SVG_LIMITS.maxCacheEntries; index += 1) {
  assert(texToSvg(`q_{${index}}`, false), `cache-fill formula ${index} should render`)
}
const afterEviction = texToSvg('q_0', false)
assert(afterEviction)
assert.notEqual(afterEviction, firstEvictionCandidate, 'the bounded LRU should evict its oldest entry')

console.log('bounded TeX to SVG regressions passed')
