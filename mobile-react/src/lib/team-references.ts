import type { ChatReference, Health, TeamReference } from '../types'
import type { AgentServerClient } from '../api/AgentServerClient'
import { reconcileChatReferences } from './chat-references'
import { teamNetworkProxyRoute } from './team-network'

export const MAX_TEAM_REFERENCES = 16
export interface TeamMentionTrigger { kind: '@@'; start: number; end: number; query: string }
export type TeamReferenceTarget = Pick<TeamReference, 'kind' | 'recipient_kind' | 'team_id' | 'target_id' | 'display_name_snapshot'>
export interface TeamMentionCandidate { id: string; label: string; teamName: string; target: TeamReferenceTarget }

export function teamMessagesAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.agent_team_messages_v1
  return capability?.available === true && capability.version === 1
    && capability.mention_sigil === '@@' && capability.send_requires_mention === true
    && teamNetworkProxyRoute(health) !== null
}

/** Double-@ owns its token; it never grants a local @Chat route. */
export function teamMentionTrigger(text: string, caret: number, chats: readonly ChatReference[] = [], teams: readonly TeamReference[] = []): TeamMentionTrigger | null {
  const end = Math.max(0, Math.min(caret, text.length))
  const lineStart = text.lastIndexOf('\n', end - 1) + 1
  for (let at = end - 2; at >= lineStart; at -= 1) {
    if (text.slice(at, at + 2) !== '@@' || text[at - 1] === '@' || text[at + 2] === '@') continue
    if ([...chats, ...teams].some(reference => reference.source_text_start <= at && at < reference.source_text_end)) return null
    if (at > 0 && !/\s|[([{]/u.test(text[at - 1])) return null
    return { kind: '@@', start: at, end, query: text.slice(at + 2, end) }
  }
  return null
}

export function insertTeamReference(text: string, trigger: TeamMentionTrigger, target: TeamReferenceTarget): { text: string; reference: TeamReference; caret: number } {
  const display = `@@${target.display_name_snapshot}`
  const suffix = text.slice(trigger.end)
  const inserted = `${display}${!suffix || !/^\s/u.test(suffix) ? ' ' : ''}`
  const next = `${text.slice(0, trigger.start)}${inserted}${suffix}`
  const reference: TeamReference = { ...target, source_text_start: trigger.start, source_text_end: trigger.start + display.length, grant_intent: true }
  if (validTeamReferences(next, [reference]).length !== 1) throw new Error('That Team Network name cannot be referenced.')
  return { text: next, reference, caret: trigger.start + inserted.length }
}

export function reconcileTeamReferences(previousText: string, nextText: string, references: readonly TeamReference[]): TeamReference[] {
  // Both reference kinds use exact UTF-16 spans and the same edit revocation.
  const shifted = reconcileChatReferences(previousText, nextText, references as unknown as ChatReference[])
  return validTeamReferences(nextText, shifted as unknown as TeamReference[])
}

export function validTeamReferences(text: string, references: readonly TeamReference[], occupied: readonly Pick<ChatReference, 'source_text_start' | 'source_text_end'>[] = []): TeamReference[] {
  if (references.length > MAX_TEAM_REFERENCES || !wellFormed(text)) return []
  const accepted: TeamReference[] = []
  const spans = [...occupied]
  const identities = new Set<string>()
  for (const reference of [...references].sort((a, b) => a.source_text_start - b.source_text_start)) {
    if (!reference || reference.kind !== 'recipient' || reference.recipient_kind !== 'server' || reference.grant_intent !== true) continue
    if (!safeString(reference.team_id, 240) || !safeString(reference.target_id, 240) || !safeString(reference.display_name_snapshot, 160) || reference.display_name_snapshot.startsWith('@')) continue
    const { source_text_start: start, source_text_end: end } = reference
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) continue
    if (text.slice(start, end) !== `@@${reference.display_name_snapshot}` || (start > 0 && !/\s|[([{]/u.test(text[start - 1])) || (end < text.length && !/\s/u.test(text[end]))) continue
    if (spans.some(span => span.source_text_start < end && start < span.source_text_end)) continue
    const key = `${reference.team_id}\0${reference.target_id}`
    if (identities.has(key)) continue
    // Copy only the public reference contract; never persist transport metadata.
    accepted.push({ kind: 'recipient', recipient_kind: 'server', team_id: reference.team_id, target_id: reference.target_id, display_name_snapshot: reference.display_name_snapshot, source_text_start: start, source_text_end: end, grant_intent: true })
    spans.push(reference)
    identities.add(key)
  }
  return accepted
}

export function parseStoredTeamReferences(value: unknown, text: string): TeamReference[] {
  if (!Array.isArray(value) || value.length > MAX_TEAM_REFERENCES) return []
  return validTeamReferences(text, value.filter(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate)))
}

export function teamReferencesEqual(left: readonly TeamReference[], right: readonly TeamReference[]): boolean {
  return left.length === right.length && left.every((reference, index) => {
    const other = right[index]
    return other && reference.kind === other.kind && reference.recipient_kind === other.recipient_kind
      && reference.team_id === other.team_id && reference.target_id === other.target_id
      && reference.display_name_snapshot === other.display_name_snapshot && reference.grant_intent === other.grant_intent
      && reference.source_text_start === other.source_text_start && reference.source_text_end === other.source_text_end
  })
}

/** Detects ambiguous lost metadata only; this never creates recipient authority. */
export function teamReferenceTokenPresent(text: string, displayName: string): boolean {
  const token = `@@${displayName}`
  for (let start = text.indexOf(token); start >= 0; start = text.indexOf(token, start + 1)) {
    const end = start + token.length
    if ((start === 0 || /\s|[([{]/u.test(text[start - 1])) && (end === text.length || /\s/u.test(text[end]))) return true
  }
  return false
}

export function restoreFailedTeamReferences(admittedText: string, admitted: readonly TeamReference[], currentText: string, current: readonly TeamReference[], restoredText: string): TeamReference[] {
  if (currentText && currentText !== admittedText) {
    const offset = admittedText.length + (admittedText.length ? 2 : 0)
    return validTeamReferences(restoredText, [...admitted, ...current.map(reference => ({ ...reference, source_text_start: reference.source_text_start + offset, source_text_end: reference.source_text_end + offset }))])
  }
  return validTeamReferences(restoredText, admittedText.length ? admitted : current)
}

/** Read-only discovery through the active AgentsServer's already approved proxy. */
export async function loadTeamMentionCandidates(connection: Pick<AgentServerClient, 'teamNetworkGet'>, health: Health, current: () => boolean): Promise<TeamMentionCandidate[]> {
  const route = teamNetworkProxyRoute(health)
  const assertCurrent = () => { if (!current()) throw new Error('The active server changed. Open the recipient picker again.') }
  assertCurrent()
  if (!route || !teamMessagesAvailable(health)) throw new Error('Connect this server to Team Network to choose an @@ recipient.')
  const [hubValue, sessionValue] = await Promise.all([
    connection.teamNetworkGet<unknown>(route.basePath, '/v1/health'),
    connection.teamNetworkGet<unknown>(route.basePath, route.sessionPath),
  ])
  assertCurrent()
  const hub = record(hubValue)
  const capability = record(record(hub.capabilities).team_messages_v1)
  if (capability.available !== true || capability.version !== 1) throw new Error('This Team Network does not support structured messages yet.')
  const expectedHub = health.capabilities?.team_hub_v1?.hub_id
  if (!safeString(hub.hub_id, 240) || (expectedHub && hub.hub_id !== expectedHub)) throw new Error('Team Network returned a different Hub identity.')
  const session = record(sessionValue)
  const principal = record(session.principal)
  if (!safeString(principal.id, 240) || (principal.kind !== 'service' && principal.kind !== 'node')) throw new Error('Team Network did not identify the current server.')
  if (!Array.isArray(session.teams) || session.teams.length > 256) throw new Error('Invalid Team Network team list.')
  const candidates: TeamMentionCandidate[] = []
  const seen = new Set<string>()
  for (const value of session.teams) {
    const team = record(value)
    if (!safeString(team.id, 240) || !safeString(team.display_name, 160)) throw new Error('Invalid Team Network team identity.')
    if (team.status !== 'active') continue
    let after: string | null = null
    const cursors = new Set<string>()
    for (let page = 0; page < 100; page += 1) {
      assertCurrent()
      const query = new URLSearchParams({ limit: '100', ...(after ? { after_server_id: after } : {}) })
      const projection = record(await connection.teamNetworkGet<unknown>(route.basePath, `/v1/teams/${encodeURIComponent(team.id)}/network?${query}`))
      assertCurrent()
      const network = record(projection.network)
      if (network.id !== team.id || network.hub_id !== hub.hub_id) throw new Error('Team Network returned a different team or Hub.')
      if (!Array.isArray(projection.servers) || projection.servers.length > 100 || typeof projection.has_more !== 'boolean') throw new Error('Invalid Team Network server list.')
      for (const value of projection.servers) {
        const server = record(value)
        if (!safeString(server.id, 240) || !safeString(server.server_identity, 240) || typeof server.owned_by_caller !== 'boolean') throw new Error('Invalid Team Network server identity.')
        if (server.status !== 'active' || server.owned_by_caller || server.server_identity === health.server_identity) continue
        const label = typeof server.recipient_display_name === 'string' ? server.recipient_display_name : server.display_name
        if (!safeString(label, 160) || label.startsWith('@')) continue
        const id = `server:${team.id}:${server.id}`
        if (seen.has(id)) throw new Error('Team Network repeated a server identity.')
        seen.add(id)
        candidates.push({ id, label, teamName: team.display_name, target: { kind: 'recipient', recipient_kind: 'server', team_id: team.id, target_id: server.id, display_name_snapshot: label } })
      }
      if (!projection.has_more) break
      const cursor = projection.next_after_server_id
      const last = record(projection.servers.at(-1)).id
      if (!safeString(cursor, 240) || cursor !== last || cursors.has(cursor) || page === 99) throw new Error('Invalid Team Network pagination.')
      cursors.add(cursor)
      after = cursor
    }
  }
  assertCurrent()
  return candidates.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function safeString(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) && wellFormed(value) }
function wellFormed(value: string): boolean { return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) }
