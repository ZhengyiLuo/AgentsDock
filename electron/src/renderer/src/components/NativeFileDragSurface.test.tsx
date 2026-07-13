import { fireEvent, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { AgentFile } from '@shared/types'
import { NativeFileDragSurface } from './NativeFileDragSurface'

describe('NativeFileDragSurface', () => {
  it('starts an on-demand native file drag on the first gesture', async () => {
    const beginDrag = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { beginDrag } } as unknown as AgentsDockAPI
    })
    const file: AgentFile = { id: 'video-1', filename: 'result.mp4', content_type: 'video/mp4' }
    const { getByText } = render(<NativeFileDragSurface file={file}><span>Result</span></NativeFileDragSurface>)
    const surface = getByText('Result').closest('article')!

    fireEvent.dragStart(surface)

    await waitFor(() => expect(beginDrag).toHaveBeenCalledWith(file))
    expect(beginDrag).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight native drag request', async () => {
    let finishDrag!: (started: boolean) => void
    const beginDrag = vi.fn(() => new Promise<boolean>(resolve => { finishDrag = resolve }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { beginDrag } } as unknown as AgentsDockAPI
    })
    const file: AgentFile = { id: 'video-2', filename: 'slow-result.mp4', content_type: 'video/mp4' }
    const { getByText } = render(<NativeFileDragSurface file={file}><span>Slow result</span></NativeFileDragSurface>)
    const surface = getByText('Slow result').closest('article')!

    fireEvent.dragStart(surface)
    fireEvent.dragStart(surface)
    expect(beginDrag).toHaveBeenCalledTimes(1)
    expect(surface).toHaveAttribute('data-native-drag-preparing', 'true')

    finishDrag(true)
    await waitFor(() => expect(surface).not.toHaveAttribute('data-native-drag-preparing'))
  })

  it('does not start a native drag from an action button', async () => {
    const beginDrag = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { beginDrag } } as unknown as AgentsDockAPI
    })
    const file: AgentFile = { id: 'report-1', filename: 'report.csv', content_type: 'text/csv' }
    const { getByText } = render(<NativeFileDragSurface file={file}><button data-native-drag-ignore>Download</button></NativeFileDragSurface>)
    const button = getByText('Download')

    fireEvent.dragStart(button)
    await Promise.resolve()

    expect(beginDrag).not.toHaveBeenCalled()
  })
})
