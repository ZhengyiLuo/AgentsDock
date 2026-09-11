import type { Event, Health, QueuedRunNowResponse, QueuedTurn } from '@shared/types'
import { isImportedHistoryRecord, isImportedProviderControlMetadata } from '@shared/provider-origin'

export type SteerFirstQueuedResult = {
  steered: boolean
  turns: QueuedTurn[]
}

export type QueuedTurnCrossChatFence = {
  runNow: boolean
  moveEarlier: boolean
  moveLater: boolean
}

export type ActiveInboundDeliveryKind = 'cross_chat' | 'secure_peer' | 'unknown'

export type ActiveInboundDelivery = {
  kind: ActiveInboundDeliveryKind
  identity: string
}

/**
 * Identifies the currently running inbound delivery from the authoritative
 * timeline event sequence. The caller still checks the store's active-session
 * bit before warning, so an incomplete historical stream cannot create a
 * permanent false-positive.
 */
export function activeInboundDelivery(
  events: readonly Event[],
  conservativelyTreatUnknownAsInbound = false
): ActiveInboundDelivery | null {
  let latestStart: Event | null = null
  let latestSeq = 0
  for (const event of events) {
    if (isImportedProviderControlMetadata(event) || isImportedHistoryRecord(event)) continue
    latestSeq = Math.max(latestSeq, event.seq)
    if (event.type === 'turn_started' && (!latestStart || event.seq > latestStart.seq)) latestStart = event
  }
  if (!latestStart) {
    return conservativelyTreatUnknownAsInbound
      ? { kind: 'unknown', identity: `unknown:${latestSeq}` }
      : null
  }
  const runId = latestStart.run_id?.trim() || ''
  if (runId && events.some(event => (
    !isImportedProviderControlMetadata(event) && !isImportedHistoryRecord(event)
    && event.seq >= latestStart!.seq
    && event.run_id?.trim() === runId
    && (event.type === 'turn_finished' || event.type === 'turn_stopped' || event.type === 'error')
  ))) return null
  const kind: ActiveInboundDeliveryKind | null = latestStart.purpose === 'cross_chat_handoff_delivery'
    ? 'cross_chat'
    : latestStart.purpose === 'secure_peer_handoff_delivery'
      ? 'secure_peer'
      : conservativelyTreatUnknownAsInbound && !latestStart.purpose?.trim()
        ? 'unknown'
        : null
  return kind ? { kind, identity: `${kind}:${runId || latestStart.id}:${latestStart.seq}` } : null
}

export function activeInboundDeliveryKind(
  events: readonly Event[],
  conservativelyTreatUnknownAsInbound = false
): ActiveInboundDeliveryKind | null {
  return activeInboundDelivery(events, conservativelyTreatUnknownAsInbound)?.kind ?? null
}

interface PendingSteer {
  queuedId: string
  controller: AbortController
  promise: Promise<QueuedTurn[]>
}

export interface SteeringScope {
  profileId: string | null
  profileGeneration: number
  serverIdentity?: string | null
  sessionId: string
}

export const STEERING_REQUEST_TIMEOUT_MS = 30_000

class SteeringCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SteeringCancelledError'
  }
}

class SteeringTimeoutError extends Error {
  constructor() {
    super('“Send now” did not receive a response. The operation may still be settling; refresh the queue before retrying.')
    this.name = 'SteeringTimeoutError'
  }
}

const pendingSteers = new Map<string, PendingSteer>()
const pendingSteerListeners = new Set<() => void>()

export function isUserQueuedTurn(turn: QueuedTurn): boolean {
  return turn.purpose !== 'handoff_digest'
    && turn.purpose !== 'handoff_digest_delivery'
    && turn.purpose !== 'cross_chat_handoff_delivery'
    && turn.purpose !== 'secure_peer_handoff_delivery'
    && turn.purpose !== 'scheduled_job'
}

/** All pending provider work belongs in the same composer queue. */
export function isVisibleQueuedTurn(turn: QueuedTurn): boolean {
  return isUserQueuedTurn(turn) || isImmutableQueuedTurn(turn)
}

/** Incoming deliveries keep their authenticated content. */
export function isCrossChatDeliveryQueuedTurn(turn: QueuedTurn): boolean {
  return turn.purpose === 'cross_chat_handoff_delivery'
}

/** Encrypted peer deliveries need a visible queue owner and exact escape. */
export function isSecurePeerDeliveryQueuedTurn(turn: QueuedTurn): boolean {
  return turn.purpose === 'secure_peer_handoff_delivery'
}

/** Any immutable delivery row that owns a position in the provider queue. */
export function isQueuedDeliveryBarrier(turn: QueuedTurn): boolean {
  return isCrossChatDeliveryQueuedTurn(turn)
    || isSecurePeerDeliveryQueuedTurn(turn)
}

export function isScheduledJobQueuedTurn(turn: QueuedTurn): boolean {
  return turn.purpose === 'scheduled_job'
}

/** System-owned content cannot be rewritten or force-sent through the user API. */
export function isImmutableQueuedTurn(turn: QueuedTurn): boolean {
  return isQueuedDeliveryBarrier(turn) || isScheduledJobQueuedTurn(turn)
}

/** Explicit pending-order changes require the server's durable mixed-queue contract. */
export function exactQueuedDeliveryReorderAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  return capability?.available === true && capability.features?.exact_queued_delivery_reorder === true
}

export function isReorderableQueuedTurn(turn: QueuedTurn, mixedReorder = false): boolean {
  return turn.promoted !== true && isVisibleQueuedTurn(turn) && (mixedReorder || !isImmutableQueuedTurn(turn))
}

/** Stable server queue order, with transient positionless rows kept at the end. */
export function queuedTurnsInPositionOrder(turns: readonly QueuedTurn[]): QueuedTurn[] {
  return turns
    .map((turn, index) => ({ turn, index }))
    .sort((left, right) => (
      (left.turn.position ?? Number.MAX_SAFE_INTEGER) - (right.turn.position ?? Number.MAX_SAFE_INTEGER)
      || left.index - right.index
    ))
    .map(({ turn }) => turn)
}

/** Whether a drag-style move would overtake an immutable delivery row. */
export function queuedMoveCrossesCrossChatDelivery(
  turns: readonly QueuedTurn[],
  activeId: string,
  targetId: string,
  placement: 'before' | 'after',
  mixedReorder = false
): boolean {
  if (activeId === targetId) return false
  const ordered = queuedTurnsInPositionOrder(turns)
  const from = ordered.findIndex(turn => turn.queued_id === activeId)
  const target = ordered.findIndex(turn => turn.queued_id === targetId)
  if (from < 0 || target < 0) return false

  let to = target + (placement === 'after' ? 1 : 0)
  if (from < to) to -= 1
  if (to === from) return false
  const crossed = to > from
    ? ordered.slice(from + 1, to + 1)
    : ordered.slice(to, from)
  return !isReorderableQueuedTurn(ordered[from], mixedReorder)
    || crossed.some(turn => !isReorderableQueuedTurn(turn, mixedReorder))
}

/** Actions a user turn cannot perform without overtaking earlier system work. */
export function queuedTurnCrossChatFence(
  turns: readonly QueuedTurn[],
  queuedId: string,
  mixedReorder = false
): QueuedTurnCrossChatFence {
  const ordered = queuedTurnsInPositionOrder(turns)
  const index = ordered.findIndex(turn => turn.queued_id === queuedId)
  if (index < 0) return { runNow: false, moveEarlier: false, moveLater: false }
  return {
    runNow: ordered.slice(0, index).some(isImmutableQueuedTurn),
    moveEarlier: index > 0 && !isReorderableQueuedTurn(ordered[index - 1], mixedReorder),
    moveLater: index + 1 < ordered.length && !isReorderableQueuedTurn(ordered[index + 1], mixedReorder)
  }
}

/** The first durable delivery a user turn would overtake, if any. */
export function firstBlockingCrossChatDelivery(
  turns: readonly QueuedTurn[],
  queuedId: string
): QueuedTurn | null {
  const ordered = queuedTurnsInPositionOrder(turns)
  const index = ordered.findIndex(turn => turn.queued_id === queuedId)
  if (index < 0) return null
  return ordered.slice(0, index).find(isQueuedDeliveryBarrier) ?? null
}

function steeringKey(scope: SteeringScope): string {
  return JSON.stringify([
    scope.profileId,
    scope.serverIdentity ?? null,
    scope.profileGeneration,
    scope.sessionId
  ])
}

export function isSteeringPending(scope: SteeringScope | null | undefined): boolean {
  return Boolean(scope && pendingSteers.has(steeringKey(scope)))
}

export function subscribeSteeringPending(listener: () => void): () => void {
  pendingSteerListeners.add(listener)
  return () => pendingSteerListeners.delete(listener)
}

function notifySteeringPending(): void {
  for (const listener of pendingSteerListeners) listener()
}

/**
 * Release renderer ownership when its server/profile context disappears.
 * The shielded server operation is not claimed to be cancelled; any late IPC
 * response is ignored and the next user action must revalidate server state.
 */
export function cancelPendingSteering(message = '“Send now” was cancelled because the active server changed.'): void {
  if (!pendingSteers.size) return
  const pending = [...pendingSteers.values()]
  pendingSteers.clear()
  for (const steer of pending) steer.controller.abort(new SteeringCancelledError(message))
  notifySteeringPending()
}

export function isSteeringCancellation(error: unknown): boolean {
  return error instanceof SteeringCancelledError
}

async function performSteerQueuedTurn(
  sessionId: string,
  queuedId: string,
  signal: AbortSignal
): Promise<QueuedTurn[]> {
  let result: QueuedRunNowResponse
  try {
    result = await abortable(window.agentsDock.queue.runNow(sessionId, queuedId), signal)
  } catch (error) {
    if (signal.aborted) throw abortReason(signal)
    // Native steering detaches the row before the provider handoff settles.
    // A missing row therefore cannot turn a rejected/aborted request into
    // success; keep the authoritative server error.
    throw friendlySteeringError(error)
  }
  const turns = await abortable(window.agentsDock.queue.list(sessionId), signal)
  return result?.deferred === true
    ? turns
    : turns.filter(turn => turn.queued_id !== queuedId || turn.promoted === true)
}

export function steerQueuedTurn(
  scope: SteeringScope,
  queuedId: string,
  confirmImmediatelyBeforeRun?: () => boolean
): Promise<QueuedTurn[]> {
  const key = steeringKey(scope)
  const existing = pendingSteers.get(key)
  if (existing) {
    if (existing.queuedId === queuedId) return existing.promise
    return Promise.reject(new Error(
      'Another “Send now” action is already in progress. This message remains queued; try again after it finishes.'
    ))
  }
  if (confirmImmediatelyBeforeRun && !confirmImmediatelyBeforeRun()) {
    return Promise.reject(new SteeringCancelledError('“Send now” was cancelled.'))
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(
    () => controller.abort(new SteeringTimeoutError()),
    STEERING_REQUEST_TIMEOUT_MS
  )
  const operation = performSteerQueuedTurn(scope.sessionId, queuedId, controller.signal)
  const promise = operation.finally(() => window.clearTimeout(timeout))
  pendingSteers.set(key, { queuedId, controller, promise })
  notifySteeringPending()
  const release = (): void => {
    if (pendingSteers.get(key)?.promise !== promise) return
    pendingSteers.delete(key)
    notifySteeringPending()
  }
  void promise.then(release, release)
  return promise
}

export async function steerFirstQueuedTurn(
  scope: SteeringScope,
  admissionError?: (turn: QueuedTurn) => string | null,
  confirmImmediatelyBeforeRun?: () => boolean
): Promise<SteerFirstQueuedResult> {
  const pending = pendingSteers.get(steeringKey(scope))
  if (pending) return { steered: false, turns: await pending.promise }

  const turns = await window.agentsDock.queue.list(scope.sessionId)
  if (turns.some(turn => turn.promoted === true)) return { steered: false, turns }
  const first = queuedTurnsInPositionOrder(turns).find(isUserQueuedTurn)

  if (!first) return { steered: false, turns }
  if (queuedTurnCrossChatFence(turns, first.queued_id).runNow) {
    return { steered: false, turns }
  }
  const error = admissionError?.(first)
  if (error) throw new Error(error)
  try {
    return { steered: true, turns: await steerQueuedTurn(scope, first.queued_id, confirmImmediatelyBeforeRun) }
  } catch (error) {
    if (isSteeringCancellation(error)) return { steered: false, turns }
    throw error
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new SteeringCancelledError('“Send now” was cancelled.')
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) }
    )
  })
}

function friendlySteeringError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error)
  if (
    message.toLowerCase().includes('steering handoff')
    || message.toLowerCase().includes('force send is already')
  ) {
    return new Error('Another “Send now” action is already in progress. Please wait for it to finish.')
  }
  return error
}
