import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getLocale, setLocale } from '@shared/i18n'
import type { ChatReference } from '@shared/types'
import { MarkdownContent } from './MarkdownContent'

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  setLocale('en')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([false, true])('preserves Markdown DOM, selection, scroll and copied state when English override is %s', async preserveEnglishUI => {
  vi.useFakeTimers()
  const writeClipboard = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { native: { writeClipboard } } })
  const rawCode = 'const Message = "Settings /tmp/raw.txt";'
  const text = '```js\n' + rawCode + '\n```\n\n[Documentation](https://example.com)\n\n![Preview](preview.png)\n\n| Name | Value |\n| --- | --- |\n| Message | Settings |'
  const { container } = render(<MarkdownContent text={text} preserveEnglishUI={preserveEnglishUI} />)
  const code = container.querySelector('pre code')!
  const nodes = ['pre', 'pre code', 'pre code span', 'a', 'img', '.table-scroll'].map(selector => ({
    selector, element: container.querySelector(selector)!
  }))
  const tableScroll = container.querySelector<HTMLElement>('.table-scroll')!
  tableScroll.scrollLeft = 120
  const copy = screen.getByTitle('Copy full code')
  await act(async () => { fireEvent.click(copy) })
  expect(writeClipboard).toHaveBeenCalledWith(rawCode)
  expect(copy.querySelector('.lucide-check')).not.toBeNull()
  const selection = window.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(code)
  selection.addRange(range)
  const selectedText = selection.toString()
  expect(selectedText.trim()).toBe(rawCode)

  for (const locale of ['zh-CN', 'en'] as const) {
    act(() => setLocale(locale))
    for (const { selector, element } of nodes) {
      expect(container.querySelector(selector), selector).toBe(element)
    }
    expect(selection.toString()).toBe(selectedText)
    expect(selection.getRangeAt(0).startContainer).toBe(code)
    expect(tableScroll.scrollLeft).toBe(120)
    expect(screen.getByTitle(preserveEnglishUI || locale === 'en' ? 'Copy full code' : '复制完整代码')).toBe(copy)
    expect(copy.querySelector('.lucide-check')).not.toBeNull()
  }
})

it('renders Chinese and English-only Team markdown controls concurrently without changing raw code', async () => {
  const writeClipboard = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { native: { writeClipboard } } })
  const rawCode = 'const Message = "Settings /tmp/raw.txt";'
  const text = '```js\n' + rawCode + '\n```\n\n$\\frac{1}{$'
  setLocale('zh-CN')
  render(<>
    <section data-testid="general"><MarkdownContent text={text} /></section>
    <section data-testid="team"><MarkdownContent text={text} preserveEnglishUI /></section>
  </>)
  const general = screen.getByTestId('general')
  const team = screen.getByTestId('team')
  expect(within(general).getByTitle('复制完整代码')).toBeInTheDocument()
  expect(within(general).getByTitle('无法渲染此公式')).toBeInTheDocument()
  expect(within(team).getByTitle('Copy full code')).toBeInTheDocument()
  expect(within(team).getByTitle('This equation could not be rendered')).toBeInTheDocument()
  expect(general.querySelector('pre')?.textContent?.trim()).toBe(rawCode)
  expect(team.querySelector('pre')?.textContent?.trim()).toBe(rawCode)
  await act(async () => { fireEvent.click(within(team).getByTitle('Copy full code')) })
  expect(writeClipboard).toHaveBeenCalledWith(rawCode)
  expect(getLocale()).toBe('zh-CN')
  act(() => setLocale('en'))
  expect(within(general).getByTitle('Copy full code')).toBeInTheDocument()
  expect(within(team).getByTitle('Copy full code')).toBeInTheDocument()
  expect(within(general).getByTitle('This equation could not be rendered')).toBeInTheDocument()
  expect(within(team).getByTitle('This equation could not be rendered')).toBeInTheDocument()
})

it('updates route accessibility while preserving the authored reference node', () => {
  const reference: ChatReference = {
    session_id: 'other-chat', display_title_snapshot: 'Settings', action: 'route' as const,
    source_text_start: 4, source_text_end: 13, grant_intent: true
  }
  const onChatReferenceClick = vi.fn()
  render(<MarkdownContent text="Ask @Settings" sessionId="source-chat"
    inlineChatReferences={[reference]} onChatReferenceClick={onChatReferenceClick} />)
  const chip = screen.getByRole('link', { name: 'Route hint for Settings' })
  act(() => setLocale('zh-CN'))
  expect(screen.getByRole('link', { name: '会话“Settings”的路由提示' })).toBe(chip)
  expect(chip).toHaveTextContent('@Settings')
  fireEvent.click(chip)
  expect(onChatReferenceClick).toHaveBeenCalledWith(reference)
  act(() => setLocale('en'))
  expect(screen.getByRole('link', { name: 'Route hint for Settings' })).toBe(chip)
})

it('updates the memoized renderer when only the English-only override changes', () => {
  const text = '```\nunchanged code\n```'
  setLocale('zh-CN')
  const { rerender } = render(<MarkdownContent text={text} preserveEnglishUI />)
  const copy = screen.getByTitle('Copy full code')
  const code = screen.getByText('unchanged code')
  rerender(<MarkdownContent text={text} />)
  expect(screen.getByTitle('复制完整代码')).toBe(copy)
  expect(screen.getByText('unchanged code')).toBe(code)
  rerender(<MarkdownContent text={text} preserveEnglishUI />)
  expect(screen.getByTitle('Copy full code')).toBe(copy)
  expect(screen.getByText('unchanged code')).toBe(code)
})
