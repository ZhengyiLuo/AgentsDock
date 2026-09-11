import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Event } from '../shared/types'

const faults = vi.hoisted(() => ({ open: false, initialize: false, files: false, root: '' }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const mocked = { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (faults.files) throw Object.assign(new Error('ENOSPC: synthetic disk full'), { code: 'ENOSPC' })
    return fs.writeFileSync(...args)
  } }
  return { ...mocked, default: mocked }
})
vi.mock('node:sqlite', async importOriginal => {
  const sqlite = await importOriginal<typeof import('node:sqlite')>()
  const mocked = { ...sqlite, DatabaseSync: class extends sqlite.DatabaseSync {
    private readonly disk: boolean
    constructor(path: string, options?: import('node:sqlite').DatabaseSyncOptions) {
      if (faults.open && path !== ':memory:' && !options?.readOnly) {
        throw Object.assign(new Error('ENOSPC: synthetic open failure'), { code: 'ENOSPC' })
      }
      super(path, options ?? {})
      this.disk = path !== ':memory:'
    }
    override exec(sql: string): void {
      if (faults.initialize && this.disk && sql.includes('CREATE TABLE')) {
        throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 })
      }
      super.exec(sql)
    }
  } }
  return { ...mocked, default: mocked }
})
vi.mock('electron', () => ({ app: { getPath: () => faults.root }, safeStorage: {},
  BrowserWindow: class {}, dialog: {}, nativeImage: {}, Notification: class {}, shell: {} }))
vi.mock('./logger', () => ({ appLog: vi.fn() }))

import { LocalCache } from './persistence'
import { SettingsStore } from './settings'
import { AppService } from './service'
import { clearStorageError, localStorageWasFull } from './storage-health'
import { isStorageFullError } from '../shared/storage-errors'

const disposers: Array<() => void> = []
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-storage-full-'))
  faults.root = directory
  disposers.unshift(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
function settings(directory: string): SettingsStore {
  return new SettingsStore({ path: join(directory, 'settings.json'), createProfileId: () => 'synthetic-profile',
    keychain: { read: () => '', write: () => false, delete: () => {} },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
    isMacAppStoreBuild: () => false })
}
function cache(path: string): LocalCache {
  const value = new LocalCache(path)
  disposers.push(() => value.close())
  return value
}
function event(seq: number): Event {
  return { id: `event-${seq}`, seq, session_id: 'chat', type: 'assistant_text', text: `Answer ${seq}`, ts: '2026-09-11T00:00:00Z' }
}
afterEach(() => {
  faults.open = faults.initialize = faults.files = false
  vi.restoreAllMocks()
  while (disposers.length) disposers.pop()?.()
  clearStorageError()
})

describe('storage exhaustion recovery', () => {
  it('boots the actual app service with a missing cache on ENOSPC, then explicitly recovers and saves a draft', async () => {
    const directory = root()
    const configured = settings(directory)
    const original = readFileSync(join(directory, 'settings.json'), 'utf8')
    faults.open = true
    expect(() => new DatabaseSync(join(directory, 'synthetic-probe.sqlite'))).toThrow('ENOSPC')
    const service = new AppService({ settings: configured, clientFactory: () => ({}) as never })
    const local = (service as unknown as { cache: LocalCache }).cache
    disposers.push(() => local.close())
    const bootstrap = await service.bootstrap()
    expect(bootstrap.storageFull).toBe(true)
    expect(() => local.putPreference('server', 'draft:chat', 'Unsent draft')).toThrow('ENOSPC')
    expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe(original)
    faults.open = false
    service.retryLocalStorage()
    local.putPreference('server', 'draft:chat', 'Unsent draft')
    expect(cache(join(directory, 'agentsdock.sqlite')).preference('server', 'draft:chat', '')).toBe('Unsent draft')
    expect(localStorageWasFull()).toBe(false)
  })

  it('preserves existing drafts through a failed migration and fences temporary events after retry', () => {
    const directory = root()
    const path = join(directory, 'cache.sqlite')
    const initial = new LocalCache(path)
    initial.putPreference('server', 'draft:chat', 'Previously saved draft')
    const db = (initial as unknown as { db: DatabaseSync }).db
    db.prepare('DELETE FROM cache_meta WHERE key = ?').run('file-ownership-schema')
    initial.close()
    faults.initialize = true
    const local = cache(path)
    expect(local.preference('server', 'draft:chat', '')).toBe('Previously saved draft')
    expect(() => local.putPreference('server', 'draft:chat', 'Current draft')).toThrow('disk is full')
    local.putEvents('server', 'chat', [event(8)])
    faults.initialize = false
    local.retryStorageWrites()
    expect(local.preference('server', 'draft:chat', '')).toBe('Previously saved draft')
    expect(local.latestEventSequence('server', 'chat')).toBe(0)
    expect(() => local.putEvents('server', 'chat', [event(9)])).toThrow('Refresh this chat')
    local.putEvents('server', 'chat', [event(8), event(9)], 0)
    local.putPreference('server', 'draft:chat', 'Current draft')
    expect(cache(path).preference('server', 'draft:chat', '')).toBe('Current draft')
  })

  it('does not advance the durable cursor over a failed batch and recovers by authoritative reconciliation', () => {
    const local = cache(':memory:')
    local.putEvents('server', 'chat', [event(1)])
    const db = (local as unknown as { db: DatabaseSync }).db
    const exec = db.exec.bind(db)
    vi.spyOn(db, 'exec').mockImplementationOnce(sql => exec(sql)).mockImplementationOnce(() => {
      throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 })
    })
    expect(() => local.putEvents('server', 'chat', [event(2)])).toThrow('disk is full')
    expect(local.latestEventSequence('server', 'chat')).toBe(1)
    expect(() => local.putEvents('server', 'chat', [event(3)])).toThrow('disk is full')
    expect(() => local.putTimelineState('server', 'chat', false, 3)).toThrow('disk is full')
    local.putEvents('server', 'chat', [event(2), event(3)], 1)
    expect(local.latestEventSequence('server', 'chat')).toBe(3)
  })

  it('keeps settings intact on ENOSPC and does not require a normalization write at startup', () => {
    const directory = root()
    const current = settings(directory)
    const path = join(directory, 'settings.json')
    const original = readFileSync(path, 'utf8')
    faults.files = true
    expect(() => writeFileSync(join(directory, 'synthetic-probe.txt'), 'probe')).toThrow('ENOSPC')
    expect(() => current.updateProfile('synthetic-profile', { name: 'New label' })).toThrow('ENOSPC')
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(current.getActiveProfile().name).not.toBe('New label')
    faults.files = false
    writeFileSync(path, JSON.stringify({ ...JSON.parse(original), obsoleteDisplayOption: true }))
    faults.files = true
    expect(settings(directory).getActiveProfile().id).toBe('synthetic-profile')
    expect(localStorageWasFull()).toBe(true)
    faults.files = false
    current.updateProfile('synthetic-profile', { name: 'New label' })
    expect(settings(directory).getActiveProfile().name).toBe('New label')
  })

  it('does not mistake remote error text, permission failures or corruption for local exhaustion', () => {
    expect(isStorageFullError(new Error('The remote server reported ENOSPC'))).toBe(false)
    expect(isStorageFullError({ code: 'EACCES' })).toBe(false)
    expect(isStorageFullError({ code: 'ERR_SQLITE_ERROR', errcode: 11 })).toBe(false)
    expect(isStorageFullError({ name: 'QuotaExceededError' })).toBe(true)
  })
})
