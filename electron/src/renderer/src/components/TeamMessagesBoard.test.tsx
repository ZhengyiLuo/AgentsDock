import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import userEvent from '@testing-library/user-event'
import type { AgentsDockAPI } from '@shared/ipc'
import type { TeamHubScope } from '@shared/team-hub'
import type { NativeFileRef } from '@shared/types'
import { setLocale } from '@shared/i18n'
import { applyMailArrivalHint, applyMailPageCoverage, beginMailHintStream, type MailHintPageAcknowledgment, type MailHintProjection, type MailHintScope } from '@shared/team-mail-hints'
import { acknowledgeBulletinHint, applyBulletinHint, emptyBulletinCursor, type BulletinChangeCursor, type BulletinHintRefresh } from '@shared/team-bulletin-hints'
import { TEAM_MESSAGES_SKILL_SLUG_PATTERN, type TeamAttachment, type TeamMessage, type TeamMessageCreateInput, type TeamMailboxStateInput, type TeamMessagePage, type TeamMessageSummary, type TeamMessagesCapability, type TeamNetworkBulletinPost, type TeamSkill, type TeamSkillDetails } from '@shared/team-network'
import { resetTeamNetworkSnapshotCacheForTests } from '../lib/team-network-snapshot-cache'
import { parseTeamMessageLink } from '../lib/team-message-links'
import { TeamMessagesBoard } from './TeamMessagesBoard'
import { selectMailHintPending, useAppStore } from '../store/app-store'

const teamMessagesStyles = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/TeamMessagesBoard.css'), 'utf8')

afterEach(() => {
  cleanup()
  setLocale('en')
  useAppStore.setState({ mailHints: null })
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

const searchCapability: TeamMessagesCapability = {
  ...capability,
  search: { available: true, version: 1, fields: ['subject', 'body', 'sender'], max_query_chars: 200 }
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

describe('fresh exact-mailbox page acknowledgement', () => {
  const hintScope: MailHintScope = {
    profileId: scope.profileId, profileGeneration: scope.profileGeneration, serverIdentity: scope.serverIdentity,
    streamId: 'stream-1', hubId: scope.hubIdentity!, teamId: 'team-1', recipientServerId: 'server-local'
  }
  const cursor = (through_sequence: number) => ({ through_sequence,
    arrival_id: through_sequence ? `tmsg_${through_sequence.toString(16).padStart(32, '0')}` : null })
  const coverage = (sequence: number) => ({ version: 1 as const, team_id: 'team-1', recipient_server_id: 'server-local', ...cursor(sequence) })
  const summary = (sequence: number) => messageSummary(message({
    id: cursor(sequence).arrival_id!, sequence, body: `Arrival ${sequence}`
  }), { preview: `Arrival ${sequence}` })
  const page = (sequence: number, hasMore = false): TeamMessagePage => ({
    box: 'inbox', address: { kind: 'server', id: 'server-local' }, messages: sequence ? [summary(sequence)] : [],
    next_after_sequence: sequence, has_more: hasMore, mailbox_coverage: coverage(sequence)
  })
  const board = (props: Partial<Parameters<typeof TeamMessagesBoard>[0]> = {}) => <TeamMessagesBoard
    section="mail" scope={scope} teamId="team-1" capability={capability}
    addresses={[{ kind: 'server', id: 'server-local', label: 'Local' }]} canWrite {...props} />
  function installHints(latest: number | null = 900) {
    const initial = beginMailHintStream(hintScope)
    const state = latest === null ? initial : applyMailArrivalHint(initial, hintScope, 'snapshot', { ...coverage(latest), reset: false })
    useAppStore.setState({
      activeProfileId: scope.profileId, profileGeneration: scope.profileGeneration, switchingProfileId: null,
      profiles: [{ id: scope.profileId, name: 'Local', serverUrl: 'https://example.test', serverIdentity: scope.serverIdentity,
        hasAccessToken: false, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 }],
      mailHints: { profileId: scope.profileId, profileGeneration: scope.profileGeneration, revision: 1, state }
    })
    const acknowledgePage = vi.fn(async (input: MailHintPageAcknowledgment): Promise<MailHintProjection | null> => {
      const current = useAppStore.getState().mailHints!
      return { ...current, revision: current.revision + 1, state: applyMailPageCoverage(current.state!, input.scope, input.requestedAfter, input.coverage) }
    })
    Object.assign(window.agentsDock, { mailHints: { acknowledgePage } })
    return acknowledgePage
  }

  function floodHints() {
    act(() => {
      for (let sequence = 8; sequence <= 250; sequence += 1) {
        const current = useAppStore.getState().mailHints!
        useAppStore.setState({ mailHints: { ...current, revision: current.revision + 1,
          state: applyMailArrivalHint(current.state!, hintScope, 'hint', { ...coverage(sequence), reset: false }) } })
      }
    })
  }

  const bulletinCursor = (sequence: number): BulletinChangeCursor => sequence === 0 ? emptyBulletinCursor('team-1') : {
    version: 1, team_id: 'team-1', through_sequence: sequence,
    change_id: `bchg_${sequence.toString(16).padStart(32, '0')}`,
    message_id: cursor(sequence).arrival_id!, change_kind: 'revised', message_version: sequence
  }
  const feedPage = (sequence = 0, hasMore = false): TeamMessagePage => ({
    box: 'feed', address: null, messages: [], next_after_sequence: sequence, has_more: hasMore
  })
  function installBulletinHints(latest = 7) {
    const acknowledgePage = installHints(0)
    const current = useAppStore.getState().mailHints!
    useAppStore.setState({ mailHints: { ...current,
      bulletin: applyBulletinHint(null, hintScope, 'snapshot', { ...bulletinCursor(latest), reset: false }, emptyBulletinCursor('team-1')) } })
    const acknowledgeBulletinRefresh = vi.fn(async (input: BulletinHintRefresh): Promise<MailHintProjection> => {
      const projection = useAppStore.getState().mailHints!
      return { ...projection, revision: projection.revision + 1,
        bulletin: acknowledgeBulletinHint(projection.bulletin!, input) }
    })
    Object.assign(window.agentsDock.mailHints!, { acknowledgeBulletinRefresh })
    return { acknowledgePage, acknowledgeBulletinRefresh }
  }
  function pushBulletinHint(sequence: number) {
    const current = useAppStore.getState().mailHints!
    useAppStore.setState({ mailHints: { ...current, revision: current.revision + 1,
      bulletin: applyBulletinHint(current.bulletin!, hintScope, 'hint', { ...bulletinCursor(sequence), reset: false }, null) } })
  }

  it('searches only on submit, one page at a time, without acknowledging mail coverage or overwriting unread counts', async () => {
    const api = installAPI([])
    const acknowledge = installHints()
    const onUnreadSnapshot = vi.fn()
    api.teamMessages.mockResolvedValue(page(7))
    const view = render(board({ capability: searchCapability, onUnreadSnapshot }))
    await waitFor(() => expect(acknowledge).toHaveBeenCalledOnce())
    acknowledge.mockClear()
    onUnreadSnapshot.mockClear()
    api.teamMessages.mockClear()
    const input = screen.getByRole('searchbox', { name: 'Search mail' })
    const scroll = view.container.querySelector('.network-v2-scroll') as HTMLElement
    scroll.scrollTop = 123
    await userEvent.type(input, '  rollout review  ')
    expect(api.teamMessages).not.toHaveBeenCalled()
    expect(scroll.scrollTop).toBe(123)
    api.teamMessages.mockResolvedValue(page(600, true))
    fireEvent.submit(screen.getByRole('search', { name: 'Search mail' }))
    await screen.findByRole('button', { name: 'Open Arrival 600' })
    expect(scroll.scrollTop).toBe(0)
    expect(api.teamMessages).toHaveBeenCalledOnce()
    expect(api.teamMessages.mock.calls[0][1]).toMatchObject({ q: 'rollout review', box: 'inbox', addressId: 'server-local', limit: 25 })
    expect(api.teamMessages.mock.calls[0][1]).not.toHaveProperty('includeMailboxCoverage')
    expect(acknowledge).not.toHaveBeenCalled()
    expect(onUnreadSnapshot).not.toHaveBeenCalled()
    api.teamMessages.mockResolvedValue(page(700))
    scroll.scrollTop = 45
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByRole('button', { name: 'Open Arrival 700' })
    expect(scroll.scrollTop).toBe(45)
    expect(api.teamMessages).toHaveBeenCalledTimes(2)
    expect(api.teamMessages.mock.calls[1][1]).toMatchObject({ q: 'rollout review', afterSequence: 600 })
    expect(screen.getByRole('button', { name: 'Open Arrival 600' })).toBeVisible()
    expect(acknowledge).not.toHaveBeenCalled()
    const fresh = deferred<TeamMessagePage>()
    api.teamMessages.mockReturnValue(fresh.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.queryByRole('button', { name: 'Open Arrival 600' })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Open Arrival 7' })).toBeVisible()
    expect(api.teamMessages.mock.calls[2][1]).not.toHaveProperty('q')
    await act(async () => fresh.resolve(page(7)))
    expect(onUnreadSnapshot).toHaveBeenCalledWith(1, false)
    expect(onUnreadSnapshot.mock.calls.every(([count]) => count === 1)).toBe(true)
  })

  it('does not reuse Bulletin prefetch or clear its hint during search, and clearing searches fetches fresh history', async () => {
    const api = installAPI([])
    const { acknowledgeBulletinRefresh } = installBulletinHints()
    const prefetched = messageSummary(bulletinMessage({ id: 'prefetched', body: 'Original item' }), { preview: 'Original item' })
    render(board({ section: 'feed', capability: searchCapability,
      initialFeedLoad: Promise.resolve({ state: 'ready', page: { ...feedPage(7), messages: [prefetched] } }) }))
    await screen.findByText('Original item')
    api.teamMessages.mockResolvedValue(feedPage())
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search bulletin' }), { target: { value: 'missing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await screen.findByText('No matching messages')
    expect(api.teamMessages).toHaveBeenCalledOnce()
    expect(api.teamMessages.mock.calls[0][1]).toMatchObject({ box: 'feed', q: 'missing' })
    expect(acknowledgeBulletinRefresh).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Bulletin updated · Refresh' })).toBeVisible()
    expect(screen.queryByText('Original item')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await waitFor(() => expect(api.teamMessages).toHaveBeenCalledTimes(2))
    expect(api.teamMessages.mock.calls[1][1]).not.toHaveProperty('q')
    await waitFor(() => expect(acknowledgeBulletinRefresh).toHaveBeenCalledOnce())
  })

  it('fences late search results and resets input/cursors across Inbox, Sent and connection changes', async () => {
    const api = installAPI([])
    const view = render(board({ capability: searchCapability }))
    await screen.findByText('Inbox is empty')
    const delayed = deferred<TeamMessagePage>()
    api.teamMessages.mockReturnValueOnce(delayed.promise)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search mail' }), { target: { value: 'rollout' } })
    fireEvent.submit(screen.getByRole('search', { name: 'Search mail' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sent' }))
    await waitFor(() => expect(api.teamMessages.mock.lastCall?.[1]).toMatchObject({ box: 'sent' }))
    expect(screen.getByRole('searchbox', { name: 'Search mail' })).toHaveValue('')
    expect(api.teamMessages.mock.lastCall?.[1]).not.toHaveProperty('q')
    await act(async () => delayed.resolve(page(900)))
    expect(screen.queryByRole('button', { name: 'Open Arrival 900' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }))
    expect(screen.getByRole('searchbox', { name: 'Search mail' })).toHaveValue('')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search mail' }), { target: { value: 'sender' } })
    fireEvent.submit(screen.getByRole('search', { name: 'Search mail' }))
    await waitFor(() => expect(api.teamMessages.mock.lastCall?.[1]).toHaveProperty('q', 'sender'))
    view.rerender(board({ capability: searchCapability, scope: { ...scope, generation: 4 } }))
    await waitFor(() => expect(api.teamMessages.mock.lastCall?.[0]).toMatchObject({ generation: 4 }))
    expect(api.teamMessages.mock.lastCall?.[1]).not.toHaveProperty('q')
    expect(screen.getByRole('searchbox', { name: 'Search mail' })).toHaveValue('')
  })

  it('explains search support on older hosts without pretending loaded rows are all search results', async () => {
    const api = installAPI([])
    render(board())
    await waitFor(() => expect(api.teamMessages).toHaveBeenCalledOnce())
    expect(screen.getByRole('searchbox', { name: 'Search mail' })).toBeDisabled()
    expect(screen.getByText('Update the Team Network host and connected server to enable search.')).toBeVisible()
    fireEvent.submit(screen.getByRole('search', { name: 'Search mail' }))
    expect(api.teamMessages).toHaveBeenCalledOnce()
  })

  it('submits with Enter and keeps search results stable through hint floods without polling', async () => {
    const api = installAPI([])
    installHints()
    render(board({ capability: searchCapability }))
    await screen.findByText('Inbox is empty')
    api.teamMessages.mockResolvedValue(page(42))
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search mail' }), 'Astra{Enter}')
    await screen.findByRole('button', { name: 'Open Arrival 42' })
    const calls = api.teamMessages.mock.calls.length
    const details = api.teamMessage.mock.calls.length
    vi.useFakeTimers()
    floodHints()
    act(() => vi.advanceTimersByTime(180_000))
    expect(api.teamMessages).toHaveBeenCalledTimes(calls)
    expect(api.teamMessage).toHaveBeenCalledTimes(details)
    expect(screen.getByRole('button', { name: 'Open Arrival 42' })).toBeVisible()
    expect(screen.getByRole('searchbox', { name: 'Search mail' })).toHaveValue('Astra')
    expect(screen.getByRole('button', { name: 'New mail · Refresh' })).toBeVisible()
  })

  it('shows search failures without a false empty-state and ignores a superseded query failure', async () => {
    const api = installAPI([])
    render(board({ capability: searchCapability }))
    await screen.findByText('Inbox is empty')
    const old = deferred<TeamMessagePage>()
    api.teamMessages.mockReturnValueOnce(old.promise)
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search mail' }), 'first{Enter}')
    api.teamMessages.mockRejectedValueOnce(new Error('Search unavailable. Update the connected server.'))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search mail' }), { target: { value: 'second' } })
    fireEvent.submit(screen.getByRole('search', { name: 'Search mail' }))
    await screen.findByText('Search unavailable. Update the connected server.')
    expect(screen.queryByText('No matching messages')).not.toBeInTheDocument()
    await act(async () => old.reject(new Error('Superseded error')))
    expect(screen.queryByText('Superseded error')).not.toBeInTheDocument()
    api.teamMessages.mockResolvedValue(page(43))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('button', { name: 'Open Arrival 43' })
    expect(api.teamMessages.mock.lastCall?.[1]).toHaveProperty('q', 'second')
    expect(api.teamMessage).not.toHaveBeenCalled()
  })

  it('keeps a Bulletin draft, focus and scroll on hint floods, then acknowledges only the head captured before Refresh', async () => {
    const api = installAPI([])
    const { acknowledgePage, acknowledgeBulletinRefresh } = installBulletinHints()
    const view = render(board({ section: 'feed', initialFeedLoad: Promise.resolve({ state: 'ready', page: feedPage() }) }))
    const draft = await screen.findByRole('textbox', { name: 'Team bulletin' })
    fireEvent.change(draft, { target: { value: 'An unsent synthetic draft.' } })
    draft.focus()
    const scroll = view.container.querySelector('.network-v2-scroll') as HTMLElement
    scroll.scrollTop = 147
    vi.useFakeTimers()
    act(() => { for (let sequence = 8; sequence <= 250; sequence += 1) pushBulletinHint(sequence) })
    act(() => vi.advanceTimersByTime(180_000))
    expect(screen.getByRole('button', { name: 'Bulletin updated · Refresh' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Team bulletin' })).toBe(draft)
    expect(draft).toHaveValue('An unsent synthetic draft.')
    expect(draft).toHaveFocus()
    expect(view.container.querySelector('.network-v2-scroll')).toBe(scroll)
    expect(scroll.scrollTop).toBe(147)
    expect(api.teamMessages).not.toHaveBeenCalled()
    expect(api.teamMessage).not.toHaveBeenCalled()
    expect(api.recordTeamMessageReceipt).not.toHaveBeenCalled()
    expect(acknowledgePage).not.toHaveBeenCalled()
    expect(acknowledgeBulletinRefresh).not.toHaveBeenCalled()
    act(() => setLocale('zh-CN'))
    expect(screen.getByRole('button', { name: '公告栏有更新 · 刷新' })).toBeVisible()
    act(() => setLocale('en'))
    vi.useRealTimers()
    const fresh = deferred<TeamMessagePage>()
    api.teamMessages.mockReturnValue(fresh.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Bulletin updated · Refresh' }))
    expect(api.teamMessages).toHaveBeenCalledOnce()
    act(() => pushBulletinHint(251))
    await act(async () => fresh.resolve(feedPage()))
    await waitFor(() => expect(acknowledgeBulletinRefresh).toHaveBeenCalledOnce())
    expect(acknowledgeBulletinRefresh).toHaveBeenCalledWith({ scope: hintScope, cursor: bulletinCursor(250) })
    expect(useAppStore.getState().mailHints?.bulletin?.seen.through_sequence).toBe(250)
    expect(screen.getByRole('button', { name: 'Bulletin updated · Refresh' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Team bulletin' })).toHaveValue('An unsent synthetic draft.')
    expect(acknowledgePage).not.toHaveBeenCalled()
  })

  it('retains a fresh Bulletin prefix across capped Load more and acknowledges only its complete final page', async () => {
    const api = installAPI([])
    const { acknowledgeBulletinRefresh } = installBulletinHints(7)
    api.teamMessages.mockImplementation((_scope, query: { afterSequence?: number }) => Promise.resolve(
      (query.afterSequence ?? 0) < 400 ? feedPage((query.afterSequence ?? 0) + 25, true) : feedPage(401)
    ))
    render(board({ section: 'feed' }))
    await waitFor(() => expect(api.teamMessages).toHaveBeenCalledTimes(16))
    const more = await screen.findByRole('button', { name: 'Load more' })
    expect(acknowledgeBulletinRefresh).not.toHaveBeenCalled()
    act(() => pushBulletinHint(8))
    fireEvent.click(more)
    await waitFor(() => expect(acknowledgeBulletinRefresh).toHaveBeenCalledOnce())
    expect(api.teamMessages).toHaveBeenCalledTimes(17)
    expect(api.teamMessages.mock.calls[16][1]).toMatchObject({ afterSequence: 400 })
    expect(acknowledgeBulletinRefresh).toHaveBeenCalledWith({ scope: hintScope, cursor: bulletinCursor(7) })
    expect(screen.getByRole('button', { name: 'Bulletin updated · Refresh' })).toBeVisible()
  })

  it('does not acknowledge Bulletin history continued from a prefetched page or a failed fresh traversal', async () => {
    const api = installAPI([])
    const { acknowledgeBulletinRefresh } = installBulletinHints()
    api.teamMessages.mockResolvedValue(feedPage(25))
    const view = render(board({ section: 'feed', initialFeedLoad: Promise.resolve({ state: 'ready', page: feedPage(0, true) }) }))
    await waitFor(() => expect(api.teamMessages).toHaveBeenCalledOnce())
    expect(acknowledgeBulletinRefresh).not.toHaveBeenCalled()
    view.unmount()
    api.teamMessages.mockReset().mockResolvedValueOnce(feedPage(25, true)).mockRejectedValueOnce(new Error('Synthetic page failure'))
    render(board({ section: 'feed', lifecycleCacheKey: 'failed-bulletin-refresh' }))
    await waitFor(() => expect(api.teamMessages).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Synthetic page failure')).toBeVisible()
    expect(acknowledgeBulletinRefresh).not.toHaveBeenCalled()
    api.teamMessages.mockResolvedValue(feedPage(26))
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(api.teamMessages).toHaveBeenCalledTimes(3))
    expect(acknowledgeBulletinRefresh).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Bulletin updated · Refresh' })).toBeVisible()
  })

  it('does not acknowledge cached Bulletin rows until their fresh revalidation completes', async () => {
    const api = installAPI([])
    api.teamMessages.mockResolvedValue(feedPage())
    const props = { section: 'feed' as const, lifecycleCacheKey: 'bulletin-hint-cache' }
    const first = render(board(props))
    await screen.findByRole('textbox', { name: 'Team bulletin' })
    first.unmount()
    const { acknowledgeBulletinRefresh } = installBulletinHints()
    const fresh = deferred<TeamMessagePage>()
    api.teamMessages.mockReturnValue(fresh.promise)
    render(board(props))
    expect(screen.getByRole('textbox', { name: 'Team bulletin' })).toBeVisible()
    expect(acknowledgeBulletinRefresh).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Bulletin updated · Refresh' })).toBeVisible()
    await act(async () => fresh.resolve(feedPage()))
    await waitFor(() => expect(acknowledgeBulletinRefresh).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button', { name: 'Bulletin updated · Refresh' })).not.toBeInTheDocument()
  })

  it.each(['team', 'hub', 'profile', 'generation', 'server'] as const)(
    'does not show or acknowledge another Bulletin’s updates after a %s boundary', async boundary => {
      installAPI([])
      const { acknowledgeBulletinRefresh } = installBulletinHints()
      render(board({ section: 'feed', ...(boundary === 'team' ? { teamId: 'other-team' }
        : boundary === 'hub' ? { scope: { ...scope, hubIdentity: 'other-hub' } }
          : boundary === 'profile' ? { scope: { ...scope, profileId: 'other-profile' } }
            : boundary === 'generation' ? { scope: { ...scope, profileGeneration: scope.profileGeneration + 1 } }
              : { scope: { ...scope, serverIdentity: 'other-server' } }) }))
      await screen.findByRole('textbox', { name: 'Team bulletin' })
      expect(screen.queryByRole('button', { name: 'Bulletin updated · Refresh' })).not.toBeInTheDocument()
      expect(acknowledgeBulletinRefresh).not.toHaveBeenCalled()
    }
  )

  it('shows a quiet scoped notice for a hint flood without fetching or moving the list until explicit refresh', async () => {
    const api = installAPI([])
    const acknowledgePage = installHints(0)
    api.teamMessages.mockResolvedValue(page(7))
    const view = render(board())
    await waitFor(() => expect(acknowledgePage).toHaveBeenCalledOnce())
    const scroll = view.container.querySelector('.network-v2-scroll') as HTMLElement
    scroll.scrollTop = 137
    expect(screen.queryByRole('button', { name: 'New mail · Refresh' })).not.toBeInTheDocument()
    vi.useFakeTimers()
    floodHints()
    act(() => vi.advanceTimersByTime(180_000))
    expect(screen.getByRole('button', { name: 'New mail · Refresh' })).toBeVisible()
    expect(view.container.querySelector('.network-v2-scroll')).toBe(scroll)
    expect(scroll.scrollTop).toBe(137)
    expect(api.teamMessages).toHaveBeenCalledOnce()
    expect(api.teamMessage).not.toHaveBeenCalled()
    expect(api.recordTeamMessageReceipt).not.toHaveBeenCalled()
    expect(acknowledgePage).toHaveBeenCalledOnce()
    act(() => setLocale('zh-CN'))
    expect(screen.getByRole('button', { name: '新邮件 · 刷新' })).toBeVisible()
    expect(api.teamMessages).toHaveBeenCalledOnce()
    act(() => setLocale('en'))
    vi.useRealTimers()
    api.teamMessages.mockResolvedValue(page(250))
    fireEvent.click(screen.getByRole('button', { name: 'New mail · Refresh' }))
    await waitFor(() => expect(acknowledgePage).toHaveBeenCalledTimes(2))
    expect(api.teamMessages).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'New mail · Refresh' })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Open Arrival 250' })).toBeVisible()
  })

  it('keeps the selected Mail detail, focus and scroll intact when new hints arrive', async () => {
    const detail = message({ id: cursor(7).arrival_id!, body: 'Arrival 7' })
    const api = installAPI([], [detail])
    installHints(0)
    api.teamMessages.mockResolvedValue(page(7))
    const view = render(board())
    fireEvent.click(await screen.findByRole('button', { name: 'Open Arrival 7' }))
    await waitFor(() => expect(api.recordTeamMessageReceipt).toHaveBeenCalledOnce())
    const scroll = view.container.querySelector('.network-v2-detail-body') as HTMLElement
    const back = screen.getByRole('button', { name: 'Back' })
    back.focus()
    scroll.scrollTop = 213
    const body = screen.getByText('Arrival 7', { selector: 'p' })
    floodHints()
    expect(screen.getByRole('button', { name: 'New mail · Refresh' })).toBeVisible()
    expect(view.container.querySelector('.network-v2-detail-body')).toBe(scroll)
    expect(screen.getByText('Arrival 7', { selector: 'p' })).toBe(body)
    expect(scroll.scrollTop).toBe(213)
    expect(back).toHaveFocus()
    expect(api.teamMessages).toHaveBeenCalledOnce()
    expect(api.teamMessage).toHaveBeenCalledOnce()
    expect(api.recordTeamMessageReceipt).toHaveBeenCalledOnce()
  })

  it.each(['team', 'hub', 'profile', 'generation', 'server', 'recipient', 'human', 'sent', 'bulletin'] as const)(
    'does not show another mailbox’s arrival notice in a %s context', async boundary => {
      installAPI([])
      installHints(250)
      render(board(boundary === 'team' ? { teamId: 'other-team' }
        : boundary === 'hub' ? { scope: { ...scope, hubIdentity: 'other-hub' } }
          : boundary === 'profile' ? { scope: { ...scope, profileId: 'other-profile' } }
            : boundary === 'generation' ? { scope: { ...scope, profileGeneration: scope.profileGeneration + 1 } }
              : boundary === 'server' ? { scope: { ...scope, serverIdentity: 'other-server' } }
                : boundary === 'recipient' ? { addresses: [{ kind: 'server', id: 'other-server', label: 'Other' }] }
                  : boundary === 'human' ? { addresses: [{ kind: 'human', id: 'server-local', label: 'Human' }] }
                    : boundary === 'sent' ? { initialMailboxBox: 'sent' } : { section: 'feed' }))
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(screen.queryByRole('button', { name: 'New mail · Refresh' })).not.toBeInTheDocument()
    }
  )

  it('keeps the dot for arrivals beyond 16 capped pages and continues only with the immutable coverage anchor', async () => {
    const api = installAPI([])
    const acknowledgePage = installHints()
    api.teamMessages.mockImplementation((_scope, query: { afterSequence?: number }) => {
      const after = query.afterSequence ?? 0
      return Promise.resolve(after < 400
        ? { ...page(after + 25, true), messages: Array.from({ length: 25 }, (_, index) => summary(after + index + 1)) }
        : { ...page(900), messages: [] })
    })
    render(board())
    await waitFor(() => expect(acknowledgePage).toHaveBeenCalledTimes(16))
    expect(api.teamMessages).toHaveBeenCalledTimes(16)
    expect(useAppStore.getState().mailHints?.state?.seen.through_sequence).toBe(400)
    expect(selectMailHintPending(useAppStore.getState())).toBe(true)
    expect(api.teamMessages.mock.calls[0][1]).toMatchObject({ includeMailboxCoverage: true, afterSequence: 0 })
    expect(api.teamMessages.mock.calls[0][1]).not.toHaveProperty('afterArrivalId')
    expect(api.teamMessages.mock.calls[1][1]).toMatchObject({ includeMailboxCoverage: true, afterSequence: 25, afterArrivalId: cursor(25).arrival_id })
    expect(acknowledgePage.mock.calls[15][0]).toEqual({ scope: hintScope, requestedAfter: cursor(375), coverage: coverage(400) })
    expect(api.teamMessage).not.toHaveBeenCalled()
    expect(api.recordTeamMessageReceipt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(acknowledgePage).toHaveBeenCalledTimes(17))
    expect(api.teamMessages.mock.calls[16][1]).toMatchObject({ afterSequence: 400, afterArrivalId: cursor(400).arrival_id })
    expect(selectMailHintPending(useAppStore.getState())).toBe(false)
  })

  it('records an applied fresh page before its delayed arrival hint without making that reviewed page pending again', async () => {
    const api = installAPI([])
    const acknowledgePage = installHints(0)
    api.teamMessages.mockResolvedValue(page(7))
    render(board())
    await waitFor(() => expect(acknowledgePage).toHaveBeenCalledOnce())
    expect(await screen.findByRole('button', { name: 'Open Arrival 7' })).toBeVisible()
    const current = useAppStore.getState().mailHints!
    act(() => useAppStore.setState({ mailHints: { ...current, revision: current.revision + 1,
      state: applyMailArrivalHint(current.state!, hintScope, 'hint', { ...coverage(7), reset: false }) } }))
    expect(selectMailHintPending(useAppStore.getState())).toBe(false)
    expect(api.teamMessages).toHaveBeenCalledOnce()
  })

  it('keeps a fresh Inbox page usable without acknowledging when main omits unavailable optional coverage', async () => {
    const api = installAPI([])
    const acknowledgePage = installHints(7)
    api.teamMessages.mockResolvedValue({ ...page(7), mailbox_coverage: undefined })
    render(board())
    expect(await screen.findByRole('button', { name: 'Open Arrival 7' })).toBeVisible()
    expect(api.teamMessages).toHaveBeenCalledOnce()
    expect(acknowledgePage).not.toHaveBeenCalled()
    expect(selectMailHintPending(useAppStore.getState())).toBe(true)
  })

  it('does not turn a passive local acknowledgement failure into a Mail load error', async () => {
    const api = installAPI([])
    const acknowledgePage = installHints(7)
    acknowledgePage.mockRejectedValue(new Error('Seen metadata temporarily unavailable'))
    api.teamMessages.mockResolvedValue(page(7))
    render(board())
    expect(await screen.findByRole('button', { name: 'Open Arrival 7' })).toBeVisible()
    await waitFor(() => expect(acknowledgePage).toHaveBeenCalledOnce())
    expect(screen.queryByText('Seen metadata temporarily unavailable')).not.toBeInTheDocument()
    expect(selectMailHintPending(useAppStore.getState())).toBe(true)
  })

  it('does not acknowledge cached rows while their fresh revalidation is pending', async () => {
    const api = installAPI([summary(7)])
    const first = render(board({ lifecycleCacheKey: 'mail-hint-cache' }))
    expect(await screen.findByRole('button', { name: 'Open Arrival 7' })).toBeVisible()
    first.unmount()
    const acknowledgePage = installHints(7)
    const fresh = deferred<TeamMessagePage>()
    api.teamMessages.mockReturnValue(fresh.promise)
    render(board({ lifecycleCacheKey: 'mail-hint-cache' }))
    expect(screen.getByRole('button', { name: 'Open Arrival 7' })).toBeVisible()
    expect(acknowledgePage).not.toHaveBeenCalled()
    expect(selectMailHintPending(useAppStore.getState())).toBe(true)
    await act(async () => fresh.resolve(page(7)))
    await waitFor(() => expect(acknowledgePage).toHaveBeenCalledOnce())
    expect(selectMailHintPending(useAppStore.getState())).toBe(false)
  })

  it('does not acknowledge prefetched Bulletin pages even if they carry coverage-shaped metadata', async () => {
    const api = installAPI([])
    const acknowledgePage = installHints(7)
    render(board({ section: 'feed', initialFeedLoad: Promise.resolve({ state: 'ready', page: { ...page(7), box: 'feed' } }) }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(api.teamMessages).not.toHaveBeenCalled()
    expect(acknowledgePage).not.toHaveBeenCalled()
    expect(selectMailHintPending(useAppStore.getState())).toBe(true)
  })

  it.each(['profile', 'generation', 'identity', 'stream'] as const)('rejects a delayed page acknowledgement after the %s changes', async boundary => {
    const api = installAPI([])
    const acknowledgePage = installHints(7)
    const delayed = deferred<TeamMessagePage>()
    api.teamMessages.mockReturnValue(delayed.promise)
    render(board())
    expect(api.teamMessages).toHaveBeenCalledOnce()
    const current = useAppStore.getState().mailHints!
    act(() => useAppStore.setState(boundary === 'profile' ? { activeProfileId: 'another-profile' }
      : boundary === 'generation' ? { profileGeneration: scope.profileGeneration + 1 }
        : boundary === 'identity' ? { profiles: useAppStore.getState().profiles.map(profile => ({ ...profile, serverIdentity: 'another-identity' })) }
          : { mailHints: { ...current, revision: 2, state: beginMailHintStream({ ...hintScope, streamId: 'stream-2' }, cursor(0), current.state!) } }))
    await act(async () => delayed.resolve(page(7)))
    expect(acknowledgePage).not.toHaveBeenCalled()
    expect(api.teamMessages).toHaveBeenCalledOnce()
  })

  it('does not acknowledge or apply a late response after the mailbox request generation changes', async () => {
    const api = installAPI([])
    const acknowledgePage = installHints(7)
    const delayed = deferred<TeamMessagePage>()
    api.teamMessages.mockReturnValueOnce(delayed.promise).mockResolvedValue({ ...page(0), mailbox_coverage: undefined })
    const view = render(board())
    view.rerender(board({ addresses: [{ kind: 'server', id: 'another-server', label: 'Other' }] }))
    await act(async () => delayed.resolve(page(7)))
    expect(screen.queryByText('Arrival 7')).not.toBeInTheDocument()
    expect(acknowledgePage).not.toHaveBeenCalled()
    expect(api.teamMessages).toHaveBeenCalledTimes(2)
    expect(api.teamMessages.mock.calls[1][1]).not.toHaveProperty('includeMailboxCoverage')
  })

  it('declines missing or wrong-mailbox coverage and never invents the next immutable predecessor from cached maxima', async () => {
    const api = installAPI([])
    const acknowledgePage = installHints(900)
    api.teamMessages.mockResolvedValueOnce({ ...page(7, true), mailbox_coverage: { ...coverage(7), recipient_server_id: 'other' } })
      .mockResolvedValueOnce(page(9))
    render(board())
    expect(await screen.findByRole('button', { name: 'Open Arrival 9' })).toBeVisible()
    expect(api.teamMessages).toHaveBeenCalledTimes(2)
    expect(api.teamMessages.mock.calls[1][1]).toMatchObject({ afterSequence: 7 })
    expect(api.teamMessages.mock.calls[1][1]).not.toHaveProperty('includeMailboxCoverage')
    expect(api.teamMessages.mock.calls[1][1]).not.toHaveProperty('afterArrivalId')
    expect(acknowledgePage).not.toHaveBeenCalled()
    expect(selectMailHintPending(useAppStore.getState())).toBe(true)
  })
})

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
      // The badge callback runs in a passive effect, after the row's DOM commit.
      await waitFor(() => {
        expect(row).toHaveClass('unread')
        expect(counts).toHaveBeenLastCalledWith(1, false)
      })
      expect(api.setTeamMessageMailboxState.mock.calls[0][1]).toEqual({
        teamId: 'team-1', messageId: 'message-1', addressKind: 'server', addressId: 'server-local',
        unread: true, expectedVersion: 1, idempotencyKey: expect.any(String)
      })
      await menu()
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark as read' }))
      await waitFor(() => {
        expect(row).not.toHaveClass('unread')
        expect(counts).toHaveBeenLastCalledWith(0, false)
      })
      expect(api.setTeamMessageMailboxState.mock.calls[1][1]).toMatchObject({ unread: false, expectedVersion: 2 })
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

describe('agent replies to exact server mail', () => {
  const subjectsCapability: TeamMessagesCapability = {
    ...capability, mail_subjects: { available: true, version: 1, max_subject_chars: 160 }
  }
  const localAddress = { kind: 'server' as const, id: 'server-local', label: 'Local' }
  const subject = 'Review [phase 1] \\ **literal** 中文'
  const board = (props: Partial<Parameters<typeof TeamMessagesBoard>[0]> = {}) => <TeamMessagesBoard
    section="mail" scope={scope} teamId="team-1" capability={subjectsCapability}
    addresses={[localAddress]} canWrite callerPostingKind="server" draftIdentity="reply-owner"
    routeTargets={[{ id: 'chat-review', label: 'Review desk', current: false }]} onRouteMessage={() => undefined} {...props} />
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
    await userEvent.click(await openDetail())
    return screen.findByRole('menu')
  }

  it('chooses an exact local chat for an agent reply without a manual send or saved-draft mutation', async () => {
    const api = installReplyAPI()
    const onRouteMessage = vi.fn()
    const savedKey = 'agentsdock:team-mail-reply:legacy-preserved'
    localStorage.setItem(savedKey, JSON.stringify({ body: 'Unsent human draft', attempt: null }))
    render(board({ onRouteMessage }))
    const menu = await openReply()
    expect(within(menu).getByText("Reply through a chat's agent")).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).not.toBeInTheDocument()
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Review desk' }))
    expect(onRouteMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'message-1', title: subject,
      sender: expect.objectContaining({ id: 'server-remote' }) }), 'chat-review', 'reply')
    expect(api.createTeamMessage).not.toHaveBeenCalled()
    expect(api.teamMessages).toHaveBeenCalledTimes(1)
    expect(api.teamMessage).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(savedKey)!)).toEqual({ body: 'Unsent human draft', attempt: null })
  })

  it('searches locally with autofocus, keyboard choice, duplicate-name identities and safe Escape', async () => {
    const api = installReplyAPI()
    const onRouteMessage = vi.fn()
    render(board({ onRouteMessage, routeTargets: [
      { id: 'chat-one', label: 'Review desk', current: true },
      { id: 'chat-two', label: 'Review desk', current: false },
      { id: 'chat-other', label: 'Build room', current: false }
    ] }))
    let menu = await openReply()
    let search = within(menu).getByRole('textbox', { name: 'Search chats' })
    await waitFor(() => expect(search).toHaveFocus())
    await userEvent.type(search, 'REVIEW')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2)
    expect(within(menu).getByRole('menuitem', { name: /Review desk.*chat-two/ })).toBeVisible()
    await userEvent.clear(search)
    await userEvent.type(search, 'absent')
    expect(within(menu).getByText('No matching chats')).toBeVisible()
    await userEvent.keyboard('{Enter}')
    expect(onRouteMessage).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }))
    menu = await screen.findByRole('menu')
    search = within(menu).getByRole('textbox', { name: 'Search chats' })
    await waitFor(() => expect(search).toHaveFocus())
    await userEvent.type(search, 'review')
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(onRouteMessage).toHaveBeenCalledWith(expect.anything(), 'chat-two', 'reply')
    expect(api.createTeamMessage).not.toHaveBeenCalled()
    expect(api.teamMessages).toHaveBeenCalledTimes(1)
  })

  it('keeps agent Reply available on an older host without probing threads or posting', async () => {
    const api = installReplyAPI()
    const teamMessageThread = vi.fn()
    Object.assign(window.agentsDock.teamHub, { teamMessageThread })
    render(board({ capability, routeTargets: [] }))
    const menu = await openReply()
    expect(within(menu).getByText('No active chats')).toBeVisible()
    expect(teamMessageThread).not.toHaveBeenCalled()
    expect(api.createTeamMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['missing delivery', () => incoming({ delivery: null }), {}],
    ['human sender', () => incoming({ sender: { kind: 'human', id: 'person-1', display_name: 'Teammate' } }), {}],
    ['skill parent', () => incoming({ kind: 'skill', skill: { id: 'skill-1', slug: 'guide', version: 1 } }), {}],
    ['another server’s delivery', () => incoming({ delivery: { ...message().recipients[0], id: 'server-other' } }), {}],
    ['self sender', () => incoming({ sender: { kind: 'server', id: 'server-local', display_name: 'Local' } }), {}],
    ['human identity', () => incoming(), { callerPostingKind: 'human' as const }],
    ['read-only identity', () => incoming(), { canWrite: false }]
  ])('does not offer Reply for %s', async (_label, parent, props) => {
    const api = installReplyAPI(parent())
    render(board(props))
    fireEvent.click(await screen.findByRole('button', { name: /^Open / }))
    expect(await screen.findByText('rollout')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument()
    expect(api.createTeamMessage).not.toHaveBeenCalled()
  })

  it('loads exact incoming and outgoing thread rows only on open and explicit more', async () => {
    const parent = incoming({ body: 'Original incoming question.' })
    const api = installReplyAPI(parent)
    const reply = message({ id: 'reply-1', sequence: 8, body: 'Outgoing answer.',
      sender: { kind: 'server', id: 'server-local', display_name: 'Local' }, in_reply_to_message_id: parent.id })
    const followup = incoming({ id: 'followup-1', sequence: 9, body: 'Incoming follow-up.', in_reply_to_message_id: reply.id })
    const page = { team_id: 'team-1', anchor_message_id: parent.id, root_message_id: parent.id,
      messages: [parent, reply], next_after_sequence: 8, has_more: true, truncated: false }
    const teamMessageThread = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce({
      ...page, messages: [followup], next_after_sequence: 9, has_more: false, truncated: true
    })
    Object.assign(window.agentsDock.teamHub, { teamMessageThread })
    render(board({ capability: { ...subjectsCapability, mail_threads: { available: true, version: 1, max_page_items: 25, max_thread_items: 2048 } } }))
    expect(teamMessageThread).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: /^Open / }))
    expect(await screen.findByText('Outgoing answer.')).toBeVisible()
    expect(teamMessageThread).toHaveBeenCalledTimes(1)
    expect(teamMessageThread).toHaveBeenLastCalledWith(scope, { teamId: 'team-1', messageId: parent.id, afterSequence: 0, limit: 25 })
    expect(screen.getByText('Original incoming question.').closest('article')).toHaveClass('incoming')
    expect(screen.getByText('Outgoing answer.').closest('article')).toHaveClass('outgoing')
    fireEvent.click(screen.getByRole('button', { name: 'Load more messages' }))
    expect(await screen.findByText('Incoming follow-up.')).toBeVisible()
    expect(teamMessageThread).toHaveBeenLastCalledWith(scope, { teamId: 'team-1', messageId: parent.id, afterSequence: 8, limit: 25 })
    expect(screen.getAllByText('Original incoming question.')).toHaveLength(1)
    expect(screen.getByText(/Showing available thread history/)).toBeVisible()
    expect(api.teamMessages).toHaveBeenCalledTimes(1)
    expect(api.createTeamMessage).not.toHaveBeenCalled()
  })

  it('fences a late thread result after closing the exact message', async () => {
    installReplyAPI()
    const pending = deferred<any>()
    const teamMessageThread = vi.fn().mockReturnValue(pending.promise)
    Object.assign(window.agentsDock.teamHub, { teamMessageThread })
    render(board({ capability: { ...subjectsCapability, mail_threads: { available: true, version: 1, max_page_items: 25, max_thread_items: 2048 } } }))
    fireEvent.click(await screen.findByRole('button', { name: /^Open / }))
    await waitFor(() => expect(teamMessageThread).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await act(async () => pending.resolve({ team_id: 'team-1', anchor_message_id: 'message-1', root_message_id: 'message-1',
      messages: [incoming({ body: 'Late thread body must not return.' })], next_after_sequence: 7, has_more: false, truncated: false }))
    expect(screen.queryByText('Late thread body must not return.')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /^Open / })).toBeVisible()
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
  it('switches Mail and routing labels without refetching or translating authored content', async () => {
    const detail = message({ title: 'Mail / 公告 / @@bulletin', body: 'Keep this user-authored **message** unchanged.' })
    const summary = messageSummary(detail)
    const original = structuredClone({ detail, summary })
    const api = installAPI([summary], [detail])
    const onRouteMessage = vi.fn()
    render(<TeamMessagesBoard section="mail" scope={scope} teamId="team-1" capability={capability}
      addresses={[{ kind: 'server', id: 'server-local', label: 'Local' }]} canWrite
      routeTargets={[{ id: 'chat-1', label: 'User chat title / @@bulletin', current: true }]}
      onRouteMessage={onRouteMessage} />)
    await screen.findByRole('button', { name: `Open ${detail.title}` })
    await userEvent.click(screen.getByRole('button', { name: `Route ${detail.title} to a chat` }))
    const reads = api.teamMessages.mock.calls.length
    const deletions = api.networkDeletions.mock.calls.length

    act(() => setLocale('zh-CN'))
    expect(screen.getByRole('heading', { name: '信箱', hidden: true })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '搜索会话' })).toBeVisible()
    expect(screen.getByText('在会话中打开邮件')).toBeVisible()
    expect(screen.getByRole('menuitem', { name: /User chat title \/ @@bulletin/ })).toBeVisible()
    expect(screen.getByLabelText('当前会话')).toBeVisible()

    act(() => setLocale('en'))
    expect(screen.getByRole('textbox', { name: 'Search chats' })).toBeVisible()
    expect(screen.getByText('Open mail in chat')).toBeVisible()
    expect(api.teamMessages).toHaveBeenCalledTimes(reads)
    expect(api.networkDeletions).toHaveBeenCalledTimes(deletions)
    expect(api.teamMessage).not.toHaveBeenCalled()
    expect(onRouteMessage).not.toHaveBeenCalled()
    expect({ detail, summary }).toEqual(original)
  })

  it('switches Bulletin draft and stored error labels without new transport or posting', async () => {
    const api = installAPI([])
    const createTeamMessage = vi.fn()
    const file: NativeFileRef = { path: '/tmp/locale-draft.txt', name: 'User filename.txt', size: 0, type: 'text/plain' }
    const choose = vi.fn().mockResolvedValue([file])
    Object.assign(window.agentsDock, { files: { choose } })
    Object.assign(window.agentsDock.teamHub, { createTeamMessage })
    render(<TeamMessagesBoard section="feed" scope={scope} teamId="team-1" capability={capability}
      addresses={[]} canWrite />)
    const draft = 'Preserve my draft / 用户内容 / @@bulletin'
    fireEvent.change(await screen.findByRole('textbox', { name: 'Team bulletin' }), { target: { value: draft } })
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
    await screen.findByText('User filename.txt is not a valid attachment.')
    const reads = api.teamMessages.mock.calls.length
    const deletions = api.networkDeletions.mock.calls.length

    act(() => setLocale('zh-CN'))
    expect(screen.getByRole('heading', { name: '公告栏' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: '团队公告栏' })).toHaveValue(draft)
    expect(screen.getByRole('button', { name: '发布' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('User filename.txt 不是有效的附件。')

    act(() => setLocale('en'))
    expect(screen.getByRole('textbox', { name: 'Team bulletin' })).toHaveValue(draft)
    expect(screen.getByRole('alert')).toHaveTextContent('User filename.txt is not a valid attachment.')
    expect(api.teamMessages).toHaveBeenCalledTimes(reads)
    expect(api.networkDeletions).toHaveBeenCalledTimes(deletions)
    expect(choose).toHaveBeenCalledOnce()
    expect(createTeamMessage).not.toHaveBeenCalled()
  })

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
    // Settle the detail fetch and its attachment scope effect before the
    // next user action starts a media request in that newly mounted view.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Launch demo is ready/i })) })
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

  it.each(['legacy', 'announcement', 'skill', 'mail'] as const)('lets a capability-verified host delete another author’s %s without edit rights', async kind => {
    const user = userEvent.setup()
    const item = (kind === 'mail' ? message : bulletinMessage)({ id: 'orphan-item', title: 'Orphaned item', body: 'Orphaned content',
      kind: kind === 'skill' ? 'skill' : 'message', skill: kind === 'skill' ? { id: 'skill-orphan', slug: 'orphan', version: 1 } : null })
    const legacy: TeamNetworkBulletinPost = { id: item.id, sequence: 1, author: item.sender, body_format: 'plain', body: 'Orphaned item',
      thread_root_post_id: null, reply_to_post_id: null, created_at: item.created_at }
    installAPI(kind === 'legacy' ? [] : [messageSummary(item, { preview: item.body })], [item])
    const remove = vi.fn().mockResolvedValue({ deleted: true, post_id: item.id, message_id: item.id })
    Object.assign(window.agentsDock.teamHub, { deleteNetworkBulletin: remove, deleteTeamMessage: remove })
    render(<TeamMessagesBoard section={kind === 'mail' ? 'mail' : 'feed'} scope={scope} teamId="team-1"
      capability={{ ...capability, host_content_deletion: true }} canHostDelete canWrite={false}
      addresses={[{ kind: 'server', id: 'server-local', label: 'Host' }]} legacyBulletinPosts={kind === 'legacy' ? [legacy] : []} />)
    const title = await screen.findByText('Orphaned item')
    if (kind === 'legacy') await screen.findByRole('button', { name: 'Delete legacy announcement from Studio' })
    const card = screen.getByText(title.textContent!).closest(kind === 'mail' ? '.network-v2-card' : '.network-v2-bulletin-card') as HTMLElement
    fireEvent.contextMenu(card)
    expect(screen.queryByRole('menuitem', { name: /Edit/ })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('menuitem', { name: kind === 'mail' ? 'Delete for everyone…' : 'Delete Bulletin item…' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: kind === 'mail' ? 'Delete for everyone' : 'Delete item' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith(scope, {
      teamId: 'team-1', ...(kind === 'legacy' ? { postId: item.id } : { messageId: item.id }), idempotencyKey: expect.any(String)
    }))
    await waitFor(() => expect(screen.queryByText('Orphaned item')).not.toBeInTheDocument())
  })

  it.each([[false, true], [true, false]])('keeps host deletion gated by operator=%s capability=%s', async (host, supported) => {
    const other = bulletinMessage({ title: 'Other author', body: 'Not owned here' })
    installAPI([messageSummary(other)])
    render(<TeamMessagesBoard section="feed" scope={scope} teamId="team-1" canWrite={false} canHostDelete={host}
      capability={{ ...capability, ...(supported ? { host_content_deletion: true } : {}) }} addresses={[]} />)
    fireEvent.contextMenu((await screen.findByText('Other author')).closest('.network-v2-bulletin-card')!)
    expect(await screen.findByRole('menuitem', { name: 'Open Bulletin item' })).toBeVisible()
    expect(screen.queryByRole('menuitem', { name: 'Delete Bulletin item…' })).not.toBeInTheDocument()
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

  it('keeps the first attachment load when clicked before passive mount effects', async () => {
    const detail = message({ title: 'Immediate video preview', attachments: [attachment()],
      recipients: [{ kind: 'all', id: 'all', display_name: 'Everyone', state: 'available', delivered_at: null, read_at: null }] })
    const api = installAPI([messageSummary(detail, { attachments: [], delivery: undefined })], [detail])
    let clicked = false
    await act(async () => { render(<Profiler id="attachment-first-click" onRender={() => {
      if (clicked) return
      const button = screen.queryByRole('button', { name: 'Show video walkthrough.mp4' })
      if (!button) return
      clicked = true
      // Click in the commit phase before AttachmentView's passive effects
      // could invalidate this first explicit preview request.
      button.click()
    }}><TeamMessagesBoard section="feed" scope={scope} teamId="team-1" capability={capability} addresses={[]} canWrite /></Profiler>) })
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Immediate video preview/ })) })
    expect(await screen.findByLabelText('walkthrough.mp4')).toHaveAttribute('src', 'agentsdock-media://team/profile-1/team-1/attachment-1')
    expect(clicked).toBe(true)
    expect(api.cacheTeamAttachment).toHaveBeenCalledExactlyOnceWith(scope, { teamId: 'team-1', attachmentId: 'attachment-1' })
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

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show video walkthrough.mp4' }))
    })
    const player = await screen.findByLabelText('walkthrough.mp4')
    expect(player).toHaveAttribute('src', 'agentsdock-media://team/profile-1/team-1/attachment-1')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show image result.png' }))
    })
    const image = await screen.findByRole('img', { name: 'result.png' })
    expect(image).toHaveAttribute('src', 'agentsdock-media://team/profile-1/team-1/attachment-image')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load attachment runbook.md' }))
    })
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

    const routeButton = await screen.findByRole('button', { name: 'Route Review request to a chat' })
    const openButton = screen.getByRole('button', { name: 'Open Review request' })
    expect(routeButton).toBeVisible()
    expect(openButton.closest('article')?.querySelector('footer')).toContainElement(routeButton)
    expect(openButton).not.toContainElement(routeButton)
    expect(openButton.querySelector('.network-v2-card-title')).toHaveTextContent('Review request')
    expect(openButton.querySelector('time')).toHaveAttribute('datetime', note.created_at)
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
