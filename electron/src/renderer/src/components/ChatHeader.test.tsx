import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../store/app-store'
import { ChatHeader } from './ChatHeader'

describe('ChatHeader', () => {
  afterEach(cleanup)

  beforeEach(() => {
    useAppStore.setState({
      connected: false,
      connectionError: 'Server unavailable',
      sessions: [],
      selectedSessionId: null,
      modals: {
        settings: false,
        newChat: false,
        resume: false,
        folder: false,
        digest: false,
        job: false,
        search: false,
        review: false
      }
    })
  })

  it('opens connection settings from the disconnected startup header', async () => {
    render(<ChatHeader />)

    const button = screen.getByRole('button', { name: 'Server connection: Offline' })
    expect(button).toHaveClass('offline')

    await userEvent.setup().click(button)

    expect(useAppStore.getState().modals.settings).toBe(true)
  })
})
