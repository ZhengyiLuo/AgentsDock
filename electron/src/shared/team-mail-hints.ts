/**
 * Passive Mail arrival state. This module performs no I/O, polling, receipt
 * writes, body loading, or navigation. The authenticated transport supplies
 * the scope; a packet's mailbox fields never grant access to that mailbox.
 */
export interface MailHintScope {
  profileId: string
  profileGeneration: number
  streamId: string
  serverIdentity: string
  hubId: string
  teamId: string
  recipientServerId: string
}

export interface MailArrivalCursor {
  through_sequence: number
  arrival_id: string | null
}

export interface MailboxCoverage extends MailArrivalCursor {
  version: 1
  team_id: string
  recipient_server_id: string
}

export interface MailArrivalHint extends MailboxCoverage {
  /** Initial snapshot rejected the retained immutable arrival anchor. */
  reset: boolean
}

export interface MailHintState {
  readonly scope: Readonly<MailHintScope>
  readonly seen: Readonly<MailArrivalCursor>
  readonly retainedSeen: Readonly<MailArrivalCursor>
  readonly latest: Readonly<MailArrivalCursor> | null
  /** Previous connection's arrivals remain visible while reconnecting. */
  readonly offlineLatest: Readonly<MailArrivalCursor> | null
  /** Fresh, contiguous coverage starting at zero in this exact stream. */
  readonly freshPrefix: Readonly<MailArrivalCursor>
  readonly initialized: boolean
  readonly invalid: boolean
}

const EMPTY_CURSOR: Readonly<MailArrivalCursor> = Object.freeze({ through_sequence: 0, arrival_id: null })
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/
const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ARRIVAL_ID = /^tmsg_[0-9a-f]{32}$/
const CURSOR_KEYS = ['through_sequence', 'arrival_id']
const COVERAGE_KEYS = ['version', 'team_id', 'recipient_server_id', ...CURSOR_KEYS]

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Mail hint metadata')
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) {
    throw new Error('Invalid Mail hint metadata')
  }
  return result
}

function exactMatch(pattern: RegExp, value: string): boolean {
  // JavaScript's $ also matches before a final newline; wire IDs must not.
  return pattern.exec(value)?.[0] === value
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && exactMatch(ID, value)
}

function cursor(value: Record<string, unknown>): MailArrivalCursor {
  const sequence = value.through_sequence
  const arrivalId = value.arrival_id
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0
    || ((sequence === 0) ? arrivalId !== null : typeof arrivalId !== 'string' || !exactMatch(ARRIVAL_ID, arrivalId))) {
    throw new Error('Invalid Mail arrival cursor')
  }
  return { through_sequence: sequence as number, arrival_id: arrivalId as string | null }
}

export function parseMailArrivalCursor(value: unknown): MailArrivalCursor {
  return cursor(record(value, CURSOR_KEYS))
}

function coverage(value: Record<string, unknown>): MailboxCoverage {
  if (value.version !== 1 || typeof value.team_id !== 'string' || !exactMatch(WIRE_ID, value.team_id)
    || typeof value.recipient_server_id !== 'string' || !exactMatch(WIRE_ID, value.recipient_server_id)) {
    throw new Error('Invalid Mail mailbox identity')
  }
  return {
    version: 1,
    team_id: value.team_id,
    recipient_server_id: value.recipient_server_id,
    ...cursor(value)
  }
}

export function parseMailboxCoverage(value: unknown): MailboxCoverage {
  return coverage(record(value, COVERAGE_KEYS))
}

export function parseMailArrivalHint(value: unknown): MailArrivalHint {
  const parsed = record(value, [...COVERAGE_KEYS, 'reset'])
  if (typeof parsed.reset !== 'boolean') throw new Error('Invalid Mail hint reset')
  return { ...coverage(parsed), reset: parsed.reset }
}

/** Stable persistence key: no transient connection/generation and no secrets. */
export function mailHintRealmKey(scope: MailHintScope): string {
  return JSON.stringify([scope.profileId, scope.serverIdentity, scope.hubId, scope.teamId, scope.recipientServerId])
}

function sameScope(left: MailHintScope, right: MailHintScope): boolean {
  return left.profileGeneration === right.profileGeneration && left.streamId === right.streamId
    && left.profileId === right.profileId && left.serverIdentity === right.serverIdentity
    && left.hubId === right.hubId && left.teamId === right.teamId && left.recipientServerId === right.recipientServerId
}

function newer(left: Readonly<MailArrivalCursor> | null, right: Readonly<MailArrivalCursor>): Readonly<MailArrivalCursor> {
  if (!left || right.through_sequence > left.through_sequence) return Object.freeze({ ...right })
  return left
}

function contradicts(left: Readonly<MailArrivalCursor> | null, right: Readonly<MailArrivalCursor>): boolean {
  return Boolean(left && left.through_sequence === right.through_sequence && left.arrival_id !== right.arrival_id)
}

function wrongMailbox(state: MailHintState, value: MailboxCoverage): boolean {
  return value.team_id !== state.scope.teamId || value.recipient_server_id !== state.scope.recipientServerId
}

function invalid(state: MailHintState): MailHintState {
  return state.invalid ? state : { ...state, invalid: true }
}

function cursorPending(latest: Readonly<MailArrivalCursor> | null, seen: Readonly<MailArrivalCursor>): boolean {
  return Boolean(latest && (latest.through_sequence > seen.through_sequence || contradicts(latest, seen)))
}

function retainedLatest(state: MailHintState, seen: Readonly<MailArrivalCursor>): Readonly<MailArrivalCursor> | null {
  const left = state.latest
  const right = state.offlineLatest
  if (!left || !right) return left ?? right
  if (left.through_sequence !== right.through_sequence) return left.through_sequence > right.through_sequence ? left : right
  // An unresolved restored identity must remain pending across another failed
  // reconnect, even when the durable seen cursor now matches one of the two.
  return cursorPending(left, seen) ? left : right
}

export function beginMailHintStream(
  scope: MailHintScope,
  retainedSeen: unknown = EMPTY_CURSOR,
  previous?: MailHintState
): MailHintState {
  if (!Number.isSafeInteger(scope.profileGeneration) || scope.profileGeneration < 1
    || ![scope.profileId, scope.streamId, scope.serverIdentity, scope.hubId, scope.teamId, scope.recipientServerId].every(identifier)) {
    throw new Error('Invalid Mail hint scope')
  }
  if (previous && sameScope(previous.scope, scope)) return previous
  const sameRealm = previous && mailHintRealmKey(previous.scope) === mailHintRealmKey(scope)
  const seen = Object.freeze(parseMailArrivalCursor(retainedSeen))
  return {
    scope: Object.freeze({ ...scope }),
    seen,
    retainedSeen: seen,
    latest: null,
    offlineLatest: sameRealm ? retainedLatest(previous, seen) : null,
    freshPrefix: EMPTY_CURSOR,
    initialized: false,
    invalid: false
  }
}

/**
 * Bootstrap may arrive after a live hint. Keep only the newest current-stream
 * cursor and merge it with the initial snapshot; no event backlog is retained.
 * Reset is legal only for that initial, server-authenticated snapshot.
 */
export function applyMailArrivalHint(
  state: MailHintState,
  scope: MailHintScope,
  kind: 'snapshot' | 'hint',
  raw: unknown
): MailHintState {
  if (!sameScope(state.scope, scope) || state.invalid) return state
  let packet: MailArrivalHint
  try { packet = parseMailArrivalHint(raw) } catch { return invalid(state) }
  if (wrongMailbox(state, packet) || (packet.reset && kind !== 'snapshot')) return invalid(state)
  if (kind === 'snapshot' && state.initialized) return invalid(state)
  const incoming: MailArrivalCursor = { through_sequence: packet.through_sequence, arrival_id: packet.arrival_id }
  if (contradicts(state.latest, incoming) || contradicts(state.freshPrefix, incoming)) return invalid(state)
  const latest = newer(state.latest, incoming)
  if (kind === 'hint') {
    if (state.initialized && contradicts(state.seen, incoming)) return invalid(state)
    return latest === state.latest ? state : { ...state, latest }
  }
  // Fresh pages rooted at zero in this new connection do not become unread
  // again merely because the reconnect rejected an older saved anchor.
  const seen = packet.reset ? state.freshPrefix : state.seen
  if (contradicts(seen, incoming) || (!packet.reset && incoming.through_sequence < state.retainedSeen.through_sequence)) return invalid(state)
  return { ...state, seen, latest, offlineLatest: null, initialized: true }
}

/**
 * Call only for a freshly fetched, successfully applied, unfiltered Inbox page.
 * The request captures its exact stream scope and full arrival anchor before
 * I/O. The server must validate that predecessor before returning coverage.
 * Receiving a hint, cached rows, opening Mail, or read receipts never calls this.
 */
export function applyMailPageCoverage(
  state: MailHintState,
  requestScope: MailHintScope,
  requestedAfter: unknown,
  raw: unknown
): MailHintState {
  if (!sameScope(state.scope, requestScope) || state.invalid) return state
  let packet: MailboxCoverage
  let after: MailArrivalCursor
  try {
    packet = parseMailboxCoverage(raw)
    after = parseMailArrivalCursor(requestedAfter)
  } catch { return invalid(state) }
  if (wrongMailbox(state, packet) || packet.through_sequence < after.through_sequence) return invalid(state)
  const covered: MailArrivalCursor = { through_sequence: packet.through_sequence, arrival_id: packet.arrival_id }
  if ((state.initialized && (contradicts(state.seen, covered) || contradicts(state.seen, after)))
    || contradicts(state.freshPrefix, covered) || contradicts(state.freshPrefix, after)
    || contradicts(state.latest, covered) || contradicts(state.latest, after) || contradicts(after, covered)) return invalid(state)
  const freshPrefix = after.through_sequence <= state.freshPrefix.through_sequence
    ? newer(state.freshPrefix, covered) : state.freshPrefix
  const seen = after.through_sequence <= state.seen.through_sequence
    ? newer(state.seen, covered) : state.seen
  if (seen === state.seen && freshPrefix === state.freshPrefix) return state
  return { ...state, seen, freshPrefix }
}

/** This is an unreviewed-arrival dot, not an exact unread-message count. */
export function mailHintPending(state: MailHintState): boolean {
  return cursorPending(state.latest, state.seen) || cursorPending(state.offlineLatest, state.seen)
}
