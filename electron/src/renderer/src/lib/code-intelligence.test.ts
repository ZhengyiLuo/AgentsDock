import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodeIntelligenceAPI, CodeIntelligenceEvent } from '@shared/code-intelligence'
import {
  codeLanguageId, codeLocationPath, createCodeIntelligenceClient, languageForCodePath,
  normalizedCodeLocations, openCodeIntelligenceConnection, sanitizeCodeIntelligenceHTML,
  searchWorkspaceSymbols, workspaceFileUri
} from './code-intelligence'

const scope = { profileId: 'test-server', profileGeneration: 4 }
const rootUri = 'file:///workspace/project'

function bridge() {
  let listener: ((event: CodeIntelligenceEvent) => void) | undefined
  let connectionId = ''
  const calls: Array<Record<string, any>> = []
  const api: CodeIntelligenceAPI = {
    status: vi.fn(), files: vi.fn(), read: vi.fn(),
    connect: vi.fn(async (_scope, _sessionId, id) => { connectionId = id }),
    disconnect: vi.fn(async () => {}),
    send: vi.fn((_scope, _sessionId, _id, message) => calls.push(JSON.parse(message))),
    onEvent: vi.fn(handler => { listener = handler; return () => { listener = undefined } })
  }
  const event = (value: Partial<CodeIntelligenceEvent>) => listener?.({
    ...scope, sessionId: 'chat', connectionId, type: 'message', ...value
  })
  const reply = (id: number | string, result: unknown) => event({ message: JSON.stringify({ jsonrpc: '2.0', id, result }) })
  return { api, calls, event, reply }
}

afterEach(() => vi.useRealTimers())

describe('code intelligence workspace paths', () => {
  it('encodes actual path segments and preserves source language IDs', () => {
    expect(workspaceFileUri(rootUri, 'src/a #?%.tsx')).toBe('file:///workspace/project/src/a%20%23%3F%25.tsx')
    expect(codeLocationPath(rootUri, 'file:///workspace/project/src/a%20%23%3F%25.tsx')).toBe('src/a #?%.tsx')
    expect(codeLanguageId('a.jsx')).toBe('javascriptreact')
    expect(codeLanguageId('a.mts')).toBe('typescript')
    expect(codeLanguageId('a.cjs')).toBe('javascript')
    expect(languageForCodePath('a.pyi')).toBe('python')
    expect(languageForCodePath('notes.md')).toBeNull()
  })

  it('rejects sibling roots, encoded separators, non-files and traversal', () => {
    for (const path of ['../secret.ts', '/absolute.ts', 'a/../b.py', 'a\\b.ts']) {
      expect(workspaceFileUri(rootUri, path)).toBeNull()
    }
    for (const uri of ['file:///workspace/project-other/a.ts', 'file:///workspace/secret.ts',
      'file:///workspace/project/a%2Fb.ts', 'file:///workspace/project/a%5Cb.ts',
      'file://other/workspace/project/a.ts', 'https://host/workspace/project/a.ts',
      'file:///workspace/project/a.ts?bad=1']) {
      expect(codeLocationPath(rootUri, uri)).toBeNull()
    }
    expect(codeLocationPath('file:///C:/Project', 'file:///c:/project/src/a.ts')).toBe('src/a.ts')
  })

  it('normalizes Location and LocationLink, bounds and deduplicates navigation results', () => {
    const range = { start: { line: 2, character: 3 }, end: { line: 4, character: 0 } }
    expect(normalizedCodeLocations(rootUri, [
      { uri: `${rootUri}/a.py`, range },
      { targetUri: `${rootUri}/a.py`, targetSelectionRange: range },
      { uri: 'file:///elsewhere/b.py', range },
      { uri: `${rootUri}/b.py`, range: { start: { line: -1, character: 0 }, end: range.end } }
    ])).toEqual([{ path: 'a.py', line: 3, column: 4, endLine: 4 }])
    expect(normalizedCodeLocations(rootUri, Array.from({ length: 250 }, (_, i) => ({ uri: `${rootUri}/${i}.py`, range })))).toHaveLength(200)
  })
})

describe('native LSP transport', () => {
  it('subscribes before connect and drops events from other profiles, generations, chats and sockets', async () => {
    const fixture = bridge()
    const connected = await openCodeIntelligenceConnection({ api: fixture.api, scope, sessionId: 'chat', language: 'python', rootUri })
    expect(vi.mocked(fixture.api.onEvent).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fixture.api.connect).mock.invocationCallOrder[0])
    const handler = vi.fn()
    connected.transport.subscribe(handler)
    const message = JSON.stringify({ jsonrpc: '2.0', method: '$/progress', params: {} })
    fixture.event({ message, profileId: 'other' })
    fixture.event({ message, profileGeneration: 3 })
    fixture.event({ message, sessionId: 'other' })
    fixture.event({ message, connectionId: 'other' })
    expect(handler).not.toHaveBeenCalled()
    fixture.event({ message })
    expect(handler).toHaveBeenCalledExactlyOnceWith(message)
    connected.close()
    fixture.event({ message })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(fixture.api.disconnect).toHaveBeenCalledTimes(1)
  })

  it('reports immediate socket failure and does not reconnect', async () => {
    const fixture = bridge()
    vi.mocked(fixture.api.connect).mockImplementation(async (_scope, _session, id) => {
      fixture.event({ connectionId: id, type: 'error', message: 'Language server not installed' })
    })
    const onClose = vi.fn()
    await expect(openCodeIntelligenceConnection({ api: fixture.api, scope, sessionId: 'chat', language: 'python', rootUri, onClose }))
      .rejects.toThrow('Language server not installed')
    expect(onClose).toHaveBeenCalledExactlyOnceWith('Language server not installed')
    expect(fixture.api.connect).toHaveBeenCalledTimes(1)
  })

  it('initializes with the project root, answers configuration, and rejects unsupported server mutations', async () => {
    const fixture = bridge()
    const pending = createCodeIntelligenceClient({ api: fixture.api, scope, sessionId: 'chat', language: 'python', rootUri })
    await vi.waitFor(() => expect(fixture.calls[0]?.method).toBe('initialize'))
    expect(fixture.calls[0].params.rootUri).toBe(rootUri)
    expect(fixture.calls[0].params.capabilities.workspace).toMatchObject({ configuration: true, workspaceFolders: true })
    fixture.reply(fixture.calls[0].id, { capabilities: { workspaceSymbolProvider: true } })
    const connected = await pending
    fixture.event({ message: JSON.stringify({ jsonrpc: '2.0', id: 'server-1', method: 'workspace/configuration', params: { items: [{ section: 'python.analysis' }] } }) })
    expect(fixture.calls.at(-1)).toMatchObject({ id: 'server-1', result: [{ diagnosticMode: 'openFilesOnly', autoSearchPaths: true }] })
    fixture.event({ message: JSON.stringify({ jsonrpc: '2.0', id: 'server-2', method: 'workspace/applyEdit', params: {} }) })
    expect(fixture.calls.at(-1)).toMatchObject({ id: 'server-2', error: { code: -32601 } })
    const symbols = searchWorkspaceSymbols(connected.client, ' Widget ', rootUri)
    await vi.waitFor(() => expect(fixture.calls.at(-1)?.method).toBe('workspace/symbol'))
    expect(fixture.calls.at(-1)?.params.query).toBe('Widget')
    const range = { start: { line: 1, character: 2 }, end: { line: 5, character: 0 } }
    fixture.reply(fixture.calls.at(-1)!.id, [
      { name: 'Widget', kind: 5, location: { uri: `${rootUri}/widget.py`, range } },
      { name: 'Outside', location: { uri: 'file:///other.py', range } }
    ])
    expect(await symbols).toEqual([{ name: 'Widget', kind: 5, path: 'widget.py', line: 2, column: 3, endLine: 5 }])
    connected.close()
  })

  it('settles pending RPCs immediately on close instead of leaking timeout or request state', async () => {
    const fixture = bridge()
    const pending = createCodeIntelligenceClient({ api: fixture.api, scope, sessionId: 'chat', language: 'python', rootUri })
    await vi.waitFor(() => expect(fixture.calls[0]?.method).toBe('initialize'))
    fixture.reply(fixture.calls[0].id, { capabilities: {} })
    const connected = await pending
    const request = connected.client.request('textDocument/definition', {})
    const rejection = expect(request).rejects.toMatchObject({ code: -32800 })
    await vi.waitFor(() => expect(fixture.calls.at(-1)?.method).toBe('textDocument/definition'))
    connected.close()
    await rejection
    expect(fixture.api.disconnect).toHaveBeenCalledTimes(1)
  })

  it('opens a bounded real seed once for symbol discovery and sends its actual language ID', async () => {
    const fixture = bridge()
    const pending = createCodeIntelligenceClient({
      api: fixture.api, scope, sessionId: 'chat', language: 'typescript', rootUri,
      document: { path: 'src/start.jsx', text: 'export const greeting = "hi"\n' }, workspaceSymbols: true
    })
    await vi.waitFor(() => expect(fixture.calls[0]?.method).toBe('initialize'))
    expect(fixture.calls[0].params.initializationOptions).toEqual({ tsserver: { useSyntaxServer: 'never' } })
    fixture.reply(fixture.calls[0].id, { capabilities: { workspaceSymbolProvider: true, documentSymbolProvider: true } })
    await vi.waitFor(() => expect(fixture.calls.at(-1)?.method).toBe('textDocument/documentSymbol'))
    fixture.reply(fixture.calls.at(-1)!.id, [])
    const connected = await pending
    expect(fixture.calls.find(call => call.method === 'textDocument/didOpen')?.params.textDocument).toEqual({
      uri: `${rootUri}/src/start.jsx`, languageId: 'javascriptreact', version: 0, text: 'export const greeting = "hi"\n'
    })
    expect(fixture.calls.filter(call => call.method === 'textDocument/didOpen')).toHaveLength(1)
    connected.close()
    await expect(createCodeIntelligenceClient({
      api: fixture.api, scope, sessionId: 'chat', language: 'python', rootUri,
      document: { path: '../outside.py', text: '' }
    })).rejects.toThrow('within the workspace')
    await expect(createCodeIntelligenceClient({
      api: fixture.api, scope, sessionId: 'chat', language: 'python', rootUri,
      document: { path: 'large.py', text: 'x'.repeat(512 * 1024 + 1) }
    })).rejects.toThrow('512 KiB')
    expect(fixture.api.connect).toHaveBeenCalledTimes(1)
  })

  it('retains native TypeScript editor routing outside the workspace symbol picker', async () => {
    const fixture = bridge()
    const pending = createCodeIntelligenceClient({ api: fixture.api, scope, sessionId: 'chat', language: 'typescript', rootUri })
    await vi.waitFor(() => expect(fixture.calls[0]?.method).toBe('initialize'))
    expect(fixture.calls[0].params.initializationOptions).toBeUndefined()
    fixture.reply(fixture.calls[0].id, { capabilities: {} })
    const connected = await pending
    connected.close()
  })

  it('closes initialization on abort without leaving a language-server process behind', async () => {
    const fixture = bridge()
    const abort = new AbortController()
    const pending = createCodeIntelligenceClient({ api: fixture.api, scope, sessionId: 'chat', language: 'python', rootUri, signal: abort.signal })
    const rejection = expect(pending).rejects.toMatchObject({ code: -32800 })
    await vi.waitFor(() => expect(fixture.calls[0]?.method).toBe('initialize'))
    abort.abort()
    await rejection
    expect(fixture.api.disconnect).toHaveBeenCalledTimes(1)
  })

  it('waits for Python seed diagnostics instead of returning a premature empty project index', async () => {
    const fixture = bridge()
    const ready = vi.fn()
    const pending = createCodeIntelligenceClient({
      api: fixture.api, scope, sessionId: 'chat', language: 'python', rootUri,
      document: { path: 'main.py', text: 'answer = 42\n' }, workspaceSymbols: true
    }).then(connection => { ready(); return connection })
    await vi.waitFor(() => expect(fixture.calls[0]?.method).toBe('initialize'))
    fixture.reply(fixture.calls[0].id, { capabilities: { workspaceSymbolProvider: true, documentSymbolProvider: true } })
    await vi.waitFor(() => expect(fixture.calls.at(-1)?.method).toBe('textDocument/documentSymbol'))
    fixture.reply(fixture.calls.at(-1)!.id, [])
    fixture.event({ message: JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: `${rootUri}/other.py`, diagnostics: [] } }) })
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()
    fixture.event({ message: JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: `${rootUri}/main.py`, diagnostics: [] } }) })
    const connected = await pending
    expect(ready).toHaveBeenCalledTimes(1)
    fixture.event({ message: JSON.stringify({ jsonrpc: '2.0', id: 'configuration', method: 'workspace/configuration', params: { items: [{ section: 'python.analysis' }] } }) })
    expect(fixture.calls.at(-1)).toMatchObject({ result: [{ diagnosticMode: 'workspace' }] })
    connected.close()
  })

  it('cancels a Python seed readiness wait when the picker closes', async () => {
    const fixture = bridge()
    const abort = new AbortController()
    const pending = createCodeIntelligenceClient({
      api: fixture.api, scope, sessionId: 'chat', language: 'python', rootUri, signal: abort.signal,
      document: { path: 'main.py', text: 'answer = 42\n' }, workspaceSymbols: true
    })
    const rejection = expect(pending).rejects.toThrow('Connection cancelled')
    await vi.waitFor(() => expect(fixture.calls[0]?.method).toBe('initialize'))
    fixture.reply(fixture.calls[0].id, { capabilities: { workspaceSymbolProvider: true } })
    await vi.waitFor(() => expect(fixture.calls.at(-1)?.method).toBe('textDocument/didOpen'))
    abort.abort()
    await rejection
    expect(fixture.api.disconnect).toHaveBeenCalledTimes(1)
  })

  it('dismisses optional pending tooltips on disconnect without an unhandled upstream rejection', async () => {
    const fixture = bridge()
    const pending = createCodeIntelligenceClient({ api: fixture.api, scope, sessionId: 'chat', language: 'python', rootUri })
    await vi.waitFor(() => expect(fixture.calls[0]?.method).toBe('initialize'))
    fixture.reply(fixture.calls[0].id, { capabilities: {} })
    const connected = await pending
    const hover = connected.client.request('textDocument/hover', {})
    const signature = connected.client.request('textDocument/signatureHelp', {})
    await vi.waitFor(() => expect(fixture.calls.at(-1)?.method).toBe('textDocument/signatureHelp'))
    connected.close()
    expect(await hover).toBeNull()
    expect(await signature).toBeNull()
  })

  it('strips active documentation HTML, links, images and attributes', () => {
    const html = sanitizeCodeIntelligenceHTML('<script>bad()</script><p onclick="bad()">Type <code class="x">Widget</code><img src="https://remote/track"><a href="javascript:bad()">link</a></p><svg><script>bad()</script></svg>')
    expect(html).toBe('<p>Type <code>Widget</code>link</p>')
  })
})
