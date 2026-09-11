import { forwardRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale } from '@shared/i18n'
import { resetTransientCloseStackForTests } from '../lib/transient-close'
import { welcomeReply, WELCOME_SETUP_URL, WELCOME_SHOW_TOKEN_COMMAND } from '../lib/welcome-chat'
import { useAppStore } from '../store/app-store'
import { CodeReview } from './CodeReview'
import { EmergencyTimelineDock } from './EmergencyTimelineDock'
import { WelcomeChat } from './WelcomeChat'

vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function MockVirtuoso(props: {
    data: unknown[]
    computeItemKey: (index: number, item: unknown) => string
    itemContent: (index: number, item: unknown) => React.ReactNode
    className?: string
  }, _ref) {
    return <div className={props.className}>{props.data.map((item, index) => <div key={props.computeItemKey(index, item)}>{props.itemContent(index, item)}</div>)}</div>
  })
}))

const originalAcknowledge = useAppStore.getState().acknowledgeEmergency

beforeEach(() => setLocale('en'))
afterEach(() => {
  cleanup()
  resetTransientCloseStackForTests()
  useAppStore.setState({ acknowledgeEmergency: originalAcknowledge })
  setLocale('en')
  vi.restoreAllMocks()
})

it('localizes code-review count templates while retaining raw paths and patch lines', () => {
  const source = ['src/Settings.ts', 'src/Message.ts'].map(path => [
    `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -4,7 +4,7 @@',
    ' <<<<<<< HEAD', ' ours /tmp/Settings', ' ||||||| parent', ' base', ' =======', ' theirs', ' >>>>>>> feature'
  ].join('\n')).join('\n')
  render(<CodeReview target={{ sessionId: 'raw-chat-id', source }} onClose={vi.fn()} />)
  expect(screen.getByRole('status')).toHaveTextContent('2 conflicted files · 2 conflicts')
  expect(screen.getByText('2 files', { exact: true })).toBeInTheDocument()
  expect(screen.getAllByText('3 unmodified lines').length).toBe(2)
  act(() => setLocale('zh-CN'))
  expect(screen.getByRole('status')).toHaveTextContent('2 个有冲突的文件 · 2 处冲突')
  expect(screen.getByText('2 个文件', { exact: true })).toBeInTheDocument()
  expect(screen.getAllByText('3 行未修改').length).toBe(2)
  expect(screen.getByRole('button', { name: 'src/Settings.ts，1 处冲突，新增 0 行，删除 0 行' })).toBeInTheDocument()
  expect(screen.getAllByText('ours /tmp/Settings').length).toBe(2)
  act(() => setLocale('en'))
  expect(screen.getByRole('status')).toHaveTextContent('2 conflicted files · 2 conflicts')
})

it('updates only canned welcome copy when switching languages and preserves user text and drafts', () => {
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const { container } = render(<WelcomeChat />)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'hello Settings /tmp/Message.txt' } })
  fireEvent.submit(input.closest('form')!)
  fireEvent.change(input, { target: { value: 'Pending user draft /plan' } })
  expect(screen.getByText(/isn't connected to a real agent yet/)).toBeInTheDocument()
  act(() => setLocale('zh-CN'))
  expect(container.querySelector('.welcome-chat-lead')).toHaveTextContent('AgentsDock 连接到由你运行和管理的 AgentsServer')
  expect(screen.getByText(/尚未连接到真实的 Agent/)).toBeInTheDocument()
  expect(screen.getByText('hello Settings /tmp/Message.txt')).toBeInTheDocument()
  expect(input).toHaveValue('Pending user draft /plan')
  expect(welcomeReply('你好')).toMatch(/^你好/)
  const setup = welcomeReply('怎么设置服务端')
  expect(setup).toContain(WELCOME_SHOW_TOKEN_COMMAND)
  expect(setup).toContain(WELCOME_SETUP_URL)
  act(() => setLocale('en'))
  expect(screen.getByText(/isn't connected to a real agent yet/)).toBeInTheDocument()
  expect(input).toHaveValue('Pending user draft /plan')
})

it('localizes emergency counts and retry state without altering alert text or acknowledgement IDs', async () => {
  const acknowledgeEmergency = vi.fn().mockResolvedValue(false)
  useAppStore.setState({
    activeProfileId: 'raw-profile', profileGeneration: 1, profiles: [], switchingProfileId: null,
    acknowledgeEmergency,
    sessions: ['current', 'second', 'third'].map(id => ({
      id, title: `Raw ${id} Settings`, backend: 'codex' as const,
      emergency_alert: {
        id: `raw-alert-${id}`, status: 'active' as const, severity: 'critical' as const,
        message: 'Raw failure detail: /tmp/Message.txt', raised_at: '2026-09-01T00:00:00Z'
      },
      unacknowledged_emergency_count: 1
    }))
  })
  render(<EmergencyTimelineDock sessionId="current" focused />)
  expect(screen.getByText('2 more active emergencies')).toBeInTheDocument()
  act(() => setLocale('zh-CN'))
  expect(screen.getByText('另有 2 个待处理的紧急情况')).toBeInTheDocument()
  expect(screen.getByText('Raw failure detail: /tmp/Message.txt')).toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认“Raw current Settings”中的紧急情况' })) })
  expect(acknowledgeEmergency).toHaveBeenCalledWith('current', 'raw-alert-current')
  expect(screen.getByRole('alert')).toHaveTextContent('无法确认。请重试。')
  act(() => setLocale('en'))
  expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t acknowledge. Try again.')
})
