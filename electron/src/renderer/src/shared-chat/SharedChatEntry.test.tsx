import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { SharedChatEntry } from './SharedChatEntry'

const fixture = vi.hoisted(() => ({ state: { initialized: false }, setError: vi.fn() }))
vi.mock('../store/app-store', () => ({ useAppStore: Object.assign(
  (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
  { getState: () => ({ ...fixture.state, setError: fixture.setError }) }) }))
vi.mock('../lib/i18n', () => ({ useLocale: () => 'en' }))
vi.mock('@shared/i18n', () => ({ t: (key: string) => ({
  'chatShare.accessToken': 'Access token', 'chatShare.web.open': 'Open shared chat',
  'chatShare.web.opening': 'Opening', 'chatShare.web.tokenHint': 'Enter the reusable access token shared with you.'
}[key] ?? key) }))
vi.mock('./SharedChatApp', () => ({ SharedChatApp: () => <div>Shared native chat</div> }))

const token = 'a'.repeat(43)
let bridge: { start: Mock<() => Promise<void>>; redeem: Mock<(token: string) => Promise<void>>; catalog: Mock<() => Promise<void>> }
beforeEach(() => {
  vi.clearAllMocks()
  fixture.state.initialized = false
  bridge = { start: vi.fn().mockRejectedValue(new Error('No browser cookie')),
    redeem: vi.fn().mockResolvedValue(undefined), catalog: vi.fn().mockResolvedValue(undefined) }
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); history.replaceState(null, '', '/') })

describe('manual reusable shared-chat token entry', () => {
  it('tries only cookie resume on mount and never consumes or prefills URL or stored tokens', async () => {
    history.replaceState(null, '', `/interactive-chat/interactive_${'b'.repeat(32)}?token=${token}#invite=${token}`)
    const read = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(token)
    const write = vi.spyOn(Storage.prototype, 'setItem')
    const view = render(<SharedChatEntry bridge={bridge} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Access token' })).toBeEnabled())
    expect(screen.getByRole('textbox', { name: 'Access token' })).toHaveValue('')
    expect(screen.getByText('Enter the reusable access token shared with you.')).toBeInTheDocument()
    expect(bridge.start).toHaveBeenCalledTimes(1)
    expect(bridge.redeem).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    view.rerender(<SharedChatEntry bridge={bridge} />)
    expect(bridge.start).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('resumes an existing cookie without requiring or redeeming a token', async () => {
    bridge.start.mockImplementation(async () => { fixture.state.initialized = true })
    render(<SharedChatEntry bridge={bridge} />)
    await waitFor(() => expect(screen.getByText('Shared native chat')).toBeInTheDocument())
    expect(bridge.start).toHaveBeenCalledTimes(1)
    expect(bridge.redeem).not.toHaveBeenCalled()
    expect(bridge.catalog).toHaveBeenCalledTimes(1)
  })

  it('posts exactly one manually entered token per submission and clears it after joining', async () => {
    bridge.start.mockRejectedValueOnce(new Error('No browser cookie')).mockResolvedValue(undefined)
    let finish!: () => void
    bridge.redeem.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    const write = vi.spyOn(Storage.prototype, 'setItem')
    render(<SharedChatEntry bridge={bridge} />)
    const input = screen.getByRole('textbox', { name: 'Access token' })
    await waitFor(() => expect(input).toBeEnabled())
    fireEvent.change(input, { target: { value: ` ${token} ` } })
    const form = input.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(bridge.redeem).toHaveBeenCalledExactlyOnceWith(token)
    await act(async () => { finish() })
    await waitFor(() => expect(input).toHaveValue(''))
    expect(bridge.start).toHaveBeenCalledTimes(2)
    expect(bridge.catalog).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects malformed manual tokens before a request and does not retry a denied token', async () => {
    bridge.redeem.mockRejectedValue(new Error('Access unavailable'))
    render(<SharedChatEntry bridge={bridge} />)
    const input = screen.getByRole('textbox', { name: 'Access token' })
    await waitFor(() => expect(input).toBeEnabled())
    fireEvent.change(input, { target: { value: 'not-a-complete-token' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('chatShare.web.invalidToken'))
    expect(bridge.redeem).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: token } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Access unavailable'))
    expect(bridge.redeem).toHaveBeenCalledExactlyOnceWith(token)
    expect(bridge.start).toHaveBeenCalledTimes(1)
    expect(bridge.catalog).not.toHaveBeenCalled()
  })
})
