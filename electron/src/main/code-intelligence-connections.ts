import { CODE_INTELLIGENCE_PROTOCOL, codeIntelligenceLanguage, type CodeIntelligenceEvent, type CodeIntelligenceLanguage } from '../shared/code-intelligence'
import type { WorkspaceProfileScope } from '../shared/types'

interface Connection {
  owner: number
  scope: WorkspaceProfileScope
  sessionId: string
  connectionId: string
  socket: WebSocket | null
  notify: (event: CodeIntelligenceEvent) => void
  reject: (error: Error) => void
}

/** Each renderer/editor owns only its language socket. No agent transport is touched. */
export class CodeIntelligenceConnections {
  private readonly connections = new Map<string, Connection>()

  async connect(owner: number, scope: WorkspaceProfileScope, sessionId: string, connectionId: string,
    language: CodeIntelligenceLanguage, open: () => Promise<WebSocket>, notify: Connection['notify']): Promise<void> {
    const key = this.key(owner, connectionId)
    if (!scope || typeof scope.profileId !== 'string' || !scope.profileId
      || !Number.isSafeInteger(scope.profileGeneration) || typeof sessionId !== 'string' || !sessionId) {
      throw new Error('The code editor is missing its chat or server.')
    }
    codeIntelligenceLanguage(language)
    if (this.connections.has(key)) throw new Error('This code intelligence connection is already open.')
    let resolve!: () => void
    let reject!: (error: Error) => void
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    const connection: Connection = { owner, scope: { ...scope }, sessionId, connectionId, socket: null, notify, reject }
    this.connections.set(key, connection)
    const current = (): boolean => this.connections.get(key) === connection
    const emit = (type: CodeIntelligenceEvent['type'], message?: string): void => {
      notify({ profileId: scope.profileId, profileGeneration: scope.profileGeneration,
        sessionId, connectionId, type, ...(message ? { message } : {}) })
    }
    // Start separately so a close during health validation can settle immediately.
    void (async () => {
      try {
        const socket = await open()
        if (!current()) { socket.close(1000, 'Code editor closed'); return }
        connection.socket = socket
        const fail = (message: string): void => {
          if (!current()) return
          emit('error', message)
          this.close(key, message)
        }
        const opened = (): void => {
          if (!current()) return
          if (socket.protocol !== CODE_INTELLIGENCE_PROTOCOL) return fail('The server did not accept the code intelligence protocol.')
          resolve()
        }
        socket.addEventListener('open', opened)
        socket.addEventListener('message', event => {
          if (!current()) return
          if (typeof event.data !== 'string') return fail('The language server returned a non-text message.')
          try {
            const packet = JSON.parse(event.data)
            if (packet?.type === 'intelligence_error') return fail(String(packet.message || 'Code intelligence stopped.'))
            emit('message', event.data)
          } catch { fail('The language server returned an invalid message.') }
        })
        socket.addEventListener('error', () => fail('Could not connect to code intelligence on this server.'))
        socket.addEventListener('close', event => {
          if (!current()) return
          this.connections.delete(key)
          const message = event.reason || 'Code intelligence disconnected.'
          reject(new Error(message))
          emit('closed', message)
        })
        if (socket.readyState === 1) opened()
        else if (socket.readyState >= 2) fail('Code intelligence disconnected before connecting.')
      } catch (error) {
        if (!current()) return
        const message = error instanceof Error ? error.message : 'Code intelligence could not start.'
        emit('error', message)
        this.close(key, message)
      }
    })()
    return ready
  }

  send(owner: number, scope: WorkspaceProfileScope, sessionId: string, connectionId: string, message: string): void {
    const key = this.key(owner, connectionId)
    const connection = this.match(key, scope, sessionId)
    if (!connection) return
    try {
      if (typeof message !== 'string') throw new Error('Invalid language server request.')
      if (connection.socket?.readyState !== 1) throw new Error('Code intelligence is not connected.')
      connection.socket.send(message)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Code intelligence request failed.'
      connection.notify({ profileId: connection.scope.profileId, profileGeneration: connection.scope.profileGeneration,
        sessionId, connectionId, type: 'error', message: reason })
      this.close(key, reason)
    }
  }

  disconnect(owner: number, scope: WorkspaceProfileScope, sessionId: string, connectionId: string): void {
    const key = this.key(owner, connectionId)
    if (this.match(key, scope, sessionId)) this.close(key, 'Code editor closed')
  }

  closeOwner(owner: number): void {
    for (const [key, connection] of this.connections) if (connection.owner === owner) this.close(key, 'Window closed')
  }

  private match(key: string, scope: WorkspaceProfileScope, sessionId: string): Connection | undefined {
    const connection = this.connections.get(key)
    return connection && scope && connection.sessionId === sessionId
      && connection.scope.profileId === scope.profileId
      && connection.scope.profileGeneration === scope.profileGeneration
      && (connection.scope.serverIdentity ?? null) === (scope.serverIdentity ?? null) ? connection : undefined
  }

  private close(key: string, reason: string): void {
    const connection = this.connections.get(key)
    if (!connection) return
    this.connections.delete(key)
    connection.reject(new Error(reason))
    if (connection.socket && connection.socket.readyState < 2) connection.socket.close(1000, 'Code editor closed')
  }

  private key(owner: number, connectionId: string): string {
    if (typeof connectionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(connectionId)) throw new Error('Invalid code intelligence connection.')
    return `${owner}:${connectionId}`
  }
}
