import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Event } from '@shared/types'
import {
  activeInboundDelivery,
  activeInboundDeliveryKind,
  cancelPendingSteering,
  firstBlockingCrossChatDelivery,
  exactQueuedDeliveryReorderAvailable,
  isReorderableQueuedTurn,
  isCrossChatDeliveryQueuedTurn,
  isQueuedDeliveryBarrier,
  isImmutableQueuedTurn,
  isScheduledJobQueuedTurn,
  isSteeringCancellation,
  isSteeringPending,
  isUserQueuedTurn,
  isVisibleQueuedTurn,
  queuedMoveCrossesCrossChatDelivery,
  queuedTurnCrossChatFence,
  queuedTurnsInPositionOrder,
  STEERING_REQUEST_TIMEOUT_MS,
  steerFirstQueuedTurn,
  steerQueuedTurn,
  subscribeSteeringPending,
  type SteeringScope
} from './queue-actions'

const timelineEvent = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, session_id: 'chat-1', seq, type, ts: '2026-09-05T00:00:00Z', ...patch
})

describe('activeInboundDeliveryKind', () => {
  it('detects active local and encrypted inbound delivery runs', () => {
    expect(activeInboundDeliveryKind([
      timelineEvent(2, 'turn_started', { run_id: 'local', purpose: 'cross_chat_handoff_delivery' })
    ])).toBe('cross_chat')
    expect(activeInboundDeliveryKind([
      timelineEvent(2, 'turn_started', { run_id: 'peer', purpose: 'secure_peer_handoff_delivery' })
    ])).toBe('secure_peer')
  })

  it('does not warn for ordinary or terminal delivery runs', () => {
    expect(activeInboundDeliveryKind([
      timelineEvent(2, 'turn_started', { run_id: 'ordinary', purpose: null })
    ])).toBeNull()
    expect(activeInboundDeliveryKind([
      timelineEvent(3, 'turn_finished', { run_id: 'local' }),
      timelineEvent(2, 'turn_started', { run_id: 'local', purpose: 'cross_chat_handoff_delivery' })
    ])).toBeNull()
  })

  it('conservatively identifies an unknown active origin only when sync is not live', () => {
    expect(activeInboundDelivery([], true)).toEqual({ kind: 'unknown', identity: 'unknown:0' })
    expect(activeInboundDeliveryKind([
      timelineEvent(2, 'turn_started', { run_id: 'unknown', purpose: null })
    ])).toBeNull()
    expect(activeInboundDeliveryKind([
      timelineEvent(2, 'turn_started', { run_id: 'unknown', purpose: null })
    ], true)).toBe('unknown')
  })

  it('keeps imported goal context from replacing the active inbound delivery', () => {
    const start = timelineEvent(2, 'turn_started', { run_id: 'local', purpose: 'cross_chat_handoff_delivery' })
    const context = timelineEvent(3, 'turn_started', {
      backend: 'codex', run_id: 'import_goal', imported: true,
      metadata_only: true, provider_runtime_context: 'goal'
    })
    expect(activeInboundDelivery([context])).toBeNull()
    expect(activeInboundDelivery([context], true)).toEqual({ kind: 'unknown', identity: 'unknown:0' })
    expect(activeInboundDelivery([start, context])).toEqual({ kind: 'cross_chat', identity: 'cross_chat:local:2' })
    expect(activeInboundDelivery([
      start, context, timelineEvent(4, 'turn_finished', { run_id: 'local' })
    ])).toBeNull()
    expect(activeInboundDelivery([start, { ...context, provider_user_authored: true }]))
      .toEqual({ kind: 'cross_chat', identity: 'cross_chat:local:2' })
    expect(activeInboundDelivery([start, { ...context, provider_user_authored: true, imported: false }])).toBeNull()
  })

  it('ignores imported bookkeeping terminals while the inbound delivery remains active', () => {
    expect(activeInboundDeliveryKind([
      timelineEvent(2, 'turn_started', { run_id: 'import_delivery', purpose: 'cross_chat_handoff_delivery' }),
      timelineEvent(3, 'turn_finished', {
        backend: 'claude', run_id: 'import_delivery', imported: true, metadata_only: true
      })
    ])).toBe('cross_chat')
  })
})

const chatOneScope: SteeringScope = {
  profileId: 'profile-a',
  profileGeneration: 1,
  serverIdentity: 'server-a',
  sessionId: 'chat-1'
}

afterEach(() => {
  cancelPendingSteering()
  vi.useRealTimers()
})

describe('queue row visibility', () => {
  const turn = (purpose?: string) => ({ queued_id: purpose ?? 'user', prompt: 'Queued', file_ids: [], purpose })

  it('shows local cross-chat deliveries in the shelf without making them steerable', () => {
    const delivery = turn('cross_chat_handoff_delivery')
    expect(isVisibleQueuedTurn(delivery)).toBe(true)
    expect(isCrossChatDeliveryQueuedTurn(delivery)).toBe(true)
    expect(isUserQueuedTurn(delivery)).toBe(false)
  })

  it('allows explicit mixed ordering without weakening force-send, promoted, or hidden-work fences', () => {
    const delivery = { ...turn('cross_chat_handoff_delivery'), position: 1 }
    const user = { ...turn(), position: 2 }
    expect(isReorderableQueuedTurn(delivery)).toBe(false)
    expect(isReorderableQueuedTurn(delivery, true)).toBe(true)
    expect(isReorderableQueuedTurn({ ...delivery, promoted: true }, true)).toBe(false)
    expect(isReorderableQueuedTurn(turn('handoff_digest'), true)).toBe(false)
    expect(queuedTurnCrossChatFence([delivery, user], 'user', true)).toEqual({ runNow: true, moveEarlier: false, moveLater: false })
    expect(queuedMoveCrossesCrossChatDelivery([delivery, user], 'user', delivery.queued_id, 'before', true)).toBe(false)
    expect(queuedMoveCrossesCrossChatDelivery([{ ...delivery, promoted: true }, user], 'user', delivery.queued_id, 'before', true)).toBe(true)
    expect(exactQueuedDeliveryReorderAvailable(null)).toBe(false)
    expect(exactQueuedDeliveryReorderAvailable({ capabilities: { cross_chat_handoffs_v1: { available: false, features: { exact_queued_delivery_reorder: true } } } } as never)).toBe(false)
    expect(exactQueuedDeliveryReorderAvailable({ capabilities: { cross_chat_handoffs_v1: { available: true, features: { exact_queued_delivery_reorder: true } } } } as never)).toBe(true)
  })

  it('shows ordinary user-authored turns in the composer shelf', () => {
    expect(isVisibleQueuedTurn(turn())).toBe(true)
    expect(isUserQueuedTurn(turn())).toBe(true)
  })

  it('shows scheduled occurrences without allowing user edits or moves across them', () => {
    const job = { ...turn('scheduled_job'), position: 2, job_id: 'job-1', job_title: 'Check', job_scheduled_run_at: 1_789_000_000 }
    const before = { ...turn(), queued_id: 'before', position: 1 }
    const after = { ...turn(), queued_id: 'after', position: 3 }
    expect(isVisibleQueuedTurn(job)).toBe(true)
    expect(isUserQueuedTurn(job)).toBe(false)
    expect(isScheduledJobQueuedTurn(job)).toBe(true)
    expect(isImmutableQueuedTurn(job)).toBe(true)
    expect(isQueuedDeliveryBarrier(job)).toBe(false)
    expect(queuedMoveCrossesCrossChatDelivery([before, job, after], 'after', 'before', 'before')).toBe(true)
    expect(queuedTurnCrossChatFence([before, job, after], 'after').runNow).toBe(true)
  })

  it('keeps digest internals hidden but exposes encrypted peer queue owners', () => {
    expect(isVisibleQueuedTurn(turn('handoff_digest'))).toBe(false)
    expect(isVisibleQueuedTurn(turn('handoff_digest_delivery'))).toBe(false)
    expect(isVisibleQueuedTurn(turn('secure_peer_handoff_delivery'))).toBe(true)
    expect(isUserQueuedTurn(turn('secure_peer_handoff_delivery'))).toBe(false)
  })
})

describe('queuedMoveCrossesCrossChatDelivery', () => {
  const user = (queued_id: string, position: number) => ({ queued_id, prompt: queued_id, file_ids: [], position })
  const delivery = (queued_id: string, position: number) => ({
    queued_id, prompt: queued_id, file_ids: [], position, purpose: 'cross_chat_handoff_delivery'
  })

  it('detects forward moves whose final target crosses a delivery barrier', () => {
    const turns = [
      user('first', 1),
      user('second', 2),
      delivery('delivery', 3),
      user('last', 4)
    ]

    expect(queuedMoveCrossesCrossChatDelivery(turns, 'first', 'last', 'before')).toBe(true)
    expect(queuedMoveCrossesCrossChatDelivery(turns, 'first', 'last', 'after')).toBe(true)
  })

  it('detects reverse moves whose final target crosses a delivery barrier', () => {
    const turns = [
      user('first', 1),
      delivery('delivery', 2),
      user('third', 3),
      user('last', 4)
    ]

    expect(queuedMoveCrossesCrossChatDelivery(turns, 'last', 'first', 'before')).toBe(true)
    expect(queuedMoveCrossesCrossChatDelivery(turns, 'last', 'first', 'after')).toBe(true)
  })

  it('allows moves that remain on one side of a delivery barrier', () => {
    const turns = [
      user('first', 1),
      user('second', 2),
      delivery('delivery', 3),
      user('fourth', 4),
      user('last', 5)
    ]

    expect(queuedMoveCrossesCrossChatDelivery(turns, 'first', 'second', 'after')).toBe(false)
    expect(queuedMoveCrossesCrossChatDelivery(turns, 'last', 'fourth', 'before')).toBe(false)
  })

  it('uses sorted positions and exact before/after final-target semantics', () => {
    const turns = [
      user('last', 40),
      delivery('delivery', 20),
      user('first', 10),
      user('third', 30)
    ]

    expect(queuedMoveCrossesCrossChatDelivery(turns, 'first', 'delivery', 'before')).toBe(false)
    expect(queuedMoveCrossesCrossChatDelivery(turns, 'first', 'delivery', 'after')).toBe(true)
    expect(queuedMoveCrossesCrossChatDelivery(turns, 'third', 'delivery', 'before')).toBe(true)
    expect(queuedMoveCrossesCrossChatDelivery(turns, 'third', 'delivery', 'after')).toBe(false)
  })

  it('treats no-op and unresolved moves as not crossing a barrier', () => {
    const turns = [user('first', 1), delivery('delivery', 2), user('last', 3)]

    expect(queuedMoveCrossesCrossChatDelivery(turns, 'first', 'first', 'after')).toBe(false)
    expect(queuedMoveCrossesCrossChatDelivery(turns, 'missing', 'last', 'after')).toBe(false)
    expect(queuedMoveCrossesCrossChatDelivery(turns, 'first', 'missing', 'after')).toBe(false)
  })
})

describe('queuedTurnCrossChatFence', () => {
  it('blocks only the row actions that would overtake an invisible delivery', () => {
    const turns = [
      { queued_id: 'first', prompt: 'First', file_ids: [], position: 1 },
      { queued_id: 'delivery', prompt: 'Delivery', file_ids: [], position: 2, purpose: 'cross_chat_handoff_delivery' },
      { queued_id: 'last', prompt: 'Last', file_ids: [], position: 3 }
    ]

    expect(queuedTurnCrossChatFence(turns, 'first')).toEqual({
      runNow: false, moveEarlier: false, moveLater: true
    })
    expect(queuedTurnCrossChatFence(turns, 'last')).toEqual({
      runNow: true, moveEarlier: true, moveLater: false
    })
    expect(queuedTurnCrossChatFence(turns, 'missing')).toEqual({
      runNow: false, moveEarlier: false, moveLater: false
    })
  })

  it('uses one stable order for positioned and transient positionless turns', () => {
    const positioned = { queued_id: 'positioned', prompt: 'Positioned', file_ids: [], position: 1 }
    const firstPending = { queued_id: 'pending-a', prompt: 'Pending A', file_ids: [] }
    const pendingDelivery = { queued_id: 'pending-delivery', prompt: 'Delivery', file_ids: [], purpose: 'cross_chat_handoff_delivery' }
    const lastPending = { queued_id: 'pending-b', prompt: 'Pending B', file_ids: [] }
    const turns = [lastPending, positioned, firstPending, pendingDelivery]

    expect(queuedTurnsInPositionOrder(turns).map(turn => turn.queued_id)).toEqual([
      'positioned', 'pending-b', 'pending-a', 'pending-delivery'
    ])
    expect(queuedTurnCrossChatFence(turns, 'pending-a')).toEqual({
      runNow: false, moveEarlier: false, moveLater: true
    })
  })

  it('treats encrypted peer deliveries as FIFO barriers and returns the exact first blocker', () => {
    const peerDelivery = {
      queued_id: 'peer-delivery', prompt: 'Encrypted delivery', file_ids: [], position: 2,
      purpose: 'secure_peer_handoff_delivery'
    }
    const localDelivery = {
      queued_id: 'local-delivery', prompt: 'Local delivery', file_ids: [], position: 3,
      purpose: 'cross_chat_handoff_delivery'
    }
    const userTurn = { queued_id: 'user', prompt: 'User work', file_ids: [], position: 4 }
    const turns = [userTurn, localDelivery, peerDelivery]

    expect(isQueuedDeliveryBarrier(peerDelivery)).toBe(true)
    expect(queuedTurnCrossChatFence(turns, userTurn.queued_id).runNow).toBe(true)
    expect(firstBlockingCrossChatDelivery(turns, userTurn.queued_id)).toBe(peerDelivery)
  })
})

describe('steerQueuedTurn', () => {
  const runNow = vi.fn()
  const list = vi.fn()

  beforeEach(() => {
    runNow.mockReset()
    list.mockReset()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { queue: { runNow, list } } as unknown as AgentsDockAPI
    })
  })

  it('returns the refreshed queue after steering', async () => {
    const later = { queued_id: 'queued-2', session_id: 'chat-1', prompt: 'Later', file_ids: [] }
    runNow.mockResolvedValue({ ok: true, queued_id: 'queued-1', deferred: false })
    list.mockResolvedValue([
      { queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Promoted', file_ids: [] },
      later
    ])
    await expect(steerQueuedTurn(chatOneScope, 'queued-1')).resolves.toEqual([later])
  })

  it('runs the final confirmation gate immediately before queue promotion', async () => {
    const confirm = vi.fn().mockReturnValue(false)

    const rejection = steerQueuedTurn(chatOneScope, 'queued-1', confirm)

    await expect(rejection).rejects.toSatisfy(isSteeringCancellation)
    expect(confirm).toHaveBeenCalledOnce()
    expect(runNow).not.toHaveBeenCalled()
    expect(isSteeringPending(chatOneScope)).toBe(false)
  })

  it('retains a server-marked promoted row while its provider handoff is starting', async () => {
    const promoted = {
      queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Starting', file_ids: [], promoted: true
    }
    const later = { queued_id: 'queued-2', session_id: 'chat-1', prompt: 'Later', file_ids: [] }
    runNow.mockResolvedValue({ ok: true, queued_id: promoted.queued_id, deferred: false })
    list.mockResolvedValue([promoted, later])

    await expect(steerQueuedTurn(chatOneScope, promoted.queued_id)).resolves.toEqual([promoted, later])
  })

  it('keeps the queued item and resolves without an error when Force Send is deferred', async () => {
    const deferred = { queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Wait for startup', file_ids: [] }
    const later = { queued_id: 'queued-2', session_id: 'chat-1', prompt: 'Later', file_ids: [] }
    runNow.mockResolvedValue({
      ok: false,
      queued_id: deferred.queued_id,
      deferred: true,
      retryable: true,
      delivery_uncertain: false,
      message: 'The provider is still starting. This message remains queued.'
    })
    list.mockResolvedValue([deferred, later])

    await expect(steerQueuedTurn(chatOneScope, deferred.queued_id)).resolves.toEqual([deferred, later])
  })

  it('preserves a missing-row response instead of inferring provider completion', async () => {
    const error = new Error('queued turn not found')
    runNow.mockRejectedValue(error)
    list.mockResolvedValue([])
    await expect(steerQueuedTurn(chatOneScope, 'queued-1')).rejects.toBe(error)
    expect(list).not.toHaveBeenCalled()
  })

  it('keeps a real steering failure when the turn is still queued', async () => {
    const error = new Error('offline')
    runNow.mockRejectedValue(error)
    list.mockResolvedValue([{ queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Run', file_ids: [] }])
    await expect(steerQueuedTurn(chatOneScope, 'queued-1')).rejects.toBe(error)
  })

  it('coalesces repeated steer requests while the first handoff is pending', async () => {
    let accept!: () => void
    runNow.mockImplementation(() => new Promise<void>(resolve => { accept = resolve }))
    list.mockResolvedValue([])
    const notifications = vi.fn()
    const unsubscribe = subscribeSteeringPending(notifications)

    const first = steerQueuedTurn(chatOneScope, 'queued-1')
    const second = steerQueuedTurn(chatOneScope, 'queued-1')

    expect(isSteeringPending(chatOneScope)).toBe(true)
    expect(runNow).toHaveBeenCalledTimes(1)
    accept()
    await expect(Promise.all([first, second])).resolves.toEqual([[], []])
    expect(list).toHaveBeenCalledTimes(1)
    expect(isSteeringPending(chatOneScope)).toBe(false)
    expect(notifications).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('rejects a different queued item instead of falsely joining the active steer', async () => {
    let accept!: () => void
    runNow.mockImplementation(() => new Promise<void>(resolve => { accept = resolve }))
    list.mockResolvedValue([])

    const first = steerQueuedTurn(chatOneScope, 'queued-1')
    await expect(steerQueuedTurn(chatOneScope, 'queued-2')).rejects.toThrow(
      'Another “Send now” action is already in progress. This message remains queued'
    )
    expect(runNow).toHaveBeenCalledTimes(1)
    expect(runNow).toHaveBeenCalledWith('chat-1', 'queued-1')

    accept()
    await expect(first).resolves.toEqual([])
  })

  it('isolates pending state by profile and server generation', async () => {
    const accepts: Array<() => void> = []
    runNow.mockImplementation(() => new Promise<void>(resolve => { accepts.push(resolve) }))
    list.mockResolvedValue([])
    const nextGeneration = { ...chatOneScope, profileGeneration: 2 }

    const first = steerQueuedTurn(chatOneScope, 'queued-1')
    const second = steerQueuedTurn(nextGeneration, 'queued-1')

    expect(runNow).toHaveBeenCalledTimes(2)
    expect(isSteeringPending(chatOneScope)).toBe(true)
    expect(isSteeringPending(nextGeneration)).toBe(true)
    accepts.forEach(accept => accept())
    await expect(Promise.all([first, second])).resolves.toEqual([[], []])
  })

  it('cancels renderer leases immediately when the active server changes', async () => {
    runNow.mockImplementation(() => new Promise<void>(() => undefined))

    const pending = steerQueuedTurn(chatOneScope, 'queued-1')
    const result = expect(pending).rejects.toThrow('active server changed')
    cancelPendingSteering()

    await result
    expect(isSteeringPending(chatOneScope)).toBe(false)
  })

  it('expires a hung request and releases the renderer lease', async () => {
    vi.useFakeTimers()
    runNow.mockImplementation(() => new Promise<void>(() => undefined))

    const pending = steerQueuedTurn(chatOneScope, 'queued-1')
    const result = expect(pending).rejects.toThrow('did not receive a response')
    await vi.advanceTimersByTimeAsync(STEERING_REQUEST_TIMEOUT_MS)

    await result
    expect(list).not.toHaveBeenCalled()
    expect(isSteeringPending(chatOneScope)).toBe(false)
  })

  it('replaces the raw Electron handoff failure with a friendly message', async () => {
    runNow.mockRejectedValue(new Error(
      "Error invoking remote method 'queue:run-now': Error: another steering handoff is already in progress"
    ))
    list.mockResolvedValue([
      { queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Run', file_ids: [] }
    ])

    await expect(steerQueuedTurn(chatOneScope, 'queued-1')).rejects.toThrow(
      'Another “Send now” action is already in progress. Please wait for it to finish.'
    )
  })
})

describe('steerFirstQueuedTurn', () => {
  const runNow = vi.fn()
  const list = vi.fn()

  beforeEach(() => {
    runNow.mockReset()
    list.mockReset()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { queue: { runNow, list } } as unknown as AgentsDockAPI
    })
  })

  it('refreshes the server queue and steers its position-one turn', async () => {
    const later = { queued_id: 'later', session_id: 'chat-1', prompt: 'Later', file_ids: [], position: 2 }
    const first = { queued_id: 'first', session_id: 'chat-1', prompt: 'First', file_ids: [], position: 1 }
    list.mockResolvedValueOnce([later, first]).mockResolvedValueOnce([later])
    runNow.mockResolvedValue(true)

    await expect(steerFirstQueuedTurn(chatOneScope)).resolves.toEqual({ steered: true, turns: [later] })
    expect(runNow).toHaveBeenCalledWith('chat-1', 'first')
  })

  it('does nothing when the refreshed server queue is empty', async () => {
    list.mockResolvedValue([])

    await expect(steerFirstQueuedTurn(chatOneScope)).resolves.toEqual({ steered: false, turns: [] })
    expect(runNow).not.toHaveBeenCalled()
  })

  it('does not promote another row while a visible provider handoff is starting', async () => {
    const promoted = {
      queued_id: 'starting', session_id: 'chat-1', prompt: 'Starting', file_ids: [], position: 1, promoted: true
    }
    const later = { queued_id: 'later', session_id: 'chat-1', prompt: 'Later', file_ids: [], position: 2 }
    list.mockResolvedValue([promoted, later])

    await expect(steerFirstQueuedTurn(chatOneScope)).resolves.toEqual({
      steered: false,
      turns: [promoted, later]
    })
    expect(runNow).not.toHaveBeenCalled()
  })

  it('revalidates the refreshed first turn before admitting Send now', async () => {
    const first = { queued_id: 'first', session_id: 'chat-1', prompt: 'First', file_ids: [], position: 1 }
    list.mockResolvedValue([first])

    await expect(steerFirstQueuedTurn(chatOneScope, () => 'Cursor is unavailable.')).rejects.toThrow('Cursor is unavailable.')
    expect(runNow).not.toHaveBeenCalled()
  })

  it('rechecks interruption consent after loading the first queued turn', async () => {
    const first = { queued_id: 'first', session_id: 'chat-1', prompt: 'First', file_ids: [], position: 1 }
    const confirm = vi.fn().mockReturnValue(false)
    list.mockResolvedValue([first])

    await expect(steerFirstQueuedTurn(chatOneScope, undefined, confirm)).resolves.toEqual({
      steered: false,
      turns: [first]
    })
    expect(confirm).toHaveBeenCalledOnce()
    expect(runNow).not.toHaveBeenCalled()
  })

  it('does not steer an internal digest-generation turn', async () => {
    const digest = { queued_id: 'digest', session_id: 'chat-1', prompt: 'Generate digest', file_ids: [], position: 1, purpose: 'handoff_digest' }
    const user = { queued_id: 'user', session_id: 'chat-1', prompt: 'User follow-up', file_ids: [], position: 2 }
    list.mockResolvedValueOnce([digest, user]).mockResolvedValueOnce([digest])
    runNow.mockResolvedValue(true)

    await expect(steerFirstQueuedTurn(chatOneScope)).resolves.toEqual({ steered: true, turns: [digest] })
    expect(runNow).toHaveBeenCalledWith('chat-1', 'user')
  })

  it('does not expose an internal digest-delivery turn as steerable user work', async () => {
    const delivery = { queued_id: 'delivery', session_id: 'chat-1', prompt: 'Context digest from Source.', file_ids: [], position: 1, purpose: 'handoff_digest_delivery' }
    list.mockResolvedValue([delivery])

    await expect(steerFirstQueuedTurn(chatOneScope)).resolves.toEqual({ steered: false, turns: [delivery] })
    expect(runNow).not.toHaveBeenCalled()
  })

  it('does not expose an internal cross-chat delivery as steerable user work', async () => {
    const delivery = { queued_id: 'delivery', session_id: 'chat-1', prompt: 'Handoff from Source', file_ids: [], position: 1, purpose: 'cross_chat_handoff_delivery' }
    list.mockResolvedValue([delivery])

    await expect(steerFirstQueuedTurn(chatOneScope)).resolves.toEqual({ steered: false, turns: [delivery] })
    expect(runNow).not.toHaveBeenCalled()
  })

  it('does not steer user work past an earlier internal cross-chat delivery', async () => {
    const delivery = { queued_id: 'delivery', session_id: 'chat-1', prompt: 'Handoff from Source', file_ids: [], position: 1, purpose: 'cross_chat_handoff_delivery' }
    const user = { queued_id: 'user', session_id: 'chat-1', prompt: 'User follow-up', file_ids: [], position: 2 }
    list.mockResolvedValue([user, delivery])

    await expect(steerFirstQueuedTurn(chatOneScope)).resolves.toEqual({ steered: false, turns: [user, delivery] })
    expect(runNow).not.toHaveBeenCalled()
  })
})
