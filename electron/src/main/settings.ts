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
import { dirname, join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeMacOSKeychainPassword } from './macos-keychain'
import type {
  AddServerProfileInput as SharedAddServerProfileInput,
  PublicServerProfile,
  PublicServerSettings,
  ServerConnectionState,
  ServerSettings,
  UpdateServerProfilePatch
} from '../shared/types'
import { DEFAULT_SERVER_URL, normalizeServerURL } from '../shared/server-url'

interface StoredSettingsV1 {
  serverUrl?: string
  encryptedAccessToken?: string
  keychainAccessToken?: boolean
  serverIdentity?: string | null
  serverSetupComplete?: boolean
}

export interface StoredSettingsV2 {
  schemaVersion: 2
  activeProfileId: string
  profiles: StoredServerProfile[]
}

export interface StoredServerProfile {
  id: string
  name: string
  serverUrl: string
  serverIdentity?: string | null
  encryptedAccessToken?: string
  keychainAccessToken?: boolean
  serverSetupComplete: boolean
  createdAt: string
  updatedAt: string
  /** Durable cleanup work left after an explicit server-authority reset. */
  retiredServerNamespaces?: string[]
}

export interface ServerProfileRuntimeState {
  connectionState?: ServerConnectionState
  cachedUnreadCount?: number
  lastConnectionError?: string | null
  serverVersion?: string | null
  lastConnectionCheckedAt?: number | null
}

export interface AddServerProfileInput extends SharedAddServerProfileInput {
  serverIdentity?: string | null
  setActive?: boolean
}

export interface UpdateServerProfileInput extends UpdateServerProfilePatch {
  serverIdentity?: string | null
  retiredServerNamespaces?: string[]
}

export interface SettingsKeychain {
  read(account: string): string
  readAsync?(account: string): Promise<string>
  write(account: string, token: string): boolean
  delete(account: string): void
}

export interface SettingsSafeStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown'
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface SettingsStoreOptions {
  path?: string
  keychain?: SettingsKeychain
  safeStorage?: SettingsSafeStorage
  createProfileId?: () => string
  now?: () => string
  isMacAppStoreBuild?: () => boolean
}

const KEYCHAIN_SERVICE = 'com.zhengyiluo.AgentsDock'
const LEGACY_KEYCHAIN_ACCOUNT = 'agent-access-token'
const PROFILE_KEYCHAIN_PREFIX = 'agent-access-token:'
const UNREADABLE_ACCESS_TOKEN_ERROR = 'The saved access token could not be read. Re-enter it to reconnect securely.'
let atomicWriteCounter = 0

export { normalizeServerURL } from '../shared/server-url'

export class SettingsStore {
  private readonly path: string
  private readonly backupPath: string
  private readonly keychain: SettingsKeychain
  private readonly secureStorage: SettingsSafeStorage
  private readonly createProfileId: () => string
  private readonly now: () => string
  private readonly useKeychain: boolean
  private value!: StoredSettingsV2
  private legacyKeychainCleanupPending = false
  private readonly connectionRevisions = new Map<string, number>()
  private readonly credentialReads = new Map<string, { revision: number; promise: Promise<string> }>()

  constructor(options: SettingsStoreOptions = {}) {
    this.path = options.path ?? join(app.getPath('userData'), 'settings.json')
    this.backupPath = `${this.path}.bak`
    this.keychain = options.keychain ?? systemKeychain
    this.secureStorage = options.safeStorage ?? safeStorage
    this.createProfileId = options.createProfileId ?? randomUUID
    this.now = options.now ?? (() => new Date().toISOString())
    this.useKeychain = !(options.isMacAppStoreBuild ?? isMacAppStoreBuild)()
    this.value = this.read()
    if (process.env.AGENTSDOCK_MIGRATE_SAFE_STORAGE === '1') this.migrateLegacySafeStorageToken()
  }

  publicSettings(): PublicServerSettings {
    const profile = this.activeStoredProfile()
    return {
      serverUrl: profile.serverUrl,
      // Presence is display metadata, never proof that authentication can read it.
      hasAccessToken: hasStoredAccessToken(profile),
      serverIdentity: profile.serverIdentity ?? null,
      serverSetupComplete: profile.serverSetupComplete
    }
  }

  listProfiles(runtime: Readonly<Record<string, ServerProfileRuntimeState>> | ((profile: PublicServerProfile) => ServerProfileRuntimeState) = {}): PublicServerProfile[] {
    return this.value.profiles.map(profile => {
      const metadata = this.publicProfile(profile)
      return typeof runtime === 'function'
        ? publicProfile(profile, metadata.hasAccessToken, runtime(metadata))
        : publicProfile(profile, metadata.hasAccessToken, runtime[profile.id])
    })
  }

  getActiveProfile(runtime?: ServerProfileRuntimeState): PublicServerProfile {
    return this.publicProfile(this.activeStoredProfile(), runtime)
  }

  getProfile(profileId: string, runtime?: ServerProfileRuntimeState): PublicServerProfile | null {
    const profile = this.value.profiles.find(candidate => candidate.id === profileId)
    return profile ? this.publicProfile(profile, runtime) : null
  }

  /** Scope fencing needs configured metadata, not a secure-storage token read. */
  getProfileMetadata(profileId: string): Pick<PublicServerProfile, 'id' | 'name' | 'serverUrl' | 'serverIdentity'> | null {
    const profile = this.value.profiles.find(candidate => candidate.id === profileId)
    return profile ? {
      id: profile.id,
      name: profile.name,
      serverUrl: normalizeServerURL(profile.serverUrl),
      serverIdentity: cleanIdentity(profile.serverIdentity)
    } : null
  }

  getActiveProfileId(): string { return this.value.activeProfileId }

  serverUrl(profileId = this.value.activeProfileId): string {
    return normalizeServerURL(this.requireProfile(profileId).serverUrl)
  }

  serverIdentity(profileId = this.value.activeProfileId): string | null {
    return cleanIdentity(this.requireProfile(profileId).serverIdentity)
  }

  retiredServerNamespaces(profileId: string): string[] {
    return [...(this.requireProfile(profileId).retiredServerNamespaces ?? [])]
  }

  setRetiredServerNamespaces(profileId: string, namespaces: readonly string[]): void {
    this.updateProfile(profileId, { retiredServerNamespaces: normalizeRetiredNamespaces(namespaces) })
  }

  accessToken(profileId = this.value.activeProfileId): string {
    return this.readProfileToken(this.requireProfile(profileId))
  }

  accessTokenForConnection(profileId = this.value.activeProfileId): string {
    const profile = this.requireProfile(profileId)
    const token = this.readProfileToken(profile)
    if (!token && hasStoredAccessToken(profile)) throw new Error(UNREADABLE_ACCESS_TOKEN_ERROR)
    return token
  }

  /** Coalesce only concurrent authentication reads, never retain a settled secret. */
  accessTokenForConnectionAsync(profileId = this.value.activeProfileId): Promise<string> {
    const profile = this.requireProfile(profileId)
    const revision = this.connectionRevision(profileId)
    const pending = this.credentialReads.get(profileId)
    if (pending?.revision === revision) return pending.promise
    const promise = this.readProfileTokenAsync(profile).then(token => {
      if (this.connectionRevision(profileId) !== revision) throw new Error('The server profile credentials changed. Try connecting again.')
      if (!token && hasStoredAccessToken(profile)) throw new Error(UNREADABLE_ACCESS_TOKEN_ERROR)
      return token
    }).finally(() => {
      if (this.credentialReads.get(profileId)?.promise === promise) this.credentialReads.delete(profileId)
    })
    this.credentialReads.set(profileId, { revision, promise })
    return promise
  }

  connectionRevision(profileId: string): number {
    this.requireProfile(profileId)
    return this.connectionRevisions.get(profileId) ?? 0
  }

  update(settings: ServerSettings): void {
    const active = this.activeStoredProfile()
    this.updateProfile(active.id, {
      serverUrl: settings.serverUrl,
      accessToken: settings.accessToken
    })
  }

  addProfile(input: AddServerProfileInput): PublicServerProfile {
    const serverUrl = normalizeServerURL(input.serverUrl)
    const serverIdentity = cleanIdentity(input.serverIdentity)
    const duplicateURL = this.value.profiles.find(profile => normalizeServerURL(profile.serverUrl) === serverUrl)
    if (duplicateURL) throw new Error(`A server profile already uses ${serverUrl}.`)
    const duplicateIdentity = serverIdentity && this.value.profiles.find(profile => profile.serverIdentity === serverIdentity)
    if (duplicateIdentity) throw new Error(`Server identity ${serverIdentity} already belongs to “${duplicateIdentity.name}”.`)

    const id = this.uniqueProfileId()
    const timestamp = this.now()
    let profile: StoredServerProfile = {
      id,
      name: cleanProfileName(input.name) || defaultProfileName(serverUrl, serverIdentity),
      serverUrl,
      serverIdentity,
      serverSetupComplete: input.serverSetupComplete ?? Boolean(serverIdentity),
      createdAt: timestamp,
      updatedAt: timestamp
    }
    const credential = input.accessToken !== undefined
      ? this.stageAccessToken(profile, input.accessToken ?? '')
      : unchangedCredential(profile)
    profile = credential.profile
    const next = cloneSettings(this.value)
    next.profiles.push(profile)
    if (input.setActive) next.activeProfileId = id
    try {
      this.persist(next)
      credential.commit()
    } catch (error) {
      credential.rollback()
      throw error
    }
    return this.publicProfile(profile)
  }

  updateProfile(profileId: string, patch: UpdateServerProfileInput): PublicServerProfile {
    const current = this.requireProfile(profileId)
    const keepsCredential = patch.accessToken === undefined || patch.accessToken === '__KEEP__'
    if (keepsCredential && (patch.accessToken === '__KEEP__' || patch.serverUrl !== undefined)
      && hasStoredAccessToken(current) && !this.readProfileToken(current)) {
      throw new Error(UNREADABLE_ACCESS_TOKEN_ERROR)
    }
    const updated: StoredServerProfile = {
      ...current,
      name: patch.name === undefined ? current.name : requireProfileName(patch.name),
      serverUrl: patch.serverUrl === undefined ? current.serverUrl : normalizeServerURL(patch.serverUrl),
      serverIdentity: patch.serverIdentity === undefined ? current.serverIdentity : cleanIdentity(patch.serverIdentity),
      serverSetupComplete: patch.serverSetupComplete ?? current.serverSetupComplete,
      retiredServerNamespaces: patch.retiredServerNamespaces === undefined
        ? current.retiredServerNamespaces
        : normalizeRetiredNamespaces(patch.retiredServerNamespaces),
      updatedAt: this.now()
    }
    const duplicateURL = this.value.profiles.find(profile => profile.id !== profileId && normalizeServerURL(profile.serverUrl) === updated.serverUrl)
    if (duplicateURL) throw new Error(`A server profile already uses ${updated.serverUrl}.`)
    const duplicateIdentity = updated.serverIdentity && this.value.profiles.find(profile => profile.id !== profileId && profile.serverIdentity === updated.serverIdentity)
    if (duplicateIdentity) throw new Error(`Server identity ${updated.serverIdentity} already belongs to “${duplicateIdentity.name}”.`)

    if (!keepsCredential || updated.serverUrl !== current.serverUrl || updated.serverIdentity !== current.serverIdentity) {
      this.invalidateCredentialRead(profileId)
    }

    const credential = keepsCredential
      ? unchangedCredential(updated)
      : this.stageAccessToken(updated, patch.accessToken ?? '')
    const next = cloneSettings(this.value)
    next.profiles = next.profiles.map(profile => profile.id === profileId ? credential.profile : profile)
    try {
      this.persist(next)
      credential.commit()
    } catch (error) {
      credential.rollback()
      throw error
    }
    return this.publicProfile(credential.profile)
  }

  setActiveProfile(profileId: string): PublicServerProfile {
    const profile = this.requireProfile(profileId)
    if (profileId !== this.value.activeProfileId) {
      const next = cloneSettings(this.value)
      next.activeProfileId = profileId
      this.persist(next)
    }
    return this.publicProfile(profile)
  }

  reorderProfiles(profileIds: string[]): PublicServerProfile[] {
    if (profileIds.length !== this.value.profiles.length || new Set(profileIds).size !== profileIds.length) {
      throw new Error('Server profile order must contain every profile exactly once.')
    }
    const byId = new Map(this.value.profiles.map(profile => [profile.id, profile]))
    if (profileIds.some(id => !byId.has(id))) throw new Error('Server profile order contains an unknown profile.')
    const next = cloneSettings(this.value)
    next.profiles = profileIds.map(id => byId.get(id)!)
    this.persist(next)
    return this.listProfiles()
  }

  removeProfile(profileId: string, replacementProfileId?: string): void {
    const profile = this.requireProfile(profileId)
    if (this.value.profiles.length === 1) throw new Error('AgentsDock must keep at least one server profile.')
    const next = cloneSettings(this.value)
    next.profiles = next.profiles.filter(candidate => candidate.id !== profileId)
    if (this.value.activeProfileId === profileId) {
      if (!replacementProfileId || replacementProfileId === profileId || !next.profiles.some(candidate => candidate.id === replacementProfileId)) {
        throw new Error('Select a replacement server profile before removing the active profile.')
      }
      next.activeProfileId = replacementProfileId
    }
    this.persist(next)
    this.invalidateCredentialRead(profileId)
    if (this.useKeychain) this.keychain.delete(profileKeychainAccount(profileId))
  }

  setServerIdentity(serverIdentity: string | null | undefined): void {
    this.setProfileServerIdentity(this.value.activeProfileId, serverIdentity)
  }

  setProfileServerIdentity(profileId: string, serverIdentity: string | null | undefined): void {
    const identity = cleanIdentity(serverIdentity)
    const profile = this.requireProfile(profileId)
    if ((profile.serverIdentity ?? null) === identity && (!identity || profile.serverSetupComplete)) return
    this.updateProfile(profileId, {
      serverIdentity: identity,
      serverSetupComplete: identity ? true : profile.serverSetupComplete
    })
  }

  markServerSetupComplete(serverIdentity?: string | null): void {
    this.markProfileServerSetupComplete(this.value.activeProfileId, serverIdentity)
  }

  markProfileServerSetupComplete(profileId: string, serverIdentity?: string | null): void {
    const profile = this.requireProfile(profileId)
    const identity = cleanIdentity(serverIdentity)
    if (profile.serverSetupComplete && (!identity || identity === profile.serverIdentity)) return
    this.updateProfile(profileId, {
      serverIdentity: identity || profile.serverIdentity,
      serverSetupComplete: true
    })
  }

  private read(): StoredSettingsV2 {
    if (!existsSync(this.path)) {
      const value = this.defaultSettings()
      this.writeAtomic(this.path, serializeSettings(value))
      return value
    }
    const raw = readFileSync(this.path, 'utf8')
    // Capture migration evidence before normalization can replace the v1 backup.
    if (this.useKeychain && existsSync(this.backupPath)) {
      try {
        const backup = parseStoredSettings(readFileSync(this.backupPath, 'utf8'), this.now)
        this.legacyKeychainCleanupPending = backup.kind === 'v1' && Boolean(backup.value.keychainAccessToken)
      } catch { /* an invalid backup is never authority or migration evidence */ }
    }
    try {
      return this.decode(raw)
    } catch (primaryError) {
      // Future/unsupported or structurally invalid schemas must remain intact
      // so an older app cannot silently replace settings it does not
      // understand. Only malformed JSON is treated as corruption.
      if (!(primaryError instanceof SyntaxError)) throw primaryError
      this.legacyKeychainCleanupPending = false
      // A rollback backup can predate an identity reset, profile removal, or
      // credential revocation. Automatically restoring it would resurrect
      // authority the user explicitly removed. Quarantine the corrupt primary
      // and start with a fresh, unbound profile; the backup remains available
      // for manual diagnostics only and is never treated as live authority.
      const deniedProfileIds = new Set<string>()
      if (existsSync(this.backupPath)) {
        try {
          const backup = parseStoredSettings(readFileSync(this.backupPath, 'utf8'), this.now)
          if (backup.kind === 'v2') {
            for (const profile of backup.value.profiles) deniedProfileIds.add(profile.id)
          }
        } catch { /* a corrupt backup grants no authority either */ }
      }
      const quarantine = `${this.path}.corrupt-${Date.now()}-${++atomicWriteCounter}`
      try { renameSync(this.path, quarantine) }
      catch {
        // If quarantine is unavailable, do not overwrite or recover the
        // suspect file. Surface the original failure rather than risk reuse.
        throw primaryError
      }
      const fresh = this.defaultSettings(deniedProfileIds)
      try {
        this.persistValue(fresh)
        return fresh
      } catch (error) {
        try { renameSync(quarantine, this.path) } catch { /* retain quarantine */ }
        throw error
      }
    }
  }

  private decode(raw: string): StoredSettingsV2 {
    const parsed = parseStoredSettings(raw, this.now)
    if (parsed.kind === 'v1') return this.migrateV1(parsed.value)
    const normalized = parsed.value
    if (serializeSettings(normalized) !== serializeUnknown(JSON.parse(raw))) this.persistInitialNormalization(normalized)
    return normalized
  }

  private migrateV1(legacy: StoredSettingsV1): StoredSettingsV2 {
    this.legacyKeychainCleanupPending = this.useKeychain && Boolean(legacy.keychainAccessToken)
    const timestamp = this.now()
    const id = this.uniqueProfileId([])
    const serverUrl = normalizeServerURL(legacy.serverUrl || DEFAULT_SERVER_URL)
    const serverIdentity = cleanIdentity(legacy.serverIdentity)
    const profile: StoredServerProfile = {
      id,
      name: defaultProfileName(serverUrl, serverIdentity),
      serverUrl,
      serverIdentity,
      encryptedAccessToken: cleanEncryptedToken(legacy.encryptedAccessToken),
      keychainAccessToken: Boolean(legacy.keychainAccessToken),
      serverSetupComplete: legacy.serverSetupComplete ?? Boolean(
        serverIdentity || legacy.encryptedAccessToken || legacy.keychainAccessToken || serverUrl !== DEFAULT_SERVER_URL
      ),
      createdAt: timestamp,
      updatedAt: timestamp
    }
    let wroteProfileKeychain = false
    if (profile.keychainAccessToken) {
      const legacyToken = this.useKeychain ? this.keychain.read(LEGACY_KEYCHAIN_ACCOUNT) : ''
      if (legacyToken && this.keychain.write(profileKeychainAccount(id), legacyToken)) {
        wroteProfileKeychain = true
      } else if (this.decryptStoredToken(profile.encryptedAccessToken)) {
        profile.keychainAccessToken = false
      } else {
        throw new Error('The saved access token could not be migrated without losing it. Reopen AgentsDock after Keychain is available.')
      }
    }
    const next: StoredSettingsV2 = { schemaVersion: 2, activeProfileId: id, profiles: [profile] }
    try {
      this.persistValue(next)
    } catch (error) {
      if (wroteProfileKeychain) this.keychain.delete(profileKeychainAccount(id))
      throw error
    }
    // Keep the fixed-account credential while the rollback backup still contains
    // schema v1. If the new settings file is corrupted before that backup is
    // replaced, recovery must be able to migrate the same credential again.
    return next
  }

  private defaultSettings(deniedProfileIds: ReadonlySet<string> = new Set()): StoredSettingsV2 {
    const timestamp = this.now()
    const id = this.uniqueProfileId([], deniedProfileIds)
    return {
      schemaVersion: 2,
      activeProfileId: id,
      profiles: [{
        id,
        name: defaultProfileName(DEFAULT_SERVER_URL, null),
        serverUrl: DEFAULT_SERVER_URL,
        serverIdentity: null,
        serverSetupComplete: false,
        createdAt: timestamp,
        updatedAt: timestamp
      }]
    }
  }

  private persistInitialNormalization(next: StoredSettingsV2): void {
    this.persistValue(next)
  }

  private persist(next: StoredSettingsV2): void {
    this.persistValue(next)
    this.value = next
  }

  private persistValue(next: StoredSettingsV2): void {
    validateSettings(next)
    const previous = existsSync(this.path) ? readFileSync(this.path, 'utf8') : null
    if (previous != null) this.writeAtomic(this.backupPath, previous)
    try {
      this.writeAtomic(this.path, serializeSettings(next))
      const verified = parseStoredSettings(readFileSync(this.path, 'utf8'), this.now)
      if (verified.kind !== 'v2') throw new Error('Settings validation did not produce schema v2.')
      this.cleanupLegacyKeychainCredential(next)
    } catch (error) {
      if (previous != null) this.writeAtomic(this.path, previous)
      throw error
    }
  }

  private cleanupLegacyKeychainCredential(next: StoredSettingsV2): void {
    if (!this.legacyKeychainCleanupPending || !this.useKeychain || !existsSync(this.backupPath)) return
    try {
      const backup = parseStoredSettings(readFileSync(this.backupPath, 'utf8'), this.now)
      if (backup.kind !== 'v2') return
      const missingProfileCredential = next.profiles.some(profile => profile.keychainAccessToken && !this.keychain.read(profileKeychainAccount(profile.id)))
      if (missingProfileCredential) return
      if (this.keychain.read(LEGACY_KEYCHAIN_ACCOUNT)) this.keychain.delete(LEGACY_KEYCHAIN_ACCOUNT)
      this.legacyKeychainCleanupPending = false
    } catch {
      // The rollback credential stays until both schema-v2 files and every
      // profile-specific Keychain entry can be verified safely.
    }
  }

  private writeAtomic(target: string, contents: string): void {
    mkdirSync(dirname(target), { recursive: true })
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${++atomicWriteCounter}`
    let descriptor: number | null = null
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, contents, { encoding: 'utf8' })
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = null
      renameSync(temporary, target)
      chmodSync(target, 0o600)
      syncDirectory(dirname(target))
    } catch (error) {
      if (descriptor != null) {
        try { closeSync(descriptor) } catch { /* preserve the original write error */ }
      }
      rmSync(temporary, { force: true })
      throw error
    }
  }

  private activeStoredProfile(): StoredServerProfile { return this.requireProfile(this.value.activeProfileId) }

  private publicProfile(profile: StoredServerProfile, runtime?: ServerProfileRuntimeState): PublicServerProfile {
    return publicProfile(profile, hasStoredAccessToken(profile), runtime)
  }

  private requireProfile(profileId: string): StoredServerProfile {
    const profile = this.value.profiles.find(candidate => candidate.id === profileId)
    if (!profile) throw new Error(`Unknown server profile: ${profileId}`)
    return profile
  }

  private uniqueProfileId(
    existing = this.value?.profiles ?? [],
    deniedProfileIds: ReadonlySet<string> = new Set()
  ): string {
    const ids = new Set([...existing.map(profile => profile.id), ...deniedProfileIds])
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = this.createProfileId().trim()
      if (id && !ids.has(id)) return id
    }
    throw new Error('Could not create a unique server profile ID.')
  }

  private readProfileToken(profile: StoredServerProfile): string {
    if (profile.keychainAccessToken && this.useKeychain) {
      const token = this.keychain.read(profileKeychainAccount(profile.id))
      if (token) return token
    }
    return this.decryptStoredToken(profile.encryptedAccessToken)
  }

  private async readProfileTokenAsync(profile: StoredServerProfile): Promise<string> {
    if (profile.keychainAccessToken && this.useKeychain) {
      const account = profileKeychainAccount(profile.id)
      const token = this.keychain.readAsync ? await this.keychain.readAsync(account) : this.keychain.read(account)
      if (token) return token
    }
    return this.decryptStoredToken(profile.encryptedAccessToken)
  }

  private invalidateCredentialRead(profileId: string): void {
    this.connectionRevisions.set(profileId, (this.connectionRevisions.get(profileId) ?? 0) + 1)
    this.credentialReads.delete(profileId)
  }

  private decryptStoredToken(value: string | undefined): string {
    // Electron's Linux `basic_text` backend is recoverable obfuscation, not
    // credential storage. Keep an existing ciphertext on disk so switching to
    // a real secret store cannot destroy recoverable user state, but never use
    // it to authenticate while the insecure backend is selected.
    if (!value || !secureCredentialStorageAvailable(this.secureStorage)) return ''
    try { return this.secureStorage.decryptString(Buffer.from(value, 'base64')) } catch { return '' }
  }

  private stageAccessToken(profile: StoredServerProfile, token: string): CredentialMutation {
    const next = { ...profile }
    const account = profileKeychainAccount(profile.id)
    const oldToken = this.readProfileToken(profile)
    if (!token) {
      next.keychainAccessToken = false
      delete next.encryptedAccessToken
      return {
        profile: next,
        rollback: () => undefined,
        commit: () => { if (this.useKeychain) this.keychain.delete(account) }
      }
    }

    let encryptedAccessToken: string | undefined
    if (secureCredentialStorageAvailable(this.secureStorage)) {
      encryptedAccessToken = this.secureStorage.encryptString(token).toString('base64')
    }
    const wroteKeychain = this.useKeychain && this.keychain.write(account, token)
    if (!wroteKeychain && !encryptedAccessToken) throw new Error('Secure token storage is unavailable on this device.')
    next.keychainAccessToken = wroteKeychain
    if (encryptedAccessToken) next.encryptedAccessToken = encryptedAccessToken
    else delete next.encryptedAccessToken
    return {
      profile: next,
      rollback: () => {
        if (!wroteKeychain) return
        if (oldToken) this.keychain.write(account, oldToken)
        else this.keychain.delete(account)
      },
      commit: () => {
        if (!wroteKeychain && profile.keychainAccessToken) this.keychain.delete(account)
      }
    }
  }

  private migrateLegacySafeStorageToken(): void {
    const profile = this.activeStoredProfile()
    if (!this.useKeychain || profile.keychainAccessToken || !profile.encryptedAccessToken || !this.secureStorage.isEncryptionAvailable()) return
    const token = this.decryptStoredToken(profile.encryptedAccessToken)
    if (!token || !this.keychain.write(profileKeychainAccount(profile.id), token)) return
    const next = cloneSettings(this.value)
    const updated = { ...profile, keychainAccessToken: true, updatedAt: this.now() }
    next.profiles = next.profiles.map(candidate => candidate.id === profile.id ? updated : candidate)
    try {
      this.persist(next)
    } catch {
      this.keychain.delete(profileKeychainAccount(profile.id))
    }
  }
}

function secureCredentialStorageAvailable(storage: SettingsSafeStorage): boolean {
  if (!storage.isEncryptionAvailable()) return false
  if (process.platform !== 'linux') return true
  const backend = storage.getSelectedStorageBackend?.()
  return backend === 'gnome_libsecret' || backend === 'kwallet' || backend === 'kwallet5' || backend === 'kwallet6'
}

interface CredentialMutation {
  profile: StoredServerProfile
  rollback(): void
  commit(): void
}

function unchangedCredential(profile: StoredServerProfile): CredentialMutation {
  return { profile, rollback: () => undefined, commit: () => undefined }
}

function profileKeychainAccount(profileId: string): string { return `${PROFILE_KEYCHAIN_PREFIX}${profileId}` }

function publicProfile(profile: StoredServerProfile, hasAccessToken: boolean, runtime?: ServerProfileRuntimeState): PublicServerProfile {
  return {
    id: profile.id,
    name: profile.name,
    serverUrl: profile.serverUrl,
    serverIdentity: profile.serverIdentity ?? null,
    hasAccessToken,
    serverSetupComplete: profile.serverSetupComplete,
    connectionState: runtime?.connectionState ?? 'cached',
    cachedUnreadCount: Math.max(0, Math.trunc(runtime?.cachedUnreadCount ?? 0)),
    lastConnectionError: runtime?.lastConnectionError ?? null,
    ...(runtime?.serverVersion ? { serverVersion: runtime.serverVersion } : {})
  }
}

function hasStoredAccessToken(profile: StoredServerProfile): boolean {
  return Boolean(profile.keychainAccessToken || profile.encryptedAccessToken)
}

function cleanIdentity(value: string | null | undefined): string | null {
  return value?.trim() || null
}

function normalizeRetiredNamespaces(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 16) throw new Error('Retired server cache cleanup state is invalid.')
  const namespaces = value.map(item => {
    if (
      typeof item !== 'string'
      || !item.trim()
      || item.trim() !== item
      || item.length > 512
      || /[\u0000-\u001f\u007f]/.test(item)
    ) throw new Error('Retired server cache cleanup state is invalid.')
    return item
  })
  if (new Set(namespaces).size !== namespaces.length) throw new Error('Retired server cache cleanup state is invalid.')
  return namespaces
}

function cleanEncryptedToken(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function cleanProfileName(value: string | undefined): string { return value?.trim() || '' }

function requireProfileName(value: string): string {
  const name = cleanProfileName(value)
  if (!name) throw new Error('Server profile name cannot be empty.')
  return name
}

function defaultProfileName(serverUrl: string, serverIdentity: string | null): string {
  if (serverIdentity) return serverIdentity
  try {
    const url = new URL(serverUrl)
    return url.hostname || url.host || 'AgentsServer'
  } catch {
    return 'AgentsServer'
  }
}

function cloneSettings(value: StoredSettingsV2): StoredSettingsV2 {
  return JSON.parse(JSON.stringify(value)) as StoredSettingsV2
}

function serializeSettings(value: StoredSettingsV2): string { return `${JSON.stringify(value, null, 2)}\n` }
function serializeUnknown(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }

function parseStoredSettings(raw: string, now: () => string): { kind: 'v1'; value: StoredSettingsV1 } | { kind: 'v2'; value: StoredSettingsV2 } {
  const value = JSON.parse(raw) as unknown
  if (!isRecord(value)) throw new Error('Settings must contain a JSON object.')
  if (value.schemaVersion === 2) return { kind: 'v2', value: normalizeSettingsV2(value, now) }
  if (value.schemaVersion !== undefined) throw new Error(`Unsupported settings schema version: ${String(value.schemaVersion)}`)
  return { kind: 'v1', value: value as StoredSettingsV1 }
}

function normalizeSettingsV2(value: Record<string, unknown>, now: () => string): StoredSettingsV2 {
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) throw new Error('Settings must contain at least one server profile.')
  const timestamp = now()
  const profiles = value.profiles.map((entry, index) => normalizeProfile(entry, timestamp, index))
  const ids = new Set(profiles.map(profile => profile.id))
  if (ids.size !== profiles.length) throw new Error('Server profile IDs must be unique.')
  const activeProfileId = typeof value.activeProfileId === 'string' && ids.has(value.activeProfileId)
    ? value.activeProfileId
    : profiles[0].id
  const normalized: StoredSettingsV2 = { schemaVersion: 2, activeProfileId, profiles }
  validateSettings(normalized)
  return normalized
}

function normalizeProfile(value: unknown, timestamp: string, index: number): StoredServerProfile {
  if (!isRecord(value)) throw new Error(`Server profile ${index + 1} is invalid.`)
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!id) throw new Error(`Server profile ${index + 1} has no ID.`)
  const serverUrl = normalizeServerURL(typeof value.serverUrl === 'string' ? value.serverUrl : DEFAULT_SERVER_URL)
  const serverIdentity = cleanIdentity(typeof value.serverIdentity === 'string' ? value.serverIdentity : null)
  const createdAt = typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : timestamp
  const updatedAt = typeof value.updatedAt === 'string' && value.updatedAt ? value.updatedAt : createdAt
  return {
    id,
    name: cleanProfileName(typeof value.name === 'string' ? value.name : undefined) || defaultProfileName(serverUrl, serverIdentity),
    serverUrl,
    serverIdentity,
    encryptedAccessToken: cleanEncryptedToken(value.encryptedAccessToken),
    keychainAccessToken: Boolean(value.keychainAccessToken),
    serverSetupComplete: Boolean(value.serverSetupComplete),
    retiredServerNamespaces: normalizeRetiredNamespaces(value.retiredServerNamespaces),
    createdAt,
    updatedAt
  }
}

function validateSettings(value: StoredSettingsV2): void {
  if (value.schemaVersion !== 2 || !value.profiles.length) throw new Error('Invalid schema v2 settings.')
  const ids = new Set<string>()
  for (const profile of value.profiles) {
    if (!profile.id || ids.has(profile.id)) throw new Error('Server profile IDs must be non-empty and unique.')
    ids.add(profile.id)
    if (!profile.name.trim()) throw new Error(`Server profile ${profile.id} has no name.`)
    if (!profile.serverUrl) throw new Error(`Server profile ${profile.id} has no URL.`)
  }
  if (!ids.has(value.activeProfileId)) throw new Error('The active server profile does not exist.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const systemKeychain: SettingsKeychain = {
  readAsync(account: string): Promise<string> {
    if (isMacAppStoreBuild()) return Promise.resolve('')
    return new Promise(resolve => {
      execFile('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
        encoding: 'utf8', timeout: 3000
      }, (error, stdout) => resolve(error ? '' : stdout.trim()))
    })
  },
  read(account: string): string {
    if (isMacAppStoreBuild()) return ''
    try {
      return execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
        encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch { return '' }
  },
  write(account: string, token: string): boolean {
    return writeMacOSKeychainPassword(KEYCHAIN_SERVICE, account, token)
  },
  delete(account: string): void {
    if (isMacAppStoreBuild()) return
    try {
      execFileSync('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], {
        encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'ignore', 'ignore']
      })
    } catch { /* deleting an absent token is already the desired state */ }
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, 'r')
    fsyncSync(descriptor)
  } catch { /* the file rename is still atomic when a platform cannot fsync directories */ }
  finally { if (descriptor != null) closeSync(descriptor) }
}

function isMacAppStoreBuild(): boolean {
  return Boolean((process as NodeJS.Process & { mas?: boolean }).mas)
}
