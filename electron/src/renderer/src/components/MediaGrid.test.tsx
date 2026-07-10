import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { AgentFile } from '@shared/types'
import { closeTopTransient, resetTransientCloseStackForTests } from '../lib/transient-close'
import { MediaPreviewDialog } from './MediaGrid'

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
