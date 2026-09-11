import type { Health } from '../types'

export interface TeamNetworkProxyRoute {
  basePath: string
  sessionPath: '/v1/server-session' | '/v1/peer-session'
}

const SECURE_PEER_PROXY = /^\/api\/team-hub-secure\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/**
 * Mobile profiles own only an AgentsServer token. Admit Teamspace exclusively
 * through its authenticated, server-scoped proxy mounts; never expose or
 * reuse Team Hub credentials or direct URLs in the renderer.
 */
export function teamNetworkProxyRoute(health: Health | null | undefined): TeamNetworkProxyRoute | null {
  const capability = health?.capabilities?.team_hub_v1
  if (capability?.available !== true || capability.version !== 1) return null
  if (capability.server_session_base_path === '/api/team-hub-server') {
    return { basePath: '/api/team-hub-server', sessionPath: '/v1/server-session' }
  }
  const basePath = capability.base_path?.trim() || ''
  if (capability.transport === 'secure_peer' && SECURE_PEER_PROXY.test(basePath)) {
    return { basePath, sessionPath: '/v1/peer-session' }
  }
  return null
}

export function teamNetworkAvailable(health: Health | null | undefined): boolean {
  return teamNetworkProxyRoute(health) !== null
}

export function teamNetworkRequestPath(basePath: string, path: string): string {
  const trustedBase = basePath === '/api/team-hub-server' || SECURE_PEER_PROXY.test(basePath)
  if (!trustedBase || !path.startsWith('/v1/') || path.includes('..') || path.includes('\\') || /[\r\n]/u.test(path)) {
    throw new Error('Invalid Teamspace proxy route')
  }
  return `${basePath}${path}`
}

export function teamNetworkIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
