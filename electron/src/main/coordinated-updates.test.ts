// @vitest-environment node
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Health, ServerUpdateStatus } from '../shared/types'
import { AgentServerClient, ServerError } from './server-client'
import { CoordinatedUpdateManager, compareReleaseVersions, verifyPairedRelease,
  SERVER_RELEASE_PUBLIC_KEY, type CoordinatedProfile, type CoordinatedUpdatePlan, type SignedServerRelease } from './coordinated-updates'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
function signed(version = '1.2.0-beta.2', extra: Record<string, unknown> = {}): SignedServerRelease {
  const bytes = Buffer.from(JSON.stringify({ schema: 2, distribution: 'npm', version,
    track: version.includes('-') ? 'beta' : 'stable', api_contract_version: 28, minimum_server_api_contract: 8, ...extra }))
  return { manifest_base64: bytes.toString('base64'), signature_base64: sign(null, bytes, keys.privateKey).toString('base64') }
}
function health(id = 'a', overrides: Partial<Health> = {}): Health {
  return { ok: true, server_identity: `server-${id}`, server_instance_id: `boot-${id}`,
    server_version: '1.1.0-beta.1', api_contract_version: 28,
    capabilities: { server_updates: { available: true, version: 11 }, server_update_ensure_v1: { available: true, version: 1 } }, ...overrides }
}
function splitHealth(executionVersion: string, gatewayVersion: string): Health {
  return health('a', {
    server_version: executionVersion,
    gateway: { protocol: 1, instance_id: 'gateway-boot', pid: 101, version: gatewayVersion, restart_preserves_execution: true },
    execution_service: { protocol: 1, instance_id: 'execution-boot', pid: 102, version: executionVersion,
      worker_upgrade_policy: 'when_idle', rolling_worker_upgrade: false }
  })
}
function fixture(ids = ['a']) {
  const profiles: CoordinatedProfile[] = ids.map((id, index) => ({ id, name: `Server ${id}`, serverIdentity: `server-${id}`, active: index === 0 }))
  const clients = Object.fromEntries(ids.map(id => [id, {
    health: vi.fn(async () => health(id)),
    ensureServerUpdate: vi.fn(async (): Promise<ServerUpdateStatus> => ({ phase: 'pending', current_version: '1.1.0-beta.1',
      server_identity: `server-${id}`, server_instance_id: `boot-${id}`, target_version: '1.2.0-beta.2', schedule_id: 'schedule-a', message: 'Queued until idle.' })),
    serverUpdateStatus: vi.fn(async (): Promise<ServerUpdateStatus> => ({ phase: 'pending', current_version: '1.1.0-beta.1', track: 'beta',
      target_version: '1.2.0-beta.2', server_identity: `server-${id}`, server_instance_id: `boot-${id}` })),
    checkServerUpdate: vi.fn(async (): Promise<ServerUpdateStatus> => ({ phase: 'available', current_version: '1.1.0-beta.1', latest_version: '1.1.0-beta.3', track: 'beta' })),
    startServerUpdate: vi.fn(async (): Promise<ServerUpdateStatus> => ({ phase: 'pending', current_version: '1.1.0-beta.1',
      server_identity: `server-${id}`, server_instance_id: `boot-${id}`, schedule_id: 'bridge-schedule' })),
    dispose: vi.fn()
  }]))
  let saved: CoordinatedUpdatePlan | null = null
  const store = { read: () => saved, write: vi.fn((value: CoordinatedUpdatePlan) => { saved = structuredClone(value) }) }
  const assertCurrent = vi.fn()
  const options = { profiles: () => profiles, connect: vi.fn(async (profile: CoordinatedProfile) => ({ client: clients[profile.id], assertCurrent, loopback: false })),
    store, publish: vi.fn(), publicKey }
  return { manager: new CoordinatedUpdateManager(options), options, clients, profiles, store, assertCurrent, saved: () => saved }
}

describe('signed coordinated release contract', () => {
  it('shares the server release trust root', () => {
    const keyDer = (pem: string) => createPublicKey(pem).export({ format: 'der', type: 'spki' })
    const serverPem = readFileSync(resolve(process.cwd(), '../server/release-public-key.pem'), 'utf8')
    const appKey = keyDer(SERVER_RELEASE_PUBLIC_KEY)
    expect(keyDer(serverPem)).toEqual(appKey)
    for (const newline of ['\n', '\r\n']) {
      expect(keyDer(serverPem.replace(/\r?\n/g, newline))).toEqual(appKey)
    }
    expect(keyDer(publicKey)).not.toEqual(appKey)
  })
  it('authenticates exact bytes, target version and compatibility before enrollment', () => {
    expect(verifyPairedRelease(signed(), '1.2.0-beta.2', publicKey).minimum_server_api_contract).toBe(8)
    expect(() => verifyPairedRelease(signed(), '1.2.0-beta.3', publicKey)).toThrow('does not match')
    expect(() => verifyPairedRelease(signed('1.2.0-beta.2', { minimum_server_api_contract: 29 }), undefined, publicKey)).toThrow('contract')
    const bad = signed(); bad.manifest_base64 = Buffer.from('{}').toString('base64')
    expect(() => verifyPairedRelease(bad, undefined, publicKey)).toThrow('signature')
    expect(() => verifyPairedRelease({ ...signed(), signature_base64: 'A'.repeat(1024) }, undefined, publicKey)).toThrow('bounds')
  })
  it('compares arbitrary precision versions and stable promotions without coercion', () => {
    expect(compareReleaseVersions('1.2.0-beta.10', '1.2.0-beta.2')).toBe(1)
    expect(compareReleaseVersions('1.2.0', '1.2.0-beta.999')).toBe(1)
    expect(compareReleaseVersions('1.1.9', '1.2.0-beta.1')).toBe(-1)
    expect(() => compareReleaseVersions('development', '1.2.0')).toThrow()
  })

})

describe('coordinated app/server reconciliation (mocked server boundary)', () => {
  it('pauses an unrecoverable legacy 1.0.4 attempt and retries the paired bridge after host repair', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.0.3',
      capabilities: { server_updates: { available: true, version: 9 } } }))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'failed', current_version: '1.0.3', target_version: '1.0.4' })
    f.clients.a.startServerUpdate.mockRejectedValueOnce(new ServerError(503, 'the previous server update could not be safely finalized'))
    await f.manager.resume(signed('1.0.5'), '1.0.5')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'blocked', paused: true, targetVersion: '1.0.5' })
    expect(f.clients.a.startServerUpdate).toHaveBeenCalledOnce()
    await f.manager.retry('a')
    expect(f.clients.a.startServerUpdate).toHaveBeenCalledTimes(2)
    expect(f.clients.a.startServerUpdate).toHaveBeenLastCalledWith('1.0.5', 'stable', true,
      { expected_server_identity: 'server-a', expected_server_instance_id: 'boot-a' })
    expect(f.manager.status()[0]).toMatchObject({ phase: 'pending', paused: false })
  })

  it('keeps the bundled update pending when only the gateway reaches the paired version', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(splitHealth('1.1.0-beta.1', '1.2.0-beta.2'))
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'pending', gatewayVersion: '1.2.0-beta.2', executionVersion: '1.1.0-beta.1' })
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledOnce()
  })
  it('waits for the gateway when execution reaches the paired version first, without replacing the same runtime again', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(splitHealth('1.2.0-beta.2', '1.1.0-beta.1'))
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'pending', gatewayVersion: '1.1.0-beta.1', executionVersion: '1.2.0-beta.2' })
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it('resumes a partial activation through the recovery-capable ensure contract', async () => {
    const f = fixture()
    const partial = splitHealth('1.2.0-beta.2', '1.1.0-beta.1')
    partial.capabilities = { server_update_ensure_v1: { available: true, version: 1, activation_recovery: true } }
    f.clients.a.health.mockResolvedValue(partial)
    f.clients.a.ensureServerUpdate.mockResolvedValue({ phase: 'restarting', current_version: '1.2.0-beta.2',
      target_version: '1.2.0-beta.2', server_identity: 'server-a', server_instance_id: 'boot-a', update_id: 'original-operation' })
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledOnce()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
    expect(f.manager.status()[0]).toMatchObject({ phase: 'updating', operationId: 'original-operation' })
  })
  it('shows failed recovery while the server keeps legacy work safely drained, and permits retry', async () => {
    const f = fixture()
    const partial = splitHealth('1.2.0-beta.2', '1.1.0-beta.1')
    partial.capabilities = { server_update_ensure_v1: { available: true, version: 1, activation_recovery: true } }
    f.clients.a.health.mockResolvedValue(partial)
    f.clients.a.ensureServerUpdate.mockResolvedValueOnce({ phase: 'installing', current_version: '1.2.0-beta.2',
      target_version: '1.2.0-beta.2', server_identity: 'server-a', server_instance_id: 'boot-a',
      update_id: 'original-operation', error_code: 'server_update_recovery_failed', retryable: true })
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'failed', paused: true })
    await f.manager.retry('a')
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledTimes(2)
    expect(f.manager.status()[0].paused).not.toBe(true)
  })
  it('reconciles a gateway version change without requiring the execution boot or update status to change', async () => {
    const f = fixture()
    const previous = splitHealth('1.2.0-beta.2', '1.1.0-beta.1')
    f.clients.a.health.mockResolvedValue(previous)
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    f.manager.serverReachable('a', previous)
    await f.manager.reconcileAll()
    expect(f.manager.status()[0].phase).toBe('pending')
    const completed = splitHealth('1.2.0-beta.2', '1.2.0-beta.2')
    f.clients.a.health.mockResolvedValue(completed)
    f.manager.serverReachable('a', completed)
    await vi.waitFor(() => expect(f.manager.status()[0]).toMatchObject({ phase: 'current', gatewayVersion: '1.2.0-beta.2' }))
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
  })
  it.each([
    { execution_service: undefined },
    { gateway: undefined },
    { gateway: null },
    { server_version: '1.3.0-beta.1' },
    { gateway: { protocol: 2, instance_id: 'gateway-boot', version: '1.2.0-beta.2' } }
  ])('rejects inconsistent or incomplete component health before automatic mutations: %j', async override => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue({ ...splitHealth('1.2.0-beta.2', '1.2.0-beta.2'), ...override } as Health)
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'blocked' })
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it('retains a failed operation while the gateway is behind, and clears it only after both components recover', async () => {
    const f = fixture()
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    f.clients.a.health.mockResolvedValue(splitHealth('1.2.0-beta.2', '1.1.0-beta.1'))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'failed', current_version: '1.2.0-beta.2',
      target_version: '1.2.0-beta.2', schedule_id: 'schedule-a', server_identity: 'server-a', server_instance_id: 'boot-a' })
    await f.manager.reconcileAll()
    expect(f.manager.status()[0]).toMatchObject({ phase: 'failed', paused: true })
    f.clients.a.health.mockResolvedValue(splitHealth('1.2.0-beta.2', '1.2.0-beta.2'))
    await f.manager.reconcileAll()
    expect(f.manager.status()[0]).toMatchObject({ phase: 'current', paused: false })
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledOnce()
  })
  it.each([true, false])('preserves the concrete server failure when components are incomplete (owned operation: %s)', async owned => {
    const f = fixture()
    if (owned) await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    const message = 'The server could not write the update files because its disk is full. Free up space, then retry.'
    f.clients.a.health.mockResolvedValue(splitHealth('1.2.0-beta.2', '1.1.0-beta.1'))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'failed', current_version: '1.2.0-beta.2',
      target_version: '1.2.0-beta.2', schedule_id: 'schedule-a', server_identity: 'server-a', server_instance_id: 'boot-a', message })

    if (owned) await f.manager.reconcileAll()
    else await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')

    expect(f.manager.status()[0]).toMatchObject({ phase: 'failed', paused: true, message })
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledTimes(owned ? 1 : 0)
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it('does not accept a complete operation receipt while authenticated component health still shows an old gateway', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(splitHealth('1.2.0-beta.2', '1.1.0-beta.1'))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'complete', current_version: '1.2.0-beta.2',
      installed_version: '1.2.0-beta.2', server_identity: 'server-a', server_instance_id: 'boot-a' })
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'blocked', message: 'The server update is incomplete. Reconnect to check recovery.' })
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
  })
  it('keeps a healthy candidate pending until the installer releases its admission hold', async () => {
    const f = fixture()
    const held = splitHealth('1.2.0-beta.2', '1.2.0-beta.2')
    held.execution_service!.maintenance_held = true
    f.clients.a.health.mockResolvedValue(held)
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    f.manager.serverReachable('a', held)
    await f.manager.reconcileAll()
    expect(f.manager.status()[0].phase).toBe('pending')
    const released = structuredClone(held)
    released.execution_service!.maintenance_held = false
    f.clients.a.health.mockResolvedValue(released)
    f.manager.serverReachable('a', released)
    await vi.waitFor(() => expect(f.manager.status()[0].phase).toBe('current'))
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
  })
  it('keeps a matching operation pending when new health arrives before its installer finishes', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.2.0-beta.2',
      server_update: { phase: 'installing', target_version: '1.2.0-beta.2' } }))
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.manager.status()[0].phase).toBe('pending')
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
  })
  it('queues compatible busy servers independently and persists identity-bound operation receipts', async () => {
    const f = fixture(['a', 'b'])
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    for (const id of ['a', 'b']) expect(f.clients[id].ensureServerUpdate).toHaveBeenCalledWith(signed(), {
      expected_server_identity: `server-${id}`, expected_server_instance_id: `boot-${id}`
    })
    expect(f.saved()?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: 'a', serverIdentity: 'server-a', phase: 'pending', scheduleId: 'schedule-a' }),
      expect.objectContaining({ profileId: 'b', serverIdentity: 'server-b', phase: 'pending' })
    ]))
  })
  it('leaves newer compatible shared servers alone, including beta to older stable requests', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.3.0-beta.1' }))
    await f.manager.resume(signed('1.2.0'), '1.2.0')
    expect(f.manager.status()[0].phase).toBe('current')
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it.each([7, 29])('reports a newer server outside the supported API range without replacing it (%s)', async api => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.3.0-beta.1', api_contract_version: api }))
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'blocked' })
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
  })
  it('accepts a newer server within the supported API range', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.3.0-beta.1', api_contract_version: 20 }))
    await f.manager.resume(signed(), '1.2.0-beta.2')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'current', message: 'Server is up to date.' })
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
  })
  it('does not substitute another route for an unstructured server rejection', async () => {
    const f = fixture()
    f.clients.a.ensureServerUpdate.mockRejectedValue(new ServerError(409, 'Server channel must be preserved.'))
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'blocked', message: 'Server channel must be preserved.' })
    expect(f.clients.a.checkServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it.each([401, 403, 409])('does not fall back for unrelated HTTP %s responses', async status => {
    const f = fixture()
    f.clients.a.ensureServerUpdate.mockRejectedValue(new ServerError(status, 'Server rejected this update.', {
      code: status === 409 ? 'server_identity_changed' : 'server_update_channel_conflict'
    }))
    await f.manager.resume(signed('1.0.5'), '1.0.5')
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it('uses native HTTP to bridge an old ensure channel refusal to the exact bundled release', async () => {
    const defaultFetchStub = globalThis.fetch
    vi.unstubAllGlobals() // This case uses only its owned loopback HTTP listener.
    const calls: { path: string; method: string; body: Record<string, unknown>; token?: string }[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      const path = new URL(request.url!, 'http://localhost').pathname
      calls.push({ path, method: request.method!, body, token: request.headers['x-agentsdock-token'] as string })
      response.setHeader('Content-Type', 'application/json')
      if (path === '/api/health') response.end(JSON.stringify(health('a', { server_version: '1.0.4-beta.12' })))
      else if (path === '/api/admin/update/ensure') {
        response.statusCode = 409
        response.end(JSON.stringify({ detail: { code: 'server_update_channel_conflict',
          message: "Automatic updates cannot change this server's release channel." } }))
      } else if (path === '/api/admin/update') response.end(JSON.stringify({ phase: 'current', current_version: '1.0.4-beta.12', track: 'beta' }))
      else if (path === '/api/admin/update/start') response.end(JSON.stringify({ phase: 'pending', current_version: '1.0.4-beta.12',
        target_version: '1.0.5', track: 'stable', server_identity: 'server-a', server_instance_id: 'boot-a', schedule_id: 'bridge' }))
      else { response.statusCode = 404; response.end('{}') }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const client = new AgentServerClient(`http://127.0.0.1:${address.port}`, 'owned-test-token')
    const f = fixture()
    const manager = new CoordinatedUpdateManager({ ...f.options,
      connect: async () => ({ client, assertCurrent: () => undefined, loopback: true }) })
    try {
      await manager.resume(signed('1.0.5'), '1.0.5')
      expect(manager.status()).toEqual([expect.objectContaining({ phase: 'pending' })])
      expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
        'GET /api/health', 'POST /api/admin/update/ensure', 'GET /api/admin/update', 'POST /api/admin/update/start'
      ])
      expect(calls.every(call => call.token === 'owned-test-token')).toBe(true)
      expect(calls[1].body).toMatchObject({ ...signed('1.0.5'), expected_server_identity: 'server-a', expected_server_instance_id: 'boot-a' })
      expect(calls[3].body).toEqual({ version: '1.0.5', track: 'stable', when_idle: true,
        expected_server_identity: 'server-a', expected_server_instance_id: 'boot-a' })
      expect(manager.status()[0]).toMatchObject({ phase: 'pending', operationOwned: true, operationTargetVersion: '1.0.5' })
    } finally {
      client.dispose()
      vi.stubGlobal('fetch', defaultFetchStub)
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it('queues the existing signed bridge without canceling reservations or forcing restart', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { capabilities: { server_updates: { available: true, version: 11 } } }))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'current', current_version: '1.1.0-beta.1', track: 'beta' })
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.clients.a.startServerUpdate).toHaveBeenCalledWith('1.2.0-beta.2', 'beta', true,
      { expected_server_identity: 'server-a', expected_server_instance_id: 'boot-a' })
    expect(f.manager.status()[0].scheduleId).toBe('bridge-schedule')
  })
  it.each([
    ['1.0.3', 'stable', '1.0.5', 'stable'],
    ['1.0.4-beta.9', 'beta', '1.0.5', 'stable'],
    ['1.0.3', 'stable', '1.0.5-beta.1', 'beta']
  ] as const)('updates %s (%s) to the app-paired %s (%s)', async (current, currentTrack, version, track) => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { server_version: current,
      capabilities: { server_updates: { available: true, version: 9 } } }))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'current', current_version: current, track: currentTrack })
    f.clients.a.checkServerUpdate.mockRejectedValue(new ServerError(502, 'signed release check failed: HTTP Error 429: Too Many Requests'))
    f.clients.a.startServerUpdate.mockResolvedValue({ phase: 'pending', current_version: current,
      target_version: version, track, server_identity: 'server-a', server_instance_id: 'boot-a', schedule_id: 'paired-upgrade' })

    await f.manager.resume(signed(version), version)
    expect(f.clients.a.checkServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).toHaveBeenCalledExactlyOnceWith(version, track, true,
      { expected_server_identity: 'server-a', expected_server_instance_id: 'boot-a' })
    expect(f.manager.status()[0]).toMatchObject({ phase: 'pending', scheduleId: 'paired-upgrade' })
  })
  it('reconciles a persisted channel error after startup even when update status is unavailable', async () => {
    const f = fixture()
    f.store.write({ envelope: signed('1.0.5'), records: [{ profileId: 'a', name: 'Server a',
      serverIdentity: 'server-a', targetVersion: '1.0.5', phase: 'blocked',
      message: 'Server update channel differs from this app release. Its channel was preserved.' }] })
    f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.0.4-beta.9',
      capabilities: { server_updates: { available: true, version: 9 } } }))
    f.clients.a.serverUpdateStatus.mockRejectedValue(new ServerError(502, 'Update status is temporarily unavailable.'))

    await f.manager.resume(signed('1.0.5'), '1.0.5')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'blocked' })
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it('joins an existing beta reservation while the stable paired update waits', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.0.4-beta.9',
      capabilities: { server_updates: { available: true, version: 9 } } }))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'pending', current_version: '1.0.4-beta.9',
      target_version: '1.0.4-beta.12', track: 'beta', schedule_id: 'existing-beta-choice',
      server_identity: 'server-a', server_instance_id: 'boot-a' })

    await f.manager.resume(signed('1.0.5'), '1.0.5')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'pending', scheduleId: 'existing-beta-choice', operationTargetVersion: '1.0.4-beta.12' })
    expect(f.clients.a.checkServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it('joins an existing legacy reservation and never substitutes an older target', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { capabilities: { server_updates: { available: true, version: 11 } } }))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'pending', current_version: '1.1.0-beta.1',
      target_version: '1.3.0-beta.1', schedule_id: 'someone-elses-schedule', server_identity: 'server-a', server_instance_id: 'boot-a' })
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.clients.a.checkServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
    expect(f.manager.status()[0].scheduleId).toBe('someone-elses-schedule')
  })
  it.each(['failed', 'available'] as const)('observes legacy terminal %s on unchanged health and stops after pausing', async phase => {
    const f = fixture()
    const unchanged = health('a', { capabilities: { server_updates: { available: true, version: 9 } } })
    const starting: ServerUpdateStatus = { phase: 'starting', current_version: '1.1.0-beta.1',
      target_version: '1.2.0-beta.2', update_id: 'legacy-operation',
      server_identity: 'server-a', server_instance_id: 'boot-a' }
    f.clients.a.health.mockResolvedValue(unchanged)
    f.clients.a.serverUpdateStatus.mockResolvedValue({ ...starting, phase: 'current' })
    f.clients.a.startServerUpdate.mockResolvedValue(starting)
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    f.clients.a.serverUpdateStatus.mockResolvedValue(starting)
    f.manager.serverReachable('a', unchanged)
    await f.manager.reconcileAll()
    expect(f.manager.status()[0]).toMatchObject({ phase: 'updating', operationOwned: true })

    f.clients.a.serverUpdateStatus.mockResolvedValue({ ...starting, phase })
    f.manager.serverReachable('a', unchanged)
    await vi.waitFor(() => expect(f.manager.status()[0]).toMatchObject({ phase: phase === 'failed' ? 'failed' : 'blocked', paused: true }))
    const calls = f.options.connect.mock.calls.length
    f.manager.serverReachable('a', unchanged)
    await Promise.resolve()
    expect(f.options.connect).toHaveBeenCalledTimes(calls)
    expect(f.clients.a.startServerUpdate).toHaveBeenCalledOnce()
    expect(f.clients.a.checkServerUpdate).not.toHaveBeenCalled()
  })
  it('coalesces unchanged legacy health during a pending status read without retrying a failure', async () => {
    const f = fixture()
    const unchanged = health('a', { capabilities: { server_updates: { available: true, version: 9 } } })
    const starting: ServerUpdateStatus = { phase: 'starting', current_version: '1.1.0-beta.1',
      target_version: '1.2.0-beta.2', update_id: 'legacy-operation',
      server_identity: 'server-a', server_instance_id: 'boot-a' }
    f.clients.a.health.mockResolvedValue(unchanged)
    f.clients.a.serverUpdateStatus.mockResolvedValue(starting)
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    let complete!: (value: ServerUpdateStatus) => void
    f.clients.a.serverUpdateStatus.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const calls = f.clients.a.serverUpdateStatus.mock.calls.length
    f.manager.serverReachable('a', unchanged)
    await vi.waitFor(() => expect(f.clients.a.serverUpdateStatus).toHaveBeenCalledTimes(calls + 1))
    for (let index = 0; index < 5; index++) f.manager.serverReachable('a', unchanged)
    complete({ ...starting, phase: 'failed' })
    await f.manager.reconcileAll()
    await vi.waitFor(() => expect(f.manager.status()[0]).toMatchObject({ phase: 'failed', paused: true }))
    await f.manager.reconcileAll()
    expect(f.clients.a.serverUpdateStatus).toHaveBeenCalledTimes(calls + 1)
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.checkServerUpdate).not.toHaveBeenCalled()
  })
  it('does not recheck idle legacy profiles on unchanged health', async () => {
    const f = fixture()
    const unchanged = health('a', { server_version: '1.2.0-beta.2',
      capabilities: { server_updates: { available: true, version: 9 } } })
    f.clients.a.health.mockResolvedValue(unchanged)
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    f.manager.serverReachable('a', unchanged)
    await f.manager.reconcileAll()
    const calls = f.options.connect.mock.calls.length
    f.manager.serverReachable('a', unchanged)
    await Promise.resolve()
    expect(f.options.connect).toHaveBeenCalledTimes(calls)
    expect(f.clients.a.serverUpdateStatus).not.toHaveBeenCalled()
  })
  it('joins a retryable older reservation and retries on same-boot operation transitions without polling', async () => {
    const f = fixture()
    f.clients.a.ensureServerUpdate.mockRejectedValueOnce(new ServerError(409, 'Another update must finish.', { error_code: 'server_update_pending' }))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'pending', current_version: '1.1.0-beta.1',
      server_identity: 'server-a', server_instance_id: 'boot-a', schedule_id: 'older-schedule', target_version: '1.1.0-beta.3' })
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'pending', scheduleId: 'older-schedule' })
    const waiting = health('a', { server_update: { phase: 'pending', schedule_id: 'older-schedule', updated_at: 'one' } })
    f.manager.serverReachable('a', waiting)
    await f.manager.reconcileAll()
    const calls = f.clients.a.ensureServerUpdate.mock.calls.length
    f.manager.serverReachable('a', waiting)
    await Promise.resolve()
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledTimes(calls)
    f.manager.serverReachable('a', health('a', { server_update: { phase: 'available', updated_at: 'two' } }))
    await f.manager.reconcileAll()
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledTimes(calls + 1)
  })
  it('requires a scoped update route for a remote legacy server', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.1.0', capabilities: { server_updates: { available: true, version: 8 } } }))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'current', current_version: '1.1.0', track: 'stable' })
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
    expect(f.manager.status()[0].phase).toBe('blocked')
  })
  it('reports server progress despite an old API contract and accepts verified new health', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { api_contract_version: 7 }))
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.2.0-beta.2', server_instance_id: 'new-boot' }))
    await f.manager.reconcileAll()
    expect(f.manager.status()[0]).toMatchObject({ phase: 'current', serverInstanceId: 'new-boot' })
  })
  it('keeps offline profiles pending without blocking other profiles and resumes persisted intent', async () => {
    const f = fixture(['a', 'b'])
    f.clients.b.health.mockRejectedValue(new Error('offline'))
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.manager.status().map(record => record.phase)).toEqual(['pending', 'offline'])
    const resumed = new CoordinatedUpdateManager(f.options)
    f.clients.b.health.mockResolvedValue(health('b'))
    await resumed.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(resumed.status().map(record => record.phase)).toEqual(['pending', 'pending'])
  })
  it('does not lose a new boot observation while an earlier ensure response is still in flight', async () => {
    const f = fixture()
    let release!: (status: ServerUpdateStatus) => void
    f.clients.a.ensureServerUpdate.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const prepared = f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    await vi.waitFor(() => expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledOnce())
    const completed = health('a', { server_instance_id: 'new-boot', server_version: '1.2.0-beta.2' })
    f.clients.a.health.mockResolvedValue(completed)
    f.manager.serverReachable('a', completed)
    release({ phase: 'starting', current_version: '1.1.0-beta.1', server_identity: 'server-a', server_instance_id: 'boot-a' })
    await prepared
    await vi.waitFor(() => expect(f.manager.status()[0]).toMatchObject({ phase: 'current', serverInstanceId: 'new-boot' }))
  })
  it.each(['failed', 'available'] as const)('persists %s owned updates as paused and requires explicit profile retry', async phase => {
    const f = fixture(['a', 'b'])
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    for (const id of ['a', 'b']) f.clients[id].serverUpdateStatus.mockResolvedValue({ phase,
      current_version: '1.1.0-beta.1', target_version: phase === 'failed' ? '1.2.0-beta.2' : undefined,
      latest_version: '1.2.0-beta.2', schedule_id: phase === 'failed' ? 'schedule-a' : undefined,
      server_identity: `server-${id}`, server_instance_id: `boot-${id}` })
    await f.manager.reconcileAll()
    expect(f.manager.status().every(record => record.paused)).toBe(true)
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledOnce()
    const resumed = new CoordinatedUpdateManager(f.options)
    await resumed.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    resumed.serverReachable('a', health('a', { server_update: { phase, updated_at: 'changed' } }))
    await resumed.reconcileAll()
    expect(resumed.status().every(record => record.paused)).toBe(true)
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledOnce()
    await resumed.retry('a')
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledTimes(2)
    expect(f.clients.b.ensureServerUpdate).toHaveBeenCalledOnce()
    expect(resumed.status().find(record => record.profileId === 'b')?.paused).toBe(true)
  })
  it('only enrolls server updates when the installed app includes bundled metadata', async () => {
    const f = fixture()
    await f.manager.resume()
    expect(f.options.connect).not.toHaveBeenCalled()
    expect(f.store.write).not.toHaveBeenCalled()
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.options.connect).toHaveBeenCalledOnce()
    expect(f.manager.status()[0].phase).toBe('pending')
  })
  it.each([
    { phase: 'pending', version: '1.0.5' },
    { phase: 'failed', version: '1.0.5' },
    { phase: 'pending', version: '9.0.0' }
  ] as const)('leaves a saved $phase plan for $version untouched in an app-only release', async ({ phase, version }) => {
    const f = fixture()
    f.store.write({ envelope: signed(version), records: [{ profileId: 'a', name: 'Server a',
      serverIdentity: 'server-a', targetVersion: version, phase, paused: phase === 'failed',
      operationOwned: true, operationId: 'old-operation', operationTargetVersion: version, message: 'Saved update.' }] })
    const saved = f.saved()
    f.store.write.mockClear()
    const read = vi.spyOn(f.store, 'read')

    await f.manager.resume(undefined, '1.0.6-beta.1')
    f.manager.serverReachable('a', health())
    await f.manager.reconcileAll()
    await expect(f.manager.retry('a')).rejects.toThrow('no longer belongs')

    expect(read).not.toHaveBeenCalled()
    expect(f.store.write).not.toHaveBeenCalled()
    expect(f.saved()).toEqual(saved)
    expect(f.options.publish).toHaveBeenCalledExactlyOnceWith([])
    expect(f.manager.status()).toEqual([])
    expect(f.options.connect).not.toHaveBeenCalled()
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it.each(['missing', 'corrupt'])('does not read a %s saved store in an app-only release', async condition => {
    const f = fixture()
    const read = vi.spyOn(f.store, 'read').mockImplementation(() => {
      if (condition === 'corrupt') throw new Error('Invalid saved JSON')
      return null
    })
    await f.manager.resume()
    expect(read).not.toHaveBeenCalled()
    expect(f.store.write).not.toHaveBeenCalled()
    expect(f.options.connect).not.toHaveBeenCalled()
    expect(f.options.publish).toHaveBeenCalledExactlyOnceWith([])
  })
  it('clears an in-memory paired plan without modifying its saved receipt when resuming app-only', async () => {
    const f = fixture()
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    const saved = f.saved()
    f.options.connect.mockClear()
    f.store.write.mockClear()
    f.clients.a.ensureServerUpdate.mockClear()

    await f.manager.resume()
    f.manager.serverReachable('a', health())
    await f.manager.reconcileAll()
    await expect(f.manager.retry('a')).rejects.toThrow('no longer belongs')

    expect(f.manager.status()).toEqual([])
    expect(f.options.publish).toHaveBeenLastCalledWith([])
    expect(f.saved()).toEqual(saved)
    expect(f.store.write).not.toHaveBeenCalled()
    expect(f.options.connect).not.toHaveBeenCalled()
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it('uses the installed app bundle instead of a newer pre-install plan left by an older app', async () => {
    const f = fixture()
    f.store.write({ envelope: signed('1.3.0-beta.1'), records: [] })
    await f.manager.resume(signed('1.2.0'), '1.2.0')
    expect(f.saved()?.envelope).toEqual(signed('1.2.0'))
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledWith(signed('1.2.0'), {
      expected_server_identity: 'server-a', expected_server_instance_id: 'boot-a'
    })
  })
  it.each([
    { legacy: false, phase: 'failed' }, { legacy: false, phase: 'available' },
    { legacy: true, phase: 'failed' }, { legacy: true, phase: 'available' }
  ] as const)('automatically starts a new bundle after an old owned $phase attempt (legacy: $legacy)', async ({ legacy, phase }) => {
    const f = fixture()
    f.store.write({ envelope: signed('1.0.4'), records: [{
      profileId: 'a', name: 'Server a', serverIdentity: 'server-a', targetVersion: '1.0.4',
      phase: phase === 'failed' ? 'failed' : 'blocked', message: 'Old update stopped.', paused: true,
      operationId: 'old-operation', scheduleId: 'old-schedule', operationTargetVersion: '1.0.4', operationOwned: true
    }] })
    f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.0.3',
      ...(legacy ? { capabilities: { server_updates: { available: true, version: 9 } } } : {}) }))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase, current_version: '1.0.3', target_version: '1.0.4',
      update_id: 'old-operation', schedule_id: 'old-schedule', server_identity: 'server-a', server_instance_id: 'boot-a' })
    const accepted: ServerUpdateStatus = { phase: 'starting', current_version: '1.0.3', target_version: '1.0.5',
      update_id: 'new-operation', server_identity: 'server-a', server_instance_id: 'boot-a' }
    f.clients.a.ensureServerUpdate.mockResolvedValue(accepted)
    f.clients.a.startServerUpdate.mockResolvedValue(accepted)

    await f.manager.resume(signed('1.0.5'), '1.0.5')

    expect(f.options.publish.mock.calls[0][0][0]).toMatchObject({ paused: false,
      operationId: undefined, scheduleId: undefined, operationTargetVersion: undefined, operationOwned: false })
    expect(f.manager.status()[0]).toMatchObject({ phase: 'updating', paused: false, targetVersion: '1.0.5',
      operationId: 'new-operation', scheduleId: undefined, operationTargetVersion: '1.0.5' })
    if (legacy) {
      expect(f.clients.a.startServerUpdate).toHaveBeenCalledExactlyOnceWith('1.0.5', 'stable', true,
        { expected_server_identity: 'server-a', expected_server_instance_id: 'boot-a' })
      expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
    } else {
      expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledExactlyOnceWith(signed('1.0.5'),
        { expected_server_identity: 'server-a', expected_server_instance_id: 'boot-a' })
      expect(f.clients.a.serverUpdateStatus).not.toHaveBeenCalled()
    }
  })
  it('rejects wrong server identities before mutation and fences profile changes after credential reads', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('other'))
    await f.manager.resume(signed('1.2.0-beta.2'), '1.2.0-beta.2')
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
    expect(f.manager.status()[0].phase).toBe('blocked')
    f.clients.a.health.mockResolvedValue(health())
    f.assertCurrent.mockImplementation(() => { throw new Error('Server profile identity changed.') })
    await f.manager.reconcileAll()
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
  })
})
