// @vitest-environment node
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Health, ServerUpdateStatus } from '../shared/types'
import { ServerError } from './server-client'
import { CoordinatedUpdateManager, compareReleaseVersions, fetchPairedServerRelease, verifyPairedRelease,
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
    load: vi.fn(async (version: string) => signed(version)), store, publish: vi.fn(), publicKey }
  return { manager: new CoordinatedUpdateManager(options), options, clients, profiles, store, assertCurrent, saved: () => saved }
}

describe('signed coordinated release contract', () => {
  it('shares the server release trust root', () => {
    expect(SERVER_RELEASE_PUBLIC_KEY).toBe(readFileSync(resolve(process.cwd(), '../server/release-public-key.pem'), 'utf8'))
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
  it('fetches only exact release assets and bounds both streams', async () => {
    const envelope = signed()
    const fetcher = vi.fn(async (url: string) => new Response(Buffer.from(url.endsWith('.sig') ? envelope.signature_base64 : envelope.manifest_base64, 'base64')))
    expect(await fetchPairedServerRelease('1.2.0-beta.2', fetcher)).toEqual(envelope)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      'https://github.com/ZhengyiLuo/AgentsDock/releases/download/v1.2.0-beta.2/agents-server-npm-manifest.json',
      'https://github.com/ZhengyiLuo/AgentsDock/releases/download/v1.2.0-beta.2/agents-server-npm-manifest.sig'
    ])
    await expect(fetchPairedServerRelease('1.2.0', async () => new Response('x'.repeat(65 * 1024)))).rejects.toThrow('bounds')
  })
})

describe('coordinated app/server reconciliation (mocked server boundary)', () => {
  it('keeps the bundled update pending when only the gateway reaches the paired version', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(splitHealth('1.1.0-beta.1', '1.2.0-beta.2'))
    await f.manager.prepare('1.2.0-beta.2')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'pending', gatewayVersion: '1.2.0-beta.2', executionVersion: '1.1.0-beta.1' })
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledOnce()
  })
  it('waits for the gateway when execution reaches the paired version first, without replacing the same runtime again', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(splitHealth('1.2.0-beta.2', '1.1.0-beta.1'))
    expect(await f.manager.prepare('1.2.0-beta.2')).toBe(true)
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
    await f.manager.prepare('1.2.0-beta.2')
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
    await f.manager.prepare('1.2.0-beta.2')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'failed', paused: true })
    await f.manager.retry('a')
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledTimes(2)
    expect(f.manager.status()[0].paused).not.toBe(true)
  })
  it('reconciles a gateway version change without requiring the execution boot or update status to change', async () => {
    const f = fixture()
    const previous = splitHealth('1.2.0-beta.2', '1.1.0-beta.1')
    f.clients.a.health.mockResolvedValue(previous)
    await f.manager.prepare('1.2.0-beta.2')
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
    expect(await f.manager.prepare('1.2.0-beta.2')).toBe(false)
    expect(f.manager.status()[0]).toMatchObject({ phase: 'blocked', activationBlocked: true })
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it('retains a failed operation while the gateway is behind, and clears it only after both components recover', async () => {
    const f = fixture()
    await f.manager.prepare('1.2.0-beta.2')
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
  it('does not accept a complete operation receipt while authenticated component health still shows an old gateway', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(splitHealth('1.2.0-beta.2', '1.1.0-beta.1'))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'complete', current_version: '1.2.0-beta.2',
      installed_version: '1.2.0-beta.2', server_identity: 'server-a', server_instance_id: 'boot-a' })
    await f.manager.prepare('1.2.0-beta.2')
    expect(f.manager.status()[0]).toMatchObject({ phase: 'blocked', message: 'The server update is incomplete. Reconnect to check recovery.' })
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
  })
  it('keeps a healthy candidate pending until the installer releases its admission hold', async () => {
    const f = fixture()
    const held = splitHealth('1.2.0-beta.2', '1.2.0-beta.2')
    held.execution_service!.maintenance_held = true
    f.clients.a.health.mockResolvedValue(held)
    await f.manager.prepare('1.2.0-beta.2')
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
    await f.manager.prepare('1.2.0-beta.2')
    expect(f.manager.status()[0].phase).toBe('pending')
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
  })
  it('queues compatible busy servers independently and persists identity-bound operation receipts', async () => {
    const f = fixture(['a', 'b'])
    expect(await f.manager.prepare('1.2.0-beta.2')).toBe(true)
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
    await f.manager.prepare('1.2.0')
    expect(f.manager.status()[0].phase).toBe('current')
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it.each([7, 20, 29])('does not activate against a newer server with a different API contract (%s)', async api => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.3.0-beta.1', api_contract_version: api }))
    expect(await f.manager.prepare('1.2.0-beta.2')).toBe(false)
    expect(f.manager.status()[0]).toMatchObject({ phase: 'blocked', activationBlocked: true })
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
  })
  it('never falls back to legacy routes after ensure refuses a channel change', async () => {
    const f = fixture()
    f.clients.a.ensureServerUpdate.mockRejectedValue(new ServerError(409, 'Server channel must be preserved.'))
    expect(await f.manager.prepare('1.2.0-beta.2')).toBe(false)
    expect(f.manager.status()[0]).toMatchObject({ phase: 'blocked', message: 'Server channel must be preserved.' })
    expect(f.clients.a.checkServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
  })
  it('queues the existing signed bridge without canceling reservations or forcing restart', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { capabilities: { server_updates: { available: true, version: 11 } } }))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'current', current_version: '1.1.0-beta.1', track: 'beta' })
    await f.manager.prepare('1.2.0-beta.2')
    expect(f.clients.a.startServerUpdate).toHaveBeenCalledWith('1.1.0-beta.3', 'beta', true,
      { expected_server_identity: 'server-a', expected_server_instance_id: 'boot-a' })
    expect(f.manager.status()[0].scheduleId).toBe('bridge-schedule')
  })
  it('joins an existing legacy reservation and never substitutes an older target', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { capabilities: { server_updates: { available: true, version: 11 } } }))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'pending', current_version: '1.1.0-beta.1',
      target_version: '1.3.0-beta.1', schedule_id: 'someone-elses-schedule', server_identity: 'server-a', server_instance_id: 'boot-a' })
    await f.manager.prepare('1.2.0-beta.2')
    expect(f.clients.a.checkServerUpdate).not.toHaveBeenCalled()
    expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
    expect(f.manager.status()[0].scheduleId).toBe('someone-elses-schedule')
  })
  it('joins a retryable older reservation and retries on same-boot operation transitions without polling', async () => {
    const f = fixture()
    f.clients.a.ensureServerUpdate.mockRejectedValueOnce(new ServerError(409, 'Another update must finish.', { error_code: 'server_update_pending' }))
    f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'pending', current_version: '1.1.0-beta.1',
      server_identity: 'server-a', server_instance_id: 'boot-a', schedule_id: 'older-schedule', target_version: '1.1.0-beta.3' })
    await f.manager.prepare('1.2.0-beta.2')
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
  it('blocks legacy channel switches and remote pre-fencing mutation', async () => {
    for (const version of [8, 11]) {
      const f = fixture()
      f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.1.0', capabilities: { server_updates: { available: true, version } } }))
      f.clients.a.serverUpdateStatus.mockResolvedValue({ phase: 'current', current_version: '1.1.0', track: 'stable' })
      await f.manager.prepare('1.2.0-beta.2')
      expect(f.clients.a.startServerUpdate).not.toHaveBeenCalled()
      expect(f.manager.status()[0].phase).toBe('blocked')
    }
  })
  it('keeps the working app while an active server has no API overlap, then accepts verified new health', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('a', { api_contract_version: 7 }))
    expect(await f.manager.prepare('1.2.0-beta.2')).toBe(false)
    f.clients.a.health.mockResolvedValue(health('a', { server_version: '1.2.0-beta.2', server_instance_id: 'new-boot' }))
    await f.manager.reconcileAll()
    expect(f.manager.canActivate()).toBe(true)
    expect(f.manager.status()[0]).toMatchObject({ phase: 'current', serverInstanceId: 'new-boot' })
  })
  it('keeps offline profiles pending without blocking other profiles and resumes persisted intent', async () => {
    const f = fixture(['a', 'b'])
    f.clients.b.health.mockRejectedValue(new Error('offline'))
    await f.manager.prepare('1.2.0-beta.2')
    expect(f.manager.status().map(record => record.phase)).toEqual(['pending', 'offline'])
    const resumed = new CoordinatedUpdateManager(f.options)
    f.clients.b.health.mockResolvedValue(health('b'))
    await resumed.resume()
    expect(resumed.status().map(record => record.phase)).toEqual(['pending', 'pending'])
    expect(f.options.load).toHaveBeenCalledOnce()
  })
  it('does not lose a new boot observation while an earlier ensure response is still in flight', async () => {
    const f = fixture()
    let release!: (status: ServerUpdateStatus) => void
    f.clients.a.ensureServerUpdate.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const prepared = f.manager.prepare('1.2.0-beta.2')
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
    await f.manager.prepare('1.2.0-beta.2')
    for (const id of ['a', 'b']) f.clients[id].serverUpdateStatus.mockResolvedValue({ phase,
      current_version: '1.1.0-beta.1', target_version: phase === 'failed' ? '1.2.0-beta.2' : undefined,
      latest_version: '1.2.0-beta.2', schedule_id: phase === 'failed' ? 'schedule-a' : undefined,
      server_identity: `server-${id}`, server_instance_id: `boot-${id}` })
    await f.manager.reconcileAll()
    expect(f.manager.status().every(record => record.paused)).toBe(true)
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledOnce()
    const resumed = new CoordinatedUpdateManager(f.options)
    await resumed.resume()
    resumed.serverReachable('a', health('a', { server_update: { phase, updated_at: 'changed' } }))
    await resumed.reconcileAll()
    expect(resumed.status().every(record => record.paused)).toBe(true)
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledOnce()
    await resumed.retry('a')
    expect(f.clients.a.ensureServerUpdate).toHaveBeenCalledTimes(2)
    expect(f.clients.b.ensureServerUpdate).toHaveBeenCalledOnce()
    expect(resumed.status().find(record => record.profileId === 'b')?.paused).toBe(true)
  })
  it('does not enroll old startup installs or fetch missing release descriptors', async () => {
    const f = fixture()
    await f.manager.resume()
    expect(f.options.load).not.toHaveBeenCalled()
    expect(f.options.connect).not.toHaveBeenCalled()
    expect(await f.manager.prepareEnrolled('1.2.0-beta.2')).toBe(true)
    expect(f.options.load).not.toHaveBeenCalled()
    expect(f.options.connect).not.toHaveBeenCalled()
    await f.manager.prepareEnrolled('1.2.0-beta.2', true)
    expect(f.options.load).toHaveBeenCalledOnce()
  })
  it('rejects wrong server identities before mutation and fences profile changes after credential reads', async () => {
    const f = fixture()
    f.clients.a.health.mockResolvedValue(health('other'))
    expect(await f.manager.prepare('1.2.0-beta.2')).toBe(false)
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
    expect(f.manager.status()[0].phase).toBe('blocked')
    f.clients.a.health.mockResolvedValue(health())
    f.assertCurrent.mockImplementation(() => { throw new Error('Server profile identity changed.') })
    await f.manager.reconcileAll()
    expect(f.clients.a.ensureServerUpdate).not.toHaveBeenCalled()
  })
})
