import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Health } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { Timeline } from './Timeline'

function importHealth(apiContractVersion: number): Health {
  return {
    ok: true,
    api_contract_version: apiContractVersion,
    capabilities: {
      local_session_import_v1: {
        available: true,
        required: false,
        message: '',
        action: null,
        version: 1,
        max_batch_items: 25,
        max_list_items: 500
      }
    }
  }
}

describe('Timeline empty state Import Chat launcher', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedSessionId: null,
      sessions: [],
      health: importHealth(15),
      modals: {
        settings: false,
        newChat: false,
        resume: false,
        folder: false,
        digest: false,
        job: false,
        search: false,
        review: false,
        importChats: false
      }
    })
  })

  afterEach(cleanup)

  it('opens Import Chat on a fresh API15 server with no chats', async () => {
    const user = userEvent.setup()
    render(<Timeline />)

    await user.click(screen.getByRole('button', { name: 'Import local chats' }))

    expect(useAppStore.getState().modals.importChats).toBe(true)
  })

  it('does not expose Import Chat on API14 even if a capability-shaped field is present', () => {
    useAppStore.setState({ health: importHealth(14) })

    render(<Timeline />)

    expect(screen.queryByRole('button', { name: 'Import local chats' })).not.toBeInTheDocument()
  })
})
