import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeProviderSignIn } from './NativeProviderSignIn'
import { setLocale } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { RuntimeHealthPanel } from './RuntimeHealth'
afterEach(() => { cleanup(); setLocale('en') })

it.each([
  ['codex', 'codex login'], ['claude', 'claude auth login'],
  ['cursor', 'agent login'], ['opencode', 'opencode auth login']
] as const)('offers an explicit server-side login command for %s, without running it', async (backend, command) => {
  const writeClipboard = vi.fn().mockResolvedValue(undefined)
  const openExternal = vi.fn()
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { native: { writeClipboard, openExternal } } })
  render(<NativeProviderSignIn backend={backend} />)
  expect(screen.queryByText(command)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Sign-in instructions' }))
  expect(screen.getByText(command)).toBeVisible()
  expect(screen.getByText(/computer running the selected AgentsServer/)).toBeVisible()
  expect(writeClipboard).not.toHaveBeenCalled()
  expect(openExternal).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Copy login command' }))
  await screen.findByRole('button', { name: 'Copied' })
  expect(writeClipboard).toHaveBeenCalledExactlyOnceWith(command)
  expect(screen.queryByText('Signed in')).not.toBeInTheDocument()
})

it('does not mistake installed or unauthenticated runtimes for authenticated ones', () => {
  useAppStore.setState({ connected: true, runtimeCatalog: null, health: { ok: true, runtimes: {
    claude: { backend: 'claude', status: 'ready', available: true, installed: true, authenticated: null, message: 'Installed' },
    codex: { backend: 'codex', status: 'ready', available: true, installed: true, authenticated: true, message: 'Authenticated' },
    opencode: { backend: 'opencode', status: 'unauthenticated', available: false, installed: true, authenticated: false, message: 'Login required' }
  } } })
  render(<RuntimeHealthPanel />)
  expect(screen.getByText('Sign-in not confirmed').closest('.runtime-health-row')).toHaveClass('unknown')
  expect(screen.getByText('Signed in').closest('.runtime-health-row')).toHaveClass('ready')
  expect(screen.getByText('Not signed in').closest('.runtime-health-row')).toHaveClass('unknown')
})

it('localizes instructions and does not imply Claude recheck performs login', () => {
  setLocale('zh-CN')
  render(<NativeProviderSignIn backend="claude" />)
  fireEvent.click(screen.getByRole('button', { name: '登录指引' }))
  expect(screen.getByText(/Claude 会在下次发送消息时确认登录状态/)).toBeVisible()
})
