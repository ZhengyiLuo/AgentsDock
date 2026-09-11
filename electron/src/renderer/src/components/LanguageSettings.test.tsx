import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localeOptions } from '@shared/locales'
import { disposeLanguage, initializeLanguage, LANGUAGE_STORAGE_KEY, setLanguagePreference } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import { AppSettingsDialog } from './Dialogs'

beforeEach(async () => {
  Reflect.deleteProperty(window, 'agentsDock')
  disposeLanguage()
  await setLanguagePreference('en')
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  disposeLanguage()
  Reflect.deleteProperty(window, 'agentsDock')
})

it('changes Settings > General language live and persists the selection without reopening settings', async () => {
  const save = vi.fn(async preference => ({ preference, systemLocale: 'en-US' }))
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      language: {
        get: vi.fn().mockResolvedValue({ preference: 'en', systemLocale: 'en-US' }),
        set: save
      },
      updates: { check: vi.fn().mockResolvedValue({ state: 'not-available', channel: 'direct', track: 'stable', currentVersion: '0.2.0' }) },
      events: { on: vi.fn().mockReturnValue(() => undefined) }
    }
  })
  await initializeLanguage()
  useAppStore.setState({
    profiles: [],
    health: { ok: true, server_version: '0.1.26' },
    modals: { settings: false, appSettings: true, newChat: false, resume: false, folder: false, digest: false, job: false, search: false, review: false, importChats: false }
  })
  render(<AppSettingsDialog />)
  const originalDialog = screen.getByRole('dialog', { name: 'Settings' })
  const selector = within(originalDialog).getByRole('combobox', { name: 'Language' })
  expect(selector).toHaveValue('en')
  expect(within(selector).getAllByRole('option').map(option => ({ value: (option as HTMLOptionElement).value, label: option.textContent }))).toEqual([
    { value: 'system', label: 'Follow system' },
    ...localeOptions
  ])
  await act(async () => { fireEvent.change(selector, { target: { value: 'zh-CN' } }) })
  expect(screen.getByRole('dialog', { name: '设置' })).toBe(originalDialog)
  expect(screen.getByRole('button', { name: '通用' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('combobox', { name: '语言' })).toBe(selector)
  expect(selector).toHaveValue('zh-CN')
  expect(within(selector).getByRole('option', { name: '和系统一致' })).toBeInTheDocument()
  for (const option of localeOptions) {
    expect(within(selector).getByRole('option', { name: option.label })).toHaveValue(option.value)
  }
  await waitFor(() => expect(save).toHaveBeenCalledWith('zh-CN'))
  expect(JSON.parse(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)!)).toEqual({ preference: 'zh-CN', pending: false })
  fireEvent.click(screen.getByRole('button', { name: '外观' }))
  expect(screen.getByRole('combobox', { name: '应用主题' })).toHaveValue('system')
  expect(screen.getByRole('option', { name: '和系统一致' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '通用' }))
  await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: '语言' }), { target: { value: 'en' } }) })
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(originalDialog)
  expect(screen.getByRole('combobox', { name: 'Language' })).toHaveValue('en')
})
