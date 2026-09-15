import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { CodexRuntimeProvider, useCodexRuntime } from '../components/CodexRuntimeContext'
import { ClaudeRuntimeProvider, useClaudeRuntime } from '../components/ClaudeRuntimeContext'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('shared runtime snapshot commits', () => {
  for (const backend of ['codex', 'claude'] as const) it(`${backend} applies Stop status even when Session replacement cancels the event timer`, async () => {
    vi.useFakeTimers()
    const session: Session = { id: 'shared-one', title: 'Synthetic shared chat', backend }
    let status = 'active'
    const runtime = vi.fn(async () => ({ available: true, status: { type: status, activeFlags: [] }, thread_loaded: true, session_loaded: true, pending_interactions: [], goal: null }))
    let receive: ((value: unknown) => void) | undefined
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      sharedChat: true, codex: { runtime }, claude: { runtime },
      events: { on: (name: string, callback: (value: unknown) => void) => { if (name === 'server:provider-runtime') receive = callback; return () => undefined } }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({ activeProfileId: 'shared-chat', profileGeneration: 1, connected: true })
    const Provider = backend === 'codex' ? CodexRuntimeProvider : ClaudeRuntimeProvider
    const capability = { available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }
    const Probe = backend === 'codex'
      ? () => <output>{useCodexRuntime().runtime?.status?.type}</output>
      : () => <output>{useClaudeRuntime().runtime?.status?.type}</output>
    let view: ReturnType<typeof render>
    await act(async () => { view = render(<Provider session={session} capability={capability}><Probe /></Provider>) })
    expect(screen.getByRole('status')).toHaveTextContent('active')
    status = 'idle'
    await act(async () => {
      // Same ordering as bridge.apply: signal first, then React commits the
      // immutable Session snapshot and cancels the old effect's 60ms timer.
      receive?.({ profileId: 'shared-chat', profileGeneration: 1, event: { session_id: session.id, backend, runtime: 'context_usage' } })
      view.rerender(<Provider session={{ ...session }} capability={capability}><Probe /></Provider>)
    })
    expect(screen.getByRole('status')).toHaveTextContent('idle')
    const calls = runtime.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(runtime).toHaveBeenCalledTimes(calls) // No periodic refresh added.
  })
})
