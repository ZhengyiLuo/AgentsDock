import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { CodexGoalsConfiguration } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { CODEX_GOALS_CONFIGURATION_CHANGED_EVENT } from '../lib/codex-goals'
import { CodexServerSettings } from './CodexServerSettings'

function installBridge(codex: Partial<AgentsDockAPI['codex']>) {
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: { codex } as unknown as AgentsDockAPI
  })
}

describe('CodexServerSettings', () => {
  afterEach(cleanup)
  afterEach(() => setLocale('en'))

  it('keeps Persistent Codex goals in English within Chinese settings', async () => {
    setLocale('zh-CN')
    const setServerGoals = vi.fn()
    installBridge({
      serverGoals: vi.fn().mockResolvedValue({ enabled: true, configurable: true, message: 'Goals enabled.' }),
      setServerGoals
    })

    render(<CodexServerSettings connected profileId="profile" profileGeneration={1} />)
    expect(screen.getByText('Persistent Codex goals', { exact: true })).toBeInTheDocument()
    const toggle = await screen.findByRole('switch', { name: '允许在此服务端使用 Persistent Codex goals' })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(setServerGoals).not.toHaveBeenCalled()
  })

  it('waits for the server before changing the visible setting', async () => {
    let resolveUpdate: ((value: CodexGoalsConfiguration) => void) | undefined
    const setServerGoals = vi.fn((_enabled: boolean) => new Promise<CodexGoalsConfiguration>(resolve => { resolveUpdate = resolve }))
    const changed = vi.fn()
    window.addEventListener(CODEX_GOALS_CONFIGURATION_CHANGED_EVENT, changed, { once: true })
    installBridge({
      serverGoals: vi.fn().mockResolvedValue({ enabled: true, configurable: true, message: 'Goals enabled.' }),
      setServerGoals
    })

    render(<CodexServerSettings connected profileId="profile" profileGeneration={1} />)
    const toggle = await screen.findByRole('switch', { name: 'Allow persistent Codex goals on this server' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(toggle)
    expect(setServerGoals).toHaveBeenCalledWith(false)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toBeDisabled()

    resolveUpdate?.({ enabled: false, configurable: true, message: 'Goals disabled server-wide.' })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(screen.getByText(/Goals disabled server-wide.*Normal chats and scheduled jobs continue/)).toBeInTheDocument()
    expect(changed).toHaveBeenCalledOnce()
    expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({
      profileId: 'profile',
      profileGeneration: 1,
      enabled: false
    })
  })

  it('keeps the authoritative value and shows a busy conflict inline', async () => {
    installBridge({
      serverGoals: vi.fn().mockResolvedValue({ enabled: true, configurable: true, message: 'Goals enabled.' }),
      setServerGoals: vi.fn().mockRejectedValue(new Error('409 Wait for 2 active Codex turns to finish, then retry.'))
    })

    render(<CodexServerSettings connected profileId="profile" profileGeneration={1} />)
    const toggle = await screen.findByRole('switch')
    fireEvent.click(toggle)

    await screen.findByText('409 Wait for 2 active Codex turns to finish, then retry.')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toBeEnabled()
  })

  it('makes an older server explicitly unavailable without throwing', async () => {
    installBridge({
      serverGoals: vi.fn().mockRejectedValue(new Error('404 Not Found'))
    })

    render(<CodexServerSettings connected profileId="profile" profileGeneration={1} />)
    const toggle = await screen.findByRole('switch')
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Persistent goals remain available, but this connection cannot change the server-wide setting.')).toBeInTheDocument()
  })

  it.each(['403 forbidden', '401 Unauthorized'])(
    'treats a non-admin connection as unavailable instead of exposing %s',
    async failure => {
      installBridge({ serverGoals: vi.fn().mockRejectedValue(new Error(failure)) })

      render(<CodexServerSettings connected profileId="profile" profileGeneration={1} />)

      const toggle = await screen.findByRole('switch')
      expect(toggle).toBeDisabled()
      expect(screen.queryByText(new RegExp(failure, 'i'))).not.toBeInTheDocument()
      expect(screen.getByText(/this connection cannot change the server-wide setting/i)).toBeInTheDocument()
    }
  )
})
