import { app, safeStorage } from 'electron'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import {
  deriveServerTeamHubURL,
  deriveSecurePeerTeamHubURL,
  isLoopbackHostname,
  normalizeMountedTeamHubURL
} from '../shared/team-hub-url'
import { normalizeServerURL } from '../shared/server-url'
import { writeMacOSKeychainPassword } from './macos-keychain'

interface TeamHubStoredSettingsV1 {
  schemaVersion: 1
  profileId: string
  hubUrl: string
  hubIdentity: string | null
  keychainRefreshToken: boolean
  encryptedRefreshToken?: string
}

export interface TeamHubStoredBinding {
  profileId: string
  serverUrl: string
  serverIdentity: string
  hubUrl: string
  hubIdentity: string
  connectionId?: string
  hostServerIdentity?: string
  keychainRefreshToken: boolean
  encryptedRefreshToken?: string
  /** Write-ahead fence for a rotating credential that may have been consumed. */
  rejectedRefreshTokenFingerprint?: string
  /** Random durable namespace for cached bytes owned by one signed-in session. */
  authCacheEpoch?: string
  /** Present only after an explicit user Disconnect/Deactivate action. */
  backgroundReconnectDisabled?: true
}

export interface TeamHubStoredSettings {
  schemaVersion: 2
  bindings: TeamHubStoredBinding[]
  /** Explicitly disconnected/forgotten profiles with no binding left to carry the preference. */
  backgroundReconnectDisabledProfiles?: string[]
}

export interface TeamHubVerifiedBinding {
  profileId: string
  serverUrl: string
  serverIdentity: string
  hubUrl: string
  hubIdentity: string
  connectionId?: string
  hostServerIdentity?: string
}

export interface TeamHubPublicSettings extends TeamHubVerifiedBinding {
  hasRefreshCredential: boolean
}

export interface TeamHubKeychain {
  read(account: string): string
  write(account: string, value: string): boolean
  delete(account: string): void
}

export interface TeamHubSafeStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown'
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface TeamHubSettingsStoreOptions {
  path?: string
  keychain?: TeamHubKeychain
  secureStorage?: TeamHubSafeStorage
  isMacAppStoreBuild?: () => boolean
  /** Retained as a source-compatible no-op for pre-embedded test harnesses. */
  createProfileId?: () => string
}

export interface TeamHubServerProfileCleanup {
  removed: boolean
  /** Binding removal committed, but best-effort cache cleanup was incomplete. */
  cleanupWarning?: string
  /** Restore the exact profile-scoped binding when parent-profile deletion fails. */
  rollback(): void
}

const KEYCHAIN_SERVICE = 'com.zhengyiluo.AgentsDock.TeamHub'
const KEYCHAIN_ACCOUNT_PREFIX = 'refresh-token:'
const MAX_BINDINGS = 64
let temporaryFileCounter = 0

export class TeamHubSettingsStore {
  private readonly path: string
  private readonly keychain: TeamHubKeychain
  private readonly secureStorage: TeamHubSafeStorage
  private readonly useKeychain: boolean
  private value: TeamHubStoredSettings

  constructor(options: TeamHubSettingsStoreOptions = {}) {
    this.path = options.path ?? join(app.getPath('userData'), 'team-hub-settings.json')
    this.keychain = options.keychain ?? systemTeamHubKeychain
    this.secureStorage = options.secureStorage ?? safeStorage
    this.useKeychain = !(options.isMacAppStoreBuild ?? isMacAppStoreBuild)()
    this.value = this.read()
  }

  publicSettings(profileId: string): TeamHubPublicSettings | null {
    const binding = this.value.bindings.find(candidate => candidate.profileId === profileId)
    return binding ? publicBinding(binding) : null
  }

  backgroundReconnectAllowed(profileId: string): boolean {
    if (this.value.backgroundReconnectDisabledProfiles?.includes(profileId)) return false
    const binding = this.value.bindings.find(candidate => candidate.profileId === profileId)
    return binding?.backgroundReconnectDisabled !== true
  }

  setProfileBackgroundReconnectAllowed(profileId: string, allowed: boolean): void {
    const cleanProfileId = cleanIdentifier(profileId, 'AgentsServer profile', 240)
    const disabled = this.value.backgroundReconnectDisabledProfiles ?? []
    const currentlyAllowed = !disabled.includes(cleanProfileId)
    if (currentlyAllowed === allowed) return
    const nextDisabled = allowed
      ? disabled.filter(candidate => candidate !== cleanProfileId)
      : boundedReconnectDisabledProfiles(disabled, cleanProfileId)
    const next: TeamHubStoredSettings = {
      ...this.value,
      ...(nextDisabled.length > 0 ? { backgroundReconnectDisabledProfiles: nextDisabled } : {})
    }
    if (nextDisabled.length === 0) delete next.backgroundReconnectDisabledProfiles
    this.persist(next)
    this.value = next
  }

  setBackgroundReconnectAllowed(expected: TeamHubVerifiedBinding, allowed: boolean): void {
    const current = this.requireBinding(expected)
    if ((current.backgroundReconnectDisabled !== true) === allowed) return
    const nextBinding: TeamHubStoredBinding = { ...current }
    if (allowed) delete nextBinding.backgroundReconnectDisabled
    else nextBinding.backgroundReconnectDisabled = true
    const next = replaceBinding(this.value, nextBinding)
    this.persist(next)
    this.value = next
  }

  refreshToken(profileId: string): string {
    const binding = this.value.bindings.find(candidate => candidate.profileId === profileId)
    if (!binding) return ''
    // A credential previously used over plaintext Direct IP stays dormant. It
    // may be reused only after the same verified Hub migrates to a safe route.
    if (isLegacyDirectTeamHubURL(binding.hubUrl)) return ''
    if (binding.keychainRefreshToken) {
      const token = this.keychain.read(keychainAccount(profileId))
      if (token) return token
    }
    // Preserve legacy ciphertext for a future secure-backend recovery, but do
    // not turn Electron's Linux `basic_text` obfuscation into a live bearer.
    if (!binding.encryptedRefreshToken || !secureCredentialStorageAvailable(this.secureStorage)) return ''
    try {
      return this.secureStorage.decryptString(Buffer.from(binding.encryptedRefreshToken, 'base64'))
    } catch {
      return ''
    }
  }

  rejectedRefreshTokenFingerprint(profileId: string): string | null {
    const binding = this.value.bindings.find(candidate => candidate.profileId === profileId)
    return binding?.rejectedRefreshTokenFingerprint ?? null
  }

  authCacheEpoch(profileId: string): string | null {
    const binding = this.value.bindings.find(candidate => candidate.profileId === profileId)
    return binding?.authCacheEpoch ?? null
  }

  markRefreshTokenUse(expected: TeamHubVerifiedBinding, fingerprint: string): void {
    const current = this.requireBinding(expected)
    const cleanFingerprint = cleanCredentialFingerprint(fingerprint)
    if (current.rejectedRefreshTokenFingerprint === cleanFingerprint) return
    const nextBinding = { ...current, rejectedRefreshTokenFingerprint: cleanFingerprint }
    const next = replaceBinding(this.value, nextBinding)
    this.persist(next)
    this.value = next
  }

  activateVerifiedHub(value: TeamHubVerifiedBinding): TeamHubPublicSettings {
    const verified = cleanBinding(value)
    const current = this.value.bindings.find(candidate => candidate.profileId === verified.profileId)
    if (current && sameBinding(current, verified)) return publicBinding(current)
    if (current && sameBindingIdentity(current, verified)) {
      // Route selection is not identity enrollment. The caller must first fence
      // the candidate against authenticated discovery and verify the Hub health
      // identity; then the same profile may move between its advertised routes
      // without discarding the independently stored refresh credential.
      const nextBinding: TeamHubStoredBinding = { ...current, hubUrl: verified.hubUrl }
      const next = replaceBinding(this.value, nextBinding)
      this.persist(next)
      this.value = next
      return publicBinding(nextBinding)
    }
    if (current && isSecureBindingLineageMove(current, verified)) {
      // A newly activated secure-peer connection to the same pinned remote Hub
      // replaces only the connection-bound proxy lane. Secure bindings never
      // carry a human refresh credential, so persist that invariant before
      // removing any stale profile-scoped Keychain item.
      const nextBinding: TeamHubStoredBinding = {
        ...current,
        hubUrl: verified.hubUrl,
        connectionId: verified.connectionId,
        keychainRefreshToken: false
      }
      delete nextBinding.encryptedRefreshToken
      delete nextBinding.rejectedRefreshTokenFingerprint
      delete nextBinding.authCacheEpoch
      const next = replaceBinding(this.value, nextBinding)
      this.persist(next)
      this.value = next
      this.keychain.delete(keychainAccount(verified.profileId))
      return publicBinding(nextBinding)
    }
    if (current) {
      throw new Error('The active AgentsServer advertised a different Team Hub identity. Forget or re-enroll this server profile explicitly before trusting it.')
    }
    if (!current && this.value.bindings.length >= MAX_BINDINGS) {
      throw new Error('Too many Team Hub server bindings are stored on this device.')
    }
    const nextBinding: TeamHubStoredBinding = {
      ...verified,
      keychainRefreshToken: false
    }
    const next: TeamHubStoredSettings = {
      ...this.value,
      schemaVersion: 2,
      bindings: [...this.value.bindings, nextBinding]
    }
    this.persist(next)
    this.value = next
    return publicBinding(nextBinding)
  }

  /**
   * Adopt a binding only after the authenticated AgentsServer proxy has
   * returned and validated its service session. That server proof is
   * authoritative and replaces stale device-local enrollment state.
   */
  activateServerVerifiedHub(value: TeamHubVerifiedBinding): TeamHubPublicSettings {
    const verified = cleanServerBinding(value)
    const current = this.value.bindings.find(candidate => candidate.profileId === verified.profileId)
    if (!current && this.value.bindings.length >= MAX_BINDINGS) {
      throw new Error('Too many Team Hub server bindings are stored on this device.')
    }
    const nextBinding: TeamHubStoredBinding = { ...verified, keychainRefreshToken: false }
    const next: TeamHubStoredSettings = current
      ? replaceBinding(this.value, nextBinding)
      : { ...this.value, schemaVersion: 2, bindings: [...this.value.bindings, nextBinding] }
    this.persist(next)
    this.value = next
    this.keychain.delete(keychainAccount(verified.profileId))
    return publicBinding(nextBinding)
  }

  forgetBinding(profileId: string): boolean {
    const cleanProfileId = cleanIdentifier(profileId, 'AgentsServer profile', 240)
    if (!this.value.bindings.some(binding => binding.profileId === cleanProfileId)) return false
    const next: TeamHubStoredSettings = {
      ...this.value,
      schemaVersion: 2,
      bindings: this.value.bindings.filter(binding => binding.profileId !== cleanProfileId),
      backgroundReconnectDisabledProfiles: boundedReconnectDisabledProfiles(
        this.value.backgroundReconnectDisabledProfiles ?? [],
        cleanProfileId
      )
    }
    this.persist(next)
    this.value = next
    this.keychain.delete(keychainAccount(cleanProfileId))
    return true
  }

  /** Remove all local Teamspace state owned by a server profile being deleted. */
  removeServerProfile(profileId: string): TeamHubServerProfileCleanup {
    const cleanProfileId = cleanIdentifier(profileId, 'AgentsServer profile', 240)
    const previous: TeamHubStoredSettings = JSON.parse(JSON.stringify(this.value)) as TeamHubStoredSettings
    const previousBinding = previous.bindings.find(binding => binding.profileId === cleanProfileId)
    const previousToken = previousBinding ? this.refreshToken(cleanProfileId) : ''
    const disabledProfiles = (this.value.backgroundReconnectDisabledProfiles ?? [])
      .filter(candidate => candidate !== cleanProfileId)
    const removed = Boolean(previousBinding || disabledProfiles.length !== (this.value.backgroundReconnectDisabledProfiles ?? []).length)
    if (removed) {
      const next: TeamHubStoredSettings = {
        ...this.value,
        schemaVersion: 2,
        bindings: this.value.bindings.filter(binding => binding.profileId !== cleanProfileId),
        ...(disabledProfiles.length > 0 ? { backgroundReconnectDisabledProfiles: disabledProfiles } : {})
      }
      if (disabledProfiles.length === 0) delete next.backgroundReconnectDisabledProfiles
      this.persist(next)
      this.value = next
    }
    this.keychain.delete(keychainAccount(cleanProfileId))
    let rolledBack = false
    return {
      removed,
      rollback: () => {
        if (rolledBack || !removed) return
        this.persist(previous)
        this.value = previous
        if (previousBinding?.keychainRefreshToken && previousToken) {
          this.keychain.write(keychainAccount(cleanProfileId), previousToken)
        }
        rolledBack = true
      }
    }
  }

  storeRefreshToken(token: string, expected: TeamHubVerifiedBinding, authCacheEpoch?: string): void {
    const current = this.requireBinding(expected)
    const clean = cleanSecret(token)
    const account = keychainAccount(current.profileId)
    const oldToken = this.refreshToken(current.profileId)
    const oldUsedKeychain = current.keychainRefreshToken
    const wroteKeychain = this.useKeychain && this.keychain.write(account, clean)
    const nextBinding: TeamHubStoredBinding = wroteKeychain
      ? { ...current, keychainRefreshToken: true, encryptedRefreshToken: undefined }
      : this.encryptedBinding(current, clean)
    delete nextBinding.rejectedRefreshTokenFingerprint
    if (authCacheEpoch !== undefined) nextBinding.authCacheEpoch = cleanAuthCacheEpoch(authCacheEpoch)
    const next = replaceBinding(this.value, nextBinding)
    try {
      this.persist(next)
      this.value = next
      if (!wroteKeychain) this.keychain.delete(account)
    } catch (error) {
      if (wroteKeychain) {
        if (oldUsedKeychain && oldToken) this.keychain.write(account, oldToken)
        else this.keychain.delete(account)
      }
      throw error
    }
  }

  clearRefreshToken(expected: TeamHubVerifiedBinding): void {
    const current = this.requireBinding(expected)
    const nextBinding: TeamHubStoredBinding = { ...current, keychainRefreshToken: false }
    delete nextBinding.encryptedRefreshToken
    delete nextBinding.rejectedRefreshTokenFingerprint
    delete nextBinding.authCacheEpoch
    const next = replaceBinding(this.value, nextBinding)
    this.persist(next)
    this.value = next
    this.keychain.delete(keychainAccount(current.profileId))
  }

  private encryptedBinding(current: TeamHubStoredBinding, token: string): TeamHubStoredBinding {
    if (!secureCredentialStorageAvailable(this.secureStorage)) {
      throw new Error('Secure credential storage is unavailable. Team Hub sign-in was not saved.')
    }
    return {
      ...current,
      keychainRefreshToken: false,
      encryptedRefreshToken: this.secureStorage.encryptString(token).toString('base64')
    }
  }

  private requireBinding(expected: TeamHubVerifiedBinding): TeamHubStoredBinding {
    const clean = cleanBinding(expected)
    const current = this.value.bindings.find(candidate => candidate.profileId === clean.profileId)
    if (!current || !sameBinding(current, clean)) {
      throw new Error('Team Hub connection changed. Refresh Teamspace and try again.')
    }
    return current
  }

  private read(): TeamHubStoredSettings {
    if (!existsSync(this.path)) return this.createDefault()
    try {
      return this.parse(readFileSync(this.path, 'utf8'))
    } catch (primaryError) {
      // A syntactically valid but unsupported/invalid schema is not corruption.
      // In particular, a downgraded app must not quarantine a newer schema and
      // silently replace it with an empty Teamspace store.
      if (!(primaryError instanceof SyntaxError)) throw primaryError
      // Never recover authority from a secondary snapshot. Credential and
      // binding deletion must not be reversible through a stale backup after
      // an interrupted write or later primary-file corruption.
      const corruptPath = `${this.path}.corrupt-${Date.now()}`
      try { renameSync(this.path, corruptPath) } catch { throw primaryError }
      return this.createDefault()
    }
  }

  private parse(raw: string): TeamHubStoredSettings {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Team Hub settings are invalid.')
    const item = parsed as Record<string, unknown>
    if (item.schemaVersion === 1) return this.migrateV1(item as unknown as Partial<TeamHubStoredSettingsV1>)
    if (item.schemaVersion !== 2 || !Array.isArray(item.bindings) || item.bindings.length > MAX_BINDINGS) {
      throw new Error('Unsupported Team Hub settings schema.')
    }
    const bindings = item.bindings.map(rawItem => {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) throw new Error('Team Hub settings are invalid.')
      const raw = rawItem as Partial<TeamHubStoredBinding>
      const binding: TeamHubStoredBinding = {
        ...cleanBinding(raw, true),
        keychainRefreshToken: raw.keychainRefreshToken === true
      }
      if (raw.backgroundReconnectDisabled !== undefined) {
        if (raw.backgroundReconnectDisabled !== true) throw new Error('Team Hub settings are invalid.')
        binding.backgroundReconnectDisabled = true
      }
      if (typeof raw.encryptedRefreshToken === 'string' && raw.encryptedRefreshToken) {
        binding.encryptedRefreshToken = raw.encryptedRefreshToken
      }
      if (raw.rejectedRefreshTokenFingerprint !== undefined) {
        binding.rejectedRefreshTokenFingerprint = cleanCredentialFingerprint(raw.rejectedRefreshTokenFingerprint)
      }
      if (raw.authCacheEpoch !== undefined) binding.authCacheEpoch = cleanAuthCacheEpoch(raw.authCacheEpoch)
      return binding
    })
    if (new Set(bindings.map(binding => binding.profileId)).size !== bindings.length) {
      throw new Error('Team Hub settings contain duplicate server bindings.')
    }
    const rawDisabledProfiles = item.backgroundReconnectDisabledProfiles
    if (rawDisabledProfiles !== undefined && (
      !Array.isArray(rawDisabledProfiles)
      || rawDisabledProfiles.length > MAX_BINDINGS
    )) throw new Error('Team Hub settings are invalid.')
    const backgroundReconnectDisabledProfiles = rawDisabledProfiles?.map(profileId => (
      cleanIdentifier(profileId, 'AgentsServer profile', 240)
    ))
    if (
      backgroundReconnectDisabledProfiles
      && new Set(backgroundReconnectDisabledProfiles).size !== backgroundReconnectDisabledProfiles.length
    ) throw new Error('Team Hub settings contain duplicate reconnect preferences.')
    return {
      schemaVersion: 2,
      bindings,
      ...(backgroundReconnectDisabledProfiles?.length ? { backgroundReconnectDisabledProfiles } : {})
    }
  }

  private migrateV1(parsed: Partial<TeamHubStoredSettingsV1>): TeamHubStoredSettings {
    // The old credential was bound only to a user-entered Hub URL, not an
    // authenticated AgentsServer profile tuple. It cannot be migrated safely.
    const legacyProfileId = cleanIdentifier(parsed.profileId, 'legacy Team Hub profile')
    const next: TeamHubStoredSettings = { schemaVersion: 2, bindings: [] }
    this.persist(next)
    this.keychain.delete(keychainAccount(legacyProfileId))
    return next
  }

  private createDefault(): TeamHubStoredSettings {
    const value: TeamHubStoredSettings = { schemaVersion: 2, bindings: [] }
    this.persist(value)
    return value
  }

  private persist(value: TeamHubStoredSettings): void {
    // A single atomic rename is the commit point. A crash leaves either the
    // prior complete state (the mutation did not commit) or the complete new
    // state; there is no second file whose authority can diverge.
    this.writeAtomic(this.path, serializeSettings(value))
  }

  private writeAtomic(target: string, contents: string): void {
    const directory = dirname(target)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    try { chmodSync(directory, 0o700) } catch { /* best effort on platforms without POSIX modes */ }
    const temporaryPath = `${target}.tmp-${process.pid}-${++temporaryFileCounter}`
    let descriptor: number | null = null
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600)
      writeFileSync(descriptor, contents, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = null
      renameSync(temporaryPath, target)
      try { chmodSync(target, 0o600) } catch { /* best effort on platforms without POSIX modes */ }
      syncDirectory(directory)
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor)
      rmSync(temporaryPath, { force: true })
      throw error
    }
  }
}

function serializeSettings(value: TeamHubStoredSettings): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function cleanCredentialFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Team Hub refresh credential fence is invalid.')
  }
  return value
}

function cleanAuthCacheEpoch(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error('Team Hub attachment cache epoch is invalid.')
  }
  return value
}

function secureCredentialStorageAvailable(storage: TeamHubSafeStorage): boolean {
  if (!storage.isEncryptionAvailable()) return false
  if (process.platform !== 'linux') return true
  const backend = storage.getSelectedStorageBackend?.()
  return backend === 'gnome_libsecret' || backend === 'kwallet' || backend === 'kwallet5' || backend === 'kwallet6'
}

function publicBinding(value: TeamHubStoredBinding): TeamHubPublicSettings {
  return {
    profileId: value.profileId,
    serverUrl: value.serverUrl,
    serverIdentity: value.serverIdentity,
    hubUrl: value.hubUrl,
    hubIdentity: value.hubIdentity,
    ...(value.connectionId ? { connectionId: value.connectionId } : {}),
    ...(value.hostServerIdentity ? { hostServerIdentity: value.hostServerIdentity } : {}),
    hasRefreshCredential: Boolean(value.keychainRefreshToken || value.encryptedRefreshToken)
  }
}

function cleanBinding(value: Partial<TeamHubVerifiedBinding>, allowLegacyDirect = false): TeamHubVerifiedBinding {
  const hubUrl = normalizeMountedTeamHubURL(cleanIdentifier(value.hubUrl, 'Team Hub URL', 2_048))
  const serverUrl = normalizeServerURL(cleanIdentifier(value.serverUrl, 'AgentsServer URL', 2_048))
  const secureConnectionId = securePeerConnectionIdFromHubURL(hubUrl)
  const serverProxy = isServerTeamHubProxyURL(hubUrl)
  if (serverProxy && hubUrl !== deriveServerTeamHubURL(serverUrl, '/api/team-hub-server')) {
    throw new Error('Server Team Hub binding is invalid.')
  }
  if (!allowLegacyDirect && !secureConnectionId && !serverProxy && isLegacyDirectTeamHubURL(hubUrl)) {
    throw new Error('Legacy plaintext Direct IP Teamspace bindings are no longer supported.')
  }
  const binding: TeamHubVerifiedBinding = {
    profileId: cleanIdentifier(value.profileId, 'AgentsServer profile', 240),
    serverUrl,
    serverIdentity: cleanIdentifier(value.serverIdentity, 'AgentsServer identity', 240),
    hubUrl,
    hubIdentity: cleanIdentifier(value.hubIdentity, 'Team Hub identity', 240)
  }
  if (secureConnectionId) {
    const connectionId = cleanIdentifier(value.connectionId, 'secure connection', 64)
    if (connectionId !== secureConnectionId) {
      throw new Error('Secure connection identifier is invalid.')
    }
    const expectedBasePath = `/api/team-hub-secure/${connectionId}`
    if (hubUrl !== deriveSecurePeerTeamHubURL(serverUrl, expectedBasePath, null)) {
      throw new Error('Secure Team Hub binding is invalid.')
    }
    binding.connectionId = connectionId
    binding.hostServerIdentity = cleanIdentifier(value.hostServerIdentity, 'host AgentsServer identity', 240)
  } else if (value.connectionId !== undefined || value.hostServerIdentity !== undefined) {
    throw new Error('Unexpected secure Team Hub binding metadata.')
  }
  return binding
}

function cleanServerBinding(value: Partial<TeamHubVerifiedBinding>): TeamHubVerifiedBinding {
  // The dedicated server-proof path performs its own exact proxy validation;
  // allow remote plaintext control origins to reach that check.
  const binding = cleanBinding(value, true)
  if (
    !isServerTeamHubProxyURL(binding.hubUrl)
    || binding.connectionId !== undefined
    || binding.hostServerIdentity !== undefined
  ) throw new Error('Server Team Hub binding is invalid.')
  return binding
}

function isLegacyDirectTeamHubURL(value: string): boolean {
  const url = new URL(value)
  return url.protocol === 'http:'
    && !isLoopbackHostname(url.hostname)
    && securePeerConnectionIdFromHubURL(value) === null
}

function securePeerConnectionIdFromHubURL(value: string): string | null {
  const match = /(?:^|\/)api\/team-hub-secure\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
    new URL(value).pathname
  )
  return match?.[1] ?? null
}

function isServerTeamHubProxyURL(value: string): boolean {
  return /(?:^|\/)api\/team-hub-server$/.test(new URL(value).pathname)
}

function sameBinding(left: TeamHubVerifiedBinding, right: TeamHubVerifiedBinding): boolean {
  return left.profileId === right.profileId
    && left.serverUrl === right.serverUrl
    && left.serverIdentity === right.serverIdentity
    && left.hubUrl === right.hubUrl
    && left.hubIdentity === right.hubIdentity
    && left.connectionId === right.connectionId
    && left.hostServerIdentity === right.hostServerIdentity
}

function sameBindingIdentity(left: TeamHubVerifiedBinding, right: TeamHubVerifiedBinding): boolean {
  return left.profileId === right.profileId
    && left.serverUrl === right.serverUrl
    && left.serverIdentity === right.serverIdentity
    && left.hubIdentity === right.hubIdentity
    && left.connectionId === right.connectionId
    && left.hostServerIdentity === right.hostServerIdentity
}

function isSecureBindingLineageMove(
  current: TeamHubStoredBinding,
  replacement: TeamHubVerifiedBinding
): boolean {
  const currentConnectionId = current.connectionId
  const replacementConnectionId = replacement.connectionId
  if (
    !currentConnectionId
    || !replacementConnectionId
    || currentConnectionId === replacementConnectionId
    || current.keychainRefreshToken
    || Boolean(current.encryptedRefreshToken)
  ) return false
  return current.profileId === replacement.profileId
    && current.serverUrl === replacement.serverUrl
    && current.serverIdentity === replacement.serverIdentity
    && current.hubIdentity === replacement.hubIdentity
    && current.hostServerIdentity === replacement.hostServerIdentity
    && current.hubUrl === deriveSecurePeerTeamHubURL(
      current.serverUrl,
      `/api/team-hub-secure/${currentConnectionId}`,
      null
    )
    && replacement.hubUrl === deriveSecurePeerTeamHubURL(
      replacement.serverUrl,
      `/api/team-hub-secure/${replacementConnectionId}`,
      null
    )
}

function replaceBinding(settings: TeamHubStoredSettings, binding: TeamHubStoredBinding): TeamHubStoredSettings {
  return {
    ...settings,
    schemaVersion: 2,
    bindings: settings.bindings.map(candidate => candidate.profileId === binding.profileId ? binding : candidate)
  }
}

function boundedReconnectDisabledProfiles(existing: string[], profileId: string): string[] {
  return [...existing.filter(candidate => candidate !== profileId), profileId].slice(-MAX_BINDINGS)
}

function keychainAccount(profileId: string): string {
  return `${KEYCHAIN_ACCOUNT_PREFIX}${profileId}`
}

function cleanIdentifier(value: unknown, label: string, maxLength = 240): string {
  if (typeof value !== 'string') throw new Error(`${label} is missing.`)
  const clean = value.trim()
  if (!clean || clean.length > maxLength || /[\u0000-\u001f\u007f]/.test(clean)) throw new Error(`${label} is invalid.`)
  return clean
}

function cleanSecret(value: string): string {
  const clean = value.trim()
  if (!clean || clean.length > 16_384 || /[\u0000\r\n]/.test(clean)) throw new Error('The Team Hub credential is invalid.')
  return clean
}

const systemTeamHubKeychain: TeamHubKeychain = {
  read(account: string): string {
    if (isMacAppStoreBuild() || process.platform !== 'darwin') return ''
    try {
      return execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
        encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch { return '' }
  },
  write(account: string, value: string): boolean {
    if (isMacAppStoreBuild() || process.platform !== 'darwin') return false
    return writeMacOSKeychainPassword(KEYCHAIN_SERVICE, account, value)
  },
  delete(account: string): void {
    if (isMacAppStoreBuild() || process.platform !== 'darwin') return
    try {
      execFileSync('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], {
        encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'ignore', 'ignore']
      })
    } catch { /* an absent credential is already cleared */ }
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, 'r')
    fsyncSync(descriptor)
  } catch { /* the atomic rename remains useful where directory fsync is unsupported */ }
  finally { if (descriptor !== null) closeSync(descriptor) }
}

function isMacAppStoreBuild(): boolean {
  return Boolean((process as NodeJS.Process & { mas?: boolean }).mas)
}
