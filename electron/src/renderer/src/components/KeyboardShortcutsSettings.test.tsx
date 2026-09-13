import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale, t } from '@shared/i18n'
import { APP_SHORTCUT_GROUPS, APP_SHORTCUTS, shortcutDisplay, shortcutKeycaps, shortcutTranslationKey } from '@shared/shortcuts'
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings'

afterEach(() => {
  cleanup()
  setLocale('en')
})

describe('KeyboardShortcutsSettings', () => {
  it('renders every registered shortcut once in its group with Mac keys', () => {
    render(<KeyboardShortcutsSettings platform="mac" />)

    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(Object.keys(APP_SHORTCUTS).length)
    for (const group of APP_SHORTCUT_GROUPS) {
      const heading = screen.getByRole('heading', { name: t(`shortcuts.group.${group.id}`) })
      const list = heading.parentElement?.querySelector('ul')
      expect(list).not.toBeNull()
      for (const shortcut of group.shortcuts) {
        const label = within(list as HTMLElement).getByText(t(shortcutTranslationKey(shortcut)))
        const row = label.closest('li')!
        const keycaps = Array.from(row.querySelectorAll('kbd')).map(key => key.textContent)
        expect(keycaps).toEqual(shortcutKeycaps(shortcut, 'mac'))
        expect(row.querySelector('.sr-only')).toHaveTextContent(shortcutDisplay(shortcut, 'mac'))
      }
    }
  })

  it('uses Windows and Linux key labels on non-Mac platforms', () => {
    render(<KeyboardShortcutsSettings platform="other" />)

    const label = screen.getByText('Toggle chat list')
    const keycaps = Array.from(label.closest('li')!.querySelectorAll('kbd')).map(key => key.textContent)
    expect(keycaps).toEqual(['Ctrl', '/'])
    const terminalLabel = screen.getByText('New tmux window')
    const availability = within(terminalLabel.closest('li') as HTMLElement).getByText('macOS only')
    expect(availability.tagName).toBe('SPAN')
  })

  it('updates its category, groups, and actions in Simplified Chinese', () => {
    setLocale('zh-CN')
    render(<KeyboardShortcutsSettings platform="mac" />)

    expect(screen.getByRole('heading', { name: '键盘快捷键' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '导航' })).toBeInTheDocument()
    expect(screen.getByText('切换会话列表')).toBeInTheDocument()
    expect(screen.getByText('发送消息')).toBeInTheDocument()
  })
})
