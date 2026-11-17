import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event as SessionEvent, ProfileBootstrapPayload } from '@shared/types'
const track = vi.hoisted(() => vi.fn())
vi.mock('./analytics', () => ({ trackEvent: track }))
const owner = { profileId: 'local-only-profile', generation: 1, sessionId: 'local-only-session' }
const event = (type: string, extra = {}): SessionEvent => ({ type, seq: 1, id: 'local-only-event', session_id: owner.sessionId, ts: '', ...extra })
async function load() { vi.resetModules(); return import('./analytics-funnel') }

describe('launch and send funnel', () => {
  beforeEach(() => track.mockClear())
  it('counts a milestone once despite strict-mode/remount/reconnect', async () => {
    const { trackMilestone } = await load()
    trackMilestone('app_launched'); trackMilestone('app_launched')
    trackMilestone('app_server_ready'); trackMilestone('app_server_ready')
    expect(track.mock.calls.map(([name]) => name)).toEqual(['app_launched', 'app_server_ready'])
  })
  it('counts fresh refresh Health even when native connection notifications are deduplicated', async () => {
    const { observeFreshServerReady } = await load()
    const payload = { activeProfileId: 'profile', profiles: [{ id: 'profile', connectionState: 'online' }], healthCheckedAt: 200, health: { ok: true, api_contract_version: 8 } } as unknown as ProfileBootstrapPayload
    observeFreshServerReady(payload, 201, 8) // Cached check predates the request.
    observeFreshServerReady({ ...payload, healthCheckedAt: undefined }, 100, 8)
    observeFreshServerReady({ ...payload, health: { ok: true, api_contract_version: 7 } }, 100, 8)
    observeFreshServerReady({ ...payload, health: { ok: false } }, 100, 8)
    observeFreshServerReady({ ...payload, health: { ok: true, chat_readiness: { ready: false } } } as ProfileBootstrapPayload, 100, 8)
    observeFreshServerReady({ ...payload, profiles: [{ ...payload.profiles[0], connectionState: 'offline' }] }, 100, 8)
    expect(track).not.toHaveBeenCalled()
    observeFreshServerReady(payload, 100, 8)
    observeFreshServerReady(payload, 100, 8)
    expect(track).toHaveBeenCalledExactlyOnceWith('app_server_ready', undefined)
  })
  it('does not turn lost HTTP responses into proven rejections', async () => {
    const { beginMessageObservation } = await load()
    const first = beginMessageObservation(owner, 'codex')
    first.failed(new Error('fetch failed')); first.failed(new Error('duplicate'))
    const second = beginMessageObservation(owner, 'claude')
    second.failed(new Error("Error invoking remote method 'turns:send': Error: [submission_rejected] private details"))
    expect(track.mock.calls).toEqual([
      ['message_submission_attempted', { backend: 'codex' }],
      ['message_submission_settled', { backend: 'codex', outcome: 'unknown' }],
      ['message_submission_attempted', { backend: 'claude' }],
      ['message_submission_settled', { backend: 'claude', outcome: 'rejected' }]
    ])
  })
  it('requires an exact accepted run, excludes imports/commentary, and sends no ownership data', async () => {
    const { beginMessageObservation, observeReply } = await load()
    beginMessageObservation(owner, 'codex').accepted(event('turn_started', { run_id: 'local-only-run' }))
    for (const extra of [{ run_id: 'other' }, { imported: true }, { forked: true }, { phase: 'commentary' }, { phase: 'analysis' }, { phase: 'reasoning' }, { phase: 'unknown' }, { session_id: 'other-session' }]) {
      observeReply(owner, event('assistant_text', { run_id: 'local-only-run', text: 'private', ...extra }))
    }
    observeReply({ ...owner, generation: 2 }, event('assistant_text', { run_id: 'local-only-run', text: 'private' }))
    expect(track.mock.calls.filter(([name]) => name === 'app_first_reply_observed')).toHaveLength(0)
    observeReply(owner, event('assistant_text', { run_id: 'local-only-run', text: 'private' }))
    observeReply(owner, event('turn_finished', { run_id: 'local-only-run', result_text: 'private' }))
    expect(track.mock.calls.filter(([name]) => name === 'app_first_reply_observed')).toHaveLength(1)
    expect(JSON.stringify(track.mock.calls)).not.toMatch(/local-only|private/)
  })
  it('does not attribute the previous running reply to a queued submission', async () => {
    const { beginMessageObservation, observeReply } = await load()
    beginMessageObservation(owner, 'claude').accepted(event('turn_queued', { queued_id: 'queue-one' }), 'queue-one')
    observeReply(owner, event('assistant_text', { run_id: 'previous-run', text: 'old answer' }))
    expect(track.mock.calls.some(([name]) => name === 'app_first_reply_observed')).toBe(false)
    observeReply(owner, event('turn_started', { queued_id: 'queue-one', run_id: 'new-run' }))
    observeReply(owner, event('assistant_text', { run_id: 'new-run', text: 'new answer' }))
    expect(track.mock.calls.filter(([name]) => name === 'app_first_reply_observed')).toHaveLength(1)
  })
  it('marks receipt-less legacy responses unknown instead of inventing acceptance', async () => {
    const { beginMessageObservation } = await load()
    beginMessageObservation(owner, 'codex').accepted()
    expect(track).toHaveBeenLastCalledWith('message_submission_settled', { backend: 'codex', outcome: 'unknown' })
  })
  it('correlates an exact user-message receipt instead of losing its reply', async () => {
    const { beginMessageObservation, observeReply } = await load()
    beginMessageObservation(owner, 'codex').accepted(event('user_message', { run_id: 'accepted-run' }))
    observeReply(owner, event('assistant_text', { run_id: 'accepted-run', phase: 'final_answer', text: 'answer' }))
    expect(track).toHaveBeenLastCalledWith('app_first_reply_observed', undefined)
  })
  it('does not bind a queued receipt to the previous run even if it carries a run id', async () => {
    const { beginMessageObservation, observeReply } = await load()
    beginMessageObservation(owner, 'codex').accepted(event('user_message', { run_id: 'previous-run', queued_id: 'queued' }))
    observeReply(owner, event('assistant_text', { run_id: 'previous-run', text: 'previous' }))
    expect(track.mock.calls.some(([name]) => name === 'app_first_reply_observed')).toBe(false)
    observeReply(owner, event('turn_started', { run_id: 'accepted-run', queued_id: 'queued' }))
    observeReply(owner, event('turn_finished', { run_id: 'accepted-run', result_text: 'answer' }))
    expect(track).toHaveBeenLastCalledWith('app_first_reply_observed', undefined)
  })
})
