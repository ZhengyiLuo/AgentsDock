import { fireEvent, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { AgentFile } from '@shared/types'
import { NativeFileDragSurface } from './NativeFileDragSurface'

describe('NativeFileDragSurface', () => {
  it('warms one file on hover and starts the native drag synchronously once ready', async () => {
    const prepareDrag = vi.fn().mockResolvedValue(undefined)
    const beginDrag = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { prepareDrag, beginDrag } } as unknown as AgentsDockAPI
    })
    const file: AgentFile = { id: 'video-1', filename: 'result.mp4', content_type: 'video/mp4' }
    const { getByText } = render(<NativeFileDragSurface file={file}><span>Result</span></NativeFileDragSurface>)
    const surface = getByText('Result').closest('article')!

    fireEvent.pointerEnter(surface)
    await waitFor(() => expect(surface).toHaveAttribute('data-native-drag-ready', 'true'))
    fireEvent.dragStart(surface)

    expect(beginDrag).toHaveBeenCalledWith(file)
    expect(prepareDrag).toHaveBeenCalledTimes(1)
  })

  it('does not attempt a late native drag after the originating gesture has ended', async () => {
    let releasePreparation!: () => void
    const prepareDrag = vi.fn(() => new Promise<void>(resolve => { releasePreparation = resolve }))
    const beginDrag = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { prepareDrag, beginDrag } } as unknown as AgentsDockAPI
    })
    const file: AgentFile = { id: 'video-2', filename: 'slow-result.mp4', content_type: 'video/mp4' }
    const { getByText } = render(<NativeFileDragSurface file={file}><span>Slow result</span></NativeFileDragSurface>)
    const surface = getByText('Slow result').closest('article')!

    fireEvent.pointerDown(surface, { button: 0 })
    fireEvent.dragStart(surface)
    expect(beginDrag).not.toHaveBeenCalled()

    releasePreparation()
    await waitFor(() => expect(surface).toHaveAttribute('data-native-drag-ready', 'true'))
    expect(beginDrag).not.toHaveBeenCalled()

    fireEvent.dragStart(surface)
    expect(beginDrag).toHaveBeenCalledWith(file)
  })

  it('does not prepare a temp copy when an action button is clicked', async () => {
    const prepareDrag = vi.fn().mockResolvedValue(undefined)
    const beginDrag = vi.fn()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { prepareDrag, beginDrag } } as unknown as AgentsDockAPI
    })
    const file: AgentFile = { id: 'report-1', filename: 'report.csv', content_type: 'text/csv' }
    const { getByText } = render(<NativeFileDragSurface file={file}><button data-native-drag-ignore>Download</button></NativeFileDragSurface>)
    const button = getByText('Download')

    fireEvent.pointerDown(button, { button: 0 })
    fireEvent.dragStart(button)
    await Promise.resolve()

    expect(prepareDrag).not.toHaveBeenCalled()
    expect(beginDrag).not.toHaveBeenCalled()
  })
})
