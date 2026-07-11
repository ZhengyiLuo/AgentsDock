import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { AgentFile } from '@shared/types'
import { closeTopTransient, resetTransientCloseStackForTests } from '../lib/transient-close'
import { MediaGrid, MediaPreviewDialog } from './MediaGrid'

describe('MediaPreviewDialog', () => {
  afterEach(resetTransientCloseStackForTests)

  it('owns the top-level close command while the viewer is open', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { mediaURL: vi.fn(() => 'agentsdock-media://file/image-1') } } as unknown as AgentsDockAPI
    })
    const file: AgentFile = { id: 'image-1', filename: 'result.png', content_type: 'image/png' }
    const onClose = vi.fn()
    const view = render(<MediaPreviewDialog file={file} onClose={onClose} />)

    act(() => { expect(closeTopTransient()).toBe(true) })

    expect(onClose).toHaveBeenCalledOnce()
    view.unmount()
    expect(closeTopTransient()).toBe(false)
  })

  it('navigates the media cluster with arrow keys and visible controls', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: {
          mediaURL: vi.fn((id: string) => `agentsdock-media://file/${id}`),
          open: vi.fn(),
          save: vi.fn()
        }
      } as unknown as AgentsDockAPI
    })
    const first: AgentFile = { id: 'video-1', filename: 'first.mp4', content_type: 'video/mp4' }
    const second: AgentFile = { id: 'video-2', filename: 'second.mp4', content_type: 'video/mp4' }
    const onSelect = vi.fn()
    const view = render(<MediaPreviewDialog file={first} files={[first, second]} onSelect={onSelect} onClose={vi.fn()} />)

    expect(screen.getByText(/1 of 2/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous media' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next media' })).toBeEnabled()

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenCalledWith(second)

    onSelect.mockClear()
    view.rerender(<MediaPreviewDialog file={second} files={[first, second]} onSelect={onSelect} onClose={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenCalledWith(first)
  })
})

describe('MediaGrid documents', () => {
  it('uses a compact file row instead of an empty media canvas and exposes pinned state', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: {
          mediaURL: vi.fn(() => 'agentsdock-media://file/report-1'),
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
})
