import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PublicServerProfile } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { connectionStateLabel, profileHostSubtitle, ServerSelector, serverProfileHost } from './ServerSelector'

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

afterEach(cleanup)

describe('server selector labels', () => {
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
})
