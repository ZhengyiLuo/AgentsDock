import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '../shared/ipc'

const electronHarness = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  getPathForFile: vi.fn((file: File) => file.name.startsWith('virtual-') ? '' : `/tmp/${file.name}`)
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronHarness.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronHarness.invoke,
    on: electronHarness.on,
    removeListener: electronHarness.removeListener,
    send: electronHarness.send
  },
  webUtils: { getPathForFile: electronHarness.getPathForFile }
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  electronHarness.exposeInMainWorld.mockReset()
  electronHarness.invoke.mockReset()
  electronHarness.getPathForFile.mockClear()
})

describe('native file preload authorization', () => {
  it('stages trusted chat drops once, permits a fresh re-drop, and ignores unrelated or pathless gestures', async () => {
    const listeners = new Map<string, EventListener>()
    vi.spyOn(window, 'addEventListener').mockImplementation(((name: string, listener: EventListener) => {
      listeners.set(name, listener)
    }) as typeof window.addEventListener)
    electronHarness.invoke.mockImplementation(async (channel: string, paths: string[]) => {
      if (channel !== 'files:stage-native-batch') return undefined
      return paths.map(path => ({ path, name: path.split('/').at(-1)!, size: 4 }))
    })

    await import('./index')
    const exposed = electronHarness.exposeInMainWorld.mock.calls.find(call => call[0] === 'agentsDock')
    const api = exposed?.[1] as AgentsDockAPI
    const drop = listeners.get('drop')
    const paste = listeners.get('paste')
    expect(api.files.stageNativeFiles).toBeTypeOf('function')
    expect(drop).toBeTypeOf('function')
    expect(paste).toBeTypeOf('function')

    const chat = document.createElement('div')
    chat.className = 'chat-workspace'
    const image = new File(['data'], 'photo.png', { type: 'image/png', lastModified: 10 })
    drop!({
      isTrusted: true,
      dataTransfer: { files: [image] },
      composedPath: () => [chat, document.body]
    } as unknown as Event)
    await expect(api.files.stageNativeFiles!([image])).resolves.toEqual([
      expect.objectContaining({ path: '/tmp/photo.png', name: 'photo.png' })
    ])
    await expect(api.files.stageNativeFiles!([image])).rejects.toThrow('Choose this file again')
    expect(electronHarness.invoke).toHaveBeenCalledTimes(1)

    const freshImage = new File(['data'], 'photo.png', { type: 'image/png', lastModified: 10 })
    drop!({
      isTrusted: true,
      dataTransfer: { files: [freshImage] },
      composedPath: () => [chat, document.body]
    } as unknown as Event)
    await expect(api.files.stageNativeFiles!([freshImage])).resolves.toHaveLength(1)
    expect(electronHarness.invoke).toHaveBeenCalledTimes(2)

    const settings = document.createElement('div')
    settings.className = 'settings-dialog'
    const unrelated = new File(['data'], 'other.mp4', { type: 'video/mp4' })
    drop!({
      isTrusted: true,
      dataTransfer: { files: [unrelated] },
      composedPath: () => [settings, document.body]
    } as unknown as Event)
    await expect(api.files.stageNativeFiles!([unrelated])).rejects.toThrow('Choose this file again')

    const composer = document.createElement('div')
    composer.className = 'composer'
    const virtualImage = new File(['data'], 'virtual-paste.png', { type: 'image/png' })
    paste!({
      isTrusted: true,
      clipboardData: { files: [virtualImage] },
      composedPath: () => [composer, chat, document.body]
    } as unknown as Event)
    await expect(api.files.stageNativeFiles!([virtualImage])).resolves.toEqual([null])
    expect(electronHarness.invoke).toHaveBeenCalledTimes(2)
  })
})
