import type { CoordinatedServerUpdate } from './types'

export function needsLegacyUpdateRecovery(message: string): boolean {
  return message.includes('the previous server update could not be safely finalized')
}

export function legacyUpdateRecoveryCommand(update: CoordinatedServerUpdate): string | null {
  // This repair was introduced in 1.0.5. Never interpolate server-supplied text
  // into a command or suggest a withdrawn package that lacks the repair.
  return update.targetVersion === '1.0.5'
    && (['blocked', 'failed'].includes(update.phase) && needsLegacyUpdateRecovery(update.message)
      || update.phase === 'updating' && update.operationTargetVersion === '1.0.4')
    ? 'npx @agentsdock/server@1.0.5 recover'
    : null
}
