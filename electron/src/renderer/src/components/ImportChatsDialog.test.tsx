import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import type { BulkImportSessionResult, Health, LocalSessionCandidate } from '@shared/types'
import { trackEvent } from '../lib/analytics'
import { useAppStore } from '../store/app-store'
import { ImportChatsDialog } from './Dialogs'

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }))

const supportedHealth: Health = {
  ok: true,
  api_contract_version: 15,
  capabilities: {
    local_session_import_v1: {
      available: true,
      required: false,
      message: '',
      action: null,
      version: 1,
      max_batch_items: 25,
      max_list_items: 500
    }
  }
}

// Folderless candidates render a single flat, always-expanded list, which
// keeps the import-flow tests focused on selection/import rather than folder
// collapsing. The grouping/collapse tests use their own foldered fixture.
const candidates: LocalSessionCandidate[] = [
  { provider_session_id: 'shared-id', backend: 'claude', label: 'Claude chat', updated_at: '2026-08-01T00:00:00Z', cwd: null },
  { provider_session_id: 'shared-id', backend: 'codex', label: 'Codex chat', updated_at: '2026-08-02T00:00:00Z', cwd: null }
]
const folderedCandidates: LocalSessionCandidate[] = [
  { provider_session_id: 'shared-id', backend: 'claude', label: 'Claude chat', updated_at: '2026-08-01T00:00:00Z', cwd: '/work/a' },
  { provider_session_id: 'shared-id', backend: 'codex', label: 'Codex chat', updated_at: '2026-08-02T00:00:00Z', cwd: '/work/b' }
]
const originalRefreshSessions = useAppStore.getState().refreshSessions
const originalSelectSession = useAppStore.getState().selectSession

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

describe('ImportChatsDialog', () => {
  beforeEach(() => {
    setLocale('en')
    vi.clearAllMocks()
    useAppStore.setState({
      profiles: [{
        id: 'profile-a',
        name: 'Alpha',
        serverUrl: 'http://alpha.example:7850',
        serverIdentity: 'server-a',
        hasAccessToken: true,
        serverSetupComplete: true,
        connectionState: 'online',
        cachedUnreadCount: 0
      }],
      activeProfileId: 'profile-a',
      profileGeneration: 1,
      health: supportedHealth,
      runtimeCatalog: null,
      sessions: [],
      selectedSessionId: null,
      refreshSessions: originalRefreshSessions,
      selectSession: originalSelectSession,
      error: null,
      modals: {
        settings: false,
        newChat: false,
        resume: false,
        folder: false,
        digest: false,
        job: false,
        search: false,
        review: false,
        importChats: true
      }
    })
  })

  afterEach(() => {
    cleanup()
    setLocale('en')
    useAppStore.setState({ refreshSessions: originalRefreshSessions, selectSession: originalSelectSession })
  })

  it('preserves an unsubmitted session ID and loaded history when language changes', async () => {
    const listLocal = vi.fn().mockResolvedValue(candidates)
    const bulkImport = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal, bulkImport } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)
    await screen.findByText('Codex chat')
    const input = screen.getByRole('textbox', { name: 'Session ID' })
    await user.type(input, 'unsubmitted-id')
    act(() => setLocale('zh-CN'))
    expect(input).toHaveValue('unsubmitted-id')
    expect(screen.getByText('Codex chat')).toBeInTheDocument()
    expect(listLocal).toHaveBeenCalledTimes(1)
    expect(bulkImport).not.toHaveBeenCalled()
    act(() => setLocale('en'))
    expect(screen.getByRole('textbox', { name: 'Session ID' })).toBe(input)
    expect(input).toHaveValue('unsubmitted-id')
    expect(listLocal).toHaveBeenCalledTimes(1)
  })

  it('resumes a discovered session ID inline with its original agent and working directory', async () => {
    const candidate = folderedCandidates[1]
    const listLocal = vi.fn().mockResolvedValue([candidate])
    const bulkImport = vi.fn().mockResolvedValue([{
      provider_session_id: candidate.provider_session_id,
      backend: candidate.backend,
      session_id: 'imported-chat',
      ok: true,
      imported: 4
    }])
    const refreshSessions = vi.fn().mockResolvedValue(undefined)
    const selectSession = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal, bulkImport } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ refreshSessions, selectSession })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    await screen.findByText('Codex chat')
    await user.type(screen.getByRole('textbox', { name: 'Session ID' }), candidate.provider_session_id)
    await user.click(screen.getByRole('button', { name: 'Resume' }))

    await waitFor(() => expect(bulkImport).toHaveBeenCalledWith([{
      provider_session_id: candidate.provider_session_id,
      backend: 'codex',
      cwd: '/work/b'
    }]))
    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('imported-chat'))
    expect(useAppStore.getState().modals.importChats).toBe(false)
    expect(useAppStore.getState().modals.resume).toBe(false)
  })

  it('keeps an unknown session ID inline and asks only for its agent and working directory', async () => {
    const listLocal = vi.fn().mockResolvedValue([])
    const resume = vi.fn().mockResolvedValue({ id: 'resumed-chat', title: 'Resumed Codex', backend: 'codex' })
    const refreshSessions = vi.fn().mockResolvedValue(undefined)
    const selectSession = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal, resume } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ refreshSessions, selectSession })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    await screen.findByText('No un-imported local chats found.')
    await user.type(screen.getByRole('textbox', { name: 'Session ID' }), 'external-thread-id')
    await user.click(screen.getByRole('button', { name: 'Resume' }))

    expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveValue('codex')
    await user.type(screen.getByRole('textbox', { name: 'Working directory' }), '/work/project')
    await user.click(screen.getByRole('button', { name: 'Resume' }))

    await waitFor(() => expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'external-thread-id',
      backend: 'codex',
      cwd: '/work/project'
    })))
    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('resumed-chat'))
    expect(useAppStore.getState().modals.importChats).toBe(false)
    expect(useAppStore.getState().modals.resume).toBe(false)
  })

  it('does not call local import routes without API 15 and the version-1 capability', async () => {
    const listLocal = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ health: { ok: true, api_contract_version: 15 } })

    render(<ImportChatsDialog />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/requires AgentsServer API 15/i)
    expect(listLocal).not.toHaveBeenCalled()
  })

  it('keeps explicit per-item failures retryable and emits no success analytics', async () => {
    const failures: BulkImportSessionResult[] = candidates.map(candidate => ({
      provider_session_id: candidate.provider_session_id,
      backend: candidate.backend,
      session_id: null,
      ok: false,
      imported: 0,
      code: 'empty_transcript',
      error: 'No importable messages were found.'
    }))
    const listLocal = vi.fn().mockResolvedValue(candidates)
    const bulkImport = vi.fn().mockResolvedValue(failures)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal, bulkImport } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    await screen.findByText('Claude chat')
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    await user.click(screen.getByRole('button', { name: 'Import 2' }))

    await waitFor(() => expect(bulkImport).toHaveBeenCalledWith([
      { provider_session_id: 'shared-id', backend: 'claude', cwd: null },
      { provider_session_id: 'shared-id', backend: 'codex', cwd: null }
    ]))
    await waitFor(() => expect(listLocal).toHaveBeenCalledTimes(2))
    expect(trackEvent).not.toHaveBeenCalled()
    expect(screen.getByText('Claude chat')).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getAllByRole('checkbox').every(checkbox => !checkbox.hasAttribute('disabled'))).toBe(true)
  })

  it('groups foldered candidates by working directory, collapsed by default', async () => {
    const listLocal = vi.fn().mockResolvedValue(folderedCandidates)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    // Folder headers show by leaf name; the chats inside start collapsed.
    const folderA = (await screen.findByTitle('/work/a')).closest('button') as HTMLElement
    const folderB = (screen.getByTitle('/work/b')).closest('button') as HTMLElement
    expect(folderA).toHaveTextContent('a')
    expect(folderB).toHaveTextContent('b')
    await waitFor(() => expect(folderA).toHaveAttribute('aria-expanded', 'false'))
    expect(screen.queryByText('Claude chat')).not.toBeInTheDocument()

    // Expanding a folder reveals only its own chat.
    await user.click(folderB)
    expect(within(folderB.closest('.import-chats-group') as HTMLElement).getByText('Codex chat')).toBeInTheDocument()
    expect(screen.queryByText('Claude chat')).not.toBeInTheDocument()
  })

  it('collapses and re-expands a folder group from its header', async () => {
    const listLocal = vi.fn().mockResolvedValue(folderedCandidates)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    const folderA = (await screen.findByTitle('/work/a')).closest('button') as HTMLElement
    await waitFor(() => expect(folderA).toHaveAttribute('aria-expanded', 'false'))

    await user.click(folderA)
    expect(folderA).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Claude chat')).toBeInTheDocument()

    await user.click(folderA)
    expect(folderA).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Claude chat')).not.toBeInTheDocument()
  })

  it('summarizes how many chats were sorted into folders', async () => {
    const listLocal = vi.fn().mockResolvedValue(folderedCandidates)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal } } as unknown as AgentsDockAPI
    })
    render(<ImportChatsDialog />)

    expect(await screen.findByText(/sorted into/)).toHaveTextContent('2 chats sorted into 2 folders · 0 selected')
  })

  it('tracks a real partial success once and removes only the imported identity', async () => {
    const outcome: BulkImportSessionResult[] = [
      { provider_session_id: 'shared-id', backend: 'claude', session_id: 'chat-imported', ok: true, imported: 4 },
      { provider_session_id: 'shared-id', backend: 'codex', session_id: null, ok: false, imported: 0, code: 'empty_transcript', error: 'No messages.' }
    ]
    const listLocal = vi.fn()
      .mockResolvedValueOnce(candidates)
      .mockResolvedValueOnce([candidates[1]])
    const bulkImport = vi.fn().mockResolvedValue(outcome)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal, bulkImport } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    await screen.findByText('Claude chat')
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    await user.click(screen.getByRole('button', { name: 'Import 2' }))

    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('chats_bulk_imported', { success: true }))
    await waitFor(() => expect(screen.queryByText('Claude chat')).not.toBeInTheDocument())
    expect(screen.getByText('Codex chat')).toBeInTheDocument()
    expect(useAppStore.getState().modals.importChats).toBe(true)
  })

  it('keeps acknowledged success and analytics truthful when the post-import rescan fails', async () => {
    const outcome: BulkImportSessionResult[] = [
      { provider_session_id: 'shared-id', backend: 'claude', session_id: 'chat-imported', ok: true, imported: 4 },
      { provider_session_id: 'shared-id', backend: 'codex', session_id: null, ok: false, imported: 0, code: 'empty_transcript', error: 'No messages.' }
    ]
    const listLocal = vi.fn()
      .mockResolvedValueOnce(candidates)
      .mockRejectedValueOnce(new Error('rescan unavailable'))
    const bulkImport = vi.fn().mockResolvedValue(outcome)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal, bulkImport } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    await screen.findByText('Claude chat')
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    await user.click(screen.getByRole('button', { name: 'Import 2' }))

    await waitFor(() => expect(listLocal).toHaveBeenCalledTimes(2))
    expect(trackEvent).toHaveBeenCalledTimes(1)
    expect(trackEvent).toHaveBeenCalledWith('chats_bulk_imported', { success: true })
    expect(screen.queryByText('Claude chat')).not.toBeInTheDocument()
    expect(screen.getByText('Codex chat')).toBeInTheDocument()
    expect(useAppStore.getState().modals.importChats).toBe(true)
  })

  it('blocks an unknown attempted item but keeps an explicitly unattempted item retryable', async () => {
    const threeCandidates: LocalSessionCandidate[] = [
      candidates[0],
      candidates[1],
      { provider_session_id: 'not-attempted-id', backend: 'claude', label: 'Not attempted chat', updated_at: '2026-08-03T00:00:00Z', cwd: null }
    ]
    const outcome: BulkImportSessionResult[] = [
      { provider_session_id: 'shared-id', backend: 'claude', session_id: 'chat-imported', ok: true, imported: 4 },
      { provider_session_id: 'shared-id', backend: 'codex', session_id: null, ok: false, imported: 0, code: 'client_status_unknown', error: 'Re-scan before retrying.' },
      { provider_session_id: 'not-attempted-id', backend: 'claude', session_id: null, ok: false, imported: 0, code: 'client_not_attempted', error: 'Not attempted. Re-scan, then retry.' }
    ]
    const listLocal = vi.fn()
      .mockResolvedValueOnce(threeCandidates)
      .mockRejectedValueOnce(new Error('rescan unavailable'))
    const bulkImport = vi.fn().mockResolvedValue(outcome)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal, bulkImport } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    await screen.findByText('Not attempted chat')
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    await user.click(screen.getByRole('button', { name: 'Import 3' }))

    await waitFor(() => expect(listLocal).toHaveBeenCalledTimes(2))
    const unknownRow = screen.getByText('Codex chat').closest('li')!
    const notAttemptedRow = screen.getByText('Not attempted chat').closest('li')!
    expect(within(unknownRow).getByRole('checkbox')).toBeDisabled()
    expect(within(notAttemptedRow).getByRole('checkbox')).toBeEnabled()
    expect(trackEvent).toHaveBeenCalledTimes(1)
    expect(trackEvent).toHaveBeenCalledWith('chats_bulk_imported', { success: true })
  })

  it('ignores a delayed bulk result after switching to another server scope', async () => {
    const pending = deferred<BulkImportSessionResult[]>()
    const listLocal = vi.fn()
      .mockResolvedValueOnce(candidates)
      .mockResolvedValueOnce([])
    const bulkImport = vi.fn(() => pending.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal, bulkImport } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    await screen.findByText('Claude chat')
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    await user.click(screen.getByRole('button', { name: 'Import 2' }))
    await waitFor(() => expect(bulkImport).toHaveBeenCalledOnce())

    act(() => {
      useAppStore.setState({
        profiles: [
          ...useAppStore.getState().profiles,
          {
            id: 'profile-b',
            name: 'Beta',
            serverUrl: 'http://beta.example:7850',
            serverIdentity: 'server-b',
            hasAccessToken: true,
            serverSetupComplete: true,
            connectionState: 'online',
            cachedUnreadCount: 0
          }
        ],
        activeProfileId: 'profile-b',
        profileGeneration: 2,
        health: supportedHealth
      })
    })
    await waitFor(() => expect(listLocal).toHaveBeenCalledTimes(2))
    await act(async () => {
      pending.resolve([
        { provider_session_id: 'shared-id', backend: 'claude', session_id: 'old-chat-a', ok: true, imported: 2 },
        { provider_session_id: 'shared-id', backend: 'codex', session_id: 'old-chat-b', ok: true, imported: 2 }
      ])
      await pending.promise
    })

    expect(await screen.findByText('No un-imported local chats found.')).toBeInTheDocument()
    await waitFor(() => expect(trackEvent).not.toHaveBeenCalled())
    expect(useAppStore.getState().modals.importChats).toBe(true)
    expect(useAppStore.getState().error).toBeNull()
  })

  it('invalidates delayed work when the dialog closes and reopens on the same server', async () => {
    const pending = deferred<BulkImportSessionResult[]>()
    const listLocal = vi.fn()
      .mockResolvedValueOnce(candidates)
      .mockResolvedValueOnce(candidates)
    const bulkImport = vi.fn(() => pending.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal, bulkImport } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    await screen.findByText('Claude chat')
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    await user.click(screen.getByRole('button', { name: 'Import 2' }))
    await waitFor(() => expect(bulkImport).toHaveBeenCalledOnce())
    await user.click(screen.getByRole('button', { name: 'Close' }))
    act(() => { useAppStore.getState().setModal('importChats', true) })
    await waitFor(() => expect(listLocal).toHaveBeenCalledTimes(2))

    await act(async () => {
      pending.resolve([
        { provider_session_id: 'shared-id', backend: 'claude', session_id: 'old-chat-a', ok: true, imported: 2 },
        { provider_session_id: 'shared-id', backend: 'codex', session_id: 'old-chat-b', ok: true, imported: 2 }
      ])
      await pending.promise
    })

    expect(await screen.findByText('Claude chat')).toBeInTheDocument()
    expect(useAppStore.getState().modals.importChats).toBe(true)
    expect(trackEvent).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('ignores a delayed rescan after the capability becomes unavailable', async () => {
    const pendingRescan = deferred<LocalSessionCandidate[]>()
    const outcome: BulkImportSessionResult[] = [
      { provider_session_id: 'shared-id', backend: 'claude', session_id: 'chat-imported', ok: true, imported: 2 },
      { provider_session_id: 'shared-id', backend: 'codex', session_id: null, ok: false, imported: 0, code: 'empty_transcript', error: 'No messages.' }
    ]
    const listLocal = vi.fn()
      .mockResolvedValueOnce(candidates)
      .mockImplementationOnce(() => pendingRescan.promise)
    const bulkImport = vi.fn().mockResolvedValue(outcome)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal, bulkImport } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    await screen.findByText('Claude chat')
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    await user.click(screen.getByRole('button', { name: 'Import 2' }))
    await waitFor(() => expect(listLocal).toHaveBeenCalledTimes(2))
    expect(trackEvent).toHaveBeenCalledTimes(1)

    act(() => { useAppStore.setState({ health: { ok: true, api_contract_version: 14 } }) })
    expect(await screen.findByRole('alert')).toHaveTextContent(/requires AgentsServer API 15/i)
    await act(async () => {
      pendingRescan.resolve(candidates)
      await pendingRescan.promise
    })

    await waitFor(() => expect(screen.queryByText('Claude chat')).not.toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent(/requires AgentsServer API 15/i)
    expect(trackEvent).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().modals.importChats).toBe(true)
    expect(useAppStore.getState().error).toBeNull()
  })

  it('locks resume controls while a bulk import is in progress', async () => {
    const pending = deferred<BulkImportSessionResult[]>()
    const listLocal = vi.fn().mockResolvedValue(candidates)
    const bulkImport = vi.fn(() => pending.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal, bulkImport } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    await screen.findByText('Claude chat')
    const resumeInput = screen.getByRole('textbox', { name: 'Session ID' })
    await user.type(resumeInput, 'external-thread-id')
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    expect(screen.getByRole('combobox', { name: 'Agent' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Select all' }))
    await user.click(screen.getByRole('button', { name: 'Import 2' }))
    await waitFor(() => expect(bulkImport).toHaveBeenCalledOnce())

    act(() => setLocale('zh-CN'))
    expect(resumeInput).toBeDisabled()
    expect(resumeInput).toHaveValue('external-thread-id')
    expect(screen.getByRole('button', { name: '导入' })).toBeDisabled()
    expect(listLocal).toHaveBeenCalledOnce()
    act(() => setLocale('en'))

    expect(resumeInput).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Agent' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Working directory' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Select all' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Select none' })).toBeDisabled()
    expect(screen.getAllByRole('checkbox').every(checkbox => checkbox.hasAttribute('disabled'))).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    expect(bulkImport).toHaveBeenCalledOnce()

    await act(async () => {
      pending.resolve(candidates.map(candidate => ({
        provider_session_id: candidate.provider_session_id,
        backend: candidate.backend,
        session_id: null,
        ok: false,
        imported: 0,
        code: 'empty_transcript',
        error: 'No messages.'
      })))
      await pending.promise
    })
    await waitFor(() => expect(resumeInput).toBeEnabled())
  })

  it('locks bulk-import controls while a session ID resume is in progress', async () => {
    const candidate = candidates[0]
    const pending = deferred<BulkImportSessionResult[]>()
    const listLocal = vi.fn().mockResolvedValue([candidate])
    const bulkImport = vi.fn(() => pending.promise)
    const refreshSessions = vi.fn().mockResolvedValue(undefined)
    const selectSession = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { listLocal, bulkImport } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ refreshSessions, selectSession })
    const user = userEvent.setup()
    render(<ImportChatsDialog />)

    await screen.findByText('Claude chat')
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    await user.type(screen.getByRole('textbox', { name: 'Session ID' }), candidate.provider_session_id)
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(bulkImport).toHaveBeenCalledOnce())

    act(() => setLocale('zh-CN'))
    expect(screen.getByRole('button', { name: '导入 1 个会话' })).toBeDisabled()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(listLocal).toHaveBeenCalledOnce()
    act(() => setLocale('en'))

    expect(screen.getByRole('button', { name: 'Import 1' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Select all' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Select none' })).toBeDisabled()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Import 1' }))
    expect(bulkImport).toHaveBeenCalledOnce()

    await act(async () => {
      pending.resolve([{
        provider_session_id: candidate.provider_session_id,
        backend: candidate.backend,
        session_id: 'resumed-chat',
        ok: true,
        imported: 3
      }])
      await pending.promise
    })
    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('resumed-chat'))
  })
})
