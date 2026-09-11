import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import type { Stats } from 'node:fs'
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  lstat,
  writeFile
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import type { TeamAttachment } from '../shared/team-network'

const DEFAULT_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024
const SIDECAR_NAME = 'metadata.json'
const PAYLOAD_NAME = 'content.bin'
const CACHE_IDENTITY_DEPTH = 7

export interface TeamAttachmentCacheIdentity {
  profileId: string
  profileGeneration: number
  /** Team Hub auth/session generation; prevents cross-principal reuse. */
  authGeneration: number
  authCacheEpoch: string
  /** Exact AgentsServer authority which introduced this Team Hub binding. */
  serverIdentity: string
  hubId: string
  teamId: string
  attachmentId: string
}

interface CacheSidecar {
  version: 5
  profile_id: string
  server_identity: string
  auth_generation: number
  auth_cache_epoch: string
  hub_id: string
  team_id: string
  attachment_id: string
  file_name: string
  media_type: string
  byte_size: number
  sha256: string
}

interface CacheEntry {
  directory: string
  file: string
  sidecar: CacheSidecar
  signature: string
  lastAccess: number
}

interface VerifiedFile {
  signature: string
  sha256: string
}

interface ProfileTransferGeneration {
  readonly generation: number
  readonly controller: AbortController
}

export class TeamAttachmentCache {
  private readonly maxBytes: number
  private readonly inFlight = new Map<string, Promise<string>>()
  private readonly verifiedFiles = new Map<string, VerifiedFile>()
  private readonly profileTransfers = new Map<string, ProfileTransferGeneration>()
  private readonly profileOperations = new Map<string, Promise<void>>()
  private maintenance: Promise<void> = Promise.resolve()
  private transfers: Promise<void> = Promise.resolve()

  constructor(private readonly root: string, maxBytes = configuredCacheMaxBytes()) {
    if (!root || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Team attachment cache configuration is invalid.')
    this.maxBytes = maxBytes
  }

  cache(
    identity: TeamAttachmentCacheIdentity,
    attachment: TeamAttachment,
    chunkBytes: number,
    download: (start: number, end: number, signal?: AbortSignal) => Promise<Response>
  ): Promise<string> {
    requireMatchingAttachment(identity, attachment)
    const key = cacheOperationKey(identity, attachment)
    const active = this.inFlight.get(key)
    if (active) return active
    const profileTransfer = this.profileTransfer(identity.profileId)
    const operation = this.withProfileOperation(identity.profileId, () => this.withTransfer(() => {
      this.requireProfileTransfer(identity.profileId, profileTransfer)
      return this.cacheFresh(identity, attachment, chunkBytes, download, profileTransfer.controller.signal)
    }, profileTransfer.controller.signal))
      .finally(() => {
        if (this.inFlight.get(key) === operation) this.inFlight.delete(key)
      })
    this.inFlight.set(key, operation)
    return operation
  }

  /** Remove every cached attachment owned by one exact server profile. */
  purgeProfile(profileId: string): Promise<void> {
    const profileComponent = component(profileId, 'AgentsServer profile')
    const previousTransfer = this.profileTransfer(profileId)
    previousTransfer.controller.abort(new Error('The Team attachment cache profile was purged.'))
    this.profileTransfers.set(profileComponent, {
      generation: previousTransfer.generation + 1,
      controller: new AbortController()
    })
    const keyPrefix = `${profileComponent}\0`
    // A cache call made after this purge request must queue behind the purge,
    // not reuse an older in-flight promise whose file is about to be removed.
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(keyPrefix)) this.inFlight.delete(key)
    }
    const directory = join(this.root, profileComponent)
    return this.withProfileOperation(profileId, () => this.withMaintenance(async () => {
      this.forgetDirectory(directory)
      await rm(directory, { recursive: true, force: true })
    }))
  }

  async response(identity: TeamAttachmentCacheIdentity, request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } })
    }
    const profileTransfer = this.profileTransfer(identity.profileId)
    return this.withProfileOperation(identity.profileId, async () => {
      this.requireProfileTransfer(identity.profileId, profileTransfer)
      const entry = await this.readEntry(identity)
      if (!entry) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })
      const range = parseByteRange(request.headers.get('Range'), entry.sidecar.byte_size)
      if (range === 'invalid') {
        return new Response(null, {
          status: 416,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes */${entry.sidecar.byte_size}`,
            'Cache-Control': 'no-store'
          }
        })
      }
      const start = range?.start ?? 0
      const end = range?.end ?? entry.sidecar.byte_size - 1
      const length = end - start + 1
      const handle = await this.openVerifiedEntry(entry, profileTransfer.controller.signal)
      if (!handle) {
        this.requireProfileTransfer(identity.profileId, profileTransfer)
        await this.invalidate(entry)
        return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } })
      }
      try {
        this.requireProfileTransfer(identity.profileId, profileTransfer)
      } catch (error) {
        await handle.close().catch(() => undefined)
        throw error
      }
      const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Content-Type': entry.sidecar.media_type,
        'Content-Length': String(length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      })
      if (range) headers.set('Content-Range', `bytes ${start}-${end}/${entry.sidecar.byte_size}`)
      if (request.method === 'HEAD') {
        await handle.close()
        return new Response(null, { status: range ? 206 : 200, headers })
      }
      return new Response(
        fileHandleResponseStream(handle, start, end, profileTransfer.controller.signal),
        { status: range ? 206 : 200, headers }
      )
    })
  }

  private async cacheFresh(
    identity: TeamAttachmentCacheIdentity,
    attachment: TeamAttachment,
    chunkBytes: number,
    download: (start: number, end: number, signal?: AbortSignal) => Promise<Response>,
    signal: AbortSignal
  ): Promise<string> {
    requireMatchingAttachment(identity, attachment)
    if (attachment.state !== 'ready') throw new Error('Team attachment is not ready to download.')
    if (attachment.byte_size > this.maxBytes) {
      throw new Error('Team attachment is larger than the local Team attachment cache.')
    }
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 8 * 1024 * 1024) {
      throw new Error('Team attachment chunk size is invalid.')
    }
    const directory = this.entryDirectory(identity)
    const file = join(directory, PAYLOAD_NAME)
    const expected = sidecarFor(identity, attachment)
    const existing = await this.readEntry(identity)
    if (existing && sameSidecar(existing.sidecar, expected)) {
      const handle = await this.openVerifiedEntry(existing, signal)
      if (handle) {
        await handle.close()
        await this.withMaintenance(() => this.evict(existing.file))
        return existing.file
      }
    }
    await this.withMaintenance(async () => {
      this.forgetDirectory(directory)
      await rm(directory, { recursive: true, force: true })
      await this.reserve(attachment.byte_size)
      await mkdir(directory, { recursive: true, mode: 0o700 })
    })
    const temporary = join(directory, `.download-${randomUUID()}.part`)
    const handle = await open(temporary, 'wx', 0o600)
    const hash = createHash('sha256')
    let offset = 0
    try {
      while (offset < attachment.byte_size) {
        signal.throwIfAborted()
        const end = Math.min(attachment.byte_size - 1, offset + chunkBytes - 1)
        const response = await download(offset, end, signal)
        signal.throwIfAborted()
        if (response.status !== 206) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error('Team Hub did not honor the attachment byte range.')
        }
        const expectedRange = `bytes ${offset}-${end}/${attachment.byte_size}`
        if (response.headers.get('Content-Range') !== expectedRange) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error('Team Hub returned a mismatched attachment byte range.')
        }
        const bytes = await readExactResponseBytes(response, end - offset + 1, signal)
        await writeAll(handle, bytes, offset)
        hash.update(bytes)
        offset += bytes.byteLength
      }
      signal.throwIfAborted()
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    await handle.close()
    const digest = hash.digest('hex')
    if (offset !== attachment.byte_size || digest !== attachment.sha256) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new Error('Team attachment failed integrity verification.')
    }
    signal.throwIfAborted()
    try {
      await this.withMaintenance(async () => {
        signal.throwIfAborted()
        await rename(temporary, file)
        await atomicWriteJSON(join(directory, SIDECAR_NAME), expected)
        const info = await lstat(file)
        if (!info.isFile() || info.isSymbolicLink() || info.size !== attachment.byte_size) {
          throw new Error('Team attachment cache commit failed.')
        }
        // Do not memoize the write-time digest against a later path lookup.
        // The first media open reopens with O_NOFOLLOW and hashes that exact fd.
        this.verifiedFiles.delete(file)
        await this.evict(file)
      })
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      await this.withMaintenance(async () => {
        this.forgetDirectory(directory)
        await rm(directory, { recursive: true, force: true })
      }).catch(() => undefined)
      throw error
    }
    return file
  }

  private async openVerifiedEntry(entry: CacheEntry, signal?: AbortSignal): Promise<FileHandle | null> {
    let handle: FileHandle | undefined
    try {
      handle = await open(entry.file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      const before = await handle.stat()
      if (!before.isFile() || before.size !== entry.sidecar.byte_size) throw new Error('Invalid cached attachment.')
      const signature = fileSignature(before)
      entry.signature = signature
      const verified = this.verifiedFiles.get(entry.file)
      if (!verified || verified.signature !== signature || verified.sha256 !== entry.sidecar.sha256) {
        const digest = await sha256FileHandle(handle, before.size, signal)
        const after = await handle.stat()
        if (fileSignature(after) !== signature || digest !== entry.sidecar.sha256) {
          throw new Error('Cached attachment integrity verification failed.')
        }
        this.verifiedFiles.set(entry.file, { signature, sha256: digest })
      }
      return handle
    } catch {
      await handle?.close().catch(() => undefined)
      return null
    }
  }

  private invalidate(entry: CacheEntry): Promise<void> {
    return this.withMaintenance(async () => {
      try {
        const current = await lstat(entry.file)
        if (fileSignature(current) !== entry.signature) return
      } catch {
        return
      }
      this.forgetDirectory(entry.directory)
      await rm(entry.directory, { recursive: true, force: true })
    })
  }

  private forgetDirectory(directory: string): void {
    const prefix = `${directory}${sep}`
    for (const path of this.verifiedFiles.keys()) {
      if (path.startsWith(prefix)) this.verifiedFiles.delete(path)
    }
  }

  private withMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.maintenance.then(operation)
    this.maintenance = result.then(() => undefined, () => undefined)
    return result
  }

  private withTransfer<T>(operation: () => Promise<T>, waitingSignal: AbortSignal): Promise<T> {
    const previous = this.transfers
    let acquired = false
    const execution = previous.then(() => {
      acquired = true
      waitingSignal.throwIfAborted()
      return operation()
    })
    this.transfers = execution.then(() => undefined, () => undefined)
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (outcome: () => void) => {
        if (settled) return
        settled = true
        waitingSignal.removeEventListener('abort', abortWaiting)
        outcome()
      }
      const abortWaiting = () => {
        if (!acquired) finish(() => reject(
          waitingSignal.reason ?? new Error('The Team attachment cache profile was purged.')
        ))
      }
      if (waitingSignal.aborted) abortWaiting()
      else waitingSignal.addEventListener('abort', abortWaiting, { once: true })
      void execution.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error))
      )
    })
  }

  private withProfileOperation<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const key = component(profileId, 'AgentsServer profile')
    const previous = this.profileOperations.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.profileOperations.set(key, tail)
    void tail.then(() => {
      if (this.profileOperations.get(key) === tail) this.profileOperations.delete(key)
    })
    return result
  }

  private profileTransfer(profileId: string): ProfileTransferGeneration {
    const key = component(profileId, 'AgentsServer profile')
    const existing = this.profileTransfers.get(key)
    if (existing) return existing
    const created = { generation: 1, controller: new AbortController() }
    this.profileTransfers.set(key, created)
    return created
  }

  private requireProfileTransfer(profileId: string, expected: ProfileTransferGeneration): void {
    if (this.profileTransfers.get(component(profileId, 'AgentsServer profile')) !== expected) {
      throw new Error('The Team attachment cache profile was purged.')
    }
    expected.controller.signal.throwIfAborted()
  }

  private async readEntry(identity: TeamAttachmentCacheIdentity): Promise<CacheEntry | null> {
    const directory = this.entryDirectory(identity)
    let sidecar: CacheSidecar
    try {
      sidecar = await readSidecarFile(join(directory, SIDECAR_NAME))
    } catch {
      return null
    }
    if (!sameCacheIdentity(sidecar, identity)) return null
    const file = join(directory, PAYLOAD_NAME)
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.size !== sidecar.byte_size) return null
      return {
        directory,
        file,
        sidecar,
        signature: fileSignature(info),
        lastAccess: info.atimeMs || info.mtimeMs
      }
    } catch {
      return null
    }
  }

  private entryDirectory(identity: TeamAttachmentCacheIdentity): string {
    return join(
      this.root,
      component(identity.profileId, 'AgentsServer profile'),
      component(identity.serverIdentity, 'AgentsServer'),
      component(String(identity.authGeneration), 'Team Hub auth generation'),
      component(identity.authCacheEpoch, 'Team Hub auth cache epoch'),
      component(identity.hubId, 'Team Hub'),
      component(identity.teamId, 'Team'),
      component(identity.attachmentId, 'Team attachment')
    )
  }

  private async evict(preservedFile: string): Promise<void> {
    const entries = await collectEntries(this.root, true)
    let total = entries.reduce((sum, entry) => sum + entry.sidecar.byte_size, 0)
    if (total <= this.maxBytes) return
    entries.sort((left, right) => left.lastAccess - right.lastAccess)
    for (const entry of entries) {
      if (entry.file === preservedFile) continue
      if (!await removeCacheDirectory(entry.directory)) continue
      this.verifiedFiles.delete(entry.file)
      total -= entry.sidecar.byte_size
      if (total <= this.maxBytes) return
    }
    if (total > this.maxBytes) throw new Error('Could not enforce the local Team attachment cache limit.')
  }

  private async reserve(byteSize: number): Promise<void> {
    const entries = await collectEntries(this.root, true)
    let total = entries.reduce((sum, entry) => sum + entry.sidecar.byte_size, 0)
    if (total + byteSize <= this.maxBytes) return
    entries.sort((left, right) => left.lastAccess - right.lastAccess)
    for (const entry of entries) {
      if (!await removeCacheDirectory(entry.directory)) continue
      this.verifiedFiles.delete(entry.file)
      total -= entry.sidecar.byte_size
      if (total + byteSize <= this.maxBytes) return
    }
    throw new Error('Could not reserve space in the local Team attachment cache.')
  }
}

function configuredCacheMaxBytes(): number {
  const raw = process.env.AGENTSDOCK_TEAM_CACHE_MAX_BYTES?.trim()
  if (!raw) return DEFAULT_CACHE_MAX_BYTES
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_CACHE_MAX_BYTES
}

function component(value: string, label: string): string {
  if (!value || Buffer.byteLength(value, 'utf8') > 1_024) {
    throw new Error(`${label} cache identity is invalid.`)
  }
  return Buffer.from(value, 'utf8').toString('base64url')
}

function cacheIdentityKey(identity: TeamAttachmentCacheIdentity): string {
  return [
    component(identity.profileId, 'AgentsServer profile'),
    component(identity.serverIdentity, 'AgentsServer'),
    component(String(identity.authGeneration), 'Team Hub auth generation'),
    component(identity.authCacheEpoch, 'Team Hub auth cache epoch'),
    component(identity.hubId, 'Team Hub'),
    component(identity.teamId, 'Team'),
    component(identity.attachmentId, 'Team attachment')
  ].join('\0')
}

function cacheOperationKey(identity: TeamAttachmentCacheIdentity, attachment: TeamAttachment): string {
  // Generations intentionally share a disk identity, but an older generation
  // must never lend its in-flight promise to a replacement connection. The
  // transfer queue still serializes both operations, allowing the newer one to
  // reuse the verified stable file after the older operation finishes.
  if (!Number.isSafeInteger(identity.profileGeneration) || identity.profileGeneration < 0) {
    throw new Error('AgentsServer profile cache generation is invalid.')
  }
  if (!Number.isSafeInteger(identity.authGeneration) || identity.authGeneration < 0) {
    throw new Error('Team Hub auth cache generation is invalid.')
  }
  component(identity.authCacheEpoch, 'Team Hub auth cache epoch')
  return `${cacheIdentityKey(identity)}\0generation:${identity.profileGeneration}\0${JSON.stringify(sidecarFor(identity, attachment))}`
}

function requireMatchingAttachment(identity: TeamAttachmentCacheIdentity, attachment: TeamAttachment): void {
  if (attachment.id !== identity.attachmentId || attachment.team_id !== identity.teamId) {
    throw new Error('Team Hub returned a mismatched attachment.')
  }
}

function sidecarFor(identity: TeamAttachmentCacheIdentity, attachment: TeamAttachment): CacheSidecar {
  return {
    version: 5,
    profile_id: identity.profileId,
    server_identity: identity.serverIdentity,
    auth_generation: identity.authGeneration,
    auth_cache_epoch: identity.authCacheEpoch,
    hub_id: identity.hubId,
    team_id: identity.teamId,
    attachment_id: identity.attachmentId,
    file_name: attachment.file_name,
    media_type: attachment.media_type,
    byte_size: attachment.byte_size,
    sha256: attachment.sha256
  }
}

function parseSidecar(value: unknown): CacheSidecar {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Team cache metadata.')
  const item = value as Record<string, unknown>
  const keys = [
    'version', 'profile_id', 'server_identity', 'auth_generation', 'auth_cache_epoch', 'hub_id', 'team_id',
    'attachment_id', 'file_name', 'media_type', 'byte_size', 'sha256'
  ]
  if (Object.keys(item).length !== keys.length || keys.some(key => !(key in item))) {
    throw new Error('Invalid Team cache metadata.')
  }
  if (
    item.version !== 5
    || typeof item.profile_id !== 'string'
    || typeof item.server_identity !== 'string'
    || typeof item.auth_generation !== 'number'
    || !Number.isSafeInteger(item.auth_generation)
    || item.auth_generation < 0
    || typeof item.auth_cache_epoch !== 'string'
    || !item.auth_cache_epoch
    || typeof item.hub_id !== 'string'
    || typeof item.team_id !== 'string'
    || typeof item.attachment_id !== 'string'
    || typeof item.file_name !== 'string'
    || !item.file_name
    || item.file_name === '.'
    || item.file_name === '..'
    || item.file_name.includes('/')
    || item.file_name.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(item.file_name)
    || Buffer.byteLength(item.file_name, 'utf8') > 255
    || typeof item.media_type !== 'string'
    || typeof item.byte_size !== 'number'
    || !Number.isSafeInteger(item.byte_size)
    || item.byte_size < 1
    || typeof item.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(item.sha256)
  ) throw new Error('Invalid Team cache metadata.')
  return item as unknown as CacheSidecar
}

function sameCacheIdentity(sidecar: CacheSidecar, identity: TeamAttachmentCacheIdentity): boolean {
  return sidecar.profile_id === identity.profileId
    && sidecar.server_identity === identity.serverIdentity
    && sidecar.auth_generation === identity.authGeneration
    && sidecar.auth_cache_epoch === identity.authCacheEpoch
    && sidecar.hub_id === identity.hubId
    && sidecar.team_id === identity.teamId
    && sidecar.attachment_id === identity.attachmentId
}

function sameSidecar(left: CacheSidecar, right: CacheSidecar): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function fileSignature(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}

async function sha256FileHandle(handle: FileHandle, size: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, size))
  let offset = 0
  while (offset < size) {
    signal?.throwIfAborted()
    const length = Math.min(buffer.length, size - offset)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    if (bytesRead !== length) throw new Error('Cached attachment changed during verification.')
    hash.update(buffer.subarray(0, bytesRead))
    offset += bytesRead
  }
  return hash.digest('hex')
}

function fileHandleResponseStream(
  handle: FileHandle,
  start: number,
  end: number,
  signal: AbortSignal
): ReadableStream<Uint8Array> {
  let position = start
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let terminal = false
  const close = async () => {
    signal.removeEventListener('abort', abort)
    await handle.close().catch(() => undefined)
  }
  const fail = (error: unknown) => {
    if (terminal) return
    terminal = true
    void close()
    try { controller?.error(error) } catch { /* stream already cancelled */ }
  }
  const abort = () => fail(signal.reason ?? new Error('The Team attachment cache profile was purged.'))
  return new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    },
    async pull(nextController) {
      if (terminal) return
      try {
        signal.throwIfAborted()
        const length = Math.min(64 * 1024, end - position + 1)
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(buffer, 0, length, position)
        signal.throwIfAborted()
        if (bytesRead !== length) throw new Error('Cached attachment changed while it was being read.')
        position += bytesRead
        nextController.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead))
        if (position > end) {
          terminal = true
          await close()
          nextController.close()
        }
      } catch (error) {
        fail(error)
      }
    },
    async cancel() {
      if (terminal) return
      terminal = true
      await close()
    }
  }, { highWaterMark: 0 })
}

async function readExactResponseBytes(
  response: Response,
  expectedLength: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const rawLength = response.headers.get('Content-Length')
  if (rawLength === null || !/^\d+$/.test(rawLength) || Number(rawLength) !== expectedLength) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Team Hub returned a mismatched attachment chunk length.')
  }
  if (!response.body) throw new Error('Team Hub returned an empty attachment chunk.')
  const result = new Uint8Array(expectedLength)
  const reader = response.body.getReader()
  const cancelForAbort = () => { void reader.cancel(signal?.reason).catch(() => undefined) }
  if (signal?.aborted) cancelForAbort()
  else signal?.addEventListener('abort', cancelForAbort, { once: true })
  let offset = 0
  try {
    while (true) {
      const item = await reader.read()
      signal?.throwIfAborted()
      if (item.done) break
      if (item.value.byteLength > expectedLength - offset) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Team Hub returned an oversized attachment chunk.')
      }
      result.set(item.value, offset)
      offset += item.value.byteLength
    }
  } finally {
    signal?.removeEventListener('abort', cancelForAbort)
    reader.releaseLock()
  }
  if (offset !== expectedLength) throw new Error('Team Hub returned a truncated attachment chunk.')
  return result
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    if (bytesWritten < 1) throw new Error('Could not write the Team attachment cache.')
    offset += bytesWritten
  }
}

async function atomicWriteJSON(path: string, value: CacheSidecar): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}

async function readSidecarFile(path: string): Promise<CacheSidecar> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 2 || before.size > 4_096) throw new Error('Invalid Team cache metadata.')
    const bytes = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead < 1) throw new Error('Invalid Team cache metadata.')
      offset += bytesRead
    }
    const after = await handle.stat()
    if (fileSignature(after) !== fileSignature(before)) throw new Error('Invalid Team cache metadata.')
    return parseSidecar(JSON.parse(bytes.toString('utf8')))
  } finally {
    await handle.close()
  }
}

async function collectEntries(root: string, cleanInvalid = false): Promise<CacheEntry[]> {
  const result: CacheEntry[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    let children
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
    if (depth === CACHE_IDENTITY_DEPTH) {
      try {
        const sidecar = await readSidecarFile(join(directory, SIDECAR_NAME))
        const file = join(directory, PAYLOAD_NAME)
        const info = await lstat(file)
        if (!info.isFile() || info.isSymbolicLink() || info.size !== sidecar.byte_size) {
          throw new Error('Invalid Team cache entry.')
        }
        const unexpected = children.filter(child => child.name !== SIDECAR_NAME && child.name !== PAYLOAD_NAME)
        if (unexpected.length > 0) {
          if (!cleanInvalid) throw new Error('Invalid Team cache entry.')
          for (const child of unexpected) {
            await rm(join(directory, child.name), { recursive: true, force: true })
          }
        }
        result.push({
          directory,
          file,
          sidecar,
          signature: fileSignature(info),
          lastAccess: info.atimeMs || info.mtimeMs
        })
        return
      } catch (error) {
        if (!cleanInvalid) return
        if (!await removeCacheDirectory(directory)) throw error
        return
      }
    }
    for (const child of children) {
      const path = join(directory, child.name)
      if (child.isDirectory() && !child.isSymbolicLink()) await visit(path, depth + 1)
      else if (cleanInvalid) await rm(path, { recursive: true, force: true })
    }
  }
  await visit(root, 0)
  return result
}

async function removeCacheDirectory(directory: string): Promise<boolean> {
  try {
    await rm(directory, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function parseByteRange(value: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return 'invalid'
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix < 1) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= size
    || requestedEnd < start
  ) return 'invalid'
  return { start, end: Math.min(requestedEnd, size - 1) }
}
