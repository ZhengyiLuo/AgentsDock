import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import type {
  AgentFile,
  AgentTextFile,
  Session,
  WorkspaceCreateResult,
  WorkspaceEntriesPage,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSearchPage
} from '@shared/types'
import { EDITOR_APPEARANCE_STORAGE_KEY } from '../lib/editor-appearance'
import { resetTransientCloseStackForTests } from '../lib/transient-close'
import {
  absoluteWorkspacePath,
  languageLabel,
  mergeWorkspacePaletteEntries,
  resetWorkspaceEditorMemoryForTests,
  resolveWorkspacePathInput,
  resolveWorkspaceReference,
  workspaceParentDirectories,
  WorkspaceEditor
} from './WorkspaceEditor'
import './SafeHtmlMarkdownContent'

vi.mock('./CodeMirrorEditor', () => ({
  CodeMirrorEditor: ({
    value,
    readOnly,
    ariaLabel,
    theme,
    fontSize,
    maxBytes,
    initialViewState,
    navigationRequest,
    onScrollElementChange,
    onChange
  }: {
    value: string
    readOnly: boolean
    ariaLabel: string
    theme?: string
    fontSize?: number
    maxBytes?: number
    initialViewState?: { scrollTop: number; scrollLeft: number; anchor: number; head: number }
    navigationRequest?: { requestId: number; line: number; column?: number }
    onScrollElementChange?: (element: HTMLElement | null) => void
    onChange: (value: string, lines: number) => void
  }) => <textarea
    ref={onScrollElementChange}
    data-code-mirror
    data-editor-theme={theme}
    data-editor-font-size={fontSize}
    data-editor-max-bytes={maxBytes}
    data-editor-scroll-top={initialViewState?.scrollTop}
    data-editor-navigation-line={navigationRequest?.line}
    data-editor-navigation-column={navigationRequest?.column}
    aria-label={ariaLabel}
    value={value}
    readOnly={readOnly}
    onChange={event => onChange(event.target.value, event.target.value.split('\n').length)}
  />
}))

const session: Session = {
  id: 'chat-a',
  title: 'Chat A',
  backend: 'codex',
  cwd: '/work/project'
}

const entries: WorkspaceEntry[] = [
  { name: 'src', path: 'src', kind: 'directory', writable: true, revision: 'entry-src' },
  { name: 'README.md', path: 'README.md', kind: 'file', size: 12, writable: true, revision: 'entry-readme' },
  { name: 'App.tsx', path: 'src/App.tsx', kind: 'file', size: 22, writable: true, revision: 'entry-app' }
]

function workspaceFile(path: string, content = path.endsWith('.md') ? '# Project\n' : 'export const app = true\n', revision = 'rev-1'): WorkspaceFile {
  return {
    root: '/work/project',
    path,
    name: path.split('/').at(-1) ?? path,
    content,
    revision,
    size: new TextEncoder().encode(content).byteLength,
    mtime_ns: 1,
    writable: true
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

function renderEditor(
  workspaceKey = 'server-a:chat-a',
  capabilityVersion = 5,
  maxTextFileBytes?: number,
  onReady?: () => void,
  onReturnToChat?: () => void
) {
  return render(<WorkspaceEditor
    workspaceKey={workspaceKey}
    session={session}
    profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
    available
    capabilityVersion={capabilityVersion}
    maxTextFileBytes={maxTextFileBytes}
    onReady={onReady}
    onReturnToChat={onReturnToChat}
    chatContent={<p>Chat timeline</p>}
  />)
}

describe('WorkspaceEditor', () => {
  beforeEach(() => {
    setLocale('en')
    resetWorkspaceEditorMemoryForTests()
    resetTransientCloseStackForTests()
    window.localStorage.removeItem(EDITOR_APPEARANCE_STORAGE_KEY)
    window.localStorage.removeItem('agentsdock:workspace-editor-split')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        workspace: {
          info: vi.fn(),
          entries: vi.fn().mockImplementation((_sessionId: string, path = '') => Promise.resolve({
            root: '/work/project',
            path,
            entries: path === 'src' ? entries.slice(2) : path ? [] : entries.slice(0, 2),
            total: path === 'src' ? 1 : path ? 0 : 2,
            offset: 0,
            limit: 500,
            has_more: false
          })),
          search: vi.fn().mockImplementation((_sessionId: string, query = '') => Promise.resolve({
            root: '/work/project',
            query,
            entries: entries.filter(entry => entry.kind === 'file' && entry.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
            scanned: entries.length,
            truncated: false,
            limit: 100
          })),
          read: vi.fn().mockImplementation((_sessionId: string, path: string) => Promise.resolve(workspaceFile(path))),
          readAbsolute: vi.fn().mockImplementation((_sessionId: string, path: string) => Promise.resolve({
            ...workspaceFile(path, '# external\n'),
            root: '/',
            writable: false,
            scope: 'absolute'
          })),
          writeAbsolute: vi.fn().mockImplementation((_sessionId: string, path: string, content: string) => Promise.resolve({
            ...workspaceFile(path, content, 'rev-absolute-2'),
            root: '/',
            writable: true,
            scope: 'absolute'
          })),
          overwriteAbsolute: vi.fn().mockImplementation((_sessionId: string, path: string, content: string) => Promise.resolve({
            ...workspaceFile(path, content, 'rev-absolute-3'),
            root: '/',
            writable: true,
            scope: 'absolute'
          })),
          previewAvailable: vi.fn().mockResolvedValue(true),
          mediaURL: vi.fn().mockImplementation((_profileId: string, _generation: number, sessionId: string, path: string) => `agentsdock-media://workspace/profile-a/1/${sessionId}/${encodeURIComponent(path)}`),
          download: vi.fn().mockResolvedValue('/Users/test/Downloads/file'),
          create: vi.fn().mockImplementation((_sessionId: string, path: string, kind: 'file' | 'directory') => Promise.resolve({
            root: '/work/project',
            entry: {
              name: path.split('/').at(-1) ?? path,
              path,
              kind,
              writable: true,
              revision: `entry-${path}`
            },
            ...(kind === 'file' ? { file: workspaceFile(path, '', `rev-${path}`) } : {})
          })),
          write: vi.fn().mockImplementation((_sessionId: string, path: string, content: string) => Promise.resolve(workspaceFile(path, content, 'rev-2'))),
          overwrite: vi.fn().mockImplementation((_sessionId: string, path: string, content: string) => Promise.resolve(workspaceFile(path, content, 'rev-2'))),
          rename: vi.fn().mockImplementation((_sessionId: string, path: string, name: string) => {
            const parent = path.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/` : ''
            const nextPath = `${parent}${name}`
            return Promise.resolve({
              root: '/work/project',
              previous_path: path,
              entry: { ...entries.find(entry => entry.path === path), name, path: nextPath, revision: 'entry-renamed' }
            })
          }),
          remove: vi.fn().mockImplementation((_sessionId: string, path: string) => Promise.resolve({
            root: '/work/project',
            path,
            kind: entries.find(entry => entry.path === path)?.kind ?? 'file',
            removed: true
          }))
        },
        preferences: {
          get: vi.fn().mockImplementation((_key: string, fallback: unknown) => Promise.resolve(fallback)),
          set: vi.fn().mockResolvedValue(undefined),
          getScoped: vi.fn().mockImplementation((_scope: unknown, _key: string, fallback: unknown) => Promise.resolve(fallback)),
          setScoped: vi.fn().mockResolvedValue(undefined)
        },
        native: {
          log: vi.fn().mockResolvedValue(undefined),
          writeClipboard: vi.fn().mockResolvedValue(undefined)
        },
        files: {
          mediaURL: vi.fn().mockImplementation((_profileId: string, _generation: number, sessionId: string, fileId: string) => `agentsdock-media://file/profile-a/1/${sessionId}/${fileId}`),
          open: vi.fn().mockResolvedValue(undefined),
          readText: vi.fn().mockImplementation((_sessionId: string, file: AgentFile) => Promise.resolve({
            id: file.id,
            filename: file.filename,
            content: '# Migration audit\n',
            content_type: file.content_type,
            size: 18,
            revision: `artifact:${file.id}:rev-1`
          } satisfies AgentTextFile)),
          cancelReadText: vi.fn().mockResolvedValue(true)
        }
      } as unknown as AgentsDockAPI
    })
  })

  afterEach(() => {
    cleanup()
    setLocale('en')
    resetTransientCloseStackForTests()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('switches editor chrome and confirmation copy live without translating filenames or unsaved contents', async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.click(screen.getByRole('button', { name: /Open file/ }))
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    const editor = await screen.findByRole('textbox', { name: 'Contents of README.md' })
    fireEvent.change(editor, { target: { value: '# Chat Agent Prompt\nunsaved English contents' } })
    act(() => setLocale('zh-CN'))
    expect(screen.getByRole('textbox', { name: 'README.md 的内容' })).toBe(editor)
    expect(editor).toHaveValue('# Chat Agent Prompt\nunsaved English contents')
    expect(screen.getByRole('combobox', { name: '编辑器颜色主题' })).toHaveValue('app')
    expect(screen.getByRole('option', { name: '和app一致' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'VS Code Dark' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建文件' })).toBeInTheDocument()
    expect(languageLabel('notes.txt')).toBe('纯文本')
    expect(languageLabel('source.ts')).toBe('TypeScript')
    await user.click(screen.getByRole('button', { name: '关闭有未保存更改的 README.md' }))
    expect(screen.getByRole('alertdialog', { name: 'README.md 中有未保存的更改' })).toHaveTextContent('保存对 README.md 的更改？')
    await user.click(screen.getByRole('button', { name: '取消' }))
    act(() => setLocale('en'))
    expect(screen.getByRole('textbox', { name: 'Contents of README.md' })).toHaveValue('# Chat Agent Prompt\nunsaved English contents')
    expect(window.agentsDock.workspace.write).not.toHaveBeenCalled()
  })

  it('announces readiness only after all workspace-open listeners are mounted', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener')
    const onReady = vi.fn(() => {
      const registered = addEventListener.mock.calls.map(([type]) => type)
      expect(registered).toEqual(expect.arrayContaining([
        'agentsdock:open-workspace-file',
        'agentsdock:open-workspace-path',
        'agentsdock:open-agent-file'
      ]))
    })

    renderEditor('server-a:chat-a', 5, undefined, onReady)

    expect(onReady).toHaveBeenCalledOnce()
  })

  it('keeps Cmd+P available for chat switching and uses Cmd+O for focused file quick open', async () => {
    const user = userEvent.setup()
    renderEditor()

    expect(screen.getByRole('button', { name: /Chat.*pinned/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Chat timeline')).toBeVisible()

    fireEvent.keyDown(window, { key: 'p', metaKey: true })
    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    const editor = await screen.findByRole('textbox', { name: 'Contents of README.md' })
    editor.focus()
    fireEvent.keyDown(editor, { key: 'p', metaKey: true })

    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
    fireEvent.keyDown(editor, { key: 'o', metaKey: true })

    expect(screen.getByRole('dialog', { name: 'Open workspace file' })).toBeInTheDocument()
    const firstSearch = screen.getByPlaceholderText('Search workspace or paste a full path…')
    expect(firstSearch).toHaveFocus()
    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-a', '', 100))

    fireEvent.keyDown(firstSearch, { key: 'o', metaKey: true })
    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
    await waitFor(() => expect(editor).toHaveFocus())

    fireEvent.keyDown(editor, { key: 'o', metaKey: true })
    const secondSearch = screen.getByPlaceholderText('Search workspace or paste a full path…')
    expect(secondSearch).toHaveFocus()
    fireEvent.keyDown(secondSearch, { key: 'o', metaKey: true })
    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
    await waitFor(() => expect(editor).toHaveFocus())
  })

  it('dismisses an open root picker when chat switching takes ownership', async () => {
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    expect(await screen.findByPlaceholderText('Search workspace or paste a full path…')).toHaveFocus()

    let unhandled = true
    act(() => {
      unhandled = window.dispatchEvent(new Event('agentsdock:dismiss-workspace-file-picker'))
    })

    expect(unhandled).toBe(true)
    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
  })

  it('lets only the targeted WorkspaceEditor claim file quick-open requests and Cmd+O', async () => {
    const secondSession = { ...session, id: 'chat-b', title: 'Chat B' }
    render(<>
      <div data-testid="workspace-a"><WorkspaceEditor
        workspaceKey="server-a:chat-a"
        session={session}
        profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
        available
        capabilityVersion={5}
        chatContent={<p>Chat A timeline</p>}
      /></div>
      <div data-testid="workspace-b"><WorkspaceEditor
        workspaceKey="server-a:chat-b"
        session={secondSession}
        profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
        available
        capabilityVersion={5}
        chatContent={<p>Chat B timeline</p>}
      /></div>
    </>)
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-b', path: 'src/App.tsx' }
      }))
    })
    const workspaceA = screen.getByTestId('workspace-a')
    const workspaceB = screen.getByTestId('workspace-b')
    const editorB = await within(workspaceB).findByRole('textbox', { name: 'Contents of src/App.tsx' })
    editorB.focus()
    vi.mocked(window.agentsDock.workspace.search).mockClear()

    let unhandled = true
    act(() => {
      unhandled = window.dispatchEvent(new CustomEvent('agentsdock:quick-open-active-surface', { cancelable: true }))
    })

    expect(unhandled).toBe(false)
    expect(within(workspaceA).queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
    expect(within(workspaceB).getByRole('dialog', { name: 'Open workspace file' })).toBeVisible()
    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-b', '', 100))

    const searchB = within(workspaceB).getByPlaceholderText('Search workspace or paste a full path…')
    fireEvent.keyDown(searchB, { key: 'o', metaKey: true })
    expect(within(workspaceB).queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()

    editorB.focus()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    expect(within(workspaceA).queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
    const cmdOSearch = within(workspaceB).getByPlaceholderText('Search workspace or paste a full path…')
    expect(cmdOSearch).toHaveFocus()
    fireEvent.keyDown(cmdOSearch, { key: 'o', metaKey: true })
    expect(within(workspaceB).queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-file', {
        detail: { sessionId: 'chat-b' }
      }))
    })
    expect(within(workspaceA).queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
    expect(within(workspaceB).getByRole('dialog', { name: 'Open workspace file' })).toBeVisible()
  })

  it('keeps chat usable and persists local editor state when the server capability is unavailable', async () => {
    render(<WorkspaceEditor
      workspaceKey="server-a:chat-a"
      session={session}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available={false}
      unavailableMessage="Install a server with workspace file support."
      chatContent={<p>Chat timeline</p>}
    />)

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    expect(screen.getByRole('alert')).toHaveTextContent('Install a server with workspace file support.')
    expect(screen.getByText('Chat timeline')).toBeVisible()
    expect(window.agentsDock.workspace.search).not.toHaveBeenCalled()
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalled()
    await waitFor(() => expect(window.agentsDock.preferences.getScoped).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const promises: Promise<unknown>[] = []
    window.dispatchEvent(new CustomEvent('agentsdock:flush-draft', { detail: { promises } }))
    await act(async () => { await Promise.all(promises) })
    expect(window.agentsDock.preferences.setScoped).toHaveBeenCalledWith(
      expect.any(Object),
      'workspace-editor:chat-a',
      expect.objectContaining({ version: 5 })
    )
  })

  it('does not send an unchanged workspace draft through persistence twice', async () => {
    renderEditor()
    await waitFor(() => expect(window.agentsDock.preferences.getScoped).toHaveBeenCalledTimes(1))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const flush = async () => {
      const promises: Promise<unknown>[] = []
      window.dispatchEvent(new CustomEvent('agentsdock:flush-draft', {
        detail: { promises }
      }))
      await Promise.all(promises)
    }
    await act(flush)
    expect(window.agentsDock.preferences.setScoped).toHaveBeenCalledTimes(1)
    expect(window.agentsDock.preferences.setScoped).toHaveBeenCalledWith(
      expect.any(Object),
      'workspace-editor:chat-a',
      expect.objectContaining({ version: 5, filePresentation: 'full' })
    )

    await act(flush)
    expect(window.agentsDock.preferences.setScoped).toHaveBeenCalledTimes(1)
  })

  it('restores tab metadata but reads only the active file', async () => {
    vi.mocked(window.agentsDock.preferences.getScoped).mockResolvedValueOnce({
      version: 1,
      cwd: '/work/project',
      activePath: 'README.md',
      tabs: [
        { path: 'README.md', viewState: { anchor: 4, head: 4, scrollTop: 96, scrollLeft: 0 } },
        { path: 'src/App.tsx' },
        { path: 'src/other.ts' }
      ]
    })
    renderEditor()

    expect(await screen.findByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'App.tsx' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'other.ts' })).toBeInTheDocument()
    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledTimes(1))
    expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', 'README.md')
    expect(await screen.findByRole('textbox', { name: 'Contents of README.md' })).toHaveAttribute('data-editor-scroll-top', '96')
  })

  it('keeps a restored deleted tab discoverable and activates it without duplication', async () => {
    const user = userEvent.setup()
    const deletedPath = 'outputs/g1_thor_with_yam_v3.urdf'
    vi.mocked(window.agentsDock.preferences.getScoped).mockResolvedValueOnce({
      version: 5,
      cwd: '/work/project',
      activePath: 'README.md',
      secondaryPath: null,
      activeGroup: 'primary',
      filePresentation: 'full',
      tabs: [{ path: 'README.md' }, { path: deletedPath }]
    })
    vi.mocked(window.agentsDock.workspace.search).mockResolvedValue({
      root: '/work/project',
      query: 'g1_thor',
      entries: [],
      scanned: 0,
      truncated: false,
      limit: 100
    })
    vi.mocked(window.agentsDock.workspace.read).mockImplementation((_sessionId: string, path: string) => (
      path === deletedPath
        ? Promise.reject(new Error('The file no longer exists on disk.'))
        : Promise.resolve(workspaceFile(path))
    ))

    renderEditor()
    const readmeEditor = await screen.findByRole('textbox', { name: 'Contents of README.md' })
    expect(screen.getByRole('tab', { name: 'g1_thor_with_yam_v3.urdf' })).toBeInTheDocument()
    readmeEditor.focus()
    fireEvent.keyDown(readmeEditor, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    await user.type(search, 'g1_thor')
    await user.click(await screen.findByRole('option', { name: /g1_thor_with_yam_v3\.urdf.*Open tab/i }))

    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', deletedPath))
    expect(screen.getAllByRole('tab', { name: 'g1_thor_with_yam_v3.urdf' })).toHaveLength(1)
    expect(screen.getByRole('tab', { name: 'g1_thor_with_yam_v3.urdf' })).toHaveAttribute('aria-selected', 'true')
    expect((await screen.findAllByText('The file no longer exists on disk.')).some(element => element.offsetParent !== null || element.isConnected)).toBe(true)
  })

  it('finds a loaded Explorer match after more than 200 nonmatching entries', async () => {
    const manyEntries: WorkspaceEntry[] = [
      ...Array.from({ length: 225 }, (_, index) => ({
        name: `generated-${index}.log`,
        path: `outputs/generated-${index}.log`,
        kind: 'file' as const,
        writable: true
      })),
      { name: 'g1_thor_target.urdf', path: 'outputs/g1_thor_target.urdf', kind: 'file', writable: true }
    ]
    vi.mocked(window.agentsDock.workspace.entries).mockResolvedValue({
      root: '/work/project',
      path: '',
      entries: manyEntries,
      total: manyEntries.length,
      offset: 0,
      limit: 500,
      has_more: false
    })
    vi.mocked(window.agentsDock.workspace.search).mockResolvedValue({
      root: '/work/project',
      query: 'g1_thor',
      entries: [],
      scanned: 0,
      truncated: false,
      limit: 100
    })

    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'README.md' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of README.md' })
    expect(await screen.findByText('g1_thor_target.urdf')).toBeVisible()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    fireEvent.change(screen.getByPlaceholderText('Search workspace or paste a full path…'), {
      target: { value: 'g1_thor' }
    })

    expect(await screen.findByRole('option', { name: /outputs\/g1_thor_target\.urdf/i })).toBeVisible()
  })

  it('never evicts a current dirty untitled buffer when a full delayed restore resolves', async () => {
    const user = userEvent.setup()
    const persistedState = {
      version: 5 as const,
      cwd: '/work/project',
      activePath: 'restored/file-0.ts',
      secondaryPath: null,
      activeGroup: 'primary' as const,
      filePresentation: 'full' as const,
      tabs: Array.from({ length: 12 }, (_, index) => ({ path: `restored/file-${index}.ts` }))
    }
    const restoration = deferred<typeof persistedState>()
    vi.mocked(window.agentsDock.preferences.getScoped).mockReturnValueOnce(restoration.promise)
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    await user.click(screen.getByRole('button', { name: 'New file' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Contents of Untitled-1' }),
      'const mustSurvive = true'
    )

    await act(async () => {
      restoration.resolve(persistedState)
      await restoration.promise
    })

    expect(await screen.findByRole('tab', { name: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Contents of Untitled-1' })).toHaveValue('const mustSurvive = true')
    expect(screen.getByRole('button', { name: 'Close Untitled-1 with unsaved changes' })).toBeVisible()
    expect(screen.getAllByRole('tab')).toHaveLength(12)
    expect(screen.queryByRole('tab', { name: 'file-11.ts' })).not.toBeInTheDocument()
  })

  it('restores an attached artifact tab and its editor position', async () => {
    const file: AgentFile = {
      id: 'artifact-restored',
      filename: 'source-policy.yaml',
      content_type: 'application/yaml'
    }
    vi.mocked(window.agentsDock.preferences.getScoped).mockResolvedValueOnce({
      version: 1,
      cwd: '/work/project',
      activePath: '.agentsdock-artifacts/artifact-restored/source-policy.yaml',
      tabs: [{
        path: '.agentsdock-artifacts/artifact-restored/source-policy.yaml',
        artifact: file,
        viewState: { anchor: 3, head: 3, scrollTop: 72, scrollLeft: 0 }
      }]
    })
    renderEditor()

    await waitFor(() => expect(window.agentsDock.files.readText).toHaveBeenCalledWith('chat-a', file, expect.any(String)))
    expect(await screen.findByRole('tab', { name: 'source-policy.yaml' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Contents of source-policy.yaml' })).toHaveAttribute('data-editor-scroll-top', '72')
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalled()
  })

  it('opens a searched file in one tab and loads the workspace explorer lazily', async () => {
    const user = userEvent.setup()
    renderEditor()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    await user.type(search, 'app')
    const result = await screen.findByRole('option', { name: /src\/App.tsx/i })
    await user.click(result)

    expect(screen.getByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })).toHaveValue('export const app = true\n')
    await waitFor(() => expect(window.agentsDock.workspace.entries).toHaveBeenCalledWith('chat-a', '', 0, 500))
    expect(window.agentsDock.native.log).toHaveBeenCalledWith(
      'workspace-file',
      'read completed',
      expect.objectContaining({ sessionId: 'chat-a', path: 'src/App.tsx', size: 24, writable: true })
    )

    await user.click(screen.getByRole('button', { name: 'Open README.md' }))
    expect(screen.getByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tab', { name: 'README.md' })).toHaveLength(1)
  })

  it('reveals and expands a file parent in the explorer whenever the file opens', async () => {
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })

    const file = await screen.findByRole('button', { name: 'Open src/App.tsx' })
    expect(file).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'src' })).toHaveAttribute('aria-expanded', 'true')
    expect(window.agentsDock.workspace.entries).toHaveBeenCalledWith('chat-a', '', 0, 500)
    expect(window.agentsDock.workspace.entries).toHaveBeenCalledWith('chat-a', 'src', 0, 500)
  })

  it('reveals a file from the second large-directory page', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      name: `file-${String(index).padStart(3, '0')}.ts`,
      path: `file-${String(index).padStart(3, '0')}.ts`,
      kind: 'file' as const,
      revision: `entry-${index}`
    }))
    const target: WorkspaceEntry = {
      name: 'target.ts',
      path: 'target.ts',
      kind: 'file',
      revision: 'entry-target'
    }
    vi.mocked(window.agentsDock.workspace.entries).mockImplementation((_sessionId, path = '', offset = 0) => Promise.resolve({
      root: '/work/project',
      path,
      entries: path || offset > 500 ? [] : offset === 500 ? [target] : firstPage,
      total: path ? 0 : 10_000,
      offset,
      limit: 500,
      has_more: !path && offset < 9_500
    }))
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'target.ts' }
      }))
    })

    expect(await screen.findByRole('button', { name: 'Open target.ts' })).toHaveAttribute('aria-current', 'page')
    expect(window.agentsDock.workspace.entries).toHaveBeenCalledWith('chat-a', '', 500, 500)
  })

  it('bounds automatic reveal work in very large directories', async () => {
    const page = (offset: number) => Array.from({ length: 500 }, (_, index) => ({
      name: `file-${offset + index}.ts`,
      path: `file-${offset + index}.ts`,
      kind: 'file' as const,
      revision: `entry-${offset + index}`
    }))
    vi.mocked(window.agentsDock.workspace.entries).mockImplementation((_sessionId, path = '', offset = 0) => Promise.resolve({
      root: '/work/project',
      path,
      entries: path ? [] : page(offset),
      total: path ? 0 : 10_000,
      offset,
      limit: 500,
      has_more: !path && offset < 9_500
    }))
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'not-in-first-thousand.ts' }
      }))
    })

    await waitFor(() => expect(window.agentsDock.workspace.entries).toHaveBeenCalledWith('chat-a', '', 500, 500))
    const offsets = vi.mocked(window.agentsDock.workspace.entries).mock.calls
      .filter(([, path]) => (path ?? '') === '')
      .map(([, , offset]) => offset ?? 0)
    expect(Math.max(...offsets)).toBe(500)
    await waitFor(() => expect(window.agentsDock.native.log).toHaveBeenCalledWith(
      'workspace-file',
      'tree reveal page budget reached',
      expect.objectContaining({
        path: 'not-in-first-thousand.ts',
        loaded: 1_000,
        total: 10_000,
        limit: 1
      })
    ))
  })

  it('bounds automatic reveal depth', async () => {
    const parts = Array.from({ length: 40 }, (_, index) => `d${index}`)
    const deepPath = `${parts.join('/')}/target.ts`
    vi.mocked(window.agentsDock.workspace.entries).mockImplementation((_sessionId, path = '', offset = 0) => {
      const depth = path ? path.split('/').length : 0
      const name = parts[depth]
      const entryPath = [...parts.slice(0, depth), name].join('/')
      return Promise.resolve({
        root: '/work/project',
        path,
        entries: name ? [{ name, path: entryPath, kind: 'directory' as const, revision: `entry-${depth}` }] : [],
        total: name ? 1 : 0,
        offset,
        limit: 500,
        has_more: false
      })
    })
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: deepPath }
      }))
    })

    await waitFor(() => expect(window.agentsDock.native.log).toHaveBeenCalledWith(
      'workspace-file',
      'tree reveal depth budget reached',
      expect.objectContaining({ path: deepPath, steps: 41, limit: 32 })
    ))
    const requestedDirectories = new Set(
      vi.mocked(window.agentsDock.workspace.entries).mock.calls.map(([, path]) => path ?? '')
    )
    expect(vi.mocked(window.agentsDock.workspace.entries).mock.calls.length).toBeLessThanOrEqual(9)
    expect(requestedDirectories.size).toBeLessThanOrEqual(9)
    expect(window.agentsDock.native.log).toHaveBeenCalledWith(
      'workspace-file',
      'tree reveal request budget reached',
      expect.objectContaining({ path: deepPath, limit: 8 })
    )
  })

  it('copies absolute and workspace-relative paths from the explorer context menu', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    const file = await screen.findByRole('button', { name: 'Open src/App.tsx' })

    fireEvent.contextMenu(file)
    await user.click(await screen.findByRole('menuitem', { name: 'Copy Path' }))
    expect(window.agentsDock.native.writeClipboard).toHaveBeenCalledWith('/work/project/src/App.tsx')

    fireEvent.contextMenu(file)
    await user.click(await screen.findByRole('menuitem', { name: 'Copy Relative Path' }))
    expect(window.agentsDock.native.writeClipboard).toHaveBeenCalledWith('src/App.tsx')
  })

  it('downloads workspace files from the explorer context menu without offering it for folders', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    const file = await screen.findByRole('button', { name: 'Open src/App.tsx' })

    fireEvent.contextMenu(file)
    await user.click(await screen.findByRole('menuitem', { name: 'Download…' }))
    expect(window.agentsDock.workspace.download).toHaveBeenCalledWith('chat-a', 'src/App.tsx')

    const folder = screen.getByRole('button', { name: 'src' })
    fireEvent.contextMenu(folder)
    expect(screen.queryByRole('menuitem', { name: 'Download…' })).not.toBeInTheDocument()
  })

  it('keeps the explorer usable and surfaces a failed workspace download', async () => {
    const user = userEvent.setup()
    vi.mocked(window.agentsDock.workspace.download).mockRejectedValueOnce(new Error('Download connection failed.'))
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    const file = await screen.findByRole('button', { name: 'Open src/App.tsx' })

    fireEvent.contextMenu(file)
    await user.click(await screen.findByRole('menuitem', { name: 'Download…' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Download connection failed.')
    expect(screen.getByRole('button', { name: 'Open src/App.tsx' })).toBeEnabled()
  })

  it('opens an editable untitled buffer and asks for its path only on first save', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })

    await user.click(screen.getByRole('button', { name: 'New file' }))
    const editor = screen.getByRole('textbox', { name: 'Contents of Untitled-1' })
    expect(screen.getByRole('tab', { name: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true')
    expect(editor).not.toHaveAttribute('readonly')
    expect(window.agentsDock.workspace.create).not.toHaveBeenCalled()

    await user.type(editor, 'export const note = true')
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    const saveDialog = await screen.findByRole('dialog', { name: 'Save Untitled-1' })
    const name = screen.getByLabelText('File name')
    await user.clear(name)
    await user.type(name, 'notes.ts')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(saveDialog).not.toBeInTheDocument()
    await waitFor(() => expect(window.agentsDock.workspace.create).toHaveBeenCalledWith(
      'chat-a',
      'notes.ts',
      'file'
    ))
    expect(window.agentsDock.workspace.write).toHaveBeenCalledWith(
      'chat-a',
      'notes.ts',
      'export const note = true',
      'rev-notes.ts'
    )
    expect(await screen.findByRole('tab', { name: 'notes.ts' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Contents of notes.ts' })).toHaveValue('export const note = true')
  })

  it('reserves the Save As destination against mutations through both create and write', async () => {
    const user = userEvent.setup()
    const creation = deferred<WorkspaceCreateResult>()
    const writing = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.create).mockReturnValueOnce(creation.promise)
    vi.mocked(window.agentsDock.workspace.write).mockReturnValueOnce(writing.promise)
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    const folder = await screen.findByRole('button', { name: 'src' })
    fireEvent.contextMenu(folder)
    await user.click(await screen.findByRole('menuitem', { name: 'New File' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Contents of Untitled-1' }),
      'const reserved = true'
    )
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    const name = await screen.findByLabelText('File name')
    await user.clear(name)
    await user.type(name, 'reserved.ts')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(window.agentsDock.workspace.create).toHaveBeenCalledWith(
      'chat-a',
      'src/reserved.ts',
      'file'
    ))
    const newFile = screen.getByRole('button', { name: 'New file' })
    const newFolder = screen.getByRole('button', { name: 'New folder' })
    expect(newFile).toBeDisabled()
    expect(newFolder).toBeDisabled()
    fireEvent.click(newFolder)
    expect(window.agentsDock.workspace.create).toHaveBeenCalledTimes(1)

    await act(async () => {
      creation.resolve({
        root: '/work/project',
        entry: {
          name: 'reserved.ts',
          path: 'src/reserved.ts',
          kind: 'file',
          writable: true,
          revision: 'entry-reserved.ts'
        },
        file: workspaceFile('src/reserved.ts', '', 'rev-reserved.ts')
      })
      await creation.promise
    })
    await waitFor(() => expect(window.agentsDock.workspace.write).toHaveBeenCalledWith(
      'chat-a',
      'src/reserved.ts',
      'const reserved = true',
      'rev-reserved.ts'
    ))
    expect(newFile).toBeDisabled()
    expect(newFolder).toBeDisabled()
    fireEvent.click(newFolder)
    expect(window.agentsDock.workspace.create).toHaveBeenCalledTimes(1)

    await act(async () => {
      writing.resolve(workspaceFile('src/reserved.ts', 'const reserved = true', 'rev-2'))
      await writing.promise
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save Untitled-1' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'New file' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'New folder' })).toBeEnabled()
  })

  it('persists and restores untitled drafts, names, directories, and dirty state across an app relaunch', async () => {
    const user = userEvent.setup()
    const first = renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    const folder = await screen.findByRole('button', { name: 'src' })
    fireEvent.contextMenu(folder)
    await user.click(await screen.findByRole('menuitem', { name: 'New File' }))
    const editor = screen.getByRole('textbox', { name: 'Contents of Untitled-1' })
    await user.type(editor, 'export const restored = true')
    first.rerender(<WorkspaceEditor
      workspaceKey="server-a:chat-a"
      session={session}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available={false}
      unavailableMessage="Server unavailable."
      capabilityVersion={4}
      chatContent={<p>Chat timeline</p>}
    />)
    await user.type(editor, '\n// edited offline')

    const promises: Promise<unknown>[] = []
    window.dispatchEvent(new CustomEvent('agentsdock:flush-draft', { detail: { promises } }))
    await act(async () => { await Promise.all(promises) })
    const persisted = vi.mocked(window.agentsDock.preferences.setScoped).mock.calls.at(-1)?.[2]
    expect(persisted).toEqual(expect.objectContaining({
      version: 5,
      activePath: expect.stringMatching(/^untitled:\/\//),
      tabs: expect.arrayContaining([
        expect.objectContaining({
          untitled: true,
          name: 'Untitled-1',
          saveDirectory: 'src',
          draft: 'export const restored = true\n// edited offline',
          dirty: true
        })
      ])
    }))

    first.unmount()
    resetWorkspaceEditorMemoryForTests()
    vi.mocked(window.agentsDock.preferences.getScoped).mockResolvedValueOnce(persisted)
    render(<WorkspaceEditor
      workspaceKey="server-a:chat-a-relaunched"
      session={session}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available={false}
      unavailableMessage="Server unavailable."
      capabilityVersion={4}
      chatContent={<p>Chat timeline</p>}
    />)

    expect(await screen.findByRole('tab', { name: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Contents of Untitled-1' })).toHaveValue('export const restored = true\n// edited offline')
    expect(screen.getByRole('button', { name: 'Close Untitled-1 with unsaved changes' })).toBeVisible()
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(await screen.findByRole('dialog', { name: 'Save Untitled-1' })).toHaveTextContent('project / src')
    expect(window.agentsDock.workspace.create).not.toHaveBeenCalled()
  })

  it('re-checks file-creation authority when an open Save As dialog is submitted', async () => {
    const user = userEvent.setup()
    const view = render(<WorkspaceEditor
      workspaceKey="server-a:chat-a"
      session={session}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available
      capabilityVersion={4}
      chatContent={<p>Chat timeline</p>}
    />)
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    await user.click(screen.getByRole('button', { name: 'New file' }))
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    const name = await screen.findByLabelText('File name')
    await user.clear(name)
    await user.type(name, 'blocked.ts')

    view.rerender(<WorkspaceEditor
      workspaceKey="server-a:chat-a"
      session={{ ...session, archived: true }}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available
      capabilityVersion={4}
      chatContent={<p>Chat timeline</p>}
    />)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Archived chats are read-only.'
    )
    expect(window.agentsDock.workspace.create).not.toHaveBeenCalled()
    expect(window.agentsDock.workspace.write).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Contents of Untitled-1' })).toBeInTheDocument()
  })

  it('removes an exact empty orphan and preserves the untitled draft when its first write fails', async () => {
    const user = userEvent.setup()
    vi.mocked(window.agentsDock.workspace.write).mockRejectedValueOnce(new Error('Write transport failed.'))
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    await user.click(screen.getByRole('button', { name: 'New file' }))
    const editor = screen.getByRole('textbox', { name: 'Contents of Untitled-1' })
    await user.type(editor, 'const preserved = true')
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    const name = await screen.findByLabelText('File name')
    await user.clear(name)
    await user.type(name, 'orphan.ts')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(window.agentsDock.workspace.remove).toHaveBeenCalledWith(
      'chat-a',
      'orphan.ts',
      'entry-orphan.ts',
      false
    ))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The empty file created at orphan.ts was removed. Your untitled draft is preserved; retry Save.'
    )
    expect(screen.getByRole('textbox', { name: 'Contents of Untitled-1' })).toHaveValue('const preserved = true')
    expect(screen.queryByRole('tab', { name: 'orphan.ts' })).not.toBeInTheDocument()
  })

  it('re-checks authority before the first write and removes the just-created empty file if authority changes', async () => {
    const user = userEvent.setup()
    const creation = deferred<WorkspaceCreateResult>()
    vi.mocked(window.agentsDock.workspace.create).mockReturnValueOnce(creation.promise)
    const view = render(<WorkspaceEditor
      workspaceKey="server-a:chat-a"
      session={session}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available
      capabilityVersion={4}
      chatContent={<p>Chat timeline</p>}
    />)
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    await user.click(screen.getByRole('button', { name: 'New file' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Contents of Untitled-1' }),
      'const preserved = true'
    )
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    const name = await screen.findByLabelText('File name')
    await user.clear(name)
    await user.type(name, 'authority-changed.ts')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(window.agentsDock.workspace.create).toHaveBeenCalled())

    view.rerender(<WorkspaceEditor
      workspaceKey="server-a:chat-a"
      session={session}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available
      capabilityVersion={3}
      chatContent={<p>Chat timeline</p>}
    />)
    await act(async () => {
      creation.resolve({
        root: '/work/project',
        entry: {
          name: 'authority-changed.ts',
          path: 'authority-changed.ts',
          kind: 'file',
          writable: true,
          revision: 'entry-authority-changed.ts'
        },
        file: workspaceFile('authority-changed.ts', '', 'rev-authority-changed.ts')
      })
      await creation.promise
    })

    await waitFor(() => expect(window.agentsDock.workspace.remove).toHaveBeenCalledWith(
      'chat-a',
      'authority-changed.ts',
      'entry-authority-changed.ts',
      false
    ))
    expect(window.agentsDock.workspace.write).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Update AgentsServer to create workspace files and folders. The empty file created at authority-changed.ts was removed.'
    )
    expect(screen.getByRole('textbox', { name: 'Contents of Untitled-1' })).toHaveValue('const preserved = true')
  })

  it('surfaces an orphan warning and offers Replace on retry when cleanup cannot be confirmed', async () => {
    const user = userEvent.setup()
    vi.mocked(window.agentsDock.workspace.write).mockRejectedValueOnce(new Error('Write transport failed.'))
    vi.mocked(window.agentsDock.workspace.remove).mockRejectedValueOnce(new Error('Revision changed.'))
    vi.mocked(window.agentsDock.workspace.create)
      .mockResolvedValueOnce({
        root: '/work/project',
        entry: {
          name: 'orphan.ts',
          path: 'orphan.ts',
          kind: 'file',
          writable: true,
          revision: 'entry-orphan.ts'
        },
        file: workspaceFile('orphan.ts', '', 'rev-orphan.ts')
      })
      .mockRejectedValueOnce(new Error('That name already exists.'))
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    await user.click(screen.getByRole('button', { name: 'New file' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Contents of Untitled-1' }),
      'const preserved = true'
    )
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    const name = await screen.findByLabelText('File name')
    await user.clear(name)
    await user.type(name, 'orphan.ts')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'cleanup failed (Revision changed.). Your untitled draft is preserved.'
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('button', { name: 'Replace' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'orphan.ts already exists. Choose Replace to overwrite it.'
    )
    expect(screen.getByRole('textbox', { name: 'Contents of Untitled-1' })).toHaveValue('const preserved = true')
  })

  it('creates folders inside the right-clicked folder and keeps failed names editable', async () => {
    const user = userEvent.setup()
    vi.mocked(window.agentsDock.workspace.create).mockRejectedValueOnce(new Error('That name already exists.'))
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    const folder = await screen.findByRole('button', { name: 'src' })

    fireEvent.contextMenu(folder)
    await user.click(await screen.findByRole('menuitem', { name: 'New Folder' }))
    const name = screen.getByRole('textbox', { name: 'New folder name' })
    await user.type(name, 'components{Enter}')

    await waitFor(() => expect(window.agentsDock.workspace.create).toHaveBeenCalledWith(
      'chat-a',
      'src/components',
      'directory'
    ))
    expect(name).toHaveValue('components')
    expect(screen.getByText('That name already exists.')).toBeVisible()

    fireEvent.keyDown(name, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'New folder name' })).not.toBeInTheDocument()
  })

  it('uses a right-clicked explorer folder as the first-save directory', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    const folder = await screen.findByRole('button', { name: 'src' })

    fireEvent.contextMenu(folder)
    await user.click(await screen.findByRole('menuitem', { name: 'New File' }))
    expect(screen.getByRole('textbox', { name: 'Contents of Untitled-1' })).toBeVisible()
    expect(window.agentsDock.workspace.create).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(await screen.findByRole('dialog', { name: 'Save Untitled-1' })).toHaveTextContent(
      'project / src'
    )
    const name = screen.getByLabelText('File name')
    await user.clear(name)
    await user.type(name, 'new-helper.ts')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(window.agentsDock.workspace.create).toHaveBeenCalledWith(
      'chat-a',
      'src/new-helper.ts',
      'file'
    ))
  })

  it('dismisses Save As with Escape without creating or closing the untitled buffer', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    await user.click(screen.getByRole('button', { name: 'New file' }))

    fireEvent.keyDown(window, { key: 's', metaKey: true })
    const name = await screen.findByLabelText('File name')
    expect(name).toHaveFocus()
    fireEvent.keyDown(name, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Save Untitled-1' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Untitled-1' })).toBeInTheDocument()
    expect(window.agentsDock.workspace.create).not.toHaveBeenCalled()
  })

  it('expands and loads every ancestor before creating beside a deeply nested active file', async () => {
    const user = userEvent.setup()
    const nestedEntries: Record<string, WorkspaceEntry[]> = {
      '': [{ name: 'deep', path: 'deep', kind: 'directory', revision: 'deep-rev' }],
      deep: [{ name: 'nested', path: 'deep/nested', kind: 'directory', revision: 'nested-rev' }],
      'deep/nested': [{ name: 'src', path: 'deep/nested/src', kind: 'directory', revision: 'src-rev' }],
      'deep/nested/src': [{ name: 'App.tsx', path: 'deep/nested/src/App.tsx', kind: 'file', revision: 'app-rev', writable: true }]
    }
    vi.mocked(window.agentsDock.workspace.entries).mockImplementation((_sessionId, path = '', offset = 0) => Promise.resolve({
      root: '/work/project',
      path,
      entries: nestedEntries[path] ?? [],
      total: nestedEntries[path]?.length ?? 0,
      offset,
      limit: 500,
      has_more: false
    }))
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'deep/nested/src/App.tsx' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of deep/nested/src/App.tsx' })

    const create = new Event('agentsdock:new-active-surface', { cancelable: true })
    act(() => { window.dispatchEvent(create) })

    expect(create.defaultPrevented).toBe(true)
    expect(await screen.findByRole('textbox', { name: 'Contents of Untitled-1' })).toBeVisible()
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(await screen.findByRole('dialog', { name: 'Save Untitled-1' })).toHaveTextContent(
      'project / deep/nested/src'
    )
    const name = screen.getByLabelText('File name')
    fireEvent.change(name, { target: { value: 'draft.ts' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(new Set(
      vi.mocked(window.agentsDock.workspace.entries).mock.calls.map(([, path]) => path ?? '')
    )).toEqual(new Set(['', 'deep', 'deep/nested', 'deep/nested/src'])))
  })

  it('reloads a partial directory after creation so later pages keep their server offset', async () => {
    const user = userEvent.setup()
    const serverEntries = Array.from({ length: 501 }, (_, index): WorkspaceEntry => ({
      name: `file-${String(index).padStart(3, '0')}.ts`,
      path: `file-${String(index).padStart(3, '0')}.ts`,
      kind: 'file',
      revision: `entry-${index}`,
      writable: true
    }))
    let created = false
    vi.mocked(window.agentsDock.workspace.entries).mockImplementation((_sessionId, path = '', offset = 0) => {
      const current = created
        ? [...serverEntries, { name: 'zz-new.ts', path: 'zz-new.ts', kind: 'file' as const, revision: 'entry-new', writable: true }]
        : serverEntries
      return Promise.resolve({
        root: '/work/project',
        path,
        entries: path ? [] : current.slice(offset, offset + 500),
        total: path ? 0 : current.length,
        offset,
        limit: 500,
        has_more: !path && offset + 500 < current.length
      })
    })
    vi.mocked(window.agentsDock.workspace.create).mockImplementationOnce(async () => {
      created = true
      return {
        root: '/work/project',
        entry: { name: 'zz-new.ts', path: 'zz-new.ts', kind: 'file', revision: 'entry-new', writable: true },
        file: workspaceFile('zz-new.ts', '', 'rev-new')
      }
    })
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'file-000.ts' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of file-000.ts' })

    await user.click(screen.getByRole('button', { name: 'New file' }))
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    const name = await screen.findByLabelText('File name')
    fireEvent.change(name, { target: { value: 'zz-new.ts' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(
      vi.mocked(window.agentsDock.workspace.entries).mock.calls
        .map(([, path, offset]) => ({ path: path ?? '', offset: offset ?? 0 }))
    ).toContainEqual({ path: '', offset: 500 }))
    expect(
      vi.mocked(window.agentsDock.workspace.entries).mock.calls
        .filter(([, path]) => (path ?? '') === '')
        .map(([, , offset]) => offset ?? 0)
    ).not.toContain(501)
  }, 15_000)

  it('routes New to the focused file surface but leaves split-view chat focus for New Chat', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })

    const fullFileNew = new Event('agentsdock:new-active-surface', { cancelable: true })
    act(() => { window.dispatchEvent(fullFileNew) })
    expect(fullFileNew.defaultPrevented).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Contents of Untitled-1' })).toBeVisible()
    const repeatedNew = new Event('agentsdock:new-active-surface', { cancelable: true })
    act(() => { window.dispatchEvent(repeatedNew) })
    expect(repeatedNew.defaultPrevented).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Contents of Untitled-2' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Restore chat split view' }))
    const chatTab = screen.getByRole('button', { name: /Chat.*pinned/i })
    chatTab.focus()
    const chatFocusedNew = new Event('agentsdock:new-active-surface', { cancelable: true })
    act(() => { window.dispatchEvent(chatFocusedNew) })
    expect(chatFocusedNew.defaultPrevented).toBe(false)

    const fileTab = screen.getByRole('tab', { name: 'App.tsx' })
    fileTab.focus()
    const tabFocusedNew = new Event('agentsdock:new-active-surface', { cancelable: true })
    act(() => { window.dispatchEvent(tabFocusedNew) })
    expect(tabFocusedNew.defaultPrevented).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Contents of Untitled-3' })).toBeVisible()

    screen.getByRole('textbox', { name: 'Contents of Untitled-3' }).focus()
    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    const modalNew = new Event('agentsdock:new-active-surface', { cancelable: true })
    act(() => { window.dispatchEvent(modalNew) })
    expect(modalNew.defaultPrevented).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Contents of Untitled-4' })).not.toBeInTheDocument()
    modal.remove()

    const editorFocusedNew = new Event('agentsdock:new-active-surface', { cancelable: true })
    act(() => { window.dispatchEvent(editorFocusedNew) })
    expect(editorFocusedNew.defaultPrevented).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Contents of Untitled-4' })).toBeInTheDocument()
  })

  it('consumes New in a full-file view and explains when the server cannot create files', async () => {
    render(<WorkspaceEditor
      workspaceKey="server-a:chat-a"
      session={session}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available
      capabilityVersion={3}
      chatContent={<p>Chat timeline</p>}
    />)
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })

    const create = new Event('agentsdock:new-active-surface', { cancelable: true })
    act(() => { window.dispatchEvent(create) })

    expect(create.defaultPrevented).toBe(true)
    expect(screen.getByRole('alert')).toHaveTextContent('Update AgentsServer to create workspace files and folders.')
    expect(window.agentsDock.workspace.create).not.toHaveBeenCalled()
  })

  it('renames an open file from the explorer without losing its tab', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    const file = await screen.findByRole('button', { name: 'Open src/App.tsx' })

    fireEvent.contextMenu(file)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename…' }))
    const input = screen.getByLabelText('New name')
    fireEvent.change(input, { target: { value: 'Application.tsx' } })
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(window.agentsDock.workspace.rename).toHaveBeenCalledWith(
      'chat-a',
      'src/App.tsx',
      'Application.tsx',
      'entry-app'
    ))
    expect(await screen.findByRole('tab', { name: 'Application.tsx' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Contents of src/Application.tsx' })).toHaveValue('export const app = true\n')
  })

  it('confirms permanent file deletion and closes the deleted tab', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    const file = await screen.findByRole('button', { name: 'Open src/App.tsx' })

    fireEvent.contextMenu(file)
    await user.click(await screen.findByRole('menuitem', { name: 'Delete Permanently…' }))
    expect(screen.getByRole('alertdialog', { name: 'Delete App.tsx' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => expect(window.agentsDock.workspace.remove).toHaveBeenCalledWith(
      'chat-a',
      'src/App.tsx',
      'entry-app',
      false
    ))
    expect(screen.queryByRole('tab', { name: 'App.tsx' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Chat.*pinned/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('uses recursive deletion for folders after an explicit confirmation', async () => {
    const user = userEvent.setup()
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    const folder = await screen.findByRole('button', { name: 'src' })

    fireEvent.contextMenu(folder)
    await user.click(await screen.findByRole('menuitem', { name: 'Delete Permanently…' }))
    expect(screen.getByText(/folder and everything inside it/i)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => expect(window.agentsDock.workspace.remove).toHaveBeenCalledWith(
      'chat-a',
      'src',
      'entry-src',
      true
    ))
    expect(screen.queryByRole('tab', { name: 'App.tsx' })).not.toBeInTheDocument()
  })

  it('opens an agent-sent workspace path directly in the editor', async () => {
    renderEditor()

    window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
      detail: { sessionId: 'another-chat', path: 'secrets.txt' }
    }))
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalled()

    window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
      detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
    }))

    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', 'src/App.tsx'))
    expect(await screen.findByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByPlaceholderText('Search workspace or paste a full path…')).not.toBeInTheDocument()
  })

  it('resolves an inline basename reference and opens the editor at its line', async () => {
    vi.mocked(window.agentsDock.workspace.read).mockRejectedValueOnce(new Error('workspace_file_not_found'))
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: {
          sessionId: 'chat-a',
          path: 'App.tsx',
          line: 2,
          column: 4,
          resolve: true
        }
      }))
    })

    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-a', 'App.tsx', 100))
    expect(await screen.findByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Contents of src/App.tsx' })).toHaveAttribute('data-editor-navigation-line', '2')
    expect(screen.getByRole('textbox', { name: 'Contents of src/App.tsx' })).toHaveAttribute('data-editor-navigation-column', '4')
  })

  it('asks the user to choose when a basename reference is ambiguous', async () => {
    const user = userEvent.setup()
    const matches: WorkspaceEntry[] = [
      { name: 'launcher.py', path: 'cli/launcher.py', kind: 'file', size: 10, writable: true },
      { name: 'launcher.py', path: 'train/launcher.py', kind: 'file', size: 10, writable: true }
    ]
    vi.mocked(window.agentsDock.workspace.search).mockResolvedValue({
      root: '/work/project',
      query: 'launcher.py',
      entries: matches,
      scanned: 2,
      truncated: false,
      limit: 100
    })
    vi.mocked(window.agentsDock.workspace.read).mockRejectedValueOnce(new Error('workspace_file_not_found'))
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'launcher.py', line: 72, resolve: true }
      }))
    })

    expect(await screen.findByRole('dialog', { name: 'Open workspace file' })).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: /cli\/launcher.py/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /train\/launcher.py/i })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Multiple workspace files match launcher.py')
    expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', 'launcher.py')

    await user.click(screen.getByRole('option', { name: /cli\/launcher.py/i }))
    expect(await screen.findByRole('tab', { name: 'launcher.py' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Contents of cli/launcher.py' })).toHaveAttribute('data-editor-navigation-line', '72')
  })

  it('opens an exact relative code reference before search so ignored files remain addressable', async () => {
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: {
          sessionId: 'chat-a',
          path: 'generated/private_tool.py',
          line: 14,
          resolve: true
        }
      }))
    })

    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', 'generated/private_tool.py'))
    expect(window.agentsDock.workspace.search).not.toHaveBeenCalledWith('chat-a', 'generated/private_tool.py', 100)
    expect(await screen.findByRole('tab', { name: 'private_tool.py' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Contents of generated/private_tool.py' })).toHaveAttribute('data-editor-navigation-line', '14')
  })

  it('keeps the newest location when the same referenced file is clicked while it is loading', async () => {
    const pendingRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read).mockImplementationOnce(() => pendingRead.promise)
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx', line: 2, resolve: true }
      }))
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx', line: 19, resolve: true }
      }))
    })
    await act(async () => {
      pendingRead.resolve(workspaceFile('src/App.tsx', Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n')))
      await pendingRead.promise
    })

    expect(await screen.findByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Contents of src/App.tsx' })).toHaveAttribute('data-editor-navigation-line', '19')
  })

  it('continues basename resolution after duplicate clicks share a failed exact-path read', async () => {
    const pendingRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read).mockImplementationOnce(() => pendingRead.promise)
    vi.mocked(window.agentsDock.workspace.search).mockResolvedValue({
      root: '/work/project',
      query: 'launcher.py',
      entries: [{
        name: 'launcher.py',
        path: 'cli/launcher.py',
        kind: 'file',
        size: 10,
        writable: true
      }],
      scanned: 1,
      truncated: false,
      limit: 100
    })
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'launcher.py', line: 72, resolve: true }
      }))
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'launcher.py', line: 91, resolve: true }
      }))
    })
    await act(async () => {
      pendingRead.reject(new Error('workspace_file_not_found'))
      try {
        await pendingRead.promise
      } catch {
        // The shared exact-path read is expected to fail before search fallback.
      }
    })

    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-a', 'launcher.py', 100))
    expect(await screen.findByRole('tab', { name: 'launcher.py' })).toHaveAttribute('aria-selected', 'true')
    expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', 'cli/launcher.py')
    expect(screen.getByRole('textbox', { name: 'Contents of cli/launcher.py' })).toHaveAttribute('data-editor-navigation-line', '91')
  })

  it('does not let a stale reference search replace a newer direct file open', async () => {
    const pendingSearch = deferred<{
      root: string
      query: string
      entries: WorkspaceEntry[]
      scanned: number
      truncated: boolean
      limit: number
    }>()
    vi.mocked(window.agentsDock.workspace.read).mockRejectedValueOnce(new Error('workspace_file_not_found'))
    vi.mocked(window.agentsDock.workspace.search).mockImplementationOnce(() => pendingSearch.promise)
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'policy_runner.py', line: 167, resolve: true }
      }))
    })
    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-a', 'policy_runner.py', 100))

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    expect(await screen.findByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')

    await act(async () => {
      pendingSearch.resolve({
        root: '/work/project',
        query: 'policy_runner.py',
        entries: [{
          name: 'policy_runner.py',
          path: 'robot/control/atlas_vla/policy_runner.py',
          kind: 'file',
          size: 10,
          writable: true
        }],
        scanned: 1,
        truncated: false,
        limit: 100
      })
      await pendingSearch.promise
    })

    expect(screen.getByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalledWith(
      'chat-a',
      'robot/control/atlas_vla/policy_runner.py'
    )
  })

  it('rejects an absolute code reference outside the chat workspace', () => {
    renderEditor('server-a:chat-a', 4)

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: {
          sessionId: 'chat-a',
          path: '/another/project/secrets.py',
          line: 8,
          resolve: true
        }
      }))
    })

    expect(screen.getByRole('alert')).toHaveTextContent('Update AgentsServer to open explicit absolute paths outside the workspace.')
    expect(window.agentsDock.workspace.search).not.toHaveBeenCalled()
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalled()
  })

  it('keeps a late workspace alert visible and dismissible inside the open-file palette', async () => {
    const user = userEvent.setup()
    renderEditor('server-a:chat-a', 4)

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    const dialog = screen.getByRole('dialog', { name: 'Open workspace file' })

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: {
          sessionId: 'chat-a',
          path: '/another/project/secrets.py',
          resolve: true
        }
      }))
    })

    const alert = screen.getByRole('alert')
    expect(dialog).toContainElement(alert)
    expect(screen.getByPlaceholderText('Search workspace or paste a full path…')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close file picker' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Dismiss workspace error' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(dialog).toBeVisible()
  })

  it('prefers an agent file live in the workspace and falls back to its attached snapshot', async () => {
    const file: AgentFile = {
      id: 'workspace-artifact-1',
      filename: 'App.tsx',
      source_path: '/work/project/src/App.tsx',
      content_type: 'text/typescript'
    }
    const view = renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
        detail: { sessionId: 'chat-a', file }
      }))
    })

    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', 'src/App.tsx'))
    expect(await screen.findByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
    expect(window.agentsDock.files.readText).not.toHaveBeenCalled()

    view.unmount()
    resetWorkspaceEditorMemoryForTests()
    vi.mocked(window.agentsDock.workspace.read).mockRejectedValueOnce(new Error('Workspace file not found'))
    renderEditor('server-a:chat-a:fallback')
    window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
      detail: { sessionId: 'chat-a', file }
    }))

    await waitFor(() => expect(window.agentsDock.files.readText).toHaveBeenCalledWith('chat-a', file, expect.any(String)))
    expect(await screen.findByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Attached snapshot')).toBeInTheDocument()
  })

  it('opens and deduplicates an agent text artifact in a read-only editor tab', async () => {
    const file: AgentFile = {
      id: 'artifact-1',
      filename: 'migration-audit.md',
      source_path: '/Users/dev/.agentsdock/files/artifact-1/migration-audit.md',
      content_type: 'text/markdown'
    }
    renderEditor()

    window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
      detail: { sessionId: 'another-chat', file }
    }))
    expect(window.agentsDock.files.readText).not.toHaveBeenCalled()

    window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
      detail: { sessionId: 'chat-a', file }
    }))

    await waitFor(() => expect(window.agentsDock.files.readText).toHaveBeenCalledWith('chat-a', file, expect.any(String)))
    expect(await screen.findByRole('tab', { name: 'migration-audit.md' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Contents of migration-audit.md' })).toHaveValue('# Migration audit\n')
    expect(screen.getByRole('textbox', { name: 'Contents of migration-audit.md' })).toHaveAttribute('readonly')
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalled()
    await waitFor(() => expect(window.agentsDock.workspace.entries).toHaveBeenCalledWith(
      'chat-a',
      '',
      0,
      500
    ))
    expect(screen.queryByText('Loading files')).not.toBeInTheDocument()

    window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
      detail: { sessionId: 'chat-a', file }
    }))
    await waitFor(() => expect(screen.getAllByRole('tab', { name: 'migration-audit.md' })).toHaveLength(1))
    expect(window.agentsDock.files.readText).toHaveBeenCalledTimes(1)
  })

  it('refuses an artifact explicitly owned by another chat', async () => {
    const foreign: AgentFile = {
      id: 'parent-artifact',
      session_id: 'parent-chat',
      filename: 'parent-output.md',
      content_type: 'text/markdown'
    }
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
        detail: { sessionId: 'chat-a', file: foreign }
      }))
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('That file belongs to a different chat.')
    expect(window.agentsDock.files.readText).not.toHaveBeenCalled()
    expect(screen.queryByRole('tab', { name: 'parent-output.md' })).not.toBeInTheDocument()
  })

  it('shows an attached-file tab immediately while its content is downloading', async () => {
    const file: AgentFile = {
      id: 'artifact-slow',
      filename: 'production-workflow.md',
      content_type: 'text/markdown'
    }
    const read = deferred<AgentTextFile>()
    vi.mocked(window.agentsDock.files.readText).mockReturnValueOnce(read.promise)
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
        detail: { sessionId: 'chat-a', file }
      }))
    })

    expect(screen.getByRole('tab', { name: 'production-workflow.md' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Loading file')).toBeInTheDocument()

    read.resolve({
      id: file.id,
      filename: file.filename,
      content: '# Workflow\n',
      content_type: file.content_type,
      size: 11,
      revision: 'artifact:slow:rev-1'
    })
    expect(await screen.findByRole('textbox', { name: 'Contents of production-workflow.md' })).toHaveValue('# Workflow\n')
  })

  it('cancels a pending attached-file read when its loading tab is closed', async () => {
    const user = userEvent.setup()
    const file: AgentFile = {
      id: 'artifact-cancel',
      filename: 'slow.log',
      content_type: 'text/plain'
    }
    const read = deferred<AgentTextFile>()
    vi.mocked(window.agentsDock.files.readText).mockReturnValueOnce(read.promise)
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
        detail: { sessionId: 'chat-a', file }
      }))
    })

    const close = screen.getByRole('button', { name: 'Close slow.log' })
    expect(close).toBeEnabled()
    const requestId = vi.mocked(window.agentsDock.files.readText).mock.calls[0]?.[2]
    await user.click(close)

    expect(screen.queryByRole('tab', { name: 'slow.log' })).not.toBeInTheDocument()
    expect(window.agentsDock.files.cancelReadText).toHaveBeenCalledWith('chat-a', requestId)

    await act(async () => {
      read.resolve({
        id: file.id,
        filename: file.filename,
        content: 'late result',
        content_type: file.content_type,
        size: 11,
        revision: 'late'
      })
      await read.promise
    })
    expect(screen.queryByRole('tab', { name: 'slow.log' })).not.toBeInTheDocument()
  })

  it('uses the final tab slot when a missing workspace source falls back to its attachment', async () => {
    const restoredTabs = Array.from({ length: 11 }, (_, index) => ({ path: `restored-${index}.ts` }))
    const file: AgentFile = {
      id: 'artifact-final-slot',
      filename: 'fallback.ts',
      source_path: '/work/project/fallback.ts',
      content_type: 'text/typescript'
    }
    vi.mocked(window.agentsDock.preferences.getScoped).mockResolvedValueOnce({
      version: 1,
      cwd: '/work/project',
      activePath: null,
      tabs: restoredTabs
    })
    vi.mocked(window.agentsDock.workspace.read).mockRejectedValueOnce(new Error('Workspace file not found'))
    renderEditor()
    await screen.findByRole('tab', { name: 'restored-10.ts' })

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
        detail: { sessionId: 'chat-a', file }
      }))
    })

    expect(await screen.findByRole('tab', { name: 'fallback.ts' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByText(/Close a file before opening more than/)).not.toBeInTheDocument()
  })

  it('opens agent text artifacts when workspace file support is unavailable', async () => {
    const file: AgentFile = {
      id: 'artifact-2',
      filename: 'versioned-policy.yaml',
      source_path: '/Users/dev/.agentsdock/files/artifact-2/versioned-policy.yaml',
      content_type: 'application/yaml'
    }
    vi.mocked(window.agentsDock.files.readText).mockResolvedValueOnce({
      id: file.id,
      filename: file.filename,
      content: 'version: 1\n',
      content_type: file.content_type,
      size: 11,
      revision: 'artifact:artifact-2:rev-1'
    })
    render(<WorkspaceEditor
      workspaceKey="server-a:chat-a"
      session={session}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available={false}
      unavailableMessage="Install a server with workspace file support."
      chatContent={<p>Chat timeline</p>}
    />)

    window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
      detail: { sessionId: 'chat-a', file }
    }))

    expect(await screen.findByRole('tab', { name: 'versioned-policy.yaml' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Contents of versioned-policy.yaml' })).toHaveValue('version: 1\n')
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalled()
  })

  it('opens large artifacts as a bounded source preview with a complete-file action', async () => {
    const user = userEvent.setup()
    const file: AgentFile = {
      id: 'artifact-large',
      filename: 'scheduled-job-output.md',
      source_path: '/Users/dev/.agentsdock/files/artifact-large/scheduled-job-output.md',
      content_type: 'text/markdown',
      size: 10 * 1024 * 1024
    }
    vi.mocked(window.agentsDock.files.readText).mockResolvedValueOnce({
      id: file.id,
      filename: file.filename,
      content: '# First part of the output\n',
      content_type: file.content_type,
      size: 10 * 1024 * 1024,
      preview_size: 2 * 1024 * 1024,
      truncated: true,
      revision: 'artifact:artifact-large:preview'
    })
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
        detail: { sessionId: 'chat-a', file }
      }))
    })

    expect(await screen.findByRole('textbox', { name: 'Contents of scheduled-job-output.md' }))
      .toHaveValue('# First part of the output\n')
    expect(screen.getByText('Showing first 2.0 MiB of 10 MiB')).toBeVisible()
    expect(screen.queryByRole('group', { name: 'Markdown view mode' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open complete file' }))
    expect(window.agentsDock.files.open).toHaveBeenCalledWith('chat-a', file)
  })

  it('opens files full screen by default while keeping Chat pinned as a tab', async () => {
    const user = userEvent.setup()
    const view = renderEditor()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))

    expect(screen.getByText('Chat timeline')).not.toBeVisible()
    expect(screen.getByRole('button', { name: /Chat.*pinned/i })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('separator', { name: 'Resize chat and file editor' })).not.toBeInTheDocument()
    expect(view.container.querySelector('.workspace-editor-content')).toHaveClass('workspace-editor-content-editor-only')
    expect(screen.getByRole('navigation', { name: 'Workspace tabs' })).not.toHaveClass('workspace-editor-tab-strip-split')
    expect(screen.getByRole('tab', { name: 'README.md' }).closest('.workspace-editor-file-tabs')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: /Chat.*pinned/i }))
    expect(screen.getByText('Chat timeline')).toBeVisible()
    expect(screen.queryByRole('separator', { name: 'Resize chat and file editor' })).not.toBeInTheDocument()
    expect(view.container.querySelector('.workspace-editor-content')).not.toHaveClass('workspace-editor-content-split')
  })

  it('returns a transient file workspace to its preserved chat layout', async () => {
    const user = userEvent.setup()
    const onReturnToChat = vi.fn()
    const view = renderEditor('server-a:chat-a', 5, undefined, undefined, onReturnToChat)

    expect(onReturnToChat).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))

    expect(view.container.querySelector('.workspace-editor-content')).toHaveClass('workspace-editor-content-editor-only')
    expect(screen.queryByRole('separator', { name: 'Resize chat and file editor' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Return to split chats' }))
    expect(onReturnToChat).toHaveBeenCalledOnce()
  })

  it('returns to preserved chats when a transient open-file request is cancelled', async () => {
    const user = userEvent.setup()
    const onReturnToChat = vi.fn()
    renderEditor('server-a:chat-a', 5, undefined, undefined, onReturnToChat)

    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-file')) })
    await screen.findByRole('dialog', { name: 'Open workspace file' })
    await user.click(screen.getByRole('button', { name: 'Close file picker' }))

    expect(onReturnToChat).toHaveBeenCalledOnce()
  })

  it('returns to preserved chats when a transient picker selection fails and is cancelled', async () => {
    const user = userEvent.setup()
    const onReturnToChat = vi.fn()
    vi.mocked(window.agentsDock.workspace.read).mockRejectedValueOnce(new Error('The selected file is unavailable.'))
    renderEditor('server-a:chat-a', 5, undefined, undefined, onReturnToChat)

    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-file')) })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    expect(await screen.findByText('The selected file is unavailable.')).toBeVisible()
    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace or paste a full path…'), { key: 'Escape' })

    expect(onReturnToChat).toHaveBeenCalledOnce()
  })

  it('returns after cancelling the initial transient picker even when an old file is restored', async () => {
    const user = userEvent.setup()
    const first = renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    first.unmount()

    const onReturnToChat = vi.fn()
    renderEditor('server-a:chat-a', 5, undefined, undefined, onReturnToChat)
    expect(screen.getByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true')
    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-file')) })
    await screen.findByRole('dialog', { name: 'Open workspace file' })
    await user.click(screen.getByRole('button', { name: 'Close file picker' }))

    expect(onReturnToChat).toHaveBeenCalledOnce()
  })

  it('does not restore focus to a covered chat control after a transient file opens', async () => {
    const user = userEvent.setup()
    const coveredChatControl = document.createElement('button')
    coveredChatControl.textContent = 'Covered chat control'
    document.body.appendChild(coveredChatControl)
    const onReturnToChat = vi.fn()
    renderEditor('server-a:chat-a', 5, undefined, undefined, onReturnToChat)
    coveredChatControl.focus()

    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-file')) })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))

    const editorPanel = screen.getByRole('tabpanel')
    await waitFor(() => expect(editorPanel).toContainElement(document.activeElement as HTMLElement))
    expect(document.activeElement).not.toBe(coveredChatControl)
    coveredChatControl.remove()
  })

  it('returns to preserved chats after closing the last transient file', async () => {
    const user = userEvent.setup()
    const onReturnToChat = vi.fn()
    renderEditor('server-a:chat-a', 5, undefined, undefined, onReturnToChat)

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    await user.click(screen.getByRole('button', { name: 'Close README.md' }))

    expect(onReturnToChat).toHaveBeenCalledOnce()
  })

  it('restores the chat split on demand and returns to the default full-screen file view', async () => {
    const user = userEvent.setup()
    const view = renderEditor()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))

    const content = view.container.querySelector('.workspace-editor-content')
    expect(content).toHaveClass('workspace-editor-content-editor-only')
    expect(content).not.toHaveClass('workspace-editor-content-split')
    expect(screen.getByText('Chat timeline')).not.toBeVisible()
    expect(screen.queryByRole('separator', { name: 'Resize chat and file editor' })).not.toBeInTheDocument()
    expect(screen.getByRole('tabpanel')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Restore chat split view' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('navigation', { name: 'Workspace tabs' })).not.toHaveClass('workspace-editor-tab-strip-split')

    await user.click(screen.getByRole('button', { name: 'Restore chat split view' }))

    expect(content).toHaveClass('workspace-editor-content-split', 'workspace-editor-right')
    expect(content).not.toHaveClass('workspace-editor-content-editor-only')
    expect(screen.getByText('Chat timeline')).toBeVisible()
    expect(screen.getByRole('separator', { name: 'Resize chat and file editor' })).toHaveAttribute('aria-valuenow', '58')
    expect(screen.getByRole('button', { name: 'Show file workspace full screen' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: 'Show file workspace full screen' }))
    expect(content).toHaveClass('workspace-editor-content-editor-only')
    expect(screen.getByText('Chat timeline')).not.toBeVisible()
  })

  it('scrolls overflowing file tabs sideways with a vertical wheel while pinned controls stay fixed', async () => {
    const user = userEvent.setup()
    renderEditor()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    await user.click(screen.getByRole('button', { name: 'Restore chat split view' }))

    const tabList = screen.getByRole('tablist', { name: 'Open files' })
    Object.defineProperties(tabList, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 620 }
    })
    tabList.scrollLeft = 0

    const verticalWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 90 })
    fireEvent(tabList, verticalWheel)

    expect(tabList.scrollLeft).toBe(90)
    expect(tabList.contains(screen.getByRole('button', { name: /Open file/ }))).toBe(false)
    expect(tabList.contains(screen.getByRole('button', { name: /Chat.*pinned/i }))).toBe(false)

    const horizontalWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 40, deltaY: 5 })
    fireEvent(tabList, horizontalWheel)
    expect(tabList.scrollLeft).toBe(90)

    tabList.scrollLeft = 420
    const boundaryWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 30 })
    fireEvent(tabList, boundaryWheel)
    expect(tabList.scrollLeft).toBe(420)
  })

  it('restores the per-chat split presentation after the editor remounts', async () => {
    const user = userEvent.setup()
    const first = renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    await user.click(screen.getByRole('button', { name: 'Restore chat split view' }))
    expect(first.container.querySelector('.workspace-editor-content')).toHaveClass('workspace-editor-content-split')

    const promises: Promise<unknown>[] = []
    window.dispatchEvent(new CustomEvent('agentsdock:flush-draft', { detail: { promises } }))
    await act(async () => { await Promise.all(promises) })
    first.unmount()

    const restored = renderEditor()
    expect(await screen.findByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true')
    expect(restored.container.querySelector('.workspace-editor-content')).toHaveClass('workspace-editor-content-split')
    expect(screen.getByText('Chat timeline')).toBeVisible()
  })

  it('restores a persisted split presentation while legacy states remain full screen', async () => {
    vi.mocked(window.agentsDock.preferences.getScoped).mockResolvedValueOnce({
      version: 4,
      cwd: '/work/project',
      activePath: 'README.md',
      secondaryPath: null,
      activeGroup: 'primary',
      filePresentation: 'split',
      tabs: [{ path: 'README.md' }]
    })
    const split = renderEditor()
    expect(await screen.findByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true')
    expect(split.container.querySelector('.workspace-editor-content')).toHaveClass('workspace-editor-content-split')
    split.unmount()

    resetWorkspaceEditorMemoryForTests()
    vi.mocked(window.agentsDock.preferences.getScoped).mockResolvedValueOnce({
      version: 3,
      cwd: '/work/project',
      activePath: 'README.md',
      secondaryPath: null,
      activeGroup: 'primary',
      tabs: [{ path: 'README.md' }]
    })
    const legacy = renderEditor('server-a:chat-legacy')
    expect(await screen.findByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true')
    expect(legacy.container.querySelector('.workspace-editor-content')).toHaveClass('workspace-editor-content-editor-only')
  })

  it('opens workspace images and PDFs through the preview transport without reading them as text', async () => {
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'assets/diagram.png' }
      }))
    })

    const image = await screen.findByRole('img', { name: 'assets/diagram.png' })
    expect(image).toHaveAttribute(
      'src',
      'agentsdock-media://workspace/profile-a/1/chat-a/assets%2Fdiagram.png'
    )
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalledWith('chat-a', 'assets/diagram.png')

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'docs/design.pdf' }
      }))
    })

    const pdf = await screen.findByTitle('PDF preview of docs/design.pdf')
    expect(pdf).toHaveAttribute(
      'src',
      'agentsdock-media://workspace/profile-a/1/chat-a/docs%2Fdesign.pdf'
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalledWith('chat-a', 'docs/design.pdf')
  })

  it('prefers a live workspace image through the main-process availability probe', async () => {
    const file: AgentFile = {
      id: 'live-image-artifact',
      filename: 'diagram.png',
      source_path: '/work/project/assets/diagram.png',
      content_type: 'image/png'
    }
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
        detail: { sessionId: 'chat-a', file }
      }))
    })

    const image = await screen.findByRole('img', { name: 'assets/diagram.png' })
    expect(image).toHaveAttribute(
      'src',
      'agentsdock-media://workspace/profile-a/1/chat-a/assets%2Fdiagram.png'
    )
    expect(window.agentsDock.workspace.previewAvailable).toHaveBeenCalledWith(
      { profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' },
      'chat-a',
      'assets/diagram.png'
    )
    expect(window.agentsDock.files.mediaURL).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls back to an attached media snapshot when its workspace preview path is stale', async () => {
    const file: AgentFile = {
      id: 'stale-image-artifact',
      filename: 'diagram.png',
      source_path: '/work/project/assets/diagram.png',
      content_type: 'image/png'
    }
    vi.mocked(window.agentsDock.workspace.previewAvailable).mockResolvedValueOnce(false)
    renderEditor()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', {
        detail: { sessionId: 'chat-a', file }
      }))
    })

    const image = await screen.findByRole('img', { name: 'diagram.png' })
    expect(image).toHaveAttribute(
      'src',
      'agentsdock-media://file/profile-a/1/chat-a/stale-image-artifact'
    )
    expect(window.agentsDock.files.mediaURL).toHaveBeenCalledWith(
      'profile-a',
      1,
      'chat-a',
      'stale-image-artifact'
    )
    expect(window.agentsDock.workspace.previewAvailable).toHaveBeenCalledWith(
      { profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' },
      'chat-a',
      'assets/diagram.png'
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByText('Attached snapshot')).toBeInTheDocument()
  })

  it('renders Markdown source and preview together and switches view modes', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))

    expect(await screen.findByRole('textbox', { name: 'Contents of README.md' })).toBeVisible()
    expect(screen.getByLabelText('Preview of README.md')).toHaveTextContent('Project')
    expect(screen.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.queryByRole('textbox', { name: 'Contents of README.md' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Preview of README.md')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Source' }))
    expect(screen.getByRole('textbox', { name: 'Contents of README.md' })).toBeVisible()
    expect(screen.queryByLabelText('Preview of README.md')).not.toBeInTheDocument()
  })

  it('renders sanitized README HTML and resolves its relative images through the workspace', async () => {
    const user = userEvent.setup()
    vi.mocked(window.agentsDock.workspace.read).mockResolvedValueOnce(workspaceFile(
      'README.md',
      '<div align="center"><img src="media/robot_wbc.png" width="800" alt="DEMO ATLAS Header"><!-- divider --></div>\n\n# Project'
    ))
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))

    const image = await screen.findByRole('img', { name: 'DEMO ATLAS Header' })
    expect(image).toHaveAttribute(
      'src',
      'agentsdock-media://workspace/profile-a/1/chat-a/media%2Frobot_wbc.png'
    )
    expect(image).toHaveAttribute('width', '800')
    expect(screen.getByLabelText('Preview of README.md').querySelector('div[align="center"]')).not.toBeNull()
    expect(screen.getByLabelText('Preview of README.md')).not.toHaveTextContent('<div align=')
  })

  it('resizes and restores the Markdown source/preview split', async () => {
    const user = userEvent.setup()
    const first = renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))

    const divider = screen.getByRole('separator', { name: 'Resize Markdown source and preview' })
    const markdown = first.container.querySelector<HTMLElement>('.workspace-editor-markdown')
    expect(markdown?.style.getPropertyValue('--workspace-markdown-source-percent')).toBe('50%')
    vi.spyOn(markdown as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 1000,
      top: 0,
      bottom: 700,
      width: 1000,
      height: 700,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })

    fireEvent.pointerDown(divider, { pointerId: 11, button: 0, isPrimary: true, clientX: 500 })
    fireEvent.pointerMove(divider, { pointerId: 11, buttons: 1, isPrimary: true, clientX: 650 })
    await waitFor(() => expect(markdown?.style.getPropertyValue('--workspace-markdown-source-percent')).toBe('65%'))
    fireEvent.pointerUp(divider, { pointerId: 11, button: 0, isPrimary: true, clientX: 650 })
    expect(divider).toHaveAttribute('aria-valuenow', '65')

    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(divider).toHaveAttribute('aria-valuenow', '62')
    expect(JSON.parse(window.localStorage.getItem('agentsdock:workspace-editor-split') ?? '{}')).toMatchObject({
      markdownSourcePercent: 62
    })

    first.unmount()
    resetWorkspaceEditorMemoryForTests()
    const restored = renderEditor('server-a:chat-markdown-split-restored')
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    expect(screen.getByRole('separator', { name: 'Resize Markdown source and preview' })).toHaveAttribute('aria-valuenow', '62')
    expect(restored.container.querySelector<HTMLElement>('.workspace-editor-markdown')?.style.getPropertyValue('--workspace-markdown-source-percent')).toBe('62%')
  })

  it('keeps Markdown source and preview at roughly the same proportional scroll position', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))

    const source = screen.getByRole('textbox', { name: 'Contents of README.md' })
    const preview = screen.getByLabelText('Preview of README.md')
    Object.defineProperties(source, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 500 }
    })
    Object.defineProperties(preview, {
      scrollHeight: { configurable: true, value: 4000 },
      clientHeight: { configurable: true, value: 500 }
    })

    source.scrollTop = 750
    fireEvent.scroll(source)
    await waitFor(() => expect(preview.scrollTop).toBeCloseTo(1750, 0))

    preview.scrollTop = 875
    fireEvent.scroll(preview)
    await waitFor(() => expect(source.scrollTop).toBeCloseTo(375, 0))

    fireEvent.scroll(source)
    await new Promise(resolve => window.requestAnimationFrame(() => resolve(undefined)))
    expect(preview.scrollTop).toBeCloseTo(875, 0)
  })

  it('persists each Markdown tab view mode across chat switches and app relaunches', async () => {
    const user = userEvent.setup()
    const first = renderEditor()
    await waitFor(() => expect(window.agentsDock.preferences.getScoped).toHaveBeenCalled())
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')

    const promises: Promise<unknown>[] = []
    window.dispatchEvent(new CustomEvent('agentsdock:flush-draft', { detail: { promises } }))
    await act(async () => { await Promise.all(promises) })
    await waitFor(() => expect(window.agentsDock.preferences.setScoped).toHaveBeenLastCalledWith(
      expect.any(Object),
      'workspace-editor:chat-a',
      expect.objectContaining({
        version: 5,
        tabs: expect.arrayContaining([
          expect.objectContaining({ path: 'README.md', markdownViewMode: 'preview' })
        ])
      })
    ))
    const persisted = vi.mocked(window.agentsDock.preferences.setScoped).mock.calls.at(-1)?.[2]
    expect(persisted).toBeTruthy()

    first.unmount()
    resetWorkspaceEditorMemoryForTests()
    vi.mocked(window.agentsDock.preferences.getScoped).mockResolvedValueOnce(persisted)
    renderEditor('server-a:chat-a-relaunched')

    expect(await screen.findByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('textbox', { name: 'Contents of README.md' })).not.toBeInTheDocument()
    expect(await screen.findByLabelText('Preview of README.md')).toBeVisible()
  })

  it('opens a second editor group and switches its file independently', async () => {
    const user = userEvent.setup()
    renderEditor()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.type(screen.getByPlaceholderText('Search workspace or paste a full path…'), 'app')
    await user.click(await screen.findByRole('option', { name: /src\/App\.tsx/i }))
    await user.click(screen.getByRole('tab', { name: 'README.md' }))
    await user.click(screen.getByRole('button', { name: 'Split editor right' }))
    await user.click(screen.getByRole('tab', { name: 'App.tsx' }))

    expect(screen.getByRole('region', { name: 'Primary file editor' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Secondary file editor' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Contents of README.md' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Contents of src/App.tsx' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close secondary editor' })).toBeInTheDocument()
  })

  it('anchors native file quick open to the focused editor group and restores replacement focus', async () => {
    const user = userEvent.setup()
    renderEditor()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.type(screen.getByPlaceholderText('Search workspace or paste a full path…'), 'app')
    await user.click(await screen.findByRole('option', { name: /src\/App\.tsx/i }))
    await user.click(screen.getByRole('tab', { name: 'README.md' }))
    await user.click(screen.getByRole('button', { name: 'Split editor right' }))
    await user.click(screen.getByRole('tab', { name: 'App.tsx' }))

    const secondary = screen.getByRole('region', { name: 'Secondary file editor' })
    const secondaryAppEditor = within(secondary).getByRole('textbox', { name: 'Contents of src/App.tsx' })
    secondaryAppEditor.focus()
    let handled = true
    act(() => {
      handled = window.dispatchEvent(new CustomEvent('agentsdock:quick-open-active-surface', { cancelable: true }))
    })

    const firstDialog = screen.getByRole('dialog', { name: 'Open workspace file' })
    expect(handled).toBe(false)
    expect(secondary).toContainElement(firstDialog)
    expect(screen.getByPlaceholderText('Search workspace or paste a full path…')).toHaveFocus()
    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace or paste a full path…'), { key: 'Escape' })
    await waitFor(() => expect(secondaryAppEditor).toHaveFocus())

    act(() => {
      handled = window.dispatchEvent(new CustomEvent('agentsdock:quick-open-active-surface', { cancelable: true }))
    })
    expect(screen.getByRole('dialog', { name: 'Open workspace file' })).toBeVisible()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:workspace-close-active'))
    })
    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Secondary file editor' })).toBeVisible()
    await waitFor(() => expect(secondaryAppEditor).toHaveFocus())

    vi.mocked(window.agentsDock.workspace.search).mockResolvedValue({
      root: '/work/project',
      query: 'readme',
      entries: [],
      scanned: 0,
      truncated: false,
      limit: 100
    })
    act(() => {
      handled = window.dispatchEvent(new CustomEvent('agentsdock:quick-open-active-surface', { cancelable: true }))
    })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    await user.type(search, 'readme')
    const readmeOption = await screen.findByRole('option', { name: /README\.md.*Open tab/i })
    await user.click(readmeOption)

    const primaryAfter = screen.getByRole('region', { name: 'Primary file editor' })
    const secondaryAfter = screen.getByRole('region', { name: 'Secondary file editor' })
    expect(within(primaryAfter).getByRole('textbox', { name: 'Contents of README.md' })).toBeVisible()
    const replacement = within(secondaryAfter).getByRole('textbox', { name: 'Contents of README.md' })
    await waitFor(() => expect(replacement).toHaveFocus())

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:quick-open-active-surface', { cancelable: true }))
    })
    expect(secondaryAfter).toContainElement(screen.getByRole('dialog', { name: 'Open workspace file' }))
    const chatTab = screen.getByRole('button', { name: /Chat.*pinned/i })
    await user.click(chatTab)
    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
    expect(chatTab).toHaveAttribute('aria-pressed', 'true')

    fireEvent.keyDown(chatTab, { key: 'o', metaKey: true })
    expect(screen.getByRole('dialog', { name: 'Open workspace file' })).toBeVisible()
  })

  it('closes a secondary-owned picker when its file group is removed', async () => {
    const user = userEvent.setup()
    renderEditor()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.type(screen.getByPlaceholderText('Search workspace or paste a full path…'), 'app')
    await user.click(await screen.findByRole('option', { name: /src\/App\.tsx/i }))
    await user.click(screen.getByRole('tab', { name: 'README.md' }))
    await user.click(screen.getByRole('button', { name: 'Split editor right' }))
    await user.click(screen.getByRole('tab', { name: 'App.tsx' }))

    const secondary = screen.getByRole('region', { name: 'Secondary file editor' })
    within(secondary).getByRole('textbox', { name: 'Contents of src/App.tsx' }).focus()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:quick-open-active-surface', { cancelable: true }))
    })
    expect(secondary).toContainElement(screen.getByRole('dialog', { name: 'Open workspace file' }))

    fireEvent.click(screen.getByRole('button', { name: 'Close App.tsx' }))

    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Secondary file editor' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Primary file editor' })).toBeVisible()
  })

  it('clears both editor groups when the same split file tab is closed', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    await user.click(screen.getByRole('button', { name: 'Split editor right' }))
    expect(screen.getByRole('region', { name: 'Secondary file editor' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Close README.md' }))

    expect(screen.queryByRole('region', { name: 'Secondary file editor' })).not.toBeInTheDocument()
    expect(screen.getByText('Chat timeline')).toBeVisible()
  })

  it('promotes the surviving secondary file when the primary file is deleted', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    await user.click(screen.getByRole('button', { name: 'Split editor right' }))
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.type(screen.getByPlaceholderText('Search workspace or paste a full path…'), 'app')
    await user.click(await screen.findByRole('option', { name: /src\/App\.tsx/i }))

    const readmeEntry = await screen.findByRole('button', { name: 'Open README.md' })
    fireEvent.contextMenu(readmeEntry)
    await user.click(await screen.findByRole('menuitem', { name: 'Delete Permanently…' }))
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => expect(window.agentsDock.workspace.remove).toHaveBeenCalledWith(
      'chat-a',
      'README.md',
      'entry-readme',
      false
    ))
    expect(screen.getByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Contents of src/App.tsx' })).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Secondary file editor' })).not.toBeInTheDocument()
  })

  it('moves and resizes the active editor split while remembering the layout', async () => {
    const user = userEvent.setup()
    const view = renderEditor()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /src\/App\.tsx/i }))
    await user.click(screen.getByRole('button', { name: 'Restore chat split view' }))

    const content = view.container.querySelector<HTMLElement>('.workspace-editor-content')!
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 1000,
      top: 0,
      bottom: 700,
      width: 1000,
      height: 700,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    const divider = screen.getByRole('separator', { name: 'Resize chat and file editor' })
    const tabStrip = screen.getByRole('navigation', { name: 'Workspace tabs' })
    fireEvent.pointerDown(divider, { pointerId: 7, button: 0, isPrimary: true, clientX: 420 })
    fireEvent.pointerMove(divider, { pointerId: 7, buttons: 1, isPrimary: true, clientX: 500 })
    await waitFor(() => {
      expect(content.style.getPropertyValue('--workspace-editor-width')).toBe('50%')
      expect(tabStrip.style.getPropertyValue('--workspace-editor-width')).toBe('50%')
    })
    fireEvent.pointerUp(divider, { pointerId: 7, button: 0, isPrimary: true, clientX: 500 })
    expect(divider).toHaveAttribute('aria-valuenow', '50')

    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(divider).toHaveAttribute('aria-valuenow', '48')

    await user.click(screen.getByRole('button', { name: 'Editor left' }))
    expect(view.container.querySelector('.workspace-editor-content')).toHaveClass('workspace-editor-left')
    expect(tabStrip).toHaveClass('workspace-editor-left')
    expect(tabStrip.firstElementChild).toHaveClass('workspace-editor-file-tabs')
    expect(tabStrip.lastElementChild).toHaveClass('workspace-editor-chat-tab')
    expect(screen.getByRole('button', { name: 'Editor left' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(divider).toHaveAttribute('aria-valuenow', '50')
    expect(JSON.parse(window.localStorage.getItem('agentsdock:workspace-editor-split') ?? '{}')).toEqual({
      side: 'left',
      editorPercent: 50,
      explorerWidth: 232,
      markdownSourcePercent: 50
    })
  })

  it('resizes the file explorer and restores its width', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const user = userEvent.setup()
    const first = renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))

    const panel = screen.getByRole('tabpanel')
    const divider = screen.getByRole('separator', { name: 'Resize file explorer' })
    expect(panel.style.getPropertyValue('--workspace-explorer-width')).toBe('232px')

    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(divider).toHaveAttribute('aria-valuenow', '244')
    expect(panel.style.getPropertyValue('--workspace-explorer-width')).toBe('244px')
    expect(JSON.parse(window.localStorage.getItem('agentsdock:workspace-editor-split') ?? '{}')).toMatchObject({
      explorerWidth: 244
    })

    first.unmount()
    resetWorkspaceEditorMemoryForTests()
    renderEditor('server-a:chat-width-restored')
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    const restoredPanel = screen.getByRole('tabpanel')
    expect(restoredPanel.style.getPropertyValue('--workspace-explorer-width')).toBe('244px')
    const restoredDivider = screen.getByRole('separator', { name: 'Resize file explorer' })
    expect(restoredDivider).toHaveAttribute('aria-valuemax', '244')
    expect(restoredDivider).toHaveAttribute('aria-valuenow', '244')
    let panelWidth = 1200
    vi.spyOn(restoredPanel, 'getBoundingClientRect').mockImplementation(() => ({
      left: 0,
      right: panelWidth,
      top: 0,
      bottom: 700,
      width: panelWidth,
      height: 700,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }))
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(restoredDivider).toHaveAttribute('aria-valuemax', '955'))
    fireEvent.keyDown(restoredDivider, { key: 'End' })
    expect(restoredDivider).toHaveAttribute('aria-valuenow', '955')
    expect(restoredPanel.style.getPropertyValue('--workspace-explorer-width')).toBe('955px')
    expect(screen.getByLabelText('Current file: README.md')).toHaveTextContent('README.md')

    // A narrower window clamps the saved width visually. ArrowLeft must move
    // immediately from that effective width rather than consuming a no-op key
    // press against the larger stored value.
    panelWidth = 600
    fireEvent(window, new Event('resize'))
    await waitFor(() => {
      expect(restoredDivider).toHaveAttribute('aria-valuemax', '355')
      expect(restoredDivider).toHaveAttribute('aria-valuenow', '355')
    })
    fireEvent.keyDown(restoredDivider, { key: 'ArrowLeft' })
    expect(restoredDivider).toHaveAttribute('aria-valuenow', '343')

    panelWidth = 1200
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(restoredDivider).toHaveAttribute('aria-valuemax', '955'))
    fireEvent.keyDown(restoredDivider, { key: 'End' })
    fireEvent.pointerDown(restoredDivider, { pointerId: 9, button: 0, isPrimary: true, clientX: 955 })
    fireEvent.pointerMove(restoredDivider, { pointerId: 9, buttons: 1, isPrimary: true, clientX: 540 })
    await new Promise(resolve => window.requestAnimationFrame(() => resolve(undefined)))
    expect(restoredPanel.style.getPropertyValue('--workspace-explorer-width')).toBe('540px')
    fireEvent.pointerMove(restoredDivider, { pointerId: 9, buttons: 1, isPrimary: true, clientX: 300 })
    await new Promise(resolve => window.requestAnimationFrame(() => resolve(undefined)))
    expect(restoredPanel.style.getPropertyValue('--workspace-explorer-width')).toBe('300px')
    fireEvent.pointerUp(restoredDivider, { pointerId: 9, button: 0, isPrimary: true, clientX: 300 })
    expect(restoredDivider).toHaveAttribute('aria-valuenow', '300')
    expect(JSON.parse(window.localStorage.getItem('agentsdock:workspace-editor-split') ?? '{}')).toMatchObject({
      explorerWidth: 300
    })

    panelWidth = 430
    fireEvent(window, new Event('resize'))
    await waitFor(() => {
      expect(restoredPanel).toHaveClass('workspace-editor-explorer-compact')
      expect(restoredDivider).toHaveAttribute('aria-valuemax', '185')
      expect(restoredDivider).toHaveAttribute('aria-valuenow', '185')
    })
    panelWidth = 441
    fireEvent(window, new Event('resize'))
    await waitFor(() => {
      expect(restoredPanel).not.toHaveClass('workspace-editor-explorer-compact')
      expect(restoredDivider).toHaveAttribute('aria-valuemax', '196')
    })
  })

  it('switches between Chat and open files with Command-number, Control-Tab, and Option-Command-arrows', async () => {
    const user = userEvent.setup()
    renderEditor()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.type(screen.getByPlaceholderText('Search workspace or paste a full path…'), 'app')
    await user.click(await screen.findByRole('option', { name: /src\/App\.tsx/i }))

    expect(screen.getByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: /Chat.*pinned/i })).toHaveAttribute('title', 'Chat · ⌘1')
    expect(screen.getByRole('tab', { name: 'README.md' })).toHaveAttribute('title', 'README.md · ⌘2')
    expect(screen.getByRole('tab', { name: 'App.tsx' })).toHaveAttribute('title', 'src/App.tsx · ⌘3')

    fireEvent.keyDown(window, { key: '1', metaKey: true })
    expect(screen.getByRole('button', { name: /Chat.*pinned/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Chat timeline')).toBeVisible()
    expect(screen.getByRole('tab', { name: 'README.md' })).toHaveAttribute('tabindex', '0')

    fireEvent.keyDown(window, { key: '2', metaKey: true })
    expect(screen.getByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })
    expect(screen.getByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
    const editor = screen.getByRole('textbox', { name: 'Contents of src/App.tsx' })
    editor.focus()
    expect(fireEvent.keyDown(editor, {
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      metaKey: true,
      altKey: true
    })).toBe(false)
    expect(screen.getByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true')
    const previousEditor = screen.getByRole('textbox', { name: 'Contents of README.md' })
    previousEditor.focus()
    expect(fireEvent.keyDown(previousEditor, {
      key: 'ArrowRight',
      code: 'ArrowRight',
      metaKey: true,
      altKey: true
    })).toBe(false)
    expect(screen.getByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:navigate-workspace-tab', { detail: { direction: 1 } }))
    })
    expect(screen.getByRole('button', { name: /Chat.*pinned/i })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
  })

  it('navigates quick-open results with the keyboard', async () => {
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    await screen.findByRole('option', { name: /README\.md/i })

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(await screen.findByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens a pasted full path inside the workspace without searching that path', async () => {
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-a', '', 100))
    vi.mocked(window.agentsDock.workspace.search).mockClear()

    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    fireEvent.change(search, { target: { value: '/work/project/src/App.tsx' } })
    expect(await screen.findByRole('option', { name: /Open src\/App\.tsx from full path/i })).toHaveAttribute('aria-selected', 'true')
    expect(window.agentsDock.workspace.search).not.toHaveBeenCalled()

    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', 'src/App.tsx'))
    expect(await screen.findByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens an exact workspace-relative path without relying on search scan limits', async () => {
    const relativePath = 'out/sample_inventory_review/synthetic_dataset_coverage_20260101/synthetic_sessions_missing_from_expected_validation_inventory_20260101.tsv'
    vi.mocked(window.agentsDock.workspace.search).mockResolvedValue({
      root: '/work/project',
      query: relativePath,
      entries: [],
      scanned: 10_000,
      truncated: true,
      limit: 100
    })

    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-a', '', 100))
    vi.mocked(window.agentsDock.workspace.search).mockClear()

    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    fireEvent.change(search, { target: { value: relativePath } })
    expect(await screen.findByRole('option', { name: new RegExp(`Open ${relativePath} from full path`, 'i') })).toHaveAttribute('aria-selected', 'true')
    expect(window.agentsDock.workspace.search).not.toHaveBeenCalled()

    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', relativePath))
    expect(await screen.findByRole('tab', { name: 'synthetic_sessions_missing_from_expected_validation_inventory_20260101.tsv' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows a failed quick-open read once inside the picker', async () => {
    const requestedPath = 'out/source_filter_review/large_result.tsv'
    const failure = `${requestedPath} is larger than the editor limit.`
    vi.mocked(window.agentsDock.workspace.read).mockRejectedValueOnce(new Error(
      `Error invoking remote method 'workspace:read': Error: ${failure}`
    ))

    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    fireEvent.change(search, { target: { value: requestedPath } })
    fireEvent.keyDown(search, { key: 'Enter' })

    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-a', requestedPath, 100))
    expect(await screen.findByText(failure)).toBeVisible()
    expect(screen.getAllByText(failure)).toHaveLength(1)
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Dismiss workspace error' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Open workspace file' })).toBeVisible()
  })

  it('stops an obsolete remote search spinner when an immediate local selection fails', async () => {
    const pendingSearch = deferred<WorkspaceSearchPage>()
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    await waitFor(() => expect(window.agentsDock.workspace.entries).toHaveBeenCalled())
    vi.mocked(window.agentsDock.workspace.search).mockReturnValue(pendingSearch.promise)
    vi.mocked(window.agentsDock.workspace.read).mockRejectedValueOnce(new Error('README is unavailable.'))

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    fireEvent.click(await screen.findByRole('option', { name: /README\.md/i }))

    expect(await screen.findByText('README is unavailable.')).toBeVisible()
    expect(screen.queryByText('Searching workspace')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Open workspace file' })).toBeVisible()
  })

  it('falls back to suffix search when a pasted relative path cannot be opened exactly', async () => {
    const requestedPath = 'src/data/claude_sandbox/260728_kd_real475_run016_3obj_launch/launch_state.js'
    const actualPath = `packages/robot/${requestedPath}`
    vi.mocked(window.agentsDock.workspace.search).mockImplementation((_sessionId: string, query = '') => Promise.resolve({
      root: '/work/project',
      query,
      entries: query === requestedPath
        ? [{ name: 'launch_state.js', path: actualPath, kind: 'file', size: 10, writable: true }]
        : [],
      scanned: 1,
      truncated: false,
      limit: 100
    }))
    vi.mocked(window.agentsDock.workspace.read).mockImplementation((_sessionId: string, path: string) => (
      path === requestedPath
        ? Promise.reject(new Error(`Workspace path has the wrong type: ${requestedPath.slice(0, requestedPath.lastIndexOf('/'))}`))
        : Promise.resolve(workspaceFile(path))
    ))

    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    fireEvent.change(search, { target: { value: requestedPath } })
    expect(await screen.findByRole('option', { name: new RegExp(`Open ${requestedPath} from full path`, 'i') })).toBeVisible()

    fireEvent.keyDown(search, { key: 'Enter' })

    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', requestedPath))
    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-a', requestedPath, 100))
    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', actualPath))
    expect(await screen.findByRole('tab', { name: 'launch_state.js' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: `Contents of ${actualPath}` })).toBeVisible()
  })

  it('keeps authoritative ambiguous matches when the follow-up basename search fails', async () => {
    const requestedPath = 'pkg/launcher.py'
    const matches: WorkspaceEntry[] = [
      { name: 'launcher.py', path: 'cli/pkg/launcher.py', kind: 'file', size: 10, writable: true },
      { name: 'launcher.py', path: 'train/pkg/launcher.py', kind: 'file', size: 10, writable: true }
    ]
    vi.mocked(window.agentsDock.workspace.search).mockImplementation((_sessionId: string, query = '') => {
      if (query === 'launcher.py') return Promise.reject(new Error('Workspace search is temporarily unavailable.'))
      return Promise.resolve({
        root: '/work/project',
        query,
        entries: query === requestedPath ? matches : [],
        scanned: matches.length,
        truncated: false,
        limit: 100
      })
    })
    vi.mocked(window.agentsDock.workspace.read).mockImplementation((_sessionId: string, path: string) => (
      path === requestedPath
        ? Promise.reject(new Error('The exact path is unavailable.'))
        : Promise.resolve(workspaceFile(path))
    ))

    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    fireEvent.change(search, { target: { value: requestedPath } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(await screen.findByRole('option', { name: /cli\/pkg\/launcher\.py/i })).toBeVisible()
    expect(screen.getByRole('option', { name: /train\/pkg\/launcher\.py/i })).toBeVisible()
    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-a', 'launcher.py', 100))
    expect(screen.getByRole('option', { name: /cli\/pkg\/launcher\.py/i })).toBeVisible()
    expect(screen.getByRole('option', { name: /train\/pkg\/launcher\.py/i })).toBeVisible()
    expect(screen.getByText(/Showing open and loaded files only/i)).toBeVisible()
  })

  it('does not open a stale exact-path fallback after the palette query changes', async () => {
    const requestedPath = 'src/data/old/launch_state.js'
    const pendingRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read).mockImplementation((_sessionId: string, path: string) => (
      path === requestedPath ? pendingRead.promise : Promise.resolve(workspaceFile(path))
    ))

    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    fireEvent.change(search, { target: { value: requestedPath } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', requestedPath))

    fireEvent.change(search, { target: { value: 'README.md' } })
    await act(async () => pendingRead.reject(new Error('The exact path does not exist.')))

    expect(window.agentsDock.workspace.search).not.toHaveBeenCalledWith('chat-a', requestedPath, 100)
    expect(screen.queryByRole('tab', { name: 'launch_state.js' })).not.toBeInTheDocument()
  })

  it('does not add or focus a palette file whose read resolves after Escape', async () => {
    const user = userEvent.setup()
    const stalePath = 'outputs/stale-result.ts'
    const pendingRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read).mockImplementation((_sessionId: string, path: string) => (
      path === stalePath ? pendingRead.promise : Promise.resolve(workspaceFile(path))
    ))

    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    const editor = await screen.findByRole('textbox', { name: 'Contents of README.md' })
    editor.focus()
    fireEvent.keyDown(editor, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    fireEvent.change(search, { target: { value: stalePath } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', stalePath))

    fireEvent.keyDown(search, { key: 'Escape' })
    const chatTab = screen.getByRole('button', { name: /Chat.*pinned/i })
    chatTab.focus()
    await act(async () => {
      pendingRead.resolve(workspaceFile(stalePath))
      await pendingRead.promise
    })

    expect(screen.queryByRole('tab', { name: 'stale-result.ts' })).not.toBeInTheDocument()
    expect(chatTab).toHaveFocus()
  })

  it('does not add a palette file whose read resolves after the query changes', async () => {
    const stalePath = 'outputs/stale-query-result.ts'
    const pendingRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read).mockImplementation((_sessionId: string, path: string) => (
      path === stalePath ? pendingRead.promise : Promise.resolve(workspaceFile(path))
    ))

    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    fireEvent.change(search, { target: { value: stalePath } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', stalePath))

    fireEvent.change(search, { target: { value: 'README' } })
    await act(async () => {
      pendingRead.resolve(workspaceFile(stalePath))
      await pendingRead.promise
    })

    expect(screen.getByRole('dialog', { name: 'Open workspace file' })).toBeVisible()
    expect(screen.getByPlaceholderText('Search workspace or paste a full path…')).toHaveValue('README')
    expect(screen.queryByRole('tab', { name: 'stale-query-result.ts' })).not.toBeInTheDocument()
  })

  it('does not install stale search results after the visible query changes', async () => {
    const oldSearch = deferred<WorkspaceSearchPage>()
    const newSearch = deferred<WorkspaceSearchPage>()
    vi.mocked(window.agentsDock.workspace.search).mockImplementation((_sessionId: string, query = '') => {
      if (query === 'old') return oldSearch.promise
      if (query === 'new') return newSearch.promise
      return Promise.resolve({ root: '/work/project', query, entries: [], scanned: 0, truncated: false, limit: 100 })
    })

    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    fireEvent.change(search, { target: { value: 'old' } })
    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-a', 'old', 100))
    fireEvent.change(search, { target: { value: 'new' } })
    await act(async () => {
      oldSearch.resolve({
        root: '/work/project',
        query: 'old',
        entries: [{ name: 'old-result.ts', path: 'old-result.ts', kind: 'file', writable: true }],
        scanned: 1,
        truncated: false,
        limit: 100
      })
      await oldSearch.promise
    })
    expect(screen.queryByRole('option', { name: /old-result\.ts/i })).not.toBeInTheDocument()

    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-a', 'new', 100))
    await act(async () => {
      newSearch.resolve({
        root: '/work/project',
        query: 'new',
        entries: [{ name: 'new-result.ts', path: 'new-result.ts', kind: 'file', writable: true }],
        scanned: 1,
        truncated: false,
        limit: 100
      })
      await newSearch.promise
    })
    expect(await screen.findByRole('option', { name: /new-result\.ts/i })).toBeVisible()
  })

  it('dismisses the Cmd+O file picker with Escape while its search field has focus', async () => {
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })

    const search = await screen.findByPlaceholderText('Search workspace or paste a full path…')
    expect(search).toHaveFocus()
    fireEvent.keyDown(search, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
  })

  it('opens an explicitly entered absolute path outside the workspace as read-only without searching', async () => {
    const first = renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await waitFor(() => expect(window.agentsDock.workspace.search).toHaveBeenCalledWith('chat-a', '', 100))
    vi.mocked(window.agentsDock.workspace.search).mockClear()
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    const path = '/home/dev/.codex/AGENTS.md'
    fireEvent.change(search, { target: { value: path } })

    expect(await screen.findByRole('option', { name: `Open ${path} read only` })).toBeVisible()
    expect(window.agentsDock.workspace.search).not.toHaveBeenCalled()
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(window.agentsDock.workspace.readAbsolute).toHaveBeenCalledWith('chat-a', path))
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalledWith('chat-a', path)
    expect(await screen.findByRole('textbox', { name: `Contents of ${path}` })).toHaveAttribute('readonly')
    expect(screen.getByRole('tab', { name: 'AGENTS.md' }).getAttribute('title')).toContain(path)
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    expect(window.agentsDock.workspace.write).not.toHaveBeenCalled()
    expect(window.agentsDock.workspace.remove).not.toHaveBeenCalled()

    first.unmount()
    renderEditor()
    expect(await screen.findByRole('tab', { name: 'AGENTS.md' })).toBeInTheDocument()
    expect(await screen.findByRole('textbox', { name: `Contents of ${path}` })).toHaveAttribute('readonly')
  })

  it('opens a server-home path from Cmd+O and keeps the resolved path editable', async () => {
    const requestedPath = '~/.claude/settings.local.json'
    const resolvedPath = '/home/dev/.claude/settings.local.json'
    vi.mocked(window.agentsDock.workspace.readAbsolute).mockResolvedValueOnce({
      ...workspaceFile(resolvedPath, '{"permissions": {}}\n', 'rev-home-1'),
      root: '/',
      writable: true,
      scope: 'absolute'
    })

    renderEditor('server-a:chat-a', 6)
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    vi.mocked(window.agentsDock.workspace.search).mockClear()
    fireEvent.change(search, { target: { value: requestedPath } })

    expect(await screen.findByRole('option', { name: `Open ${requestedPath}` })).toBeVisible()
    expect(window.agentsDock.workspace.search).not.toHaveBeenCalled()
    fireEvent.keyDown(search, { key: 'Enter' })

    await waitFor(() => expect(window.agentsDock.workspace.readAbsolute).toHaveBeenCalledWith('chat-a', requestedPath))
    const editor = await screen.findByRole('textbox', { name: `Contents of ${resolvedPath}` })
    expect(editor).not.toHaveAttribute('readonly')
    expect(screen.getByRole('tab', { name: 'settings.local.json' }).getAttribute('title')).toContain(resolvedPath)

    fireEvent.change(editor, { target: { value: '{"permissions": {"allow": []}}\n' } })
    fireEvent.keyDown(window, { key: 's', metaKey: true })

    await waitFor(() => expect(window.agentsDock.workspace.writeAbsolute).toHaveBeenCalledWith(
      'chat-a',
      resolvedPath,
      '{"permissions": {"allow": []}}\n',
      'rev-home-1'
    ))
  })

  it('keeps the newest location when duplicate absolute aliases resolve to one canonical path', async () => {
    const requestedPath = '~/.claude/settings.local.json'
    const resolvedPath = '/home/dev/.claude/settings.local.json'
    const pendingRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.readAbsolute).mockImplementationOnce(() => pendingRead.promise)
    renderEditor('server-a:chat-a', 6)

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: requestedPath, line: 2, resolve: true }
      }))
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: requestedPath, line: 19, resolve: true }
      }))
    })
    await act(async () => {
      pendingRead.resolve({
        ...workspaceFile(resolvedPath, Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n')),
        root: '/',
        writable: true,
        scope: 'absolute'
      })
      await pendingRead.promise
    })

    const editor = await screen.findByRole('textbox', { name: `Contents of ${resolvedPath}` })
    expect(editor).toHaveAttribute('data-editor-navigation-line', '19')
    expect(window.agentsDock.workspace.readAbsolute).toHaveBeenCalledTimes(1)
  })

  it('opens a rendered absolute file link as editable and saves it with capability v6', async () => {
    const path = '/home/dev/project/README.md'
    vi.mocked(window.agentsDock.workspace.readAbsolute).mockResolvedValueOnce({
      ...workspaceFile(path, '# external\n', 'rev-external-1'),
      root: '/',
      writable: true,
      scope: 'absolute'
    })
    const view = render(<WorkspaceEditor
      workspaceKey="server-a:chat-a"
      session={session}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available
      capabilityVersion={5}
      chatContent={<p>Chat timeline</p>}
    />)
    view.rerender(<WorkspaceEditor
      workspaceKey="server-a:chat-a"
      session={session}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available
      capabilityVersion={6}
      chatContent={<p>Chat timeline</p>}
    />)

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path, resolve: true }
      }))
    })

    await waitFor(() => expect(window.agentsDock.workspace.readAbsolute).toHaveBeenCalledWith('chat-a', path))
    expect(window.agentsDock.workspace.search).not.toHaveBeenCalled()
    const editor = await screen.findByRole('textbox', { name: `Contents of ${path}` })
    expect(editor).not.toHaveAttribute('readonly')

    fireEvent.change(editor, { target: { value: '# edited externally\n' } })
    fireEvent.keyDown(window, { key: 's', metaKey: true })

    await waitFor(() => expect(window.agentsDock.workspace.writeAbsolute).toHaveBeenCalledWith(
      'chat-a',
      path,
      '# edited externally\n',
      'rev-external-1'
    ))
    expect(window.agentsDock.workspace.write).not.toHaveBeenCalled()
    expect(window.agentsDock.workspace.search).not.toHaveBeenCalled()
  })

  it('refreshes restored absolute tabs when capability hydration enables editing', async () => {
    const path = '/home/dev/project/README.md'
    vi.mocked(window.agentsDock.workspace.readAbsolute).mockResolvedValue({
      ...workspaceFile(path, '# external\n', 'rev-external-1'),
      root: '/',
      writable: true,
      scope: 'absolute'
    })
    const props = {
      workspaceKey: 'server-a:chat-a',
      session,
      profileScope: { profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' },
      available: true,
      chatContent: <p>Chat timeline</p>
    }
    const first = render(<WorkspaceEditor {...props} capabilityVersion={6} />)
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path, resolve: true }
      }))
    })
    expect(await screen.findByRole('textbox', { name: `Contents of ${path}` })).not.toHaveAttribute('readonly')
    first.unmount()

    const restored = render(<WorkspaceEditor {...props} capabilityVersion={1} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: `Contents of ${path}` })).toHaveAttribute('readonly'))
    restored.rerender(<WorkspaceEditor {...props} capabilityVersion={6} />)

    await waitFor(() => expect(screen.getByRole('textbox', { name: `Contents of ${path}` })).not.toHaveAttribute('readonly'))
    expect(vi.mocked(window.agentsDock.workspace.readAbsolute).mock.calls.filter(([, requested]) => requested === path).length).toBeGreaterThanOrEqual(2)
  })

  it('refreshes the absolute-link listener when a live server upgrade enables reads', async () => {
    const path = '/home/dev/project/README.md'
    const props = {
      workspaceKey: 'server-a:chat-a',
      session,
      profileScope: { profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' },
      available: true,
      chatContent: <p>Chat timeline</p>
    }
    const view = render(<WorkspaceEditor {...props} capabilityVersion={4} />)
    view.rerender(<WorkspaceEditor {...props} capabilityVersion={5} />)

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path, resolve: true }
      }))
    })

    await waitFor(() => expect(window.agentsDock.workspace.readAbsolute).toHaveBeenCalledWith('chat-a', path))
    expect(await screen.findByRole('textbox', { name: `Contents of ${path}` })).toHaveAttribute('readonly')
  })

  it('preserves a dirty external draft only in the chat that explicitly opened it', async () => {
    const path = '/home/dev/project/README.md'
    vi.mocked(window.agentsDock.workspace.readAbsolute).mockResolvedValue({
      ...workspaceFile(path, '# disk\n', 'rev-external-1'),
      root: '/',
      writable: true,
      scope: 'absolute'
    })
    const renderSession = (currentSession: Session, workspaceKey: string) => render(<WorkspaceEditor
      workspaceKey={workspaceKey}
      session={currentSession}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available
      capabilityVersion={6}
      chatContent={<p>Chat timeline</p>}
    />)

    const first = renderSession(session, 'server-a:chat-a')
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path, resolve: true }
      }))
    })
    const editor = await screen.findByRole('textbox', { name: `Contents of ${path}` })
    fireEvent.change(editor, { target: { value: '# unsaved chat A\n' } })
    first.unmount()

    const chatB = { ...session, id: 'chat-b', title: 'Chat B' }
    const second = renderSession(chatB, 'server-a:chat-b')
    expect(screen.queryByRole('tab', { name: 'README.md' })).not.toBeInTheDocument()
    expect(window.agentsDock.workspace.readAbsolute).not.toHaveBeenCalledWith('chat-b', path)
    second.unmount()

    renderSession(session, 'server-a:chat-a')
    expect(await screen.findByRole('textbox', { name: `Contents of ${path}` })).toHaveValue('# unsaved chat A\n')
    await waitFor(() => expect(window.agentsDock.workspace.readAbsolute).toHaveBeenCalledWith('chat-a', path))
  })

  it('keeps outside-workspace absolute reads unavailable against older servers', async () => {
    render(<WorkspaceEditor
      workspaceKey="server-a:chat-a"
      session={session}
      profileScope={{ profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a' }}
      available
      capabilityVersion={4}
      chatContent={<p>Chat timeline</p>}
    />)
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    fireEvent.change(search, { target: { value: '/home/dev/.codex/AGENTS.md' } })

    expect(await screen.findByText('Update AgentsServer to open explicit absolute paths outside the workspace.')).toBeVisible()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(window.agentsDock.workspace.readAbsolute).not.toHaveBeenCalled()
  })

  it('normalizes full paths and preserves workspace boundaries', () => {
    expect(resolveWorkspacePathInput('/work/project', '"/work/project/src/../README.md"')).toEqual({
      kind: 'workspace-file',
      path: 'README.md'
    })
    expect(resolveWorkspacePathInput('/work/project', '/work/project-other/README.md')).toEqual({
      kind: 'absolute-file',
      path: '/work/project-other/README.md'
    })
    expect(resolveWorkspacePathInput('C:\\work\\project', 'c:\\work\\project\\src\\App.tsx')).toEqual({
      kind: 'workspace-file',
      path: 'src/App.tsx'
    })
    expect(resolveWorkspacePathInput('/work/project', 'src/App.tsx')).toEqual({
      kind: 'workspace-file',
      path: 'src/App.tsx'
    })
    expect(resolveWorkspacePathInput('/work/project', 'App')).toEqual({ kind: 'search' })
    expect(resolveWorkspacePathInput('/work/project', '/home/dev/.codex/AGENTS.md')).toEqual({
      kind: 'absolute-file',
      path: '/home/dev/.codex/AGENTS.md'
    })
    expect(resolveWorkspacePathInput('/work/project', '~/.claude/settings.local.json')).toEqual({
      kind: 'absolute-file',
      path: '~/.claude/settings.local.json'
    })
    expect(resolveWorkspacePathInput('/work/project', '"~/.claude/settings.local.json"')).toEqual({
      kind: 'absolute-file',
      path: '~/.claude/settings.local.json'
    })
    expect(resolveWorkspacePathInput('/work/project', '~/.claude/../settings.json')).toEqual({
      kind: 'outside-workspace'
    })
    expect(resolveWorkspacePathInput('/work/project', '/home/dev/../secrets.txt')).toEqual({
      kind: 'outside-workspace'
    })
  })

  it('builds reveal ancestors and copyable paths for POSIX and Windows workspaces', () => {
    expect(workspaceParentDirectories('robot/control/atlas_vla/policy_runner.py')).toEqual([
      'robot',
      'robot/control',
      'robot/control/atlas_vla'
    ])
    expect(absoluteWorkspacePath('/work/project', 'src/App.tsx')).toBe('/work/project/src/App.tsx')
    expect(absoluteWorkspacePath('C:\\work\\project', 'src/App.tsx')).toBe('C:\\work\\project\\src\\App.tsx')
  })

  it('resolves exact, suffix, and unique basename workspace references without guessing', () => {
    const candidates: WorkspaceEntry[] = [
      { name: 'launcher.py', path: 'cli/launcher.py', kind: 'file', size: 10, writable: true },
      { name: 'launcher.py', path: 'train/launcher.py', kind: 'file', size: 10, writable: true },
      { name: 'policy_runner.py', path: 'robot/control/atlas_vla/policy_runner.py', kind: 'file', size: 10, writable: true },
      { name: 'src', path: 'src', kind: 'directory', writable: true }
    ]

    expect(resolveWorkspaceReference('cli/launcher.py', candidates)).toEqual({
      kind: 'match',
      path: 'cli/launcher.py'
    })
    expect(resolveWorkspaceReference('atlas_vla/policy_runner.py', candidates)).toEqual({
      kind: 'match',
      path: 'robot/control/atlas_vla/policy_runner.py'
    })
    expect(resolveWorkspaceReference('policy_runner.py', candidates)).toEqual({
      kind: 'match',
      path: 'robot/control/atlas_vla/policy_runner.py'
    })
    expect(resolveWorkspaceReference('launcher.py', candidates)).toEqual({
      kind: 'ambiguous',
      matches: candidates.slice(0, 2)
    })
    expect(resolveWorkspaceReference('missing.py', candidates)).toEqual({ kind: 'missing' })
  })

  it('keeps the newest palette selection even when the older read finishes first', async () => {
    const user = userEvent.setup()
    const readmeRead = deferred<WorkspaceFile>()
    const appRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read)
      .mockImplementationOnce(() => readmeRead.promise)
      .mockImplementationOnce(() => appRead.promise)
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })

    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    await user.click(screen.getByRole('option', { name: /src\/App\.tsx/i }))
    await act(async () => {
      readmeRead.resolve(workspaceFile('README.md'))
      await readmeRead.promise
    })

    expect(screen.queryByRole('tab', { name: 'README.md' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Open workspace file' })).toBeVisible()

    await act(async () => {
      appRead.resolve(workspaceFile('src/App.tsx'))
      await appRead.promise
    })

    expect(await screen.findByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps pinned Chat authoritative over a deferred root-palette selection', async () => {
    const user = userEvent.setup()
    const pendingRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read).mockImplementationOnce(() => pendingRead.promise)
    renderEditor()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    const chatTab = screen.getByRole('button', { name: /Chat.*pinned/i })
    await user.click(chatTab)
    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()

    await act(async () => {
      pendingRead.resolve(workspaceFile('README.md'))
      await pendingRead.promise
    })
    expect(chatTab).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('tab', { name: 'README.md' })).not.toBeInTheDocument()
  })

  it('keeps an existing file-tab click authoritative over a deferred palette selection', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    const readmeTab = screen.getByRole('tab', { name: 'README.md' })
    const pendingRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read).mockImplementationOnce(() => pendingRead.promise)

    fireEvent.keyDown(readmeTab, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /src\/App\.tsx/i }))
    await user.click(readmeTab)
    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()

    await act(async () => {
      pendingRead.resolve(workspaceFile('src/App.tsx'))
      await pendingRead.promise
    })
    expect(readmeTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: 'App.tsx' })).not.toBeInTheDocument()
  })

  it('retries a current selection after an older same-path palette read becomes stale', async () => {
    const user = userEvent.setup()
    const oldRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read)
      .mockImplementationOnce(() => oldRead.promise)
      .mockImplementationOnce(() => Promise.resolve(workspaceFile('README.md')))
    renderEditor()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace or paste a full path…'), { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))

    await act(async () => {
      oldRead.resolve(workspaceFile('README.md'))
      await oldRead.promise
    })
    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows a shared same-path read failure to the current palette selection', async () => {
    const user = userEvent.setup()
    const oldRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read).mockImplementationOnce(() => oldRead.promise)
    renderEditor()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    fireEvent.keyDown(screen.getByPlaceholderText('Search workspace or paste a full path…'), { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    await act(async () => {
      oldRead.reject(new Error('README could not be read.'))
      try { await oldRead.promise } catch { /* expected */ }
    })

    expect(await screen.findByText('README could not be read.')).toBeVisible()
    expect(screen.getByRole('dialog', { name: 'Open workspace file' })).toBeVisible()
    expect(window.agentsDock.workspace.read).toHaveBeenCalledTimes(1)
  })

  it('keeps a palette selection authoritative over an older generic file read', async () => {
    const user = userEvent.setup()
    const genericRead = deferred<WorkspaceFile>()
    const paletteRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read)
      .mockImplementationOnce(() => genericRead.promise)
      .mockImplementationOnce(() => paletteRead.promise)
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'README.md' }
      }))
    })
    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', 'README.md'))

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /src\/App\.tsx/i }))
    await act(async () => {
      genericRead.resolve(workspaceFile('README.md'))
      await genericRead.promise
    })
    expect(screen.getByRole('dialog', { name: 'Open workspace file' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'README.md' })).not.toHaveAttribute('aria-selected', 'true')

    await act(async () => {
      paletteRead.resolve(workspaceFile('src/App.tsx'))
      await paletteRead.promise
    })
    expect(await screen.findByRole('tab', { name: 'App.tsx' })).toHaveAttribute('aria-selected', 'true')
  })

  it('does not let palette open, query, or cancel supersede a generic file open', async () => {
    const pendingRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read).mockReturnValueOnce(pendingRead.promise)
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'README.md' }
      }))
    })
    await waitFor(() => expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-a', 'README.md'))

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    const search = screen.getByPlaceholderText('Search workspace or paste a full path…')
    fireEvent.change(search, { target: { value: 'app' } })
    fireEvent.keyDown(search, { key: 'Escape' })
    await act(async () => {
      pendingRead.resolve(workspaceFile('README.md'))
      await pendingRead.promise
    })

    expect(await screen.findByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
  })

  it('transfers the last tab reservation to the newest palette selection', async () => {
    const user = userEvent.setup()
    const restoredTabs = Array.from({ length: 11 }, (_, index) => ({ path: `restored-${index}.ts` }))
    const candidates: WorkspaceEntry[] = [
      { name: 'first.ts', path: 'first.ts', kind: 'file', size: 10, writable: true },
      { name: 'second.ts', path: 'second.ts', kind: 'file', size: 10, writable: true }
    ]
    const firstRead = deferred<WorkspaceFile>()
    const secondRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.preferences.getScoped).mockResolvedValueOnce({
      version: 1,
      cwd: '/work/project',
      activePath: null,
      tabs: restoredTabs
    })
    vi.mocked(window.agentsDock.workspace.search).mockResolvedValueOnce({
      root: '/work/project',
      query: '',
      entries: candidates,
      scanned: candidates.length,
      truncated: false,
      limit: 100
    })
    vi.mocked(window.agentsDock.workspace.read)
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => secondRead.promise)
    const view = renderEditor()
    await screen.findByRole('tab', { name: 'restored-10.ts' })

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /first\.ts/i }))
    await user.click(screen.getByRole('option', { name: /second\.ts/i }))

    expect(window.agentsDock.workspace.read).toHaveBeenCalledTimes(2)
    await act(async () => {
      firstRead.resolve(workspaceFile('first.ts'))
      await firstRead.promise
    })
    expect(screen.queryByRole('tab', { name: 'first.ts' })).not.toBeInTheDocument()
    await act(async () => {
      secondRead.resolve(workspaceFile('second.ts'))
      await secondRead.promise
    })
    expect(await screen.findByRole('tab', { name: 'second.ts' })).toHaveAttribute('aria-selected', 'true')
    expect(view.container.querySelectorAll('.workspace-editor-file-tab')).toHaveLength(12)
  })

  it('opens writable files editable and saves with Cmd+S using the last disk revision', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /src\/App.tsx/i }))

    const editor = await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    expect(editor).not.toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: /Read-only|Editing/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save/i })).not.toBeInTheDocument()
    await user.clear(editor)
    await user.type(editor, 'export const app = false')
    expect(screen.getByRole('button', { name: 'Close App.tsx with unsaved changes' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(window.agentsDock.workspace.write).toHaveBeenCalledWith(
      'chat-a',
      'src/App.tsx',
      'export const app = false',
      'rev-1'
    ))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close App.tsx with unsaved changes' })).not.toBeInTheDocument())
  })

  it('closes a saved tab while explorer metadata synchronization is still pending', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /src\/App.tsx/i }))

    const editor = await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    await waitFor(() => expect(window.agentsDock.workspace.entries).toHaveBeenCalledWith('chat-a', 'src', 0, 500))
    const metadata = deferred<WorkspaceEntriesPage>()
    vi.mocked(window.agentsDock.workspace.entries).mockImplementationOnce(() => metadata.promise)
    const entryCallsBeforeSave = vi.mocked(window.agentsDock.workspace.entries).mock.calls.length

    await user.type(editor, '// saved\n')
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(vi.mocked(window.agentsDock.workspace.entries).mock.calls.length).toBeGreaterThan(entryCallsBeforeSave))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close App.tsx with unsaved changes' })).not.toBeInTheDocument())

    const close = screen.getByRole('button', { name: 'Close App.tsx' })
    expect(close).toBeEnabled()
    await user.click(close)
    expect(screen.queryByRole('tab', { name: 'App.tsx' })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /src\/App.tsx/i }))
    expect(await screen.findByRole('tab', { name: 'App.tsx' })).toBeInTheDocument()

    await act(async () => {
      metadata.resolve({
        root: '/work/project',
        path: 'src',
        entries: [{ ...entries[2], revision: 'entry-after-save' }],
        total: 1,
        offset: 0,
        limit: 500,
        has_more: false
      })
      await metadata.promise
    })
    expect(screen.getByRole('tab', { name: 'App.tsx' })).toBeInTheDocument()
  })

  it('saves and closes a dirty tab without waiting for explorer metadata synchronization', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /src\/App.tsx/i }))

    const editor = await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    await waitFor(() => expect(window.agentsDock.workspace.entries).toHaveBeenCalledWith('chat-a', 'src', 0, 500))
    const metadata = deferred<WorkspaceEntriesPage>()
    vi.mocked(window.agentsDock.workspace.entries).mockImplementationOnce(() => metadata.promise)
    const entryCallsBeforeSave = vi.mocked(window.agentsDock.workspace.entries).mock.calls.length

    await user.type(editor, '// save and close\n')
    await user.click(screen.getByRole('button', { name: 'Close App.tsx with unsaved changes' }))
    await user.click(screen.getByRole('button', { name: 'Save and close' }))

    await waitFor(() => expect(window.agentsDock.workspace.write).toHaveBeenCalledWith(
      'chat-a',
      'src/App.tsx',
      'export const app = true\n// save and close\n',
      'rev-1'
    ))
    await waitFor(() => expect(vi.mocked(window.agentsDock.workspace.entries).mock.calls.length).toBeGreaterThan(entryCallsBeforeSave))
    expect(screen.queryByRole('tab', { name: 'App.tsx' })).not.toBeInTheDocument()

    await act(async () => {
      metadata.resolve({
        root: '/work/project',
        path: 'src',
        entries: [{ ...entries[2], revision: 'entry-after-save' }],
        total: 1,
        offset: 0,
        limit: 500,
        has_more: false
      })
      await metadata.promise
    })
  })

  it('blocks rename while saving and refreshes the explorer revision afterward', async () => {
    const user = userEvent.setup()
    const pendingWrite = deferred<WorkspaceFile>()
    let entryRevision = 'entry-app'
    vi.mocked(window.agentsDock.workspace.entries).mockImplementation((_sessionId, path = '', offset = 0) => Promise.resolve({
      root: '/work/project',
      path,
      entries: path === 'src'
        ? [{ ...entries[2], revision: entryRevision }]
        : path ? [] : entries.slice(0, 2),
      total: path === 'src' ? 1 : path ? 0 : 2,
      offset,
      limit: 500,
      has_more: false
    }))
    vi.mocked(window.agentsDock.workspace.write).mockImplementationOnce(() => pendingWrite.promise)
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    const file = await screen.findByRole('button', { name: 'Open src/App.tsx' })
    const editor = await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    await user.type(editor, '// saved\n')
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(window.agentsDock.workspace.write).toHaveBeenCalledTimes(1))

    fireEvent.contextMenu(file)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename…' }))
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'SavedApp.tsx' } })
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    expect(window.agentsDock.workspace.rename).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Wait for this file operation to finish')

    entryRevision = 'entry-after-save'
    await act(async () => {
      pendingWrite.resolve(workspaceFile('src/App.tsx', '// saved\nexport const app = true\n', 'rev-2'))
      await pendingWrite.promise
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close App.tsx with unsaved changes' })).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(window.agentsDock.workspace.rename).toHaveBeenCalledWith(
      'chat-a',
      'src/App.tsx',
      'SavedApp.tsx',
      'entry-after-save'
    ))
  })

  it('keeps fresh explorer metadata when a refresh supersedes post-save synchronization', async () => {
    const user = userEvent.setup()
    const staleMetadata = deferred<WorkspaceEntriesPage>()
    let sourceDirectoryCalls = 0
    vi.mocked(window.agentsDock.workspace.entries).mockImplementation((_sessionId, path = '', offset = 0) => {
      if (path === 'src') {
        sourceDirectoryCalls += 1
        if (sourceDirectoryCalls === 2) return staleMetadata.promise
        return Promise.resolve({
          root: '/work/project',
          path,
          entries: [{ ...entries[2], revision: sourceDirectoryCalls >= 3 ? 'entry-fresh' : 'entry-app' }],
          total: 1,
          offset,
          limit: 500,
          has_more: false
        })
      }
      return Promise.resolve({
        root: '/work/project',
        path,
        entries: path ? [] : entries.slice(0, 2),
        total: path ? 0 : 2,
        offset,
        limit: 500,
        has_more: false
      })
    })
    renderEditor()
    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'src/App.tsx' }
      }))
    })
    const editor = await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    await user.type(editor, '// saved\n')
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(sourceDirectoryCalls).toBe(2))

    await user.click(screen.getByRole('button', { name: 'Refresh file explorer' }))
    await waitFor(() => expect(sourceDirectoryCalls).toBeGreaterThanOrEqual(3))
    await act(async () => {
      staleMetadata.resolve({
        root: '/work/project',
        path: 'src',
        entries: [{ ...entries[2], revision: 'entry-stale' }],
        total: 1,
        offset: 0,
        limit: 500,
        has_more: false
      })
      await staleMetadata.promise
    })

    const file = await screen.findByRole('button', { name: 'Open src/App.tsx' })
    fireEvent.contextMenu(file)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename…' }))
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'FreshApp.tsx' } })
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(window.agentsDock.workspace.rename).toHaveBeenCalledWith(
      'chat-a',
      'src/App.tsx',
      'FreshApp.tsx',
      'entry-fresh'
    ))
    expect(screen.queryByText(/explorer metadata changed/i)).not.toBeInTheDocument()
  })

  it('keeps a local edit that lands while reload is in flight', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /src\/App\.tsx/i }))
    const editor = await screen.findByRole('textbox', { name: 'Contents of src/App.tsx' })
    expect(editor).not.toHaveAttribute('readonly')

    const reloadRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read).mockImplementationOnce(() => reloadRead.promise)
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(editor).toHaveAttribute('readonly')

    fireEvent.change(editor, { target: { value: 'export const local = true\n' } })
    expect(editor).toHaveValue('export const local = true\n')
    await act(async () => {
      reloadRead.resolve(workspaceFile('src/App.tsx', 'export const disk = true\n', 'rev-2'))
      await reloadRead.promise
    })

    await waitFor(() => expect(editor).toHaveValue('export const local = true\n'))
    expect(screen.getByRole('button', { name: 'Close App.tsx with unsaved changes' })).toBeInTheDocument()
    expect(screen.getByText('Reload finished after this file was edited. Your local changes were kept.')).toBeInTheDocument()
  })

  it('closes a clean file while reload is in flight and ignores the late result', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))

    const reloadRead = deferred<WorkspaceFile>()
    vi.mocked(window.agentsDock.workspace.read).mockImplementationOnce(() => reloadRead.promise)
    await user.click(screen.getByRole('button', { name: 'Reload' }))

    const closeButton = screen.getByRole('button', { name: 'Close README.md' })
    expect(closeButton).toBeEnabled()
    await user.click(closeButton)
    expect(screen.queryByRole('tab', { name: 'README.md' })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    const reopenedEditor = await screen.findByRole('textbox', { name: 'Contents of README.md' })
    await waitFor(() => expect(reopenedEditor).toHaveValue('# Project\n'))

    await act(async () => {
      reloadRead.resolve(workspaceFile('README.md', '# Reloaded\n', 'rev-2'))
      await reloadRead.promise
    })
    expect(screen.getByRole('tab', { name: 'README.md' })).toBeInTheDocument()
    expect(reopenedEditor).toHaveValue('# Project\n')
  })

  it('atomically overwrites and closes a conflicted draft through the profile-pinned service operation', async () => {
    const user = userEvent.setup()
    vi.mocked(window.agentsDock.workspace.write).mockRejectedValueOnce(new Error('File changed on disk. Reload before saving.'))
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README.md/i }))
    const editor = await screen.findByRole('textbox', { name: 'Contents of README.md' })
    await user.type(editor, 'local draft')
    fireEvent.keyDown(window, { key: 's', metaKey: true })

    await screen.findByText('File changed on disk. Reload before saving.')
    expect(editor).toHaveValue('# Project\nlocal draft')
    expect(screen.getByRole('button', { name: 'Close README.md with unsaved changes' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close README.md with unsaved changes' }))
    const overwrite = screen.getByRole('button', { name: 'Overwrite and close' })
    expect(overwrite).toBeEnabled()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('changed on disk')

    await user.click(overwrite)

    await waitFor(() => expect(window.agentsDock.workspace.overwrite).toHaveBeenCalledWith(
      'chat-a',
      'README.md',
      '# Project\nlocal draft'
    ))
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'README.md' })).not.toBeInTheDocument())
  })

  it('keeps a conflicted draft and close dialog actionable when overwrite fails', async () => {
    const user = userEvent.setup()
    vi.mocked(window.agentsDock.workspace.write).mockRejectedValueOnce(new Error('File changed on disk. Reload before saving.'))
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README.md/i }))
    const editor = await screen.findByRole('textbox', { name: 'Contents of README.md' })
    await user.type(editor, 'local draft')
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await screen.findByText('File changed on disk. Reload before saving.')
    await user.click(screen.getByRole('button', { name: 'Close README.md with unsaved changes' }))

    vi.mocked(window.agentsDock.workspace.overwrite).mockRejectedValueOnce(
      new Error('File changed on disk again. Reload before saving.')
    )
    await user.click(screen.getByRole('button', { name: 'Overwrite and close' }))

    const closeDialog = screen.getByRole('alertdialog')
    await waitFor(() => expect(closeDialog).toHaveTextContent('File changed on disk again. Reload before saving.'))
    expect(screen.getByRole('button', { name: 'Overwrite and close' })).toBeEnabled()
    expect(editor).toHaveValue('# Project\nlocal draft')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'README.md' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close README.md with unsaved changes' }))
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('tab', { name: 'README.md' })).not.toBeInTheDocument()
  })

  it('uses the dirty indicator as the accessible dirty-tab close affordance', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README.md/i }))
    await user.type(await screen.findByRole('textbox', { name: 'Contents of README.md' }), 'draft')

    const dirtyCloseButton = screen.getByRole('button', { name: 'Close README.md with unsaved changes' })
    expect(dirtyCloseButton).toHaveTextContent('●')
    expect(dirtyCloseButton.querySelector('.workspace-editor-dirty-dot')).toHaveAttribute('aria-hidden', 'true')
    await user.click(dirtyCloseButton)

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Save changes to README.md?')
  })

  it('closes the owner picker before showing an unsaved-file confirmation', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    const editor = await screen.findByRole('textbox', { name: 'Contents of README.md' })
    await user.type(editor, 'draft')
    editor.focus()
    fireEvent.keyDown(editor, { key: 'o', metaKey: true })
    expect(screen.getByRole('dialog', { name: 'Open workspace file' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Close README.md with unsaved changes' }))

    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Save changes to README.md?')
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1)
  })

  it('does not stack native Cmd+O quick open over an unsaved-file confirmation', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    await user.type(await screen.findByRole('textbox', { name: 'Contents of README.md' }), 'draft')
    await user.click(screen.getByRole('button', { name: 'Close README.md with unsaved changes' }))
    const confirmation = screen.getByRole('alertdialog')
    within(confirmation).getByRole('button', { name: 'Cancel' }).focus()

    let unhandled = true
    act(() => {
      unhandled = window.dispatchEvent(new CustomEvent('agentsdock:quick-open-active-surface', {
        cancelable: true,
        detail: { source: 'workspace-file', sessionId: 'chat-a' }
      }))
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-file', {
        detail: { sessionId: 'chat-a' }
      }))
    })

    expect(unhandled).toBe(false)
    expect(screen.queryByRole('dialog', { name: 'Open workspace file' })).not.toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBeVisible()
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1)
  })

  it('opens and saves complete files above 2 MiB in the editable CodeMirror path', async () => {
    const user = userEvent.setup()
    const header = 'alpha\nbeta target\n'
    const targetBytes = 2 * 1024 * 1024 + 32 * 1024
    const content = `${header}${'x'.repeat(targetBytes - header.length)}`
    expect(new TextEncoder().encode(content)).toHaveLength(targetBytes)
    vi.mocked(window.agentsDock.workspace.read).mockImplementationOnce((_sessionId, path) => Promise.resolve(workspaceFile(path, content)))
    const view = renderEditor('server-a:chat-a', 5, 32 * 1024 * 1024)
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README.md/i }))

    const viewer = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Contents of README.md' })
    expect(viewer).not.toHaveAttribute('readonly')
    expect(view.container.querySelector('[data-code-mirror]')).toBe(viewer)
    expect(view.container.querySelector('.workspace-editor-large-file-viewer')).not.toBeInTheDocument()
    expect(viewer).toHaveAttribute('data-editor-max-bytes', String(32 * 1024 * 1024))
    expect(screen.queryByRole('button', { name: /Read-only|Editing/i })).not.toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', {
        detail: { sessionId: 'chat-a', path: 'README.md', line: 2, column: 3 }
      }))
    })
    await waitFor(() => expect(viewer).toHaveAttribute('data-editor-navigation-line', '2'))
    expect(viewer).toHaveAttribute('data-editor-navigation-column', '3')

    fireEvent.change(viewer, { target: { value: `${content}\nchanged: true` } })
    fireEvent.keyDown(window, { key: 's', metaKey: true })
    await waitFor(() => expect(window.agentsDock.workspace.write).toHaveBeenCalledTimes(1))
    const [sessionId, path, written, revision] = vi.mocked(window.agentsDock.workspace.write).mock.calls[0]
    expect(sessionId).toBe('chat-a')
    expect(path).toBe('README.md')
    expect(written).toHaveLength(content.length + '\nchanged: true'.length)
    expect(written.endsWith('\nchanged: true')).toBe(true)
    expect(revision).toBe('rev-1')
  }, 10_000)

  it('retains a positive server-advertised edit limit without changing file editability', async () => {
    const user = userEvent.setup()
    renderEditor('server-a:chat-a', 5, 4 * 1024 * 1024)
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README.md/i }))

    const editor = await screen.findByRole('textbox', { name: 'Contents of README.md' })
    expect(editor).not.toHaveAttribute('readonly')
    expect(editor).toHaveAttribute('data-editor-max-bytes', String(4 * 1024 * 1024))
  })

  it('treats an explicit zero server-advertised edit limit as unlimited', async () => {
    const user = userEvent.setup()
    renderEditor('server-a:chat-a', 5, 0)
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README.md/i }))

    expect(await screen.findByRole('textbox', { name: 'Contents of README.md' }))
      .toHaveAttribute('data-editor-max-bytes', String(Number.MAX_SAFE_INTEGER))
  })

  it('keeps the legacy 2 MiB edit fallback when an older server omits the capability', async () => {
    const user = userEvent.setup()
    renderEditor('server-a:chat-a', 5, undefined)
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README.md/i }))

    expect(await screen.findByRole('textbox', { name: 'Contents of README.md' }))
      .toHaveAttribute('data-editor-max-bytes', String(2 * 1024 * 1024))
  })

  it('requires an inline decision before closing a dirty tab', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README.md/i }))
    await user.type(await screen.findByRole('textbox', { name: 'Contents of README.md' }), 'draft')
    await user.click(screen.getByRole('button', { name: 'Close README.md with unsaved changes' }))

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Save changes to README.md?')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('tab', { name: /README\.md/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close README.md with unsaved changes' }))
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByRole('tab', { name: 'README.md' })).not.toBeInTheDocument()
  })

  it('protects dirty file tabs when Close is requested from the pinned Chat tab', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))
    await user.type(await screen.findByRole('textbox', { name: 'Contents of README.md' }), 'draft')
    await user.click(screen.getByRole('button', { name: /Chat.*pinned/i }))

    const close = new Event('agentsdock:workspace-close-active', { cancelable: true })
    window.dispatchEvent(close)

    expect(close.defaultPrevented).toBe(true)
    await waitFor(() => expect(screen.getByRole('tab', { name: /README\.md/ })).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Save changes to README.md?')
  })

  it('labels the syntax modes exposed by the lazy editor', () => {
    expect(languageLabel('src/App.tsx')).toBe('TypeScript React')
    expect(languageLabel('Dockerfile.dev')).toBe('Dockerfile')
    expect(languageLabel('config.yaml')).toBe('YAML')
    expect(languageLabel('notes.unknown')).toBe('Plain text')
  })

  it('keeps focused open tabs ahead of loaded and remote quick-open results', () => {
    const open = [
      { name: 'alpha.ts', path: 'src/alpha.ts', kind: 'file' as const },
      { name: 'beta.ts', path: 'src/beta.ts', kind: 'file' as const }
    ]
    const known = [
      { name: 'ignored-beta.ts', path: 'outputs/ignored-beta.ts', kind: 'file' as const }
    ]
    const remote = [
      { name: 'beta.ts', path: 'src/beta.ts', kind: 'file' as const },
      { name: 'remote-beta.ts', path: 'packages/remote-beta.ts', kind: 'file' as const }
    ]

    expect(mergeWorkspacePaletteEntries(open, known, remote, 'beta', 'src/beta.ts'))
      .toEqual([
        open[1],
        remote[1],
        known[0]
      ])
  })

  it('persists live editor theme and font size choices', async () => {
    const user = userEvent.setup()
    renderEditor()
    fireEvent.keyDown(window, { key: 'o', metaKey: true })
    await user.click(await screen.findByRole('option', { name: /README\.md/i }))

    const editor = await screen.findByRole('textbox', { name: 'Contents of README.md' })
    expect(editor).toHaveAttribute('data-editor-theme', 'app')
    expect(editor).toHaveAttribute('data-editor-font-size', '13')
    expect(screen.getByRole('combobox', { name: 'Editor color theme' })).toHaveValue('app')
    expect(screen.getByRole('option', { name: 'Match app' })).toBeInTheDocument()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Editor color theme' }), 'github-light')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Editor font size' }), '17')

    expect(editor).toHaveAttribute('data-editor-theme', 'github-light')
    expect(editor).toHaveAttribute('data-editor-font-size', '17')
    expect(JSON.parse(window.localStorage.getItem(EDITOR_APPEARANCE_STORAGE_KEY) ?? '')).toEqual({
      theme: 'github-light',
      fontSize: 17
    })
  })
})
