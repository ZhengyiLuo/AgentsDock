import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { steerFirstQueuedTurn, steerQueuedTurn } from './queue-actions'

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

describe('steerFirstQueuedTurn', () => {
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

  it('refreshes the server queue and steers its position-one turn', async () => {
    const later = { queued_id: 'later', session_id: 'chat-1', prompt: 'Later', file_ids: [], position: 2 }
    const first = { queued_id: 'first', session_id: 'chat-1', prompt: 'First', file_ids: [], position: 1 }
    list.mockResolvedValueOnce([later, first]).mockResolvedValueOnce([later])
    runNow.mockResolvedValue(true)

    await expect(steerFirstQueuedTurn('chat-1')).resolves.toEqual({ steered: true, turns: [later] })
    expect(runNow).toHaveBeenCalledWith('chat-1', 'first')
  })

  it('does nothing when the refreshed server queue is empty', async () => {
    list.mockResolvedValue([])

    await expect(steerFirstQueuedTurn('chat-1')).resolves.toEqual({ steered: false, turns: [] })
    expect(runNow).not.toHaveBeenCalled()
  })

  it('does not steer an internal digest-generation turn', async () => {
    const digest = { queued_id: 'digest', session_id: 'chat-1', prompt: 'Generate digest', file_ids: [], position: 1, purpose: 'handoff_digest' }
    const user = { queued_id: 'user', session_id: 'chat-1', prompt: 'User follow-up', file_ids: [], position: 2 }
    list.mockResolvedValueOnce([digest, user]).mockResolvedValueOnce([digest])
    runNow.mockResolvedValue(true)

    await expect(steerFirstQueuedTurn('chat-1')).resolves.toEqual({ steered: true, turns: [digest] })
    expect(runNow).toHaveBeenCalledWith('chat-1', 'user')
  })

  it('does not expose an internal digest-delivery turn as steerable user work', async () => {
    const delivery = { queued_id: 'delivery', session_id: 'chat-1', prompt: 'Context digest from Source.', file_ids: [], position: 1, purpose: 'handoff_digest_delivery' }
    list.mockResolvedValue([delivery])

    await expect(steerFirstQueuedTurn('chat-1')).resolves.toEqual({ steered: false, turns: [delivery] })
    expect(runNow).not.toHaveBeenCalled()
  })
})
