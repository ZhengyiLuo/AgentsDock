import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BulkImportSessionItem,
  BulkImportSessionResult,
  ChatReference,
  ClaudePendingInteraction,
  ClaudeRuntimeSnapshot,
  CodexRuntimeSnapshot,
  Event,
  Health,
  Job,
  JobRunNowResult,
  JobRunHistoryPage,
  LocalSessionCandidate,
  ReasoningSummaryStreamSnapshot,
  RuntimeCatalog,
  ServerRestartRequest,
  ServerRestartStatus,
  ServerUpdateStatus,
  ServerUpdateTrack,
  Session,
  SubagentSnapshot,
  TimelineIndex,
  TimelinePage,
  TimelineTracePage,
  UpdateSessionInput,
  WorkspaceFile,
  WorkspaceCreateResult,
  WorkspaceRemoveResult,
  WorkspaceRenameResult
} from '../shared/types'

const electronHarness = vi.hoisted(() => ({
  notificationSupported: false,
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  shellOpenExternal: vi.fn(),
  notifications: [] as Array<{
    options: { title: string; body: string; silent: boolean }
    shown: boolean
    click?: () => void
  }>
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: class {},
  dialog: {
    showOpenDialog: (...args: unknown[]) => electronHarness.showOpenDialog(...args),
    showSaveDialog: (...args: unknown[]) => electronHarness.showSaveDialog(...args)
  },
  nativeImage: {},
  Notification: class {
    private readonly record: (typeof electronHarness.notifications)[number]
    static isSupported() { return electronHarness.notificationSupported }
    constructor(options: { title: string; body: string; silent: boolean }) {
      this.record = { options, shown: false }
      electronHarness.notifications.push(this.record)
    }
    on(event: string, listener: () => void) {
      if (event === 'click') this.record.click = listener
      return this
    }
    show() { this.record.shown = true }
  },
  safeStorage: {},
  shell: { openExternal: (...args: unknown[]) => electronHarness.shellOpenExternal(...args) }
}))

import { LocalCache, TIMELINE_PAGING_SCHEMA_VERSION } from './persistence'
import {
  ServerError,
  TeamHubBootstrapTransportError,
  type AgentServerClient,
  type ServerUpdateTarget
} from './server-client'
import { AppService, mergePolledSessionSummaries, mergeSessionSummaries, sessionOwnedFilesPage } from './service'
import { SettingsStore } from './settings'
import { PortTunnelManager } from './port-tunnel-manager'
import { mailHintPending, TEAM_MAIL_HINTS_PATH, TEAM_MAIL_HINTS_PROTOCOL, type MailHintPacket, type MailboxCoverage } from '../shared/team-mail-hints'

const cleanup: Array<() => void> = []

describe('main-owned passive Team Mail hints', () => {
  const arrival = (seq: number) => ({ through_sequence: seq, arrival_id: seq ? `tmsg_${seq.toString(16).padStart(32, '0')}` : null })
  const capability = { enabled: true, version: 1, websocket_path: TEAM_MAIL_HINTS_PATH,
    websocket_protocol: TEAM_MAIL_HINTS_PROTOCOL, mailbox_coverage: true,
    mailbox: { hub_id: 'hub-a', team_id: 'team-a', recipient_server_id: null } } as const
  function harness(enabled?: boolean) {
    let health: Health = { ok: true, server_identity: 'server-a', server_instance_id: 'boot-a',
      capabilities: { team_mail_hints_v1: capability } }
    const streams: Array<{ previous(): MailboxCoverage | null; packet(packet: MailHintPacket): void;
      fatal(): void; disconnected(): void; stop: ReturnType<typeof vi.fn> }> = []
    const a = Object.assign(fakeClient({ health: async () => health }), {
      mailHintStream: vi.fn((_identity, _mailbox, previous, packet, fatal, disconnected) => {
        const stream = { previous, packet, fatal, disconnected, stop: vi.fn() }
        streams.push(stream)
        return stream.stop
      })
    })
    const b = Object.assign(fakeClient({ health: async () => ({ ok: true, server_identity: 'server-b' }) }), { mailHintStream: vi.fn() })
    const { settings } = profileSettings()
    const cache = new LocalCache(':memory:')
    const service = new AppService({ settings, cache, mailHintsEnabled: enabled,
      clientFactory: url => (url.includes('a.test') ? a : b) as unknown as AgentServerClient })
    cleanup.push(() => { service.stop(); cache.close() })
    const snapshot = (seq = 3, reset = false, streamId = 'a'.repeat(32), recipient = 'node-a'): MailHintPacket => ({
      type: 'snapshot', server_identity: 'server-a', hub_id: 'hub-a', stream_id: streamId,
      cursor: { version: 1, team_id: 'team-a', recipient_server_id: recipient, reset, ...arrival(seq) }
    })
    return { service, cache, a, b, streams, snapshot, setHealth: (value: Health) => { health = value },
      refresh: () => service.refreshServer('a', 1), health: () => health }
  }

  it('can be explicitly disabled even when the server advertises support', async () => {
    const test = harness(false)
    expect((await test.refresh()).mailHints).toBeNull()
    expect(test.a.mailHintStream).not.toHaveBeenCalled()
  })

  it('negotiates the default lane without probing disabled or older servers', async () => {
    const test = harness()
    for (const capabilities of [undefined, { team_mail_hints_v1: { ...capability, enabled: false, mailbox: null } }]) {
      test.setHealth({ ...test.health(), capabilities })
      expect((await test.refresh()).mailHints).toBeNull()
      expect(test.a.mailHintStream).not.toHaveBeenCalled()
    }
    test.setHealth({ ...test.health(), capabilities: { team_mail_hints_v1: capability } })
    await test.refresh()
    await test.refresh()
    expect(test.a.mailHintStream).toHaveBeenCalledOnce()
  })

  it('singleflights the active stream and hints only change bounded bootstrap metadata', async () => {
    const test = harness(true)
    await test.refresh()
    await test.refresh()
    expect(test.a.mailHintStream).toHaveBeenCalledOnce()
    const methods = [test.a.health, test.a.sessions, test.a.jobs, test.a.runtimeCatalog, test.a.createSession, test.a.markRead, test.a.markUnread]
    const calls = methods.map(method => method.mock.calls.length)
    const put = vi.spyOn(test.cache, 'putPreference')
    test.streams[0].packet(test.snapshot())
    expect(put).toHaveBeenCalledOnce() // stable recipient pointer only; not an acknowledgment
    put.mockClear()
    for (let seq = 4; seq <= 100; seq++) test.streams[0].packet({ ...test.snapshot(seq), type: 'hint' })
    expect(put).not.toHaveBeenCalled()
    expect(methods.map(method => method.mock.calls.length)).toEqual(calls)
    const projection = (await test.service.bootstrap()).mailHints!
    expect(projection.state?.seen).toEqual(arrival(0))
    expect(projection.state?.latest).toEqual(arrival(100))
    expect(mailHintPending(projection.state!)).toBe(true)
    expect(test.service.currentMailHintScope(test.service.teamHubServerScope())).toEqual(projection.state?.scope)
  })

  it('persists only fresh covered prefixes, retains offline arrivals, and fences pages during reconnect', async () => {
    const test = harness(true)
    await test.refresh()
    const stream = test.streams[0]
    stream.packet(test.snapshot(900))
    const initial = (await test.service.bootstrap()).mailHints!.state!
    const ack = { scope: { ...initial.scope }, requestedAfter: arrival(0),
      coverage: { version: 1 as const, team_id: 'team-a', recipient_server_id: 'node-a', ...arrival(400) } }
    const covered = test.service.acknowledgeMailHintPage(ack)!
    expect(covered.state?.seen).toEqual(arrival(400))
    expect(mailHintPending(covered.state!)).toBe(true)
    expect(stream.previous()).toMatchObject(arrival(400))
    stream.disconnected()
    expect(test.service.currentMailHintScope(test.service.teamHubServerScope())).toBeNull()
    expect(test.service.acknowledgeMailHintPage({ ...ack, coverage: { ...ack.coverage, ...arrival(900) } })).toBeNull()
    stream.packet(test.snapshot(900, false, 'b'.repeat(32)))
    const reconnected = (await test.service.bootstrap()).mailHints!
    expect(reconnected.state?.seen).toEqual(arrival(400))
    const stale = test.service.acknowledgeMailHintPage({ ...ack, coverage: { ...ack.coverage, ...arrival(900) } })!
    expect(stale.state?.seen).toEqual(arrival(400))
    const final = test.service.acknowledgeMailHintPage({ ...ack, scope: reconnected.state!.scope,
      coverage: { ...ack.coverage, ...arrival(900) } })!
    expect(mailHintPending(final.state!)).toBe(false)
  })

  it('retires late callbacks on profile switch and shutdown and resets unproven restored anchors', async () => {
    const test = harness(true)
    await test.refresh()
    test.streams[0].packet(test.snapshot(10))
    const state = (await test.service.bootstrap()).mailHints!.state!
    test.service.acknowledgeMailHintPage({ scope: state.scope, requestedAfter: arrival(0),
      coverage: { version: 1, team_id: 'team-a', recipient_server_id: 'node-a', ...arrival(10) } })
    test.streams[0].packet(test.snapshot(12, true, 'b'.repeat(32), 'node-replaced'))
    const restored = (await test.service.bootstrap()).mailHints!.state!
    expect(restored.seen).toEqual(arrival(0))
    expect(restored.scope.recipientServerId).toBe('node-replaced')
    const switched = await test.service.switchServer('b')
    expect(test.streams[0].stop).toHaveBeenCalledOnce()
    test.streams[0].packet(test.snapshot(100))
    expect((await test.service.bootstrap()).mailHints).toBeNull()
    expect(switched.mailHints).toBeNull()
    test.service.stop()
    expect(test.b.mailHintStream).not.toHaveBeenCalled()
  })

  it('suspends on unverified health and reconnects only after fresh health with exact authority', async () => {
    const test = harness(true)
    await test.refresh()
    test.streams[0].packet(test.snapshot(8))
    test.a.health.mockRejectedValueOnce(new Error('offline'))
    await test.refresh()
    expect(test.streams[0].stop).toHaveBeenCalledOnce()
    expect(test.service.currentMailHintScope(test.service.teamHubServerScope())).toBeNull()
    expect(mailHintPending((await test.service.bootstrap()).mailHints!.state!)).toBe(true)
    await test.refresh()
    expect(test.a.mailHintStream).toHaveBeenCalledTimes(2)
    test.streams[1].packet(test.snapshot(8, false, 'b'.repeat(32)))
    test.setHealth({ ...test.health(), server_instance_id: 'boot-b' })
    await test.refresh()
    expect(test.streams[1].stop).toHaveBeenCalledOnce()
    expect(test.a.mailHintStream).toHaveBeenCalledTimes(3)
    test.streams[2].fatal()
    expect((await test.service.bootstrap()).mailHints).toBeNull()
  })

  it('reloads the exact durable seen anchor after leaving and reopening a profile, never the latest hint', async () => {
    const test = harness(true)
    await test.refresh()
    test.streams[0].packet(test.snapshot(40))
    const state = (await test.service.bootstrap()).mailHints!.state!
    const ack = { scope: state.scope, requestedAfter: arrival(0),
      coverage: { version: 1 as const, team_id: 'team-a', recipient_server_id: 'node-a', ...arrival(10) } }
    test.service.acknowledgeMailHintPage(ack)
    expect(test.service.acknowledgeMailHintPage({ ...ack, body: 'unexpected' } as never)).toBeNull()
    await test.service.switchServer('b')
    const reopened = await test.service.switchServer('a')
    await test.service.refreshServer('a', reopened.profileGeneration)
    expect(test.streams.at(-1)!.previous()).toEqual({ version: 1, team_id: 'team-a', recipient_server_id: 'node-a', ...arrival(10) })
    test.streams.at(-1)!.packet(test.snapshot(40, false, 'c'.repeat(32)))
    const latest = (await test.service.bootstrap()).mailHints!.state!
    expect(latest.seen).toEqual(arrival(10))
    expect(mailHintPending(latest)).toBe(true)
    const poisoned = test.service.acknowledgeMailHintPage({ ...ack, scope: latest.scope,
      coverage: { ...ack.coverage, through_sequence: 40, arrival_id: `tmsg_${'e'.repeat(32)}` } })!
    expect(poisoned.state?.invalid).toBe(true)
    expect(test.service.currentMailHintScope(test.service.teamHubServerScope())).toBeNull()
  })
})

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.()
  electronHarness.notificationSupported = false
  electronHarness.notifications.length = 0
  electronHarness.showOpenDialog.mockReset()
  electronHarness.showSaveDialog.mockReset()
  electronHarness.shellOpenExternal.mockReset()
})

describe('session summary merging', () => {
  it('keeps the retained endpoint model list when a slim summary omits it', () => {
    const catalog = { configured: true, available: true, model: null, base_url: 'https://first.example/v1',
      models: [{ value: 'first/model', label: 'First' }], model_efforts: { 'first/model': [{ value: 'high', label: 'High' }] } }
    const existing: Session = { id: 'chat', title: 'Chat', backend: 'codex', codex_provider: 'custom', codex_provider_catalog: catalog }
    const { models: _models, model_efforts: _efforts, ...summary } = catalog
    expect(mergeSessionSummaries([existing], [{ ...existing, codex_provider_catalog: summary }])[0].codex_provider_catalog).toEqual(catalog)
    expect(mergeSessionSummaries([existing], [{ ...existing, codex_provider_catalog: { ...summary, base_url: 'https://second.example/v1' } }])[0].codex_provider_catalog?.models).toBeUndefined()
  })
  it('preserves selected-session details omitted by compact polling', () => {
    const previous: Session[] = [{
      id: 'chat',
      title: 'Before',
      backend: 'codex',
      system_prompt: 'Keep this detail',
      codex_thread_id: 'thread-1',
      latest_agent_event_seq: 4
    }]

    expect(mergeSessionSummaries(previous, [{
      id: 'chat',
      title: 'After',
      backend: 'codex',
      latest_agent_event_seq: 5
    }])).toEqual([expect.objectContaining({
      title: 'After',
      system_prompt: 'Keep this detail',
      codex_thread_id: 'thread-1',
      latest_agent_event_seq: 5
    })])
  })

  it('treats an omitted emergency projection in canonical polling as an explicit clear', () => {
    const previous: Session[] = [{
      id: 'chat', title: 'Before', backend: 'codex', system_prompt: 'Keep this detail',
      emergency_alert: {
        id: `emergency_${'a'.repeat(32)}`,
        status: 'active', severity: 'critical', message: 'Previously active.',
        raised_at: '2026-08-25T12:00:00Z'
      },
      unacknowledged_emergency_count: 1
    }]

    expect(mergePolledSessionSummaries(previous, [{
      id: 'chat', title: 'After', backend: 'codex'
    }])).toEqual([expect.objectContaining({
      title: 'After',
      system_prompt: 'Keep this detail',
      emergency_alert: null,
      unacknowledged_emergency_count: 0
    })])
  })
})

describe('background refresh failures', () => {
  function addInteractiveWindow(service: AppService) {
    const listeners = new Map<string, (event: unknown, input: { type: string }) => void>()
    const window = {
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      webContents: {
        id: 41,
        send: vi.fn(),
        on: vi.fn((event: string, listener: (event: unknown, input: { type: string }) => void) => {
          listeners.set(event, listener)
        })
      }
    }
    service.addWindow(window as never)
    return { listeners, window }
  }

  async function settleImmediateRefresh(): Promise<void> {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  }

  it('settles a cache write failure instead of leaking a rejected timer promise', async () => {
    const client = fakeClient({
      sessions: async () => [{ id: 'chat', title: 'Changed', backend: 'codex' }]
    })
    const { service, cache } = createProfileService({ 'http://a.test:7850': [client] })
    const failure = new Error('cache write failed')
    vi.spyOn(cache, 'putSessions').mockImplementation(() => { throw failure })
    const internals = service as unknown as {
      scope: unknown
      runBackgroundRefresh(includeJobs: boolean, scope: unknown): Promise<void>
    }

    await expect(internals.runBackgroundRefresh(false, internals.scope)).resolves.toBeUndefined()
    expect(cache.putSessions).toHaveBeenCalledOnce()
  })

  it('defers the reconciliation poll until keyboard input has been quiet', async () => {
    vi.useFakeTimers()
    let service: AppService | null = null
    try {
      const active = fakeClient()
      const inactive = fakeClient()
      ;({ service } = createProfileService({
        'http://a.test:7850': [active],
        'http://b.test:7850': [inactive]
      }))
      const { listeners } = addInteractiveWindow(service)
      service.start()
      await settleImmediateRefresh()
      active.health.mockClear()
      active.sessions.mockClear()
      active.jobs.mockClear()

      await vi.advanceTimersByTimeAsync(29_900)
      listeners.get('before-input-event')?.({}, { type: 'keyDown' })
      await vi.advanceTimersByTimeAsync(100)

      expect(active.health).not.toHaveBeenCalled()
      expect(active.sessions).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(500)
      listeners.get('before-input-event')?.({}, { type: 'char' })
      await vi.advanceTimersByTimeAsync(2_999)
      expect(active.health).not.toHaveBeenCalled()
      expect(active.sessions).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(active.health).toHaveBeenCalledOnce()
      expect(active.sessions).toHaveBeenCalledOnce()
      expect(active.jobs).not.toHaveBeenCalled()
    } finally {
      service?.stop()
      vi.useRealTimers()
    }
  })

  it('coalesces continued scrolling and runs one poll promptly after real quiet', async () => {
    vi.useFakeTimers()
    let service: AppService | null = null
    try {
      const active = fakeClient()
      const inactive = fakeClient()
      ;({ service } = createProfileService({
        'http://a.test:7850': [active],
        'http://b.test:7850': [inactive]
      }))
      const { listeners } = addInteractiveWindow(service)
      service.start()
      await settleImmediateRefresh()
      active.health.mockClear()
      active.sessions.mockClear()

      await vi.advanceTimersByTimeAsync(29_900)
      listeners.get('before-mouse-event')?.({}, { type: 'mouseWheel' })
      await vi.advanceTimersByTimeAsync(100)
      for (let index = 0; index < 20; index += 1) {
        await vi.advanceTimersByTimeAsync(500)
        listeners.get('before-mouse-event')?.({}, { type: 'mouseWheel' })
      }

      expect(active.health).not.toHaveBeenCalled()
      expect(active.sessions).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_999)
      expect(active.health).not.toHaveBeenCalled()
      expect(active.sessions).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(active.health).toHaveBeenCalledOnce()
      expect(active.sessions).toHaveBeenCalledOnce()
    } finally {
      service?.stop()
      vi.useRealTimers()
    }
  })

  it('does not overlap a deferred poll and resumes on a later interval', async () => {
    vi.useFakeTimers()
    let service: AppService | null = null
    try {
      const stalledSessions = deferred<Session[]>()
      let sessionRequest = 0
      const active = fakeClient({
        sessions: () => {
          sessionRequest += 1
          if (sessionRequest === 1) return Promise.resolve([])
          if (sessionRequest === 2) return stalledSessions.promise
          return Promise.resolve([])
        }
      })
      const inactive = fakeClient()
      ;({ service } = createProfileService({
        'http://a.test:7850': [active],
        'http://b.test:7850': [inactive]
      }))
      const { listeners } = addInteractiveWindow(service)
      service.start()
      await settleImmediateRefresh()
      active.health.mockClear()
      active.sessions.mockClear()

      await vi.advanceTimersByTimeAsync(29_900)
      listeners.get('before-input-event')?.({}, { type: 'keyDown' })
      await vi.advanceTimersByTimeAsync(3_000)
      expect(active.sessions).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(27_100)
      expect(active.health).toHaveBeenCalledOnce()
      expect(active.sessions).toHaveBeenCalledOnce()

      stalledSessions.resolve([])
      await settleImmediateRefresh()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(active.health).toHaveBeenCalledTimes(2)
      expect(active.sessions).toHaveBeenCalledTimes(2)
    } finally {
      service?.stop()
      vi.useRealTimers()
    }
  })

  it('holds a fetched background result through continuous input and applies it once after quiet', async () => {
    vi.useFakeTimers()
    let service: AppService | null = null
    try {
      const fetchedSessions = deferred<Session[]>()
      let sessionRequest = 0
      const active = fakeClient({
        sessions: () => {
          sessionRequest += 1
          return sessionRequest === 1
            ? Promise.resolve([{ id: 'chat', title: 'Before', backend: 'codex' }])
            : fetchedSessions.promise
        }
      })
      const inactive = fakeClient()
      const created = createProfileService({
        'http://a.test:7850': [active],
        'http://b.test:7850': [inactive]
      })
      service = created.service
      const { listeners, window } = addInteractiveWindow(service)
      service.start()
      await settleImmediateRefresh()
      active.health.mockClear()
      active.sessions.mockClear()
      window.webContents.send.mockClear()
      const putSessions = vi.spyOn(created.cache, 'putSessions')

      await vi.advanceTimersByTimeAsync(30_000)
      expect(active.sessions).toHaveBeenCalledOnce()
      listeners.get('before-input-event')?.({}, { type: 'keyDown' })
      fetchedSessions.resolve([{ id: 'chat', title: 'After', backend: 'codex' }])
      await settleImmediateRefresh()

      expect(putSessions).not.toHaveBeenCalled()
      expect(window.webContents.send).not.toHaveBeenCalledWith('server:sessions', expect.anything())
      expect((await service.bootstrap()).sessions).toEqual([
        expect.objectContaining({ id: 'chat', title: 'Before' })
      ])

      for (let index = 0; index < 6; index += 1) {
        await vi.advanceTimersByTimeAsync(500)
        listeners.get('before-input-event')?.({}, { type: 'char' })
      }
      expect(putSessions).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_999)
      expect(putSessions).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      expect(putSessions).toHaveBeenCalledOnce()
      expect(window.webContents.send.mock.calls.filter(([channel]) => channel === 'server:sessions')).toHaveLength(1)
      expect((await service.bootstrap()).sessions).toEqual([
        expect.objectContaining({ id: 'chat', title: 'After' })
      ])
    } finally {
      service?.stop()
      vi.useRealTimers()
    }
  })

  it('cancels a post-fetch quiet waiter on stop without applying its result', async () => {
    vi.useFakeTimers()
    let service: AppService | null = null
    try {
      const fetchedSessions = deferred<Session[]>()
      let sessionRequest = 0
      const active = fakeClient({
        sessions: () => ++sessionRequest === 1
          ? Promise.resolve([{ id: 'chat', title: 'Before', backend: 'codex' }])
          : fetchedSessions.promise
      })
      const inactive = fakeClient()
      const created = createProfileService({
        'http://a.test:7850': [active],
        'http://b.test:7850': [inactive]
      })
      service = created.service
      const { listeners, window } = addInteractiveWindow(service)
      const internals = service as unknown as { backgroundApplyQuietWaiters: Map<number, Set<(apply: boolean) => void>> }
      service.start()
      await settleImmediateRefresh()
      window.webContents.send.mockClear()
      const putSessions = vi.spyOn(created.cache, 'putSessions')

      await vi.advanceTimersByTimeAsync(30_000)
      listeners.get('before-mouse-event')?.({}, { type: 'mouseWheel' })
      fetchedSessions.resolve([{ id: 'chat', title: 'After stop', backend: 'codex' }])
      await settleImmediateRefresh()
      expect(internals.backgroundApplyQuietWaiters.size).toBe(1)

      service.stop()
      await settleImmediateRefresh()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(internals.backgroundApplyQuietWaiters.size).toBe(0)
      expect(putSessions).not.toHaveBeenCalled()
      expect(window.webContents.send).not.toHaveBeenCalledWith('server:sessions', expect.anything())
    } finally {
      service?.stop()
      vi.useRealTimers()
    }
  })

  it('publishes reconnect health before deferring the fetched session apply', async () => {
    vi.useFakeTimers()
    let service: AppService | null = null
    try {
      const fetchedSessions = deferred<Session[]>()
      let healthRequest = 0
      let sessionRequest = 0
      const active = fakeClient({
        health: async () => {
          if (++healthRequest === 1) throw new Error('offline')
          return { ok: true }
        },
        sessions: () => ++sessionRequest === 1 ? Promise.resolve([]) : fetchedSessions.promise
      })
      const inactive = fakeClient()
      const created = createProfileService({
        'http://a.test:7850': [active],
        'http://b.test:7850': [inactive]
      })
      service = created.service
      const { listeners, window } = addInteractiveWindow(service)
      service.start()
      await settleImmediateRefresh()
      window.webContents.send.mockClear()
      const putSessions = vi.spyOn(created.cache, 'putSessions')

      await vi.advanceTimersByTimeAsync(30_000)
      listeners.get('before-input-event')?.({}, { type: 'keyDown' })
      fetchedSessions.resolve([{ id: 'chat', title: 'Recovered', backend: 'codex' }])
      await settleImmediateRefresh()

      expect(window.webContents.send.mock.calls).toContainEqual([
        'server:connection',
        expect.objectContaining({ connected: true })
      ])
      expect(putSessions).not.toHaveBeenCalled()
      expect((await service.bootstrap()).sessions).toEqual([])
    } finally {
      service?.stop()
      vi.useRealTimers()
    }
  })

  it('lets an explicit server refresh promote an in-flight background apply during recent input', async () => {
    vi.useFakeTimers()
    let service: AppService | null = null
    try {
      const fetchedSessions = deferred<Session[]>()
      let sessionRequest = 0
      const active = fakeClient({
        sessions: () => ++sessionRequest === 1
          ? Promise.resolve([{ id: 'chat', title: 'Before', backend: 'codex' }])
          : fetchedSessions.promise
      })
      const inactive = fakeClient()
      const created = createProfileService({
        'http://a.test:7850': [active],
        'http://b.test:7850': [inactive]
      })
      service = created.service
      const { listeners } = addInteractiveWindow(service)
      service.start()
      await settleImmediateRefresh()
      const putSessions = vi.spyOn(created.cache, 'putSessions')
      const payload = await service.bootstrap()

      await vi.advanceTimersByTimeAsync(30_000)
      listeners.get('before-input-event')?.({}, { type: 'keyDown' })
      fetchedSessions.resolve([{ id: 'chat', title: 'Explicit refresh', backend: 'codex' }])
      await settleImmediateRefresh()
      expect(putSessions).not.toHaveBeenCalled()

      const refreshed = service.refreshServer('a', payload.profileGeneration)
      await settleImmediateRefresh()

      expect(putSessions).toHaveBeenCalledOnce()
      await expect(refreshed).resolves.toEqual(expect.objectContaining({
        sessions: [expect.objectContaining({ title: 'Explicit refresh' })]
      }))
    } finally {
      service?.stop()
      vi.useRealTimers()
    }
  })

  it('cancels a deferred all-session poll when the service stops', async () => {
    vi.useFakeTimers()
    let service: AppService | null = null
    try {
      const active = fakeClient()
      const inactive = fakeClient()
      ;({ service } = createProfileService({
        'http://a.test:7850': [active],
        'http://b.test:7850': [inactive]
      }))
      const { listeners } = addInteractiveWindow(service)
      const internals = service as unknown as {
        deferredBackgroundRefreshTimer: NodeJS.Timeout | null
        deferredBackgroundRefresh: unknown | null
      }
      service.start()
      await settleImmediateRefresh()
      active.health.mockClear()
      active.sessions.mockClear()

      await vi.advanceTimersByTimeAsync(29_900)
      listeners.get('before-input-event')?.({}, { type: 'rawKeyDown' })
      await vi.advanceTimersByTimeAsync(100)
      expect(internals.deferredBackgroundRefreshTimer).not.toBeNull()
      expect(internals.deferredBackgroundRefresh).not.toBeNull()

      service.stop()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(internals.deferredBackgroundRefreshTimer).toBeNull()
      expect(internals.deferredBackgroundRefresh).toBeNull()
      expect(active.health).not.toHaveBeenCalled()
      expect(active.sessions).not.toHaveBeenCalled()
    } finally {
      service?.stop()
      vi.useRealTimers()
    }
  })
})

describe('emergency alert memory bounds', () => {
  it('bounds cached seen-alert hydration across more than four thousand chats', () => {
    const sessions: Session[] = Array.from({ length: 4_100 }, (_, index) => ({
      id: `chat-${index}`,
      title: `Chat ${index}`,
      backend: 'codex',
      emergency_alert: {
        id: `emergency_${index.toString(16).padStart(32, '0')}`,
        status: 'active',
        severity: 'critical',
        message: `Emergency ${index}`,
        raised_at: '2026-08-25T12:00:00Z'
      },
      unacknowledged_emergency_count: 1
    }))
    const { service } = createProfileService({
      'http://a.test:7850': [fakeClient()],
      'http://b.test:7850': [fakeClient()]
    }, cache => cache.putSessions('profile:a', sessions))
    const seen = (service as unknown as { seenEmergencyAlertIds: Set<string> })
      .seenEmergencyAlertIds

    expect(seen.size).toBe(4_096)
    expect(seen.has('emergency_' + '0'.repeat(32))).toBe(false)
    expect(seen.has(`emergency_${(4_099).toString(16).padStart(32, '0')}`)).toBe(true)
  })
})

describe('session file ownership', () => {
  it('keeps current and legacy files while rejecting explicit foreign records', () => {
    const page = sessionOwnedFilesPage({
      files: [
        { id: 'current', session_id: 'child', filename: 'current.txt' },
        { id: 'legacy', filename: 'legacy.txt' },
        { id: 'foreign', session_id: 'parent', filename: 'foreign.txt' }
      ],
      total: 3,
      offset: 0,
      limit: 60,
      has_more: false
    }, 'child')

    expect(page.files.map(file => file.id)).toEqual(['current', 'legacy'])
    expect(page.total).toBe(2)
  })
})

describe('inspector visibility preference', () => {
  it('defaults to folded while preserving an explicitly saved open state', async () => {
    const { service, cache } = createProfileService({
      'http://a.test:7850': [fakeClient()]
    })

    await expect(service.bootstrap()).resolves.toEqual(expect.objectContaining({ inspectorVisible: false }))

    cache.putPreference('profile:a', 'inspectorVisible', true)
    await expect(service.bootstrap()).resolves.toEqual(expect.objectContaining({ inspectorVisible: true }))
  })
})

describe('server-wide Codex goals compatibility', () => {
  it('reports legacy servers as unavailable instead of breaking Settings', async () => {
    const client = {
      codexServerGoals: vi.fn().mockRejectedValue(new ServerError(404, 'Not found')),
      setCodexServerGoals: vi.fn().mockRejectedValue(new ServerError(501, 'Not implemented'))
    }
    const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined),
      assertCurrentScope: vi.fn()
    })

    await expect(service.codexServerGoals()).resolves.toEqual({
      enabled: true,
      configurable: false,
      message: 'Update AgentsServer to manage persistent Codex goals.'
    })
    await expect(service.setCodexServerGoals(false)).resolves.toEqual({
      enabled: true,
      configurable: false,
      message: 'Update AgentsServer to manage persistent Codex goals.'
    })
  })
})

describe('server-wide Codex subagents scope', () => {
  const configuration = { configurable: true, max_concurrent_threads_per_session: 8,
    scope: 'server', applies_to: 'new_or_reloaded_threads', message: 'Synthetic setting.' }
  const caller = { profileId: 'profile-a', profileGeneration: 1 }

  function harness() {
    const client = {
      codexServerSubagents: vi.fn().mockResolvedValue(configuration),
      setCodexServerSubagents: vi.fn().mockResolvedValue(configuration)
    }
    const scope = { profileId: 'profile-a', generation: 1, namespace: 'profile:profile-a', client }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, { scope, activeProfileId: scope.profileId, profileGeneration: scope.generation,
      validatedGeneration: scope.generation, profileResetIsPending: vi.fn().mockReturnValue(false) })
    return { service, client, scope }
  }

  it('delegates explicit read/save/reset to the captured validated profile without extra refresh', async () => {
    const { service, client } = harness()
    const refresh = vi.fn(() => { throw new Error('Unexpected settings refresh') })
    Object.assign(service, { refreshAll: refresh })
    await expect(service.codexServerSubagents(caller)).resolves.toEqual(configuration)
    await expect(service.setCodexServerSubagents(caller, 32)).resolves.toEqual(configuration)
    await expect(service.setCodexServerSubagents(caller, null)).resolves.toEqual(configuration)
    expect(client.codexServerSubagents).toHaveBeenCalledOnce()
    expect(client.setCodexServerSubagents.mock.calls).toEqual([[32], [null]])
    expect(refresh).not.toHaveBeenCalled()
  })

  it.each(['read', 'write'] as const)('rejects a late %s result after profile generation changes', async operation => {
    const { service, client } = harness()
    const response = deferred<typeof configuration>()
    const called = deferred<void>()
    client[operation === 'read' ? 'codexServerSubagents' : 'setCodexServerSubagents']
      .mockImplementation(() => { called.resolve(); return response.promise })
    const pending = operation === 'read' ? service.codexServerSubagents(caller) : service.setCodexServerSubagents(caller, 32)
    await called.promise
    const otherClient = { codexServerSubagents: vi.fn(), setCodexServerSubagents: vi.fn() }
    Object.assign(service, { scope: { profileId: 'profile-a', generation: 2, client: otherClient }, profileGeneration: 2 })
    response.resolve(configuration)
    await expect(pending).rejects.toThrow('superseded')
    expect(otherClient.codexServerSubagents).not.toHaveBeenCalled()
    expect(otherClient.setCodexServerSubagents).not.toHaveBeenCalled()
  })

  it('does not write when profile validation is superseded before dispatch', async () => {
    const { service, client } = harness()
    const validation = deferred<void>()
    Object.assign(service, { validatedGeneration: 0, refreshAll: vi.fn(() => validation.promise) })
    const pending = service.setCodexServerSubagents(caller, 32)
    Object.assign(service, { activeProfileId: 'profile-b', profileGeneration: 2 })
    validation.resolve()
    await expect(pending).rejects.toThrow('superseded')
    expect(client.setCodexServerSubagents).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404, 405, 501])('preserves HTTP %s for the renderer compatibility message without retrying', async status => {
    const { service, client } = harness()
    const error = new ServerError(status, 'Synthetic unavailable setting.')
    client.codexServerSubagents.mockRejectedValue(error)
    client.setCodexServerSubagents.mockRejectedValue(error)
    await expect(service.codexServerSubagents(caller)).rejects.toBe(error)
    await expect(service.setCodexServerSubagents(caller, 32)).rejects.toBe(error)
    expect(client.codexServerSubagents).toHaveBeenCalledOnce()
    expect(client.setCodexServerSubagents).toHaveBeenCalledOnce()
  })

  it.each(['different-profile', 'same-profile-new-generation'] as const)(
    'rejects a stale renderer caller before validation or either server is contacted: %s', async transition => {
      const { service, client } = harness()
      const otherClient = { codexServerSubagents: vi.fn(), setCodexServerSubagents: vi.fn() }
      const profileId = transition === 'different-profile' ? 'profile-b' : caller.profileId
      const validation = vi.fn(() => { throw new Error('Stale caller reached validation') })
      Object.assign(service, {
        scope: { profileId, generation: 2, client: otherClient },
        activeProfileId: profileId, profileGeneration: 2, ensureValidatedScope: validation
      })
      await expect(service.codexServerSubagents(caller)).rejects.toThrow('superseded')
      await expect(service.setCodexServerSubagents(caller, 32)).rejects.toThrow('superseded')
      expect(validation).not.toHaveBeenCalled()
      for (const candidate of [client, otherClient]) {
        expect(candidate.codexServerSubagents).not.toHaveBeenCalled()
        expect(candidate.setCodexServerSubagents).not.toHaveBeenCalled()
      }
    }
  )
})

describe('Codex account status profile isolation', () => {
  const caller = { profileId: 'profile-a', profileGeneration: 1 }
  const account = { available: true, auth_mode: 'apiKey', email: null, plan_type: null, requires_openai_auth: true }
  function harness() {
    const client = { codexAuth: vi.fn().mockResolvedValue(account) }
    const scope = { profileId: caller.profileId, generation: 1, namespace: 'profile:profile-a', client }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, { scope, activeProfileId: caller.profileId, profileGeneration: 1,
      validatedGeneration: 1, profileResetIsPending: vi.fn().mockReturnValue(false) })
    return { service, client }
  }
  it('reads the captured account and has no credential-mutation method', async () => {
    const { service, client } = harness()
    expect(await service.codexAuth(caller)).toEqual(account)
    expect(client.codexAuth).toHaveBeenCalledOnce()
    expect(service).not.toHaveProperty('codexLoginWithApiKey')
  })
  it('rejects a stale renderer before reading another server', async () => {
    const { service, client } = harness()
    Object.assign(service, { activeProfileId: 'profile-b', profileGeneration: 2 })
    await expect(service.codexAuth(caller)).rejects.toThrow('superseded')
    expect(client.codexAuth).not.toHaveBeenCalled()
  })
  it('rejects a late account result after switching servers', async () => {
    const { service, client } = harness()
    const response = deferred<typeof account>(), called = deferred<void>()
    client.codexAuth.mockImplementation(() => { called.resolve(); return response.promise })
    const pending = service.codexAuth(caller)
    await called.promise
    Object.assign(service, { activeProfileId: 'profile-b', profileGeneration: 2 })
    response.resolve(account)
    await expect(pending).rejects.toThrow('superseded')
    expect(client.codexAuth).toHaveBeenCalledOnce()
  })
})

describe('Codex endpoint request profile isolation', () => {
  const caller = { profileId: 'provider-a', profileGeneration: 1 }
  const configuration = { available: true, configured: true, base_url: 'https://gateway.example/v1',
    model: 'gpt-6-astra', has_api_key: true, wire_api: 'responses' }
  const input = { base_url: configuration.base_url, model: configuration.model, api_key: 'synthetic-key' }
  const testResult = { ok: true, status: 'ready', message: '' }
  function harness() {
    const client = { codexProviderModels: vi.fn().mockRejectedValue(new Error('offline discovery')), codexProvider: vi.fn().mockResolvedValue(configuration), testCodexProvider: vi.fn().mockResolvedValue(testResult),
      setCodexProvider: vi.fn().mockResolvedValue(configuration), resetCodexProvider: vi.fn().mockResolvedValue(configuration) }
    const service = Object.create(AppService.prototype) as AppService
    const refreshRuntime = vi.fn().mockResolvedValue(undefined)
    Object.assign(service, { scope: { profileId: caller.profileId, generation: 1, namespace: 'profile:provider-a', client },
      activeProfileId: caller.profileId, profileGeneration: 1, validatedGeneration: 1,
      health: { capabilities: { codex_provider_v1: { available: true, per_chat: true, per_chat_models: true } } },
      profileResetIsPending: vi.fn().mockReturnValue(false), refreshRuntime })
    return { service, client, refreshRuntime }
  }
  it('does not refresh or save during testing; saves/resets explicitly refresh once', async () => {
    const { service, client, refreshRuntime } = harness()
    expect(await service.codexProvider(caller)).toEqual(configuration)
    expect(await service.testCodexProvider(caller, input)).toEqual(testResult)
    expect(refreshRuntime).not.toHaveBeenCalled()
    expect(client.setCodexProvider).not.toHaveBeenCalled()
    expect(await service.setCodexProvider(caller, input)).toEqual(configuration)
    expect(refreshRuntime).toHaveBeenCalledOnce()
    await service.resetCodexProvider(caller)
    expect(refreshRuntime).toHaveBeenCalledTimes(2)
    expect(client.testCodexProvider.mock.calls).toEqual([[input]])
    expect(client.setCodexProvider.mock.calls).toEqual([[input]])
  })
  it.each(['codexProvider', 'testCodexProvider', 'setCodexProvider', 'resetCodexProvider'] as const)(
    'rejects stale selection before %s can dispatch any key', async action => {
      const { service, client } = harness()
      Object.assign(service, { activeProfileId: 'provider-b', profileGeneration: 2 })
      await expect(service[action](caller, input)).rejects.toThrow('superseded')
      for (const request of Object.values(client)) expect(request).not.toHaveBeenCalled()
    }
  )
  it('discards late endpoint test result after changing servers', async () => {
    const { service, client, refreshRuntime } = harness()
    const response = deferred<typeof testResult>(), started = deferred<void>()
    client.testCodexProvider.mockImplementation(() => { started.resolve(); return response.promise })
    const pending = service.testCodexProvider(caller, input)
    await started.promise
    Object.assign(service, { activeProfileId: 'provider-b', profileGeneration: 2 })
    response.resolve(testResult)
    await expect(pending).rejects.toThrow('superseded')
    expect(refreshRuntime).not.toHaveBeenCalled()
  })
  it('does not turn saved settings into a failure when readiness refresh fails', async () => {
    const { service, client, refreshRuntime } = harness()
    refreshRuntime.mockRejectedValue(new Error('offline'))
    await expect(service.setCodexProvider(caller, input)).resolves.toEqual(configuration)
    expect(client.setCodexProvider).toHaveBeenCalledOnce()
  })
  it('completes saving before a slow endpoint model discovery returns', async () => {
    const { service, client } = harness()
    client.codexProviderModels.mockImplementation(() => new Promise(() => {}))
    await expect(service.setCodexProvider(caller, input)).resolves.toEqual(configuration)
    expect(client.codexProviderModels).toHaveBeenCalledOnce()
  })
  it('does not configure a custom endpoint on older global-override servers, but permits recovery reset', async () => {
    const { service, client } = harness()
    Object.assign(service, { health: { capabilities: { codex_provider_v1: { available: true } } } })
    await expect(service.setCodexProvider(caller, input)).rejects.toThrow('CODEX_PROVIDER_UPDATE')
    expect(client.setCodexProvider).not.toHaveBeenCalled()
    await expect(service.resetCodexProvider(caller)).resolves.toEqual(configuration)
  })
})

describe('per-chat Codex endpoint compatibility', () => {
  function harness(perChat: boolean) {
    const session = { id: 'chat', title: 'Chat', backend: 'codex', codex_provider: 'custom' }
    const client = { createSession: vi.fn().mockResolvedValue(session), updateSession: vi.fn().mockResolvedValue(session) }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, { scope: { profileId: 'profile', generation: 1, namespace: 'profile:profile', client },
      activeProfileId: 'profile', profileGeneration: 1, validatedGeneration: 1,
      profileResetIsPending: vi.fn().mockReturnValue(false), upsertSession: vi.fn(),
      health: { capabilities: { codex_provider_v1: { available: true, per_chat: perChat } } } })
    return { service, client }
  }
  const draft = { title: 'Chat', folder: 'General', cwd: '/work', backend: 'codex' as const, codex_provider: 'custom' as const }
  it('refuses an old server before it can silently create or switch to ordinary Codex', async () => {
    const { service, client } = harness(false)
    await expect(service.createSession(draft)).rejects.toThrow('Update AgentsServer')
    await expect(service.resumeSession({ ...draft, providerId: 'native-thread' })).rejects.toThrow('Update AgentsServer')
    await expect(service.updateSession('chat', { codex_provider: 'custom' })).rejects.toThrow('Update AgentsServer')
    expect(client.createSession).not.toHaveBeenCalled()
    expect(client.updateSession).not.toHaveBeenCalled()
  })
  it('passes explicit choices to a capable server without changing normal chat behavior', async () => {
    const { service, client } = harness(true)
    await service.createSession(draft)
    await service.updateSession('chat', { codex_provider: 'default' })
    expect(client.createSession).toHaveBeenCalledWith(draft)
    expect(client.updateSession).toHaveBeenCalledWith('chat', { codex_provider: 'default' })
    const legacy = harness(false)
    await legacy.service.createSession({ ...draft, codex_provider: undefined })
    expect(legacy.client.createSession).toHaveBeenCalledOnce()
  })
})

describe('per-chat sub-agent limit ownership', () => {
  function harness(capable = true) {
    const client = { createSession: vi.fn(), updateSession: vi.fn().mockResolvedValue({ id: 'chat' }) }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, { scope: { profileId: 'one', generation: 4, namespace: 'one', client },
      activeProfileId: 'one', profileGeneration: 4, validatedGeneration: 4,
      settings: { getProfile: () => ({ serverIdentity: 'server-one' }) },
      profileResetIsPending: vi.fn().mockReturnValue(false), upsertSession: vi.fn(),
      health: { capabilities: capable ? { subagent_limit_v1: { version: 1 } } : {} } })
    return { service, client }
  }
  const scope = { profileId: 'one', profileGeneration: 4, serverIdentity: 'server-one' }
  it('refuses a stale target before issuing any request', async () => {
    const { service, client } = harness()
    await expect(service.updateSession('chat', { subagent_limit: 3 }, { ...scope, profileGeneration: 3 })).rejects.toThrow()
    await expect(service.updateSession('chat', { subagent_limit: 3 }, { ...scope, serverIdentity: 'replaced' })).rejects.toThrow()
    expect(client.updateSession).not.toHaveBeenCalled()
    await service.updateSession('chat', { subagent_limit: 3 }, scope)
    expect(client.updateSession).toHaveBeenCalledExactlyOnceWith('chat', { subagent_limit: 3 })
  })
  it('refuses old servers even when clearing, before silent field loss', async () => {
    const { service, client } = harness(false)
    await expect(service.updateSession('chat', { subagent_limit: null }, scope)).rejects.toThrow('Update AgentsServer')
    await expect(service.createSession({ title: 'Chat', folder: '', cwd: '', backend: 'codex', subagent_limit: 3 })).rejects.toThrow('Update AgentsServer')
    expect(client.updateSession).not.toHaveBeenCalled()
    expect(client.createSession).not.toHaveBeenCalled()
  })
  it('validates positive whole numbers and preserves the explicit null reset', async () => {
    const { service, client } = harness()
    for (const value of [0, -1, 1.5, true, '2', Number.MAX_SAFE_INTEGER + 1]) {
      await expect(service.updateSession('chat', { subagent_limit: value as number }, scope)).rejects.toThrow('positive whole number')
    }
    expect(client.updateSession).not.toHaveBeenCalled()
    await service.updateSession('chat', { subagent_limit: null }, scope)
    expect(client.updateSession).toHaveBeenCalledExactlyOnceWith('chat', { subagent_limit: null })
  })
})

describe('provider command compatibility', () => {
  it.each([404, 405, 501])('treats an older server HTTP %s as unsupported', async status => {
    const client = {
      providerCommands: vi.fn().mockRejectedValue(new ServerError(status, 'Not supported'))
    }
    const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      sessions: [{ id: 'chat', title: 'Chat', backend: 'claude' }],
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined),
      assertCurrentScope: vi.fn()
    })

    await expect(service.providerCommands('chat', true)).resolves.toEqual({
      backend: 'claude',
      revision: 'unsupported',
      support: { available: false, mode: 'unsupported' },
      commands: []
    })
    expect(client.providerCommands).toHaveBeenCalledWith('chat', true)
  })
})

describe('secure peer control fencing', () => {
  function completionHarness() {
    const expected = { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' }
    const pairing = {
      id: '09d7bb2e-3b47-4be7-89fc-2cecd90f4434', direction: 'outgoing', status: 'connected',
      trust_state: 'approved', transport_state: 'online', complete_on_approval: true,
      peer_server_identity: 'server-host', peer_display_name: 'Host', remote_endpoint: '100.64.0.1:7851',
      host_server_identity: 'server-host', host_ca_fingerprint: `sha256:${'a'.repeat(64)}`,
      peer_public_key_fingerprint: `sha256:${'b'.repeat(64)}`, transcript_hash: 'c'.repeat(64),
      sas_words: ['amber', 'birch', 'cobalt', 'delta', 'ember', 'forest'], requested_scopes: ['teamspace.read'],
      granted_scopes: ['teamspace.read'], team_id: 'team-1', team_display_name: 'Team', hub_id: 'hub-host',
      connection_id: '19d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      local_proxy_base_path: '/api/team-hub-secure/19d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      certificate_expires_at: '2027-01-01T00:00:00Z', certificate_fingerprint: `sha256:${'d'.repeat(64)}`,
      last_seen_at: '2026-09-09T00:00:00Z', expires_at: null, error: null
    }
    const status = {
      version: 2, heartbeat_interval_seconds: 30, lease_seconds: 90, server_identity: 'server-a', server_instance_id: 'instance-a',
      active_connection_id: pairing.connection_id as string | null, pairings: [pairing],
      host: { available: true, enabled: false, listen_port: 7851, advertised_host: null, advertised_hosts: [],
        ca_fingerprint: null, pairing_link: null, certificate_expires_at: null, error: null, error_code: null, action: null }
    }
    const receipt = { version: 1, completion_state: 'completed', pairing }
    const client = {
      securePeerPairingCompletion: vi.fn().mockResolvedValue(receipt),
      securePeerStatus: vi.fn().mockResolvedValue(status), requestSecurePeerPairing: vi.fn().mockResolvedValue(pairing)
    }
    const service = Object.create(AppService.prototype) as AppService
    const capability = { available: true, version: 1, completion_path: '/api/admin/secure-peers/v1/pairings/{pairing_id}/completion', max_wait_seconds: 600 }
    const retireMailHints = vi.fn()
    Object.assign(service, {
      mailHints: { retire: retireMailHints },
      health: { capabilities: { automatic_pairing_completion_v1: capability } },
      securePeerControlContext: vi.fn().mockResolvedValue({ expected, serverInstanceId: 'instance-a', scope: { client } }),
      requireSecurePeerControlContext: vi.fn()
    })
    return { service, expected, pairing, status, receipt, client, capability, retireMailHints,
      input: { pairingId: pairing.id, expectedTranscriptHash: pairing.transcript_hash }, controller: new AbortController() }
  }

  it('observes one native completion then verifies the exact active receipt without another activation', async () => {
    const test = completionHarness()
    await expect(test.service.waitForSecurePeerPairingCompletion(test.expected, test.input, test.controller.signal))
      .resolves.toMatchObject({ activeConnectionId: test.pairing.connection_id, automaticPairingCompletionAvailable: true })
    expect(test.client.securePeerPairingCompletion).toHaveBeenCalledExactlyOnceWith(test.pairing.id, {
      expected_server_identity: 'server-a', expected_server_instance_id: 'instance-a', expected_transcript_hash: 'c'.repeat(64)
    }, test.controller.signal)
    expect(test.client.securePeerStatus).toHaveBeenCalledExactlyOnceWith(test.controller.signal)
    expect(test.client.requestSecurePeerPairing).not.toHaveBeenCalled()
    expect(test.retireMailHints).toHaveBeenCalledOnce()
  })

  function endpointHarness(active = true) {
    const test = completionHarness()
    test.pairing.transport_state = active ? 'offline' : 'disconnected'
    test.pairing.status = active ? 'connected' : 'approved'
    test.status.active_connection_id = active ? test.pairing.connection_id : null
    const migrated = structuredClone(test.status)
    migrated.pairings[0].remote_endpoint = '100.64.0.2:7852'
    const update = vi.fn().mockResolvedValue(migrated)
    Object.assign(test.client, { updateSecurePeerConnectionEndpoint: update })
    Object.assign(test.service, { health: { capabilities: { secure_peer_v1: {
      available: true, version: 1, endpoint_update_version: 1,
      endpoint_update_path: '/api/admin/secure-peers/v1/connections/{connection_id}/endpoint'
    } } } })
    const input = { connectionId: test.pairing.connection_id, expectedServerInstanceId: 'instance-a',
      expectedHostServerIdentity: 'server-host', expectedHubIdentity: 'hub-host',
      expectedRemoteEndpoint: '100.64.0.1:7851', host: '100.64.0.2:7852', confirmed: true as const }
    return { ...test, migrated, update, endpointInput: input }
  }

  it.each([true, false])('migrates an approved unreachable endpoint preserving active=%s and exact trust', async active => {
    const test = endpointHarness(active)
    const result = await test.service.updateSecurePeerConnectionEndpoint(test.expected, test.endpointInput)
    expect(result).toMatchObject({ activeConnectionId: test.status.active_connection_id,
      endpointUpdateAvailable: true, pairings: [{ remoteEndpoint: '100.64.0.2:7852', trustState: 'approved' }] })
    expect(test.update).toHaveBeenCalledExactlyOnceWith(test.pairing.connection_id, {
      request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      expected_server_identity: 'server-a', expected_server_instance_id: 'instance-a',
      expected_host_server_identity: 'server-host', expected_hub_id: 'hub-host',
      expected_host_ip: '100.64.0.1', expected_port: 7851, host_ip: '100.64.0.2', port: 7852, confirmed: true
    })
    expect(test.client.securePeerStatus).toHaveBeenCalledOnce()
    expect(test.client.requestSecurePeerPairing).not.toHaveBeenCalled()
    expect(test.retireMailHints).toHaveBeenCalledTimes(active ? 1 : 0)
  })

  it.each(['old-address', 'host-pin', 'hub-pin', 'connection', 'unapproved', 'instance', 'unsupported', 'confirmation', 'invalid-address', 'unchanged'])(
    'rejects %s endpoint migration before any write', async fault => {
      const test = endpointHarness()
      if (fault === 'old-address') test.endpointInput.expectedRemoteEndpoint = '100.64.0.3:7851'
      if (fault === 'host-pin') test.endpointInput.expectedHostServerIdentity = 'other-host'
      if (fault === 'hub-pin') test.endpointInput.expectedHubIdentity = 'other-hub'
      if (fault === 'connection') test.endpointInput.connectionId = test.pairing.id
      if (fault === 'unapproved') { test.pairing.status = 'revoked'; test.pairing.trust_state = 'revoked'; test.pairing.transport_state = 'revoked' }
      if (fault === 'instance') test.endpointInput.expectedServerInstanceId = 'old-instance'
      if (fault === 'unsupported') Object.assign(test.service, { health: { capabilities: {} } })
      if (fault === 'confirmation') Object.assign(test.endpointInput, { confirmed: false })
      if (fault === 'invalid-address') test.endpointInput.host = 'https://other.invalid'
      if (fault === 'unchanged') test.endpointInput.host = test.endpointInput.expectedRemoteEndpoint
      const beforeWrite = vi.fn()
      await expect(test.service.updateSecurePeerConnectionEndpoint(test.expected, test.endpointInput, beforeWrite)).rejects.toThrow()
      expect(beforeWrite).not.toHaveBeenCalled()
      expect(test.update).not.toHaveBeenCalled()
      expect(test.retireMailHints).not.toHaveBeenCalled()
    }
  )

  it.each(['address', 'host-pin', 'hub-pin', 'certificate', 'selection', 'instance'])(
    'rejects a migration receipt with the wrong %s', async fault => {
      const test = endpointHarness()
      if (fault === 'address') test.migrated.pairings[0].remote_endpoint = '100.64.0.3:7852'
      if (fault === 'host-pin') test.migrated.pairings[0].host_server_identity = 'other-host'
      if (fault === 'hub-pin') test.migrated.pairings[0].hub_id = 'other-hub'
      if (fault === 'certificate') test.migrated.pairings[0].certificate_fingerprint = `sha256:${'e'.repeat(64)}`
      if (fault === 'selection') test.migrated.active_connection_id = null
      if (fault === 'instance') test.migrated.server_instance_id = 'other-instance'
      await expect(test.service.updateSecurePeerConnectionEndpoint(test.expected, test.endpointInput)).rejects.toThrow()
      expect(test.update).toHaveBeenCalledOnce()
      expect(test.retireMailHints).not.toHaveBeenCalled()
    }
  )

  it('resolves a committed lost response with one status read and never repeats the write', async () => {
    const test = endpointHarness()
    test.update.mockRejectedValue(new Error('socket closed after commit'))
    test.client.securePeerStatus.mockResolvedValueOnce(test.status).mockResolvedValueOnce(test.migrated)
    await expect(test.service.updateSecurePeerConnectionEndpoint(test.expected, test.endpointInput)).resolves.toMatchObject({
      pairings: [{ remoteEndpoint: '100.64.0.2:7852' }]
    })
    expect(test.update).toHaveBeenCalledOnce()
    expect(test.client.securePeerStatus).toHaveBeenCalledTimes(2)
  })

  it('retains an interrupted migration failure when readback still has the old endpoint', async () => {
    const test = endpointHarness()
    const failure = new Error('socket closed before commit')
    test.update.mockRejectedValue(failure)
    await expect(test.service.updateSecurePeerConnectionEndpoint(test.expected, test.endpointInput)).rejects.toBe(failure)
    expect(test.update).toHaveBeenCalledOnce()
    expect(test.client.securePeerStatus).toHaveBeenCalledTimes(2)
    expect(test.retireMailHints).not.toHaveBeenCalled()
  })

  it('discards a migrated receipt when the active profile changed while awaiting it', async () => {
    const test = endpointHarness()
    const requireContext = vi.fn().mockImplementationOnce(() => undefined).mockImplementation(() => {
      throw new Error('AgentsServer profile changed')
    })
    Object.assign(test.service, { requireSecurePeerControlContext: requireContext })
    await expect(test.service.updateSecurePeerConnectionEndpoint(test.expected, test.endpointInput)).rejects.toThrow('profile changed')
    expect(test.update).toHaveBeenCalledOnce()
    expect(test.retireMailHints).not.toHaveBeenCalled()
  })

  it.each(['wrong-transcript', 'wrong-connection', 'offline', 'no-consent'] as const)('rejects %s completion instead of adopting it', async fault => {
    const test = completionHarness()
    if (fault === 'wrong-transcript') test.pairing.transcript_hash = 'e'.repeat(64)
    if (fault === 'wrong-connection') test.status.active_connection_id = null
    if (fault === 'offline') test.pairing.transport_state = 'offline'
    if (fault === 'no-consent') test.pairing.complete_on_approval = false
    await expect(test.service.waitForSecurePeerPairingCompletion(test.expected, test.input, test.controller.signal)).rejects.toThrow()
    expect(test.retireMailHints).not.toHaveBeenCalled()
  })

  it.each(['cancelled', 'expired'])('returns exact %s consent outcome without falsifying retained approved trust', async state => {
    const test = completionHarness()
    test.receipt.completion_state = state
    test.pairing.status = 'approved'
    test.pairing.transport_state = 'disconnected'
    test.pairing.complete_on_approval = false
    test.status.active_connection_id = null
    const result = await test.service.waitForSecurePeerPairingCompletion(test.expected, test.input, test.controller.signal)
    expect(result.pairingCompletion).toEqual({ pairingId: test.input.pairingId, transcriptHash: test.input.expectedTranscriptHash, state })
    expect(result.pairings[0].trustState).toBe('approved')
    expect(result.activeConnectionId).toBeNull()
    expect(test.client.securePeerStatus).toHaveBeenCalledTimes(1)
    expect(test.retireMailHints).not.toHaveBeenCalled()
  })

  it('does not start a status request after observation was aborted', async () => {
    const test = completionHarness()
    test.client.securePeerPairingCompletion.mockImplementation(async () => { test.controller.abort(); return test.receipt })
    await expect(test.service.waitForSecurePeerPairingCompletion(test.expected, test.input, test.controller.signal)).rejects.toThrow()
    expect(test.client.securePeerStatus).not.toHaveBeenCalled()
  })

  function observationWindowReceipt(test: ReturnType<typeof completionHarness>) {
    return {
      version: 1, completion_state: 'unavailable', reason: 'observation_window_elapsed',
      pairing: { ...test.pairing, status: 'pending_approval', trust_state: 'pending', transport_state: 'disconnected',
        connection_id: null, local_proxy_base_path: null, certificate_fingerprint: null, certificate_expires_at: null,
        granted_scopes: [], expires_at: null }
    }
  }

  it('re-arms only the same held observer across multiple windows, then verifies completion once', async () => {
    const test = completionHarness()
    let elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    const waiting = observationWindowReceipt(test)
    test.client.securePeerPairingCompletion
      .mockImplementationOnce(async () => { elapsed += 600_000; return waiting })
      .mockImplementationOnce(async () => { elapsed += 600_000; return waiting })
      .mockResolvedValueOnce(test.receipt)
    await expect(test.service.waitForSecurePeerPairingCompletion(test.expected, test.input, test.controller.signal))
      .resolves.toMatchObject({ activeConnectionId: test.pairing.connection_id })
    expect(test.client.securePeerPairingCompletion).toHaveBeenCalledTimes(3)
    for (const call of test.client.securePeerPairingCompletion.mock.calls) {
      expect(call).toEqual([test.pairing.id, {
        expected_server_identity: 'server-a', expected_server_instance_id: 'instance-a', expected_transcript_hash: 'c'.repeat(64)
      }, test.controller.signal])
    }
    expect(test.client.securePeerStatus).toHaveBeenCalledExactlyOnceWith(test.controller.signal)
    expect(test.client.requestSecurePeerPairing).not.toHaveBeenCalled()
    expect(test.retireMailHints).toHaveBeenCalledOnce()
  })

  it.each(['early', 'other-reason', 'missing-reason', 'legacy-expiry', 'missing-expiry', 'wrong-pairing',
    'wrong-transcript', 'incoming', 'no-consent', 'rejected', 'pairing-error', 'malformed'] as const)(
    'does not re-arm an %s observer response or refresh/recreate the Join', async fault => {
      const test = completionHarness()
      let elapsed = 0
      vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
      const waiting = observationWindowReceipt(test) as Record<string, any>
      if (fault === 'other-reason') waiting.reason = 'unavailable'
      if (fault === 'missing-reason') delete waiting.reason
      if (fault === 'legacy-expiry') waiting.pairing.expires_at = '2026-09-15T12:00:00Z'
      if (fault === 'missing-expiry') delete waiting.pairing.expires_at
      if (fault === 'wrong-pairing') waiting.pairing.id = '29d7bb2e-3b47-4be7-89fc-2cecd90f4434'
      if (fault === 'wrong-transcript') waiting.pairing.transcript_hash = 'e'.repeat(64)
      if (fault === 'incoming') waiting.pairing.direction = 'incoming'
      if (fault === 'no-consent') waiting.pairing.complete_on_approval = false
      if (fault === 'rejected') Object.assign(waiting.pairing, { status: 'rejected', trust_state: 'rejected' })
      if (fault === 'pairing-error') waiting.pairing.error = 'Host unavailable'
      if (fault === 'malformed') waiting.pairing = null
      test.client.securePeerPairingCompletion.mockImplementationOnce(async () => {
        elapsed += fault === 'early' ? 1 : 600_000
        return waiting
      })
      await expect(test.service.waitForSecurePeerPairingCompletion(test.expected, test.input, test.controller.signal)).rejects.toThrow()
      expect(test.client.securePeerPairingCompletion).toHaveBeenCalledTimes(1)
      expect(test.client.securePeerStatus).not.toHaveBeenCalled()
      expect(test.client.requestSecurePeerPairing).not.toHaveBeenCalled()
      expect(test.retireMailHints).not.toHaveBeenCalled()
    }
  )

  it('requires a fresh long hold on every observer window instead of reusing elapsed time', async () => {
    const test = completionHarness()
    let elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    const waiting = observationWindowReceipt(test)
    test.client.securePeerPairingCompletion
      .mockImplementationOnce(async () => { elapsed += 600_000; return waiting })
      .mockResolvedValueOnce(waiting)
    await expect(test.service.waitForSecurePeerPairingCompletion(test.expected, test.input, test.controller.signal)).rejects.toThrow()
    expect(test.client.securePeerPairingCompletion).toHaveBeenCalledTimes(2)
    expect(test.client.securePeerStatus).not.toHaveBeenCalled()
    expect(test.client.requestSecurePeerPairing).not.toHaveBeenCalled()
    expect(test.retireMailHints).not.toHaveBeenCalled()
  })

  it.each(['disconnected', 'offline', 'reconnecting'] as const)(
    'retains approved but %s automatic activation across a held window', async transportState => {
      const test = completionHarness()
      let elapsed = 0
      vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
      const waiting = { ...observationWindowReceipt(test), pairing: {
        ...test.pairing, status: 'approved', transport_state: transportState
      } }
      test.client.securePeerPairingCompletion.mockImplementationOnce(async () => { elapsed += 600_000; return waiting })
      await expect(test.service.waitForSecurePeerPairingCompletion(test.expected, test.input, test.controller.signal))
        .resolves.toMatchObject({ activeConnectionId: test.pairing.connection_id })
      expect(test.client.securePeerPairingCompletion).toHaveBeenCalledTimes(2)
      expect(test.client.securePeerStatus).toHaveBeenCalledTimes(1)
      expect(test.client.requestSecurePeerPairing).not.toHaveBeenCalled()
      expect(test.retireMailHints).toHaveBeenCalledOnce()
    }
  )

  it.each(['abort', 'scope', 'transport'] as const)('stops the held observer on %s loss without re-arming', async fault => {
    const test = completionHarness()
    let elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    test.client.securePeerPairingCompletion.mockImplementationOnce(async () => {
      elapsed += 600_000
      if (fault === 'abort') test.controller.abort()
      if (fault === 'scope') vi.mocked(test.service['requireSecurePeerControlContext']).mockImplementation(() => { throw new Error('Stale server scope') })
      if (fault === 'transport') throw new Error('Lost connection')
      return observationWindowReceipt(test)
    })
    await expect(test.service.waitForSecurePeerPairingCompletion(test.expected, test.input, test.controller.signal)).rejects.toThrow()
    expect(test.client.securePeerPairingCompletion).toHaveBeenCalledTimes(1)
    expect(test.client.securePeerStatus).not.toHaveBeenCalled()
    expect(test.retireMailHints).not.toHaveBeenCalled()
  })

  it('returns cancellation after a held observer window without ending consent early', async () => {
    const test = completionHarness()
    let elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    const waiting = observationWindowReceipt(test)
    test.client.securePeerPairingCompletion.mockImplementationOnce(async () => { elapsed += 600_000; return waiting })
    test.receipt.completion_state = 'cancelled'
    test.pairing.status = 'approved'
    test.pairing.transport_state = 'disconnected'
    test.pairing.complete_on_approval = false
    test.status.active_connection_id = null
    const result = await test.service.waitForSecurePeerPairingCompletion(test.expected, test.input, test.controller.signal)
    expect(result.pairingCompletion?.state).toBe('cancelled')
    expect(test.client.securePeerPairingCompletion).toHaveBeenCalledTimes(2)
    expect(test.client.securePeerStatus).toHaveBeenCalledTimes(1)
    expect(test.retireMailHints).not.toHaveBeenCalled()
  })

  it('sends automatic consent only when explicitly requested and exactly advertised', async () => {
    const test = completionHarness()
    const input = { host: '100.64.0.1', displayName: 'Guest', requestedScopes: ['teamspace.read'] as ['teamspace.read'] }
    await test.service.requestSecurePeerPairing(test.expected, input)
    expect(test.client.requestSecurePeerPairing.mock.calls[0][0]).not.toHaveProperty('complete_on_approval')
    await test.service.requestSecurePeerPairing(test.expected, { ...input, completeOnApproval: true, confirmLocalBindingReplacement: true })
    expect(test.client.requestSecurePeerPairing.mock.calls[1][0]).toMatchObject({ complete_on_approval: true })
    expect(test.client.requestSecurePeerPairing.mock.calls[1][0]).not.toHaveProperty('confirmLocalBindingReplacement')
    test.capability.available = false
    await expect(test.service.requestSecurePeerPairing(test.expected, { ...input, completeOnApproval: true })).rejects.toThrow(/Update this/)
    expect(test.client.requestSecurePeerPairing).toHaveBeenCalledTimes(2)
  })

  it('passes the exact requested scope subset and pairing-link CA pin to the active AgentsServer', async () => {
    const fingerprint = `sha256:${'a'.repeat(64)}`
    const requestSecurePeerPairing = vi.fn().mockResolvedValue({
      id: '09d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      direction: 'outgoing',
      status: 'pending_approval',
      peer_server_identity: 'server-host',
      peer_display_name: 'Studio host',
      remote_endpoint: '100.64.0.1:7851',
      host_server_identity: 'server-host',
      host_ca_fingerprint: fingerprint,
      peer_public_key_fingerprint: `sha256:${'b'.repeat(64)}`,
      transcript_hash: 'c'.repeat(64),
      sas_words: ['amber', 'birch', 'cobalt', 'delta', 'ember', 'forest'],
      requested_scopes: ['teamspace.read', 'cross_chat.instruction'],
      granted_scopes: [],
      team_id: null,
      team_display_name: null,
      hub_id: null,
      connection_id: null,
      local_proxy_base_path: null,
      certificate_expires_at: null,
      certificate_fingerprint: null,
      last_seen_at: null,
      expires_at: '2026-08-24T00:00:00Z',
      error: null
    })
    const scope = {
      profileId: 'profile-a', generation: 7, namespace: 'server-a',
      client: { requestSecurePeerPairing }
    }
    const settings = {
      getProfile: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-a' })),
      getProfileMetadata: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-a' })),
      serverUrl: vi.fn(() => 'http://100.64.0.1:7850')
    }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: 'profile-a',
      profileGeneration: 7,
      validatedGeneration: 7,
      settings,
      health: { ok: true, server_identity: 'server-a', server_instance_id: 'instance-a' },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined),
      assertCurrentScope: vi.fn()
    })
    const link = `agentsdock://secure-peer/join?host=100.64.0.1&port=7851&fingerprint=${encodeURIComponent(fingerprint)}`

    await expect(service.requestSecurePeerPairing(
      { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' },
      { host: link, displayName: 'Client node', requestedScopes: ['teamspace.read', 'cross_chat.instruction'] }
    )).resolves.toMatchObject({ requestedScopes: ['teamspace.read', 'cross_chat.instruction'] })

    expect(requestSecurePeerPairing).toHaveBeenCalledWith({
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'instance-a',
      host: '100.64.0.1',
      port: 7851,
      display_name: 'Client node',
      requested_scopes: ['teamspace.read', 'cross_chat.instruction'],
      expected_ca_fingerprint: fingerprint
    })

    await expect(service.requestSecurePeerPairing(
      { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' },
      { host: '100.64.0.1', displayName: 'Client node', requestedScopes: ['teamspace.read', 'teamspace.read'] }
    )).rejects.toThrow(/unique/i)
    expect(requestSecurePeerPairing).toHaveBeenCalledTimes(1)
  })

  it('retries an ambiguous pairing response once with the exact same request UUID', async () => {
    const fingerprint = `sha256:${'a'.repeat(64)}`
    const response = {
      id: '09d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      direction: 'outgoing', status: 'pending_approval',
      peer_server_identity: 'server-host', peer_display_name: 'Studio host',
      remote_endpoint: '100.64.0.1:7851', host_server_identity: 'server-host',
      host_ca_fingerprint: fingerprint, peer_public_key_fingerprint: `sha256:${'b'.repeat(64)}`,
      transcript_hash: 'c'.repeat(64), sas_words: ['amber', 'birch', 'cobalt', 'delta', 'ember', 'forest'],
      requested_scopes: ['teamspace.read'], granted_scopes: [], team_id: null,
      team_display_name: null, hub_id: null, connection_id: null,
      local_proxy_base_path: null, certificate_expires_at: null,
      certificate_fingerprint: null, last_seen_at: null,
      expires_at: '2026-08-24T00:00:00Z', error: null
    }
    const requestSecurePeerPairing = vi.fn()
      .mockRejectedValueOnce(new Error('socket closed after commit'))
      .mockResolvedValueOnce(response)
    const scope = {
      profileId: 'profile-a', generation: 7, namespace: 'server-a',
      client: { requestSecurePeerPairing }
    }
    const settings = {
      getProfile: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-a' })),
      getProfileMetadata: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-a' })),
      serverUrl: vi.fn(() => 'http://100.64.0.1:7850')
    }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope, activeProfileId: 'profile-a', profileGeneration: 7,
      validatedGeneration: 7, settings,
      health: { ok: true, server_identity: 'server-a', server_instance_id: 'instance-a' },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined),
      assertCurrentScope: vi.fn()
    })

    await expect(service.requestSecurePeerPairing(
      { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' },
      { host: '100.64.0.1:7851', displayName: 'Client node', requestedScopes: ['teamspace.read'] }
    )).resolves.toMatchObject({ id: response.id })
    expect(requestSecurePeerPairing).toHaveBeenCalledTimes(2)
    expect(requestSecurePeerPairing.mock.calls[1][0]).toEqual(
      requestSecurePeerPairing.mock.calls[0][0]
    )
  })

  it('uses the host-global local approval queue contract and never assigns a team while rejecting', async () => {
    const response = {
      version: 1,
      server_identity: 'server-a',
      server_instance_id: 'instance-a',
      active_connection_id: null,
      remote_route_delivery_available: false,
      host: {
        available: false, enabled: false, listen_port: 7851,
        advertised_host: null, advertised_hosts: [], ca_fingerprint: null,
        pairing_link: null, certificate_expires_at: null, error: null, action: null
      },
      pairings: [], remote_routes: [], published_routes: []
    }
    const approveSecurePeerPairing = vi.fn().mockResolvedValue(response)
    const rejectSecurePeerPairing = vi.fn().mockResolvedValue(response)
    const scope = {
      profileId: 'profile-a', generation: 7, namespace: 'server-a',
      client: { approveSecurePeerPairing, rejectSecurePeerPairing }
    }
    const settings = {
      getProfile: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-a' })),
      getProfileMetadata: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-a' })),
      serverUrl: vi.fn(() => 'http://100.64.0.1:7850')
    }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope, activeProfileId: 'profile-a', profileGeneration: 7, validatedGeneration: 7, settings,
      health: { ok: true, server_identity: 'server-a', server_instance_id: 'instance-a' },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined), assertCurrentScope: vi.fn()
    })
    const expectedScope = { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' }
    const pairingId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const transcriptHash = 'c'.repeat(64)

    await service.approveSecurePeerPairing(expectedScope, {
      pairingId,
      teamId: 'team-studio',
      expectedPeerServerIdentity: 'server-remote',
      expectedTranscriptHash: transcriptHash,
      scopes: ['teamspace.read', 'cross_chat.instruction'],
      sasConfirmed: true
    })
    expect(approveSecurePeerPairing).toHaveBeenCalledWith(pairingId, {
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'instance-a',
      team_id: 'team-studio',
      expected_peer_server_identity: 'server-remote',
      expected_transcript_hash: transcriptHash,
      scopes: ['teamspace.read', 'cross_chat.instruction'],
      sas_confirmed: true,
      confirmed: true
    })

    await service.rejectSecurePeerPairing(expectedScope, {
      pairingId,
      expectedPeerServerIdentity: 'server-remote',
      expectedTranscriptHash: transcriptHash,
      reason: 'Not this server'
    })
    const rejectBody = rejectSecurePeerPairing.mock.calls[0][1]
    expect(rejectSecurePeerPairing).toHaveBeenCalledWith(pairingId, {
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'instance-a',
      expected_peer_server_identity: 'server-remote',
      expected_transcript_hash: transcriptHash,
      reason: 'Not this server',
      confirmed: true
    })
    expect(rejectBody).not.toHaveProperty('team_id')
  })

  it('enforces the frozen public-route alias grammar before calling AgentsServer', async () => {
    const publishSecurePeerRoute = vi.fn()
    const scope = {
      profileId: 'profile-a', generation: 7, namespace: 'server-a',
      client: { publishSecurePeerRoute }
    }
    const settings = {
      getProfile: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-a' })),
      getProfileMetadata: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-a' })),
      serverUrl: vi.fn(() => 'http://100.64.0.1:7850')
    }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope, activeProfileId: 'profile-a', profileGeneration: 7, validatedGeneration: 7, settings,
      health: { ok: true, server_identity: 'server-a', server_instance_id: 'instance-a' },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined), assertCurrentScope: vi.fn()
    })
    const input = {
      connectionId: '22e7bb2e-3b47-4be7-89fc-2cecd90f4434',
      chatId: 'chat-a', displayTitle: 'Training', actions: ['instruction'] as Array<'instruction' | 'request_reply'>
    }
    const expectedScope = { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' }

    await expect(service.publishSecurePeerRoute(expectedScope, { ...input, alias: 'training.agent' })).rejects.toThrow(/alias/i)
    await expect(service.publishSecurePeerRoute(expectedScope, { ...input, alias: `a${'b'.repeat(32)}` })).rejects.toThrow(/alias/i)
    await expect(service.publishSecurePeerRoute(expectedScope, { ...input, alias: '2training' })).rejects.toThrow(/alias/i)
    await expect(service.publishSecurePeerRoute(expectedScope, { ...input, alias: 'Training' })).rejects.toThrow(/alias/i)
    expect(publishSecurePeerRoute).not.toHaveBeenCalled()
  })
})

describe('embedded Team Hub discovery', () => {
  it('uses metadata-only profile lookup for repeated Team Hub scope checks', () => {
    const { settings } = profileSettings()
    settings.updateProfile('a', { name: 'Configured name', serverIdentity: 'configured-server' })
    const publicProfile = vi.spyOn(settings, 'getProfile').mockImplementation(() => {
      throw new Error('Scope metadata must not inspect stored credentials')
    })
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, { settings, scope: { profileId: 'a', generation: 7 },
      health: { server_identity: 'configured-server', server_name: 'Live name' } })
    const expected = { profileId: 'a', profileGeneration: 7, serverIdentity: 'configured-server',
      serverUrl: 'http://a.test:7850', serverName: 'Live name' }
    expect(service.teamHubServerScope()).toEqual(expected)
    expect(service.teamHubServerScope()).toEqual(expected)
    expect(publicProfile).not.toHaveBeenCalled()
  })

  function serviceWithCapability(capability: unknown) {
    const scope = { profileId: 'profile-a', generation: 7, namespace: 'server-a', client: {} }
    const settings = {
      getProfile: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'https://dock.example.test/prefix', serverIdentity: 'server-a' })),
      getProfileMetadata: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'https://dock.example.test/prefix', serverIdentity: 'server-a' })),
      serverUrl: vi.fn(() => 'https://dock.example.test/prefix')
    }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: 'profile-a',
      profileGeneration: 7,
      validatedGeneration: 7,
      settings,
      health: {
        ok: true,
        server_identity: 'server-a',
        capabilities: { team_hub_v1: capability }
      },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined),
      assertCurrentScope: vi.fn()
    })
    return { service, scope }
  }

  it('reports a missing host-control contract without claiming the connected server is outdated', async () => {
    const scope = { profileId: 'profile-a', generation: 7, namespace: 'server-a', client: {} }
    const settings = {
      getProfile: vi.fn(() => ({
        id: 'profile-a', name: 'Studio', serverUrl: 'https://dock.example.test/prefix', serverIdentity: 'server-a'
      })),
      getProfileMetadata: vi.fn(() => ({
        id: 'profile-a', name: 'Studio', serverUrl: 'https://dock.example.test/prefix', serverIdentity: 'server-a'
      })),
      serverUrl: vi.fn(() => 'https://dock.example.test/prefix')
    }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope, activeProfileId: 'profile-a', profileGeneration: 7, validatedGeneration: 7, settings,
      health: {
        ok: true, server_identity: 'server-a', server_instance_id: 'instance-a',
        capabilities: { team_hub_v1: { available: false, designated_host: false } }
      },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined), assertCurrentScope: vi.fn()
    })

    await expect(service.configureTeamHubServerRole({
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a'
    }, { role: 'host', serverName: 'Studio' })).rejects.toThrow(
      'The connected AgentsServer build does not include Team Network host control. Install a build that includes host control, then reconnect.'
    )
  })

  it('enables hosting on the exact live server instance and adopts the fresh host capability', async () => {
    const hostControl = (enabled: boolean) => ({
      available: true, enabled, can_enable: !enabled, can_disable: enabled, version: 1,
      status_path: '/api/admin/team-hub/host',
      enable_path: '/api/admin/team-hub/host/enable',
      disable_path: '/api/admin/team-hub/host/disable',
      message: enabled ? 'Hosting enabled.' : 'Hosting can be enabled.', action: null
    })
    const inactiveHub = {
      available: false, designated_host: false, version: 1, base_path: null,
      hub_id: null, host_server_identity: null, message: 'Not a host.', action: 'Enable hosting.'
    }
    const activeHub = {
      available: false, designated_host: true, version: 1, base_path: '/api/team-hub',
      transport: 'loopback', hub_url: null, hub_id: null, host_server_identity: 'server-a',
      message: 'Create the Team Network owner.', action: 'Create a Team Network.'
    }
    const nextHealth = {
      ok: true, server_identity: 'server-a', server_instance_id: 'instance-a',
      capabilities: { team_hub_host_control_v1: hostControl(true), team_hub_v1: activeHub }
    }
    const enableTeamHubHost = vi.fn(async (input: { request_id: string }) => ({
      phase: 'complete' as const,
      request_id: input.request_id,
      operation: 'create' as const,
      server_identity: 'server-a',
      server_instance_id: 'instance-a',
      server_name: 'Studio host',
      reconnect_required: false as const,
      message: 'Hosting enabled.',
      team_hub: activeHub
    }))
    const health = vi.fn().mockResolvedValue(nextHealth)
    const scope = { profileId: 'profile-a', generation: 7, namespace: 'server-a', client: { enableTeamHubHost, health } }
    const settings = {
      getProfile: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'https://dock.example.test/prefix', serverIdentity: 'server-a' })),
      getProfileMetadata: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'https://dock.example.test/prefix', serverIdentity: 'server-a' })),
      serverUrl: vi.fn(() => 'https://dock.example.test/prefix'),
      updateProfile: vi.fn()
    }
    const adoptHealth = vi.fn()
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope, activeProfileId: 'profile-a', profileGeneration: 7, validatedGeneration: 7, settings,
      health: {
        ok: true, server_identity: 'server-a', server_instance_id: 'instance-a',
        capabilities: { team_hub_host_control_v1: hostControl(false), team_hub_v1: inactiveHub }
      },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined), assertCurrentScope: vi.fn(), adoptHealth,
      readActivityHealth: vi.fn((_scope: unknown, read: () => Promise<Health>) => read()),
      emitProfiles: vi.fn()
    })
    const expected = { profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a' }

    await expect(service.configureTeamHubServerRole(expected, {
      role: 'host', serverName: 'Studio host'
    })).resolves.toMatchObject({
      designatedHost: true, hostServerIdentity: 'server-a', basePath: '/api/team-hub'
    })
    expect(enableTeamHubHost).toHaveBeenCalledWith({
      request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      expected_server_identity: 'server-a', expected_server_instance_id: 'instance-a', confirmed: true,
      server_name: 'Studio host'
    })
    expect(health).toHaveBeenCalledOnce()
    expect(adoptHealth).toHaveBeenCalledWith(scope, nextHealth)
    expect(settings.updateProfile).not.toHaveBeenCalled()
  })

  it('rejects a mismatched host activation receipt before adopting server state', async () => {
    const enableTeamHubHost = vi.fn(async (input: { request_id: string }) => ({
      phase: 'complete' as const, request_id: input.request_id, operation: 'create' as const,
      server_identity: 'other-server', server_instance_id: 'instance-a', reconnect_required: false as const,
      server_name: 'Studio',
      message: 'Hosting enabled.', team_hub: {}
    }))
    const health = vi.fn()
    const scope = { profileId: 'profile-a', generation: 7, namespace: 'server-a', client: { enableTeamHubHost, health } }
    const settings = {
      getProfile: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'https://dock.example.test/prefix', serverIdentity: 'server-a' })),
      getProfileMetadata: vi.fn(() => ({ id: 'profile-a', name: 'Studio', serverUrl: 'https://dock.example.test/prefix', serverIdentity: 'server-a' })),
      serverUrl: vi.fn(() => 'https://dock.example.test/prefix')
    }
    const adoptHealth = vi.fn()
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope, activeProfileId: 'profile-a', profileGeneration: 7, validatedGeneration: 7, settings,
      health: {
        ok: true, server_identity: 'server-a', server_instance_id: 'instance-a',
        capabilities: {
          team_hub_host_control_v1: {
            available: true, enabled: false, can_enable: true, can_disable: false, version: 1,
            status_path: '/api/admin/team-hub/host', enable_path: '/api/admin/team-hub/host/enable',
            disable_path: '/api/admin/team-hub/host/disable', message: 'Ready.', action: null
          }
        }
      },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined), assertCurrentScope: vi.fn(), adoptHealth
    })

    await expect(service.configureTeamHubServerRole({
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a'
    }, { role: 'host', serverName: 'Studio' })).rejects.toThrow('mismatched Team Network role activation receipt')
    expect(health).not.toHaveBeenCalled()
    expect(adoptHealth).not.toHaveBeenCalled()
  })

  it('uses the live disable control for the member role with the canonical server name', async () => {
    const enableTeamHubHost = vi.fn()
    const disableTeamHubHost = vi.fn().mockRejectedValue(new Error('stop after request capture'))
    const scope = {
      profileId: 'profile-a', generation: 7, namespace: 'server-a',
      client: { enableTeamHubHost, disableTeamHubHost }
    }
    const settings = {
      getProfile: vi.fn(() => ({
        id: 'profile-a', name: 'Studio', serverUrl: 'https://dock.example.test/prefix', serverIdentity: 'server-a'
      })),
      getProfileMetadata: vi.fn(() => ({
        id: 'profile-a', name: 'Studio', serverUrl: 'https://dock.example.test/prefix', serverIdentity: 'server-a'
      })),
      serverUrl: vi.fn(() => 'https://dock.example.test/prefix')
    }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope, activeProfileId: 'profile-a', profileGeneration: 7, validatedGeneration: 7, settings,
      health: {
        ok: true, server_identity: 'server-a', server_instance_id: 'instance-a',
        capabilities: {
          team_hub_host_control_v1: {
            available: true, enabled: true, can_enable: false, can_disable: true, version: 1,
            status_path: '/api/admin/team-hub/host', enable_path: '/api/admin/team-hub/host/enable',
            disable_path: '/api/admin/team-hub/host/disable', message: 'Ready.', action: null
          }
        }
      },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined), assertCurrentScope: vi.fn()
    })

    await expect(service.configureTeamHubServerRole({
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a'
    }, { role: 'member', serverName: '  Atlas  ' })).rejects.toThrow('stop after request capture')
    expect(enableTeamHubHost).not.toHaveBeenCalled()
    expect(disableTeamHubHost).toHaveBeenCalledWith({
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expected_server_identity: 'server-a', expected_server_instance_id: 'instance-a',
      confirmed: true, server_name: 'Atlas'
    })
  })

  it('projects the exact authenticated host capability behind the active server fence', async () => {
    const { service, scope } = serviceWithCapability({
      available: true, designated_host: true, version: 1, base_path: '/api/team-hub',
      hub_id: 'hub-stable-a', host_server_identity: 'server-a',
      message: 'Team Hub is hosted by this server.', action: null
    })
    const expected = {
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a',
      serverUrl: 'https://dock.example.test/prefix', serverName: 'Studio'
    }

    await expect(service.discoverTeamHub(expected)).resolves.toEqual({
      available: true, designatedHost: true, version: 1, basePath: '/api/team-hub',
      transport: 'loopback', hubUrl: null,
      hubIdentity: 'hub-stable-a', hostServerIdentity: 'server-a',
      message: 'Team Hub is hosted by this server.', action: null
    })
    expect(service.currentTeamHubDiscovery(expected)).toEqual({
      available: true, designatedHost: true, version: 1, basePath: '/api/team-hub',
      transport: 'loopback', hubUrl: null,
      hubIdentity: 'hub-stable-a', hostServerIdentity: 'server-a',
      message: 'Team Hub is hosted by this server.', action: null
    })
    expect((service as unknown as { ensureValidatedScope(value: unknown): Promise<void> }).ensureValidatedScope).toHaveBeenCalledWith(scope)
  })

  it('projects and fences the exact server-scoped Teamspace proxy capability', async () => {
    const capability = {
      available: true, designated_host: true, version: 1, base_path: '/api/team-hub',
      server_session_base_path: '/api/team-hub-server',
      hub_id: 'hub-stable-a', host_server_identity: 'server-a',
      message: 'Team Hub is hosted by this server.', action: null
    }
    const { service, scope } = serviceWithCapability(capability)
    const delegated = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    }))
    const serverTeamHubProxyFetch = vi.fn(() => delegated)
    Object.assign(scope.client, { serverTeamHubProxyFetch })
    const expected = {
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a',
      serverUrl: 'https://dock.example.test/prefix', serverName: 'Studio'
    }

    await expect(service.discoverTeamHub(expected)).resolves.toMatchObject({
      serverSessionBasePath: '/api/team-hub-server', hubIdentity: 'hub-stable-a'
    })
    const proxy = service.serverTeamHubProxyFetch(expected, '/api/team-hub-server')
    await expect(proxy('https://dock.example.test/prefix/api/team-hub-server/v1/server-session'))
      .resolves.toBeInstanceOf(Response)
    expect(serverTeamHubProxyFetch).toHaveBeenCalledWith('/api/team-hub-server')

    capability.server_session_base_path = '/api/team-hub-server/escape'
    await expect(service.discoverTeamHub(expected)).rejects.toThrow('invalid Team Hub V1 capability')
  })

  it('returns an inert unavailable descriptor when an old server has no capability', async () => {
    const { service } = serviceWithCapability(undefined)
    await expect(service.discoverTeamHub({
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a',
      serverUrl: 'https://dock.example.test/prefix', serverName: 'Studio'
    })).resolves.toMatchObject({ available: false, designatedHost: false, basePath: null, hubIdentity: null })
  })

  it('rejects a capability whose designated host identity differs from the active server', async () => {
    const { service } = serviceWithCapability({
      available: true, designated_host: true, version: 1, base_path: '/api/team-hub',
      hub_id: 'hub-stable-a', host_server_identity: 'foreign-server', message: 'ready', action: null
    })
    await expect(service.discoverTeamHub({
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a',
      serverUrl: 'https://dock.example.test/prefix', serverName: 'Studio'
    })).rejects.toThrow('invalid Team Hub V1 capability')
    expect(service.currentTeamHubDiscovery({
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a',
      serverUrl: 'https://dock.example.test/prefix', serverName: 'Studio'
    })).toBeNull()
  })

  it('accepts an exact private Serve capability but rejects arbitrary remote Hub URLs', async () => {
    const capability = {
      available: true, designated_host: true, version: 1, base_path: '/api/team-hub',
      transport: 'tailscale_serve', hub_url: 'https://atlas.my-tailnet.ts.net:8444/api/team-hub',
      hub_id: 'hub-stable-a', host_server_identity: 'server-a', message: 'ready', action: null
    }
    const { service } = serviceWithCapability(capability)
    const expected = {
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a',
      serverUrl: 'https://dock.example.test/prefix', serverName: 'Studio'
    }
    await expect(service.discoverTeamHub(expected)).resolves.toMatchObject({
      transport: 'tailscale_serve', hubUrl: capability.hub_url
    })

    capability.hub_url = 'https://attacker.example:8444/api/team-hub'
    await expect(service.discoverTeamHub(expected)).rejects.toThrow('invalid Team Hub V1 capability')
  })

  it('accepts only path-bound secure-peer discovery and rejects every server-supplied absolute proxy URL', async () => {
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const basePath = `/api/team-hub-secure/${connectionId}`
    const capability = {
      available: true,
      designated_host: false,
      version: 1,
      base_path: basePath,
      transport: 'secure_peer',
      hub_url: null as string | null,
      connection_id: connectionId,
      hub_id: 'hub-remote',
      host_server_identity: 'server-host',
      routes: [{
        transport: 'secure_peer',
        hub_url: null as string | null,
        base_path: basePath,
        connection_id: connectionId,
        host_server_identity: 'server-host',
        hub_id: 'hub-remote'
      }],
      message: 'Secure peer connected.',
      action: null
    }
    const { service } = serviceWithCapability(capability)
    const expected = {
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a',
      serverUrl: 'https://dock.example.test/prefix', serverName: 'Studio'
    }

    await expect(service.discoverTeamHub(expected)).resolves.toEqual({
      available: true,
      designatedHost: false,
      version: 1,
      basePath,
      transport: 'secure_peer',
      hubUrl: null,
      routes: [{
        transport: 'secure_peer', hubUrl: null, basePath, connectionId,
        hostServerIdentity: 'server-host', hubIdentity: 'hub-remote'
      }],
      hubIdentity: 'hub-remote',
      hostServerIdentity: 'server-host',
      connectionId,
      message: 'Secure peer connected.',
      action: null
    })

    capability.hub_url = `https://attacker.invalid${basePath}`
    await expect(service.discoverTeamHub(expected)).rejects.toThrow('invalid Team Hub V1 capability')
    capability.hub_url = null
    capability.routes[0].hub_url = `https://attacker.invalid${basePath}`
    await expect(service.discoverTeamHub(expected)).rejects.toThrow('invalid Team Hub V1 capability')
  })

  it('accepts a canonical ordered Serve-plus-Direct route list and rejects reorder or duplicates', async () => {
    const serve = 'https://atlas.my-tailnet.ts.net:8444/api/team-hub'
    const direct = 'http://100.64.0.1:7850/api/team-hub'
    const capability = {
      available: true, designated_host: true, version: 1, base_path: '/api/team-hub',
      transport: 'tailscale_serve', hub_url: serve,
      routes: [
        { transport: 'tailscale_serve', hub_url: serve },
        { transport: 'direct_ip', hub_url: direct }
      ],
      hub_id: 'hub-stable-a', host_server_identity: 'server-a', message: 'ready', action: null
    }
    const { service } = serviceWithCapability(capability)
    const expected = {
      profileId: 'profile-a', profileGeneration: 7, serverIdentity: 'server-a',
      serverUrl: 'https://dock.example.test/prefix', serverName: 'Studio'
    }
    await expect(service.discoverTeamHub(expected)).resolves.toMatchObject({
      transport: 'tailscale_serve', hubUrl: serve,
      routes: [
        { transport: 'tailscale_serve', hubUrl: serve },
        { transport: 'direct_ip', hubUrl: direct }
      ]
    })

    capability.routes = [...capability.routes].reverse()
    await expect(service.discoverTeamHub(expected)).rejects.toThrow('invalid Team Hub V1 capability')
    capability.routes = [
      { transport: 'tailscale_serve', hub_url: serve },
      { transport: 'tailscale_serve', hub_url: serve }
    ]
    await expect(service.discoverTeamHub(expected)).rejects.toThrow('invalid Team Hub V1 capability')
  })

  it('requests a body-bound proof through Serve and rechecks the exact capability after the response', async () => {
    const hubUrl = 'https://atlas.my-tailnet.ts.net:8444/api/team-hub'
    const capability = {
      available: true, designated_host: true, version: 1, base_path: '/api/team-hub',
      transport: 'tailscale_serve', hub_url: hubUrl, hub_id: 'hub-atlas',
      host_server_identity: 'server-atlas', message: 'ready', action: null
    }
    const teamHubBootstrapProof = vi.fn(async (_hubURL: string, request: { request_id: string }) => ({
      request_id: request.request_id,
      server_identity: 'server-atlas',
      server_instance_id: 'instance-atlas',
      hub_id: 'hub-atlas',
      tailnet_login: 'owner@example.test',
      expires_at: new Date(Date.now() + 3 * 60_000).toISOString(),
      bootstrap_proof: `bootstrap_remote.${'a'.repeat(43)}`
    }))
    const scope = { profileId: 'atlas', generation: 9, namespace: 'server-atlas', client: { teamHubBootstrapProof } }
    const settings = {
      getProfile: vi.fn(() => ({ id: 'atlas', name: 'Atlas', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-atlas' })),
      getProfileMetadata: vi.fn(() => ({ id: 'atlas', name: 'Atlas', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-atlas' })),
      serverUrl: vi.fn(() => 'http://100.64.0.1:7850')
    }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope, activeProfileId: 'atlas', profileGeneration: 9, validatedGeneration: 9, settings,
      health: { ok: true, server_identity: 'server-atlas', server_instance_id: 'instance-atlas', capabilities: { team_hub_v1: capability } },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined), assertCurrentScope: vi.fn()
    })
    const expected = {
      profileId: 'atlas', profileGeneration: 9, serverIdentity: 'server-atlas',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    }

    const result = await service.requestTeamHubBootstrapProof(expected, {
      hubIdentity: 'hub-atlas', hubUrl, recipientEmail: 'owner@example.test',
      displayName: 'Owner', deviceLabel: 'AgentsDock Desktop'
    })

    expect(result.proof).toBe(`bootstrap_remote.${'a'.repeat(43)}`)
    const [requestedURL, request] = teamHubBootstrapProof.mock.calls[0]
    expect(requestedURL).toBe(hubUrl)
    expect(request).toEqual({
      request_id: result.requestId,
      expected_server_identity: 'server-atlas',
      expected_server_instance_id: 'instance-atlas',
      expected_hub_id: 'hub-atlas',
      expected_hub_url: hubUrl,
      confirmed: true,
      recipient_email: 'owner@example.test',
      display_name: 'Owner',
      device_label: 'AgentsDock Desktop'
    })
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('requests Direct IP only from the authenticated secondary route with explicit unsafe confirmation', async () => {
    const serve = 'https://atlas.my-tailnet.ts.net:8444/api/team-hub'
    const direct = 'http://100.64.0.1:7850/api/team-hub'
    const capability = {
      available: true, designated_host: true, version: 1, base_path: '/api/team-hub',
      transport: 'tailscale_serve', hub_url: serve,
      routes: [
        { transport: 'tailscale_serve', hub_url: serve },
        { transport: 'direct_ip', hub_url: direct }
      ],
      hub_id: 'hub-atlas', host_server_identity: 'server-atlas', message: 'ready', action: null
    }
    const teamHubBootstrapProof = vi.fn(async (_url: string, request: { request_id: string }) => ({
      request_id: request.request_id, server_identity: 'server-atlas', server_instance_id: 'instance-atlas',
      hub_id: 'hub-atlas', tailnet_login: 'owner@example.test', expires_at: new Date(Date.now() + 3 * 60_000).toISOString(),
      bootstrap_proof: `bootstrap_remote.${'d'.repeat(43)}`
    }))
    const scope = { profileId: 'atlas', generation: 9, namespace: 'server-atlas', client: { teamHubBootstrapProof } }
    const settings = {
      getProfile: vi.fn(() => ({ id: 'atlas', name: 'Atlas', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-atlas' })),
      getProfileMetadata: vi.fn(() => ({ id: 'atlas', name: 'Atlas', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-atlas' })),
      serverUrl: vi.fn(() => 'http://100.64.0.1:7850')
    }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope, activeProfileId: 'atlas', profileGeneration: 9, validatedGeneration: 9, settings,
      health: { ok: true, server_identity: 'server-atlas', server_instance_id: 'instance-atlas', capabilities: { team_hub_v1: capability } },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined), assertCurrentScope: vi.fn()
    })
    const expected = {
      profileId: 'atlas', profileGeneration: 9, serverIdentity: 'server-atlas',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    }
    const input = {
      hubIdentity: 'hub-atlas', hubUrl: direct, transport: 'direct_ip' as const,
      recipientEmail: 'owner@example.test', displayName: 'Owner', deviceLabel: 'Desktop'
    }

    await expect(service.requestTeamHubBootstrapProof(expected, input)).rejects.toThrow('explicit unencrypted')
    expect(teamHubBootstrapProof).not.toHaveBeenCalled()

    const result = await service.requestTeamHubBootstrapProof(expected, {
      ...input, unsafeDirectIPConfirmed: true
    })
    expect(teamHubBootstrapProof).toHaveBeenCalledWith(direct, expect.objectContaining({
      request_id: result.requestId,
      expected_hub_url: direct,
      expected_transport: 'direct_ip',
      unsafe_direct_ip_confirmed: true
    }))
  })

  it('replays one ambiguous grant request with the exact same UUID and body', async () => {
    const hubUrl = 'https://atlas.my-tailnet.ts.net:8444/api/team-hub'
    const capability = {
      available: true, designated_host: true, version: 1, base_path: '/api/team-hub',
      transport: 'tailscale_serve', hub_url: hubUrl, hub_id: 'hub-atlas',
      host_server_identity: 'server-atlas', message: 'ready', action: null
    }
    const teamHubBootstrapProof = vi.fn(async (_hubURL: string, request: { request_id: string }) => ({
      request_id: request.request_id,
      server_identity: 'server-atlas', server_instance_id: 'instance-atlas', hub_id: 'hub-atlas',
      tailnet_login: 'owner@example.test', expires_at: new Date(Date.now() + 3 * 60_000).toISOString(),
      bootstrap_proof: `bootstrap_remote.${'r'.repeat(43)}`
    }))
    teamHubBootstrapProof.mockRejectedValueOnce(new TeamHubBootstrapTransportError())
    const scope = { profileId: 'atlas', generation: 9, namespace: 'server-atlas', client: { teamHubBootstrapProof } }
    const settings = {
      getProfile: vi.fn(() => ({ id: 'atlas', name: 'Atlas', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-atlas' })),
      getProfileMetadata: vi.fn(() => ({ id: 'atlas', name: 'Atlas', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-atlas' })),
      serverUrl: vi.fn(() => 'http://100.64.0.1:7850')
    }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope, activeProfileId: 'atlas', profileGeneration: 9, validatedGeneration: 9, settings,
      health: { ok: true, server_identity: 'server-atlas', server_instance_id: 'instance-atlas', capabilities: { team_hub_v1: capability } },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined), assertCurrentScope: vi.fn()
    })
    const expected = {
      profileId: 'atlas', profileGeneration: 9, serverIdentity: 'server-atlas',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    }

    await expect(service.requestTeamHubBootstrapProof(expected, {
      hubIdentity: 'hub-atlas', hubUrl, recipientEmail: 'owner@example.test',
      displayName: 'Owner', deviceLabel: 'Desktop'
    })).resolves.toMatchObject({ proof: `bootstrap_remote.${'r'.repeat(43)}` })

    expect(teamHubBootstrapProof).toHaveBeenCalledTimes(2)
    expect(teamHubBootstrapProof.mock.calls[1]).toEqual(teamHubBootstrapProof.mock.calls[0])

    teamHubBootstrapProof.mockReset()
    teamHubBootstrapProof.mockRejectedValue(new ServerError(503, 'Hub unavailable'))
    await expect(service.requestTeamHubBootstrapProof(expected, {
      hubIdentity: 'hub-atlas', hubUrl, recipientEmail: 'owner@example.test',
      displayName: 'Owner', deviceLabel: 'Desktop'
    })).rejects.toThrow('Hub unavailable')
    expect(teamHubBootstrapProof).toHaveBeenCalledOnce()
  })

  it('discards a proof if the same profile advertises a replacement Hub while the grant is in flight', async () => {
    const pending = deferred<{
      request_id: string; server_identity: string; server_instance_id: string; hub_id: string
      tailnet_login: string; expires_at: string; bootstrap_proof: string
    }>()
    let requestId = ''
    const teamHubBootstrapProof = vi.fn((_url: string, request: { request_id: string }) => {
      requestId = request.request_id
      return pending.promise
    })
    const capability = {
      available: true, designated_host: true, version: 1, base_path: '/api/team-hub',
      transport: 'tailscale_serve', hub_url: 'https://atlas.my-tailnet.ts.net:8444/api/team-hub',
      hub_id: 'hub-old', host_server_identity: 'server-atlas', message: 'ready', action: null
    }
    const scope = { profileId: 'atlas', generation: 9, namespace: 'server-atlas', client: { teamHubBootstrapProof } }
    const settings = {
      getProfile: vi.fn(() => ({ id: 'atlas', name: 'Atlas', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-atlas' })),
      getProfileMetadata: vi.fn(() => ({ id: 'atlas', name: 'Atlas', serverUrl: 'http://100.64.0.1:7850', serverIdentity: 'server-atlas' })),
      serverUrl: vi.fn(() => 'http://100.64.0.1:7850')
    }
    const service = Object.create(AppService.prototype) as AppService
    const health = {
      ok: true, server_identity: 'server-atlas', server_instance_id: 'instance-atlas', capabilities: { team_hub_v1: capability }
    }
    Object.assign(service, {
      scope, activeProfileId: 'atlas', profileGeneration: 9, validatedGeneration: 9, settings, health,
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined), assertCurrentScope: vi.fn()
    })
    const proof = service.requestTeamHubBootstrapProof({
      profileId: 'atlas', profileGeneration: 9, serverIdentity: 'server-atlas',
      serverUrl: 'http://100.64.0.1:7850', serverName: 'Atlas'
    }, {
      hubIdentity: 'hub-old', hubUrl: capability.hub_url, recipientEmail: 'owner@example.test',
      displayName: 'Owner', deviceLabel: 'Desktop'
    })
    await vi.waitFor(() => expect(teamHubBootstrapProof).toHaveBeenCalled())
    health.capabilities.team_hub_v1 = {
      ...capability, hub_id: 'hub-new', hub_url: 'https://other.my-tailnet.ts.net:8444/api/team-hub'
    }
    pending.resolve({
      request_id: requestId, server_identity: 'server-atlas', server_instance_id: 'instance-atlas', hub_id: 'hub-old',
      tailnet_login: 'owner@example.test', expires_at: new Date(Date.now() + 3 * 60_000).toISOString(),
      bootstrap_proof: `bootstrap_remote.${'b'.repeat(43)}`
    })

    await expect(proof).rejects.toThrow('superseded')
  })
})

describe('bounded cross-chat exchange scope fencing', () => {
  it('validates the active profile before and after loading exchange details', async () => {
    const exchange = { id: 'exchange-1', status: 'active' }
    const client = { crossChatExchange: vi.fn().mockResolvedValue(exchange) }
    const scope = { profileId: 'profile', generation: 2, namespace: 'profile:profile', client }
    const ensureValidatedScope = vi.fn().mockResolvedValue(undefined)
    const assertCurrentScope = vi.fn()
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      ensureValidatedScope,
      assertCurrentScope
    })

    await expect(service.crossChatExchange('exchange-1')).resolves.toBe(exchange)
    expect(ensureValidatedScope).toHaveBeenCalledWith(scope)
    expect(client.crossChatExchange).toHaveBeenCalledWith('exchange-1')
    expect(assertCurrentScope).toHaveBeenCalledWith(scope)
  })

  it('rejects a stale-profile cancellation result instead of exposing it to the renderer', async () => {
    const client = { cancelCrossChatExchange: vi.fn().mockResolvedValue({ id: 'exchange-1', status: 'cancelled' }) }
    const scope = { profileId: 'profile', generation: 2, namespace: 'profile:profile', client }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined),
      assertCurrentScope: vi.fn(() => { throw new Error('Server changed while the request was in flight.') })
    })

    await expect(service.cancelCrossChatExchange('exchange-1')).rejects.toThrow('Server changed')
    expect(client.cancelCrossChatExchange).toHaveBeenCalledWith('exchange-1')
  })
})

describe('emergency contact service fencing', () => {
  it('validates the captured profile, acknowledges the exact alert, then upserts only after the response fence', async () => {
    const acknowledged: Session = {
      id: 'chat', title: 'Emergency chat', backend: 'codex',
      emergency_alert: null, unacknowledged_emergency_count: 0
    }
    const acknowledgeEmergency = vi.fn().mockResolvedValue(acknowledged)
    const scope = {
      profileId: 'profile', generation: 2, namespace: 'profile:profile',
      client: { acknowledgeEmergency }
    }
    const ensureValidatedScope = vi.fn().mockResolvedValue(undefined)
    const assertCurrentScope = vi.fn()
    const upsertSession = vi.fn()
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      ensureValidatedScope,
      assertCurrentScope,
      upsertSession
    })
    const alertId = `emergency_${'a'.repeat(32)}`

    await expect(service.acknowledgeEmergency('chat', alertId)).resolves.toBe(acknowledged)

    expect(ensureValidatedScope).toHaveBeenCalledWith(scope)
    expect(acknowledgeEmergency).toHaveBeenCalledWith('chat', alertId)
    expect(assertCurrentScope).toHaveBeenCalledWith(scope)
    expect(upsertSession).toHaveBeenCalledWith(scope, acknowledged)
    expect(assertCurrentScope.mock.invocationCallOrder[0]).toBeLessThan(upsertSession.mock.invocationCallOrder[0])
  })

  it('rejects a response from a superseded profile before mutating the active session cache', async () => {
    const acknowledged: Session = {
      id: 'same-id', title: 'Old server result', backend: 'codex',
      emergency_alert: null, unacknowledged_emergency_count: 0
    }
    const acknowledgeEmergency = vi.fn().mockResolvedValue(acknowledged)
    const scope = {
      profileId: 'old-profile', generation: 4, namespace: 'profile:old-profile',
      client: { acknowledgeEmergency }
    }
    const upsertSession = vi.fn()
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined),
      assertCurrentScope: vi.fn(() => { throw new Error('Server changed while the request was in flight.') }),
      upsertSession
    })

    await expect(service.acknowledgeEmergency('same-id', `emergency_${'b'.repeat(32)}`))
      .rejects.toThrow('Server changed')
    expect(upsertSession).not.toHaveBeenCalled()
  })

  it('merges snapshot and change packets only while their authenticated profile generation remains current', () => {
    let onSessions!: (sessions: Session[], snapshot: boolean, removedSessionId?: string) => void
    const stop = vi.fn()
    const emergencyStream = vi.fn((_expectedServerIdentity: string, listener: typeof onSessions) => {
      onSessions = listener
      return stop
    })
    const scope = {
      profileId: 'profile-a', generation: 7, namespace: 'server-a',
      client: { emergencyStream }
    }
    const putSessions = vi.fn()
    const emitSessions = vi.fn()
    const refreshProfileUnread = vi.fn()
    const disposeSession = vi.fn()
    const service = Object.create(AppService.prototype) as AppService
    const detailed: Session = {
      id: 'chat', title: 'Before', backend: 'codex', system_prompt: 'Preserve me',
      emergency_alert: null, unacknowledged_emergency_count: 0
    }
    const ordinary: Session = {
      id: 'ordinary', title: 'Keep this chat', backend: 'codex', system_prompt: 'Also preserve me'
    }
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      validatedGeneration: scope.generation,
      sessions: [detailed, ordinary],
      emergencyStreamStop: null,
      emergencyStreamGeneration: null,
      portTunnels: { disposeSession },
      cache: { putSessions },
      emitSessions,
      refreshProfileUnread
    })
    const internals = service as unknown as {
      ensureEmergencyStream(capturedScope: unknown, health: Health): void
      sessions: Session[]
      activeProfileId: string
    }
    const capability = {
      agent_emergency_alerts_v1: {
        available: true,
        required: false,
        version: 1 as const,
        max_message_chars: 500,
        max_requests_per_run: 3,
        max_active_alerts: 32,
        stream_path: '/api/emergency-alerts/events',
        message: 'Emergency contact is available.',
        action: null
      }
    }
    const active: Session = {
      id: 'chat', title: 'After', backend: 'codex',
      emergency_alert: {
        id: `emergency_${'c'.repeat(32)}`,
        status: 'active', severity: 'critical', message: 'I need help.',
        raised_at: '2026-08-25T12:00:00Z'
      },
      unacknowledged_emergency_count: 1
    }

    internals.ensureEmergencyStream(scope, {
      ok: true,
      server_identity: 'server-a',
      capabilities: capability
    })
    expect(emergencyStream.mock.calls[0][0]).toBe('server-a')
    onSessions([active], true)

    expect(internals.sessions).toEqual([
      expect.objectContaining({
        id: 'chat', title: 'After', system_prompt: 'Preserve me',
        unacknowledged_emergency_count: 1
      }),
      ordinary
    ])
    expect(putSessions).toHaveBeenLastCalledWith(scope.namespace, internals.sessions)
    expect(emitSessions).toHaveBeenLastCalledWith(scope, internals.sessions)

    onSessions([], true)
    expect(internals.sessions).toEqual([
      expect.objectContaining({
        id: 'chat', system_prompt: 'Preserve me',
        emergency_alert: null, unacknowledged_emergency_count: 0
      }),
      ordinary
    ])

    onSessions([active], false)

    onSessions([{
      id: 'chat', title: 'After', backend: 'codex',
      archived: true, emergency_alert: null, unacknowledged_emergency_count: 0
    }], false)
    expect(internals.sessions[0]).toEqual(expect.objectContaining({
      system_prompt: 'Preserve me', emergency_alert: null, unacknowledged_emergency_count: 0
    }))
    expect(internals.sessions[1]).toBe(ordinary)
    expect(disposeSession).toHaveBeenCalledOnce()
    expect(disposeSession).toHaveBeenCalledWith('chat')

    onSessions([], false, 'chat')
    expect(internals.sessions).toEqual([ordinary])
    expect(disposeSession).toHaveBeenCalledOnce()

    const accepted = internals.sessions
    internals.activeProfileId = 'profile-b'
    onSessions([active], false)
    expect(internals.sessions).toBe(accepted)
    expect(refreshProfileUnread).toHaveBeenCalledTimes(5)
  })

  it('keeps an authenticated emergency stream for an inactive server and routes its notification back to that profile', async () => {
    electronHarness.notificationSupported = true
    let onSessions!: (sessions: Session[], snapshot: boolean, removedSessionId?: string) => void
    const streamStop = vi.fn()
    const inactiveProbe = fakeClient({
      health: async () => ({
        ok: true,
        server_identity: 'server-b',
        capabilities: {
          agent_emergency_alerts_v1: {
            available: true,
            required: false,
            version: 1,
            max_message_chars: 500,
            max_requests_per_run: 3,
            max_active_alerts: 32,
            stream_path: '/api/emergency-alerts/events',
            message: 'Emergency contact is available.',
            action: null
          }
        }
      })
    })
    const inactiveWatcher = fakeClient({
      emergencyStream: (_expectedServerIdentity, listener) => {
        onSessions = listener
        return streamStop
      }
    })
    const { service, settings, cache } = createProfileService({
      'http://a.test:7850': [fakeClient()],
      'http://b.test:7850': [inactiveProbe, inactiveWatcher]
    })
    settings.setProfileServerIdentity('b', 'server-b')
    const staleAlertId = `emergency_${'f'.repeat(32)}`
    cache.putSessions('server-b', [
      { id: 'quiet', title: 'Quiet cached chat', backend: 'codex' },
      {
        id: 'stale-urgent', title: 'Resolved incident', backend: 'codex',
        emergency_alert: {
          id: staleAlertId,
          status: 'active', severity: 'critical', message: 'This is already resolved.',
          raised_at: '2026-08-25T12:00:00Z'
        },
        unacknowledged_emergency_count: 1
      }
    ])
    const send = vi.fn()
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      show: vi.fn(),
      focus: vi.fn(),
      webContents: {
        send,
        isDestroyed: () => false,
        isLoadingMainFrame: () => false
      }
    }
    ;(service as unknown as { windows: Set<unknown> }).windows = new Set([window])
    service.rendererReadyForNotificationRoutes(window as never)

    await probeInactiveProfiles(service)
    expect(inactiveWatcher.emergencyStream).toHaveBeenCalledOnce()
    expect(inactiveWatcher.emergencyStream.mock.calls[0][0]).toBe('server-b')
    const alertId = `emergency_${'e'.repeat(32)}`
    const active: Session = {
      id: 'remote-urgent', title: 'TargetApp incident', backend: 'codex',
      emergency_alert: {
        id: alertId,
        status: 'active', severity: 'critical',
        message: 'Remote production writes may be lost.',
        raised_at: '2026-08-25T13:00:00Z'
      },
      unacknowledged_emergency_count: 1,
      latest_agent_event_seq: 8,
      last_read_agent_event_seq: 7
    }

    onSessions([active], true)
    onSessions([active], true)

    expect(cache.session('server-b', 'remote-urgent')).toEqual(active)
    expect(cache.session('server-b', 'quiet')).toEqual({
      id: 'quiet', title: 'Quiet cached chat', backend: 'codex'
    })
    expect(cache.session('server-b', 'stale-urgent')).toEqual(expect.objectContaining({
      emergency_alert: null,
      unacknowledged_emergency_count: 0
    }))
    expect(electronHarness.notifications).toHaveLength(1)
    expect(electronHarness.notifications[0].options).toEqual({
      title: 'EMERGENCY · TargetApp incident',
      body: 'Remote production writes may be lost.',
      silent: false
    })
    electronHarness.notifications[0].click?.()
    expect(send).toHaveBeenCalledWith('native:notification', {
      profileId: 'b',
      serverIdentity: 'server-b',
      sessionId: 'remote-urgent'
    })

    onSessions([], false, 'remote-urgent')
    expect(cache.session('server-b', 'remote-urgent')).toBeNull()
  })
})

describe('workspace Git scope fencing', () => {
  const expected = { profileId: 'profile', profileGeneration: 4, serverIdentity: 'server-a' }
  function fixture() {
    const client = Object.fromEntries(['workspaceGitStatus', 'workspaceGitDiff', 'workspaceGitConflict', 'workspaceGitAction']
      .map(method => [method, vi.fn().mockResolvedValue({ revision: 'snapshot' })]))
    const scope = { client }
    const service = Object.create(AppService.prototype) as AppService
    const requireWorkspaceScope = vi.fn(() => scope)
    const ensureValidatedScope = vi.fn().mockResolvedValue(undefined)
    const assertCurrentScope = vi.fn()
    Object.assign(service, { requireWorkspaceScope, ensureValidatedScope, assertCurrentScope })
    return { service, client, requireWorkspaceScope, ensureValidatedScope, assertCurrentScope }
  }
  it('checks profile before and after every read and mutation', async () => {
    const f = fixture()
    await f.service.workspaceGitStatus(expected, 'chat')
    await f.service.workspaceGitDiff(expected, 'chat', 'file.ts', 'staged')
    await f.service.workspaceGitConflict(expected, 'chat', 'file.ts')
    await f.service.workspaceGitAction(expected, 'chat', { action: 'commit', expected_revision: 'rev', message: 'Reviewed' })
    expect(f.requireWorkspaceScope).toHaveBeenCalledTimes(4)
    for (const call of f.requireWorkspaceScope.mock.calls) expect(call).toEqual([expected])
    expect(f.assertCurrentScope).toHaveBeenCalledTimes(8)
  })
  it('never mutates after server validation discovers a profile switch', async () => {
    const f = fixture()
    f.assertCurrentScope.mockImplementation(() => { throw new Error('Server changed') })
    await expect(f.service.workspaceGitAction(expected, 'chat', { action: 'stage', paths: ['file'], expected_revision: 'rev' })).rejects.toThrow('Server changed')
    expect(f.client.workspaceGitAction).not.toHaveBeenCalled()
  })
  it('does not return an old server response into a new workspace', async () => {
    const f = fixture()
    f.assertCurrentScope.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('Server changed') })
    await expect(f.service.workspaceGitStatus(expected, 'chat')).rejects.toThrow('Server changed')
    expect(f.client.workspaceGitStatus).toHaveBeenCalledOnce()
  })
})

describe('persistent agent handoff route scope fencing', () => {
  it('validates the active profile around every route admin operation', async () => {
    const route = { route_id: 'route-1', alias: 'mobile' }
    const client = {
      agentHandoffRoutes: vi.fn().mockResolvedValue({ routes: [route], max_routes: 16 }),
      agentTeamMailRoutes: vi.fn().mockResolvedValue({ routes: [], max_routes: 16 }),
      deleteAgentTeamMailRoute: vi.fn().mockResolvedValue({ ok: true, deleted: true, route_id: 'mail-1' }),
      searchAgentHandoffTargets: vi.fn().mockResolvedValue({ chats: [], server_identity: 'server-a' }),
      createAgentHandoffRoute: vi.fn().mockResolvedValue(route),
      updateAgentHandoffRoute: vi.fn().mockResolvedValue(route),
      deleteAgentHandoffRoute: vi.fn().mockResolvedValue({ ok: true, deleted: true, route_id: 'route-1' })
    }
    const scope = { profileId: 'profile', generation: 4, namespace: 'profile:profile', client }
    const ensureValidatedScope = vi.fn().mockResolvedValue(undefined)
    const assertCurrentScope = vi.fn()
    const requireWorkspaceScope = vi.fn((_expected: unknown) => scope)
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      requireWorkspaceScope,
      ensureValidatedScope,
      assertCurrentScope
    })

    const expected = { profileId: 'profile', profileGeneration: 4, serverIdentity: 'server-a' }
    await service.agentHandoffRoutes(expected, 'source')
    await service.searchAgentHandoffTargets(expected, 'mobile', 'source', 10)
    await service.createAgentHandoffRoute(expected, 'source', { alias: 'mobile', target_session_id: 'target' })
    const updateResult = await service.updateAgentHandoffRoute(expected, 'source', 'route-1', { expected_revision: `rev_${'a'.repeat(32)}`, actions: ['request_reply'] })
    const deleteRevision = `rev_${'b'.repeat(32)}`
    const deleteResult = await service.deleteAgentHandoffRoute(expected, 'source', 'route-1', deleteRevision)
    await expect(service.agentTeamMailRoutes(expected, 'source')).resolves.toEqual({ routes: [], max_routes: 16 })
    await expect(service.deleteAgentTeamMailRoute(expected, 'source', 'mail-1', deleteRevision)).resolves.toEqual({ status: 'deleted', deleted: true, route_id: 'mail-1' })

    expect(requireWorkspaceScope).toHaveBeenCalledTimes(7)
    for (const call of requireWorkspaceScope.mock.calls) expect(call[0]).toEqual(expected)
    expect(ensureValidatedScope).toHaveBeenCalledTimes(7)
    expect(assertCurrentScope).toHaveBeenCalledTimes(7)
    expect(client.agentTeamMailRoutes).toHaveBeenCalledWith('source')
    expect(client.deleteAgentTeamMailRoute).toHaveBeenCalledWith('source', 'mail-1', deleteRevision)
    expect(client.searchAgentHandoffTargets).toHaveBeenCalledWith('mobile', 'source', 10)
    expect(client.createAgentHandoffRoute).toHaveBeenCalledWith('source', { alias: 'mobile', target_session_id: 'target' })
    expect(client.updateAgentHandoffRoute).toHaveBeenCalledWith('source', 'route-1', { expected_revision: `rev_${'a'.repeat(32)}`, actions: ['request_reply'] })
    expect(updateResult).toEqual({ status: 'updated', route })
    expect(client.deleteAgentHandoffRoute).toHaveBeenCalledWith('source', 'route-1', deleteRevision)
    expect(deleteResult).toEqual({ status: 'deleted', deleted: true, route_id: 'route-1' })
  })

  it('rejects a stale-profile route mutation result', async () => {
    const client = { createAgentHandoffRoute: vi.fn().mockResolvedValue({ route_id: 'route-1' }) }
    const scope = { profileId: 'profile', generation: 4, namespace: 'profile:profile', client }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      requireWorkspaceScope: vi.fn(() => scope),
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined),
      assertCurrentScope: vi.fn(() => { throw new Error('Server changed while the request was in flight.') })
    })

    await expect(service.createAgentHandoffRoute({ profileId: 'profile', profileGeneration: 4 }, 'source', {
      alias: 'mobile', target_session_id: 'target'
    })).rejects.toThrow('Server changed')
  })

  it('returns a refresh-only result for the structured revision conflict and never retries', async () => {
    const conflict = new ServerError(409, 'This route changed.', {
      code: 'route_revision_conflict', message: 'This route changed.', current_route: null
    })
    const client = { updateAgentHandoffRoute: vi.fn().mockRejectedValue(conflict) }
    const scope = { profileId: 'profile', generation: 4, namespace: 'profile:profile', client }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      requireWorkspaceScope: vi.fn(() => scope),
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined),
      assertCurrentScope: vi.fn()
    })

    await expect(service.updateAgentHandoffRoute({ profileId: 'profile', profileGeneration: 4 }, 'source', 'route-1', {
      expected_revision: `rev_${'a'.repeat(32)}`, alias: 'mobile'
    })).resolves.toEqual({ status: 'revision_conflict' })
    expect(client.updateAgentHandoffRoute).toHaveBeenCalledTimes(1)
  })

  it('does not misclassify an ordinary 409 as a revision conflict', async () => {
    const duplicate = new ServerError(409, 'Alias already exists.', 'Alias already exists.')
    const client = { updateAgentHandoffRoute: vi.fn().mockRejectedValue(duplicate) }
    const scope = { profileId: 'profile', generation: 4, namespace: 'profile:profile', client }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      requireWorkspaceScope: vi.fn(() => scope),
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined),
      assertCurrentScope: vi.fn()
    })

    await expect(service.updateAgentHandoffRoute({ profileId: 'profile', profileGeneration: 4 }, 'source', 'route-1', {
      expected_revision: `rev_${'a'.repeat(32)}`, alias: 'mobile'
    })).rejects.toBe(duplicate)
    expect(client.updateAgentHandoffRoute).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale IPC workspace scope before touching the newly active server client', async () => {
    const newClient = { createAgentHandoffRoute: vi.fn() }
    const activeScope = {
      profileId: 'profile-new', generation: 9, namespace: 'profile:profile-new', client: newClient
    }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope: activeScope,
      activeProfileId: activeScope.profileId,
      profileGeneration: activeScope.generation,
      settings: { getProfile: vi.fn(() => ({ id: 'profile-new', serverIdentity: 'server-new' })) },
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined)
    })

    await expect(service.createAgentHandoffRoute({
      profileId: 'profile-old', profileGeneration: 8, serverIdentity: 'server-old'
    }, 'colliding-session-id', {
      alias: 'mobile', target_session_id: 'target'
    })).rejects.toThrow(/superseded|server changed/i)
    expect(newClient.createAgentHandoffRoute).not.toHaveBeenCalled()
  })
})

describe('pinned item profile fencing', () => {
  it('rejects a queued mutation from the prior profile before staging it in the active namespace', async () => {
    const oldPut = vi.fn()
    const activePut = vi.fn()
    const oldClient = Object.assign(fakeClient(), { putPinnedItem: oldPut })
    const activeClient = Object.assign(fakeClient(), { putPinnedItem: activePut })
    const { service, cache } = createProfileService({
      'http://a.test:7850': [oldClient],
      'http://b.test:7850': [activeClient]
    })
    const initial = await service.bootstrap()
    const staleScope = {
      profileId: 'a',
      profileGeneration: initial.profileGeneration,
      serverIdentity: null
    }

    await service.switchServer('b')

    await expect(service.putPin(staleScope, {
      id: 'message:shared-event',
      sessionId: 'shared-chat',
      kind: 'message',
      eventId: 'shared-event',
      title: 'Old profile message',
      createdAt: 10
    })).rejects.toThrow(/superseded|server changed/i)
    expect(oldPut).not.toHaveBeenCalled()
    expect(activePut).not.toHaveBeenCalled()
    expect(cache.pins('profile:a', 'shared-chat')).toEqual([])
    expect(cache.pins('profile:b', 'shared-chat')).toEqual([])
  })
})

describe('queued Force Send reconciliation', () => {
  it('keeps deferred work queued while retaining successful removal behavior', async () => {
    const queued = { queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Run this', file_ids: [] }
    const later = { queued_id: 'queued-2', session_id: 'chat-1', prompt: 'Later', file_ids: [] }
    const deferredResponse = {
      ok: false,
      queued_id: queued.queued_id,
      deferred: true,
      retryable: true,
      delivery_uncertain: false,
      message: 'The message remains queued.'
    }
    const successResponse = { ok: true, queued_id: queued.queued_id, deferred: false }
    const runQueuedNow = vi.fn()
      .mockResolvedValueOnce(deferredResponse)
      .mockResolvedValueOnce(successResponse)
    const queue = vi.fn().mockResolvedValue([queued, later])
    const putQueuedTurns = vi.fn()
    const client = { runQueuedNow, queue } as unknown as AgentServerClient
    const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client }
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      validatedGeneration: scope.generation,
      cache: { putQueuedTurns }
    })

    await expect(service.runQueuedNow('chat-1', queued.queued_id)).resolves.toBe(deferredResponse)
    expect(putQueuedTurns).toHaveBeenNthCalledWith(1, scope.namespace, 'chat-1', [queued, later])

    await expect(service.runQueuedNow('chat-1', queued.queued_id)).resolves.toBe(successResponse)
    expect(putQueuedTurns).toHaveBeenNthCalledWith(2, scope.namespace, 'chat-1', [later])
  })
})

describe('queued cross-chat capability forwarding', () => {
  it('rejects secure-peer @ references before turn or queue admission reaches AgentsServer', async () => {
    const reference: ChatReference = {
      session_id: '22e7bb2e-3b47-4be7-89fc-2cecd90f4434',
      display_title_snapshot: 'Studio/training',
      source_text_start: 4,
      source_text_end: 20,
      action: 'instruction',
      target_kind: 'secure_peer',
      target_server_identity: 'server-studio',
      target_connection_id: '09d7bb2e-3b47-4be7-89fc-2cecd90f4434',
      target_route_id: '22e7bb2e-3b47-4be7-89fc-2cecd90f4434',
      target_route_revision: `rev_${'a'.repeat(32)}`
    }
    const sendTurn = vi.fn()
    const updateQueued = vi.fn()
    const client = { sendTurn, updateQueued } as unknown as AgentServerClient
    const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client }
    const ensureValidatedScope = vi.fn().mockResolvedValue(undefined)
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      ensureValidatedScope
    })

    await expect(service.sendTurn({
      sessionId: 'chat-1', prompt: 'Ask @Studio/training', fileIds: [], chatReferences: [reference]
    })).rejects.toThrow(/use @@ Team Network Inbox/i)
    await expect(service.updateQueued(
      'chat-1', 'queued-1', 'Ask @Studio/training', [reference]
    )).rejects.toThrow(/use @@ Team Network Inbox/i)

    expect(ensureValidatedScope).not.toHaveBeenCalled()
    expect(sendTurn).not.toHaveBeenCalled()
    expect(updateQueued).not.toHaveBeenCalled()
  })

  it.each([0, 2])('projects an edited async body without replacing a newer cached revision %s', async revision => {
    const queued = {
      queued_id: 'queued-agent', prompt: 'Old body', file_ids: [],
      purpose: 'cross_chat_handoff_delivery', conversation_mode: 'async_route_v1',
      cross_chat_envelope_id: 'envelope-1', source_session_id: 'sender',
      message_body: 'Old body', message_revision: revision
    }
    const updateQueued = vi.fn().mockResolvedValue(true)
    const client = { updateQueued } as unknown as AgentServerClient
    const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client }
    const putQueuedTurns = vi.fn()
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope, activeProfileId: scope.profileId, profileGeneration: scope.generation,
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined), assertCurrentScope: vi.fn(),
      cache: { putQueuedTurns, queuedTurns: vi.fn().mockReturnValue([queued]) }
    })
    await expect(service.updateQueued('chat-1', 'queued-agent', 'Edited @literal', undefined, undefined, undefined, 0)).resolves.toBe(true)
    expect(updateQueued).toHaveBeenCalledWith('chat-1', 'queued-agent', 'Edited @literal', undefined, undefined, undefined, 0)
    expect(putQueuedTurns).toHaveBeenCalledWith(scope.namespace, 'chat-1', [revision > 1 ? queued : {
      ...queued, prompt: 'Edited @literal', display_prompt: 'Edited @literal',
      message_body: 'Edited @literal', message_revision: 1, message_edited_by_user: true
    }])
  })

  it('scope-fences an edit and forwards the exact refreshed client capabilities', async () => {
    const reference = {
      session_id: 'chat-2', display_title_snapshot: 'Target', source_text_start: 4, source_text_end: 11,
      action: 'request_reply' as const
    }
    const capabilities = ['codex_interactive_v1', 'cross_chat_handoffs_v1', 'cross_chat_handoffs_v2']
    const queued = {
      queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Old prompt', display_prompt: 'Old visible prompt', file_ids: []
    }
    const updateQueued = vi.fn().mockResolvedValue(true)
    const queue = vi.fn().mockRejectedValue(new Error('refresh must not run after a committed edit'))
    const client = { updateQueued, queue } as unknown as AgentServerClient
    const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client }
    const ensureValidatedScope = vi.fn().mockResolvedValue(undefined)
    const assertCurrentScope = vi.fn()
    const putQueuedTurns = vi.fn()
    const queuedTurns = vi.fn().mockReturnValue([queued])
    const service = Object.create(AppService.prototype) as AppService
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      ensureValidatedScope,
      assertCurrentScope,
      cache: { putQueuedTurns, queuedTurns }
    })

    await expect(service.updateQueued('chat-1', 'queued-1', 'Ask @Target', [reference], capabilities)).resolves.toBe(true)

    expect(ensureValidatedScope).toHaveBeenCalledWith(scope)
    expect(updateQueued).toHaveBeenCalledWith('chat-1', 'queued-1', 'Ask @Target', [reference], capabilities, undefined)
    expect(assertCurrentScope).toHaveBeenCalledTimes(1)
    expect(queue).not.toHaveBeenCalled()
    expect(putQueuedTurns).toHaveBeenCalledWith(scope.namespace, 'chat-1', [{
      ...queued,
      prompt: 'Ask @Target',
      display_prompt: 'Ask @Target',
      chat_references: [reference]
    }])
  })

  it('caches the exact queued prompt so UTF-16 reference spans remain aligned', async () => {
    const prompt = '  🧭 Ask @Target and @@All  \n'
    const chatStart = prompt.indexOf('@Target')
    const teamStart = prompt.indexOf('@@All')
    const chatReference = {
      session_id: 'chat-2', display_title_snapshot: 'Target',
      source_text_start: chatStart, source_text_end: chatStart + '@Target'.length,
      action: 'request_reply' as const
    }
    const teamReference = {
      kind: 'recipient' as const, recipient_kind: 'all' as const,
      team_id: 'team-1', target_id: 'all', display_name_snapshot: 'All',
      source_text_start: teamStart, source_text_end: teamStart + '@@All'.length,
      grant_intent: true as const
    }
    const queued = {
      queued_id: 'queued-1', session_id: 'chat-1', prompt: 'Old prompt',
      display_prompt: 'Old visible prompt', file_ids: []
    }
    const updateQueued = vi.fn().mockResolvedValue(true)
    const putQueuedTurns = vi.fn()
    const service = Object.create(AppService.prototype) as AppService
    const client = { updateQueued } as unknown as AgentServerClient
    const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client }
    Object.assign(service, {
      scope,
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      ensureValidatedScope: vi.fn().mockResolvedValue(undefined),
      assertCurrentScope: vi.fn(),
      cache: { putQueuedTurns, queuedTurns: vi.fn().mockReturnValue([queued]) }
    })

    await expect(service.updateQueued(
      'chat-1', 'queued-1', prompt, [chatReference], undefined, [teamReference]
    )).resolves.toBe(true)

    expect(updateQueued).toHaveBeenCalledWith(
      'chat-1', 'queued-1', prompt, [chatReference], undefined, [teamReference]
    )
    const projected = putQueuedTurns.mock.calls[0]?.[2]?.[0]
    expect(projected).toMatchObject({
      prompt,
      display_prompt: prompt,
      chat_references: [chatReference],
      team_references: [teamReference]
    })
    expect(projected.prompt.slice(chatReference.source_text_start, chatReference.source_text_end)).toBe('@Target')
    expect(projected.prompt.slice(teamReference.source_text_start, teamReference.source_text_end)).toBe('@@All')
  })
})

function serviceHarness(updated: Session) {
  const updateSession = vi.fn().mockResolvedValue(updated)
  const disconnectTerminal = vi.fn()
  const disposeSessionPorts = vi.fn()
  const upsertSession = vi.fn()
  const service = Object.create(AppService.prototype) as AppService
  const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client: { updateSession } }
  Object.assign(service, {
    client: scope.client,
    scope,
    activeProfileId: scope.profileId,
    profileGeneration: scope.generation,
    validatedGeneration: scope.generation,
    disconnectTerminal,
    portTunnels: { disposeSession: disposeSessionPorts },
    upsertSession
  })
  return { service, updateSession, disconnectTerminal, disposeSessionPorts, upsertSession }
}

function artifactTextHarness(contents: string | Uint8Array) {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-artifact-text-'))
  const path = join(directory, 'artifact.txt')
  writeFileSync(path, contents)
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const service = Object.create(AppService.prototype) as AppService
  const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client: {} }
  Object.assign(service, {
    activeProfileId: scope.profileId,
    profileGeneration: scope.generation,
    scope,
    localFilePath: vi.fn(() => path)
  })
  return { service, path }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const runtimeCatalog: RuntimeCatalog = {
  backends: {
    claude: { models: [{ value: 'claude', label: 'Claude' }], efforts: [] },
    codex: { models: [{ value: 'codex', label: 'Codex' }], efforts: [] }
  }
}

interface FakeClientOptions {
  health?: () => Promise<Health>
  serverRestartStatus?: () => Promise<ServerRestartStatus>
  restartServer?: (input: ServerRestartRequest) => Promise<ServerRestartStatus>
  serverUpdateStatus?: (target?: ServerUpdateTarget) => Promise<ServerUpdateStatus>
  checkServerUpdate?: (track?: ServerUpdateTrack, target?: ServerUpdateTarget) => Promise<ServerUpdateStatus>
  startServerUpdate?: (
    version?: string,
    track?: ServerUpdateTrack,
    whenIdle?: boolean,
    target?: ServerUpdateTarget
  ) => Promise<ServerUpdateStatus>
  cancelServerUpdate?: (scheduleId: string, target?: ServerUpdateTarget) => Promise<ServerUpdateStatus>
  upload?: (sessionId: string, path: string, signal?: AbortSignal) => Promise<import('../shared/types').AgentFile>
  uploadOpened?: (
    sessionId: string,
    source: import('./server-client').OpenedUploadSource,
    signal?: AbortSignal
  ) => Promise<import('../shared/types').AgentFile>
  markRead?: (sessionId: string, seq?: number | null) => Promise<Session>
  markUnread?: (sessionId: string) => Promise<Session>
  sessions?: () => Promise<Session[]>
  jobs?: () => Promise<Job[]>
  createSession?: () => Promise<Session>
  listLocalSessions?: () => Promise<LocalSessionCandidate[]>
  bulkImportSessions?: (items: BulkImportSessionItem[]) => Promise<BulkImportSessionResult[]>
  runJob?: () => Promise<JobRunNowResult>
  jobRuns?: (
    sessionId: string,
    jobId: string,
    beforeSeq?: number | null,
    limit?: number,
    timelineGroupId?: string | null
  ) => Promise<JobRunHistoryPage>
  runTrace?: (
    sessionId: string,
    runId: string,
    anchorSeq: number,
    afterSeq?: number,
    limit?: number
  ) => Promise<TimelineTracePage>
  codexRuntime?: (sessionId: string) => Promise<CodexRuntimeSnapshot>
  loadCodexThread?: (sessionId: string) => Promise<CodexRuntimeSnapshot>
  claudeRuntime?: (sessionId: string) => Promise<ClaudeRuntimeSnapshot>
  refreshClaudeContextUsage?: (sessionId: string) => Promise<ClaudeRuntimeSnapshot>
  resolveClaudeInteraction?: (
    sessionId: string,
    interactionId: string,
    response: Record<string, unknown>
  ) => Promise<ClaudePendingInteraction>
  sessionPage?: (
    sessionId: string,
    options?: {
      after?: number
      before?: number
      limit?: number
      tail?: boolean
      visible?: boolean
      compact?: boolean
      pageMode?: 'semantic'
    }
  ) => Promise<TimelinePage>
  subagents?: (sessionId: string) => Promise<SubagentSnapshot>
  timelineIndex?: (sessionId: string) => Promise<TimelineIndex>
  workspaceFile?: (sessionId: string, path: string) => Promise<WorkspaceFile>
  absoluteFile?: (sessionId: string, path: string) => Promise<WorkspaceFile>
  writeAbsoluteFile?: (sessionId: string, path: string, content: string, expectedRevision: string) => Promise<WorkspaceFile>
  createWorkspaceEntry?: (sessionId: string, path: string, kind: 'file' | 'directory') => Promise<WorkspaceCreateResult>
  writeWorkspaceFile?: (sessionId: string, path: string, content: string, expectedRevision: string) => Promise<WorkspaceFile>
  renameWorkspaceEntry?: (sessionId: string, path: string, newName: string, expectedRevision: string) => Promise<WorkspaceRenameResult>
  removeWorkspaceEntry?: (sessionId: string, path: string, expectedRevision: string, recursive: boolean) => Promise<WorkspaceRemoveResult>
  runtimeCatalog?: (refresh?: boolean) => Promise<RuntimeCatalog>
  fileRequest?: (fileId: string, request?: Request) => Promise<Response>
  workspacePreviewRequest?: (
    sessionId: string,
    path: string,
    request?: Request,
    callerSignal?: AbortSignal
  ) => Promise<Response>
  workspaceDownloadRequest?: (sessionId: string, path: string) => Promise<Response>
  stream?: AgentServerClient['stream']
  emergencyStream?: (
    expectedServerIdentity: string,
    onSessions: (sessions: Session[], snapshot: boolean, removedSessionId?: string) => void,
    onState: (connected: boolean, error?: string) => void
  ) => () => void
  terminal?: () => { write(data: string): void; resize(columns: number, rows: number): void; scroll(delta: number): void; close(): void }
  portTunnelSocket?: (sessionId: string, remotePort: number) => WebSocket
}

function fakeClient(options: FakeClientOptions = {}) {
  return {
    dispose: vi.fn(),
    health: vi.fn(options.health ?? (async () => ({ ok: true }))),
    serverRestartStatus: vi.fn(options.serverRestartStatus ?? (async () => ({
      phase: 'idle', message: 'No restart is active.'
    }))),
    restartServer: vi.fn(options.restartServer ?? (async input => ({
      phase: 'accepted',
      request_id: input.request_id,
      message: 'Restart accepted.',
      ...(input.force ? { forced: true } : {}),
      ...(input.expected_update_schedule_id
        ? { update_schedule_id: input.expected_update_schedule_id }
        : {})
    }))),
    serverUpdateStatus: vi.fn(options.serverUpdateStatus ?? (async () => ({
      phase: 'current', current_version: '0.1.26-beta.28'
    }))),
    checkServerUpdate: vi.fn(options.checkServerUpdate ?? (async () => ({
      phase: 'current', current_version: '0.1.26-beta.28'
    }))),
    startServerUpdate: vi.fn(options.startServerUpdate ?? (async () => ({
      phase: 'pending', current_version: '0.1.26-beta.26'
    }))),
    cancelServerUpdate: vi.fn(options.cancelServerUpdate ?? (async () => ({
      phase: 'available', current_version: '0.1.26-beta.26'
    }))),
    sessions: vi.fn(options.sessions ?? (async () => [])),
    jobs: vi.fn(options.jobs ?? (async () => [])),
    createSession: vi.fn(options.createSession ?? (async () => ({ id: 'created', title: 'Created', backend: 'codex' }))),
    listLocalSessions: vi.fn(options.listLocalSessions ?? (async () => [])),
    bulkImportSessions: vi.fn(options.bulkImportSessions ?? (async () => [])),
    runJob: vi.fn(options.runJob ?? (async () => ({
      ok: true,
      job_id: 'job-a',
      run_id: 'run-a',
      queued: false,
      deferred: false,
      manual_run_pending: false
    }))),
    jobRuns: vi.fn(options.jobRuns ?? (async () => ({
      runs: [],
      total: 0,
      has_more: false,
      next_before: null,
      supported: true
    }))),
    runTrace: vi.fn(options.runTrace ?? (async () => {
      throw new ServerError(404, 'Direct run trace is not available')
    })),
    codexRuntime: vi.fn(options.codexRuntime ?? (async () => ({
      available: true,
      transport: 'app_server',
      interactive_capability: 'codex_interactive_v1',
      thread_loaded: true,
      status: { type: 'idle' },
      goal: null,
      time_budget_seconds: null,
      pending_interactions: [],
      permission_profiles: [],
      background_terminals_supported: null
    }))),
    loadCodexThread: vi.fn(options.loadCodexThread ?? (async () => ({
      available: true,
      transport: 'app_server',
      interactive_capability: 'codex_interactive_v1',
      thread_loaded: true,
      status: { type: 'idle' },
      goal: null,
      time_budget_seconds: null,
      pending_interactions: [],
      permission_profiles: [],
      background_terminals_supported: null
    }))),
    claudeRuntime: vi.fn(options.claudeRuntime ?? (async () => ({
      available: true,
      transport: 'sdk',
      interactive_capability: 'claude_sdk_interactive_v1',
      session_loaded: true,
      status: { type: 'idle' },
      pending_interactions: []
    }))),
    refreshClaudeContextUsage: vi.fn(options.refreshClaudeContextUsage ?? (async () => ({
      available: true,
      transport: 'sdk',
      interactive_capability: 'claude_sdk_interactive_v1',
      session_loaded: true,
      status: { type: 'idle' },
      pending_interactions: [],
      context_usage_refreshed: true
    }))),
    resolveClaudeInteraction: vi.fn(options.resolveClaudeInteraction ?? (async (sessionId, interactionId) => ({
      id: interactionId,
      session_id: sessionId,
      method: 'item/tool/requestApproval',
      params: {},
      created_at: '2026-08-05T00:00:00Z'
    }))),
    sessionPage: vi.fn(options.sessionPage ?? (async sessionId => ({
      session: { id: sessionId, title: 'Chat', backend: 'codex' },
      events: [],
      queued_turns: [],
      has_more: false
    }))),
    subagents: vi.fn(options.subagents ?? (async sessionId => ({
      session_id: sessionId,
      subagents: [],
      count: 0,
      active_count: 0,
      latest_seq: 0
    }))),
    timelineIndex: vi.fn(options.timelineIndex ?? (async sessionId => ({
      session_id: sessionId,
      landmarks: [],
      latest_seq: 0,
      event_count: 0
    }))),
    workspaceInfo: vi.fn(async () => ({ root: '/work', name: 'work', read_only: false, capability_version: 1, max_text_file_bytes: 2_097_152 })),
    workspaceEntries: vi.fn(async () => ({ root: '/work', path: '', entries: [], total: 0, offset: 0, limit: 500, has_more: false })),
    workspaceSearch: vi.fn(async () => ({ root: '/work', query: '', entries: [], scanned: 0, truncated: false, limit: 100 })),
    completeWorkingDirectory: vi.fn(async path => ({
      input: path,
      resolved_path: path,
      exists: true,
      base_path: path,
      suggestions: [],
      truncated: false,
      message: null
    })),
    workspaceFile: vi.fn(options.workspaceFile ?? (async (_sessionId, path) => workspaceFile(path))),
    absoluteFile: vi.fn(options.absoluteFile ?? (async (_sessionId, path) => ({
      ...workspaceFile(path),
      root: '/',
      writable: false,
      scope: 'absolute' as const
    }))),
    writeAbsoluteFile: vi.fn(options.writeAbsoluteFile ?? (async (_sessionId, path, content) => ({
      ...workspaceFile(path, content, 'b'.repeat(64)),
      root: '/',
      writable: true,
      scope: 'absolute' as const
    }))),
    createWorkspaceEntry: vi.fn(options.createWorkspaceEntry ?? (async (_sessionId, path, kind) => ({
      root: '/work',
      entry: {
        name: path.split('/').at(-1) ?? path,
        path,
        kind,
        revision: 'b'.repeat(64)
      },
      ...(kind === 'file' ? { file: workspaceFile(path, '', 'b'.repeat(64)) } : {})
    }))),
    writeWorkspaceFile: vi.fn(options.writeWorkspaceFile ?? (async (_sessionId, path, content) => workspaceFile(path, content, 'b'.repeat(64)))),
    renameWorkspaceEntry: vi.fn(options.renameWorkspaceEntry ?? (async (_sessionId, path, newName) => ({
      root: '/work',
      previous_path: path,
      entry: {
        name: newName,
        path: `${path.split('/').slice(0, -1).join('/')}/${newName}`.replace(/^\//, ''),
        kind: 'file',
        revision: 'b'.repeat(64)
      }
    }))),
    removeWorkspaceEntry: vi.fn(options.removeWorkspaceEntry ?? (async (_sessionId, path, _expectedRevision, recursive) => ({
      root: '/work',
      path,
      kind: recursive ? 'directory' : 'file',
      removed: true
    }))),
    runtimeCatalog: vi.fn(options.runtimeCatalog ?? (async () => runtimeCatalog)),
    fileRequest: vi.fn(options.fileRequest ?? (async () => new Response('file'))),
    workspacePreviewRequest: vi.fn(options.workspacePreviewRequest ?? (async () => new Response('workspace preview'))),
    workspaceDownloadRequest: vi.fn(options.workspaceDownloadRequest ?? (async () => new Response('workspace download'))),
    upload: vi.fn(options.upload ?? (async (_sessionId, path) => ({
      id: `uploaded-${path}`,
      filename: path.split('/').at(-1) ?? path,
      content_type: 'application/octet-stream'
    }))),
    uploadOpened: vi.fn(options.uploadOpened ?? (async (sessionId, source, signal) => {
      if (options.upload) return options.upload(sessionId, source.filename, signal)
      return {
        id: `uploaded-${source.filename}`,
        filename: source.filename,
        content_type: 'application/octet-stream'
      }
    })),
    markRead: vi.fn(options.markRead ?? (async (sessionId, seq) => ({
      id: sessionId, title: sessionId, backend: 'codex', last_read_agent_event_seq: seq ?? null, manual_unread: false
    }))),
    markUnread: vi.fn(options.markUnread ?? (async sessionId => ({
      id: sessionId, title: sessionId, backend: 'codex', manual_unread: true
    }))),
    stream: vi.fn(options.stream ?? (() => vi.fn())),
    emergencyStream: vi.fn(options.emergencyStream ?? (() => vi.fn())),
    terminal: vi.fn(options.terminal ?? (() => ({ write: vi.fn(), resize: vi.fn(), scroll: vi.fn(), close: vi.fn() }))),
    portTunnelSocket: vi.fn(options.portTunnelSocket ?? (() => ({ close: vi.fn() } as unknown as WebSocket)))
  }
}

function workspaceFile(path: string, content = 'hello\n', revision = 'a'.repeat(64)): WorkspaceFile {
  return {
    root: '/work',
    path,
    name: path.split('/').at(-1) ?? path,
    content,
    revision,
    size: content.length,
    mtime_ns: 1,
    writable: true
  }
}

function profileSettings(activeServerUrl = 'http://a.test:7850'): { settings: SettingsStore; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-service-'))
  const ids = ['a', 'b']
  const settings = new SettingsStore({
    path: join(directory, 'settings.json'),
    createProfileId: () => ids.shift() ?? `extra-${Date.now()}`,
    now: () => '2026-07-17T12:00:00Z',
    isMacAppStoreBuild: () => true,
    keychain: { read: () => '', write: () => false, delete: () => undefined },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString('utf8')
    }
  })
  settings.updateProfile('a', { name: 'A', serverUrl: activeServerUrl })
  settings.addProfile({ name: 'B', serverUrl: 'http://b.test:7850' })
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  return { settings, directory }
}

function createProfileService(
  clients: Record<string, Array<ReturnType<typeof fakeClient>>>,
  prepareCache?: (cache: LocalCache) => void,
  portTunnelManager?: PortTunnelManager,
  removeTeamHubProfile?: (profileId: string) => Promise<void | { rollback(): void }>,
  clipboardTempRoot?: string,
  activeServerUrl = 'http://a.test:7850'
): { service: AppService; cache: LocalCache; settings: SettingsStore } {
  const { settings } = profileSettings(activeServerUrl)
  const cache = new LocalCache(':memory:')
  prepareCache?.(cache)
  const service = new AppService({
    settings,
    cache,
    clientFactory: serverUrl => {
      const client = clients[serverUrl]?.shift()
      if (!client) throw new Error(`Missing fake client for ${serverUrl}`)
      return client as unknown as AgentServerClient
    },
    portTunnelManager,
    removeTeamHubProfile,
    clipboardTempRoot
  })
  cleanup.push(() => {
    service.stop()
    cache.close()
  })
  return { service, cache, settings }
}

async function settleBackgroundWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function probeInactiveProfiles(service: AppService) {
  await (service as unknown as { refreshInactiveProfileHealth(): Promise<void> }).refreshInactiveProfileHealth()
  return (await service.bootstrap()).profiles
}

function emptyTimelinePage(sessionId: string): TimelinePage {
  return {
    session: { id: sessionId, title: sessionId, backend: 'codex' },
    events: [],
    queued_turns: [],
    has_more: false,
    latest_seq: 0,
    semantic_paging: true,
    semantic_item_count: 0,
    total: 0
  }
}

function managedRestartHealth(instanceId: string, serverIdentity = 'server-a'): Health {
  return {
    ok: true,
    server_identity: serverIdentity,
    server_instance_id: instanceId,
    server_version: '0.1.20',
    capabilities: {
      server_restart: {
        version: 2,
        available: true,
        required: false,
        message: 'Managed restart is available.',
        action: null,
        force_restart: true,
        force_confirmation_required: true
      }
    }
  }
}

function managedUpdateHealth(version = 9): Health {
  return {
    ok: true,
    server_identity: 'server-a',
    server_instance_id: 'boot-a',
    server_version: '0.1.26-beta.28',
    capabilities: {
      server_updates: {
        version,
        available: true,
        required: false,
        message: 'Managed updates are available.',
        action: null
      }
    }
  }
}

describe('background connection event publication', () => {
  it('forwards owner-safe activity hints without rewriting events or overriding legacy no-run starts', () => {
    const client = fakeClient()
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    const send = vi.fn()
    service.addWindow({ isDestroyed: () => false, on: vi.fn(), webContents: { id: 73, on: vi.fn(), send } } as never)
    const internals = service as unknown as {
      scope: unknown
      health: Health | null
      adoptHealth(scope: unknown, health: Health): unknown
      emitAgentEvent(scope: unknown, event: Event): void
    }
    internals.adoptHealth(internals.scope, {
      ok: true, active: ['chat-a'], active_runs: [{ session_id: 'chat-a', run_id: 'new-run' }]
    })
    const oldEnd: Event = { id: 'old-end', session_id: 'chat-a', seq: 10, type: 'turn_finished', ts: 'now', run_id: 'old-run' }
    internals.emitAgentEvent(internals.scope, oldEnd)
    expect(send).toHaveBeenCalledWith('server:event', expect.objectContaining({
      event: oldEnd, activeSession: true, activeRunId: 'new-run'
    }))
    const legacy: Event = { id: 'legacy-start', session_id: 'chat-b', seq: 11, type: 'turn_started', ts: 'now' }
    internals.emitAgentEvent(internals.scope, legacy)
    const forwarded = send.mock.calls.filter(([channel]) => channel === 'server:event').at(-1)?.[1]
    expect(forwarded.event).toBe(legacy)
    expect(forwarded).not.toHaveProperty('activeSession')
    expect(forwarded).not.toHaveProperty('activeRunId')
    internals.health = null
    internals.emitAgentEvent(internals.scope, { ...legacy, seq: 12, run_id: 'unverified-run' })
    expect(internals.health).toBeNull()
    expect(send.mock.calls.filter(([channel]) => channel === 'server:event').at(-1)?.[1]).not.toHaveProperty('activeSession')
  })

  it('rejects stale profile health capture before altering the new scope activity projection', async () => {
    const client = fakeClient()
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    const internals = service as unknown as {
      scope: { generation: number }
      readActivityHealth(scope: unknown, read: () => Promise<Health>): Promise<Health>
    }
    const read = vi.fn(async () => ({ ok: true }))
    await expect(internals.readActivityHealth({ ...internals.scope, generation: -1 }, read)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })

  it('does not let early idle health erase a streamed start while the session list is still pending', async () => {
    const sessions = deferred<Session[]>()
    const idle: Health = { ok: true, server_identity: 'server-a', server_instance_id: 'boot-a', active: [] }
    const client = fakeClient({ health: async () => ({ ...idle }), sessions: () => sessions.promise })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    const send = vi.fn()
    service.addWindow({ isDestroyed: () => false, on: vi.fn(), webContents: { id: 73, on: vi.fn(), send } } as never)
    const internals = service as unknown as {
      scope: unknown
      adoptHealth(scope: unknown, health: Health): unknown
      emitConnection(scope: unknown, connected: boolean, health: Health): void
      emitAgentEvent(scope: unknown, event: Event): void
      refreshAll(announce: boolean, includeJobs: boolean, scope: unknown): Promise<void>
    }
    internals.adoptHealth(internals.scope, idle)
    internals.emitConnection(internals.scope, true, idle)
    const pending = internals.refreshAll(false, false, internals.scope)
    await Promise.resolve()
    await Promise.resolve()
    internals.emitAgentEvent(internals.scope, {
      id: 'wake-start', session_id: 'chat-a', seq: 10, type: 'turn_started', ts: 'now',
      run_id: 'wake-run', purpose: 'chat_mailbox_wake', prompt: ''
    })
    expect((await service.bootstrap()).health?.active).toEqual(['chat-a'])
    sessions.resolve([])
    await pending
    const connections = () => send.mock.calls.filter(([channel]) => channel === 'server:connection')
    expect(connections().at(-1)?.[1].health.active).toEqual(['chat-a'])
    // This later request begins AFTER the live transition, so a truly idle
    // server can clear stale activity even if its body equals the first one.
    await internals.refreshAll(false, false, internals.scope)
    expect(connections().at(-1)?.[1].health.active).toEqual([])
    expect((await service.bootstrap()).health?.active).toEqual([])
  })

  it('does not let a delayed active health response resurrect a streamed completion', async () => {
    const response = deferred<Health>()
    const active: Health = { ok: true, server_identity: 'server-a', server_instance_id: 'boot-a', active: ['chat-a'] }
    const client = fakeClient({ health: () => response.promise })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    const send = vi.fn()
    service.addWindow({ isDestroyed: () => false, on: vi.fn(), webContents: { id: 73, on: vi.fn(), send } } as never)
    const internals = service as unknown as {
      scope: unknown
      adoptHealth(scope: unknown, health: Health): unknown
      emitAgentEvent(scope: unknown, event: Event): void
      refreshAll(announce: boolean, includeJobs: boolean, scope: unknown): Promise<void>
    }
    internals.adoptHealth(internals.scope, active)
    const pending = internals.refreshAll(false, false, internals.scope)
    internals.emitAgentEvent(internals.scope, {
      id: 'wake-end', session_id: 'chat-a', seq: 11, type: 'turn_finished', ts: 'now', run_id: 'wake-run'
    })
    response.resolve(active)
    await pending
    expect(send.mock.calls.filter(([channel]) => channel === 'server:connection').at(-1)?.[1].health.active).toEqual([])
  })

  it('suppresses telemetry-only health churn while retaining meaningful health changes', async () => {
    const client = fakeClient()
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    const send = vi.fn()
    service.addWindow({
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: { id: 73, on: vi.fn(), send }
    } as never)
    const internals = service as unknown as {
      scope: unknown
      health: Health | null
      setProfileRuntime(profileId: string, patch: { lastConnectionCheckedAt?: number }): void
      emitConnection(scope: unknown, connected: boolean, health?: Health, error?: string): void
    }
    const first: Health = {
      ok: true,
      server_identity: 'server-a',
      server_instance_id: 'boot-a',
      active: [],
      job_guard: {
        load_1m: 0.25,
        load_per_cpu: 0.03125,
        available_mem_mb: 8_192,
        cpu_count: 8,
        start_max_active_runs: 8
      }
    }
    const telemetryOnly: Health = {
      ...first,
      job_guard: {
        ...first.job_guard as Record<string, unknown>,
        load_1m: 7.5,
        load_per_cpu: 0.9375,
        available_mem_mb: 7_100
      }
    }

    internals.health = first
    internals.setProfileRuntime('a', { lastConnectionCheckedAt: 1_000 })
    internals.emitConnection(internals.scope, true, first)
    internals.health = telemetryOnly
    internals.setProfileRuntime('a', { lastConnectionCheckedAt: 2_000 })
    internals.emitConnection(internals.scope, true, telemetryOnly)

    const connectionEvents = () => send.mock.calls.filter(([channel]) => channel === 'server:connection')
    const profileEvents = () => send.mock.calls.filter(([channel]) => channel === 'server:profiles')
    expect(connectionEvents()).toHaveLength(1)
    // The internal health-check timestamp is intentionally absent from the
    // public profile contract, so a telemetry-only refresh must not replace
    // the renderer's complete profiles array either.
    expect(profileEvents()).toHaveLength(1)
    // Event deduplication must not strip telemetry from the actual payload or
    // replace the service's latest internal Health snapshot.
    expect(connectionEvents()[0][1]).toEqual(expect.objectContaining({ health: first }))
    expect((await service.bootstrap()).health).toBe(telemetryOnly)

    const activeChanged: Health = { ...telemetryOnly, active: ['chat-running'] }
    internals.health = activeChanged
    internals.emitConnection(internals.scope, true, activeChanged)
    expect(connectionEvents()).toHaveLength(2)
    expect(connectionEvents()[1][1]).toEqual(expect.objectContaining({
      health: expect.objectContaining({ active: ['chat-running'] })
    }))
  })
})

describe('split-chat timeline subscriptions', () => {
  it('forwards transient summaries only for the current lease and profile without writing them to SQLite', async () => {
    const streams: Array<{
      summary: NonNullable<Parameters<AgentServerClient['stream']>[6]>
      event: (event: Event) => void
      stop: ReturnType<typeof vi.fn>
    }> = []
    const client = () => fakeClient({
      sessionPage: async sessionId => emptyTimelinePage(sessionId),
      stream: (_sessionId, _after, event, _state, _runtime, _pins, summary) => {
        expect(summary).toBeTypeOf('function')
        const stream = { summary: summary!, event, stop: vi.fn() }
        streams.push(stream)
        return stream.stop
      }
    })
    const { service, cache } = createProfileService({
      'http://a.test:7850': [client()], 'http://b.test:7850': [client()]
    })
    Object.assign(service, { validatedGeneration: 1 })
    const send = vi.fn()
    service.addWindow({ isDestroyed: () => false, on: vi.fn(), webContents: { send } } as never)
    const internals = service as unknown as {
      scope: { profileId: string; generation: number; namespace: string }
      pendingEventCache: Map<string, unknown>
      flushEventCache(): void
    }
    const snapshot: ReasoningSummaryStreamSnapshot = {
      type: 'reasoning_summary_stream', session_id: 'chat', instance_id: 'boot-a', revision: 1,
      items: [{ run_id: 'run-a', item_id: 'item-a', backend: 'codex', phase: 'summary',
        text: 'Current live summary.', ts: '2026-09-20T05:00:00Z', after_seq: 0 }]
    }
    await service.subscribeTimeline('chat', 0)
    await settleBackgroundWork()
    const putEvents = vi.spyOn(cache, 'putEvents')
    const before = cache.snapshot(internals.scope.namespace, 'chat')
    send.mockClear()
    streams[0].summary(snapshot)
    expect(send).toHaveBeenCalledExactlyOnceWith('server:reasoning-stream', {
      profileId: 'a', profileGeneration: 1, sessionId: 'chat', snapshot
    })
    expect(internals.pendingEventCache.size).toBe(0)
    internals.flushEventCache()
    expect(putEvents).not.toHaveBeenCalled()
    expect(cache.snapshot(internals.scope.namespace, 'chat')).toEqual(before)
    // The durable lane still persists normally through this same subscription.
    const durable: Event = { id: 'durable', session_id: 'chat', seq: 1, type: 'assistant_text', ts: 'now', text: 'Complete.' }
    streams[0].event(durable)
    internals.flushEventCache()
    expect(putEvents).toHaveBeenCalledWith(internals.scope.namespace, 'chat', [durable])

    await service.subscribeTimeline('chat', 1)
    await settleBackgroundWork()
    expect(streams[0].stop).toHaveBeenCalledOnce()
    send.mockClear()
    putEvents.mockClear()
    streams[0].summary({ ...snapshot, revision: 90 })
    const replacement = { ...snapshot, revision: 2, items: [] }
    streams[1].summary(replacement)
    expect(send).toHaveBeenCalledExactlyOnceWith('server:reasoning-stream', {
      profileId: 'a', profileGeneration: 1, sessionId: 'chat', snapshot: replacement
    })
    service.unsubscribeTimeline('chat')
    send.mockClear()
    streams[1].summary({ ...snapshot, revision: 91 })
    expect(send).not.toHaveBeenCalled()

    await service.switchServer('b')
    Object.assign(service, { validatedGeneration: internals.scope.generation })
    await service.subscribeTimeline('chat', 0)
    await settleBackgroundWork()
    const current = streams.at(-1)!
    expect(current).not.toBe(streams[1])
    send.mockClear()
    putEvents.mockClear()
    streams[0].summary({ ...snapshot, revision: 92 })
    streams[1].summary({ ...snapshot, revision: 93 })
    const otherProfile = { ...snapshot, instance_id: 'boot-b', revision: 0 }
    current.summary(otherProfile)
    expect(send).toHaveBeenCalledExactlyOnceWith('server:reasoning-stream', {
      profileId: 'b', profileGeneration: internals.scope.generation, sessionId: 'chat', snapshot: otherProfile
    })
    expect(internals.pendingEventCache.size).toBe(0)
    internals.flushEventCache()
    expect(putEvents).not.toHaveBeenCalled()
  })

  it('keeps two session streams live and scopes events and sync state to their source chat', async () => {
    const streams = new Map<string, {
      onEvent: (event: Event) => void
      onState: (connected: boolean, error?: string) => void
      stop: ReturnType<typeof vi.fn>
    }>()
    const client = fakeClient({
      sessionPage: async sessionId => emptyTimelinePage(sessionId),
      stream: (sessionId, _after, onEvent, onState) => {
        const stop = vi.fn()
        streams.set(sessionId, { onEvent, onState, stop })
        return stop
      }
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    Object.assign(service, { validatedGeneration: 1 })
    const send = vi.fn()
    service.addWindow({ isDestroyed: () => false, on: vi.fn(), webContents: { send } } as never)

    await service.subscribeTimeline('chat-a', 0)
    await settleBackgroundWork()
    await service.subscribeTimeline('chat-b', 0)
    await settleBackgroundWork()

    expect(client.stream).toHaveBeenCalledTimes(2)
    expect(streams.get('chat-a')?.stop).not.toHaveBeenCalled()
    streams.get('chat-a')?.onState(true)
    streams.get('chat-b')?.onState(true)
    streams.get('chat-a')?.onEvent({
      id: 'a-event', session_id: 'chat-a', seq: 1, type: 'assistant_text', ts: 'now', text: 'A'
    })
    streams.get('chat-b')?.onEvent({
      id: 'b-event', session_id: 'chat-b', seq: 1, type: 'assistant_text', ts: 'now', text: 'B'
    })

    expect(send).toHaveBeenCalledWith('server:sync', expect.objectContaining({ sessionId: 'chat-a', state: 'live' }))
    expect(send).toHaveBeenCalledWith('server:sync', expect.objectContaining({ sessionId: 'chat-b', state: 'live' }))
    expect(send).toHaveBeenCalledWith('server:event', expect.objectContaining({
      event: expect.objectContaining({ id: 'a-event', session_id: 'chat-a' })
    }))
    expect(send).toHaveBeenCalledWith('server:event', expect.objectContaining({
      event: expect.objectContaining({ id: 'b-event', session_id: 'chat-b' })
    }))
  })

  it('replaces only the re-subscribed session and ignores callbacks from its superseded lease', async () => {
    const streams = new Map<string, Array<{
      onEvent: (event: Event) => void
      onState: (connected: boolean, error?: string) => void
      stop: ReturnType<typeof vi.fn>
    }>>()
    const client = fakeClient({
      sessionPage: async sessionId => emptyTimelinePage(sessionId),
      stream: (sessionId, _after, onEvent, onState) => {
        const stream = { onEvent, onState, stop: vi.fn() }
        streams.set(sessionId, [...(streams.get(sessionId) ?? []), stream])
        return stream.stop
      }
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    Object.assign(service, { validatedGeneration: 1 })
    const send = vi.fn()
    service.addWindow({ isDestroyed: () => false, on: vi.fn(), webContents: { send } } as never)

    await service.subscribeTimeline('chat-a', 0)
    await settleBackgroundWork()
    await service.subscribeTimeline('chat-b', 0)
    await settleBackgroundWork()
    const streamA = streams.get('chat-a')?.[0]
    const oldB = streams.get('chat-b')?.[0]

    await service.subscribeTimeline('chat-b', 4)
    await settleBackgroundWork()
    const currentB = streams.get('chat-b')?.[1]

    expect(streamA?.stop).not.toHaveBeenCalled()
    expect(oldB?.stop).toHaveBeenCalledOnce()
    send.mockClear()
    oldB?.onState(false, 'stale disconnect')
    oldB?.onEvent({ id: 'stale-b', session_id: 'chat-b', seq: 5, type: 'assistant_text', ts: 'now', text: 'stale' })
    currentB?.onState(true)
    expect(send).not.toHaveBeenCalledWith('server:sync', expect.objectContaining({ error: 'stale disconnect' }))
    expect(send).not.toHaveBeenCalledWith('server:event', expect.objectContaining({ event: expect.objectContaining({ id: 'stale-b' }) }))
    expect(send).toHaveBeenCalledWith('server:sync', expect.objectContaining({ sessionId: 'chat-b', state: 'live' }))
  })

  it('reconnects each disconnected session without accepting callbacks from the replaced streams', async () => {
    const streams = new Map<string, Array<{
      onEvent: (event: Event) => void
      stop: ReturnType<typeof vi.fn>
    }>>()
    const client = fakeClient({
      sessionPage: async sessionId => emptyTimelinePage(sessionId),
      stream: (sessionId, _after, onEvent) => {
        const stream = { onEvent, stop: vi.fn() }
        streams.set(sessionId, [...(streams.get(sessionId) ?? []), stream])
        return stream.stop
      }
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    Object.assign(service, { validatedGeneration: 1 })
    const send = vi.fn()
    service.addWindow({ isDestroyed: () => false, on: vi.fn(), webContents: { send } } as never)
    await service.subscribeTimeline('chat-a', 0)
    await settleBackgroundWork()
    await service.subscribeTimeline('chat-b', 0)
    await settleBackgroundWork()

    const internals = service as unknown as {
      scope: unknown
      refreshAll(announce: boolean, includeJobs: boolean, scope: unknown): Promise<void>
    }
    await internals.refreshAll(false, false, internals.scope)
    await settleBackgroundWork()

    expect(streams.get('chat-a')).toHaveLength(2)
    expect(streams.get('chat-b')).toHaveLength(2)
    expect(streams.get('chat-a')?.[0].stop).toHaveBeenCalledOnce()
    expect(streams.get('chat-b')?.[0].stop).toHaveBeenCalledOnce()
    send.mockClear()
    streams.get('chat-a')?.[0].onEvent({
      id: 'stale-a', session_id: 'chat-a', seq: 1, type: 'assistant_text', ts: 'now', text: 'stale'
    })
    streams.get('chat-b')?.[1].onEvent({
      id: 'current-b', session_id: 'chat-b', seq: 1, type: 'assistant_text', ts: 'now', text: 'current'
    })
    expect(send).not.toHaveBeenCalledWith('server:event', expect.objectContaining({ event: expect.objectContaining({ id: 'stale-a' }) }))
    expect(send).toHaveBeenCalledWith('server:event', expect.objectContaining({ event: expect.objectContaining({ id: 'current-b' }) }))
  })

  it('does not supersede a cold timeline open while health polling completes', async () => {
    const response = deferred<TimelinePage>()
    const client = fakeClient({ sessionPage: () => response.promise })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    Object.assign(service, { validatedGeneration: 1 })
    const internals = service as unknown as {
      scope: unknown
      refreshAll(announce: boolean, includeJobs: boolean, scope: unknown): Promise<void>
    }

    const opening = service.openTimeline('chat', true)
    await Promise.resolve()
    expect(client.sessionPage).toHaveBeenCalledOnce()

    await internals.refreshAll(false, false, internals.scope)
    response.resolve({
      session: { id: 'chat', title: 'Chat', backend: 'codex' },
      events: [{
        id: 'latest', session_id: 'chat', seq: 10, type: 'assistant_text', ts: 'now', text: 'Latest'
      }],
      queued_turns: [],
      has_more: false,
      latest_seq: 10,
      semantic_paging: true,
      semantic_item_count: 1
    })

    await expect(opening).resolves.toMatchObject({ events: [expect.objectContaining({ id: 'latest' })] })
    expect(client.sessionPage).toHaveBeenCalledOnce()
    expect(client.stream).toHaveBeenCalledOnce()
  })

  it('unsubscribes only the exact pane and retains the other stream when a replacement pane opens', async () => {
    const stops = new Map<string, ReturnType<typeof vi.fn>>()
    const client = fakeClient({
      sessionPage: async sessionId => emptyTimelinePage(sessionId),
      stream: sessionId => {
        const stop = vi.fn()
        stops.set(sessionId, stop)
        return stop
      }
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    Object.assign(service, { validatedGeneration: 1 })

    await service.subscribeTimeline('chat-a', 0)
    await settleBackgroundWork()
    await service.subscribeTimeline('chat-b', 0)
    await settleBackgroundWork()
    service.unsubscribeTimeline('chat-b')
    await service.subscribeTimeline('chat-c', 0)
    await settleBackgroundWork()

    expect(stops.get('chat-b')).toHaveBeenCalledOnce()
    expect(stops.get('chat-a')).not.toHaveBeenCalled()
    expect(stops.get('chat-c')).not.toHaveBeenCalled()
  })

  it('defensively bounds live streams to two sessions', async () => {
    const stops = new Map<string, ReturnType<typeof vi.fn>>()
    const client = fakeClient({
      sessionPage: async sessionId => emptyTimelinePage(sessionId),
      stream: sessionId => {
        const stop = vi.fn()
        stops.set(sessionId, stop)
        return stop
      }
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    Object.assign(service, { validatedGeneration: 1 })

    await service.subscribeTimeline('chat-a', 0)
    await settleBackgroundWork()
    await service.subscribeTimeline('chat-b', 0)
    await settleBackgroundWork()
    await service.subscribeTimeline('chat-c', 0)
    await settleBackgroundWork()

    expect(stops.get('chat-a')).toHaveBeenCalledOnce()
    expect(stops.get('chat-b')).not.toHaveBeenCalled()
    expect(stops.get('chat-c')).not.toHaveBeenCalled()
    const subscriptions = (service as unknown as { timelineSubscriptions: Map<string, unknown> }).timelineSubscriptions
    expect([...subscriptions.keys()]).toEqual(['chat-b', 'chat-c'])
  })

  it('closes every session stream on profile switch and service disposal', async () => {
    const aStops: ReturnType<typeof vi.fn>[] = []
    const bStops: ReturnType<typeof vi.fn>[] = []
    const a = fakeClient({
      sessionPage: async sessionId => emptyTimelinePage(sessionId),
      stream: () => {
        const stop = vi.fn()
        aStops.push(stop)
        return stop
      }
    })
    const b = fakeClient({
      sessionPage: async sessionId => emptyTimelinePage(sessionId),
      stream: () => {
        const stop = vi.fn()
        bStops.push(stop)
        return stop
      }
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })
    Object.assign(service, { validatedGeneration: 1 })
    await service.subscribeTimeline('chat-a', 0)
    await settleBackgroundWork()
    await service.subscribeTimeline('chat-b', 0)
    await settleBackgroundWork()

    await service.switchServer('b')
    expect(aStops).toHaveLength(2)
    expect(aStops.every(stop => stop.mock.calls.length === 1)).toBe(true)

    Object.assign(service, { validatedGeneration: 2 })
    await service.subscribeTimeline('chat-c', 0)
    await settleBackgroundWork()
    service.stop()
    expect(bStops).toHaveLength(1)
    expect(bStops[0]).toHaveBeenCalledOnce()
  })

  it('keeps focused-chat persistence separate from secondary opens and subscriptions', async () => {
    const client = fakeClient({ sessionPage: async sessionId => emptyTimelinePage(sessionId) })
    const { service, cache } = createProfileService({ 'http://a.test:7850': [client] })
    Object.assign(service, { validatedGeneration: 1 })
    service.putPreference('selectedSessionId', 'chat-a')

    await service.subscribeTimeline('chat-b', 0)
    await settleBackgroundWork()
    await service.openTimeline('chat-b', true)
    expect((await service.bootstrap()).selectedSessionId).toBe('chat-a')
    expect(cache.preference('profile:a', 'selectedSessionId', null as string | null)).toBe('chat-a')

    service.putPreference('selectedSessionId', 'chat-b')
    expect((await service.bootstrap()).selectedSessionId).toBe('chat-b')
  })
})

describe('subagent lifecycle hydration', () => {
  it('deduplicates concurrent snapshot requests and tolerates an older server', async () => {
    const response = deferred<SubagentSnapshot>()
    const client = fakeClient({ subagents: async () => response.promise })
    const { service, cache } = createProfileService({
      'http://a.test:7850': [client]
    })
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex' }
    cache.putSession('profile:a', session)
    Object.assign(service, {
      validatedGeneration: 1,
      timelineSubscriptions: new Map([[session.id, { lease: 1, stop: null, connected: false }]])
    })
    const internals = service as unknown as {
      scope: unknown
      refreshSubagentSnapshot(scope: unknown, sessionId: string, lease: number): Promise<void>
    }
    const first = internals.refreshSubagentSnapshot(internals.scope, session.id, 1)
    const second = internals.refreshSubagentSnapshot(internals.scope, session.id, 1)
    await Promise.resolve()
    expect(client.subagents).toHaveBeenCalledOnce()

    response.resolve({
      session_id: session.id,
      subagents: [{
        seq: 7,
        id: 'subagent-state-7',
        session_id: session.id,
        type: 'subagent_state',
        ts: '2026-08-02T12:00:00Z',
        backend: 'codex',
        subagent_id: 'child-1',
        subagent_status: 'running'
      }],
      count: 1,
      active_count: 1,
      latest_seq: 7
    })
    await Promise.all([first, second])
    expect(cache.snapshot('profile:a', session.id)?.events).toEqual([
      expect.objectContaining({ id: 'subagent-state-7', subagent_id: 'child-1' })
    ])

    client.subagents.mockRejectedValueOnce(new ServerError(404, 'Not found'))
    await expect(internals.refreshSubagentSnapshot(internals.scope, session.id, 1)).resolves.toBeUndefined()
    expect(client.subagents).toHaveBeenCalledTimes(2)
  })

  it('returns the timeline without waiting for lifecycle hydration', async () => {
    const response = deferred<SubagentSnapshot>()
    const client = fakeClient({ subagents: async () => response.promise })
    const { service } = createProfileService({
      'http://a.test:7850': [client]
    })
    Object.assign(service, { validatedGeneration: 1 })

    await expect(service.openTimeline('chat', true)).resolves.toMatchObject({
      session: { id: 'chat', backend: 'codex' }
    })
    await settleBackgroundWork()
    expect(client.subagents).toHaveBeenCalledOnce()
    response.resolve({
      session_id: 'chat',
      subagents: [],
      count: 0,
      active_count: 0,
      latest_seq: 0
    })
  })

  it('drops malformed snapshot events before background SQLite persistence while preserving valid events', async () => {
    const valid: Event = {
      seq: 7,
      id: 'subagent-state-7',
      session_id: 'chat',
      type: 'subagent_state',
      ts: '2026-08-02T12:00:00Z',
      backend: 'codex',
      subagent_id: 'child-1',
      subagent_status: 'running'
    }
    const client = fakeClient({
      subagents: async () => ({
        session_id: 'chat',
        subagents: [
          { ...valid, id: undefined },
          { ...valid, id: 42 },
          { ...valid, seq: Number.NaN },
          { ...valid, seq: Number.POSITIVE_INFINITY },
          { ...valid, seq: 1.5 },
          { ...valid, seq: 0 },
          { ...valid, session_id: 'other-chat' },
          { ...valid, type: 'turn_finished' },
          valid
        ] as unknown as Event[],
        count: 9,
        active_count: 1,
        latest_seq: 7
      })
    })
    const { service, cache } = createProfileService({
      'http://a.test:7850': [client]
    })
    Object.assign(service, { validatedGeneration: 1 })
    const putEvents = vi.spyOn(cache, 'putEvents')

    await expect(service.openTimeline('chat', true)).resolves.toMatchObject({
      session: { id: 'chat', backend: 'codex' }
    })
    await settleBackgroundWork()

    expect(client.subagents).toHaveBeenCalledOnce()
    expect(putEvents).toHaveBeenCalledOnce()
    expect(putEvents).toHaveBeenCalledWith('profile:a', 'chat', [valid])
    expect(cache.snapshot('profile:a', 'chat')?.events).toEqual([valid])
  })

  it('keeps the timeline lease fence ahead of filtered snapshot persistence', async () => {
    const response = deferred<SubagentSnapshot>()
    const client = fakeClient({ subagents: async () => response.promise })
    const { service, cache } = createProfileService({
      'http://a.test:7850': [client]
    })
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex' }
    cache.putSession('profile:a', session)
    Object.assign(service, {
      validatedGeneration: 1,
      timelineSubscriptions: new Map([[session.id, { lease: 1, stop: null, connected: false }]])
    })
    const internals = service as unknown as {
      scope: unknown
      refreshSubagentSnapshot(scope: unknown, sessionId: string, lease: number): Promise<void>
    }
    const putEvents = vi.spyOn(cache, 'putEvents')
    const pending = internals.refreshSubagentSnapshot(internals.scope, session.id, 1)
    await Promise.resolve()
    Object.assign(service, {
      timelineSubscriptions: new Map([[session.id, { lease: 2, stop: null, connected: false }]])
    })
    response.resolve({
      session_id: session.id,
      subagents: [{
        seq: 8, id: 'stale-subagent-state', session_id: session.id, type: 'subagent_state',
        ts: '2026-08-02T12:00:01Z', backend: 'codex', subagent_id: 'child-1', subagent_status: 'running'
      }],
      count: 1,
      active_count: 1,
      latest_seq: 8
    })

    await expect(pending).resolves.toBeUndefined()
    expect(putEvents).not.toHaveBeenCalled()
  })

  it('contains unexpected persistence failures from detached snapshot refreshes', async () => {
    const client = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [client]
    })
    const internals = service as unknown as {
      scope: unknown
      scheduleSubagentSnapshotRefresh(scope: unknown, sessionId: string, lease: number): void
      refreshSubagentSnapshot(scope: unknown, sessionId: string, lease: number): Promise<void>
    }
    const refresh = vi.spyOn(internals, 'refreshSubagentSnapshot')
      .mockRejectedValueOnce(new Error('simulated cache write failure'))

    internals.scheduleSubagentSnapshotRefresh(internals.scope, 'chat', 1)
    await settleBackgroundWork()

    expect(refresh).toHaveBeenCalledWith(internals.scope, 'chat', 1)
  })
})

describe('semantic timeline paging', () => {
  it('loads scheduled job run history lazily and degrades on older servers', async () => {
    const latestRun: Event = {
      id: 'latest-job-result',
      session_id: 'chat',
      seq: 44,
      type: 'turn_finished',
      ts: 'now',
      run_id: 'job-run-4',
      job_id: 'job-1',
      result_text: 'Latest result'
    }
    const current = fakeClient({
      jobRuns: async () => ({
        runs: [latestRun],
        total: 4,
        has_more: true,
        next_before: 44,
        supported: true
      })
    })
    const { service } = createProfileService({
      'http://a.test:7850': [current]
    })
    Object.assign(service, { validatedGeneration: 1 })

    await expect(service.jobRuns('chat', 'job-1', 50, 10, 'job:job-1:segment:20')).resolves.toEqual({
      runs: [latestRun],
      total: 4,
      has_more: true,
      next_before: 44,
      supported: true
    })
    expect(current.jobRuns).toHaveBeenCalledWith(
      'chat',
      'job-1',
      50,
      10,
      'job:job-1:segment:20'
    )

    current.jobRuns.mockRejectedValueOnce(new ServerError(404, 'Not found'))
    await expect(service.jobRuns('chat', 'job-1')).resolves.toEqual({
      runs: [],
      total: 0,
      has_more: false,
      next_before: null,
      supported: false
    })
  })

  it('loads a scheduled run trace directly without requiring a turn landmark', async () => {
    const thought: Event = {
      id: 'scheduled-thought',
      session_id: 'chat',
      seq: 22,
      type: 'reasoning_summary',
      ts: 'now',
      run_id: 'scheduled-run',
      job_id: 'job-1',
      text: 'Validated the scheduled result'
    }
    const client = fakeClient({
      runTrace: async () => ({
        events: [thought],
        has_more: false,
        next_after: 22
      })
    })
    const { service } = createProfileService({
      'http://a.test:7850': [client]
    })
    Object.assign(service, { validatedGeneration: 1 })

    await expect(service.timelineTrace('chat', 'scheduled-run', 25, 0, 40)).resolves.toEqual({
      events: [thought],
      has_more: false,
      next_after: 22
    })
    expect(client.runTrace).toHaveBeenCalledWith('chat', 'scheduled-run', 25, 0, 40)
    expect(client.timelineIndex).not.toHaveBeenCalled()
  })

  it('loads a completed run trace on demand without replacing the compact timeline cache', async () => {
    const client = fakeClient({
      timelineIndex: async sessionId => ({
        session_id: sessionId,
        landmarks: [{
          key: 'turn:run-1',
          kind: 'user',
          start_seq: 10,
          end_seq: 80,
          title: 'Inspect it',
          preview: 'Done'
        }, {
          key: 'turn:run-1:start-50',
          kind: 'user',
          start_seq: 50,
          end_seq: 80,
          title: 'Inspect it again',
          preview: 'Done again'
        }],
        latest_seq: 80,
        event_count: 71
      }),
      sessionPage: async (sessionId, options) => ({
        session: { id: sessionId, title: 'Chat', backend: 'codex' },
        events: [
          { id: 'user', session_id: sessionId, seq: 50, type: 'turn_started', ts: 'now', run_id: 'run-1', prompt: 'Inspect it again' },
          { id: 'thought', session_id: sessionId, seq: 51, type: 'reasoning_summary', ts: 'now', run_id: 'run-1', text: 'Checking.' },
          { id: 'foreign-run', session_id: sessionId, seq: 52, type: 'reasoning_summary', ts: 'now', run_id: 'run-2', text: 'Other run.' },
          { id: 'tool', session_id: sessionId, seq: 53, type: 'tool_started', ts: 'now', run_id: 'run-1', tool: { name: 'exec' } },
          { id: 'answer', session_id: sessionId, seq: 54, type: 'assistant_text', ts: 'now', run_id: 'run-1', text: 'Done' },
          { id: 'foreign-session', session_id: 'other-chat', seq: 55, type: 'reasoning_summary', ts: 'now', run_id: 'run-1', text: 'Wrong chat.' }
        ],
        queued_turns: [],
        has_more: false,
        events_omitted_after: 12,
        latest_seq: 40
      })
    })
    const { service, cache } = createProfileService(
      { 'http://a.test:7850': [client] },
      value => {
        value.putSession('profile:a', { id: 'chat', title: 'Chat', backend: 'codex' })
        value.putEvents('profile:a', 'chat', [{
          id: 'compact-answer',
          session_id: 'chat',
          seq: 80,
          type: 'turn_finished',
          ts: 'now',
          run_id: 'run-1',
          result_text: 'Done'
        }])
      }
    )
    Object.assign(service, { validatedGeneration: 1 })

    const detail = await service.timelineTrace('chat', 'run-1', 53, 0, 120)

    expect(client.sessionPage).toHaveBeenCalledWith('chat', {
      after: 49,
      before: 81,
      limit: 120,
      tail: false,
      visible: true,
      compact: false
    })
    expect(detail).toEqual({
      events: [
        expect.objectContaining({ id: 'thought' }),
        expect.objectContaining({ id: 'tool' })
      ],
      has_more: true,
      next_after: 55
    })
    expect(cache.snapshot('profile:a', 'chat')?.events.map(event => event.id)).toEqual(['compact-answer'])
  })

  it('refreshes a cached mid-turn index before loading later trace events', async () => {
    let indexReads = 0
    const client = fakeClient({
      timelineIndex: async sessionId => {
        indexReads++
        return {
          session_id: sessionId,
          landmarks: [{
            key: 'turn:run-1',
            kind: 'user',
            start_seq: 10,
            end_seq: indexReads === 1 ? 20 : 40,
            title: 'Long task',
            preview: 'Still working'
          }],
          latest_seq: indexReads === 1 ? 20 : 40,
          event_count: indexReads === 1 ? 11 : 31
        }
      },
      sessionPage: async (sessionId, options) => ({
        session: { id: sessionId, title: 'Chat', backend: 'codex' },
        events: [{
          id: 'later-thought',
          session_id: sessionId,
          seq: 30,
          type: 'reasoning_summary',
          ts: 'now',
          run_id: 'run-1',
          text: 'Reasoning after the cached boundary.'
        }],
        queued_turns: [],
        has_more: false,
        events_omitted_after: 0,
        latest_seq: 40
      })
    })
    const { service } = createProfileService(
      { 'http://a.test:7850': [client] },
      value => value.putSession('profile:a', { id: 'chat', title: 'Chat', backend: 'codex' })
    )
    Object.assign(service, { validatedGeneration: 1 })

    await service.timelineIndex('chat')
    const detail = await service.timelineTrace('chat', 'run-1', 30, 0, 120)

    expect(client.timelineIndex).toHaveBeenCalledTimes(2)
    expect(client.sessionPage).toHaveBeenCalledWith('chat', {
      after: 9,
      before: 41,
      limit: 120,
      tail: false,
      visible: true,
      compact: false
    })
    expect(detail).toEqual({
      events: [expect.objectContaining({ id: 'later-thought' })],
      has_more: false,
      next_after: 30
    })
  })

  it('requests semantic pages for initial and older timeline loads', async () => {
    const client = fakeClient({
      sessionPage: async (sessionId, options) => ({
        session: { id: sessionId, title: 'Chat', backend: 'codex' },
        events: [{
          id: options?.before ? 'older' : 'latest',
          session_id: sessionId,
          seq: options?.before ? 40 : 100,
          type: 'turn_finished',
          ts: 'now',
          run_id: options?.before ? 'run-old' : 'run-new',
          result_text: 'Done'
        }],
        queued_turns: [],
        has_more: true,
        next_semantic_before: options?.before ? 25 : 75,
        semantic_item_count: 1
      })
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    Object.assign(service, { validatedGeneration: 1 })

    const initial = await service.openTimeline('chat')
    const older = await service.olderTimeline('chat', initial.nextTimelineBefore!, 20)

    expect(client.sessionPage).toHaveBeenNthCalledWith(1, 'chat', expect.objectContaining({
      limit: 48,
      tail: true,
      pageMode: 'semantic'
    }))
    expect(client.sessionPage).toHaveBeenNthCalledWith(2, 'chat', expect.objectContaining({
      before: 75,
      limit: 20,
      pageMode: 'semantic'
    }))
    expect(older.next_semantic_before).toBe(25)
  })

  it('keeps historical-window paging out of the persistent live-tail cache', async () => {
    const cachedSession: Session = { id: 'chat', title: 'Cached title', backend: 'codex' }
    const client = fakeClient({
      sessionPage: async (sessionId, options) => ({
        session: { id: sessionId, title: 'Remote title', backend: 'codex' },
        events: [{
          id: 'historical', session_id: sessionId, seq: 40, type: 'assistant_text', ts: 'now', text: 'Older'
        }],
        queued_turns: [],
        has_more: true,
        latest_seq: 100,
        next_semantic_before: 25,
        semantic_paging: true,
        semantic_item_count: 1
      })
    })
    const { service, cache } = createProfileService(
      { 'http://a.test:7850': [client] },
      value => {
        value.putSession('profile:a', cachedSession)
        value.putEvents('profile:a', 'chat', [{
          id: 'live-tail', session_id: 'chat', seq: 100, type: 'assistant_text', ts: 'now', text: 'Latest'
        }])
        value.putTimelineState('profile:a', 'chat', true, 100, 2, 75, true)
      }
    )
    Object.assign(service, { validatedGeneration: 1 })

    await expect(service.historicalOlderTimeline('chat', 75, 20)).resolves.toMatchObject({
      next_before: 25,
      next_semantic_before: 25
    })

    expect(cache.snapshot('profile:a', 'chat')).toMatchObject({
      session: { title: 'Cached title' },
      events: [expect.objectContaining({ id: 'live-tail' })],
      nextTimelineBefore: 75
    })
    expect(cache.timelineState('profile:a', 'chat')).toMatchObject({
      hasMore: true,
      verifiedLatestSeq: 100,
      knownTotal: 2,
      nextTimelineBefore: 75
    })
  })

  it('replaces an unverified legacy cache with the semantic audit before persisting its cursor', async () => {
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex', latest_event_seq: 90 }
    const client = fakeClient({
      sessionPage: async (sessionId, options) => options?.pageMode === 'semantic'
        ? {
          session,
          events: [{
            id: 'audited',
            session_id: sessionId,
            seq: 90,
            type: 'turn_finished',
            ts: 'now',
            run_id: 'audited-run',
            result_text: 'Audited'
          }],
          queued_turns: [],
          has_more: true,
          next_semantic_before: 80,
          semantic_item_count: 1,
          semantic_total: 2,
          latest_seq: 90
        }
        : {
          session,
          events: [],
          queued_turns: [],
          has_more: false,
          latest_seq: 90
        }
    })
    const { service, cache } = createProfileService(
      { 'http://a.test:7850': [client] },
      value => {
        value.putSession('profile:a', session)
        value.putEvents('profile:a', session.id, [{
          id: 'legacy',
          session_id: session.id,
          seq: 1,
          type: 'assistant_text',
          ts: 'now',
          text: 'Incomplete legacy cache'
        }])
      }
    )
    Object.assign(service, { validatedGeneration: 1 })

    await service.openTimeline('chat')
    await settleBackgroundWork()

    const cached = cache.snapshot('profile:a', 'chat')
    expect(cached?.events.map(event => event.id)).toEqual(['audited'])
    expect(cached?.nextTimelineBefore).toBe(80)
    expect(client.sessionPage).toHaveBeenCalledWith('chat', expect.objectContaining({ pageMode: 'semantic' }))
  })

  it('lazily audits a verified tail once after a health version upgrade and keeps offline cache intact', async () => {
    let version = '0.1.26-beta.60', offline = false
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex', latest_event_seq: 90, last_read_agent_event_seq: 80 }
    const old: Event = { id: 'same-import', session_id: 'chat', seq: 10, type: 'turn_started',
      ts: '2026-09-11T12:00:00Z', backend: 'codex', imported: true, run_id: 'import_history',
      prompt: '<turn_aborted>Synthetic previous turn interrupted.</turn_aborted>' }
    const answer: Event = { id: 'real-answer', session_id: 'chat', seq: 90, type: 'assistant_text',
      ts: old.ts, backend: 'codex', run_id: 'real-run', text: 'Keep the actual answer.' }
    const repaired: Event = { ...old, prompt: '', metadata_only: true, provider_runtime_context: 'turn_aborted',
      provider_origin: { provider: 'codex', kind: 'turn_aborted', event_id: 'source-item', session_id: 'source-thread',
        turn_id: 'source-turn', timestamp: old.ts, source_text_sha256: createHash('sha256').update(old.prompt!).digest('hex') } }
    const client = fakeClient({
      health: async () => ({ ok: true, server_version: version }), sessions: async () => [session],
      sessionPage: async (_id, options) => {
        if (offline) throw new Error('Synthetic offline timeline')
        return { session, events: options?.pageMode === 'semantic' ? [repaired, answer] : [], queued_turns: [],
          has_more: false, latest_seq: 90, total: 2, semantic_paging: true, semantic_item_count: 1 }
      }
    })
    const { service, cache } = createProfileService({ 'http://a.test:7850': [client] }, value => {
      value.putSession('profile:a', session)
      value.putEvents('profile:a', 'chat', [old, answer])
      value.putTimelineState('profile:a', 'chat', false, 90, 2, null, true)
      value.putTimelineState('profile:a', 'unopened', false, 5, 1, null, true)
      value.putPreference('profile:a', 'serverVersion:v1', version)
      value.putPreference('profile:a', 'draft:chat', 'Preserved unsent draft')
    })
    await service.refreshServer('a', 1)
    expect((await service.openTimeline('chat')).events).toEqual([old, answer])
    await settleBackgroundWork()
    expect(client.sessionPage.mock.calls.some(([, options]) => options?.pageMode === 'semantic')).toBe(false)
    service.unsubscribeTimeline('chat')
    const priorCalls = client.sessionPage.mock.calls.length
    version = '0.1.26-beta.61'
    await service.refreshServer('a', 1)
    expect(client.sessionPage).toHaveBeenCalledTimes(priorCalls)
    expect(cache.timelineState('profile:a', 'unopened')?.pagingSchemaVersion).toBeNull()
    offline = true
    expect((await service.openTimeline('chat')).events).toEqual([old, answer])
    await settleBackgroundWork()
    expect(cache.snapshot('profile:a', 'chat')?.events).toEqual([old, answer])
    expect(cache.timelineState('profile:a', 'chat')?.pagingSchemaVersion).toBeNull()
    service.unsubscribeTimeline('chat')
    offline = false
    expect((await service.openTimeline('chat')).events).toEqual([old, answer])
    await settleBackgroundWork()
    expect(cache.snapshot('profile:a', 'chat')?.events).toEqual([repaired, answer])
    expect(cache.timelineState('profile:a', 'chat')?.pagingSchemaVersion).toBe(TIMELINE_PAGING_SCHEMA_VERSION)
    expect(cache.preference('profile:a', 'draft:chat', '')).toBe('Preserved unsent draft')
    expect(cache.session('profile:a', 'chat')?.last_read_agent_event_seq).toBe(80)
    const auditCalls = client.sessionPage.mock.calls.filter(([, options]) => options?.pageMode === 'semantic').length
    await service.refreshServer('a', 1)
    service.unsubscribeTimeline('chat')
    await service.openTimeline('chat'); await settleBackgroundWork()
    expect(client.sessionPage.mock.calls.filter(([, options]) => options?.pageMode === 'semantic')).toHaveLength(auditCalls)
    expect(client.sessionPage.mock.calls.every(([id]) => id === 'chat')).toBe(true)
  })

  it('re-audits a cached legacy page after the server gains semantic paging', async () => {
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex', latest_event_seq: 90 }
    const client = fakeClient({
      sessionPage: async (sessionId, options) => options?.pageMode === 'semantic'
        ? {
          session,
          events: [
            {
              id: 'restored-user',
              session_id: sessionId,
              seq: 10,
              type: 'turn_started',
              ts: 'now',
              run_id: 'restored-run',
              prompt: 'Previously hidden question'
            },
            {
              id: 'restored-answer',
              session_id: sessionId,
              seq: 90,
              type: 'assistant_text',
              ts: 'now',
              run_id: 'restored-run',
              text: 'Visible answer'
            }
          ],
          queued_turns: [],
          has_more: false,
          semantic_item_count: 1,
          semantic_total: 1,
          latest_seq: 90
        }
        : {
          session,
          events: [],
          queued_turns: [],
          has_more: false,
          latest_seq: 90
        }
    })
    const { service, cache } = createProfileService(
      { 'http://a.test:7850': [client] },
      value => {
        value.putSession('profile:a', session)
        value.putEvents('profile:a', session.id, [{
          id: 'legacy-answer',
          session_id: session.id,
          seq: 90,
          type: 'assistant_text',
          ts: 'now',
          run_id: 'restored-run',
          text: 'Visible answer'
        }])
        value.putTimelineState('profile:a', session.id, true, 90, 100, 80, false)
        value.putPreference('profile:a', 'serverVersion:v1', '0.1.13-beta.8')
        value.putPreference('profile:a', 'semanticTimelineCapability:v1', {
          serverVersion: '0.1.13-beta.2',
          supported: false
        })
      }
    )
    Object.assign(service, { validatedGeneration: 1 })

    await service.openTimeline('chat')
    await settleBackgroundWork()

    expect(cache.snapshot('profile:a', 'chat')?.events.map(event => event.id)).toEqual([
      'restored-user',
      'restored-answer'
    ])
    expect(cache.timelineState('profile:a', 'chat')).toMatchObject({
      semanticPaging: true,
      pagingSchemaVersion: TIMELINE_PAGING_SCHEMA_VERSION
    })
  })

  it('repairs an already cached legacy tail when its semantic audit falls back to legacy paging', async () => {
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex', latest_event_seq: 900 }
    const client = fakeClient({
      sessionPage: async (sessionId, options) => {
        if ((options?.after ?? 0) > 0) {
          return {
            session,
            events: [],
            queued_turns: [],
            has_more: false,
            latest_seq: 900
          }
        }
        if (options?.compact) {
          return {
            session,
            events: [{
              id: 'cached-long-start',
              session_id: sessionId,
              seq: 100,
              type: 'turn_started',
              ts: 'now',
              run_id: 'cached-long-run',
              prompt: 'Restore this cached user message'
            }],
            queued_turns: [],
            has_more: true,
            before: 100,
            latest_seq: 900
          }
        }
        return {
          session,
          events: [
            {
              id: options?.pageMode === 'semantic' ? 'unsupported-semantic-tail' : 'legacy-tail-trace',
              session_id: sessionId,
              seq: 700,
              type: 'tool_started',
              ts: 'now',
              run_id: 'cached-long-run'
            },
            {
              id: 'cached-long-answer',
              session_id: sessionId,
              seq: 900,
              type: 'assistant_text',
              ts: 'now',
              run_id: 'cached-long-run',
              text: 'Visible answer'
            }
          ],
          queued_turns: [],
          has_more: true,
          before: 700,
          latest_seq: 900
        }
      }
    })
    const { service, cache } = createProfileService(
      { 'http://a.test:7850': [client] },
      value => {
        value.putSession('profile:a', session)
        value.putEvents('profile:a', session.id, [{
          id: 'cached-long-answer',
          session_id: session.id,
          seq: 900,
          type: 'assistant_text',
          ts: 'now',
          run_id: 'cached-long-run',
          text: 'Visible answer'
        }])
        value.putTimelineState('profile:a', session.id, true, 900, 900, 700, false)
        value.putPreference('profile:a', 'serverVersion:v1', '0.1.13-beta.8')
        value.putPreference('profile:a', 'semanticTimelineCapability:v1', {
          serverVersion: '0.1.13-beta.2',
          supported: false
        })
      }
    )
    Object.assign(service, { validatedGeneration: 1 })

    expect((await service.openTimeline('chat')).events.map(event => event.id)).toEqual([
      'cached-long-answer'
    ])
    await settleBackgroundWork()

    expect(cache.snapshot('profile:a', 'chat')?.events.map(event => event.id)).toEqual([
      'cached-long-start',
      'legacy-tail-trace',
      'cached-long-answer'
    ])
    expect(cache.timelineState('profile:a', 'chat')).toMatchObject({
      semanticPaging: false,
      pagingSchemaVersion: TIMELINE_PAGING_SCHEMA_VERSION
    })
    expect(client.sessionPage).toHaveBeenCalledWith('chat', expect.objectContaining({
      before: 700,
      compact: true
    }))
  })

  it('restores the opening user event when a legacy tail begins mid-turn', async () => {
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex', latest_event_seq: 900 }
    const client = fakeClient({
      sessionPage: async (sessionId, options) => {
        if (options?.pageMode === 'semantic') {
          return {
            session,
            events: [{
              id: 'ignored-semantic',
              session_id: sessionId,
              seq: 700,
              type: 'tool_started',
              ts: 'now',
              run_id: 'long-run'
            }],
            queued_turns: [],
            has_more: true,
            before: 700,
            latest_seq: 900
          }
        }
        if (options?.compact) {
          return {
            session,
            events: [{
              id: 'long-start',
              session_id: sessionId,
              seq: 100,
              type: 'turn_started',
              ts: 'now',
              run_id: 'long-run',
              prompt: 'Keep this user message'
            }],
            queued_turns: [],
            has_more: true,
            before: 100,
            latest_seq: 900
          }
        }
        return {
          session,
          events: [
            {
              id: 'tail-trace',
              session_id: sessionId,
              seq: 700,
              type: 'tool_started',
              ts: 'now',
              run_id: 'long-run'
            },
            {
              id: 'tail-answer',
              session_id: sessionId,
              seq: 900,
              type: 'assistant_text',
              ts: 'now',
              run_id: 'long-run',
              text: 'Done'
            }
          ],
          queued_turns: [],
          has_more: true,
          before: 700,
          latest_seq: 900
        }
      }
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    Object.assign(service, { validatedGeneration: 1 })

    const snapshot = await service.openTimeline('chat')

    expect(snapshot.events.map(event => event.id)).toEqual([
      'long-start',
      'tail-trace',
      'tail-answer'
    ])
    expect(client.sessionPage).toHaveBeenCalledWith('chat', expect.objectContaining({
      before: 700,
      compact: true
    }))
  })

  it('replaces an empty cached timeline with its first authoritative semantic page', async () => {
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex', latest_event_seq: 1_000 }
    const client = fakeClient({
      sessionPage: async sessionId => ({
        session,
        events: [{
          id: 'semantic-tail',
          session_id: sessionId,
          seq: 901,
          type: 'turn_finished',
          ts: 'now',
          run_id: 'semantic-run',
          result_text: 'Loaded'
        }],
        queued_turns: [],
        has_more: true,
        next_semantic_before: 700,
        semantic_item_count: 1,
        total: 321,
        latest_seq: 1_000
      })
    })
    const { service, cache } = createProfileService(
      { 'http://a.test:7850': [client] },
      value => value.putSession('profile:a', session)
    )
    Object.assign(service, { validatedGeneration: 1 })

    const initial = await service.openTimeline('chat')
    expect(initial.events).toEqual([])

    await settleBackgroundWork()

    expect(cache.timelineState('profile:a', 'chat')).toMatchObject({
      hasMore: true,
      verifiedLatestSeq: 1_000,
      knownTotal: 321,
      nextTimelineBefore: 700,
      semanticPaging: true
    })
    expect(cache.snapshot('profile:a', 'chat')).toMatchObject({
      events: [expect.objectContaining({ id: 'semantic-tail' })],
      eventsTotal: 321,
      nextTimelineBefore: 700,
      semanticPaging: true
    })
    expect(client.sessionPage).toHaveBeenCalledTimes(1)
    expect(client.sessionPage).toHaveBeenCalledWith('chat', expect.objectContaining({
      limit: 48,
      pageMode: 'semantic'
    }))
  })

  it('retries an older page as a bounded raw request when the server ignores semantic paging', async () => {
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex', latest_event_seq: 90 }
    const client = fakeClient({
      sessionPage: async (sessionId, options) => ({
        session,
        events: [{
          id: options?.pageMode ? 'ignored-semantic-response' : 'legacy-page',
          session_id: sessionId,
          seq: options?.pageMode ? 70 : 40,
          type: 'turn_finished',
          ts: 'now',
          run_id: options?.pageMode ? 'ignored' : 'legacy',
          result_text: 'Done'
        }],
        queued_turns: [],
        has_more: true,
        next_before: options?.pageMode ? 70 : 40
      })
    })
    const { service, cache } = createProfileService(
      { 'http://a.test:7850': [client] },
      value => {
        value.putSession('profile:a', session)
        value.putTimelineState('profile:a', session.id, true, 90, 100, 80, true)
      }
    )
    Object.assign(service, { validatedGeneration: 1 })

    const page = await service.olderTimeline('chat', 80, 20)

    expect(client.sessionPage).toHaveBeenNthCalledWith(1, 'chat', expect.objectContaining({
      before: 80,
      limit: 20,
      pageMode: 'semantic'
    }))
    expect(client.sessionPage).toHaveBeenNthCalledWith(2, 'chat', expect.objectContaining({
      before: 80,
      limit: 480
    }))
    expect(client.sessionPage.mock.calls[1]?.[1]).not.toHaveProperty('pageMode')
    expect(page.events.map(event => event.id)).toEqual(['legacy-page'])
    expect(page.semantic_paging).toBe(false)
    expect(page.next_before).toBe(40)
    expect(cache.timelineState('profile:a', 'chat')).toMatchObject({
      nextTimelineBefore: 40,
      semanticPaging: false
    })
  })

  it('uses a bounded raw cache page offline without persisting an unsafe cursor or exhausting uncached history', async () => {
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex', latest_event_seq: 4 }
    const offline = new Error('server unreachable')
    const client = fakeClient({ sessionPage: async () => { throw offline } })
    const { service, cache } = createProfileService(
      { 'http://a.test:7850': [client] },
      value => {
        value.putSession('profile:a', session)
        value.putEvents('profile:a', session.id, [
          {
            id: 'cached-start', session_id: session.id, seq: 1, type: 'turn_started',
            ts: 'now', run_id: 'cached', prompt: 'Cached question'
          },
          {
            id: 'cached-finish', session_id: session.id, seq: 2, type: 'turn_finished',
            ts: 'now', run_id: 'cached', result_text: 'Cached answer'
          }
        ])
        value.putTimelineState('profile:a', session.id, true, 4, 10, 3, true)
      }
    )
    Object.assign(service, { validatedGeneration: 1 })

    const cachedPage = await service.olderTimeline('chat', 3, 20)

    expect(cachedPage.events.map(event => event.id)).toEqual(['cached-start', 'cached-finish'])
    expect(cachedPage.has_more).toBe(true)
    expect(cachedPage.next_before).toBe(1)
    expect(cachedPage.semantic_paging).toBe(false)
    expect(cache.timelineState('profile:a', 'chat')).toMatchObject({
      hasMore: true,
      nextTimelineBefore: 3,
      semanticPaging: true
    })

    await expect(service.olderTimeline('chat', 1, 20)).rejects.toThrow('server unreachable')
    expect(cache.timelineState('profile:a', 'chat')).toMatchObject({
      hasMore: true,
      nextTimelineBefore: 3,
      semanticPaging: true
    })
  })

  it('prefers the remote semantic page over cached history when loading older items', async () => {
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex' }
    const client = fakeClient({
      sessionPage: async sessionId => ({
        session,
        events: [{
          id: 'remote',
          session_id: sessionId,
          seq: 40,
          type: 'turn_finished',
          ts: 'now',
          result_text: 'Remote'
        }],
        queued_turns: [],
        has_more: true,
        next_semantic_before: 30,
        semantic_item_count: 1
      })
    })
    const { service } = createProfileService(
      { 'http://a.test:7850': [client] },
      cache => {
        cache.putSession('profile:a', session)
        cache.putEvents('profile:a', session.id, [{
          id: 'cached',
          session_id: session.id,
          seq: 20,
          type: 'turn_finished',
          ts: 'now',
          result_text: 'Cached'
        }])
        cache.putTimelineState('profile:a', session.id, true, 40, 40, 35, true)
      }
    )
    Object.assign(service, { validatedGeneration: 1 })

    const page = await service.olderTimeline('chat', 50, 20)

    expect(page.events.map(event => event.id)).toEqual(['remote'])
    expect(client.sessionPage).toHaveBeenCalledWith('chat', expect.objectContaining({
      before: 50,
      limit: 20,
      pageMode: 'semantic'
    }))
  })

  it('pages a long cached job run by raw cursor without replaying a local semantic group', async () => {
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex' }
    const client = fakeClient({ sessionPage: async () => { throw new Error('offline') } })
    const events: Event[] = Array.from({ length: 2_502 }, (_, index) => {
      const seq = index + 1
      return {
        id: `job-event-${seq}`,
        session_id: session.id,
        seq,
        type: seq === 1 ? 'job_started' : seq === 2_502 ? 'job_finished' : 'tool_output',
        ts: 'now',
        run_id: 'long-job-run',
        job_id: 'long-job'
      }
    })
    const { service } = createProfileService(
      { 'http://a.test:7850': [client] },
      cache => {
        cache.putSession('profile:a', session)
        cache.putEvents('profile:a', session.id, events)
        cache.putTimelineState('profile:a', session.id, true, 2_502, 2_502, 2_023, true)
      }
    )
    Object.assign(service, { validatedGeneration: 1 })

    const newest = await service.olderTimeline('chat', 2_503, 120)
    const previous = await service.olderTimeline('chat', newest.next_before!, 120)

    expect(newest.events).toHaveLength(480)
    expect(newest.events[0]?.seq).toBe(2_023)
    expect(newest.events.at(-1)?.seq).toBe(2_502)
    expect(previous.events[0]?.seq).toBe(1_543)
    expect(previous.events.at(-1)?.seq).toBe(2_022)
    expect(newest.semantic_paging).toBe(false)
    expect(previous.semantic_paging).toBe(false)
    expect(newest).not.toHaveProperty('semantic_item_count')
    expect(previous).not.toHaveProperty('semantic_item_count')
  })

  it('retries an initial old-server semantic probe as a raw 480-event request', async () => {
    const session: Session = { id: 'chat', title: 'Chat', backend: 'codex' }
    const client = fakeClient({
      sessionPage: async (sessionId, options) => ({
        session,
        events: [{
          id: options?.pageMode ? 'ignored-semantic-response' : 'legacy-page',
          session_id: sessionId,
          seq: 500,
          type: 'turn_finished',
          ts: 'now',
          result_text: 'Done'
        }],
        queued_turns: [],
        has_more: true,
        next_before: 450,
        latest_seq: 500
      })
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    Object.assign(service, { validatedGeneration: 1 })

    const snapshot = await service.openTimeline('chat')

    expect(client.sessionPage).toHaveBeenNthCalledWith(1, 'chat', expect.objectContaining({
      limit: 48,
      pageMode: 'semantic'
    }))
    expect(client.sessionPage).toHaveBeenNthCalledWith(2, 'chat', expect.objectContaining({
      limit: 480
    }))
    expect(client.sessionPage.mock.calls[1]?.[1]).not.toHaveProperty('pageMode')
    expect(snapshot.events.map(event => event.id)).toEqual(['legacy-page'])
    expect(snapshot.semanticPaging).toBe(false)
  })
})

describe('session terminal lifecycle', () => {
  it('disconnects the local terminal after a chat is archived', async () => {
    const updated: Session = { id: 'chat', title: 'Chat', backend: 'codex', archived: true }
    const { service, disconnectTerminal, disposeSessionPorts, upsertSession } = serviceHarness(updated)

    await service.updateSession('chat', { archived: true } as UpdateSessionInput)

    expect(disconnectTerminal).toHaveBeenCalledWith('chat')
    expect(disposeSessionPorts).toHaveBeenCalledWith('chat')
    expect(upsertSession).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'profile', generation: 1 }), updated)
  })

  it('does not disconnect the terminal for ordinary session edits', async () => {
    const updated: Session = { id: 'chat', title: 'Renamed', backend: 'codex', archived: false }
    const { service, disconnectTerminal } = serviceHarness(updated)

    await service.updateSession('chat', { title: 'Renamed' } as UpdateSessionInput)

    expect(disconnectTerminal).not.toHaveBeenCalled()
  })

  it('persists agent scheduled-jobs access without affecting human session services', async () => {
    const updated: Session = {
      id: 'chat', title: 'Chat', backend: 'codex', archived: false,
      provider_jobs_access: 'blocked'
    }
    const { service, updateSession, disconnectTerminal, upsertSession } = serviceHarness(updated)

    await expect(service.updateSession('chat', {
      provider_jobs_access: 'blocked'
    })).resolves.toBe(updated)

    expect(updateSession).toHaveBeenCalledWith('chat', { provider_jobs_access: 'blocked' })
    expect(disconnectTerminal).not.toHaveBeenCalled()
    expect(upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'profile', generation: 1 }),
      updated
    )
  })
})

describe('artifact text files', () => {
  it('reads a cached UTF-8 artifact and returns a stable content revision', async () => {
    const content = '# Motion policy\n速度 = 1\n'
    const { service } = artifactTextHarness(content)
    const file = { id: 'policy-1', filename: 'policy.md', content_type: 'text/markdown' }

    await expect(service.readTextFile('chat', file)).resolves.toEqual({
      id: 'policy-1',
      filename: 'policy.md',
      content,
      content_type: 'text/markdown',
      size: Buffer.byteLength(content),
      revision: createHash('sha256').update(content).digest('hex')
    })
  })

  it('returns a bounded preview for cached artifacts larger than 2 MiB', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024 + 1).fill(0x61)
    const { service } = artifactTextHarness(bytes)

    await expect(service.readTextFile('chat', { id: 'large', filename: 'large.txt' }))
      .resolves.toMatchObject({
        size: bytes.byteLength,
        preview_size: 2 * 1024 * 1024,
        truncated: true
      })
  })

  it('does not reject a text preview cut through a trailing UTF-8 character', async () => {
    const prefix = Buffer.alloc(2 * 1024 * 1024 - 1, 0x61)
    const bytes = Buffer.concat([prefix, Buffer.from('€')])
    const { service } = artifactTextHarness(bytes)

    const preview = await service.readTextFile('chat', { id: 'large-utf8', filename: 'large.txt' })

    expect(preview.truncated).toBe(true)
    expect(preview.preview_size).toBe(2 * 1024 * 1024)
    expect(preview.content).toHaveLength(prefix.byteLength)
    expect(preview.content.endsWith('a')).toBe(true)
  })

  it('rejects NUL-containing binary artifacts', async () => {
    const { service } = artifactTextHarness(new Uint8Array([0x61, 0x00, 0x62]))

    await expect(service.readTextFile('chat', { id: 'binary', filename: 'binary.dat' }))
      .rejects.toThrow('appears to be binary')
  })

  it('rejects byte sequences that are not valid UTF-8', async () => {
    const { service } = artifactTextHarness(new Uint8Array([0xc3, 0x28]))

    await expect(service.readTextFile('chat', { id: 'invalid', filename: 'invalid.txt' }))
      .rejects.toThrow('not valid UTF-8')
  })

  it('accepts ANSI-colored text logs', async () => {
    const content = '\u001b[32mready\u001b[0m\n'
    const { service } = artifactTextHarness(content)

    await expect(service.readTextFile('chat', { id: 'ansi', filename: 'run.log', content_type: 'text/plain' }))
      .resolves.toMatchObject({ content })
  })

  it('caps an uncached network response before writing it to disk', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-artifact-stream-'))
    const path = join(directory, 'uncached.txt')
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const bytes = new Uint8Array(2 * 1024 * 1024 + 1).fill(0x61)
    const fileRequest = vi.fn().mockResolvedValue(new Response(
      bytes,
      { status: 200 }
    ))
    const service = Object.create(AppService.prototype) as AppService
    const scope = {
      profileId: 'profile',
      generation: 1,
      namespace: 'profile:profile',
      client: { fileRequest, health: vi.fn().mockResolvedValue({ server_identity: 'test' }) }
    }
    Object.assign(service, {
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      validatedGeneration: scope.generation,
      scope,
      localFilePath: vi.fn(() => path)
    })

    await expect(service.readTextFile('chat', { id: 'large-network', filename: 'large.txt' }))
      .resolves.toMatchObject({
        size: bytes.byteLength,
        preview_size: 2 * 1024 * 1024,
        truncated: true
      })
    expect(existsSync(path)).toBe(false)
  })

  it('cancels the remaining response after reading a bounded Content-Length preview', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-artifact-header-'))
    const path = join(directory, 'uncached.txt')
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const cancel = vi.fn()
    const preview = new Uint8Array(2 * 1024 * 1024).fill(0x61)
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(preview) },
      cancel
    }), {
      status: 200,
      headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) }
    })
    const fileRequest = vi.fn().mockResolvedValue(response)
    const service = Object.create(AppService.prototype) as AppService
    const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client: { fileRequest } }
    Object.assign(service, {
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      validatedGeneration: scope.generation,
      scope,
      localFilePath: vi.fn(() => path)
    })

    await expect(service.readTextFile('chat', { id: 'large-header', filename: 'large.txt' }))
      .resolves.toMatchObject({
        size: 2 * 1024 * 1024 + 1,
        preview_size: 2 * 1024 * 1024,
        truncated: true
      })
    expect(cancel).toHaveBeenCalledOnce()
    expect(existsSync(path)).toBe(false)
  })

  it('cancels non-success response bodies', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-artifact-error-'))
    const path = join(directory, 'uncached.txt')
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const cancel = vi.fn()
    const fileRequest = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 503 }))
    const service = Object.create(AppService.prototype) as AppService
    const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client: { fileRequest } }
    Object.assign(service, {
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      validatedGeneration: scope.generation,
      scope,
      localFilePath: vi.fn(() => path)
    })

    await expect(service.readTextFile('chat', { id: 'unavailable', filename: 'source.ts' }))
      .rejects.toThrow('Artifact download failed (503')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('aborts an uncached artifact read when the caller cancels it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-artifact-cancel-'))
    const path = join(directory, 'uncached.txt')
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const fileRequest = vi.fn((_sessionId: string, _fileId: string, _request: Request | undefined, signal: AbortSignal) => (
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    ))
    const service = Object.create(AppService.prototype) as AppService
    const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client: { fileRequest } }
    Object.assign(service, {
      activeProfileId: scope.profileId,
      profileGeneration: scope.generation,
      validatedGeneration: scope.generation,
      scope,
      localFilePath: vi.fn(() => path)
    })
    const controller = new AbortController()
    const read = service.readTextFile('chat', { id: 'cancel', filename: 'source.ts' }, controller.signal)
    await vi.waitFor(() => expect(fileRequest).toHaveBeenCalledOnce())

    controller.abort()

    await expect(read).rejects.toThrow('Artifact loading was canceled')
    expect(existsSync(path)).toBe(false)
  })

  it('times out an uncached artifact read after 30 seconds', async () => {
    vi.useFakeTimers()
    try {
      const directory = mkdtempSync(join(tmpdir(), 'agentsdock-artifact-timeout-'))
      const path = join(directory, 'uncached.txt')
      cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
      const fileRequest = vi.fn((_sessionId: string, _fileId: string, _request: Request | undefined, signal: AbortSignal) => (
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      ))
      const service = Object.create(AppService.prototype) as AppService
      const scope = { profileId: 'profile', generation: 1, namespace: 'profile:profile', client: { fileRequest } }
      Object.assign(service, {
        activeProfileId: scope.profileId,
        profileGeneration: scope.generation,
        validatedGeneration: scope.generation,
        scope,
        localFilePath: vi.fn(() => path)
      })
      const read = service.readTextFile('chat', { id: 'timeout', filename: 'source.ts' })
      const timedOut = expect(read).rejects.toThrow('Artifact loading timed out after 30 seconds')
      await Promise.resolve()
      await Promise.resolve()
      expect(fileRequest).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(30_000)

      await timedOut
      expect(existsSync(path)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('timeline-driven jobs refresh', () => {
  it('refreshes jobs after live schedule events and completed turns, but not raw provider events', async () => {
    let onEvent: (event: Event) => void = () => { throw new Error('Timeline stream did not start.') }
    let jobsRequest = 0
    const createdJob: Job = {
      id: 'job-1',
      session_id: 'chat',
      title: 'Daily status',
      prompt: 'Report status',
      interval_seconds: 86_400,
      enabled: true
    }
    const updatedJob = { ...createdJob, title: 'Weekday status' }
    const client = fakeClient({
      jobs: async () => ++jobsRequest === 1 ? [createdJob] : [updatedJob],
      stream: (_sessionId, _after, receiveEvent) => {
        onEvent = receiveEvent
        return vi.fn()
      }
    })
    const { service } = createProfileService({
      'http://a.test:7850': [client]
    })
    const window = {
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      webContents: { send: vi.fn() }
    }
    service.addWindow(window as never)
    const internals = service as unknown as {
      scope: { profileId: string; generation: number; namespace: string; client: AgentServerClient }
      validatedGeneration: number | null
      timelineSubscriptions: Map<string, { lease: number; stop: (() => void) | null; connected: boolean }>
      activateTimelineStream(scope: { profileId: string; generation: number; namespace: string; client: AgentServerClient }, sessionId: string, after: number, lease: number): void
    }
    internals.validatedGeneration = internals.scope.generation
    internals.timelineSubscriptions.set('chat', { lease: 1, stop: null, connected: false })
    internals.activateTimelineStream(internals.scope, 'chat', 0, 1)

    const event = (seq: number, type: string): Event => ({
      id: `event-${seq}`,
      seq,
      session_id: 'chat',
      type,
      ts: `2026-07-21T12:00:0${seq}Z`
    })

    onEvent?.(event(1, 'raw_event'))
    await settleBackgroundWork()
    expect(client.jobs).not.toHaveBeenCalled()

    onEvent?.(event(2, 'job_created'))
    await settleBackgroundWork()
    expect(client.jobs).toHaveBeenCalledOnce()
    expect(window.webContents.send).toHaveBeenCalledWith('server:jobs', expect.objectContaining({ jobs: [createdJob] }))

    onEvent?.(event(3, 'job_updated'))
    await settleBackgroundWork()
    expect(client.jobs).toHaveBeenCalledTimes(2)
    expect(window.webContents.send).toHaveBeenCalledWith('server:jobs', expect.objectContaining({ jobs: [updatedJob] }))

    onEvent?.(event(4, 'job_deleted'))
    await settleBackgroundWork()
    expect(client.jobs).toHaveBeenCalledTimes(3)

    onEvent?.(event(5, 'turn_finished'))
    await settleBackgroundWork()
    expect(client.jobs).toHaveBeenCalledTimes(4)

    // Replayed provider control bookkeeping is not a newly completed job.
    onEvent?.({ ...event(6, 'turn_finished'), backend: 'claude', imported: true,
      metadata_only: true, run_id: 'import_metadata' })
    await settleBackgroundWork()
    expect(client.jobs).toHaveBeenCalledTimes(4)

    // Ordinary imported completions retain the established refresh behavior.
    onEvent?.({ ...event(7, 'turn_finished'), backend: 'claude', imported: true,
      run_id: 'import_conversation' })
    await settleBackgroundWork()
    expect(client.jobs).toHaveBeenCalledTimes(5)
  })
})

describe('streamed event cache batching', () => {
  it('waits for the event cache batching window before persisting', async () => {
    vi.useFakeTimers()
    try {
      const { service, cache } = createProfileService({
        'http://a.test:7850': [fakeClient()]
      })
      const putEvents = vi.spyOn(cache, 'putEvents')
      const queuedTurns = vi.spyOn(cache, 'queuedTurns')
      const internals = service as unknown as {
        scope: { profileId: string; generation: number; namespace: string; client: AgentServerClient }
        enqueueEventCache(
          scope: { profileId: string; generation: number; namespace: string; client: AgentServerClient },
          event: Event
        ): void
      }
      internals.enqueueEventCache(internals.scope, {
        id: 'event-1',
        seq: 1,
        session_id: 'chat',
        type: 'assistant_text',
        ts: '2026-07-24T12:00:00Z',
        text: 'Hello'
      })

      await vi.advanceTimersByTimeAsync(49)
      expect(putEvents).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(putEvents).toHaveBeenCalledOnce()
      expect(queuedTurns).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reduces queue and file side effects once for an entire streamed batch', () => {
    const { service, cache } = createProfileService({
      'http://a.test:7850': [fakeClient()]
    })
    const queuedTurns = vi.spyOn(cache, 'queuedTurns')
    const putQueuedTurns = vi.spyOn(cache, 'putQueuedTurns')
    const putFiles = vi.spyOn(cache, 'putFiles')
    const internals = service as unknown as {
      scope: { profileId: string; generation: number; namespace: string; client: AgentServerClient }
      applyEventsToCaches(
        scope: { profileId: string; generation: number; namespace: string; client: AgentServerClient },
        sessionId: string,
        events: readonly Event[]
      ): void
    }

    internals.applyEventsToCaches(internals.scope, 'chat', [
      {
        id: 'queued-1', seq: 1, session_id: 'chat', type: 'turn_queued',
        ts: '2026-07-24T12:00:00Z', queued_id: 'one', prompt: 'One', position: 2
      },
      {
        id: 'queued-2', seq: 2, session_id: 'chat', type: 'turn_queued',
        ts: '2026-07-24T12:00:01Z', queued_id: 'two', prompt: 'Two', position: 1
      },
      {
        id: 'file-1', seq: 3, session_id: 'chat', type: 'artifact_created',
        ts: '2026-07-24T12:00:02Z',
        file: { id: 'file', filename: 'result.txt' },
        artifact: { id: 'artifact', filename: 'report.md' }
      }
    ])

    expect(queuedTurns).toHaveBeenCalledOnce()
    expect(putQueuedTurns).toHaveBeenCalledOnce()
    expect(putQueuedTurns).toHaveBeenCalledWith('profile:a', 'chat', [
      expect.objectContaining({ queued_id: 'two', position: 1 }),
      expect.objectContaining({ queued_id: 'one', position: 2 })
    ])
    expect(putFiles).toHaveBeenCalledOnce()
    expect(putFiles).toHaveBeenCalledWith('profile:a', 'chat', [
      expect.objectContaining({ id: 'file' }),
      expect.objectContaining({ id: 'artifact' })
    ])
  })

  it('persists a pause-only streamed queue update', () => {
    const { service, cache } = createProfileService({
      'http://a.test:7850': [fakeClient()]
    })
    cache.putQueuedTurns('profile:a', 'chat', [
      {
        queued_id: 'one', session_id: 'chat', prompt: 'One', file_ids: [], position: 1,
        paused: false, pause_reason: null
      },
      {
        queued_id: 'two', session_id: 'chat', prompt: 'Two', file_ids: [], position: 2,
        paused: false, pause_reason: null
      }
    ])
    const internals = service as unknown as {
      scope: { profileId: string; generation: number; namespace: string; client: AgentServerClient }
      applyEventsToCaches(
        scope: { profileId: string; generation: number; namespace: string; client: AgentServerClient },
        sessionId: string,
        events: readonly Event[]
      ): void
    }

    internals.applyEventsToCaches(internals.scope, 'chat', [{
      id: 'paused-1', seq: 3, session_id: 'chat', type: 'turn_queue_paused',
      ts: '2026-08-16T12:00:00Z', queued_ids: ['one']
    }])

    expect(cache.queuedTurns('profile:a', 'chat')).toEqual([
      expect.objectContaining({ queued_id: 'one', paused: true, pause_reason: 'stopped' }),
      expect.objectContaining({ queued_id: 'two', paused: false, pause_reason: null })
    ])
  })

  it('reconstructs a delivery-fenced row after its streamed tombstone', () => {
    const { service, cache } = createProfileService({
      'http://a.test:7850': [fakeClient()]
    })
    cache.putQueuedTurns('profile:a', 'chat', [
      { queued_id: 'one', session_id: 'chat', prompt: 'One', file_ids: [], position: 1 },
      { queued_id: 'two', session_id: 'chat', prompt: 'Two', file_ids: [], position: 2 }
    ])
    const internals = service as unknown as {
      scope: { profileId: string; generation: number; namespace: string; client: AgentServerClient }
      applyEventsToCaches(
        scope: { profileId: string; generation: number; namespace: string; client: AgentServerClient },
        sessionId: string,
        events: readonly Event[]
      ): void
    }

    internals.applyEventsToCaches(internals.scope, 'chat', [
      {
        id: 'unqueued-1', seq: 3, session_id: 'chat', type: 'turn_unqueued',
        ts: '2026-08-16T12:00:00Z', queued_id: 'one'
      },
      {
        id: 'fenced-1', seq: 4, session_id: 'chat', type: 'turn_queue_delivery_fenced',
        ts: '2026-08-16T12:00:01Z', queued_id: 'one', prompt: 'One', file_ids: ['proof.png'],
        position: 1
      }
    ])

    expect(cache.queuedTurns('profile:a', 'chat')).toEqual([
      expect.objectContaining({
        queued_id: 'one', file_ids: ['proof.png'], paused: true, pause_reason: 'delivery_uncertain'
      }),
      expect.objectContaining({ queued_id: 'two', position: 2 })
    ])
  })
})

describe('remote identity preflight', () => {
  it('never sends a mutation when health reports a changed server identity', async () => {
    const { settings } = profileSettings()
    settings.setProfileServerIdentity('a', 'expected-a')
    const cache = new LocalCache(':memory:')
    const client = fakeClient({
      health: async () => ({ ok: true, server_identity: 'unexpected-a' })
    })
    const service = new AppService({
      settings,
      cache,
      clientFactory: () => client as unknown as AgentServerClient
    })
    cleanup.push(() => { service.stop(); cache.close() })

    await expect(service.createSession({
      title: 'Must not be created',
      folder: 'General',
      cwd: '/tmp',
      backend: 'codex'
    })).rejects.toThrow('Server identity changed')

    expect(client.health).toHaveBeenCalledOnce()
    expect(client.createSession).not.toHaveBeenCalled()
  })

  it('rejects a direct remote result that returns after its captured scope is stale', async () => {
    const lateResult = deferred<JobRunNowResult>()
    const a = fakeClient({ runJob: () => lateResult.promise })
    const b = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })

    const pending = service.runJob('job-a')
    await settleBackgroundWork()
    expect(a.runJob).toHaveBeenCalledWith('job-a')

    await service.switchServer('b')
    lateResult.resolve({
      ok: true,
      job_id: 'job-a',
      run_id: 'run-a',
      queued: false,
      deferred: false,
      manual_run_pending: false
    })

    await expect(pending).rejects.toThrow('superseded')
  })

  it('preserves the server Run Now admission result through the service boundary', async () => {
    const result: JobRunNowResult = {
      ok: true,
      job_id: 'job-a',
      run_id: null,
      queued: true,
      deferred: true,
      manual_run_pending: true,
      message: 'Queued until the chat is available.'
    }
    const client = fakeClient({ runJob: async () => result })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })

    await expect(service.runJob('job-a')).resolves.toEqual(result)
  })

  it('keeps Codex control results bound to the profile generation that issued them', async () => {
    const lateRuntime = deferred<CodexRuntimeSnapshot>()
    const a = fakeClient({ codexRuntime: () => lateRuntime.promise })
    const b = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })

    const pending = service.codexRuntime('chat-a')
    await settleBackgroundWork()
    expect(a.codexRuntime).toHaveBeenCalledWith('chat-a')

    await service.switchServer('b')
    lateRuntime.resolve({
      available: true,
      transport: 'app_server',
      interactive_capability: 'codex_interactive_v1',
      thread_loaded: true,
      status: { type: 'idle' },
      goal: null,
      time_budget_seconds: null,
      pending_interactions: [],
      permission_profiles: [],
      background_terminals_supported: true
    })

    await expect(pending).rejects.toThrow('superseded')
  })

  it('keeps Claude SDK control results bound to the profile generation that issued them', async () => {
    const lateRuntime = deferred<ClaudeRuntimeSnapshot>()
    const a = fakeClient({ claudeRuntime: () => lateRuntime.promise })
    const b = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })

    const pending = service.claudeRuntime('chat-a')
    await settleBackgroundWork()
    expect(a.claudeRuntime).toHaveBeenCalledWith('chat-a')

    await service.switchServer('b')
    lateRuntime.resolve({
      available: true,
      transport: 'sdk',
      interactive_capability: 'claude_sdk_interactive_v1',
      session_loaded: true,
      status: { type: 'idle' },
      pending_interactions: []
    })

    await expect(pending).rejects.toThrow('superseded')
  })

  it('keeps Claude context refresh results bound to the profile generation that issued them', async () => {
    const lateRefresh = deferred<ClaudeRuntimeSnapshot>()
    const a = fakeClient({ refreshClaudeContextUsage: () => lateRefresh.promise })
    const b = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })

    const pending = service.refreshClaudeContextUsage('chat-a')
    await settleBackgroundWork()
    expect(a.refreshClaudeContextUsage).toHaveBeenCalledWith('chat-a')

    await service.switchServer('b')
    lateRefresh.resolve({
      available: true,
      transport: 'sdk',
      interactive_capability: 'claude_sdk_interactive_v1',
      session_loaded: true,
      status: { type: 'idle' },
      pending_interactions: [],
      context_usage_refreshed: true
    })

    await expect(pending).rejects.toThrow('superseded')
  })

  it('falls back to the observational Codex runtime when an older server cannot load threads on demand', async () => {
    const observed: CodexRuntimeSnapshot = {
      available: true,
      transport: 'app_server',
      interactive_capability: 'codex_interactive_v1',
      thread_loaded: false,
      status: { type: 'notLoaded' },
      goal: null,
      time_budget_seconds: null,
      pending_interactions: [],
      permission_profiles: [],
      background_terminals_supported: true
    }
    const client = fakeClient({
      loadCodexThread: async () => { throw new ServerError(404, 'not found') },
      codexRuntime: async () => observed
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })

    await expect(service.loadCodexThread('chat-a')).resolves.toEqual(observed)
    expect(client.loadCodexThread).toHaveBeenCalledWith('chat-a')
    expect(client.codexRuntime).toHaveBeenCalledWith('chat-a')
  })

  it('surfaces real failures while loading a persisted Codex thread', async () => {
    const client = fakeClient({
      loadCodexThread: async () => { throw new ServerError(500, 'resume failed') }
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })

    await expect(service.loadCodexThread('chat-a')).rejects.toThrow('resume failed')
    expect(client.codexRuntime).not.toHaveBeenCalled()
  })

  it('coalesces concurrent loads of the same persisted Codex thread', async () => {
    const result: CodexRuntimeSnapshot = {
      available: true,
      transport: 'app_server',
      interactive_capability: 'codex_interactive_v1',
      persisted_thread: true,
      thread_loaded: true,
      status: { type: 'idle' },
      goal: null,
      time_budget_seconds: null,
      pending_interactions: [],
      permission_profiles: [],
      background_terminals_supported: true
    }
    const pending = deferred<CodexRuntimeSnapshot>()
    const client = fakeClient({ loadCodexThread: () => pending.promise })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })

    const first = service.loadCodexThread('chat-a')
    const second = service.loadCodexThread('chat-a')
    await settleBackgroundWork()
    expect(client.loadCodexThread).toHaveBeenCalledTimes(1)

    pending.resolve(result)
    await expect(Promise.all([first, second])).resolves.toEqual([result, result])
  })
})

describe('local session import', () => {
  const importHealth: Health = {
    ok: true,
    api_contract_version: 15,
    capabilities: {
      local_session_import_v1: {
        available: true,
        required: false,
        message: '',
        action: null,
        version: 1,
        max_batch_items: 25,
        max_list_items: 500
      }
    }
  }

  it('returns local session candidates from the client without touching the session cache', async () => {
    const candidates: LocalSessionCandidate[] = [
      { provider_session_id: 'claude-abc', backend: 'claude', label: 'widget: Fix the flaky test', updated_at: '2026-08-01T00:00:00Z', cwd: '/work/widget' }
    ]
    const client = fakeClient({ health: async () => importHealth, listLocalSessions: async () => candidates })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })

    await expect(service.listLocalSessions()).resolves.toEqual(candidates)
    expect(client.listLocalSessions).toHaveBeenCalledWith(500)
  })

  it('refreshes the session list after a bulk import with at least one success', async () => {
    const results: BulkImportSessionResult[] = [
      { provider_session_id: 'claude-abc', backend: 'claude', session_id: 'sess_new', ok: true, imported: 3 },
      { provider_session_id: 'codex-def', backend: 'codex', session_id: null, ok: false, imported: 0, error: 'boom' }
    ]
    const client = fakeClient({
      health: async () => importHealth,
      bulkImportSessions: async () => results,
      sessions: async () => [{ id: 'sess_new', title: 'Imported', folder: 'General', cwd: '/work', backend: 'claude' }]
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })

    const items: BulkImportSessionItem[] = [
      { provider_session_id: 'claude-abc', backend: 'claude', cwd: '/work/widget' },
      { provider_session_id: 'codex-def', backend: 'codex' }
    ]
    await expect(service.bulkImportSessions(items)).resolves.toEqual(results)
    expect(client.bulkImportSessions).toHaveBeenCalledWith(items)
    expect(client.sessions).toHaveBeenCalled()
  })

  it('returns acknowledged per-item successes when the secondary session refresh fails', async () => {
    const results: BulkImportSessionResult[] = [
      { provider_session_id: 'claude-abc', backend: 'claude', session_id: 'sess_new', ok: true, imported: 3 }
    ]
    const client = fakeClient({
      health: async () => importHealth,
      bulkImportSessions: async () => results
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    await service.listLocalSessions()
    client.sessions.mockClear()
    client.sessions.mockRejectedValueOnce(new Error('refresh unavailable'))

    await expect(service.bulkImportSessions([
      { provider_session_id: 'claude-abc', backend: 'claude' }
    ])).resolves.toEqual(results)
    expect(client.sessions).toHaveBeenCalledOnce()
  })

  it('does not refresh the session list when every item in the batch fails', async () => {
    const results: BulkImportSessionResult[] = [
      { provider_session_id: 'claude-abc', backend: 'claude', session_id: null, ok: false, imported: 0, error: 'boom' }
    ]
    const client = fakeClient({ health: async () => importHealth, bulkImportSessions: async () => results })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    // Prime scope validation (which independently calls client.sessions()) before
    // measuring, so only calls caused by bulkImportSessions itself are counted.
    await service.listLocalSessions()
    client.sessions.mockClear()

    await expect(service.bulkImportSessions([
      { provider_session_id: 'claude-abc', backend: 'claude' }
    ])).resolves.toEqual(results)
    expect(client.sessions).not.toHaveBeenCalled()
  })

  it('chunks a large selection to the advertised server batch maximum', async () => {
    const client = fakeClient({
      health: async () => importHealth,
      bulkImportSessions: async items => items.map(item => ({
        provider_session_id: item.provider_session_id,
        backend: item.backend,
        session_id: `imported-${item.provider_session_id}`,
        ok: true,
        imported: 1
      }))
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    const items: BulkImportSessionItem[] = Array.from({ length: 26 }, (_, index) => ({
      provider_session_id: `provider-${index}`,
      backend: index % 2 ? 'codex' : 'claude'
    }))

    await expect(service.bulkImportSessions(items)).resolves.toHaveLength(26)
    expect(client.bulkImportSessions).toHaveBeenCalledTimes(2)
    expect(client.bulkImportSessions.mock.calls[0][0]).toHaveLength(25)
    expect(client.bulkImportSessions.mock.calls[1][0]).toHaveLength(1)
  })

  it('stops after an unconfirmed batch while preserving successes and marking unattempted items', async () => {
    let calls = 0
    const client = fakeClient({
      health: async () => importHealth,
      bulkImportSessions: async items => {
        calls += 1
        if (calls === 2) throw new Error('connection closed')
        return items.map(item => ({
          provider_session_id: item.provider_session_id,
          backend: item.backend,
          session_id: `imported-${item.provider_session_id}`,
          ok: true,
          imported: 1
        }))
      }
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    const items: BulkImportSessionItem[] = Array.from({ length: 51 }, (_, index) => ({
      provider_session_id: `provider-${index}`,
      backend: 'claude'
    }))

    const results = await service.bulkImportSessions(items)

    expect(results.filter(result => result.ok)).toHaveLength(25)
    expect(client.bulkImportSessions).toHaveBeenCalledTimes(2)
    expect(results.slice(25, 50).every(result => result.code === 'client_status_unknown')).toBe(true)
    expect(results[25].error).toMatch(/re-scan local chats before retrying/i)
    expect(results[50]).toMatchObject({
      provider_session_id: 'provider-50',
      backend: 'claude',
      ok: false,
      imported: 0,
      code: 'client_not_attempted'
    })
    expect(results[50].error).toMatch(/not attempted.*re-scan local chats.*retry/i)
  })

  it('continues to later batches after explicit per-item server failures', async () => {
    let calls = 0
    const client = fakeClient({
      health: async () => importHealth,
      bulkImportSessions: async items => {
        calls += 1
        return items.map(item => calls === 1 ? {
          provider_session_id: item.provider_session_id,
          backend: item.backend,
          session_id: null,
          ok: false,
          imported: 0,
          code: 'empty_transcript',
          error: 'No importable messages were found.'
        } : {
          provider_session_id: item.provider_session_id,
          backend: item.backend,
          session_id: `imported-${item.provider_session_id}`,
          ok: true,
          imported: 1
        })
      }
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    const items: BulkImportSessionItem[] = Array.from({ length: 26 }, (_, index) => ({
      provider_session_id: `provider-${index}`,
      backend: 'codex'
    }))

    const results = await service.bulkImportSessions(items)

    expect(client.bulkImportSessions).toHaveBeenCalledTimes(2)
    expect(results.slice(0, 25).every(result => result.code === 'empty_transcript')).toBe(true)
    expect(results[25]).toMatchObject({ provider_session_id: 'provider-25', ok: true, imported: 1 })
  })

  it('rejects local import routes when API 15 does not advertise the capability', async () => {
    const client = fakeClient({ health: async () => ({ ok: true, api_contract_version: 15 }) })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })

    await expect(service.listLocalSessions()).rejects.toThrow(/requires AgentsServer API 15/i)
    expect(client.listLocalSessions).not.toHaveBeenCalled()
  })
})

describe('workspace file scope safety', () => {
  it('checks workspace preview availability through a scoped main-process HEAD request', async () => {
    const cancelled = vi.fn()
    const preview = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1])) },
        cancel: cancelled
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([2])) },
        cancel: cancelled
      }), { status: 404 }))
    const a = fakeClient({
      health: async () => ({ ok: true, server_identity: 'server-a' }),
      workspacePreviewRequest: preview
    })
    const { service, settings } = createProfileService({ 'http://a.test:7850': [a] })
    settings.setProfileServerIdentity('a', 'server-a')
    const scope = { profileId: 'a', profileGeneration: 1, serverIdentity: 'server-a' }

    await expect(service.workspacePreviewAvailable(scope, 'chat', 'assets/live.png')).resolves.toBe(true)
    await expect(service.workspacePreviewAvailable(scope, 'chat', 'assets/missing.png')).resolves.toBe(false)
    expect(cancelled).toHaveBeenCalledTimes(2)
    expect(preview).toHaveBeenCalledTimes(2)
    for (const [sessionId, path, request, callerSignal] of preview.mock.calls) {
      expect(sessionId).toBe('chat')
      expect(path).toMatch(/^assets\/(?:live|missing)\.png$/)
      expect(request).toBeInstanceOf(Request)
      expect((request as Request).method).toBe('HEAD')
      expect((request as Request).url).toMatch(/^agentsdock-media:\/\/workspace\/a\/1\/chat\/assets%2F(?:live|missing)\.png$/)
      expect([...((request as Request).headers)]).toEqual([])
      expect(callerSignal).toBeInstanceOf(AbortSignal)
      expect((callerSignal as AbortSignal).aborted).toBe(false)
    }

    await expect(service.workspacePreviewAvailable(
      { ...scope, serverIdentity: 'server-other' },
      'chat',
      'assets/live.png'
    )).rejects.toThrow('superseded')
    expect(preview).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['', 'assets/live.png'],
    ['..', 'assets/live.png'],
    ['x'.repeat(2_049), 'assets/live.png'],
    ['chat', ''],
    ['chat', '/private/file.png'],
    ['chat', '../file.png'],
    ['chat', 'assets/../file.png'],
    ['chat', 'assets\\file.png'],
    ['chat', 'assets/\u0000file.png'],
    ['chat', 'assets//file.png'],
    ['chat', 'x'.repeat(4_097)]
  ])('rejects an invalid workspace preview identity before any server request (%j, %j)', async (
    sessionId,
    path
  ) => {
    const preview = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const a = fakeClient({
      health: async () => ({ ok: true, server_identity: 'server-a' }),
      workspacePreviewRequest: preview
    })
    const { service, settings } = createProfileService({ 'http://a.test:7850': [a] })
    settings.setProfileServerIdentity('a', 'server-a')

    await expect(service.workspacePreviewAvailable(
      { profileId: 'a', profileGeneration: 1, serverIdentity: 'server-a' },
      sessionId,
      path
    )).rejects.toThrow('Invalid workspace media resource identity')

    expect(a.health).not.toHaveBeenCalled()
    expect(preview).not.toHaveBeenCalled()
  })

  it('bounds a workspace preview probe with a main-owned abort signal', async () => {
    const timeoutController = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
    const preview = vi.fn((
      _sessionId: string,
      _path: string,
      _request?: Request,
      callerSignal?: AbortSignal
    ) => new Promise<Response>((_resolve, reject) => {
      callerSignal?.addEventListener('abort', () => reject(callerSignal.reason), { once: true })
    }))
    const a = fakeClient({
      health: async () => ({ ok: true, server_identity: 'server-a' }),
      workspacePreviewRequest: preview
    })
    const { service, settings } = createProfileService({ 'http://a.test:7850': [a] })
    settings.setProfileServerIdentity('a', 'server-a')

    try {
      const pending = service.workspacePreviewAvailable(
        { profileId: 'a', profileGeneration: 1, serverIdentity: 'server-a' },
        'chat',
        'assets/live.png'
      )
      await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce())
      expect(timeoutSpy).toHaveBeenCalledWith(30_000)

      timeoutController.abort(new DOMException('Probe timed out', 'TimeoutError'))
      await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('rejects a workspace preview availability result after the active profile changes', async () => {
    const late = deferred<Response>()
    const a = fakeClient({
      health: async () => ({ ok: true, server_identity: 'server-a' }),
      workspacePreviewRequest: () => late.promise
    })
    const b = fakeClient({ health: async () => ({ ok: true, server_identity: 'server-b' }) })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })
    settings.setProfileServerIdentity('a', 'server-a')
    settings.setProfileServerIdentity('b', 'server-b')
    const scope = { profileId: 'a', profileGeneration: 1, serverIdentity: 'server-a' }

    const pending = service.workspacePreviewAvailable(scope, 'chat', 'assets/live.png')
    await vi.waitFor(() => expect(a.workspacePreviewRequest).toHaveBeenCalledOnce())
    await service.switchServer('b')
    late.resolve(new Response(null, { status: 200 }))

    await expect(pending).rejects.toThrow('superseded')
    expect(b.workspacePreviewRequest).not.toHaveBeenCalled()
  })

  it('rejects a workspace preview result when the profile changes during body disposal', async () => {
    const cancelStarted = deferred<void>()
    const finishCancel = deferred<void>()
    const a = fakeClient({
      health: async () => ({ ok: true, server_identity: 'server-a' }),
      workspacePreviewRequest: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1])) },
        cancel() {
          cancelStarted.resolve()
          return finishCancel.promise
        }
      }), { status: 200 })
    })
    const b = fakeClient({ health: async () => ({ ok: true, server_identity: 'server-b' }) })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })
    settings.setProfileServerIdentity('a', 'server-a')
    settings.setProfileServerIdentity('b', 'server-b')

    const pending = service.workspacePreviewAvailable(
      { profileId: 'a', profileGeneration: 1, serverIdentity: 'server-a' },
      'chat',
      'assets/live.png'
    )
    await cancelStarted.promise
    await service.switchServer('b')
    finishCancel.resolve()

    await expect(pending).rejects.toThrow('superseded')
    expect(b.workspacePreviewRequest).not.toHaveBeenCalled()
  })

  it('downloads a complete binary workspace file through the native save dialog', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-workspace-download-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const destination = join(directory, 'weights.bin')
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x80])
    electronHarness.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    const a = fakeClient({
      workspaceDownloadRequest: async () => new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' }
      })
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    await expect(service.downloadWorkspaceFile('chat', 'models/weights.bin')).resolves.toBe(destination)
    expect(electronHarness.showSaveDialog).toHaveBeenCalledWith({ defaultPath: 'weights.bin' })
    expect(a.workspaceDownloadRequest).toHaveBeenCalledWith('chat', 'models/weights.bin')
    expect(a.workspacePreviewRequest).not.toHaveBeenCalled()
    expect(readFileSync(destination)).toEqual(Buffer.from(bytes))
  })

  it('falls back to the binary-safe preview route when an older server lacks workspace downloads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-workspace-download-fallback-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const destination = join(directory, 'plot.png')
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    electronHarness.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    const a = fakeClient({
      workspaceDownloadRequest: async () => new Response('Not found', { status: 404 }),
      workspacePreviewRequest: async () => new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'image/png' }
      })
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    await expect(service.downloadWorkspaceFile('chat', 'images/plot.png')).resolves.toBe(destination)
    expect(a.workspaceDownloadRequest).toHaveBeenCalledWith('chat', 'images/plot.png')
    expect(a.workspacePreviewRequest).toHaveBeenCalledWith('chat', 'images/plot.png')
    expect(readFileSync(destination)).toEqual(Buffer.from(bytes))
  })

  it('falls back to the text workspace route when an older server cannot preview the file type', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-workspace-download-text-fallback-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const destination = join(directory, 'README.md')
    const content = '# Café\n'
    electronHarness.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    const a = fakeClient({
      workspaceDownloadRequest: async () => new Response('Not found', { status: 404 }),
      workspacePreviewRequest: async () => new Response('Unsupported preview', { status: 415 }),
      workspaceFile: async (_sessionId, path) => workspaceFile(path, content)
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    await expect(service.downloadWorkspaceFile('chat', 'README.md')).resolves.toBe(destination)
    expect(a.workspaceDownloadRequest).toHaveBeenCalledWith('chat', 'README.md')
    expect(a.workspacePreviewRequest).toHaveBeenCalledWith('chat', 'README.md')
    expect(a.workspaceFile).toHaveBeenCalledWith('chat', 'README.md')
    expect(readFileSync(destination)).toEqual(Buffer.from(content, 'utf8'))
  }, 10_000)

  it('falls back to the text workspace route when an older server lacks both download and preview routes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-workspace-download-legacy-fallback-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const destination = join(directory, 'README.md')
    const content = '# Legacy server\n'
    electronHarness.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    const a = fakeClient({
      workspaceDownloadRequest: async () => new Response('Not found', { status: 404 }),
      workspacePreviewRequest: async () => new Response('Not found', { status: 404 }),
      workspaceFile: async (_sessionId, path) => workspaceFile(path, content)
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    await expect(service.downloadWorkspaceFile('chat', 'README.md')).resolves.toBe(destination)
    expect(a.workspaceFile).toHaveBeenCalledWith('chat', 'README.md')
    expect(readFileSync(destination)).toEqual(Buffer.from(content, 'utf8'))
  }, 10_000)

  it('does not request or create a workspace download when the save dialog is canceled', async () => {
    electronHarness.showSaveDialog.mockResolvedValue({ canceled: true })
    const a = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    await expect(service.downloadWorkspaceFile('chat', 'README.md')).resolves.toBeNull()
    expect(a.workspaceDownloadRequest).not.toHaveBeenCalled()
    expect(a.workspacePreviewRequest).not.toHaveBeenCalled()
  })

  it('rejects a workspace download destination chosen after switching profiles', async () => {
    const chosen = deferred<{ canceled: boolean; filePath: string }>()
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-workspace-download-race-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const destination = join(directory, 'README.md')
    electronHarness.showSaveDialog.mockReturnValue(chosen.promise)
    const a = fakeClient()
    const b = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })

    const pending = service.downloadWorkspaceFile('chat', 'README.md')
    await service.switchServer('b')
    chosen.resolve({ canceled: false, filePath: destination })

    await expect(pending).rejects.toThrow('superseded')
    expect(a.workspaceDownloadRequest).not.toHaveBeenCalled()
    expect(b.workspaceDownloadRequest).not.toHaveBeenCalled()
    expect(existsSync(destination)).toBe(false)
  })

  it('reports a workspace download HTTP error without leaving a destination or partial file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-workspace-download-error-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const destination = join(directory, 'missing.txt')
    electronHarness.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    const a = fakeClient({
      workspaceDownloadRequest: async () => new Response('Access denied', {
        status: 403,
        statusText: 'Forbidden'
      })
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    await expect(service.downloadWorkspaceFile('chat', 'private/missing.txt'))
      .rejects.toThrow('Workspace download failed (403 Forbidden): Access denied')
    expect(existsSync(destination)).toBe(false)
    expect(readdirSync(directory)).toEqual([])
  })

  it('removes a partial workspace download when the response stream fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-workspace-download-stream-error-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const destination = join(directory, 'partial.bin')
    electronHarness.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x01, 0x02]))
        controller.error(new Error('stream interrupted'))
      }
    }))
    const a = fakeClient({ workspaceDownloadRequest: async () => response })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    await expect(service.downloadWorkspaceFile('chat', 'partial.bin')).rejects.toThrow('stream interrupted')
    expect(existsSync(destination)).toBe(false)
    expect(readdirSync(directory)).toEqual([])
  })

  it('delegates revision-checked writes through the captured profile client', async () => {
    const a = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    await expect(service.writeWorkspaceFile('chat', 'src/App.tsx', 'updated', 'a'.repeat(64)))
      .resolves.toMatchObject({ path: 'src/App.tsx', content: 'updated', revision: 'b'.repeat(64) })
    expect(a.writeWorkspaceFile).toHaveBeenCalledWith('chat', 'src/App.tsx', 'updated', 'a'.repeat(64))
  })

  it('keeps explicit absolute reads read-only through the captured profile client', async () => {
    const path = '/home/dev/.codex/AGENTS.md'
    const a = fakeClient({
      absoluteFile: async (_sessionId, requestedPath) => ({
        ...workspaceFile(requestedPath, 'instructions\n'),
        root: '/',
        writable: true
      })
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    await expect(service.absoluteFile('chat', path)).resolves.toMatchObject({
      path,
      content: 'instructions\n',
      writable: false,
      scope: 'absolute'
    })
    await expect(service.writeAbsoluteFile('chat', path, 'blocked\n', 'a'.repeat(64)))
      .rejects.toThrow('Update AgentsServer')
    expect(a.absoluteFile).toHaveBeenCalledWith('chat', path)
    expect(a.writeAbsoluteFile).not.toHaveBeenCalled()
    expect(a.writeWorkspaceFile).not.toHaveBeenCalled()
    expect(a.removeWorkspaceEntry).not.toHaveBeenCalled()
  })

  it('enables revision-checked absolute edits only with workspace capability v6', async () => {
    const path = '/home/dev/.codex/AGENTS.md'
    const a = fakeClient({
      health: async () => ({
        ok: true,
        capabilities: {
          workspace_files: {
            available: true,
            required: false,
            message: 'Workspace file editing is available.',
            action: null,
            version: 6
          }
        }
      }),
      absoluteFile: async (_sessionId, requestedPath) => ({
        ...workspaceFile(requestedPath, 'instructions\n', 'a'.repeat(64)),
        root: '/',
        writable: true,
        scope: 'absolute'
      }),
      writeAbsoluteFile: async (_sessionId, requestedPath, content) => ({
        ...workspaceFile(requestedPath, content, 'b'.repeat(64)),
        root: '/',
        writable: true,
        scope: 'absolute'
      })
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    await expect(service.absoluteFile('chat', path)).resolves.toMatchObject({
      path,
      writable: true,
      scope: 'absolute'
    })
    await expect(service.writeAbsoluteFile('chat', path, 'updated\n', 'a'.repeat(64)))
      .resolves.toMatchObject({ path, content: 'updated\n', writable: true, scope: 'absolute' })
    expect(a.writeAbsoluteFile).toHaveBeenCalledWith('chat', path, 'updated\n', 'a'.repeat(64))

    await expect(service.overwriteAbsoluteFile('chat', path, 'replace\n'))
      .resolves.toMatchObject({ path, content: 'replace\n', scope: 'absolute' })
    expect(a.absoluteFile).toHaveBeenLastCalledWith('chat', path)
    expect(a.writeAbsoluteFile).toHaveBeenLastCalledWith('chat', path, 'replace\n', 'a'.repeat(64))
  })

  it('atomically overwrites a workspace file through one captured profile client', async () => {
    const a = fakeClient({
      workspaceFile: async (_sessionId, path) => workspaceFile(path, 'disk', 'latest-revision'),
      writeWorkspaceFile: async (_sessionId, path, content) => workspaceFile(path, content, 'saved-revision')
    })
    const b = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })

    await expect(service.overwriteWorkspaceFile('chat', 'README.md', 'local draft'))
      .resolves.toMatchObject({ path: 'README.md', content: 'local draft', revision: 'saved-revision' })
    expect(a.workspaceFile).toHaveBeenCalledWith('chat', 'README.md')
    expect(a.writeWorkspaceFile).toHaveBeenCalledWith('chat', 'README.md', 'local draft', 'latest-revision')
    expect(b.workspaceFile).not.toHaveBeenCalled()
    expect(b.writeWorkspaceFile).not.toHaveBeenCalled()
  })

  it('never writes a conflicted overwrite after its captured profile is switched', async () => {
    const lateFile = deferred<WorkspaceFile>()
    const a = fakeClient({ workspaceFile: () => lateFile.promise })
    const b = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })

    const pending = service.overwriteWorkspaceFile('chat', 'README.md', 'local draft')
    await settleBackgroundWork()
    await service.switchServer('b')
    lateFile.resolve(workspaceFile('README.md', 'disk', 'latest-revision'))

    await expect(pending).rejects.toThrow('superseded')
    expect(a.writeWorkspaceFile).not.toHaveBeenCalled()
    expect(b.writeWorkspaceFile).not.toHaveBeenCalled()
  })

  it('delegates revision-checked rename and remove operations through the captured profile client', async () => {
    const a = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    await expect(service.renameWorkspaceEntry('chat', 'src/App.tsx', 'Shell.tsx', 'a'.repeat(64)))
      .resolves.toMatchObject({
        previous_path: 'src/App.tsx',
        entry: { path: 'src/Shell.tsx', revision: 'b'.repeat(64) }
      })
    expect(a.renameWorkspaceEntry).toHaveBeenCalledWith(
      'chat',
      'src/App.tsx',
      'Shell.tsx',
      'a'.repeat(64)
    )

    await expect(service.removeWorkspaceEntry('chat', 'src', 'b'.repeat(64), true))
      .resolves.toEqual({ root: '/work', path: 'src', kind: 'directory', removed: true })
    expect(a.removeWorkspaceEntry).toHaveBeenCalledWith('chat', 'src', 'b'.repeat(64), true)
  })

  it('delegates workspace file and folder creation through the captured profile client', async () => {
    const a = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    await expect(service.createWorkspaceEntry('chat', 'src/NewFile.ts', 'file'))
      .resolves.toMatchObject({
        entry: { path: 'src/NewFile.ts', kind: 'file' },
        file: { path: 'src/NewFile.ts', content: '' }
      })
    expect(a.createWorkspaceEntry).toHaveBeenCalledWith('chat', 'src/NewFile.ts', 'file')
  })

  it('rejects a workspace read that resolves after its profile was switched', async () => {
    const lateFile = deferred<WorkspaceFile>()
    const a = fakeClient({ workspaceFile: () => lateFile.promise })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    const pending = service.workspaceFile('chat', 'README.md')
    await settleBackgroundWork()
    await service.switchServer('b')
    lateFile.resolve(workspaceFile('README.md'))

    await expect(pending).rejects.toThrow('superseded')
  })

  it('rejects a workspace mutation that resolves after its profile was switched', async () => {
    const lateRename = deferred<WorkspaceRenameResult>()
    const a = fakeClient({ renameWorkspaceEntry: () => lateRename.promise })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })

    const pending = service.renameWorkspaceEntry('chat', 'README.md', 'README-old.md', 'a'.repeat(64))
    await settleBackgroundWork()
    await service.switchServer('b')
    lateRename.resolve({
      root: '/work',
      previous_path: 'README.md',
      entry: {
        name: 'README-old.md',
        path: 'README-old.md',
        kind: 'file',
        revision: 'b'.repeat(64)
      }
    })

    await expect(pending).rejects.toThrow('superseded')
  })
})

describe('managed server updates', () => {
  it('opens independent profile-owned update connections and rejects changed profile authority', async () => {
    const active = fakeClient(), updateClient = fakeClient()
    const { service, settings } = createProfileService({ 'http://a.test:7850': [active, updateClient] })
    settings.setProfileServerIdentity('a', 'server-a')
    const profile = service.coordinatedUpdateProfiles().find(candidate => candidate.id === 'a')!
    expect(profile).toMatchObject({ serverIdentity: 'server-a', active: true })
    const connection = await service.coordinatedUpdateConnection(profile)
    expect(connection.client).toBe(updateClient)
    expect(connection.loopback).toBe(false)
    expect(() => connection.assertCurrent()).not.toThrow()
    settings.updateProfile('a', { serverUrl: 'http://different.test:7850' })
    expect(() => connection.assertCurrent()).toThrow()
    connection.client.dispose()
    expect(active.dispose).not.toHaveBeenCalled()
  })
  function prepare(
    client: ReturnType<typeof fakeClient>,
    capabilityVersion = 9,
    serverUrl = 'http://a.test:7850'
  ) {
    const result = createProfileService(
      { [serverUrl]: [client] },
      undefined,
      undefined,
      undefined,
      undefined,
      serverUrl
    )
    result.settings.setProfileServerIdentity('a', 'server-a')
    Object.assign(result.service, {
      health: managedUpdateHealth(capabilityVersion),
      validatedGeneration: 1
    })
    return result
  }

  const exactStatus = (phase: ServerUpdateStatus['phase'] = 'current'): ServerUpdateStatus => ({
    phase,
    current_version: '0.1.26-beta.28',
    server_identity: 'server-a',
    server_instance_id: 'boot-a'
  })

  it('binds every supported update operation to the validated server identity and boot', async () => {
    const client = fakeClient({
      serverUpdateStatus: async () => exactStatus(),
      checkServerUpdate: async () => exactStatus(),
      startServerUpdate: async () => exactStatus('pending'),
      cancelServerUpdate: async () => exactStatus('available')
    })
    const { service } = prepare(client)
    const target = {
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'boot-a'
    }

    await service.serverUpdateStatus()
    await service.checkServerUpdate('beta')
    await service.startServerUpdate('0.1.26-beta.28', 'beta', true)
    await service.cancelServerUpdate('44444444444444444444444444444444')

    expect(client.serverUpdateStatus).toHaveBeenCalledWith(target)
    expect(client.checkServerUpdate).toHaveBeenCalledWith('beta', target)
    expect(client.startServerUpdate).toHaveBeenCalledWith('0.1.26-beta.28', 'beta', true, target)
    expect(client.cancelServerUpdate).toHaveBeenCalledWith('44444444444444444444444444444444', target)
  })

  it('rejects an update response produced by a different server boot', async () => {
    const client = fakeClient({
      startServerUpdate: async () => ({
        ...exactStatus('pending'),
        server_instance_id: 'boot-other'
      })
    })
    const { service } = prepare(client)

    await expect(service.startServerUpdate(undefined, 'beta', true)).rejects.toThrow('different server instance')
  })

  it.each([
    [401, 'Administrator credentials were rejected.'],
    [403, 'This credential cannot install updates.'],
    [409, 'The managed update request was rejected.']
  ] as const)('preserves an authoritative update-start HTTP %s status in the IPC error message', async (status, message) => {
    const client = fakeClient({
      startServerUpdate: async () => { throw new ServerError(status, message) }
    })
    const { service } = prepare(client)

    await expect(service.startServerUpdate('0.1.26-beta.48', 'beta', true))
      .rejects.toThrow(`HTTP ${status}: ${message}`)
    expect(client.startServerUpdate).toHaveBeenCalledTimes(1)
    expect(client.startServerUpdate).toHaveBeenCalledWith('0.1.26-beta.48', 'beta', true, {
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'boot-a'
    })
  })

  it('preserves a timed-out update-start error unchanged without a misleading HTTP status', async () => {
    const timeout = new Error('Server update request timed out.')
    const client = fakeClient({ startServerUpdate: async () => { throw timeout } })
    const { service } = prepare(client)

    await expect(service.startServerUpdate('0.1.26-beta.48', 'beta', true)).rejects.toBe(timeout)
    expect(timeout.message).toBe('Server update request timed out.')
    expect(client.startServerUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not infer an authoritative update-start HTTP status from an unknown error object', async () => {
    const unknown = { status: 401, message: 'An unfamiliar error object.' }
    const client = fakeClient({ startServerUpdate: async () => { throw unknown } })
    const { service } = prepare(client)

    await expect(service.startServerUpdate('0.1.26-beta.48', 'beta', true)).rejects.toBe(unknown)
    expect(client.startServerUpdate).toHaveBeenCalledTimes(1)
  })

  it('allows legacy update mutations only for a channel-aware HTTP loopback server', async () => {
    const client = fakeClient({
      serverUpdateStatus: async () => ({ phase: 'current', current_version: '0.1.26-beta.26' }),
      startServerUpdate: async () => ({ phase: 'pending', current_version: '0.1.26-beta.26' }),
      cancelServerUpdate: async () => ({ phase: 'available', current_version: '0.1.26-beta.26' })
    })
    const { service } = prepare(client, 7, 'http://127.0.0.1:7850')

    await service.serverUpdateStatus()
    await service.startServerUpdate('0.1.26-beta.48', 'beta', true)
    await service.cancelServerUpdate('44444444444444444444444444444444')

    expect(client.serverUpdateStatus).toHaveBeenCalledWith(undefined)
    expect(client.startServerUpdate).toHaveBeenCalledWith('0.1.26-beta.48', 'beta', true, undefined)
    expect(client.cancelServerUpdate).toHaveBeenCalledWith('44444444444444444444444444444444', undefined)
  })

  it.each([
    ['a remote HTTP server', 'http://a.test:7850', 8],
    ['an HTTPS loopback URL', 'https://127.0.0.1:7850', 8],
    ['a pre-channel HTTP loopback server', 'http://127.0.0.1:7850', 1]
  ])('allows legacy status reads but refuses update mutations for %s', async (_label, serverUrl, capabilityVersion) => {
    const client = fakeClient({
      serverUpdateStatus: async () => ({ phase: 'current', current_version: '0.1.26-beta.26' })
    })
    const { service } = prepare(client, capabilityVersion, serverUrl)

    await service.serverUpdateStatus()
    await expect(service.startServerUpdate(undefined, 'beta', true)).rejects.toThrow('Update or reconnect AgentsServer')
    await expect(service.cancelServerUpdate('44444444444444444444444444444444')).rejects.toThrow('Update or reconnect AgentsServer')

    expect(client.serverUpdateStatus).toHaveBeenCalledWith(undefined)
    expect(client.startServerUpdate).not.toHaveBeenCalled()
    expect(client.cancelServerUpdate).not.toHaveBeenCalled()
  })

  it('refuses a legacy update when the saved profile is changed to loopback without reconnecting', async () => {
    const client = fakeClient()
    const { service, settings } = prepare(client, 7, 'http://a.test:7850')
    settings.updateProfile('a', { serverUrl: 'http://127.0.0.1:7850' })

    await expect(service.startServerUpdate(undefined, 'beta', true)).rejects.toThrow('Update or reconnect AgentsServer')

    expect(client.startServerUpdate).not.toHaveBeenCalled()
  })

  it('keeps v9 loopback mutations bound to the exact server identity and boot', async () => {
    const client = fakeClient({ startServerUpdate: async () => exactStatus('pending') })
    const { service } = prepare(client, 9, 'http://localhost:7850')

    await service.startServerUpdate('0.1.26-beta.48', 'beta', true)

    expect(client.startServerUpdate).toHaveBeenCalledWith('0.1.26-beta.48', 'beta', true, {
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'boot-a'
    })
  })
})

describe('managed server restart', () => {
  function prepare(
    oldClient: ReturnType<typeof fakeClient>,
    reconnectClient?: ReturnType<typeof fakeClient>,
    extraClients: Record<string, Array<ReturnType<typeof fakeClient>>> = {}
  ) {
    const clients: Record<string, Array<ReturnType<typeof fakeClient>>> = {
      'http://a.test:7850': reconnectClient ? [oldClient, reconnectClient] : [oldClient],
      ...extraClients
    }
    const result = createProfileService(clients)
    result.settings.setProfileServerIdentity('a', 'server-a')
    Object.assign(result.service, {
      health: managedRestartHealth('boot-old'),
      validatedGeneration: 1,
      serverRestartReconnectTimeoutMs: 30,
      serverRestartPollDelayMs: 1,
      serverRestartHealthTimeoutMs: 5
    })
    return {
      ...result,
      scope: { profileId: 'a', profileGeneration: 1, serverIdentity: 'server-a' }
    }
  }

  it('reads restart status through the identity- and generation-fenced active scope', async () => {
    const oldClient = fakeClient({
      serverRestartStatus: async () => ({
        phase: 'idle',
        current_version: '0.1.20',
        server_identity: 'server-a',
        server_instance_id: 'boot-old',
        message: 'No restart is active.'
      })
    })
    const { service, scope } = prepare(oldClient)

    await expect(service.serverRestartStatus(scope)).resolves.toMatchObject({
      phase: 'idle', server_instance_id: 'boot-old'
    })
    expect(oldClient.serverRestartStatus).toHaveBeenCalledOnce()
    await expect(service.serverRestartStatus({ ...scope, profileGeneration: 0 })).rejects.toThrow('superseded')
    expect(oldClient.serverRestartStatus).toHaveBeenCalledOnce()
  })

  it('posts exactly once, confirms a different boot on the same canonical server, and adopts the fresh client generation', async () => {
    const oldClient = fakeClient()
    const reconnectClient = fakeClient({
      health: async () => managedRestartHealth('boot-new'),
      sessions: async () => [{ id: 'chat-new', title: 'After restart', backend: 'codex' }]
    })
    const { service, scope } = prepare(oldClient, reconnectClient)
    const before = await service.bootstrap()

    const payload = await service.restartServer(scope, 'boot-old')

    expect(oldClient.restartServer).toHaveBeenCalledOnce()
    expect(oldClient.restartServer).toHaveBeenCalledWith({
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'boot-old',
      confirmed: true
    })
    expect(payload.profileGeneration).toBeGreaterThan(before.profileGeneration)
    expect(payload.health).toMatchObject({ server_identity: 'server-a', server_instance_id: 'boot-new' })
    expect(reconnectClient.health).toHaveBeenCalledWith(expect.any(Number), 'error')
    expect(oldClient.dispose).toHaveBeenCalledOnce()
    expect(reconnectClient.dispose).not.toHaveBeenCalled()
    const refreshed = await service.refreshServer('a', payload.profileGeneration)
    expect(refreshed.sessions).toEqual([expect.objectContaining({ id: 'chat-new' })])
  })

  it('does not post a restart when the saved Keychain credential cannot be recovered', async () => {
    const oldClient = fakeClient()
    const reconnectClient = fakeClient({ health: async () => managedRestartHealth('boot-new') })
    const { service, settings, scope } = prepare(oldClient, reconnectClient)
    vi.spyOn(settings, 'accessTokenForConnectionAsync').mockRejectedValue(new Error('The saved access token could not be read from Keychain.'))

    await expect(service.restartServer(scope, 'boot-old')).rejects.toThrow('saved access token could not be read')

    expect(oldClient.restartServer).not.toHaveBeenCalled()
    expect(reconnectClient.health).not.toHaveBeenCalled()
  })

  it('does not let an older reconnect override a newer switch waiting for authentication', async () => {
    const reconnectHealth = deferred<Health>()
    const switchToken = deferred<string>()
    const reconnect = fakeClient({ health: () => reconnectHealth.promise })
    const clientB = fakeClient()
    const { service, settings, scope } = prepare(fakeClient(), reconnect, { 'http://b.test:7850': [clientB] })
    vi.spyOn(settings, 'accessTokenForConnectionAsync').mockImplementation(profileId => profileId === 'b' ? switchToken.promise : Promise.resolve(''))
    const restarting = service.restartServer(scope, 'boot-old')
    const rejected = expect(restarting).rejects.toThrow('superseded')
    await vi.waitFor(() => expect(reconnect.health).toHaveBeenCalledOnce())
    const switching = service.switchServer('b')
    reconnectHealth.resolve(managedRestartHealth('boot-new'))
    await rejected
    expect(reconnect.dispose).toHaveBeenCalledOnce()
    switchToken.resolve('fake-b')
    await expect(switching).resolves.toMatchObject({ activeProfileId: 'b' })
  })

  it('carries the exact recovered Keychain token into the post-restart reconnect client', async () => {
    const oldClient = fakeClient()
    const reconnectClient = fakeClient({ health: async () => managedRestartHealth('boot-new') })
    const { service, settings, scope } = prepare(oldClient)
    vi.spyOn(settings, 'accessTokenForConnectionAsync').mockResolvedValue('recovered-keychain-token')
    const unguardedRead = vi.spyOn(settings, 'accessToken').mockImplementation(() => {
      throw new Error('restart must carry the recovered credential instead of rereading it')
    })
    const reconnectFactory = vi.fn(() => reconnectClient as unknown as AgentServerClient)
    Object.assign(service, { clientFactory: reconnectFactory })

    await expect(service.restartServer(scope, 'boot-old')).resolves.toMatchObject({
      health: expect.objectContaining({ server_instance_id: 'boot-new' })
    })

    expect(reconnectFactory).toHaveBeenCalledWith(
      'http://a.test:7850',
      'recovered-keychain-token'
    )
    expect(oldClient.restartServer).toHaveBeenCalledOnce()
    expect(unguardedRead).not.toHaveBeenCalled()
  })

  it('binds a force update restart to the canonical target, blocker revision, and exact pending schedule', async () => {
    const oldClient = fakeClient()
    const reconnectClient = fakeClient({ health: async () => managedRestartHealth('boot-new') })
    const { service, scope } = prepare(oldClient, reconnectClient)
    const blockerRevision = 'b'.repeat(64)
    const updateScheduleId = '1'.repeat(32)
    const health = managedRestartHealth('boot-old')
    health.capabilities = {
      ...health.capabilities,
      server_updates: {
        version: 11,
        available: true,
        required: false,
        message: 'Atomic update-now restart is available.',
        action: null
      }
    }
    Object.assign(service, { health })

    await expect(service.restartServer(scope, 'boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: blockerRevision,
      expectedUpdateScheduleId: updateScheduleId
    })).resolves.toMatchObject({
      health: expect.objectContaining({ server_instance_id: 'boot-new' })
    })

    expect(oldClient.restartServer).toHaveBeenCalledOnce()
    expect(oldClient.restartServer).toHaveBeenCalledWith({
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'boot-old',
      confirmed: true,
      force: true,
      force_confirmed: true,
      expected_blocker_revision: blockerRevision,
      expected_update_schedule_id: updateScheduleId
    })
  })

  it('rejects an invalid or unsupported update schedule fence before sending a restart POST', async () => {
    const oldClient = fakeClient()
    const { service, scope } = prepare(oldClient)

    await expect(service.restartServer(scope, 'boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: 'b'.repeat(64),
      expectedUpdateScheduleId: 'NOT-A-SCHEDULE'
    })).rejects.toThrow('exact 32-character lowercase update schedule ID')
    expect(oldClient.restartServer).not.toHaveBeenCalled()

    await expect(service.restartServer(scope, 'boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: 'b'.repeat(64),
      expectedUpdateScheduleId: '2'.repeat(32)
    })).rejects.toThrow('Update or reconnect AgentsServer')
    expect(oldClient.restartServer).not.toHaveBeenCalled()
  })

  it('fails closed when restart acceptance does not echo the bound update schedule', async () => {
    const oldClient = fakeClient({
      restartServer: async input => ({
        phase: 'accepted',
        request_id: input.request_id,
        forced: true,
        update_schedule_id: '4'.repeat(32),
        message: 'Restart accepted.'
      })
    })
    const { service, scope } = prepare(oldClient, fakeClient())
    const health = managedRestartHealth('boot-old')
    health.capabilities = {
      ...health.capabilities,
      server_updates: {
        version: 11,
        available: true,
        required: false,
        message: 'Atomic update-now restart is available.',
        action: null
      }
    }
    Object.assign(service, { health })

    await expect(service.restartServer(scope, 'boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: 'b'.repeat(64),
      expectedUpdateScheduleId: '3'.repeat(32)
    })).rejects.toThrow('did not confirm the exact queued update reservation')
    expect(oldClient.restartServer).toHaveBeenCalledOnce()
  })

  it('fails closed when a schedule-bound restart POST is ambiguous even if the same server returns with a new boot', async () => {
    const oldClient = fakeClient({
      restartServer: async () => { throw new TypeError('socket closed before response') }
    })
    const reconnectClient = fakeClient({ health: async () => managedRestartHealth('boot-new') })
    const { service, scope } = prepare(oldClient, reconnectClient)
    const health = managedRestartHealth('boot-old')
    health.capabilities = {
      ...health.capabilities,
      server_updates: {
        version: 11,
        available: true,
        required: false,
        message: 'Atomic update-now restart is available.',
        action: null
      }
    }
    Object.assign(service, { health })

    await expect(service.restartServer(scope, 'boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: 'b'.repeat(64),
      expectedUpdateScheduleId: '3'.repeat(32)
    })).rejects.toThrow('did not return the required confirmation for the exact queued update reservation')

    expect(oldClient.restartServer).toHaveBeenCalledOnce()
    expect(reconnectClient.health).not.toHaveBeenCalled()
    expect(reconnectClient.dispose).toHaveBeenCalledOnce()
  })

  it('forces a restart without a blocker revision when the server could not provide a snapshot', async () => {
    // A wedged server may be unable to serve a fresh blocker snapshot; that is
    // exactly when force restart matters, so the revision is optional.
    const oldClient = fakeClient()
    const reconnectClient = fakeClient({ health: async () => managedRestartHealth('boot-new') })
    const { service, scope } = prepare(oldClient, reconnectClient)

    await expect(service.restartServer(scope, 'boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: null
    })).resolves.toMatchObject({
      health: expect.objectContaining({ server_instance_id: 'boot-new' })
    })

    expect(oldClient.restartServer).toHaveBeenCalledOnce()
    expect(oldClient.restartServer).toHaveBeenCalledWith({
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expected_server_identity: 'server-a',
      expected_server_instance_id: 'boot-old',
      confirmed: true,
      force: true,
      force_confirmed: true
    })
  })

  it('rejects an invalid or unsupported force confirmation before sending a restart POST', async () => {
    const oldClient = fakeClient()
    const { service, scope } = prepare(oldClient)

    await expect(service.restartServer(scope, 'boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: 'not-a-revision'
    })).rejects.toThrow('fresh, explicitly confirmed blocker snapshot')
    expect(oldClient.restartServer).not.toHaveBeenCalled()

    Object.assign(service, {
      health: managedRestartHealth('boot-old', 'server-a')
    })
    const serviceHealth = (service as unknown as { health: Health }).health
    if (serviceHealth.capabilities?.server_restart) {
      serviceHealth.capabilities.server_restart = {
        ...serviceHealth.capabilities.server_restart,
        version: 1,
        force_restart: false
      }
    }
    await expect(service.restartServer(scope, 'boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: 'c'.repeat(64)
    })).rejects.toThrow('does not support explicitly confirmed force restart')
    expect(oldClient.restartServer).not.toHaveBeenCalled()
  })

  it('never retries an ambiguous POST and can still confirm the accepted restart by its new boot identifier', async () => {
    const oldClient = fakeClient({
      restartServer: async () => { throw new TypeError('socket closed before response') }
    })
    const reconnectClient = fakeClient({ health: async () => managedRestartHealth('boot-new') })
    const { service, scope } = prepare(oldClient, reconnectClient)

    await expect(service.restartServer(scope, 'boot-old')).resolves.toMatchObject({
      health: expect.objectContaining({ server_instance_id: 'boot-new' })
    })
    expect(oldClient.restartServer).toHaveBeenCalledOnce()
  })

  it('never retries an ambiguous force-restart POST', async () => {
    const oldClient = fakeClient({
      restartServer: async () => { throw new TypeError('socket closed before response') }
    })
    const reconnectClient = fakeClient({ health: async () => managedRestartHealth('boot-new') })
    const { service, scope } = prepare(oldClient, reconnectClient)

    await expect(service.restartServer(scope, 'boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: 'd'.repeat(64)
    })).resolves.toMatchObject({
      health: expect.objectContaining({ server_instance_id: 'boot-new' })
    })
    expect(oldClient.restartServer).toHaveBeenCalledOnce()
  })

  it('rejects a different canonical identity without adopting the endpoint', async () => {
    const oldClient = fakeClient()
    const reconnectClient = fakeClient({ health: async () => managedRestartHealth('boot-new', 'server-other') })
    const { service, scope } = prepare(oldClient, reconnectClient)
    const before = await service.bootstrap()

    await expect(service.restartServer(scope, 'boot-old')).rejects.toThrow('different server')

    expect((await service.bootstrap()).profileGeneration).toBe(before.profileGeneration)
    expect(oldClient.dispose).not.toHaveBeenCalled()
    expect(reconnectClient.dispose).toHaveBeenCalledOnce()
  })

  it('fences a reconnect result that arrives after the user switches profiles', async () => {
    const reconnectHealth = deferred<Health>()
    const oldClient = fakeClient()
    const reconnectClient = fakeClient({ health: () => reconnectHealth.promise })
    const bClient = fakeClient()
    const { service, scope } = prepare(oldClient, reconnectClient, {
      'http://b.test:7850': [bClient]
    })
    const pending = service.restartServer(scope, 'boot-old')
    await settleBackgroundWork()
    expect(reconnectClient.health).toHaveBeenCalledOnce()

    await service.switchServer('b')
    reconnectHealth.resolve(managedRestartHealth('boot-new'))

    await expect(pending).rejects.toThrow('superseded')
    expect((await service.bootstrap()).activeProfileId).toBe('b')
    expect(reconnectClient.dispose).toHaveBeenCalledOnce()
    expect(bClient.dispose).not.toHaveBeenCalled()
  })

  it('fences a reconnect result after the active profile endpoint changes in place', async () => {
    const reconnectHealth = deferred<Health>()
    const oldClient = fakeClient()
    const reconnectClient = fakeClient({ health: () => reconnectHealth.promise })
    const { service, settings, scope } = prepare(oldClient, reconnectClient)
    const pending = service.restartServer(scope, 'boot-old')
    await settleBackgroundWork()
    expect(reconnectClient.health).toHaveBeenCalledOnce()

    settings.updateProfile('a', { serverUrl: 'http://changed.test:7850' })
    reconnectHealth.resolve(managedRestartHealth('boot-new'))

    await expect(pending).rejects.toThrow('superseded')
    expect(reconnectClient.dispose).toHaveBeenCalledOnce()
    expect(oldClient.dispose).not.toHaveBeenCalled()
  })

  it('does not poll or retry after an authoritative restart rejection', async () => {
    const oldClient = fakeClient({
      restartServer: async () => { throw new ServerError(409, 'active work prevents restart') }
    })
    const reconnectClient = fakeClient({ health: async () => managedRestartHealth('boot-new') })
    const { service, scope } = prepare(oldClient, reconnectClient)

    await expect(service.restartServer(scope, 'boot-old')).rejects.toThrow('active work prevents restart')
    expect(oldClient.restartServer).toHaveBeenCalledOnce()
    expect(reconnectClient.health).not.toHaveBeenCalled()
    expect(reconnectClient.dispose).toHaveBeenCalledOnce()
  })

  it('does not poll or retry when a force confirmation has a stale blocker revision', async () => {
    const oldClient = fakeClient({
      restartServer: async () => { throw new ServerError(409, 'restart blockers changed') }
    })
    const reconnectClient = fakeClient({ health: async () => managedRestartHealth('boot-new') })
    const { service, scope } = prepare(oldClient, reconnectClient)

    await expect(service.restartServer(scope, 'boot-old', {
      force: true,
      forceConfirmed: true,
      expectedBlockerRevision: 'e'.repeat(64)
    })).rejects.toThrow('restart blockers changed')
    expect(oldClient.restartServer).toHaveBeenCalledOnce()
    expect(reconnectClient.health).not.toHaveBeenCalled()
    expect(reconnectClient.dispose).toHaveBeenCalledOnce()
  })

  it('reports an unconfirmed timeout while the old boot remains reachable and sends no second POST', async () => {
    const oldClient = fakeClient()
    const reconnectClient = fakeClient({ health: async () => managedRestartHealth('boot-old') })
    const { service, scope } = prepare(oldClient, reconnectClient)
    Object.assign(service, { serverRestartReconnectTimeoutMs: 5, serverRestartPollDelayMs: 5 })

    await expect(service.restartServer(scope, 'boot-old')).rejects.toThrow('same server instance is still reachable')
    expect(oldClient.restartServer).toHaveBeenCalledOnce()
    expect(reconnectClient.dispose).toHaveBeenCalledOnce()
  })

  it('rejects an old server that does not advertise the restart capability before creating a reconnect client', async () => {
    const oldClient = fakeClient()
    const { service, settings } = createProfileService({ 'http://a.test:7850': [oldClient] })
    settings.setProfileServerIdentity('a', 'server-a')
    Object.assign(service, {
      health: { ok: true, server_identity: 'server-a', server_instance_id: 'boot-old' },
      validatedGeneration: 1
    })

    await expect(service.restartServer({
      profileId: 'a', profileGeneration: 1, serverIdentity: 'server-a'
    }, 'boot-old')).rejects.toThrow('does not support managed restart')
    expect(oldClient.restartServer).not.toHaveBeenCalled()
  })
})

describe('main-process read state ordering', () => {
  it('serializes read and unread mutations and merges only receipt-owned fields', async () => {
    const read = deferred<Session>()
    const unread = deferred<Session>()
    const initial: Session = {
      id: 'chat-a', title: 'Before', backend: 'codex', latest_event_seq: 12,
      last_read_agent_event_seq: 9, last_read_agent_event_at: '2026-09-05T00:00:09Z'
    }
    const client = fakeClient({
      markRead: () => read.promise,
      markUnread: () => unread.promise
    })
    const { service } = createProfileService(
      { 'http://a.test:7850': [client] },
      cache => cache.putSession('profile:a', initial)
    )
    Object.assign(service, { validatedGeneration: 1 })

    const first = service.markRead('chat-a', 10)
    const second = service.markUnread('chat-a')
    await vi.waitFor(() => expect(client.markRead).toHaveBeenCalledOnce())
    expect(client.markUnread).not.toHaveBeenCalled()
    Object.assign(service, {
      sessions: [{ ...initial, title: 'Live title', latest_event_seq: 20, last_read_agent_event_seq: 20, last_read_agent_event_at: '2026-09-05T00:00:20Z' }]
    })
    read.resolve({ ...initial, title: 'Stale title', last_read_agent_event_seq: 10, manual_unread: false })
    await first
    await vi.waitFor(() => expect(client.markUnread).toHaveBeenCalledOnce())
    unread.resolve({ ...initial, title: 'Stale unread title', last_read_agent_event_seq: 10, manual_unread: true })
    const result = await second

    expect(result).toMatchObject({
      id: 'chat-a', title: 'Live title', latest_event_seq: 20,
      last_read_agent_event_seq: 20, last_read_agent_event_at: '2026-09-05T00:00:20Z', manual_unread: true
    })
    expect((service as unknown as { sessions: Session[] }).sessions[0]).toMatchObject(result)
  })

  it('rejects a read receipt for another chat without caching it', async () => {
    const client = fakeClient({ markRead: async () => ({ id: 'chat-b', title: 'Wrong', backend: 'codex' }) })
    const { service } = createProfileService({ 'http://a.test:7850': [client] })
    Object.assign(service, { validatedGeneration: 1 })

    await expect(service.markRead('chat-a', 1)).rejects.toThrow('another chat')
    expect((service as unknown as { sessions: Session[] }).sessions.some(session => session.id === 'chat-b')).toBe(false)
  })
})

describe('credential-free profile metadata and asynchronous authentication', () => {
  function prepare(profileCount = 3, removeTeamHubProfile?: (profileId: string) => Promise<void>) {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-profile-auth-'))
    const ids = ['a', 'b', 'c']
    const values = new Map<string, string>()
    const read = vi.fn((account: string) => values.get(account) ?? '')
    const readAsync = vi.fn(async (account: string) => values.get(account) ?? '')
    const settings = new SettingsStore({ path: join(directory, 'settings.json'),
      createProfileId: () => ids.shift()!, isMacAppStoreBuild: () => false,
      keychain: { read, readAsync, write: (account, token) => { values.set(account, token); return true },
        delete: account => { values.delete(account) } },
      safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('Unexpected encryption') },
        decryptString: () => { throw new Error('Unexpected decryption') } }
    })
    settings.updateProfile('a', { serverUrl: 'https://a.test', accessToken: 'fake-a' })
    for (const id of ['b', 'c'].slice(0, profileCount - 1)) settings.addProfile({ serverUrl: `https://${id}.test`, accessToken: `fake-${id}` })
    const cache = new LocalCache(':memory:')
    const clientFactory = vi.fn((_url: string, _token: string) => fakeClient() as unknown as AgentServerClient)
    const service = new AppService({ settings, cache, clientFactory, removeTeamHubProfile })
    cleanup.push(() => { service.stop(); cache.close(); rmSync(directory, { recursive: true, force: true }) })
    read.mockClear()
    readAsync.mockClear()
    clientFactory.mockClear()
    return { settings, service, read, readAsync, clientFactory }
  }

  it.each([2, 3])('uses zero credential reads for display and one asynchronous read for an ordinary %i-profile switch', async count => {
    const { service, settings, read, readAsync, clientFactory } = prepare(count)
    service.publicSettings()
    service.getActiveServer()
    service.teamHubServerScope()
    service.scopedPreference({ profileId: 'a', profileGeneration: 1, serverIdentity: null }, 'display-only', false)
    const listProfiles = vi.spyOn(settings, 'listProfiles')
    await service.bootstrap()
    expect(listProfiles).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled()
    expect(readAsync).not.toHaveBeenCalled()

    const payload = await service.switchServer('b')
    expect(payload.activeProfileId).toBe('b')
    expect(read).not.toHaveBeenCalled()
    expect(readAsync).toHaveBeenCalledExactlyOnceWith('agent-access-token:b')
    expect(clientFactory).toHaveBeenCalledExactlyOnceWith('https://b.test', 'fake-b')
    expect(JSON.stringify(payload)).not.toContain('fake-b')
  })

  it.each(['older first', 'newer first'])('keeps the newest profile intent when authentication resolves %s', async order => {
    const { service, readAsync, clientFactory } = prepare()
    const b = deferred<string>()
    const c = deferred<string>()
    readAsync.mockImplementation(account => account.endsWith(':b') ? b.promise : c.promise)
    const older = service.switchServer('b')
    const rejected = expect(older).rejects.toThrow(/changed|stale|superseded/i)
    const newer = service.switchServer('c')
    if (order === 'older first') {
      b.resolve('fake-b')
      await rejected
      expect((await service.bootstrap()).activeProfileId).toBe('a')
    }
    c.resolve('fake-c')
    await expect(newer).resolves.toMatchObject({ activeProfileId: 'c' })
    if (order === 'newer first') { b.resolve('fake-b'); await rejected }
    expect(clientFactory).toHaveBeenCalledExactlyOnceWith('https://c.test', 'fake-c')
  })

  it('lets a same-active selection cancel a pending switch without creating another client', async () => {
    const { service, readAsync, clientFactory } = prepare(2)
    const token = deferred<string>()
    readAsync.mockImplementation(account => account.endsWith(':b') ? token.promise : Promise.resolve('fake-a'))
    const switching = service.switchServer('b')
    const rejected = expect(switching).rejects.toThrow(/changed|stale|superseded/i)
    await expect(service.switchServer('a')).resolves.toMatchObject({ activeProfileId: 'a', profileGeneration: 1 })
    token.resolve('fake-b')
    await rejected
    expect(clientFactory).not.toHaveBeenCalled()
  })

  it.each(['stop', 'token replace', 'token clear', 'url change', 'identity change', 'remove'] as const)(
    'never creates a connection from a pending credential after %s', async operation => {
      const { service, settings, readAsync, clientFactory } = prepare(2)
      const token = deferred<string>()
      readAsync.mockReturnValue(token.promise)
      const switching = service.switchServer('b')
      const rejected = expect(switching).rejects.toThrow(/changed|stale|superseded|Unknown/i)
      if (operation === 'stop') service.stop()
      if (operation === 'token replace') await service.updateServer('b', { accessToken: 'fake-new' })
      if (operation === 'token clear') await service.updateServer('b', { accessToken: '' })
      if (operation === 'url change') await service.updateServer('b', { serverUrl: 'https://changed.test' })
      if (operation === 'identity change') settings.setProfileServerIdentity('b', 'changed-identity')
      if (operation === 'remove') await service.removeServer('b')
      token.resolve('fake-b')
      await rejected
      expect(clientFactory).not.toHaveBeenCalled()
    }
  )

  it.each(['stop', 'credential edit'])('does not start inactive requests after %s while authentication is pending', async operation => {
    const { service, readAsync, clientFactory } = prepare(2)
    const token = deferred<string>()
    readAsync.mockReturnValue(token.promise)
    const probing = probeInactiveProfiles(service)
    expect(readAsync).toHaveBeenCalledExactlyOnceWith('agent-access-token:b')
    if (operation === 'stop') service.stop()
    else await service.updateServer('b', { accessToken: 'fake-new' })
    token.resolve('fake-b')
    await probing
    expect(clientFactory).not.toHaveBeenCalled()
  })

  it('invalidates the inactive credential cache after a connection edit', async () => {
    const { service, readAsync, clientFactory } = prepare(2)
    await probeInactiveProfiles(service)
    await service.updateServer('b', { accessToken: 'fake-new' })
    await probeInactiveProfiles(service)
    expect(readAsync).toHaveBeenCalledTimes(2)
    expect(clientFactory.mock.calls).toEqual([['https://b.test', 'fake-b'], ['https://b.test', 'fake-new']])
  })

  it('refuses a completed credential while profile removal is still reserved', async () => {
    const cleanupGate = deferred<void>()
    const { service, readAsync, clientFactory } = prepare(2, () => cleanupGate.promise)
    const token = deferred<string>()
    readAsync.mockReturnValue(token.promise)
    const switching = service.switchServer('b')
    const rejected = expect(switching).rejects.toThrow(/being removed/i)
    const removing = service.removeServer('b')
    token.resolve('fake-b')
    await rejected
    expect(clientFactory).not.toHaveBeenCalled()
    cleanupGate.resolve()
    await expect(removing).resolves.toBe(true)
  })

  it('disposes a prepared connection superseded while identity cleanup is pending', async () => {
    const cleanupGate = deferred<void>()
    const { service, clientFactory } = prepare(3, () => cleanupGate.promise)
    const switching = service.updateServerAndSwitch('b', { resetServerIdentity: true })
    const rejected = expect(switching).rejects.toThrow(/superseded/i)
    await vi.waitFor(() => expect(clientFactory).toHaveBeenCalledWith('https://b.test', 'fake-b'))
    const supersededClient = clientFactory.mock.results[0].value
    await service.switchServer('c')
    cleanupGate.resolve()
    await rejected
    expect(supersededClient.dispose).toHaveBeenCalledOnce()
    expect((await service.bootstrap()).activeProfileId).toBe('c')
  })

  it('does not test a draft URL using a credential that changed during the read', async () => {
    const { service, readAsync, clientFactory } = prepare(2)
    const token = deferred<string>()
    readAsync.mockReturnValue(token.promise)
    const testing = service.testServerConnection({ profileId: 'b', serverUrl: 'https://draft.test' })
    const rejected = expect(testing).rejects.toThrow(/changed|stale/i)
    await service.updateServer('b', { accessToken: 'fake-new' })
    token.resolve('fake-b')
    await rejected
    expect(clientFactory).not.toHaveBeenCalled()
  })

  it('does not start a connection test after shutdown while a credential is pending', async () => {
    const { service, readAsync, clientFactory } = prepare(2)
    const token = deferred<string>()
    readAsync.mockReturnValue(token.promise)
    const testing = service.testServerConnection({ profileId: 'b', serverUrl: 'https://b.test' })
    const rejected = expect(testing).rejects.toThrow('superseded')
    service.stop()
    token.resolve('fake-b')
    await rejected
    expect(clientFactory).not.toHaveBeenCalled()
  })

  it('keeps settings and the active scope aligned while a kept credential is pending', async () => {
    const { service, settings, readAsync, clientFactory } = prepare(2)
    const token = deferred<string>()
    readAsync.mockReturnValue(token.promise)
    const applying = service.applySettings({ serverUrl: 'https://changed.test', accessToken: '__KEEP__' })
    const rejected = expect(applying).rejects.toThrow(/changed|superseded/)
    expect(settings.serverUrl('a')).toBe('https://a.test')
    expect(service.teamHubServerScope().serverUrl).toBe('https://a.test')
    // Old-server identity adoption while the read is pending must fence it,
    // never stamp that old identity onto the not-yet-committed new endpoint.
    settings.setProfileServerIdentity('a', 'old-server')
    token.resolve('fake-a')
    await rejected
    expect(settings.serverUrl('a')).toBe('https://a.test')
    expect(settings.serverIdentity('a')).toBe('old-server')
    expect(clientFactory).not.toHaveBeenCalled()
  })
})

describe('server profile lifecycle', () => {
  it('aborts an admitted upload when its renderer reloads and never starts the next file', async () => {
    const firstStarted = deferred<void>()
    const upload = vi.fn((_sessionId: string, _path: string, signal?: AbortSignal) => {
      firstStarted.resolve()
      return new Promise<import('../shared/types').AgentFile>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const { service } = createProfileService({ 'http://a.test:7850': [fakeClient({ upload })] })
    Object.assign(service, { validatedGeneration: 1 })
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-upload-renderer-race-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const first = join(directory, 'first.txt')
    const second = join(directory, 'second.txt')
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    electronHarness.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [first, second] })
    const webContentsHandlers = new Map<string, () => void>()
    service.addWindow({
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: {
        id: 41,
        send: vi.fn(),
        on: (event: string, listener: () => void) => { webContentsHandlers.set(event, listener) }
      }
    } as never)

    await service.chooseFiles(41)
    const uploading = service.uploadFiles(41, 'chat-a', [first, second])
    await firstStarted.promise
    const signal = upload.mock.calls[0][2]
    expect(signal?.aborted).toBe(false)
    webContentsHandlers.get('did-start-loading')?.()

    await expect(uploading).rejects.toThrow(/renderer/i)
    expect(signal?.aborted).toBe(true)
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('stages clipboard images privately and removes them after a successful upload', async () => {
    const upload = vi.fn(async (sessionId: string, path: string) => ({
      id: 'clipboard-upload', session_id: sessionId, filename: path.split('/').at(-1)!, content_type: 'image/png'
    }))
    const tempRoot = mkdtempSync(join(tmpdir(), 'agentsdock-clipboard-root-'))
    cleanup.push(() => rmSync(tempRoot, { recursive: true, force: true }))
    const { service } = createProfileService(
      { 'http://a.test:7850': [fakeClient({ upload })] },
      undefined, undefined, undefined, tempRoot
    )
    Object.assign(service, { validatedGeneration: 1 })
    service.addWindow({
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: { id: 41, send: vi.fn(), on: vi.fn() }
    } as never)
    const previousUmask = process.umask(0)
    let staged: ReturnType<AppService['stageClipboardImage']>
    try {
      staged = service.stageClipboardImage(41, new Uint8Array([1, 2, 3]).buffer, 'diagram', 'image/png')
    } finally {
      process.umask(previousUmask)
    }

    if (process.platform !== 'win32') {
      expect(statSync(staged.path).mode & 0o777).toBe(0o600)
      expect(statSync(join(staged.path, '..')).mode & 0o777).toBe(0o700)
    }
    await service.uploadFiles(41, 'chat-a', [staged.path])
    expect(existsSync(staged.path)).toBe(false)
  })

  it('rejects oversized clipboard images before creating a staged file', () => {
    const { service } = createProfileService({ 'http://a.test:7850': [fakeClient()] })
    service.addWindow({
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: { id: 41, send: vi.fn(), on: vi.fn() }
    } as never)

    expect(() => service.stageClipboardImage(
      41,
      new ArrayBuffer(32 * 1024 * 1024 + 1),
      'too-large.png',
      'image/png'
    )).toThrow(/between 1 byte/i)
  })

  it('removes staged clipboard files when their renderer is destroyed', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'agentsdock-clipboard-root-'))
    cleanup.push(() => rmSync(tempRoot, { recursive: true, force: true }))
    const { service } = createProfileService(
      { 'http://a.test:7850': [fakeClient()] },
      undefined, undefined, undefined, tempRoot
    )
    const webContentsHandlers = new Map<string, () => void>()
    service.addWindow({
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: {
        id: 41,
        send: vi.fn(),
        on: (event: string, listener: () => void) => { webContentsHandlers.set(event, listener) }
      }
    } as never)
    const staged = service.stageClipboardImage(41, new Uint8Array([1]).buffer, 'private.png', 'image/png')
    expect(existsSync(staged.path)).toBe(true)

    webContentsHandlers.get('destroyed')?.()

    expect(existsSync(staged.path)).toBe(false)
  })

  it('scavenges only old private crash-leftover clipboard directories on first use', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'agentsdock-clipboard-root-'))
    cleanup.push(() => rmSync(tempRoot, { recursive: true, force: true }))
    const stale = join(tempRoot, 'AgentsDockClipboard-AbC123')
    const recent = join(tempRoot, 'AgentsDockClipboard-DeF456')
    const unsafe = join(tempRoot, 'AgentsDockClipboard-GhI789')
    const symlinkTarget = join(tempRoot, 'must-not-delete')
    const symlink = join(tempRoot, 'AgentsDockClipboard-JkL012')
    mkdirSync(stale, { mode: 0o700 })
    mkdirSync(recent, { mode: 0o700 })
    mkdirSync(unsafe, { mode: 0o755 })
    mkdirSync(symlinkTarget, { mode: 0o700 })
    symlinkSync(symlinkTarget, symlink)
    writeFileSync(join(stale, 'private.png'), 'stale', { mode: 0o600 })
    const old = new Date(Date.now() - 48 * 60 * 60_000)
    utimesSync(stale, old, old)
    // Node cannot express or inspect Windows ACLs with POSIX mode bits. Keep
    // this candidate recent there and exercise the private-mode guard on POSIX.
    if (process.platform !== 'win32') utimesSync(unsafe, old, old)
    chmodSync(stale, 0o700)
    // chmod changes ctime but not the mtime used by the conservative scavenger.
    const { service } = createProfileService(
      { 'http://a.test:7850': [fakeClient()] },
      undefined, undefined, undefined, tempRoot
    )
    service.addWindow({
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: { id: 41, send: vi.fn(), on: vi.fn() }
    } as never)

    const current = service.stageClipboardImage(41, new Uint8Array([1]).buffer, 'current.png', 'image/png')

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(unsafe)).toBe(true)
    expect(existsSync(symlink)).toBe(true)
    expect(existsSync(symlinkTarget)).toBe(true)
    expect(existsSync(current.path)).toBe(true)
  })

  it('does not publish a chooser grant after its renderer is destroyed', async () => {
    const { service } = createProfileService({ 'http://a.test:7850': [fakeClient()] })
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-chooser-race-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'private.txt')
    writeFileSync(path, 'private')
    let finishDialog!: (value: { canceled: boolean; filePaths: string[] }) => void
    electronHarness.showOpenDialog.mockReturnValue(new Promise(resolve => { finishDialog = resolve }))
    const webContentsHandlers = new Map<string, () => void>()
    service.addWindow({
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: {
        id: 41,
        send: vi.fn(),
        on: (event: string, listener: () => void) => { webContentsHandlers.set(event, listener) }
      }
    } as never)

    const choosing = service.chooseFiles(41)
    await vi.waitFor(() => expect(electronHarness.showOpenDialog).toHaveBeenCalledOnce())
    webContentsHandlers.get('destroyed')?.()
    finishDialog({ canceled: false, filePaths: [path] })

    await expect(choosing).rejects.toThrow('renderer changed')
    await expect(service.uploadFiles(41, 'chat-a', [path])).rejects.toThrow('renderer is no longer available')
  })

  it('revokes a chosen path when a profile switch supersedes its generation', async () => {
    const clientB = fakeClient()
    const upload = vi.fn()
    Object.assign(clientB, { upload })
    const { service } = createProfileService({
      'http://a.test:7850': [fakeClient()],
      'http://b.test:7850': [clientB]
    })
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-chooser-switch-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'private.txt')
    writeFileSync(path, 'private')
    electronHarness.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] })
    service.addWindow({
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: { id: 41, on: vi.fn(), send: vi.fn() }
    } as never)

    await service.chooseFiles(41)
    await service.switchServer('b', true)

    await expect(service.uploadFiles(41, 'chat-b', [path])).rejects.toThrow('Choose this file again')
    expect(upload).not.toHaveBeenCalled()
  })

  it('refuses to switch to a profile whose stored credential is unreadable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-dormant-profile-'))
    const settingsPath = join(directory, 'settings.json')
    const timestamp = '2026-07-17T12:00:00Z'
    writeFileSync(settingsPath, `${JSON.stringify({
      schemaVersion: 2,
      activeProfileId: 'a',
      profiles: [
        {
          id: 'a', name: 'A', serverUrl: 'http://a.test:7850', serverSetupComplete: true,
          createdAt: timestamp, updatedAt: timestamp
        },
        {
          id: 'b', name: 'B', serverUrl: 'http://b.test:7850', serverSetupComplete: true,
          encryptedAccessToken: Buffer.from('dormant-token').toString('base64'), keychainAccessToken: false,
          createdAt: timestamp, updatedAt: timestamp
        }
      ]
    }, null, 2)}\n`)
    const settings = new SettingsStore({
      path: settingsPath,
      isMacAppStoreBuild: () => true,
      keychain: { read: () => '', write: () => false, delete: () => undefined },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: value => Buffer.from(value),
        decryptString: value => value.toString('utf8')
      }
    })
    const cache = new LocalCache(':memory:')
    const activeClient = fakeClient()
    const clientFactory = vi.fn((serverUrl: string) => {
      if (serverUrl === 'http://a.test:7850') return activeClient as unknown as AgentServerClient
      return fakeClient() as unknown as AgentServerClient
    })
    const service = new AppService({ settings, cache, clientFactory })
    cleanup.push(() => {
      service.stop()
      cache.close()
      rmSync(directory, { recursive: true, force: true })
    })

    expect(settings.getProfile('b')?.hasAccessToken).toBe(true)
    await expect(service.switchServer('b')).rejects.toThrow('saved access token could not be read')
    expect(settings.getActiveProfileId()).toBe('a')
    expect(clientFactory).toHaveBeenCalledTimes(1)
  })

  it('cleans up the matching server-owned Teamspace binding before removing a profile', async () => {
    const removeTeamHubProfile = vi.fn(async () => undefined)
    const { service, settings } = createProfileService({
      'http://a.test:7850': [fakeClient()]
    }, undefined, undefined, removeTeamHubProfile)

    await expect(service.removeServer('b')).resolves.toBe(true)
    expect(removeTeamHubProfile).toHaveBeenCalledOnce()
    expect(removeTeamHubProfile).toHaveBeenCalledWith('b')
    expect(settings.getProfile('b')).toBeNull()
  })

  it('purges both fallback and identity cache namespaces before removing a profile', async () => {
    const { service, settings, cache } = createProfileService({
      'http://a.test:7850': [fakeClient()]
    })
    settings.setProfileServerIdentity('b', 'server-b')
    const cachedSession = (id: string): Session => ({ id, title: id, backend: 'codex' })
    const cachedEvent = (sessionId: string): Event => ({
      id: `${sessionId}-event`, session_id: sessionId, seq: 1,
      type: 'assistant_text', ts: '2026-09-05T00:00:00Z', text: 'private'
    })
    cache.putSession('profile:b', cachedSession('fallback-private'))
    cache.putEvents('profile:b', 'fallback-private', [cachedEvent('fallback-private')])
    cache.putSession('server-b', cachedSession('identity-private'))
    cache.putEvents('server-b', 'identity-private', [cachedEvent('identity-private')])
    cache.putSession('server-keep', cachedSession('keep'))

    await expect(service.removeServer('b')).resolves.toBe(true)

    expect(cache.cachedServerIds()).toEqual(['server-keep'])
    expect(settings.getProfile('b')).toBeNull()
  })

  it('keeps the profile without restoring retired Teamspace authority when cache purge fails', async () => {
    const rollback = vi.fn()
    const removeTeamHubProfile = vi.fn(async () => ({ rollback }))
    const { service, settings, cache } = createProfileService({
      'http://a.test:7850': [fakeClient()]
    }, undefined, undefined, removeTeamHubProfile)
    vi.spyOn(cache, 'removeServerNamespaces').mockImplementation(() => {
      throw new Error('cache volume is read-only')
    })

    await expect(service.removeServer('b')).rejects.toThrow('cache volume is read-only')
    expect(settings.getProfile('b')).not.toBeNull()
    expect(rollback).not.toHaveBeenCalled()
  })

  it('fences profile switches while asynchronous profile cleanup is in progress', async () => {
    let finishCleanup!: () => void
    const removeTeamHubProfile = vi.fn(() => new Promise<void>(resolve => { finishCleanup = resolve }))
    const clientB = fakeClient()
    const { service, settings } = createProfileService({
      'http://a.test:7850': [fakeClient()],
      'http://b.test:7850': [clientB]
    }, undefined, undefined, removeTeamHubProfile)

    const removing = service.removeServer('b')
    await vi.waitFor(() => expect(removeTeamHubProfile).toHaveBeenCalledWith('b'))
    await expect(service.switchServer('b', true)).rejects.toThrow('already being removed')
    finishCleanup()

    await expect(removing).resolves.toBe(true)
    expect(settings.getActiveProfileId()).toBe('a')
    expect(settings.getProfile('b')).toBeNull()
    expect(clientB.health).not.toHaveBeenCalled()
  })

  it('keeps a server profile when its Teamspace attachment cache cannot be purged', async () => {
    const removeTeamHubProfile = vi.fn(async () => {
      throw new Error('Teamspace cache cleanup failed')
    })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [fakeClient()]
    }, undefined, undefined, removeTeamHubProfile)

    await expect(service.removeServer('b')).rejects.toThrow('Teamspace cache cleanup failed')
    expect(removeTeamHubProfile).toHaveBeenCalledWith('b')
    expect(settings.getProfile('b')).not.toBeNull()
  })

  it('keeps a cached runtime catalog fresh across profile activation', async () => {
    const client = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [client]
    }, cache => {
      cache.putPreference('profile:a', 'runtimeCatalog:v1', runtimeCatalog)
    })
    const payload = await service.bootstrap()

    await service.refreshServer('a', payload.profileGeneration)
    await settleBackgroundWork()

    expect(client.runtimeCatalog).not.toHaveBeenCalled()
  })

  it('refetches the model list when the server comes back as a new instance', async () => {
    // Upgrading a provider CLI only takes effect for a fresh server process,
    // and the catalog is cached on disk for 15 minutes - so after restarting
    // the server a newly released model stayed invisible in the picker.
    const refreshedCatalog: RuntimeCatalog = {
      ...runtimeCatalog,
      generated_at: '2026-07-30T21:00:00Z',
    }
    let instanceId = 'instance-a'
    const client = fakeClient({
      health: async () => ({ ok: true, server_identity: 'server-a', server_instance_id: instanceId }),
      runtimeCatalog: async () => refreshedCatalog
    })
    const { service } = createProfileService({
      'http://a.test:7850': [client]
    }, cache => {
      cache.putPreference('profile:a', 'runtimeCatalog:v1', runtimeCatalog)
    })
    const payload = await service.bootstrap()
    await service.refreshServer('a', payload.profileGeneration)
    await settleBackgroundWork()
    client.runtimeCatalog.mockClear()

    instanceId = 'instance-b'
    await service.refreshServer('a', payload.profileGeneration)
    await settleBackgroundWork()

    expect(client.runtimeCatalog).toHaveBeenCalled()
    expect(client.runtimeCatalog).toHaveBeenLastCalledWith(true)
  })

  it('keeps trusting the cached catalog while the server instance is unchanged', async () => {
    // The refresh must key on the server actually being replaced, not fire on
    // every reconnect, or an ordinary network blip re-probes every CLI.
    const client = fakeClient({
      health: async () => ({ ok: true, server_identity: 'server-a', server_instance_id: 'instance-a' })
    })
    const { service } = createProfileService({
      'http://a.test:7850': [client]
    }, cache => {
      cache.putPreference('profile:a', 'runtimeCatalog:v1', runtimeCatalog)
    })
    const payload = await service.bootstrap()

    await service.refreshServer('a', payload.profileGeneration)
    await service.refreshServer('a', payload.profileGeneration)
    await settleBackgroundWork()

    expect(client.runtimeCatalog).not.toHaveBeenCalled()
  })

  it('forces an authoritative runtime probe when the user explicitly rechecks CLI status', async () => {
    const refreshedCatalog: RuntimeCatalog = {
      ...runtimeCatalog,
      generated_at: '2026-07-30T20:00:00Z',
    }
    const client = fakeClient({ runtimeCatalog: async () => refreshedCatalog })
    const { service } = createProfileService({
      'http://a.test:7850': [client]
    })

    const result = await service.runtime(true)

    expect(client.runtimeCatalog).toHaveBeenLastCalledWith(true)
    expect(result).toEqual(refreshedCatalog)
  })

  it('queues a forced CLI probe behind an in-flight background catalog refresh', async () => {
    const backgroundCatalog = deferred<RuntimeCatalog>()
    const refreshedCatalog: RuntimeCatalog = {
      ...runtimeCatalog,
      generated_at: '2026-07-30T20:02:00Z',
    }
    const client = fakeClient({
      runtimeCatalog: refresh => refresh ? Promise.resolve(refreshedCatalog) : backgroundCatalog.promise
    })
    const { service } = createProfileService({
      'http://a.test:7850': [client]
    })

    const pending = service.runtime(true)
    await settleBackgroundWork()

    expect(client.runtimeCatalog).toHaveBeenCalledTimes(1)
    expect(client.runtimeCatalog).toHaveBeenNthCalledWith(1, false)
    backgroundCatalog.resolve(runtimeCatalog)

    await expect(pending).resolves.toEqual(refreshedCatalog)
    expect(client.runtimeCatalog).toHaveBeenCalledTimes(2)
    expect(client.runtimeCatalog).toHaveBeenNthCalledWith(2, true)
  })

  it('surfaces a queued forced CLI probe failure after an in-flight background refresh', async () => {
    const backgroundCatalog = deferred<RuntimeCatalog>()
    const client = fakeClient({
      runtimeCatalog: refresh => refresh
        ? Promise.reject(new Error('Queued CLI probe timed out'))
        : backgroundCatalog.promise
    })
    const { service } = createProfileService({
      'http://a.test:7850': [client]
    })

    const pending = service.runtime(true)
    await settleBackgroundWork()
    expect(client.runtimeCatalog).toHaveBeenNthCalledWith(1, false)
    backgroundCatalog.resolve(runtimeCatalog)

    await expect(pending).rejects.toThrow('Queued CLI probe timed out')
    expect(client.runtimeCatalog).toHaveBeenCalledTimes(2)
    expect(client.runtimeCatalog).toHaveBeenNthCalledWith(2, true)
  })

  it('reports a failed explicit runtime recheck instead of silently returning stale cached status', async () => {
    const client = fakeClient({
      runtimeCatalog: async refresh => {
        if (refresh) throw new Error('CLI probe timed out')
        return runtimeCatalog
      }
    })
    const { service } = createProfileService({
      'http://a.test:7850': [client]
    }, cache => {
      cache.putPreference('profile:a', 'runtimeCatalog:v1', runtimeCatalog)
    })

    await expect(service.runtime(true)).rejects.toThrow('CLI probe timed out')
    expect(client.runtimeCatalog).toHaveBeenLastCalledWith(true)
  })

  it('atomically persists an active connection edit and swaps to exactly one prepared client', async () => {
    const original = fakeClient()
    const prepared = fakeClient({
      health: async () => ({ ok: true, server_identity: 'new-a' }),
      sessions: async () => [{ id: 'new-chat', title: 'Prepared client', backend: 'codex' }]
    })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [original],
      'http://a-new.test:7850': [prepared],
      'http://b.test:7850': [fakeClient()]
    })
    const persist = vi.spyOn(settings, 'updateProfile')
    const before = await service.bootstrap()

    const payload = await service.updateServerAndSwitch('a', {
      name: 'A New',
      serverUrl: 'http://a-new.test:7850',
      resetServerIdentity: true
    })

    // The connection edit is committed before the old generation is retired;
    // the trust reset is a second durable commit after that generation fence,
    // followed by a durable clear of the retired-authority cleanup tombstone.
    expect(persist).toHaveBeenCalledTimes(3)
    expect(original.dispose).toHaveBeenCalledOnce()
    expect(prepared.dispose).not.toHaveBeenCalled()
    expect(settings.getProfile('a')).toEqual(expect.objectContaining({ name: 'A New', serverUrl: 'http://a-new.test:7850' }))
    expect(payload.profileGeneration).toBeGreaterThan(before.profileGeneration)
    const refreshed = await service.refreshServer('a', payload.profileGeneration)
    expect(prepared.health).toHaveBeenCalledOnce()
    expect(prepared.sessions).toHaveBeenCalledOnce()
    expect(refreshed.sessions).toEqual([expect.objectContaining({ title: 'Prepared client' })])
  })

  it('disposes only the prospective client when an atomic connection edit cannot persist', async () => {
    const original = fakeClient()
    const prospective = fakeClient()
    const { service, settings } = createProfileService({
      'http://a.test:7850': [original],
      'http://b.test:7850': [prospective]
    })
    const before = await service.bootstrap()

    await expect(service.updateServerAndSwitch('a', { serverUrl: 'http://b.test:7850' })).rejects.toThrow('already uses')

    expect(prospective.dispose).toHaveBeenCalledOnce()
    expect(original.dispose).not.toHaveBeenCalled()
    expect(settings.serverUrl('a')).toBe('http://a.test:7850')
    expect((await service.bootstrap())).toEqual(expect.objectContaining({ activeProfileId: 'a', profileGeneration: before.profileGeneration }))
  })

  it('requires an atomic reopen when resetting the active server identity', async () => {
    const original = fakeClient()
    const reopened = fakeClient()
    const { service, settings } = createProfileService({
      'http://a.test:7850': [original, reopened],
      'http://b.test:7850': [fakeClient()]
    })
    settings.setProfileServerIdentity('a', 'old-identity')
    const before = await service.bootstrap()

    await expect(service.updateServer('a', { resetServerIdentity: true }))
      .rejects.toThrow(/reopen the active server/i)

    expect(settings.getProfile('a')?.serverIdentity).toBe('old-identity')
    expect(original.dispose).not.toHaveBeenCalled()
    expect((await service.bootstrap()).profileGeneration).toBe(before.profileGeneration)

    const reopenedPayload = await service.updateServerAndSwitch('a', { resetServerIdentity: true })

    expect(original.dispose).toHaveBeenCalledOnce()
    expect(settings.getProfile('a')?.serverIdentity).toBeNull()
    expect(reopenedPayload.profileGeneration).toBeGreaterThan(before.profileGeneration)
  })

  it('commits a coherent replacement profile even when every old-resource cleanup callback is hostile', async () => {
    const original = fakeClient()
    original.dispose.mockImplementation(() => { throw new Error('old client dispose failed') })
    const replacement = fakeClient({
      health: async () => ({ ok: true, server_identity: 'server-b' }),
      sessions: async () => [{ id: 'chat-b', title: 'Replacement chat', backend: 'codex' }]
    })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [original],
      'http://b.test:7850': [replacement]
    })
    const timelineStop = vi.fn(() => { throw new Error('timeline stop failed') })
    const emergencyStop = vi.fn(() => { throw new Error('emergency stop failed') })
    const terminalClose = vi.fn(() => { throw new Error('terminal close failed') })
    const tunnelDispose = vi.fn()
      .mockImplementationOnce(() => { throw new Error('tunnel dispose failed') })
    const projectionReset = vi.fn(() => { throw new Error('projector reset failed') })
    const internals = service as unknown as {
      timelineSubscriptions: Map<string, { lease: number; stop: () => void; connected: boolean; initializing: boolean }>
      emergencyStreamStop: (() => void) | null
      terminalConnections: Map<string, { write(data: string): void; resize(columns: number, rows: number): void; scroll(delta: number): void; close(): void }>
      portTunnels: { disposeAll(): void }
      subagentProjector: { reset(): void }
    }
    internals.timelineSubscriptions.set('chat-a', {
      lease: 1, stop: timelineStop, connected: true, initializing: false
    })
    internals.emergencyStreamStop = emergencyStop
    internals.terminalConnections.set('chat-a', {
      write: vi.fn(), resize: vi.fn(), scroll: vi.fn(), close: terminalClose
    })
    internals.portTunnels.disposeAll = tunnelDispose
    internals.subagentProjector.reset = projectionReset

    const payload = await service.switchServer('b', true)

    expect(settings.getActiveProfileId()).toBe('b')
    expect(payload).toMatchObject({
      activeProfileId: 'b',
      profileTransitionWarning: expect.stringMatching(/timeline stop failed/i)
    })
    expect(timelineStop).toHaveBeenCalledOnce()
    expect(emergencyStop).toHaveBeenCalledOnce()
    expect(terminalClose).toHaveBeenCalledOnce()
    expect(tunnelDispose).toHaveBeenCalledOnce()
    expect(projectionReset).toHaveBeenCalledOnce()
    expect(original.dispose).toHaveBeenCalledOnce()
    expect(replacement.dispose).not.toHaveBeenCalled()
    await expect(service.refreshServer('b', payload.profileGeneration)).resolves.toMatchObject({
      activeProfileId: 'b', sessions: [expect.objectContaining({ id: 'chat-b' })]
    })
  })

  it('keeps an active identity-reset failure empty and fenced until an explicit successful retry', async () => {
    const original = fakeClient()
    const failedReplacement = fakeClient()
    const recoveredReplacement = fakeClient({
      health: async () => ({ ok: true, server_identity: 'server-new-a' }),
      sessions: async () => [{ id: 'new-chat', title: 'New authority', backend: 'codex' }]
    })
    const rollback = vi.fn()
    const removeTeamHubProfile = vi.fn()
      .mockResolvedValueOnce({ rollback })
      .mockResolvedValueOnce({ rollback: vi.fn() })
    const { service, settings, cache } = createProfileService({
      'http://a.test:7850': [original, failedReplacement, recoveredReplacement]
    }, undefined, undefined, removeTeamHubProfile)
    settings.setProfileServerIdentity('a', 'server-old-a')
    cache.putSession('server-old-a', { id: 'private-old', title: 'Private old chat', backend: 'codex' })
    const removeNamespaces = vi.spyOn(cache, 'removeServerNamespaces')
      .mockImplementationOnce(() => { throw new Error('cache purge failed') })

    const failed = await service.updateServerAndSwitch('a', { resetServerIdentity: true })

    expect(failed).toMatchObject({
      activeProfileId: 'a', sessions: [], health: null,
      profileTransitionWarning: expect.stringMatching(/identity was reset.*cache purge failed/i)
    })
    expect(settings.getProfile('a')?.serverIdentity).toBeNull()
    expect(cache.snapshot('server-old-a', 'private-old')).not.toBeNull()
    expect(rollback).not.toHaveBeenCalled()
    await expect(service.refreshServer('a', failed.profileGeneration)).rejects.toThrow(/waiting for its prior identity reset/i)
    await expect(service.bootstrap()).resolves.toMatchObject({ activeProfileId: 'a', sessions: [] })

    const recovered = await service.updateServerAndSwitch('a', { resetServerIdentity: true })
    expect(recovered.profileTransitionWarning).toBeUndefined()
    expect(settings.getProfile('a')?.serverIdentity).toBeNull()
    expect(cache.cachedServerIds()).not.toContain('server-old-a')
    await expect(service.refreshServer('a', recovered.profileGeneration)).resolves.toMatchObject({
      sessions: [expect.objectContaining({ id: 'new-chat' })]
    })
    // The failed reset, bootstrap retry, and explicit reset retry each attempt
    // the exact retained namespace set.
    expect(removeNamespaces).toHaveBeenCalledTimes(3)
  })

  it('does not delete retired authority data when durable identity persistence fails', async () => {
    const original = fakeClient()
    const failedReplacement = fakeClient()
    const recoveredReplacement = fakeClient({
      health: async () => ({ ok: true, server_identity: 'server-new-a' })
    })
    const rollback = vi.fn()
    const removeTeamHubProfile = vi.fn()
      .mockResolvedValueOnce({ rollback })
      .mockResolvedValueOnce({ rollback: vi.fn() })
    const { service, settings, cache } = createProfileService({
      'http://a.test:7850': [original, failedReplacement, recoveredReplacement]
    }, undefined, undefined, removeTeamHubProfile)
    settings.setProfileServerIdentity('a', 'server-old-a')
    cache.putSession('server-old-a', { id: 'private-old', title: 'Private old chat', backend: 'codex' })
    const updateProfile = settings.updateProfile.bind(settings)
    const persistence = vi.spyOn(settings, 'updateProfile').mockImplementation((profileId, patch) => {
      if (patch.serverIdentity === null) throw new Error('settings persistence failed')
      return updateProfile(profileId, patch)
    })

    const failed = await service.updateServerAndSwitch('a', { resetServerIdentity: true })

    expect(failed).toMatchObject({
      activeProfileId: 'a', sessions: [], health: null,
      profileTransitionWarning: expect.stringMatching(/could not be reset safely.*settings persistence failed/i)
    })
    expect(settings.getProfile('a')?.serverIdentity).toBe('server-old-a')
    expect(cache.cachedServerIds()).toContain('server-old-a')
    expect(removeTeamHubProfile).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
    await expect(service.refreshServer('a', failed.profileGeneration)).rejects.toThrow(/waiting for its prior identity reset/i)

    persistence.mockRestore()
    const recovered = await service.updateServerAndSwitch('a', { resetServerIdentity: true })
    expect(recovered.profileTransitionWarning).toBeUndefined()
    expect(settings.getProfile('a')?.serverIdentity).toBeNull()
    await expect(service.refreshServer('a', recovered.profileGeneration)).resolves.toMatchObject({ activeProfileId: 'a' })
  })

  it('fences and flushes the active scope before purging its reset identity namespace', async () => {
    const oldStream: { receive: ((event: Event) => void) | null } = { receive: null }
    const original = fakeClient()
    const canonical = fakeClient({
      sessionPage: async sessionId => emptyTimelinePage(sessionId),
      stream: (_sessionId, _after, onEvent) => {
        oldStream.receive = onEvent
        return vi.fn()
      }
    })
    const replacement = fakeClient()
    const { service, settings, cache } = createProfileService({
      'http://a.test:7850': [original, canonical, replacement]
    })
    settings.setProfileServerIdentity('a', 'server-old-a')
    await service.switchServer('a', true)
    const internals = service as unknown as {
      scope: { profileId: string; generation: number; namespace: string; client: AgentServerClient }
      validatedGeneration: number | null
    }
    internals.validatedGeneration = internals.scope.generation
    await service.subscribeTimeline('chat', 0)
    await settleBackgroundWork()
    expect(oldStream.receive).not.toBeNull()

    oldStream.receive?.({
      id: 'queued-old', session_id: 'chat', seq: 1, type: 'assistant_text',
      ts: '2026-09-05T00:00:00Z', text: 'must be purged'
    })
    await service.updateServerAndSwitch('a', { resetServerIdentity: true })

    expect(settings.getProfile('a')?.serverIdentity).toBeNull()
    expect(cache.cachedServerIds()).not.toContain('server-old-a')
    expect(cache.snapshot('server-old-a', 'chat')).toBeNull()
    oldStream.receive?.({
      id: 'late-old', session_id: 'chat', seq: 2, type: 'assistant_text',
      ts: '2026-09-05T00:00:01Z', text: 'must stay fenced'
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(cache.cachedServerIds()).not.toContain('server-old-a')
    expect(cache.snapshot('server-old-a', 'chat')).toBeNull()
  })

  it('purges an old canonical cache namespace before reset, rebind, and later profile removal', async () => {
    const { service, settings, cache } = createProfileService({
      'http://a.test:7850': [fakeClient()]
    })
    settings.setProfileServerIdentity('b', 'server-old-b')
    cache.putSession('server-old-b', { id: 'old-private', title: 'Old private', backend: 'codex' })
    cache.putPreference('server-old-b', 'private', { secret: true })
    cache.putSession('server-keep', { id: 'keep', title: 'Keep', backend: 'codex' })

    await service.updateServer('b', { resetServerIdentity: true })

    expect(cache.cachedServerIds()).toEqual(['server-keep'])
    settings.setProfileServerIdentity('b', 'server-new-b')
    cache.putSession('server-new-b', { id: 'new-private', title: 'New private', backend: 'codex' })
    await expect(service.removeServer('b')).resolves.toBe(true)

    expect(cache.cachedServerIds()).toEqual(['server-keep'])
    expect(settings.getProfile('b')).toBeNull()
  })

  it('searches cached sessions across profiles without collapsing reused session IDs', () => {
    const { service } = createProfileService({
      'http://a.test:7850': [fakeClient()],
      'http://b.test:7850': [fakeClient()]
    }, cache => {
      cache.putSession('profile:a', { id: 'same', title: 'Shared Alpha result', backend: 'codex' })
      cache.putSession('profile:b', { id: 'same', title: 'Shared Beta result', backend: 'claude' })
    })

    const results = service.searchAllProfileSessions('Shared')

    expect(results.map(result => [result.profileId, result.session.title])).toEqual([
      ['a', 'Shared Alpha result'],
      ['b', 'Shared Beta result']
    ])
    expect(results.every(result => result.source === 'title')).toBe(true)
  })

  it('does not let a late A refresh overwrite B when both servers reuse a session ID', async () => {
    const lateASessions = deferred<Session[]>()
    const a = fakeClient({ sessions: () => lateASessions.promise })
    const b = fakeClient({ sessions: async () => [{ id: 'same', title: 'B remote', backend: 'codex' }] })
    const { service, cache } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    }, value => {
      value.putSession('profile:a', { id: 'same', title: 'A cached', backend: 'codex' })
      value.putSession('profile:b', { id: 'same', title: 'B cached', backend: 'codex' })
    })

    const oldRefresh = (service as unknown as {
      refreshAll(announce: boolean, includeJobs: boolean): Promise<void>
    }).refreshAll(false, true)
    const payload = await service.switchServer('b')
    expect(payload.sessions).toEqual([expect.objectContaining({ id: 'same', title: 'B cached' })])
    await service.refreshServer('b', payload.profileGeneration)

    lateASessions.resolve([{ id: 'same', title: 'A late', backend: 'codex' }])
    await oldRefresh

    expect(cache.session('profile:b', 'same')).toEqual(expect.objectContaining({ title: 'B remote' }))
    expect(cache.session('profile:a', 'same')).toEqual(expect.objectContaining({ title: 'A cached' }))
    expect((await service.bootstrap()).activeProfileId).toBe('b')
  })

  it('returns an offline profile cache before attempting its network refresh', async () => {
    const a = fakeClient()
    const offline = new Error('server unreachable')
    const b = fakeClient({
      health: async () => { throw offline },
      sessions: async () => { throw offline },
      jobs: async () => { throw offline }
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    }, cache => {
      cache.putSession('profile:b', { id: 'cached-b', title: 'Cached while offline', backend: 'claude' })
    })

    const cached = await service.switchServer('b')

    expect(cached.sessions).toEqual([expect.objectContaining({ id: 'cached-b', title: 'Cached while offline' })])
    expect(cached.health).toBeNull()
    expect(b.health).not.toHaveBeenCalled()
    expect(b.sessions).not.toHaveBeenCalled()
    expect(b.jobs).not.toHaveBeenCalled()

    await service.refreshServer('b', cached.profileGeneration)
    const firstFailure = await service.bootstrap()
    expect(firstFailure.sessions).toEqual([expect.objectContaining({ id: 'cached-b' })])
    expect(firstFailure.profiles.find(profile => profile.id === 'b')).toEqual(expect.objectContaining({
      connectionState: 'retrying',
      lastConnectionError: 'server unreachable'
    }))

    await service.refreshServer('b', cached.profileGeneration)
    const offlinePayload = await service.bootstrap()
    expect(offlinePayload.sessions).toEqual([expect.objectContaining({ id: 'cached-b' })])
    expect(offlinePayload.profiles.find(profile => profile.id === 'b')).toEqual(expect.objectContaining({
      connectionState: 'offline',
      lastConnectionError: 'server unreachable'
    }))
  })

  it('does not report the active server online when health explicitly returns ok false', async () => {
    const unhealthy = fakeClient({ health: async () => ({ ok: false, server_identity: 'server-a' }) })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [unhealthy],
      'http://b.test:7850': [fakeClient()]
    })
    settings.setProfileServerIdentity('a', 'server-a')
    const bootstrap = await service.bootstrap()

    await service.refreshServer('a', bootstrap.profileGeneration)
    const after = await service.bootstrap()

    expect(after.health).toBeNull()
    expect(after.profiles.find(profile => profile.id === 'a')).toEqual(expect.objectContaining({
      connectionState: 'offline',
      lastConnectionError: 'Server health check reported unavailable.'
    }))
  })

  it('drops Team Hub discovery on the first rejected active-server health refresh', async () => {
    const capability = {
      available: true,
      designated_host: true,
      version: 1,
      base_path: '/api/team-hub',
      hub_id: 'hub-stable-a',
      host_server_identity: 'server-a',
      message: 'Team Hub is hosted by this server.',
      action: null
    }
    const health = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        server_identity: 'server-a',
        capabilities: { team_hub_v1: capability }
      })
      .mockRejectedValueOnce(new Error('server connection failed'))
    const active = fakeClient({ health })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [active],
      'http://b.test:7850': [fakeClient()]
    })
    settings.setProfileServerIdentity('a', 'server-a')
    const bootstrap = await service.bootstrap()
    const scope = {
      profileId: 'a',
      profileGeneration: bootstrap.profileGeneration,
      serverIdentity: 'server-a',
      serverUrl: 'http://a.test:7850',
      serverName: 'A'
    }

    await service.refreshServer('a', bootstrap.profileGeneration)
    expect(service.currentTeamHubDiscovery(scope)).toMatchObject({
      available: true,
      hubIdentity: 'hub-stable-a'
    })

    await service.refreshServer('a', bootstrap.profileGeneration)

    expect(service.currentTeamHubDiscovery(scope)).toBeNull()
    expect((await service.bootstrap()).health).toBeNull()
  })

  it('rejects and disposes an explicit unavailable connection test response', async () => {
    const unavailable = fakeClient({ health: async () => ({ ok: false }) })
    const { service } = createProfileService({
      'http://a.test:7850': [fakeClient()],
      'http://b.test:7850': [fakeClient()],
      'http://probe.test:7850': [unavailable]
    })

    await expect(service.testServerConnection({ serverUrl: 'http://probe.test:7850' }))
      .rejects.toThrow('Server health check reported unavailable.')
    expect(unavailable.dispose).toHaveBeenCalledOnce()
  })

  it('reports two independently verified servers online while keeping only one active', async () => {
    const a = fakeClient({ health: async () => ({ ok: true, server_identity: 'server-a' }) })
    const bProbe = fakeClient({ health: async () => ({ ok: true, server_identity: 'server-b' }) })
    const bActive = fakeClient({ health: async () => ({ ok: true, server_identity: 'server-b' }) })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [bProbe, bActive]
    })
    settings.setProfileServerIdentity('a', 'server-a')
    settings.setProfileServerIdentity('b', 'server-b')
    const bootstrap = await service.bootstrap()

    await service.refreshServer('a', bootstrap.profileGeneration)
    await probeInactiveProfiles(service)
    const switched = await service.switchServer('b')
    await service.refreshServer('b', switched.profileGeneration)
    const profiles = (await service.bootstrap()).profiles

    expect(settings.getActiveProfileId()).toBe('b')
    expect(profiles.map(profile => [profile.id, profile.connectionState])).toEqual([
      ['a', 'online'],
      ['b', 'online']
    ])
    expect(bProbe.health).toHaveBeenCalledOnce()
    expect(bProbe.sessions).not.toHaveBeenCalled()
    expect(bProbe.jobs).not.toHaveBeenCalled()
    expect(bProbe.dispose).toHaveBeenCalledOnce()
  })

  it('keeps a healthy active server connected but degraded when tmux is missing', async () => {
    const missingTmux = {
      available: false,
      required: true,
      message: 'tmux is missing; terminal sessions and detached updates are unavailable.',
      action: 'Install tmux, then restart AgentsServer.'
    }
    const a = fakeClient({
      health: async () => ({ ok: true, server_identity: 'server-a', capabilities: { tmux: missingTmux } })
    })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    })
    settings.setProfileServerIdentity('a', 'server-a')
    const bootstrap = await service.bootstrap()

    await service.refreshServer('a', bootstrap.profileGeneration)
    const after = await service.bootstrap()

    expect(after.health).toEqual(expect.objectContaining({ ok: true, capabilities: { tmux: missingTmux } }))
    expect(after.profiles.find(profile => profile.id === 'a')).toEqual(expect.objectContaining({
      connectionState: 'degraded',
      lastConnectionError: missingTmux.message
    }))
    await expect(service.connectTerminal('a', bootstrap.profileGeneration, 'chat', { columns: 80, rows: 24 }))
      .rejects.toThrow(missingTmux.action)
    expect(a.terminal).not.toHaveBeenCalled()
  })

  it('reports an inactive tmux prerequisite warning as degraded and clears it after recovery', async () => {
    const message = 'tmux is missing; terminal sessions and detached updates are unavailable.'
    const missingTmux = fakeClient({
      health: async () => ({
        ok: true,
        server_identity: 'server-b',
        capabilities: { tmux: { available: false, required: true, message, action: 'Install tmux and restart AgentsServer.' } }
      })
    })
    const recovered = fakeClient({
      health: async () => ({
        ok: true,
        server_identity: 'server-b',
        capabilities: { tmux: { available: true, required: true, message: 'tmux is available.', action: null } }
      })
    })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [fakeClient()],
      'http://b.test:7850': [missingTmux, recovered]
    })
    settings.setProfileServerIdentity('b', 'server-b')

    const degraded = await probeInactiveProfiles(service)
    expect(degraded.find(profile => profile.id === 'b')).toEqual(expect.objectContaining({
      connectionState: 'degraded',
      lastConnectionError: message
    }))

    const healthy = await probeInactiveProfiles(service)
    expect(healthy.find(profile => profile.id === 'b')).toEqual(expect.objectContaining({
      connectionState: 'online',
      lastConnectionError: null
    }))
  })

  it('isolates an inactive health failure and recovers it on the next successful probe', async () => {
    const a = fakeClient({ health: async () => ({ ok: true, server_identity: 'server-a' }) })
    const failedProbe = fakeClient({ health: async () => { throw new Error('beta unreachable') } })
    const recoveredProbe = fakeClient({ health: async () => ({ ok: true, server_identity: 'server-b' }) })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [failedProbe, recoveredProbe]
    })
    settings.setProfileServerIdentity('a', 'server-a')
    settings.setProfileServerIdentity('b', 'server-b')
    const bootstrap = await service.bootstrap()
    await service.refreshServer('a', bootstrap.profileGeneration)

    const failed = await probeInactiveProfiles(service)
    expect(failed.find(profile => profile.id === 'a')?.connectionState).toBe('online')
    expect(failed.find(profile => profile.id === 'b')).toEqual(expect.objectContaining({
      connectionState: 'offline',
      lastConnectionError: 'beta unreachable'
    }))

    const recovered = await probeInactiveProfiles(service)
    expect(recovered.find(profile => profile.id === 'a')?.connectionState).toBe('online')
    expect(recovered.find(profile => profile.id === 'b')).toEqual(expect.objectContaining({
      connectionState: 'online',
      lastConnectionError: null
    }))
    expect(failedProbe.dispose).toHaveBeenCalledOnce()
    expect(recoveredProbe.dispose).toHaveBeenCalledOnce()
  })

  it('caches an inactive profile credential between periodic probes', async () => {
    const a = fakeClient()
    const firstProbe = fakeClient({ health: async () => ({ ok: true, server_identity: 'server-b' }) })
    const secondProbe = fakeClient({ health: async () => ({ ok: true, server_identity: 'server-b' }) })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [firstProbe, secondProbe]
    })
    settings.setProfileServerIdentity('b', 'server-b')
    const accessToken = vi.spyOn(settings, 'accessTokenForConnectionAsync')

    await probeInactiveProfiles(service)
    await probeInactiveProfiles(service)

    expect(accessToken).toHaveBeenCalledOnce()
    expect(accessToken).toHaveBeenCalledWith('b')
  })

  it('never paints an inactive profile green when its canonical identity changes', async () => {
    const a = fakeClient()
    const wrongServer = fakeClient({ health: async () => ({ ok: true, server_identity: 'unexpected-b' }) })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [wrongServer]
    })
    settings.setProfileServerIdentity('b', 'server-b')

    const profiles = await probeInactiveProfiles(service)

    expect(profiles.find(profile => profile.id === 'b')).toEqual(expect.objectContaining({
      connectionState: 'offline',
      lastConnectionError: expect.stringContaining('Server identity changed from server-b to unexpected-b')
    }))
    expect(settings.getProfile('b')?.serverIdentity).toBe('server-b')
    expect(wrongServer.dispose).toHaveBeenCalledOnce()
  })

  it('keeps an unpinned inactive profile unknown after a successful health response', async () => {
    const a = fakeClient()
    const unpinned = fakeClient({ health: async () => ({ ok: true, server_identity: 'new-server-b' }) })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [unpinned]
    })

    const profiles = await probeInactiveProfiles(service)

    expect(profiles.find(profile => profile.id === 'b')).toEqual(expect.objectContaining({
      connectionState: 'cached',
      lastConnectionError: null
    }))
    expect(settings.getProfile('b')?.serverIdentity).toBeNull()
  })

  it('expires an inactive green status back to cached when its verification is stale', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const a = fakeClient()
    const bProbe = fakeClient({ health: async () => ({ ok: true, server_identity: 'server-b' }) })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [bProbe]
    })
    settings.setProfileServerIdentity('b', 'server-b')

    expect((await probeInactiveProfiles(service)).find(profile => profile.id === 'b')?.connectionState).toBe('online')
    now.mockReturnValue(76_001)

    expect((await service.bootstrap()).profiles.find(profile => profile.id === 'b')?.connectionState).toBe('cached')
  })

  it('disposes an inactive probe and immediately rescans the formerly active profile after a switch', async () => {
    const lateHealth = deferred<Health>()
    const a = fakeClient()
    const aProbe = fakeClient({ health: async () => ({ ok: true, server_identity: 'server-a' }) })
    const bProbe = fakeClient({ health: () => lateHealth.promise })
    const bActive = fakeClient()
    const { service, settings } = createProfileService({
      'http://a.test:7850': [a, aProbe],
      'http://b.test:7850': [bProbe, bActive]
    })
    settings.setProfileServerIdentity('a', 'server-a')
    settings.setProfileServerIdentity('b', 'server-b')
    ;(service as unknown as { running: boolean }).running = true

    const pendingProfiles = (service as unknown as { refreshInactiveProfileHealth(): Promise<void> }).refreshInactiveProfileHealth()
    await vi.waitFor(() => expect(bProbe.health).toHaveBeenCalledOnce())
    await service.switchServer('b')
    expect(bProbe.dispose).toHaveBeenCalledOnce()
    lateHealth.resolve({ ok: true, server_identity: 'server-b' })
    await pendingProfiles
    await vi.waitFor(() => expect(aProbe.health).toHaveBeenCalledOnce())

    expect((await service.bootstrap()).profiles.find(profile => profile.id === 'b')?.connectionState).toBe('connecting')
    expect(bActive.dispose).not.toHaveBeenCalled()
  })

  it('times out and disposes a stalled inactive health probe', async () => {
    vi.useFakeTimers()
    try {
      const never = deferred<Health>()
      const a = fakeClient()
      const stalled = fakeClient({ health: () => never.promise })
      const { service, settings } = createProfileService({
        'http://a.test:7850': [a],
        'http://b.test:7850': [stalled]
      })
      settings.setProfileServerIdentity('b', 'server-b')

      const pending = (service as unknown as { refreshInactiveProfileHealth(): Promise<void> }).refreshInactiveProfileHealth()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(5_000)
      await pending
      const profiles = (await service.bootstrap()).profiles

      expect(profiles.find(profile => profile.id === 'b')).toEqual(expect.objectContaining({
        connectionState: 'offline',
        lastConnectionError: 'Server health check timed out after 5 seconds.'
      }))
      expect(stalled.dispose).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects the original A generation after a rapid A to B to A switch', async () => {
    const lateA = deferred<Session[]>()
    const firstA = fakeClient({ sessions: () => lateA.promise })
    const b = fakeClient({ sessions: async () => [{ id: 'same', title: 'B final', backend: 'codex' }] })
    const finalA = fakeClient({ sessions: async () => [{ id: 'same', title: 'A final', backend: 'codex' }] })
    const { service, cache } = createProfileService({
      'http://a.test:7850': [firstA, finalA],
      'http://b.test:7850': [b]
    }, value => {
      value.putSession('profile:a', { id: 'same', title: 'A cached', backend: 'codex' })
      value.putSession('profile:b', { id: 'same', title: 'B cached', backend: 'codex' })
    })

    const originalRefresh = (service as unknown as {
      refreshAll(announce: boolean, includeJobs: boolean): Promise<void>
    }).refreshAll(false, true)
    const bPayload = await service.switchServer('b')
    const finalPayload = await service.switchServer('a')
    expect(finalPayload.profileGeneration).toBeGreaterThan(bPayload.profileGeneration)
    await service.refreshServer('a', finalPayload.profileGeneration)

    lateA.resolve([{ id: 'same', title: 'A stale generation', backend: 'codex' }])
    await originalRefresh
    await settleBackgroundWork()

    expect(cache.session('profile:a', 'same')).toEqual(expect.objectContaining({ title: 'A final' }))
    expect((await service.bootstrap()).sessions).toEqual([
      expect.objectContaining({ id: 'same', title: 'A final' })
    ])
  })

  it('keeps the connection generation stable and moves fallback cache after canonical identity adoption', async () => {
    const a = fakeClient({
      health: async () => ({ ok: true, server_identity: 'canonical-a', server_version: '1.4.2' }),
      sessions: async () => [{ id: 'chat', title: 'Canonical A', backend: 'codex' }]
    })
    const b = fakeClient()
    const { service, cache, settings } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    }, value => {
      value.putSession('http://a.test:7850', { id: 'legacy', title: 'Legacy URL cache', backend: 'codex' })
      value.putPreference('http://a.test:7850', 'legacyMarker', true)
      value.putPreference('canonical-a', 'draft:chat', 'canonical draft')
    })
    const before = await service.bootstrap()
    const fallbackScope = { profileId: 'a', profileGeneration: before.profileGeneration, serverIdentity: null }

    await (service as unknown as {
      refreshAll(announce: boolean, includeJobs: boolean): Promise<void>
    }).refreshAll(false, true)
    await settleBackgroundWork()
    const after = await service.bootstrap()

    expect(after.profileGeneration).toBe(before.profileGeneration)
    expect(a.health).toHaveBeenCalledOnce()
    expect(a.sessions).toHaveBeenCalledOnce()
    expect(settings.getProfile('a')?.serverIdentity).toBe('canonical-a')
    expect(cache.sessions('http://a.test:7850')).toEqual([])
    expect(cache.sessions('profile:a')).toEqual([])
    expect(cache.sessions('canonical-a')).toEqual([expect.objectContaining({ id: 'chat' })])
    expect(cache.preference('canonical-a', 'legacyMarker', false)).toBe(true)
    expect(cache.preference('canonical-a', 'serverVersion:v1', null)).toBe('1.4.2')
    expect(after.profiles.find(profile => profile.id === 'a')?.serverVersion).toBe('1.4.2')
    expect(() => service.putScopedPreference(fallbackScope, 'draft:chat', 'stale fallback draft')).toThrow('superseded')
    expect(cache.preference('canonical-a', 'draft:chat', '')).toBe('canonical draft')
    expect(service.scopedPreference({ ...fallbackScope, serverIdentity: 'canonical-a' }, 'draft:chat', '')).toBe('canonical draft')
  })

  it('does not apply sessions when a saved profile reports a changed canonical identity', async () => {
    const { settings } = profileSettings()
    settings.setProfileServerIdentity('a', 'expected-a')
    const cache = new LocalCache(':memory:')
    cache.putSession('expected-a', { id: 'same', title: 'Trusted cache', backend: 'codex' })
    const client = fakeClient({
      health: async () => ({ ok: true, server_identity: 'unexpected-a' }),
      sessions: async () => [{ id: 'same', title: 'Wrong server data', backend: 'codex' }]
    })
    const service = new AppService({
      settings,
      cache,
      clientFactory: () => client as unknown as AgentServerClient
    })
    cleanup.push(() => { service.stop(); cache.close() })

    await (service as unknown as {
      refreshAll(announce: boolean, includeJobs: boolean): Promise<void>
    }).refreshAll(false, true)

    expect(settings.getProfile('a')?.serverIdentity).toBe('expected-a')
    expect(cache.session('expected-a', 'same')).toEqual(expect.objectContaining({ title: 'Trusted cache' }))
    expect(cache.sessions('unexpected-a')).toEqual([])
    expect(service.getActiveServer().lastConnectionError).toContain('Server identity changed')
  })

  it('rejects a canonical identity already owned by another profile', async () => {
    const { settings } = profileSettings()
    settings.setProfileServerIdentity('b', 'owned-by-b')
    const cache = new LocalCache(':memory:')
    cache.putSession('profile:a', { id: 'same', title: 'A cache', backend: 'codex' })
    const client = fakeClient({
      health: async () => ({ ok: true, server_identity: 'owned-by-b' }),
      sessions: async () => [{ id: 'same', title: 'Duplicate server data', backend: 'codex' }]
    })
    const service = new AppService({
      settings,
      cache,
      clientFactory: () => client as unknown as AgentServerClient
    })
    cleanup.push(() => { service.stop(); cache.close() })

    await (service as unknown as {
      refreshAll(announce: boolean, includeJobs: boolean): Promise<void>
    }).refreshAll(false, true)

    expect(settings.getProfile('a')?.serverIdentity).toBeNull()
    expect(cache.session('profile:a', 'same')).toEqual(expect.objectContaining({ title: 'A cache' }))
    expect(service.getActiveServer().lastConnectionError).toContain('already belongs to')
  })

  it('uses different local file cache paths for the same file ID on different profiles', async () => {
    const a = fakeClient()
    const b = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })
    const internals = service as unknown as {
      captureScope(): unknown
      localFilePath(scope: unknown, sessionId: string, file: { id: string; filename: string }): string
    }
    const aPath = internals.localFilePath(internals.captureScope(), 'chat', { id: 'same-file', filename: 'result.txt' })
    await service.switchServer('b')
    const bPath = internals.localFilePath(internals.captureScope(), 'chat', { id: 'same-file', filename: 'result.txt' })

    expect(aPath).not.toBe(bPath)
    expect(aPath).toContain('AgentsDockFiles')
    expect(bPath).toContain('AgentsDockFiles')
  })

  it('never serves an old profile media URL from the new profile with the same file ID', async () => {
    const lateAResponse = deferred<Response>()
    const a = fakeClient({ fileRequest: () => lateAResponse.promise })
    const b = fakeClient({ fileRequest: async () => new Response('profile B file') })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })
    await (service as unknown as {
      refreshAll(announce: boolean, includeJobs: boolean): Promise<void>
    }).refreshAll(false, false)
    const request = new Request('https://media.invalid/same-file')
    const aGeneration = (await service.bootstrap()).profileGeneration
    const staleResponse = service.mediaResponse('a', aGeneration, 'chat', 'same-file', request)
    await Promise.resolve()
    await Promise.resolve()
    expect(a.fileRequest).toHaveBeenCalledWith('chat', 'same-file', request)

    await service.switchServer('b')
    lateAResponse.resolve(new Response('profile A file'))

    await expect(staleResponse).rejects.toThrow('superseded')
    await expect(service.mediaResponse('a', aGeneration, 'chat', 'same-file', request)).rejects.toThrow('superseded')
    expect(b.fileRequest).not.toHaveBeenCalled()

    await settleBackgroundWork()
    const bGeneration = (await service.bootstrap()).profileGeneration
    const activeResponse = await service.mediaResponse('b', bGeneration, 'chat', 'same-file', request)
    expect(await activeResponse.text()).toBe('profile B file')
    expect(b.fileRequest).toHaveBeenCalledWith('chat', 'same-file', request)
  })

  it('never serves an old profile workspace media URL after the profile generation changes', async () => {
    const lateAResponse = deferred<Response>()
    const a = fakeClient({ workspacePreviewRequest: () => lateAResponse.promise })
    const b = fakeClient({ workspacePreviewRequest: async () => new Response('profile B workspace file') })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })
    await (service as unknown as {
      refreshAll(announce: boolean, includeJobs: boolean): Promise<void>
    }).refreshAll(false, false)
    const request = new Request('agentsdock-media://workspace/a/1/chat/assets%2Fsame.png', {
      headers: { Range: 'bytes=0-99' }
    })
    const aGeneration = (await service.bootstrap()).profileGeneration
    const staleResponse = service.workspaceMediaResponse(
      'a',
      aGeneration,
      'chat',
      'assets/same.png',
      request
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(a.workspacePreviewRequest).toHaveBeenCalledWith('chat', 'assets/same.png', request)

    await service.switchServer('b')
    lateAResponse.resolve(new Response('profile A workspace file'))

    await expect(staleResponse).rejects.toThrow('superseded')
    await expect(service.workspaceMediaResponse(
      'a',
      aGeneration,
      'chat',
      'assets/same.png',
      request
    )).rejects.toThrow('superseded')
    expect(b.workspacePreviewRequest).not.toHaveBeenCalled()

    await settleBackgroundWork()
    const bGeneration = (await service.bootstrap()).profileGeneration
    const activeResponse = await service.workspaceMediaResponse(
      'b',
      bGeneration,
      'chat',
      'assets/same.png',
      request
    )
    expect(await activeResponse.text()).toBe('profile B workspace file')
    expect(b.workspacePreviewRequest).toHaveBeenCalledWith('chat', 'assets/same.png', request)
  })

  it('routes notification clicks to the authenticated profile without switching in the main process', async () => {
    electronHarness.notificationSupported = true
    const { service, settings } = createProfileService({
      'http://a.test:7850': [fakeClient()],
      'http://b.test:7850': [fakeClient()]
    }, cache => {
      cache.putSession('profile:a', { id: 'same', title: 'A chat', backend: 'codex' })
    })
    settings.setProfileServerIdentity('a', 'server-a')
    const send = vi.fn()
    const window = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: {
        send,
        isDestroyed: vi.fn(() => false),
        isLoadingMainFrame: vi.fn(() => false)
      }
    }
    ;(service as unknown as { windows: Set<unknown> }).windows = new Set([window])

    await service.notify({
      title: 'A chat',
      body: 'New agent message',
      profileId: 'a',
      serverIdentity: 'spoofed-payload-identity',
      sessionId: 'same'
    })

    expect(electronHarness.notifications).toHaveLength(0)
    await service.notify({
      title: 'A chat',
      body: 'New agent message',
      profileId: 'a',
      serverIdentity: 'server-a',
      sessionId: 'same'
    })

    expect(electronHarness.notifications).toHaveLength(1)
    expect(electronHarness.notifications[0]).toMatchObject({ shown: true })
    electronHarness.notifications[0].click?.()

    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
    expect(service.rendererReadyForNotificationRoutes(window as never)).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('native:notification', {
      profileId: 'a',
      serverIdentity: 'server-a',
      sessionId: 'same'
    })
  })

  it('notifies from the main session stream and deduplicates renderer delivery by alert ID', async () => {
    electronHarness.notificationSupported = true
    const { service, settings } = createProfileService({
      'http://a.test:7850': [fakeClient()],
      'http://b.test:7850': [fakeClient()]
    }, cache => {
      cache.putSession('profile:a', {
        id: 'urgent', title: 'Production watch', backend: 'codex',
        emergency_alert: null, unacknowledged_emergency_count: 0
      })
    })
    settings.setProfileServerIdentity('a', 'server-a')
    const alertId = `emergency_${'d'.repeat(32)}`
    const active: Session = {
      id: 'urgent', title: 'Production watch', backend: 'codex',
      emergency_alert: {
        id: alertId,
        status: 'active', severity: 'critical',
        message: 'Production writes may be lost.',
        raised_at: '2026-08-25T12:00:00Z'
      },
      unacknowledged_emergency_count: 1
    }
    const internals = service as unknown as {
      scope: unknown
      sessions: Session[]
      emitSessions(scope: unknown, sessions: Session[]): void
    }
    internals.sessions = [active]

    internals.emitSessions(internals.scope, [active])
    internals.emitSessions(internals.scope, [active])
    await service.notify({
      title: 'EMERGENCY · Production watch',
      body: 'Production writes may be lost.',
      profileId: 'a',
      serverIdentity: 'server-a',
      sessionId: 'urgent',
      emergencyAlertId: alertId
    })

    expect(electronHarness.notifications).toHaveLength(1)
    expect(electronHarness.notifications[0]).toMatchObject({
      shown: true,
      options: {
        title: 'EMERGENCY · Production watch',
        body: 'Production writes may be lost.',
        silent: false
      }
    })
  })
})

describe('service stop and restart', () => {
  it('creates a fresh client and ignores a late completion from the disposed scope', async () => {
    const lateSessions = deferred<Session[]>()
    const stopped = fakeClient({ sessions: () => lateSessions.promise })
    const restarted = fakeClient({ sessions: async () => [{ id: 'chat', title: 'Restarted client', backend: 'codex' }] })
    const { service } = createProfileService({
      'http://a.test:7850': [stopped, restarted],
      'http://b.test:7850': [fakeClient(), fakeClient()]
    })

    service.start()
    await vi.waitFor(() => expect(stopped.sessions).toHaveBeenCalledOnce())
    const beforeStop = await service.bootstrap()
    service.stop()
    service.start()
    await vi.waitFor(() => expect(restarted.sessions).toHaveBeenCalledOnce())
    await settleBackgroundWork()
    const afterRestart = await service.bootstrap()
    expect(afterRestart.profileGeneration).toBeGreaterThan(beforeStop.profileGeneration)
    expect(afterRestart.sessions).toEqual([expect.objectContaining({ title: 'Restarted client' })])
    expect(stopped.dispose).toHaveBeenCalledOnce()

    lateSessions.resolve([{ id: 'chat', title: 'Late disposed result', backend: 'codex' }])
    await settleBackgroundWork()
    expect((await service.bootstrap()).sessions).toEqual([expect.objectContaining({ title: 'Restarted client' })])
  })

  it('clears the inactive health timer and aborts its temporary client on stop', async () => {
    const lateHealth = deferred<Health>()
    const a = fakeClient()
    const bProbe = fakeClient({ health: () => lateHealth.promise })
    const { service, settings } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [bProbe]
    })
    settings.setProfileServerIdentity('b', 'server-b')
    const internals = service as unknown as { profileHealthPollTimer: NodeJS.Timeout | null }

    service.start()
    await vi.waitFor(() => expect(bProbe.health).toHaveBeenCalledOnce())
    expect(internals.profileHealthPollTimer).not.toBeNull()
    service.stop()

    expect(internals.profileHealthPollTimer).toBeNull()
    expect(bProbe.dispose).toHaveBeenCalledOnce()
    lateHealth.resolve({ ok: true, server_identity: 'server-b' })
    await settleBackgroundWork()
    expect((await service.bootstrap()).profiles.find(profile => profile.id === 'b')?.connectionState).toBe('cached')
  })

  it('rejects a save destination chosen after the connection scope changes', async () => {
    const chosen = deferred<{ canceled: boolean; filePath: string }>()
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-save-race-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const destination = join(directory, 'same.txt')
    electronHarness.showSaveDialog.mockReturnValue(chosen.promise)
    const a = fakeClient()
    const b = fakeClient()
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [b]
    })

    const pending = service.saveFile('chat', { id: 'same-file', filename: 'same.txt', content_type: 'text/plain' })
    await service.switchServer('b')
    chosen.resolve({ canceled: false, filePath: destination })

    await expect(pending).rejects.toThrow('superseded')
    expect(a.fileRequest).not.toHaveBeenCalled()
    expect(b.fileRequest).not.toHaveBeenCalled()
    expect(existsSync(destination)).toBe(false)
  })
})

describe('rapid profile resource teardown', () => {
  const portForwardingHealth = (serverIdentity = 'server-a', perSessionLimit = 16): Health => ({
    ok: true,
    server_identity: serverIdentity,
    capabilities: {
      port_forwarding_v1: {
        version: 1,
        available: true,
        required: false,
        message: 'Port forwarding is available.',
        action: null,
        max_active_connections_per_session: perSessionLimit
      }
    }
  })

  it('disposes idle port listeners when background polling archives or removes known chats', async () => {
    const disposeSession = vi.fn()
    const manager = {
      list: vi.fn(() => []), start: vi.fn(), stop: vi.fn(), url: vi.fn(),
      disposeAll: vi.fn(), disposeSession
    } as unknown as PortTunnelManager
    const client = fakeClient({
      sessions: async () => [{ id: 'archived-chat', title: 'Archived', backend: 'codex', archived: true }]
    })
    const { service } = createProfileService({
      'http://a.test:7850': [client],
      'http://b.test:7850': [fakeClient()]
    }, cache => {
      cache.putSessions('profile:a', [
        { id: 'archived-chat', title: 'Active before polling', backend: 'codex', archived: false },
        { id: 'deleted-chat', title: 'Deleted elsewhere', backend: 'codex', archived: false }
      ])
    }, manager)
    await (service as unknown as {
      refreshAll(announce: boolean, includeJobs: boolean): Promise<void>
    }).refreshAll(false, false)

    expect(disposeSession).toHaveBeenCalledTimes(2)
    expect(disposeSession).toHaveBeenCalledWith('archived-chat')
    expect(disposeSession).toHaveBeenCalledWith('deleted-chat')
  })

  it('gates port forwarding on the authenticated server capability', async () => {
    const start = vi.fn()
    const manager = {
      list: vi.fn(() => []), start, stop: vi.fn(), url: vi.fn(), disposeAll: vi.fn()
    } as unknown as PortTunnelManager
    const { service } = createProfileService({
      'http://a.test:7850': [fakeClient()],
      'http://b.test:7850': [fakeClient()]
    }, undefined, manager)
    const payload = await service.bootstrap()
    await service.refreshServer('a', payload.profileGeneration)

    await expect(service.startForwardedPort('a', payload.profileGeneration, 'chat-a', 7007))
      .rejects.toThrow('does not support port forwarding')
    expect(start).not.toHaveBeenCalled()
  })

  it('passes the authenticated server aggregate connection budget to the tunnel manager', async () => {
    const start = vi.fn(async (
      sessionId: string,
      remotePort: number
    ) => ({
      sessionId, remotePort, localPort: 17007,
      localUrl: 'http://127.0.0.1:17007', state: 'open' as const, error: null
    }))
    const manager = {
      list: vi.fn(() => []), start, stop: vi.fn(), url: vi.fn(),
      disposeAll: vi.fn(), disposeSession: vi.fn(), disposeIfOwned: vi.fn()
    } as unknown as PortTunnelManager
    const client = fakeClient({
      health: async () => portForwardingHealth('server-a', 7),
      sessions: async () => [{ id: 'chat-a', title: 'Chat', backend: 'codex', archived: false }]
    })
    const { service } = createProfileService({ 'http://a.test:7850': [client] }, undefined, manager)
    const initial = await service.bootstrap()
    await service.refreshServer('a', initial.profileGeneration)

    await service.startForwardedPort('a', initial.profileGeneration, 'chat-a', 7007)

    expect(start).toHaveBeenCalledWith(
      'chat-a', 7007, undefined, expect.any(Function), 7
    )
  })

  it('rejects missing, archived, and stale chats before creating a forwarded listener', async () => {
    const start = vi.fn()
    const manager = {
      list: vi.fn(() => []), start, stop: vi.fn(), url: vi.fn(),
      disposeAll: vi.fn(), disposeSession: vi.fn()
    } as unknown as PortTunnelManager
    const a = fakeClient({
      health: async () => portForwardingHealth(),
      sessions: async () => [
        { id: 'active-chat', title: 'Active', backend: 'codex', archived: false },
        { id: 'archived-chat', title: 'Archived', backend: 'codex', archived: true }
      ]
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    }, undefined, manager)
    const initial = await service.bootstrap()
    await service.refreshServer('a', initial.profileGeneration)

    await expect(service.startForwardedPort('a', initial.profileGeneration, 'missing-chat', 7007))
      .rejects.toThrow('no longer available')
    await expect(service.startForwardedPort('a', initial.profileGeneration, 'archived-chat', 7007))
      .rejects.toThrow('Archived chats cannot open port forwards')

    await service.switchServer('b')
    await expect(service.startForwardedPort('a', initial.profileGeneration, 'active-chat', 7007))
      .rejects.toThrow('superseded')
    expect(start).not.toHaveBeenCalled()
  })

  it('disposes a listener whose chat is archived while manager start is pending', async () => {
    const delayedStart = deferred<{
      sessionId: string
      remotePort: number
      localPort: number
      localUrl: string
      state: 'open'
      error: null
    }>()
    let archived = false
    const disposeSession = vi.fn()
    const disposeIfOwned = vi.fn()
    let startedSocketFactory: (() => WebSocket) | null = null
    const manager = {
      list: vi.fn(() => []),
      start: vi.fn((
        _sessionId: string,
        _remotePort: number,
        _preferredLocalPort: number | undefined,
        createRemoteSocket: () => WebSocket
      ) => {
        startedSocketFactory = createRemoteSocket
        return delayedStart.promise
      }),
      stop: vi.fn(),
      url: vi.fn(),
      disposeAll: vi.fn(),
      disposeSession,
      disposeIfOwned
    } as unknown as PortTunnelManager
    const a = fakeClient({
      health: async () => portForwardingHealth(),
      sessions: async () => [{ id: 'chat-a', title: 'Chat', backend: 'codex', archived }]
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    }, undefined, manager)
    const initial = await service.bootstrap()
    await service.refreshServer('a', initial.profileGeneration)

    const pending = service.startForwardedPort('a', initial.profileGeneration, 'chat-a', 7007)
    await vi.waitFor(() => expect(manager.start).toHaveBeenCalledOnce())
    archived = true
    await service.refreshServer('a', initial.profileGeneration)
    expect(disposeSession).toHaveBeenCalledTimes(1)

    delayedStart.resolve({
      sessionId: 'chat-a', remotePort: 7007, localPort: 17007,
      localUrl: 'http://127.0.0.1:17007', state: 'open', error: null
    })
    await expect(pending).rejects.toThrow('Archived chats cannot open port forwards')
    expect(disposeSession).toHaveBeenCalledOnce()
    expect(disposeIfOwned).toHaveBeenCalledOnce()
    expect(disposeIfOwned).toHaveBeenCalledWith('chat-a', 7007, startedSocketFactory)
  })

  it.each([
    ['the health request is rejected', async () => { throw new Error('server connection failed') }],
    ['the validated server identity disappears', async () => ({ ok: true })],
    ['the port-forwarding capability disappears', async () => ({ ok: true, server_identity: 'server-a' })]
  ])('disposes every forwarded listener when %s', async (_label, nextHealth) => {
    const health = vi.fn()
      .mockResolvedValueOnce(portForwardingHealth())
      .mockImplementationOnce(nextHealth)
    const disposeAll = vi.fn()
    const manager = {
      list: vi.fn(() => []), start: vi.fn(), stop: vi.fn(), url: vi.fn(),
      disposeAll, disposeSession: vi.fn()
    } as unknown as PortTunnelManager
    const a = fakeClient({
      health,
      sessions: async () => [{ id: 'chat-a', title: 'Chat', backend: 'codex', archived: false }]
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    }, undefined, manager)
    const initial = await service.bootstrap()
    await service.refreshServer('a', initial.profileGeneration)
    expect(disposeAll).not.toHaveBeenCalled()

    await service.refreshServer('a', initial.profileGeneration)

    expect(disposeAll).toHaveBeenCalledOnce()
  })

  it('keeps a stored socket factory fail-closed after health validation is lost', async () => {
    const health = vi.fn()
      .mockResolvedValueOnce(portForwardingHealth())
      .mockRejectedValueOnce(new Error('server connection failed'))
    const a = fakeClient({
      health,
      sessions: async () => [{ id: 'chat-a', title: 'Chat', backend: 'codex', archived: false }]
    })
    let createRemoteSocket: (() => WebSocket) | null = null
    const manager = {
      list: vi.fn(() => []),
      start: vi.fn(async (
        sessionId: string,
        remotePort: number,
        _preferredLocalPort: number | undefined,
        factory: () => WebSocket
      ) => {
        createRemoteSocket = factory
        return {
          sessionId, remotePort, localPort: 17007,
          localUrl: 'http://127.0.0.1:17007', state: 'open' as const, error: null
        }
      }),
      stop: vi.fn(),
      url: vi.fn(),
      disposeAll: vi.fn(),
      disposeSession: vi.fn()
    } as unknown as PortTunnelManager
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    }, undefined, manager)
    const initial = await service.bootstrap()
    await service.refreshServer('a', initial.profileGeneration)
    await service.startForwardedPort('a', initial.profileGeneration, 'chat-a', 7007)
    expect(createRemoteSocket).not.toBeNull()

    await service.refreshServer('a', initial.profileGeneration)

    expect(() => createRemoteSocket?.()).toThrow('has not passed its identity check')
    expect(a.portTunnelSocket).not.toHaveBeenCalled()
  })

  it('shares one remote-port listener across chats and emits profile-wide snapshots', async () => {
    const manager = new PortTunnelManager()
    const a = fakeClient({
      health: async () => portForwardingHealth(),
      sessions: async () => [
        { id: 'chat-a', title: 'Chat A', backend: 'codex', archived: false },
        { id: 'chat-b', title: 'Chat B', backend: 'codex', archived: false }
      ]
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    }, undefined, manager)
    const send = vi.fn()
    service.addWindow({ isDestroyed: () => false, on: vi.fn(), webContents: { send } } as never)
    const initial = await service.bootstrap()
    await service.refreshServer('a', initial.profileGeneration)

    const fromA = await service.startForwardedPort('a', initial.profileGeneration, 'chat-a', 7007)
    const fromB = await service.startForwardedPort('a', initial.profileGeneration, 'chat-b', 7007)

    expect(fromB).toEqual(fromA)
    expect(fromB.sessionId).toBe('chat-a')
    expect(service.listForwardedPorts('a', initial.profileGeneration)).toEqual([fromA])
    expect(send).toHaveBeenCalledWith('ports:changed', {
      profileId: 'a',
      profileGeneration: initial.profileGeneration,
      ports: [fromA]
    })

    await service.openForwardedPort('a', initial.profileGeneration, 7007)
    expect(electronHarness.shellOpenExternal).toHaveBeenCalledWith(fromA.localUrl)
    await service.stopForwardedPort('a', initial.profileGeneration, 7007)
    expect(service.listForwardedPorts('a', initial.profileGeneration)).toEqual([])
    expect(send).toHaveBeenLastCalledWith('ports:changed', {
      profileId: 'a',
      profileGeneration: initial.profileGeneration,
      ports: []
    })

    await service.startForwardedPort('a', initial.profileGeneration, 'chat-a', 8080)
    send.mockClear()
    await service.switchServer('b')
    expect(send.mock.calls.filter(([name]) => name === 'ports:changed')).toEqual([])
  })

  it('does not let a failed duplicate request dispose another chat owner\'s tunnel', async () => {
    const manager = new PortTunnelManager()
    const a = fakeClient({
      health: async () => portForwardingHealth(),
      sessions: async () => [
        { id: 'chat-a', title: 'Chat A', backend: 'codex', archived: false },
        { id: 'chat-b', title: 'Chat B', backend: 'codex', archived: false }
      ]
    })
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    }, undefined, manager)
    const initial = await service.bootstrap()
    await service.refreshServer('a', initial.profileGeneration)
    const ownedByA = await service.startForwardedPort('a', initial.profileGeneration, 'chat-a', 7007)
    const duplicate = deferred<typeof ownedByA>()
    const start = vi.spyOn(manager, 'start').mockReturnValueOnce(duplicate.promise)
    const disposeIfOwned = vi.spyOn(manager, 'disposeIfOwned')

    const pending = service.startForwardedPort('a', initial.profileGeneration, 'chat-b', 7007)
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    const internals = service as unknown as { sessions: Session[] }
    internals.sessions = internals.sessions.map(session => (
      session.id === 'chat-b' ? { ...session, archived: true } : session
    ))
    duplicate.resolve(ownedByA)

    await expect(pending).rejects.toThrow('Archived chats cannot open port forwards')
    expect(disposeIfOwned).toHaveBeenCalledWith('chat-b', 7007, expect.any(Function))
    expect(manager.list()).toEqual([ownedByA])
  })

  it('fences port forwards by generation and tears them down before a profile switch', async () => {
    const remoteSocket = {} as WebSocket
    const a = fakeClient({
      health: async () => portForwardingHealth(),
      sessions: async () => [{ id: 'chat-a', title: 'Chat', backend: 'codex', archived: false }],
      portTunnelSocket: () => remoteSocket
    })
    const disposeAll = vi.fn()
    const start = vi.fn(async (
      sessionId: string,
      remotePort: number,
      _preferredLocalPort: number | undefined,
      createRemoteSocket: () => WebSocket
    ) => {
      expect(createRemoteSocket()).toBe(remoteSocket)
      return {
        sessionId, remotePort, localPort: 17007,
        localUrl: 'http://127.0.0.1:17007', state: 'open' as const, error: null
      }
    })
    const manager = {
      list: vi.fn(() => []), start, stop: vi.fn(),
      url: vi.fn(() => 'http://127.0.0.1:17007'), disposeAll
    } as unknown as PortTunnelManager
    const { service } = createProfileService({
      'http://a.test:7850': [a],
      'http://b.test:7850': [fakeClient()]
    }, undefined, manager)
    const initial = await service.bootstrap()
    await service.refreshServer('a', initial.profileGeneration)

    await expect(service.startForwardedPort('a', initial.profileGeneration, 'chat-a', 7007, 17007))
      .resolves.toMatchObject({ remotePort: 7007, localPort: 17007, state: 'open' })
    expect(a.portTunnelSocket).toHaveBeenCalledWith('chat-a', 7007)
    await service.openForwardedPort('a', initial.profileGeneration, 7007)
    expect(electronHarness.shellOpenExternal).toHaveBeenCalledWith('http://127.0.0.1:17007')

    await service.switchServer('b')

    expect(disposeAll).toHaveBeenCalledOnce()
    expect(() => service.listForwardedPorts('a', initial.profileGeneration)).toThrow('superseded')
  })

  it('closes each old client and terminal exactly once across ten switches', async () => {
    const terminalConnections: Array<{ write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; scroll: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = []
    const makeClient = () => fakeClient({
      terminal: () => {
        const connection = { write: vi.fn(), resize: vi.fn(), scroll: vi.fn(), close: vi.fn() }
        terminalConnections.push(connection)
        return connection
      }
    })
    const aClients = Array.from({ length: 6 }, makeClient)
    const bClients = Array.from({ length: 5 }, makeClient)
    const allClients = [...aClients, ...bClients]
    const { service } = createProfileService({
      'http://a.test:7850': [...aClients],
      'http://b.test:7850': [...bClients]
    })

    let payload = await service.bootstrap()
    await service.refreshServer('a', payload.profileGeneration)
    await service.connectTerminal('a', payload.profileGeneration, 'shared-terminal', { columns: 80, rows: 24 })
    for (let index = 0; index < 10; index += 1) {
      const profileId = index % 2 === 0 ? 'b' : 'a'
      payload = await service.switchServer(profileId)
      await service.refreshServer(profileId, payload.profileGeneration)
      await service.connectTerminal(profileId, payload.profileGeneration, 'shared-terminal', { columns: 80, rows: 24 })
    }

    expect(terminalConnections).toHaveLength(11)
    expect(terminalConnections.slice(0, -1).every(connection => connection.close.mock.calls.length === 1)).toBe(true)
    expect(terminalConnections.at(-1)?.close).not.toHaveBeenCalled()
    expect(allClients.filter(client => client.dispose.mock.calls.length === 1)).toHaveLength(10)
    expect(allClients.filter(client => client.dispose.mock.calls.length === 0)).toHaveLength(1)
    expect(allClients.some(client => client.dispose.mock.calls.length > 1)).toBe(false)
  })

  it('settles ten fast switches on the final generation without leaking overlapping requests', async () => {
    vi.useFakeTimers()
    let service: AppService | null = null
    try {
      const terminalConnections: Array<{
        owner: string
        write: ReturnType<typeof vi.fn>
        resize: ReturnType<typeof vi.fn>
        scroll: ReturnType<typeof vi.fn>
        close: ReturnType<typeof vi.fn>
      }> = []
      const terminalFor = (owner: string) => () => {
        const connection = { owner, write: vi.fn(), resize: vi.fn(), scroll: vi.fn(), close: vi.fn() }
        terminalConnections.push(connection)
        return connection
      }
      const initialBackground = {
        health: deferred<Health>(),
        sessions: deferred<Session[]>(),
        jobs: deferred<Job[]>()
      }
      let initialHealthCalls = 0
      let initialSessionCalls = 0
      let initialJobCalls = 0
      const initialClient = fakeClient({
        health: () => ++initialHealthCalls === 1 ? Promise.resolve({ ok: true }) : initialBackground.health.promise,
        sessions: () => ++initialSessionCalls === 1 ? Promise.resolve([]) : initialBackground.sessions.promise,
        jobs: () => ++initialJobCalls === 1 ? Promise.resolve([]) : initialBackground.jobs.promise,
        terminal: terminalFor('initial-a')
      })
      const inactiveHealthProbe = fakeClient()
      const switchRequests = Array.from({ length: 10 }, (_, index) => {
        const profileId = index % 2 === 0 ? 'b' : 'a'
        const health = deferred<Health>()
        const sessions = deferred<Session[]>()
        const jobs = deferred<Job[]>()
        const client = fakeClient({
          health: () => health.promise,
          sessions: () => sessions.promise,
          jobs: () => jobs.promise,
          terminal: terminalFor(`switch-${index + 1}-${profileId}`)
        })
        return { profileId, health, sessions, jobs, client }
      })
      const allClients = [initialClient, ...switchRequests.map(request => request.client)]
      const created = createProfileService({
        'http://a.test:7850': [initialClient, ...switchRequests.filter(request => request.profileId === 'a').map(request => request.client)],
        'http://b.test:7850': [inactiveHealthProbe, ...switchRequests.filter(request => request.profileId === 'b').map(request => request.client)]
      })
      service = created.service
      const internals = service as unknown as {
        activeProfileId: string
        profileGeneration: number
        client: AgentServerClient
        windows: Set<unknown>
        pollTimer: NodeJS.Timeout | null
        jobsPollTimer: NodeJS.Timeout | null
        searchBackfillTimer: NodeJS.Timeout | null
        refreshInFlight: Map<number, Promise<void>>
        runtimeRefreshInFlight: Map<number, Promise<void>>
        filesRefreshInFlight: Set<string>
        fileDownloads: Map<string, Promise<string>>
        terminalConnections: Map<string, unknown>
        terminalLeases: Map<string, number>
      }

      const initialPayload = await service.bootstrap()
      await service.refreshServer('a', initialPayload.profileGeneration)
      await service.connectTerminal('a', initialPayload.profileGeneration, 'shared-terminal', { columns: 80, rows: 24 })

      const window = {
        isDestroyed: vi.fn(() => false),
        on: vi.fn(),
        webContents: { send: vi.fn() }
      }
      service.addWindow(window as never)
      service.start()
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
      expect(inactiveHealthProbe.health).toHaveBeenCalledOnce()
      for (let index = 0; index < 5; index += 1) await Promise.resolve()
      expect(inactiveHealthProbe.dispose).toHaveBeenCalledOnce()
      expect(initialClient.health).toHaveBeenCalledTimes(2)
      expect(initialClient.sessions).toHaveBeenCalledTimes(2)
      expect(initialClient.jobs).toHaveBeenCalledTimes(2)
      expect(internals.refreshInFlight.size).toBe(1)
      const pollTimer = internals.pollTimer
      const jobsPollTimer = internals.jobsPollTimer
      const activeTimerCount = vi.getTimerCount()

      // Authentication now yields before activation. Keep this teardown test's
      // deliberately finite client pool focused on foreground generations;
      // inactive-probe scheduling and stale reads are tested independently.
      vi.spyOn(service as unknown as { requestInactiveProfileHealthSweep(): void }, 'requestInactiveProfileHealthSweep').mockImplementation(() => undefined)

      const switches: Array<ReturnType<AppService['switchServer']>> = []
      const refreshes: Array<ReturnType<AppService['refreshServer']>> = []
      const terminalConnects: Array<ReturnType<AppService['connectTerminal']>> = []
      for (const request of switchRequests) {
        switches.push(Promise.resolve(await service.switchServer(request.profileId)))
        const generation = internals.profileGeneration
        refreshes.push(service.refreshServer(request.profileId, generation))
        terminalConnects.push(service.connectTerminal(request.profileId, generation, 'shared-terminal', { columns: 80, rows: 24 }))
      }

      const switchPayloads = await Promise.all(switches)
      expect(switchPayloads.map(payload => payload.profileGeneration)).toEqual(
        Array.from({ length: 10 }, (_, index) => initialPayload.profileGeneration + index + 1)
      )
      expect(internals.activeProfileId).toBe('a')
      expect(internals.profileGeneration).toBe(initialPayload.profileGeneration + 10)
      expect(internals.client).toBe(switchRequests.at(-1)?.client)
      expect(internals.refreshInFlight.size).toBe(1)
      expect(internals.pollTimer).toBe(pollTimer)
      expect(internals.jobsPollTimer).toBe(jobsPollTimer)
      expect(vi.getTimerCount()).toBe(activeTimerCount)
      expect(internals.windows.size).toBe(1)
      expect(window.on).toHaveBeenCalledOnce()
      expect(switchRequests.every(request => request.client.health.mock.calls.length === 1)).toBe(true)
      expect(switchRequests.every(request => request.client.sessions.mock.calls.length === 1)).toBe(true)
      expect(switchRequests.every(request => request.client.jobs.mock.calls.length === 1)).toBe(true)

      for (const [index, request] of [...switchRequests].reverse().entries()) {
        request.health.resolve({ ok: true })
        request.sessions.resolve([{ id: 'shared', title: `Resolved ${10 - index}`, backend: 'codex' }])
        request.jobs.resolve([])
      }
      initialBackground.health.resolve({ ok: true })
      initialBackground.sessions.resolve([{ id: 'stale-initial', title: 'Stale initial request', backend: 'codex' }])
      initialBackground.jobs.resolve([])

      const [refreshResults, terminalResults] = await Promise.all([
        Promise.allSettled(refreshes),
        Promise.allSettled(terminalConnects)
      ])
      for (let index = 0; index < 5; index += 1) await Promise.resolve()

      expect(refreshResults.slice(0, -1).every(result => result.status === 'rejected')).toBe(true)
      expect(refreshResults.at(-1)?.status).toBe('fulfilled')
      expect(terminalResults.slice(0, -1).every(result => result.status === 'rejected')).toBe(true)
      expect(terminalResults.at(-1)?.status).toBe('fulfilled')
      expect((await service.bootstrap())).toEqual(expect.objectContaining({
        activeProfileId: 'a',
        profileGeneration: initialPayload.profileGeneration + 10,
        sessions: [expect.objectContaining({ title: 'Resolved 10' })]
      }))

      expect(terminalConnections).toHaveLength(2)
      expect(terminalConnections[0].close).toHaveBeenCalledOnce()
      expect(terminalConnections[1]).toEqual(expect.objectContaining({ owner: 'switch-10-a' }))
      expect(terminalConnections[1].close).not.toHaveBeenCalled()
      expect(internals.terminalConnections.size).toBe(1)
      expect(internals.terminalLeases.size).toBe(1)
      expect(allClients.filter(client => client.dispose.mock.calls.length === 1)).toHaveLength(10)
      expect(allClients.filter(client => client.dispose.mock.calls.length === 0)).toEqual([switchRequests.at(-1)?.client])
      expect(allClients.some(client => client.dispose.mock.calls.length > 1)).toBe(false)

      expect(internals.refreshInFlight.size).toBe(0)
      expect(internals.runtimeRefreshInFlight.size).toBe(0)
      expect(internals.filesRefreshInFlight.size).toBe(0)
      expect(internals.fileDownloads.size).toBe(0)
      expect(internals.pollTimer).toBe(pollTimer)
      expect(internals.jobsPollTimer).toBe(jobsPollTimer)
      expect(vi.getTimerCount()).toBe(activeTimerCount)
      expect(internals.windows.size).toBe(1)
      expect(window.on).toHaveBeenCalledOnce()
    } finally {
      service?.stop()
      vi.useRealTimers()
    }
  })
})
