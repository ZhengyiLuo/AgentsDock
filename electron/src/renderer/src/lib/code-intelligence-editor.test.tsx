import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { LSPPlugin } from '@codemirror/lsp-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeIntelligenceAPI, CodeIntelligenceEvent } from '@shared/code-intelligence'
import { setLocale } from '@shared/i18n'
import { CodeMirrorEditor } from '../components/CodeMirrorEditor'

const scope = { profileId: 'editor-server', profileGeneration: 2, serverIdentity: 'editor-test' }
const rootUri = 'file:///workspace/project'
const value = 'from helper import greet\nprint(greet("hi"))\n'

function fixture() {
  const listeners = new Set<(event: CodeIntelligenceEvent) => void>()
  const calls: Array<{ connectionId: string, message: Record<string, any> }> = []
  const emit = (connectionId: string, message: unknown, extra: Partial<CodeIntelligenceEvent> = {}) => {
    for (const listener of listeners) listener({ ...scope, sessionId: 'chat', connectionId, type: 'message', message: JSON.stringify(message), ...extra })
  }
  const api: CodeIntelligenceAPI = {
    files: vi.fn(), read: vi.fn(),
    status: vi.fn(async () => ({ root: '/workspace/project', root_uri: rootUri, languages: [{ id: 'python' as const, available: true }, { id: 'typescript' as const, available: true }] })),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    send: vi.fn((_scope, _sessionId, connectionId, raw) => {
      const message = JSON.parse(raw)
      calls.push({ connectionId, message })
      if (message.method === 'initialize') queueMicrotask(() => emit(connectionId, {
        jsonrpc: '2.0', id: message.id,
        result: { capabilities: { textDocumentSync: 2, completionProvider: { triggerCharacters: ['.'] }, hoverProvider: true, definitionProvider: true, referencesProvider: true } }
      }))
    })
  }
  const requests = (method: string) => calls.filter(call => call.message.method === method)
  const reply = (method: string, result: unknown) => {
    const request = requests(method).at(-1)!
    emit(request.connectionId, { jsonrpc: '2.0', id: request.message.id, result })
  }
  return { api, calls, emit, requests, reply }
}

function mountEditor(api: CodeIntelligenceAPI, onNavigate = vi.fn()) {
  window.agentsDock = { ...window.agentsDock, intelligence: api }
  const rendered = render(<CodeMirrorEditor path="main.py" value={value} readOnly={false} ariaLabel="Python source" onChange={vi.fn()}
    intelligence={{ scope, sessionId: 'chat', cwd: '/workspace/project', active: true, onNavigate }} />)
  const view = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Python source' }))!
  return { ...rendered, view, onNavigate }
}

describe('project-aware editor', () => {
  let originalAPI: typeof window.agentsDock
  beforeEach(() => {
    setLocale('en')
    originalAPI = window.agentsDock
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) })
  })
  afterEach(() => {
    cleanup()
    window.agentsDock = originalAPI
    vi.useRealTimers()
  })

  it('opens the actual draft with a project URI and debounces changes without status polling', async () => {
    const server = fixture()
    const { view } = mountEditor(server.api)
    await waitFor(() => expect(screen.getByText('IntelliSense')).toBeVisible())
    await waitFor(() => expect(server.requests('textDocument/didOpen')).toHaveLength(1))
    expect(server.requests('textDocument/didOpen')[0].message.params.textDocument).toMatchObject({ uri: `${rootUri}/main.py`, languageId: 'python', text: value, version: 0 })
    vi.useFakeTimers()
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '# one' } })
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' two' } })
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' three' } })
    })
    expect(server.requests('textDocument/didChange')).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(server.requests('textDocument/didChange')).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(server.requests('textDocument/didChange')).toHaveLength(1)
    expect(server.requests('textDocument/didChange')[0].message.params.contentChanges[0].text).toContain('# one two three')
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(server.requests('textDocument/didChange')).toHaveLength(1)
    expect(server.api.status).toHaveBeenCalledTimes(1)
    expect(server.api.connect).toHaveBeenCalledTimes(1)
  })

  it('opens definitions and reference selections through the pane callback, including LocationLink', async () => {
    const server = fixture()
    const { view, onNavigate } = mountEditor(server.api)
    await screen.findByText('IntelliSense')
    act(() => view.dispatch({ selection: { anchor: 20 } }))
    fireEvent.click(screen.getByRole('button', { name: 'Go to definition' }))
    await waitFor(() => expect(server.requests('textDocument/definition')).toHaveLength(1))
    expect(server.requests('textDocument/definition')[0].message.params.position).toEqual({ line: 0, character: 20 })
    await act(async () => server.reply('textDocument/definition', [{ targetUri: `${rootUri}/helper.py`, targetSelectionRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } } }]))
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ path: 'helper.py', line: 4, column: 5, endLine: 4 })
    fireEvent.click(screen.getByRole('button', { name: 'Find references' }))
    await waitFor(() => expect(server.requests('textDocument/references')).toHaveLength(1))
    await act(async () => server.reply('textDocument/references', [
      { uri: `${rootUri}/main.py`, range: { start: { line: 1, character: 6 }, end: { line: 1, character: 11 } } },
      { uri: `${rootUri}/helper.py`, range: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } } }
    ]))
    fireEvent.click(screen.getByRole('button', { name: /helper.py 4:5/ }))
    expect(onNavigate).toHaveBeenCalledTimes(2)
  })

  it('binds F12 and ignores a definition response after the source draft changes', async () => {
    const server = fixture()
    const { view, onNavigate } = mountEditor(server.api)
    await screen.findByText('IntelliSense')
    act(() => view.focus())
    fireEvent.keyDown(view.contentDOM, { key: 'F12', code: 'F12' })
    await waitFor(() => expect(server.requests('textDocument/definition')).toHaveLength(1))
    act(() => view.dispatch({ changes: { from: 0, insert: '# changed\n' } }))
    await act(async () => server.reply('textDocument/definition', { uri: `${rootUri}/helper.py`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }))
    expect(onNavigate).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: 'Code locations' })).not.toBeInTheDocument()
  })

  it('uses the official completion source and shows returned project candidates', async () => {
    const server = fixture()
    const { view } = mountEditor(server.api)
    await screen.findByText('IntelliSense')
    act(() => { view.dispatch({ selection: { anchor: 21 } }); view.focus() })
    fireEvent.keyDown(view.contentDOM, { key: ' ', code: 'Space', ctrlKey: true })
    await waitFor(() => expect(server.requests('textDocument/completion')).toHaveLength(1))
    await act(async () => server.reply('textDocument/completion', [{ label: 'greet_from_project', kind: 3, detail: '(name: str) -> str' }]))
    await waitFor(() => expect(screen.getByRole('option', { name: /greet_from_project/ })).toBeVisible())
  })

  it('ignores diagnostic versions and diagnostics for a newer unsynchronized draft', async () => {
    const server = fixture()
    const { view } = mountEditor(server.api)
    await screen.findByText('IntelliSense')
    const connectionId = server.requests('initialize')[0].connectionId
    const diagnostics = [{ range: { start: { line: 0, character: 5 }, end: { line: 0, character: 11 } }, severity: 1, message: 'Unknown import' }]
    const publish = (version: number) => server.emit(connectionId, { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: `${rootUri}/main.py`, version, diagnostics } })
    act(() => publish(99))
    expect(view.dom.querySelector('.cm-lintRange-error')).toBeNull()
    act(() => view.dispatch({ changes: { from: 0, insert: '#' } }))
    act(() => publish(0))
    expect(view.dom.querySelector('.cm-lintRange-error')).toBeNull()
    act(() => { LSPPlugin.get(view)!.client.sync() })
    act(() => publish(1))
    await waitFor(() => expect(view.dom.querySelector('.cm-lintRange-error')).not.toBeNull())
  })

  it('keeps the editor usable when missing setup or disconnected, with explicit retry only', async () => {
    const server = fixture()
    vi.mocked(server.api.status).mockResolvedValueOnce({ root: '/workspace/project', root_uri: rootUri, languages: [{ id: 'python', available: false, message: 'Pyright is missing', install_hint: 'npm install --global pyright' }] })
    const { view } = mountEditor(server.api)
    await screen.findByText('IntelliSense unavailable')
    expect(server.api.connect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }))
    expect(screen.getByText('Pyright is missing')).toBeVisible()
    expect(screen.getByText('npm install --global pyright')).toBeVisible()
    act(() => view.dispatch({ changes: { from: 0, insert: '# still editing\n' } }))
    expect(view.state.doc.toString()).toContain('still editing')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('IntelliSense')
    const connectionId = server.requests('initialize')[0].connectionId
    act(() => server.emit(connectionId, {}, { type: 'closed', message: 'Server stopped' }))
    await screen.findByText('IntelliSense unavailable')
    expect(server.api.connect).toHaveBeenCalledTimes(1)
    expect(LSPPlugin.get(view)).toBeNull()
  })

  it('closes the old connection on file changes and does not apply its late navigation', async () => {
    const server = fixture()
    const { rerender, onNavigate } = mountEditor(server.api)
    await screen.findByText('IntelliSense')
    fireEvent.click(screen.getByRole('button', { name: 'Go to definition' }))
    await waitFor(() => expect(server.requests('textDocument/definition')).toHaveLength(1))
    rerender(<CodeMirrorEditor path="other.py" value="x = 1\n" readOnly={false} ariaLabel="Other source" onChange={vi.fn()}
      intelligence={{ scope, sessionId: 'chat', cwd: '/workspace/project', active: true, onNavigate }} />)
    await screen.findByText('IntelliSense')
    await act(async () => server.reply('textDocument/definition', { uri: `${rootUri}/helper.py`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } }))
    expect(onNavigate).not.toHaveBeenCalled()
    expect(server.api.disconnect).toHaveBeenCalledTimes(1)
    expect(server.api.connect).toHaveBeenCalledTimes(2)
  })
})
