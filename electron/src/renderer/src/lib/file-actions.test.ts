import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { AgentFile } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { saveAgentFile } from './file-actions'

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
