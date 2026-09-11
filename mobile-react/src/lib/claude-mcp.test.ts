import { claudeMcpManagementCapability, isClaudeMcpCommand } from './claude-mcp'
import type { Health } from '../types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(isClaudeMcpCommand('/mcp'), 'exact command should match')
assert(isClaudeMcpCommand('  /MCP  '), 'command matching should ignore case and surrounding whitespace')
assert(!isClaudeMcpCommand('/mcp reconnect'), 'arguments must not be interpreted as the app-owned command')
assert(!isClaudeMcpCommand('please run /mcp'), 'ordinary prompt text must not be intercepted')

const supported = claudeMcpManagementCapability({
  ok: true,
  capabilities: {
    claude_controls: {
      available: true,
      version: 3,
      interactive_client_capability: 'claude_sdk_interactive_v1',
      features: { mcp_management: true },
    },
  },
} as Health)
assert(supported?.available === true, 'version 3 MCP management should be available')

const temporarilyUnavailable = claudeMcpManagementCapability({
  ok: true,
  capabilities: {
    claude_controls: {
      available: false,
      version: 3,
      message: 'Claude Agent SDK is unavailable.',
      features: { mcp_management: true },
    },
  },
} as Health)
assert(temporarilyUnavailable?.available === false, 'advertised controls should retain runtime unavailability')
assert(temporarilyUnavailable?.message === 'Claude Agent SDK is unavailable.', 'safe capability message should be retained')

assert(claudeMcpManagementCapability({
  ok: true,
  capabilities: { claude_controls: { available: true, version: 2, features: { mcp_management: true } } },
} as Health) === null, 'older capability versions must be treated as unsupported')

assert(claudeMcpManagementCapability({
  ok: true,
  capabilities: { claude_controls: { available: true, version: 3, features: {} } },
} as Health) === null, 'the feature must be explicitly advertised')
