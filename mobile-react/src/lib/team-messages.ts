import { chatMessageBodyHashMatches } from './chat-message-body'

export interface TeamMessageRecipient { kind: 'server' | 'human' | 'all'; id: string; display_name: string; state: 'available' | 'delivered' | 'read' }
export interface TeamMailboxState { address_kind: 'server'; address_id: string; unread: boolean; version: number }
export interface TeamMessageSummary {
  id: string; sequence: number; kind: 'message' | 'skill'; title: string | null; preview: string
  body_format: 'plain' | 'markdown'; body_sha256: string; body_bytes: number
  sender: { kind: 'server' | 'human'; id: string; display_name: string }
  recipients: TeamMessageRecipient[]; delivery?: TeamMessageRecipient | null
  attachments: Array<{ id: string; file_name: string; media_type: string; byte_size: number }>
  mailbox_state?: TeamMailboxState; in_reply_to_message_id: string | null
  destination?: 'all_servers'; created_at: string
}
export interface TeamMessage extends TeamMessageSummary { body: string }
export interface TeamMessagePage { messages: TeamMessageSummary[]; next_after_sequence: number; has_more: boolean }
export interface TeamMessageCapabilities { messages: boolean; mailboxState: boolean; mailSubjects: boolean; threads: boolean }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240 && value === value.trim() && !/[\u0000-\u0020\u007f]/u.test(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const label = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)
const invalid = () => new Error('Team Network returned an invalid message or mailbox receipt. Refresh and try again.')
export function parseTeamMessageCapabilities(value: unknown, expectedHub?: string | null): TeamMessageCapabilities {
  const hub = object(value), capabilities = object(hub.capabilities), messages = object(capabilities.team_messages_v1)
  if (!id(hub.hub_id) || expectedHub && hub.hub_id !== expectedHub) throw new Error('Team Network returned a different Hub identity.')
  const mailbox = object(capabilities.team_mailbox_state_v1), subjects = object(capabilities.team_mail_subjects_v1), threads = object(capabilities.team_mail_threads_v1)
  return { messages: messages.available === true && messages.version === 1,
    mailboxState: mailbox.available === true && mailbox.version === 1 && JSON.stringify(mailbox.address_kinds) === '["server"]',
    mailSubjects: subjects.available === true && subjects.version === 1 && subjects.max_subject_chars === 160,
    threads: threads.available === true && threads.version === 1 && threads.max_page_items === 25 && threads.max_thread_items === 2048 }
}
function recipient(value: unknown): TeamMessageRecipient {
  const row = object(value)
  if (!['server', 'human', 'all'].includes(String(row.kind)) || !id(row.id) || !label(row.display_name) || !['available', 'delivered', 'read'].includes(String(row.state))) throw invalid()
  return { kind: row.kind, id: row.id, display_name: row.display_name, state: row.state } as TeamMessageRecipient
}
function mailboxState(value: unknown): TeamMailboxState {
  const row = object(value)
  if (row.address_kind !== 'server' || !id(row.address_id) || typeof row.unread !== 'boolean' || !count(row.version)) throw invalid()
  return { address_kind: 'server', address_id: row.address_id, unread: row.unread, version: row.version }
}
export function parseTeamMessage(value: unknown, messageId?: string, full = false): TeamMessage {
  const row = object(value), sender = object(row.sender)
  if (!id(row.id) || messageId && row.id !== messageId || !count(row.sequence) || row.sequence < 1
    || !['message', 'skill'].includes(String(row.kind)) || row.kind === 'message' && row.skill != null || !(row.title === null || typeof row.title === 'string' && row.title.length <= 160)
    || !['plain', 'markdown'].includes(String(row.body_format)) || !count(row.body_bytes) || row.body_bytes > 49_152
    || typeof row.body_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.body_sha256)
    || !['server', 'human'].includes(String(sender.kind)) || !id(sender.id) || !label(sender.display_name)
    || !Array.isArray(row.recipients) || !row.recipients.length || row.recipients.length > (row.destination === 'all_servers' ? 1024 : 16)
    || !Array.isArray(row.attachments) || row.attachments.length > 16
    || !(row.in_reply_to_message_id === null || id(row.in_reply_to_message_id)) || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) throw invalid()
  const recipients = row.recipients.map(recipient)
  if (new Set(recipients.map(value => `${value.kind}:${value.id}`)).size !== recipients.length
    || recipients.some(value => value.kind === 'all') && recipients.length !== 1
    || row.destination !== undefined && (row.destination !== 'all_servers' || recipients.some(value => value.kind !== 'server'))) throw invalid()
  const attachments = row.attachments.map(value => {
    const item = object(value)
    if (!id(item.id) || !label(item.file_name) || typeof item.media_type !== 'string' || !count(item.byte_size)) throw invalid()
    return { id: item.id, file_name: item.file_name, media_type: item.media_type, byte_size: item.byte_size }
  })
  const delivery = row.delivery == null ? row.delivery as null | undefined : recipient(row.delivery)
  if (delivery && !recipients.some(value => value.kind === delivery.kind && value.id === delivery.id)) throw invalid()
  const state = row.mailbox_state === undefined ? undefined : mailboxState(row.mailbox_state)
  if (state && !recipients.some(value => value.kind === 'server' && value.id === state.address_id)) throw invalid()
  if (full && (typeof row.body !== 'string' || new TextEncoder().encode(row.body).length !== row.body_bytes || !chatMessageBodyHashMatches(row.body, row.body_sha256))) throw invalid()
  if (!full && (typeof row.preview !== 'string' || row.preview.length > 6000)) throw invalid()
  return { ...row, recipients, attachments, delivery, mailbox_state: state, preview: full ? String(row.body).slice(0, 600) : row.preview } as unknown as TeamMessage
}
export function parseTeamMessagePage(value: unknown, box: 'inbox' | 'sent' | 'feed', addressId: string | null, after = 0): TeamMessagePage {
  const row = object(value), address = object(row.address)
  if (row.box !== box || (box === 'inbox' ? address.kind !== 'server' || address.id !== addressId : row.address !== null)
    || !Array.isArray(row.messages) || row.messages.length > 25 || typeof row.has_more !== 'boolean' || !count(row.next_after_sequence)) throw invalid()
  const messages = row.messages.map(value => parseTeamMessage(value))
  let sequence = after
  for (const message of messages) {
    if (message.sequence <= sequence || box === 'inbox' && (!message.recipients.some(value => value.kind === 'server' && value.id === addressId) || message.delivery?.kind !== 'server' || message.delivery.id !== addressId)
      || box !== 'inbox' && message.delivery != null) throw invalid()
    sequence = message.sequence
  }
  if (new Set(messages.map(value => value.id)).size !== messages.length || row.next_after_sequence !== sequence || row.has_more && !messages.length) throw invalid()
  return { messages, has_more: row.has_more, next_after_sequence: sequence }
}
export function teamMessageUnread(message: TeamMessageSummary, addressId: string): boolean {
  return message.mailbox_state?.address_id === addressId ? message.mailbox_state.unread
    : (message.delivery?.kind === 'server' && message.delivery.id === addressId ? message.delivery : message.recipients.find(value => value.kind === 'server' && value.id === addressId))?.state !== 'read'
}
export function parseTeamReadReceipt(value: unknown, messageId: string, addressId: string, expected?: { unread: boolean; version: number }): { recipients: TeamMessageRecipient[]; mailbox_state?: TeamMailboxState } {
  const row = object(value)
  if (row.message_id !== messageId || !Array.isArray(row.recipients) || !row.recipients.length || row.recipients.length > 1024 || expected && row.recipients.length !== 1) throw invalid()
  const recipients = row.recipients.map(recipient), own = recipients.find(value => value.kind === 'server' && value.id === addressId)
  if (!own || recipients.some(value => value.kind === 'all') || new Set(recipients.map(value => `${value.kind}:${value.id}`)).size !== recipients.length || !expected?.unread && own.state !== 'read') throw invalid()
  const state = expected ? mailboxState(row.mailbox_state) : undefined
  if (expected && (!state || state.address_id !== addressId || state.unread !== expected.unread || state.version !== expected.version + 1)) throw invalid()
  return { recipients, ...(state ? { mailbox_state: state } : {}) }
}
export function parseTeamDismissal(value: unknown, messageId: string, addressId: string): void {
  const row = object(value), address = object(row.address)
  if (row.dismissed !== true || row.message_id !== messageId || address.kind !== 'server' || address.id !== addressId) throw invalid()
}
export function teamMailReplyAvailable(message: TeamMessageSummary, addressId: string): boolean {
  return message.kind === 'message' && message.sender.kind === 'server' && message.sender.id !== addressId
    && message.delivery?.kind === 'server' && message.delivery.id === addressId
    && message.recipients.every(value => value.kind === 'server') && message.recipients.some(value => value.id === addressId)
}
