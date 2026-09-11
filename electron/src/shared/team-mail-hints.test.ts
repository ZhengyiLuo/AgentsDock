import { describe, expect, it, vi } from 'vitest'
import {
  applyMailArrivalHint, applyMailPageCoverage, beginMailHintStream,
  mailHintPending, mailHintRealmKey, parseMailArrivalCursor,
  parseMailArrivalHint, parseMailboxCoverage,
  type MailArrivalCursor, type MailHintScope
} from './team-mail-hints'

const scope: MailHintScope = {
  profileId: 'profile-studio', profileGeneration: 2, streamId: 'stream-one',
  serverIdentity: 'server-studio', hubId: 'hub-team', teamId: 'team-one', recipientServerId: 'node-studio'
}
const messageId = (label: string) => `tmsg_${Array.from(label).map(char => char.charCodeAt(0).toString(16)).join('').padEnd(32, '0').slice(0, 32)}`
const at = (through_sequence: number, arrival_id: string | null = through_sequence ? messageId(String(through_sequence)) : null): MailArrivalCursor => ({ through_sequence, arrival_id })
const coverage = (sequence: number, arrivalId?: string | null) => ({
  version: 1, team_id: scope.teamId, recipient_server_id: scope.recipientServerId, ...at(sequence, arrivalId)
})
const hint = (sequence: number, reset = false, arrivalId?: string | null) => ({ ...coverage(sequence, arrivalId), reset })
const initial = (sequence = 0) => applyMailArrivalHint(beginMailHintStream(scope), scope, 'snapshot', hint(sequence))

describe('Mail hint metadata boundary', () => {
  it('accepts only bounded recipient identifiers and precise immutable arrival cursors', () => {
    expect(parseMailArrivalCursor(at(0))).toEqual(at(0))
    expect(parseMailArrivalHint(hint(Number.MAX_SAFE_INTEGER))).toEqual(hint(Number.MAX_SAFE_INTEGER))
    expect(parseMailboxCoverage(coverage(7))).toEqual(coverage(7))
    for (const raw of [at(-1), at(1.5), at(Number.MAX_SAFE_INTEGER + 1), at(0, 'tmsg_bad'), at(2, null), at(2, ''), at(2, 'a'.repeat(241))]) {
      expect(() => parseMailArrivalCursor(raw)).toThrow()
    }
    for (const raw of [null, [], { ...hint(1), version: 2 }, { ...hint(1), reset: 1 },
      { ...hint(1), recipient_server_id: 'bad\nidentifier' }, { ...hint(1), team_id: '' }]) {
      expect(() => parseMailArrivalHint(raw)).toThrow()
    }
  })

  it('rejects subjects, bodies, credentials, recipients and any other payload expansion', () => {
    for (const name of ['body', 'subject', 'token', 'authority', 'recipients', 'sender_display_name']) {
      expect(() => parseMailArrivalHint({ ...hint(2), [name]: 'private' })).toThrow()
      expect(() => parseMailboxCoverage({ ...coverage(2), [name]: 'private' })).toThrow()
    }
    expect(() => parseMailboxCoverage(hint(2))).toThrow()
  })

  it('does not accept a trailing line terminator through a JavaScript end anchor', () => {
    for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      for (const field of ['team_id', 'recipient_server_id', 'arrival_id'] as const) {
        const packet = hint(2)
        expect(() => parseMailArrivalHint({ ...packet, [field]: packet[field] + suffix })).toThrow()
      }
      for (const field of ['profileId', 'streamId', 'serverIdentity', 'hubId', 'teamId', 'recipientServerId'] as const) {
        expect(() => beginMailHintStream({ ...scope, [field]: scope[field] + suffix })).toThrow()
      }
    }
  })

  it('persists by stable realm, never transient stream or profile generation', () => {
    expect(mailHintRealmKey(scope)).toBe(mailHintRealmKey({ ...scope, streamId: 'reconnected', profileGeneration: 5 }))
    for (const field of ['profileId', 'serverIdentity', 'hubId', 'teamId', 'recipientServerId'] as const) {
      expect(mailHintRealmKey(scope)).not.toBe(mailHintRealmKey({ ...scope, [field]: 'different' }))
    }
    expect(() => beginMailHintStream({ ...scope, profileGeneration: -1 })).toThrow()
    expect(() => beginMailHintStream({ ...scope, streamId: '' })).toThrow()
  })
})

describe('passive Mail hint state', () => {
  it('does not acknowledge arrivals merely because they were received', () => {
    let state = initial()
    state = applyMailArrivalHint(state, scope, 'hint', hint(9))
    expect(mailHintPending(state)).toBe(true)
    expect(state.seen).toEqual(at(0))
    expect(state.initialized).toBe(true)
  })

  it('retains one scalar and returns the identical state for duplicates and older hints', () => {
    const state = initial(9)
    for (let index = 0; index < 10_000; index++) {
      expect(applyMailArrivalHint(state, scope, 'hint', hint(index % 10))).toBe(state)
    }
    expect(Object.keys(state)).not.toContain('events')
  })

  it('buffers an early newer hint across a late bootstrap snapshot', () => {
    let state = beginMailHintStream(scope)
    state = applyMailArrivalHint(state, scope, 'hint', hint(900))
    state = applyMailArrivalHint(state, scope, 'snapshot', hint(400))
    expect(state.latest).toEqual(at(900))
    expect(mailHintPending(state)).toBe(true)
    expect(state.invalid).toBe(false)
  })

  it('records fresh page coverage before any hint arrives', () => {
    let state = beginMailHintStream(scope)
    state = applyMailPageCoverage(state, scope, at(0), coverage(100))
    state = applyMailArrivalHint(state, scope, 'snapshot', hint(40))
    state = applyMailArrivalHint(state, scope, 'hint', hint(100))
    expect(state.seen).toEqual(at(100))
    expect(state.invalid).toBe(false)
    expect(mailHintPending(state)).toBe(false)
  })

  it('accepts an anchored later page that completed ahead of the initial snapshot callback', () => {
    let state = beginMailHintStream(scope, at(50))
    state = applyMailPageCoverage(state, scope, at(50), coverage(110))
    state = applyMailArrivalHint(state, scope, 'snapshot', hint(90))
    expect(state.seen).toEqual(at(110))
    expect(state.invalid).toBe(false)
    expect(mailHintPending(state)).toBe(false)
  })

  it('cannot clear a 900 arrival with a capped page ending at 400', () => {
    let state = initial(900)
    state = applyMailPageCoverage(state, scope, at(0), coverage(400))
    expect(state.seen).toEqual(at(400))
    expect(mailHintPending(state)).toBe(true)
    state = applyMailPageCoverage(state, scope, at(400), coverage(900))
    expect(mailHintPending(state)).toBe(false)
  })

  it('does not acknowledge a disconnected page range', () => {
    const state = initial(900)
    expect(applyMailPageCoverage(state, scope, at(400), coverage(900))).toBe(state)
    expect(mailHintPending(state)).toBe(true)
  })

  it('keeps newer coverage when an older request completes later', () => {
    let state = initial(900)
    state = applyMailPageCoverage(state, scope, at(0), coverage(900))
    expect(applyMailPageCoverage(state, scope, at(0), coverage(400))).toBe(state)
    state = applyMailArrivalHint(state, scope, 'hint', hint(1000))
    state = applyMailPageCoverage(state, scope, at(0), coverage(900))
    expect(mailHintPending(state)).toBe(true)
  })

  it('allows authoritative deleted/empty Inbox catchup without a receipt write', () => {
    const state = applyMailPageCoverage(initial(900), scope, at(0), coverage(900))
    expect(mailHintPending(state)).toBe(false)
    expect(state.seen).toEqual(at(900))
  })

  it.each(['profileId', 'profileGeneration', 'streamId', 'serverIdentity', 'hubId', 'teamId', 'recipientServerId'] as const)(
    'fences delayed events and pages after %s changes', field => {
      const changed = { ...scope, [field]: field === 'profileGeneration' ? 3 : 'different' }
      const state = initial(900)
      expect(applyMailArrivalHint(state, changed, 'hint', hint(1000))).toBe(state)
      expect(applyMailPageCoverage(state, changed, at(0), coverage(900))).toBe(state)
    }
  )

  it('fails closed for another mailbox claimed within the current transport', () => {
    let state = initial(900)
    state = applyMailArrivalHint(state, scope, 'hint', { ...hint(1000), recipient_server_id: 'node-other' })
    expect(state.invalid).toBe(true)
    expect(state.latest).toEqual(at(900))
    expect(applyMailPageCoverage(state, scope, at(0), coverage(900))).toBe(state)
    expect(mailHintPending(state)).toBe(true)
  })

  it('rejects contradictory arrival identities, invalid coverage and unsolicited resets', () => {
    const state = initial(900)
    expect(applyMailArrivalHint(state, scope, 'hint', hint(900, false, messageId('other'))).invalid).toBe(true)
    expect(applyMailArrivalHint(state, scope, 'hint', hint(100, true)).invalid).toBe(true)
    expect(applyMailArrivalHint(state, scope, 'snapshot', hint(900)).invalid).toBe(true)
    expect(applyMailPageCoverage(state, scope, at(800), coverage(400)).invalid).toBe(true)
    const seen = applyMailPageCoverage(state, scope, at(0), coverage(900))
    expect(applyMailPageCoverage(seen, scope, at(900, messageId('other')), coverage(1000)).invalid).toBe(true)
  })

  it('retains pending arrivals offline, then replaces stale connection watermarks on reset', () => {
    const next = { ...scope, streamId: 'reconnected' }
    let state = beginMailHintStream(next, at(800), initial(900))
    expect(mailHintPending(state)).toBe(true)
    state = applyMailArrivalHint(state, next, 'snapshot', hint(400, true))
    expect(state.seen).toEqual(at(0))
    expect(state.latest).toEqual(at(400))
    expect(state.offlineLatest).toBeNull()
    expect(state.invalid).toBe(false)
    expect(mailHintPending(state)).toBe(true)
  })

  it('retains the greatest offline arrival across repeated reconnects before a snapshot', () => {
    const secondScope = { ...scope, streamId: 'stream-two' }
    const thirdScope = { ...scope, streamId: 'stream-three' }
    const previous = applyMailPageCoverage(initial(900), scope, at(0), coverage(880))
    let state = beginMailHintStream(secondScope, previous.seen, previous)
    state = applyMailArrivalHint(state, secondScope, 'hint', hint(850))
    expect(mailHintPending(state)).toBe(true)
    state = beginMailHintStream(thirdScope, state.seen, state)
    expect(state.offlineLatest).toEqual(at(900))
    expect(mailHintPending(state)).toBe(true)
  })

  it('handles restored data that reused a sequence or advanced past the retained cursor', () => {
    for (const sequence of [800, 1000]) {
      let state = beginMailHintStream(scope, at(800, messageId('old')))
      state = applyMailArrivalHint(state, scope, 'snapshot', hint(sequence, true, messageId('restored')))
      expect(state.seen).toEqual(at(0))
      expect(state.invalid).toBe(false)
      expect(mailHintPending(state)).toBe(true)
    }
  })

  it('preserves a fresh new-stream prefix on reset but discards pages rooted in the old cursor', () => {
    let state = beginMailHintStream(scope, at(800, messageId('old')))
    state = applyMailPageCoverage(state, scope, at(0), coverage(400))
    state = applyMailArrivalHint(state, scope, 'snapshot', hint(400, true))
    expect(state.seen).toEqual(at(400))
    expect(mailHintPending(state)).toBe(false)
    let staleRoot = beginMailHintStream(scope, at(800, messageId('old')))
    staleRoot = applyMailPageCoverage(staleRoot, scope, at(800, messageId('old')), coverage(1000))
    staleRoot = applyMailArrivalHint(staleRoot, scope, 'snapshot', hint(1000, true))
    expect(staleRoot.seen).toEqual(at(0))
    expect(mailHintPending(staleRoot)).toBe(true)
  })

  it('preserves newly reviewed data when restore reused the exact old sequence', () => {
    let state = beginMailHintStream(scope, at(800, messageId('old')))
    state = applyMailPageCoverage(state, scope, at(0), coverage(800, messageId('new')))
    state = applyMailArrivalHint(state, scope, 'snapshot', hint(800, true, messageId('new')))
    expect(state.seen).toEqual(at(800, messageId('new')))
    expect(state.invalid).toBe(false)
    expect(mailHintPending(state)).toBe(false)
  })

  it('checks immutable current-stream cursor identity in both hint/page orders', () => {
    const oldId = messageId('old')
    const otherId = messageId('other')
    const snap = applyMailArrivalHint(beginMailHintStream(scope), scope, 'snapshot', hint(900, false, oldId))
    expect(applyMailPageCoverage(snap, scope, at(0), coverage(900, otherId)).invalid).toBe(true)
    expect(applyMailPageCoverage(snap, scope, at(900, otherId), coverage(1000)).invalid).toBe(true)
    const earlyPage = applyMailPageCoverage(beginMailHintStream(scope), scope, at(0), coverage(800, oldId))
    expect(applyMailArrivalHint(earlyPage, scope, 'hint', hint(800, false, otherId)).invalid).toBe(true)
    expect(applyMailPageCoverage(beginMailHintStream(scope), scope, at(400, oldId), coverage(400, otherId)).invalid).toBe(true)
  })

  it('retains conflicting offline pending through another reconnect until a snapshot resolves it', () => {
    const oldId = messageId('old')
    const restoredId = messageId('restored')
    const original = applyMailArrivalHint(beginMailHintStream(scope), scope, 'snapshot', hint(900, false, oldId))
    const second = { ...scope, streamId: 'second' }
    const third = { ...scope, streamId: 'third' }
    let state = beginMailHintStream(second, at(800), original)
    state = applyMailPageCoverage(state, second, at(0), coverage(900, restoredId))
    state = applyMailArrivalHint(state, second, 'hint', hint(900, false, restoredId))
    expect(mailHintPending(state)).toBe(true)
    state = beginMailHintStream(third, state.seen, state)
    expect(state.offlineLatest).toEqual(at(900, oldId))
    expect(mailHintPending(state)).toBe(true)
    // Saved seen900/restored remains a valid anchor in the current data.
    state = applyMailArrivalHint(state, third, 'snapshot', hint(900, false, restoredId))
    expect(state.invalid).toBe(false)
    expect(mailHintPending(state)).toBe(false)
  })

  it('does not carry another realm\'s pending arrivals into a new profile', () => {
    const changed = { ...scope, profileId: 'profile-other', streamId: 'different' }
    const state = beginMailHintStream(changed, at(0), initial(900))
    expect(state.latest).toBeNull()
    expect(state.offlineLatest).toBeNull()
    expect(mailHintPending(state)).toBe(false)
  })

  it('has no timer or network side effects while accepting a burst', () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const interval = vi.spyOn(globalThis, 'setInterval')
    const fetcher = vi.spyOn(globalThis, 'fetch')
    try {
      let state = initial()
      for (let sequence = 1; sequence <= 1000; sequence++) state = applyMailArrivalHint(state, scope, 'hint', hint(sequence))
      expect(state.latest).toEqual(at(1000))
      expect(timer).not.toHaveBeenCalled()
      expect(interval).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      timer.mockRestore(); interval.mockRestore(); fetcher.mockRestore()
    }
  })
})
