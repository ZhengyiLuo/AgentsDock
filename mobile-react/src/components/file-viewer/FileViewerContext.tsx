import { createContext, useContext } from 'react'
import type { AgentFile } from '../../types'

export type FileViewerRequest = ArtifactFileViewerRequest | WorkspaceFileViewerRequest

export interface ArtifactFileViewerRequest {
  kind: 'artifacts'
  sessionId: string
  files: AgentFile[]
  initialId: string
  ownerKey: string
}

export interface WorkspaceFileViewerRequest {
  kind: 'workspace'
  sessionId: string
}

export interface FileViewerController {
  viewerActive: boolean
  openArtifacts: (request: Omit<ArtifactFileViewerRequest, 'kind'>) => void
  openWorkspace: (sessionId: string) => void
  closeViewer: () => void
  setPresentationBlocked: (blocked: boolean) => void
}

export const FileViewerContext = createContext<FileViewerController | null>(null)

export function useFileViewer(): FileViewerController {
  const value = useContext(FileViewerContext)
  if (!value) throw new Error('File viewer context is unavailable')
  return value
}
