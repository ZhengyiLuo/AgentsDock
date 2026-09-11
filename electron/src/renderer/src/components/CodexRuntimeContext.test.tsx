import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { CodexRuntimeSnapshot, Event, ProfileAgentEvent, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { CodexRuntimeProvider } from './CodexRuntimeContext'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Codex runtime event refresh', () => {
  it('ignores imported goal metadata while refreshing for actual turn and goal updates', async () => {
    vi.useFakeTimers()
    const session: Session = { id: 'chat-1', title: 'Goal work', backend: 'codex' }
    const runtime = vi.fn().mockResolvedValue({
      available: true, transport: 'app_server', interactive_capability: 'codex_interactive_v1',
      thread_loaded: true, status: { type: 'idle' }, goal: null, time_budget_seconds: null,
      pending_interactions: [], permission_profiles: [], background_terminals_supported: false
    } satisfies CodexRuntimeSnapshot)
    let receiveEvent: ((payload: ProfileAgentEvent) => void) | undefined
    useAppStore.setState({ activeProfileId: 'profile-1', profileGeneration: 4, connected: false })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        codex: { runtime },
        events: {
          on: vi.fn((channel: string, listener: (payload: ProfileAgentEvent) => void) => {
            if (channel === 'server:event') receiveEvent = listener
            return () => undefined
          })
        }
      } as unknown as AgentsDockAPI
    })
    await act(async () => {
      render(<CodexRuntimeProvider session={session} capability={{ available: true }}>{null}</CodexRuntimeProvider>)
    })
    expect(runtime).toHaveBeenCalledOnce()
    const context: Event = {
      id: 'context', session_id: session.id, seq: 1, type: 'turn_started',
      ts: '2026-09-10T00:00:00Z', backend: 'codex', run_id: 'import_goal',
      imported: true, metadata_only: true, provider_runtime_context: 'goal'
    }
    const deliver = async (event: Event) => {
      await act(async () => {
        receiveEvent?.({ profileId: 'profile-1', profileGeneration: 4, event })
        await vi.advanceTimersByTimeAsync(60)
      })
    }
    await deliver(context)
    expect(runtime).toHaveBeenCalledOnce()
    await deliver({ ...context, id: 'user', seq: 2, provider_user_authored: true })
    expect(runtime).toHaveBeenCalledOnce()
    await deliver({ ...context, id: 'import-finish', seq: 3, type: 'turn_finished', metadata_only: false })
    expect(runtime).toHaveBeenCalledOnce()
    await deliver({ ...context, id: 'native-user', seq: 4, imported: false, run_id: 'native-run', provider_user_authored: true })
    expect(runtime).toHaveBeenCalledTimes(2)
    await deliver({ ...context, id: 'goal-update', seq: 5, type: 'codex_goal_updated', imported: false, run_id: 'native-run' })
    expect(runtime).toHaveBeenCalledTimes(3)
  })
})
