import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { ClaudeMcpSnapshot, InteractiveProviderCapability, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { ClaudeMcpDialog, claudeMcpCapabilityAdvertised, claudeMcpCapabilitySupported } from './ClaudeMcpDialog'

const session: Session = { id: 'claude-chat', title: 'Claude chat', backend: 'claude' }

function snapshot(patch: Partial<ClaudeMcpSnapshot> = {}): ClaudeMcpSnapshot {
  return {
    version: 1,
    available: true,
    transport: 'agent-sdk',
    generation: 'owner-a:sdk-7',
    session_loaded: true,
    servers: [{
      name: 'dayone-cli',
      status: 'needs-auth',
      enabled: true,
      error: 'This MCP server needs authentication.',
      scope: 'user',
      server_info: { name: 'Day One', version: '2.0' },
      tool_count: 3
    }],
    truncated: false,
    reason: null,
    action: null,
    ...patch
  }
}

function installBridge(
  read: ReturnType<typeof vi.fn>,
  control: ReturnType<typeof vi.fn> = vi.fn()
) {
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: { claude: { mcp: read, controlMcp: control } } as unknown as AgentsDockAPI
  })
}

describe('ClaudeMcpDialog', () => {
  afterEach(cleanup)

  beforeEach(() => {
    useAppStore.setState({ activeProfileId: 'profile-a', profileGeneration: 4, switchingProfileId: null })
  })

  it('requires an available, versioned Claude MCP capability for command discovery', () => {
    const base: InteractiveProviderCapability = {
      available: false,
      required: false,
      message: 'Claude is configured for print mode.',
      action: null,
      version: 3,
      features: { mcp_management: true }
    }
    expect(claudeMcpCapabilityAdvertised(base)).toBe(true)
    expect(claudeMcpCapabilitySupported(base)).toBe(false)
    expect(claudeMcpCapabilitySupported({ ...base, available: true })).toBe(true)
    expect(claudeMcpCapabilitySupported({ ...base, version: 2 })).toBe(false)
    expect(claudeMcpCapabilitySupported({ ...base, features: {} })).toBe(false)
    expect(claudeMcpCapabilitySupported(null)).toBe(false)
  })

  it('loads bounded server status and explains terminal authentication', async () => {
    const read = vi.fn().mockResolvedValue(snapshot())
    installBridge(read)

    render(<ClaudeMcpDialog open session={session} running={false} supported onOpenChange={vi.fn()} />)

    expect(await screen.findByText('dayone-cli')).toBeInTheDocument()
    expect(read).toHaveBeenCalledWith('claude-chat')
    expect(screen.getByText('Authentication required')).toBeInTheDocument()
    expect(screen.getByText('User scope · 3 tools')).toBeInTheDocument()
    expect(screen.getByText('Open Terminal, run claude, then enter /mcp to authenticate this server. Reconnect it here afterward.')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Disable dayone-cli for this Claude chat' })).toBeChecked()
  })

  it('echoes the opaque generation for chat-scoped enable and disable controls', async () => {
    const first = snapshot()
    const disabled = snapshot({
      generation: 'owner-a:sdk-8',
      servers: [{ ...first.servers[0], enabled: false, status: 'disabled' }],
      action: { type: 'disable', server_name: 'dayone-cli' }
    })
    const read = vi.fn().mockResolvedValue(first)
    const control = vi.fn().mockResolvedValue(disabled)
    installBridge(read, control)
    const user = userEvent.setup()
    render(<ClaudeMcpDialog open session={session} running={false} supported onOpenChange={vi.fn()} />)

    await user.click(await screen.findByRole('switch', { name: 'Disable dayone-cli for this Claude chat' }))

    expect(control).toHaveBeenCalledWith('claude-chat', {
      version: 1,
      action: 'disable',
      server_name: 'dayone-cli',
      expected_generation: 'owner-a:sdk-7'
    })
    expect(await screen.findByRole('switch', { name: 'Enable dayone-cli for this Claude chat' })).not.toBeChecked()
  })

  it('uses one reconnect-all control request for failed and unauthenticated servers', async () => {
    const read = vi.fn().mockResolvedValue(snapshot())
    const control = vi.fn().mockResolvedValue(snapshot({
      generation: 'owner-a:sdk-8',
      action: { type: 'reconnect_all', server_name: null }
    }))
    installBridge(read, control)
    const user = userEvent.setup()
    render(<ClaudeMcpDialog open session={session} running={false} supported onOpenChange={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: /^Reconnect$/ }))

    expect(control).toHaveBeenCalledTimes(1)
    expect(control).toHaveBeenCalledWith('claude-chat', {
      version: 1,
      action: 'reconnect_all',
      server_name: null,
      expected_generation: 'owner-a:sdk-7'
    })
  })

  it('explains truncated lists and the temporary lifetime of enable and disable changes', async () => {
    const read = vi.fn().mockResolvedValue(snapshot({ truncated: true }))
    installBridge(read)
    render(<ClaudeMcpDialog open session={session} running={false} supported onOpenChange={vi.fn()} />)

    expect(await screen.findByText('Some MCP servers are not shown')).toBeInTheDocument()
    expect(screen.getByText('Enable and disable changes last only while this Claude session remains loaded.')).toBeInTheDocument()
    expect(screen.getByText('This server has more MCP servers than AgentsDock can show. Open Terminal on the AgentsServer host, run claude, then enter /mcp to view and manage the complete list.')).toBeInTheDocument()
  })

  it('does not call a fully filtered bounded view an unconfigured server', async () => {
    const read = vi.fn().mockResolvedValue(snapshot({ servers: [], truncated: true }))
    installBridge(read)
    render(<ClaudeMcpDialog open session={session} running={false} supported onOpenChange={vi.fn()} />)

    expect(await screen.findByText('No displayable MCP servers')).toBeInTheDocument()
    expect(screen.queryByText('No MCP servers configured')).not.toBeInTheDocument()
    expect(screen.getByText('Use Claude Code in Terminal on the AgentsServer host to view the complete list.')).toBeInTheDocument()
  })

  it('never paints a deferred snapshot from the previous server profile', async () => {
    const oldProfile = deferred<ClaudeMcpSnapshot>()
    const newProfile = deferred<ClaudeMcpSnapshot>()
    const read = vi.fn()
      .mockImplementationOnce(() => oldProfile.promise)
      .mockImplementationOnce(() => newProfile.promise)
    installBridge(read)
    render(<ClaudeMcpDialog open session={session} running={false} supported onOpenChange={vi.fn()} />)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))

    act(() => useAppStore.setState({ switchingProfileId: 'profile-b' }))
    expect(screen.getByText('Switching AgentsServer')).toBeInTheDocument()
    expect(read).toHaveBeenCalledTimes(1)

    await act(async () => { oldProfile.resolve(snapshot()) })
    expect(screen.queryByText('dayone-cli')).not.toBeInTheDocument()

    act(() => useAppStore.setState({ activeProfileId: 'profile-b', profileGeneration: 5, switchingProfileId: null }))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('dayone-cli')).not.toBeInTheDocument()

    await act(async () => {
      newProfile.resolve(snapshot({
        servers: [{ ...snapshot().servers[0], name: 'new-profile-server' }]
      }))
    })
    expect(await screen.findByText('new-profile-server')).toBeInTheDocument()
    expect(screen.queryByText('dayone-cli')).not.toBeInTheDocument()
  })

  it('does not call the MCP endpoint during an active Claude turn and loads after it finishes', async () => {
    const read = vi.fn().mockResolvedValue(snapshot())
    installBridge(read)
    const view = render(<ClaudeMcpDialog open session={session} running supported onOpenChange={vi.fn()} />)

    expect(screen.getByText('Claude turn in progress')).toBeInTheDocument()
    expect(read).not.toHaveBeenCalled()

    view.rerender(<ClaudeMcpDialog open session={session} running={false} supported onOpenChange={vi.fn()} />)
    expect(await screen.findByText('dayone-cli')).toBeInTheDocument()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('shows print-mode and old-server fallbacks without presenting an empty server list', async () => {
    const read = vi.fn().mockResolvedValue(snapshot({
      available: false,
      transport: 'print',
      generation: null,
      session_loaded: false,
      servers: [],
      reason: { code: 'claude_mcp_print_transport', message: 'Use the Claude Agent SDK transport to manage MCP servers.', retryable: false }
    }))
    installBridge(read)
    const view = render(<ClaudeMcpDialog open session={session} running={false} supported onOpenChange={vi.fn()} />)

    expect(await screen.findByText('Claude is using print mode')).toBeInTheDocument()
    expect(screen.queryByText('No MCP servers configured')).not.toBeInTheDocument()

    view.rerender(<ClaudeMcpDialog open session={session} running={false} supported={false} onOpenChange={vi.fn()} />)
    expect(screen.getByText('Update AgentsServer')).toBeInTheDocument()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('refreshes after a rejected mutation without replaying it', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({ generation: 'owner-b:sdk-1' }))
    const control = vi.fn().mockRejectedValue(new Error('claude_mcp_generation_changed'))
    installBridge(read, control)
    const user = userEvent.setup()
    render(<ClaudeMcpDialog open session={session} running={false} supported onOpenChange={vi.fn()} />)

    await user.click(await screen.findByRole('switch', { name: 'Disable dayone-cli for this Claude chat' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('MCP status changed while this panel was open.')
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(control).toHaveBeenCalledTimes(1)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
