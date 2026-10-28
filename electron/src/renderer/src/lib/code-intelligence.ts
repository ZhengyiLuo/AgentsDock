import { LSPClient, type LSPClientConfig, type Transport } from '@codemirror/lsp-client'
import type { CodeIntelligenceAPI, CodeIntelligenceLanguage } from '@shared/code-intelligence'
import type { WorkspaceProfileScope } from '@shared/types'

export interface CodeLocation {
  path: string
  line: number
  column: number
  endLine?: number
}

export interface CodeSymbol extends CodeLocation {
  name: string
  kind?: number
  containerName?: string
}

interface ConnectionOptions {
  api: CodeIntelligenceAPI
  scope: WorkspaceProfileScope
  sessionId: string
  language: CodeIntelligenceLanguage
  rootUri: string
  workspaceSymbols?: boolean
  signal?: AbortSignal
  onClose?: (message?: string) => void
}

export interface CodeIntelligenceClient {
  client: LSPClient
  close(): void
}

const MAX_LOCATIONS = 200

class ProjectLSPClient extends LSPClient {
  override request<Params, Result>(method: string, params: Params): Promise<Result> {
    const request = super.request<Params, Result>(method, params)
    // The upstream automatic signature plugin doesn't handle rejected requests.
    // Tooltips are optional: a timeout or disconnect simply dismisses them.
    return method === 'textDocument/hover' || method === 'textDocument/signatureHelp'
      ? request.catch(() => null as Result) : request
  }
}

export function languageForCodePath(path: string): CodeIntelligenceLanguage | null {
  if (/\.(?:py|pyi)$/i.test(path)) return 'python'
  return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path) ? 'typescript' : null
}

export function codeLanguageId(path: string): string {
  if (/\.tsx$/i.test(path)) return 'typescriptreact'
  if (/\.jsx$/i.test(path)) return 'javascriptreact'
  if (/\.[cm]?js$/i.test(path)) return 'javascript'
  return languageForCodePath(path) ?? 'plaintext'
}

/** Construct URIs from path segments, never from unescaped file names. */
export function workspaceFileUri(rootUri: string, path: string): string | null {
  const root = fileUriParts(rootUri)
  if (!root || !path || path.includes('\0') || path.includes('\\')) return null
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return null
  const url = new URL(rootUri)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${parts.map(encodeURIComponent).join('/')}`
  return url.href
}

/** Locations are limited to this chat's workspace, including on remote hosts. */
export function codeLocationPath(rootUri: string, uri: string): string | null {
  const root = fileUriParts(rootUri)
  const file = fileUriParts(uri)
  if (!root || !file || root.host !== file.host || file.parts.length <= root.parts.length) return null
  const windows = /^[a-z]:$/i.test(root.parts[0] ?? '')
  if (!root.parts.every((part, index) => windows
    ? part.toLowerCase() === file.parts[index]?.toLowerCase()
    : part === file.parts[index])) return null
  return file.parts.slice(root.parts.length).join('/')
}

function fileUriParts(uri: string): { host: string, parts: string[] } | null {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'file:' || url.search || url.hash || url.username || url.password) return null
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts.some(part => /[\0/\\]/.test(part) || part === '.' || part === '..')) return null
    return { host: url.host.toLowerCase(), parts }
  } catch { return null }
}

export function normalizedCodeLocations(rootUri: string, value: unknown): CodeLocation[] {
  const results: CodeLocation[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(value) ? value : value ? [value] : []) {
    if (!item || typeof item !== 'object') continue
    const uri = 'targetUri' in item ? item.targetUri : item.uri
    const range = 'targetSelectionRange' in item ? item.targetSelectionRange : item.range
    if (typeof uri !== 'string' || !range || !validPosition(range.start) || !validPosition(range.end)) continue
    const path = codeLocationPath(rootUri, uri)
    if (!path) continue
    const key = `${path}:${range.start.line}:${range.start.character}`
    if (seen.has(key)) continue
    seen.add(key)
    const endLine = Math.max(range.start.line + 1, range.end.line + (range.end.character === 0 ? 0 : 1))
    results.push({ path, line: range.start.line + 1, column: range.start.character + 1, endLine })
    if (results.length === MAX_LOCATIONS) break
  }
  return results
}

function validPosition(value: unknown): value is { line: number, character: number } {
  if (!value || typeof value !== 'object') return false
  const position = value as { line: number, character: number }
  return Number.isSafeInteger(position.line) && position.line >= 0
    && Number.isSafeInteger(position.character) && position.character >= 0
}

export async function searchWorkspaceSymbols(client: LSPClient, query: string, rootUri: string): Promise<CodeSymbol[]> {
  if (!query.trim() || !client.serverCapabilities?.workspaceSymbolProvider) return []
  const response = await client.request<{ query: string }, unknown>('workspace/symbol', { query: query.trim().slice(0, 200) })
  if (!Array.isArray(response)) return []
  const symbols: CodeSymbol[] = []
  const seen = new Set<string>()
  for (const symbol of response) {
    if (!symbol || typeof symbol.name !== 'string' || !symbol.location) continue
    const location = normalizedCodeLocations(rootUri, symbol.location)[0]
    if (!location) continue
    const key = `${symbol.name}:${location.path}:${location.line}:${location.column}`
    if (seen.has(key)) continue
    seen.add(key)
    symbols.push({ ...location, name: symbol.name,
      ...(typeof symbol.kind === 'number' ? { kind: symbol.kind } : {}),
      ...(typeof symbol.containerName === 'string' ? { containerName: symbol.containerName } : {}) })
    if (symbols.length === MAX_LOCATIONS) break
  }
  return symbols
}

/** One connection owns one server process. There is deliberately no reconnect loop. */
export async function openCodeIntelligenceConnection(options: ConnectionOptions): Promise<{ transport: Transport, close(): void }> {
  const { api, sessionId, language, rootUri, signal, onClose } = options
  // Capture the identity, rather than retaining a mutable caller-owned object.
  const scope = { ...options.scope }
  const connectionId = crypto.randomUUID()
  const handlers = new Set<(message: string) => void>()
  const requests = new Set<string | number>()
  let closed = false
  let failure: string | undefined
  let unsubscribe = () => {}
  const disconnect = () => { void api.disconnect(scope, sessionId, connectionId).catch(() => {}) }
  const finish = (message?: string, notify = false) => {
    if (closed) return
    closed = true
    failure = message
    unsubscribe()
    signal?.removeEventListener('abort', abort)
    // Upstream disconnect does not settle its pending RPC promises. Settle them
    // before unsubscribing the client to release timers and stale completions.
    for (const id of requests) {
      const cancelled = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32800, message: message || 'Connection closed' } })
      for (const handler of handlers) handler(cancelled)
    }
    requests.clear()
    handlers.clear()
    disconnect()
    if (notify) onClose?.(message)
  }
  const abort = () => finish('Connection cancelled')
  const send = (message: string) => api.send(scope, sessionId, connectionId, message)
  // Register before connect: the server may exit immediately after opening.
  unsubscribe = api.onEvent(event => {
    if (closed || event.profileId !== scope.profileId || event.profileGeneration !== scope.profileGeneration
      || event.sessionId !== sessionId || event.connectionId !== connectionId) return
    if (event.type !== 'message') { finish(event.message, true); return }
    if (!event.message) return
    let message: Record<string, unknown>
    try { message = JSON.parse(event.message) } catch { finish('Invalid language server message', true); return }
    if (!message || typeof message !== 'object') { finish('Invalid language server message', true); return }
    if ('id' in message && typeof message.method === 'string') {
      send(JSON.stringify(serverRequestResponse(message, rootUri, language, options.workspaceSymbols)))
      return
    }
    if ('id' in message) requests.delete(message.id as string | number)
    for (const handler of handlers) handler(event.message)
  })
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  if (closed) throw new Error(failure || 'Connection cancelled')
  try {
    await api.connect(scope, sessionId, connectionId, language)
    if (closed) {
      // A close raced the native connect. Ensure the just-opened socket is gone.
      disconnect()
      throw new Error(failure || 'Connection closed')
    }
  } catch (error) { finish(); throw error }
  return {
    transport: {
      send(message) {
        const value = JSON.parse(message)
        if (closed) {
          // Upstream queues didClose as a microtask. A late notification after
          // teardown is harmless; requests still fail immediately.
          if ('id' in value) throw new Error(failure || 'Connection closed')
          return
        }
        if ('id' in value && 'method' in value) requests.add(value.id)
        try { send(message) } catch (error) { finish(String(error), true); throw error }
      },
      subscribe(handler) { if (!closed) handlers.add(handler) },
      unsubscribe(handler) { handlers.delete(handler) }
    },
    close: () => finish()
  }
}

export async function createCodeIntelligenceClient(
  options: ConnectionOptions & {
    document?: { path: string, text: string }
    extensions?: LSPClientConfig['extensions']
    notificationHandlers?: LSPClientConfig['notificationHandlers']
  }
): Promise<CodeIntelligenceClient> {
  const seed = options.document
  const seedUri = seed ? workspaceFileUri(options.rootUri, seed.path) : null
  if (seed && (!seedUri || languageForCodePath(seed.path) !== options.language
    || new TextEncoder().encode(seed.text).byteLength > 512 * 1024)) {
    throw new Error('The code index needs a source file within the workspace, up to 512 KiB.')
  }
  let seedDiagnosticsReceived = false
  let seedWaiter: ((error?: Error) => void) | undefined
  let closedError: Error | undefined
  const connection = await openCodeIntelligenceConnection({
    ...options,
    onClose: message => {
      closedError = new Error(message || 'Connection closed')
      seedWaiter?.(closedError)
      options.onClose?.(message)
    }
  })
  const client = new ProjectLSPClient({
    rootUri: options.rootUri,
    timeout: 15_000,
    // The lightweight TS syntax server may return workspace symbols before the
    // semantic project exists. A picker uses the full server so the document
    // readiness request below also waits for project loading. Editors retain
    // the normal fast syntax server during startup.
    ...(options.language === 'typescript' && options.workspaceSymbols
      ? { initializationOptions: { tsserver: { useSyntaxServer: 'never' } } } : {}),
    sanitizeHTML: sanitizeCodeIntelligenceHTML,
    extensions: [
      { clientCapabilities: { workspace: { configuration: true, workspaceFolders: true } } },
      ...(options.extensions ?? [])
    ],
    notificationHandlers: {
      ...options.notificationHandlers,
      'textDocument/publishDiagnostics': (client, params) => {
        if (seedUri && params?.uri === seedUri) {
          seedDiagnosticsReceived = true
          seedWaiter?.()
        }
        return options.notificationHandlers?.['textDocument/publishDiagnostics']?.(client, params) ?? false
      }
    }
  }).connect(connection.transport)
  const close = () => { connection.close(); client.disconnect() }
  try { await client.initializing } catch (error) { close(); throw error }
  if (closedError) { close(); throw closedError }
  if (options.signal?.aborted) { close(); throw new Error('Connection cancelled') }
  if (seed && seedUri) {
    // TypeScript needs an actual open source file to create its project. This
    // document is read once through the scoped native bridge; no file is written.
    client.notification('textDocument/didOpen', {
      textDocument: { uri: seedUri, languageId: codeLanguageId(seed.path), version: 0, text: seed.text }
    })
    if (options.workspaceSymbols && client.serverCapabilities?.documentSymbolProvider) {
      // The initialize response precedes project creation. With the picker using
      // TypeScript's full server, a document request waits for that project.
      try {
        await client.request('textDocument/documentSymbol', { textDocument: { uri: seedUri } })
      } catch (error) { close(); throw error }
    }
    if (options.workspaceSymbols && options.language === 'python' && !seedDiagnosticsReceived) {
      // Pyright discovers the workspace asynchronously. Its first diagnostic for
      // this seed follows discovery; waiting for it avoids an initial empty list.
      // A timeout remains a retryable failure, not a timer-based success guess.
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => finish(new Error('Connection cancelled'))
          const timer = setTimeout(() => finish(new Error('The language server did not finish preparing symbols.')), 15_000)
          const finish = (error?: Error) => {
            clearTimeout(timer)
            options.signal?.removeEventListener('abort', abort)
            seedWaiter = undefined
            if (error) reject(error)
            else resolve()
          }
          seedWaiter = finish
          options.signal?.addEventListener('abort', abort, { once: true })
          if (options.signal?.aborted) abort()
          else if (closedError) finish(closedError)
          else if (seedDiagnosticsReceived) finish()
        })
      } catch (error) { close(); throw error }
    }
  }
  return { client, close }
}

function serverRequestResponse(request: Record<string, unknown>, rootUri: string, language: CodeIntelligenceLanguage, workspaceSymbols = false): object {
  const response = { jsonrpc: '2.0', id: request.id }
  if (request.method === 'workspace/configuration') {
    const items = (request.params as { items?: Array<{ section?: string }> })?.items
    const settings: Record<string, unknown> = language === 'python'
      ? { python: { analysis: { diagnosticMode: workspaceSymbols ? 'workspace' : 'openFilesOnly', autoSearchPaths: true, useLibraryCodeForTypes: true } } }
      : { typescript: {}, javascript: {} }
    return { ...response, result: Array.isArray(items) ? items.map(item => {
      if (!item.section) return settings
      return item.section.split('.').reduce<unknown>((value, key) => (
        value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
      ), settings) ?? null
    }) : [] }
  }
  if (request.method === 'workspace/workspaceFolders') {
    return { ...response, result: [{ uri: rootUri, name: 'Workspace' }] }
  }
  if (['client/registerCapability', 'client/unregisterCapability', 'window/workDoneProgress/create'].includes(String(request.method))) {
    return { ...response, result: null }
  }
  return { ...response, error: { code: -32601, message: 'This client does not support this server request.' } }
}

/** Keep documentation formatting without allowing links, images or active HTML. */
export function sanitizeCodeIntelligenceHTML(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const allowed = new Set(['P', 'BR', 'PRE', 'CODE', 'EM', 'STRONG', 'B', 'I', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'SPAN', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
  const active = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE'])
  const clean = (parent: ParentNode) => {
    for (const element of Array.from(parent.children)) {
      const tag = element.tagName.toUpperCase()
      if (active.has(tag)) { element.remove(); continue }
      clean(element)
      if (!allowed.has(tag)) { element.replaceWith(...element.childNodes); continue }
      for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name)
    }
  }
  clean(template.content)
  return template.innerHTML
}
