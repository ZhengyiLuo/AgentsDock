import assert from 'node:assert/strict'
import { AppState as NativeAppState } from 'react-native'
import { SNAPSHOT_CACHE_VERSION } from '../lib/history'
import type { Event, QueuedTurn, Session, Snapshot } from '../types'
import { client, useAppStore } from './useAppStore'

const appState = NativeAppState as typeof NativeAppState & { __emitAppState(state: string): void }
const session: Session = { id: 'paused-queue', title: 'Queue recovery', backend: 'claude' }
const row: QueuedTurn = { queued_id: 'first', session_id: session.id, prompt: 'Keep my request', file_ids: [], position: 0 }
const next: QueuedTurn = { ...row, queued_id: 'next', prompt: 'Keep the order', position: 1 }
const held = (turn: QueuedTurn): QueuedTurn => ({ ...turn, paused: true, promoted: false, pause_reason: 'stopped' })
const cached: Snapshot = { cacheVersion: SNAPSHOT_CACHE_VERSION, session, events: [], queuedTurns: [row, next], files: [], filesTotal: 0, latestSeq: 0, hasMore: false, cachedAt: 1 }
const original = { page: client.sessionPage, stream: client.stream, files: client.files, read: client.markRead, queue: client.queue, run: client.runQueuedNow }
let receive!: Parameters<typeof client.stream>[2]
let authoritative: QueuedTurn[] = [row, next]
let queueReads = 0
let sends = 0
let pendingRead: Promise<QueuedTurn[]> | null = null
let sequence = 0
const packet = (type: string, patch: Partial<Event> = {}): Event => ({ id: `event-${++sequence}`, session_id: session.id, seq: sequence, type, ts: '2026-10-22T00:00:00Z', ...patch })
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }
client.markValidated()
client.sessionPage = async () => ({ session, events: [], queued_turns: authoritative, has_more: false, total: 0, latest_seq: sequence })
client.stream = (_id, _after, onEvent, onState) => { receive = onEvent; onState(true); return () => {} }
client.files = async () => ({ files: [], total: 0, offset: 0, limit: 60, has_more: false })
client.markRead = async () => session
client.queue = async () => { queueReads += 1; return pendingRead ?? authoritative }
client.runQueuedNow = async (_id, queuedId) => { sends += 1; return { ok: true, queued_id: queuedId } }

try {
  appState.__emitAppState('active')
  useAppStore.setState({ initialized: true, activeProfileId: 'uninitialized', profileGeneration: 0,
    serverConfigured: true, connected: true, connecting: false, workspaceAdopting: false,
    health: { ok: true, server_identity: 'uninitialized', api_contract_version: 9 }, sessions: [session],
    selectedSessionId: session.id, snapshots: { [session.id]: cached }, syncStatus: 'cached', liveConnected: false })
  await useAppStore.getState().selectSession(session.id)
  receive(packet('turn_queue_run_now', { queued_id: row.queued_id }))
  assert.deepEqual(useAppStore.getState().snapshots[session.id].queuedTurns.map(turn => turn.queued_id), ['next'])
  authoritative = [held(row), held(next)]
  receive(packet('turn_queue_paused', { queued_ids: ['first', 'next'] }))
  await flush()
  assert.equal(queueReads, 1, 'a bulk Stop must fetch a promoted row missing from the mobile shelf')
  assert.deepEqual(useAppStore.getState().snapshots[session.id].queuedTurns, authoritative, 'restore the held row and the original queue order')
  assert.equal(sends, 0, 'recovering a stopped queue must never resend a message')
  receive(packet('turn_queue_paused', { queued_ids: ['first', 'next'] }))
  await flush()
  assert.equal(queueReads, 1, 'a repeated pause with complete rows must not start polling')

  assert.equal(await useAppStore.getState().runQueuedNow(session.id, row.queued_id, 0), false)
  assert.equal(sends, 1)
  assert.deepEqual(useAppStore.getState().snapshots[session.id].queuedTurns, authoritative, 'an accepted promotion superseded by Stop must retain the held row')
  assert.equal(useAppStore.getState().queuedRunStatus[session.id]?.tone, 'info', 'a user-requested Stop is not a send error')
  assert.match(useAppStore.getState().queuedRunStatus[session.id]?.message ?? '', /stopped/i)

  client.runQueuedNow = async () => { sends += 1; return { ok: false, error: 'Admission rejected' } }
  assert.equal(await useAppStore.getState().runQueuedNow(session.id, row.queued_id, 0), false)
  assert.equal(useAppStore.getState().queuedRunStatus[session.id]?.tone, 'error', 'a paused row must not hide an actual admission failure')
  authoritative = [{ ...held(row), pause_reason: 'delivery_uncertain' }, held(next)]
  client.runQueuedNow = async () => { sends += 1; return { ok: true } }
  assert.equal(await useAppStore.getState().runQueuedNow(session.id, row.queued_id, 0), false)
  assert.equal(useAppStore.getState().queuedRunStatus[session.id]?.tone, 'error', 'an uncertain delivery must not be reported as an ordinary Stop')
  authoritative = [held(row), held(next)]

  let finishRead!: (rows: QueuedTurn[]) => void
  pendingRead = new Promise(resolve => { finishRead = resolve })
  receive(packet('turn_queue_run_now', { queued_id: row.queued_id }))
  receive(packet('turn_queue_paused', { queued_ids: ['first'] }))
  const beforeNavigation = useAppStore.getState().snapshots[session.id]
  useAppStore.setState({ selectedSessionId: 'other-chat' })
  finishRead(authoritative)
  await flush()
  assert.equal(useAppStore.getState().snapshots[session.id], beforeNavigation, 'a late pause refresh must not publish after navigating away')
  assert.equal(sends, 3, 'navigation and refresh must not trigger another send')
  console.log('mobile stopped-promotion stream, queue recovery, no replay and stale-read tests passed')
} finally {
  appState.__emitAppState('background')
  await useAppStore.getState().selectSession(session.id)
  client.sessionPage = original.page
  client.stream = original.stream
  client.files = original.files
  client.markRead = original.read
  client.queue = original.queue
  client.runQueuedNow = original.run
}
