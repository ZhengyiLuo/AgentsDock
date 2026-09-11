import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForwardedPort, Session, TerminalWindow } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { TerminalWorkspace } from './TerminalWorkspace'

const xtermHarness = vi.hoisted(() => ({ instances: [] as Array<Record<string, unknown>> }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    attachCustomKeyEventHandler = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    getSelection = vi.fn(() => '')
    hasSelection = vi.fn(() => false)
    loadAddon = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    open = vi.fn()
    refresh = vi.fn()
    resize = vi.fn((columns: number, rows: number) => {
      this.cols = columns
      this.rows = rows
    })
    selectAll = vi.fn()
    write = vi.fn()

    constructor(options: Record<string, unknown>) {
      this.options = options
      xtermHarness.instances.push(this as unknown as Record<string, unknown>)
    }
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit = vi.fn()
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }))
  }
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class MockSearchAddon {
    clearDecorations = vi.fn()
    findNext = vi.fn()
    findPrevious = vi.fn()
  }
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {}
}))

const session: Session = { id: 'chat-1', title: 'Chat', backend: 'codex', cwd: '/workspace' }

const ports = {
  list: vi.fn(async (): Promise<ForwardedPort[]> => []),
  start: vi.fn(),
  stop: vi.fn(async () => undefined),
  open: vi.fn(async () => undefined)
}

const terminal = {
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  write: vi.fn(),
  resize: vi.fn(),
  scroll: vi.fn(),
  windows: vi.fn(async (): Promise<{ windows: TerminalWindow[]; mouse_enabled: boolean; name: string | null }> => ({ windows: [], mouse_enabled: false, name: null })),
  action: vi.fn(async (): Promise<{ windows: TerminalWindow[]; mouse_enabled: boolean; name: string | null }> => ({ windows: [], mouse_enabled: false, name: null })),
  kill: vi.fn(async () => undefined)
}

type TerminalDataPayload = {
  profileId: string
  profileGeneration: number
  sessionId: string
  data: string
}

let terminalDataListener: ((payload: TerminalDataPayload) => void) | null = null
let previousTheme: string | undefined

describe('TerminalWorkspace ports surface', () => {
  beforeEach(() => {
    previousTheme = document.documentElement.dataset.theme
    setLocale('en')
    vi.clearAllMocks()
    xtermHarness.instances.length = 0
    terminalDataListener = null
    ports.list.mockResolvedValue([])
    terminal.connect.mockResolvedValue(undefined)
    terminal.disconnect.mockResolvedValue(undefined)
    terminal.windows.mockResolvedValue({ windows: [], mouse_enabled: false, name: null })
    terminal.action.mockResolvedValue({ windows: [], mouse_enabled: false, name: null })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        events: {
          on: vi.fn((name: string, listener: (payload: unknown) => void) => {
            if (name === 'terminal:data') {
              terminalDataListener = listener as (payload: TerminalDataPayload) => void
            }
            return () => {
              if (name === 'terminal:data') terminalDataListener = null
            }
          })
        },
        native: {
          log: vi.fn(async () => undefined),
          openExternal: vi.fn(async () => undefined),
          readClipboard: vi.fn(async () => ''),
          writeClipboard: vi.fn(async () => undefined)
        },
        ports,
        terminal
      }
    })
    useAppStore.setState({
      activeProfileId: 'profile-a',
      profileGeneration: 4,
      switchingProfileId: null,
      forwardedPorts: [],
      forwardedPortsRevision: 0,
      health: {
        ok: true,
        capabilities: {
          port_forwarding_v1: {
            available: true,
            required: false,
            message: 'Port forwarding is ready.',
            action: null,
            version: 1
          }
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    setLocale('en')
    useAppStore.setState({ health: null })
    if (previousTheme === undefined) delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = previousTheme
  })

  it('uses a white light-theme terminal with original blue selection and unchanged ANSI colors', async () => {
    document.documentElement.dataset.theme = 'light'
    render(<TerminalWorkspace session={session} layoutHeight={360} />)
    await waitFor(() => expect(xtermHarness.instances).toHaveLength(1))

    expect(xtermHarness.instances[0].options).toMatchObject({ theme: {
      background: '#ffffff', foreground: '#1a1a1e', cursor: '#1675d1', cursorAccent: '#ffffff',
      selectionBackground: '#a9d2f4aa', black: '#252523', red: '#c43732', green: '#287f42', yellow: '#9a6b0b',
      blue: '#1769aa', magenta: '#8755a8', cyan: '#167a83', white: '#e9e9e6', brightBlack: '#74746f',
      brightRed: '#e0443e', brightGreen: '#369b54', brightYellow: '#b98210', brightBlue: '#2184d7',
      brightMagenta: '#a268c4', brightCyan: '#2098a2', brightWhite: '#ffffff'
    } })
  })

  it('updates the existing terminal when the app theme changes and preserves the dark palette', async () => {
    document.documentElement.dataset.theme = 'light'
    render(<TerminalWorkspace session={session} layoutHeight={360} />)
    await waitFor(() => expect(xtermHarness.instances).toHaveLength(1))
    const instance = xtermHarness.instances[0]

    act(() => { document.documentElement.dataset.theme = 'dark' })
    await waitFor(() => expect(instance.options).toMatchObject({ theme: {
      background: '#111212', foreground: '#e7e7e4', cursor: '#58a6ff', cursorAccent: '#111212',
      selectionBackground: '#2f628dcc', black: '#111212', red: '#ff625d', green: '#39d98a', yellow: '#f5b83d',
      blue: '#58a6ff', magenta: '#b7a0ff', cyan: '#4fcbd3', white: '#d8d8d5', brightBlack: '#73736f',
      brightRed: '#ff817d', brightGreen: '#62e6a6', brightYellow: '#ffd06b', brightBlue: '#82bdff',
      brightMagenta: '#d0c0ff', brightCyan: '#78e4e9', brightWhite: '#ffffff'
    } }))

    act(() => { document.documentElement.dataset.theme = 'light' })
    await waitFor(() => expect(instance.options).toMatchObject({ theme: {
      background: '#ffffff', foreground: '#1a1a1e', cursor: '#1675d1', cursorAccent: '#ffffff',
      selectionBackground: '#a9d2f4aa'
    } }))
    expect(xtermHarness.instances).toHaveLength(1)
  })

  it('does not commit for unrelated health telemetry replacements', async () => {
    const onRender = vi.fn()
    render(<Profiler id="terminal" onRender={onRender}>
      <TerminalWorkspace session={session} layoutHeight={360} />
    </Profiler>)
    await waitFor(() => expect(ports.list).toHaveBeenCalledWith('profile-a', 4))
    await act(async () => { await Promise.resolve() })
    onRender.mockClear()

    act(() => {
      const health = useAppStore.getState().health!
      useAppStore.setState({
        health: {
          ...health,
          active_runs: [{ id: 'background-team-network-refresh' }]
        }
      })
    })

    expect(onRender).not.toHaveBeenCalled()
  })

  it('coalesces terminal output packets into one xterm write per frame', async () => {
    render(<TerminalWorkspace session={session} layoutHeight={360} />)
    await waitFor(() => expect(terminalDataListener).not.toBeNull())
    const write = xtermHarness.instances[0].write as ReturnType<typeof vi.fn>
    write.mockClear()

    act(() => {
      for (const data of ['first ', 'second ', 'third']) {
        terminalDataListener?.({
          profileId: 'profile-a',
          profileGeneration: 4,
          sessionId: session.id,
          data
        })
      }
    })

    await waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(write).toHaveBeenCalledWith('first second third')
  })

  it('keeps the existing terminal connection and port scope when language changes', async () => {
    render(<TerminalWorkspace session={session} layoutHeight={360} />)
    await waitFor(() => expect(terminal.connect).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(ports.list).toHaveBeenCalledTimes(1))
    const instance = xtermHarness.instances[0]
    act(() => setLocale('zh-CN'))
    expect(xtermHarness.instances).toHaveLength(1)
    expect(xtermHarness.instances[0]).toBe(instance)
    expect(instance.dispose).not.toHaveBeenCalled()
    expect(terminal.disconnect).not.toHaveBeenCalled()
    expect(terminal.connect).toHaveBeenCalledTimes(1)
    expect(ports.list).toHaveBeenCalledTimes(1)
    expect(terminal.action).not.toHaveBeenCalled()
    expect(terminal.kill).not.toHaveBeenCalled()
    act(() => setLocale('en'))
    expect(xtermHarness.instances).toHaveLength(1)
    expect(terminal.disconnect).not.toHaveBeenCalled()
  })

  it('maps an unsupported server capability to a clear update state without calling ports.start', async () => {
    useAppStore.setState({
      health: {
        ok: true,
        capabilities: {
          port_forwarding_v1: {
            available: false,
            required: false,
            message: 'This server is too old for authenticated port forwarding.',
            action: 'Update AgentsServer from Settings.',
            version: 0
          }
        }
      }
    })
    render(<TerminalWorkspace session={session} layoutHeight={360} />)

    fireEvent.click(screen.getByRole('tab', { name: /Ports/ }))

    const unavailable = await screen.findByRole('status')
    expect(unavailable).toHaveTextContent('Server update required')
    expect(unavailable).toHaveTextContent('Update AgentsServer to a build with authenticated port forwarding.')
    expect(screen.queryByRole('button', { name: 'Forward' })).not.toBeInTheDocument()
    expect(ports.list).not.toHaveBeenCalled()
    expect(ports.start).not.toHaveBeenCalled()
  })

  it('shows and suppresses detections for profile-wide forwards owned by another chat', async () => {
    const otherChat: Session = { ...session, id: 'chat-2', title: 'Other chat' }
    ports.list.mockResolvedValue([{
      sessionId: session.id,
      remotePort: 7007,
      localPort: 49152,
      localUrl: 'http://127.0.0.1:49152',
      state: 'open',
      error: null
    }])

    render(<TerminalWorkspace session={otherChat} layoutHeight={360} />)

    await waitFor(() => expect(ports.list).toHaveBeenCalledWith('profile-a', 4))
    const portsTab = screen.getByRole('tab', { name: /Ports/ })
    await waitFor(() => expect(portsTab.querySelector('small')).toHaveTextContent('1'))
    await waitFor(() => expect(terminalDataListener).not.toBeNull())

    act(() => {
      terminalDataListener?.({
        profileId: 'profile-a',
        profileGeneration: 4,
        sessionId: otherChat.id,
        data: 'Ready at http://localhost:7007'
      })
    })

    expect(screen.queryByLabelText('Port 7007 detected')).not.toBeInTheDocument()
  })

  it('does not let a stale background list overwrite a newer ports event', async () => {
    const delayedList = deferred<ForwardedPort[]>()
    const forwardedPort: ForwardedPort = {
      sessionId: session.id,
      remotePort: 7007,
      localPort: 49152,
      localUrl: 'http://127.0.0.1:49152',
      state: 'open',
      error: null
    }
    ports.list.mockImplementationOnce(() => delayedList.promise)
    render(<TerminalWorkspace session={session} layoutHeight={360} />)
    await waitFor(() => expect(ports.list).toHaveBeenCalledWith('profile-a', 4))

    act(() => {
      useAppStore.setState(state => ({
        forwardedPorts: [forwardedPort],
        forwardedPortsRevision: state.forwardedPortsRevision + 1
      }))
    })
    const portsTab = screen.getByRole('tab', { name: /Ports/ })
    await waitFor(() => expect(portsTab.querySelector('small')).toHaveTextContent('1'))

    await act(async () => {
      delayedList.resolve([])
      await delayedList.promise
    })

    expect(portsTab.querySelector('small')).toHaveTextContent('1')
    expect(useAppStore.getState().forwardedPorts).toEqual([forwardedPort])
  })

  it('does not let a late detected-port start overwrite a newer owner', async () => {
    const delayedStart = deferred<ForwardedPort>()
    const replacement: ForwardedPort = {
      sessionId: 'chat-2',
      remotePort: 5173,
      localPort: 49180,
      localUrl: 'http://127.0.0.1:49180',
      state: 'open',
      error: null
    }
    ports.start.mockImplementationOnce(() => delayedStart.promise)
    render(<TerminalWorkspace session={session} layoutHeight={360} />)
    await waitFor(() => expect(terminalDataListener).not.toBeNull())

    act(() => {
      terminalDataListener?.({
        profileId: 'profile-a',
        profileGeneration: 4,
        sessionId: session.id,
        data: 'Ready at http://localhost:5173'
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: /Forward/ }))
    await waitFor(() => expect(ports.start).toHaveBeenCalledOnce())

    act(() => {
      useAppStore.setState(state => ({
        forwardedPorts: [replacement],
        forwardedPortsRevision: state.forwardedPortsRevision + 1
      }))
    })
    ports.list.mockResolvedValue([replacement])
    await act(async () => {
      delayedStart.resolve({
        sessionId: session.id,
        remotePort: 5173,
        localPort: 49170,
        localUrl: 'http://127.0.0.1:49170',
        state: 'open',
        error: null
      })
      await delayedStart.promise
    })

    expect(useAppStore.getState().forwardedPorts).toEqual([replacement])
    expect(screen.getByRole('tab', { name: /Ports/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('leaves the contextual Find command untouched while focus is on Ports', async () => {
    render(<TerminalWorkspace session={session} layoutHeight={360} />)

    const terminalFindButton = screen.getByRole('button', { name: 'Find in terminal' })
    terminalFindButton.focus()
    const terminalEvent = new CustomEvent('agentsdock:find-active-surface', { cancelable: true })
    expect(window.dispatchEvent(terminalEvent)).toBe(false)
    expect(await screen.findByPlaceholderText('Find')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Ports' }))
    const refresh = await screen.findByRole('button', { name: 'Refresh forwarded ports' })
    refresh.focus()
    await waitFor(() => expect(refresh).toHaveFocus())

    const portsEvent = new CustomEvent('agentsdock:find-active-surface', { cancelable: true })
    expect(window.dispatchEvent(portsEvent)).toBe(true)
    expect(portsEvent.defaultPrevented).toBe(false)
    expect(screen.queryByPlaceholderText('Find')).not.toBeInTheDocument()
  })

  it('clears the forwarded-port badge when capability is lost on the Terminal surface', async () => {
    terminal.action.mockResolvedValue({
      windows: [{ id: 'window-0', index: 0, name: 'main', active: true, panes: 1 }],
      mouse_enabled: false,
      name: 'Chat'
    })
    ports.list.mockResolvedValue([{
      sessionId: session.id,
      remotePort: 7007,
      localPort: 49152,
      localUrl: 'http://127.0.0.1:49152',
      state: 'open',
      error: null
    }])
    render(<TerminalWorkspace session={session} layoutHeight={360} />)

    fireEvent.click(screen.getByRole('button', { name: 'New tmux window' }))
    const terminalTab = await screen.findByRole('tab', { name: /main/ })
    fireEvent.click(screen.getByRole('tab', { name: /Ports/ }))
    const portsTab = screen.getByRole('tab', { name: /Ports/ })
    await waitFor(() => expect(portsTab.querySelector('small')).toHaveTextContent('1'))
    fireEvent.click(terminalTab)

    act(() => {
      useAppStore.setState({
        health: {
          ok: true,
          capabilities: {
            port_forwarding_v1: {
              available: false,
              required: false,
              message: 'Port forwarding is unavailable.',
              action: null,
              version: 1
            }
          }
        }
      })
    })

    await waitFor(() => expect(portsTab.querySelector('small')).toBeNull())
    expect(terminalTab).toHaveAttribute('aria-selected', 'true')
  })

  it('ignores a delayed detected-port start after forwarding becomes unavailable', async () => {
    const delayedStart = deferred<ForwardedPort>()
    ports.start.mockImplementationOnce(() => delayedStart.promise)
    render(<TerminalWorkspace session={session} layoutHeight={360} />)
    await waitFor(() => expect(terminalDataListener).not.toBeNull())

    act(() => {
      terminalDataListener?.({
        profileId: 'profile-a',
        profileGeneration: 4,
        sessionId: session.id,
        data: 'Ready at http://localhost:5173'
      })
    })
    fireEvent.click(await screen.findByRole('button', { name: /Forward/ }))
    await waitFor(() => expect(ports.start).toHaveBeenCalledWith('profile-a', 4, session.id, 5173))

    act(() => {
      useAppStore.setState({
        health: {
          ok: true,
          capabilities: {
            port_forwarding_v1: {
              available: false,
              required: false,
              message: 'Port forwarding is unavailable.',
              action: null,
              version: 1
            }
          }
        }
      })
    })
    await act(async () => {
      delayedStart.resolve({
        sessionId: session.id,
        remotePort: 5173,
        localPort: 49153,
        localUrl: 'http://127.0.0.1:49153',
        state: 'open',
        error: null
      })
      await delayedStart.promise
    })

    const portsTab = screen.getByRole('tab', { name: /Ports/ })
    expect(portsTab).toHaveAttribute('aria-selected', 'false')
    act(() => {
      useAppStore.setState({
        health: {
          ok: true,
          capabilities: {
            port_forwarding_v1: {
              available: true,
              required: false,
              message: 'Port forwarding is ready.',
              action: null,
              version: 1
            }
          }
        }
      })
    })
    expect(await screen.findByLabelText('Port 5173 detected')).toBeInTheDocument()
  })

  it('retains only the 16 newest terminal port detections', async () => {
    ports.list.mockResolvedValue([])
    render(<TerminalWorkspace session={session} layoutHeight={360} />)
    await waitFor(() => expect(terminalDataListener).not.toBeNull())

    const emittedPorts = Array.from({ length: 20 }, (_, index) => 4_100 + index)
    act(() => {
      terminalDataListener?.({
        profileId: 'profile-a',
        profileGeneration: 4,
        sessionId: session.id,
        data: emittedPorts.map(port => `Ready at http://localhost:${port}`).join('\n')
      })
    })

    fireEvent.click(screen.getByRole('tab', { name: /Ports/ }))
    await screen.findByText('Detected in terminal')

    expect(screen.getAllByRole('button', { name: /Dismiss port \d+ suggestion/ })).toHaveLength(16)
    for (const port of emittedPorts.slice(0, 4)) {
      expect(screen.queryByText(`http://localhost:${port}`)).not.toBeInTheDocument()
    }
    for (const port of emittedPorts.slice(-16)) {
      expect(screen.getByText(`http://localhost:${port}`)).toBeInTheDocument()
    }

    act(() => {
      terminalDataListener?.({
        profileId: 'profile-a',
        profileGeneration: 4,
        sessionId: session.id,
        data: '\nBuild finished successfully.\n'
      })
    })

    for (const port of emittedPorts.slice(0, 4)) {
      expect(screen.queryByText(`http://localhost:${port}`)).not.toBeInTheDocument()
    }
    for (const port of emittedPorts.slice(-16)) {
      expect(screen.getByText(`http://localhost:${port}`)).toBeInTheDocument()
    }
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}
