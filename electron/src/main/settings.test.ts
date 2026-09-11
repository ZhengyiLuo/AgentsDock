import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const credentialProcesses = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => { throw new Error('Tests must never invoke a real credential process') })
}))
vi.mock('node:child_process', () => ({ ...credentialProcesses, default: credentialProcesses }))

vi.mock('electron', () => ({
  app: { getPath: () => { throw new Error('Tests must inject a settings path') } },
  safeStorage: {
    isEncryptionAvailable: () => { throw new Error('Tests must inject safeStorage') },
    encryptString: () => { throw new Error('Tests must inject safeStorage') },
    decryptString: () => { throw new Error('Tests must inject safeStorage') }
  }
}))

import {
  SettingsStore,
  type SettingsKeychain,
  type SettingsSafeStorage,
  type StoredSettingsV2
} from './settings'

const temporaryDirectories: string[] = []

class MemoryKeychain implements SettingsKeychain {
  readonly values = new Map<string, string>()
  readonly reads: string[] = []
  readonly writes: string[] = []
  readonly deletes: string[] = []
  writeEnabled = true

  read(account: string): string {
    this.reads.push(account)
    return this.values.get(account) ?? ''
  }

  write(account: string, token: string): boolean {
    this.writes.push(account)
    if (!this.writeEnabled) return false
    this.values.set(account, token)
    return true
  }

  delete(account: string): void {
    this.deletes.push(account)
    this.values.delete(account)
  }
}

const memorySafeStorage: SettingsSafeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: value => {
    const decoded = value.toString('utf8')
    if (!decoded.startsWith('encrypted:')) throw new Error('Invalid test ciphertext')
    return decoded.slice('encrypted:'.length)
  }
}

function encrypted(value: string): string {
  return memorySafeStorage.encryptString(value).toString('base64')
}

function settingsPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-settings-'))
  temporaryDirectories.push(directory)
  return join(directory, 'settings.json')
}

function stored(path: string): StoredSettingsV2 {
  return JSON.parse(readFileSync(path, 'utf8')) as StoredSettingsV2
}

afterEach(() => {
  credentialProcesses.execFile.mockReset()
  credentialProcesses.execFileSync.mockClear()
  delete process.env.AGENTSDOCK_MIGRATE_SAFE_STORAGE
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
})

describe('SettingsStore schema v2 migration', () => {
  it('reads configured profile metadata without accessing Keychain or decrypting credentials', () => {
    const keychain = new MemoryKeychain()
    const decryptString = vi.fn(memorySafeStorage.decryptString)
    const store = new SettingsStore({ path: settingsPath(), keychain,
      safeStorage: { ...memorySafeStorage, decryptString },
      createProfileId: () => 'metadata-profile', isMacAppStoreBuild: () => false })
    store.updateProfile('metadata-profile', {
      name: 'Studio', serverUrl: 'https://dock.example.test/prefix', serverIdentity: 'server-studio', accessToken: 'test-token'
    })
    keychain.reads.length = 0
    decryptString.mockClear()
    expect(store.getProfileMetadata('metadata-profile')).toEqual({
      id: 'metadata-profile', name: 'Studio', serverUrl: 'https://dock.example.test/prefix', serverIdentity: 'server-studio'
    })
    expect(store.getProfileMetadata('missing')).toBeNull()
    expect(keychain.reads).toEqual([])
    expect(decryptString).not.toHaveBeenCalled()
    expect(store.accessTokenForConnection('metadata-profile')).toBe('test-token')
    expect(keychain.reads).toHaveLength(1)
  })

  it('migrates v1 settings and the fixed Keychain account exactly once', () => {
    const path = settingsPath()
    const legacy = {
      serverUrl: 'server.example:7850/api/health',
      serverIdentity: 'server-alpha',
      serverSetupComplete: true,
      keychainAccessToken: true,
      encryptedAccessToken: encrypted('safe-storage-backup')
    }
    const legacyRaw = `${JSON.stringify(legacy, null, 2)}\n`
    writeFileSync(path, legacyRaw)
    const keychain = new MemoryKeychain()
    keychain.values.set('agent-access-token', 'keychain-token')

    const store = new SettingsStore({
      path,
      keychain,
      safeStorage: memorySafeStorage,
      createProfileId: () => 'profile-alpha',
      now: () => '2026-07-17T12:00:00.000Z',
      isMacAppStoreBuild: () => false
    })

    expect(stored(path)).toEqual({
      schemaVersion: 2,
      activeProfileId: 'profile-alpha',
      profiles: [{
        id: 'profile-alpha',
        name: 'server-alpha',
        serverUrl: 'http://server.example:7850',
        serverIdentity: 'server-alpha',
        encryptedAccessToken: legacy.encryptedAccessToken,
        keychainAccessToken: true,
        serverSetupComplete: true,
        createdAt: '2026-07-17T12:00:00.000Z',
        updatedAt: '2026-07-17T12:00:00.000Z'
      }]
    })
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(legacyRaw)
    expect(keychain.values.get('agent-access-token:profile-alpha')).toBe('keychain-token')
    expect(keychain.values.get('agent-access-token')).toBe('keychain-token')
    expect(store.accessToken()).toBe('keychain-token')
    expect(store.publicSettings()).toEqual({
      serverUrl: 'http://server.example:7850',
      hasAccessToken: true,
      serverIdentity: 'server-alpha',
      serverSetupComplete: true
    })

    const writesAfterMigration = keychain.writes.length
    const deletesAfterMigration = keychain.deletes.length
    const reopened = new SettingsStore({
      path,
      keychain,
      safeStorage: memorySafeStorage,
      createProfileId: () => { throw new Error('V2 reopen must not generate another profile ID') },
      now: () => '2027-01-01T00:00:00.000Z',
      isMacAppStoreBuild: () => false
    })
    expect(reopened.getActiveProfileId()).toBe('profile-alpha')
    expect(reopened.accessToken()).toBe('keychain-token')
    expect(keychain.writes).toHaveLength(writesAfterMigration)
    // Reopening normalizes the new optional profile fields, creating a second
    // validated v2 snapshot. Only then is the fixed legacy account retired.
    expect(keychain.deletes).toEqual(['agent-access-token'])

    reopened.updateProfile('profile-alpha', { name: 'Alpha' })
    expect(keychain.values.get('agent-access-token:profile-alpha')).toBe('keychain-token')
    expect(keychain.values.has('agent-access-token')).toBe(false)
    expect(keychain.deletes).toEqual(['agent-access-token'])

    reopened.updateProfile('profile-alpha', { name: 'Alpha renamed' })
    expect(keychain.deletes).toEqual(['agent-access-token'])
  })

  it('preserves a v1 safeStorage token per profile in MAS mode without touching Keychain', () => {
    const path = settingsPath()
    const ciphertext = encrypted('mas-token')
    writeFileSync(path, JSON.stringify({
      serverUrl: 'https://mas.example.test:9443',
      encryptedAccessToken: ciphertext,
      keychainAccessToken: false,
      serverSetupComplete: true
    }))
    const keychain = new MemoryKeychain()
    const store = new SettingsStore({
      path,
      keychain,
      safeStorage: memorySafeStorage,
      createProfileId: () => 'profile-mas',
      now: () => '2026-07-17T12:00:00.000Z',
      isMacAppStoreBuild: () => true
    })

    expect(store.accessToken()).toBe('mas-token')
    expect(stored(path).profiles[0]).toEqual(expect.objectContaining({
      id: 'profile-mas',
      encryptedAccessToken: ciphertext,
      keychainAccessToken: false
    }))
    expect(keychain.reads).toEqual([])
    expect(keychain.writes).toEqual([])
    expect(keychain.deletes).toEqual([])
  })

  it('does not recover authority from a keychain-bearing v1 backup when the v2 primary is corrupted', () => {
    const path = settingsPath()
    writeFileSync(path, JSON.stringify({
      serverUrl: 'https://recovery.example.test:9443',
      keychainAccessToken: true,
      serverSetupComplete: true
    }))
    const keychain = new MemoryKeychain()
    keychain.values.set('agent-access-token', 'rollback-token')
    const ids = ['profile-first', 'profile-recovered']

    const migrated = new SettingsStore({
      path,
      keychain,
      safeStorage: memorySafeStorage,
      createProfileId: () => ids.shift()!,
      now: () => '2026-07-17T12:00:00.000Z',
      isMacAppStoreBuild: () => false
    })
    expect(migrated.accessToken()).toBe('rollback-token')

    writeFileSync(path, '{corrupted-v2')
    const recovered = new SettingsStore({
      path,
      keychain,
      safeStorage: memorySafeStorage,
      createProfileId: () => ids.shift()!,
      now: () => '2026-07-17T12:01:00.000Z',
      isMacAppStoreBuild: () => false
    })

    expect(recovered.getActiveProfileId()).toBe('profile-recovered')
    expect(recovered.accessToken()).toBe('')
    expect(keychain.values.has('agent-access-token:profile-recovered')).toBe(false)
    expect(recovered.serverIdentity()).toBeNull()
  })
})

describe('SettingsStore profile operations', () => {
  it('uses bounded nonblocking macOS credential reads and hides process failures', async () => {
    const path = settingsPath()
    const timestamp = '2026-09-10T10:00:00Z'
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, activeProfileId: 'system-test', profiles: [{
      id: 'system-test', name: 'System test', serverUrl: 'https://system.test', keychainAccessToken: true,
      serverSetupComplete: true, createdAt: timestamp, updatedAt: timestamp
    }] }))
    const store = new SettingsStore({ path, safeStorage: memorySafeStorage, isMacAppStoreBuild: () => false })
    const pending = store.accessTokenForConnectionAsync()
    expect(credentialProcesses.execFile).toHaveBeenCalledExactlyOnceWith('/usr/bin/security',
      ['find-generic-password', '-s', 'com.zhengyiluo.AgentsDock', '-a', 'agent-access-token:system-test', '-w'],
      { encoding: 'utf8', timeout: 3000 }, expect.any(Function))
    expect(credentialProcesses.execFileSync).not.toHaveBeenCalled()
    expect(store.getActiveProfile().name).toBe('System test')
    credentialProcesses.execFile.mock.calls[0][3](null, 'fake-result\n')
    await expect(pending).resolves.toBe('fake-result')
    const failed = store.accessTokenForConnectionAsync()
    const rejected = expect(failed).rejects.toThrow('The saved access token could not be read. Re-enter it to reconnect securely.')
    credentialProcesses.execFile.mock.calls[1][3](new Error('private process details'), 'private output')
    await rejected
    expect(credentialProcesses.execFileSync).not.toHaveBeenCalled()
  })

  it('projects, selects and updates v2 profile metadata without reading credentials', () => {
    const keychain = new MemoryKeychain()
    const decryptString = vi.fn(memorySafeStorage.decryptString)
    const ids = ['metadata-a', 'metadata-b']
    const store = new SettingsStore({ path: settingsPath(), keychain,
      safeStorage: { ...memorySafeStorage, decryptString }, createProfileId: () => ids.shift()!,
      isMacAppStoreBuild: () => false })
    store.updateProfile('metadata-a', { accessToken: 'fake-a' })
    store.addProfile({ serverUrl: 'https://b.test', accessToken: 'fake-b' })
    keychain.reads.length = 0
    decryptString.mockClear()

    expect(store.publicSettings().hasAccessToken).toBe(true)
    expect(store.getActiveProfile().hasAccessToken).toBe(true)
    expect(store.getProfile('metadata-b')?.hasAccessToken).toBe(true)
    expect(store.listProfiles()).toHaveLength(2)
    store.getProfileMetadata('metadata-a')
    store.setActiveProfile('metadata-b')
    store.reorderProfiles(['metadata-b', 'metadata-a'])
    store.updateProfile('metadata-a', { name: 'Renamed' })
    store.setProfileServerIdentity('metadata-a', 'identity-a')
    store.setRetiredServerNamespaces('metadata-b', ['retired-b'])
    expect(keychain.reads).toEqual([])
    expect(decryptString).not.toHaveBeenCalled()
    expect(JSON.stringify(store.listProfiles())).not.toContain('fake-a')
  })

  it('coalesces pending asynchronous authentication reads but never caches a settled secret', async () => {
    let resolveRead!: (token: string) => void
    const keychain = Object.assign(new MemoryKeychain(), {
      readAsync: vi.fn(() => new Promise<string>(resolve => { resolveRead = resolve }))
    })
    const store = new SettingsStore({ path: settingsPath(), keychain, safeStorage: memorySafeStorage,
      createProfileId: () => 'async-profile', isMacAppStoreBuild: () => false })
    store.updateProfile('async-profile', { accessToken: 'fake-token' })
    keychain.reads.length = 0
    const first = store.accessTokenForConnectionAsync()
    const concurrent = store.accessTokenForConnectionAsync()
    expect(first).toBe(concurrent)
    expect(keychain.readAsync).toHaveBeenCalledExactlyOnceWith('agent-access-token:async-profile')
    expect(keychain.reads).toEqual([])
    expect(store.listProfiles()).toHaveLength(1)
    resolveRead('fake-token')
    await expect(first).resolves.toBe('fake-token')
    const next = store.accessTokenForConnectionAsync()
    expect(next).not.toBe(first)
    expect(keychain.readAsync).toHaveBeenCalledTimes(2)
    resolveRead('fake-token')
    await expect(next).resolves.toBe('fake-token')
  })

  it.each(['replace', 'clear', 'url', 'identity', 'remove', 'failed replacement'] as const)(
    'rejects an obsolete asynchronous credential after %s and does not revive it', async mutation => {
      const resolvers: Array<(token: string) => void> = []
      const keychain = Object.assign(new MemoryKeychain(), {
        readAsync: vi.fn(() => new Promise<string>(resolve => { resolvers.push(resolve) }))
      })
      const ids = ['async-a', 'async-b']
      const store = new SettingsStore({ path: settingsPath(), keychain, safeStorage: memorySafeStorage,
        createProfileId: () => ids.shift()!, isMacAppStoreBuild: () => false })
      store.updateProfile('async-a', { accessToken: 'fake-old' })
      store.addProfile({ serverUrl: 'https://b.test' })
      const old = store.accessTokenForConnectionAsync('async-a')
      const rejected = expect(old).rejects.toThrow(/changed|Unknown server profile/)
      if (mutation === 'replace') store.updateProfile('async-a', { accessToken: 'fake-new' })
      if (mutation === 'clear') store.updateProfile('async-a', { accessToken: '' })
      if (mutation === 'url') store.updateProfile('async-a', { serverUrl: 'https://new.test' })
      if (mutation === 'identity') store.setProfileServerIdentity('async-a', 'new-identity')
      if (mutation === 'remove') store.removeProfile('async-a', 'async-b')
      if (mutation === 'failed replacement') {
        const persist = vi.spyOn(store as unknown as { persist(): void }, 'persist').mockImplementation(() => { throw new Error('fake disk failure') })
        expect(() => store.updateProfile('async-a', { accessToken: 'fake-new' })).toThrow('fake disk failure')
        persist.mockRestore()
        expect(keychain.values.get('agent-access-token:async-a')).toBe('fake-old')
      }
      const fresh = mutation === 'remove' ? null : store.accessTokenForConnectionAsync('async-a')
      resolvers[0]('fake-old')
      await rejected
      if (fresh) {
        // An obsolete read's finally handler cannot evict the newer in-flight read.
        if (mutation !== 'clear') {
          expect(store.accessTokenForConnectionAsync('async-a')).toBe(fresh)
          resolvers[1](mutation === 'replace' ? 'fake-new' : 'fake-old')
        }
        await expect(fresh).resolves.toBe(mutation === 'clear' ? '' : mutation === 'replace' ? 'fake-new' : 'fake-old')
      }
    }
  )

  it('keeps unreadable asynchronous authentication fail-closed and retries after storage recovers', async () => {
    const keychain = Object.assign(new MemoryKeychain(), { readAsync: vi.fn().mockResolvedValue('') })
    const store = new SettingsStore({ path: settingsPath(), keychain,
      safeStorage: { ...memorySafeStorage, decryptString: () => { throw new Error('fake unavailable storage') } },
      createProfileId: () => 'unreadable', isMacAppStoreBuild: () => false })
    store.updateProfile('unreadable', { accessToken: 'fake-token' })
    expect(store.getActiveProfile().hasAccessToken).toBe(true)
    await expect(store.accessTokenForConnectionAsync()).rejects.toThrow('saved access token could not be read')
    keychain.readAsync.mockResolvedValue('fake-recovered')
    await expect(store.accessTokenForConnectionAsync()).resolves.toBe('fake-recovered')
    expect(keychain.readAsync).toHaveBeenCalledTimes(2)
  })

  it('falls back to safeStorage when Keychain rejects an access token', () => {
    const path = settingsPath()
    const keychain = new MemoryKeychain()
    keychain.writeEnabled = false
    const store = new SettingsStore({
      path,
      keychain,
      safeStorage: memorySafeStorage,
      createProfileId: () => 'profile-alpha',
      now: () => '2026-07-17T12:00:00.000Z',
      isMacAppStoreBuild: () => false
    })
    const token = 'admin token requiring safeStorage'

    store.update({ serverUrl: 'http://127.0.0.1:7850', accessToken: token })

    expect(store.accessToken()).toBe(token)
    expect(stored(path).profiles[0]).toEqual(expect.objectContaining({
      keychainAccessToken: false,
      encryptedAccessToken: encrypted(token)
    }))
    expect(readFileSync(path, 'utf8')).not.toContain(token)
    expect(keychain.values.has('agent-access-token:profile-alpha')).toBe(false)
  })

  it('refuses Electron basic-text credential storage on Linux', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      const keychain = new MemoryKeychain()
      keychain.writeEnabled = false
      const store = new SettingsStore({
        path: settingsPath(),
        keychain,
        safeStorage: { ...memorySafeStorage, getSelectedStorageBackend: () => 'basic_text' },
        createProfileId: () => 'profile-linux',
        isMacAppStoreBuild: () => false
      })

      expect(() => store.update({ serverUrl: 'http://127.0.0.1:7850', accessToken: 'must-not-use-basic-text' })).toThrow('Secure token storage is unavailable')
      expect(store.publicSettings().hasAccessToken).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps legacy Linux basic-text ciphertext dormant until secure storage is available', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      const path = settingsPath()
      const ciphertext = encrypted('legacy-basic-text-token')
      writeFileSync(path, `${JSON.stringify({
        schemaVersion: 2,
        activeProfileId: 'profile-linux',
        profiles: [{
          id: 'profile-linux',
          name: 'Linux',
          serverUrl: 'http://127.0.0.1:7850',
          encryptedAccessToken: ciphertext,
          keychainAccessToken: false,
          serverSetupComplete: true,
          createdAt: '2026-07-17T12:00:00.000Z',
          updatedAt: '2026-07-17T12:00:00.000Z'
        }]
      }, null, 2)}\n`)
      const decryptString = vi.fn(memorySafeStorage.decryptString)
      const store = new SettingsStore({
        path,
        keychain: new MemoryKeychain(),
        safeStorage: { ...memorySafeStorage, decryptString, getSelectedStorageBackend: () => 'basic_text' },
        createProfileId: () => 'unused',
        isMacAppStoreBuild: () => false
      })

      expect(store.accessToken()).toBe('')
      expect(decryptString).not.toHaveBeenCalled()
      // Display presence is metadata; only explicit authentication tests usability.
      expect(store.publicSettings().hasAccessToken).toBe(true)
      expect(store.getActiveProfile().hasAccessToken).toBe(true)
      expect(store.listProfiles()[0]?.hasAccessToken).toBe(true)
      expect(() => store.accessTokenForConnection()).toThrow('saved access token could not be read')
      expect(() => store.update({ serverUrl: 'http://127.0.0.1:7850', accessToken: '__KEEP__' }))
        .toThrow('saved access token could not be read')
      expect(store.updateProfile('profile-linux', { name: 'Renamed Linux' }).name).toBe('Renamed Linux')
      expect(stored(path).profiles[0].encryptedAccessToken).toBe(ciphertext)
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps compatibility wrappers active-profile scoped and credentials profile-specific', () => {
    const path = settingsPath()
    const keychain = new MemoryKeychain()
    const ids = ['profile-alpha', 'profile-beta']
    const store = new SettingsStore({
      path,
      keychain,
      safeStorage: memorySafeStorage,
      createProfileId: () => ids.shift()!,
      now: () => '2026-07-17T12:00:00.000Z',
      isMacAppStoreBuild: () => false
    })

    store.update({ serverUrl: 'alpha.example:7850', accessToken: 'alpha-token' })
    const beta = store.addProfile({
      name: 'Beta',
      serverUrl: 'beta.example:7850',
      accessToken: 'beta-token',
      setActive: true
    })
    expect(beta.id).toBe('profile-beta')
    expect(store.getActiveProfileId()).toBe('profile-beta')
    expect(store.serverUrl()).toBe('http://beta.example:7850')
    expect(store.accessToken()).toBe('beta-token')

    store.update({ serverUrl: 'beta-new.example:7850', accessToken: '__KEEP__' })
    expect(store.accessToken()).toBe('beta-token')
    expect(keychain.values.get('agent-access-token:profile-alpha')).toBe('alpha-token')
    expect(keychain.values.get('agent-access-token:profile-beta')).toBe('beta-token')

    store.setActiveProfile('profile-alpha')
    expect(store.publicSettings().serverUrl).toBe('http://alpha.example:7850')
    expect(store.accessToken()).toBe('alpha-token')
    expect(store.reorderProfiles(['profile-beta', 'profile-alpha']).map(profile => profile.id))
      .toEqual(['profile-beta', 'profile-alpha'])

    store.removeProfile('profile-beta')
    expect(store.listProfiles().map(profile => profile.id)).toEqual(['profile-alpha'])
    expect(keychain.values.get('agent-access-token:profile-alpha')).toBe('alpha-token')
    expect(keychain.values.has('agent-access-token:profile-beta')).toBe(false)
    expect(JSON.stringify(store.listProfiles())).not.toContain('alpha-token')
  })

  it('requires an explicit replacement when removing the active profile', () => {
    const path = settingsPath()
    const ids = ['profile-a', 'profile-b']
    const store = new SettingsStore({
      path,
      keychain: new MemoryKeychain(),
      safeStorage: memorySafeStorage,
      createProfileId: () => ids.shift()!,
      now: () => '2026-07-17T12:00:00.000Z',
      isMacAppStoreBuild: () => false
    })
    store.addProfile({ serverUrl: 'server-b.example:7850', setActive: true })

    expect(() => store.removeProfile('profile-b')).toThrow(/replacement/)
    store.removeProfile('profile-b', 'profile-a')
    expect(store.getActiveProfileId()).toBe('profile-a')
  })
})

describe('SettingsStore atomic persistence', () => {
  it('does not authorize legacy cleanup from a corrupt primary and an unmigrated v1 backup', () => {
    const path = settingsPath()
    const keychain = new MemoryKeychain()
    keychain.values.set('agent-access-token', 'fake-retained-legacy')
    writeFileSync(path, '{broken')
    writeFileSync(`${path}.bak`, JSON.stringify({ serverUrl: 'https://old.test', keychainAccessToken: true }))
    const store = new SettingsStore({ path, keychain, safeStorage: memorySafeStorage,
      createProfileId: () => 'fresh', isMacAppStoreBuild: () => false })
    store.updateProfile('fresh', { name: 'Fresh profile' })
    expect(keychain.reads).toEqual([])
    expect(keychain.deletes).toEqual([])
    expect(store.accessToken()).toBe('')
    expect(keychain.values.get('agent-access-token')).toBe('fake-retained-legacy')
  })

  it('keeps a diagnostic backup but never restores its authority after corruption', () => {
    const path = settingsPath()
    const keychain = new MemoryKeychain()
    const store = new SettingsStore({
      path,
      keychain,
      safeStorage: memorySafeStorage,
      createProfileId: () => 'profile-a',
      now: () => '2026-07-17T12:00:00.000Z',
      isMacAppStoreBuild: () => false
    })
    const initial = readFileSync(path, 'utf8')
    store.update({ serverUrl: 'changed.example:7850', accessToken: '' })
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(initial)

    writeFileSync(path, '{not-valid-json')
    const recovered = new SettingsStore({
      path,
      keychain,
      safeStorage: memorySafeStorage,
      createProfileId: () => 'profile-recovered',
      now: () => '2026-07-17T13:00:00.000Z',
      isMacAppStoreBuild: () => false
    })

    expect(recovered.serverUrl()).toBe('http://127.0.0.1:7850')
    expect(stored(path).schemaVersion).toBe(2)
    expect(stored(path).activeProfileId).toBe('profile-recovered')
    expect(recovered.accessToken()).toBe('')
  })

  it('leaves a future schema untouched and surfaces an actionable downgrade error', () => {
    const path = settingsPath()
    const raw = '{"schemaVersion":3,"profiles":[],"future":"keep-me"}\n'
    writeFileSync(path, raw)

    expect(() => new SettingsStore({
      path,
      keychain: new MemoryKeychain(),
      safeStorage: memorySafeStorage,
      createProfileId: () => 'must-not-create',
      now: () => '2026-07-17T13:00:00.000Z',
      isMacAppStoreBuild: () => false
    })).toThrow(/unsupported settings schema/i)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })

  it.each(['identity reset', 'profile removal', 'token clear'] as const)(
    'cannot resurrect authority from the stale backup after %s and primary corruption',
    operation => {
      const path = settingsPath()
      const keychain = new MemoryKeychain()
      const ids = ['profile-a', 'profile-b', 'profile-recovered']
      const store = new SettingsStore({
        path,
        keychain,
        safeStorage: memorySafeStorage,
        createProfileId: () => ids.shift()!,
        now: () => '2026-07-17T12:00:00.000Z',
        isMacAppStoreBuild: () => false
      })
      store.updateProfile('profile-a', {
        serverIdentity: 'server-retired',
        accessToken: 'retired-token'
      })
      if (operation === 'identity reset') {
        store.updateProfile('profile-a', { serverIdentity: null })
      } else if (operation === 'profile removal') {
        store.addProfile({ name: 'Replacement', serverUrl: 'replacement.test:7850', setActive: true })
        store.removeProfile('profile-a')
      } else {
        store.updateProfile('profile-a', { accessToken: '' })
      }
      writeFileSync(path, '{corrupt-primary')

      const recovered = new SettingsStore({
        path,
        keychain,
        safeStorage: memorySafeStorage,
        createProfileId: () => ids.shift()!,
        now: () => '2026-07-17T13:00:00.000Z',
        isMacAppStoreBuild: () => false
      })

      expect(recovered.getActiveProfileId()).not.toBe('profile-a')
      expect(recovered.serverIdentity()).toBeNull()
      expect(recovered.accessToken()).toBe('')
      expect(recovered.listProfiles().some(profile => profile.id === 'profile-a')).toBe(false)
    }
  )
})
