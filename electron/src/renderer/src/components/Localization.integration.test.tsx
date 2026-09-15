import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { disposeLanguage, initializeLanguage, setLanguagePreference } from '../lib/i18n'
import { resetTransientCloseStackForTests } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import { Composer, inboundDeliveryInterruptionMessage } from './Composer'
import { Sidebar } from './Sidebar'

const rawTitle = 'Settings / New chat / Agent 会话'
const rawFolder = 'Appearance / Team Network'

beforeEach(async () => {
  disposeLanguage()
  Reflect.deleteProperty(window, 'agentsDock')
  await setLanguagePreference('en')
  window.localStorage.clear()
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      preferences: {
        get: vi.fn(async (key: string) => key === 'sidebarScrollTop:v1' ? 24 : ''),
        set: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as AgentsDockAPI
  })
  await initializeLanguage()
  useAppStore.setState({
    profiles: [],
    activeProfileId: 'localization-test-profile',
    profileGeneration: 0,
    switchingProfileId: null,
    connected: false,
    connectionGeneration: 0,
    syncStatus: 'live',
    syncError: null,
    syncBySession: { 'chat-1': { status: 'live', error: null } },
    selectedSessionId: 'chat-1',
    chatPanes: { primary: 'chat-1', secondary: null },
    focusedChatPane: 'primary',
    sessions: [
      { id: 'chat-1', title: rawTitle, folder: rawFolder, backend: 'codex' },
      { id: 'chat-2', title: 'Pinned user title', pinned: true, backend: 'claude' },
      { id: 'chat-3', title: 'Archived user title', archived: true, backend: 'codex' }
    ],
    folderOrder: [rawFolder],
    collapsedFolders: new Set(),
    archivedCollapsed: false,
    snapshots: {},
    uploadsBySession: {},
    uploadPathsBySession: {},
    drafts: {},
    chatReferencesBySession: {},
    teamReferencesBySession: {},
    agentRoutesBySession: {},
    agentRouteLoadingSessionIds: new Set(),
    agentRouteErrorsBySession: {},
    revokingAgentRouteIds: new Set(),
    activeSessionIds: new Set(),
    turnAdmissionTokens: {},
    stoppingSessionIds: new Set(),
    runtimeCatalog: null,
    health: null,
    error: null,
    creatingChat: false
  })
})

afterEach(async () => {
  cleanup()
  resetTransientCloseStackForTests()
  disposeLanguage()
  Reflect.deleteProperty(window, 'agentsDock')
  await setLanguagePreference('en')
  vi.restoreAllMocks()
})

it('switches sidebar and Team Network labels without translating user titles or folders', async () => {
  const { container } = render(<Sidebar />)
  const row = screen.getByText(rawTitle).closest('.session-row')
  const list = container.querySelector<HTMLDivElement>('.session-list')!
  await waitFor(() => expect(list.scrollTop).toBe(24))
  list.scrollTop = 93
  fireEvent.scroll(list)
  expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument()
  expect(screen.getByText('Pinned', { exact: true })).toBeInTheDocument()

  await act(() => setLanguagePreference('zh-CN'))
  expect(screen.getByRole('button', { name: '新建会话' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '导入会话' })).toHaveTextContent('导入')
  expect(screen.getByText('已置顶', { exact: true })).toBeInTheDocument()
  expect(screen.getByText('已归档', { exact: true })).toBeInTheDocument()
  expect(screen.getByText(rawTitle).closest('.session-row')).toBe(row)
  expect(screen.getByText(rawFolder, { exact: true })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '打开团队网络' })).toHaveTextContent('团队网络 测试版')
  expect(screen.getByRole('button', { name: '打开团队网络' })).toHaveAttribute('title', '打开团队网络（测试版）')
  expect(list.scrollTop).toBe(93)
  expect(useAppStore.getState().sessions[0]).toMatchObject({ title: rawTitle, folder: rawFolder, backend: 'codex' })

  await act(() => setLanguagePreference('en'))
  expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument()
  expect(screen.getByText('Pinned', { exact: true })).toBeInTheDocument()
  expect(screen.getByText(rawTitle).closest('.session-row')).toBe(row)
  expect(screen.getByRole('button', { name: 'Open Team Network' })).toHaveTextContent('Team Network Beta')
  expect(list.scrollTop).toBe(93)
})

it('preserves the real composer draft, selection, textarea, and raw title through Chinese and English switches', async () => {
  render(<Composer sessionId="chat-1" />)
  const textarea = screen.getByRole('textbox', { name: `Message ${rawTitle}` }) as HTMLTextAreaElement
  const rawDraft = 'Please keep Chat, Settings, /plan, /tmp/Message.txt and 会话 exactly as typed.'
  fireEvent.change(textarea, { target: { value: rawDraft } })
  textarea.focus()
  textarea.setSelectionRange(7, 16)
  Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: () => 260 })
  Object.defineProperty(textarea, 'clientHeight', { configurable: true, get: () => 190 })
  textarea.scrollTop = 40

  await act(() => setLanguagePreference('zh-CN'))
  expect(screen.getByRole('textbox', { name: `向“${rawTitle}”发送消息` })).toBe(textarea)
  expect(textarea).toHaveValue(rawDraft)
  expect(textarea.selectionStart).toBe(7)
  expect(textarea.selectionEnd).toBe(16)
  expect(textarea.scrollTop).toBe(40)
  await waitFor(() => expect(useAppStore.getState().drafts['chat-1']).toBe(rawDraft))
  expect(useAppStore.getState().sessions[0].title).toBe(rawTitle)

  await act(() => setLanguagePreference('en'))
  expect(screen.getByRole('textbox', { name: `Message ${rawTitle}` })).toBe(textarea)
  expect(textarea).toHaveValue(rawDraft)
  expect(textarea.selectionStart).toBe(7)
  expect(textarea.selectionEnd).toBe(16)
  expect(textarea.scrollTop).toBe(40)
})

it('refreshes an already-open command palette while retaining command identity and input', async () => {
  render(<Composer />)
  const textarea = screen.getByRole('textbox')
  fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
  const palette = screen.getByRole('listbox')
  const settingsOption = within(palette).getByRole('option', { name: /Settings.*Open AgentsDock settings/ })
  const identity = settingsOption.id

  await act(() => setLanguagePreference('zh-CN'))
  expect(within(palette).getByText('设置', { exact: true })).toBeInTheDocument()
  expect(document.getElementById(identity)).toBe(settingsOption)
  expect(textarea).toHaveValue('/')
  await waitFor(() => expect(useAppStore.getState().drafts['chat-1']).toBe('/'))

  await act(() => setLanguagePreference('en'))
  expect(within(palette).getByText('Settings', { exact: true })).toBeInTheDocument()
  expect(document.getElementById(identity)).toBe(settingsOption)
  expect(textarea).toHaveValue('/')
})

it('keeps secure-peer queue rows and interruption warnings in English in the Chinese UI', async () => {
  const warning = inboundDeliveryInterruptionMessage('secure_peer', 'stop')
  const steerWarning = inboundDeliveryInterruptionMessage('secure_peer', 'send_now')
  useAppStore.setState({
    snapshots: {
      'chat-1': {
        session: { id: 'chat-1', title: rawTitle, backend: 'codex' },
        events: [],
        queuedTurns: [{
          queued_id: 'queued-peer', session_id: 'chat-1',
          prompt: 'Encrypted raw Settings message', file_ids: [],
          purpose: 'secure_peer_handoff_delivery', secure_peer_envelope_id: 'peer-envelope-1'
        }],
        files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
      }
    }
  })
  await act(() => setLanguagePreference('zh-CN'))
  render(<Composer />)
  expect(inboundDeliveryInterruptionMessage('secure_peer', 'stop')).toBe(warning)
  expect(inboundDeliveryInterruptionMessage('secure_peer', 'send_now')).toBe(steerWarning)
  const row = screen.getByRole('status', { name: 'Encrypted raw Settings message, encrypted peer delivery, queue position pending' })
  expect(within(row).getByText('Encrypted peer delivery · position pending · starts automatically')).toBeInTheDocument()
  const skip = within(row).getByRole('button', { name: 'Skip encrypted peer delivery' })
  expect(skip).toHaveTextContent('Skip delivery')
  expect(skip).toHaveAttribute('title', 'Update AgentsServer to safely skip this delivery.')
})

it('localizes both reference controls while preserving authored @ and @@ text', async () => {
  const prefix = `${'checkpoint/'.repeat(30)}\n`
  const chatDraft = `${prefix}Ask @Training`
  const teamDraft = `${prefix}Ask @@Pat`
  const chatStart = chatDraft.indexOf('@Training')
  const teamStart = teamDraft.indexOf('@@Pat')
  useAppStore.setState({
    sessions: [
      { id: 'chat-1', title: rawTitle, backend: 'codex' },
      { id: 'chat-2', title: 'Training', backend: 'claude' },
      { id: 'team-chat', title: 'Team raw title', backend: 'codex' }
    ],
    drafts: { 'chat-1': chatDraft, 'team-chat': teamDraft },
    chatReferencesBySession: { 'chat-1': [{
      session_id: 'chat-2', display_title_snapshot: 'Training', action: 'route',
      source_text_start: chatStart, source_text_end: chatStart + 9
    }] },
    teamReferencesBySession: { 'team-chat': [{
      kind: 'recipient', recipient_kind: 'server', team_id: 'raw-team', target_id: 'raw-server',
      display_name_snapshot: 'Pat', source_text_start: teamStart, source_text_end: teamStart + 5,
      grant_intent: true
    }] }
  })
  await act(() => setLanguagePreference('zh-CN'))
  const { rerender } = render(<Composer sessionId="chat-1" />)
  expect(screen.getByRole('group', { name: '已选择的消息引用' })).toHaveTextContent('@Training')
  expect(screen.getByRole('textbox')).toHaveValue(chatDraft)
  rerender(<Composer sessionId="team-chat" />)
  expect(screen.getByRole('group', { name: '已选择的消息引用' })).toHaveTextContent('@@Pat')
  expect(screen.getByRole('textbox')).toHaveValue(teamDraft)
})
