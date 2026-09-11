import { normalizeServerURL } from './format'

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:7850'
export const AGENTS_SERVER_REPOSITORY_URL = 'https://github.com/ZhengyiLuo/AgentsServer'

export function inferServerConfigured(serverURL: unknown, explicit: unknown): boolean {
  if (typeof explicit === 'boolean') return explicit
  if (typeof serverURL !== 'string' || !serverURL.trim()) return false
  const normalized = normalizeServerURL(serverURL).toLowerCase()
  return normalized !== DEFAULT_SERVER_URL && normalized !== 'http://localhost:7850'
}
