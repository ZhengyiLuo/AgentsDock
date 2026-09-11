import type { AgentFile } from '@shared/types'
import { useAppStore } from '../store/app-store'

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
    .trim()
}
