import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
vi.mock('../lib/i18n', () => ({ useLocale: () => 'en', t: (key: string, values?: { count?: number }) => key === 'chatShare.revokedCount' ? `Revoked (${values?.count})` : ({
  'chatShare.viewOnly': 'View only', 'chatShare.interactiveAction': 'Interactive',
  'chatShare.title': 'Share chat', 'chatShare.existing': 'Existing shares',
  'chatShare.link': 'Share URL', 'chatShare.accessToken': 'Access token',
  'chatShare.copyInvitation': 'Copy invitation', 'chatShare.copyTokenLink': 'Copy link with token',
  'chatShare.close': 'Close chat sharing', 'chatShare.revoke': 'Revoke',
  'chatShare.active': 'Active', 'chatShare.revoked': 'Revoked',
  'chatShare.reusableTokenHint': 'Share the same token with multiple people.'
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
  fixture.revoke.mockResolvedValue(undefined)
  vi.stubGlobal('agentsDock', { chatShares: { create: fixture.create, preview: fixture.preview,
    list: fixture.list, revoke: fixture.revoke }, native: { writeClipboard: fixture.copy, openExternal: fixture.open } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('two-action chat sharing', () => {
  it.each(['snapshot', 'interactive'] as const)('creates %s directly, copies the separate token and opens only the safe URL', async mode => {
    const path = mode === 'snapshot' ? `/shared-chat/share_${'a'.repeat(32)}` : `/interactive-chat/interactive_${'b'.repeat(32)}`
    const url = `http://192.0.2.1:7850${path}`
    const token = 'c'.repeat(43)
    fixture.create.mockResolvedValue({ id: 'synthetic-share', title: 'Synthetic conversation', created_at: 1,
      expires_at: null, revoked_at: null, path, url, access_token: token })
    openDialog()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(fixture.preview).not.toHaveBeenCalled()
    expect(fixture.list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: mode === 'snapshot' ? 'View only' : 'Interactive' }))
    await waitFor(() => expect(fixture.open).toHaveBeenCalledWith(url))
    expect(fixture.copy).toHaveBeenCalledWith(`${url}\nToken: ${token}`)
    expect(screen.getByRole('textbox', { name: 'Share URL' })).toHaveValue(url)
    expect(screen.getByRole('textbox', { name: 'Access token' })).toHaveValue(token)
    expect(screen.queryByRole('button', { name: 'Copy link with token' })).toBeNull()
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith(fixture.scope, fixture.session.id, {
      mode, title: fixture.session.title, ...(mode === 'snapshot' ? { confirmed_public: true } : { confirmed_interactive: true })
    })
    expect(fixture.preview).not.toHaveBeenCalled()
    expect(fixture.list).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('chatShare.copiedOpened'))
    if (mode === 'interactive') expect(screen.getByText('Share the same token with multiple people.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy invitation' }))
    await waitFor(() => expect(fixture.copy).toHaveBeenCalledTimes(2))
    expect(fixture.copy).toHaveBeenLastCalledWith(`${url}\nToken: ${token}`)
    expect(fixture.open).toHaveBeenCalledTimes(1)
  })

  it.each(['snapshot', 'interactive'] as const)('offers an explicit token-bearing link only for snapshots (%s)', async mode => {
    const path = mode === 'snapshot' ? `/shared-chat/share_${'a'.repeat(32)}` : `/interactive-chat/interactive_${'b'.repeat(32)}`
    const url = `https://share.example.test${path}`
    const token = 'd'.repeat(43)
    const tokenURL = mode === 'snapshot' ? `https://share.example.test/share/${token}` : `${url}#token=${token}`
    fixture.create.mockResolvedValue({ id: 'synthetic-share', title: 'Synthetic conversation', created_at: 1,
      expires_at: null, revoked_at: null, path, url, access_token: token, token_url: tokenURL })
    openDialog()
    fireEvent.click(screen.getByRole('button', { name: mode === 'snapshot' ? 'View only' : 'Interactive' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('chatShare.copiedOpened'))
    expect(fixture.copy).toHaveBeenCalledExactlyOnceWith(`${url}\nToken: ${token}`)
    if (mode === 'snapshot') {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link with token' }))
      await waitFor(() => expect(fixture.copy).toHaveBeenLastCalledWith(tokenURL))
    } else expect(screen.queryByRole('button', { name: 'Copy link with token' })).toBeNull()
    expect(fixture.open).toHaveBeenCalledExactlyOnceWith(url)
  })

  it('clears the displayed token on revoke and does not recover it from the management list', async () => {
    const record = { id: `interactive_${'b'.repeat(32)}`, title: 'Synthetic conversation', created_at: 1,
      expires_at: null, revoked_at: null }
    const path = `/interactive-chat/${record.id}`
    const token = 'e'.repeat(43)
    fixture.create.mockResolvedValue({ ...record, path, url: `http://192.0.2.1:7850${path}`, access_token: token })
    fixture.list.mockImplementation(async (_scope, _id, mode) => mode === 'interactive' ? [record] : [])
    openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Interactive' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('chatShare.copiedOpened'))
    const details = screen.getByText('Existing shares').closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    await waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Access token' })).toBeNull())
    expect(fixture.revoke).toHaveBeenCalledExactlyOnceWith(fixture.scope, fixture.session.id, 'interactive', record.id)
    expect(document.body.textContent).not.toContain(token)
    const revoked = screen.getByText('Revoked (1)').closest('details')!
    expect(revoked.open).toBe(false)
    revoked.open = true
    fireEvent(revoked, new Event('toggle'))
    expect(within(revoked).getByRole('button', { name: 'Revoke' })).toBeDisabled()
    expect(within(revoked).getByText(record.title)).toBeInTheDocument()
  })

  it('keeps previously used shares active and folds all revoked history after another revoke', async () => {
    const record = { id: `interactive_${'a'.repeat(32)}`, title: 'Previously used share', created_at: 1,
      expires_at: null, revoked_at: null, redeemed_at: 2 }
    const remaining = { ...record, id: `interactive_${'b'.repeat(32)}`, title: 'Still active' }
    const old = { ...record, id: `interactive_${'c'.repeat(32)}`, title: 'Revoked earlier', revoked_at: 3 }
    fixture.list.mockImplementation(async (_scope, _id, mode) => mode === 'interactive' ? [record, remaining, old] : [])
    openDialog()
    const details = screen.getByText('Existing shares').closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    await waitFor(() => expect(screen.getByText(record.title)).toBeInTheDocument())
    const row = screen.getByText(record.title).closest('.chat-share-record')!
    expect(within(row as HTMLElement).getByText('Interactive · Active')).toBeInTheDocument()
    const revoked = screen.getByText('Revoked (1)').closest('details')!
    revoked.open = true
    fireEvent(revoked, new Event('toggle'))
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(screen.getByText('Revoked (2)')).toBeInTheDocument())
    expect(revoked.open).toBe(false)
    expect(within(revoked).getByText(record.title)).toBeInTheDocument()
    expect(within(revoked).getByText(old.title)).toBeInTheDocument()
    expect(screen.getByText(remaining.title).closest('.chat-share-revoked')).toBeNull()
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
