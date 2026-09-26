import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { nativeFileRefsFromFiles } from './native-files'

const previousAPI = window.agentsDock
afterEach(() => { Object.defineProperty(window, 'agentsDock', { configurable: true, value: previousAPI }) })

function bridge(sharedChat: boolean) {
  const stageNativeFile = vi.fn(async (file: File) => ({ path: `synthetic:${file.name}`, name: file.name, size: file.size, type: file.type }))
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    sharedChat, files: { stageNativeFile, stageClipboardImage: vi.fn() }
  } as unknown as AgentsDockAPI })
  return stageNativeFile
}

describe('native file selection', () => {
  it('stages every File from a shared drop without a separate attachment count limit', async () => {
    const stage = bridge(true)
    const files = Array.from({ length: 5 }, (_, index) => new File(['synthetic'], `file-${index}.txt`))
    await expect(nativeFileRefsFromFiles(files)).resolves.toHaveLength(5)
    expect(stage).toHaveBeenCalledTimes(5)
    for (const file of files) expect(stage).toHaveBeenCalledWith(file)
  })
  it('passes shared dropped files larger than 8 MiB into the normal upload path', async () => {
    const stage = bridge(true)
    const oversized = new File(['synthetic'], 'large.txt')
    Object.defineProperty(oversized, 'size', { value: 8 * 1024 * 1024 + 1 })
    await expect(nativeFileRefsFromFiles([new File(['synthetic'], 'small.txt'), oversized])).resolves.toHaveLength(2)
    expect(stage).toHaveBeenCalledWith(oversized)
  })
  it('preserves the desktop staging path without the shared-browser count limit', async () => {
    const stage = bridge(false)
    const files = Array.from({ length: 5 }, (_, index) => new File(['synthetic'], `native-${index}.txt`))
    expect(await nativeFileRefsFromFiles(files)).toHaveLength(5)
    expect(stage).toHaveBeenCalledTimes(5)
  })
  it('uses one atomic native batch when the desktop preload provides it', async () => {
    const stageNativeFiles = vi.fn(async (files: File[]) => files.map(file => ({
      path: `/tmp/${file.name}`, name: file.name, size: file.size, type: file.type
    })))
    const stageClipboardImage = vi.fn()
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      sharedChat: false,
      files: { stageNativeFiles, stageNativeFile: vi.fn(), stageClipboardImage }
    } as unknown as AgentsDockAPI })
    const files = [
      new File(['image'], 'photo.png', { type: 'image/png' }),
      new File(['video'], 'movie.mp4', { type: 'video/mp4' })
    ]

    await expect(nativeFileRefsFromFiles(files)).resolves.toEqual([
      expect.objectContaining({ path: '/tmp/photo.png', type: 'image/png' }),
      expect.objectContaining({ path: '/tmp/movie.mp4', type: 'video/mp4' })
    ])
    expect(stageNativeFiles).toHaveBeenCalledExactlyOnceWith(files)
    expect(stageClipboardImage).not.toHaveBeenCalled()
  })
})
