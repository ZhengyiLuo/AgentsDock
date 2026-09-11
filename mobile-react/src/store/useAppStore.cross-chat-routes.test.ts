import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentCrossChatRoute, AgentCrossChatRoutesSnapshot, Health, QueuedTurn, Session, TeamReference } from '../types'
import { AgentServerClient, ServerError } from '../api/AgentServerClient'
import { client, useAppStore } from './useAppStore'

const session: Session = { id: 'source', title: 'Source', backend: 'codex' }
const route: AgentCrossChatRoute = { route_id: 'route-1', revision: 'revision-a', alias: 'Target', target_session_id: 'target', actions: ['instruction'], created_at: '2026-09-11T00:00:00Z', updated_at: '2026-09-11T00:00:00Z', target: { title: 'Target', folder: null, backend: 'codex', available: true, unavailable_reason: null } }
const capability = { available: true, version: 10, actions: ['route' as const, 'instruction' as const], supported_target_backends: ['codex' as const], features: { durable_route_grants: true, agent_cross_chat_routes: true, agent_ambient_local_handoffs: false, exact_queued_delivery_skip: true, async_route_v1: true }, agent_routes: { policy: 'default_deny' as const, client_capability: 'agent_cross_chat_routes_v2', async_route_v1: { available: true, client_capability: 'chat_conversation_async_route_v1', mode: 'async_route_v1' as const } } }
const health: Health = { ok: true, server_identity: 'server', server_instance_id: 'instance', capabilities: { cross_chat_handoffs_v1: capability } }
const delivery: QueuedTurn = { queued_id: 'incoming', prompt: 'Message', file_ids: [], purpose: 'cross_chat_handoff_delivery', conversation_mode: 'async_route_v1', cross_chat_envelope_id: 'envelope', session_id: session.id }
const original = { routes: client.agentHandoffRoutes, remove: client.deleteAgentHandoffRoute, queue: client.queue, skip: client.skipQueuedCrossChatDelivery, send: client.sendTurn, update: client.updateQueued, team: client.teamNetworkGet, sync: useAppStore.getState().syncSelectedSession, fetch: globalThis.fetch }
let publicQueue: QueuedTurn[] = []
let sends = 0
let skips = 0
let removes = 0
let updates = 0
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function reset() {
  client.markValidated()
  publicQueue = [delivery]
  sends = skips = removes = updates = 0
  client.agentHandoffRoutes = async () => ({ routes: [route], max_routes: 16 })
  client.deleteAgentHandoffRoute = async () => { removes += 1; return { ok: true, deleted: true, route_id: route.route_id } }
  client.queue = async () => publicQueue
  client.skipQueuedCrossChatDelivery = async () => { skips += 1; publicQueue = [] }
  client.sendTurn = async () => { sends += 1; return { session } }
  client.updateQueued = async () => { updates += 1 }
  useAppStore.setState({
    initialized: true, activeProfileId: 'uninitialized', profileGeneration: 0, connected: true, connecting: false,
    switchingProfileId: null, workspaceAdopting: false, selectedSessionId: session.id, health,
    sessions: [session, { ...session, id: 'target', title: 'Target' }], runtime: null,
    agentRoutesBySession: { [session.id]: { routes: [route], max_routes: 16 } }, agentRouteErrorsBySession: {},
    agentRouteLoadingSessionIds: new Set(), revokingAgentRouteIds: new Set(), skippingQueuedDeliveryIds: new Set(),
    drafts: { [session.id]: 'Hello' }, chatReferencesBySession: {}, teamReferencesBySession: {},
    uploads: {}, uploadPending: {}, uploadFailed: {}, turnAdmissionTokens: {}, sendingSessionIds: new Set(), error: null,
    snapshots: { [session.id]: { session, events: [], queuedTurns: [delivery], files: [], filesTotal: 0, hasMore: false, cachedAt: Date.now() } },
    syncSelectedSession: async () => {},
  })
}
const refresh = () => useAppStore.getState().refreshAgentRoutes(session.id, 0)
const revoke = () => useAppStore.getState().revokeAgentRoute(session.id, route.route_id, route.revision, 0)
const skip = () => useAppStore.getState().skipQueuedDelivery(session.id, delivery.queued_id, 0)
const send = () => useAppStore.getState().sendPrompt(false, 0, session.id)

try {
  await test('route reads publish only the latest request and reject revoked validation', async () => {
    reset()
    const older = deferred<AgentCrossChatRoutesSnapshot>()
    client.agentHandoffRoutes = () => older.promise
    const pending = refresh()
    client.agentHandoffRoutes = async () => ({ routes: [], max_routes: 4 })
    assert.deepEqual(await refresh(), { routes: [], max_routes: 4 })
    older.resolve({ routes: [route], max_routes: 16 })
    assert.equal(await pending, null)
    assert.equal(useAppStore.getState().agentRoutesBySession.source.max_routes, 4)
    const stale = deferred<AgentCrossChatRoutesSnapshot>()
    client.agentHandoffRoutes = () => stale.promise
    const staleRequest = refresh()
    client.revokeValidation()
    stale.resolve({ routes: [route], max_routes: 16 })
    assert.equal(await staleRequest, null)
    assert.equal(useAppStore.getState().agentRoutesBySession.source.max_routes, 4)
    assert.equal(useAppStore.getState().agentRouteLoadingSessionIds.size, 0)
  })

  await test('route revoke is single-flight, blocks same-tick sends, and confirms absence after refresh', async () => {
    reset()
    const removal = deferred<{ ok: true; deleted: boolean; route_id: string }>()
    client.deleteAgentHandoffRoute = async () => { removes += 1; return removal.promise }
    client.agentHandoffRoutes = async () => ({ routes: [], max_routes: 16 })
    const pending = revoke()
    assert.equal(await revoke(), false)
    assert.equal(await send(), false)
    assert.equal(sends, 0)
    removal.resolve({ ok: true, deleted: true, route_id: route.route_id })
    assert.equal(await pending, true)
    assert.equal(removes, 1)
    assert.equal(useAppStore.getState().revokingAgentRouteIds.size, 0)
  })

  await test('revision conflicts refresh the changed grant without retrying its deletion', async () => {
    reset()
    client.deleteAgentHandoffRoute = async () => { removes += 1; throw new ServerError(409, 'Changed', { code: 'route_revision_conflict' }) }
    client.agentHandoffRoutes = async () => ({ routes: [{ ...route, revision: 'revision-new' }], max_routes: 16 })
    assert.equal(await revoke(), false)
    assert.equal(removes, 1)
    assert.equal(useAppStore.getState().agentRoutesBySession.source.routes[0].revision, 'revision-new')
    assert.match(useAppStore.getState().agentRouteErrorsBySession.source ?? '', /review it before revoking again/u)
    assert.equal(await revoke(), false)
    assert.equal(removes, 1)
  })

  await test('a server restart invalidates an in-flight grant removal result', async () => {
    reset()
    const removal = deferred<{ ok: true; deleted: boolean; route_id: string }>()
    client.deleteAgentHandoffRoute = () => removal.promise
    const pending = revoke()
    useAppStore.setState({ health: { ...health, server_instance_id: 'new-instance' } })
    removal.resolve({ ok: true, deleted: true, route_id: route.route_id })
    assert.equal(await pending, false)
    assert.equal(useAppStore.getState().agentRoutesBySession.source.routes.length, 1)
    assert.equal(useAppStore.getState().revokingAgentRouteIds.size, 0)
  })

  await test('a retained grant is reported explicitly and workspace adoption blocks route/skip requests', async () => {
    reset()
    assert.equal(await revoke(), false)
    assert.match(useAppStore.getState().agentRouteErrorsBySession.source ?? '', /still present/u)
    reset()
    useAppStore.setState({ workspaceAdopting: true })
    assert.equal(await refresh(), null)
    assert.equal(await revoke(), false)
    assert.equal(await skip(), false)
    assert.equal(removes + skips, 0)
  })

  await test('skip rereads the exact owner, admits one request, and refreshes after acknowledgement', async () => {
    reset()
    const queueRead = deferred<QueuedTurn[]>()
    client.queue = () => queueRead.promise
    const pending = skip()
    assert.equal(await skip(), false)
    client.queue = async () => publicQueue
    queueRead.resolve([delivery])
    assert.equal(await pending, true)
    assert.equal(skips, 1)
    assert.deepEqual(useAppStore.getState().snapshots.source.queuedTurns, [])
    assert.equal(useAppStore.getState().skippingQueuedDeliveryIds.size, 0)
  })

  await test('skip cannot target a changed queued owner or a promoted message', async () => {
    for (const patch of [{ cross_chat_envelope_id: 'other' }, { promoted: true }]) {
      reset()
      publicQueue = [{ ...delivery, ...patch }]
      assert.equal(await skip(), false)
      assert.equal(skips, 0)
      assert.equal(useAppStore.getState().snapshots.source.queuedTurns[0], publicQueue[0])
    }
  })

  await test('failed skip never removes optimistically and uncertain acknowledgement stays an error', async () => {
    reset()
    client.skipQueuedCrossChatDelivery = async () => { skips += 1; throw new ServerError(409, 'Already starting') }
    assert.equal(await skip(), false)
    assert.equal(useAppStore.getState().snapshots.source.queuedTurns.length, 1)
    assert.match(useAppStore.getState().error ?? '', /Already starting/u)
    reset()
    client.skipQueuedCrossChatDelivery = async () => { skips += 1 }
    assert.equal(await skip(), false)
    assert.match(useAppStore.getState().error ?? '', /not confirmed/u)
  })

  await test('revoking validation during the skip owner read prevents the mutation', async () => {
    reset()
    const queueRead = deferred<QueuedTurn[]>()
    client.queue = () => queueRead.promise
    const pending = skip()
    client.revokeValidation()
    queueRead.resolve([delivery])
    assert.equal(await pending, false)
    assert.equal(skips, 0)
    assert.equal(useAppStore.getState().skippingQueuedDeliveryIds.size, 0)
  })

  await test('a live start during the owner read prevents acting on the stale queued message', async () => {
    reset()
    const read = deferred<QueuedTurn[]>()
    client.queue = () => read.promise
    const pending = skip()
    publicQueue = []
    useAppStore.setState({ snapshots: { source: { ...useAppStore.getState().snapshots.source, queuedTurns: [] } } })
    client.queue = async () => publicQueue
    read.resolve([delivery])
    assert.equal(await pending, false)
    assert.equal(skips, 0)
    assert.deepEqual(useAppStore.getState().snapshots.source.queuedTurns, [])
  })

  await test('a concurrent restored owner prevents a stale empty read from confirming skip success', async () => {
    reset()
    const read = deferred<QueuedTurn[]>()
    const readingConfirmation = deferred<void>()
    let reads = 0
    client.queue = async () => {
      reads += 1
      if (reads === 2) { readingConfirmation.resolve(); return read.promise }
      return publicQueue
    }
    const pending = skip()
    await readingConfirmation.promise
    publicQueue = [{ ...delivery }]
    useAppStore.setState({ snapshots: { source: { ...useAppStore.getState().snapshots.source, queuedTurns: publicQueue } } })
    read.resolve([])
    assert.equal(await pending, false)
    assert.equal(skips, 1)
    assert.equal(useAppStore.getState().snapshots.source.queuedTurns.length, 1)
    assert.match(useAppStore.getState().error ?? '', /not confirmed/u)
  })

  await test('accepted route grants refresh permissions and exhausted capacity blocks before send', async () => {
    reset()
    const reference = { session_id: 'target', display_title_snapshot: 'Target', source_text_start: 0, source_text_end: 7, action: 'route' as const, grant_intent: true as const }
    useAppStore.setState({ drafts: { source: '@Target hello' }, chatReferencesBySession: { source: [reference] }, agentRoutesBySession: { source: { routes: [], max_routes: 0 } } })
    assert.equal(await send(), false)
    assert.equal(sends, 0)
    useAppStore.setState({ agentRoutesBySession: { source: { routes: [], max_routes: 16 } } })
    let reads = 0
    client.agentHandoffRoutes = async () => { reads += 1; return { routes: [route], max_routes: 16 } }
    assert.equal(await send(), true)
    await Promise.resolve()
    assert.equal(reads, 1)
    assert.equal(useAppStore.getState().agentRoutesBySession.source.routes[0].route_id, route.route_id)
  })

  await test('API route reads and revision deletes encode opaque identifiers; async skip sends its envelope', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    globalThis.fetch = async (input, init) => { requests.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null }); return new Response(JSON.stringify({ ok: true, routes: [], max_routes: 16, deleted: true, route_id: 'r /?' }), { status: 200 }) }
    const api = new AgentServerClient('https://example.invalid', 'test')
    await api.agentHandoffRoutes('s /?')
    await api.deleteAgentHandoffRoute('s /?', 'r /?', 'revision /?&')
    await api.skipQueuedCrossChatDelivery('s /?', 'q /?', { cross_chat_envelope_id: 'envelope' })
    assert.match(new URL(requests[0].url).pathname, /\/s%20%2F%3F\/agent-handoff-routes$/u)
    assert.equal(new URL(requests[0].url).searchParams.get('unlimited_routes'), 'true')
    assert.equal(requests[1].method, 'DELETE')
    assert.equal(new URL(requests[1].url).searchParams.get('expected_revision'), 'revision /?&')
    assert.deepEqual(requests[2].body, { cross_chat_envelope_id: 'envelope' })
    assert.equal(requests[2].method, 'POST')
    assert.throws(() => api.deleteAgentHandoffRoute('source', 'route', ''), /Refresh/u)
    api.dispose()
    globalThis.fetch = original.fetch
  })

  await test('native and Hub alias gates protect both sends and queued edits without consuming drafts', async () => {
    const all = { available: true, version: 1, mention: '@@all', recipient_kind: 'all_servers', max_recipients_per_message: 16 }
    const aliasHealth: Health = { ...health, capabilities: { ...health.capabilities, agent_team_messages_v1: { available: true, version: 1, mention_sigil: '@@', send_requires_mention: true }, team_hub_v1: { available: true, version: 1, designated_host: false, base_path: null, server_session_base_path: '/api/team-hub-server', hub_id: 'hub', host_server_identity: 'host' }, team_all_servers_alias_v1: all } }
    const alias: TeamReference = { kind: 'recipient', recipient_kind: 'all_servers', team_id: 'team', target_id: 'all_servers', display_name_snapshot: 'all', source_text_start: 0, source_text_end: 5, grant_intent: true }
    const hub = { hub_id: 'hub', capabilities: { team_messages_v1: { available: true, version: 1 }, team_all_servers_alias_v1: all } }
    const configure = () => { reset(); publicQueue = [{ queued_id: 'editable', prompt: '@@all hello', file_ids: [], team_references: [alias] }]; useAppStore.setState({ health: aliasHealth, drafts: { source: '@@all hello' }, teamReferencesBySession: { source: [alias] }, snapshots: { source: { ...useAppStore.getState().snapshots.source, queuedTurns: publicQueue } } }) }
    configure()
    client.teamNetworkGet = async <T>() => hub as T
    assert.equal(await send(), true)
    assert.equal(sends, 1)
    for (const mutate of [send, () => useAppStore.getState().updateQueued('source', 'editable', '@@all hello', undefined, 0)]) {
      configure()
      client.teamNetworkGet = async <T>() => ({ ...hub, capabilities: { team_messages_v1: { available: true, version: 1 } } }) as T
      assert.equal(await mutate(), false)
      assert.equal(sends + updates, 0)
      assert.equal(useAppStore.getState().drafts.source, '@@all hello')
      configure()
      const read = deferred<unknown>()
      client.teamNetworkGet = <T>() => read.promise as Promise<T>
      const pending = mutate()
      useAppStore.setState({ health: { ...aliasHealth, capabilities: { ...aliasHealth.capabilities, team_all_servers_alias_v1: { ...all, available: false } } } })
      read.resolve(hub)
      assert.equal(await pending, false)
      assert.equal(sends + updates, 0)
    }
  })
} finally {
  client.agentHandoffRoutes = original.routes
  client.deleteAgentHandoffRoute = original.remove
  client.queue = original.queue
  client.skipQueuedCrossChatDelivery = original.skip
  client.sendTurn = original.send
  client.updateQueued = original.update
  client.teamNetworkGet = original.team
  globalThis.fetch = original.fetch
  useAppStore.setState({ syncSelectedSession: original.sync })
}
