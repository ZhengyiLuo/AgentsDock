import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'

const analytics = vi.hoisted(() => ({
  decision: 'granted' as 'granted' | 'denied',
  setConsent: vi.fn((enabled: boolean) => { analytics.decision = enabled ? 'granted' : 'denied' })
}))

vi.mock('../lib/analytics', () => ({
  ANALYTICS_CONSENT_CHANGED_EVENT: 'agentsdock:analytics-consent-changed',
  ANALYTICS_PRIVACY_POLICY_URL: 'https://agentsdock.net/privacy.html',
  getAnalyticsConsentDecision: () => analytics.decision,
  setAnalyticsConsent: analytics.setConsent
}))

import { AnalyticsPrivacySettings } from './AnalyticsPrivacySettings'

const openExternal = vi.fn().mockResolvedValue(undefined)

describe('desktop analytics settings', () => {
  beforeEach(() => {
    analytics.decision = 'granted'
    vi.clearAllMocks()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { native: { openExternal } } as unknown as AgentsDockAPI
    })
  })
  afterEach(cleanup)

  it('shows the saved choice and links to the privacy policy', () => {
    render(<AnalyticsPrivacySettings />)

    expect(screen.getByRole('switch', { name: 'Share usage analytics' })).toBeChecked()
    expect(screen.getByText(/Messages, files, paths, server details/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Privacy Policy/ }))
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://agentsdock.net/privacy.html')
  })

  it('preserves an earlier opt-out and lets the user change either choice', () => {
    analytics.decision = 'denied'
    render(<AnalyticsPrivacySettings />)

    const toggle = screen.getByRole('switch', { name: 'Share usage analytics' })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    expect(analytics.setConsent).toHaveBeenCalledWith(true)
  })

  it('follows consent changes made elsewhere without writing them again', () => {
    render(<AnalyticsPrivacySettings />)
    const toggle = screen.getByRole('switch', { name: 'Share usage analytics' })

    act(() => window.dispatchEvent(new CustomEvent('agentsdock:analytics-consent-changed', {
      detail: { enabled: false }
    })))

    expect(toggle).not.toBeChecked()
    expect(analytics.setConsent).not.toHaveBeenCalled()
  })
})
