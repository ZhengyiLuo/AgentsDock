import type { ReasoningSummaryStreamSnapshot } from './types'

/** Validate the transient lane separately so it can never advance a durable cursor. */
export function isReasoningSummaryStream(value: unknown): value is ReasoningSummaryStreamSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const packet = value as Record<string, unknown>
  if (packet.type !== 'reasoning_summary_stream'
    || !identity(packet.session_id) || !identity(packet.instance_id)
    || !Number.isSafeInteger(packet.revision) || Number(packet.revision) < 0
    || !Array.isArray(packet.items) || packet.items.length > 256) return false
  const identities = new Set<string>()
  let textSize = 0
  for (const value of packet.items) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const item = value as Record<string, unknown>
    if (!identity(item.run_id) || !identity(item.item_id)
      || item.backend !== 'codex' || (item.phase !== 'summary' && item.phase !== 'reasoning')
      || typeof item.text !== 'string'
      || !Number.isSafeInteger(item.after_seq) || Number(item.after_seq) < 0
      || typeof item.ts !== 'string' || item.ts.length > 80 || !Number.isFinite(Date.parse(item.ts))) return false
    const key = JSON.stringify([item.run_id, item.item_id, item.phase])
    if (identities.has(key)) return false
    identities.add(key)
    textSize += item.text.length
    if (textSize > 8 * 1024 * 1024) return false
  }
  return true
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
}
