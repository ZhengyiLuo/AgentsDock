import { useState } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { ClaudeRuntimeSnapshot, Session } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { ChatHeader } from './ChatHeader'
import { ClaudeRuntimeProvider } from './ClaudeRuntimeContext'
import { ClaudeGoalControls } from './ClaudeGoalControls'

const session: Session = { id: 'claude-chat', backend: 'claude', title: 'Claude chat' }
const capability = { available: true, interactive_client_capability: 'claude_sdk_interactive_v1' }
const idle: ClaudeRuntimeSnapshot = { available: true, transport: 'sdk', interactive_capability: 'claude_sdk_interactive_v1',
  session_loaded: true, status: { type: 'idle' }, pending_interactions: [], features: { goals: true }, goal: null,
  context_usage_snapshot: { context_tokens: 20000, effective_context_window: 100000 } }
const runtime = vi.fn(), setGoal = vi.fn(), clearGoal = vi.fn(), resolveInteraction = vi.fn()
function GoalSurface() {
  const [open, setOpen] = useState(false)
  return <ClaudeGoalControls open={open} onOpenChange={setOpen} />
}
function surface() {
  return <ClaudeRuntimeProvider session={session} capability={capability}><ChatHeader session={session} /><GoalSurface /></ClaudeRuntimeProvider>
}

describe('Claude header controls', () => {
  beforeEach(() => {
    vi.clearAllMocks(); setLocale('en')
    runtime.mockResolvedValue(idle); setGoal.mockResolvedValue(idle); clearGoal.mockResolvedValue(idle); resolveInteraction.mockResolvedValue({})
    useAppStore.setState({ activeProfileId: 'a', profileGeneration: 1, connected: true, switchingProfileId: null,
      selectedSessionId: session.id, sessions: [session], activeSessionIds: new Set(), turnAdmissionTokens: {} })
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      claude: { runtime, setGoal, clearGoal, resolveInteraction }, events: { on: vi.fn().mockReturnValue(() => undefined) },
      preferences: { get: vi.fn().mockImplementation((_key, fallback) => Promise.resolve(fallback)) }
    } as unknown as AgentsDockAPI })
  })
  afterEach(() => { cleanup(); setLocale('en') })

  it('opens from the idle header, refreshes native state and shows context without inventing Codex operations', async () => {
    render(surface())
    const trigger = await screen.findByRole('button', { name: 'Claude controls: Idle' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    await userEvent.setup().click(trigger)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Claude controls' })).toBeInTheDocument()
    expect(within(dialog).getByText('20%')).toBeInTheDocument()
    expect(within(dialog).getByText('20k / 100k usable tokens')).toBeInTheDocument()
    expect(within(dialog).getByText('Loaded')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Rollback|Review changes|Run shell/ })).not.toBeInTheDocument()
    await waitFor(() => expect(runtime).toHaveBeenCalledTimes(2))
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Refresh Claude status' }))
    await waitFor(() => expect(runtime).toHaveBeenCalledTimes(3))
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Close Claude controls' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps lifecycle Running visible when the native snapshot briefly says idle', async () => {
    useAppStore.setState({ activeSessionIds: new Set([session.id]) })
    render(surface())
    const trigger = await screen.findByRole('button', { name: 'Claude controls: Running' })
    await userEvent.setup().click(trigger)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Claude Running' })).not.toBeInTheDocument()
    expect(setGoal).not.toHaveBeenCalled()
  })

  it('opens the same goal dialog from the header and submits only a native Claude completion condition', async () => {
    render(surface())
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Claude controls: Idle' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Goal…' }))
    const goal = await screen.findByRole('dialog', { name: 'Claude goal' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    const field = within(goal).getByRole('textbox', { name: 'Completion condition' })
    await userEvent.setup().type(field, 'All changes pass validation.')
    expect(within(goal).queryByRole('spinbutton')).not.toBeInTheDocument()
    await userEvent.setup().click(within(goal).getByRole('button', { name: 'Start goal' }))
    expect(setGoal).toHaveBeenCalledExactlyOnceWith(session.id, 'All changes pass validation.')
  })

  it('resolves pending native approval from the status panel through the Claude bridge', async () => {
    const interaction = { id: 'permission-1', session_id: session.id, tool_use_id: 'tool-1', method: 'item/commandExecution/requestApproval',
      params: { toolName: 'Bash', displayName: 'Run shell command', toolInput: { command: 'git status --short' }, availableDecisions: ['accept', 'decline'] }, created_at: 'now' }
    runtime.mockResolvedValue({ ...idle, status: { type: 'active', activeFlags: ['waitingOnApproval'] }, pending_interactions: [interaction] })
    render(surface())
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Claude controls: 1 waiting' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve & run' }))
    expect(resolveInteraction).toHaveBeenCalledExactlyOnceWith(session.id, interaction.id, { decision: 'accept' })
  })

  it('closes the panel when switching servers and keeps unsupported goal actions absent', async () => {
    runtime.mockResolvedValue({ ...idle, features: {} })
    render(surface())
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Claude controls: Idle' }))
    expect(screen.queryByRole('button', { name: 'Goal…' })).not.toBeInTheDocument()
    act(() => useAppStore.setState({ activeProfileId: 'b', profileGeneration: 2 }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(setGoal).not.toHaveBeenCalled()
  })
})
