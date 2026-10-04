import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatShareDialog } from './ChatShareDialog'

const fixture = vi.hoisted(() => {
  const scope = { profileId: 'profile', profileGeneration: 1, serverIdentity: 'server' }
  const session = { id: 'synthetic-chat', title: 'Synthetic conversation' }
  return { scope, session, state: { activeProfileId: 'profile', profileGeneration: 1,
    profiles: [{ id: 'profile', serverIdentity: 'server', serverUrl: 'http://192.0.2.1:7850' }], sessions: [session] },
    create: vi.fn(), preview: vi.fn(), list: vi.fn(), revoke: vi.fn(), copy: vi.fn(), open: vi.fn() }
})
const analytics = vi.hoisted(() => ({ trackEvent: vi.fn() }))
vi.mock('../store/app-store', () => ({ useAppStore: Object.assign(
  (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state), { getState: () => fixture.state }) }))
vi.mock('../lib/workspace-preferences', () => ({ captureWorkspaceScope: () => fixture.scope }))
vi.mock('../lib/analytics', () => analytics)
vi.mock('../lib/i18n', () => ({ useLocale: () => 'en', t: (key: string, values?: { count?: number; time?: string }) => key === 'chatShare.revokedCount' ? `Revoked (${values?.count})`
  : key === 'chatShare.createdAt' ? `Created ${values?.time}` : ({
  'chatShare.viewOnly': 'View only', 'chatShare.interactiveAction': 'Interactive',
  'chatShare.title': 'Share chat', 'chatShare.existing': 'Existing shares',
  'chatShare.address': 'Share address',
  'chatShare.addressHint': 'Use this server’s LAN address to share on the same network.',
  'chatShare.invalidAddress': 'Enter an HTTP or HTTPS address with an optional port, without a path, sign-in details, query or fragment.',
  'chatShare.link': 'Share URL', 'chatShare.relativePath': 'Relative share path',
  'chatShare.accessToken': 'Access token', 'chatShare.copyLink': 'Copy link',
  'chatShare.copyPath': 'Copy relative path', 'chatShare.copyAccessToken': 'Copy access token',
  'chatShare.copiedSuccessfully': 'Copied successfully.',
  'chatShare.viewOnlyShare': 'View-only share', 'chatShare.interactiveShare': 'Interactive share',
  'chatShare.created': 'Created share link',
  'chatShare.copyInvitation': 'Copy link and token', 'chatShare.copyTokenLink': 'Copy link with token',
  'chatShare.close': 'Close chat sharing', 'chatShare.revoke': 'Revoke',
  'chatShare.active': 'Active', 'chatShare.revoked': 'Revoked',
  'chatShare.reusableTokenHint': 'Share the same token with multiple people.'
}[key] ?? key) }))

function requestDialog() {
  act(() => { window.dispatchEvent(new CustomEvent('agentsdock:share-chat', {
    detail: { scope: fixture.scope, session: fixture.session }
  })) })
}

function openDialog() {
  const view = render(<ChatShareDialog />)
  requestDialog()
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.scope = { profileId: 'profile', profileGeneration: 1, serverIdentity: 'server' }
  fixture.state.activeProfileId = 'profile'; fixture.state.profileGeneration = 1
  fixture.state.profiles = [{ id: 'profile', serverIdentity: 'server', serverUrl: 'http://192.0.2.1:7850' }]
  fixture.copy.mockResolvedValue(undefined); fixture.open.mockResolvedValue(undefined)
  fixture.list.mockResolvedValue([])
  fixture.revoke.mockResolvedValue(undefined)
  vi.stubGlobal('agentsDock', { chatShares: { create: fixture.create, preview: fixture.preview,
    list: fixture.list, revoke: fixture.revoke }, native: { writeClipboard: fixture.copy, openExternal: fixture.open } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('two-action chat sharing', () => {
  it.each(['snapshot', 'interactive'] as const)('creates %s without copying, then copies the URL and token separately or together', async mode => {
    const path = mode === 'snapshot' ? `/shared-chat/share_${'a'.repeat(32)}` : `/interactive-chat/interactive_${'b'.repeat(32)}`
    const url = `http://192.0.2.1:7850${path}`
    const token = 'c'.repeat(43)
    fixture.create.mockResolvedValue({ id: 'synthetic-share', title: 'Synthetic conversation', created_at: 1,
      expires_at: null, revoked_at: null, path, url, access_token: token })
    openDialog()
    expect(analytics.trackEvent).toHaveBeenCalledExactlyOnceWith('chat_share_opened')
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(fixture.preview).not.toHaveBeenCalled()
    expect(fixture.list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: mode === 'snapshot' ? 'View only' : 'Interactive' }))
    await waitFor(() => expect(fixture.open).toHaveBeenCalledWith(url))
    expect(analytics.trackEvent).toHaveBeenCalledWith(
      mode === 'snapshot' ? 'chat_share_snapshot_created' : 'chat_share_interactive_created'
    )
    expect(fixture.copy).not.toHaveBeenCalled()
    const shareURL = screen.getByRole('textbox', { name: 'Share URL' })
    const accessToken = screen.getByRole('textbox', { name: 'Access token' })
    expect(shareURL).toHaveValue(url)
    expect(shareURL).toHaveAttribute('title', url)
    expect(accessToken).toHaveValue(token)
    expect(accessToken).toHaveAttribute('title', token)
    expect(screen.getByText(mode === 'snapshot' ? 'View-only share' : 'Interactive share')).toBeInTheDocument()
    const copyLink = screen.getByRole('button', { name: 'Copy link' })
    const copyToken = screen.getByRole('button', { name: 'Copy access token' })
    expect(copyLink).toHaveTextContent('')
    expect(copyToken).toHaveTextContent('')
    fireEvent.click(copyLink)
    await waitFor(() => expect(fixture.copy).toHaveBeenLastCalledWith(url))
    expect(screen.getByRole('status')).toHaveTextContent('Copied successfully.')
    fireEvent.click(copyToken)
    await waitFor(() => expect(fixture.copy).toHaveBeenLastCalledWith(token))
    fireEvent.click(screen.getByRole('button', { name: 'Copy link and token' }))
    await waitFor(() => expect(fixture.copy).toHaveBeenLastCalledWith(`${url}\nToken: ${token}`))
    expect(fixture.copy).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('status')).toHaveTextContent('Copied successfully.')
    expect(screen.queryByRole('button', { name: 'Copy link with token' })).toBeNull()
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith(fixture.scope, fixture.session.id, {
      mode, title: fixture.session.title, base_url: 'http://192.0.2.1:7850',
      ...(mode === 'snapshot' ? { confirmed_public: true } : { confirmed_interactive: true })
    })
    expect(fixture.preview).not.toHaveBeenCalled()
    expect(fixture.list).not.toHaveBeenCalled()
    if (mode === 'interactive') expect(screen.getByText('Share the same token with multiple people.')).toBeInTheDocument()
    expect(fixture.open).toHaveBeenCalledTimes(1)
  })

  it.each(['snapshot', 'interactive'] as const)('does not expose a token-bearing convenience link for %s shares', async mode => {
    const path = mode === 'snapshot' ? `/shared-chat/share_${'a'.repeat(32)}` : `/interactive-chat/interactive_${'b'.repeat(32)}`
    const url = `https://share.example.test${path}`
    const token = 'd'.repeat(43)
    const tokenURL = mode === 'snapshot' ? `https://share.example.test/share/${token}` : `${url}#token=${token}`
    fixture.create.mockResolvedValue({ id: 'synthetic-share', title: 'Synthetic conversation', created_at: 1,
      expires_at: null, revoked_at: null, path, url, access_token: token, token_url: tokenURL })
    openDialog()
    fireEvent.click(screen.getByRole('button', { name: mode === 'snapshot' ? 'View only' : 'Interactive' }))
    await waitFor(() => expect(fixture.open).toHaveBeenCalledExactlyOnceWith(url))
    expect(fixture.copy).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Copy link with token' })).toBeNull()
    expect(document.body).not.toHaveTextContent(tokenURL)
    fireEvent.click(screen.getByRole('button', { name: 'Copy link and token' }))
    await waitFor(() => expect(fixture.copy).toHaveBeenCalledExactlyOnceWith(`${url}\nToken: ${token}`))
    expect(fixture.open).toHaveBeenCalledExactlyOnceWith(url)
  })

  it.each(['snapshot', 'interactive'] as const)('copies the relative path and token when a %s share has no absolute URL', async mode => {
    const path = mode === 'snapshot' ? `/shared-chat/share_${'a'.repeat(32)}` : `/interactive-chat/interactive_${'b'.repeat(32)}`
    const token = 'j'.repeat(43)
    fixture.create.mockResolvedValue({ id: 'synthetic-share', title: fixture.session.title, created_at: 1,
      expires_at: null, revoked_at: null, path, url: null, access_token: token })
    openDialog()
    fireEvent.click(screen.getByRole('button', { name: mode === 'snapshot' ? 'View only' : 'Interactive' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy link and token' })).toBeEnabled())
    expect(screen.getByRole('textbox', { name: 'Relative share path' })).toHaveValue(path)
    expect(fixture.copy).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Copy link and token' }))
    await waitFor(() => expect(fixture.copy).toHaveBeenCalledExactlyOnceWith(`${path}\nToken: ${token}`))
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
    await waitFor(() => expect(fixture.open).toHaveBeenCalledTimes(1))
    const details = screen.getByText('Existing shares').closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    await waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Access token' })).toBeNull())
    expect(fixture.revoke).toHaveBeenCalledExactlyOnceWith(fixture.scope, fixture.session.id, 'interactive', record.id)
    expect(analytics.trackEvent).toHaveBeenCalledWith('chat_share_revoked')
    expect(document.body.textContent).not.toContain(token)
    const revoked = screen.getByText('Revoked (1)').closest('details')!
    expect(revoked.open).toBe(false)
    revoked.open = true
    fireEvent(revoked, new Event('toggle'))
    expect(within(revoked).getByRole('button', { name: 'Revoke' })).toBeDisabled()
    expect(within(revoked).getByText('Interactive')).toHaveClass('chat-share-mode-chip', 'interactive')
    expect(revoked).not.toHaveTextContent(record.title)
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
    await waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(2))
    const activeRows = [...details.querySelectorAll<HTMLElement>(':scope > .chat-share-record')]
    expect(activeRows).toHaveLength(2)
    const row = activeRows[0]!
    expect(within(row as HTMLElement).getByText('Interactive')).toBeInTheDocument()
    expect(row).toHaveTextContent(/Active · Created /)
    expect(within(row as HTMLElement).getByText(/Created /).closest('time')).toHaveAttribute('dateTime', '1970-01-01T00:00:01.000Z')
    const revoked = screen.getByText('Revoked (1)').closest('details')!
    revoked.open = true
    fireEvent(revoked, new Event('toggle'))
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(screen.getByText('Revoked (2)')).toBeInTheDocument())
    expect(revoked.open).toBe(false)
    expect(within(revoked).getAllByText('Interactive')).toHaveLength(2)
    expect(details.querySelectorAll(':scope > .chat-share-record')).toHaveLength(1)
    expect(screen.queryByText(record.title)).toBeNull()
    expect(screen.queryByText(remaining.title)).toBeNull()
    expect(screen.queryByText(old.title)).toBeNull()
  })

  it.each(['snapshot', 'interactive'] as const)('keeps rejected %s creation visible without retry, copy or browser opening', async mode => {
    fixture.create.mockRejectedValue(new Error('Synthetic server validation error'))
    openDialog()
    fireEvent.change(screen.getByRole('textbox', { name: 'Share address' }), { target: { value: 'http://192.168.50.20:7850' } })
    fireEvent.click(screen.getByRole('button', { name: mode === 'snapshot' ? 'View only' : 'Interactive' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Synthetic server validation error'))
    expect(screen.getByRole('textbox', { name: 'Share address' })).toHaveValue('http://192.168.50.20:7850')
    expect(fixture.create).toHaveBeenCalledTimes(1)
    expect(fixture.copy).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
    expect(fixture.list).not.toHaveBeenCalled()
    expect(analytics.trackEvent).not.toHaveBeenCalledWith(
      mode === 'snapshot' ? 'chat_share_snapshot_created' : 'chat_share_interactive_created'
    )
  })

  it('keeps a created share visible when an explicit clipboard action fails', async () => {
    const path = `/shared-chat/share_${'a'.repeat(32)}`
    const url = `http://192.0.2.1:7850${path}`
    fixture.create.mockResolvedValue({ id: 'synthetic-share', title: fixture.session.title, created_at: 1,
      expires_at: null, revoked_at: null, path, url, access_token: 'g'.repeat(43) })
    fixture.copy.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    openDialog()

    fireEvent.click(screen.getByRole('button', { name: 'View only' }))
    await waitFor(() => expect(fixture.open).toHaveBeenCalledExactlyOnceWith(url))
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Clipboard unavailable'))
    expect(analytics.trackEvent).toHaveBeenCalledWith('chat_share_snapshot_created')
    expect(fixture.create).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox', { name: 'Share URL' })).toHaveValue(url)
  })

  it('clears previous copy success when combined copying fails and allows another attempt', async () => {
    const path = `/interactive-chat/interactive_${'b'.repeat(32)}`
    const url = `http://192.0.2.1:7850${path}`
    const token = 'k'.repeat(43)
    fixture.create.mockResolvedValue({ id: 'synthetic-share', title: fixture.session.title, created_at: 1,
      expires_at: null, revoked_at: null, path, url, access_token: token })
    openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Interactive' }))
    await waitFor(() => expect(fixture.open).toHaveBeenCalledExactlyOnceWith(url))
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied successfully.'))

    fixture.copy.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    const copyBoth = screen.getByRole('button', { name: 'Copy link and token' })
    fireEvent.click(copyBoth)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Clipboard unavailable'))
    expect(screen.queryByRole('status')).toBeNull()
    expect(copyBoth).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Share URL' })).toHaveValue(url)
    expect(screen.getByRole('textbox', { name: 'Access token' })).toHaveValue(token)
    fireEvent.click(copyBoth)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied successfully.'))
    expect(fixture.copy).toHaveBeenLastCalledWith(`${url}\nToken: ${token}`)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(fixture.create).toHaveBeenCalledTimes(1)
    expect(fixture.open).toHaveBeenCalledTimes(1)
  })

  it.each(['snapshot', 'interactive'] as const)('creates %s with a custom LAN origin and keeps its returned URLs bound after editing the address', async mode => {
    const path = mode === 'snapshot' ? `/shared-chat/share_${'a'.repeat(32)}` : `/interactive-chat/interactive_${'b'.repeat(32)}`
    const url = `http://192.168.50.20:7850${path}`
    const token = 'f'.repeat(43)
    fixture.create.mockResolvedValue({ id: 'synthetic-share', title: fixture.session.title, created_at: 1,
      expires_at: null, revoked_at: null, path, url, access_token: token })
    openDialog()
    const address = screen.getByRole('textbox', { name: 'Share address' })
    expect(address).toHaveValue('http://192.0.2.1:7850')
    fireEvent.change(address, { target: { value: 'http://192.168.50.20:7850/' } })
    fireEvent.click(screen.getByRole('button', { name: mode === 'snapshot' ? 'View only' : 'Interactive' }))
    await waitFor(() => expect(fixture.open).toHaveBeenCalledExactlyOnceWith(url))
    expect(fixture.create).toHaveBeenCalledExactlyOnceWith(fixture.scope, fixture.session.id, {
      mode, title: fixture.session.title, base_url: 'http://192.168.50.20:7850',
      ...(mode === 'snapshot' ? { confirmed_public: true } : { confirmed_interactive: true })
    })
    fireEvent.change(address, { target: { value: 'https://different.example.test' } })
    expect(screen.getByRole('textbox', { name: 'Share URL' })).toHaveValue(url)
    expect(screen.getByRole('textbox', { name: 'Access token' })).toHaveValue(token)
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(fixture.copy).toHaveBeenLastCalledWith(url))
    fireEvent.click(screen.getByRole('button', { name: 'Copy access token' }))
    await waitFor(() => expect(fixture.copy).toHaveBeenLastCalledWith(token))
    fireEvent.click(screen.getByRole('button', { name: 'Copy link and token' }))
    await waitFor(() => expect(fixture.copy).toHaveBeenLastCalledWith(`${url}\nToken: ${token}`))
    expect(fixture.copy).toHaveBeenCalledTimes(3)
    expect(fixture.open).toHaveBeenCalledExactlyOnceWith(url)
    expect(fixture.create).toHaveBeenCalledTimes(1)
  })

  it('shows explicit mode, status and creation time and orders mixed-mode shares newest first', async () => {
    const oldest = { id: `interactive_${'a'.repeat(32)}`, title: 'Same title', created_at: 10,
      expires_at: null, revoked_at: null }
    const newest = { id: `share_${'b'.repeat(32)}`, title: 'Same title', created_at: 30,
      expires_at: null, revoked_at: null }
    const middle = { id: `interactive_${'c'.repeat(32)}`, title: 'Same title', created_at: 20,
      expires_at: null, revoked_at: null }
    fixture.list.mockImplementation(async (_scope, _id, mode) => mode === 'snapshot' ? [newest] : [oldest, middle])
    openDialog()
    const details = screen.getByText('Existing shares').closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))

    await waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(2))
    const rows = [...document.querySelectorAll<HTMLElement>('.chat-share-record')]
    expect(rows).toHaveLength(3)
    expect(rows.map(row => row.querySelector('time')?.getAttribute('dateTime'))).toEqual([
      '1970-01-01T00:00:30.000Z', '1970-01-01T00:00:20.000Z', '1970-01-01T00:00:10.000Z'
    ])
    expect(rows[0]).toHaveTextContent(/Active · Created /)
    expect(rows[1]).toHaveTextContent(/Active · Created /)
    expect(within(rows[0]).getByText('View only')).toHaveClass('chat-share-mode-chip', 'snapshot')
    expect(within(rows[1]).getByText('Interactive')).toHaveClass('chat-share-mode-chip', 'interactive')
    expect(screen.queryByText('Same title')).toBeNull()
  })

  it('prefills only the selected profile origin and does no background work while the address is edited', async () => {
    fixture.state.profiles[0].serverUrl = 'https://studio.example.test:8443/reverse-proxy/'
    const stateBefore = JSON.stringify(fixture.state)
    vi.useFakeTimers()
    try {
      openDialog()
      const address = screen.getByRole('textbox', { name: 'Share address' })
      expect(address).toHaveValue('https://studio.example.test:8443')
      expect(address).toHaveAccessibleDescription('Use this server’s LAN address to share on the same network.')
      expect(screen.queryByRole('combobox')).toBeNull()
      fireEvent.change(address, { target: { value: 'http://192.168.50.20:7850' } })
      await act(async () => vi.advanceTimersByTimeAsync(60_000))
      expect(JSON.stringify(fixture.state)).toBe(stateBefore)
      expect(fixture.create).not.toHaveBeenCalled()
      expect(fixture.preview).not.toHaveBeenCalled()
      expect(fixture.list).not.toHaveBeenCalled()
      expect(fixture.open).not.toHaveBeenCalled()
      expect(fixture.copy).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it.each([
    'http://192.168.50.20:7850/path', 'https://user:secret@example.test',
    'http://192.168.50.20:7850?token=secret', 'http://192.168.50.20:7850#token', '', '192.168.50.20:7850'
  ])('rejects an invalid share address locally: %s', async address => {
    openDialog()
    fireEvent.change(screen.getByRole('textbox', { name: 'Share address' }), { target: { value: address } })
    for (const mode of ['View only', 'Interactive']) {
      fireEvent.click(screen.getByRole('button', { name: mode }))
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
        'Enter an HTTP or HTTPS address with an optional port, without a path, sign-in details, query or fragment.'
      ))
      await waitFor(() => expect(screen.getByRole('button', { name: mode })).toBeEnabled())
    }
    expect(fixture.create).not.toHaveBeenCalled()
    expect(fixture.preview).not.toHaveBeenCalled()
    expect(fixture.list).not.toHaveBeenCalled()
    expect(fixture.copy).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
  })

  it('keeps the address and both actions disabled during one pending creation', async () => {
    let reject!: (error: Error) => void
    fixture.create.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'View only' }))
    try {
      expect(screen.getByRole('textbox', { name: 'Share address' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'View only' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Interactive' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Interactive' }))
      expect(fixture.create).toHaveBeenCalledTimes(1)
    } finally { await act(async () => reject(new Error('Creation acknowledgment unavailable'))) }
    expect(screen.getByRole('textbox', { name: 'Share address' })).toBeEnabled()
    expect(fixture.create).toHaveBeenCalledTimes(1)
    expect(fixture.copy).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
  })

  it('resets the address draft when closed and when the selected profile changes', () => {
    const view = openDialog()
    fireEvent.change(screen.getByRole('textbox', { name: 'Share address' }), { target: { value: 'http://192.168.50.20:7850' } })
    fireEvent.click(screen.getByRole('button', { name: 'Close chat sharing' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    requestDialog()
    expect(screen.getByRole('textbox', { name: 'Share address' })).toHaveValue('http://192.0.2.1:7850')
    fireEvent.change(screen.getByRole('textbox', { name: 'Share address' }), { target: { value: 'http://192.168.50.20:7850' } })

    fixture.scope = { profileId: 'other-profile', profileGeneration: 2, serverIdentity: 'other-server' }
    fixture.state.activeProfileId = 'other-profile'; fixture.state.profileGeneration = 2
    fixture.state.profiles = [{ id: 'other-profile', serverIdentity: 'other-server', serverUrl: 'https://other.example.test:8443' }]
    view.rerender(<ChatShareDialog />)
    expect(screen.queryByRole('dialog')).toBeNull()
    requestDialog()
    expect(screen.getByRole('textbox', { name: 'Share address' })).toHaveValue('https://other.example.test:8443')
    expect(fixture.create).not.toHaveBeenCalled()
  })

  it('does not copy or open a late creation after the profile scope closes', async () => {
    let resolve!: (value: unknown) => void
    fixture.create.mockImplementation(() => new Promise(accept => { resolve = accept }))
    const view = openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Interactive' }))
    fixture.scope = { ...fixture.scope, profileGeneration: 2 }
    fixture.state.profileGeneration = 2
    view.rerender(<ChatShareDialog />)
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => resolve({ id: 'late-share', path: '/interactive-chat/late-share',
      url: 'http://192.0.2.1:7850/interactive-chat/late-share', access_token: 'late-token' }))
    expect(fixture.create).toHaveBeenCalledTimes(1)
    expect(analytics.trackEvent).toHaveBeenCalledWith('chat_share_interactive_created')
    expect(fixture.copy).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
    requestDialog()
    expect(screen.getByRole('textbox', { name: 'Share address' })).toHaveValue('http://192.0.2.1:7850')
    expect(screen.queryByRole('textbox', { name: 'Access token' })).toBeNull()
  })
})
