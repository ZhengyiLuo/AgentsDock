import type { ChatReference, TeamRecipientReference, TeamReference, TeamSkillReference } from '@shared/types'

export interface TeamMentionTrigger {
  kind: '@@'
  start: number
  end: number
  query: string
}

export type TeamReferenceTarget =
  | Pick<TeamRecipientReference, 'kind' | 'recipient_kind' | 'team_id' | 'target_id' | 'display_name_snapshot'>
  | Pick<TeamSkillReference, 'kind' | 'team_id' | 'target_id' | 'display_name_snapshot'>

export interface InsertTeamReferenceResult {
  text: string
  reference: TeamReference
  caret: number
}

export interface ComposerReferenceSet {
  chatReferences: ChatReference[]
  teamReferences: TeamReference[]
}

export interface ComposerReferenceSpan {
  source_text_start: number
  source_text_end: number
}

const TEAM_REFERENCE_KINDS = new Set(['recipient', 'skill'])
const TEAM_RECIPIENT_KINDS = new Set(['server', 'human', 'all', 'all_servers'])
const MAX_TEAM_REFERENCES = 16
const MAX_TEAM_REFERENCE_DISPLAY_NAME_LENGTH = 160

export function teamMessagesAvailable(health: {
  capabilities?: { agent_team_messages_v1?: {
    available?: boolean
    version?: number
    mention_sigil?: string
    send_requires_mention?: boolean
  } }
} | null | undefined): boolean {
  const capability = health?.capabilities?.agent_team_messages_v1
  return capability?.available === true
    && capability.version === 1
    && capability.mention_sigil === '@@'
    && capability.send_requires_mention === true
}

export function teamReferenceText(
  reference: Pick<TeamReference, 'display_name_snapshot'>
): string {
  return `@@${reference.display_name_snapshot}`
}

/** Finds the active Team Network query before the single-@ chat parser runs. */
export function teamMentionTrigger(
  text: string,
  caret: number,
  chatReferences: readonly ChatReference[] = [],
  teamReferences: readonly TeamReference[] = []
): TeamMentionTrigger | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length))
  const lineStart = text.lastIndexOf('\n', safeCaret - 1) + 1
  const line = text.slice(lineStart, safeCaret)
  const references = [...chatReferences, ...teamReferences]
  const insideResolvedReference = (offset: number) => references.some(reference => (
    reference.source_text_start <= offset
    && offset < reference.source_text_end
  ))

  for (let at = line.length - 2; at >= 0; at -= 1) {
    if (line[at] !== '@' || line[at + 1] !== '@') continue
    if (line[at - 1] === '@' || line[at + 2] === '@') continue
    const absolute = lineStart + at
    const previous = absolute > 0 ? text[absolute - 1] : ''
    if (insideResolvedReference(absolute)) return null
    if (previous && !/\s|[([{]/u.test(previous)) return null
    return {
      kind: '@@',
      start: absolute,
      end: safeCaret,
      query: text.slice(absolute + 2, safeCaret)
    }
  }
  return null
}

export function insertTeamReference(
  text: string,
  trigger: TeamMentionTrigger,
  target: TeamReferenceTarget
): InsertTeamReferenceResult {
  const displayName = target.display_name_snapshot.trim()
  if (!displayName || displayName.startsWith('@') || hasControlCharacter(displayName)) {
    throw new Error('That Team Network name cannot be referenced.')
  }
  const display = `@@${displayName}`
  const prefix = text.slice(0, trigger.start)
  const suffix = text.slice(trigger.end)
  const needsSpace = suffix.length === 0 || !/^\s/u.test(suffix)
  const inserted = `${display}${needsSpace ? ' ' : ''}`
  const span = {
    display_name_snapshot: displayName,
    source_text_start: trigger.start,
    source_text_end: trigger.start + display.length,
    grant_intent: true as const
  }
  const reference: TeamReference = target.kind === 'recipient'
    ? { ...target, ...span }
    : { ...target, ...span }
  return {
    text: `${prefix}${inserted}${suffix}`,
    reference,
    caret: trigger.start + inserted.length
  }
}

/**
 * Applies one contiguous textarea edit. Touching any part of a Team Network
 * chip revokes that exact authority instead of reconstructing it from text.
 */
export function reconcileTeamReferences(
  previousText: string,
  nextText: string,
  references: readonly TeamReference[]
): TeamReference[] {
  if (!references.length || previousText === nextText) return [...references]
  let prefix = 0
  const maxPrefix = Math.min(previousText.length, nextText.length)
  while (prefix < maxPrefix && previousText[prefix] === nextText[prefix]) prefix += 1

  let suffix = 0
  const remainingPrevious = previousText.length - prefix
  const remainingNext = nextText.length - prefix
  while (
    suffix < remainingPrevious
    && suffix < remainingNext
    && previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) suffix += 1

  const previousEditEnd = previousText.length - suffix
  const nextEditEnd = nextText.length - suffix
  const delta = nextEditEnd - previousEditEnd
  return references.flatMap(reference => {
    if (reference.source_text_end <= prefix) return [reference]
    if (reference.source_text_start >= previousEditEnd) {
      return [{
        ...reference,
        source_text_start: reference.source_text_start + delta,
        source_text_end: reference.source_text_end + delta
      }]
    }
    return []
  }).filter(reference => teamReferenceTokenMatches(nextText, reference))
}

export function validTeamReferences(
  text: string,
  references: readonly TeamReference[],
  occupied: readonly ComposerReferenceSpan[] = []
): TeamReference[] {
  const accepted: TeamReference[] = []
  const acceptedSpans: ComposerReferenceSpan[] = [...occupied]
  const authorities = new Set<string>()
  for (const reference of [...references].sort((left, right) => (
    left.source_text_start - right.source_text_start
    || left.source_text_end - right.source_text_end
  ))) {
    if (accepted.length >= MAX_TEAM_REFERENCES) break
    if (!validTeamReferenceIdentity(reference)) continue
    if (!Number.isInteger(reference.source_text_start) || !Number.isInteger(reference.source_text_end)) continue
    if (reference.source_text_start < 0 || reference.source_text_end <= reference.source_text_start || reference.source_text_end > text.length) continue
    if (!teamReferenceTokenMatches(text, reference)) continue
    if (acceptedSpans.some(span => spansOverlap(span, reference))) continue
    const key = `${reference.kind}\u0000${reference.recipient_kind ?? ''}\u0000${reference.team_id}\u0000${reference.target_id}`
    if (authorities.has(key)) continue
    accepted.push(canonicalTeamReference(reference))
    acceptedSpans.push(reference)
    authorities.add(key)
  }
  return accepted
}

/** Team references win exact-span collisions so legacy @@ chat markers stay read-only. */
export function validComposerReferences(
  text: string,
  chatReferences: readonly ChatReference[],
  teamReferences: readonly TeamReference[],
  validateChats: (text: string, references: readonly ChatReference[]) => ChatReference[]
): ComposerReferenceSet {
  const validTeams = validTeamReferences(text, teamReferences)
  const validChats = validateChats(text, chatReferences).filter(reference => (
    !validTeams.some(teamReference => spansOverlap(reference, teamReference))
  ))
  return { chatReferences: validChats, teamReferences: validTeams }
}

export function parseStoredTeamReferences(value: unknown, text: string): TeamReference[] {
  if (!Array.isArray(value)) return []
  const references = value.flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const item = candidate as Record<string, unknown>
    if (
      typeof item.kind !== 'string'
      || typeof item.team_id !== 'string'
      || typeof item.target_id !== 'string'
      || typeof item.display_name_snapshot !== 'string'
      || typeof item.source_text_start !== 'number'
      || typeof item.source_text_end !== 'number'
      || item.grant_intent !== true
    ) return []
    return [item as unknown as TeamReference]
  })
  return validTeamReferences(text, references)
}

export function orderedComposerReferenceSpans(
  chatReferences: readonly ChatReference[],
  teamReferences: readonly TeamReference[]
): ComposerReferenceSpan[] {
  return [...chatReferences, ...teamReferences].sort((left, right) => (
    left.source_text_start - right.source_text_start
    || left.source_text_end - right.source_text_end
  ))
}

export function atomicComposerReferenceCaret(
  caret: number,
  references: readonly ComposerReferenceSpan[]
): number {
  const reference = references.find(candidate => candidate.source_text_start < caret && caret < candidate.source_text_end)
  if (!reference) return caret
  return caret - reference.source_text_start < reference.source_text_end - caret
    ? reference.source_text_start
    : reference.source_text_end
}

export function atomicComposerReferenceNavigation(
  caret: number,
  references: readonly ComposerReferenceSpan[],
  key: 'ArrowLeft' | 'ArrowRight'
): number | null {
  const reference = key === 'ArrowLeft'
    ? [...references].reverse().find(candidate => candidate.source_text_start < caret && caret <= candidate.source_text_end)
    : references.find(candidate => candidate.source_text_start <= caret && caret < candidate.source_text_end)
  if (!reference) return null
  return key === 'ArrowLeft' ? reference.source_text_start : reference.source_text_end
}

export function atomicComposerReferenceDeletion(
  text: string,
  references: readonly ComposerReferenceSpan[],
  selectionStart: number,
  selectionEnd: number,
  key: 'Backspace' | 'Delete'
): { text: string; caret: number } | null {
  let start = Math.max(0, Math.min(selectionStart, selectionEnd, text.length))
  let end = Math.max(start, Math.min(Math.max(selectionStart, selectionEnd), text.length))
  const collapsed = start === end
  const ordered = [...references].sort((left, right) => left.source_text_start - right.source_text_start)
  const touched = collapsed
    ? ordered.filter(reference => key === 'Backspace'
      ? reference.source_text_start < start && start <= reference.source_text_end
      : reference.source_text_start <= start && start < reference.source_text_end)
    : ordered.filter(reference => reference.source_text_start < end && start < reference.source_text_end)
  if (!touched.length) return null
  start = Math.min(start, ...touched.map(reference => reference.source_text_start))
  end = Math.max(end, ...touched.map(reference => reference.source_text_end))
  if (collapsed && text[end] === ' ') end += 1
  else if (collapsed && text[start - 1] === ' ') start -= 1
  return { text: `${text.slice(0, start)}${text.slice(end)}`, caret: start }
}

function validTeamReferenceIdentity(reference: TeamReference): boolean {
  if (!TEAM_REFERENCE_KINDS.has(reference.kind) || reference.grant_intent !== true) return false
  if (
    !boundedSafeString(reference.team_id, 240)
    || !boundedSafeString(reference.target_id, 240)
    || !boundedSafeString(reference.display_name_snapshot, MAX_TEAM_REFERENCE_DISPLAY_NAME_LENGTH)
    || reference.display_name_snapshot.startsWith('@')
  ) return false
  if (reference.kind === 'recipient') {
    if (!TEAM_RECIPIENT_KINDS.has(reference.recipient_kind ?? '')) return false
    if (reference.recipient_kind === 'all' || reference.recipient_kind === 'all_servers') {
      return reference.target_id === reference.recipient_kind
    }
    return true
  }
  return reference.recipient_kind == null
}

function canonicalTeamReference(reference: TeamReference): TeamReference {
  const shared = {
    team_id: reference.team_id,
    target_id: reference.target_id,
    display_name_snapshot: reference.display_name_snapshot,
    source_text_start: reference.source_text_start,
    source_text_end: reference.source_text_end,
    grant_intent: true as const
  }
  return reference.kind === 'recipient'
    ? { kind: 'recipient', recipient_kind: reference.recipient_kind, ...shared }
    : { kind: 'skill', ...shared }
}

function teamReferenceTokenMatches(text: string, reference: TeamReference): boolean {
  const previous = reference.source_text_start > 0 ? text[reference.source_text_start - 1] : ''
  const next = reference.source_text_end < text.length ? text[reference.source_text_end] : ''
  return text.slice(reference.source_text_start, reference.source_text_end) === teamReferenceText(reference)
    && (!previous || /\s|[([{]/u.test(previous))
    && (!next || /\s/u.test(next))
}

function spansOverlap(left: ComposerReferenceSpan, right: ComposerReferenceSpan): boolean {
  return left.source_text_start < right.source_text_end && right.source_text_start < left.source_text_end
}

function boundedSafeString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !hasControlCharacter(value)
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value)
}
