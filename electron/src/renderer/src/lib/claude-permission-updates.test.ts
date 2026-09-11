import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { queueClaudePermissionUpdate } from './claude-permission-updates'

describe('Claude permission update queue', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeProfileId: 'profile-a',
      profileGeneration: 1,
      switchingProfileId: null,
      sessions: [{
        id: 'chat-1', title: 'Claude', backend: 'claude', claude_permission_mode: 'default'
      }],
      error: null
    })
  })

  it('serializes changes for one chat and leaves the latest mode authoritative', async () => {
    const firstResponse = deferred<void>()
    const update = vi.fn(async (_sessionId: string, patch: Partial<Session>) => {
      const response = {
        ...useAppStore.getState().sessions.find(session => session.id === 'chat-1'),
        ...definedValues(patch)
      } as Session
      if (update.mock.calls.length === 1) await firstResponse.promise
      return response
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { sessions: { update } } as unknown as AgentsDockAPI
    })

    const first = queueClaudePermissionUpdate('chat-1', { claude_permission_mode: 'acceptEdits' })
    const second = queueClaudePermissionUpdate('chat-1', { claude_permission_mode: 'plan' })

    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    firstResponse.resolve()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()

    expect(update.mock.calls.map(([, patch]) => patch)).toEqual([
      { claude_permission_mode: 'acceptEdits' },
      { claude_permission_mode: 'plan' }
    ])
    expect(useAppStore.getState().sessions[0].claude_permission_mode).toBe('plan')
  })
})

function definedValues(patch: Partial<Session>): Partial<Session> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}
