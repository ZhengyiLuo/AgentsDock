import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { WorkingDirectoryCompletion } from '@shared/types'
import { WorkingDirectoryInput } from './WorkingDirectoryInput'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}

function completion(input: string, names: string[], exists = false): WorkingDirectoryCompletion {
  const base = input.endsWith('/') ? input.slice(0, -1) : input
  return {
    input,
    resolved_path: input,
    exists,
    base_path: base,
    suggestions: names.map(name => ({ name, path: `${base}/${name}/` })),
    truncated: false,
    message: null
  }
}

function Harness({ available = true, onCommit, showBrowseButton = false }: { available?: boolean; onCommit?: (value: string) => void; showBrowseButton?: boolean }) {
  const [value, setValue] = useState('/srv/work')
  return <WorkingDirectoryInput value={value} onChange={setValue} onCommit={onCommit} defaultCwd="/srv/work" available={available} showBrowseButton={showBrowseButton} />
}

describe('WorkingDirectoryInput', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows server folders on focus and completes the highlighted path with Tab', async () => {
    const complete = vi.fn(async (path: string) => completion(path, ['alpha', 'beta'], path === '/srv/work'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Harness />)

    const input = screen.getByRole('combobox', { name: 'Working directory' })
    await user.click(input)
    expect(await screen.findByText('Folder found')).toBeInTheDocument()
    expect(screen.getByRole('listbox', { name: 'Folders on the active server' })).toBeInTheDocument()

    await user.keyboard('{Tab}')

    expect(input).toHaveValue('/srv/work/alpha/')
    await waitFor(() => expect(complete).toHaveBeenLastCalledWith('/srv/work/alpha/', 24))
  })

  it('opens a server-folder picker, navigates children, and applies only an explicitly chosen folder', async () => {
    const complete = vi.fn(async (path: string) => path === '/srv/work'
      ? completion(path, ['alpha'], true)
      : path === '/srv/work/alpha/'
        ? completion(path, ['nested'], true)
        : completion(path, [], true))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Harness showBrowseButton />)

    const input = screen.getByRole('combobox', { name: 'Working directory' })
    const browse = screen.getByRole('button', { name: 'Browse folders on active server' })
    expect(browse).toHaveAttribute('type', 'button')
    expect(browse).toHaveAttribute('aria-haspopup', 'dialog')

    await user.click(browse)

    expect(browse).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('dialog', { name: 'Browse server folders' })).toBeVisible()
    expect(await screen.findByText('/srv/work')).toBeVisible()
    await user.click(await screen.findByRole('button', { name: 'Open folder alpha' }))
    expect(input).toHaveValue('/srv/work')
    expect(await screen.findByText('/srv/work/alpha/')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Use this folder' }))

    expect(input).toHaveValue('/srv/work/alpha/')
    expect(screen.queryByRole('dialog', { name: 'Browse server folders' })).not.toBeInTheDocument()
    expect(complete).toHaveBeenCalledWith('/srv/work/alpha/', 50)
  })

  it('navigates up and cancels without changing the working directory', async () => {
    const complete = vi.fn(async (path: string) => path === '/srv/work'
      ? completion(path, ['alpha'], true)
      : completion(path, [], true))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Harness showBrowseButton />)

    await user.click(screen.getByRole('button', { name: 'Browse folders on active server' }))
    await user.click(await screen.findByRole('button', { name: 'Open folder alpha' }))
    await screen.findByText('/srv/work/alpha/')
    await user.click(screen.getByRole('button', { name: 'Go to parent folder' }))
    await waitFor(() => expect(complete).toHaveBeenCalledWith('/srv/work', 50))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('combobox', { name: 'Working directory' })).toHaveValue('/srv/work')
    expect(screen.queryByRole('dialog', { name: 'Browse server folders' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Browse folders on active server' })).toHaveFocus()
  })

  it('shows server-folder loading, error, retry, and empty states and closes with Escape', async () => {
    const first = deferred<WorkingDirectoryCompletion>()
    const complete = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error('Server folder lookup failed'))
      .mockResolvedValueOnce(completion('/srv/work', [], true))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Harness showBrowseButton />)

    await user.click(screen.getByRole('button', { name: 'Browse folders on active server' }))
    expect(screen.getByText('Loading folders…')).toBeVisible()
    first.resolve(completion('/srv/work', [], true))
    expect(await screen.findByText('No folders inside this directory.')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Browse folders on active server' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Server folder lookup failed')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No folders inside this directory.')).toBeVisible()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Browse server folders' })).not.toBeInTheDocument()
  })

  it('uses arrow keys and Enter without submitting until a suggestion is selected', async () => {
    const complete = vi.fn(async (path: string) => completion(path, ['alpha', 'beta']))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Harness />)

    const input = screen.getByRole('combobox', { name: 'Working directory' })
    await user.click(input)
    await screen.findByRole('option', { name: /alpha/ })
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')

    expect(input).toHaveValue('/srv/work/beta/')
  })

  it('keeps an immediate Tab in the field until the remote completion arrives', async () => {
    const pending = deferred<WorkingDirectoryCompletion>()
    const complete = vi.fn(() => pending.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Harness />)

    const input = screen.getByRole('combobox', { name: 'Working directory' })
    await user.click(input)
    await waitFor(() => expect(complete).toHaveBeenCalled())
    await user.keyboard('{Tab}')
    expect(input).toHaveFocus()

    pending.resolve(completion('/srv/work', ['ready']))
    await screen.findByRole('option', { name: /ready/ })
    await user.keyboard('{Tab}')
    expect(input).toHaveValue('/srv/work/ready/')
  })

  it('keeps the picker visible with useful loading and empty feedback', async () => {
    const pending = deferred<WorkingDirectoryCompletion>()
    const complete = vi.fn(() => pending.promise)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Harness />)

    const input = screen.getByRole('combobox', { name: 'Working directory' })
    await user.click(input)
    expect(screen.getByText('Folders on this server')).toBeVisible()
    expect(screen.getByText('Looking up folders…')).toBeVisible()

    pending.resolve(completion('/srv/work', []))

    expect(await screen.findByText('No matching folders on this server.')).toBeVisible()
    expect(screen.getByText('Keep typing a path')).toBeVisible()
    expect(input).toHaveAttribute('aria-expanded', 'true')
  })

  it('commits a chosen server folder immediately for inline editors', async () => {
    const onCommit = vi.fn()
    const complete = vi.fn(async (path: string) => completion(path, ['alpha']))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Harness onCommit={onCommit} />)

    await user.click(screen.getByRole('combobox', { name: 'Working directory' }))
    await user.click(await screen.findByRole('option', { name: /alpha/ }))

    expect(onCommit).toHaveBeenCalledWith('/srv/work/alpha/')
  })

  it('keeps the plain path input usable with an older server', async () => {
    const complete = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Harness available={false} showBrowseButton />)

    const input = screen.getByRole('textbox', { name: 'Working directory' })
    await user.clear(input)
    await user.type(input, '/legacy/path')

    expect(input).toHaveValue('/legacy/path')
    expect(complete).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Browse folders on active server' })).not.toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('points at the server when it lacks the completion capability', async () => {
    // Server capability off; the preload binding exists (current client).
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete: vi.fn() } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Harness available={false} />)

    await user.click(screen.getByRole('textbox', { name: 'Working directory' }))

    expect(screen.getByText('Folder suggestions need a newer AgentsServer. You can still enter a path.')).toBeVisible()
  })

  it('points at the desktop app when the server supports completion but the preload binding is missing', async () => {
    // Server capability on, but an older AgentsDock build without the
    // workingDirectories.complete preload must not blame the server.
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {} as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Harness available={true} />)

    await user.click(screen.getByRole('textbox', { name: 'Working directory' }))

    expect(screen.getByText('Update AgentsDock to browse folders here. You can still enter a path.')).toBeVisible()
  })

  it('does not show a late completion from an older typed path', async () => {
    const first = deferred<WorkingDirectoryCompletion>()
    const complete = vi.fn((path: string) => path === '/srv/work'
      ? first.promise
      : Promise.resolve(completion(path, ['new-result'])))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { workingDirectories: { complete } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<Harness />)

    const input = screen.getByRole('combobox', { name: 'Working directory' })
    await user.click(input)
    await waitFor(() => expect(complete).toHaveBeenCalledWith('/srv/work', 24))
    await user.type(input, '/next')
    expect(await screen.findByRole('option', { name: /new-result/ })).toBeInTheDocument()

    first.resolve(completion('/srv/work', ['stale-result'], true))
    await Promise.resolve()

    expect(screen.queryByRole('option', { name: /stale-result/ })).not.toBeInTheDocument()
  })
})
