import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { WorkspaceGitStatus } from '@shared/workspace-git'
import { setLocale } from '@shared/i18n'
import { WorkspaceChanges } from './WorkspaceChanges'

vi.mock('react-virtuoso', () => ({ Virtuoso: ({ data, itemContent }: { data: unknown[]; itemContent: (index: number, item: unknown) => React.ReactNode }) => <div>{data.map((item, index) => <div key={index}>{itemContent(index, item)}</div>)}</div> }))

const scope = { profileId: 'server-a', profileGeneration: 1, serverIdentity: 'identity-a' }
const modified = { path: 'app.ts', index_status: ' ', worktree_status: 'M', staged: false, unstaged: true, untracked: false, conflicted: false }
const initial: WorkspaceGitStatus = { root: '/workspace/project', branch: 'main', head: 'abc', revision: 'rev-1', operation: null, files: [modified], staged_count: 0, conflict_count: 0 }
const git = { status: vi.fn(), diff: vi.fn(), conflict: vi.fn(), action: vi.fn() }

beforeEach(() => {
  setLocale('en')
  Object.values(git).forEach(mock => mock.mockReset())
  git.status.mockResolvedValue(initial)
  git.diff.mockImplementation((_scope, _session, path, view) => Promise.resolve({ path, view, diff: '--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new', revision: 'rev-1', binary: false, truncated: false }))
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { workspaceGit: git } as unknown as AgentsDockAPI })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Workspace changes', () => {
  it('loads on activation and stages then commits through scoped revision-checked actions', async () => {
    const view = render(<WorkspaceChanges scope={scope} sessionId="chat-a" active={false} />)
    expect(git.status).not.toHaveBeenCalled()
    view.rerender(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    await screen.findByRole('button', { name: 'Stage app.ts' })
    expect(git.diff).not.toHaveBeenCalled()
    const staged = { ...initial, revision: 'rev-2', staged_count: 1, files: [{ ...modified, staged: true, unstaged: false, index_status: 'M', worktree_status: ' ' }] }
    git.action.mockResolvedValueOnce(staged)
    fireEvent.click(screen.getByRole('button', { name: 'Stage app.ts' }))
    await screen.findByRole('button', { name: 'Unstage app.ts' })
    expect(git.action).toHaveBeenLastCalledWith(scope, 'chat-a', { action: 'stage', paths: ['app.ts'], expected_revision: 'rev-1' })
    fireEvent.click(screen.getByRole('button', { name: 'Review commit' }))
    await screen.findByText('+new')
    expect(git.diff).toHaveBeenLastCalledWith(scope, 'chat-a', 'app.ts', 'staged')
    const reads = git.status.mock.calls.length
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'Fix app' } })
    expect(git.status).toHaveBeenCalledTimes(reads)
    git.action.mockResolvedValueOnce({ ...staged, revision: 'rev-3', files: [], staged_count: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }))
    await screen.findByText('Changes committed.')
    expect(git.action).toHaveBeenLastCalledWith(scope, 'chat-a', { action: 'commit', message: 'Fix app', expected_revision: 'rev-2' })
  })

  it('ignores a late snapshot after changing profile ownership', async () => {
    let resolve!: (status: WorkspaceGitStatus) => void
    git.status.mockReturnValueOnce(new Promise<WorkspaceGitStatus>(done => { resolve = done }))
    const view = render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    const otherScope = { ...scope, profileId: 'server-b', profileGeneration: 2 }
    git.status.mockResolvedValueOnce({ ...initial, root: '/workspace/other', branch: 'other-branch', files: [] })
    view.rerender(<WorkspaceChanges scope={otherScope} sessionId="chat-b" />)
    await screen.findByText('other-branch')
    await act(async () => resolve(initial))
    expect(screen.queryByText('main')).not.toBeInTheDocument()
    expect(git.status).toHaveBeenLastCalledWith(otherScope, 'chat-b')
  })

  it('preserves a conflict draft on refresh and prevents saving it against a newer repository revision', async () => {
    const conflicted = { ...initial, operation: 'merge' as const, conflict_count: 1, files: [{ ...modified, conflicted: true, index_status: 'U', worktree_status: 'U' }] }
    git.status.mockResolvedValue(conflicted)
    git.conflict.mockResolvedValue({ path: 'app.ts', base: 'base', ours: 'current', theirs: 'incoming', result: '<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> incoming', binary: false, revision: 'rev-1' })
    render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    fireEvent.click(await screen.findByRole('button', { name: /app.ts/ }))
    fireEvent.change(await screen.findByLabelText('Resolved result'), { target: { value: 'my resolution' } })
    git.status.mockResolvedValueOnce({ ...conflicted, revision: 'rev-2' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh changes' }))
    await screen.findByText(/The repository changed/)
    expect(screen.getByLabelText('Resolved result')).toHaveValue('my resolution')
    expect(screen.getByRole('button', { name: 'Save resolution' })).toBeDisabled()
    expect(git.conflict).toHaveBeenCalledTimes(1)
    expect(git.action).not.toHaveBeenCalled()
  })

  it('requires an explicit abort confirmation and sends confirmed authority once', async () => {
    git.status.mockResolvedValue({ ...initial, operation: 'merge' })
    git.action.mockResolvedValue({ ...initial, revision: 'rev-2' })
    render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Abort merge' }))
    expect(git.action).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(git.action).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Abort merge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Abort operation' }))
    await waitFor(() => expect(git.action).toHaveBeenCalledExactlyOnceWith(scope, 'chat-a', { action: 'abort', confirmed: true, expected_revision: 'rev-1' }))
    await screen.findByText('Operation aborted.')
  })

  it('keeps a rebase open when continuing reaches the next conflict', async () => {
    git.status.mockResolvedValue({ ...initial, operation: 'rebase', files: [] })
    git.action.mockResolvedValue({ ...initial, revision: 'rev-2', operation: 'rebase', conflict_count: 1, files: [{ ...modified, conflicted: true }] })
    render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue rebase' }))
    await screen.findByText('More conflicts to resolve.')
    expect(screen.queryByText('Operation completed.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue rebase' })).toBeDisabled()
  })
})
