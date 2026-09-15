import type { TeamReference } from '../types'
import { MAX_TEAM_REFERENCES, validTeamReferences } from './team-references'

export interface TeamMailDraftMessage {
  teamId: string
  messageId: string
  senderId: string
  senderName: string
  senderKind: 'server'
  title: string
  section: 'mail' | 'feed'
  mailboxBox: 'inbox' | 'sent'
}
export interface StageTeamMailDraftInput {
  sessionId: string
  expectedSelectedSessionId: string | null
  expectedProfileId: string | null
  expectedProfileGeneration: number
  expectedServerIdentity: string | null
  expectedServerInstanceId: string | null
  expectedValidationRevision: number
  message: TeamMailDraftMessage
  intent: 'read' | 'reply'
}
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240 && value === value.trim() && !/[\u0000-\u0020\u007f]/u.test(value)

/** Draft text and a single explicit sender reference; this helper never sends. */
export function appendTeamMailDraft(draft: string, references: readonly TeamReference[], input: Pick<StageTeamMailDraftInput, 'message' | 'intent' | 'expectedServerIdentity'>): { text: string; references: TeamReference[] } {
  const message = input.message
  if (!identifier(message.teamId) || !identifier(message.messageId) || !identifier(message.senderId)
    || !identifier(input.expectedServerIdentity) || message.senderKind !== 'server'
    || !['mail', 'feed'].includes(message.section) || !['inbox', 'sent'].includes(message.mailboxBox)
    || !['read', 'reply'].includes(input.intent) || input.intent === 'reply' && message.section !== 'mail'
    || typeof message.senderName !== 'string' || !message.senderName.trim() || message.senderName !== message.senderName.trim()
    || message.senderName.length > 160 || /^@|[\u0000-\u001f\u007f]/u.test(message.senderName)) throw new Error('Choose an authenticated server Mail message again.')
  const link = new URL('agentsdock://team-message')
  link.searchParams.set('section', message.section)
  link.searchParams.set('teamId', message.teamId)
  link.searchParams.set('messageId', message.messageId)
  if (message.section === 'mail') link.searchParams.set('mailboxBox', message.mailboxBox)
  link.searchParams.set('serverIdentity', input.expectedServerIdentity)
  const title = (message.title || `Message from ${message.senderName}`).replace(/[\r\n]/gu, ' ').slice(0, 160).replace(/([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/gu, '\\$1')
  const prefix = `${draft}${draft ? '\n\n' : ''}${input.intent === 'reply' ? 'Reply to' : 'Read'} [${title}](${link.href}) from `
  const text = `${prefix}@@${message.senderName}`
  const reference: TeamReference = { kind: 'recipient', recipient_kind: 'server', team_id: message.teamId,
    target_id: message.senderId, display_name_snapshot: message.senderName, source_text_start: prefix.length,
    source_text_end: text.length, grant_intent: true }
  const previous = validTeamReferences(draft, references)
  if (previous.length !== references.length || previous.length >= MAX_TEAM_REFERENCES) throw new Error('Review the existing Team references before routing this message.')
  const next = validTeamReferences(text, [...previous, reference])
  // Existing same-recipient references already grant the exact target; do not
  // replace them or infer a second grant from the appended display token.
  const sameTarget = previous.some(value => value.kind === reference.kind && value.recipient_kind === reference.recipient_kind && value.team_id === reference.team_id && value.target_id === reference.target_id)
  if (!sameTarget && !next.some(value => value.source_text_start === reference.source_text_start)) throw new Error('This Mail sender cannot be represented safely in the draft.')
  return { text, references: next }
}
