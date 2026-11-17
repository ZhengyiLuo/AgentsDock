import type { AgentFile } from '@shared/types'
import { t } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { trackOperation } from './analytics'

/** Preserve the native request/error contract; report no file metadata. */
export function requestNativeFileOpen(sessionId: string, file: AgentFile): Promise<void> {
  return trackOperation('file_open_requested', () => window.agentsDock.files.open(sessionId, file), undefined, { origin: 'artifact' })
}

export function openAgentFile(sessionId: string, file: AgentFile): Promise<boolean> {
  return openFileWithFeedback(file.title || file.filename, () => requestNativeFileOpen(sessionId, file))
}

export function openLinkedFile(sessionId: string, target: string): Promise<boolean> {
  const filename = target.replace(/\\/g, '/').split('/').at(-1) || target
  return openFileWithFeedback(filename, () => trackOperation('file_open_requested', () => window.agentsDock.files.openLinked(sessionId, target), undefined, { origin: 'linked_file' }))
}

async function openFileWithFeedback(filename: string, open: () => Promise<void>): Promise<boolean> {
  const origin = useAppStore.getState()
  try {
    await open()
    return true
  } catch (error) {
    const current = useAppStore.getState()
    // A late failure belongs to the original view, not a newly selected chat/server.
    if (current.activeProfileId !== origin.activeProfileId
      || current.profileGeneration !== origin.profileGeneration
      || current.selectedSessionId !== origin.selectedSessionId
      || current.switchingProfileId) return false
    const reason = cleanIPCError(error instanceof Error ? error.message : String(error))
    const detail = /^Linked file failed: 404$/.test(reason)
      ? t('files.linkUnavailable')
      : reason
    current.setError(t('files.openFailed', { filename, reason: detail }))
    return false
  }
}

export async function saveAgentFile(sessionId: string, file: AgentFile): Promise<string | null> {
  try {
    return await window.agentsDock.files.save(sessionId, file)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    useAppStore.getState().setError(`Could not download "${file.title || file.filename}": ${cleanIPCError(reason)}`)
    return null
  }
}

function cleanIPCError(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .replace(/^Native file open failed:\s*/i, '')
    .trim()
}
