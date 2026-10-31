import type { WorkspaceFile, WorkspaceProfileScope, WorkspaceSearchPage } from './types'

export const CODE_INTELLIGENCE_PROTOCOL = 'agentsdock-intelligence-v1'
export type CodeIntelligenceLanguage = 'python' | 'typescript'

export interface CodeIntelligenceStatus {
  root: string
  root_uri: string
  languages: Array<{
    id: CodeIntelligenceLanguage
    available: boolean
    message?: string
    install_hint?: string
  }>
}

export interface CodeIntelligenceEvent {
  profileId: string
  profileGeneration: number
  sessionId: string
  connectionId: string
  type: 'message' | 'closed' | 'error'
  message?: string
}

export interface CodeIntelligenceAPI {
  read(scope: WorkspaceProfileScope, sessionId: string, path: string): Promise<WorkspaceFile>
  files(scope: WorkspaceProfileScope, sessionId: string, query?: string, limit?: number): Promise<WorkspaceSearchPage>
  status(scope: WorkspaceProfileScope, sessionId: string): Promise<CodeIntelligenceStatus>
  connect(scope: WorkspaceProfileScope, sessionId: string, connectionId: string, language: CodeIntelligenceLanguage): Promise<void>
  send(scope: WorkspaceProfileScope, sessionId: string, connectionId: string, message: string): void
  disconnect(scope: WorkspaceProfileScope, sessionId: string, connectionId: string): Promise<void>
  onEvent(listener: (event: CodeIntelligenceEvent) => void): () => void
}

export function codeIntelligenceLanguage(value: unknown): CodeIntelligenceLanguage {
  if (value !== 'python' && value !== 'typescript') throw new Error('Unsupported code language.')
  return value
}

export function parseCodeIntelligenceStatus(value: unknown): CodeIntelligenceStatus {
  const item = value as CodeIntelligenceStatus | null
  if (!item || typeof item.root !== 'string' || typeof item.root_uri !== 'string'
    || !Array.isArray(item.languages) || !item.languages.every(language => language
      && ['python', 'typescript'].includes(language.id) && typeof language.available === 'boolean'
      && (language.message === undefined || typeof language.message === 'string')
      && (language.install_hint === undefined || typeof language.install_hint === 'string'))) {
    throw new Error('The server returned an invalid code intelligence status.')
  }
  return item
}
