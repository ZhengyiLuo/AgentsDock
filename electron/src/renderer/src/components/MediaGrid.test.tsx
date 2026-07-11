import { act, render, screen } from '@testing-library/react'
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
