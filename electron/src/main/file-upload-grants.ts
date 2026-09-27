import { closeSync, constants as fsConstants, fstatSync, openSync, realpathSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export interface FileUploadGrantScope {
  profileId: string
  profileGeneration: number
  rendererId: number
}

export interface AdmittedUploadFile {
  readonly requestedPath: string
  readonly canonicalPath: string
  readonly fd: number
  readonly byteSize: number
  close(): void
}

export interface FileUploadGrantRegistryOptions {
  now?: () => number
  ttlMs?: number
  maxEntries?: number
  maxAdmissions?: number
  realpath?: (path: string) => string
  isRegularFile?: (path: string) => boolean
}

interface FileUploadGrant extends FileUploadGrantScope {
  readonly selectionId: string
  readonly requestedPath: string
  readonly canonicalPath: string
  readonly device: number
  readonly inode: number
  readonly byteSize: number
  readonly expiresAt: number
  sessionId: string | null
  declarationId: string | null
  declarationPending: boolean
  admissions: number
  cleanup: (() => void) | null
  cleanupTimer: ReturnType<typeof setTimeout> | null
  activeAdmissions: Set<AdmittedUploadFile>
}

const DEFAULT_TTL_MS = 15 * 60_000
const DEFAULT_MAX_ENTRIES = 512
const DEFAULT_MAX_ADMISSIONS = 4
const MAX_PATH_CHARS = 4_096

/**
 * Main-process ownership for native file paths returned to the renderer.
 *
 * The renderer may only upload an exact path which came from a successful
 * chooser/staging operation. The first admission binds that capability to one
 * chat; a small retry allowance preserves upload retry UX without letting the
 * path capability cross renderer, profile generation, or chat boundaries.
 */
export class FileUploadGrantRegistry {
  private readonly grants = new Map<string, FileUploadGrant>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly maxAdmissions: number
  private readonly realpath: (path: string) => string
  private readonly isRegularFile: (path: string) => boolean

  constructor(options: FileUploadGrantRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS)
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES)
    this.maxAdmissions = positiveInteger(options.maxAdmissions, DEFAULT_MAX_ADMISSIONS)
    this.realpath = options.realpath ?? realpathSync
    this.isRegularFile = options.isRegularFile ?? (path => statSync(path).isFile())
  }

  register(paths: readonly string[], scope: FileUploadGrantScope, replaceExisting = true): void {
    const now = this.now()
    this.prune(now)
    if (paths.length > this.maxEntries) throw new Error('Too many files were selected for upload.')
    const uniquePaths = [...new Set(paths.map(exactPath))]
    if (!uniquePaths.length) return

    // Resolve and validate the complete batch before publishing any grant.
    const resolved = uniquePaths.map(requestedPath => ({
      requestedPath: exactPath(requestedPath),
      ...this.canonicalRegularFile(requestedPath)
    }))
    const newKeys = resolved.filter(item => !this.grants.has(item.requestedPath)).length
    this.evictOldest(Math.max(0, this.grants.size + newKeys - this.maxEntries))
    const expiresAt = now + this.ttlMs
    for (const item of resolved) {
      if (!replaceExisting && this.grants.has(item.requestedPath)) continue
      const previous = this.grants.get(item.requestedPath)
      if (previous) this.releaseGrant(item.requestedPath, previous)
      this.grants.set(item.requestedPath, {
        ...scope,
        ...item,
        selectionId: randomUUID(),
        expiresAt,
        sessionId: null,
        declarationId: null,
        declarationPending: false,
        admissions: 0,
        cleanup: null,
        cleanupTimer: null,
        activeAdmissions: new Set()
      })
    }
  }

  registerFreshSelection(paths: readonly string[], scope: FileUploadGrantScope): void {
    const now = this.now()
    this.prune(now)
    if (paths.length > this.maxEntries) throw new Error('Too many files were selected for upload.')
    const uniquePaths = [...new Set(paths.map(exactPath))]
    if (!uniquePaths.length) return

    // Resolve the complete selection and prove every previous grant is idle
    // before replacing any of them. A new trusted chooser/drop gesture may
    // move a file capability to another chat, but it must never interrupt an
    // upload or replace a private managed staging file in flight.
    const resolved = uniquePaths.map(requestedPath => ({
      requestedPath: exactPath(requestedPath),
      ...this.canonicalRegularFile(requestedPath)
    }))
    for (const item of resolved) {
      const previous = this.grants.get(item.requestedPath)
      if (
        previous
        && (
          previous.activeAdmissions.size > 0
          || previous.declarationPending
          || previous.declarationId !== null
          || previous.cleanup !== null
        )
      ) throw new Error('Wait for this file to finish uploading before choosing it again.')
    }

    const newKeys = resolved.filter(item => !this.grants.has(item.requestedPath)).length
    const evictionCount = Math.max(0, this.grants.size + newKeys - this.maxEntries)
    const selectedPaths = new Set(resolved.map(item => item.requestedPath))
    const evictionCandidates = [...this.grants.values()]
      .filter(grant => !selectedPaths.has(grant.requestedPath) && freshSelectionMayReplace(grant))
      .sort((left, right) => left.expiresAt - right.expiresAt)
      .slice(0, evictionCount)
    if (evictionCandidates.length < evictionCount) {
      throw new Error('Wait for current file uploads to finish before choosing more files.')
    }
    for (const grant of evictionCandidates) this.releaseGrant(grant.requestedPath, grant)
    const expiresAt = now + this.ttlMs
    for (const item of resolved) {
      const previous = this.grants.get(item.requestedPath)
      if (previous) this.releaseGrant(item.requestedPath, previous)
      this.grants.set(item.requestedPath, {
        ...scope,
        ...item,
        selectionId: randomUUID(),
        expiresAt,
        sessionId: null,
        declarationId: null,
        declarationPending: false,
        admissions: 0,
        cleanup: null,
        cleanupTimer: null,
        activeAdmissions: new Set()
      })
    }
  }

  captureAdmission(
    paths: readonly string[],
    scope: FileUploadGrantScope,
    sessionIdValue: string
  ): string[] {
    const now = this.now()
    this.prune(now)
    if (paths.length > this.maxEntries) throw new Error('Too many files were selected for upload.')
    const sessionId = exactSessionId(sessionIdValue)
    if (!paths.length) throw new Error('Choose at least one file to upload.')
    const boundedPaths = paths.map(exactPath)
    if (new Set(boundedPaths).size !== boundedPaths.length) throw new Error('The same file cannot be attached twice in one upload.')
    return boundedPaths.map(requestedPath => {
      const grant = this.grants.get(requestedPath)
      if (
        !grant
        || !sameScope(grant, scope)
        || (grant.sessionId !== null && grant.sessionId !== sessionId)
        || grant.admissions >= this.maxAdmissions
      ) throw unauthorizedPathError()
      return grant.selectionId
    })
  }

  registerManaged(path: string, scope: FileUploadGrantScope, cleanup: () => void): void {
    this.register([path], scope)
    const requestedPath = exactPath(path)
    const grant = this.grants.get(requestedPath)
    if (!grant) throw new Error('The staged file grant could not be created.')
    grant.cleanup = cleanup
    const delay = Math.max(0, grant.expiresAt - this.now())
    grant.cleanupTimer = setTimeout(() => this.releaseGrant(requestedPath, grant), delay)
    grant.cleanupTimer.unref?.()
  }

  admit(
    paths: readonly string[],
    scope: FileUploadGrantScope,
    sessionIdValue: string,
    declarationIdValue?: string,
    expectedSelectionIds?: readonly string[]
  ): AdmittedUploadFile[] {
    const now = this.now()
    this.prune(now)
    if (paths.length > this.maxEntries) throw new Error('Too many files were selected for upload.')
    const sessionId = exactSessionId(sessionIdValue)
    const declarationId = declarationIdValue === undefined ? undefined : exactSessionId(declarationIdValue)
    if (!paths.length) throw new Error('Choose at least one file to upload.')
    const boundedPaths = paths.map(exactPath)
    if (new Set(boundedPaths).size !== boundedPaths.length) throw new Error('The same file cannot be attached twice in one upload.')
    if (expectedSelectionIds && expectedSelectionIds.length !== boundedPaths.length) throw unauthorizedPathError()

    // Validate the whole batch first. Mutation happens only after every path
    // is proven, so two competing chat admissions cannot split a grant batch.
    const candidates: Array<{ grant: FileUploadGrant; admitted: AdmittedUploadFile }> = []
    try {
      for (const [index, requestedPath] of boundedPaths.entries()) {
        const grant = this.grants.get(requestedPath)
        if (!grant) throw unauthorizedPathError()
        if (
          grant.profileId !== scope.profileId
          || grant.profileGeneration !== scope.profileGeneration
          || grant.rendererId !== scope.rendererId
          || (grant.sessionId !== null && grant.sessionId !== sessionId)
          || (declarationId !== undefined && grant.declarationId !== declarationId)
          || (expectedSelectionIds !== undefined && grant.selectionId !== expectedSelectionIds[index])
          || grant.admissions >= this.maxAdmissions
        ) throw unauthorizedPathError()
        const canonicalPath = this.realpath(requestedPath)
        if (canonicalPath !== grant.canonicalPath) throw unauthorizedPathError()
        const fd = openSync(canonicalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
        let closed = false
        try {
          const info = fstatSync(fd)
          if (
            !info.isFile()
            || info.dev !== grant.device
            || info.ino !== grant.inode
            || info.size !== grant.byteSize
          ) throw unauthorizedPathError()
          const admitted: AdmittedUploadFile = {
            requestedPath,
            canonicalPath,
            fd,
            byteSize: info.size,
            close: () => {
              if (closed) return
              closed = true
              grant.activeAdmissions.delete(admitted)
              try { closeSync(fd) } catch { /* already closed by teardown */ }
            }
          }
          candidates.push({ grant, admitted })
        } catch (error) {
          if (!closed) {
            closed = true
            try { closeSync(fd) } catch { /* best effort */ }
          }
          throw error
        }
      }
    } catch {
      for (const candidate of candidates) candidate.admitted.close()
      throw unauthorizedPathError()
    }

    for (const { grant } of candidates) {
      grant.sessionId = sessionId
      grant.admissions += 1
    }
    for (const { grant, admitted } of candidates) grant.activeAdmissions.add(admitted)
    return candidates.map(candidate => candidate.admitted)
  }

  reserveDeclaration(path: string, scope: FileUploadGrantScope, sessionId: string): AdmittedUploadFile {
    const requestedPath = exactPath(path)
    const grant = this.grants.get(requestedPath)
    if (!grant || grant.declarationPending) throw unauthorizedPathError()
    const admitted = this.admit([requestedPath], scope, sessionId)[0]
    const current = this.grants.get(requestedPath)
    if (current !== grant || current.declarationPending) {
      admitted.close()
      throw unauthorizedPathError()
    }
    current.declarationPending = true
    return admitted
  }

  bindDeclaration(
    pathValue: string,
    scope: FileUploadGrantScope,
    sessionIdValue: string,
    declarationIdValue: string
  ): void {
    const requestedPath = exactPath(pathValue)
    const sessionId = exactSessionId(sessionIdValue)
    const declarationId = exactSessionId(declarationIdValue)
    const grant = this.grants.get(requestedPath)
    if (
      !grant
      || !sameScope(grant, scope)
      || grant.sessionId !== sessionId
      || grant.admissions < 1
      || !grant.declarationPending
    ) throw unauthorizedPathError()
    grant.declarationId = declarationId
    grant.declarationPending = false
  }

  abandonDeclaration(pathValue: string, scope: FileUploadGrantScope, sessionIdValue: string): void {
    const requestedPath = exactPath(pathValue)
    const sessionId = exactSessionId(sessionIdValue)
    const grant = this.grants.get(requestedPath)
    if (!grant || !sameScope(grant, scope) || grant.sessionId !== sessionId) return
    grant.declarationPending = false
  }

  releaseManaged(pathValue: string, scope: FileUploadGrantScope): void {
    const requestedPath = exactPath(pathValue)
    const grant = this.grants.get(requestedPath)
    if (!grant || !grant.cleanup || !sameScope(grant, scope)) return
    this.releaseGrant(requestedPath, grant)
  }

  releaseManagedIfExhausted(pathValue: string, scope: FileUploadGrantScope): void {
    const requestedPath = exactPath(pathValue)
    const grant = this.grants.get(requestedPath)
    if (!grant || !grant.cleanup || !sameScope(grant, scope) || grant.admissions < this.maxAdmissions) return
    this.releaseGrant(requestedPath, grant)
  }

  revokeRenderer(rendererId: number): void {
    for (const [path, grant] of this.grants) {
      if (grant.rendererId === rendererId) this.releaseGrant(path, grant)
    }
  }

  clear(): void {
    for (const [path, grant] of this.grants) this.releaseGrant(path, grant)
  }

  private canonicalRegularFile(pathValue: string): {
    canonicalPath: string
    device: number
    inode: number
    byteSize: number
  } {
    const path = exactPath(pathValue)
    let canonicalPath: string
    try {
      canonicalPath = this.realpath(path)
      if (!this.isRegularFile(canonicalPath)) throw new Error('not a regular file')
      const info = statSync(canonicalPath)
      if (!info.isFile()) throw new Error('not a regular file')
      return {
        canonicalPath,
        device: info.dev,
        inode: info.ino,
        byteSize: info.size
      }
    } catch {
      throw new Error('Only existing regular files can be attached.')
    }
  }

  private prune(now: number): void {
    for (const [path, grant] of this.grants) {
      if (grant.expiresAt <= now) this.releaseGrant(path, grant)
    }
  }

  private evictOldest(count: number): void {
    if (count <= 0) return
    const oldest = [...this.grants.values()]
      .sort((left, right) => left.expiresAt - right.expiresAt)
      .slice(0, count)
    for (const grant of oldest) this.releaseGrant(grant.requestedPath, grant)
  }

  private releaseGrant(path: string, grant: FileUploadGrant): void {
    if (this.grants.get(path) !== grant) return
    this.grants.delete(path)
    if (grant.cleanupTimer) clearTimeout(grant.cleanupTimer)
    grant.cleanupTimer = null
    for (const admitted of [...grant.activeAdmissions]) admitted.close()
    grant.activeAdmissions.clear()
    try { grant.cleanup?.() } catch { /* best-effort cleanup of a private staged file */ }
    grant.cleanup = null
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback
}

function exactPath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_CHARS || value.includes('\0')) throw unauthorizedPathError()
  return value
}

function sameScope(grant: FileUploadGrantScope, scope: FileUploadGrantScope): boolean {
  return grant.profileId === scope.profileId
    && grant.profileGeneration === scope.profileGeneration
    && grant.rendererId === scope.rendererId
}

function freshSelectionMayReplace(grant: FileUploadGrant): boolean {
  return grant.activeAdmissions.size === 0
    && !grant.declarationPending
    && grant.declarationId === null
    && grant.cleanup === null
}

function exactSessionId(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('The upload chat identifier is invalid.')
  }
  return value
}

function unauthorizedPathError(): Error {
  return new Error('Choose this file again before uploading it.')
}
