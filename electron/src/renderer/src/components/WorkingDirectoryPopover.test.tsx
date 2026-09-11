import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { WorkingDirectoryCompletion } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { WorkingDirectoryPopover } from './WorkingDirectoryPopover'

const realUpdateSession = useAppStore.getState().updateSession

function completion(path: string, children: string[]): WorkingDirectoryCompletion {
  return {
    input: path,
    resolved_path: path,
    exists: true,
    base_path: path,
    suggestions: children.map(name => ({ name, path: `${path}/${name}` })),
    truncated: false,
    message: null
  }
}

describe('WorkingDirectoryPopover', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useAppStore.setState({ updateSession: realUpdateSession })
  })

  it('loads typed paths automatically and treats Return as Choose', async () => {
    const complete = vi.fn(async (path: string) => path === '/srv/pasted'
      ? completion(path, ['nested'])
      : path === '/srv/automatic'
        ? completion(path, ['detected'])
        : completion(path, path === '/srv' ? ['project'] : []))
    const updateSession = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      health: {
        ok: true,
        default_cwd: '/srv',
        capabilities: {
          working_directory_completion: { available: true, required: false, message: '', action: null }
        }
      },
      updateSession
    })
    const user = userEvent.setup()
    render(<WorkingDirectoryPopover session={{ id: 'chat-1', title: 'Chat', backend: 'codex', cwd: '/srv' }} />)

    await user.click(screen.getByRole('button', { name: 'Working directory: /srv' }))
    const path = await screen.findByRole('textbox', { name: 'Folder path' })
    expect(path).toHaveValue('/srv')
    expect(screen.queryByRole('button', { name: 'Open path' })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Open project' })).toBeVisible()

    await user.clear(path)
    await user.paste('/srv/pasted')
    expect(screen.getByRole('button', { name: 'Choose' })).toBeDisabled()
    expect(updateSession).not.toHaveBeenCalled()

    await user.keyboard('{Enter}')
    await waitFor(() => expect(complete).toHaveBeenCalledWith('/srv/pasted', 50))
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith('chat-1', { cwd: '/srv/pasted' }))
    expect(screen.queryByRole('textbox', { name: 'Folder path' })).not.toBeInTheDocument()

    updateSession.mockClear()
    await user.click(screen.getByRole('button', { name: 'Working directory: /srv' }))
    const reopenedPath = await screen.findByRole('textbox', { name: 'Folder path' })
    await user.clear(reopenedPath)
    await user.paste('/srv/automatic')
    expect(await screen.findByRole('button', { name: 'Open detected' })).toBeVisible()
    expect(reopenedPath).toHaveValue('/srv/automatic')
    expect(updateSession).not.toHaveBeenCalled()

    await user.keyboard('{Enter}')
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith('chat-1', { cwd: '/srv/automatic' }))
    expect(screen.queryByRole('textbox', { name: 'Folder path' })).not.toBeInTheDocument()
  })

  it('uses the leading folder control to return to the parent directory', async () => {
    const complete = vi.fn(async (path: string) => completion(path, path === '/srv/work' ? ['nested'] : path === '/srv' ? ['work'] : ['srv']))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      health: {
        ok: true,
        default_cwd: '/srv',
        capabilities: {
          working_directory_completion: { available: true, required: false, message: '', action: null }
        }
      }
    })
    const user = userEvent.setup()
    render(<WorkingDirectoryPopover session={{ id: 'chat-1', title: 'Chat', backend: 'codex', cwd: '/srv/work' }} />)

    await user.click(screen.getByRole('button', { name: 'Working directory: /srv/work' }))
    const parent = await screen.findByRole('button', { name: 'Go to parent folder' })
    expect(parent).toBeEnabled()

    await user.click(parent)
    await waitFor(() => expect(complete).toHaveBeenCalledWith('/srv', 50))
    expect(screen.getByRole('textbox', { name: 'Folder path' })).toHaveValue('/srv')

    await user.click(parent)
    await waitFor(() => expect(complete).toHaveBeenCalledWith('/', 50))
    expect(screen.getByRole('textbox', { name: 'Folder path' })).toHaveValue('/')
    expect(parent).toBeDisabled()
  })
})
