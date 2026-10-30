import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale } from '@shared/i18n'
import type { AgentsDockAPI } from '@shared/ipc'
import { useAppStore } from '../store/app-store'
import { AppSettingsDialog } from './Dialogs'

beforeEach(() => {
  setLocale('en')
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      updates: { status: vi.fn().mockResolvedValue({ state: 'not-available', channel: 'direct', track: 'stable', currentVersion: '1.0.0' }) },
      events: { on: vi.fn().mockReturnValue(() => undefined) }
    } as unknown as AgentsDockAPI
  })
  useAppStore.setState({ ...useAppStore.getInitialState(),
    activeProfileId: 'server-a',
    modals: { ...useAppStore.getInitialState().modals, appSettings: true }
  }, true)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  setLocale('en')
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'agentsDock')
})

it('controls the three sidebar groups independently and keeps the cron choice available with unread grouping off', async () => {
  const user = userEvent.setup()
  const setGroupUnreadChats = vi.fn((groupUnreadChats: boolean) => useAppStore.setState({ groupUnreadChats }))
  const setIncludeCronInUnread = vi.fn((includeCronInUnread: boolean) => useAppStore.setState({ includeCronInUnread }))
  const setGroupRunningChats = vi.fn((groupRunningChats: boolean) => useAppStore.setState({ groupRunningChats }))
  useAppStore.setState({ setGroupUnreadChats, setIncludeCronInUnread, setGroupRunningChats })
  render(<AppSettingsDialog />)
  await screen.findByText('Version 1.0.0')

  const unread = screen.getByRole('switch', { name: 'Unread chats at the top' })
  const cron = screen.getByRole('switch', { name: 'Include cron jobs in Unread' })
  const running = screen.getByRole('switch', { name: 'Show Running section' })
  expect(unread).toBeChecked()
  expect(cron).not.toBeChecked()
  expect(running).toBeChecked()
  expect(unread).toHaveAccessibleDescription('Show unread chats in a separate section above your folders.')
  expect(cron).toHaveAccessibleDescription('Include unread cron output when grouping chats in Unread.')
  expect(running).toHaveAccessibleDescription('Show active chats in a separate section above your folders.')

  unread.focus()
  await user.keyboard('[Space]')
  expect(setGroupUnreadChats).toHaveBeenCalledExactlyOnceWith(false)
  expect(unread).not.toBeChecked()
  expect(cron).toBeEnabled()
  await user.click(cron)
  expect(setIncludeCronInUnread).toHaveBeenCalledExactlyOnceWith(true)
  expect(cron).toBeChecked()
  expect(unread).not.toBeChecked()
  await user.click(running)
  expect(setGroupRunningChats).toHaveBeenCalledExactlyOnceWith(false)
  expect(running).not.toBeChecked()

  act(() => useAppStore.setState({
    activeProfileId: 'server-b', groupUnreadChats: true, includeCronInUnread: false, groupRunningChats: true
  }))
  expect(unread).toBeChecked()
  expect(cron).not.toBeChecked()
  expect(running).toBeChecked()
  expect(setGroupUnreadChats).toHaveBeenCalledOnce()
  expect(setIncludeCronInUnread).toHaveBeenCalledOnce()
  expect(setGroupRunningChats).toHaveBeenCalledOnce()
})

it('updates all grouping labels and descriptions when the language changes', async () => {
  render(<AppSettingsDialog />)
  await screen.findByText('Version 1.0.0')
  const unread = screen.getByRole('switch', { name: 'Unread chats at the top' })
  const cron = screen.getByRole('switch', { name: 'Include cron jobs in Unread' })
  const running = screen.getByRole('switch', { name: 'Show Running section' })
  act(() => setLocale('zh-CN'))
  expect(screen.getByRole('switch', { name: '在顶部显示未读会话' })).toBe(unread)
  expect(screen.getByRole('switch', { name: '在未读分组中包含 Cron 任务' })).toBe(cron)
  expect(screen.getByRole('switch', { name: '显示运行中分组' })).toBe(running)
  expect(unread).toHaveAccessibleDescription('在文件夹上方单独显示未读会话分组。')
  expect(cron).toHaveAccessibleDescription('将有未读 Cron 输出的会话纳入未读分组。')
  expect(running).toHaveAccessibleDescription('在文件夹上方单独显示运行中的会话。')
})
