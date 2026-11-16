import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { AgentFile } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { openAgentFile, openLinkedFile, saveAgentFile } from './file-actions'
import { setLocale } from '@shared/i18n'
import { trackOperation } from './analytics'

vi.mock('./analytics', () => ({ trackOperation: vi.fn(async (_name, action) => action()) }))

describe('file link feedback', () => {
  const open = vi.fn()
  const openLinked = vi.fn()
  beforeEach(() => {
    setLocale('en')
    open.mockReset().mockResolvedValue(undefined)
    openLinked.mockReset().mockResolvedValue(undefined)
    vi.mocked(trackOperation).mockClear()
    useAppStore.setState({ error: null, activeProfileId: 'server-a', profileGeneration: 1, selectedSessionId: 'chat-a', switchingProfileId: null })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { files: { open, openLinked } } })
  })
  afterEach(() => setLocale('en'))

  it('preserves successful opens and sends the original target to the authenticated bridge', async () => {
    await expect(openLinkedFile('chat-a', '/build/Test.zip')).resolves.toBe(true)
    expect(openLinked).toHaveBeenCalledExactlyOnceWith('chat-a', '/build/Test.zip')
    const file = { id: 'file-a', filename: 'Test.zip' }
    await expect(openAgentFile('chat-a', file)).resolves.toBe(true)
    expect(open).toHaveBeenCalledExactlyOnceWith('chat-a', file)
    expect(useAppStore.getState().error).toBeNull()
    expect(trackOperation).toHaveBeenCalledTimes(2)
    expect(trackOperation).toHaveBeenCalledWith('file_open_requested', expect.any(Function), undefined, { origin: 'artifact' })
    expect(trackOperation).toHaveBeenCalledWith('file_open_requested', expect.any(Function), undefined, { origin: 'linked_file' })
  })

  it('translates missing-attachment feedback into Chinese', async () => {
    setLocale('zh-CN')
    openLinked.mockRejectedValue(new Error('Linked file failed: 404'))
    await expect(openLinkedFile('chat-a', '/build/Test.zip')).resolves.toBe(false)
    expect(useAppStore.getState().error).toBe('无法打开“Test.zip”：此文件不是当前会话中可用的附件。请让 Agent 将文件作为附件发送后重试。')
  })

  it.each(['Linked file failed: 403', 'fetch failed', 'Linked file failed: 409'])('preserves other failure reasons: %s', async reason => {
    openLinked.mockRejectedValue(new Error(reason))
    await openLinkedFile('chat-a', '/build/Test.zip')
    expect(useAppStore.getState().error).toBe(`Could not open "Test.zip": ${reason}`)
  })

  it('allows a retry after a failed click without clearing unrelated errors on success', async () => {
    openLinked.mockRejectedValueOnce(new Error('fetch failed'))
    await expect(openLinkedFile('chat-a', 'Test.zip')).resolves.toBe(false)
    useAppStore.setState({ error: 'A different operation failed' })
    await expect(openLinkedFile('chat-a', 'Test.zip')).resolves.toBe(true)
    expect(openLinked).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().error).toBe('A different operation failed')
  })

  it.each([
    { activeProfileId: 'server-b' }, { profileGeneration: 2 },
    { selectedSessionId: 'chat-b' }, { switchingProfileId: 'server-b' }
  ])('does not display a late error after navigating: %o', async next => {
    let reject!: (error: Error) => void
    openLinked.mockReturnValue(new Promise<void>((_, fail) => { reject = fail }))
    const result = openLinkedFile('chat-a', '/build/Test.zip')
    useAppStore.setState(next)
    reject(new Error('Linked file failed: 404'))
    await expect(result).resolves.toBe(false)
    expect(useAppStore.getState().error).toBeNull()
  })
})

describe('saveAgentFile', () => {
  const file: AgentFile = { id: 'video-1', filename: 'result.mp4', title: 'Result video' }

  beforeEach(() => {
    useAppStore.setState({ error: null })
  })

  it('returns the selected destination after a successful download', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { save: vi.fn().mockResolvedValue('/tmp/result.mp4') } } as unknown as AgentsDockAPI
    })

    await expect(saveAgentFile('chat-1', file)).resolves.toBe('/tmp/result.mp4')
    expect(useAppStore.getState().error).toBeNull()
  })

  it('surfaces a useful error when the native download fails', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        files: { save: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'files:save': Error: Download failed (404 Not Found)")) }
      } as unknown as AgentsDockAPI
    })

    await expect(saveAgentFile('chat-1', file)).resolves.toBeNull()
    expect(useAppStore.getState().error).toBe('Could not download "Result video": Download failed (404 Not Found)')
  })
})
