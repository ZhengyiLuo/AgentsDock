import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { steerQueuedTurn } from './queue-actions'

describe('steerQueuedTurn', () => {
  const runNow = vi.fn()
  const list = vi.fn()

  beforeEach(() => {
    runNow.mockReset()
    list.mockReset()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { queue: { runNow, list } } as unknown as AgentsDockAPI
    })
  })

  it('returns the refreshed queue after steering', async () => {
    runNow.mockResolvedValue(true)
    list.mockResolvedValue([])
    await expect(steerQueuedTurn('chat-1', 'queued-1')).resolves.toEqual([])
  })

  it('treats a missing queued turn as already started when it disappeared', async () => {
    runNow.mockRejectedValue(new Error('queued turn not found'))
    list.mockResolvedValue([])
    await expect(steerQueuedTurn('chat-1', 'queued-1')).resolves.toEqual([])
  })

  it('keeps a real steering failure when the turn is still queued', async () => {
    const error = new Error('offline')
    runNow.mockRejectedValue(error)
    list.mockResolvedValue([{ queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Run', file_ids: [] }])
    await expect(steerQueuedTurn('chat-1', 'queued-1')).rejects.toBe(error)
  })
})
