import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { PublicServerSettings, ServerSettings } from '../shared/types'
import { DEFAULT_SERVER_URL, normalizeServerURL } from '../shared/server-url'

interface StoredSettings {
  serverUrl: string
  encryptedAccessToken?: string
  keychainAccessToken?: boolean
  serverIdentity?: string | null
}

const KEYCHAIN_SERVICE = 'com.zhengyiluo.AgentsDock'
const KEYCHAIN_ACCOUNT = 'agent-access-token'

export { normalizeServerURL } from '../shared/server-url'

export class SettingsStore {
  private readonly path: string
  private value: StoredSettings

  constructor() {
    this.path = join(app.getPath('userData'), 'settings.json')
    this.value = this.read()
    if (process.env.AGENTSDOCK_MIGRATE_SAFE_STORAGE === '1') this.migrateLegacySafeStorageToken()
  }

  publicSettings(): PublicServerSettings {
    return {
      serverUrl: this.value.serverUrl,
      hasAccessToken: Boolean(this.value.keychainAccessToken || this.value.encryptedAccessToken),
      serverIdentity: this.value.serverIdentity ?? null
    }
  }

  serverUrl(): string {
    return normalizeServerURL(this.value.serverUrl)
  }

  accessToken(): string {
    return this.value.keychainAccessToken ? readKeychainToken() : ''
  }

  update(settings: ServerSettings): void {
    this.value.serverUrl = normalizeServerURL(settings.serverUrl)
    if (settings.accessToken !== '__KEEP__') {
      if (settings.accessToken) {
        writeKeychainToken(settings.accessToken)
        this.value.keychainAccessToken = true
      } else {
        deleteKeychainToken()
        this.value.keychainAccessToken = false
      }
      delete this.value.encryptedAccessToken
    }
    this.write()
  }

  setServerIdentity(serverIdentity: string | null | undefined): void {
    this.value.serverIdentity = serverIdentity ?? null
    this.write()
  }

  private read(): StoredSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoredSettings
      const stored = {
        serverUrl: normalizeServerURL(parsed.serverUrl || DEFAULT_SERVER_URL),
        encryptedAccessToken: parsed.encryptedAccessToken,
        keychainAccessToken: parsed.keychainAccessToken,
        serverIdentity: parsed.serverIdentity
      }
      if (stored.serverUrl === DEFAULT_SERVER_URL && !stored.encryptedAccessToken && !stored.keychainAccessToken) return this.migrateSwiftSettings() ?? stored
      return stored
    } catch {
      return this.migrateSwiftSettings() ?? { serverUrl: DEFAULT_SERVER_URL }
    }
  }

  private migrateSwiftSettings(): StoredSettings | null {
    try {
      const serverUrl = normalizeServerURL(execFileSync('/usr/bin/defaults', ['read', 'com.zhengyiluo.ZenithDock', 'serverURL'], { encoding: 'utf8', timeout: 3000 }).trim())
      let token = ''
      try {
        token = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'com.zhengyiluo.ZenithDock', '-a', 'agent-access-token', '-w'], { encoding: 'utf8', timeout: 3000 }).trim()
      } catch { /* the endpoint can still be migrated without a token */ }
      const migrated: StoredSettings = { serverUrl }
      if (token) {
        writeKeychainToken(token)
        migrated.keychainAccessToken = true
      }
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, `${JSON.stringify(migrated, null, 2)}\n`, { mode: 0o600 })
      return migrated
    } catch {
      return null
    }
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 })
  }

  private migrateLegacySafeStorageToken(): void {
    if (!this.value.encryptedAccessToken || !safeStorage.isEncryptionAvailable()) return
    try {
      const token = safeStorage.decryptString(Buffer.from(this.value.encryptedAccessToken, 'base64'))
      if (!token) return
      writeKeychainToken(token)
      this.value.keychainAccessToken = true
      delete this.value.encryptedAccessToken
      this.write()
    } catch { /* normal startup remains non-blocking; the user can re-enter the token */ }
  }
}

function readKeychainToken(): string {
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch { return '' }
}

function writeKeychainToken(token: string): void {
  execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', token], {
    encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'ignore', 'pipe']
  })
}

function deleteKeychainToken(): void {
  try {
    execFileSync('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'ignore', 'ignore']
    })
  } catch { /* deleting an absent token is already the desired state */ }
}
