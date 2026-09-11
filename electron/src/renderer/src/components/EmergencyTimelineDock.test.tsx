import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicServerProfile, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { EmergencyTimelineDock } from './EmergencyTimelineDock'

const originalOpenNotificationRoute = useAppStore.getState().openNotificationRoute
const originalAcknowledgeEmergency = useAppStore.getState().acknowledgeEmergency

const profile: PublicServerProfile = {
  id: 'profile-a',
  name: 'Production',
  serverUrl: 'https://production.example:7850',
  serverIdentity: 'server-a',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'online',
  cachedUnreadCount: 0
}

function emergencySession(id: string, title: string, alertId: string, raisedAt: string): Session {
  return {
    id,
    title,
    backend: 'codex',
    emergency_alert: {
      id: alertId,
      status: 'active',
      severity: 'critical',
      message: `${title} needs immediate attention.`,
      raised_at: raisedAt
    },
    unacknowledged_emergency_count: 1
  }
}

describe('EmergencyTimelineDock', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeProfileId: profile.id,
      profileGeneration: 3,
      profiles: [profile],
      switchingProfileId: null,
      sessions: [],
      selectedSessionId: 'current',
      openNotificationRoute: originalOpenNotificationRoute,
      acknowledgeEmergency: originalAcknowledgeEmergency,
      error: null
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps the newest active emergency reachable without a dismiss control', () => {
    useAppStore.setState({
      sessions: [
        { id: 'current', title: 'Current chat', backend: 'codex' },
        emergencySession('older', 'Older incident', 'alert-old', '2026-09-05T12:00:00Z'),
        emergencySession('newer', 'Newest incident', 'alert-new', '2026-09-05T12:05:00Z')
      ]
    })

    render(<EmergencyTimelineDock sessionId="current" focused />)

    const dock = screen.getByRole('region', { name: 'Active emergency in Newest incident' })
    expect(dock).toHaveAttribute('data-alert-id', 'alert-new')
    expect(dock).toHaveTextContent('Newest incident needs immediate attention.')
    expect(dock).toHaveTextContent('1 more active emergency')
    expect(screen.getByRole('button', { name: 'Open emergency chat Newest incident' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument()
  })

  it('opens the exact emergency route and remains visible when navigation fails', async () => {
    let finishFirstAttempt!: (opened: boolean) => void
    const openNotificationRoute = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishFirstAttempt = resolve }))
      .mockResolvedValueOnce(true)
    useAppStore.setState({
      sessions: [
        { id: 'current', title: 'Current chat', backend: 'codex' },
        emergencySession('incident', 'Production incident', 'alert-route', '2026-09-05T12:05:00Z')
      ],
      openNotificationRoute
    })
    render(<EmergencyTimelineDock sessionId="current" focused />)

    const button = screen.getByRole('button', { name: 'Open emergency chat Production incident' })
    fireEvent.click(button)
    expect(button).toBeDisabled()
    act(() => finishFirstAttempt(false))

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t open the chat. Try again.')
    expect(button).toBeEnabled()
    fireEvent.click(button)

    await waitFor(() => expect(openNotificationRoute).toHaveBeenCalledTimes(2))
    expect(openNotificationRoute).toHaveBeenLastCalledWith({
      profileId: 'profile-a',
      serverIdentity: 'server-a',
      sessionId: 'incident'
    })
  })

  it('prioritizes the focused chat emergency and keeps acknowledgement retryable', async () => {
    const current = emergencySession('current', 'Focused incident', 'alert-current', '2026-09-05T12:00:00Z')
    const newer = emergencySession('newer', 'Newer incident', 'alert-newer', '2026-09-05T12:05:00Z')
    const acknowledgeEmergency = vi.fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        act(() => useAppStore.setState({ sessions: [newer] }))
        return true
      })
    useAppStore.setState({ sessions: [current, newer], acknowledgeEmergency })
    render(<EmergencyTimelineDock sessionId="current" focused />)

    const button = screen.getByRole('button', { name: 'Acknowledge emergency in Focused incident' })
    fireEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t acknowledge. Try again.')
    expect(button).toBeEnabled()
    fireEvent.click(button)

    await waitFor(() => expect(acknowledgeEmergency).toHaveBeenCalledTimes(2))
    expect(acknowledgeEmergency).toHaveBeenLastCalledWith('current', 'alert-current')
    expect(await screen.findByRole('region', { name: 'Active emergency in Newer incident' })).toHaveAttribute('data-alert-id', 'alert-newer')
  })

  it('renders only for the focused pane and hides during profile switching', () => {
    useAppStore.setState({
      sessions: [emergencySession('incident', 'Production incident', 'alert-hidden', '2026-09-05T12:05:00Z')]
    })
    const { rerender } = render(<EmergencyTimelineDock sessionId="current" focused={false} />)
    expect(screen.queryByRole('region')).not.toBeInTheDocument()

    rerender(<EmergencyTimelineDock sessionId="current" focused />)
    expect(screen.getByRole('region', { name: 'Active emergency in Production incident' })).toBeVisible()

    act(() => useAppStore.setState({ switchingProfileId: 'profile-b' }))
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
})
