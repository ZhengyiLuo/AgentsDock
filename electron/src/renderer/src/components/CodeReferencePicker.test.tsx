import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { CodeIntelligenceStatus } from '@shared/code-intelligence'
import type { Session, WorkspaceSearchPage } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { createCodeIntelligenceClient, searchWorkspaceSymbols } from '../lib/code-intelligence'
import { resetTransientCloseStackForTests } from '../lib/transient-close'
import { Composer } from './Composer'
import { CodeReferencePicker, CodeReferenceShelf, codeReferenceText, codeReferenceDraftLines, parseCodeReferenceRange } from './CodeReferencePicker'

vi.mock('../lib/code-intelligence', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/code-intelligence')>(), createCodeIntelligenceClient: vi.fn(), searchWorkspaceSymbols: vi.fn()
}))

const scope = { profileId: 'profile-a', profileGeneration: 0, serverIdentity: null }
const session: Session = { id: 'chat-1', title: 'Project', backend: 'codex', cwd: '/project' }
const initial = useAppStore.getState()
const status: CodeIntelligenceStatus = { root: '/project', root_uri: 'file:///project', languages: [{ id: 'typescript', available: true }] }
const filePage: WorkspaceSearchPage = { root: '/project', query: '', entries: [
  { name: 'App.tsx', path: 'src/App.tsx', kind: 'file', size: 10 }, { name: 'test.ts', path: 'test.ts', kind: 'file', size: 10 }
], scanned: 2, limit: 100, truncated: false }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function setupAPI() {
  const api = {
    intelligence: { files: vi.fn().mockResolvedValue(filePage), status: vi.fn().mockResolvedValue(status),
      read: vi.fn().mockResolvedValue({ root: '/project', path: 'src/App.tsx', content: 'export const App = 1', size: 20 }) },
    preferences: { get: vi.fn().mockResolvedValue(''), set: vi.fn().mockResolvedValue(undefined) },
    workspace: { read: vi.fn() }
  }
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: api as unknown as AgentsDockAPI })
  return api
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({ ...initial, profileGeneration: scope.profileGeneration, activeProfileId: scope.profileId,
    profiles: [], connected: true, selectedSessionId: session.id, sessions: [session], switchingProfileId: null,
    drafts: {}, snapshots: {}, health: null, runtimeCatalog: null, activeSessionIds: new Set(),
    uploadsBySession: {}, uploadPathsBySession: {}, chatReferencesBySession: {}, teamReferencesBySession: {},
    turnAdmissionTokens: {}, pendingTurnSubmissions: {}, discardingEmptyChats: {},
    chatPanes: { primary: session.id, secondary: null }, focusedChatPane: 'primary'
  })
  setLocale('en')
})
afterEach(() => { cleanup(); vi.useRealTimers(); resetTransientCloseStackForTests(); setLocale('en'); useAppStore.setState(initial) })

describe('code reference picker', () => {
  it('does no idle work, searches only the final debounced query, and adds a server path and explicit line range without reading files', async () => {
    const api = setupAPI(), onSelect = vi.fn()
    render(<CodeReferencePicker session={session} scope={scope} onSelect={onSelect} />)
    expect(api.intelligence.status).not.toHaveBeenCalled()
    expect(api.intelligence.files).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Files and symbols' }))
    await waitFor(() => expect(api.intelligence.files).toHaveBeenCalledTimes(1))
    expect(api.intelligence.files).toHaveBeenCalledWith(scope, session.id, '', 100)
    const search = screen.getByRole('combobox')
    fireEvent.change(search, { target: { value: 'A' } })
    fireEvent.change(search, { target: { value: 'App' } })
    await waitFor(() => expect(api.intelligence.files).toHaveBeenCalledTimes(2))
    expect(api.intelligence.files).toHaveBeenLastCalledWith(scope, session.id, 'App', 100)
    await screen.findByRole('option', { name: /App.tsx/ })
    fireEvent.change(screen.getByRole('textbox', { name: 'Lines (optional)' }), { target: { value: '12-20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }))
    expect(onSelect).toHaveBeenCalledWith({ path: '/project/src/App.tsx', line: 12, endLine: 20 })
    expect(api.workspace.read).not.toHaveBeenCalled()
    expect(api.intelligence.read).not.toHaveBeenCalled()
    expect(api.intelligence.status).toHaveBeenCalledTimes(1)
    expect(createCodeIntelligenceClient).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('supports keyboard selection and rejects invalid ranges', async () => {
    setupAPI()
    const onSelect = vi.fn()
    render(<CodeReferencePicker session={session} scope={scope} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Files and symbols' }))
    await screen.findByRole('option', { name: /test.ts/ })
    const search = screen.getByRole('combobox')
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /test.ts/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.change(screen.getByRole('textbox', { name: 'Lines (optional)' }), { target: { value: '20-12' } })
    expect(screen.getByRole('button', { name: 'Add reference' })).toBeDisabled()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Lines (optional)' }), { target: { value: '3' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith({ path: '/project/test.ts', line: 3 })
  })

  it('opens language clients only for a Symbols query, reuses them, and cancels them when dismissed', async () => {
    const api = setupAPI()
    api.intelligence.status.mockResolvedValue({ ...status, languages: [
      ...status.languages, { id: 'python', available: true }
    ] })
    const close = vi.fn(), client = {} as Awaited<ReturnType<typeof createCodeIntelligenceClient>>['client']
    vi.mocked(createCodeIntelligenceClient).mockResolvedValue({ client, close })
    vi.mocked(searchWorkspaceSymbols).mockResolvedValue([{ name: 'App', path: 'src/App.tsx', line: 8, endLine: 11, column: 1 }])
    const onSelect = vi.fn()
    render(<CodeReferencePicker session={session} scope={scope} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Files and symbols' }))
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Symbols' }), { button: 0, ctrlKey: false })
    expect(createCodeIntelligenceClient).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'App' } })
    await screen.findByRole('option', { name: /App src\/App.tsx:8/ })
    expect(searchWorkspaceSymbols).toHaveBeenCalledWith(client, 'App', status.root_uri)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Lines (optional)' })).toHaveValue('8-11'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Application' } })
    await waitFor(() => expect(searchWorkspaceSymbols).toHaveBeenCalledTimes(2))
    expect(createCodeIntelligenceClient).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Some language servers did not respond. Showing available results.')).not.toBeInTheDocument()
    expect(api.intelligence.read).toHaveBeenCalledTimes(1)
    expect(createCodeIntelligenceClient).toHaveBeenCalledWith(expect.objectContaining({
      document: { path: 'src/App.tsx', text: 'export const App = 1' }, workspaceSymbols: true
    }))
    const signal = vi.mocked(createCodeIntelligenceClient).mock.calls[0][0].signal
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(signal?.aborted).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('discards obsolete query results and results from a previous server', async () => {
    const api = setupAPI(), old = deferred<WorkspaceSearchPage>(), next = deferred<WorkspaceSearchPage>()
    api.intelligence.files.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const onSelect = vi.fn()
    const view = render(<CodeReferencePicker key="a" session={session} scope={scope} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Files and symbols' }))
    await waitFor(() => expect(api.intelligence.files).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'new' } })
    await waitFor(() => expect(api.intelligence.files).toHaveBeenCalledTimes(2))
    await act(async () => old.resolve(filePage))
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    act(() => useAppStore.setState({ activeProfileId: 'profile-b', profileGeneration: 1 }))
    view.rerender(<CodeReferencePicker key="b" session={session} scope={{ ...scope, profileId: 'profile-b', profileGeneration: 1 }} onSelect={onSelect} />)
    await act(async () => next.resolve(filePage))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('skips large source files during symbol bootstrap and cannot connect after the picker closes', async () => {
    const api = setupAPI(), seed = deferred<{ root: string; path: string; content: string; size: number }>()
    api.intelligence.files.mockResolvedValue({ ...filePage, entries: [
      { name: 'huge.ts', path: 'huge.ts', kind: 'file', size: 1024 * 1024 }, filePage.entries[0]
    ] })
    api.intelligence.read.mockReturnValue(seed.promise)
    render(<CodeReferencePicker session={session} scope={scope} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Files and symbols' }))
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Symbols' }), { button: 0, ctrlKey: false })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'App' } })
    await waitFor(() => expect(api.intelligence.read).toHaveBeenCalledWith(scope, session.id, 'src/App.tsx'))
    fireEvent.click(screen.getByRole('button', { name: 'Close files and symbols' }))
    await act(async () => seed.resolve({ root: '/project', path: 'src/App.tsx', content: 'export const App = 1', size: 20 }))
    expect(createCodeIntelligenceClient).not.toHaveBeenCalled()
    expect(searchWorkspaceSymbols).not.toHaveBeenCalled()
  })

  it('bootstraps a module-only TypeScript project through bounded extension searches', async () => {
    const api = setupAPI(), client = {} as Awaited<ReturnType<typeof createCodeIntelligenceClient>>['client']
    api.intelligence.files.mockImplementation(async (_scope, _session, query) => ({ ...filePage,
      entries: query === '.mts' || !query ? [{ name: 'main.mts', path: 'src/main.mts', kind: 'file', size: 20 }] : []
    }))
    api.intelligence.read.mockResolvedValue({ root: '/project', path: 'src/main.mts', content: 'export const moduleSymbol = 1', size: 28 })
    vi.mocked(createCodeIntelligenceClient).mockResolvedValue({ client, close: vi.fn() })
    vi.mocked(searchWorkspaceSymbols).mockResolvedValue([{ name: 'moduleSymbol', path: 'src/main.mts', line: 1, column: 1 }])
    render(<CodeReferencePicker session={session} scope={scope} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Files and symbols' }))
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Symbols' }), { button: 0, ctrlKey: false })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'moduleSymbol' } })
    await screen.findByRole('option', { name: /moduleSymbol/ })
    expect(api.intelligence.files.mock.calls.map(call => call[2]).filter(Boolean)).toEqual(['.ts', '.js', '.mts'])
    expect(api.intelligence.read).toHaveBeenCalledWith(scope, session.id, 'src/main.mts')
    expect(createCodeIntelligenceClient).toHaveBeenCalledWith(expect.objectContaining({
      language: 'typescript', document: { path: 'src/main.mts', text: 'export const moduleSymbol = 1' }
    }))
  })

  it('reports partial startup failure even when the remaining language returns no symbols', async () => {
    const api = setupAPI(), client = {} as Awaited<ReturnType<typeof createCodeIntelligenceClient>>['client']
    api.intelligence.status.mockResolvedValue({ ...status, languages: [...status.languages, { id: 'python', available: true }] })
    api.intelligence.files.mockResolvedValue({ ...filePage, entries: [...filePage.entries,
      { name: 'main.py', path: 'main.py', kind: 'file', size: 20 }
    ] })
    api.intelligence.read.mockImplementation(async (_scope, _session, path) => ({ root: '/project', path, content: '', size: 0 }))
    vi.mocked(createCodeIntelligenceClient).mockImplementation(async options => {
      if (options.language === 'python') throw new Error('Language server disconnected')
      return { client, close: vi.fn() }
    })
    vi.mocked(searchWorkspaceSymbols).mockResolvedValue([])
    render(<CodeReferencePicker session={session} scope={scope} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Files and symbols' }))
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Symbols' }), { button: 0, ctrlKey: false })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'missing' } })
    expect(await screen.findByText('Some language servers did not respond. Showing available results.')).toBeInTheDocument()
    expect(screen.queryByText('No matching files or symbols.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('keeps file references available when symbol status fails and translates the dialog', async () => {
    const api = setupAPI()
    api.intelligence.status.mockRejectedValue(new Error('Unsupported endpoint'))
    setLocale('zh-CN')
    render(<CodeReferencePicker session={session} scope={scope} onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '文件和符号' }))
    await screen.findByRole('option', { name: /App.tsx/ })
    expect(screen.getByRole('button', { name: '添加引用' })).toBeEnabled()
    fireEvent.mouseDown(screen.getByRole('tab', { name: '符号' }), { button: 0, ctrlKey: false })
    expect(await screen.findByText('项目符号搜索不可用。您仍可添加文件引用。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭文件和符号' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps references in the existing editable composer draft and persists them through reopening', async () => {
    const api = setupAPI()
    const view = render(<Composer />)
    const message = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.change(message, { target: { value: 'Please review this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Files and symbols' }))
    await screen.findByRole('option', { name: /App.tsx/ })
    fireEvent.click(screen.getByRole('button', { name: 'Add reference' }))
    expect(message).toHaveValue('Please review this\n`/project/src/App.tsx`\n')
    fireEvent.change(message, { target: { value: 'Please review this\n`/project/src/App.tsx:4-8`\n' } })
    expect(screen.getByRole('button', { name: 'Remove reference /project/src/App.tsx:4-8' })).toBeInTheDocument()
    await waitFor(() => expect(useAppStore.getState().drafts[session.id]).toContain('/project/src/App.tsx:4-8'))
    view.unmount()
    render(<Composer />)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Please review this\n`/project/src/App.tsx:4-8`\n')
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference /project/src/App.tsx:4-8' }))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Please review this\n')
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
    expect(api.workspace.read).not.toHaveBeenCalled()
  })
})

describe('plain draft reference formatting', () => {
  it('preserves spaces and backticks and exposes only standalone absolute paths as removable references', () => {
    const text = codeReferenceText({ path: '/project/a ` b.ts', line: 4, endLine: 9 })
    expect(text).toBe('``/project/a ` b.ts:4-9``')
    expect(codeReferenceDraftLines(`See this:\n${text}\nordinary \`inline\` code`)).toEqual([
      { text, label: '/project/a ` b.ts:4-9', start: 10, end: 10 + text.length }
    ])
    expect(parseCodeReferenceRange('0')).toBeNull()
    expect(parseCodeReferenceRange('9-4')).toBeNull()
    expect(parseCodeReferenceRange('')).toEqual({})
  })

  it('lets keyboard users edit or remove a restored reference', () => {
    setupAPI()
    const onEdit = vi.fn(), onRemove = vi.fn()
    render(<CodeReferenceShelf draft="`/project/file.ts:3`" onEdit={onEdit} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit reference /project/file.ts:3' }))
    expect(onEdit).toHaveBeenCalledWith(0, 20)
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference /project/file.ts:3' }))
    expect(onRemove).toHaveBeenCalledWith(0, 20)
  })
})
