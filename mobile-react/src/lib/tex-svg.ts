const TEX_SOURCE_LIMIT = 1_024
const SVG_CHARACTER_LIMIT = 256_000
const SVG_ELEMENT_LIMIT = 1_024
const SVG_WIDTH_EM_LIMIT = 256
const SVG_HEIGHT_EM_LIMIT = 64
const CACHE_ENTRY_LIMIT = 128
const CACHE_CHARACTER_LIMIT = 4_000_000

const MATHJAX_EM = 16
const MATHJAX_X_HEIGHT = 0.442

export const TEX_SVG_LIMITS = Object.freeze({
  maxSourceLength: TEX_SOURCE_LIMIT,
  maxSvgCharacters: SVG_CHARACTER_LIMIT,
  maxSvgElements: SVG_ELEMENT_LIMIT,
  maxWidthEm: SVG_WIDTH_EM_LIMIT,
  maxHeightEm: SVG_HEIGHT_EM_LIMIT,
  maxCacheEntries: CACHE_ENTRY_LIMIT,
  maxCacheCharacters: CACHE_CHARACTER_LIMIT,
})

export interface TexSvg {
  /** Standalone, self-contained SVG XML whose glyphs use currentColor. */
  xml: string
  /** Intrinsic dimensions in MathJax em units. */
  widthEm: number
  heightEm: number
  /** Portion of the formula below the text baseline, in em units. */
  depthEm: number
}

interface MathJaxAdaptor {
  firstChild(node: unknown): unknown
  outerHTML(node: unknown): string
}

interface MathJaxInput {
  reset(): void
  readonly parseOptions: { readonly error: boolean }
}

interface MathJaxDocument {
  convert(source: string, options: {
    display: boolean
    em: number
    ex: number
    containerWidth: number
    lineWidth: number
    scale: number
  }): unknown
}

interface MathJaxRuntime {
  adaptor: MathJaxAdaptor
  input: MathJaxInput
  document: MathJaxDocument
}

interface CacheEntry {
  value: TexSvg | null
  svgCharacters: number
}

interface MathJaxRuntimeState {
  initialized: boolean
  value: MathJaxRuntime | null
}

const runtimeGlobal = globalThis as typeof globalThis & {
  __agentsdockMathJaxRuntimeState?: MathJaxRuntimeState
}
// Fast Refresh can evaluate this module again. Preserve the registered HTML
// handler and document so MathJax is initialized at most once per JS runtime.
const runtimeState = runtimeGlobal.__agentsdockMathJaxRuntimeState ??= {
  initialized: false,
  value: null,
}
const cache = new Map<string, CacheEntry>()
let cachedSvgCharacters = 0

/**
 * Convert bounded TeX to a self-contained SVG for react-native-svg.
 *
 * MathJax is loaded only when the first valid formula is converted. Every
 * failure is contained and represented by null so callers can show the raw
 * source without taking down the surrounding Markdown or timeline.
 */
export function texToSvg(source: string, display: boolean): TexSvg | null {
  if (!source || source.length > TEX_SOURCE_LIMIT) return null
  const tex = source.trim()
  if (!tex) return null

  const key = `${display ? 'display' : 'inline'}\u0000${tex}`
  const cached = takeCached(key)
  if (cached !== undefined) return cached

  const mathJax = getRuntime()
  if (!mathJax) return cacheResult(key, null)

  let result: TexSvg | null = null
  try {
    mathJax.input.reset()
    const container = mathJax.document.convert(tex, {
      display,
      em: MATHJAX_EM,
      ex: MATHJAX_EM * MATHJAX_X_HEIGHT,
      containerWidth: MATHJAX_EM * SVG_WIDTH_EM_LIMIT,
      lineWidth: MATHJAX_EM * SVG_WIDTH_EM_LIMIT,
      scale: 1,
    })
    if (!mathJax.input.parseOptions.error) {
      result = validatedSvg(mathJax.adaptor.outerHTML(mathJax.adaptor.firstChild(container)))
    }
  } catch {
    result = null
  }

  return cacheResult(key, result)
}

function getRuntime(): MathJaxRuntime | null {
  if (runtimeState.initialized) return runtimeState.value
  try {
    const { mathjax } = require('mathjax-full/js/mathjax.js') as typeof import('mathjax-full/js/mathjax.js')
    const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js') as typeof import('mathjax-full/js/adaptors/liteAdaptor.js')
    const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js') as typeof import('mathjax-full/js/handlers/html.js')
    const { TeX } = require('mathjax-full/js/input/tex.js') as typeof import('mathjax-full/js/input/tex.js')
    const { SVG } = require('mathjax-full/js/output/svg.js') as typeof import('mathjax-full/js/output/svg.js')

    // The TeX entry point registers base. Load only the two extensions needed
    // for common model output instead of AllPackages and its wider surface.
    require('mathjax-full/js/input/tex/ams/AmsConfiguration.js')
    require('mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js')

    const adaptor = liteAdaptor()
    RegisterHTMLHandler(adaptor)
    const input = new TeX({
      packages: ['base', 'ams', 'newcommand'],
      maxBuffer: TEX_SOURCE_LIMIT,
      maxMacros: 1_000,
    })
    const output = new SVG({
      fontCache: 'local',
      internalSpeechTitles: false,
    })
    const document = mathjax.document('', { InputJax: input, OutputJax: output })
    runtimeState.value = { adaptor, input, document } as unknown as MathJaxRuntime
  } catch {
    runtimeState.value = null
  }
  runtimeState.initialized = true
  return runtimeState.value
}

function validatedSvg(serialized: string): TexSvg | null {
  if (!serialized.startsWith('<svg') || serialized.length > SVG_CHARACTER_LIMIT) return null
  if (countElements(serialized, SVG_ELEMENT_LIMIT) > SVG_ELEMENT_LIMIT) return null

  const openingEnd = serialized.indexOf('>')
  if (openingEnd < 0) return null
  const opening = serialized.slice(0, openingEnd + 1)
  const viewBox = opening.match(/\bviewBox="([^"]+)"/)?.[1]
  if (!viewBox) return null
  const values = viewBox.trim().split(/[\s,]+/u).map(Number)
  if (values.length !== 4 || values.some(value => !Number.isFinite(value))) return null

  const [, minimumY, width, height] = values
  if (!(width > 0) || !(height > 0) || minimumY > 0) return null
  const widthEm = width / 1_000
  const heightEm = height / 1_000
  const depthEm = (height + minimumY) / 1_000
  if (
    !(widthEm > 0) || widthEm > SVG_WIDTH_EM_LIMIT
    || !(heightEm > 0) || heightEm > SVG_HEIGHT_EM_LIMIT
    || depthEm < -0.000_1 || depthEm > heightEm + 0.000_1
  ) return null

  // CSS vertical-align is browser-only. Native text attachments reserve the
  // SVG's full measured height, so passing that CSS through SvgXml would be
  // unsupported and would not affect React Native line metrics.
  const cleanOpening = opening.replace(/\sstyle="[^"]*"/u, '')
  const xml = cleanOpening + serialized.slice(openingEnd + 1)
  return {
    xml,
    widthEm,
    heightEm,
    depthEm: Math.max(0, depthEm),
  }
}

/** Count opening XML elements, stopping immediately once the bound is lost. */
function countElements(xml: string, limit: number): number {
  let count = 0
  let cursor = 0
  while ((cursor = xml.indexOf('<', cursor)) >= 0) {
    const next = xml.charCodeAt(cursor + 1)
    if ((next >= 65 && next <= 90) || (next >= 97 && next <= 122)) {
      count += 1
      if (count > limit) return count
    }
    cursor += 1
  }
  return count
}

function takeCached(key: string): TexSvg | null | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function cacheResult(key: string, value: TexSvg | null): TexSvg | null {
  const previous = cache.get(key)
  if (previous) {
    cachedSvgCharacters -= previous.svgCharacters
    cache.delete(key)
  }
  const entry = { value, svgCharacters: value?.xml.length ?? 0 }
  cache.set(key, entry)
  cachedSvgCharacters += entry.svgCharacters

  while (cache.size > CACHE_ENTRY_LIMIT || cachedSvgCharacters > CACHE_CHARACTER_LIMIT) {
    const oldestKey = cache.keys().next().value as string | undefined
    if (oldestKey == null) break
    const oldest = cache.get(oldestKey)
    if (oldest) cachedSvgCharacters -= oldest.svgCharacters
    cache.delete(oldestKey)
  }
  return value
}
