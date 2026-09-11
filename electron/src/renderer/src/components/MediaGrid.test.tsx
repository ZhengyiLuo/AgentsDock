import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { AgentFile, WorkspaceProfileScope } from '@shared/types'
import { closeTopTransient, resetTransientCloseStackForTests } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import { MediaGrid as MediaGridImpl, MediaPreviewDialog } from './MediaGrid'

const TEST_PIN_PROFILE_SCOPE: WorkspaceProfileScope = {
  profileId: 'profile-a',
  profileGeneration: 0,
  serverIdentity: null
}

function MediaGrid(props: Omit<ComponentProps<typeof MediaGridImpl>, 'profileScope'> & { profileScope?: WorkspaceProfileScope | null }) {
  return <MediaGridImpl {...props} profileScope={props.profileScope ?? TEST_PIN_PROFILE_SCOPE} />
}

describe('MediaPreviewDialog', () => {
  beforeEach(() => useAppStore.setState({ activeProfileId: 'profile-a' }))
  afterEach(() => { cleanup(); resetTransientCloseStackForTests() })

  it('owns the top-level close command while the viewer is open', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { mediaURL: vi.fn(() => 'agentsdock-media://file/profile-a/image-1') } } as unknown as AgentsDockAPI
    })
    const file: AgentFile = { id: 'image-1', filename: 'result.png', content_type: 'image/png' }
    const onClose = vi.fn()
    const view = render(<MediaPreviewDialog sessionId="chat-1" file={file} onClose={onClose} />)

    act(() => { expect(closeTopTransient()).toBe(true) })

    expect(onClose).toHaveBeenCalledOnce()
    view.unmount()
    expect(closeTopTransient()).toBe(false)
  })

  it('closes from the visible X button', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: {
          mediaURL: vi.fn(() => 'agentsdock-media://file/profile-a/image-1'),
          open: vi.fn(),
          save: vi.fn()
        }
      } as unknown as AgentsDockAPI
    })
    const file: AgentFile = { id: 'image-1', filename: 'result.png', content_type: 'image/png' }
    const onClose = vi.fn()
    render(<MediaPreviewDialog sessionId="chat-1" file={file} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close media preview' }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('navigates the media cluster with arrow keys and visible controls', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: {
          mediaURL: vi.fn((profileId: string, generation: number, sessionId: string, id: string) => `agentsdock-media://file/${profileId}/${generation}/${sessionId}/${id}`),
          open: vi.fn(),
          save: vi.fn()
        }
      } as unknown as AgentsDockAPI
    })
    const first: AgentFile = { id: 'video-1', filename: 'first.mp4', content_type: 'video/mp4' }
    const second: AgentFile = { id: 'video-2', filename: 'second.mp4', content_type: 'video/mp4' }
    const onSelect = vi.fn()
    const view = render(<MediaPreviewDialog sessionId="chat-1" file={first} files={[first, second]} onSelect={onSelect} onClose={vi.fn()} />)

    expect(screen.getByText(/1 of 2/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous media' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next media' })).toBeEnabled()

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenCalledWith(second)

    onSelect.mockClear()
    view.rerender(<MediaPreviewDialog sessionId="chat-1" file={second} files={[first, second]} onSelect={onSelect} onClose={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenCalledWith(first)
  })

  it('changes the resource URL when profiles reuse the same file ID', () => {
    const mediaURL = vi.fn((profileId: string, generation: number, sessionId: string, id: string) => `agentsdock-media://file/${profileId}/${generation}/${sessionId}/${id}`)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { mediaURL, open: vi.fn(), save: vi.fn() } } as unknown as AgentsDockAPI
    })
    const file: AgentFile = { id: 'same-file', filename: 'result.png', content_type: 'image/png' }
    render(<MediaPreviewDialog sessionId="chat-1" file={file} onClose={vi.fn()} />)

    expect(screen.getByRole('img', { name: 'result.png' })).toHaveAttribute('src', 'agentsdock-media://file/profile-a/0/chat-1/same-file')
    act(() => useAppStore.setState({ activeProfileId: 'profile-b' }))

    expect(screen.getByRole('img', { name: 'result.png' })).toHaveAttribute('src', 'agentsdock-media://file/profile-b/0/chat-1/same-file')
    expect(mediaURL).toHaveBeenCalledWith('profile-a', 0, 'chat-1', 'same-file')
    expect(mediaURL).toHaveBeenCalledWith('profile-b', 0, 'chat-1', 'same-file')
  })
})

describe('MediaGrid documents', () => {
  beforeEach(() => useAppStore.setState({
    activeProfileId: 'profile-a',
    sessions: [{
      id: 'chat-1',
      title: 'Chat',
      cwd: '/work/project',
      backend: 'codex'
    }]
  }))
  afterEach(() => {
    cleanup()
    useAppStore.setState({ sessions: [] })
  })

  it('uses a compact file row instead of an empty media canvas and exposes pinned state', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: {
          mediaURL: vi.fn(() => 'agentsdock-media://file/profile-a/report-1'),
          open: vi.fn(),
          save: vi.fn(),
          reveal: vi.fn()
        },
        pins: { put: vi.fn(), remove: vi.fn() }
      } as unknown as AgentsDockAPI
    })
    const file: AgentFile = { id: 'report-1', filename: 'status-report.md', content_type: 'text/markdown', size: 8192 }
    const view = render(<MediaGrid files={[file]} sessionId="chat-1" pinnedItemIds={new Set(['file:report-1'])} />)

    expect(view.container.querySelector('.media-file-row')).toBeInTheDocument()
    expect(view.container.querySelector('.media-preview')).not.toBeInTheDocument()
    expect(screen.getByTitle('Unpin file')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('status-report.md')).toBeInTheDocument()
  })

  it('keeps file metadata when pinning a document for later editor access', async () => {
    const put = vi.fn().mockResolvedValue([])
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: {
          mediaURL: vi.fn(),
          open: vi.fn(),
          save: vi.fn(),
          reveal: vi.fn()
        },
        pins: { put, remove: vi.fn() }
      } as unknown as AgentsDockAPI
    })
    const file: AgentFile = {
      id: 'source-pin',
      filename: 'policy_runner.py',
      title: 'Policy runner',
      content_type: 'text/x-python',
      path: '/server/files/source-pin/policy_runner.py',
      source_path: '/work/project/robot/control/policy_runner.py'
    }
    render(<MediaGrid files={[file]} sessionId="chat-1" />)

    fireEvent.click(screen.getByTitle('Pin file'))

    await waitFor(() => expect(put).toHaveBeenCalledWith(
      TEST_PIN_PROFILE_SCOPE,
      expect.objectContaining({
        fileId: file.id,
        fileSessionId: 'chat-1',
        filename: file.filename,
        content_type: file.content_type,
        path: file.path,
        source_path: file.source_path
      })
    ))
  })

  it('does not persist a file pin owned by another chat', async () => {
    const put = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: {
          mediaURL: vi.fn(),
          open: vi.fn(),
          save: vi.fn(),
          reveal: vi.fn()
        },
        pins: { put, remove: vi.fn() }
      } as unknown as AgentsDockAPI
    })
    const file: AgentFile = {
      id: 'foreign-source',
      session_id: 'chat-2',
      filename: 'foreign.py',
      content_type: 'text/x-python'
    }
    render(<MediaGrid files={[file]} sessionId="chat-1" />)

    fireEvent.click(screen.getByTitle('Pin file'))

    await waitFor(() => expect(put).not.toHaveBeenCalled())
  })

  it('previews an image whose upload metadata used the generic binary MIME type', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: {
          mediaURL: vi.fn(() => 'agentsdock-media://file/profile-a/image-1'),
          open: vi.fn(),
          save: vi.fn(),
          reveal: vi.fn()
        },
        pins: { put: vi.fn(), remove: vi.fn() }
      } as unknown as AgentsDockAPI
    })
    const file: AgentFile = { id: 'image-1', filename: 'screen.png', content_type: 'application/octet-stream' }
    const view = render(<MediaGrid files={[file]} sessionId="chat-1" />)

    expect(screen.getByRole('img', { name: 'screen.png' })).toHaveAttribute('src', 'agentsdock-media://file/profile-a/image-1')
    expect(view.container.querySelector('.media-preview')).toBeInTheDocument()
    expect(view.container.querySelector('.media-file-row')).not.toBeInTheDocument()
  })

  it('offers agent-generated workspace files directly to the editor', () => {
    const openExternally = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: {
          mediaURL: vi.fn(() => 'agentsdock-media://file/profile-a/source-1'),
          open: openExternally,
          save: vi.fn(),
          reveal: vi.fn()
        },
        pins: { put: vi.fn(), remove: vi.fn() }
      } as unknown as AgentsDockAPI
    })
    const file: AgentFile = {
      id: 'source-1',
      filename: 'policy_runner.py',
      source_path: '/work/project/robot/control/atlas_vla/policy_runner.py',
      content_type: 'application/octet-stream'
    }
    const open = vi.fn()
    window.addEventListener('agentsdock:open-agent-file', open)
    render(<MediaGrid files={[file]} sessionId="chat-1" />)

    expect(screen.getByTitle('Open in Editor')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /policy_runner\.py/i }))

    expect(open).toHaveBeenCalledOnce()
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-1',
      file
    })
    expect(openExternally).not.toHaveBeenCalled()
    window.removeEventListener('agentsdock:open-agent-file', open)
  })

  it('offers text artifacts outside the workspace to the internal artifact viewer', () => {
    const openExternally = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: {
          mediaURL: vi.fn(() => 'agentsdock-media://file/profile-a/source-2'),
          open: openExternally,
          save: vi.fn(),
          reveal: vi.fn()
        },
        pins: { put: vi.fn(), remove: vi.fn() }
      } as unknown as AgentsDockAPI
    })
    const file: AgentFile = {
      id: 'source-2',
      filename: 'notes.md',
      source_path: '/tmp/notes.md',
      content_type: 'text/markdown'
    }
    const open = vi.fn()
    window.addEventListener('agentsdock:open-agent-file', open)
    render(<MediaGrid files={[file]} sessionId="chat-1" />)

    expect(screen.getByTitle('Open in Editor')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /notes\.md/i }))

    expect(open).toHaveBeenCalledOnce()
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'chat-1',
      file
    })
    expect(openExternally).not.toHaveBeenCalled()
    window.removeEventListener('agentsdock:open-agent-file', open)
  })
})
