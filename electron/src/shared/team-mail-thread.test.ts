import { describe, expect, it } from 'vitest'
import { parseTeamMailThreadsCapability, parseTeamMessageThreadPage, parseTeamMessageThreadQuery } from './team-network'

const query = { teamId: 'team-1', messageId: 'mail-1' }
const capability = { available: true, version: 1, max_page_items: 25, max_thread_items: 2048 }
const recipient = { kind: 'server', id: 'server-2', display_name: 'Recipient', state: 'available', delivered_at: null, read_at: null }
function message(id = 'mail-1', sequence = 1) {
  return { id, sequence, kind: 'message', title: 'Subject', body: 'Hello', body_format: 'markdown',
    body_bytes: 5, body_sha256: 'a'.repeat(64), sender: { kind: 'server', id: 'server-1', display_name: 'Sender' },
    recipients: [recipient], attachments: [], in_reply_to_message_id: sequence === 1 ? null : 'mail-1',
    skill: null, provenance: {}, created_at: '2026-09-10T12:00:00Z' }
}
function page() {
  return { team_id: query.teamId, anchor_message_id: query.messageId, root_message_id: 'mail-1',
    messages: [message(), message('mail-2', 2)], next_after_sequence: 2, has_more: false, truncated: false }
}

describe('Team Mail thread contract', () => {
  it('defaults to one bounded page and accepts only integral 1..25 limits and safe cursors', () => {
    expect(parseTeamMessageThreadQuery(query)).toEqual({ ...query, afterSequence: 0, limit: 25 })
    for (const limit of [1, 25]) expect(parseTeamMessageThreadQuery({ ...query, limit }).limit).toBe(limit)
    for (const limit of [0, 26, 1.5, true, '2', null]) {
      expect(() => parseTeamMessageThreadQuery({ ...query, limit })).toThrow()
    }
    for (const afterSequence of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, true]) {
      expect(() => parseTeamMessageThreadQuery({ ...query, afterSequence })).toThrow()
    }
    expect(() => parseTeamMessageThreadQuery({ ...query, unknown: true })).toThrow()
  })

  it('preserves exact parent-linked full messages and explicit incomplete history without guessing by subject or text', () => {
    const result = parseTeamMessageThreadPage({ ...page(), truncated: true }, query)
    expect(result.messages.map(item => [item.id, item.team_id, item.body])).toEqual([
      ['mail-1', 'team-1', 'Hello'], ['mail-2', 'team-1', 'Hello']
    ])
    expect(result.messages[1].in_reply_to_message_id).toBe('mail-1')
    expect(result.truncated).toBe(true)
    expect(result.has_more).toBe(false)
    expect(parseTeamMessageThreadPage({ ...page(), messages: [], next_after_sequence: 2 }, { ...query, afterSequence: 2 }).messages).toEqual([])
  })

  it('rejects foreign identity, duplicated/unordered rows, invalid continuation, and oversized pages', () => {
    const invalid = [
      { team_id: 'foreign-team' }, { anchor_message_id: 'foreign-mail' }, { root_message_id: '' },
      { messages: [message(), { ...message('mail-2', 2), team_id: 'foreign-team' }] },
      { messages: [message(), message('mail-1', 2)] },
      { messages: [message('mail-2', 2), message()] },
      { messages: [message(), message('mail-2', 1)] },
      { next_after_sequence: 3 }, { messages: [], next_after_sequence: 0, has_more: true },
      { truncated: 'false' }, { unknown: true }
    ]
    for (const value of invalid) expect(() => parseTeamMessageThreadPage({ ...page(), ...value }, query)).toThrow()
    expect(() => parseTeamMessageThreadPage(page(), { ...query, limit: 1 })).toThrow()
    expect(() => parseTeamMessageThreadPage(page(), { ...query, afterSequence: 1 })).toThrow()
  })

  it('rejects Bulletin and skill rows while allowing frozen all-server Mail recipients', () => {
    const bulletin = { ...message(), recipients: [{ ...recipient, kind: 'all', id: 'all' }] }
    for (const row of [bulletin, { ...bulletin, kind: 'skill', skill: { id: 'skill-1', slug: 'test', version: 1 } }]) {
      expect(() => parseTeamMessageThreadPage({ ...page(), messages: [row], next_after_sequence: 1 }, query)).toThrow()
    }
    const row = { ...message(), destination: 'all_servers' }
    expect(parseTeamMessageThreadPage({ ...page(), messages: [row], next_after_sequence: 1 }, query).messages[0].destination).toBe('all_servers')
  })

  it('requires the exact negotiated optional capability', () => {
    expect(parseTeamMailThreadsCapability(capability)).toEqual(capability)
    for (const value of [undefined, null, { ...capability, version: 2 }, { ...capability, max_page_items: 100 },
      { ...capability, available: false }, { ...capability, extra: true }]) {
      expect(() => parseTeamMailThreadsCapability(value)).toThrow()
    }
  })
})
