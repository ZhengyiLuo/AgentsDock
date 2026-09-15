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
  it('rejects a five-file shared drop before staging, then accepts a valid selection', async () => {
    const stage = bridge(true)
    const files = Array.from({ length: 5 }, (_, index) => new File(['synthetic'], `file-${index}.txt`))
    await expect(nativeFileRefsFromFiles(files)).rejects.toThrow('at most 4 files')
    expect(stage).not.toHaveBeenCalled()
    await expect(nativeFileRefsFromFiles(files.slice(0, 1))).resolves.toMatchObject([{ name: 'file-0.txt' }])
    expect(stage).toHaveBeenCalledTimes(1)
  })
  it('rejects an oversized shared drop before staging even its valid prefix', async () => {
    const stage = bridge(true)
    const oversized = new File(['synthetic'], 'large.txt')
    Object.defineProperty(oversized, 'size', { value: 8 * 1024 * 1024 + 1 })
    await expect(nativeFileRefsFromFiles([new File(['synthetic'], 'small.txt'), oversized])).rejects.toThrow('8 MiB')
    expect(stage).not.toHaveBeenCalled()
  })
  it('preserves the desktop staging path without the shared-browser count limit', async () => {
    const stage = bridge(false)
    const files = Array.from({ length: 5 }, (_, index) => new File(['synthetic'], `native-${index}.txt`))
    expect(await nativeFileRefsFromFiles(files)).toHaveLength(5)
    expect(stage).toHaveBeenCalledTimes(5)
  })
})
