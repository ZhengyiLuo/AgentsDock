import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  TeamHubSettingsStore,
  type TeamHubKeychain,
  type TeamHubSafeStorage,
  type TeamHubVerifiedBinding
} from './team-hub-settings'

const directories: string[] = []

class MemoryKeychain implements TeamHubKeychain {
  readonly values = new Map<string, string>()
  readonly deleted: string[] = []
  writeEnabled = true
  read(account: string) { return this.values.get(account) ?? '' }
  write(account: string, value: string) {
    if (!this.writeEnabled) return false
    this.values.set(account, value)
    return true
  }
  delete(account: string) { this.deleted.push(account); this.values.delete(account) }
}

const secureStorage: TeamHubSafeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: value => Buffer.from(`encrypted:${value}`),
  decryptString: value => value.toString().replace(/^encrypted:/, '')
}

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-team-hub-settings-'))
  directories.push(directory)
  return join(directory, 'settings.json')
}

function binding(overrides: Partial<TeamHubVerifiedBinding> = {}): TeamHubVerifiedBinding {
  return {
    profileId: 'server-profile-a',
    serverUrl: 'http://127.0.0.1:7850',
    serverIdentity: 'server-stable-a',
    hubUrl: 'http://127.0.0.1:7850/api/team-hub',
    hubIdentity: 'hub-stable-a',
    ...overrides
  }
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('TeamHubSettingsStore', () => {
  it('replaces device enrollment with an exact keychain-free server-managed binding', () => {
    const settingsPath = path()
    const keychain = new MemoryKeychain()
    const store = new TeamHubSettingsStore({ path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false })
    const deviceBinding = binding()
    store.activateVerifiedHub(deviceBinding)
    store.storeRefreshToken('device-refresh', deviceBinding)
    keychain.deleted.length = 0
    const managedBinding = {
      ...deviceBinding,
      hubUrl: 'http://127.0.0.1:7850/api/team-hub-server'
    }

    expect(store.activateServerVerifiedHub(managedBinding)).toEqual({
      ...managedBinding,
      hasRefreshCredential: false
    })
    expect(store.refreshToken(deviceBinding.profileId)).toBe('')
    expect(keychain.deleted).toEqual(['refresh-token:server-profile-a'])
    expect(new TeamHubSettingsStore({ path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false })
      .publicSettings(deviceBinding.profileId)).toEqual({ ...managedBinding, hasRefreshCredential: false })
  })

  it('removes a profile-scoped managed binding and reconnect preference together', () => {
    const settingsPath = path()
    const keychain = new MemoryKeychain()
    const store = new TeamHubSettingsStore({ path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false })
    const managedBinding = binding({ hubUrl: 'http://127.0.0.1:7850/api/team-hub-server' })
    store.activateServerVerifiedHub(managedBinding)
    store.setProfileBackgroundReconnectAllowed(managedBinding.profileId, false)

    expect(store.removeServerProfile(managedBinding.profileId).removed).toBe(true)
    expect(store.publicSettings(managedBinding.profileId)).toBeNull()
    expect(store.backgroundReconnectAllowed(managedBinding.profileId)).toBe(true)
  })

  it('binds a refresh credential to the exact AgentsServer profile tuple without writing the secret to disk', () => {
    const settingsPath = path()
    const keychain = new MemoryKeychain()
    const store = new TeamHubSettingsStore({ path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false })
    const verified = binding()

    store.activateVerifiedHub(verified)
    store.storeRefreshToken('refresh-super-secret', verified)

    expect(store.refreshToken(verified.profileId)).toBe('refresh-super-secret')
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('refresh-super-secret')
    expect(store.publicSettings(verified.profileId)).toEqual({ ...verified, hasRefreshCredential: true })
  })

  it('persists refresh use before dispatch and atomically replaces its marker, token, and cache epoch', () => {
    const settingsPath = path()
    const keychain = new MemoryKeychain()
    const verified = binding()
    const createStore = () => new TeamHubSettingsStore({
      path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false
    })
    const first = createStore()
    first.activateVerifiedHub(verified)
    first.storeRefreshToken('refresh-r0', verified, '11111111-1111-4111-8111-111111111111')
    first.markRefreshTokenUse(verified, 'a'.repeat(64))

    const afterDispatchFence = createStore()
    expect(afterDispatchFence.refreshToken(verified.profileId)).toBe('refresh-r0')
    expect(afterDispatchFence.rejectedRefreshTokenFingerprint(verified.profileId)).toBe('a'.repeat(64))
    expect(afterDispatchFence.authCacheEpoch(verified.profileId)).toBe('11111111-1111-4111-8111-111111111111')

    afterDispatchFence.storeRefreshToken(
      'refresh-r1', verified, '22222222-2222-4222-8222-222222222222'
    )
    const recovered = createStore()
    expect(recovered.refreshToken(verified.profileId)).toBe('refresh-r1')
    expect(recovered.rejectedRefreshTokenFingerprint(verified.profileId)).toBeNull()
    expect(recovered.authCacheEpoch(verified.profileId)).toBe('22222222-2222-4222-8222-222222222222')
  })

  it('refuses Electron basic-text refresh-token storage on Linux', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      const keychain = new MemoryKeychain()
      keychain.writeEnabled = false
      const store = new TeamHubSettingsStore({
        path: path(),
        keychain,
        secureStorage: { ...secureStorage, getSelectedStorageBackend: () => 'basic_text' },
        isMacAppStoreBuild: () => false
      })
      const verified = binding()
      store.activateVerifiedHub(verified)

      expect(() => store.storeRefreshToken('must-not-use-basic-text', verified)).toThrow('Secure credential storage is unavailable')
      expect(store.publicSettings(verified.profileId)?.hasRefreshCredential).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps legacy Linux basic-text refresh ciphertext dormant and recoverable', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      const settingsPath = path()
      const verified = binding()
      const ciphertext = secureStorage.encryptString('legacy-basic-text-refresh').toString('base64')
      writeFileSync(settingsPath, JSON.stringify({
        schemaVersion: 2,
        bindings: [{ ...verified, keychainRefreshToken: false, encryptedRefreshToken: ciphertext }]
      }), 'utf8')
      const decryptString = vi.fn(secureStorage.decryptString)
      const store = new TeamHubSettingsStore({
        path: settingsPath,
        keychain: new MemoryKeychain(),
        secureStorage: { ...secureStorage, decryptString, getSelectedStorageBackend: () => 'basic_text' },
        isMacAppStoreBuild: () => false
      })

      expect(store.refreshToken(verified.profileId)).toBe('')
      expect(decryptString).not.toHaveBeenCalled()
      expect(JSON.parse(readFileSync(settingsPath, 'utf8')).bindings[0].encryptedRefreshToken).toBe(ciphertext)
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('persists an explicit background reconnect opt-out until the same binding is rearmed', () => {
    const settingsPath = path()
    const verified = binding()
    const createStore = () => new TeamHubSettingsStore({
      path: settingsPath,
      keychain: new MemoryKeychain(),
      secureStorage,
      isMacAppStoreBuild: () => false
    })
    const first = createStore()
    first.activateVerifiedHub(verified)
    expect(first.backgroundReconnectAllowed(verified.profileId)).toBe(true)

    first.setBackgroundReconnectAllowed(verified, false)
    const reloaded = createStore()
    expect(reloaded.backgroundReconnectAllowed(verified.profileId)).toBe(false)
    expect(reloaded.publicSettings(verified.profileId)).toEqual({ ...verified, hasRefreshCredential: false })

    reloaded.setBackgroundReconnectAllowed(verified, true)
    expect(createStore().backgroundReconnectAllowed(verified.profileId)).toBe(true)
  })

  it('does not let a stale binding change the persisted reconnect preference', () => {
    const store = new TeamHubSettingsStore({
      path: path(), keychain: new MemoryKeychain(), secureStorage, isMacAppStoreBuild: () => false
    })
    const verified = binding()
    store.activateVerifiedHub(verified)

    expect(() => store.setBackgroundReconnectAllowed({ ...verified, hubIdentity: 'stale-hub' }, false))
      .toThrow('connection changed')
    expect(store.backgroundReconnectAllowed(verified.profileId)).toBe(true)
  })

  it('preserves an independent credential for each immutable desktop server profile', () => {
    const store = new TeamHubSettingsStore({ path: path(), keychain: new MemoryKeychain(), secureStorage, isMacAppStoreBuild: () => false })
    const first = binding()
    const second = binding({
      profileId: 'server-profile-b', serverUrl: 'http://127.0.0.1:7852', serverIdentity: 'server-stable-b',
      hubUrl: 'http://127.0.0.1:7852/api/team-hub', hubIdentity: 'hub-stable-b'
    })
    store.activateVerifiedHub(first)
    store.storeRefreshToken('refresh-a', first)
    store.activateVerifiedHub(second)
    store.storeRefreshToken('refresh-b', second)

    expect(store.refreshToken(first.profileId)).toBe('refresh-a')
    expect(store.refreshToken(second.profileId)).toBe('refresh-b')
  })

  it.each([
    ['Hub identity', { hubIdentity: 'hub-stable-b' }],
    ['server identity', { serverIdentity: 'server-stable-b' }],
    ['server origin', {
      serverUrl: 'http://127.0.0.1:7859',
      hubUrl: 'http://127.0.0.1:7859/api/team-hub'
    }]
  ])('fails closed on same-profile %s replacement without deleting its credential', (_label, replacement) => {
    const keychain = new MemoryKeychain()
    const store = new TeamHubSettingsStore({ path: path(), keychain, secureStorage, isMacAppStoreBuild: () => false })
    const first = binding()
    store.activateVerifiedHub(first)
    store.storeRefreshToken('refresh-a', first)
    keychain.deleted.length = 0

    expect(() => store.activateVerifiedHub(binding(replacement))).toThrow('different Team Hub identity')
    expect(store.publicSettings(first.profileId)).toEqual({ ...first, hasRefreshCredential: true })
    expect(store.refreshToken(first.profileId)).toBe('refresh-a')
    expect(keychain.deleted).toEqual([])
  })

  it('refuses to create a legacy Direct binding without deleting the safe route credential', () => {
    const keychain = new MemoryKeychain()
    const store = new TeamHubSettingsStore({ path: path(), keychain, secureStorage, isMacAppStoreBuild: () => false })
    const serve = binding({
      serverUrl: 'http://100.64.0.1:7850',
      hubUrl: 'https://atlas.example.ts.net:8444/api/team-hub'
    })
    const direct = { ...serve, hubUrl: 'http://100.64.0.1:7850/api/team-hub' }
    store.activateVerifiedHub(serve)
    store.storeRefreshToken('refresh-a', serve)
    keychain.deleted.length = 0

    expect(() => store.activateVerifiedHub(direct)).toThrow(/Direct IP.*no longer supported/i)
    expect(store.refreshToken(serve.profileId)).toBe('refresh-a')
    expect(keychain.deleted).toEqual([])
  })

  it.each([
    ['without a prefix', 'http://100.64.0.3:7850', 'http://100.64.0.3:7850'],
    ['beneath the exact AgentsServer prefix', 'https://dock.example.test/prefix', 'https://dock.example.test/prefix']
  ])('persists and reloads a remote secure-peer proxy %s', (_label, serverUrl, hubOrigin) => {
    const settingsPath = path()
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const verified = binding({
      serverUrl,
      hubUrl: `${hubOrigin}/api/team-hub-secure/${connectionId}`,
      hubIdentity: 'hub-remote',
      connectionId,
      hostServerIdentity: 'server-host'
    })

    const first = new TeamHubSettingsStore({
      path: settingsPath, keychain: new MemoryKeychain(), secureStorage, isMacAppStoreBuild: () => false
    })
    expect(first.activateVerifiedHub(verified)).toEqual({ ...verified, hasRefreshCredential: false })

    const reloaded = new TeamHubSettingsStore({
      path: settingsPath, keychain: new MemoryKeychain(), secureStorage, isMacAppStoreBuild: () => false
    })
    expect(reloaded.publicSettings(verified.profileId)).toEqual({ ...verified, hasRefreshCredential: false })
    expect(reloaded.activateVerifiedHub(verified)).toEqual({ ...verified, hasRefreshCredential: false })
  })

  it('advances only the connection-bound lane of a keychain-free secure binding', () => {
    const settingsPath = path()
    const keychain = new MemoryKeychain()
    const firstConnectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const nextConnectionId = '19d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const first = binding({
      serverUrl: 'https://dock.example.test/prefix',
      hubUrl: `https://dock.example.test/prefix/api/team-hub-secure/${firstConnectionId}`,
      hubIdentity: 'hub-remote',
      connectionId: firstConnectionId,
      hostServerIdentity: 'server-host'
    })
    const replacement = {
      ...first,
      hubUrl: `https://dock.example.test/prefix/api/team-hub-secure/${nextConnectionId}`,
      connectionId: nextConnectionId
    }
    const store = new TeamHubSettingsStore({
      path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false
    })
    store.activateVerifiedHub(first)
    store.setBackgroundReconnectAllowed(first, false)
    keychain.values.set('refresh-token:server-profile-a', 'orphaned-refresh')

    expect(store.activateVerifiedHub(replacement)).toEqual({
      ...replacement,
      hasRefreshCredential: false
    })
    expect(keychain.deleted).toEqual(['refresh-token:server-profile-a'])
    expect(keychain.values.has('refresh-token:server-profile-a')).toBe(false)
    const reloaded = new TeamHubSettingsStore({
      path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false
    })
    expect(reloaded.publicSettings(first.profileId)).toEqual({ ...replacement, hasRefreshCredential: false })
    expect(reloaded.backgroundReconnectAllowed(first.profileId)).toBe(false)
  })

  it.each([
    ['server origin', { serverUrl: 'https://other.example.test/prefix' }],
    ['server identity', { serverIdentity: 'server-replacement' }],
    ['Hub identity', { hubIdentity: 'hub-replacement' }],
    ['host server identity', { hostServerIdentity: 'server-host-replacement' }]
  ])('refuses a secure binding lineage move with a changed %s', (_label, overrides) => {
    const keychain = new MemoryKeychain()
    const firstConnectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const nextConnectionId = '19d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const first = binding({
      serverUrl: 'https://dock.example.test/prefix',
      hubUrl: `https://dock.example.test/prefix/api/team-hub-secure/${firstConnectionId}`,
      hubIdentity: 'hub-remote',
      connectionId: firstConnectionId,
      hostServerIdentity: 'server-host'
    })
    const replacementServerUrl = 'serverUrl' in overrides ? overrides.serverUrl : first.serverUrl
    const replacement = {
      ...first,
      ...overrides,
      serverUrl: replacementServerUrl,
      hubUrl: `${replacementServerUrl}/api/team-hub-secure/${nextConnectionId}`,
      connectionId: nextConnectionId
    }
    const store = new TeamHubSettingsStore({
      path: path(), keychain, secureStorage, isMacAppStoreBuild: () => false
    })
    store.activateVerifiedHub(first)

    expect(() => store.activateVerifiedHub(replacement)).toThrow('different Team Hub identity')
    expect(store.publicSettings(first.profileId)).toEqual({ ...first, hasRefreshCredential: false })
    expect(keychain.deleted).toEqual([])
  })

  it.each([
    ['Keychain', true],
    ['safeStorage', false]
  ])('refuses to move a secure binding that carries %s refresh material', (_storage, keychainEnabled) => {
    const keychain = new MemoryKeychain()
    keychain.writeEnabled = keychainEnabled
    const firstConnectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const nextConnectionId = '19d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const first = binding({
      serverUrl: 'https://dock.example.test/prefix',
      hubUrl: `https://dock.example.test/prefix/api/team-hub-secure/${firstConnectionId}`,
      hubIdentity: 'hub-remote',
      connectionId: firstConnectionId,
      hostServerIdentity: 'server-host'
    })
    const replacement = {
      ...first,
      hubUrl: `https://dock.example.test/prefix/api/team-hub-secure/${nextConnectionId}`,
      connectionId: nextConnectionId
    }
    const store = new TeamHubSettingsStore({
      path: path(), keychain, secureStorage, isMacAppStoreBuild: () => false
    })
    store.activateVerifiedHub(first)
    store.storeRefreshToken('local-refresh', first)
    keychain.deleted.length = 0

    expect(() => store.activateVerifiedHub(replacement)).toThrow('different Team Hub identity')
    expect(store.publicSettings(first.profileId)).toEqual({ ...first, hasRefreshCredential: true })
    expect(store.refreshToken(first.profileId)).toBe('local-refresh')
    expect(keychain.deleted).toEqual([])
  })

  it('does not delete a stale secure-binding keychain item until lineage persistence succeeds', () => {
    const keychain = new MemoryKeychain()
    const firstConnectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const nextConnectionId = '19d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    const first = binding({
      serverUrl: 'https://dock.example.test/prefix',
      hubUrl: `https://dock.example.test/prefix/api/team-hub-secure/${firstConnectionId}`,
      hubIdentity: 'hub-remote',
      connectionId: firstConnectionId,
      hostServerIdentity: 'server-host'
    })
    const replacement = {
      ...first,
      hubUrl: `https://dock.example.test/prefix/api/team-hub-secure/${nextConnectionId}`,
      connectionId: nextConnectionId
    }
    const store = new TeamHubSettingsStore({
      path: path(), keychain, secureStorage, isMacAppStoreBuild: () => false
    })
    store.activateVerifiedHub(first)
    keychain.values.set('refresh-token:server-profile-a', 'orphaned-refresh')
    vi.spyOn(store as unknown as { persist(value: unknown): void }, 'persist').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(() => store.activateVerifiedHub(replacement)).toThrow('disk full')
    expect(store.publicSettings(first.profileId)).toEqual({ ...first, hasRefreshCredential: false })
    expect(keychain.values.get('refresh-token:server-profile-a')).toBe('orphaned-refresh')
    expect(keychain.deleted).toEqual([])
  })

  it('rejects a secure-peer binding that is not on the exact AgentsServer origin and prefix', () => {
    const store = new TeamHubSettingsStore({
      path: path(), keychain: new MemoryKeychain(), secureStorage, isMacAppStoreBuild: () => false
    })
    const connectionId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
    expect(() => store.activateVerifiedHub(binding({
      serverUrl: 'https://dock.example.test/prefix',
      hubUrl: `https://dock.example.test/api/team-hub-secure/${connectionId}`,
      connectionId,
      hostServerIdentity: 'server-host'
    }))).toThrow('Secure Team Hub binding is invalid')
  })

  it('keeps a stored legacy Direct credential dormant until the same Hub is verified on Serve', () => {
    const settingsPath = path()
    const keychain = new MemoryKeychain()
    keychain.values.set('refresh-token:server-profile-a', 'legacy-refresh')
    const direct = binding({
      serverUrl: 'http://100.64.0.1:7850',
      hubUrl: 'http://100.64.0.1:7850/api/team-hub'
    })
    writeFileSync(settingsPath, JSON.stringify({
      schemaVersion: 2,
      bindings: [{ ...direct, keychainRefreshToken: true }]
    }), 'utf8')
    const store = new TeamHubSettingsStore({ path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false })

    expect(store.publicSettings(direct.profileId)).toEqual({ ...direct, hasRefreshCredential: true })
    expect(store.refreshToken(direct.profileId)).toBe('')

    const serve = { ...direct, hubUrl: 'https://atlas.example.ts.net:8444/api/team-hub' }
    expect(store.activateVerifiedHub(serve)).toEqual({ ...serve, hasRefreshCredential: true })
    expect(store.refreshToken(serve.profileId)).toBe('legacy-refresh')
    expect(keychain.deleted).toEqual([])
  })

  it('forgets only the explicitly selected server binding', () => {
    const keychain = new MemoryKeychain()
    const store = new TeamHubSettingsStore({ path: path(), keychain, secureStorage, isMacAppStoreBuild: () => false })
    const first = binding()
    const second = binding({
      profileId: 'server-profile-b', serverUrl: 'http://127.0.0.1:7852', serverIdentity: 'server-stable-b',
      hubUrl: 'http://127.0.0.1:7852/api/team-hub', hubIdentity: 'hub-stable-b'
    })
    store.activateVerifiedHub(first); store.storeRefreshToken('refresh-a', first)
    store.activateVerifiedHub(second); store.storeRefreshToken('refresh-b', second)

    expect(store.forgetBinding(first.profileId)).toBe(true)
    expect(store.publicSettings(first.profileId)).toBeNull()
    expect(store.refreshToken(second.profileId)).toBe('refresh-b')
    expect(keychain.deleted).toContain('refresh-token:server-profile-a')
    expect(keychain.deleted).not.toContain('refresh-token:server-profile-b')
  })

  it('never lets a stale tuple clear the current credential', () => {
    const store = new TeamHubSettingsStore({ path: path(), keychain: new MemoryKeychain(), secureStorage, isMacAppStoreBuild: () => false })
    const verified = binding()
    store.activateVerifiedHub(verified)
    store.storeRefreshToken('refresh-a', verified)

    expect(() => store.clearRefreshToken({ ...verified, hubIdentity: 'stale-hub' })).toThrow('connection changed')
    expect(store.refreshToken(verified.profileId)).toBe('refresh-a')
  })

  it('does not create an orphan keychain copy when fallback-to-keychain rotation persistence fails', () => {
    const keychain = new MemoryKeychain()
    keychain.writeEnabled = false
    const store = new TeamHubSettingsStore({ path: path(), keychain, secureStorage, isMacAppStoreBuild: () => false })
    const verified = binding()
    store.activateVerifiedHub(verified)
    store.storeRefreshToken('fallback-refresh', verified)
    keychain.writeEnabled = true
    vi.spyOn(store as unknown as { persist(value: unknown): void }, 'persist').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(() => store.storeRefreshToken('replacement-refresh', verified)).toThrow('disk full')
    expect(store.refreshToken(verified.profileId)).toBe('fallback-refresh')
    expect(keychain.values.has('refresh-token:server-profile-a')).toBe(false)
  })

  it('rejects oversized identity fields before changing settings', () => {
    const store = new TeamHubSettingsStore({ path: path(), keychain: new MemoryKeychain(), secureStorage, isMacAppStoreBuild: () => false })
    expect(() => store.activateVerifiedHub(binding({ hubIdentity: 'h'.repeat(241) }))).toThrow('identity is invalid')
    expect(store.publicSettings('server-profile-a')).toBeNull()
  })

  it('migrates the old unbound URL credential by discarding it rather than attaching it to an AgentsServer', () => {
    const settingsPath = path()
    const keychain = new MemoryKeychain()
    keychain.values.set('refresh-token:legacy-hub-profile', 'legacy-refresh')
    writeFileSync(settingsPath, JSON.stringify({
      schemaVersion: 1,
      profileId: 'legacy-hub-profile',
      hubUrl: 'http://127.0.0.1:7851',
      hubIdentity: 'legacy-hub',
      keychainRefreshToken: true
    }), 'utf8')

    const store = new TeamHubSettingsStore({ path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false })
    expect(store.publicSettings('server-profile-a')).toBeNull()
    expect(keychain.deleted).toContain('refresh-token:legacy-hub-profile')
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('legacy-hub')
  })

  it('fails closed without quarantining a syntactically valid future schema', () => {
    const settingsPath = path()
    const raw = '{"schemaVersion":3,"bindings":[],"future":"keep-me"}\n'
    writeFileSync(settingsPath, raw, 'utf8')

    expect(() => new TeamHubSettingsStore({
      path: settingsPath,
      keychain: new MemoryKeychain(),
      secureStorage,
      isMacAppStoreBuild: () => false
    })).toThrow('Unsupported Team Hub settings schema')
    expect(readFileSync(settingsPath, 'utf8')).toBe(raw)
    expect(readdirSync(dirname(settingsPath))
      .some(name => name.startsWith('settings.json.corrupt-'))).toBe(false)
  })

  it('ignores a stale credential-bearing backup after a cleared primary is corrupted', () => {
    const settingsPath = path()
    const keychain = new MemoryKeychain()
    keychain.writeEnabled = false
    const verified = binding()
    const store = new TeamHubSettingsStore({ path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false })
    store.activateVerifiedHub(verified)
    store.storeRefreshToken('refresh-to-clear', verified)
    const staleCredentialSnapshot = readFileSync(settingsPath, 'utf8')

    store.clearRefreshToken(verified)
    writeFileSync(`${settingsPath}.bak`, staleCredentialSnapshot, 'utf8')
    writeFileSync(settingsPath, '{corrupt settings bytes', 'utf8')

    const recovered = new TeamHubSettingsStore({ path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false })
    expect(recovered.refreshToken(verified.profileId)).toBe('')
    expect(recovered.publicSettings(verified.profileId)).toBeNull()
  })

  it('ignores a stale credential-bearing backup after a forgotten primary is corrupted', () => {
    const settingsPath = path()
    const keychain = new MemoryKeychain()
    keychain.writeEnabled = false
    const verified = binding()
    const store = new TeamHubSettingsStore({ path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false })
    store.activateVerifiedHub(verified)
    store.storeRefreshToken('refresh-to-forget', verified)
    const staleCredentialSnapshot = readFileSync(settingsPath, 'utf8')

    expect(store.forgetBinding(verified.profileId)).toBe(true)
    writeFileSync(`${settingsPath}.bak`, staleCredentialSnapshot, 'utf8')
    writeFileSync(settingsPath, '{corrupt settings bytes', 'utf8')

    const recovered = new TeamHubSettingsStore({ path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false })
    expect(recovered.publicSettings(verified.profileId)).toBeNull()
    expect(recovered.refreshToken(verified.profileId)).toBe('')
  })

  it('uses one atomic primary commit point when persistence is interrupted', () => {
    const settingsPath = path()
    const keychain = new MemoryKeychain()
    keychain.writeEnabled = false
    const verified = binding()
    const store = new TeamHubSettingsStore({ path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false })
    store.activateVerifiedHub(verified)
    store.storeRefreshToken('still-committed', verified)
    const committed = readFileSync(settingsPath, 'utf8')
    const writeAtomic = vi.spyOn(
      store as unknown as { writeAtomic(target: string, contents: string): void },
      'writeAtomic'
    ).mockImplementationOnce(() => { throw new Error('simulated interruption before atomic rename') })

    expect(() => store.forgetBinding(verified.profileId)).toThrow('simulated interruption')
    expect(writeAtomic).toHaveBeenCalledOnce()
    expect(writeAtomic.mock.calls[0][0]).toBe(settingsPath)
    expect(readFileSync(settingsPath, 'utf8')).toBe(committed)

    const reopened = new TeamHubSettingsStore({ path: settingsPath, keychain, secureStorage, isMacAppStoreBuild: () => false })
    expect(reopened.refreshToken(verified.profileId)).toBe('still-committed')
  })

  it('quarantines an unrecoverable settings file and starts with an empty binding store', () => {
    const settingsPath = path()
    writeFileSync(settingsPath, '{corrupt settings bytes', 'utf8')

    const store = new TeamHubSettingsStore({
      path: settingsPath,
      keychain: new MemoryKeychain(),
      secureStorage,
      isMacAppStoreBuild: () => false
    })
    expect(store.publicSettings('server-profile-a')).toBeNull()
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ schemaVersion: 2, bindings: [] })
    expect(readdirSync(dirname(settingsPath)).some(name => name.startsWith('settings.json.corrupt-'))).toBe(true)
  })

  it('starts credential-free instead of restoring secondary authority when the primary is corrupt', () => {
    const settingsPath = path()
    const first = new TeamHubSettingsStore({ path: settingsPath, keychain: new MemoryKeychain(), secureStorage, isMacAppStoreBuild: () => false })
    const verified = binding()
    first.activateVerifiedHub(verified)
    first.setProfileBackgroundReconnectAllowed(verified.profileId, false)
    writeFileSync(`${settingsPath}.bak`, readFileSync(settingsPath, 'utf8'), 'utf8')
    writeFileSync(settingsPath, '{corrupt settings bytes', 'utf8')

    const recovered = new TeamHubSettingsStore({ path: settingsPath, keychain: new MemoryKeychain(), secureStorage, isMacAppStoreBuild: () => false })
    expect(recovered.publicSettings(verified.profileId)).toBeNull()
    expect(() => JSON.parse(readFileSync(settingsPath, 'utf8'))).not.toThrow()
  })
})
