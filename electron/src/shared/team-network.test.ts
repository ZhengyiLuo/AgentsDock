import { describe, expect, it } from 'vitest'
import {
  TEAM_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES,
  parseTeamNetworkCapabilities,
  parseTeamNetworkCreatePassiveRequestInput,
  parseTeamNetworkBulletinDeleteResponse,
  parseTeamNetworkDeleteBulletinInput,
  parseTeamNetworkDeletionPage,
  parseTeamNetworkDeletionQuery,
  parseTeamNetworkMailboxEntry,
  parseTeamNetworkMailboxQuery,
  parseTeamNetworkPostBulletinInput,
  parseTeamNetworkProjection,
  parseTeamNetworkProjectionQuery,
  parseTeamNetworkSendMailboxInput,
  parseAgentTeamMessagesCapability,
  parseTeamAttachmentDeclareInput,
  parseTeamAttachmentDeclaration,
  parseTeamAttachmentCacheInput,
  parseTeamMessageCreateInput,
  parseTeamMessageDeleteInput,
  parseTeamMessageDeleteResponse,
  parseTeamMessagePage,
  parseTeamMessageQuery,
  parseTeamMessageReceiptResponse,
  parseTeamMessageRevisionInput,
  parseTeamMessageResponse,
  parseTeamMessagesCapability,
  parseTeamMailSubjectsCapability,
  parseTeamMailboxStateCapability,
  parseTeamMailboxStateInput,
  parseTeamMailboxStateResponse,
  parseTeamBulletinAliasCapability,
  parseTeamAllServersAliasCapability,
  parseTeamSkillDetails,
  parseTeamSkillPage,
  parseTeamSkillVersionResponse,
  parseTeamSkillVersionsPage,
  teamAttachmentSupportsTextPreview,
  teamBulletinAliasAvailable,
  teamAllServersAliasAvailable
} from './team-network'

describe('Team Mail coverage metadata', () => {
  const anchor = `tmsg_${'a'.repeat(32)}`
  const query = { teamId: 'team-1', box: 'inbox', addressKind: 'server', addressId: 'node-1',
    includeMailboxCoverage: true, afterSequence: 3, afterArrivalId: anchor }
  const coverage = { version: 1, team_id: 'team-1', recipient_server_id: 'node-1', through_sequence: 3, arrival_id: anchor }
  const page = { box: 'inbox', address: { kind: 'server', id: 'node-1' }, messages: [], next_after_sequence: 3,
    has_more: false, mailbox_coverage: coverage }
  it('accepts only unfiltered own-server-shaped queries with a complete immutable predecessor', () => {
    expect(parseTeamMessageQuery(query)).toMatchObject(query)
    expect(parseTeamMessageQuery({ ...query, afterSequence: 0, afterArrivalId: undefined })).toMatchObject({ afterSequence: 0 })
    for (const invalid of [{ ...query, afterArrivalId: undefined }, { ...query, afterArrivalId: `${anchor}\n` },
      { ...query, unread: true }, { ...query, addressKind: 'human' }, { ...query, since: '2026-09-10T00:00:00Z' },
      { ...query, fromKind: 'server', fromId: 'sender' }, { ...query, includeMailboxCoverage: false }]) {
      expect(() => parseTeamMessageQuery(invalid)).toThrow()
    }
  })
  it('keeps legacy pages unchanged and rejects expanded or foreign coverage', () => {
    expect(parseTeamMessagePage(page, 'team-1').mailbox_coverage).toEqual(coverage)
    const { mailbox_coverage: _ignored, ...legacy } = page
    expect(parseTeamMessagePage(legacy, 'team-1')).toEqual(legacy)
    for (const invalid of [{ ...coverage, reset: false }, { ...coverage, team_id: 'foreign' },
      { ...coverage, recipient_server_id: 'foreign' }, { ...coverage, through_sequence: 2 },
      { ...coverage, body: 'private' }]) {
      expect(() => parseTeamMessagePage({ ...page, mailbox_coverage: invalid }, 'team-1')).toThrow()
    }
    expect(() => parseTeamMessagePage({ ...page, has_more: true,
      mailbox_coverage: { ...coverage, through_sequence: 4 } }, 'team-1')).toThrow()
  })
})

const capability = {
  available: true,
  version: 1,
  logical_servers: true,
  agent_registry: true,
  bulletin: true,
  mailbox: true,
  delivery_receipts: ['delivered', 'read'],
  passive_requests: true,
  server_invites: false,
  skill_attachments: false,
  dispatch: false,
  max_agents_per_server: 256,
  max_page_items: 100,
  max_body_bytes: 8_192
}

const messagesCapability = {
  available: true,
  version: 1,
  kinds: ['message', 'skill'],
  recipient_kinds: ['server', 'human', 'all'],
  max_body_bytes: 49_152,
  max_recipients_per_message: 16,
  max_page_items: 100,
  attachments: {
    max_bytes_per_file: 512 * 1024 * 1024,
    max_files_per_message: 16,
    max_bytes_per_message: 2 * 1024 * 1024 * 1024,
    chunk_bytes: 8 * 1024 * 1024,
    range_downloads: true,
    team_quota_bytes: 50 * 1024 * 1024 * 1024
  },
  skills: {
    slug_pattern: '^[a-z0-9][a-z0-9-]{0,63}$',
    max_per_team: 500,
    max_versions_per_skill: 200,
    max_tags: 8
  }
}

describe('Team Network V1 validators', () => {
  it('negotiates mailbox attention separately and validates owned-state mutation contracts', () => {
    const attention = { available: true, version: 1, address_kinds: ['server'] }
    expect(parseTeamMailboxStateCapability(attention)).toEqual(attention)
    for (const invalid of [{ ...attention, available: false }, { ...attention, version: 2 },
      { ...attention, address_kinds: ['human'] }, { ...attention, extra: true }]) {
      expect(() => parseTeamMailboxStateCapability(invalid)).toThrow()
    }
    expect(() => parseTeamMessagesCapability({ ...messagesCapability, mailbox_state: attention })).toThrow()
    const input = { teamId: 'team-1', messageId: 'message-1', addressKind: 'server',
      addressId: 'server-1', unread: true, expectedVersion: 2, idempotencyKey: 'mailbox-state-key' }
    expect(parseTeamMailboxStateInput(input)).toEqual(input)
    for (const change of [{ addressKind: 'human' }, { unread: 'true' }, { expectedVersion: true },
      { expectedVersion: -1 }, { expectedVersion: 1.5 }, { expectedVersion: Number.MAX_SAFE_INTEGER },
      { idempotencyKey: '' }, { extra: true }]) {
      expect(() => parseTeamMailboxStateInput({ ...input, ...change })).toThrow()
    }
    const receipt = { kind: 'server', id: 'server-1', display_name: 'Server', state: 'read',
      delivered_at: '2026-09-09T12:00:00Z', read_at: '2026-09-09T12:01:00Z' }
    const result = { message_id: 'message-1', recipients: [receipt],
      mailbox_state: { address_kind: 'server', address_id: 'server-1', unread: true, version: 3 } }
    expect(parseTeamMailboxStateResponse(result)).toEqual(result)
    expect(parseTeamMailboxStateResponse({ ...result, mailbox_state: { ...result.mailbox_state, unread: false } }))
      .toMatchObject({ recipients: [receipt], mailbox_state: { unread: false } })
    for (const change of [{ recipients: [] }, { recipients: [receipt, receipt] },
      { recipients: [{ ...receipt, id: 'server-other' }] },
      { mailbox_state: { ...result.mailbox_state, unread: 'true' } },
      { mailbox_state: { ...result.mailbox_state, version: 1.5 } },
      { mailbox_state: { ...result.mailbox_state, unread: false }, recipients: [{ ...receipt, state: 'available', delivered_at: null, read_at: null }] }]) {
      expect(() => parseTeamMailboxStateResponse({ ...result, ...change })).toThrow()
    }
  })

  it('negotiates mail subjects separately without changing the frozen message capability', () => {
    const subjects = { available: true, version: 1, max_subject_chars: 160 }
    expect(parseTeamMailSubjectsCapability(subjects)).toEqual(subjects)
    for (const invalid of [{ ...subjects, available: false }, { ...subjects, version: 2 },
      { ...subjects, max_subject_chars: 161 }, { ...subjects, extra: true }]) {
      expect(() => parseTeamMailSubjectsCapability(invalid)).toThrow('Mail subjects capability')
    }
    expect(() => parseTeamMessagesCapability({ ...messagesCapability, mail_subjects: subjects })).toThrow()
  })

  it('accepts optional single-line ordinary subjects with Unicode bounds and reply linkage', () => {
    const input = { teamId: 'team-1', kind: 'message', body: '# Unchanged body',
      recipients: [{ kind: 'server', id: 'server-1' }], idempotencyKey: 'subject-key-1' }
    expect(parseTeamMessageCreateInput({ ...input, title: '  Daily summary  ', inReplyToMessageId: 'message-old' }))
      .toMatchObject({ title: 'Daily summary', body: input.body, inReplyToMessageId: 'message-old' })
    expect(parseTeamMessageCreateInput({ ...input, title: '📬'.repeat(160) }).title).toBe('📬'.repeat(160))
    expect(parseTeamMessageCreateInput(input)).not.toHaveProperty('title')
    for (const title of ['', '  ', '📬'.repeat(161), 'A\nB', 'A\rB', 'A\tB', 'A\u0000B', 'A\u0085B', 'A\u2028B', 'A\u2029B', '\ud800']) {
      expect(() => parseTeamMessageCreateInput({ ...input, title })).toThrow('title')
    }
    expect(() => parseTeamMessageCreateInput({ ...input, title: 'Subject', skill: { slug: 'unexpected' } })).toThrow('skill fields')
  })

  it('gates all-server mail separately and preserves historical Bulletin meaning', () => {
    const alias = { available: true, version: 1, mention: '@@all', recipient_kind: 'all_servers', max_recipients_per_message: 1024 } as const
    expect(parseTeamAllServersAliasCapability(alias)).toEqual(alias)
    expect(teamAllServersAliasAvailable({ ok: true, capabilities: { team_all_servers_alias_v1: alias } })).toBe(true)
    expect(teamAllServersAliasAvailable({ ok: true })).toBe(false)
    expect(() => parseTeamAllServersAliasCapability({ ...alias, recipient_kind: 'all' })).toThrow('alias capability')
    const input = { teamId: 'team-1', kind: 'message', body: 'Body', idempotencyKey: 'all-servers-key', recipients: [{ kind: 'all_servers' }] }
    expect(parseTeamMessageCreateInput(input).recipients).toEqual([{ kind: 'all_servers' }])
    expect(() => parseTeamMessageCreateInput({ ...input, recipients: [{ kind: 'all_servers' }, { kind: 'server', id: 'server-1' }] })).toThrow('recipients')
    expect(parseTeamMessageCreateInput({ ...input, recipients: [{ kind: 'all' }] }).recipients).toEqual([{ kind: 'all' }])
    const recipients = Array.from({ length: 17 }, (_, index) => ({ kind: 'server', id: `server-${index}`, display_name: `Server ${index}`, state: 'available', delivered_at: null, read_at: null }))
    const message = { id: 'message-fanout', sequence: 1, kind: 'message', title: null, body: 'Body', body_format: 'markdown',
      body_bytes: 4, body_sha256: 'a'.repeat(64), sender: { kind: 'server', id: 'server-0', display_name: 'Studio' },
      recipients, attachments: [], in_reply_to_message_id: null, skill: null, provenance: {}, created_at: '2026-09-08T12:00:00Z' }
    expect(parseTeamMessageResponse({ message: { ...message, destination: 'all_servers' } }, 'team-1').message.recipients).toHaveLength(17)
    expect(() => parseTeamMessageResponse({ message }, 'team-1')).toThrow('recipients')
    const historical = { ...message, recipients: [{ ...recipients[0], kind: 'all', id: 'all' }] }
    expect(parseTeamMessageResponse({ message: historical }, 'team-1').message.destination).toBeUndefined()
    expect(() => parseTeamMessageResponse({ message: { ...historical, destination: 'all_servers' } }, 'team-1')).toThrow('recipients')
  })

  it('strictly parses message and legacy Bulletin deletion contracts', () => {
    const deletedAt = '2026-09-05T12:00:00Z'
    expect(parseTeamMessageDeleteInput({
      teamId: 'team-1', messageId: 'message-1', idempotencyKey: 'delete-message-1'
    })).toEqual({ teamId: 'team-1', messageId: 'message-1', idempotencyKey: 'delete-message-1' })
    expect(parseTeamMessageDeleteResponse({ deleted: true, message_id: 'message-1' }))
      .toEqual({ deleted: true, message_id: 'message-1' })
    expect(parseTeamNetworkDeleteBulletinInput({
      teamId: 'team-1', postId: 'post-1', idempotencyKey: 'delete-post-1'
    })).toEqual({ teamId: 'team-1', postId: 'post-1', idempotencyKey: 'delete-post-1' })
    expect(parseTeamNetworkBulletinDeleteResponse({ deleted: true, post_id: 'post-1' }))
      .toEqual({ deleted: true, post_id: 'post-1' })
    expect(parseTeamNetworkDeletionQuery({ teamId: 'team-1' }))
      .toEqual({ teamId: 'team-1', afterSequence: 0, limit: 50 })
    expect(parseTeamNetworkDeletionPage({
      deletions: [
        { sequence: 3, kind: 'message', id: 'message-1', deleted_at: deletedAt },
        { sequence: 4, kind: 'bulletin', id: 'post-1', deleted_at: deletedAt }
      ],
      next_after_sequence: 4,
      has_more: false
    })).toEqual({
      deletions: [
        { sequence: 3, kind: 'message', id: 'message-1', deleted_at: deletedAt },
        { sequence: 4, kind: 'bulletin', id: 'post-1', deleted_at: deletedAt }
      ],
      next_after_sequence: 4,
      has_more: false
    })
    expect(() => parseTeamNetworkDeletionPage({
      deletions: [
        { sequence: 4, kind: 'message', id: 'message-1', deleted_at: deletedAt },
        { sequence: 4, kind: 'bulletin', id: 'post-1', deleted_at: deletedAt }
      ],
      next_after_sequence: 4,
      has_more: false
    })).toThrow('ordering')
    expect(() => parseTeamMessageDeleteResponse({ deleted: false, message_id: 'message-1' })).toThrow('delete response')
    expect(() => parseTeamNetworkBulletinDeleteResponse({ deleted: true, post_id: 'post-1', extra: true })).toThrow('delete response')
  })

  it('strictly gates Team Messages V1 and its recipient invariants', () => {
    expect(parseTeamMessagesCapability(messagesCapability)).toEqual(messagesCapability)
    expect(() => parseTeamMessagesCapability({
      ...messagesCapability,
      attachments: { ...messagesCapability.attachments, streaming: true }
    })).toThrow('attachment capability')
    const protocolMaximum = 999_999_999_999_999
    const sqliteMaximumFromJSON = JSON.parse('9223372036854775807') as number
    expect(parseTeamMessagesCapability({
      ...messagesCapability,
      attachments: {
        ...messagesCapability.attachments,
        max_bytes_per_file: protocolMaximum,
        max_bytes_per_message: 1,
        team_quota_bytes: 1
      }
    }).attachments).toMatchObject({
      max_bytes_per_file: protocolMaximum,
      max_bytes_per_message: 1,
      team_quota_bytes: 1
    })
    expect(parseTeamMessagesCapability({
      ...messagesCapability,
      attachments: { ...messagesCapability.attachments, team_quota_bytes: sqliteMaximumFromJSON }
    }).attachments.team_quota_bytes).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => parseTeamMessagesCapability({
      ...messagesCapability,
      attachments: { ...messagesCapability.attachments, max_bytes_per_file: protocolMaximum + 1 }
    })).toThrow('maximum attachment size')
    expect(() => parseTeamMessagesCapability({
      ...messagesCapability,
      attachments: { ...messagesCapability.attachments, max_bytes_per_message: 0 }
    })).toThrow('maximum total attachment size')
    expect(() => parseTeamMessagesCapability({
      ...messagesCapability,
      attachments: { ...messagesCapability.attachments, team_quota_bytes: 0 }
    })).toThrow('team attachment quota')
    expect(() => parseTeamMessageCreateInput({
      teamId: 'team-1',
      kind: 'skill',
      title: 'Runbook',
      body: '# Runbook',
      recipients: [{ kind: 'server', id: 'server-1' }],
      skill: { slug: 'runbook' },
      idempotencyKey: 'team-message-1'
    })).toThrow('recipients')
    const agentCapability = {
      available: true, version: 1, helper: 'team', mention_sigil: '@@', read_always: true,
      send_requires_mention: true, recipient_kinds: ['server', 'human', 'all'],
      reference_kinds: ['recipient', 'skill'], max_sends_per_run: 4,
      max_attachments_per_send: 16, max_body_bytes: 49_152
    }
    expect(parseAgentTeamMessagesCapability(agentCapability)).toEqual(agentCapability)
    expect(parseAgentTeamMessagesCapability({ ...agentCapability, required: false, message: 'ready', action: null }))
      .toMatchObject({ required: false, message: 'ready', action: null })
    expect(parseAgentTeamMessagesCapability({ ...agentCapability, available: false })).toMatchObject({ available: false })
    expect(() => parseAgentTeamMessagesCapability({ ...agentCapability, max_sends_per_run: 5 }))
      .toThrow('maximum sends')
    expect(parseTeamMessagePage({
      box: 'feed', address: null, messages: [], next_after_sequence: 0, has_more: false
    }, 'team-1')).toEqual({
      box: 'feed', address: null, messages: [], next_after_sequence: 0, has_more: false
    })
    expect(() => parseTeamMessagePage({
      box: 'feed', address: null, messages: [], next_after_sequence: null, has_more: true
    }, 'team-1'))
      .toThrow('sequence')
  })

  it('strictly parses and gates the AgentsServer Bulletin alias contract', () => {
    const alias = {
      available: true,
      required: false,
      version: 1,
      mention: '@@bulletin',
      legacy_mention: '@@all'
    } as const
    expect(parseTeamBulletinAliasCapability(alias)).toEqual(alias)
    expect(parseTeamBulletinAliasCapability({
      available: false,
      version: 1,
      mention: '@@bulletin',
      legacy_mention: '@@all'
    })).toEqual({ available: false, version: 1, mention: '@@bulletin', legacy_mention: '@@all' })
    expect(teamBulletinAliasAvailable({ ok: true, capabilities: { team_bulletin_alias_v1: alias } })).toBe(true)
    expect(teamBulletinAliasAvailable({
      ok: true,
      capabilities: { team_bulletin_alias_v1: { ...alias, available: false } }
    })).toBe(false)
    expect(teamBulletinAliasAvailable({ ok: true, capabilities: {} })).toBe(false)

    for (const malformed of [
      { ...alias, version: 2 },
      { ...alias, mention: '@@all' },
      { ...alias, legacy_mention: '@@everyone' },
      { ...alias, available: 'yes' },
      { ...alias, unexpected: true },
      { available: true, version: 1, mention: '@@bulletin' }
    ]) expect(() => parseTeamBulletinAliasCapability(malformed)).toThrow('Team Bulletin alias capability')
  })

  it('parses the final message, receipt, attachment, and skill wire projections exactly', () => {
    const createdAt = '2026-09-04T12:00:00Z'
    const sender = { kind: 'server', id: 'server-1', display_name: 'Studio' }
    const recipient = {
      kind: 'human', id: 'human-1', display_name: 'Pat', state: 'available',
      delivered_at: null, read_at: null
    }
    const messageBase = {
      id: 'message-1', sequence: 7, kind: 'message', title: null, body_format: 'markdown',
      body_bytes: 4, body_sha256: 'a'.repeat(64), sender, recipients: [recipient], attachments: [],
      in_reply_to_message_id: null, skill: null, provenance: { via: 'agent', backend: 'codex' },
      created_at: createdAt
    }
    const page = parseTeamMessagePage({
      box: 'inbox', address: { kind: 'human', id: 'human-1' },
      messages: [{ ...messageBase, preview: 'Body', delivery: recipient }],
      next_after_sequence: 7, has_more: false
    }, 'team-1')
    expect(page.messages[0]).toMatchObject({ team_id: 'team-1', preview: 'Body', delivery: recipient })
    expect('body' in page.messages[0]).toBe(false)

    const detail = parseTeamMessageResponse({
      message: { ...messageBase, body: 'Body', delivery: recipient, revision: { version: 2, versions_count: 2, edited_at: createdAt } }
    }, 'team-1').message
    expect(detail).toMatchObject({ team_id: 'team-1', body: 'Body', delivery: recipient, revision: { version: 2, versions_count: 2 } })
    expect(parseTeamMessageRevisionInput({
      teamId: 'team-1', messageId: 'message-1', body: 'Edited', expectedVersion: 2,
      idempotencyKey: 'revision-key'
    })).toMatchObject({ bodyFormat: 'markdown', expectedVersion: 2 })
    expect(parseTeamMessageResponse({
      message: { ...messageBase, title: 'Nightly status', body: 'Body', delivery: recipient }
    }, 'team-1').message).toMatchObject({
      kind: 'message', title: 'Nightly status', skill: null
    })
    expect(parseTeamMessageReceiptResponse({
      message_id: 'message-1',
      recipients: [{ ...recipient, state: 'read', delivered_at: createdAt, read_at: createdAt }]
    }).recipients).toHaveLength(1)

    const declared = parseTeamAttachmentDeclaration({
      attachment: {
        id: 'attachment-1', message_id: null, file_name: 'guide.md', media_type: 'text/markdown',
        byte_size: 4, sha256: 'b'.repeat(64), state: 'ready', received_bytes: 4,
        created_at: createdAt, ready_at: createdAt
      },
      chunk_bytes: 8 * 1024 * 1024
    }, 'team-1')
    expect(declared.attachment).toMatchObject({ team_id: 'team-1', state: 'ready', received_bytes: 4 })

    const skill = {
      id: 'skill-1', slug: 'runbook', title: 'Runbook', summary: 'How to operate', tags: ['ops'],
      version: 2, versions_count: 2, pinned: true, pinned_at: createdAt,
      archived: false, archived_at: null, author: sender, body_bytes: 4,
      current: { version: 2, message_id: 'message-2', change_note: 'Tighten steps', created_at: createdAt },
      created_at: createdAt, updated_at: createdAt, permissions: { edit: true, manage: true }
    }
    expect(parseTeamSkillPage({ skills: [skill] }, 'team-1').skills[0])
      .toMatchObject({ id: 'skill-1', team_id: 'team-1', versions_count: 2 })
    expect(parseTeamSkillDetails({
      skill: { ...skill, body: '# Go', body_format: 'markdown', attachments: [] }
    }, 'team-1').skill.body).toBe('# Go')

    const version = {
      version: 2, message_id: 'message-2', title: 'Runbook', summary: 'How to operate', tags: ['ops'],
      change_note: 'Tighten steps', author: sender, body_bytes: 4, attachments: [], created_at: createdAt
    }
    expect(parseTeamSkillVersionsPage({ skill_id: 'skill-1', versions: [version] }, 'team-1'))
      .toMatchObject({ skill_id: 'skill-1', versions: [{ team_id: 'team-1', skill_id: 'skill-1' }] })
    expect(parseTeamSkillVersionResponse({
      skill_id: 'skill-1', version: { ...version, body: '# Go', body_format: 'markdown' }
    }, 'team-1').version.body).toBe('# Go')

    expect(() => parseTeamMessageResponse({
      message: { ...messageBase, body: 'Body', team_id: 'wire-team-id' }
    }, 'team-1')).toThrow('Team Message')
  })

  it('keeps outgoing provenance strict while safely projecting beta.33 extension fields', () => {
    const provenance = { via: null, backend: null, chat_id: 'chat-1', run_id: null }
    const input = parseTeamMessageCreateInput({
      teamId: 'team-1', kind: 'message', body: 'Body', recipients: [{ kind: 'all' }],
      provenance, idempotencyKey: 'team-message-provenance'
    })
    expect(input.provenance).toEqual({ chat_id: 'chat-1' })
    expect(parseTeamMessageCreateInput({
      teamId: 'team-1', kind: 'message', body: 'Body', recipients: [{ kind: 'all' }],
      provenance: { via: 'desktop' }, idempotencyKey: 'team-message-desktop'
    }).provenance).toEqual({ via: 'desktop' })
    expect(() => parseTeamMessageCreateInput({
      teamId: 'team-1', kind: 'message', body: 'Body', recipients: [{ kind: 'all' }],
      provenance: { via: 'desktop', source: 'foreign' }, idempotencyKey: 'team-message-foreign'
    })).toThrow('provenance')

    const createdAt = '2026-09-04T12:00:00Z'
    const recipient = {
      kind: 'human', id: 'human-1', display_name: 'Pat', state: 'available',
      delivered_at: null, read_at: null
    }
    const message = {
      id: 'message-1', sequence: 7, kind: 'message', title: null, body_format: 'markdown',
      body: 'Body', body_bytes: 4, body_sha256: 'a'.repeat(64),
      sender: { kind: 'server', id: 'server-1', display_name: 'Studio' },
      recipients: [recipient], attachments: [], in_reply_to_message_id: null, skill: null,
      provenance, created_at: createdAt, delivery: recipient
    }
    expect(parseTeamMessageResponse({ message }, 'team-1').message.provenance).toEqual(provenance)
    expect(parseTeamMessageResponse({
      message: { ...message, provenance: { ...provenance, chat_id: 'c'.repeat(240), run_id: 'r'.repeat(240) } }
    }, 'team-1').message.provenance).toMatchObject({ chat_id: 'c'.repeat(240), run_id: 'r'.repeat(240) })
    expect(parseTeamMessageResponse({
      message: { ...message, provenance: { ...provenance, source: 'foreign' } }
    }, 'team-1').message.provenance).toEqual(provenance)
    expect(() => parseTeamMessageResponse({
      message: { ...message, provenance: { ...provenance, source: 'x'.repeat(201) } }
    }, 'team-1')).toThrow('provenance')
    expect(() => parseTeamMessageResponse({
      message: {
        ...message,
        provenance: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field-${index}`, 'value']))
      }
    }, 'team-1')).toThrow('provenance')
  })

  it('accepts beta.33 previews bounded by Unicode code points rather than UTF-16 units', () => {
    const createdAt = '2026-09-04T12:00:00Z'
    const preview = '🚀'.repeat(280)
    const message = {
      id: 'message-emoji', sequence: 8, kind: 'message', title: null, body_format: 'plain',
      preview, body_bytes: 4, body_sha256: 'a'.repeat(64),
      sender: { kind: 'server', id: 'server-1', display_name: 'Studio' },
      recipients: [{ kind: 'all', id: 'all', display_name: 'Everyone', state: 'available', delivered_at: null, read_at: null }],
      attachments: [], in_reply_to_message_id: null, skill: null, provenance: {}, created_at: createdAt
    }
    expect(parseTeamMessagePage({
      box: 'feed', address: null, messages: [message], next_after_sequence: 8, has_more: false
    }, 'team-1').messages[0].preview).toBe(preview)
    expect(() => parseTeamMessagePage({
      box: 'feed', address: null,
      messages: [{ ...message, preview: `${preview}🚀` }],
      next_after_sequence: 8,
      has_more: false
    }, 'team-1')).toThrow('preview')

    const pageWithControls = parseTeamMessagePage({
      box: 'feed', address: null,
      messages: [
        { ...message, id: 'message-controls', sequence: 9, preview: 'before\u0000middle\u007fafter' },
        message
      ],
      next_after_sequence: 9,
      has_more: false
    }, 'team-1')
    expect(pageWithControls.messages).toHaveLength(2)
    expect(pageWithControls.messages[0].preview).toBe('before\ufffdmiddle\ufffdafter')
  })

  it('uses Python code-point bounds for beta.33 response display and skill text', () => {
    const createdAt = '2026-09-04T12:00:00Z'
    const displayName = '🚀'.repeat(160)
    const title = '📘'.repeat(160)
    const summary = '🧪'.repeat(280)
    const changeNote = '✨'.repeat(280)
    const author = { kind: 'server', id: 'server-1', display_name: displayName }
    const skill = {
      id: 'skill-emoji', slug: 'emoji-runbook', title, summary, tags: ['ops'],
      version: 1, versions_count: 1, pinned: false, pinned_at: null,
      archived: false, archived_at: null, author, body_bytes: 4,
      current: { version: 1, message_id: 'message-emoji', change_note: changeNote, created_at: createdAt },
      created_at: createdAt, updated_at: createdAt, permissions: { edit: true, manage: true }
    }
    expect(parseTeamSkillPage({ skills: [skill] }, 'team-1').skills[0]).toMatchObject({
      title, summary, author, current: { change_note: changeNote }
    })

    const message = {
      id: 'message-emoji', sequence: 8, kind: 'skill', title, body_format: 'plain',
      body: 'Body', body_bytes: 4, body_sha256: 'a'.repeat(64), sender: author,
      recipients: [{ kind: 'all', id: 'all', display_name: 'Everyone', state: 'available', delivered_at: null, read_at: null }],
      attachments: [], in_reply_to_message_id: null,
      skill: { id: 'skill-emoji', slug: 'emoji-runbook', version: 1 },
      provenance: {}, created_at: createdAt
    }
    expect(parseTeamMessageResponse({ message }, 'team-1').message).toMatchObject({ title, sender: author })
    expect(() => parseTeamSkillPage({ skills: [{ ...skill, title: `${title}📘` }] }, 'team-1')).toThrow('title')
    expect(() => parseTeamSkillPage({ skills: [{ ...skill, summary: `${summary}🧪` }] }, 'team-1')).toThrow('summary')
    expect(() => parseTeamSkillPage({
      skills: [{ ...skill, current: { ...skill.current, change_note: `${changeNote}✨` } }]
    }, 'team-1')).toThrow('change note')
    expect(() => parseTeamMessageResponse({
      message: { ...message, sender: { ...author, display_name: `${displayName}🚀` } }
    }, 'team-1')).toThrow('name')
  })

  it('accepts beta.33 attachment response names and sizes without weakening upload input', () => {
    const createdAt = '2026-09-04T12:00:00Z'
    const protocolMaximum = 999_999_999_999_999
    const responseName = '🚀'.repeat(255)
    const wireAttachment = {
      id: 'attachment-large', message_id: null, file_name: responseName, media_type: 'video/mp4',
      byte_size: protocolMaximum, sha256: 'b'.repeat(64), state: 'ready',
      received_bytes: protocolMaximum, created_at: createdAt, ready_at: createdAt
    }
    expect(parseTeamAttachmentDeclaration({
      attachment: wireAttachment, chunk_bytes: 8 * 1024 * 1024
    }, 'team-1').attachment).toMatchObject({ file_name: responseName, byte_size: protocolMaximum })
    expect(() => parseTeamAttachmentDeclaration({
      attachment: { ...wireAttachment, file_name: `${responseName}🚀` },
      chunk_bytes: 8 * 1024 * 1024
    }, 'team-1')).toThrow('file name')
    expect(() => parseTeamAttachmentDeclaration({
      attachment: { ...wireAttachment, byte_size: protocolMaximum + 1, received_bytes: protocolMaximum + 1 },
      chunk_bytes: 8 * 1024 * 1024
    }, 'team-1')).toThrow('size')
    expect(() => parseTeamAttachmentDeclareInput({
      teamId: 'team-1', path: '/tmp/emoji-name', fileName: responseName,
      idempotencyKey: 'attachment-emoji-name'
    })).toThrow('file name')
  })

  it('strictly bounds renderer requests for a local attachment text preview', () => {
    const base = { teamId: 'team-1', attachmentId: 'attachment-1' }
    expect(parseTeamAttachmentCacheInput(base)).toEqual(base)
    expect(parseTeamAttachmentCacheInput({
      ...base, previewBytes: TEAM_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES
    })).toEqual({ ...base, previewBytes: TEAM_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES })
    expect(() => parseTeamAttachmentCacheInput({ ...base, previewBytes: 0 })).toThrow('preview size')
    expect(() => parseTeamAttachmentCacheInput({
      ...base, previewBytes: TEAM_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES + 1
    })).toThrow('preview size')
    expect(() => parseTeamAttachmentCacheInput({ ...base, previewBytes: 1.5 })).toThrow('preview size')
    expect(() => parseTeamAttachmentCacheInput({ ...base, previewBytes: '512' })).toThrow('preview size')
    expect(() => parseTeamAttachmentCacheInput({ ...base, previewBytes: 1, cors: true }))
      .toThrow('cache request')
    expect(teamAttachmentSupportsTextPreview({ file_name: 'notes.bin', media_type: 'text/plain' })).toBe(true)
    expect(teamAttachmentSupportsTextPreview({ file_name: 'runbook.JSON', media_type: 'application/octet-stream' })).toBe(true)
    expect(teamAttachmentSupportsTextPreview({ file_name: 'archive.zip', media_type: 'application/zip' })).toBe(false)
  })

  it('rejects attachment file names with surrounding whitespace before upload', () => {
    const input = {
      teamId: 'team-1', path: '/tmp/demo.mp4', fileName: 'demo.mp4',
      idempotencyKey: 'attachment-demo'
    }
    expect(parseTeamAttachmentDeclareInput(input).fileName).toBe('demo.mp4')
    expect(() => parseTeamAttachmentDeclareInput({ ...input, fileName: ' demo.mp4' })).toThrow('file name')
    expect(() => parseTeamAttachmentDeclareInput({ ...input, fileName: 'demo.mp4 ' })).toThrow('file name')
    expect(() => parseTeamAttachmentDeclareInput({ ...input, fileName: 'folder/demo.mp4' })).toThrow('file name')
    expect(() => parseTeamAttachmentDeclareInput({ ...input, fileName: 'folder\\demo.mp4' })).toThrow('file name')
  })

  it('accepts native absolute attachment paths on POSIX and Windows', () => {
    const input = {
      teamId: 'team-1', fileName: 'demo.mp4', idempotencyKey: 'attachment-native-path'
    }
    expect(parseTeamAttachmentDeclareInput({ ...input, path: '/tmp/demo.mp4' }).path).toBe('/tmp/demo.mp4')
    expect(parseTeamAttachmentDeclareInput({ ...input, path: 'C:\\Users\\Agent\\demo.mp4' }).path)
      .toBe('C:\\Users\\Agent\\demo.mp4')
    expect(parseTeamAttachmentDeclareInput({ ...input, path: '\\\\studio\\Team Share\\demo.mp4' }).path)
      .toBe('\\\\studio\\Team Share\\demo.mp4')
    expect(() => parseTeamAttachmentDeclareInput({ ...input, path: 'C:demo.mp4' })).toThrow('path')
    expect(() => parseTeamAttachmentDeclareInput({ ...input, path: '\\demo.mp4' })).toThrow('path')
  })

  it('accepts only the passive capability and rejects dispatch or attachment drift', () => {
    expect(parseTeamNetworkCapabilities(capability)).toEqual(capability)
    expect(() => parseTeamNetworkCapabilities({ ...capability, dispatch: true })).toThrow('capability')
    expect(() => parseTeamNetworkCapabilities({ ...capability, skill_attachments: true })).toThrow('capability')
    expect(() => parseTeamNetworkCapabilities({ ...capability, channels: true })).toThrow('capability')
    expect(() => parseTeamNetworkCapabilities({ ...capability, max_agents_per_server: 255 })).toThrow('capability')
    expect(() => parseTeamNetworkCapabilities({ ...capability, max_agents_per_server: 257 })).toThrow('Maximum agents per server')
    expect(() => parseTeamNetworkCapabilities({ ...capability, max_agents_per_server: 256.5 })).toThrow('Maximum agents per server')
    const { max_agents_per_server: _omitted, ...missingLimit } = capability
    expect(() => parseTeamNetworkCapabilities(missingLimit)).toThrow('capability')
  })

  it('rejects unknown renderer fields and enforces UTF-8 body bytes', () => {
    expect(() => parseTeamNetworkPostBulletinInput({
      teamId: 'team-1', body: 'hello', idempotencyKey: 'idem-key', dispatch: true
    })).toThrow('Bulletin post')
    expect(() => parseTeamNetworkCreatePassiveRequestInput({
      teamId: 'team-1', to: { kind: 'server', id: 'server-1' },
      body: '\ud800', idempotencyKey: 'request-key'
    })).toThrow('body')
    expect(() => parseTeamNetworkPostBulletinInput({
      teamId: 'team-1', body: '\ud83d\ude42'.repeat(16_385), idempotencyKey: 'bulletin-key'
    })).toThrow('body')
  })

  it('strictly validates logical server and agent projection records', () => {
    const projection = {
      network: { id: 'team-1', display_name: 'Studio', hub_id: 'hub-1' },
      servers: [{
        id: 'server-1', server_identity: 'identity-1', display_name: 'Studio',
        status: 'active', is_host: true, owned_by_caller: true
      }],
      agents: [{
        id: 'agent-1', server_id: 'server-1', external_agent_id: 'chat-1',
        backend: 'codex', display_name: 'Georgia', status: 'active'
      }],
      next_after_server_id: 'server-1',
      has_more: false
    }
    expect(parseTeamNetworkProjection(projection)).toEqual(projection)
    expect(parseTeamNetworkProjection({
      ...projection,
      servers: [{ ...projection.servers[0], recipient_display_name: 'Pat' }]
    })).toMatchObject({ servers: [{ display_name: 'Studio', recipient_display_name: 'Pat' }] })
    expect(() => parseTeamNetworkProjection({
      ...projection,
      servers: [{ ...projection.servers[0], recipient_display_name: '' }]
    })).toThrow(/server recipient name/i)
    expect(() => parseTeamNetworkProjection({
      ...projection,
      next_after_server_id: null
    })).toThrow('continuation')
    expect(() => parseTeamNetworkProjection({
      ...projection,
      servers: [], agents: [], next_after_server_id: null, has_more: true
    })).toThrow('continuation')
    expect(parseTeamNetworkProjection({
      ...projection,
      agents: Array.from({ length: 256 }, (_, index) => ({
        ...projection.agents[0], id: `agent-${index}`, external_agent_id: `chat-${index}`
      }))
    }).agents).toHaveLength(256)
    expect(parseTeamNetworkProjection({
      ...projection,
      servers: [{ ...projection.servers[0], status: 'suspended', owned_by_caller: false }],
      agents: [{ ...projection.agents[0], status: 'offline' }]
    })).toMatchObject({ servers: [{ status: 'suspended' }], agents: [{ status: 'offline' }] })
    expect(() => parseTeamNetworkProjection({
      ...projection,
      servers: [{ ...projection.servers[0], certificate: 'hidden' }]
    })).toThrow('server')
    expect(parseTeamNetworkProjectionQuery({ teamId: 'team-1', afterServerId: 'server-1', limit: 25 })).toEqual({
      teamId: 'team-1', afterServerId: 'server-1', limit: 25
    })
    expect(() => parseTeamNetworkProjectionQuery({ teamId: 'team-1', afterServerId: null })).toThrow('cursor')
    expect(() => parseTeamNetworkProjectionQuery({ teamId: 'team-1', limit: 101 })).toThrow('page size')
  })

  it('requires mailbox kind/request/expiry and receipt state timelines to agree', () => {
    const entry = {
      item: {
        id: 'item-1', sequence: 1, kind: 'message',
        from: { kind: 'human', id: 'human-1', display_name: 'Owner' },
        to: { kind: 'server', id: 'server-1', server_identity: 'identity-1', display_name: 'Studio' },
        body_format: 'markdown', body: 'Hello', request_id: null,
        created_at: '2026-08-24T12:00:00Z', expires_at: null
      },
      delivery: {
        id: 'delivery-1', state: 'available', available_at: '2026-08-24T12:00:00Z',
        delivered_at: null, read_at: null
      }
    }
    expect(parseTeamNetworkMailboxEntry(entry)).toEqual(entry)
    expect(() => parseTeamNetworkMailboxEntry({
      ...entry,
      item: { ...entry.item, kind: 'request', request_id: 'item-1' }
    })).toThrow('expiry')
    expect(() => parseTeamNetworkMailboxEntry({
      ...entry,
      delivery: { ...entry.delivery, state: 'read', delivered_at: null, read_at: '2026-08-24T12:01:00Z' }
    })).toThrow('timeline')
    expect(parseTeamNetworkMailboxQuery({
      teamId: 'team-1', address: { kind: 'human', id: 'human-1' }
    })).toMatchObject({ teamId: 'team-1', address: { kind: 'human', id: 'human-1' } })
    expect(() => parseTeamNetworkSendMailboxInput({
      teamId: 'team-1', to: { kind: 'human', id: 'human-1' }, body: 'No direct human sends', idempotencyKey: 'mail-key'
    })).toThrow('address kind')
  })
})
