import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicServerProfile, Session } from '@shared/types'
import { EmergencyNotice } from './App'
import { useAppStore } from './store/app-store'

const originalOpenNotificationRoute = useAppStore.getState().openNotificationRoute
const originalAcknowledgeEmergency = useAppStore.getState().acknowledgeEmergency

function profile(id: string, serverIdentity: string | null): PublicServerProfile {
  return {
    id,
    name: id === 'profile-a' ? 'Alpha' : 'Beta',
    serverUrl: `https://${id}.example:7850`,
    serverIdentity,
    hasAccessToken: true,
    serverSetupComplete: true,
    connectionState: 'online',
    cachedUnreadCount: 0
  }
}

function emergencySession(
  id: string,
  alertId: string,
  raisedAt: string,
  message: string,
  title = id === 'newer' ? 'Newer incident' : 'Production watch'
): Session {
  return {
    id,
    title,
    backend: 'codex',
    emergency_alert: {
      id: alertId,
      status: 'active',
      severity: 'critical',
      message,
      raised_at: raisedAt
    },
    unacknowledged_emergency_count: 1
  }
}

describe('EmergencyNotice', () => {
  beforeEach(() => {
    vi.useRealTimers()
    useAppStore.setState({
      profiles: [profile('profile-a', 'server-a')],
      activeProfileId: 'profile-a',
      profileGeneration: 4,
      switchingProfileId: null,
      sessions: [],
      selectedSessionId: null,
      openNotificationRoute: originalOpenNotificationRoute,
      acknowledgeEmergency: originalAcknowledgeEmergency,
      error: null
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows the newest active emergency and queues older notifications behind it', async () => {
    useAppStore.setState({
      sessions: [
        emergencySession('older', 'alert-old', '2026-08-25T12:00:00Z', 'The older incident remains active.'),
        emergencySession('newer', 'alert-new', '2026-08-25T12:05:00Z', 'The newest incident needs attention.')
      ]
    })
    render(<EmergencyNotice />)

    const newest = await screen.findByRole('alert')
    expect(newest).toHaveAttribute('data-alert-id', 'alert-new')
    expect(newest).toHaveTextContent('Emergency in Newer incident')
    expect(newest).toHaveTextContent('1 more emergency alert waiting')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss emergency notification for Newer incident' }))

    expect(screen.getByRole('alert')).toHaveAttribute('data-alert-id', 'alert-old')
    expect(screen.getByText('The older incident remains active.')).toBeVisible()
  })

  it('replaces the currently shown chat alert in place when that chat raises a newer alert', async () => {
    const waiting = emergencySession('waiting', 'alert-waiting', '2026-08-25T12:00:00Z', 'Another chat is waiting.', 'Waiting incident')
    useAppStore.setState({
      sessions: [
        waiting,
        emergencySession('current', 'alert-first', '2026-08-25T12:05:00Z', 'First alert.', 'Current incident')
      ]
    })
    render(<EmergencyNotice />)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveAttribute('data-alert-id', 'alert-first')

    act(() => useAppStore.setState({
      sessions: [
        waiting,
        emergencySession('current', 'alert-replacement', '2026-08-25T12:06:00Z', 'Replacement alert.', 'Current incident')
      ]
    }))

    expect(screen.getByRole('alert')).toHaveAttribute('data-alert-id', 'alert-replacement')
    expect(screen.getByText('Replacement alert.')).toBeVisible()
  })

  it('opens exact profile chats without acknowledging their emergencies', async () => {
    const openNotificationRoute = vi.fn().mockResolvedValue(true)
    const acknowledgeEmergency = vi.fn().mockResolvedValue(true)
    const alert = emergencySession('same', 'alert-open', '2026-08-25T12:05:00Z', 'Open the affected chat.')
    useAppStore.setState({ sessions: [alert], openNotificationRoute, acknowledgeEmergency })
    render(<EmergencyNotice />)
    await screen.findByRole('alert')

    act(() => useAppStore.setState({
      profiles: [profile('profile-a', 'server-a'), profile('profile-b', 'server-b')],
      activeProfileId: 'profile-b',
      profileGeneration: 5,
      sessions: [emergencySession('same', 'other-alert', '2026-08-25T12:06:00Z', 'Another profile.', 'Other profile')]
    }))
    expect(screen.getByRole('alert')).toHaveAttribute('data-alert-id', 'alert-open')
    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }))

    await waitFor(() => expect(openNotificationRoute).toHaveBeenCalledWith({
      profileId: 'profile-a',
      serverIdentity: 'server-a',
      sessionId: 'same'
    }))
    expect(acknowledgeEmergency).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveAttribute('data-alert-id', 'other-alert'))
    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }))
    await waitFor(() => expect(openNotificationRoute).toHaveBeenLastCalledWith({
      profileId: 'profile-b',
      serverIdentity: 'server-b',
      sessionId: 'same'
    }))
    expect(acknowledgeEmergency).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('keeps a failed Open chat action visible and retryable', async () => {
    let finishFirstAttempt: ((opened: boolean) => void) | undefined
    const openNotificationRoute = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishFirstAttempt = resolve }))
      .mockResolvedValueOnce(true)
    useAppStore.setState({
      sessions: [emergencySession('incident', 'alert-retry', '2026-08-25T12:05:00Z', 'Retry navigation.')],
      openNotificationRoute
    })
    render(<EmergencyNotice />)
    await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }))
    expect(screen.getByRole('button', { name: 'Opening' })).toBeDisabled()
    act(() => finishFirstAttempt?.(false))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Open chat' })).toBeEnabled())
    expect(screen.getByRole('alert')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }))

    await waitFor(() => expect(openNotificationRoute).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('keeps the next queued notice disabled while an earlier route is still opening', async () => {
    let finishOpening: ((opened: boolean) => void) | undefined
    const openNotificationRoute = vi.fn(() => new Promise<boolean>(resolve => { finishOpening = resolve }))
    const next = emergencySession('next', 'alert-next', '2026-08-25T12:04:00Z', 'Wait behind navigation.', 'Next incident')
    useAppStore.setState({
      sessions: [
        next,
        emergencySession('current', 'alert-current', '2026-08-25T12:05:00Z', 'Opening this route.', 'Current incident')
      ],
      openNotificationRoute
    })
    render(<EmergencyNotice />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }))

    act(() => useAppStore.setState({ sessions: [next] }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveAttribute('data-alert-id', 'alert-next'))
    expect(screen.getByRole('button', { name: 'Opening' })).toBeDisabled()

    act(() => finishOpening?.(false))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open chat' })).toBeEnabled())
  })

  it('auto-dismisses the in-app notification while leaving the emergency active', () => {
    vi.useFakeTimers()
    useAppStore.setState({
      sessions: [emergencySession('incident', 'alert-timeout', '2026-08-25T12:05:00Z', 'Transient notification.')]
    })
    render(<EmergencyNotice />)

    expect(screen.getByRole('alert')).toBeVisible()
    act(() => vi.advanceTimersByTime(11_999))
    expect(screen.getByRole('alert')).toBeVisible()
    act(() => vi.advanceTimersByTime(1))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(useAppStore.getState().sessions[0].emergency_alert?.status).toBe('active')
  })

  it('does not replay an alert after switching away before dismissal and returning', async () => {
    const alert = emergencySession('incident', 'alert-stable', '2026-08-25T12:05:00Z', 'Do not repeat this toast.')
    useAppStore.setState({ sessions: [alert] })
    render(<EmergencyNotice />)
    await screen.findByRole('alert')

    act(() => useAppStore.setState({
      profiles: [profile('profile-a', 'server-a'), profile('profile-b', 'server-b')],
      activeProfileId: 'profile-b',
      profileGeneration: 5,
      sessions: []
    }))
    expect(screen.getByRole('alert')).toHaveAttribute('data-alert-id', 'alert-stable')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss emergency notification for Production watch' }))

    act(() => useAppStore.setState({ activeProfileId: 'profile-a', profileGeneration: 6, sessions: [alert] }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not resurrect an acknowledged alert from a stale same-ID payload', async () => {
    const alert = emergencySession('incident', 'alert-stale', '2026-08-25T12:05:00Z', 'Do not replay stale data.')
    useAppStore.setState({ sessions: [alert] })
    render(<EmergencyNotice />)
    await screen.findByRole('alert')

    act(() => useAppStore.setState({ sessions: [] }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    act(() => useAppStore.setState({ sessions: [{ ...alert }] }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('updates a cached null-identity notice to the canonical route without replaying it', async () => {
    const openNotificationRoute = vi.fn().mockResolvedValue(true)
    const alert = emergencySession('incident', 'alert-canonical', '2026-08-25T12:05:00Z', 'Identity is being verified.')
    useAppStore.setState({
      profiles: [profile('profile-a', null)],
      sessions: [alert],
      openNotificationRoute
    })
    render(<EmergencyNotice />)
    await screen.findByRole('alert')

    act(() => useAppStore.setState({
      profiles: [profile('profile-a', 'server-a')],
      sessions: [{ ...alert }]
    }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveAttribute('data-alert-id', 'alert-canonical'))
    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }))

    await waitFor(() => expect(openNotificationRoute).toHaveBeenCalledOnce())
    expect(openNotificationRoute).toHaveBeenCalledWith({
      profileId: 'profile-a',
      serverIdentity: 'server-a',
      sessionId: 'incident'
    })
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('does not replay a dismissed null-identity alert after canonical identity adoption', async () => {
    const alert = emergencySession('incident', 'alert-dismissed-canonical', '2026-08-25T12:05:00Z', 'Dismiss before verification.')
    useAppStore.setState({ profiles: [profile('profile-a', null)], sessions: [alert] })
    render(<EmergencyNotice />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss emergency notification for Production watch' }))

    act(() => useAppStore.setState({
      profiles: [profile('profile-a', 'server-a')],
      sessions: [{ ...alert }]
    }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('deduplicates repeated payloads', async () => {
    const alert = emergencySession('incident', 'alert-once', '2026-08-25T12:05:00Z', 'Only notify once.')
    useAppStore.setState({ sessions: [alert] })
    render(<EmergencyNotice />)
    await screen.findByRole('alert')

    act(() => useAppStore.setState({ sessions: [{ ...alert }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss emergency notification for Production watch' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    act(() => useAppStore.setState({ sessions: [{ ...alert }] }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('drops a queued notice when its saved profile disappears', async () => {
    useAppStore.setState({
      sessions: [emergencySession('incident', 'alert-removed', '2026-08-25T12:05:00Z', 'Profile will be removed.')]
    })
    render(<EmergencyNotice />)
    await screen.findByRole('alert')

    act(() => useAppStore.setState({ profiles: [], activeProfileId: null, sessions: [] }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
