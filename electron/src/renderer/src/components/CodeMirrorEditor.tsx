import { useEffect, useRef, useState } from 'react'
import { getLocale } from '@shared/i18n'
import { t, useLocale } from '../lib/i18n'
import { deleteLine, indentWithTab, redo, undo } from '@codemirror/commands'
import {
  foldAll,
  foldCode,
  foldEffect,
  foldedRanges,
  foldService,
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
  toggleFold,
  unfoldAll,
  unfoldCode
} from '@codemirror/language'
import {
  getSearchQuery,
  closeSearchPanel,
  gotoLine,
  openSearchPanel,
  setSearchQuery,
  searchPanelOpen,
  type SearchQuery
} from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, Prec, Text, type Extension } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin, type MouseSelectionStyle, type ViewUpdate } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import {
  DEFAULT_EDITOR_APPEARANCE,
  clampEditorFontSize,
  editorThemeDefinition,
  resolveEditorTheme,
  type EditorThemeId,
  type EditorThemeMode,
  type EditorThemePreference
} from '../lib/editor-appearance'

interface CodeMirrorEditorProps {
  path: string
  value: string
  readOnly: boolean
  ariaLabel: string
  theme?: EditorThemePreference
  fontSize?: number
  maxBytes?: number
  initialViewState?: CodeMirrorViewState
  navigationRequest?: CodeMirrorNavigationRequest
  onLimitExceeded?: () => void
  onNavigationHandled?: (requestId: number) => void
  onScrollElementChange?: (element: HTMLElement | null) => void
  onViewStateChange?: (state: CodeMirrorViewState) => void
  onChange: (value: string, lines: number) => void
}

export interface CodeMirrorNavigationRequest {
  requestId: number
  line: number
  column?: number
}

export interface CodeMirrorViewState {
  anchor: number
  head: number
  scrollTop: number
  scrollLeft: number
  folds?: Array<{ from: number, to: number }>
  foldDocument?: string
}

const editorAppearanceExtensions = new Map<string, Extension>()
const MAX_COUNTED_SEARCH_MATCHES = 10_000
const MAX_INDENTATION_FOLD_SCAN_LINES = 1_000
const MAX_PERSISTED_FOLDS = 500
const MAX_FOLD_ALL_LINES = 50_000
const indentationFoldCache = new WeakMap<Text, {
  tabSize: number
  ranges: Map<number, { from: number, to: number } | null>
}>()

export function CodeMirrorEditor({
  path,
  value,
  readOnly,
  ariaLabel,
  theme = DEFAULT_EDITOR_APPEARANCE.theme,
  fontSize = DEFAULT_EDITOR_APPEARANCE.fontSize,
  maxBytes,
  initialViewState,
  navigationRequest,
  onLimitExceeded,
  onNavigationHandled,
  onScrollElementChange,
  onViewStateChange,
  onChange
}: CodeMirrorEditorProps) {
  const locale = useLocale()
  const [appTheme, setAppTheme] = useState<EditorThemeMode>(documentEditorTheme)
  const resolvedTheme = resolveEditorTheme(theme, appTheme)
  const resolvedFontSize = clampEditorFontSize(fontSize)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onLimitExceededRef = useRef(onLimitExceeded)
  const onNavigationHandledRef = useRef(onNavigationHandled)
  const onScrollElementChangeRef = useRef(onScrollElementChange)
  const onViewStateChangeRef = useRef(onViewStateChange)
  const maxBytesRef = useRef(maxBytes)
  const documentBytesRef = useRef(0)
  const lineSeparatorRef = useRef('\n')
  const applyingExternalValue = useRef(false)
  const lastEmittedValue = useRef(value)
  const languageRequestRef = useRef(0)
  const readOnlyCompartment = useRef(new Compartment())
  const languageCompartment = useRef(new Compartment())
  const appearanceCompartment = useRef(new Compartment())
  const localeCompartment = useRef(new Compartment())
  const contentAttributesCompartment = useRef(new Compartment())
  const previousLocale = useRef(locale)
  onChangeRef.current = onChange
  onLimitExceededRef.current = onLimitExceeded
  onNavigationHandledRef.current = onNavigationHandled
  onScrollElementChangeRef.current = onScrollElementChange
  onViewStateChangeRef.current = onViewStateChange
  maxBytesRef.current = maxBytes

  useEffect(() => {
    const synchronize = () => setAppTheme(documentEditorTheme())
    const observer = new MutationObserver(synchronize)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    window.addEventListener('agentsdock:appearance', synchronize)
    synchronize()
    return () => {
      observer.disconnect()
      window.removeEventListener('agentsdock:appearance', synchronize)
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const doc = Text.of(value.split(/\r\n?|\n/))
    lineSeparatorRef.current = lineSeparator(value)
    documentBytesRef.current = utf8Bytes(doc.sliceString(0, doc.length, lineSeparatorRef.current))
    const state = EditorState.create({
      doc,
      selection: restoredSelection(initialViewState, doc.length),
      extensions: [
        basicSetup,
        searchOccurrenceCounter,
        localeCompartment.current.of(EditorState.phrases.of(codeMirrorPhrases())),
        appearanceCompartment.current.of(editorAppearanceExtension(resolvedTheme, resolvedFontSize)),
        Prec.highest(keymap.of([
          { key: 'Mod-z', run: undo, preventDefault: true },
          { key: 'Mod-y', run: redo, preventDefault: true },
          { key: 'Mod-Shift-z', run: redo, preventDefault: true },
          { key: 'Mod-f', run: openFindPanel, shift: openReplacePanel, preventDefault: true },
          { key: 'Mod-Alt-f', run: openReplacePanel, preventDefault: true },
          { key: 'Ctrl-g', run: gotoLine, preventDefault: true },
          { key: 'Mod-d', run: deleteLine, preventDefault: true },
          { key: 'Mod-Alt-[', run: foldCode, preventDefault: true },
          { key: 'Mod-Alt-]', run: unfoldCode, preventDefault: true },
          { key: 'Mod-k Mod-l', run: toggleFold, preventDefault: true },
          { key: 'Mod-k Mod-0', run: foldAllSafely, preventDefault: true },
          { key: 'Mod-k Mod-j', run: unfoldAll, preventDefault: true },
          { key: 'Ctrl-Alt-[', run: foldAllSafely, preventDefault: true },
          { key: 'Ctrl-Alt-]', run: unfoldAll, preventDefault: true },
          indentWithTab
        ])),
        EditorState.tabSize.of(2),
        contentAttributesCompartment.current.of(EditorView.contentAttributes.of({
          'aria-label': ariaLabel,
          'aria-multiline': 'true',
          spellcheck: 'false'
        })),
        EditorView.editorAttributes.compute(['selection'], state => (
          {
            class: state.selection.ranges.some(range => !range.empty)
              ? 'cm-nonempty-selection'
              : ''
          }
        )),
        Prec.highest(EditorView.mouseSelectionStyle.of(wordMouseSelectionStyle)),
        readOnlyCompartment.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly)
        ]),
        languageCompartment.current.of([]),
        EditorState.transactionFilter.of(transaction => {
          const limit = maxBytesRef.current
          if (!transaction.docChanged || applyingExternalValue.current) return transaction
          let nextBytes = documentBytesRef.current
          transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            nextBytes -= utf8Bytes(transaction.startState.doc.sliceString(fromA, toA, lineSeparatorRef.current))
            nextBytes += utf8Bytes(inserted.sliceString(0, inserted.length, lineSeparatorRef.current))
          })
          if (limit && nextBytes > limit) {
            queueMicrotask(() => onLimitExceededRef.current?.())
            return []
          }
          documentBytesRef.current = nextBytes
          return transaction
        }),
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            if (!applyingExternalValue.current) {
              const nextValue = update.state.doc.sliceString(0, update.state.doc.length, lineSeparatorRef.current)
              lastEmittedValue.current = nextValue
              onChangeRef.current(nextValue, update.state.doc.lines)
            }
          }
        })
      ]
    })
    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    const initialFolds = restoredFoldRanges(initialViewState, doc.toString())
    if (initialFolds.length > 0) {
      view.dispatch({ effects: initialFolds.map(range => foldEffect.of(range)) })
    }
    const scrollElementChange = onScrollElementChangeRef.current
    scrollElementChange?.(view.scrollDOM)
    let viewStateRestored = !initialViewState
    const restoreFrame = initialViewState
      ? window.requestAnimationFrame(() => {
          if (viewRef.current !== view) return
          view.scrollDOM.scrollTop = nonnegativeNumber(initialViewState.scrollTop)
          view.scrollDOM.scrollLeft = nonnegativeNumber(initialViewState.scrollLeft)
          viewStateRestored = true
        })
      : null
    const rememberViewState = () => {
      const selection = view.state.selection.main
      const folds = currentFoldRanges(view)
      onViewStateChangeRef.current?.({
        anchor: selection.anchor,
        head: selection.head,
        scrollTop: viewStateRestored ? view.scrollDOM.scrollTop : nonnegativeNumber(initialViewState?.scrollTop),
        scrollLeft: viewStateRestored ? view.scrollDOM.scrollLeft : nonnegativeNumber(initialViewState?.scrollLeft),
        ...(folds.length > 0
          ? { folds, foldDocument: documentFingerprint(view.state.doc.toString()) }
          : {})
      })
    }
    const findActiveFile = (event: Event) => {
      const activeElement = view.root.activeElement
      if (activeElement instanceof Element && activeElement.closest('.terminal-workspace')) return
      event.preventDefault()
      openFindPanel(view)
    }
    const editHistory = (event: Event) => {
      if (!view.hasFocus) return
      const direction = (event as CustomEvent<{ direction?: 'undo' | 'redo' }>).detail?.direction
      if (direction !== 'undo' && direction !== 'redo') return
      event.preventDefault()
      if (direction === 'undo') undo(view)
      else redo(view)
    }
    const synchronizeLanguage = () => {
      if (viewRef.current !== view) return
      const request = ++languageRequestRef.current
      void languageExtension(path)
        .then(extension => {
          if (
            viewRef.current === view
            && request === languageRequestRef.current
          ) {
            view.dispatch({ effects: languageCompartment.current.reconfigure(extension) })
            logWorkspaceEditor('syntax ready', { path })
          }
        })
        .catch(error => {
          logWorkspaceEditor('syntax unavailable', { path, error: errorMessage(error) })
          // Plain text remains fully usable when an optional language chunk fails.
        })
    }
    window.addEventListener('agentsdock:find-active-surface', findActiveFile)
    window.addEventListener('agentsdock:edit-history', editHistory)
    window.addEventListener('agentsdock:flush-draft', rememberViewState)
    logWorkspaceEditor('mounted', { path, bytes: documentBytesRef.current })
    synchronizeLanguage()
    return () => {
      if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame)
      rememberViewState()
      languageRequestRef.current += 1
      window.removeEventListener('agentsdock:find-active-surface', findActiveFile)
      window.removeEventListener('agentsdock:edit-history', editHistory)
      window.removeEventListener('agentsdock:flush-draft', rememberViewState)
      scrollElementChange?.(null)
      viewRef.current = null
      view.destroy()
    }
  }, [path])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const changed = previousLocale.current !== locale
    previousLocale.current = locale
    // CodeMirror's stock search panel reads phrases when it is created. Reopen
    // just that panel; keep the EditorView, document, undo history and query.
    const reopenSearch = changed && searchPanelOpen(view.state)
    const searchQuery = reopenSearch ? getSearchQuery(view.state) : null
    const focused = document.activeElement as HTMLElement | null
    const searchInput = focused instanceof HTMLInputElement && view.dom.contains(focused)
      ? { name: focused.name, start: focused.selectionStart, end: focused.selectionEnd }
      : null
    if (reopenSearch) closeSearchPanel(view)
    view.dispatch({ effects: [
      localeCompartment.current.reconfigure(EditorState.phrases.of(codeMirrorPhrases())),
      contentAttributesCompartment.current.reconfigure(EditorView.contentAttributes.of({
        'aria-label': ariaLabel, 'aria-multiline': 'true', spellcheck: 'false'
      }))
    ] })
    if (reopenSearch) {
      openSearchPanel(view)
      // Opening normally seeds the query from selected text. A locale refresh
      // must preserve the user's existing search and replacement instead.
      if (searchQuery) view.dispatch({ effects: setSearchQuery.of(searchQuery) })
      const field = searchInput && ['search', 'replace'].includes(searchInput.name)
        ? view.dom.querySelector<HTMLInputElement>(`.cm-search input[name="${searchInput.name}"]`)
        : null
      if (field && searchInput) {
        field.focus({ preventScroll: true })
        field.setSelectionRange(searchInput.start, searchInput.end)
      } else if (focused?.isConnected) focused.focus({ preventScroll: true })
    }
  }, [ariaLabel, locale])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly)
      ])
    })
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: appearanceCompartment.current.reconfigure(
        editorAppearanceExtension(resolvedTheme, resolvedFontSize)
      )
    })
  }, [resolvedFontSize, resolvedTheme])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !navigationRequest) return
    const lineNumber = Math.min(view.state.doc.lines, positiveInteger(navigationRequest.line))
    const line = view.state.doc.line(lineNumber)
    const columnOffset = Math.min(line.length, positiveInteger(navigationRequest.column ?? 1) - 1)
    const position = line.from + columnOffset
    view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: 'center' })
    })
    view.focus()
    onNavigationHandledRef.current?.(navigationRequest.requestId)
  }, [navigationRequest?.requestId])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (lastEmittedValue.current === value) return
    const current = view.state.doc.sliceString(0, view.state.doc.length, lineSeparatorRef.current)
    if (current === value) {
      lastEmittedValue.current = value
      return
    }
    applyingExternalValue.current = true
    try {
      const doc = view.state.toText(value)
      lineSeparatorRef.current = lineSeparator(value)
      documentBytesRef.current = utf8Bytes(doc.sliceString(0, doc.length, lineSeparatorRef.current))
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } })
      lastEmittedValue.current = value
    } finally {
      applyingExternalValue.current = false
    }
  }, [value])

  return <div ref={hostRef} className="workspace-editor-codemirror" />
}

function documentEditorTheme(): EditorThemeMode {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function lineSeparator(value: string): string {
  // Preserve the first line ending on output while letting CodeMirror parse all
  // line ending styles in inserted or pasted text with its default configuration.
  return value.match(/\r\n?|\n/)?.[0] ?? '\n'
}

function restoredSelection(viewState: CodeMirrorViewState | undefined, documentLength: number): EditorSelection {
  if (!viewState) return EditorSelection.single(0)
  const anchor = Math.min(documentLength, nonnegativeInteger(viewState.anchor))
  const head = Math.min(documentLength, nonnegativeInteger(viewState.head))
  return EditorSelection.single(anchor, head)
}

function restoredFoldRanges(
  viewState: CodeMirrorViewState | undefined,
  document: string
): Array<{ from: number, to: number }> {
  if (!Array.isArray(viewState?.folds)) return []
  if (viewState.foldDocument !== documentFingerprint(document)) return []
  return viewState.folds
    .slice(0, MAX_PERSISTED_FOLDS)
    .flatMap(range => {
      const from = Math.min(document.length, nonnegativeInteger(range?.from))
      const to = Math.min(document.length, nonnegativeInteger(range?.to))
      return from < to ? [{ from, to }] : []
    })
    .sort(compareFoldRanges)
}

function currentFoldRanges(view: EditorView): Array<{ from: number, to: number }> {
  const ranges: Array<{ from: number, to: number }> = []
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    ranges.push({ from, to })
    if (ranges.length === MAX_PERSISTED_FOLDS) return false
  })
  return ranges.sort(compareFoldRanges)
}

function compareFoldRanges(
  left: { from: number, to: number },
  right: { from: number, to: number }
): number {
  return left.from - right.from || left.to - right.to
}

function documentFingerprint(document: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < document.length; index += 1) {
    hash ^= document.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${document.length}:${(hash >>> 0).toString(16)}`
}

function nonnegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0
}

function nonnegativeNumber(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value!) : 0
}

function positiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

function wordMouseSelectionStyle(view: EditorView, event: MouseEvent): MouseSelectionStyle | null {
  if (
    event.detail !== 2
    || event.button !== 0
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) return null

  const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (position === null) return null
  const initialWord = view.state.wordAt(position)
  if (!initialWord) return null
  let startFrom = initialWord.from
  let startTo = initialWord.to
  let startSelection = view.state.selection

  return {
    get(currentEvent, extend, multiple) {
      const currentPosition = view.posAtCoords({
        x: currentEvent.clientX,
        y: currentEvent.clientY
      })
      const currentWord = currentPosition === null
        ? { from: startFrom, to: startTo }
        : view.state.wordAt(currentPosition) ?? { from: currentPosition, to: currentPosition }
      const range = currentWord.from < startFrom
        ? EditorSelection.range(startTo, currentWord.from)
        : EditorSelection.range(startFrom, currentWord.to)

      if (extend) {
        return startSelection.replaceRange(
          startSelection.main.extend(range.from, range.to, range.assoc)
        )
      }
      if (multiple) return startSelection.addRange(range)
      return EditorSelection.create([range])
    },
    update(update) {
      if (!update.docChanged) return
      startFrom = update.changes.mapPos(startFrom, -1)
      startTo = update.changes.mapPos(startTo, 1)
      startSelection = startSelection.map(update.changes)
    }
  }
}

function utf8Bytes(content: string): number {
  return new TextEncoder().encode(content).byteLength
}

function logWorkspaceEditor(message: string, data: Record<string, unknown>): void {
  try {
    const request = window.agentsDock?.native?.log?.('workspace-file', message, data)
    void request?.catch(() => undefined)
  } catch {
    // Diagnostics must never affect the editor.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function openFindPanel(view: EditorView): boolean {
  const handled = openSearchPanel(view)
  focusSearchPanelField(view, 'search')
  return handled
}

function openReplacePanel(view: EditorView): boolean {
  const handled = openSearchPanel(view)
  focusSearchPanelField(view, 'replace')
  return handled
}

function focusSearchPanelField(view: EditorView, name: 'search' | 'replace'): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (!view.dom.isConnected) return
      const field = view.dom.querySelector<HTMLInputElement>(`.cm-search input[name="${name}"]`)
      field?.focus()
      field?.select()
    })
  })
}

function foldAllSafely(view: EditorView): boolean {
  if (view.state.doc.lines <= MAX_FOLD_ALL_LINES) return foldAll(view)
  view.dispatch({
    effects: EditorView.announce.of(
      `Fold all is limited to ${MAX_FOLD_ALL_LINES.toLocaleString('en-US')} lines to keep the editor responsive.`
    )
  })
  return true
}

interface SearchMatchRange {
  from: number
  to: number
}

class SearchOccurrenceCounter {
  private readonly view: EditorView
  private readonly counter: HTMLSpanElement
  private frame: number | null = null
  private cachedDocument: Text | null = null
  private cachedQuery: SearchQuery | null = null
  private matches: SearchMatchRange[] = []
  private truncated = false

  constructor(view: EditorView) {
    this.view = view
    this.counter = document.createElement('span')
    this.counter.className = 'cm-search-count'
    this.counter.setAttribute('role', 'status')
    this.counter.setAttribute('aria-live', 'polite')
    this.counter.setAttribute('aria-atomic', 'true')
    this.counter.hidden = true
    this.schedule()
  }

  update(_update: ViewUpdate): void {
    this.schedule()
  }

  destroy(): void {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame)
    this.counter.remove()
  }

  private schedule(): void {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame)
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null
      this.synchronize()
    })
  }

  private synchronize(): void {
    if (!this.view.dom.isConnected || !searchPanelOpen(this.view.state)) {
      this.counter.hidden = true
      return
    }
    const searchField = this.view.dom.querySelector<HTMLInputElement>('.cm-search input[name="search"]')
    if (!searchField) {
      this.counter.hidden = true
      return
    }
    if (this.counter.parentElement !== searchField.parentElement) {
      searchField.insertAdjacentElement('afterend', this.counter)
    }

    const query = getSearchQuery(this.view.state)
    if (!query.search) {
      this.counter.hidden = true
      this.counter.textContent = ''
      return
    }
    this.counter.hidden = false
    if (!query.valid) {
      this.setLabel(t('editor.searchInvalidPattern'))
      return
    }
    if (this.cachedDocument !== this.view.state.doc || !this.cachedQuery?.eq(query)) {
      this.cachedDocument = this.view.state.doc
      this.cachedQuery = query
      this.matches = []
      this.truncated = false
      const cursor = query.getCursor(this.view.state)
      while (this.matches.length <= MAX_COUNTED_SEARCH_MATCHES) {
        const next = cursor.next()
        if (next.done) break
        if (this.matches.length === MAX_COUNTED_SEARCH_MATCHES) {
          this.truncated = true
          break
        }
        this.matches.push(next.value)
      }
    }

    if (this.matches.length === 0) {
      this.setLabel(t('editor.searchNoResults'))
      return
    }
    const selection = this.view.state.selection.main
    let activeIndex = this.matches.findIndex(match => (
      match.from === selection.from && match.to === selection.to
    ))
    if (activeIndex < 0) {
      activeIndex = this.matches.findIndex(match => match.from >= selection.head)
      if (activeIndex < 0 && !this.truncated) activeIndex = 0
    }
    const total = `${this.matches.length.toLocaleString(getLocale())}${this.truncated ? '+' : ''}`
    this.setLabel(activeIndex >= 0
      ? t('editor.searchPosition', { current: (activeIndex + 1).toLocaleString(getLocale()), total })
      : t('editor.searchResults', { total }))
  }

  private setLabel(label: string): void {
    this.counter.textContent = label
    this.counter.title = label
    this.counter.setAttribute('aria-label', label)
  }
}

const searchOccurrenceCounter = ViewPlugin.fromClass(SearchOccurrenceCounter)

function codeMirrorPhrases(): Record<string, string> {
  const keys: Record<string, string> = {
    'Find': 'find', 'Replace': 'replaceTitle', 'next': 'next', 'previous': 'previous',
    'all': 'all', 'match case': 'matchCase', 'regexp': 'regexp', 'by word': 'wholeWord',
    'replace': 'replace', 'replace all': 'replaceAll', 'close': 'close',
    'Go to line': 'goToLine', 'go': 'go', 'current match': 'currentMatch', 'on line': 'onLine',
    'replaced match on line $': 'replacedLine', 'replaced $ matches': 'replacedMatches',
    'Folded lines': 'foldedLines', 'Unfolded lines': 'unfoldedLines', 'to': 'to',
    'folded code': 'foldedCode', 'unfold': 'unfold', 'Fold line': 'foldLine', 'Unfold line': 'unfoldLine',
    'Control character': 'controlCharacter', 'Completions': 'completions', 'No completions': 'noCompletions'
  }
  return Object.fromEntries(Object.entries(keys).map(([phrase, key]) => [phrase, t(`editor.codemirror.${key}`)]))
}

function editorAppearanceExtension(themeId: EditorThemeId, fontSize: number): Extension {
  const cacheKey = `${themeId}:${fontSize}`
  const cached = editorAppearanceExtensions.get(cacheKey)
  if (cached) return cached

  const theme = editorThemeDefinition(themeId)
  const palette = theme.palette
  const extension: Extension = [
    EditorView.theme({
      '&': {
        height: '100%',
        color: palette.foreground,
        backgroundColor: palette.background,
        fontSize: `${fontSize}px`
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
        lineHeight: '1.62'
      },
      '.cm-content': {
        minHeight: '100%',
        padding: '8px 0 48px',
        caretColor: palette.cursor
      },
      '.cm-line': {
        padding: '0 14px 0 8px'
      },
      '.cm-gutters': {
        color: palette.gutterForeground,
        backgroundColor: palette.gutterBackground,
        borderRight: `1px solid ${palette.gutterBorder}`
      },
      '.cm-foldGutter': {
        width: '18px'
      },
      '.cm-foldGutter .cm-gutterElement': {
        boxSizing: 'border-box',
        minWidth: '18px',
        padding: '0 1px',
        textAlign: 'center'
      },
      '.cm-foldGutter span': {
        alignItems: 'center',
        borderRadius: '3px',
        color: palette.gutterForeground,
        display: 'inline-flex',
        height: '16px',
        justifyContent: 'center',
        opacity: '0.8',
        width: '16px'
      },
      '.cm-foldGutter span:hover': {
        backgroundColor: palette.selection,
        color: palette.foreground,
        opacity: '1'
      },
      '.cm-foldPlaceholder': {
        backgroundColor: palette.activeLine,
        border: `1px solid ${palette.gutterBorder}`,
        color: palette.gutterForeground
      },
      '.cm-activeLine': {
        backgroundColor: palette.activeLine
      },
      '.cm-activeLineGutter': {
        backgroundColor: palette.activeLineGutter
      },
      '&.cm-nonempty-selection .cm-activeLine, &.cm-nonempty-selection .cm-activeLineGutter': {
        // CodeMirror paints the active-line decoration above its selection
        // layer. Suppress that overlay while selecting so the head/end line
        // uses exactly the same selection color as every other selected line.
        backgroundColor: 'transparent'
      },
      '&.cm-focused': {
        outline: `1px solid ${palette.focus}`,
        outlineOffset: '-1px'
      },
      '.cm-selectionBackground, ::selection': {
        backgroundColor: `${palette.selection} !important`
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: palette.cursor
      },
      '.cm-panels': {
        color: palette.foreground,
        backgroundColor: palette.panelBackground
      },
      '.cm-tooltip': {
        color: palette.foreground,
        backgroundColor: palette.tooltipBackground,
        borderColor: palette.tooltipBorder
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        color: palette.foreground,
        backgroundColor: palette.selection
      },
      '.cm-matchingBracket': {
        color: palette.foreground,
        backgroundColor: palette.selection,
        outline: `1px solid ${palette.focus}`
      },
      '.cm-searchMatch': {
        backgroundColor: palette.selection,
        outline: `1px solid ${palette.focus}`
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: palette.activeLine
      },
      '.cm-panel.cm-search .cm-search-count': {
        color: palette.gutterForeground,
        display: 'inline-block',
        fontSize: '11px',
        fontVariantNumeric: 'tabular-nums',
        margin: '0 8px 0 2px',
        minWidth: '62px',
        textAlign: 'right',
        whiteSpace: 'nowrap'
      },
      '.cm-panel.cm-search .cm-search-count[hidden]': {
        display: 'none'
      }
    }, { dark: theme.mode === 'dark' }),
    syntaxHighlighting(HighlightStyle.define([
      { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.modifier], color: palette.keyword },
      { tag: [tags.atom, tags.bool, tags.null, tags.number], color: palette.number },
      { tag: [tags.string, tags.docString, tags.character, tags.attributeValue, tags.regexp], color: palette.string },
      { tag: [tags.variableName, tags.labelName], color: palette.variable },
      { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: palette.function },
      { tag: [tags.propertyName, tags.attributeName], color: palette.property },
      { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: palette.type },
      { tag: [tags.operator, tags.operatorKeyword, tags.definitionOperator, tags.typeOperator], color: palette.operator },
      { tag: [tags.punctuation, tags.separator, tags.bracket], color: palette.punctuation },
      { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: palette.comment },
      { tag: [tags.meta, tags.annotation, tags.processingInstruction, tags.macroName], color: palette.meta },
      { tag: [tags.heading, tags.strong], color: palette.keyword, fontWeight: 'bold' },
      { tag: tags.emphasis, fontStyle: 'italic' },
      { tag: [tags.link, tags.url], color: palette.function, textDecoration: 'underline' },
      { tag: tags.invalid, color: palette.invalid, textDecoration: 'underline wavy' }
    ]))
  ]
  editorAppearanceExtensions.set(cacheKey, extension)
  return extension
}

async function languageExtension(path: string): Promise<Extension> {
  const name = path.split('/').at(-1)?.toLocaleLowerCase() ?? ''
  const extension = name.includes('.') ? name.split('.').at(-1) ?? '' : ''

  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].includes(extension)) {
    const { javascript } = await import('@codemirror/lang-javascript')
    return javascript({
      typescript: ['ts', 'tsx', 'mts', 'cts'].includes(extension),
      jsx: ['jsx', 'tsx'].includes(extension)
    })
  }
  if (['json', 'jsonc'].includes(extension) || name === '.eslintrc' || name === '.prettierrc') {
    const { json } = await import('@codemirror/lang-json')
    return json()
  }
  if (['md', 'mdx', 'markdown'].includes(extension)) {
    const { markdown } = await import('@codemirror/lang-markdown')
    return markdown()
  }
  if (extension === 'py' || name === 'sconstruct') {
    const { python } = await import('@codemirror/lang-python')
    return python()
  }
  if (['html', 'htm', 'vue', 'svelte'].includes(extension)) {
    const { html } = await import('@codemirror/lang-html')
    return html()
  }
  if (['css', 'scss', 'less'].includes(extension)) {
    const { css } = await import('@codemirror/lang-css')
    return css()
  }
  if (['yaml', 'yml'].includes(extension)) {
    const { yaml } = await import('@codemirror/legacy-modes/mode/yaml')
    return legacyLanguage(StreamLanguage.define(yaml))
  }
  if (['sh', 'bash', 'zsh', 'fish'].includes(extension) || ['docker-entrypoint', 'makefile'].includes(name)) {
    const { shell } = await import('@codemirror/legacy-modes/mode/shell')
    return legacyLanguage(StreamLanguage.define(shell))
  }
  if (extension === 'toml') {
    const { toml } = await import('@codemirror/legacy-modes/mode/toml')
    return legacyLanguage(StreamLanguage.define(toml))
  }
  if (extension === 'go') {
    const { go } = await import('@codemirror/legacy-modes/mode/go')
    return legacyLanguage(StreamLanguage.define(go))
  }
  if (extension === 'rs') {
    const { rust } = await import('@codemirror/legacy-modes/mode/rust')
    return legacyLanguage(StreamLanguage.define(rust))
  }
  if (['sql', 'sqlite'].includes(extension)) {
    const { standardSQL } = await import('@codemirror/legacy-modes/mode/sql')
    return legacyLanguage(StreamLanguage.define(standardSQL))
  }
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) {
    const { dockerFile } = await import('@codemirror/legacy-modes/mode/dockerfile')
    return legacyLanguage(StreamLanguage.define(dockerFile))
  }
  if (['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'java'].includes(extension)) {
    const modes = await import('@codemirror/legacy-modes/mode/clike')
    if (extension === 'java') return legacyLanguage(StreamLanguage.define(modes.java))
    if (['c', 'h'].includes(extension)) return legacyLanguage(StreamLanguage.define(modes.c))
    return legacyLanguage(StreamLanguage.define(modes.cpp))
  }
  return []
}

function legacyLanguage(language: Extension): Extension {
  return [language, foldService.of(indentationFoldRange)]
}

function indentationFoldRange(
  state: EditorState,
  lineStart: number,
  lineEnd: number
): { from: number, to: number } | null {
  let cached = indentationFoldCache.get(state.doc)
  if (!cached || cached.tabSize !== state.tabSize) {
    cached = {
      tabSize: state.tabSize,
      ranges: new Map()
    }
    indentationFoldCache.set(state.doc, cached)
  }
  if (cached.ranges.has(lineStart)) return cached.ranges.get(lineStart) ?? null

  const startLine = state.doc.lineAt(lineStart)
  const startIndent = indentationWidth(startLine.text, state.tabSize)
  let nested = false
  let lastNestedEnd = lineEnd
  const lastScannedLine = Math.min(
    state.doc.lines,
    startLine.number + MAX_INDENTATION_FOLD_SCAN_LINES
  )
  for (let lineNumber = startLine.number + 1; lineNumber <= lastScannedLine; lineNumber += 1) {
    const line = state.doc.line(lineNumber)
    if (!line.text.trim()) {
      if (nested) lastNestedEnd = line.to
      continue
    }
    const indent = indentationWidth(line.text, state.tabSize)
    if (indent <= startIndent) {
      const range = nested && lineEnd < lastNestedEnd
        ? { from: lineEnd, to: lastNestedEnd }
        : null
      cached.ranges.set(lineStart, range)
      return range
    }
    nested = true
    lastNestedEnd = line.to
  }
  const reachedDocumentEnd = lastScannedLine === state.doc.lines
  const range = reachedDocumentEnd && nested && lineEnd < lastNestedEnd
    ? { from: lineEnd, to: lastNestedEnd }
    : null
  cached.ranges.set(lineStart, range)
  return range
}

function indentationWidth(line: string, tabSize: number): number {
  let column = 0
  for (const character of line) {
    if (character === ' ') column += 1
    else if (character === '\t') column += tabSize - (column % tabSize)
    else break
  }
  return column
}
