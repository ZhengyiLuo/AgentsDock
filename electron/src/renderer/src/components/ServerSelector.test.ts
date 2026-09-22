import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicServerProfile } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { connectionStateLabel, profileHostSubtitle, ServerSelector, serverProfileHost } from './ServerSelector'

const analytics = vi.hoisted(() => ({ trackEvent: vi.fn() }))
vi.mock('../lib/analytics', () => analytics)

const alpha: PublicServerProfile = {
  id: 'alpha',
  name: 'Alpha',
  serverUrl: 'https://alpha.example:7850',
  serverIdentity: 'server-alpha',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'online',
  cachedUnreadCount: 0
}

const beta: PublicServerProfile = {
  ...alpha,
  id: 'beta',
  name: 'Beta',
  serverUrl: 'https://beta.example:7850',
  serverIdentity: 'server-beta',
  connectionState: 'cached'
}

afterEach(() => {
  cleanup()
  analytics.trackEvent.mockClear()
})
beforeEach(() => useAppStore.setState({ health: null }))

describe('server selector labels', () => {
  it('shows the selected server version and never borrows health from another server', () => {
    useAppStore.setState({
      profiles: [{ ...alpha, serverVersion: '0.1.26-beta.40' }, { ...beta, serverVersion: '0.1.25' }],
      activeProfileId: alpha.id,
      switchingProfileId: null,
      health: { ok: true, server_identity: alpha.serverIdentity!, server_version: '0.1.26-beta.46' }
    })
    render(createElement(ServerSelector))
    expect(screen.getByTitle('AgentsServer v0.1.26-beta.46').parentElement).toHaveTextContent('alpha.example:7850v0.1.26-beta.46')

    act(() => useAppStore.setState({ switchingProfileId: beta.id }))
    expect(screen.queryByTitle('AgentsServer v0.1.26-beta.46')).not.toBeInTheDocument()
    expect(screen.getByTitle('AgentsServer v0.1.26-beta.40')).toBeInTheDocument()

    act(() => useAppStore.setState({ activeProfileId: beta.id, switchingProfileId: null }))
    expect(screen.getByTitle('AgentsServer v0.1.25')).toBeInTheDocument()
    expect(screen.queryByTitle('AgentsServer v0.1.26-beta.46')).not.toBeInTheDocument()

    act(() => useAppStore.setState({ profiles: [alpha, beta] }))
    expect(screen.queryByTitle(/^AgentsServer v/)).not.toBeInTheDocument()
    expect(screen.getByText('beta.example:7850')).toBeInTheDocument()
  })

  it('shows a known version even when the profile name already contains the address', () => {
    useAppStore.setState({
      profiles: [{ ...alpha, name: 'alpha.example:7850', serverVersion: '0.1.26' }],
      activeProfileId: alpha.id,
      switchingProfileId: null
    })
    render(createElement(ServerSelector))
    expect(screen.getByTitle('AgentsServer v0.1.26')).toHaveTextContent('v0.1.26')
    expect(screen.getAllByText('alpha.example:7850')).toHaveLength(1)
  })

  it('extracts the host and port from a server URL', () => {
    expect(serverProfileHost('https://alpha.example:9443/api')).toBe('alpha.example:9443')
    expect(serverProfileHost('not a URL')).toBeNull()
  })

  it('shows a host only when it adds information to the profile name', () => {
    expect(profileHostSubtitle({
      name: 'Production',
      serverUrl: 'https://agents.example/api',
      serverIdentity: 'prod'
    })).toBe('agents.example')
    expect(profileHostSubtitle({
      name: 'agents.example',
      serverUrl: 'https://agents.example/api',
      serverIdentity: 'prod'
    })).toBeNull()
    expect(profileHostSubtitle({
      name: 'Production',
      serverUrl: 'https://agents.example/api',
      serverIdentity: 'AGENTS.EXAMPLE'
    })).toBeNull()
  })

  it('announces the target server while a switch is in progress', () => {
    useAppStore.setState({
      profiles: [alpha, beta],
      activeProfileId: alpha.id,
      switchingProfileId: beta.id
    })

    render(createElement(ServerSelector))

    expect(screen.getByRole('button', { name: 'Switching to Beta. Please wait.' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Switching to Beta. Please wait.')
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
  })

  it('labels a degraded active server and exposes its prerequisite warning', () => {
    const message = 'tmux is missing on this server.'
    useAppStore.setState({
      profiles: [{ ...alpha, connectionState: 'degraded', lastConnectionError: message }],
      activeProfileId: alpha.id,
      switchingProfileId: null
    })

    render(createElement(ServerSelector))

    expect(connectionStateLabel('degraded')).toBe('Degraded')
    expect(screen.getByRole('button', { name: `Alpha, Degraded: ${message}. Choose AgentsServer` }))
      .toHaveTextContent('Alpha')
    expect(screen.getByRole('img', { name: `Degraded: ${message}` })).toHaveClass('degraded')
  })

  it('opens the Server category from the server menu', async () => {
    useAppStore.setState(state => ({
      profiles: [alpha],
      activeProfileId: alpha.id,
      switchingProfileId: null,
      modals: { ...state.modals, settings: false, appSettings: false }
    }))
    let selectedSection: unknown = null
    const selectSection = (event: Event) => { selectedSection = (event as CustomEvent).detail }
    window.addEventListener('agentsdock:app-settings-section', selectSection, { once: true })

    render(createElement(ServerSelector))
    fireEvent.pointerDown(screen.getByRole('button', { name: /Choose AgentsServer/ }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Server Settings' }))

    expect(selectedSection).toBe('server')
    expect(useAppStore.getState().modals).toMatchObject({ settings: false, appSettings: true })
  })

  it('records one successful explicit server switch from the sidebar', async () => {
    const switchServer = vi.fn(async (profileId: string) => {
      useAppStore.setState({ activeProfileId: profileId })
      return true
    })
    useAppStore.setState({
      profiles: [alpha, beta],
      activeProfileId: alpha.id,
      switchingProfileId: null,
      switchServer
    })

    render(createElement(ServerSelector))
    fireEvent.pointerDown(screen.getByRole('button', { name: /Choose AgentsServer/ }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Beta/ }))

    await waitFor(() => expect(analytics.trackEvent).toHaveBeenCalledExactlyOnceWith('server_switched', { success: true }))
    expect(switchServer).toHaveBeenCalledExactlyOnceWith('beta')
  })
})
