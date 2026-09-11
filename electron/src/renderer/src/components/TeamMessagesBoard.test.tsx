import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { AgentsDockAPI } from '@shared/ipc'
import type { TeamHubScope } from '@shared/team-hub'
import type { NativeFileRef } from '@shared/types'
import { TEAM_MESSAGES_SKILL_SLUG_PATTERN, type TeamAttachment, type TeamMessage, type TeamMessageCreateInput, type TeamMailboxStateInput, type TeamMessagePage, type TeamMessageSummary, type TeamMessagesCapability, type TeamNetworkBulletinPost, type TeamSkill, type TeamSkillDetails } from '@shared/team-network'
import { resetTeamNetworkSnapshotCacheForTests } from '../lib/team-network-snapshot-cache'
import { parseTeamMessageLink } from '../lib/team-message-links'
import { TeamMessagesBoard } from './TeamMessagesBoard'

const teamMessagesStyles = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/TeamMessagesBoard.css'), 'utf8')

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetTeamNetworkSnapshotCacheForTests()
  document.head.querySelectorAll('style[data-team-messages-layout-test]').forEach(node => node.remove())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const scope: TeamHubScope = {
  profileId: 'profile-1',
  profileGeneration: 2,
  serverIdentity: 'server-local',
  generation: 3,
  hubIdentity: 'hub-1'
}

const capability: TeamMessagesCapability = {
  available: true,
  version: 1,
  kinds: ['message', 'skill'],
  recipient_kinds: ['server', 'human', 'all'],
  max_body_bytes: 131_072,
  max_recipients_per_message: 32,
  max_page_items: 100,
  attachments: {
    max_bytes_per_file: 64 * 1024 * 1024,
    max_files_per_message: 16,
    max_bytes_per_message: 128 * 1024 * 1024,
    chunk_bytes: 8 * 1024 * 1024,
    range_downloads: true,
    team_quota_bytes: 1024 * 1024 * 1024
  },
  skills: {
    slug_pattern: TEAM_MESSAGES_SKILL_SLUG_PATTERN,
    max_per_team: 500,
    max_versions_per_skill: 200,
    max_tags: 8
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function attachment(overrides: Partial<TeamAttachment> = {}): TeamAttachment {
  return {
    id: 'attachment-1',
    team_id: 'team-1',
    message_id: 'message-1',
    file_name: 'walkthrough.mp4',
    media_type: 'video/mp4',
    byte_size: 4_096,
    sha256: 'a'.repeat(64),
    state: 'ready',
    received_bytes: 4_096,
    created_at: '2026-09-03T15:00:00Z',
    ready_at: '2026-09-03T15:00:01Z',
    ...overrides
  }
}

function message(overrides: Partial<TeamMessage> = {}): TeamMessage {
  return {
    id: 'message-1',
    team_id: 'team-1',
    sequence: 7,
    kind: 'message',
    title: null,
    body_format: 'markdown',
    body: 'Please review the **rollout**.',
    body_bytes: 30,
    body_sha256: 'b'.repeat(64),
    sender: { kind: 'server', id: 'server-remote', display_name: 'Studio' },
    provenance: { via: 'agent', backend: 'codex' },
    recipients: [{
      kind: 'server', id: 'server-local', display_name: 'TargetApp', state: 'available',
      delivered_at: null, read_at: null
    }],
    in_reply_to_message_id: null,
    skill: null,
    attachments: [],
    created_at: '2026-09-03T15:00:00Z',
    ...overrides
  }
}

function bulletinMessage(overrides: Partial<TeamMessage> = {}): TeamMessage {
  return message({
    recipients: [{
      kind: 'all', id: 'all', display_name: 'Everyone', state: 'available',
      delivered_at: null, read_at: null
    }],
    ...overrides
  })
}

function messageSummary(full: TeamMessage, overrides: Partial<TeamMessageSummary> = {}): TeamMessageSummary {
  const { body: _body, ...summary } = full
  return {
    ...summary,
    preview: 'Please review the rollout.',
    body_bytes: new TextEncoder().encode(full.body).byteLength,
    delivery: full.recipients.find(recipient => recipient.kind !== 'all') ?? null,
    ...overrides
  }
}

function editableSkill(): TeamSkillDetails {
  return {
    id: 'skill-editable',
    team_id: 'team-1',
    slug: 'editable-guide',
    title: 'Editable guide',
    summary: 'A guide that can change',
    tags: ['operations'],
    version: 1,
    versions_count: 1,
    pinned: false,
    pinned_at: null,
    archived: false,
    archived_at: null,
    author: { kind: 'server', id: 'server-local', display_name: 'TargetApp' },
    body_bytes: 16,
    current: {
      version: 1,
      message_id: 'skill-message-editable',
      change_note: 'Initial version',
      created_at: '2026-09-03T15:00:00Z'
    },
    created_at: '2026-09-03T15:00:00Z',
    updated_at: '2026-09-03T15:00:00Z',
    permissions: { edit: true, manage: true },
    body_format: 'markdown',
    body: '# Editable guide',
    attachments: []
  }
}

function installEditableSkillAPI(choose: () => Promise<NativeFileRef[]>): TeamSkillDetails {
  const skill = editableSkill()
  installAPI([], [])
  Object.assign(window.agentsDock, { files: { choose } })
  Object.assign(window.agentsDock.teamHub, {
    teamSkills: vi.fn().mockResolvedValue({ skills: [skill] }),
    teamSkill: vi.fn().mockResolvedValue(skill),
    teamSkillVersions: vi.fn().mockResolvedValue({ skill_id: skill.id, versions: [] })
  })
  return skill
}

function installAPI(messages: TeamMessageSummary[], details: TeamMessage[] = []) {
  const teamMessages = vi.fn().mockImplementation((_scope, query: { box: 'inbox' | 'feed' | 'sent'; addressKind?: 'server' | 'human'; addressId?: string }) => Promise.resolve({
    box: query.box,
    address: query.box === 'inbox' ? { kind: query.addressKind!, id: query.addressId! } : null,
    messages,
    next_after_sequence: messages.at(-1)?.sequence ?? 0,
    has_more: false
  }))
  const teamMessage = vi.fn().mockImplementation((_scope, _teamId: string, messageId: string) => {
    const detail = details.find(candidate => candidate.id === messageId)
    return detail ? Promise.resolve(detail) : Promise.reject(new Error('Message not found'))
  })
  const recordTeamMessageReceipt = vi.fn().mockImplementation((_scope, input: { messageId: string }) => {
    const source = details.find(candidate => candidate.id === input.messageId)
      ?? messages.find(candidate => candidate.id === input.messageId)
    return Promise.resolve({
      message_id: input.messageId,
      recipients: (source?.recipients ?? []).map(recipient => ({
        ...recipient,
        state: 'read' as const,
        delivered_at: recipient.delivered_at ?? '2026-09-03T15:00:01Z',
        read_at: '2026-09-03T15:00:02Z'
      }))
    })
  })
  const cacheTeamAttachment = vi.fn().mockImplementation((_scope, input: { attachmentId: string; previewBytes?: number }) => {
    const cached = details.flatMap(detail => detail.attachments).find(candidate => candidate.id === input.attachmentId)
      ?? attachment({ id: input.attachmentId })
    const preview = cached.file_name === 'recovery.txt'
      ? 'Recovery text'
      : '# Recovery runbook\n\nUse **safe mode**.'
    return Promise.resolve({
      attachment: cached,
      media_url: `agentsdock-media://team/profile-1/team-1/${input.attachmentId}`,
      ...(input.previewBytes === undefined ? {} : {
        text_preview: {
          text: preview,
          byte_size: Math.min(cached.byte_size, input.previewBytes),
          truncated: cached.byte_size > input.previewBytes
        }
      })
    })
  })
  const networkDeletions = vi.fn().mockResolvedValue({
    supported: true,
    page: { deletions: [], next_after_sequence: 0, has_more: false }
  })
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      teamHub: { teamMessages, teamMessage, recordTeamMessageReceipt, cacheTeamAttachment, networkDeletions }
    } as unknown as AgentsDockAPI
  })
  return { teamMessages, teamMessage, recordTeamMessageReceipt, cacheTeamAttachment, networkDeletions }
}

describe('server inbox attention state', () => {
  const modern: TeamMessagesCapability = { ...capability, mailbox_state: { available: true, version: 1, address_kinds: ['server'] } }
  const receipt = { ...message().recipients[0], state: 'read' as const,
    delivered_at: '2026-09-03T15:00:01Z', read_at: '2026-09-03T15:00:02Z' }
  const state = (unread: boolean, version: number) => ({ address_kind: 'server' as const, address_id: 'server-local', unread, version })
  const mail = (unread = false, version = 1) => message({ delivery: receipt, recipients: [receipt], mailbox_state: state(unread, version) })
  const board = (props: Partial<Parameters<typeof TeamMessagesBoard>[0]> = {}) => <TeamMessagesBoard
    section="mail" scope={scope} teamId="team-1" capability={modern}
    addresses={[{ kind: 'server', id: 'server-local', label: 'Local' }]} canWrite {...props} />
  const install = (summary = mail(), detail = summary) => {
    const api = installAPI([messageSummary(summary)], [detail])
    const setTeamMessageMailboxState = vi.fn(async (_scope: TeamHubScope, input: TeamMailboxStateInput) => ({
      message_id: input.messageId, mailbox_state: state(input.unread, input.expectedVersion + 1), recipients: [receipt]
    }))
    Object.assign(window.agentsDock.teamHub, { setTeamMessageMailboxState })
    return { ...api, setTeamMessageMailboxState }
  }
  const menu = async () => {
    const row = await screen.findByRole('button', { name: /^Open / })
    fireEvent.contextMenu(row)
    return row.closest('article')!
  }

  it('marks read mail unread and back without rewinding receipts or refreshing the inbox', async () => {
    const api = install()
    const counts = vi.fn()
    const globalRead = vi.fn()
    window.addEventListener('agentsdock:team-network-mail-read', globalRead)
    try {
      render(board({ onUnreadSnapshot: counts }))
      const row = await menu()
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark as unread' }))
      await waitFor(() => expect(row).toHaveClass('unread'))
      expect(api.setTeamMessageMailboxState.mock.calls[0][1]).toEqual({
        teamId: 'team-1', messageId: 'message-1', addressKind: 'server', addressId: 'server-local',
        unread: true, expectedVersion: 1, idempotencyKey: expect.any(String)
      })
      expect(counts).toHaveBeenLastCalledWith(1, false)
      await menu()
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark as read' }))
      await waitFor(() => expect(row).not.toHaveClass('unread'))
      expect(api.setTeamMessageMailboxState.mock.calls[1][1]).toMatchObject({ unread: false, expectedVersion: 2 })
      expect(counts).toHaveBeenLastCalledWith(0, false)
      expect(api.recordTeamMessageReceipt).not.toHaveBeenCalled()
      expect(globalRead).not.toHaveBeenCalled()
      expect(api.teamMessages).toHaveBeenCalledTimes(1)
      expect(api.teamMessage).not.toHaveBeenCalled()
      expect(receipt.state).toBe('read')
    } finally { window.removeEventListener('agentsdock:team-network-mail-read', globalRead) }
  })

  it('uses the freshly loaded parent version when opening mail to mark it read', async () => {
    const api = install(mail(true, 2), mail(true, 4))
    render(board())
    fireEvent.click(await screen.findByRole('button', { name: /^Open / }))
    await waitFor(() => expect(api.setTeamMessageMailboxState).toHaveBeenCalledTimes(1))
    expect(api.setTeamMessageMailboxState.mock.calls[0][1]).toMatchObject({ unread: false, expectedVersion: 4 })
    expect(api.teamMessage).toHaveBeenCalledTimes(1)
    expect(api.recordTeamMessageReceipt).not.toHaveBeenCalled()
  })

  it('retries an unconfirmed explicit toggle using the same expected version and key', async () => {
    const api = install()
    api.setTeamMessageMailboxState.mockRejectedValueOnce(new Error('Connection ended before confirmation'))
    render(board())
    const row = await menu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark as unread' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection ended')
    expect(row).not.toHaveClass('unread')
    await menu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark as unread' }))
    await waitFor(() => expect(row).toHaveClass('unread'))
    expect(api.setTeamMessageMailboxState.mock.calls[1][1]).toEqual(api.setTeamMessageMailboxState.mock.calls[0][1])
    expect(api.teamMessages).toHaveBeenCalledTimes(1)
  })

  it('retains a newer local state when an explicit refresh returns an older page and receipt projection', async () => {
    const api = install()
    render(board())
    const row = (await screen.findByRole('button', { name: /^Open / })).closest('article')!
    const delayed = deferred<TeamMessagePage>()
    api.teamMessages.mockReturnValueOnce(delayed.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh mail' }))
    await menu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark as unread' }))
    await waitFor(() => expect(row).toHaveClass('unread'))
    await act(async () => delayed.resolve({ box: 'inbox', address: { kind: 'server', id: 'server-local' },
      messages: [messageSummary(mail())], next_after_sequence: 7, has_more: false }))
    await waitFor(() => expect(api.teamMessage).toHaveBeenCalledTimes(1))
    expect(row).toHaveClass('unread')
  })

  it('fences a late mutation result when the profile generation changes', async () => {
    const api = install()
    const delayed = deferred<Awaited<ReturnType<typeof api.setTeamMessageMailboxState>>>()
    api.setTeamMessageMailboxState.mockReturnValueOnce(delayed.promise)
    const view = render(board())
    await menu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark as unread' }))
    await waitFor(() => expect(api.setTeamMessageMailboxState).toHaveBeenCalledTimes(1))
    view.rerender(board({ scope: { ...scope, profileGeneration: scope.profileGeneration + 1 } }))
    await act(async () => delayed.resolve({ message_id: 'message-1', mailbox_state: state(true, 2), recipients: [receipt] }))
    expect((await screen.findByRole('button', { name: /^Open / })).closest('article')).not.toHaveClass('unread')
  })

  it('keeps old hosts on the existing read-receipt contract', async () => {
    const api = install()
    render(board({ capability }))
    await menu()
    expect(screen.queryByRole('menuitem', { name: 'Mark as unread' })).not.toBeInTheDocument()
    expect(api.setTeamMessageMailboxState).not.toHaveBeenCalled()
  })
})

describe('human replies to exact server mail', () => {
  const subjectsCapability: TeamMessagesCapability = {
    ...capability, mail_subjects: { available: true, version: 1, max_subject_chars: 160 }
  }
  const localAddress = { kind: 'server' as const, id: 'server-local', label: 'Local' }
  const subject = 'Review [phase 1] \\ **literal** 中文'
  const board = (props: Partial<Parameters<typeof TeamMessagesBoard>[0]> = {}) => <TeamMessagesBoard
    section="mail" scope={scope} teamId="team-1" capability={subjectsCapability}
    addresses={[localAddress]} canWrite callerPostingKind="server" draftIdentity="reply-owner" {...props} />
  const incoming = (overrides: Partial<TeamMessage> = {}) => {
    const parent = message({ title: subject, ...overrides })
    return { ...parent, delivery: overrides.delivery === undefined ? parent.recipients[0] : overrides.delivery }
  }
  const replyResult = (input: TeamMessageCreateInput) => message({
    id: 'reply-message-1', sequence: 8, title: input.title ?? null, body: input.body,
    sender: { kind: 'server', id: 'server-local', display_name: 'Local' },
    recipients: [{ ...message().recipients[0], id: 'server-remote', display_name: 'Studio' }],
    in_reply_to_message_id: input.inReplyToMessageId ?? null
  })
  const installReplyAPI = (parent = incoming()) => {
    const api = installAPI([messageSummary(parent)], [parent])
    const createTeamMessage = vi.fn((_scope: TeamHubScope, input: TeamMessageCreateInput) => Promise.resolve(replyResult(input)))
    Object.assign(window.agentsDock.teamHub, { createTeamMessage })
    return { ...api, createTeamMessage }
  }
  const openDetail = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /^Open / }))
    return screen.findByRole('button', { name: 'Reply' })
  }
  const openReply = async () => {
    fireEvent.click(await openDetail())
    return screen.findByRole('dialog', { name: 'Reply to Studio' })
  }

  it('opens a reviewable literal-subject draft and sends once to the fanout parent’s sender', async () => {
    const parent = incoming({ destination: 'all_servers', recipients: [
      message().recipients[0], { ...message().recipients[0], id: 'server-other', display_name: 'Other' }
    ] })
    const api = installReplyAPI(parent)
    const sending = deferred<TeamMessage>()
    api.createTeamMessage.mockReturnValueOnce(sending.promise)
    render(board())
    const dialog = await openReply()
    expect(within(dialog).getByText(subject, { exact: false })).toBeVisible()
    expect(within(dialog).queryByText('Other')).not.toBeInTheDocument()
    expect(api.teamMessage).toHaveBeenCalledTimes(1)
    expect(api.createTeamMessage).not.toHaveBeenCalled()
    const input = within(dialog).getByRole('textbox', { name: 'Reply message' })
    fireEvent.change(input, { target: { value: '  Reviewed the exact message.  ' } })
    const form = within(dialog).getByRole('form', { name: 'Reply to mail' })
    fireEvent.submit(form)
    fireEvent.submit(form)
    await waitFor(() => expect(api.createTeamMessage).toHaveBeenCalledTimes(1))
    const submitted = api.createTeamMessage.mock.calls[0][1]
    expect(submitted).toEqual({
      teamId: 'team-1', kind: 'message', title: subject, body: 'Reviewed the exact message.', bodyFormat: 'markdown',
      recipients: [{ kind: 'server', id: 'server-remote' }], attachmentIds: [],
      inReplyToMessageId: parent.id, provenance: { via: 'desktop' }, idempotencyKey: expect.any(String)
    })
    expect(api.teamMessage).toHaveBeenLastCalledWith(scope, 'team-1', parent.id)
    expect(api.teamMessage).toHaveBeenCalledTimes(2)
    expect(api.teamMessages).toHaveBeenCalledTimes(1)
    expect(api.recordTeamMessageReceipt).toHaveBeenCalledTimes(1)
    await act(async () => sending.resolve(replyResult(submitted)))
    expect(await screen.findByText('Reply sent to Studio.')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.teamMessages).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('')
  })

  it('keeps typing in memory without synchronous storage or body serialization and batches one trailing write', async () => {
    const api = installReplyAPI()
    render(board({ draftIdentity: 'batched-typing' }))
    await openReply()
    vi.useFakeTimers()
    const write = vi.spyOn(localStorage, 'setItem')
    const remove = vi.spyOn(localStorage, 'removeItem')
    const serialize = vi.spyOn(JSON, 'stringify')
    const input = screen.getByRole('textbox', { name: 'Reply message' })
    let body = ''
    for (const character of 'Many typed characters') {
      body += character
      fireEvent.change(input, { target: { value: body } })
      expect(write).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
    }
    expect(serialize.mock.calls.some(([value]) => value && typeof value === 'object' && 'body' in value)).toBe(false)
    expect(input).toHaveValue(body)
    await act(async () => vi.advanceTimersByTime(399))
    expect(write).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(1))
    expect(write).toHaveBeenCalledTimes(1)
    expect(JSON.parse(write.mock.calls[0][1])).toEqual({ body, attempt: null })
    expect(api.createTeamMessage).not.toHaveBeenCalled()
    expect(api.teamMessages).toHaveBeenCalledTimes(1)
    expect(api.teamMessage).toHaveBeenCalledTimes(1)
  })

  it('flushes pending typing on close, page exit, and unmount without later duplicate writes', async () => {
    installReplyAPI()
    const view = render(board({ draftIdentity: 'flush-boundaries' }))
    await openReply()
    vi.useFakeTimers()
    const write = vi.spyOn(localStorage, 'setItem')
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'Close keeps this.' } })
    expect(write).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep draft' }))
    expect(write).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('Close keeps this.')
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'Page exit keeps this.' } })
    expect(write).toHaveBeenCalledTimes(1)
    act(() => window.dispatchEvent(new Event('pagehide')))
    expect(write).toHaveBeenCalledTimes(2)
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'Unmount keeps this.' } })
    view.unmount()
    expect(write).toHaveBeenCalledTimes(3)
    expect(JSON.parse(write.mock.calls[2][1]).body).toBe('Unmount keeps this.')
    await act(async () => vi.advanceTimersByTime(1000))
    expect(write).toHaveBeenCalledTimes(3)
  })

  it('flushes before parent validation and locks before POST without resurrecting a confirmed draft', async () => {
    const parent = incoming()
    const api = installReplyAPI(parent)
    const checking = deferred<TeamMessage>()
    render(board({ draftIdentity: 'flush-before-send' }))
    await openReply()
    vi.useFakeTimers()
    const write = vi.spyOn(localStorage, 'setItem')
    api.teamMessage.mockReturnValueOnce(checking.promise)
    api.createTeamMessage.mockImplementation((_scope, input) => {
      const saved = JSON.parse(localStorage.getItem(write.mock.calls[0][0])!)
      expect(saved.attempt.idempotencyKey).toBe(input.idempotencyKey)
      expect(saved.attempt.body).toBe(input.body)
      return Promise.resolve(replyResult(input))
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'One confirmed reply.' } })
    expect(write).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(write).toHaveBeenCalledTimes(1)
    expect(JSON.parse(write.mock.calls[0][1])).toEqual({ body: 'One confirmed reply.', attempt: null })
    expect(api.createTeamMessage).not.toHaveBeenCalled()
    await act(async () => checking.resolve(parent))
    expect(api.createTeamMessage).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(2)
    const key = write.mock.calls[0][0]
    expect(localStorage.getItem(key)).toBeNull()
    await act(async () => vi.advanceTimersByTime(1000))
    expect(write).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(key)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('')
  })

  it('retains unsent drafts across closing, mailbox navigation, and remounting', async () => {
    const api = installReplyAPI()
    const view = render(board())
    await openReply()
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'Review this draft first.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Keep draft' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await openReply()
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('Review this draft first.')
    view.unmount()
    render(board())
    await openReply()
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('Review this draft first.')
    expect(api.createTeamMessage).not.toHaveBeenCalled()
  })

  it('retries an uncertain send unchanged with the same key after reopening', async () => {
    const api = installReplyAPI()
    api.createTeamMessage.mockRejectedValueOnce(new Error('Connection ended before confirmation'))
    const view = render(board())
    await openReply()
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'Only one committed reply.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your draft is saved')
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveAttribute('readonly')
    const first = api.createTeamMessage.mock.calls[0][1]
    view.unmount()
    render(board())
    await openReply()
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue(first.body)
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'An accidental changed retry' } })
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue(first.body)
    fireEvent.click(screen.getByRole('button', { name: 'Retry reply' }))
    expect(await screen.findByText('Reply sent to Studio.')).toBeVisible()
    expect(api.createTeamMessage).toHaveBeenCalledTimes(2)
    expect(api.createTeamMessage.mock.calls[1][1]).toEqual(first)
  })

  it('keeps the draft editable when the exact parent was deleted before Send', async () => {
    const api = installReplyAPI()
    render(board())
    await openReply()
    api.teamMessage.mockRejectedValueOnce(new Error('Original message was deleted'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'Keep this body.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Original message was deleted')
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('Keep this body.')
    expect(screen.getByRole('textbox', { name: 'Reply message' })).not.toHaveAttribute('readonly')
    expect(api.createTeamMessage).not.toHaveBeenCalled()
    expect(api.teamMessages).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['sender', (parent: TeamMessage) => ({ ...parent, sender: { ...parent.sender, id: 'server-different' } })],
    ['team', (parent: TeamMessage) => ({ ...parent, team_id: 'different-team' })],
    ['subject', (parent: TeamMessage) => ({ ...parent, title: 'Different subject' })],
    ['delivery', (parent: TeamMessage) => ({ ...parent, delivery: null })]
  ])('rejects a changed %s during exact-parent validation', async (_label, change) => {
    const parent = incoming()
    const api = installReplyAPI(parent)
    render(board())
    await openReply()
    api.teamMessage.mockResolvedValueOnce(change(parent))
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'Keep this body.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer available')
    expect(api.createTeamMessage).not.toHaveBeenCalled()
  })

  it('does not send after navigating away while parent validation is pending', async () => {
    const parent = incoming()
    const api = installReplyAPI(parent)
    const check = deferred<TeamMessage>()
    const view = render(board())
    await openReply()
    api.teamMessage.mockReturnValueOnce(check.promise)
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'Still a draft.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await waitFor(() => expect(api.teamMessage).toHaveBeenCalledTimes(2))
    view.unmount()
    await act(async () => check.resolve(parent))
    expect(api.createTeamMessage).not.toHaveBeenCalled()
    render(board())
    await openReply()
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('Still a draft.')
  })

  it('shares a pending send across remounts and clears only its confirmed draft', async () => {
    const api = installReplyAPI()
    const pending = deferred<TeamMessage>()
    api.createTeamMessage.mockReturnValueOnce(pending.promise)
    const view = render(board())
    await openReply()
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'One in-flight send.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    await waitFor(() => expect(api.createTeamMessage).toHaveBeenCalledTimes(1))
    const input = api.createTeamMessage.mock.calls[0][1]
    view.unmount()
    render(board())
    await openReply()
    fireEvent.click(screen.getByRole('button', { name: 'Retry reply' }))
    await waitFor(() => expect(api.teamMessage).toHaveBeenCalledTimes(4))
    expect(api.createTeamMessage).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(replyResult(input)))
    expect(await screen.findByText('Reply sent to Studio.')).toBeVisible()
    expect(api.createTeamMessage).toHaveBeenCalledTimes(1)
  })

  it('requires the negotiated subject capability but can reply to untitled mail on an older Hub', async () => {
    const api = installReplyAPI()
    const view = render(board({ capability }))
    expect(await openDetail()).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('cannot preserve the original subject')
    expect(api.createTeamMessage).not.toHaveBeenCalled()
    view.unmount()
    resetTeamNetworkSnapshotCacheForTests()
    const untitledApi = installReplyAPI(incoming({ title: null }))
    render(board({ capability }))
    await openReply()
    expect(screen.getByText('(No subject)', { exact: false })).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'Untitled reply.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(await screen.findByText('Reply sent to Studio.')).toBeVisible()
    expect(untitledApi.createTeamMessage.mock.calls[0][1]).not.toHaveProperty('title')
  })

  it.each([
    ['missing delivery', () => incoming({ delivery: null }), {}],
    ['human sender', () => incoming({ sender: { kind: 'human', id: 'person-1', display_name: 'Teammate' } }), {}],
    ['skill parent', () => incoming({ kind: 'skill', skill: { id: 'skill-1', slug: 'guide', version: 1 } }), {}],
    ['mixed recipient mail', () => incoming({ recipients: [message().recipients[0], { ...message().recipients[0], kind: 'human', id: 'person-1' }] }), {}],
    ['another server’s delivery', () => incoming({ delivery: { ...message().recipients[0], id: 'server-other' } }), {}],
    ['sent mail', () => incoming(), { initialMailboxBox: 'sent' as const }],
    ['self sender', () => incoming({ sender: { kind: 'server', id: 'server-local', display_name: 'Local' } }), {}],
    ['human identity', () => incoming(), { callerPostingKind: 'human' as const }],
    ['read-only identity', () => incoming(), { canWrite: false }]
  ])('does not offer Reply for %s', async (_label, parent, props) => {
    const detail = parent()
    const api = installReplyAPI(detail)
    render(board(props))
    fireEvent.click(await screen.findByRole('button', { name: /^Open / }))
    expect(await screen.findByText('rollout')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument()
    expect(api.createTeamMessage).not.toHaveBeenCalled()
  })

  it('keeps draft identities isolated across profiles and falls back to memory when storage is full', async () => {
    const api = installReplyAPI()
    const storage = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage quota exceeded') })
    const view = render(board({ draftIdentity: 'quota-test' }))
    await openReply()
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'Retained without storage.' } })
    view.unmount()
    const other = render(board({ draftIdentity: 'quota-test', scope: { ...scope, profileId: 'profile-other' } }))
    await openReply()
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('')
    other.unmount()
    storage.mockRestore()
    render(board({ draftIdentity: 'quota-test' }))
    await openReply()
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('Retained without storage.')
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: '' } })
    expect(api.createTeamMessage).not.toHaveBeenCalled()
  })

  it('does not revive a confirmed draft when persistent storage cannot remove it', async () => {
    const api = installReplyAPI()
    render(board({ draftIdentity: 'remove-failure-test' }))
    await openReply()
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply message' }), { target: { value: 'Confirmed reply.' } })
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(await screen.findByText('Reply sent to Studio.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('')
    expect(api.createTeamMessage).toHaveBeenCalledTimes(1)
  })

  it.each(['inbox', 'sent'] as const)('links the exact reply parent from %s without loading its body', async box => {
    const parent = incoming({ in_reply_to_message_id: 'original-message-17' })
    const api = installReplyAPI(parent)
    const opened = vi.fn()
    window.addEventListener('agentsdock:open-teamspace', opened)
    try {
      render(board({ initialMailboxBox: box }))
      fireEvent.click(await screen.findByRole('button', { name: /^Open / }))
      const link = await screen.findByRole('link', { name: 'Original message' })
      expect(parseTeamMessageLink(link.getAttribute('href')!)).toEqual({
        section: 'mail', teamId: 'team-1', messageId: 'original-message-17', serverIdentity: scope.serverIdentity,
        mailboxBox: box === 'sent' ? 'inbox' : 'sent'
      })
      expect(api.teamMessage).toHaveBeenCalledTimes(1)
      fireEvent.click(link)
      expect(opened).toHaveBeenCalledTimes(1)
      expect((opened.mock.calls[0][0] as CustomEvent).detail.messageId).toBe('original-message-17')
      expect(api.teamMessage).toHaveBeenCalledTimes(1)
      expect(api.createTeamMessage).not.toHaveBeenCalled()
    } finally { window.removeEventListener('agentsdock:open-teamspace', opened) }
  })
})

describe('Team Messages board', () => {
  it('keeps a readable untitled mail heading consistent through cards, loading, detail, and routing', async () => {
    const detail = message({ body: '# Review [the rollout](https://example.com/private)\n\nFull **context** remains here.' })
    const summary = messageSummary(detail, { preview: '# Review [the rollout](https://example.com/private)\nA shortened preview.' })
    const original = structuredClone({ detail, summary })
    const api = installAPI([summary], [detail])
    const pending = deferred<TeamMessage>()
    api.teamMessage.mockReturnValueOnce(pending.promise)
    const onRouteMessage = vi.fn()
    render(<TeamMessagesBoard section="mail" scope={scope} teamId="team-1" capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'Local' }]} canWrite
      routeTargets={[{ id: 'chat-1', label: 'Review', current: true }]} onRouteMessage={onRouteMessage} />)

    const card = await screen.findByRole('button', { name: 'Open Review the rollout' })
    expect(card.querySelector('strong')).toHaveTextContent('Review the rollout')
    expect(card.querySelector('strong')).toHaveAttribute('title', 'Review the rollout')
    expect(card.querySelector('small')).toHaveTextContent('Studio')
    expect(screen.getByRole('button', { name: 'Route Review the rollout to a chat' })).toBeVisible()
    expect(api.teamMessage).not.toHaveBeenCalled()
    fireEvent.click(card)
    expect(screen.getByRole('heading', { level: 1, name: 'Review the rollout' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Review the rollout' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Loading complete message')
    await act(async () => pending.resolve(detail))
    expect(within(screen.getByRole('region', { name: 'Review the rollout' }).querySelector('header')!).getByRole('heading', { level: 1, name: 'Review the rollout' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Review the rollout' })).toBeVisible()
    expect(screen.getByText('context')).toBeVisible()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Route Review the rollout to a chat' }))
    await user.click(screen.getByRole('menuitem', { name: /Review/ }))
    expect(onRouteMessage).toHaveBeenCalledWith(summary, 'chat-1')
    expect({ detail, summary }).toEqual(original)
  })

  it('renders explicit mail subjects literally without deriving or interpreting their markup', async () => {
    const title = '<img src="private.png"> **Authored subject**'
    const detail = message({ title })
    const api = installAPI([messageSummary(detail)], [detail])
    render(<TeamMessagesBoard section="mail" scope={scope} teamId="team-1" capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'Local' }]} canWrite />)
    const card = await screen.findByRole('button', { name: `Open ${title}` })
    expect(card.querySelector('strong')?.textContent).toBe(title)
    expect(card.querySelector('strong')).toHaveAttribute('title', title)
    expect(card.querySelector('img')).toBeNull()
    fireEvent.click(card)
    const heading = await screen.findByRole('heading', { name: title })
    expect(heading.textContent).toBe(title)
    expect(heading.childElementCount).toBe(0)
    expect(api.teamMessage).toHaveBeenCalledOnce()
  })

  it('opens an exact linked message absent from the loaded page without duplicate fetching', async () => {
    const detail = message({ id: 'message-off-page', destination: 'all_servers' })
    const api = installAPI([], [detail])
    const consumed = vi.fn()
    const props = { section: 'mail' as const, scope, teamId: 'team-1', capability,
      addresses: [{ kind: 'server' as const, id: 'server-local', label: 'TargetApp' }], canWrite: true,
      initialMailboxBox: 'sent' as const, mailboxRequestId: 3, onInitialMessageConsumed: consumed }
    const view = render(<TeamMessagesBoard {...props} initialMessageId={detail.id} />)
    expect(await screen.findByText('rollout')).toBeVisible()
    expect(screen.getByText('Team Mail · All servers')).toBeVisible()
    expect(screen.getByText('TargetApp · Available')).toBeVisible()
    expect(api.teamMessage).toHaveBeenCalledTimes(1)
    expect(api.teamMessage).toHaveBeenCalledWith(scope, 'team-1', detail.id)
    expect(api.recordTeamMessageReceipt).not.toHaveBeenCalled()
    expect(consumed).toHaveBeenCalledOnce()
    view.rerender(<TeamMessagesBoard {...props} initialMessageId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(api.teamMessage).toHaveBeenCalledTimes(1)
  })

  it('keeps failed detail loads unread and shows receipt recovery and routing in detail', async () => {
    const detail = message()
    const api = installAPI([messageSummary(detail)], [detail])
    api.teamMessage.mockRejectedValueOnce(new Error('Detail unavailable'))
    api.recordTeamMessageReceipt.mockRejectedValueOnce(new Error('Receipt unavailable'))
    const route = vi.fn()
    render(<TeamMessagesBoard section="mail" scope={scope} teamId="team-1" capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'Local' }]} canWrite
      routeTargets={[{ id: 'chat-1', label: 'Review', current: true }]} onRouteMessage={route} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Please review the rollout.' }))
    expect(await screen.findByText('Detail unavailable')).toBeVisible()
    expect(api.recordTeamMessageReceipt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Receipt unavailable')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Route Please review the rollout. to a chat' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText('Receipt unavailable')).not.toBeInTheDocument())
    expect(api.recordTeamMessageReceipt).toHaveBeenCalledTimes(2)
  })

  it('removes received mail from only the selected inbox and updates its unread snapshot', async () => {
    const detail = message()
    const api = installAPI([messageSummary(detail)], [detail])
    const dismissTeamMessage = vi.fn().mockImplementation(() => {
      api.teamMessages.mockResolvedValue({ box: 'inbox', address: { kind: 'server', id: 'server-local' }, messages: [], has_more: false, next_after_sequence: 7 })
      return Promise.resolve({ dismissed: true, message_id: detail.id, address: { kind: 'server', id: 'server-local' } })
    })
    Object.assign(window.agentsDock.teamHub, { dismissTeamMessage })
    const snapshot = vi.fn()
    render(<TeamMessagesBoard section="mail" scope={scope} teamId="team-1" capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'Local' }]} canWrite onUnreadSnapshot={snapshot} />)
    fireEvent.contextMenu((await screen.findByRole('button', { name: 'Open Please review the rollout.' })).closest('article')!)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from inbox' }))
    await waitFor(() => expect(dismissTeamMessage).toHaveBeenCalledWith(scope, expect.objectContaining({
      messageId: detail.id, addressKind: 'server', addressId: 'server-local'
    })))
    expect(await screen.findByText('Inbox is empty')).toBeVisible()
    expect(snapshot).toHaveBeenLastCalledWith(0, false)
    expect(api.recordTeamMessageReceipt).not.toHaveBeenCalled()
  })

  it('repaints cached Bulletin rows synchronously on remount while refreshing quietly', async () => {
    const cached = messageSummary(bulletinMessage({
      id: 'cached-bulletin',
      sequence: 11,
      body: 'Cached launch status',
      body_bytes: 20
    }), { preview: 'Cached launch status' })
    const api = installAPI([cached])
    const first = render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
      lifecycleCacheKey="exact-team-lifecycle"
    />)
    expect(await screen.findByText('Cached launch status')).toBeVisible()
    first.unmount()

    const refresh = deferred<TeamMessagePage>()
    api.teamMessages.mockImplementation(() => refresh.promise)
    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
      lifecycleCacheKey="exact-team-lifecycle"
    />)

    // No await: cached rows and the usable surface must survive unmount.
    expect(screen.getByText('Cached launch status')).toBeVisible()
    expect(screen.queryByText('Syncing current Bulletin posts…')).not.toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Post to Bulletin' })).toBeVisible()
    expect(api.teamMessages).toHaveBeenCalledTimes(2)
  })

  it('posts an image and video to Bulletin and previews the first image on its card', async () => {
    const imageFile: NativeFileRef = { path: '/tmp/launch.png', name: 'launch.png', size: 1_024, type: 'image/png' }
    const videoFile: NativeFileRef = { path: '/tmp/demo.mp4', name: 'demo.mp4', size: 4_096, type: 'video/mp4' }
    const imageAttachment = attachment({
      id: 'attachment-image',
      file_name: imageFile.name,
      media_type: imageFile.type!,
      byte_size: imageFile.size!,
      received_bytes: imageFile.size!
    })
    const videoAttachment = attachment({
      id: 'attachment-video',
      file_name: videoFile.name,
      media_type: videoFile.type!,
      byte_size: videoFile.size!,
      received_bytes: videoFile.size!
    })
    const api = installAPI([], [])
    const choose = vi.fn().mockResolvedValue([imageFile, videoFile])
    const declareTeamAttachment = vi.fn()
      .mockResolvedValueOnce({ attachment: { ...imageAttachment, message_id: null, state: 'uploading', received_bytes: 0, ready_at: null }, chunk_bytes: capability.attachments.chunk_bytes })
      .mockResolvedValueOnce({ attachment: { ...videoAttachment, message_id: null, state: 'uploading', received_bytes: 0, ready_at: null }, chunk_bytes: capability.attachments.chunk_bytes })
    const uploadTeamAttachment = vi.fn()
      .mockResolvedValueOnce({ ...imageAttachment, message_id: null })
      .mockResolvedValueOnce({ ...videoAttachment, message_id: null })
    const posted = message({
      id: 'message-rich',
      sequence: 9,
      body: 'Launch demo is ready.',
      body_bytes: 21,
      recipients: [{ kind: 'all', id: 'all', display_name: 'Everyone', state: 'available', delivered_at: null, read_at: null }],
      attachments: [
        { ...imageAttachment, message_id: 'message-rich' },
        { ...videoAttachment, message_id: 'message-rich' }
      ]
    })
    const createTeamMessage = vi.fn().mockResolvedValue(posted)
    api.teamMessage.mockResolvedValue(posted)
    Object.assign(window.agentsDock, { files: { choose } })
    Object.assign(window.agentsDock.teamHub, { declareTeamAttachment, uploadTeamAttachment, createTeamMessage })

    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
    />)

    expect(await screen.findByRole('form', { name: 'Post to Bulletin' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
    expect(await screen.findByText('launch.png')).toBeVisible()
    expect(screen.getByText('demo.mp4')).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Team bulletin' }), { target: { value: 'Launch demo is ready.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))

    await waitFor(() => expect(createTeamMessage).toHaveBeenCalledTimes(1))
    expect(declareTeamAttachment).toHaveBeenNthCalledWith(1, scope, {
      teamId: 'team-1', path: imageFile.path, fileName: imageFile.name, mediaType: imageFile.type,
      idempotencyKey: expect.any(String)
    })
    expect(uploadTeamAttachment).toHaveBeenNthCalledWith(1, scope, {
      teamId: 'team-1', attachmentId: imageAttachment.id, path: imageFile.path
    })
    expect(declareTeamAttachment).toHaveBeenNthCalledWith(2, scope, {
      teamId: 'team-1', path: videoFile.path, fileName: videoFile.name, mediaType: videoFile.type,
      idempotencyKey: expect.any(String)
    })
    expect(uploadTeamAttachment).toHaveBeenNthCalledWith(2, scope, {
      teamId: 'team-1', attachmentId: videoAttachment.id, path: videoFile.path
    })
    expect(createTeamMessage).toHaveBeenCalledWith(scope, {
      teamId: 'team-1',
      kind: 'message',
      body: 'Launch demo is ready.',
      bodyFormat: 'markdown',
      recipients: [{ kind: 'all' }],
      attachmentIds: ['attachment-image', 'attachment-video'],
      provenance: { via: 'desktop' },
      idempotencyKey: expect.any(String)
    })
    expect(await screen.findByLabelText('1 image, 1 video')).toBeVisible()
    expect(screen.getByRole('button', { name: /Launch demo is ready/i })).toBeVisible()
    expect(screen.getByText('launch.png')).toBeVisible()
    expect(screen.getByText('Image · +1 more')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Show image launch.png' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show video demo.mp4' })).not.toBeInTheDocument()
    expect(await screen.findByRole('img', { name: 'launch.png' })).toHaveAttribute(
      'src',
      'agentsdock-media://team/profile-1/team-1/attachment-image'
    )
    expect(api.cacheTeamAttachment).toHaveBeenCalledWith(scope, {
      teamId: 'team-1', attachmentId: 'attachment-image'
    })
    expect(screen.getByRole('textbox', { name: 'Team bulletin' })).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: /Launch demo is ready/i }))
    expect(await screen.findByRole('button', { name: 'Show image launch.png' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Show video demo.mp4' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Show image launch.png' }))
    expect(await screen.findByRole('img', { name: 'launch.png' })).toHaveAttribute(
      'src',
      'agentsdock-media://team/profile-1/team-1/attachment-image'
    )
    expect(api.teamMessages).toHaveBeenCalled()
  })

  it('keeps a growing rich post content-sized above legacy cards in a constrained feed', async () => {
    const screenshot = attachment({
      id: 'attachment-growing-image',
      file_name: 'full-rollout.png',
      media_type: 'image/png'
    })
    const video = attachment({
      id: 'attachment-growing-video',
      file_name: 'full-rollout.mp4',
      media_type: 'video/mp4'
    })
    const newest = message({
      id: 'message-growing',
      sequence: 50,
      body: 'Newest launch bulletin '.repeat(40),
      body_bytes: 920,
      recipients: [{ kind: 'all', id: 'all', display_name: 'Everyone', state: 'available', delivered_at: null, read_at: null }],
      attachments: [screenshot, video],
      created_at: '2026-09-05T20:00:00Z'
    })
    const legacyBulletinPosts: TeamNetworkBulletinPost[] = [1, 2, 3].map(index => ({
      id: `legacy-${index}`,
      sequence: 50 - index,
      author: { kind: 'server', id: `legacy-server-${index}`, display_name: `Legacy ${index}` },
      body_format: 'plain',
      body: `Legacy bulletin ${index}`,
      thread_root_post_id: null,
      reply_to_post_id: null,
      created_at: `2026-09-05T19:0${index}:00Z`
    }))
    const api = installAPI([messageSummary(newest, {
      preview: 'Newest launch bulletin '.repeat(20)
    })])
    const cachedImage = deferred<{ attachment: TeamAttachment; media_url: string }>()
    api.cacheTeamAttachment.mockImplementation((_scope, input: { attachmentId: string }) => (
      input.attachmentId === screenshot.id
        ? cachedImage.promise
        : Promise.resolve({ attachment: video, media_url: 'agentsdock-media://team/profile-1/team-1/attachment-growing-video' })
    ))
    const style = document.createElement('style')
    style.dataset.teamMessagesLayoutTest = 'true'
    style.textContent = teamMessagesStyles
    document.head.append(style)

    const view = render(<div style={{ height: 320, minHeight: 0, overflow: 'hidden' }}><TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite={false}
      legacyBulletinPosts={legacyBulletinPosts}
    /></div>)

    const stream = await waitFor(() => {
      const candidate = view.container.querySelector<HTMLElement>('.network-v2-feed-stream')
      expect(candidate).not.toBeNull()
      expect(candidate?.querySelectorAll(':scope > .network-v2-bulletin-card')).toHaveLength(4)
      return candidate!
    })
    expect(getComputedStyle(stream).gridAutoRows).toBe('max-content')
    const cards = [...stream.querySelectorAll<HTMLElement>(':scope > .network-v2-bulletin-card')]
    expect(cards[0]).toHaveTextContent('Newest launch bulletin')
    expect(cards.slice(1).map(card => card.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Legacy bulletin 1'),
      expect.stringContaining('Legacy bulletin 2'),
      expect.stringContaining('Legacy bulletin 3')
    ]))

    expect(screen.getByLabelText('1 image, 1 video')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Show image full-rollout.png' })).not.toBeInTheDocument()
    await waitFor(() => expect(api.cacheTeamAttachment).toHaveBeenCalledWith(scope, {
      teamId: 'team-1', attachmentId: screenshot.id
    }))
    await act(async () => cachedImage.resolve({
      attachment: screenshot,
      media_url: 'agentsdock-media://team/profile-1/team-1/attachment-growing-image'
    }))
    expect(await screen.findByRole('img', { name: 'full-rollout.png' })).toBeVisible()
    expect(getComputedStyle(stream).gridAutoRows).toBe('max-content')
    expect(stream.querySelectorAll(':scope > .network-v2-bulletin-card')).toHaveLength(4)
  })

  it('discards a delayed feed attachment selection after the Teamspace scope changes', async () => {
    const chosen = deferred<NativeFileRef[]>()
    installAPI([], [])
    Object.assign(window.agentsDock, { files: { choose: vi.fn(() => chosen.promise) } })
    const view = render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
    />)

    fireEvent.click(await screen.findByRole('button', { name: 'Attach files' }))
    view.rerender(<TeamMessagesBoard
      section="feed"
      scope={{ ...scope, profileId: 'profile-2', profileGeneration: 4, generation: 5 }}
      teamId="team-2"
      capability={capability}
      addresses={[]}
      canWrite
    />)
    await act(async () => chosen.resolve([{ path: '/tmp/stale.png', name: 'stale.png', size: 128, type: 'image/png' }]))

    expect(screen.queryByText('stale.png')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Attach files' })).not.toBeDisabled()
  })

  it('reuses the prepared upload and bulletin idempotency key after an ambiguous create failure', async () => {
    const file: NativeFileRef = { path: '/tmp/retry.png', name: 'retry.png', size: 1_024, type: 'image/png' }
    const uploaded = attachment({
      id: 'attachment-retry', file_name: file.name, media_type: file.type!,
      byte_size: file.size!, received_bytes: file.size!, message_id: null
    })
    installAPI([], [])
    Object.assign(window.agentsDock, { files: { choose: vi.fn().mockResolvedValue([file]) } })
    const declareTeamAttachment = vi.fn().mockResolvedValue({
      attachment: { ...uploaded, state: 'uploading', received_bytes: 0, ready_at: null },
      chunk_bytes: capability.attachments.chunk_bytes
    })
    const uploadTeamAttachment = vi.fn().mockResolvedValue(uploaded)
    const createTeamMessage = vi.fn()
      .mockRejectedValueOnce(new Error('Temporary Team Hub failure'))
      .mockResolvedValueOnce(message({
        id: 'message-retry', sequence: 10, body: 'Retry safely.', body_bytes: 13,
        recipients: [{ kind: 'all', id: 'all', display_name: 'Everyone', state: 'available', delivered_at: null, read_at: null }],
        attachments: [{ ...uploaded, message_id: 'message-retry' }]
      }))
    Object.assign(window.agentsDock.teamHub, { declareTeamAttachment, uploadTeamAttachment, createTeamMessage })

    const view = render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
    />)
    fireEvent.click(await screen.findByRole('button', { name: 'Attach files' }))
    await screen.findByText('retry.png')
    fireEvent.change(screen.getByRole('textbox', { name: 'Team bulletin' }), { target: { value: 'Retry safely.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary Team Hub failure')
    expect(screen.getByText(/Retry it unchanged to resolve safely/i)).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Team bulletin' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add files' })).toBeDisabled()
    const firstCreateKey = createTeamMessage.mock.calls[0][1].idempotencyKey

    // A retryable authenticated transport failure increments Team Hub's
    // runtime generation and temporarily unmounts this board. The ephemeral,
    // identity-scoped draft must survive that exact lifecycle boundary.
    view.unmount()
    render(<TeamMessagesBoard
      section="feed"
      scope={{ ...scope, generation: scope.generation + 1 }}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
    />)
    expect(await screen.findByRole('textbox', { name: 'Team bulletin' })).toHaveValue('Retry safely.')
    expect(screen.getByRole('textbox', { name: 'Team bulletin' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(createTeamMessage).toHaveBeenCalledTimes(2))

    expect(declareTeamAttachment).toHaveBeenCalledTimes(1)
    expect(uploadTeamAttachment).toHaveBeenCalledTimes(1)
    expect(createTeamMessage.mock.calls[1][1].idempotencyKey).toBe(firstCreateKey)
    expect(await screen.findByLabelText('1 image')).toBeVisible()
  })

  it('locks an in-flight bulletin before a Team Hub generation change', async () => {
    const firstCreate = deferred<TeamMessage>()
    const posted = message({
      id: 'message-generation-retry', sequence: 11, body: 'Generation-safe post.', body_bytes: 21,
      recipients: [{ kind: 'all', id: 'all', display_name: 'Everyone', state: 'available', delivered_at: null, read_at: null }]
    })
    installAPI([], [])
    const createTeamMessage = vi.fn()
      .mockImplementationOnce(() => firstCreate.promise)
      .mockResolvedValueOnce(posted)
    Object.assign(window.agentsDock.teamHub, { createTeamMessage })

    const view = render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
    />)
    fireEvent.change(await screen.findByRole('textbox', { name: 'Team bulletin' }), {
      target: { value: 'Generation-safe post.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(createTeamMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('textbox', { name: 'Team bulletin' })).toBeDisabled()

    view.rerender(<TeamMessagesBoard
      section="feed"
      scope={{ ...scope, generation: scope.generation + 1 }}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
    />)
    expect(await screen.findByText(/Retry it unchanged to resolve safely/i)).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Team bulletin' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(createTeamMessage).toHaveBeenCalledTimes(2))
    expect(createTeamMessage.mock.calls[1][1].idempotencyKey)
      .toBe(createTeamMessage.mock.calls[0][1].idempotencyKey)
    expect(await screen.findByText('Generation-safe post.')).toBeVisible()

    await act(async () => firstCreate.resolve(posted))
  })

  it('hides the rich feed composer from read-only members', async () => {
    installAPI([], [])
    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite={false}
    />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh bulletin' })).not.toBeDisabled())
    expect(screen.queryByRole('form', { name: 'Post to Bulletin' })).not.toBeInTheDocument()
  })

  it('keeps all-recipient skill records in Bulletin while applying deletion journal tombstones', async () => {
    const announcement = bulletinMessage({
      id: 'message-announcement', sequence: 20, body: 'Current announcement', body_bytes: 20
    })
    const skillMessage = bulletinMessage({
      id: 'message-skill', sequence: 21, kind: 'skill', title: 'Hidden skill',
      body: 'This belongs in Skills.', body_bytes: 22,
      skill: { id: 'skill-hidden', slug: 'hidden-skill', version: 1 }
    })
    const privateMessage = message({
      id: 'message-private', sequence: 22, title: 'Private operations note',
      body: 'This belongs only in Mail.', body_bytes: 26
    })
    const legacy: TeamNetworkBulletinPost = {
      id: 'legacy-deleted', sequence: 19,
      author: { kind: 'server', id: 'server-remote', display_name: 'Studio' },
      body_format: 'plain', body: 'Deleted legacy post', thread_root_post_id: null,
      reply_to_post_id: null, created_at: '2026-09-03T14:00:00Z'
    }
    installAPI([
      messageSummary(privateMessage),
      messageSummary(skillMessage, { preview: skillMessage.body }),
      messageSummary(announcement)
    ])
    const networkDeletions = vi.fn().mockResolvedValue({
      supported: true,
      page: {
        deletions: [
          { sequence: 1, kind: 'message', id: announcement.id, deleted_at: '2026-09-05T20:00:00Z' },
          { sequence: 2, kind: 'bulletin', id: legacy.id, deleted_at: '2026-09-05T20:00:01Z' }
        ],
        next_after_sequence: 2,
        has_more: false
      }
    })
    Object.assign(window.agentsDock.teamHub, { networkDeletions })

    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite={false}
      legacyBulletinPosts={[legacy]}
    />)

    await waitFor(() => expect(networkDeletions).toHaveBeenCalledWith(scope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    }))
    expect(screen.queryByText('Current announcement')).not.toBeInTheDocument()
    expect(screen.queryByText('Deleted legacy post')).not.toBeInTheDocument()
    expect(screen.getByText('Hidden skill')).toBeVisible()
    expect(screen.getByText('This belongs in Skills.')).toBeVisible()
    expect(screen.queryByText('No announcements yet')).not.toBeInTheDocument()
    expect(screen.queryByText('Private operations note')).not.toBeInTheDocument()
    expect(screen.queryByText('This belongs only in Mail.')).not.toBeInTheDocument()
  })

  it('does not offer message edit or delete actions for an owned versioned skill in Bulletin', async () => {
    const skillMessage = bulletinMessage({
      id: 'message-owned-skill',
      sequence: 23,
      kind: 'skill',
      title: 'Owned skill',
      body: 'Immutable skill version',
      sender: { kind: 'server', id: 'server-local', display_name: 'TargetApp' },
      skill: { id: 'skill-owned', slug: 'owned-skill', version: 1 },
      revision: { version: 1, versions_count: 1, edited_at: null }
    })
    installAPI([messageSummary(skillMessage, { preview: skillMessage.body, delivery: undefined })])

    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)

    const card = (await screen.findByText('Owned skill')).closest('.network-v2-bulletin-card') as HTMLElement
    fireEvent.contextMenu(card)

    expect(await screen.findByRole('menuitem', { name: 'Open Bulletin item' })).toBeVisible()
    expect(screen.queryByRole('menuitem', { name: 'Edit Bulletin item…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Delete Bulletin item…' })).not.toBeInTheDocument()
  })

  it.each(['server', 'human'] as const)('lets the exact %s poster delete a skill announcement on a supporting Hub', async kind => {
    const user = userEvent.setup()
    const own = bulletinMessage({
      id: 'message-owned-skill-delete', sequence: 24, kind: 'skill', title: 'Delete owned skill',
      body: 'Keep the library version',
      sender: { kind, id: `${kind}-poster`, display_name: 'Poster' },
      skill: { id: 'skill-owned-delete', slug: 'owned-delete', version: 1 }
    })
    installAPI([messageSummary(own, { preview: own.body, delivery: undefined })])
    const deleteTeamMessage = vi.fn().mockResolvedValue({ deleted: true, message_id: own.id })
    Object.assign(window.agentsDock.teamHub, { deleteTeamMessage })
    render(<TeamMessagesBoard
      section="feed" scope={scope} teamId="team-1"
      capability={{ ...capability, skill_announcement_deletion: true }}
      addresses={kind === 'server' ? [{ kind: 'server', id: 'server-poster', label: 'Poster' }] : []}
      principalId={kind === 'human' ? 'human-poster' : 'service_managed_server'}
      callerPostingKind={kind}
      canWrite
    />)
    const card = (await screen.findByText('Delete owned skill')).closest('.network-v2-bulletin-card') as HTMLElement
    fireEvent.contextMenu(card)
    expect(screen.queryByRole('menuitem', { name: 'Edit Bulletin item…' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('menuitem', { name: 'Delete Bulletin item…' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this Bulletin item?' })
    expect(within(dialog).getByText(/The underlying skill and its version history are kept/)).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Delete item' }))
    await waitFor(() => expect(deleteTeamMessage).toHaveBeenCalledWith(scope, {
      teamId: 'team-1', messageId: own.id, idempotencyKey: expect.any(String)
    }))
    await waitFor(() => expect(screen.queryByText('Delete owned skill')).not.toBeInTheDocument())
  })

  it('does not let a moderator delete another skill poster on a supporting Hub', async () => {
    const other = bulletinMessage({
      id: 'message-other-skill-delete', sequence: 24, kind: 'skill', title: 'Other poster skill',
      body: 'Another publisher',
      sender: { kind: 'server', id: 'server-other', display_name: 'Same display name' },
      skill: { id: 'skill-other-delete', slug: 'other-delete', version: 1 }
    })
    installAPI([messageSummary(other, { preview: other.body, delivery: undefined })])
    render(<TeamMessagesBoard
      section="feed" scope={scope} teamId="team-1"
      capability={{ ...capability, skill_announcement_deletion: true }}
      addresses={[{ kind: 'server', id: 'server-poster', label: 'Same display name' }]}
      principalId="service_managed_server" callerPostingKind="server" canWrite canManageMessages
    />)
    const card = (await screen.findByText('Other poster skill')).closest('.network-v2-bulletin-card') as HTMLElement
    fireEvent.contextMenu(card)
    expect(await screen.findByRole('menuitem', { name: 'Open Bulletin item' })).toBeVisible()
    expect(screen.queryByRole('menuitem', { name: 'Delete Bulletin item…' })).not.toBeInTheDocument()
  })

  it.each([
    ['server', 'human', true], ['human', 'server', true],
    ['server', null, true], ['human', null, true],
    ['server', 'server', false], ['human', 'human', false]
  ] as const)('hides skill deletion for author=%s caller=%s canWrite=%s', async (authorKind, callerPostingKind, canWrite) => {
    const own = bulletinMessage({
      id: 'message-skill-auth-gate', sequence: 24, kind: 'skill', title: 'Guarded skill',
      body: 'Exact publishing identity required',
      sender: { kind: authorKind, id: 'exact-poster-id', display_name: 'Poster' },
      skill: { id: 'skill-auth-gate', slug: 'auth-gate', version: 1 }
    })
    installAPI([messageSummary(own, { preview: own.body, delivery: undefined })])
    render(<TeamMessagesBoard
      section="feed" scope={scope} teamId="team-1"
      capability={{ ...capability, skill_announcement_deletion: true }}
      addresses={[{ kind: 'server', id: 'exact-poster-id', label: 'Poster' }]}
      principalId="exact-poster-id" callerPostingKind={callerPostingKind}
      canWrite={canWrite} canManageMessages
    />)
    const card = (await screen.findByText('Guarded skill')).closest('.network-v2-bulletin-card') as HTMLElement
    fireEvent.contextMenu(card)
    expect(await screen.findByRole('menuitem', { name: 'Open Bulletin item' })).toBeVisible()
    expect(screen.queryByRole('menuitem', { name: 'Delete Bulletin item…' })).not.toBeInTheDocument()
  })

  it('routes the exact Bulletin message to the chosen chat without opening it', async () => {
    const user = userEvent.setup()
    const bulletin = bulletinMessage({
      id: 'message-bulletin-route',
      sequence: 24,
      title: 'Bulletin handoff',
      body: 'Route this announcement.'
    })
    const summary = messageSummary(bulletin, { preview: bulletin.body, delivery: undefined })
    const api = installAPI([summary], [bulletin])
    const onRouteMessage = vi.fn()

    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite={false}
      routeTargets={[
        { id: 'chat-current', label: 'Current rollout', current: true },
        { id: 'chat-review', label: 'Review chat', current: false }
      ]}
      onRouteMessage={onRouteMessage}
    />)

    const route = await screen.findByRole('button', { name: 'Route Bulletin handoff to a chat' })
    await user.click(route)
    const routeMenu = await screen.findByRole('menu')
    expect(within(routeMenu).getByText('Open Bulletin item in chat')).toBeVisible()
    expect(within(routeMenu).getByRole('menuitem', { name: /Current rollout.*Current chat/ })).toBeVisible()
    await user.click(within(routeMenu).getByRole('menuitem', { name: 'Review chat' }))

    expect(onRouteMessage).toHaveBeenCalledOnce()
    expect(onRouteMessage).toHaveBeenCalledWith(summary, 'chat-review')
    expect(onRouteMessage.mock.calls[0]?.[0]).toBe(summary)
    expect(api.teamMessage).not.toHaveBeenCalled()
  })

  it('keeps an all-recipient skill in Bulletin while catching up the following page', async () => {
    const hiddenSkill = bulletinMessage({
      id: 'message-skill-page', sequence: 40, kind: 'skill', title: 'Only in Skills',
      body: 'Skill body', skill: { id: 'skill-page', slug: 'only-skills', version: 1 }
    })
    const announcement = bulletinMessage({
      id: 'message-next-announcement', sequence: 41, title: 'Next announcement',
      body: 'Visible after the filtered page.'
    })
    const teamMessages = vi.fn().mockImplementation((_scope, query: { afterSequence?: number }) => Promise.resolve(
      query.afterSequence === 40
        ? {
            box: 'feed', address: null,
            messages: [messageSummary(announcement, { preview: announcement.body })],
            next_after_sequence: 41, has_more: false
          }
        : {
            box: 'feed', address: null,
            messages: [messageSummary(hiddenSkill, { preview: hiddenSkill.body })],
            next_after_sequence: 40, has_more: true
          }
    ))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { teamHub: { teamMessages } } as unknown as AgentsDockAPI
    })

    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite={false}
    />)

    expect(await screen.findByText('Only in Skills')).toBeVisible()
    expect(await screen.findByText('Visible after the filtered page.')).toBeVisible()
    expect(teamMessages).toHaveBeenCalledTimes(2)
    expect(teamMessages).toHaveBeenLastCalledWith(scope, {
      teamId: 'team-1', box: 'feed', afterSequence: 40, limit: 25
    })
    expect(screen.getByText('Only in Skills')).toBeVisible()
    expect(screen.queryByText('No announcements yet')).not.toBeInTheDocument()
  })

  it('offers Bulletin deletion only for owned authors, traps focus, and removes after success', async () => {
    const user = userEvent.setup()
    const own = bulletinMessage({
      id: 'message-own', sequence: 30, body: 'Owned announcement', body_bytes: 18,
      sender: { kind: 'server', id: 'server-local', display_name: 'TargetApp' }
    })
    const remote = bulletinMessage({
      id: 'message-remote', sequence: 29, body: 'Remote announcement', body_bytes: 19,
      sender: { kind: 'server', id: 'server-remote', display_name: 'Studio' }
    })
    installAPI([
      messageSummary(own, { preview: 'Owned announcement' }),
      messageSummary(remote, { preview: 'Remote announcement' })
    ])
    const deleted = deferred<{ deleted: true; message_id: string }>()
    const deleteTeamMessage = vi.fn(() => deleted.promise)
    const localDelete = vi.fn()
    window.addEventListener('agentsdock:team-network-message-deleted', localDelete, { once: true })
    Object.assign(window.agentsDock.teamHub, { deleteTeamMessage })

    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite={false}
    />)

    const ownedCard = (await screen.findByText('Owned announcement')).closest('.network-v2-bulletin-card') as HTMLElement
    const remoteCard = screen.getByText('Remote announcement').closest('.network-v2-bulletin-card') as HTMLElement
    expect(screen.queryByRole('form', { name: 'Post to Bulletin' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Bulletin item from Studio' })).not.toBeInTheDocument()
    fireEvent.contextMenu(remoteCard)
    expect(await screen.findByRole('menuitem', { name: 'Open Bulletin item' })).toBeVisible()
    expect(screen.queryByRole('menuitem', { name: 'Delete Bulletin item…' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    fireEvent.contextMenu(ownedCard)
    await user.click(await screen.findByRole('menuitem', { name: 'Delete Bulletin item…' }))
    let dialog = await screen.findByRole('alertdialog', { name: 'Delete this Bulletin item?' })
    let cancel = within(dialog).getByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(cancel).toHaveFocus())
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    await user.click(cancel)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())

    fireEvent.contextMenu(ownedCard)
    await user.click(await screen.findByRole('menuitem', { name: 'Delete Bulletin item…' }))
    dialog = await screen.findByRole('alertdialog', { name: 'Delete this Bulletin item?' })
    cancel = within(dialog).getByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(cancel).toHaveFocus())
    const confirm = within(dialog).getByRole('button', { name: 'Delete item' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(deleteTeamMessage).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Owned announcement')).toBeVisible()
    expect(deleteTeamMessage).toHaveBeenCalledWith(scope, {
      teamId: 'team-1', messageId: own.id, idempotencyKey: expect.any(String)
    })

    await act(async () => deleted.resolve({ deleted: true, message_id: own.id }))
    await waitFor(() => expect(screen.queryByText('Owned announcement')).not.toBeInTheDocument())
    expect((localDelete.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      scopeKey: JSON.stringify(scope),
      profileId: scope.profileId,
      profileGeneration: scope.profileGeneration,
      serverIdentity: scope.serverIdentity,
      teamId: 'team-1',
      messageId: own.id
    })
    expect(screen.getByText('Remote announcement')).toBeVisible()
    expect(screen.getByRole('region', { name: 'Team Bulletin' })).toHaveFocus()
  })

  it('probes an unsupported deletion journal once per mounted scope and hides every delete control', async () => {
    vi.useFakeTimers()
    const own = bulletinMessage({
      id: 'message-old-server', sequence: 31, body: 'Visible on an old server.',
      sender: { kind: 'server', id: 'server-local', display_name: 'TargetApp' }
    })
    installAPI([messageSummary(own, { preview: own.body })], [own])
    const networkDeletions = vi.fn().mockResolvedValue({ supported: false, reason: 'unsupported' })
    Object.assign(window.agentsDock.teamHub, { networkDeletions })

    const first = render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)

    await vi.waitFor(() => expect(networkDeletions).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(screen.getByText('Visible on an old server.')).toBeVisible())
    const card = screen.getByText('Visible on an old server.').closest('.network-v2-bulletin-card') as HTMLElement
    fireEvent.contextMenu(card)
    expect(screen.getByRole('menuitem', { name: 'Open Bulletin item' })).toBeVisible()
    expect(screen.queryByRole('menuitem', { name: 'Delete Bulletin item…' })).not.toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(networkDeletions).toHaveBeenCalledTimes(1)

    first.unmount()
    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)
    await vi.waitFor(() => expect(networkDeletions).toHaveBeenCalledTimes(2))
  })

  it('closes an open delete dialog when a manual refresh finds its tombstone', async () => {
    vi.useFakeTimers()
    const own = bulletinMessage({
      id: 'message-remotely-deleted', sequence: 32, body: 'Delete race announcement.',
      sender: { kind: 'server', id: 'server-local', display_name: 'TargetApp' }
    })
    installAPI([messageSummary(own, { preview: own.body })])
    const tombstone = deferred<{
      supported: true
      page: {
        deletions: Array<{ sequence: number; kind: 'message'; id: string; deleted_at: string }>
        next_after_sequence: number
        has_more: false
      }
    }>()
    const networkDeletions = vi.fn()
      .mockResolvedValueOnce({ supported: true, page: { deletions: [], next_after_sequence: 0, has_more: false } })
      .mockImplementationOnce(() => tombstone.promise)
    Object.assign(window.agentsDock.teamHub, { networkDeletions })

    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)

    await vi.waitFor(() => expect(screen.getByText('Delete race announcement.')).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh bulletin' }))
    const card = screen.getByText('Delete race announcement.').closest('.network-v2-bulletin-card') as HTMLElement
    fireEvent.contextMenu(card)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Bulletin item…' }))
    expect(screen.getByRole('alertdialog')).toBeVisible()
    await vi.waitFor(() => expect(networkDeletions).toHaveBeenCalledTimes(2))
    await act(async () => tombstone.resolve({
      supported: true,
      page: {
        deletions: [{
          sequence: 1,
          kind: 'message',
          id: own.id,
          deleted_at: '2026-09-05T20:00:00Z'
        }],
        next_after_sequence: 1,
        has_more: false
      }
    }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Delete race announcement.')).not.toBeInTheDocument()
  })

  it('ignores a stale journal completion after the Team Hub scope changes', async () => {
    const own = bulletinMessage({
      id: 'message-new-lifecycle', sequence: 33, body: 'Keep in the new lifecycle.',
      sender: { kind: 'server', id: 'server-local', display_name: 'TargetApp' }
    })
    installAPI([messageSummary(own, { preview: own.body })])
    const stale = deferred<{
      supported: true
      page: {
        deletions: Array<{ sequence: number; kind: 'message'; id: string; deleted_at: string }>
        next_after_sequence: number
        has_more: false
      }
    }>()
    const nextScope = { ...scope, generation: scope.generation + 1 }
    const networkDeletions = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue({
        supported: true,
        page: { deletions: [], next_after_sequence: 0, has_more: false }
      })
    Object.assign(window.agentsDock.teamHub, { networkDeletions })
    const view = render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)
    expect(await screen.findByText('Keep in the new lifecycle.')).toBeVisible()

    view.rerender(<TeamMessagesBoard
      section="feed"
      scope={nextScope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)
    await waitFor(() => expect(networkDeletions).toHaveBeenCalledWith(nextScope, {
      teamId: 'team-1', afterSequence: 0, limit: 25
    }))
    const card = (await screen.findByText('Keep in the new lifecycle.')).closest('.network-v2-bulletin-card') as HTMLElement
    fireEvent.contextMenu(card)
    expect(await screen.findByRole('menuitem', { name: 'Delete Bulletin item…' })).toBeVisible()
    fireEvent.keyDown(document, { key: 'Escape' })

    await act(async () => stale.resolve({
      supported: true,
      page: {
        deletions: [{
          sequence: 1,
          kind: 'message',
          id: own.id,
          deleted_at: '2026-09-05T20:00:00Z'
        }],
        next_after_sequence: 1,
        has_more: false
      }
    }))
    expect(screen.getByText('Keep in the new lifecycle.')).toBeVisible()
  })

  it('lets only the poster edit a versioned Bulletin item from its context menu', async () => {
    const original = bulletinMessage({
      id: 'message-editable',
      sequence: 89,
      body: 'Original announcement',
      body_bytes: 21,
      sender: { kind: 'server', id: 'server-local', display_name: 'TargetApp' },
      revision: { version: 1, versions_count: 1, edited_at: null }
    })
    const revised = bulletinMessage({
      ...original,
      body: 'Revised announcement',
      body_bytes: 20,
      revision: { version: 2, versions_count: 2, edited_at: '2026-09-06T19:30:00Z' }
    })
    installAPI([messageSummary(original, { preview: original.body, delivery: undefined })], [original])
    const reviseTeamMessage = vi.fn().mockRejectedValueOnce(new Error('Response interrupted')).mockResolvedValue(revised)
    Object.assign(window.agentsDock.teamHub, { reviseTeamMessage })

    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)

    const card = (await screen.findByText('Original announcement')).closest('.network-v2-bulletin-card') as HTMLElement
    fireEvent.contextMenu(card)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit Bulletin item…' }))
    const editor = await screen.findByRole('textbox', { name: 'Bulletin message' })
    fireEvent.change(editor, { target: { value: 'Revised announcement' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save v2' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry save' }))
    await waitFor(() => expect(reviseTeamMessage).toHaveBeenCalledTimes(2))
    expect(reviseTeamMessage.mock.calls[1]?.[1].idempotencyKey).toBe(reviseTeamMessage.mock.calls[0]?.[1].idempotencyKey)

    await waitFor(() => expect(reviseTeamMessage).toHaveBeenCalledWith(scope, expect.objectContaining({
      teamId: 'team-1',
      messageId: original.id,
      body: 'Revised announcement',
      expectedVersion: 1
    })))
    expect(await screen.findByText('Revised announcement')).toBeVisible()
    expect(screen.getByText('Edited · v2')).toBeVisible()
  })

  it('lets a manager delete any Bulletin author while keeping one action per card', async () => {
    const remote = bulletinMessage({
      id: 'message-managed', sequence: 31, body: 'Managed announcement', body_bytes: 20,
      sender: { kind: 'human', id: 'human-other', display_name: 'Pat' }
    })
    installAPI([messageSummary(remote, { preview: 'Managed announcement' })])

    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
      canManageMessages
    />)

    const card = (await screen.findByText('Managed announcement')).closest('.network-v2-bulletin-card') as HTMLElement
    expect(within(card).getAllByRole('button')).toHaveLength(1)
    fireEvent.contextMenu(card)
    expect(await screen.findByRole('menuitem', { name: 'Delete Bulletin item…' })).toBeVisible()
  })

  it('discards a delayed skill attachment selection after the Teamspace scope changes', async () => {
    const chosen = deferred<NativeFileRef[]>()
    const skill = installEditableSkillAPI(() => chosen.promise)
    const view = render(<TeamMessagesBoard
      section="skills"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
    />)

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(skill.title) }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose attachments' }))

    view.rerender(<TeamMessagesBoard
      section="skills"
      scope={{ ...scope, profileId: 'profile-2', profileGeneration: 4, generation: 5 }}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
    />)
    await act(async () => chosen.resolve([{ path: '/tmp/stale.txt', name: 'stale.txt' }]))

    expect(screen.queryByText('stale.txt')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('contains a delayed skill attachment picker rejection after unmount', async () => {
    const chosen = deferred<NativeFileRef[]>()
    const skill = installEditableSkillAPI(() => chosen.promise)
    const view = render(<TeamMessagesBoard
      section="skills"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
    />)

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(skill.title) }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose attachments' }))
    view.unmount()
    await act(async () => chosen.reject(new Error('Picker closed during teardown')))
  })

  it('opens a message without caching attachments and loads each preview only after its explicit action', async () => {
    const video = attachment({ media_type: 'Video/MP4' })
    const screenshot = attachment({
      id: 'attachment-image',
      file_name: 'result.png',
      media_type: 'Image/PNG'
    })
    const markdownBody = '# Recovery runbook\n\nUse **safe mode**.'
    const markdownBytes = new TextEncoder().encode(markdownBody).byteLength
    const markdown = attachment({
      id: 'attachment-markdown',
      file_name: 'runbook.md',
      media_type: 'text/markdown',
      byte_size: markdownBytes,
      received_bytes: markdownBytes
    })
    const detail = message({
      title: 'Deployment walkthrough',
      recipients: [{ kind: 'all', id: 'all', display_name: 'Everyone', state: 'available', delivered_at: null, read_at: null }],
      attachments: [video, screenshot, markdown],
    })
    const api = installAPI([messageSummary(detail, { attachments: [], delivery: undefined })], [detail])
    const rendererFetch = vi.fn()
    vi.stubGlobal('fetch', rendererFetch)

    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
    />)

    fireEvent.click(await screen.findByRole('button', { name: /Deployment walkthrough/ }))

    expect(screen.queryByRole('button', { name: 'Load attachment walkthrough.mp4' })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Show video walkthrough.mp4' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Show image result.png' })).toBeVisible()
    expect(api.teamMessage).toHaveBeenCalledWith(scope, 'team-1', 'message-1')
    expect(api.cacheTeamAttachment).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('walkthrough.mp4')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Recovery runbook' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show video walkthrough.mp4' }))
    const player = await screen.findByLabelText('walkthrough.mp4')
    expect(player).toHaveAttribute('src', 'agentsdock-media://team/profile-1/team-1/attachment-1')

    fireEvent.click(screen.getByRole('button', { name: 'Show image result.png' }))
    const image = await screen.findByRole('img', { name: 'result.png' })
    expect(image).toHaveAttribute('src', 'agentsdock-media://team/profile-1/team-1/attachment-image')

    fireEvent.click(screen.getByRole('button', { name: 'Load attachment runbook.md' }))
    expect(await screen.findByRole('heading', { name: 'Recovery runbook' })).toBeVisible()
    expect(api.cacheTeamAttachment).toHaveBeenCalledWith(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1'
    })
    expect(api.cacheTeamAttachment).toHaveBeenCalledWith(scope, {
      teamId: 'team-1', attachmentId: 'attachment-image'
    })
    expect(api.cacheTeamAttachment).toHaveBeenCalledWith(scope, {
      teamId: 'team-1', attachmentId: 'attachment-markdown', previewBytes: 512 * 1024
    })
    expect(rendererFetch).not.toHaveBeenCalled()
  })

  it('opens a skill without caching its attachments until the user loads one', async () => {
    const runbook = attachment({
      id: 'skill-attachment',
      message_id: 'skill-message-1',
      file_name: 'recovery.txt',
      media_type: 'text/plain',
      byte_size: 13,
      received_bytes: 13
    })
    const skill: TeamSkillDetails = {
      id: 'skill-1',
      team_id: 'team-1',
      slug: 'recovery',
      title: 'Recovery guide',
      summary: 'Recover safely',
      tags: ['operations'],
      version: 1,
      versions_count: 1,
      pinned: false,
      pinned_at: null,
      archived: false,
      archived_at: null,
      author: { kind: 'server', id: 'server-remote', display_name: 'Studio' },
      body_bytes: 16,
      current: {
        version: 1,
        message_id: 'skill-message-1',
        change_note: 'Initial version',
        created_at: '2026-09-03T15:00:00Z'
      },
      created_at: '2026-09-03T15:00:00Z',
      updated_at: '2026-09-03T15:00:00Z',
      permissions: { edit: false, manage: false },
      body_format: 'markdown',
      body: '# Recovery guide',
      attachments: [runbook]
    }
    const skillSummary: TeamSkill = skill
    const api = installAPI([], [])
    Object.assign(window.agentsDock.teamHub, {
      teamSkills: vi.fn().mockResolvedValue({ skills: [skillSummary] }),
      teamSkill: vi.fn().mockResolvedValue(skill),
      teamSkillVersions: vi.fn().mockResolvedValue({ skill_id: skill.id, versions: [{
        team_id: skill.team_id,
        skill_id: skill.id,
        version: 1,
        message_id: skill.current.message_id,
        title: skill.title,
        summary: skill.summary,
        tags: skill.tags,
        change_note: skill.current.change_note,
        author: skill.author,
        body_bytes: skill.body_bytes,
        attachments: [runbook],
        created_at: skill.created_at
      }] })
    })
    api.cacheTeamAttachment.mockResolvedValue({
      attachment: runbook,
      media_url: 'agentsdock-media://team/profile-1/team-1/skill-attachment',
      text_preview: { text: 'Recovery text', byte_size: 13, truncated: false }
    })
    const rendererFetch = vi.fn()
    vi.stubGlobal('fetch', rendererFetch)

    render(<TeamMessagesBoard
      section="skills"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite={false}
    />)

    fireEvent.click(await screen.findByRole('button', { name: /Recovery guide/ }))
    expect(await screen.findByRole('button', { name: 'Load attachment recovery.txt' })).toBeVisible()
    expect(api.cacheTeamAttachment).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Load attachment recovery.txt' }))
    expect(await screen.findByText('Recovery text', {}, { timeout: 5_000 })).toBeVisible()
    expect(api.cacheTeamAttachment).toHaveBeenCalledTimes(1)
    expect(api.cacheTeamAttachment).toHaveBeenCalledWith(scope, {
      teamId: 'team-1', attachmentId: 'skill-attachment', previewBytes: 512 * 1024
    })
    expect(rendererFetch).not.toHaveBeenCalled()
  })

  it('marks opened inbox mail read and scopes Sent correctly', async () => {
    const detail = message()
    const api = installAPI([messageSummary(detail)], [detail])
    const readEvents: CustomEvent[] = []
    const onRead = (event: Event) => readEvents.push(event as CustomEvent)
    window.addEventListener('agentsdock:team-network-mail-read', onRead)

    render(<TeamMessagesBoard
      section="mail"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)

    const card = await screen.findByRole('button', { name: 'Open Please review the rollout.' })
    expect(card.closest('article')).toHaveClass('unread')
    fireEvent.click(card)
    expect(await screen.findByText('rollout')).toBeVisible()
    await waitFor(() => expect(api.recordTeamMessageReceipt).toHaveBeenCalledWith(scope, {
      teamId: 'team-1',
      messageId: detail.id,
      state: 'read',
      addressKind: 'server',
      addressId: 'server-local',
      idempotencyKey: expect.any(String)
    }))
    await waitFor(() => expect(readEvents.at(-1)?.detail).toEqual({
      messageId: detail.id,
      teamId: 'team-1',
      addressKind: 'server',
      addressId: 'server-local'
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText(/^To TargetApp/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open Please review the rollout.' }).closest('article')).not.toHaveClass('unread')
    fireEvent.click(screen.getByRole('button', { name: 'Sent' }))
    await waitFor(() => expect(api.teamMessages).toHaveBeenCalledWith(scope, {
      teamId: 'team-1',
      box: 'sent',
      limit: 25
    }))
    window.removeEventListener('agentsdock:team-network-mail-read', onRead)
  })

  it('marks unread mail read from the right-click menu without opening it', async () => {
    const user = userEvent.setup()
    const detail = message()
    const api = installAPI([messageSummary(detail)], [detail])

    render(<TeamMessagesBoard
      section="mail"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)

    const card = await screen.findByRole('button', { name: 'Open Please review the rollout.' })
    expect(card.closest('article')).toHaveClass('unread')
    fireEvent.contextMenu(card)
    await user.click(await screen.findByRole('menuitem', { name: 'Mark as read' }))

    await waitFor(() => expect(api.recordTeamMessageReceipt).toHaveBeenCalledWith(scope, {
      teamId: 'team-1',
      messageId: detail.id,
      state: 'read',
      addressKind: 'server',
      addressId: 'server-local',
      idempotencyKey: expect.any(String)
    }))
    await waitFor(() => expect(card.closest('article')).not.toHaveClass('unread'))
    expect(api.teamMessage).not.toHaveBeenCalled()
  })

  it('offers a Route chat picker without processing or opening mail itself', async () => {
    const user = userEvent.setup()
    const note = message({ id: 'message-ask', title: 'Review request' })
    const summary = messageSummary(note)
    const api = installAPI([summary], [note])
    const onRouteMessage = vi.fn()

    render(<TeamMessagesBoard
      section="mail"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
      routeTargets={[
        { id: 'chat-current', label: 'Current rollout', current: true },
        { id: 'chat-review', label: 'Review chat', current: false }
      ]}
      onRouteMessage={onRouteMessage}
    />)

    expect(await screen.findByRole('button', { name: 'Route Review request to a chat' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /process unread/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Route Review request to a chat' }))
    const routeMenu = await screen.findByRole('menu')
    expect(within(routeMenu).getByText('Open mail in chat')).toBeVisible()
    expect(within(routeMenu).getByRole('menuitem', { name: /Current rollout.*Current chat/ })).toBeVisible()
    await user.click(within(routeMenu).getByRole('menuitem', { name: 'Review chat' }))
    expect(onRouteMessage).toHaveBeenCalledOnce()
    expect(onRouteMessage).toHaveBeenCalledWith(summary, 'chat-review')
    expect(api.teamMessage).not.toHaveBeenCalled()
    expect(api.recordTeamMessageReceipt).not.toHaveBeenCalled()
  })

  it('deletes owned Mail from full detail and returns to the updated mailbox', async () => {
    const own = message({
      id: 'message-mail-own', sequence: 40, title: 'Private update', body: 'Private update body.', body_bytes: 20,
      sender: { kind: 'server', id: 'server-local', display_name: 'TargetApp' }
    })
    const api = installAPI([messageSummary(own)], [own])
    const deleted = deferred<{ deleted: true; message_id: string }>()
    const deleteTeamMessage = vi.fn(() => deleted.promise)
    Object.assign(window.agentsDock.teamHub, { deleteTeamMessage })

    render(<TeamMessagesBoard
      section="mail"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)

    expect(await screen.findByText('Open a message to mark it read, or route it to a chat.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Open Private update' }))
    expect(await screen.findByText('Private update body.')).toBeVisible()
    expect(api.teamMessage).toHaveBeenCalledWith(scope, 'team-1', own.id)

    fireEvent.click(screen.getByRole('button', { name: 'Delete for everyone' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete for everyone?' })
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    const confirm = within(dialog).getByRole('button', { name: 'Delete for everyone' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(deleteTeamMessage).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Private update body.')).toBeVisible()

    await act(async () => deleted.resolve({ deleted: true, message_id: own.id }))
    expect(await screen.findByText('Inbox is empty')).toBeVisible()
    expect(screen.queryByText('Private update body.')).not.toBeInTheDocument()
  })

  it('keeps deletion for owned Mail in the right-click menu instead of the card face', async () => {
    const user = userEvent.setup()
    const own = message({
      id: 'message-mail-context', sequence: 41, title: 'Context-delete update', body: 'Delete from its card.', body_bytes: 21,
      sender: { kind: 'server', id: 'server-local', display_name: 'TargetApp' }
    })
    const api = installAPI([messageSummary(own)], [own])
    const deleteTeamMessage = vi.fn().mockResolvedValue({ deleted: true, message_id: own.id })
    Object.assign(window.agentsDock.teamHub, { deleteTeamMessage })

    render(<TeamMessagesBoard
      section="mail"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)

    const card = await screen.findByRole('button', { name: 'Open Context-delete update' })
    expect(screen.queryByRole('button', { name: 'Delete Context-delete update' })).not.toBeInTheDocument()
    await waitFor(() => expect(card.closest('article')).toHaveAttribute('data-state', 'closed'))
    fireEvent.contextMenu(card)
    expect(await screen.findByRole('menuitem', { name: 'Open message' })).toBeVisible()
    await user.click(screen.getByRole('menuitem', { name: 'Delete for everyone…' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete for everyone?' })
    expect(deleteTeamMessage).not.toHaveBeenCalled()
    expect(within(dialog).getByText('Remove this message for everyone?')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Delete for everyone' }))

    await waitFor(() => expect(deleteTeamMessage).toHaveBeenCalledWith(scope, {
      teamId: 'team-1',
      messageId: own.id,
      idempotencyKey: expect.any(String)
    }))
    expect(await screen.findByText('Inbox is empty')).toBeVisible()
    expect(screen.queryByText('Context-delete update')).not.toBeInTheDocument()
    expect(api.teamMessage).not.toHaveBeenCalled()
  })

  it('does not expose Mail deletion for a message authored by another member', async () => {
    const remote = message({ title: 'Remote private note' })
    const api = installAPI([messageSummary(remote)], [remote])

    render(<TeamMessagesBoard
      section="mail"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)

    expect(await screen.findByRole('button', { name: 'Open Remote private note' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Delete Remote private note' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Remote private note' }))
    await waitFor(() => expect(api.teamMessage).toHaveBeenCalledWith(scope, 'team-1', remote.id))
    expect(await screen.findByText('rollout')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Delete for everyone' })).not.toBeInTheDocument()
  })

  it('hides Mail deletion for an owned message when the journal is unsupported', async () => {
    const own = message({
      id: 'message-mail-old-server',
      title: 'Owned old-server note',
      sender: { kind: 'server', id: 'server-local', display_name: 'TargetApp' }
    })
    installAPI([messageSummary(own)], [own])
    const networkDeletions = vi.fn().mockResolvedValue({ supported: false, reason: 'unsupported' })
    Object.assign(window.agentsDock.teamHub, { networkDeletions })

    render(<TeamMessagesBoard
      section="mail"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)

    expect(await screen.findByRole('button', { name: 'Open Owned old-server note' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Delete Owned old-server note' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Owned old-server note' }))
    expect(await screen.findByText('rollout')).toBeVisible()
    await waitFor(() => expect(networkDeletions).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Delete for everyone' })).not.toBeInTheDocument()
  })

  it('removes already-loaded Mail when its deletion arrives through the journal', async () => {
    const remote = message({ id: 'message-journal-mail', title: 'Journalled private note' })
    installAPI([messageSummary(remote)], [remote])
    const journal = deferred<{
      supported: true
      page: {
        deletions: Array<{ sequence: number; kind: 'message'; id: string; deleted_at: string }>
        next_after_sequence: number
        has_more: boolean
      }
    }>()
    Object.assign(window.agentsDock.teamHub, { networkDeletions: vi.fn(() => journal.promise) })

    render(<TeamMessagesBoard
      section="mail"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'TargetApp' }]}
      canWrite
    />)

    expect(await screen.findByRole('button', { name: 'Open Journalled private note' })).toBeVisible()
    await act(async () => journal.resolve({
      supported: true,
      page: {
        deletions: [{
          sequence: 1, kind: 'message', id: remote.id, deleted_at: '2026-09-05T20:00:00Z'
        }],
        next_after_sequence: 1,
        has_more: false
      }
    }))
    expect(await screen.findByText('Inbox is empty')).toBeVisible()
    expect(screen.queryByText('Journalled private note')).not.toBeInTheDocument()
  })

  it('requests only a bounded main-process preview for a large text attachment', async () => {
    const markdown: TeamAttachment = {
      ...attachment(),
      file_name: 'runbook.md',
      media_type: 'text/markdown',
      byte_size: 700_000
    }
    const detail = message({
      title: 'Operations runbook',
      recipients: [{ kind: 'all', id: 'all', display_name: 'Everyone', state: 'available', delivered_at: null, read_at: null }],
      attachments: [markdown],
    })
    const api = installAPI([messageSummary(detail, { attachments: [], delivery: undefined })], [detail])
    const rendererFetch = vi.fn()
    vi.stubGlobal('fetch', rendererFetch)

    render(<TeamMessagesBoard
      section="feed"
      scope={scope}
      teamId="team-1"
      capability={capability}
      addresses={[]}
      canWrite
    />)

    fireEvent.click(await screen.findByRole('button', { name: /Operations runbook/ }))
    expect(api.cacheTeamAttachment).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Load attachment runbook.md' }))

    await waitFor(() => expect(api.cacheTeamAttachment).toHaveBeenCalledWith(scope, {
      teamId: 'team-1', attachmentId: 'attachment-1', previewBytes: 512 * 1024
    }))
    expect(rendererFetch).not.toHaveBeenCalled()
    expect(await screen.findByText(/Showing the first/, {}, { timeout: 5_000 })).toBeVisible()
  })

})
