import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamMailHintController } from './team-mail-hint-controller'
import { bulletinHintPending, TEAM_ACTIVITY_HINTS_PROTOCOL, type TeamActivityHintPacket } from '../shared/team-bulletin-hints'
import { mailHintPending, TEAM_MAIL_HINTS_PATH, TEAM_MAIL_HINTS_PROTOCOL } from '../shared/team-mail-hints'
import type { AgentServerClient } from './server-client'

const capability = { enabled: true, version: 1, websocket_path: TEAM_MAIL_HINTS_PATH, websocket_protocol: TEAM_MAIL_HINTS_PROTOCOL,
  mailbox_coverage: true, mailbox: { hub_id: 'hub-a', team_id: 'team-a', recipient_server_id: 'node-a' } }
const activity = { ...capability, version: 2, websocket_protocol: TEAM_ACTIVITY_HINTS_PROTOCOL, bulletin_coverage: true }
const frame = (seq: number, type: 'snapshot' | 'hint' = 'hint'): TeamActivityHintPacket => ({ type,
  server_identity: 'server-a', hub_id: 'hub-a', stream_id: 'a'.repeat(32),
  cursor: { version: 1, team_id: 'team-a', recipient_server_id: 'node-a', through_sequence: 0, arrival_id: null, reset: false },
  bulletin: { version: 1, team_id: 'team-a', through_sequence: seq, change_id: `bchg_${seq.toString(16).padStart(32, '0')}`,
    message_id: `tmsg_${'a'.repeat(32)}`, change_kind: 'created', message_version: 1, reset: false }
})
function setup(v2 = true) {
  vi.useFakeTimers()
  const preferences = new Map<string, unknown>()
  const put = vi.fn((_namespace, key, value) => preferences.set(key, value))
  const emit = vi.fn()
  let packet!: (value: TeamActivityHintPacket) => void
  let disconnect!: () => void
  const stop = vi.fn()
  const stream = vi.fn((_identity, _mailbox, _previous, callback, _fatal, disconnected, _activity?: unknown) => {
    packet = callback; disconnect = disconnected; return stop
  })
  const controller = new TeamMailHintController(true, { preference: (_namespace, key, fallback) => (preferences.get(key) ?? fallback) as typeof fallback,
    putPreference: put }, emit)
  const binding = { profileId: 'profile-a', profileGeneration: 1, serverIdentity: 'server-a', namespace: 'cache-a',
    client: { mailHintStream: stream } as unknown as AgentServerClient, isCurrent: () => true }
  controller.ensure(binding, capability, v2 ? activity : undefined)
  return { controller, binding, stream, packet, disconnect, stop, put, emit, state: () => controller.projection('profile-a', 1)! }
}
afterEach(() => vi.useRealTimers())
describe('one coalesced Main-process Team notification connection', () => {
  it('coalesces 1,000 arrivals into one IPC, with zero idle work and no writes per event', () => {
    const test = setup()
    test.packet(frame(1, 'snapshot'))
    test.emit.mockClear(); test.put.mockClear()
    for (let seq = 2; seq <= 1001; seq++) test.packet(frame(seq))
    expect(test.emit).not.toHaveBeenCalled()
    expect(test.put).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(100)
    expect(test.emit).toHaveBeenCalledOnce()
    expect(test.state().bulletin?.latest.through_sequence).toBe(1001)
    expect(mailHintPending(test.state().state!)).toBe(false)
    expect(bulletinHintPending(test.state().bulletin!)).toBe(true)
    vi.advanceTimersByTime(600_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(test.emit).toHaveBeenCalledOnce()
    test.controller.retire()
  })
  it('clears only the captured Bulletin head, refuses disconnected and stale refreshes', () => {
    const test = setup()
    test.packet(frame(1, 'snapshot'))
    const capture = { scope: test.state().bulletin!.scope, cursor: test.state().bulletin!.latest }
    test.packet(frame(2))
    test.controller.acknowledgeBulletinRefresh(capture)
    expect(test.state().bulletin!.seen.through_sequence).toBe(1)
    expect(bulletinHintPending(test.state().bulletin!)).toBe(true)
    test.disconnect()
    expect(test.controller.acknowledgeBulletinRefresh({ ...capture, cursor: test.state().bulletin!.latest })).toBeNull()
    test.controller.retire()
    test.packet(frame(3))
    expect(test.controller.projection('profile-a', 1)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('negotiates exactly one connection and keeps older Mail-only servers usable', () => {
    const test = setup(false)
    test.controller.ensure(test.binding, capability)
    expect(test.stream).toHaveBeenCalledOnce()
    expect(test.stream.mock.calls[0][6]).toBeUndefined()
    const { bulletin: _bulletin, ...mail } = frame(1, 'snapshot')
    test.packet(mail)
    expect(test.state().bulletin).toBeNull()
    test.controller.ensure(test.binding, capability, activity)
    expect(test.stop).toHaveBeenCalledOnce()
    expect(test.stream).toHaveBeenCalledTimes(2)
    test.controller.retire()
  })
})
