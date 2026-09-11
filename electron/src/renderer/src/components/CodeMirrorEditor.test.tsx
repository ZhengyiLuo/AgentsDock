import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { redo, undo } from '@codemirror/commands'
import { getSearchQuery, openSearchPanel, SearchQuery, setSearchQuery } from '@codemirror/search'
import { setLocale } from '@shared/i18n'
import { t, useLocale } from '../lib/i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeMirrorEditor } from './CodeMirrorEditor'

describe('CodeMirrorEditor', () => {
  let originalTheme: string | undefined

  beforeEach(() => {
    setLocale('en')
    originalTheme = document.documentElement.dataset.theme
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) })
    })
  })

  afterEach(() => {
    cleanup()
    setLocale('en')
    vi.restoreAllMocks()
    if (originalTheme) document.documentElement.dataset.theme = originalTheme
    else delete document.documentElement.dataset.theme
  })

  it('switches search phrases and aria labels without losing the editor, draft, selection, query or history', async () => {
    function LocalizedEditor() {
      useLocale()
      return <CodeMirrorEditor path="notes.txt" value="apple apple" readOnly={false}
        ariaLabel={t('editor.contentsOf', { name: 'notes.txt' })} onChange={vi.fn()} />
    }
    render(<LocalizedEditor />)
    const original = screen.getByRole('textbox', { name: 'Contents of notes.txt' })
    const view = EditorView.findFromDOM(original)!
    act(() => {
      view.dispatch({ changes: { from: 11, insert: ' draft' }, selection: { anchor: 2, head: 5 } })
      openSearchPanel(view)
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'apple', replace: 'pear' })) })
    })
    await waitFor(() => expect(view.dom.querySelector('.cm-search-count')).toHaveTextContent('2 of 2'))
    act(() => setLocale('zh-CN'))
    const localized = screen.getByRole('textbox', { name: 'notes.txt 的内容' })
    expect(localized).toBe(original)
    expect(EditorView.findFromDOM(localized)).toBe(view)
    expect(view.state.doc.toString()).toBe('apple apple draft')
    expect(view.state.selection.main.anchor).toBe(2)
    expect(view.state.selection.main.head).toBe(5)
    expect(getSearchQuery(view.state).search).toBe('apple')
    expect(getSearchQuery(view.state).replace).toBe('pear')
    expect(screen.getByRole('textbox', { name: '查找' })).toHaveValue('apple')
    expect(screen.getByRole('button', { name: '下一个' })).toBeVisible()
    await waitFor(() => expect(view.dom.querySelector('.cm-search-count')).toHaveTextContent('第 2 项，共 2 项'))
    act(() => { undo(view) })
    expect(view.state.doc.toString()).toBe('apple apple')
    act(() => { redo(view) })
    expect(view.state.doc.toString()).toBe('apple apple draft')
    act(() => { view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '[', regexp: true })) }) })
    await waitFor(() => expect(view.dom.querySelector('.cm-search-count')).toHaveTextContent('无效的搜索模式'))
    act(() => { view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'missing' })) }) })
    await waitFor(() => expect(view.dom.querySelector('.cm-search-count')).toHaveTextContent('无结果'))
    act(() => setLocale('en'))
    expect(screen.getByRole('textbox', { name: 'Contents of notes.txt' })).toBe(original)
    expect(screen.getByRole('textbox', { name: 'Find' })).toHaveValue('missing')
    expect(view.state.doc.toString()).toBe('apple apple draft')
  })

  it('does not recalculate UTF-8 size on unrelated React renders', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    const onChange = vi.fn()
    const rendered = render(<CodeMirrorEditor
      path="sample.txt"
      value="plain text"
      readOnly={false}
      ariaLabel="Plain text sample"
      onChange={onChange}
    />)
    const callsAfterMount = encode.mock.calls.length

    rendered.rerender(<CodeMirrorEditor
      path="sample.txt"
      value="plain text"
      readOnly
      ariaLabel="Plain text sample"
      onChange={onChange}
    />)

    expect(encode).toHaveBeenCalledTimes(callsAfterMount)
  })

  it('exposes its native scroll element and clears it on teardown', () => {
    const onScrollElementChange = vi.fn()
    const rendered = render(<CodeMirrorEditor
      path="sample.md"
      value={'# Heading\n\nBody'}
      readOnly={false}
      ariaLabel="Markdown sample"
      onScrollElementChange={onScrollElementChange}
      onChange={vi.fn()}
    />)

    const editor = screen.getByRole('textbox', { name: 'Markdown sample' })
    const editorView = EditorView.findFromDOM(editor)
    expect(editorView).not.toBeNull()
    expect(onScrollElementChange).toHaveBeenCalledTimes(1)
    expect(onScrollElementChange).toHaveBeenLastCalledWith(editorView?.scrollDOM)

    rendered.unmount()

    expect(onScrollElementChange).toHaveBeenCalledTimes(2)
    expect(onScrollElementChange).toHaveBeenLastCalledWith(null)
  })

  it('loads syntax highlighting lazily and updates editability without replacing the document', async () => {
    const onChange = vi.fn()
    const view = render(<CodeMirrorEditor
      path="src/sample.ts"
      value="export const answer: number = 42\n"
      readOnly={false}
      ariaLabel="TypeScript sample"
      onChange={onChange}
    />)

    const editor = screen.getByRole('textbox', { name: 'TypeScript sample' })
    expect(editor).toHaveAttribute('contenteditable', 'true')
    await waitFor(() => expect(editor).toHaveAttribute('data-language', 'typescript'))
    expect(view.container.querySelectorAll('.cm-line span').length).toBeGreaterThan(2)

    view.rerender(<CodeMirrorEditor
      path="src/sample.ts"
      value="export const answer: number = 42\n"
      readOnly
      ariaLabel="TypeScript sample"
      onChange={onChange}
    />)
    expect(screen.getByRole('textbox', { name: 'TypeScript sample' })).toHaveAttribute('contenteditable', 'false')
    expect(screen.getByRole('textbox', { name: 'TypeScript sample' })).toHaveTextContent('export const answer: number = 42')
  })

  it('keeps syntax highlighting enabled for a 450 KiB Python source file', async () => {
    const onChange = vi.fn()
    const line = 'def remaining_capacity(total, used):\n    return max(total - used, 0.0)\n\n'
    const targetBytes = 450 * 1024
    const content = line.repeat(Math.ceil(targetBytes / line.length)).slice(0, targetBytes)
    render(<CodeMirrorEditor
      path="demo/processing/scripts/batch/compute_capacity.py"
      value={content}
      readOnly={false}
      ariaLabel="Large Python sample"
      onChange={onChange}
    />)

    const editor = screen.getByRole('textbox', { name: 'Large Python sample' })
    expect(new TextEncoder().encode(content).byteLength).toBe(targetBytes)
    await waitFor(() => expect(editor).toHaveAttribute('data-language', 'python'))
    expect(editor.closest('.cm-editor')?.querySelectorAll('.cm-line span').length).toBeGreaterThan(2)
  })

  it('rejects an edit before it can exceed the configured UTF-8 byte limit', async () => {
    const onChange = vi.fn()
    const onLimitExceeded = vi.fn()
    render(<CodeMirrorEditor
      path="sample.txt"
      value="abc"
      readOnly={false}
      ariaLabel="Limited sample"
      maxBytes={4}
      onLimitExceeded={onLimitExceeded}
      onChange={onChange}
    />)

    const editor = screen.getByRole('textbox', { name: 'Limited sample' })
    const editorView = EditorView.findFromDOM(editor)
    expect(editorView).not.toBeNull()
    editorView?.dispatch({ changes: { from: 3, insert: 'd' } })
    expect(editor).toHaveTextContent('abcd')
    expect(onChange).toHaveBeenLastCalledWith('abcd', 1)

    editorView?.dispatch({ changes: { from: 4, insert: 'é' } })
    expect(editor).toHaveTextContent('abcd')
    await waitFor(() => expect(onLimitExceeded).toHaveBeenCalledTimes(1))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('keeps syntax highlighting and editing enabled for a 544,335-byte YAML file', async () => {
    const onChange = vi.fn()
    const line = 'key: value\n'
    const targetBytes = 544_335
    const content = line.repeat(Math.floor(targetBytes / line.length))
      + 'x'.repeat(targetBytes % line.length)
    render(<CodeMirrorEditor
      path="demo/core/processing/configs/experiments/sample/batch/run01.yaml"
      value={content}
      readOnly={false}
      ariaLabel="Large YAML sample"
      onChange={onChange}
    />)

    const editor = screen.getByRole('textbox', { name: 'Large YAML sample' })
    const editorView = EditorView.findFromDOM(editor)
    expect(new TextEncoder().encode(content).byteLength).toBe(targetBytes)
    expect(editor).toHaveAttribute('contenteditable', 'true')
    await waitFor(() => expect(editor).toHaveAttribute('data-language', 'yaml'))

    editorView?.dispatch({ changes: { from: content.length, insert: 'y' } })
    expect(onChange).toHaveBeenLastCalledWith(`${content}y`, editorView?.state.doc.lines)
  })

  it('deletes the current line with Mod+D', () => {
    const onChange = vi.fn()
    render(<CodeMirrorEditor
      path="sample.ts"
      value={'one\ntwo\nthree'}
      readOnly={false}
      ariaLabel="Delete line sample"
      onChange={onChange}
    />)

    const editor = screen.getByRole('textbox', { name: 'Delete line sample' })
    const editorView = EditorView.findFromDOM(editor)
    expect(editorView).not.toBeNull()
    editorView?.dispatch({ selection: { anchor: 5 } })
    const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      ? { metaKey: true }
      : { ctrlKey: true }
    fireEvent.keyDown(editor, { key: 'd', code: 'KeyD', ...modifier })

    expect(editorView?.state.doc.toString()).toBe('one\nthree')
    expect(onChange).toHaveBeenLastCalledWith('one\nthree', 2)
  })

  it('supports Mod+Z plus both Mod+Y and Mod+Shift+Z redo chords', () => {
    render(<CodeMirrorEditor
      path="sample.ts"
      value="const answer = 42"
      readOnly={false}
      ariaLabel="History shortcut sample"
      onChange={vi.fn()}
    />)

    const editor = screen.getByRole('textbox', { name: 'History shortcut sample' })
    const editorView = EditorView.findFromDOM(editor)!
    const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      ? { metaKey: true }
      : { ctrlKey: true }
    editorView.dispatch({ changes: { from: editorView.state.doc.length, insert: '!' } })

    fireEvent.keyDown(editor, { key: 'z', code: 'KeyZ', keyCode: 90, which: 90, ...modifier })
    expect(editorView.state.doc.toString()).toBe('const answer = 42')

    fireEvent.keyDown(editor, { key: 'y', code: 'KeyY', keyCode: 89, which: 89, ...modifier })
    expect(editorView.state.doc.toString()).toBe('const answer = 42!')

    fireEvent.keyDown(editor, { key: 'z', code: 'KeyZ', keyCode: 90, which: 90, ...modifier })
    expect(editorView.state.doc.toString()).toBe('const answer = 42')

    fireEvent.keyDown(editor, {
      key: 'Z',
      code: 'KeyZ',
      keyCode: 90,
      which: 90,
      shiftKey: true,
      ...modifier
    })
    expect(editorView.state.doc.toString()).toBe('const answer = 42!')
  })

  it('routes native Edit-menu history commands into the focused editor', () => {
    render(<CodeMirrorEditor
      path="sample.ts"
      value="const answer = 42"
      readOnly={false}
      ariaLabel="Native history sample"
      onChange={vi.fn()}
    />)

    const editor = screen.getByRole('textbox', { name: 'Native history sample' })
    const editorView = EditorView.findFromDOM(editor)!
    editor.focus()
    editorView.dispatch({ changes: { from: editorView.state.doc.length, insert: '!' } })

    expect(window.dispatchEvent(new CustomEvent('agentsdock:edit-history', {
      cancelable: true,
      detail: { direction: 'undo' }
    }))).toBe(false)
    expect(editorView.state.doc.toString()).toBe('const answer = 42')

    expect(window.dispatchEvent(new CustomEvent('agentsdock:edit-history', {
      cancelable: true,
      detail: { direction: 'redo' }
    }))).toBe(false)
    expect(editorView.state.doc.toString()).toBe('const answer = 42!')
  })

  it('selects the word on the second unmodified press before CodeMirror can override it', () => {
    render(<CodeMirrorEditor
      path="sample.ts"
      value="const selectedWord = true"
      readOnly={false}
      ariaLabel="Word selection sample"
      onChange={vi.fn()}
    />)

    const editor = screen.getByRole('textbox', { name: 'Word selection sample' })
    const editorView = EditorView.findFromDOM(editor)!
    vi.spyOn(editorView, 'posAtCoords').mockReturnValue(10)
    expect(fireEvent.mouseDown(editor, {
      button: 0,
      detail: 2,
      clientX: 48,
      clientY: 12
    })).toBe(false)

    expect(editorView.state.selection.main).toMatchObject({
      from: 6,
      to: 18
    })
    fireEvent.mouseUp(editor, { button: 0, detail: 2, clientX: 48, clientY: 12 })
    fireEvent.click(editor, { button: 0, detail: 2, clientX: 48, clientY: 12 })
    fireEvent.doubleClick(editor, { button: 0, detail: 2, clientX: 48, clientY: 12 })

    expect(editorView.state.selection.main).toMatchObject({
      from: 6,
      to: 18
    })
    expect(editorView.state.sliceDoc(
      editorView.state.selection.main.from,
      editorView.state.selection.main.to
    )).toBe('selectedWord')
    expect(editor).toHaveFocus()
  })

  it('extends a double-click selection word by word while dragging', () => {
    render(<CodeMirrorEditor
      path="sample.ts"
      value="const selectedWord nextWord = true"
      readOnly={false}
      ariaLabel="Word drag sample"
      onChange={vi.fn()}
    />)

    const editor = screen.getByRole('textbox', { name: 'Word drag sample' })
    const editorView = EditorView.findFromDOM(editor)!
    vi.spyOn(editorView, 'posAtCoords').mockImplementation(({ x }) => x < 100 ? 10 : 22)
    fireEvent.mouseDown(editor, {
      button: 0,
      detail: 2,
      clientX: 48,
      clientY: 12
    })
    fireEvent.mouseMove(document, {
      buttons: 1,
      clientX: 148,
      clientY: 12
    })

    expect(editorView.state.selection.main).toMatchObject({
      from: 6,
      to: 27
    })
    expect(editorView.state.sliceDoc(
      editorView.state.selection.main.from,
      editorView.state.selection.main.to
    )).toBe('selectedWord nextWord')
    fireEvent.mouseUp(document, { button: 0, clientX: 148, clientY: 12 })
  })

  it('suppresses the active-line overlay while a non-empty selection is visible', () => {
    render(<CodeMirrorEditor
      path="sample.yaml"
      value={'one\ntwo\nthree'}
      readOnly={false}
      ariaLabel="Selection color sample"
      onChange={vi.fn()}
    />)

    const editor = screen.getByRole('textbox', { name: 'Selection color sample' })
    const editorView = EditorView.findFromDOM(editor)!
    expect(editorView.dom).not.toHaveClass('cm-nonempty-selection')

    editorView.dispatch({ selection: { anchor: 1, head: 9 } })
    expect(editorView.dom).toHaveClass('cm-nonempty-selection')
    const activeLine = editorView.dom.querySelector<HTMLElement>('.cm-activeLine')
    const activeLineGutter = editorView.dom.querySelector<HTMLElement>('.cm-activeLineGutter')
    expect(activeLine).not.toBeNull()
    expect(activeLineGutter).not.toBeNull()
    expect(getComputedStyle(activeLine!).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(getComputedStyle(activeLineGutter!).backgroundColor).toBe('rgba(0, 0, 0, 0)')

    editorView.dispatch({ selection: { anchor: 9 } })
    expect(editorView.dom).not.toHaveClass('cm-nonempty-selection')
  })

  it('opens file Find from the contextual native command', async () => {
    render(<CodeMirrorEditor
      path="sample.ts"
      value={'one\ntwo\none'}
      readOnly={false}
      ariaLabel="Find sample"
      onChange={vi.fn()}
    />)

    const event = new CustomEvent('agentsdock:find-active-surface', { cancelable: true })
    expect(window.dispatchEvent(event)).toBe(false)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Find' })).toHaveFocus())
    expect(screen.getByRole('textbox', { name: 'Replace' })).toBeInTheDocument()
  })

  it('shows the active Cmd+F match and total occurrence count', async () => {
    render(<CodeMirrorEditor
      path="sample.ts"
      value={'one\ntwo\none'}
      readOnly={false}
      ariaLabel="Counted Find sample"
      onChange={vi.fn()}
    />)

    const event = new CustomEvent('agentsdock:find-active-surface', { cancelable: true })
    window.dispatchEvent(event)
    const find = await screen.findByRole('textbox', { name: 'Find' })
    fireEvent.change(find, { target: { value: 'one' } })

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 2'))
    fireEvent.keyDown(find, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 })
    fireEvent.keyDown(find, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2 of 2'))

    fireEvent.change(find, { target: { value: 'missing' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No results'))
  })

  it('caps Cmd+F counting work for files with very large match sets', async () => {
    render(<CodeMirrorEditor
      path="large.txt"
      value={'x '.repeat(10_050)}
      readOnly={false}
      ariaLabel="Large counted Find sample"
      onChange={vi.fn()}
    />)

    window.dispatchEvent(new CustomEvent('agentsdock:find-active-surface', { cancelable: true }))
    const find = await screen.findByRole('textbox', { name: 'Find' })
    fireEvent.change(find, { target: { value: 'x' } })

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 of 10,000+'))
  })

  it('opens Find and focuses Replace with Mod+Shift+F', async () => {
    render(<CodeMirrorEditor
      path="sample.ts"
      value={'one\ntwo\none'}
      readOnly={false}
      ariaLabel="Replace sample"
      onChange={vi.fn()}
    />)

    const editor = screen.getByRole('textbox', { name: 'Replace sample' })
    const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      ? { metaKey: true }
      : { ctrlKey: true }
    fireEvent.keyDown(editor, { key: 'F', code: 'KeyF', keyCode: 70, which: 70, shiftKey: true, ...modifier })

    expect(screen.getByRole('textbox', { name: 'Find' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Replace' })).toHaveFocus())
  })

  it('opens Go to Line with Control+G', async () => {
    render(<CodeMirrorEditor
      path="sample.ts"
      value={'one\ntwo\nthree'}
      readOnly={false}
      ariaLabel="Go to line sample"
      onChange={vi.fn()}
    />)

    const editor = screen.getByRole('textbox', { name: 'Go to line sample' })
    editor.focus()
    fireEvent.keyDown(editor, {
      key: 'g',
      code: 'KeyG',
      ctrlKey: true
    })

    await waitFor(() => expect(screen.getByRole('textbox', { name: /^Go to line:/i })).toBeInTheDocument())
  })

  it('shows fold gutter controls and folds parser-backed code with VS Code shortcuts', async () => {
    const value = [
      'function first() {',
      '  return 1',
      '}',
      '',
      'function second() {',
      '  return 2',
      '}'
    ].join('\n')
    render(<CodeMirrorEditor
      path="sample.ts"
      value={value}
      readOnly={false}
      ariaLabel="Fold TypeScript sample"
      onChange={vi.fn()}
    />)

    const editor = screen.getByRole('textbox', { name: 'Fold TypeScript sample' })
    const editorView = EditorView.findFromDOM(editor)!
    await waitFor(() => expect(editor).toHaveAttribute('data-language', 'typescript'))
    await waitFor(() => expect(editorView.dom.querySelector('.cm-foldGutter [title="Fold line"]')).not.toBeNull())
    editorView.dispatch({ selection: { anchor: 0 } })
    const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      ? { metaKey: true }
      : { ctrlKey: true }

    fireEvent.keyDown(editor, { key: '[', code: 'BracketLeft', altKey: true, ...modifier })
    await waitFor(() => expect(editorView.dom.querySelector('.cm-foldPlaceholder')).not.toBeNull())

    fireEvent.keyDown(editor, { key: ']', code: 'BracketRight', altKey: true, ...modifier })
    await waitFor(() => expect(editorView.dom.querySelector('.cm-foldPlaceholder')).toBeNull())

    fireEvent.keyDown(editor, { key: 'k', code: 'KeyK', ...modifier })
    fireEvent.keyDown(editor, { key: '0', code: 'Digit0', ...modifier })
    await waitFor(() => expect(editorView.dom.querySelectorAll('.cm-foldPlaceholder')).toHaveLength(2))

    fireEvent.keyDown(editor, { key: 'k', code: 'KeyK', ...modifier })
    fireEvent.keyDown(editor, { key: 'j', code: 'KeyJ', ...modifier })
    await waitFor(() => expect(editorView.dom.querySelectorAll('.cm-foldPlaceholder')).toHaveLength(0))
  })

  it('folds indentation-based legacy languages and restores folds after remounting', async () => {
    const value = [
      'root:',
      '  child: one',
      '  nested:',
      '    child: two',
      'next:',
      '  child: three'
    ].join('\n')
    const remember = vi.fn()
    const first = render(<CodeMirrorEditor
      path="sample.yaml"
      value={value}
      readOnly={false}
      ariaLabel="Fold YAML sample"
      onViewStateChange={remember}
      onChange={vi.fn()}
    />)

    const editor = screen.getByRole('textbox', { name: 'Fold YAML sample' })
    const editorView = EditorView.findFromDOM(editor)!
    await waitFor(() => expect(editor).toHaveAttribute('data-language', 'yaml'))
    await waitFor(() => expect(editorView.dom.querySelector('.cm-foldGutter [title="Fold line"]')).not.toBeNull())
    const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      ? { metaKey: true }
      : { ctrlKey: true }
    const foldAt = (anchor: number) => {
      editorView.dispatch({ selection: { anchor } })
      fireEvent.keyDown(editor, { key: '[', code: 'BracketLeft', altKey: true, ...modifier })
    }
    foldAt(value.indexOf('nested:'))
    foldAt(value.indexOf('next:'))
    foldAt(0)
    await waitFor(() => expect(editorView.dom.querySelector('.cm-foldPlaceholder')).not.toBeNull())

    first.unmount()
    const saved = remember.mock.calls.at(-1)?.[0]
    expect(saved?.folds).toHaveLength(3)
    expect(saved?.folds).toEqual([...saved.folds].sort((left, right) => (
      left.from - right.from || left.to - right.to
    )))

    render(<CodeMirrorEditor
      path="sample.yaml"
      value={value}
      readOnly={false}
      ariaLabel="Restored Fold YAML sample"
      initialViewState={saved}
      onChange={vi.fn()}
    />)
    const restored = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Restored Fold YAML sample' }))!
    await waitFor(() => expect(restored.dom.querySelector('.cm-foldPlaceholder')).not.toBeNull())

    cleanup()
    const changedValue = value.replace('child: one', 'child: two')
    render(<CodeMirrorEditor
      path="sample.yaml"
      value={changedValue}
      readOnly={false}
      ariaLabel="Changed Fold YAML sample"
      initialViewState={saved}
      onChange={vi.fn()}
    />)
    const changedEditor = screen.getByRole('textbox', { name: 'Changed Fold YAML sample' })
    const changed = EditorView.findFromDOM(changedEditor)!
    await waitFor(() => expect(changedEditor).toHaveAttribute('data-language', 'yaml'))
    expect(changed.dom.querySelector('.cm-foldPlaceholder')).toBeNull()
  })

  it('bounds indentation fallback work for exceptionally large legacy-language blocks', async () => {
    const value = `root:\n${'  child: value\n'.repeat(1_001)}next: value`
    render(<CodeMirrorEditor
      path="large.yaml"
      value={value}
      readOnly={false}
      ariaLabel="Bounded Fold YAML sample"
      onChange={vi.fn()}
    />)

    const editor = screen.getByRole('textbox', { name: 'Bounded Fold YAML sample' })
    const editorView = EditorView.findFromDOM(editor)!
    await waitFor(() => expect(editor).toHaveAttribute('data-language', 'yaml'))
    editorView.dispatch({ selection: { anchor: 0 } })
    const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      ? { metaKey: true }
      : { ctrlKey: true }
    fireEvent.keyDown(editor, { key: '[', code: 'BracketLeft', altKey: true, ...modifier })

    expect(editorView.dom.querySelector('.cm-foldPlaceholder')).toBeNull()
  })

  it('reveals a requested line and column and clamps locations beyond the document', () => {
    const handled = vi.fn()
    const rendered = render(<CodeMirrorEditor
      path="sample.ts"
      value={'one\ntwo\nthree'}
      readOnly={false}
      ariaLabel="Linked reference sample"
      navigationRequest={{ requestId: 1, line: 2, column: 2 }}
      onNavigationHandled={handled}
      onChange={vi.fn()}
    />)

    const editor = screen.getByRole('textbox', { name: 'Linked reference sample' })
    const editorView = EditorView.findFromDOM(editor)!
    expect(editorView.state.selection.main.anchor).toBe(5)
    expect(editor).toHaveFocus()
    expect(handled).toHaveBeenCalledWith(1)

    rendered.rerender(<CodeMirrorEditor
      path="sample.ts"
      value={'one\ntwo\nthree'}
      readOnly={false}
      ariaLabel="Linked reference sample"
      navigationRequest={{ requestId: 2, line: 99, column: 99 }}
      onNavigationHandled={handled}
      onChange={vi.fn()}
    />)

    expect(editorView.state.selection.main.anchor).toBe('one\ntwo\nthree'.length)
    expect(handled).toHaveBeenLastCalledWith(2)
  })

  it('restores cursor and scroll state when a file editor remounts', async () => {
    const remember = vi.fn()
    const first = render(<CodeMirrorEditor
      path="sample.ts"
      value={'one\ntwo\nthree\nfour'}
      readOnly={false}
      ariaLabel="Remembered sample"
      onViewStateChange={remember}
      onChange={vi.fn()}
    />)
    const firstEditor = screen.getByRole('textbox', { name: 'Remembered sample' })
    const firstView = EditorView.findFromDOM(firstEditor)!
    firstView.dispatch({ selection: { anchor: 5, head: 8 } })
    firstView.scrollDOM.scrollTop = 72
    firstView.scrollDOM.scrollLeft = 9
    first.unmount()

    expect(remember).toHaveBeenLastCalledWith({
      anchor: 5,
      head: 8,
      scrollTop: 72,
      scrollLeft: 9
    })

    const saved = remember.mock.calls.at(-1)?.[0]
    render(<CodeMirrorEditor
      path="sample.ts"
      value={'one\ntwo\nthree\nfour'}
      readOnly={false}
      ariaLabel="Restored sample"
      initialViewState={saved}
      onChange={vi.fn()}
    />)
    const restored = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Restored sample' }))!
    expect(restored.state.selection.main).toMatchObject({ anchor: 5, head: 8 })
    await waitFor(() => {
      expect(restored.scrollDOM.scrollTop).toBe(72)
      expect(restored.scrollDOM.scrollLeft).toBe(9)
    })
  })

  it('reconfigures theme and font size without replacing the editor', async () => {
    const onChange = vi.fn()
    const rendered = render(<CodeMirrorEditor
      path="sample.ts"
      value="const answer = 42"
      readOnly={false}
      ariaLabel="Appearance sample"
      theme="vscode-dark"
      fontSize={12}
      onChange={onChange}
    />)

    const editor = screen.getByRole('textbox', { name: 'Appearance sample' })
    const editorView = EditorView.findFromDOM(editor)
    expect(editorView?.state.facet(EditorView.darkTheme)).toBe(true)
    expect(getComputedStyle(editorView!.dom).fontSize).toBe('12px')

    rendered.rerender(<CodeMirrorEditor
      path="sample.ts"
      value="const answer = 42"
      readOnly={false}
      ariaLabel="Appearance sample"
      theme="github-light"
      fontSize={18}
      onChange={onChange}
    />)

    await waitFor(() => {
      expect(EditorView.findFromDOM(editor)).toBe(editorView)
      expect(editorView?.state.facet(EditorView.darkTheme)).toBe(false)
      expect(getComputedStyle(editorView!.dom).fontSize).toBe('18px')
    })
  })

  it('follows live app theme changes by default', async () => {
    document.documentElement.dataset.theme = 'light'
    render(<CodeMirrorEditor
      path="sample.ts"
      value="const answer = 42"
      readOnly={false}
      ariaLabel="App-themed sample"
      onChange={vi.fn()}
    />)

    const editorView = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'App-themed sample' }))!
    expect(editorView.state.facet(EditorView.darkTheme)).toBe(false)

    document.documentElement.dataset.theme = 'dark'
    await waitFor(() => expect(editorView.state.facet(EditorView.darkTheme)).toBe(true))
  })
})
