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
  expect(screen.getByText(command)).toBeVisible()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(writeClipboard).not.toHaveBeenCalled()
  expect(openExternal).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('link', { name: 'Read more' }))
  expect(openExternal).toHaveBeenCalledOnce()
  expect(writeClipboard).not.toHaveBeenCalled()
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
  expect(screen.getByText(/通过 CLI 登录/)).toBeVisible()
  expect(screen.getByRole('link', { name: '了解更多' })).toHaveAttribute('href', 'https://code.claude.com/docs')
})
