const FALLBACK_MIN_HEIGHT = 46
const FALLBACK_MAX_HEIGHT = 190
const GEOMETRY_TOLERANCE = 2

export interface ComposerEditorReferenceSpan {
  source_text_start: number
  source_text_end: number
}

export interface ComposerEditorLayoutFrame {
  current: number | null
}

function pixelValue(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) ? parsed : fallback
}

function borderSize(style: CSSStyleDeclaration | null, axis: 'inline' | 'block'): number {
  if (!style) return 0
  return axis === 'inline'
    ? pixelValue(style.borderLeftWidth, 0) + pixelValue(style.borderRightWidth, 0)
    : pixelValue(style.borderTopWidth, 0) + pixelValue(style.borderBottomWidth, 0)
}

function computedStyle(element: Element): CSSStyleDeclaration | null {
  return element.ownerDocument.defaultView?.getComputedStyle(element) ?? null
}

function nativeFieldSizingAvailable(textarea: HTMLTextAreaElement): boolean {
  return textarea.ownerDocument.defaultView?.CSS?.supports?.('field-sizing', 'content') === true
}

function clearLegacyEditorSizing(textarea: HTMLTextAreaElement): void {
  if (textarea.style.height) textarea.style.removeProperty('height')
  if (textarea.style.overflowY) textarea.style.removeProperty('overflow-y')
}

function syncNativeComposerEditorMirror(
  textarea: HTMLTextAreaElement,
  mirror: HTMLDivElement | null
): boolean | null {
  if (!mirror) return null
  // Native field sizing keeps both layers in the same grid cell. Let CSS own
  // their dimensions and copy only the textarea viewport; reading client or
  // scroll extents here would force layout on every structured-draft update.
  if (mirror.style.width) mirror.style.removeProperty('width')
  if (mirror.style.height) mirror.style.removeProperty('height')
  mirror.scrollTop = textarea.scrollTop
  mirror.scrollLeft = textarea.scrollLeft
  mirror.dataset.composerMirrorAligned = 'true'
  mirror.style.visibility = 'visible'
  return true
}

/** Keep the native textarea authoritative for text, caret, selection and IME. */
export function layoutComposerEditor(
  textarea: HTMLTextAreaElement | null,
  mirror: HTMLDivElement | null
): boolean | null {
  if (!textarea) return null

  // Current Electron builds let Chromium size the textarea from its content.
  // Keep the measured fallback for older runtimes, but never force layout on
  // every keystroke when native field sizing is available. In that mode CSS
  // also owns mirror geometry, so synchronization only copies its viewport.
  if (nativeFieldSizingAvailable(textarea)) {
    clearLegacyEditorSizing(textarea)
    return syncNativeComposerEditorMirror(textarea, mirror)
  }

  const style = computedStyle(textarea)
  const minHeight = pixelValue(style?.minHeight, FALLBACK_MIN_HEIGHT)
  const maxHeight = Math.max(minHeight, pixelValue(style?.maxHeight, FALLBACK_MAX_HEIGHT))
  const blockBorder = borderSize(style, 'block')
  const previousScrollTop = textarea.scrollTop
  const previousScrollHeight = textarea.scrollHeight
  const previousClientHeight = textarea.clientHeight
  const caretAtEnd = textarea.selectionStart === textarea.value.length
    && textarea.selectionEnd === textarea.value.length
  const wasPinnedToBottom = caretAtEnd
    && previousScrollTop + previousClientHeight >= previousScrollHeight - GEOMETRY_TOLERANCE

  // Measure without a transient scrollbar changing line wrapping halfway
  // through the same paste/layout pass.
  textarea.style.height = 'auto'
  textarea.style.overflowY = 'hidden'
  const naturalHeight = Math.max(minHeight, Math.ceil(textarea.scrollHeight + blockBorder))
  const nextHeight = Math.min(naturalHeight, maxHeight)
  const capped = naturalHeight > maxHeight
  textarea.style.height = `${nextHeight}px`
  textarea.style.overflowY = capped ? 'auto' : 'hidden'

  const maximumScrollTop = Math.max(0, textarea.scrollHeight - textarea.clientHeight)
  textarea.scrollTop = wasPinnedToBottom
    ? maximumScrollTop
    : Math.min(previousScrollTop, maximumScrollTop)

  return syncComposerEditorMirror(textarea, mirror)
}

/**
 * Coalesce textarea geometry work to one pass per animation frame. Reading
 * scrollHeight after changing height forces Chromium to lay out the document,
 * so doing it synchronously for every input event makes fast typing stall.
 */
export function scheduleComposerEditorLayout(
  textarea: HTMLTextAreaElement | null,
  mirror: HTMLDivElement | null,
  frame: ComposerEditorLayoutFrame,
  onMirrorAlignment?: (aligned: boolean) => void
): void {
  if (!textarea || frame.current !== null) return
  if (nativeFieldSizingAvailable(textarea)) {
    clearLegacyEditorSizing(textarea)
    const aligned = syncNativeComposerEditorMirror(textarea, mirror)
    if (aligned !== null) onMirrorAlignment?.(aligned)
    return
  }
  const view = textarea.ownerDocument.defaultView
  if (!view) return
  frame.current = view.requestAnimationFrame(() => {
    frame.current = null
    const aligned = layoutComposerEditor(textarea, mirror)
    if (aligned !== null) onMirrorAlignment?.(aligned)
  })
}

export function cancelComposerEditorLayout(
  textarea: HTMLTextAreaElement | null,
  frame: ComposerEditorLayoutFrame
): void {
  if (frame.current === null) return
  textarea?.ownerDocument.defaultView?.cancelAnimationFrame(frame.current)
  frame.current = null
}

/**
 * Match the decoration mirror to the actual textarea viewport. If Chromium
 * still lays the two elements out differently, hide only the decorations so
 * native text and its caret can never appear off-axis.
 */
export function syncComposerEditorMirror(
  textarea: HTMLTextAreaElement | null,
  mirror: HTMLDivElement | null
): boolean | null {
  if (!textarea || !mirror) return null
  if (nativeFieldSizingAvailable(textarea)) {
    return syncNativeComposerEditorMirror(textarea, mirror)
  }

  const mirrorStyle = computedStyle(mirror)
  mirror.style.width = `${textarea.clientWidth + borderSize(mirrorStyle, 'inline')}px`
  mirror.style.height = `${textarea.clientHeight + borderSize(mirrorStyle, 'block')}px`
  mirror.scrollTop = textarea.scrollTop
  mirror.scrollLeft = textarea.scrollLeft

  const aligned = Math.abs(mirror.scrollHeight - textarea.scrollHeight) <= GEOMETRY_TOLERANCE
    && Math.abs(mirror.scrollWidth - textarea.scrollWidth) <= GEOMETRY_TOLERANCE
  mirror.dataset.composerMirrorAligned = aligned ? 'true' : 'false'
  mirror.style.visibility = aligned ? 'visible' : 'hidden'
  return aligned
}

/** Observe split-pane/container width changes without reacting to our height. */
export function observeComposerEditorWidth(
  textarea: HTMLTextAreaElement | null,
  relayout: () => void
): () => void {
  const editor = textarea?.parentElement
  const ResizeObserverConstructor = textarea?.ownerDocument.defaultView?.ResizeObserver
  if (!editor || !ResizeObserverConstructor) return () => undefined

  let width = editor.clientWidth
  const observer = new ResizeObserverConstructor(() => {
    const nextWidth = editor.clientWidth
    if (Math.abs(nextWidth - width) <= GEOMETRY_TOLERANCE) return
    width = nextWidth
    relayout()
  })
  observer.observe(editor)
  return () => observer.disconnect()
}

export function composerTextCanUseMirror(
  text: string,
  references: readonly ComposerEditorReferenceSpan[]
): boolean {
  // Long tokens and invisible formatting controls can wrap differently in a
  // textarea and ordinary inline layout. Native text remains fully usable;
  // unsafe decorations render in a separate badge rail instead.
  const decoratedEnd = references.reduce(
    (end, reference) => Math.max(end, reference.source_text_end),
    0
  )
  const decoratedPrefix = text.slice(0, decoratedEnd)
  return !/\S{40,}/u.test(decoratedPrefix)
    && !/[\t\u200b\u200c\u200d\ufeff]/u.test(decoratedPrefix)
}
