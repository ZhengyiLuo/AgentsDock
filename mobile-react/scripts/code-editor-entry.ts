import { deleteLine, indentWithTab, redo, undo } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
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
  unfoldCode,
} from '@codemirror/language'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { go } from '@codemirror/legacy-modes/mode/go'
import * as clike from '@codemirror/legacy-modes/mode/clike'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import { getSearchQuery, gotoLine, openSearchPanel, searchPanelOpen, type SearchQuery } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, Prec, type Extension, type Text } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import { codeEditorLanguage } from '../src/editor/codeEditorLanguage'
import {
  CODE_EDITOR_ENGINE_SOURCE,
  CODE_EDITOR_PROTOCOL_VERSION,
  codeEditorSequenceIsNewer,
  codeEditorUtf8ByteLength,
  parseCodeEditorHostMessage,
  serializeCodeEditorEngineMessage,
  type CodeEditorChange,
  type CodeEditorEngineEvent,
  type CodeEditorHostCommand,
  type CodeEditorSnapshot,
  type CodeEditorViewState,
} from '../src/editor/codeEditorProtocol'
import {
  clampCodeEditorFontSize,
  codeEditorTheme,
  type CodeEditorThemeId,
} from '../src/editor/codeEditorTheme'

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void }
  }
}

const MAX_PERSISTED_FOLDS = 500
const MAX_FOLD_ALL_LINES = 50_000
const MAX_INDENTATION_FOLD_SCAN_LINES = 1_000
const MAX_COUNTED_SEARCH_MATCHES = 10_000
const indentationFoldCache = new WeakMap<Text, {
  tabSize: number
  ranges: Map<number, { from: number; to: number } | null>
}>()

const readOnlyCompartment = new Compartment()
const languageCompartment = new Compartment()
const appearanceCompartment = new Compartment()
const editorHost = document.getElementById('editor')
if (!editorHost) throw new Error('Code editor host is unavailable.')

let engineSequence = 0
let lastHostSequence = 0
let maxBytes = 0
let documentBytes = 0
let applyingHostDocument = false
let currentTheme: CodeEditorThemeId = 'vscode-dark'
let currentFontSize = 13

const editor = new EditorView({
  state: createEditorState('', '', false, undefined),
  parent: editorHost,
})

editor.dom.addEventListener('focusin', () => emit({ type: 'focusChanged', focused: true }))
editor.dom.addEventListener('focusout', () => {
  queueMicrotask(() => emit({ type: 'focusChanged', focused: editor.hasFocus }))
})

window.addEventListener('message', receiveHostMessage)
document.addEventListener('message', receiveHostMessage as EventListener)
emit({ type: 'ready' })

function createEditorState(
  path: string,
  content: string,
  readOnly: boolean,
  viewState: CodeEditorViewState | undefined,
): EditorState {
  return EditorState.create({
    doc: content,
    selection: restoredSelection(viewState, content.length),
    extensions: [
      basicSetup,
      searchOccurrenceCounter,
      appearanceCompartment.of(editorAppearanceExtension(currentTheme, currentFontSize)),
      Prec.highest(keymap.of([
        { key: 'Mod-z', run: undo, preventDefault: true },
        { key: 'Mod-y', run: redo, preventDefault: true },
        { key: 'Mod-Shift-z', run: redo, preventDefault: true },
        { key: 'Mod-f', run: openFind, shift: openReplace, preventDefault: true },
        { key: 'Mod-Alt-f', run: openReplace, preventDefault: true },
        { key: 'Ctrl-g', run: gotoLine, preventDefault: true },
        { key: 'Mod-d', run: deleteLine, preventDefault: true },
        { key: 'Mod-Alt-[', run: foldCode, preventDefault: true },
        { key: 'Mod-Alt-]', run: unfoldCode, preventDefault: true },
        { key: 'Mod-k Mod-l', run: toggleFold, preventDefault: true },
        { key: 'Mod-k Mod-0', run: foldAllSafely, preventDefault: true },
        { key: 'Mod-k Mod-j', run: unfoldAll, preventDefault: true },
        { key: 'Ctrl-Alt-[', run: foldAllSafely, preventDefault: true },
        { key: 'Ctrl-Alt-]', run: unfoldAll, preventDefault: true },
        indentWithTab,
      ])),
      EditorState.tabSize.of(2),
      EditorView.contentAttributes.of({
        'aria-label': path ? `Edit ${path}` : 'Workspace code editor',
        'aria-multiline': 'true',
        autocapitalize: 'off',
        autocomplete: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
      }),
      readOnlyCompartment.of([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
      languageCompartment.of(languageExtension(path)),
      EditorState.transactionFilter.of(transaction => {
        if (!transaction.docChanged || applyingHostDocument) return transaction
        let attemptedBytes = documentBytes
        transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          attemptedBytes -= codeEditorUtf8ByteLength(transaction.startState.doc.sliceString(fromA, toA))
          attemptedBytes += codeEditorUtf8ByteLength(inserted.toString())
        })
        if (maxBytes > 0 && attemptedBytes > maxBytes) {
          queueMicrotask(() => emit({ type: 'limitExceeded', maxBytes, attemptedBytes }))
          return []
        }
        documentBytes = attemptedBytes
        return transaction
      }),
      EditorView.updateListener.of(update => {
        if (!update.docChanged || applyingHostDocument) return
        const changes: CodeEditorChange[] = []
        update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          changes.push({ from: fromA, to: toA, insert: inserted.toString() })
        })
        emit({
          type: 'changed',
          changes,
          utf8Bytes: documentBytes,
          lines: update.state.doc.lines,
          viewState: currentViewState(),
        })
      }),
    ],
  })
}

function receiveHostMessage(event: MessageEvent): void {
  const message = parseCodeEditorHostMessage(event.data)
  if (!message) {
    emit({ type: 'error', code: 'invalid_message', message: 'The native editor message is invalid.' })
    return
  }
  if (!codeEditorSequenceIsNewer(lastHostSequence, message.sequence)) return
  lastHostSequence = message.sequence
  try {
    executeHostCommand(message.command, message.requestId)
  } catch (cause) {
    emit({
      type: 'error',
      code: 'command_failed',
      message: cause instanceof Error ? cause.message : String(cause),
    }, message.requestId)
  }
}

function executeHostCommand(command: CodeEditorHostCommand, requestId?: string): void {
  switch (command.type) {
    case 'initialize':
      currentTheme = codeEditorTheme(command.theme).id
      currentFontSize = clampCodeEditorFontSize(command.fontSize)
      installDocument(command)
      emit({ type: 'initialized', snapshot: currentSnapshot() }, requestId)
      return
    case 'replaceDocument':
      installDocument(command)
      emit({ type: 'initialized', snapshot: currentSnapshot() }, requestId)
      return
    case 'setReadOnly':
      editor.dispatch({
        effects: readOnlyCompartment.reconfigure([
          EditorState.readOnly.of(command.readOnly),
          EditorView.editable.of(!command.readOnly),
        ]),
      })
      emit({ type: 'ack', command: command.type }, requestId)
      return
    case 'setAppearance':
      currentTheme = codeEditorTheme(command.theme).id
      currentFontSize = clampCodeEditorFontSize(command.fontSize)
      editor.dispatch({
        effects: appearanceCompartment.reconfigure(editorAppearanceExtension(currentTheme, currentFontSize)),
      })
      emit({ type: 'ack', command: command.type }, requestId)
      return
    case 'focus':
      editor.focus()
      emit({ type: 'ack', command: command.type }, requestId)
      return
    case 'blur':
    case 'flushAndBlur':
      blurEditor()
      emit({ type: 'blurred', snapshot: currentSnapshot() }, requestId)
      return
    case 'flush':
      emit({ type: 'snapshot', snapshot: currentSnapshot() }, requestId)
      return
    case 'execute':
      executeEditorAction(command)
      emit({ type: 'ack', command: command.type }, requestId)
  }
}

function installDocument(command: Extract<CodeEditorHostCommand, { type: 'initialize' | 'replaceDocument' }>): void {
  maxBytes = command.maxBytes
  documentBytes = codeEditorUtf8ByteLength(command.content)
  applyingHostDocument = true
  try {
    editor.setState(createEditorState(command.path, command.content, command.readOnly, command.viewState))
    restoreFolds(command.viewState, command.content)
  } finally {
    applyingHostDocument = false
  }
  if (command.viewState) {
    requestAnimationFrame(() => {
      editor.scrollDOM.scrollTop = nonnegativeNumber(command.viewState?.scrollTop)
      editor.scrollDOM.scrollLeft = nonnegativeNumber(command.viewState?.scrollLeft)
    })
  }
}

function executeEditorAction(command: Extract<CodeEditorHostCommand, { type: 'execute' }>): void {
  switch (command.action) {
    case 'undo': undo(editor); return
    case 'redo': redo(editor); return
    case 'find': openFind(editor); return
    case 'replace': openReplace(editor); return
    case 'gotoLine':
      if (command.line) navigateToLine(command.line, command.column)
      else gotoLine(editor)
      return
    case 'deleteLine': deleteLine(editor); return
    case 'indent': indentWithTab.run?.(editor); return
    case 'fold': foldCode(editor); return
    case 'unfold': unfoldCode(editor); return
    case 'toggleFold': toggleFold(editor); return
    case 'foldAll': foldAllSafely(editor); return
    case 'unfoldAll': unfoldAll(editor); return
  }
}

function navigateToLine(requestedLine: number, requestedColumn = 1): void {
  const lineNumber = Math.min(editor.state.doc.lines, Math.max(1, Math.floor(requestedLine)))
  const line = editor.state.doc.line(lineNumber)
  const columnOffset = Math.min(line.length, Math.max(1, Math.floor(requestedColumn)) - 1)
  const position = line.from + columnOffset
  editor.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: 'center' }),
  })
  editor.focus()
}

function blurEditor(): void {
  editor.contentDOM.blur()
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

function currentSnapshot(): CodeEditorSnapshot {
  return {
    content: editor.state.doc.toString(),
    utf8Bytes: documentBytes,
    lines: editor.state.doc.lines,
    viewState: currentViewState(),
  }
}

function currentViewState(): CodeEditorViewState {
  const selection = editor.state.selection.main
  const folds = currentFoldRanges()
  return {
    anchor: selection.anchor,
    head: selection.head,
    scrollTop: editor.scrollDOM.scrollTop,
    scrollLeft: editor.scrollDOM.scrollLeft,
    ...(folds.length > 0
      ? { folds, foldDocument: documentFingerprint(editor.state.doc.toString()) }
      : {}),
  }
}

function emit(event: CodeEditorEngineEvent, requestId?: string): void {
  engineSequence += 1
  window.ReactNativeWebView?.postMessage(serializeCodeEditorEngineMessage({
    source: CODE_EDITOR_ENGINE_SOURCE,
    version: CODE_EDITOR_PROTOCOL_VERSION,
    sequence: engineSequence,
    ...(requestId ? { requestId } : {}),
    event,
  }))
}

function restoredSelection(viewState: CodeEditorViewState | undefined, documentLength: number): EditorSelection {
  if (!viewState) return EditorSelection.single(0)
  return EditorSelection.single(
    Math.min(documentLength, nonnegativeInteger(viewState.anchor)),
    Math.min(documentLength, nonnegativeInteger(viewState.head)),
  )
}

function restoreFolds(viewState: CodeEditorViewState | undefined, content: string): void {
  if (!Array.isArray(viewState?.folds) || viewState.foldDocument !== documentFingerprint(content)) return
  const ranges = viewState.folds
    .slice(0, MAX_PERSISTED_FOLDS)
    .flatMap(range => {
      const from = Math.min(content.length, nonnegativeInteger(range.from))
      const to = Math.min(content.length, nonnegativeInteger(range.to))
      return from < to ? [{ from, to }] : []
    })
  if (ranges.length) editor.dispatch({ effects: ranges.map(range => foldEffect.of(range)) })
}

function currentFoldRanges(): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  foldedRanges(editor.state).between(0, editor.state.doc.length, (from, to) => {
    ranges.push({ from, to })
    if (ranges.length === MAX_PERSISTED_FOLDS) return false
  })
  return ranges.sort((left, right) => left.from - right.from || left.to - right.to)
}

function documentFingerprint(content: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`
}

function openFind(view: EditorView): boolean {
  const handled = openSearchPanel(view)
  focusSearchField(view, 'search')
  return handled
}

function openReplace(view: EditorView): boolean {
  const handled = openSearchPanel(view)
  focusSearchField(view, 'replace')
  return handled
}

function focusSearchField(view: EditorView, name: 'search' | 'replace'): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const field = view.dom.querySelector<HTMLInputElement>(`.cm-search input[name="${name}"]`)
      field?.focus()
      field?.select()
    })
  })
}

interface SearchMatchRange { from: number; to: number }

class SearchOccurrenceCounter {
  private readonly counter: HTMLSpanElement
  private frame: number | null = null
  private cachedDocument: Text | null = null
  private cachedQuery: SearchQuery | null = null
  private matches: SearchMatchRange[] = []
  private truncated = false

  constructor(private readonly view: EditorView) {
    this.counter = document.createElement('span')
    this.counter.className = 'cm-search-count'
    this.counter.setAttribute('role', 'status')
    this.counter.setAttribute('aria-live', 'polite')
    this.counter.setAttribute('aria-atomic', 'true')
    this.counter.hidden = true
    this.schedule()
  }

  update(_update: ViewUpdate): void { this.schedule() }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.counter.remove()
  }

  private schedule(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => {
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
    if (this.counter.parentElement !== searchField.parentElement) searchField.insertAdjacentElement('afterend', this.counter)
    const query = getSearchQuery(this.view.state)
    if (!query.search) {
      this.counter.hidden = true
      this.counter.textContent = ''
      return
    }
    this.counter.hidden = false
    if (!query.valid) {
      this.setLabel('Invalid pattern')
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
    if (!this.matches.length) {
      this.setLabel('No results')
      return
    }
    const selection = this.view.state.selection.main
    let activeIndex = this.matches.findIndex(match => match.from === selection.from && match.to === selection.to)
    if (activeIndex < 0) {
      activeIndex = this.matches.findIndex(match => match.from >= selection.head)
      if (activeIndex < 0 && !this.truncated) activeIndex = 0
    }
    const total = `${this.matches.length.toLocaleString('en-US')}${this.truncated ? '+' : ''}`
    this.setLabel(activeIndex >= 0 ? `${(activeIndex + 1).toLocaleString('en-US')} of ${total}` : `${total} results`)
  }

  private setLabel(label: string): void {
    this.counter.textContent = label
    this.counter.title = label
    this.counter.setAttribute('aria-label', label)
  }
}

const searchOccurrenceCounter = ViewPlugin.fromClass(SearchOccurrenceCounter)

function foldAllSafely(view: EditorView): boolean {
  if (view.state.doc.lines <= MAX_FOLD_ALL_LINES) return foldAll(view)
  view.dispatch({ effects: EditorView.announce.of(`Fold all is limited to ${MAX_FOLD_ALL_LINES} lines.`) })
  return true
}

function languageExtension(path: string): Extension {
  switch (codeEditorLanguage(path).id) {
    case 'javascript': return javascript()
    case 'typescript': return javascript({ typescript: true })
    case 'javascript-react': return javascript({ jsx: true })
    case 'typescript-react': return javascript({ typescript: true, jsx: true })
    case 'json': return json()
    case 'markdown': return markdown()
    case 'python': return python()
    case 'html': return html()
    case 'css': return css()
    case 'yaml': return legacyLanguage(StreamLanguage.define(yaml))
    case 'shell': return legacyLanguage(StreamLanguage.define(shell))
    case 'toml': return legacyLanguage(StreamLanguage.define(toml))
    case 'go': return legacyLanguage(StreamLanguage.define(go))
    case 'rust': return legacyLanguage(StreamLanguage.define(rust))
    case 'sql': return legacyLanguage(StreamLanguage.define(standardSQL))
    case 'dockerfile': return legacyLanguage(StreamLanguage.define(dockerFile))
    case 'c': return legacyLanguage(StreamLanguage.define(clike.c))
    case 'cpp': return legacyLanguage(StreamLanguage.define(clike.cpp))
    case 'java': return legacyLanguage(StreamLanguage.define(clike.java))
    case 'plain-text': return []
  }
}

function legacyLanguage(language: Extension): Extension {
  return [language, foldService.of(indentationFoldRange)]
}

function indentationFoldRange(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): { from: number; to: number } | null {
  let cached = indentationFoldCache.get(state.doc)
  if (!cached || cached.tabSize !== state.tabSize) {
    cached = { tabSize: state.tabSize, ranges: new Map() }
    indentationFoldCache.set(state.doc, cached)
  }
  if (cached.ranges.has(lineStart)) return cached.ranges.get(lineStart) ?? null

  const startLine = state.doc.lineAt(lineStart)
  const startIndent = indentationWidth(startLine.text, state.tabSize)
  let nested = false
  let lastNestedEnd = lineEnd
  const lastScannedLine = Math.min(state.doc.lines, startLine.number + MAX_INDENTATION_FOLD_SCAN_LINES)
  for (let lineNumber = startLine.number + 1; lineNumber <= lastScannedLine; lineNumber += 1) {
    const line = state.doc.line(lineNumber)
    if (!line.text.trim()) {
      if (nested) lastNestedEnd = line.to
      continue
    }
    const indent = indentationWidth(line.text, state.tabSize)
    if (indent <= startIndent) {
      const range = nested && lineEnd < lastNestedEnd ? { from: lineEnd, to: lastNestedEnd } : null
      cached.ranges.set(lineStart, range)
      return range
    }
    nested = true
    lastNestedEnd = line.to
  }
  const range = lastScannedLine === state.doc.lines && nested && lineEnd < lastNestedEnd
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

function editorAppearanceExtension(themeId: CodeEditorThemeId, fontSize: number): Extension {
  const theme = codeEditorTheme(themeId)
  const palette = theme.palette
  return [
    EditorView.theme({
      '&': {
        height: '100%',
        color: palette.foreground,
        backgroundColor: palette.background,
        fontSize: `${clampCodeEditorFontSize(fontSize)}px`,
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: 'Menlo, "SFMono-Regular", Consolas, "Liberation Mono", monospace',
        lineHeight: '1.62',
        WebkitOverflowScrolling: 'touch',
      },
      '.cm-content': { minHeight: '100%', padding: '8px 0 48px', caretColor: palette.cursor },
      '.cm-line': { padding: '0 14px 0 8px' },
      '.cm-gutters': { color: palette.gutterForeground, backgroundColor: palette.gutterBackground, borderRight: `1px solid ${palette.gutterBorder}` },
      '.cm-foldGutter': { width: '18px' },
      '.cm-foldPlaceholder': { backgroundColor: palette.activeLine, border: `1px solid ${palette.gutterBorder}`, color: palette.gutterForeground },
      '.cm-activeLine': { backgroundColor: palette.activeLine },
      '.cm-activeLineGutter': { backgroundColor: palette.activeLineGutter },
      '&.cm-focused': { outline: `1px solid ${palette.focus}`, outlineOffset: '-1px' },
      '.cm-selectionBackground, ::selection': { backgroundColor: `${palette.selection} !important` },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: palette.cursor },
      '.cm-panels': { color: palette.foreground, backgroundColor: palette.panelBackground },
      '.cm-panel.cm-search': { padding: '8px', gap: '5px' },
      '.cm-panel.cm-search input': { minHeight: '44px', fontSize: '16px' },
      '.cm-panel.cm-search button': { minWidth: '44px', minHeight: '44px' },
      '.cm-panel.cm-search .cm-search-count': { color: palette.gutterForeground, display: 'inline-block', fontSize: '11px', fontVariantNumeric: 'tabular-nums', margin: '0 8px 0 2px', minWidth: '62px', textAlign: 'right', whiteSpace: 'nowrap' },
      '.cm-panel.cm-search .cm-search-count[hidden]': { display: 'none' },
      '.cm-tooltip': { color: palette.foreground, backgroundColor: palette.tooltipBackground, borderColor: palette.tooltipBorder },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { color: palette.foreground, backgroundColor: palette.selection },
      '.cm-matchingBracket': { color: palette.foreground, backgroundColor: palette.selection, outline: `1px solid ${palette.focus}` },
      '.cm-searchMatch': { backgroundColor: palette.selection, outline: `1px solid ${palette.focus}` },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: palette.activeLine },
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
      { tag: tags.invalid, color: palette.invalid, textDecoration: 'underline wavy' },
    ])),
  ]
}

function nonnegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0
}

function nonnegativeNumber(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value!) : 0
}
