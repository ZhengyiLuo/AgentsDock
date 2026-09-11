const TEAM_NETWORK_VALIDATION_PREFIX = 'Team Network recipient validation failed:'
const BULLETIN_ALIAS_UPGRADE_MESSAGE = 'This AgentsServer does not support @@bulletin yet. Update the server and try again.'
const MAX_VALIDATION_MESSAGE_CHARS = 400
const MAX_SERIALIZED_DETAIL_CHARS = 64 * 1024

/** Project a FastAPI validation list without exposing its raw input records or IDs. */
export function teamNetworkValidationMessage(detail: unknown): string | null {
  if (!Array.isArray(detail)) return null
  for (const value of detail) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const item = value as { loc?: unknown; msg?: unknown; type?: unknown }
    if (
      !Array.isArray(item.loc)
      || !item.loc.includes('team_references')
      || typeof item.type !== 'string'
      || !item.type.endsWith('value_error')
      || typeof item.msg !== 'string'
    ) continue
    const rawMessage = item.msg.replace(/^Value error,\s*/i, '').replace(/\s+/g, ' ').trim()
    if (!rawMessage || rawMessage.length > MAX_VALIDATION_MESSAGE_CHARS) continue
    if (/team-wide recipients use the visible token ['"]@@all['"]/i.test(rawMessage)) {
      return BULLETIN_ALIAS_UPGRADE_MESSAGE
    }
    const message = `${rawMessage[0].toUpperCase()}${rawMessage.slice(1)}`
    return `${TEAM_NETWORK_VALIDATION_PREFIX} ${/[.!?]$/.test(message) ? message : `${message}.`}`
  }
  return null
}

/** Electron serializes main-process errors; unwrap only a recognized turn validation error. */
export function turnSendErrorMessage(error: unknown): string {
  const original = error instanceof Error ? error.message : String(error)
  const match = original.match(/^Error invoking remote method ['"]turns:send['"]:\s*(?:Error:\s*)?([\s\S]+)$/i)
  const candidate = (match?.[1] ?? original).trim()
  if (candidate === BULLETIN_ALIAS_UPGRADE_MESSAGE || candidate.startsWith(`${TEAM_NETWORK_VALIDATION_PREFIX} `)) {
    return candidate
  }
  if (candidate.length > MAX_SERIALIZED_DETAIL_CHARS || !candidate.startsWith('[')) return original
  try {
    return teamNetworkValidationMessage(JSON.parse(candidate)) ?? original
  } catch {
    return original
  }
}
