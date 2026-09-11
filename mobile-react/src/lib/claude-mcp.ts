import type { Health, JsonValue } from '../types'

export const CLAUDE_MCP_MANAGEMENT_MIN_VERSION = 3

export interface ClaudeMcpManagementCapability {
  advertised: true
  available: boolean
  version: number
  message: string | null
  action: string | null
}

/**
 * A missing result means the active AgentsServer predates the MCP management
 * contract. An advertised but unavailable result is a current server whose
 * Claude SDK runtime cannot provide MCP controls right now.
 */
export function claudeMcpManagementCapability(health: Health | null | undefined): ClaudeMcpManagementCapability | null {
  const capabilities = recordValue(health?.capabilities)
  const candidate = recordValue(capabilities.claude_controls)
  const features = recordValue(candidate.features)
  const version = finiteNumber(candidate.version)
  if (version == null || version < CLAUDE_MCP_MANAGEMENT_MIN_VERSION || features.mcp_management !== true) return null
  return {
    advertised: true,
    available: candidate.available === true,
    version,
    message: stringValue(candidate.message),
    action: stringValue(candidate.action),
  }
}

export function isClaudeMcpCommand(text: string): boolean {
  return /^\/mcp\s*$/i.test(text.trim())
}

function recordValue(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {}
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
