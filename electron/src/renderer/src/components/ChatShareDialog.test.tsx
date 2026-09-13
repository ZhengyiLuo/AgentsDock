import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatShareDialog } from './ChatShareDialog'

const fixture = vi.hoisted(() => {
  const scope = { profileId: 'profile', profileGeneration: 1, serverIdentity: 'server' }
  const session = { id: 'synthetic-chat', title: 'Synthetic conversation' }
  return { scope, session, state: { activeProfileId: 'profile', profileGeneration: 1,
    profiles: [{ id: 'profile', serverIdentity: 'server' }], sessions: [session] },
    create: vi.fn(), preview: vi.fn(), list: vi.fn(), revoke: vi.fn(), copy: vi.fn(), open: vi.fn() }
})
vi.mock('../store/app-store', () => ({ useAppStore: Object.assign(
  (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state), { getState: () => fixture.state }) }))
vi.mock('../lib/workspace-preferences', () => ({ captureWorkspaceScope: () => fixture.scope }))
vi.mock('../lib/i18n', () => ({ useLocale: () => 'en', t: (key: string) => ({
  'chatShare.viewOnly': 'View only', 'chatShare.interactiveAction': 'Interactive',
  'chatShare.title': 'Share chat', 'chatShare.existing': 'Existing shares'
}[key] ?? key) }))

function openDialog() {
  render(<ChatShareDialog />)
  act(() => { window.dispatchEvent(new CustomEvent('agentsdock:share-chat', {
    detail: { scope: fixture.scope, session: fixture.session }
  })) })
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.copy.mockResolvedValue(undefined); fixture.open.mockResolvedValue(undefined)
  fixture.list.mockResolvedValue([])
  vi.stubGlobal('agentsDock', { chatShares: { create: fixture.create, preview: fixture.preview,
    list: fixture.list, revoke: fixture.revoke }, native: { writeClipboard: fixture.copy, openExternal: fixture.open } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('two-action chat sharing', () => {
  it.each(['snapshot', 'interactive'] as const)('creates %s directly, copies and opens the unchanged link without redeeming it', async mode => {
    const path = mode === 'snapshot' ? `/share/${'a'.repeat(43)}` : `/interactive-chat/interactive_${'b'.repeat(32)}#invite=${'c'.repeat(43)}`
    const url = `http://192.0.2.1:7850${path}`
    fixture.create.mockResolvedValue({ id: 'synthetic-share', title: 'Synthetic conversation', created_at: 1,
      expires_at: null, revoked_at: null, path, url })
    openDialog()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(fixture.preview).not.toHaveBeenCalled()
    expect(fixture.list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: mode === 'snapshot' ? 'View only' : 'Interactive' }))
    await waitFor(() => expect(fixture.open).toHaveBeenCalledWith(url))
    expect(fixture.copy).toHaveBeenCalledWith(url)
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith(fixture.scope, fixture.session.id, {
      mode, title: fixture.session.title, ...(mode === 'snapshot' ? { confirmed_public: true } : { confirmed_interactive: true })
    })
    expect(fixture.preview).not.toHaveBeenCalled()
    expect(fixture.list).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('chatShare.copiedOpened'))
  })

  it('keeps rejected creation visible without retry, copy or browser opening', async () => {
    fixture.create.mockRejectedValue(new Error('Synthetic server validation error'))
    openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'View only' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Synthetic server validation error'))
    expect(fixture.create).toHaveBeenCalledTimes(1)
    expect(fixture.copy).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
  })
})
