import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForwardedPort } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { PortsPanel } from './PortsPanel'

const openPort: ForwardedPort = {
  sessionId: 'chat-1',
  remotePort: 7007,
  localPort: 49152,
  localUrl: 'http://127.0.0.1:49152',
  state: 'open',
  error: null
}

const ports = {
  list: vi.fn(async (_profileId: string, _generation: number) => [openPort]),
  start: vi.fn(async (_profileId: string, _generation: number, sessionId: string, remotePort: number, preferredLocalPort?: number) => ({
    sessionId,
    remotePort,
    localPort: preferredLocalPort ?? 49153,
    localUrl: `http://127.0.0.1:${preferredLocalPort ?? 49153}`,
    state: 'open' as const,
    error: null
  })),
  stop: vi.fn(async () => undefined),
  open: vi.fn(async () => undefined)
}

let portsChangedListener: ((payload: {
  profileId: string
  profileGeneration: number
  ports: ForwardedPort[]
}) => void) | null = null

describe('PortsPanel', () => {
  beforeEach(() => {
    setLocale('en')
    vi.clearAllMocks()
    portsChangedListener = null
    ports.list.mockResolvedValue([openPort])
    ports.start.mockImplementation(async (_profileId, _generation, sessionId, remotePort, preferredLocalPort) => ({
      sessionId,
      remotePort,
      localPort: preferredLocalPort ?? 49153,
      localUrl: `http://127.0.0.1:${preferredLocalPort ?? 49153}`,
      state: 'open' as const,
      error: null
    }))
    ports.stop.mockResolvedValue(undefined)
    ports.open.mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        events: {
          on: vi.fn((name: string, listener: typeof portsChangedListener) => {
            if (name === 'ports:changed') portsChangedListener = listener
            return () => {
              if (name === 'ports:changed') portsChangedListener = null
            }
          })
        },
        ports
      }
    })
  })

  afterEach(() => { cleanup(); setLocale('en') })

  it('shows a forward owned by another chat and wires profile-wide Open and Stop', async () => {
    renderPanel({ sessionId: 'chat-2' })

    expect(await screen.findByText('http://127.0.0.1:49152')).toBeInTheDocument()
    expect(screen.getByText('Forwarding')).toBeInTheDocument()
    expect(screen.getByText('Shared across chats on this server; available only on this computer.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(ports.open).toHaveBeenCalledWith('profile-a', 4, 7007))

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(ports.stop).toHaveBeenCalledWith('profile-a', 4, 7007))
    expect(screen.queryByText('http://127.0.0.1:49152')).not.toBeInTheDocument()
  })

  it('preserves the entered ports across language changes before starting a manual forward', async () => {
    ports.list.mockResolvedValue([])
    renderPanel()
    await screen.findByText('Nothing forwarded yet')

    fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: '8080' } })
    fireEvent.change(screen.getByLabelText('Preferred local port'), { target: { value: '18080' } })
    const remoteInput = screen.getByLabelText('Remote port')
    const localInput = screen.getByLabelText('Preferred local port')
    act(() => setLocale('zh-CN'))
    expect(remoteInput).toHaveValue('8080')
    expect(localInput).toHaveValue('18080')
    expect(ports.list).toHaveBeenCalledTimes(1)
    expect(ports.start).not.toHaveBeenCalled()
    act(() => setLocale('en'))
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))

    await waitFor(() => expect(ports.start).toHaveBeenCalledWith('profile-a', 4, 'chat-1', 8080, 18080))
    expect(await screen.findByText('http://127.0.0.1:18080')).toBeInTheDocument()
  })

  it('applies an immediate profile-wide change event from another chat', async () => {
    ports.list.mockResolvedValue([])
    renderPanel({ sessionId: 'chat-2' })
    await screen.findByText('Nothing forwarded yet')

    act(() => {
      portsChangedListener?.({
        profileId: 'profile-a',
        profileGeneration: 4,
        ports: [openPort]
      })
    })

    expect(await screen.findByText(openPort.localUrl)).toBeInTheDocument()

    act(() => {
      portsChangedListener?.({
        profileId: 'profile-b',
        profileGeneration: 5,
        ports: []
      })
    })
    expect(screen.getByText(openPort.localUrl)).toBeInTheDocument()
  })

  it('does not let a late start response replace a newer cross-chat owner', async () => {
    const delayedStart = deferred<Awaited<ReturnType<typeof ports.start>>>()
    const replacement: ForwardedPort = {
      sessionId: 'chat-2',
      remotePort: 8080,
      localPort: 49180,
      localUrl: 'http://127.0.0.1:49180',
      state: 'open',
      error: null
    }
    ports.list.mockResolvedValue([])
    ports.start.mockImplementationOnce(() => delayedStart.promise)
    renderPanel()
    await screen.findByText('Nothing forwarded yet')

    fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: '8080' } })
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    await waitFor(() => expect(ports.start).toHaveBeenCalledOnce())

    act(() => {
      portsChangedListener?.({ profileId: 'profile-a', profileGeneration: 4, ports: [replacement] })
    })
    expect(await screen.findByText(replacement.localUrl)).toBeInTheDocument()

    await act(async () => {
      delayedStart.resolve({
        sessionId: 'chat-1',
        remotePort: 8080,
        localPort: 49170,
        localUrl: 'http://127.0.0.1:49170',
        state: 'open',
        error: null
      })
      await delayedStart.promise
    })

    expect(screen.getByText(replacement.localUrl)).toBeInTheDocument()
    expect(screen.queryByText('http://127.0.0.1:49170')).not.toBeInTheDocument()
  })

  it('offers a one-click forward for a service detected in terminal output', async () => {
    ports.list.mockResolvedValue([])
    const dismiss = vi.fn()
    renderPanel({
      detections: [{ remotePort: 5173, url: 'http://localhost:5173/', label: 'Local service' }],
      onDismissDetection: dismiss
    })
    const detected = (await screen.findByText('Detected in terminal')).closest('section')
    expect(detected).not.toBeNull()

    fireEvent.click(within(detected as HTMLElement).getByRole('button', { name: 'Forward' }))

    await waitFor(() => expect(ports.start).toHaveBeenCalledWith('profile-a', 4, 'chat-1', 5173, undefined))
    expect(dismiss).toHaveBeenCalledWith(5173)
  })

  it('shows a server-update state without invoking the port bridge when forwarding is unavailable', async () => {
    const unavailableAction = vi.fn()
    renderPanel({
      available: false,
      unavailableTitle: 'Server update required',
      unavailableMessage: 'Update AgentsServer before forwarding ports.',
      unavailableActionLabel: 'Open server updates',
      onUnavailableAction: unavailableAction
    })

    const unavailable = await screen.findByRole('status')
    expect(unavailable).toHaveTextContent('Server update required')
    expect(unavailable).toHaveTextContent('Update AgentsServer before forwarding ports.')
    expect(screen.queryByRole('button', { name: 'Forward' })).not.toBeInTheDocument()
    expect(ports.list).not.toHaveBeenCalled()
    expect(ports.start).not.toHaveBeenCalled()

    fireEvent.click(within(unavailable).getByRole('button', { name: 'Open server updates' }))
    expect(unavailableAction).toHaveBeenCalledOnce()
    expect(ports.start).not.toHaveBeenCalled()
  })

  it('serializes detected-port starts and preserves the first failure', async () => {
    const firstStart = deferred<Awaited<ReturnType<typeof ports.start>>>()
    ports.list.mockResolvedValue([])
    ports.start.mockImplementationOnce(() => firstStart.promise)
    renderPanel({
      detections: [
        { remotePort: 5173, url: 'http://localhost:5173/', label: 'Vite' },
        { remotePort: 8080, url: 'http://localhost:8080/', label: 'Local service' }
      ]
    })

    const detected = (await screen.findByText('Detected in terminal')).closest('section')
    expect(detected).not.toBeNull()
    const forwardButtons = within(detected as HTMLElement).getAllByRole('button', { name: 'Forward' })

    fireEvent.click(forwardButtons[0])
    fireEvent.click(forwardButtons[1])

    expect(ports.start).toHaveBeenCalledTimes(1)
    expect(ports.start).toHaveBeenLastCalledWith('profile-a', 4, 'chat-1', 5173, undefined)

    await act(async () => {
      firstStart.reject(new Error('remote port refused the connection'))
      try {
        await firstStart.promise
      } catch {
        // The component owns this rejection; awaiting it only flushes React state.
      }
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('remote port refused the connection')
    expect(ports.start).toHaveBeenCalledTimes(1)

    fireEvent.click(forwardButtons[1])
    await waitFor(() => expect(ports.start).toHaveBeenCalledTimes(2))
    expect(ports.start).toHaveBeenLastCalledWith('profile-a', 4, 'chat-1', 8080, undefined)
  })

  it('shows a start failure after manager snapshots report starting and cleanup', async () => {
    const delayedStart = deferred<Awaited<ReturnType<typeof ports.start>>>()
    ports.list.mockResolvedValue([])
    ports.start.mockImplementationOnce(() => delayedStart.promise)
    renderPanel()
    await screen.findByText('Nothing forwarded yet')

    fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: '8080' } })
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    await waitFor(() => expect(ports.start).toHaveBeenCalledOnce())

    act(() => {
      portsChangedListener?.({
        profileId: 'profile-a',
        profileGeneration: 4,
        ports: [{
          sessionId: 'chat-1',
          remotePort: 8080,
          localPort: 0,
          localUrl: '',
          state: 'starting',
          error: null
        }]
      })
      portsChangedListener?.({ profileId: 'profile-a', profileGeneration: 4, ports: [] })
    })

    await act(async () => {
      delayedStart.reject(new Error('could not listen on a local port'))
      try {
        await delayedStart.promise
      } catch {
        // The component reports this rejection through its inline error state.
      }
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('could not listen on a local port')
  })

  it('finishes a stop before allowing the same remote port to start again', async () => {
    const delayedStop = deferred<undefined>()
    ports.stop.mockImplementationOnce(() => delayedStop.promise)
    renderPanel()
    expect(await screen.findByText(openPort.localUrl as string)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(ports.stop).toHaveBeenCalledWith('profile-a', 4, 7007))
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(ports.open).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: '7007' } })
    const form = screen.getByLabelText('Remote port').closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form as HTMLFormElement)
    expect(ports.start).not.toHaveBeenCalled()

    await act(async () => {
      delayedStop.resolve(undefined)
      await delayedStop.promise
    })
    await waitFor(() => expect(screen.queryByText(openPort.localUrl as string)).not.toBeInTheDocument())

    fireEvent.submit(form as HTMLFormElement)
    await waitFor(() => expect(ports.start).toHaveBeenCalledWith('profile-a', 4, 'chat-1', 7007, undefined))
  })

  it('does not let a late stop response remove a newer cross-chat restart', async () => {
    const delayedStop = deferred<undefined>()
    const replacement: ForwardedPort = {
      ...openPort,
      sessionId: 'chat-2',
      localPort: 49180,
      localUrl: 'http://127.0.0.1:49180'
    }
    ports.stop.mockImplementationOnce(() => delayedStop.promise)
    renderPanel()
    expect(await screen.findByText(openPort.localUrl)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(ports.stop).toHaveBeenCalledOnce())
    act(() => {
      portsChangedListener?.({ profileId: 'profile-a', profileGeneration: 4, ports: [replacement] })
    })

    await act(async () => {
      delayedStop.resolve(undefined)
      await delayedStop.promise
    })

    expect(screen.getByText(replacement.localUrl)).toBeInTheDocument()
    expect(screen.queryByText(openPort.localUrl)).not.toBeInTheDocument()
  })

  it('preserves a stop failure when a competing same-port start is attempted', async () => {
    const delayedStop = deferred<undefined>()
    ports.stop.mockImplementationOnce(() => delayedStop.promise)
    renderPanel()
    expect(await screen.findByText(openPort.localUrl as string)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(ports.stop).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: '7007' } })
    const form = screen.getByLabelText('Remote port').closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form as HTMLFormElement)

    expect(ports.start).not.toHaveBeenCalled()
    expect(ports.open).not.toHaveBeenCalled()
    await act(async () => {
      delayedStop.reject(new Error('could not stop port 7007'))
      try {
        await delayedStop.promise
      } catch {
        // The component reports this rejection through its inline error state.
      }
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('could not stop port 7007')
    expect(screen.getByText(openPort.localUrl as string)).toBeInTheDocument()
    expect(ports.start).not.toHaveBeenCalled()
  })

  it('blocks stop and start while Open is pending and keeps the Open error visible', async () => {
    const delayedOpen = deferred<undefined>()
    ports.open.mockImplementationOnce(() => delayedOpen.promise)
    renderPanel()
    expect(await screen.findByText(openPort.localUrl as string)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(ports.open).toHaveBeenCalledWith('profile-a', 4, 7007))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: '7007' } })
    const form = screen.getByLabelText('Remote port').closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form as HTMLFormElement)

    expect(ports.stop).not.toHaveBeenCalled()
    expect(ports.start).not.toHaveBeenCalled()
    await act(async () => {
      delayedOpen.reject(new Error('could not open the local browser'))
      try {
        await delayedOpen.promise
      } catch {
        // The component reports this rejection through its inline error state.
      }
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('could not open the local browser')
    expect(screen.getByText(openPort.localUrl as string)).toBeInTheDocument()
  })

  it('rejects invalid port numbers before calling the bridge', async () => {
    ports.list.mockResolvedValue([])
    renderPanel()
    await screen.findByText('Nothing forwarded yet')

    fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: '70000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('between 1024 and 65535')
    expect(ports.start).not.toHaveBeenCalled()
  })

  it('keeps a delayed profile A list result from replacing profile B ports', async () => {
    const profileAList = deferred<ForwardedPort[]>()
    const profileBPort: ForwardedPort = {
      ...openPort,
      sessionId: 'chat-2',
      remotePort: 8080,
      localPort: 49160,
      localUrl: 'http://127.0.0.1:49160'
    }
    ports.list.mockImplementation((profileId) => (
      profileId === 'profile-a' ? profileAList.promise : Promise.resolve([profileBPort])
    ))
    const onPortsChange = vi.fn()
    const view = renderPanel({ onPortsChange })

    view.rerender(<PortsPanel {...panelProps({
      profileId: 'profile-b',
      profileGeneration: 5,
      sessionId: 'chat-2',
      onPortsChange
    })} />)

    expect(await screen.findByText('http://127.0.0.1:49160')).toBeInTheDocument()
    await act(async () => {
      profileAList.resolve([openPort])
      await profileAList.promise
    })

    expect(screen.queryByText(openPort.localUrl as string)).not.toBeInTheDocument()
    expect(screen.getByText('http://127.0.0.1:49160')).toBeInTheDocument()
    expect(onPortsChange).not.toHaveBeenLastCalledWith([openPort])
  })

  it('drops a delayed list result when forwarding becomes unavailable', async () => {
    const delayedList = deferred<ForwardedPort[]>()
    const onPortsChange = vi.fn()
    ports.list.mockImplementationOnce(() => delayedList.promise)
    const view = renderPanel({ onPortsChange })

    view.rerender(<PortsPanel {...panelProps({
      available: false,
      unavailableTitle: 'Port forwarding unavailable',
      unavailableMessage: 'The server capability was withdrawn.',
      onPortsChange
    })} />)
    expect(await screen.findByRole('status')).toHaveTextContent('Port forwarding unavailable')

    await act(async () => {
      delayedList.resolve([openPort])
      await delayedList.promise
    })

    expect(screen.queryByText(openPort.localUrl as string)).not.toBeInTheDocument()
    expect(onPortsChange).not.toHaveBeenLastCalledWith([openPort])
  })

  it('ignores a delayed start result after the panel scope changes', async () => {
    const delayedStart = deferred<Awaited<ReturnType<typeof ports.start>>>()
    const dismissA = vi.fn()
    const dismissB = vi.fn()
    ports.list.mockResolvedValue([])
    ports.start.mockImplementationOnce(() => delayedStart.promise)
    const view = renderPanel({ onDismissDetection: dismissA })
    await screen.findByText('Nothing forwarded yet')

    fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: '8080' } })
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    await waitFor(() => expect(ports.start).toHaveBeenCalledWith('profile-a', 4, 'chat-1', 8080, undefined))

    view.rerender(<PortsPanel {...panelProps({
      profileId: 'profile-b',
      profileGeneration: 5,
      sessionId: 'chat-2',
      onDismissDetection: dismissB
    })} />)
    await act(async () => {
      delayedStart.resolve({
        sessionId: 'chat-1',
        remotePort: 8080,
        localPort: 49161,
        localUrl: 'http://127.0.0.1:49161',
        state: 'open',
        error: null
      })
      await delayedStart.promise
    })

    expect(screen.queryByText('http://127.0.0.1:49161')).not.toBeInTheDocument()
    expect(dismissA).not.toHaveBeenCalled()
    expect(dismissB).not.toHaveBeenCalled()
  })

  it('ignores a delayed start result when forwarding becomes unavailable', async () => {
    const delayedStart = deferred<Awaited<ReturnType<typeof ports.start>>>()
    const dismiss = vi.fn()
    ports.list.mockResolvedValue([])
    ports.start.mockImplementationOnce(() => delayedStart.promise)
    const view = renderPanel({ onDismissDetection: dismiss })
    await screen.findByText('Nothing forwarded yet')

    fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: '8080' } })
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    await waitFor(() => expect(ports.start).toHaveBeenCalledWith('profile-a', 4, 'chat-1', 8080, undefined))

    view.rerender(<PortsPanel {...panelProps({
      available: false,
      unavailableTitle: 'Port forwarding unavailable',
      unavailableMessage: 'The server capability was withdrawn.',
      onDismissDetection: dismiss
    })} />)
    await act(async () => {
      delayedStart.resolve({
        sessionId: 'chat-1',
        remotePort: 8080,
        localPort: 49161,
        localUrl: 'http://127.0.0.1:49161',
        state: 'open',
        error: null
      })
      await delayedStart.promise
    })

    expect(await screen.findByRole('status')).toHaveTextContent('Port forwarding unavailable')
    expect(screen.queryByText('http://127.0.0.1:49161')).not.toBeInTheDocument()
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('keeps profile B ports when a profile A stop finishes late', async () => {
    const delayedStop = deferred<undefined>()
    const profileBPort: ForwardedPort = {
      ...openPort,
      sessionId: 'chat-2',
      remotePort: 8080,
      localPort: 49162,
      localUrl: 'http://127.0.0.1:49162'
    }
    ports.list.mockImplementation((profileId) => Promise.resolve(profileId === 'profile-a' ? [openPort] : [profileBPort]))
    ports.stop.mockImplementationOnce(() => delayedStop.promise)
    const view = renderPanel()
    expect(await screen.findByText(openPort.localUrl as string)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(ports.stop).toHaveBeenCalledWith('profile-a', 4, 7007))
    view.rerender(<PortsPanel {...panelProps({
      profileId: 'profile-b',
      profileGeneration: 5,
      sessionId: 'chat-2'
    })} />)
    expect(await screen.findByText('http://127.0.0.1:49162')).toBeInTheDocument()

    await act(async () => {
      delayedStop.resolve(undefined)
      await delayedStop.promise
    })

    expect(screen.getByText('http://127.0.0.1:49162')).toBeInTheDocument()
  })
})

function renderPanel(overrides: Partial<Parameters<typeof PortsPanel>[0]> = {}) {
  return render(<PortsPanel {...panelProps(overrides)} />)
}

function panelProps(overrides: Partial<Parameters<typeof PortsPanel>[0]> = {}): Parameters<typeof PortsPanel>[0] {
  return {
    profileId: 'profile-a',
    profileGeneration: 4,
    sessionId: 'chat-1',
    detections: [],
    onDismissDetection: () => undefined,
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}
