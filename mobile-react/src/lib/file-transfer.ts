import type { AgentFile, WorkspaceEntry } from '../types'
import type { AgentServerClient } from '../api/AgentServerClient'
import { inferredMobileFileContentType } from './file-viewer'

export type FileTransferAction = 'download' | 'share'
export type FileTransferPhase = 'choosing' | 'downloading' | 'saving' | 'sharing' | 'done' | 'cancelled' | 'error'
export interface FileTransferState {
  phase: FileTransferPhase
  filename: string
  bytesWritten?: number
  totalBytes?: number
  message?: string
}
export interface FileTransferRequest {
  action: FileTransferAction
  filename: string
  title: string
  contentType: string
  expectedBytes?: number | null
  source: () => { url: string; headers: Record<string, string> }
  isCurrent: () => boolean
}
interface TransferFile { uri: string; exists: boolean; size: number | null }
export interface FileTransferDependencies<Folder, File extends TransferFile> {
  pickDirectory: () => Promise<Folder>
  sharingAvailable: () => Promise<boolean>
  createTemporaryFile: (filename: string) => Promise<File>
  download: (source: ReturnType<FileTransferRequest['source']>, file: File, signal: AbortSignal, onProgress: (progress: { bytesWritten: number; totalBytes: number }) => void) => Promise<File>
  save: (file: File, folder: Folder, filename: string) => Promise<string>
  share: (file: File, request: FileTransferRequest) => Promise<void>
  removeTemporaryFile: (file: File) => Promise<void>
}

// One transfer owns the native picker/share presentation at a time, even when
// the same file is reachable from both an inspector and a timeline.
export function createFileTransferRunner<Folder, File extends TransferFile>(dependencies: FileTransferDependencies<Folder, File>) {
  let active = false
  return async (request: FileTransferRequest, signal: AbortSignal, update: (state: FileTransferState) => void): Promise<void> => {
    if (active) throw new Error('Another file is being saved or shared. Finish or cancel that transfer first.')
    if (!request.isCurrent() || signal.aborted) return
    active = true
    let temporary: File | undefined
    let shared = false
    const filename = safeDownloadFilename(request.filename)
    const checkCurrent = () => {
      if (signal.aborted || !request.isCurrent()) throw new FileTransferCancelled()
    }
    const report = (phase: FileTransferPhase, detail: Partial<FileTransferState> = {}) => {
      checkCurrent()
      update({ phase, filename, ...detail })
    }
    try {
      let folder: Folder | undefined
      if (request.action === 'download') {
        report('choosing')
        folder = await dependencies.pickDirectory()
      } else {
        report('downloading', { bytesWritten: 0, totalBytes: validByteCount(request.expectedBytes) })
        if (!await dependencies.sharingAvailable()) throw new Error('File sharing is unavailable on this device. Use Download to choose a folder instead.')
      }
      checkCurrent()
      // Resolve credentials only after the picker returns and this chat is
      // still current. Server file paths are never treated as device paths.
      const source = request.source()
      temporary = await dependencies.createTemporaryFile(filename)
      checkCurrent()
      report('downloading', { bytesWritten: 0, totalBytes: validByteCount(request.expectedBytes) })
      const downloaded = await dependencies.download(source, temporary, signal, progress => {
        if (!signal.aborted && request.isCurrent()) {
          const totalBytes = validByteCount(progress.totalBytes) ?? validByteCount(request.expectedBytes)
          const bytesWritten = Math.max(0, validByteCount(progress.bytesWritten) ?? 0)
          update({ phase: 'downloading', filename, bytesWritten, totalBytes })
        }
      })
      checkCurrent()
      if (!downloaded.exists || downloaded.size == null) throw new Error('The downloaded file is unavailable. Please try again.')
      const expected = validByteCount(request.expectedBytes)
      if (expected != null && downloaded.size !== expected) throw new Error('The file changed or the download was incomplete. Refresh the file list and try again.')
      if (request.action === 'download') {
        report('saving')
        const savedName = await dependencies.save(downloaded, folder as Folder, filename)
        report('done', { message: `Saved ${savedName} to the selected folder.` })
      } else {
        report('sharing')
        await dependencies.share(downloaded, request)
        // Android can resolve when a recipient is chosen, before that app has
        // read the content URI. The adapter expires shared files after 24h.
        shared = true
        report('done', { message: 'Share sheet closed.' })
      }
    } catch (cause) {
      if (!request.isCurrent()) return
      if (signal.aborted || isFileTransferCancellation(cause)) {
        update({ phase: 'cancelled', filename, message: 'Download cancelled.' })
        return
      }
      throw cause
    } finally {
      try {
        if (temporary && !shared) await dependencies.removeTemporaryFile(temporary)
      } finally {
        active = false
      }
    }
  }
}

export function artifactTransferRequest(file: AgentFile, sessionId: string, client: AgentServerClient, action: FileTransferAction, isCurrent: () => boolean): FileTransferRequest {
  return {
    action, filename: file.filename, title: file.title?.trim() || file.filename,
    contentType: file.content_type?.trim() || inferredMobileFileContentType(file.filename),
    expectedBytes: file.size,
    isCurrent,
    source: () => {
      if (!file.id.trim() || file.id !== file.id.trim()) throw new Error('The file identity is invalid.')
      if (file.session_id && file.session_id !== sessionId) throw new Error('This file belongs to another chat.')
      return { url: client.fileURL(sessionId, file.id), headers: client.authHeaders() }
    },
  }
}

export function workspaceTransferRequest(entry: WorkspaceEntry, sessionId: string, client: AgentServerClient, action: FileTransferAction, isCurrent: () => boolean): FileTransferRequest {
  return {
    action, filename: entry.name, title: entry.name, contentType: inferredMobileFileContentType(entry.name),
    // Workspace files are mutable. Download the current complete version; the
    // browser's earlier size is not authoritative for this response.
    isCurrent,
    source: () => {
      if (entry.kind !== 'file') throw new Error('Select a regular file to download.')
      return { url: client.workspaceDownloadURL(sessionId, entry.path), headers: client.authHeaders() }
    },
  }
}

export function safeDownloadFilename(value: string): string {
  const leaf = value.replace(/\\/g, '/').split('/').at(-1) ?? ''
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim() || 'download'
  const extension = /\.[a-zA-Z0-9]{1,16}$/.exec(cleaned)?.[0] ?? ''
  let stem = extension ? cleaned.slice(0, -extension.length) : cleaned
  // Leave room for numbered collisions, including multibyte filenames.
  while (new TextEncoder().encode(stem + extension).length > 180) stem = Array.from(stem).slice(0, -1).join('')
  return (stem || 'download') + extension
}

export function numberedDownloadFilename(filename: string, attempt: number): string {
  if (!attempt) return filename
  const extension = /\.[a-zA-Z0-9]{1,16}$/.exec(filename)?.[0] ?? ''
  return `${extension ? filename.slice(0, -extension.length) : filename} (${attempt})${extension}`
}

export function isFileTransferBusy(state: FileTransferState | null): boolean {
  return Boolean(state && ['choosing', 'downloading', 'saving', 'sharing'].includes(state.phase))
}

export function isFileTransferCancellation(cause: unknown): boolean {
  const error = cause as { name?: string; code?: string; message?: string } | null
  return error?.name === 'AbortError' || error?.name === 'FileTransferCancelled'
    || /(?:PICKING|PICKER)_CANCELLED/i.test(error?.code ?? '')
    || /(?:file|directory) picking was cancel(?:led|ed) by the user/i.test(error?.message ?? '')
}

class FileTransferCancelled extends Error { constructor() { super('Download cancelled.'); this.name = 'FileTransferCancelled' } }
function validByteCount(value: number | null | undefined): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined }
