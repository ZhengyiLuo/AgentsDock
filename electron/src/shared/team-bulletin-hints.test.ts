import { describe, expect, it } from 'vitest'
import { acknowledgeBulletinHint, applyBulletinHint, bulletinHintPending, emptyBulletinCursor,
  parseBulletinHint, parseTeamActivityHintPacket, parseTeamActivityHintsCapability, TEAM_ACTIVITY_HINTS_PROTOCOL,
  type BulletinChangeHint } from './team-bulletin-hints'
import { TEAM_MAIL_HINTS_PATH, type MailHintScope } from './team-mail-hints'

const scope: MailHintScope = { profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a', hubId: 'hub-a',
  teamId: 'team-a', recipientServerId: 'node-a', streamId: 'a'.repeat(32) }
const hint = (seq: number, reset = false): BulletinChangeHint => ({ version: 1, team_id: 'team-a', through_sequence: seq,
  change_id: `bchg_${seq.toString(16).padStart(32, '0')}`, message_id: `tmsg_${'a'.repeat(32)}`,
  change_kind: seq > 1 ? 'revised' : 'created', message_version: seq, reset })
const initial = (seq = 1) => applyBulletinHint(null, scope, 'snapshot', hint(seq), emptyBulletinCursor('team-a'))

describe('quiet independent Bulletin cursors', () => {
  it('accepts exact v2 capability and normalizes both heads without changing Mail semantics', () => {
    const capability = { enabled: true, version: 2, websocket_path: TEAM_MAIL_HINTS_PATH, websocket_protocol: TEAM_ACTIVITY_HINTS_PROTOCOL,
      mailbox_coverage: true, bulletin_coverage: true, mailbox: { hub_id: 'hub-a', team_id: 'team-a', recipient_server_id: null } }
    expect(parseTeamActivityHintsCapability(capability)).toEqual(capability)
    expect(() => parseTeamActivityHintsCapability({ ...capability, websocket_path: `${TEAM_MAIL_HINTS_PATH}?token=secret` })).toThrow()
    const mail = { version: 1, team_id: 'team-a', recipient_server_id: 'node-a', through_sequence: 0, arrival_id: null, reset: false }
    const packet = { type: 'snapshot', server_identity: 'server-a', hub_id: 'hub-a', stream_id: scope.streamId,
      cursor: { version: 2, mail, bulletin: hint(1) } }
    expect(parseTeamActivityHintPacket(packet)).toEqual({ ...packet, cursor: mail, bulletin: hint(1) })
    expect(() => parseTeamActivityHintPacket({ ...packet, body: 'not metadata' })).toThrow()
  })
  it('retains later arrivals when a refresh acknowledges its captured older head', () => {
    const first = initial()
    const capture = { scope, cursor: first.latest }
    const later = applyBulletinHint(first, scope, 'hint', hint(2), first.seen)
    const covered = acknowledgeBulletinHint(later, capture)
    expect(covered.seen.through_sequence).toBe(1)
    expect(bulletinHintPending(covered)).toBe(true)
    expect(bulletinHintPending(acknowledgeBulletinHint(covered, { scope, cursor: covered.latest }))).toBe(false)
  })
  it('deduplicates and coalesces into one scalar, with no event backlog', () => {
    const state = initial(10)
    for (let index = 1; index <= 10_000; index++) {
      expect(applyBulletinHint(state, scope, 'hint', hint(index % 9 + 1), state.seen)).toBe(state)
    }
    expect(Object.keys(state)).toEqual(['scope', 'seen', 'latest'])
  })
  it('rejects malformed kinds, scope, secrets, contradictory identities and stale acknowledgments', () => {
    for (const change_kind of [['created'], 1, {}, 'other']) expect(() => parseBulletinHint({ ...hint(1), change_kind })).toThrow()
    for (const key of ['body', 'subject', 'token', 'recipients', 'sender']) expect(() => parseBulletinHint({ ...hint(1), [key]: 'secret' })).toThrow()
    const state = initial()
    expect(() => applyBulletinHint(state, scope, 'hint', { ...hint(1), change_id: `bchg_${'b'.repeat(32)}` }, state.seen)).toThrow()
    expect(() => applyBulletinHint(state, scope, 'hint', { ...hint(2), team_id: 'foreign' }, state.seen)).toThrow()
    for (const field of ['profileId', 'profileGeneration', 'serverIdentity', 'hubId', 'teamId', 'recipientServerId', 'streamId'] as const) {
      expect(acknowledgeBulletinHint(state, { scope: { ...scope, [field]: field === 'profileGeneration' ? 2 : 'other' }, cursor: state.latest })).toBe(state)
    }
  })
  it('resets only on authenticated reconnect and refuses to subtract unseen updates', () => {
    const state = acknowledgeBulletinHint(initial(5), { scope, cursor: initial(5).latest })
    const resumed = applyBulletinHint(state, { ...scope, streamId: 'b'.repeat(32) }, 'snapshot', hint(2, true), state.seen)
    expect(resumed.seen.through_sequence).toBe(0)
    expect(bulletinHintPending(resumed)).toBe(true)
    expect(() => applyBulletinHint(state, scope, 'hint', hint(2, true), state.seen)).toThrow()
    expect(acknowledgeBulletinHint(resumed, { scope: resumed.scope, cursor: state.latest })).toBe(resumed)
  })
})
