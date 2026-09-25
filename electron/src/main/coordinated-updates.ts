import { verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CoordinatedServerUpdate, Health, ServerUpdateStatus, ServerUpdateTrack } from '../shared/types'
import { needsLegacyUpdateRecovery } from '../shared/server-update-recovery'
import { AgentServerClient, ServerError, type ServerUpdateTarget } from './server-client'

// This is the existing server release trust root, not an npm registry key.
export const SERVER_RELEASE_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAdQ/g4Ta92ClC4Qx2L0Z339ylFhOyE2M6GK5nfXdPk8Y=\n-----END PUBLIC KEY-----\n'
const MAX_MANIFEST_BYTES = 8 * 1024
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/
const ACTIVE_PHASES = new Set(['pending', 'starting', 'checking', 'downloading', 'verifying', 'installing', 'restarting'])

class ComponentHealthError extends Error {}

function componentVersions(health: Health): { executionVersion: string; gatewayVersion: string } | null {
  if (health.gateway === undefined && health.execution_service === undefined) return null
  const gateway = health.gateway, execution = health.execution_service
  if (!gateway || !execution || gateway.protocol !== 1 || execution.protocol !== 1
    || typeof gateway.instance_id !== 'string' || !gateway.instance_id
    || typeof execution.instance_id !== 'string' || !execution.instance_id
    || typeof gateway.version !== 'string' || !RELEASE_VERSION.test(gateway.version)
    || typeof execution.version !== 'string' || !RELEASE_VERSION.test(execution.version)
    || execution.version !== health.server_version
    || (execution.maintenance_held !== undefined && typeof execution.maintenance_held !== 'boolean')) {
    throw new ComponentHealthError('The server returned inconsistent update information. Reconnect to verify the update.')
  }
  return { executionVersion: execution.version, gatewayVersion: gateway.version }
}

export interface SignedServerRelease {
  manifest_base64: string
  signature_base64: string
}
export interface PairedServerManifest {
  schema: 2
  distribution: 'npm'
  version: string
  track: ServerUpdateTrack
  api_contract_version: number
  minimum_server_api_contract: number
}
export interface CoordinatedProfile {
  id: string
  name: string
  serverIdentity: string | null
  active?: boolean
}
export interface CoordinatedConnection {
  client: Pick<AgentServerClient, 'health' | 'ensureServerUpdate' | 'serverUpdateStatus' | 'startServerUpdate' | 'dispose'>
  assertCurrent(): void
  loopback: boolean
}
export interface CoordinatedUpdatePlan {
  envelope: SignedServerRelease
  records: CoordinatedServerUpdate[]
}
export interface CoordinatedUpdateStore {
  read(): CoordinatedUpdatePlan | null
  write(value: CoordinatedUpdatePlan): void
}
export interface CoordinatedUpdateOptions {
  profiles(): CoordinatedProfile[]
  connect(profile: CoordinatedProfile): Promise<CoordinatedConnection>
  store: CoordinatedUpdateStore
  publish(records: CoordinatedServerUpdate[]): void
  publicKey?: string
  onError?: (error: unknown) => void
}

/** Durable intent belongs to the app; update admission and ownership belong to the server. */
export class CoordinatedUpdateManager {
  private plan: CoordinatedUpdatePlan | null = null
  private manifest: PairedServerManifest | null = null
  private readonly inFlight = new Map<string, { generation: number; task: Promise<void> }>()
  private readonly observations = new Map<string, string>()
  private readonly pendingObservations = new Set<string>()
  private generation = 0

  constructor(private readonly options: CoordinatedUpdateOptions) {}

  status(): CoordinatedServerUpdate[] { return structuredClone(this.plan?.records ?? []) }

  async resume(bundled?: SignedServerRelease, installedVersion?: string): Promise<void> {
    if (!bundled) {
      // An app-only release must not revive an older app's server-update intent.
      // Keep the durable receipt for a future explicitly paired release.
      this.generation += 1
      this.plan = null
      this.manifest = null
      this.observations.clear()
      this.pendingObservations.clear()
      this.options.publish([])
      return
    }
    const saved = this.options.store.read()
    const manifest = this.verify(bundled, installedVersion)
    // The installed app's bundle owns the desired server release. A cached
    // pre-install plan from an older app must not override that choice.
    this.adopt(bundled, manifest, saved?.records ?? [])
    await this.reconcileAll()
  }

  serverReachable(profileId: string, health: Health): void {
    if (!this.plan) return
    const observation = JSON.stringify([health.server_identity, health.server_instance_id, health.server_version,
      health.api_contract_version, health.gateway, health.execution_service, health.server_update])
    const record = this.plan.records.find(candidate => candidate.profileId === profileId
      && candidate.serverIdentity === health.server_identity)
    // Older bridges omit update progress from health. Observe our admitted
    // operation on the service's existing health callbacks until it settles;
    // identical idle/paused health still causes no additional requests.
    const legacyOperationNeedsStatus = health.server_update == null && !health.capabilities?.server_update_ensure_v1
      && record && !record.paused && (record.operationId || record.scheduleId)
      && (record.operationOwned || record.operationTargetVersion === this.manifest?.version)
      && ['pending', 'updating', 'offline'].includes(record.phase)
    if (this.observations.get(profileId) === observation && !legacyOperationNeedsStatus) return
    this.observations.set(profileId, observation)
    if (this.inFlight.has(profileId)) {
      this.pendingObservations.add(profileId)
      return
    }
    void this.reconcile(profileId).catch(error => this.options.onError?.(error))
  }

  serverUnavailable(profileId: string): void { this.observations.delete(profileId) }

  async retry(profileId: string): Promise<void> {
    const profile = this.options.profiles().find(candidate => candidate.id === profileId)
    const record = this.plan?.records.find(candidate => candidate.profileId === profileId && candidate.serverIdentity === profile?.serverIdentity)
    if (!profile || !record) throw new Error('The saved server update no longer belongs to this profile.')
    Object.assign(record, { paused: false, operationId: undefined, scheduleId: undefined,
      operationTargetVersion: undefined, operationOwned: false, phase: 'checking', message: 'Retrying the paired server update…' })
    this.save()
    await this.reconcile(profileId)
  }

  private verify(envelope: SignedServerRelease, version?: string): PairedServerManifest {
    return verifyPairedRelease(envelope, version, this.options.publicKey ?? SERVER_RELEASE_PUBLIC_KEY)
  }

  private adopt(envelope: SignedServerRelease, manifest: PairedServerManifest, previous: CoordinatedServerUpdate[]): void {
    this.generation += 1
    this.manifest = manifest
    this.observations.clear()
    this.plan = { envelope, records: this.options.profiles().map(profile => {
      const old = previous.find(record => record.profileId === profile.id && record.serverIdentity === profile.serverIdentity)
      const sameTarget = old?.targetVersion === manifest.version
      const paused = sameTarget && old.paused === true
      return { ...old, profileId: profile.id, name: profile.name, serverIdentity: profile.serverIdentity,
        ...(!sameTarget ? { operationId: undefined, scheduleId: undefined,
          operationTargetVersion: undefined, operationOwned: false } : {}),
        targetVersion: manifest.version, paused, phase: paused ? old!.phase : 'checking',
        message: paused ? old!.message : 'Checking the paired server update…' }
    }) }
    this.save()
  }

  async reconcileAll(): Promise<void> {
    if (!this.plan) return
    await Promise.all(this.options.profiles().map(profile => this.reconcile(profile.id)))
  }

  private reconcile(profileId: string): Promise<void> {
    const existing = this.inFlight.get(profileId)
    if (existing) return existing.generation === this.generation ? existing.task
      : existing.task.then(() => this.reconcile(profileId))
    const task = this.reconcileOne(profileId).finally(() => {
      if (this.inFlight.get(profileId)?.task === task) this.inFlight.delete(profileId)
      if (this.pendingObservations.delete(profileId)) {
        void this.reconcile(profileId).catch(error => this.options.onError?.(error))
      }
    })
    this.inFlight.set(profileId, { generation: this.generation, task })
    return task
  }

  private async reconcileOne(profileId: string): Promise<void> {
    const profile = this.options.profiles().find(candidate => candidate.id === profileId)
    const manifest = this.manifest, plan = this.plan, generation = this.generation
    if (!profile || !manifest || !plan) return
    const previousReceipt = plan.records.find(candidate => candidate.profileId === profileId && candidate.serverIdentity === profile.serverIdentity)
    let connection: CoordinatedConnection | null = null
    const patch = (update: Partial<CoordinatedServerUpdate>): void => {
      if (generation !== this.generation) return
      const current = this.options.profiles().find(candidate => candidate.id === profileId)
      if (!current || current.serverIdentity !== profile.serverIdentity) return
      let record = plan.records.find(candidate => candidate.profileId === profileId && candidate.serverIdentity === profile.serverIdentity)
      if (!record) {
        plan.records = plan.records.filter(candidate => candidate.profileId !== profileId)
        record = { profileId, name: profile.name, serverIdentity: profile.serverIdentity, targetVersion: manifest.version,
          phase: 'checking', message: 'Checking the paired server update…' }
        plan.records.push(record)
      }
      Object.assign(record, update)
      this.save()
    }
    let timeout: NodeJS.Timeout | undefined
    try {
      connection = await this.options.connect(profile)
      const currentConnection = connection
      const health = await Promise.race([
        connection.client.health(),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => {
          currentConnection.client.dispose()
          reject(new Error('Server is offline; the paired update will resume on reconnect.'))
        }, 8_000) })
      ])
      clearTimeout(timeout)
      connection.assertCurrent()
      if (generation !== this.generation) return
      if (!health.ok || !profile.serverIdentity || health.server_identity !== profile.serverIdentity) {
        patch({ phase: 'blocked', message: 'Reconnect and verify this server identity before updating.' })
        return
      }
      const capability = health.capabilities?.server_update_ensure_v1
      const updateVersion = legacyUpdateCapabilityVersion(health)
      const target = capability || updateVersion >= 9 ? updateTarget(health) : undefined
      const components = componentVersions(health)
      patch({ apiContractVersion: health.api_contract_version, serverInstanceId: health.server_instance_id,
        gatewayVersion: components?.gatewayVersion, executionVersion: components?.executionVersion })
      const currentVersion = health.server_version ?? ''
      const executionCurrent = compareReleaseVersions(currentVersion, manifest.version) >= 0
      const gatewayCurrent = !components || compareReleaseVersions(components.gatewayVersion, manifest.version) >= 0
      const updateReceipt = health.server_update
      const activeTarget = updateReceipt && typeof updateReceipt === 'object' && !Array.isArray(updateReceipt)
        && updateReceipt.target_version === manifest.version && typeof updateReceipt.phase === 'string'
        && ACTIVE_PHASES.has(updateReceipt.phase)
      const activationPending = health.execution_service?.maintenance_held === true || activeTarget
      if (executionCurrent && gatewayCurrent && !activationPending) {
        const api = health.api_contract_version
        const supported = api !== undefined && api >= manifest.minimum_server_api_contract && api <= manifest.api_contract_version
        patch({ phase: supported ? 'current' : 'blocked', paused: false,
          message: supported ? 'Server is up to date.'
            : api === undefined ? 'The server did not report its API version. Reconnect to check it.'
              : api < manifest.minimum_server_api_contract ? 'This server needs an update before chats can connect.'
                : 'Update AgentsDock to connect to this server’s newer API.' })
        return
      }
      if (previousReceipt?.paused) return
      let status: ServerUpdateStatus
      let observedStatus: ServerUpdateStatus | undefined
      let operationOwned = false
      if (previousReceipt && (previousReceipt.operationOwned || previousReceipt.operationTargetVersion === manifest.version)
        && (previousReceipt.operationId || previousReceipt.scheduleId)) {
        const observed = await connection.client.serverUpdateStatus(target)
        observedStatus = observed
        connection.assertCurrent()
        if (target && (observed.server_identity !== target.expected_server_identity || observed.server_instance_id !== target.expected_server_instance_id)) {
          patch({ phase: 'blocked', message: 'Update status belongs to another server instance.' })
          return
        }
        const failedOwnTarget = (observed.phase === 'failed' || ['server_update_recovery_failed', 'server_update_recovery_launch_failed'].includes(observed.error_code ?? '')) && (observed.target_version === previousReceipt.operationTargetVersion
          || Boolean(observed.update_id && observed.update_id === previousReceipt.operationId)
          || Boolean(observed.schedule_id && observed.schedule_id === previousReceipt.scheduleId))
        const canceledOwnReservation = ['idle', 'available', 'current'].includes(observed.phase)
        if (failedOwnTarget || canceledOwnReservation) {
          patch({ paused: true, phase: failedOwnTarget ? 'failed' : 'blocked',
            message: failedOwnTarget ? observed.message || 'The server update failed. Retry when ready.'
              : 'The server update was canceled. Retry when ready.' })
          return
        }
      }
      const canRecoverActivation = capability && typeof capability === 'object' && !Array.isArray(capability)
        && 'activation_recovery' in capability && capability.activation_recovery === true
      if (executionCurrent && (!gatewayCurrent || activationPending) && !canRecoverActivation) {
        // Execution can become healthy before the gateway finishes activation.
        // Retain the existing operation; never treat half an update as current
        // or start another replacement of the same execution runtime.
        const observed = observedStatus ?? await connection.client.serverUpdateStatus(target)
        connection.assertCurrent()
        if (!target || observed.server_identity !== target.expected_server_identity
          || observed.server_instance_id !== target.expected_server_instance_id) {
          patch({ phase: 'blocked', message: 'Update status belongs to another server instance.' })
          return
        }
        const active = ACTIVE_PHASES.has(observed.phase)
        patch({ phase: observed.phase === 'failed' ? 'failed' : active ? 'pending' : 'blocked',
          paused: observed.phase === 'failed',
          message: observed.phase === 'failed' ? observed.message || 'The server update failed before all components were ready. Retry when ready.'
            : active ? observed.message || 'Finishing the server update; waiting for verified reconnection.'
              : 'The server update is incomplete. Reconnect to check recovery.' })
        return
      }
      if (capability && typeof capability === 'object' && !Array.isArray(capability)) {
        if (!('available' in capability) || capability.available !== true || !target) {
          patch({ phase: 'blocked', message: 'Managed coordinated updates are unavailable on this server.' })
          return
        }
        connection.assertCurrent()
        try {
          status = await connection.client.ensureServerUpdate(plan.envelope, target)
        } catch (error) {
          if (isLegacyChannelConflict(error)) {
            // Old ensure handlers rejected a channel change that their manual
            // update route already supports. Use the same verified bundle and
            // authenticated server identity, without release discovery.
            status = await this.bridge(connection, health, manifest, target, () => { operationOwned = true })
          } else {
            if (!(error instanceof ServerError) || error.status !== 409 || !isPendingConflict(error)) throw error
            // Observe an existing reservation until that server reconciles it.
            status = await connection.client.serverUpdateStatus(target)
            if (!ACTIVE_PHASES.has(status.phase)) throw error
          }
        }
      } else {
        status = await this.bridge(connection, health, manifest, target, () => { operationOwned = true })
      }
      connection.assertCurrent()
      const updateCapability = health.capabilities?.server_updates
      const replyIsFenced = capability || (updateCapability && typeof updateCapability === 'object'
        && 'version' in updateCapability && Number(updateCapability.version) >= 9)
      if (replyIsFenced && target && (status.server_identity !== target.expected_server_identity
        || status.server_instance_id !== target.expected_server_instance_id)) {
        patch({ phase: 'blocked', message: 'Update response belongs to another server instance. Reconnect to reconcile it.' })
        return
      }
      const recoveryFailed = ['server_update_recovery_failed', 'server_update_recovery_launch_failed'].includes(status.error_code ?? '')
      patch({ phase: recoveryFailed ? 'failed' : status.phase === 'pending' ? 'pending' : status.phase === 'failed' ? 'failed'
        : ACTIVE_PHASES.has(status.phase) ? 'updating' : 'pending',
        ...(recoveryFailed ? { paused: true } : {}),
        operationId: status.update_id ?? undefined, scheduleId: status.schedule_id ?? undefined,
        operationTargetVersion: status.target_version ?? manifest.version,
        operationOwned: operationOwned || (previousReceipt?.operationOwned === true
          && previousReceipt.operationTargetVersion === (status.target_version ?? manifest.version)),
        message: status.message || 'Server update accepted; waiting for verified reconnection.' })
    } catch (error) {
      if (previousReceipt?.paused && !(error instanceof ComponentHealthError)) return
      const message = error instanceof Error ? error.message : String(error)
      patch({ phase: error instanceof ServerError || error instanceof ComponentHealthError || /channel|identity|legacy|managed|signed/i.test(message) ? 'blocked' : 'offline',
        ...(error instanceof ServerError && error.status === 503 && needsLegacyUpdateRecovery(message) ? { paused: true } : {}),
        message })
    } finally {
      clearTimeout(timeout)
      connection?.client.dispose()
    }
  }

  private async bridge(connection: CoordinatedConnection, health: Health, manifest: PairedServerManifest,
    target: ServerUpdateTarget | undefined, started: () => void): Promise<ServerUpdateStatus> {
    const capability = health.capabilities?.server_updates
    const version = legacyUpdateCapabilityVersion(health)
    if (!capability || typeof capability !== 'object' || Array.isArray(capability) || !('available' in capability) || capability.available !== true
      || version < 2 || (version >= 9 && !target)) {
      throw new Error('This legacy server needs the guided installer before automatic updates are available.')
    }
    const current = await connection.client.serverUpdateStatus(version >= 9 ? target : undefined)
    connection.assertCurrent()
    if (ACTIVE_PHASES.has(current.phase)) return current // Join; never cancel another client's reservation.
    // The signed app bundle already selects an exact server version and channel.
    // Legacy release discovery adds a rate-limited request without changing that
    // choice; the runner verifies the selected release before installing it.
    started()
    return connection.client.startServerUpdate(manifest.version, manifest.track, version >= 7, version >= 9 ? target : undefined)
  }

  private save(): void {
    if (!this.plan) return
    this.options.store.write(this.plan)
    this.options.publish(this.status())
  }
}

function updateTarget(health: Health): ServerUpdateTarget | undefined {
  return health.server_identity && health.server_instance_id ? {
    expected_server_identity: health.server_identity,
    expected_server_instance_id: health.server_instance_id
  } : undefined
}

function legacyUpdateCapabilityVersion(health: Health): number {
  const capability = health.capabilities?.server_updates
  return capability && typeof capability === 'object' && !Array.isArray(capability)
    && 'version' in capability && typeof capability.version === 'number' && Number.isFinite(capability.version) ? capability.version : 0
}

function isPendingConflict(error: ServerError): boolean {
  const detail = error.detail
  return Boolean(detail && typeof detail === 'object' && 'error_code' in detail && detail.error_code === 'server_update_pending')
    || error.message.includes('server_update_pending')
}

function isLegacyChannelConflict(error: unknown): boolean {
  return error instanceof ServerError && error.status === 409
    && Boolean(error.detail && typeof error.detail === 'object'
      && 'code' in error.detail && error.detail.code === 'server_update_channel_conflict')
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = RELEASE_VERSION.exec(left), b = RELEASE_VERSION.exec(right)
  if (!a || !b) throw new Error('Server release version is not recognized; automatic downgrade is disabled.')
  for (let index = 1; index <= 3; index += 1) {
    const difference = BigInt(a[index]) - BigInt(b[index])
    if (difference !== 0n) return difference > 0n ? 1 : -1
  }
  if (!a[4]) return b[4] ? 1 : 0
  if (!b[4]) return -1
  return BigInt(a[4]) === BigInt(b[4]) ? 0 : BigInt(a[4]) > BigInt(b[4]) ? 1 : -1
}

export function verifyPairedRelease(envelope: SignedServerRelease, expectedVersion?: string,
  publicKey = SERVER_RELEASE_PUBLIC_KEY): PairedServerManifest {
  if (!envelope || typeof envelope.manifest_base64 !== 'string' || typeof envelope.signature_base64 !== 'string'
    || envelope.manifest_base64.length > Math.ceil(MAX_MANIFEST_BYTES / 3) * 4 || envelope.signature_base64.length !== 88) {
    throw new Error('Paired server release descriptor exceeds its bounds.')
  }
  const bytes = Buffer.from(envelope.manifest_base64, 'base64'), signature = Buffer.from(envelope.signature_base64, 'base64')
  if (bytes.toString('base64') !== envelope.manifest_base64 || signature.toString('base64') !== envelope.signature_base64
    || signature.length !== 64 || !verify(null, bytes, publicKey, signature)) {
    throw new Error('Paired server release signature is invalid.')
  }
  const manifest = JSON.parse(bytes.toString('utf8')) as PairedServerManifest
  if (manifest.schema !== 2 || manifest.distribution !== 'npm' || !RELEASE_VERSION.test(manifest.version)
    || (expectedVersion !== undefined && manifest.version !== expectedVersion)
    || manifest.track !== (manifest.version.includes('-') ? 'beta' : 'stable')
    || !Number.isSafeInteger(manifest.api_contract_version) || manifest.api_contract_version < 1
    || !Number.isSafeInteger(manifest.minimum_server_api_contract) || manifest.minimum_server_api_contract < 1
    || manifest.minimum_server_api_contract > manifest.api_contract_version) {
    throw new Error('Paired server release descriptor does not match this app version or compatibility contract.')
  }
  return manifest
}

export function fileCoordinatedUpdateStore(path: string): CoordinatedUpdateStore {
  return {
    read: () => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as CoordinatedUpdatePlan : null,
    write: value => {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.tmp`
      writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
      renameSync(temporary, path)
    }
  }
}
