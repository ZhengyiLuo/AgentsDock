import type { AgentTeamMessagesCapability, Health, TeamAllServersAliasCapability, TeamBulletinAliasCapability } from './types'
import { parseMailArrivalCursor, parseMailboxCoverage, type MailboxCoverage } from './team-mail-hints'

export const TEAM_NETWORK_MAX_PAGE_ITEMS = 100
export const TEAM_NETWORK_DEFAULT_PAGE_ITEMS = 50
export const TEAM_NETWORK_MAX_BODY_BYTES = 65_536
export const TEAM_NETWORK_MAX_AGENTS_PER_SERVER = 256
export const TEAM_MESSAGES_MAX_BODY_BYTES = 49_152
export const TEAM_MESSAGES_MAX_RECIPIENTS = 16
export const TEAM_MESSAGES_MAX_ALL_SERVERS_RECIPIENTS = 1_024
export const TEAM_MESSAGES_MAX_ATTACHMENTS = 16
// The binary Content-Length/Content-Range grammar accepts at most 15 digits.
// A Hub may configure its per-file ceiling anywhere inside that protocol bound.
export const TEAM_MESSAGES_MAX_ATTACHMENT_BYTES = 999_999_999_999_999
export const TEAM_MESSAGES_MAX_TOTAL_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024
export const TEAM_MESSAGES_ATTACHMENT_CHUNK_BYTES = 8 * 1024 * 1024
// Text previews cross the trusted renderer/main boundary instead of relying on
// cross-origin fetch access to the private agentsdock-media protocol.
export const TEAM_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES = 512 * 1024
export const TEAM_MESSAGES_SKILL_SLUG_PATTERN = '^[a-z0-9][a-z0-9-]{0,63}$'
// JSON.parse rounds SQLite's signed-64-bit maximum to this Number. Quotas above
// MAX_SAFE_INTEGER are display/admission hints only and are clamped below.
const TEAM_MESSAGES_MAX_QUOTA_WIRE_BYTES = 9_223_372_036_854_776_000

export type TeamNetworkBodyFormat = 'plain' | 'markdown'
export type TeamNetworkAgentBackend = 'codex' | 'claude' | 'other'
export type TeamNetworkDeliveryState = 'available' | 'delivered' | 'read'
export type TeamNetworkReceiptState = Extract<TeamNetworkDeliveryState, 'delivered' | 'read'>
export type TeamNetworkAddressKind = 'server' | 'agent'

export interface TeamNetworkCapabilities {
  available: true
  version: 1
  logical_servers: true
  agent_registry: true
  bulletin: true
  mailbox: true
  delivery_receipts: ['delivered', 'read']
  passive_requests: true
  server_invites: false
  skill_attachments: false
  dispatch: false
  max_agents_per_server: 256
  max_page_items: number
  max_body_bytes: number
}

export interface TeamNetworkIdentity {
  id: string
  display_name: string
  hub_id: string
}

export interface TeamNetworkServer {
  id: string
  server_identity: string
  display_name: string
  /** Optional host-owner alias used specifically by structured @@ routing. */
  recipient_display_name?: string
  status: 'active' | 'offline' | 'suspended'
  is_host: boolean
  owned_by_caller: boolean
}

export interface TeamNetworkAgent {
  id: string
  server_id: string
  external_agent_id: string
  backend: TeamNetworkAgentBackend
  display_name: string
  status: 'active' | 'offline' | 'suspended'
}

export interface TeamNetworkProjection {
  network: TeamNetworkIdentity
  servers: TeamNetworkServer[]
  agents: TeamNetworkAgent[]
}

export interface TeamNetworkProjectionPage extends TeamNetworkProjection {
  next_after_server_id: string | null
  has_more: boolean
}

export interface TeamNetworkBulletinAuthor {
  kind: 'human' | 'server'
  id: string
  display_name: string
}

export interface TeamNetworkBulletinPost {
  id: string
  sequence: number
  author: TeamNetworkBulletinAuthor
  body_format: TeamNetworkBodyFormat
  body: string
  thread_root_post_id: string | null
  reply_to_post_id: string | null
  created_at: string
}

export interface TeamNetworkBulletinPage {
  posts: TeamNetworkBulletinPost[]
  next_after_sequence: number
  has_more: boolean
}

export interface TeamNetworkHumanAddress {
  kind: 'human'
  id: string
  display_name: string
}

export interface TeamNetworkServerAddress {
  kind: 'server'
  id: string
  server_identity: string
  display_name: string
}

export interface TeamNetworkAgentAddress {
  kind: 'agent'
  id: string
  server_id: string
  backend: TeamNetworkAgentBackend
  display_name: string
}

export type TeamNetworkPublicAddress =
  | TeamNetworkHumanAddress
  | TeamNetworkServerAddress
  | TeamNetworkAgentAddress

export interface TeamNetworkAddress {
  kind: TeamNetworkAddressKind
  id: string
}

export interface TeamNetworkHumanMailboxAddress {
  kind: 'human'
  id: string
}

export type TeamNetworkMailboxAddress = TeamNetworkAddress | TeamNetworkHumanMailboxAddress

export interface TeamNetworkMailboxItem {
  id: string
  sequence: number
  kind: 'message' | 'request' | 'reply'
  from: TeamNetworkPublicAddress
  to: TeamNetworkPublicAddress
  body_format: TeamNetworkBodyFormat
  body: string
  request_id: string | null
  created_at: string
  expires_at: string | null
}

export interface TeamNetworkDelivery {
  id: string
  state: TeamNetworkDeliveryState
  available_at: string
  delivered_at: string | null
  read_at: string | null
}

export interface TeamNetworkMailboxEntry {
  item: TeamNetworkMailboxItem
  delivery: TeamNetworkDelivery
}

export interface TeamNetworkMailboxPage {
  items: TeamNetworkMailboxEntry[]
  next_after_sequence: number
  has_more: boolean
}

export interface TeamNetworkPassiveRequest {
  id: string
  status: 'open' | 'replied' | 'expired'
  expires_at: string
  reply_item_id: string | null
}

export interface TeamNetworkPassiveRequestCreated extends TeamNetworkMailboxEntry {
  request: TeamNetworkPassiveRequest
}

export interface TeamNetworkPassiveRequestDetails extends TeamNetworkPassiveRequestCreated {
  reply: TeamNetworkMailboxEntry | null
}

export interface TeamNetworkPassiveRequestReply extends TeamNetworkMailboxEntry {
  request: TeamNetworkPassiveRequest
}

export interface TeamNetworkRegisterAgentInput {
  teamId: string
  externalAgentId: string
  backend: TeamNetworkAgentBackend
  displayName: string
  idempotencyKey: string
}

export interface TeamNetworkProjectionQuery {
  teamId: string
  afterServerId?: string
  limit?: number
}

export interface TeamNetworkBulletinQuery {
  teamId: string
  afterSequence?: number
  limit?: number
}

export interface TeamNetworkPostBulletinInput {
  teamId: string
  body: string
  bodyFormat?: TeamNetworkBodyFormat
  replyToPostId?: string | null
  idempotencyKey: string
}

export interface TeamNetworkDeleteBulletinInput {
  teamId: string
  postId: string
  idempotencyKey: string
}

export interface TeamNetworkDeleteBulletinResult {
  deleted: true
  post_id: string
}

export interface TeamNetworkDeletion {
  sequence: number
  kind: 'message' | 'bulletin'
  id: string
  deleted_at: string
}

export interface TeamNetworkDeletionPage {
  deletions: TeamNetworkDeletion[]
  next_after_sequence: number
  has_more: boolean
}

/**
 * Desktop-only compatibility envelope for the additive deletion journal.
 * The Team Hub wire response remains TeamNetworkDeletionPage so older strict
 * clients and servers do not need a capability-field change.
 */
export type TeamNetworkDeletionJournalResult =
  | { supported: true; page: TeamNetworkDeletionPage }
  | { supported: false; reason: 'unsupported' }

export interface TeamNetworkDeletionQuery {
  teamId: string
  afterSequence?: number
  limit?: number
}

export interface TeamNetworkMailboxQuery {
  teamId: string
  address: TeamNetworkMailboxAddress
  afterSequence?: number
  limit?: number
}

export interface TeamNetworkSendMailboxInput {
  teamId: string
  to: TeamNetworkAddress
  fromAgentId?: string | null
  body: string
  bodyFormat?: TeamNetworkBodyFormat
  idempotencyKey: string
}

export interface TeamNetworkDeliveryReceiptInput {
  teamId: string
  deliveryId: string
  state: TeamNetworkReceiptState
  idempotencyKey: string
}

export interface TeamNetworkCreatePassiveRequestInput extends TeamNetworkSendMailboxInput {
  expiresInSeconds?: number
}

export interface TeamNetworkReplyPassiveRequestInput {
  teamId: string
  requestId: string
  fromAgentId?: string | null
  body: string
  bodyFormat?: TeamNetworkBodyFormat
  idempotencyKey: string
}

export type TeamMessageKind = 'message' | 'skill'
export type TeamRecipientKind = 'server' | 'human' | 'all'
export type TeamMessageBox = 'inbox' | 'feed' | 'sent'
export type TeamAttachmentState = 'uploading' | 'ready' | 'failed'

export interface TeamMailSubjectsCapability {
  available: true
  version: 1
  max_subject_chars: 160
}

export interface TeamMailThreadsCapability {
  available: true
  version: 1
  max_page_items: 25
  max_thread_items: 2048
}

export interface TeamMailboxStateCapability {
  available: true
  version: 1
  address_kinds: ['server']
}

export interface TeamMailboxState {
  address_kind: 'server'
  address_id: string
  unread: boolean
  version: number
}

export interface TeamMessagesCapability {
  available: true
  version: 1
  kinds: ['message', 'skill']
  recipient_kinds: ['server', 'human', 'all']
  max_body_bytes: number
  max_recipients_per_message: number
  max_page_items: number
  /** Desktop overlay from the separately parsed Hub fanout capability. */
  all_servers?: TeamAllServersAliasCapability
  /** Desktop overlay from the separately negotiated subject capability. */
  mail_subjects?: TeamMailSubjectsCapability
  mail_threads?: TeamMailThreadsCapability
  mailbox_state?: TeamMailboxStateCapability
  /** Desktop overlay derived from the verified Hub's schema, never from message data. */
  skill_announcement_deletion?: true
  /** Desktop overlay from the separately negotiated exact-host moderation capability. */
  host_content_deletion?: true
  attachments: {
    max_bytes_per_file: number
    max_files_per_message: number
    max_bytes_per_message: number
    chunk_bytes: number
    range_downloads: true
    team_quota_bytes: number
  }
  skills: {
    slug_pattern: typeof TEAM_MESSAGES_SKILL_SLUG_PATTERN
    max_per_team: number
    max_versions_per_skill: number
    max_tags: number
  }
}

export interface TeamMessageSender {
  kind: 'human' | 'server'
  id: string
  display_name: string
}

export interface TeamRecipient {
  kind: TeamRecipientKind
  id: string
  display_name: string
  state: TeamNetworkDeliveryState
  delivered_at: string | null
  read_at: string | null
}

export interface TeamMessageProvenance {
  via?: 'agent' | 'desktop' | null
  backend?: string | null
  chat_id?: string | null
  run_id?: string | null
}

export interface TeamAttachment {
  /** Context supplied by the desktop from the route; not present on the wire object. */
  id: string
  team_id: string
  message_id: string | null
  file_name: string
  media_type: string
  byte_size: number
  sha256: string
  state: TeamAttachmentState
  received_bytes: number
  created_at: string
  ready_at: string | null
}

export interface TeamMessageSkill {
  id: string
  slug: string
  version: number
}

export interface TeamMessageRevision {
  version: number
  versions_count: number
  edited_at: string | null
}

export interface TeamMessageHistoryEntry {
  version: number
  body_format: TeamNetworkBodyFormat
  preview?: string
  body?: string
  editor: TeamMessageSender
  created_at: string
}

export interface TeamMessageHistory {
  message_id: string
  versions: TeamMessageHistoryEntry[]
}

export interface TeamMessageBase {
  id: string
  /** Present only for newly committed explicit server-inbox fanouts. */
  destination?: 'all_servers'
  /** Context supplied by the desktop from the route; not present on the wire object. */
  team_id: string
  sequence: number
  kind: TeamMessageKind
  title: string | null
  body_format: TeamNetworkBodyFormat
  body_bytes: number
  body_sha256: string
  sender: TeamMessageSender
  provenance: TeamMessageProvenance
  recipients: TeamRecipient[]
  in_reply_to_message_id: string | null
  skill: TeamMessageSkill | null
  attachments: TeamAttachment[]
  /** Present when the Hub supports author-edited, immutable Bulletin revisions. */
  revision?: TeamMessageRevision
  /** Present for inbox projections and message detail; omitted by feed/sent/create. */
  delivery?: TeamRecipient | null
  /** Opt-in private attention state for this owned server inbox. */
  mailbox_state?: TeamMailboxState
  created_at: string
}

/** Bounded message-list projection. The Hub deliberately omits the body. */
export interface TeamMessageSummary extends TeamMessageBase {
  preview: string
}

/** Full immutable message returned by GET detail and POST create. */
export interface TeamMessage extends TeamMessageBase {
  body: string
}

export interface TeamMessageAddress {
  kind: Extract<TeamRecipientKind, 'server' | 'human'>
  id: string
}

export interface TeamMessagePage {
  box: TeamMessageBox
  address: TeamMessageAddress | null
  messages: TeamMessageSummary[]
  next_after_sequence: number
  has_more: boolean
  mailbox_coverage?: MailboxCoverage
}

export interface TeamMessageThreadQuery {
  teamId: string
  messageId: string
  afterSequence?: number
  limit?: number
}

export interface TeamMessageThreadPage {
  team_id: string
  anchor_message_id: string
  root_message_id: string
  messages: TeamMessage[]
  next_after_sequence: number
  has_more: boolean
  /** A visibility/deletion boundary or bounded traversal prevents a complete history. */
  truncated: boolean
}

export interface TeamMessageReceiptResult {
  message_id: string
  recipients: TeamRecipient[]
}

export interface TeamMailboxStateResult extends TeamMessageReceiptResult {
  mailbox_state: TeamMailboxState
}

export interface TeamMailboxStateInput {
  teamId: string
  messageId: string
  addressKind: 'server'
  addressId: string
  unread: boolean
  expectedVersion: number
  idempotencyKey: string
}

export interface TeamMessageRecipientInput {
  kind: TeamRecipientKind | 'all_servers'
  id?: string
}

export interface TeamMessageSkillInput {
  slug: string
  summary?: string
  tags?: string[]
  change_note?: string
  expected_version?: number
}

export interface TeamMessageQuery {
  teamId: string
  box: TeamMessageBox
  addressKind?: Extract<TeamRecipientKind, 'server' | 'human'>
  addressId?: string
  unread?: boolean
  fromKind?: Extract<TeamMessageSender['kind'], 'server' | 'human'>
  fromId?: string
  since?: string
  afterSequence?: number
  includeMailboxCoverage?: boolean
  afterArrivalId?: string
  limit?: number
}

export interface TeamMessageCreateInput {
  teamId: string
  kind: TeamMessageKind
  title?: string
  body: string
  bodyFormat?: TeamNetworkBodyFormat
  recipients: TeamMessageRecipientInput[]
  attachmentIds?: string[]
  inReplyToMessageId?: string
  skill?: TeamMessageSkillInput
  provenance?: TeamMessageProvenance
  idempotencyKey: string
}

export interface TeamMessageReceiptInput {
  teamId: string
  messageId: string
  state: TeamNetworkReceiptState
  addressKind?: 'server' | 'human'
  addressId?: string
  idempotencyKey: string
}

export interface TeamMessageDismissInput extends TeamMessageDeleteInput {
  addressKind: 'server' | 'human'
  addressId: string
}

export interface TeamMessageDismissResult {
  dismissed: true
  message_id: string
  address: TeamMessageAddress
}

export interface TeamMessageDeleteInput {
  teamId: string
  messageId: string
  idempotencyKey: string
}

export interface TeamMessageDeleteResult {
  deleted: true
  message_id: string
}

export interface TeamMessageRevisionInput {
  teamId: string
  messageId: string
  body: string
  bodyFormat?: TeamNetworkBodyFormat
  expectedVersion: number
  idempotencyKey: string
}

/** Renderer-facing declaration input. Main computes size and sha256 from path. */
export interface TeamAttachmentDeclareInput {
  teamId: string
  path: string
  fileName?: string
  mediaType?: string
  idempotencyKey: string
}

export interface TeamAttachmentUploadInput {
  teamId: string
  attachmentId: string
  path: string
}

export interface TeamAttachmentDeclaration {
  attachment: TeamAttachment
  chunk_bytes: number
}

export interface TeamAttachmentCacheInput {
  teamId: string
  attachmentId: string
  previewBytes?: number
}

export interface TeamAttachmentTextPreview {
  text: string
  byte_size: number
  truncated: boolean
}

export interface TeamAttachmentCacheResult {
  attachment: TeamAttachment
  media_url: string
  text_preview?: TeamAttachmentTextPreview
}

export function teamAttachmentSupportsTextPreview(
  attachment: Pick<TeamAttachment, 'file_name' | 'media_type'>
): boolean {
  return attachment.media_type.toLowerCase().startsWith('text/')
    || /\.(?:md|markdown|txt|json|ya?ml|csv|tsv|log)$/i.test(attachment.file_name)
}

export interface TeamSkillCurrent {
  version: number
  message_id: string
  change_note: string
  created_at: string
}

export interface TeamSkillPermissions {
  edit: boolean
  manage: boolean
}

export interface TeamSkill {
  id: string
  /** Context supplied by the desktop from the route; not present on the wire object. */
  team_id: string
  slug: string
  title: string
  summary: string
  tags: string[]
  version: number
  versions_count: number
  pinned: boolean
  pinned_at: string | null
  archived: boolean
  archived_at: string | null
  author: TeamMessageSender
  body_bytes: number
  current: TeamSkillCurrent
  created_at: string
  updated_at: string
  permissions: TeamSkillPermissions
}

export interface TeamSkillVersionSummary {
  /** Context supplied by the desktop from the route; neither field is on a version wire object. */
  team_id: string
  skill_id: string
  version: number
  message_id: string
  title: string
  summary: string
  tags: string[]
  change_note: string
  author: TeamMessageSender
  body_bytes: number
  attachments: TeamAttachment[]
  created_at: string
}

export interface TeamSkillVersion extends TeamSkillVersionSummary {
  body_format: TeamNetworkBodyFormat
  body: string
}

export interface TeamSkillDetails extends TeamSkill {
  body_format: TeamNetworkBodyFormat
  body: string
  attachments: TeamAttachment[]
}

export interface TeamSkillPage {
  skills: TeamSkill[]
}

export interface TeamSkillVersionsPage {
  skill_id: string
  versions: TeamSkillVersionSummary[]
}

export interface TeamSkillQuery {
  teamId: string
  includeArchived?: boolean
  slug?: string
}

export interface TeamSkillVersionsQuery {
  teamId: string
  skillId: string
}

export interface TeamSkillPinInput {
  teamId: string
  skillId: string
  pinned: boolean
  idempotencyKey: string
}

export interface TeamSkillArchiveInput {
  teamId: string
  skillId: string
  archived: boolean
  idempotencyKey: string
}

/** Subjects remain a sibling capability so older exact-key parsers stay compatible. */
export function parseTeamMailSubjectsCapability(value: unknown): TeamMailSubjectsCapability {
  const item = strictRecord(value, 'Team Mail subjects capability', ['available', 'version', 'max_subject_chars'])
  if (item.available !== true || item.version !== 1 || item.max_subject_chars !== 160) {
    throw invalidContract('Team Mail subjects capability')
  }
  return { available: true, version: 1, max_subject_chars: 160 }
}

export function parseTeamMailThreadsCapability(value: unknown): TeamMailThreadsCapability {
  const item = strictRecord(value, 'Team Mail threads capability', ['available', 'version', 'max_page_items', 'max_thread_items'])
  if (item.available !== true || item.version !== 1 || item.max_page_items !== 25 || item.max_thread_items !== 2048) {
    throw invalidContract('Team Mail threads capability')
  }
  return { available: true, version: 1, max_page_items: 25, max_thread_items: 2048 }
}

export function parseTeamMailboxStateCapability(value: unknown): TeamMailboxStateCapability {
  const item = strictRecord(value, 'Team mailbox state capability', ['available', 'version', 'address_kinds'])
  if (item.available !== true || item.version !== 1 || !exactStringArray(item.address_kinds, ['server'])) {
    throw invalidContract('Team mailbox state capability')
  }
  return { available: true, version: 1, address_kinds: ['server'] }
}

function parseTeamMailboxState(value: unknown): TeamMailboxState {
  const item = strictRecord(value, 'Team mailbox state', ['address_kind', 'address_id', 'unread', 'version'])
  if (item.address_kind !== 'server' || typeof item.unread !== 'boolean') throw invalidContract('Team mailbox state')
  return { address_kind: 'server', address_id: opaqueId(item.address_id, 'Team mailbox'), unread: item.unread,
    version: integer(item.version, 'Team mailbox state version', 0, Number.MAX_SAFE_INTEGER) }
}

export function parseTeamMailboxStateResponse(value: unknown): TeamMailboxStateResult {
  const item = strictRecord(value, 'Team mailbox state result', ['message_id', 'mailbox_state', 'recipients'])
  const state = parseTeamMailboxState(item.mailbox_state)
  const receipt = parseTeamMessageReceiptResponse({ message_id: item.message_id, recipients: item.recipients })
  if (receipt.recipients.length !== 1 || receipt.recipients[0].kind !== 'server'
    || receipt.recipients[0].id !== state.address_id || !state.unread && receipt.recipients[0].state !== 'read') {
    throw invalidContract('Team mailbox state receipt')
  }
  return { ...receipt, mailbox_state: state }
}

export function parseTeamMailboxStateInput(value: unknown): TeamMailboxStateInput {
  const item = strictInputRecord(value, 'Team mailbox state', ['teamId', 'messageId', 'addressKind', 'addressId', 'unread', 'expectedVersion', 'idempotencyKey'])
  if (item.addressKind !== 'server' || typeof item.unread !== 'boolean') throw new Error('Choose an owned server mailbox.')
  return { teamId: opaqueId(item.teamId, 'team'), messageId: opaqueId(item.messageId, 'Team Message'),
    addressKind: 'server', addressId: opaqueId(item.addressId, 'Team mailbox'), unread: item.unread,
    expectedVersion: integer(item.expectedVersion, 'Team mailbox state version', 0, Number.MAX_SAFE_INTEGER - 1),
    idempotencyKey: idempotencyKey(item.idempotencyKey) }
}

/** Parse the exact additive Team Messages V1 Hub capability. */
export function parseTeamMessagesCapability(value: unknown): TeamMessagesCapability {
  const item = strictRecord(value, 'Team Messages capability', [
    'available', 'version', 'kinds', 'recipient_kinds', 'max_body_bytes',
    'max_recipients_per_message', 'max_page_items', 'attachments', 'skills'
  ])
  const attachments = strictRecord(item.attachments, 'Team Messages attachment capability', [
    'max_bytes_per_file', 'max_files_per_message', 'max_bytes_per_message',
    'chunk_bytes', 'range_downloads', 'team_quota_bytes'
  ])
  const skills = strictRecord(item.skills, 'Team Messages skill capability', [
    'slug_pattern', 'max_per_team', 'max_versions_per_skill', 'max_tags'
  ])
  if (
    item.available !== true
    || item.version !== 1
    || !exactStringArray(item.kinds, ['message', 'skill'])
    || !exactStringArray(item.recipient_kinds, ['server', 'human', 'all'])
    || attachments.range_downloads !== true
    || skills.slug_pattern !== TEAM_MESSAGES_SKILL_SLUG_PATTERN
  ) throw invalidContract('Team Messages capability')
  const maxBodyBytes = integer(item.max_body_bytes, 'Team Messages maximum body size', 1, TEAM_MESSAGES_MAX_BODY_BYTES)
  const maxRecipients = integer(
    item.max_recipients_per_message,
    'Team Messages maximum recipients',
    1,
    TEAM_MESSAGES_MAX_RECIPIENTS
  )
  const maxBytesPerFile = integer(
    attachments.max_bytes_per_file,
    'Team Messages maximum attachment size',
    1,
    TEAM_MESSAGES_MAX_ATTACHMENT_BYTES
  )
  const maxFiles = integer(
    attachments.max_files_per_message,
    'Team Messages maximum attachment count',
    1,
    TEAM_MESSAGES_MAX_ATTACHMENTS
  )
  const maxBytesPerMessage = integer(
    attachments.max_bytes_per_message,
    'Team Messages maximum total attachment size',
    1,
    TEAM_MESSAGES_MAX_TOTAL_ATTACHMENT_BYTES
  )
  const chunkBytes = integer(
    attachments.chunk_bytes,
    'Team Messages attachment chunk size',
    1,
    TEAM_MESSAGES_ATTACHMENT_CHUNK_BYTES
  )
  const teamQuotaBytes = clampedWireInteger(
    attachments.team_quota_bytes,
    'Team Messages team attachment quota',
    1,
    TEAM_MESSAGES_MAX_QUOTA_WIRE_BYTES
  )
  return {
    available: true,
    version: 1,
    kinds: ['message', 'skill'],
    recipient_kinds: ['server', 'human', 'all'],
    max_body_bytes: maxBodyBytes,
    max_recipients_per_message: maxRecipients,
    max_page_items: integer(item.max_page_items, 'Team Messages maximum page size', 1, TEAM_NETWORK_MAX_PAGE_ITEMS),
    attachments: {
      max_bytes_per_file: maxBytesPerFile,
      max_files_per_message: maxFiles,
      max_bytes_per_message: maxBytesPerMessage,
      chunk_bytes: chunkBytes,
      range_downloads: true,
      team_quota_bytes: teamQuotaBytes
    },
    skills: {
      slug_pattern: TEAM_MESSAGES_SKILL_SLUG_PATTERN,
      max_per_team: integer(skills.max_per_team, 'Team Messages maximum skills', 1, 500),
      max_versions_per_skill: integer(
        skills.max_versions_per_skill,
        'Team Messages maximum skill versions',
        1,
        200
      ),
      max_tags: integer(skills.max_tags, 'Team Messages maximum skill tags', 0, 8)
    }
  }
}

/** Parse the exact AgentsServer helper advertisement without widening the Hub capability. */
export function parseAgentTeamMessagesCapability(value: unknown): AgentTeamMessagesCapability {
  const item = strictRecord(value, 'Agent Team Messages capability', [
    'available', 'required', 'message', 'action', 'version', 'helper', 'mention_sigil',
    'read_always', 'send_requires_mention', 'recipient_kinds', 'reference_kinds',
    'max_sends_per_run', 'max_attachments_per_send', 'max_body_bytes'
  ], ['required', 'message', 'action'])
  if (
    typeof item.available !== 'boolean'
    || item.required !== undefined && typeof item.required !== 'boolean'
    || item.message !== undefined && typeof item.message !== 'string'
    || typeof item.message === 'string' && item.message.length > 400
    || item.action !== undefined && item.action !== null && typeof item.action !== 'string'
    || typeof item.action === 'string' && item.action.length > 120
    || item.version !== 1
    || item.helper !== 'team'
    || item.mention_sigil !== '@@'
    || item.read_always !== true
    || item.send_requires_mention !== true
    || !exactStringArray(item.recipient_kinds, ['server', 'human', 'all'])
    || !exactStringArray(item.reference_kinds, ['recipient', 'skill'])
  ) throw invalidContract('Agent Team Messages capability')
  return {
    available: item.available,
    ...(typeof item.required === 'boolean' ? { required: item.required } : {}),
    ...(typeof item.message === 'string' ? { message: item.message } : {}),
    ...(item.action === null || typeof item.action === 'string' ? { action: item.action } : {}),
    version: 1,
    helper: 'team',
    mention_sigil: '@@',
    read_always: true,
    send_requires_mention: true,
    recipient_kinds: ['server', 'human', 'all'],
    reference_kinds: ['recipient', 'skill'],
    max_sends_per_run: integer(item.max_sends_per_run, 'Agent Team Messages maximum sends', 1, 4),
    max_attachments_per_send: integer(
      item.max_attachments_per_send,
      'Agent Team Messages maximum attachments',
      1,
      TEAM_MESSAGES_MAX_ATTACHMENTS
    ),
    max_body_bytes: integer(
      item.max_body_bytes,
      'Agent Team Messages maximum body size',
      1,
      TEAM_MESSAGES_MAX_BODY_BYTES
    )
  }
}

/** Parse the exact AgentsServer advertisement for its canonical team-wide alias. */
export function parseTeamBulletinAliasCapability(value: unknown): TeamBulletinAliasCapability {
  const fail = (): never => { throw new Error('AgentsServer returned an invalid Team Bulletin alias capability.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const item = value as Record<string, unknown>
  const allowed = new Set(['available', 'required', 'version', 'mention', 'legacy_mention'])
  if (
    Object.keys(item).some(key => !allowed.has(key))
    || !Object.hasOwn(item, 'available')
    || !Object.hasOwn(item, 'version')
    || !Object.hasOwn(item, 'mention')
    || !Object.hasOwn(item, 'legacy_mention')
    || typeof item.available !== 'boolean'
    || item.required !== undefined && typeof item.required !== 'boolean'
    || item.version !== 1
    || item.mention !== '@@bulletin'
    || item.legacy_mention !== '@@all'
  ) fail()
  return {
    available: item.available as boolean,
    ...(typeof item.required === 'boolean' ? { required: item.required } : {}),
    version: 1,
    mention: '@@bulletin',
    legacy_mention: '@@all'
  }
}

/** Fail closed unless the health snapshot carries the exact parsed alias contract. */
export function teamBulletinAliasAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.team_bulletin_alias_v1
  return capability?.available === true
    && capability.version === 1
    && capability.mention === '@@bulletin'
    && capability.legacy_mention === '@@all'
}

export function parseTeamAllServersAliasCapability(value: unknown): TeamAllServersAliasCapability {
  const item = strictRecord(value, 'Team all-servers alias capability', [
    'available', 'version', 'mention', 'recipient_kind', 'max_recipients_per_message'
  ])
  if (typeof item.available !== 'boolean' || item.version !== 1 || item.mention !== '@@all'
    || item.recipient_kind !== 'all_servers') throw invalidContract('Team all-servers alias capability')
  return { available: item.available, version: 1, mention: '@@all', recipient_kind: 'all_servers',
    max_recipients_per_message: integer(item.max_recipients_per_message, 'Team all-servers maximum recipients', 1, TEAM_MESSAGES_MAX_ALL_SERVERS_RECIPIENTS) }
}

export function teamAllServersAliasAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.team_all_servers_alias_v1
  return capability?.available === true && capability.version === 1 && capability.mention === '@@all'
    && capability.recipient_kind === 'all_servers'
    && Number.isInteger(capability.max_recipients_per_message)
    && capability.max_recipients_per_message > 0
    && capability.max_recipients_per_message <= TEAM_MESSAGES_MAX_ALL_SERVERS_RECIPIENTS
}

export function parseTeamMessagePage(value: unknown, teamIdValue: string): TeamMessagePage {
  const teamId = opaqueId(teamIdValue, 'team')
  const item = strictRecord(value, 'Team Messages response', [
    'box', 'address', 'messages', 'next_after_sequence', 'has_more', 'mailbox_coverage'
  ], ['mailbox_coverage'])
  if (item.box !== 'inbox' && item.box !== 'feed' && item.box !== 'sent') {
    throw invalidContract('Team Messages box')
  }
  const address = item.address == null ? null : parseTeamMessageAddress(item.address)
  if ((item.box === 'inbox') !== (address !== null)) throw invalidContract('Team Messages address')
  const messages = boundedArray(item.messages, 'Team Messages', TEAM_NETWORK_MAX_PAGE_ITEMS)
    .map(value => parseTeamMessageSummary(value, teamId, item.box as TeamMessageBox))
  const nextAfterSequence = integer(
    item.next_after_sequence,
    'next Team Message sequence',
    0,
    Number.MAX_SAFE_INTEGER
  )
  const hasMore = booleanValue(item.has_more, 'Team Messages continuation')
  const coverage = item.mailbox_coverage === undefined ? undefined : parseMailboxCoverage(item.mailbox_coverage)
  if (coverage && (item.box !== 'inbox' || address?.kind !== 'server'
    || coverage.team_id !== teamId || coverage.recipient_server_id !== address.id
    || coverage.through_sequence < nextAfterSequence
    || (hasMore && coverage.through_sequence !== nextAfterSequence))) throw invalidContract('Team Mail coverage')
  return {
    box: item.box,
    address,
    messages,
    next_after_sequence: nextAfterSequence,
    has_more: hasMore,
    ...(coverage ? { mailbox_coverage: coverage } : {})
  }
}

export function parseTeamMessageResponse(value: unknown, teamIdValue: string): { message: TeamMessage } {
  const item = strictRecord(value, 'Team Message response', ['message'])
  return { message: parseTeamMessage(item.message, opaqueId(teamIdValue, 'team')) }
}

export function parseTeamMessageThreadQuery(value: unknown): Required<TeamMessageThreadQuery> {
  const item = strictInputRecord(value, 'Team Mail thread query', ['teamId', 'messageId', 'afterSequence', 'limit'], ['afterSequence', 'limit'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    messageId: opaqueId(item.messageId, 'Team Message'),
    afterSequence: optionalInteger(item.afterSequence, 'Team Mail thread cursor', 0, Number.MAX_SAFE_INTEGER, 0),
    limit: optionalInteger(item.limit, 'Team Mail thread page size', 1, 25, 25)
  }
}

export function parseTeamMessageThreadPage(value: unknown, queryValue: TeamMessageThreadQuery): TeamMessageThreadPage {
  const query = parseTeamMessageThreadQuery(queryValue)
  const item = strictRecord(value, 'Team Mail thread', ['team_id', 'anchor_message_id', 'root_message_id', 'messages', 'next_after_sequence', 'has_more', 'truncated'])
  if (item.team_id !== query.teamId || item.anchor_message_id !== query.messageId) throw invalidContract('Team Mail thread identity')
  const root = opaqueId(item.root_message_id, 'Team Mail thread root')
  const messages = boundedArray(item.messages, 'Team Mail thread messages', query.limit).map(value => parseTeamMessage(value, query.teamId))
  const ids = new Set<string>()
  let sequence = query.afterSequence
  for (const message of messages) {
    if (ids.has(message.id) || message.sequence <= sequence || message.kind !== 'message' || message.skill
      || message.recipients.some(recipient => recipient.kind === 'all')) throw invalidContract('Team Mail thread message')
    ids.add(message.id)
    sequence = message.sequence
  }
  const next = integer(item.next_after_sequence, 'Team Mail thread next cursor', query.afterSequence, Number.MAX_SAFE_INTEGER)
  const more = booleanValue(item.has_more, 'Team Mail thread continuation')
  if (next !== sequence || more && !messages.length) throw invalidContract('Team Mail thread cursor')
  return {
    team_id: query.teamId, anchor_message_id: query.messageId, root_message_id: root, messages,
    next_after_sequence: next, has_more: more, truncated: booleanValue(item.truncated, 'Team Mail thread completeness')
  }
}

export function parseTeamMessageReceiptResponse(value: unknown): TeamMessageReceiptResult {
  const item = strictRecord(value, 'Team Message receipt response', ['message_id', 'recipients'])
  const recipients = boundedArray(
    item.recipients,
    'Team Message receipt recipients',
    TEAM_MESSAGES_MAX_RECIPIENTS
  ).map(parseTeamRecipient)
  if (!recipients.length || recipients.some(recipient => recipient.kind === 'all')) {
    throw invalidContract('Team Message receipt')
  }
  return { message_id: opaqueId(item.message_id, 'Team Message'), recipients }
}

export function parseTeamMessageDeleteResponse(value: unknown): TeamMessageDeleteResult {
  const item = strictRecord(value, 'Team Message delete response', ['deleted', 'message_id'])
  if (item.deleted !== true) throw invalidContract('Team Message delete response')
  return { deleted: true, message_id: opaqueId(item.message_id, 'Team Message') }
}

export function parseTeamMessageDismissResponse(value: unknown): TeamMessageDismissResult {
  const item = strictRecord(value, 'Team Message removal', ['dismissed', 'message_id', 'address'])
  if (item.dismissed !== true) throw invalidContract('Team Message removal')
  return { dismissed: true, message_id: opaqueId(item.message_id, 'Team Message'), address: parseMessageAddress(item.address) }
}

export function parseTeamMessageHistory(value: unknown): TeamMessageHistory {
  const item = strictRecord(value, 'Team Message history', ['message_id', 'versions'])
  return {
    message_id: opaqueId(item.message_id, 'Team Message'),
    versions: boundedArray(item.versions, 'Team Message history', 200).map(value => {
      const row = strictRecord(value, 'Team Message version', ['version', 'body_format', 'body_bytes', 'body_sha256', 'editor', 'created_at', 'preview', 'body'], ['preview', 'body'])
      if ((row.body === undefined) === (row.preview === undefined)) throw invalidContract('Team Message history body')
      const bytes = integer(row.body_bytes, 'Team Message version size', 1, TEAM_MESSAGES_MAX_BODY_BYTES)
      sha256Hex(row.body_sha256, 'Team Message version hash')
      if (row.body !== undefined && (typeof row.body !== 'string' || Buffer.byteLength(row.body, 'utf8') !== bytes)) throw invalidContract('Team Message version body size')
      return {
        version: integer(row.version, 'Team Message version', 1, 200),
        body_format: inputBodyFormat(row.body_format),
        ...(row.body === undefined ? { preview: responsePreview(row.preview) } : { body: responseBody(row.body, 'Team Message version', TEAM_MESSAGES_MAX_BODY_BYTES) }),
        editor: parseTeamMessageSender(row.editor),
        created_at: timestamp(row.created_at, 'Team Message version time')
      }
    })
  }
}

export function parseTeamAttachmentDeclaration(value: unknown, teamIdValue: string): TeamAttachmentDeclaration {
  const item = strictRecord(value, 'Team attachment declaration', ['attachment', 'chunk_bytes'])
  const attachment = parseTeamAttachment(item.attachment, opaqueId(teamIdValue, 'team'))
  if (attachment.message_id !== null || attachment.state === 'failed') {
    throw invalidContract('Team attachment declaration')
  }
  return {
    attachment,
    chunk_bytes: integer(item.chunk_bytes, 'Team attachment chunk size', 1, TEAM_MESSAGES_ATTACHMENT_CHUNK_BYTES)
  }
}

export function parseTeamAttachmentResponse(value: unknown, teamIdValue: string): { attachment: TeamAttachment } {
  const item = strictRecord(value, 'Team attachment response', ['attachment'])
  return { attachment: parseTeamAttachment(item.attachment, opaqueId(teamIdValue, 'team')) }
}

export function parseTeamSkillPage(value: unknown, teamIdValue: string): TeamSkillPage {
  const teamId = opaqueId(teamIdValue, 'team')
  const item = strictRecord(value, 'Team Skills response', ['skills'])
  return { skills: boundedArray(item.skills, 'Team Skills', 500).map(value => parseTeamSkill(value, teamId)) }
}

export function parseTeamSkillDetails(value: unknown, teamIdValue: string): { skill: TeamSkillDetails } {
  const item = strictRecord(value, 'Team Skill response', ['skill'])
  return { skill: parseTeamSkillDetailsRecord(item.skill, opaqueId(teamIdValue, 'team')) }
}

export function parseTeamSkillVersionsPage(value: unknown, teamIdValue: string): TeamSkillVersionsPage {
  const teamId = opaqueId(teamIdValue, 'team')
  const item = strictRecord(value, 'Team Skill versions response', ['skill_id', 'versions'])
  const skillId = opaqueId(item.skill_id, 'Team Skill')
  return {
    skill_id: skillId,
    versions: boundedArray(item.versions, 'Team Skill versions', 200)
      .map(value => parseTeamSkillVersionSummary(value, teamId, skillId))
  }
}

export function parseTeamSkillVersionResponse(
  value: unknown,
  teamIdValue: string
): { skill_id: string; version: TeamSkillVersion } {
  const teamId = opaqueId(teamIdValue, 'team')
  const item = strictRecord(value, 'Team Skill version response', ['skill_id', 'version'])
  const skillId = opaqueId(item.skill_id, 'Team Skill')
  return { skill_id: skillId, version: parseTeamSkillVersion(item.version, teamId, skillId) }
}

export function parseTeamSkillResponse(value: unknown, teamIdValue: string): { skill: TeamSkill } {
  const item = strictRecord(value, 'Team Skill mutation response', ['skill'])
  return { skill: parseTeamSkill(item.skill, opaqueId(teamIdValue, 'team')) }
}

export function parseTeamMessageQuery(value: unknown): Required<Pick<TeamMessageQuery, 'teamId' | 'box' | 'unread' | 'afterSequence' | 'limit'>> & Omit<TeamMessageQuery, 'teamId' | 'box' | 'unread' | 'afterSequence' | 'limit'> {
  const item = strictInputRecord(value, 'Team Messages query', [
    'teamId', 'box', 'addressKind', 'addressId', 'unread', 'fromKind', 'fromId',
    'since', 'afterSequence', 'limit', 'includeMailboxCoverage', 'afterArrivalId'
  ], ['addressKind', 'addressId', 'unread', 'fromKind', 'fromId', 'since', 'afterSequence', 'limit', 'includeMailboxCoverage', 'afterArrivalId'])
  if (item.box !== 'inbox' && item.box !== 'feed' && item.box !== 'sent') {
    throw new Error('Team Messages box is invalid.')
  }
  const addressKind = optionalSenderOrAddressKind(item.addressKind, 'recipient')
  const addressId = item.addressId === undefined ? undefined : opaqueId(item.addressId, 'Team Messages address')
  if (item.box === 'inbox' ? !addressKind || !addressId : addressKind !== undefined || addressId !== undefined) {
    throw new Error('Team Messages inbox address is invalid.')
  }
  const fromKind = optionalSenderOrAddressKind(item.fromKind, 'sender')
  const fromId = item.fromId === undefined ? undefined : opaqueId(item.fromId, 'Team Messages sender')
  if ((fromKind === undefined) !== (fromId === undefined)) throw new Error('Team Messages sender filter is invalid.')
  const afterSequence = optionalInteger(item.afterSequence, 'Team Messages sequence', 0, Number.MAX_SAFE_INTEGER, 0)
  const includeMailboxCoverage = item.includeMailboxCoverage === undefined ? undefined : inputBoolean(item.includeMailboxCoverage, 'Team Mail coverage')
  if (includeMailboxCoverage) {
    if (item.box !== 'inbox' || addressKind !== 'server' || item.unread === true || fromKind || item.since !== undefined) {
      throw new Error('Team Mail coverage requires an unfiltered server inbox.')
    }
    parseMailArrivalCursor({ through_sequence: afterSequence, arrival_id: item.afterArrivalId ?? null })
  } else if (item.afterArrivalId !== undefined) throw new Error('Team Mail arrival anchor requires coverage.')
  return {
    teamId: opaqueId(item.teamId, 'team'),
    box: item.box,
    ...(addressKind ? { addressKind } : {}),
    ...(addressId ? { addressId } : {}),
    unread: item.unread === undefined ? false : inputBoolean(item.unread, 'Team Messages unread filter'),
    ...(fromKind ? { fromKind } : {}),
    ...(fromId ? { fromId } : {}),
    ...(item.since === undefined ? {} : { since: inputTimestamp(item.since, 'Team Messages since filter') }),
    afterSequence,
    ...(includeMailboxCoverage === undefined ? {} : { includeMailboxCoverage }),
    ...(item.afterArrivalId === undefined ? {} : { afterArrivalId: item.afterArrivalId as string }),
    limit: optionalInteger(item.limit, 'Team Messages page size', 1, TEAM_NETWORK_MAX_PAGE_ITEMS, TEAM_NETWORK_DEFAULT_PAGE_ITEMS)
  }
}

export function parseTeamMessageCreateInput(value: unknown): TeamMessageCreateInput & {
  bodyFormat: TeamNetworkBodyFormat
  attachmentIds: string[]
  inReplyToMessageId?: string
} {
  const item = strictInputRecord(value, 'Team Message', [
    'teamId', 'kind', 'title', 'body', 'bodyFormat', 'recipients', 'attachmentIds',
    'inReplyToMessageId', 'skill', 'provenance', 'idempotencyKey'
  ], ['title', 'bodyFormat', 'attachmentIds', 'inReplyToMessageId', 'skill', 'provenance'])
  if (item.kind !== 'message' && item.kind !== 'skill') throw new Error('Team Message kind is invalid.')
  const title = item.title === undefined ? undefined : item.kind === 'message'
    ? inputMailSubject(item.title)
    : inputText(item.title, 'Team Message title', 160, false)
  const skill = item.skill === undefined ? undefined : parseTeamMessageSkillInput(item.skill)
  if (
    (item.kind === 'skill' && (!title || !skill))
    || (item.kind === 'message' && skill !== undefined)
  ) throw new Error('Team Message skill fields are invalid.')
  const recipients = inputArray(item.recipients, 'Team Message recipients', 1, TEAM_MESSAGES_MAX_RECIPIENTS)
    .map(parseTeamMessageRecipientInput)
  const recipientKeys = recipients.map(recipient => `${recipient.kind}:${recipient.id ?? ''}`)
  if (new Set(recipientKeys).size !== recipientKeys.length) throw new Error('Team Message recipients contain duplicates.')
  const hasAll = recipients.some(recipient => recipient.kind === 'all')
  const hasAllServers = recipients.some(recipient => recipient.kind === 'all_servers')
  if (((hasAll || hasAllServers) && recipients.length !== 1) || (item.kind === 'skill' && !hasAll)) {
    throw new Error('Team Message recipients are invalid.')
  }
  const attachmentIds = item.attachmentIds === undefined
    ? []
    : inputArray(item.attachmentIds, 'Team Message attachments', 0, TEAM_MESSAGES_MAX_ATTACHMENTS)
      .map(value => opaqueId(value, 'Team attachment'))
  if (new Set(attachmentIds).size !== attachmentIds.length) throw new Error('Team Message attachments contain duplicates.')
  return {
    teamId: opaqueId(item.teamId, 'team'),
    kind: item.kind,
    ...(title ? { title } : {}),
    body: inputBody(item.body, 'Team Message', TEAM_MESSAGES_MAX_BODY_BYTES),
    bodyFormat: item.bodyFormat === undefined ? 'markdown' : inputBodyFormat(item.bodyFormat),
    recipients,
    attachmentIds,
    ...(item.inReplyToMessageId === undefined
      ? {}
      : { inReplyToMessageId: opaqueId(item.inReplyToMessageId, 'Team Message reply') }),
    ...(skill ? { skill } : {}),
    ...(item.provenance === undefined ? {} : { provenance: parseTeamMessageProvenanceInput(item.provenance) }),
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

export function parseTeamMessageReceiptInput(value: unknown): TeamMessageReceiptInput {
  const item = strictInputRecord(value, 'Team Message receipt', ['teamId', 'messageId', 'state', 'idempotencyKey', 'addressKind', 'addressId'], ['addressKind', 'addressId'])
  if (item.state !== 'delivered' && item.state !== 'read') throw new Error('Team Message receipt state is invalid.')
  if ((item.addressKind === undefined) !== (item.addressId === undefined)) throw new Error('Choose the mailbox for this receipt.')
  const address = item.addressKind === undefined ? null : parseMessageAddress({ kind: item.addressKind, id: item.addressId })
  return {
    teamId: opaqueId(item.teamId, 'team'),
    messageId: opaqueId(item.messageId, 'Team Message'),
    state: item.state,
    ...(address ? { addressKind: address.kind, addressId: address.id } : {}),
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

export function parseTeamMessageDismissInput(value: unknown): TeamMessageDismissInput {
  const item = strictInputRecord(value, 'Team Message removal', ['teamId', 'messageId', 'addressKind', 'addressId', 'idempotencyKey'])
  const address = parseMessageAddress({ kind: item.addressKind, id: item.addressId })
  return { teamId: opaqueId(item.teamId, 'team'), messageId: opaqueId(item.messageId, 'Team Message'),
    addressKind: address.kind, addressId: address.id, idempotencyKey: idempotencyKey(item.idempotencyKey) }
}

export function parseTeamMessageDeleteInput(value: unknown): TeamMessageDeleteInput {
  const item = strictInputRecord(value, 'Team Message delete', ['teamId', 'messageId', 'idempotencyKey'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    messageId: opaqueId(item.messageId, 'Team Message'),
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

function parseMessageAddress(value: unknown): TeamMessageAddress {
  const address = parseMailboxAddress(value)
  if (address.kind !== 'human' && address.kind !== 'server') throw invalidContract('Team Message mailbox')
  return { kind: address.kind, id: address.id }
}

export function parseTeamMessageRevisionInput(value: unknown): TeamMessageRevisionInput & { bodyFormat: TeamNetworkBodyFormat } {
  const item = strictInputRecord(value, 'Team Message revision', [
    'teamId', 'messageId', 'body', 'bodyFormat', 'expectedVersion', 'idempotencyKey'
  ], ['bodyFormat'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    messageId: opaqueId(item.messageId, 'Team Message'),
    body: inputBody(item.body, 'Team Message revision', TEAM_MESSAGES_MAX_BODY_BYTES),
    bodyFormat: item.bodyFormat === undefined ? 'markdown' : inputBodyFormat(item.bodyFormat),
    expectedVersion: integer(item.expectedVersion, 'Team Message expected version', 1, 200),
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

export function parseTeamAttachmentDeclareInput(value: unknown): TeamAttachmentDeclareInput {
  const item = strictInputRecord(value, 'Team attachment declaration', [
    'teamId', 'path', 'fileName', 'mediaType', 'idempotencyKey'
  ], ['fileName', 'mediaType'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    path: absoluteFilePath(item.path),
    ...(item.fileName === undefined ? {} : { fileName: inputFileName(item.fileName) }),
    ...(item.mediaType === undefined ? {} : { mediaType: inputMediaType(item.mediaType) }),
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

export function parseTeamAttachmentUploadInput(value: unknown): TeamAttachmentUploadInput {
  const item = strictInputRecord(value, 'Team attachment upload', ['teamId', 'attachmentId', 'path'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    attachmentId: opaqueId(item.attachmentId, 'Team attachment'),
    path: absoluteFilePath(item.path)
  }
}

export function parseTeamAttachmentCacheInput(value: unknown): TeamAttachmentCacheInput {
  const item = strictInputRecord(
    value,
    'Team attachment cache request',
    ['teamId', 'attachmentId', 'previewBytes'],
    ['previewBytes']
  )
  return {
    teamId: opaqueId(item.teamId, 'team'),
    attachmentId: opaqueId(item.attachmentId, 'Team attachment'),
    ...(item.previewBytes === undefined ? {} : {
      previewBytes: integer(
        item.previewBytes,
        'Team attachment preview size',
        1,
        TEAM_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES
      )
    })
  }
}

export function parseTeamSkillQuery(value: unknown): Required<Pick<TeamSkillQuery, 'teamId' | 'includeArchived'>> & Pick<TeamSkillQuery, 'slug'> {
  const item = strictInputRecord(value, 'Team Skills query', ['teamId', 'includeArchived', 'slug'], ['includeArchived', 'slug'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    includeArchived: item.includeArchived === undefined ? false : inputBoolean(item.includeArchived, 'include archived'),
    ...(item.slug === undefined ? {} : { slug: inputSkillSlug(item.slug) })
  }
}

export function parseTeamSkillVersionsQuery(value: unknown): TeamSkillVersionsQuery {
  const item = strictInputRecord(value, 'Team Skill versions query', ['teamId', 'skillId'])
  return { teamId: opaqueId(item.teamId, 'team'), skillId: opaqueId(item.skillId, 'Team Skill') }
}

export function parseTeamSkillPinInput(value: unknown): TeamSkillPinInput {
  const item = strictInputRecord(value, 'Team Skill pin', ['teamId', 'skillId', 'pinned', 'idempotencyKey'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    skillId: opaqueId(item.skillId, 'Team Skill'),
    pinned: inputBoolean(item.pinned, 'Team Skill pinned state'),
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

export function parseTeamSkillArchiveInput(value: unknown): TeamSkillArchiveInput {
  const item = strictInputRecord(value, 'Team Skill archive', ['teamId', 'skillId', 'archived', 'idempotencyKey'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    skillId: opaqueId(item.skillId, 'Team Skill'),
    archived: inputBoolean(item.archived, 'Team Skill archived state'),
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

/** Parse the exact advertised V1 capability. Unsupported or widened contracts fail closed. */
export function parseTeamNetworkCapabilities(value: unknown): TeamNetworkCapabilities {
  const item = strictRecord(value, 'Team Network capability', [
    'available', 'version', 'logical_servers', 'agent_registry', 'bulletin', 'mailbox',
    'delivery_receipts', 'passive_requests', 'server_invites', 'skill_attachments',
    'dispatch', 'max_agents_per_server', 'max_page_items', 'max_body_bytes'
  ])
  if (
    item.available !== true
    || item.version !== 1
    || item.logical_servers !== true
    || item.agent_registry !== true
    || item.bulletin !== true
    || item.mailbox !== true
    || item.passive_requests !== true
    || item.server_invites !== false
    || item.skill_attachments !== false
    || item.dispatch !== false
    || !Array.isArray(item.delivery_receipts)
    || item.delivery_receipts.length !== 2
    || item.delivery_receipts[0] !== 'delivered'
    || item.delivery_receipts[1] !== 'read'
  ) throw invalidContract('Team Network capability')
  const maxAgentsPerServer = integer(
    item.max_agents_per_server,
    'maximum agents per server',
    1,
    TEAM_NETWORK_MAX_AGENTS_PER_SERVER
  )
  if (maxAgentsPerServer !== TEAM_NETWORK_MAX_AGENTS_PER_SERVER) {
    throw invalidContract('Team Network capability')
  }
  const maxPageItems = integer(item.max_page_items, 'maximum page size', 1, TEAM_NETWORK_MAX_PAGE_ITEMS)
  const maxBodyBytes = integer(item.max_body_bytes, 'maximum body size', 1, TEAM_NETWORK_MAX_BODY_BYTES)
  return {
    available: true,
    version: 1,
    logical_servers: true,
    agent_registry: true,
    bulletin: true,
    mailbox: true,
    delivery_receipts: ['delivered', 'read'],
    passive_requests: true,
    server_invites: false,
    skill_attachments: false,
    dispatch: false,
    max_agents_per_server: TEAM_NETWORK_MAX_AGENTS_PER_SERVER,
    max_page_items: maxPageItems,
    max_body_bytes: maxBodyBytes
  }
}

export function parseTeamNetworkProjection(value: unknown): TeamNetworkProjectionPage {
  const item = strictRecord(value, 'Team Network response', [
    'network', 'servers', 'agents', 'next_after_server_id', 'has_more'
  ])
  const identity = strictRecord(item.network, 'Team Network identity', ['id', 'display_name', 'hub_id'])
  const servers = boundedArray(item.servers, 'servers').map(parseServer)
  const nextAfterServerId = nullableId(item.next_after_server_id, 'next server')
  const hasMore = booleanValue(item.has_more, 'Team Network continuation')
  const lastServerId = servers.at(-1)?.id ?? null
  if (
    (lastServerId === null && (nextAfterServerId !== null || hasMore))
    || (lastServerId !== null && nextAfterServerId !== lastServerId)
  ) throw invalidContract('Team Network continuation')
  return {
    network: {
      id: opaqueId(identity.id, 'network'),
      display_name: displayName(identity.display_name, 'network'),
      hub_id: opaqueId(identity.hub_id, 'Hub')
    },
    // Pages are grouped by logical server and never split one server's agents.
    // The HTTP client also rejects a response above its byte ceiling before
    // this structural parser runs.
    servers,
    agents: boundedArray(
      item.agents,
      'agents',
      TEAM_NETWORK_MAX_PAGE_ITEMS * TEAM_NETWORK_MAX_AGENTS_PER_SERVER
    ).map(parseAgent),
    next_after_server_id: nextAfterServerId,
    has_more: hasMore
  }
}

export function parseTeamNetworkAgentResponse(value: unknown): { agent: TeamNetworkAgent } {
  const item = strictRecord(value, 'agent response', ['agent'])
  return { agent: parseAgent(item.agent) }
}

export function parseTeamNetworkBulletinPage(value: unknown): TeamNetworkBulletinPage {
  const item = strictRecord(value, 'Bulletin response', ['posts', 'next_after_sequence', 'has_more'])
  return {
    posts: boundedArray(item.posts, 'Bulletin posts').map(parseBulletinPost),
    next_after_sequence: integer(item.next_after_sequence, 'next Bulletin sequence', 0, Number.MAX_SAFE_INTEGER),
    has_more: booleanValue(item.has_more, 'Bulletin continuation')
  }
}

export function parseTeamNetworkBulletinPostResponse(value: unknown): { post: TeamNetworkBulletinPost } {
  const item = strictRecord(value, 'Bulletin post response', ['post'])
  return { post: parseBulletinPost(item.post) }
}

export function parseTeamNetworkBulletinDeleteResponse(value: unknown): TeamNetworkDeleteBulletinResult {
  const item = strictRecord(value, 'Bulletin delete response', ['deleted', 'post_id'])
  if (item.deleted !== true) throw invalidContract('Bulletin delete response')
  return { deleted: true, post_id: opaqueId(item.post_id, 'Bulletin post') }
}

export function parseTeamNetworkDeletionPage(value: unknown): TeamNetworkDeletionPage {
  const item = strictRecord(value, 'Team Network deletion response', [
    'deletions', 'next_after_sequence', 'has_more'
  ])
  const deletions = boundedArray(item.deletions, 'Team Network deletions', TEAM_NETWORK_MAX_PAGE_ITEMS)
    .map(value => {
      const deletion = strictRecord(value, 'Team Network deletion', [
        'sequence', 'kind', 'id', 'deleted_at'
      ])
      if (deletion.kind !== 'message' && deletion.kind !== 'bulletin') {
        throw invalidContract('Team Network deletion kind')
      }
      const kind: TeamNetworkDeletion['kind'] = deletion.kind
      return {
        sequence: integer(deletion.sequence, 'Team Network deletion sequence', 1, Number.MAX_SAFE_INTEGER),
        kind,
        id: opaqueId(deletion.id, 'deleted Team Network item'),
        deleted_at: timestamp(deletion.deleted_at, 'Team Network deletion time')
      }
    })
  const nextAfterSequence = integer(
    item.next_after_sequence,
    'next Team Network deletion sequence',
    0,
    Number.MAX_SAFE_INTEGER
  )
  if (deletions.some((deletion, index) => (
    deletion.sequence <= (index === 0 ? 0 : deletions[index - 1]!.sequence)
    || deletion.sequence > nextAfterSequence
  ))) throw invalidContract('Team Network deletion ordering')
  return {
    deletions,
    next_after_sequence: nextAfterSequence,
    has_more: booleanValue(item.has_more, 'Team Network deletion continuation')
  }
}

export function parseTeamNetworkMailboxEntry(value: unknown): TeamNetworkMailboxEntry {
  const item = strictRecord(value, 'mailbox entry', ['item', 'delivery'])
  return { item: parseMailboxItem(item.item), delivery: parseDelivery(item.delivery) }
}

export function parseTeamNetworkMailboxPage(value: unknown): TeamNetworkMailboxPage {
  const item = strictRecord(value, 'mailbox response', ['items', 'next_after_sequence', 'has_more'])
  return {
    items: boundedArray(item.items, 'mailbox items').map(parseTeamNetworkMailboxEntry),
    next_after_sequence: integer(item.next_after_sequence, 'next mailbox sequence', 0, Number.MAX_SAFE_INTEGER),
    has_more: booleanValue(item.has_more, 'mailbox continuation')
  }
}

export function parseTeamNetworkDeliveryResponse(value: unknown): { delivery: TeamNetworkDelivery } {
  const item = strictRecord(value, 'delivery response', ['delivery'])
  return { delivery: parseDelivery(item.delivery) }
}

export function parseTeamNetworkPassiveRequestCreated(value: unknown): TeamNetworkPassiveRequestCreated {
  const item = strictRecord(value, 'passive request response', ['item', 'delivery', 'request'])
  return {
    item: parseMailboxItem(item.item),
    delivery: parseDelivery(item.delivery),
    request: parsePassiveRequest(item.request)
  }
}

export function parseTeamNetworkPassiveRequestDetails(value: unknown): TeamNetworkPassiveRequestDetails {
  const item = strictRecord(value, 'passive request detail', ['item', 'delivery', 'request', 'reply'])
  return {
    item: parseMailboxItem(item.item),
    delivery: parseDelivery(item.delivery),
    request: parsePassiveRequest(item.request),
    reply: item.reply == null ? null : parseTeamNetworkMailboxEntry(item.reply)
  }
}

export function parseTeamNetworkRegisterAgentInput(value: unknown): TeamNetworkRegisterAgentInput {
  const item = strictInputRecord(value, 'Agent registration', ['teamId', 'externalAgentId', 'backend', 'displayName', 'idempotencyKey'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    externalAgentId: opaqueId(item.externalAgentId, 'external agent'),
    backend: agentBackend(item.backend),
    displayName: displayName(item.displayName, 'agent'),
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

export function parseTeamNetworkProjectionQuery(value: unknown): Required<Omit<TeamNetworkProjectionQuery, 'afterServerId'>> & { afterServerId: string | null } {
  const item = strictInputRecord(value, 'Team Network query', ['teamId', 'afterServerId', 'limit'], ['afterServerId', 'limit'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    afterServerId: item.afterServerId === undefined ? null : opaqueId(item.afterServerId, 'server cursor'),
    limit: optionalInteger(item.limit, 'Team Network page size', 1, TEAM_NETWORK_MAX_PAGE_ITEMS, TEAM_NETWORK_DEFAULT_PAGE_ITEMS)
  }
}

export function parseTeamNetworkBulletinQuery(value: unknown): Required<TeamNetworkBulletinQuery> {
  const item = strictInputRecord(value, 'Bulletin query', ['teamId', 'afterSequence', 'limit'], ['afterSequence', 'limit'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    afterSequence: optionalInteger(item.afterSequence, 'Bulletin sequence', 0, Number.MAX_SAFE_INTEGER, 0),
    limit: optionalInteger(item.limit, 'Bulletin page size', 1, TEAM_NETWORK_MAX_PAGE_ITEMS, TEAM_NETWORK_DEFAULT_PAGE_ITEMS)
  }
}

export function parseTeamNetworkPostBulletinInput(value: unknown): Required<Omit<TeamNetworkPostBulletinInput, 'replyToPostId'>> & { replyToPostId: string | null } {
  const item = strictInputRecord(value, 'Bulletin post', ['teamId', 'body', 'bodyFormat', 'replyToPostId', 'idempotencyKey'], ['bodyFormat', 'replyToPostId'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    body: body(item.body, 'Bulletin'),
    bodyFormat: optionalBodyFormat(item.bodyFormat),
    replyToPostId: item.replyToPostId == null ? null : opaqueId(item.replyToPostId, 'Bulletin reply'),
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

export function parseTeamNetworkDeleteBulletinInput(value: unknown): TeamNetworkDeleteBulletinInput {
  const item = strictInputRecord(value, 'Bulletin delete', ['teamId', 'postId', 'idempotencyKey'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    postId: opaqueId(item.postId, 'Bulletin post'),
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

export function parseTeamNetworkDeletionQuery(value: unknown): Required<TeamNetworkDeletionQuery> {
  const item = strictInputRecord(value, 'Team Network deletion query', [
    'teamId', 'afterSequence', 'limit'
  ], ['afterSequence', 'limit'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    afterSequence: optionalInteger(item.afterSequence, 'Team Network deletion sequence', 0, Number.MAX_SAFE_INTEGER, 0),
    limit: optionalInteger(item.limit, 'Team Network deletion page size', 1, TEAM_NETWORK_MAX_PAGE_ITEMS, TEAM_NETWORK_DEFAULT_PAGE_ITEMS)
  }
}

export function parseTeamNetworkMailboxQuery(value: unknown): Required<Omit<TeamNetworkMailboxQuery, 'address'>> & { address: TeamNetworkMailboxAddress } {
  const item = strictInputRecord(value, 'Mailbox query', ['teamId', 'address', 'afterSequence', 'limit'], ['afterSequence', 'limit'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    address: parseMailboxAddress(item.address),
    afterSequence: optionalInteger(item.afterSequence, 'mailbox sequence', 0, Number.MAX_SAFE_INTEGER, 0),
    limit: optionalInteger(item.limit, 'mailbox page size', 1, TEAM_NETWORK_MAX_PAGE_ITEMS, TEAM_NETWORK_DEFAULT_PAGE_ITEMS)
  }
}

export function parseTeamNetworkSendMailboxInput(value: unknown): Required<Omit<TeamNetworkSendMailboxInput, 'fromAgentId'>> & { fromAgentId: string | null } {
  const item = strictInputRecord(value, 'Mailbox message', ['teamId', 'to', 'fromAgentId', 'body', 'bodyFormat', 'idempotencyKey'], ['fromAgentId', 'bodyFormat'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    to: parseInputAddress(item.to),
    fromAgentId: item.fromAgentId == null ? null : opaqueId(item.fromAgentId, 'author agent'),
    body: body(item.body, 'Mailbox'),
    bodyFormat: optionalBodyFormat(item.bodyFormat),
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

export function parseTeamNetworkDeliveryReceiptInput(value: unknown): TeamNetworkDeliveryReceiptInput {
  const item = strictInputRecord(value, 'Delivery receipt', ['teamId', 'deliveryId', 'state', 'idempotencyKey'])
  if (item.state !== 'delivered' && item.state !== 'read') throw new Error('Delivery receipt state is invalid.')
  return {
    teamId: opaqueId(item.teamId, 'team'),
    deliveryId: opaqueId(item.deliveryId, 'delivery'),
    state: item.state,
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

export function parseTeamNetworkCreatePassiveRequestInput(value: unknown): Required<Omit<TeamNetworkCreatePassiveRequestInput, 'fromAgentId'>> & { fromAgentId: string | null } {
  const item = strictInputRecord(value, 'Passive request', [
    'teamId', 'to', 'fromAgentId', 'body', 'bodyFormat', 'idempotencyKey', 'expiresInSeconds'
  ], ['fromAgentId', 'bodyFormat', 'expiresInSeconds'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    to: parseInputAddress(item.to),
    fromAgentId: item.fromAgentId == null ? null : opaqueId(item.fromAgentId, 'author agent'),
    body: body(item.body, 'Passive request'),
    bodyFormat: optionalBodyFormat(item.bodyFormat),
    idempotencyKey: idempotencyKey(item.idempotencyKey),
    expiresInSeconds: optionalInteger(item.expiresInSeconds, 'request expiry', 60, 86_400, 86_400)
  }
}

export function parseTeamNetworkReplyPassiveRequestInput(value: unknown): Required<Omit<TeamNetworkReplyPassiveRequestInput, 'fromAgentId'>> & { fromAgentId: string | null } {
  const item = strictInputRecord(value, 'Passive request reply', [
    'teamId', 'requestId', 'fromAgentId', 'body', 'bodyFormat', 'idempotencyKey'
  ], ['fromAgentId', 'bodyFormat'])
  return {
    teamId: opaqueId(item.teamId, 'team'),
    requestId: opaqueId(item.requestId, 'request'),
    fromAgentId: item.fromAgentId == null ? null : opaqueId(item.fromAgentId, 'author agent'),
    body: body(item.body, 'Passive request reply'),
    bodyFormat: optionalBodyFormat(item.bodyFormat),
    idempotencyKey: idempotencyKey(item.idempotencyKey)
  }
}

export function requireTeamNetworkIdentifier(value: unknown, label: string): string {
  return opaqueId(value, label)
}

export function requireTeamNetworkPageLimit(value: number, maximum: number, label: string): number {
  return integer(value, label, 1, Math.min(maximum, TEAM_NETWORK_MAX_PAGE_ITEMS))
}

export function requireTeamNetworkBodyWithinCapability(value: string, maximum: number, label: string): string {
  const clean = body(value, label)
  if (Buffer.byteLength(clean, 'utf8') > maximum) throw new Error(`${label} is too large for this server.`)
  return clean
}

function parseTeamMessage(value: unknown, teamId: string): TeamMessage {
  const item = parseTeamMessageRecord(value, 'body')
  const common = parseTeamMessageCommon(item, teamId)
  const body = responseBody(item.body, 'Team Message', TEAM_MESSAGES_MAX_BODY_BYTES)
  if (Buffer.byteLength(body, 'utf8') !== common.body_bytes) throw invalidContract('Team Message body size')
  return { ...common, body }
}

function parseTeamMessageSummary(
  value: unknown,
  teamId: string,
  box: TeamMessageBox
): TeamMessageSummary {
  const item = parseTeamMessageRecord(value, 'preview')
  const common = parseTeamMessageCommon(item, teamId)
  if (
    (box === 'inbox' && common.delivery == null)
    || (box !== 'inbox' && item.delivery !== undefined)
  ) throw invalidContract('Team Message delivery')
  return {
    ...common,
    preview: responsePreview(item.preview)
  }
}

function parseTeamMessageRecord(
  value: unknown,
  contentKey: 'body' | 'preview'
): Record<string, unknown> {
  return strictRecord(value, 'Team Message', [
    'id', 'sequence', 'kind', 'title', 'body_format', contentKey, 'body_bytes',
    'body_sha256', 'sender', 'recipients', 'attachments', 'in_reply_to_message_id',
    'skill', 'provenance', 'created_at', 'delivery', 'revision', 'destination', 'mailbox_state'
  ], ['delivery', 'revision', 'destination', 'mailbox_state'])
}

function parseTeamMessageCommon(item: Record<string, unknown>, teamId: string): TeamMessageBase {
  if (item.kind !== 'message' && item.kind !== 'skill') throw invalidContract('Team Message kind')
  if (item.destination !== undefined && item.destination !== 'all_servers') throw invalidContract('Team Message destination')
  const title = nullableResponseText(item.title, 'Team Message title', 160)
  const skill = item.skill == null ? null : parseTeamMessageSkill(item.skill)
  if (
    // Older helpers allowed a bounded display title on ordinary messages.
    // New subjects are negotiated separately; tolerate already-committed
    // legacy titles without poisoning an entire inbox/feed page.
    (item.kind === 'message' && skill !== null)
    || (item.kind === 'skill' && (title === null || skill === null))
  ) {
    throw invalidContract('Team Message skill identity')
  }
  const id = opaqueId(item.id, 'Team Message')
  const attachments = boundedArray(item.attachments, 'Team Message attachments', TEAM_MESSAGES_MAX_ATTACHMENTS)
    .map(value => parseTeamAttachment(value, teamId))
  if (
    attachments.some(attachment => attachment.message_id !== id || attachment.state !== 'ready')
    || attachmentBytes(attachments) > TEAM_MESSAGES_MAX_TOTAL_ATTACHMENT_BYTES
  ) {
    throw invalidContract('Team Message attachments')
  }
  const recipients = boundedArray(item.recipients, 'Team Message recipients', item.destination === 'all_servers'
    ? TEAM_MESSAGES_MAX_ALL_SERVERS_RECIPIENTS : TEAM_MESSAGES_MAX_RECIPIENTS)
    .map(parseTeamRecipient)
  const recipientKeys = recipients.map(recipient => `${recipient.kind}:${recipient.id}`)
  const allRecipient = recipients.some(recipient => recipient.kind === 'all')
  if (
    recipients.length < 1
    || new Set(recipientKeys).size !== recipientKeys.length
    || allRecipient && recipients.length !== 1
    || item.kind === 'skill' && !allRecipient
    || item.destination === 'all_servers' && (item.kind !== 'message' || recipients.some(recipient => recipient.kind !== 'server'))
  ) throw invalidContract('Team Message recipients')
  const delivery = item.delivery == null ? item.delivery === null ? null : undefined : parseTeamRecipient(item.delivery)
  const revision = item.revision === undefined ? undefined : parseTeamMessageRevision(item.revision)
  const mailboxState = item.mailbox_state === undefined ? undefined : parseTeamMailboxState(item.mailbox_state)
  if (mailboxState && (item.kind !== 'message' || delivery?.kind !== 'server' || delivery.id !== mailboxState.address_id)) {
    throw invalidContract('Team mailbox state address')
  }
  if (delivery && (
    delivery.kind === 'all'
    || !recipients.some(recipient => recipient.kind === delivery.kind && recipient.id === delivery.id)
  )) throw invalidContract('Team Message delivery')
  return {
    id,
    ...(item.destination === 'all_servers' ? { destination: 'all_servers' as const } : {}),
    team_id: teamId,
    sequence: integer(item.sequence, 'Team Message sequence', 1, Number.MAX_SAFE_INTEGER),
    kind: item.kind,
    title,
    body_format: bodyFormat(item.body_format),
    body_bytes: integer(item.body_bytes, 'Team Message body size', 1, TEAM_MESSAGES_MAX_BODY_BYTES),
    body_sha256: sha256Hex(item.body_sha256, 'Team Message body hash'),
    sender: parseTeamMessageSender(item.sender),
    provenance: parseTeamMessageProvenance(item.provenance),
    recipients,
    in_reply_to_message_id: nullableId(item.in_reply_to_message_id, 'Team Message reply'),
    skill,
    attachments,
    ...(revision === undefined ? {} : { revision }),
    ...(delivery === undefined ? {} : { delivery }),
    ...(mailboxState === undefined ? {} : { mailbox_state: mailboxState }),
    created_at: timestamp(item.created_at, 'Team Message creation time')
  }
}

function parseTeamMessageRevision(value: unknown): TeamMessageRevision {
  const item = strictRecord(value, 'Team Message revision', [
    'version', 'versions_count', 'edited_at'
  ])
  const version = integer(item.version, 'Team Message version', 1, 200)
  const versionsCount = integer(item.versions_count, 'Team Message version count', version, 200)
  return {
    version,
    versions_count: versionsCount,
    edited_at: item.edited_at == null ? null : timestamp(item.edited_at, 'Team Message edit time')
  }
}

function parseTeamMessageSkill(value: unknown): TeamMessageSkill {
  const item = strictRecord(value, 'Team Message skill', ['id', 'slug', 'version'])
  return {
    id: opaqueId(item.id, 'Team Skill'),
    slug: responseSkillSlug(item.slug),
    version: integer(item.version, 'Team Skill version', 1, 200)
  }
}

function parseTeamMessageAddress(value: unknown): TeamMessageAddress {
  const item = strictRecord(value, 'Team Messages address', ['kind', 'id'])
  if (item.kind !== 'server' && item.kind !== 'human') throw invalidContract('Team Messages address')
  return { kind: item.kind, id: opaqueId(item.id, 'Team Messages address') }
}

function parseTeamMessageSender(value: unknown): TeamMessageSender {
  const item = strictRecord(value, 'Team Message sender', ['kind', 'id', 'display_name'])
  if (item.kind !== 'human' && item.kind !== 'server') throw invalidContract('Team Message sender')
  return {
    kind: item.kind,
    id: opaqueId(item.id, 'Team Message sender'),
    display_name: displayName(item.display_name, 'Team Message sender')
  }
}

function parseTeamRecipient(value: unknown): TeamRecipient {
  const item = strictRecord(value, 'Team Message recipient', [
    'kind', 'id', 'display_name', 'state', 'delivered_at', 'read_at'
  ])
  if (item.kind !== 'server' && item.kind !== 'human' && item.kind !== 'all') {
    throw invalidContract('Team Message recipient')
  }
  const id = opaqueId(item.id, 'Team Message recipient')
  const state = deliveryState(item.state)
  const deliveredAt = nullableTimestamp(item.delivered_at, 'Team Message delivery time')
  const readAt = nullableTimestamp(item.read_at, 'Team Message read time')
  if (
    (item.kind === 'all' && id !== 'all')
    || (state === 'available' && (deliveredAt !== null || readAt !== null))
    || (state === 'delivered' && (deliveredAt === null || readAt !== null))
    || (state === 'read' && (deliveredAt === null || readAt === null))
  ) throw invalidContract('Team Message recipient state')
  return {
    kind: item.kind,
    id,
    display_name: displayName(item.display_name, 'Team Message recipient'),
    state,
    delivered_at: deliveredAt,
    read_at: readAt
  }
}

function parseTeamMessageProvenance(value: unknown): TeamMessageProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidContract('Team Message provenance')
  const item = value as Record<string, unknown>
  const entries = Object.entries(item)
  // beta.33 allowed bounded extension keys in stored provenance. Newer Hubs
  // publish only the stable fields below, but an older valid row must not
  // poison an entire feed page. Validate the old envelope, then retain only
  // fields the desktop understands.
  if (
    entries.length > 8
    || entries.some(([key, field]) => (
      !isWellFormed(key)
      || key.length < 1
      || key.length > 40
      || (field !== null && (
        typeof field !== 'string'
        || !isWellFormed(field)
        || (key !== 'chat_id' && key !== 'run_id' && [...field].length > 200)
      ))
    ))
    || Buffer.byteLength(JSON.stringify(item), 'utf8') > 2_048
  ) throw invalidContract('Team Message provenance')
  const backend = safeProvenanceText(item.backend, 80)
  const chatId = safeProvenanceId(item.chat_id)
  const runId = safeProvenanceId(item.run_id)
  return {
    ...(item.via === 'agent' || item.via === 'desktop' || item.via === null ? { via: item.via } : {}),
    ...(backend === undefined ? {} : { backend }),
    ...(chatId === undefined ? {} : { chat_id: chatId }),
    ...(runId === undefined ? {} : { run_id: runId })
  }
}

function safeProvenanceText(value: unknown, maximum: number): string | null | undefined {
  if (value === null) return null
  if (
    typeof value !== 'string'
    || value.length > maximum
    || !value.trim()
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return undefined
  return value
}

function safeProvenanceId(value: unknown): string | null | undefined {
  if (value === null) return null
  try { return value === undefined ? undefined : nullableId(value, 'Team Message provenance') }
  catch { return undefined }
}

function parseTeamAttachment(value: unknown, teamId: string): TeamAttachment {
  const item = strictRecord(value, 'Team attachment', [
    'id', 'message_id', 'file_name', 'media_type', 'byte_size', 'sha256',
    'state', 'received_bytes', 'created_at', 'ready_at'
  ])
  if (item.state !== 'uploading' && item.state !== 'ready' && item.state !== 'failed') {
    throw invalidContract('Team attachment state')
  }
  const byteSize = integer(item.byte_size, 'Team attachment size', 1, TEAM_MESSAGES_MAX_ATTACHMENT_BYTES)
  const receivedBytes = integer(item.received_bytes, 'Team attachment received size', 0, byteSize)
  const readyAt = nullableTimestamp(item.ready_at, 'Team attachment ready time')
  if (
    (item.state === 'ready') !== (readyAt !== null)
    || (item.state === 'ready') !== (receivedBytes === byteSize)
  ) throw invalidContract('Team attachment ready state')
  return {
    id: opaqueId(item.id, 'Team attachment'),
    team_id: teamId,
    message_id: nullableId(item.message_id, 'Team Message'),
    file_name: responseFileName(item.file_name),
    media_type: responseMediaType(item.media_type),
    byte_size: byteSize,
    sha256: sha256Hex(item.sha256, 'Team attachment hash'),
    state: item.state,
    received_bytes: receivedBytes,
    created_at: timestamp(item.created_at, 'Team attachment creation time'),
    ready_at: readyAt
  }
}

function parseTeamSkill(value: unknown, teamId: string): TeamSkill {
  const item = strictRecord(value, 'Team Skill', [
    'id', 'slug', 'title', 'summary', 'tags', 'version', 'versions_count', 'pinned',
    'pinned_at', 'archived', 'archived_at', 'author', 'body_bytes', 'current',
    'created_at', 'updated_at', 'permissions'
  ])
  return parseTeamSkillRecord(item, teamId)
}

function parseTeamSkillDetailsRecord(value: unknown, teamId: string): TeamSkillDetails {
  const item = strictRecord(value, 'Team Skill', [
    'id', 'slug', 'title', 'summary', 'tags', 'version', 'versions_count', 'pinned',
    'pinned_at', 'archived', 'archived_at', 'author', 'body_bytes', 'current',
    'created_at', 'updated_at', 'permissions', 'body', 'body_format', 'attachments'
  ])
  const skill = parseTeamSkillRecord(item, teamId)
  const body = responseBody(item.body, 'Team Skill', TEAM_MESSAGES_MAX_BODY_BYTES)
  if (Buffer.byteLength(body, 'utf8') !== skill.body_bytes) throw invalidContract('Team Skill body size')
  const attachments = boundedArray(item.attachments, 'Team Skill attachments', TEAM_MESSAGES_MAX_ATTACHMENTS)
    .map(value => parseTeamAttachment(value, teamId))
  if (
    attachments.some(attachment => (
      attachment.message_id !== skill.current.message_id || attachment.state !== 'ready'
    ))
    || attachmentBytes(attachments) > TEAM_MESSAGES_MAX_TOTAL_ATTACHMENT_BYTES
  ) throw invalidContract('Team Skill attachments')
  return { ...skill, body, body_format: bodyFormat(item.body_format), attachments }
}

function parseTeamSkillRecord(item: Record<string, unknown>, teamId: string): TeamSkill {
  const pinnedAt = nullableTimestamp(item.pinned_at, 'Team Skill pin time')
  const archivedAt = nullableTimestamp(item.archived_at, 'Team Skill archive time')
  const pinned = booleanValue(item.pinned, 'Team Skill pinned state')
  const archived = booleanValue(item.archived, 'Team Skill archived state')
  if (
    pinned !== (pinnedAt !== null)
    || archived !== (archivedAt !== null)
    || archived && pinned
  ) {
    throw invalidContract('Team Skill state')
  }
  const version = integer(item.version, 'Team Skill current version', 1, 200)
  const currentItem = strictRecord(item.current, 'Team Skill current version', [
    'version', 'message_id', 'change_note', 'created_at'
  ])
  const current: TeamSkillCurrent = {
    version: integer(currentItem.version, 'Team Skill current version', 1, 200),
    message_id: opaqueId(currentItem.message_id, 'Team Message'),
    change_note: responseText(currentItem.change_note, 'Team Skill change note', 280, true),
    created_at: timestamp(currentItem.created_at, 'Team Skill current version creation time')
  }
  if (current.version !== version) throw invalidContract('Team Skill current version')
  const permissionsItem = strictRecord(item.permissions, 'Team Skill permissions', ['edit', 'manage'])
  const permissions: TeamSkillPermissions = {
    edit: booleanValue(permissionsItem.edit, 'Team Skill edit permission'),
    manage: booleanValue(permissionsItem.manage, 'Team Skill manage permission')
  }
  if ((archived && permissions.edit) || (permissions.edit && !permissions.manage)) {
    throw invalidContract('Team Skill permissions')
  }
  const versionsCount = integer(item.versions_count, 'Team Skill version count', 1, 200)
  if (versionsCount < version) throw invalidContract('Team Skill version count')
  return {
    id: opaqueId(item.id, 'Team Skill'),
    team_id: teamId,
    slug: responseSkillSlug(item.slug),
    title: responseText(item.title, 'Team Skill title', 160, false),
    summary: responseText(item.summary, 'Team Skill summary', 280, true),
    tags: parseTeamSkillTags(item.tags, true),
    version,
    versions_count: versionsCount,
    pinned,
    pinned_at: pinnedAt,
    archived,
    archived_at: archivedAt,
    author: parseTeamMessageSender(item.author),
    body_bytes: integer(item.body_bytes, 'Team Skill body size', 1, TEAM_MESSAGES_MAX_BODY_BYTES),
    current,
    created_at: timestamp(item.created_at, 'Team Skill creation time'),
    updated_at: timestamp(item.updated_at, 'Team Skill update time'),
    permissions
  }
}

function parseTeamSkillVersionSummary(
  value: unknown,
  teamId: string,
  skillId: string
): TeamSkillVersionSummary {
  const item = strictRecord(value, 'Team Skill version', [
    'version', 'message_id', 'title', 'summary', 'tags', 'change_note', 'author',
    'body_bytes', 'attachments', 'created_at'
  ])
  return parseTeamSkillVersionSummaryRecord(item, teamId, skillId)
}

function parseTeamSkillVersion(value: unknown, teamId: string, skillId: string): TeamSkillVersion {
  const item = strictRecord(value, 'Team Skill version', [
    'version', 'message_id', 'title', 'summary', 'tags', 'change_note', 'author',
    'body_bytes', 'attachments', 'created_at', 'body_format', 'body'
  ])
  const summary = parseTeamSkillVersionSummaryRecord(item, teamId, skillId)
  const body = responseBody(item.body, 'Team Skill', TEAM_MESSAGES_MAX_BODY_BYTES)
  if (Buffer.byteLength(body, 'utf8') !== summary.body_bytes) throw invalidContract('Team Skill body size')
  return {
    ...summary,
    body_format: bodyFormat(item.body_format),
    body
  }
}

function parseTeamSkillVersionSummaryRecord(
  item: Record<string, unknown>,
  teamId: string,
  skillId: string
): TeamSkillVersionSummary {
  const messageId = opaqueId(item.message_id, 'Team Message')
  const attachments = boundedArray(item.attachments, 'Team Skill attachments', TEAM_MESSAGES_MAX_ATTACHMENTS)
    .map(value => parseTeamAttachment(value, teamId))
  if (
    attachments.some(attachment => attachment.message_id !== messageId || attachment.state !== 'ready')
    || attachmentBytes(attachments) > TEAM_MESSAGES_MAX_TOTAL_ATTACHMENT_BYTES
  ) {
    throw invalidContract('Team Skill attachments')
  }
  return {
    team_id: teamId,
    skill_id: skillId,
    version: integer(item.version, 'Team Skill version', 1, 200),
    message_id: messageId,
    title: responseText(item.title, 'Team Skill title', 160, false),
    summary: responseText(item.summary, 'Team Skill summary', 280, true),
    tags: parseTeamSkillTags(item.tags, true),
    change_note: responseText(item.change_note, 'Team Skill change note', 280, true),
    author: parseTeamMessageSender(item.author),
    body_bytes: integer(item.body_bytes, 'Team Skill body size', 1, TEAM_MESSAGES_MAX_BODY_BYTES),
    attachments,
    created_at: timestamp(item.created_at, 'Team Skill version creation time')
  }
}

function attachmentBytes(attachments: TeamAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachment.byte_size, 0)
}

function parseTeamMessageRecipientInput(value: unknown): TeamMessageRecipientInput {
  const item = strictInputRecord(value, 'Team Message recipient', ['kind', 'id'], ['id'])
  if (item.kind !== 'server' && item.kind !== 'human' && item.kind !== 'all' && item.kind !== 'all_servers') {
    throw new Error('Team Message recipient kind is invalid.')
  }
  if ((item.kind === 'all' || item.kind === 'all_servers') !== (item.id === undefined)) throw new Error('Team Message recipient is invalid.')
  return { kind: item.kind, ...(item.id === undefined ? {} : { id: opaqueId(item.id, 'Team Message recipient') }) }
}

function parseTeamMessageSkillInput(value: unknown): TeamMessageSkillInput {
  const item = strictInputRecord(value, 'Team Skill post', [
    'slug', 'summary', 'tags', 'change_note', 'expected_version'
  ], ['summary', 'tags', 'change_note', 'expected_version'])
  return {
    slug: inputSkillSlug(item.slug),
    ...(item.summary === undefined ? {} : { summary: inputText(item.summary, 'Team Skill summary', 280, true) }),
    ...(item.tags === undefined ? {} : { tags: parseTeamSkillTags(item.tags, false) }),
    ...(item.change_note === undefined ? {} : { change_note: inputText(item.change_note, 'Team Skill change note', 280, true) }),
    ...(item.expected_version === undefined
      ? {}
      : { expected_version: integer(item.expected_version, 'Team Skill expected version', 1, 200) })
  }
}

function parseTeamMessageProvenanceInput(value: unknown): TeamMessageProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Team Message provenance is invalid.')
  const item = value as Record<string, unknown>
  const allowed = new Set(['via', 'backend', 'chat_id', 'run_id'])
  if (Object.keys(item).some(key => !allowed.has(key))) throw new Error('Team Message provenance is invalid.')
  if (item.via != null && item.via !== 'agent' && item.via !== 'desktop') {
    throw new Error('Team Message provenance is invalid.')
  }
  const backend = item.backend == null ? undefined : inputText(item.backend, 'Team Message backend', 80, false)
  const chatId = item.chat_id == null ? undefined : opaqueId(item.chat_id, 'Team Message chat')
  const runId = item.run_id == null ? undefined : opaqueId(item.run_id, 'Team Message run')
  return {
    ...(item.via == null ? {} : { via: item.via }),
    ...(backend === undefined ? {} : { backend }),
    ...(chatId === undefined ? {} : { chat_id: chatId }),
    ...(runId === undefined ? {} : { run_id: runId })
  }
}

function parseServer(value: unknown): TeamNetworkServer {
  const item = strictRecord(value, 'server', [
    'id', 'server_identity', 'display_name', 'recipient_display_name', 'status', 'is_host', 'owned_by_caller'
  ], ['recipient_display_name'])
  if (item.status !== 'active' && item.status !== 'offline' && item.status !== 'suspended') throw invalidContract('server status')
  return {
    id: opaqueId(item.id, 'server'),
    server_identity: opaqueId(item.server_identity, 'server identity'),
    display_name: displayName(item.display_name, 'server'),
    ...(item.recipient_display_name === undefined
      ? {}
      : { recipient_display_name: displayName(item.recipient_display_name, 'server recipient') }),
    status: item.status,
    is_host: booleanValue(item.is_host, 'server host marker'),
    owned_by_caller: booleanValue(item.owned_by_caller, 'server ownership marker')
  }
}

function parseAgent(value: unknown): TeamNetworkAgent {
  const item = strictRecord(value, 'agent', ['id', 'server_id', 'external_agent_id', 'backend', 'display_name', 'status'])
  if (item.status !== 'active' && item.status !== 'offline' && item.status !== 'suspended') throw invalidContract('agent status')
  return {
    id: opaqueId(item.id, 'agent'),
    server_id: opaqueId(item.server_id, 'agent server'),
    external_agent_id: opaqueId(item.external_agent_id, 'external agent'),
    backend: agentBackend(item.backend),
    display_name: displayName(item.display_name, 'agent'),
    status: item.status
  }
}

function parseBulletinPost(value: unknown): TeamNetworkBulletinPost {
  const item = strictRecord(value, 'Bulletin post', [
    'id', 'sequence', 'author', 'body_format', 'body', 'thread_root_post_id', 'reply_to_post_id', 'created_at'
  ])
  const author = strictRecord(item.author, 'Bulletin author', ['kind', 'id', 'display_name'])
  if (author.kind !== 'human' && author.kind !== 'server') throw invalidContract('Bulletin author')
  const threadRootId = nullableId(item.thread_root_post_id, 'Bulletin thread root')
  const replyToPostId = nullableId(item.reply_to_post_id, 'Bulletin reply')
  if ((threadRootId === null) !== (replyToPostId === null)) throw invalidContract('Bulletin thread context')
  return {
    id: opaqueId(item.id, 'Bulletin post'),
    sequence: integer(item.sequence, 'Bulletin sequence', 1, Number.MAX_SAFE_INTEGER),
    author: {
      kind: author.kind,
      id: opaqueId(author.id, 'Bulletin author'),
      display_name: displayName(author.display_name, 'Bulletin author')
    },
    body_format: bodyFormat(item.body_format),
    body: body(item.body, 'Bulletin'),
    thread_root_post_id: threadRootId,
    reply_to_post_id: replyToPostId,
    created_at: timestamp(item.created_at, 'Bulletin creation time')
  }
}

function parseMailboxItem(value: unknown): TeamNetworkMailboxItem {
  const item = strictRecord(value, 'mailbox item', [
    'id', 'sequence', 'kind', 'from', 'to', 'body_format', 'body', 'request_id', 'created_at', 'expires_at'
  ])
  if (item.kind !== 'message' && item.kind !== 'request' && item.kind !== 'reply') throw invalidContract('mailbox item kind')
  const itemId = opaqueId(item.id, 'mailbox item')
  const requestId = nullableId(item.request_id, 'mailbox request')
  if (
    (item.kind === 'message' && requestId !== null)
    || (item.kind !== 'message' && requestId === null)
    || (item.kind === 'request' && requestId !== itemId)
  ) {
    throw invalidContract('mailbox request identity')
  }
  const expiresAt = nullableTimestamp(item.expires_at, 'mailbox expiry')
  if ((item.kind === 'request') !== (expiresAt !== null)) throw invalidContract('mailbox expiry')
  return {
    id: itemId,
    sequence: integer(item.sequence, 'mailbox sequence', 1, Number.MAX_SAFE_INTEGER),
    kind: item.kind,
    from: parsePublicAddress(item.from),
    to: parsePublicAddress(item.to),
    body_format: bodyFormat(item.body_format),
    body: body(item.body, 'Mailbox'),
    request_id: requestId,
    created_at: timestamp(item.created_at, 'mailbox creation time'),
    expires_at: expiresAt
  }
}

function parseDelivery(value: unknown): TeamNetworkDelivery {
  const item = strictRecord(value, 'delivery', ['id', 'state', 'available_at', 'delivered_at', 'read_at'])
  if (item.state !== 'available' && item.state !== 'delivered' && item.state !== 'read') throw invalidContract('delivery state')
  const deliveredAt = nullableTimestamp(item.delivered_at, 'delivery time')
  const readAt = nullableTimestamp(item.read_at, 'read time')
  if (
    (item.state === 'available' && (deliveredAt !== null || readAt !== null))
    || (item.state === 'delivered' && (deliveredAt === null || readAt !== null))
    || (item.state === 'read' && (deliveredAt === null || readAt === null))
  ) throw invalidContract('delivery receipt timeline')
  return {
    id: opaqueId(item.id, 'delivery'),
    state: item.state,
    available_at: timestamp(item.available_at, 'delivery availability'),
    delivered_at: deliveredAt,
    read_at: readAt
  }
}

function parsePassiveRequest(value: unknown): TeamNetworkPassiveRequest {
  const item = strictRecord(value, 'passive request', ['id', 'status', 'expires_at', 'reply_item_id'])
  if (item.status !== 'open' && item.status !== 'replied' && item.status !== 'expired') throw invalidContract('passive request status')
  const replyId = nullableId(item.reply_item_id, 'passive request reply')
  if ((item.status === 'replied') !== (replyId !== null)) throw invalidContract('passive request reply identity')
  return {
    id: opaqueId(item.id, 'passive request'),
    status: item.status,
    expires_at: timestamp(item.expires_at, 'passive request expiry'),
    reply_item_id: replyId
  }
}

function parsePublicAddress(value: unknown): TeamNetworkPublicAddress {
  const base = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!base) throw invalidContract('mailbox address')
  if (base.kind === 'human') {
    const item = strictRecord(base, 'human address', ['kind', 'id', 'display_name'])
    return { kind: 'human', id: opaqueId(item.id, 'human address'), display_name: displayName(item.display_name, 'human address') }
  }
  if (base.kind === 'server') {
    const item = strictRecord(base, 'server address', ['kind', 'id', 'server_identity', 'display_name'])
    return {
      kind: 'server', id: opaqueId(item.id, 'server address'),
      server_identity: opaqueId(item.server_identity, 'server identity'),
      display_name: displayName(item.display_name, 'server address')
    }
  }
  if (base.kind === 'agent') {
    const item = strictRecord(base, 'agent address', ['kind', 'id', 'server_id', 'backend', 'display_name'])
    return {
      kind: 'agent', id: opaqueId(item.id, 'agent address'), server_id: opaqueId(item.server_id, 'agent server'),
      backend: agentBackend(item.backend), display_name: displayName(item.display_name, 'agent address')
    }
  }
  throw invalidContract('mailbox address')
}

function parseInputAddress(value: unknown): TeamNetworkAddress {
  const item = strictInputRecord(value, 'Mailbox address', ['kind', 'id'])
  if (item.kind !== 'server' && item.kind !== 'agent') throw new Error('Mailbox address kind is invalid.')
  return { kind: item.kind, id: opaqueId(item.id, 'mailbox address') }
}

function parseMailboxAddress(value: unknown): TeamNetworkMailboxAddress {
  const item = strictInputRecord(value, 'Mailbox address', ['kind', 'id'])
  if (item.kind !== 'server' && item.kind !== 'agent' && item.kind !== 'human') throw new Error('Mailbox address kind is invalid.')
  return { kind: item.kind, id: opaqueId(item.id, 'mailbox address') }
}

function strictRecord(value: unknown, label: string, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidContract(label)
  const item = value as Record<string, unknown>
  const allowed = new Set(keys)
  if (Object.keys(item).some(key => !allowed.has(key))) throw invalidContract(label)
  const optionalSet = new Set(optional)
  if (keys.some(key => !optionalSet.has(key) && !(key in item))) throw invalidContract(label)
  return item
}

function strictInputRecord(value: unknown, label: string, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid.`)
  const item = value as Record<string, unknown>
  const allowed = new Set(keys)
  const optionalSet = new Set(optional)
  if (
    Object.keys(item).some(key => !allowed.has(key))
    || keys.some(key => !optionalSet.has(key) && !(key in item))
  ) throw new Error(`${label} is invalid.`)
  return item
}

function boundedArray(value: unknown, label: string, maximum = TEAM_NETWORK_MAX_PAGE_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalidContract(label)
  return value
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label[0]?.toUpperCase() ?? ''}${label.slice(1)} identifier is invalid.`)
  }
  return value
}

function nullableId(value: unknown, label: string): string | null {
  return value == null ? null : opaqueId(value, label)
}

function displayName(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !isWellFormed(value)
    || !value.trim()
    || !hasAtMostCodePoints(value, 160)
    || /[\u0000\u007f]/.test(value)
  ) {
    throw new Error(`${label[0]?.toUpperCase() ?? ''}${label.slice(1)} name is invalid.`)
  }
  return value
}

function body(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isWellFormed(value)) throw new Error(`${label} body is invalid.`)
  const length = Buffer.byteLength(value, 'utf8')
  if (length < 1 || length > TEAM_NETWORK_MAX_BODY_BYTES) throw new Error(`${label} body is invalid.`)
  return value
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

function agentBackend(value: unknown): TeamNetworkAgentBackend {
  if (value !== 'codex' && value !== 'claude' && value !== 'other') throw invalidContract('agent backend')
  return value
}

function bodyFormat(value: unknown): TeamNetworkBodyFormat {
  if (value !== 'plain' && value !== 'markdown') throw invalidContract('body format')
  return value
}

function optionalBodyFormat(value: unknown): TeamNetworkBodyFormat {
  return value === undefined ? 'markdown' : bodyFormat(value)
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index])
}

function deliveryState(value: unknown): TeamNetworkDeliveryState {
  if (value !== 'available' && value !== 'delivered' && value !== 'read') {
    throw invalidContract('Team Message delivery state')
  }
  return value
}

function inputArray(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} are invalid.`)
  }
  return value
}

function inputBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is invalid.`)
  return value
}

function inputTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 80 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function inputMailSubject(value: unknown): string {
  if (typeof value !== 'string' || !isWellFormed(value)
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
    || !value.trim() || !hasAtMostCodePoints(value.trim(), 160)) {
    throw new Error('Team Message title must be a single line of at most 160 characters.')
  }
  return value.trim()
}

function inputText(value: unknown, label: string, maximum: number, allowEmpty: boolean): string {
  if (
    typeof value !== 'string'
    || !isWellFormed(value)
    || value.length > maximum
    || (!allowEmpty && !value.trim())
    || /[\u0000\u007f]/.test(value)
  ) throw new Error(`${label} is invalid.`)
  return value
}

function inputBody(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || !isWellFormed(value)) throw new Error(`${label} body is invalid.`)
  const length = Buffer.byteLength(value, 'utf8')
  if (length < 1 || length > maximumBytes) throw new Error(`${label} body is invalid.`)
  return value
}

function inputBodyFormat(value: unknown): TeamNetworkBodyFormat {
  if (value !== 'plain' && value !== 'markdown') throw new Error('Team Message body format is invalid.')
  return value
}

function responseBody(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || !isWellFormed(value)) throw invalidContract(`${label} body`)
  const length = Buffer.byteLength(value, 'utf8')
  if (length < 1 || length > maximumBytes) throw invalidContract(`${label} body`)
  return value
}

function responseText(value: unknown, label: string, maximum: number, allowEmpty: boolean): string {
  if (
    typeof value !== 'string'
    || !isWellFormed(value)
    || !hasAtMostCodePoints(value, maximum)
    || (!allowEmpty && !value.trim())
    || /[\u0000\u007f]/.test(value)
  ) throw invalidContract(label)
  return value
}

function responsePreview(value: unknown): string {
  if (
    typeof value !== 'string'
    || !isWellFormed(value)
    || !hasAtMostCodePoints(value, 280)
  ) throw invalidContract('Team Message preview')
  // beta.33 could derive previews containing NUL or DEL from otherwise legal
  // message bodies. Preserve the row while rendering those controls visibly.
  return value.replace(/[\u0000\u007f]/g, '\ufffd')
}

function nullableResponseText(value: unknown, label: string, maximum: number): string | null {
  return value == null ? null : responseText(value, label, maximum, false)
}

function nullableShortText(value: unknown, label: string, maximum: number): string | null {
  return value == null ? null : responseText(value, label, maximum, false)
}

function inputSkillSlug(value: unknown): string {
  if (typeof value !== 'string' || !new RegExp(TEAM_MESSAGES_SKILL_SLUG_PATTERN).test(value)) {
    throw new Error('Team Skill slug is invalid.')
  }
  return value
}

function responseSkillSlug(value: unknown): string {
  if (typeof value !== 'string' || !new RegExp(TEAM_MESSAGES_SKILL_SLUG_PATTERN).test(value)) {
    throw invalidContract('Team Skill slug')
  }
  return value
}

function parseTeamSkillTags(value: unknown, response: boolean): string[] {
  const invalid = (): never => {
    if (response) throw invalidContract('Team Skill tags')
    throw new Error('Team Skill tags are invalid.')
  }
  if (!Array.isArray(value) || value.length > 8) return invalid()
  const tags = value.map(tag => {
    if (typeof tag !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(tag)) return invalid()
    return tag
  })
  if (new Set(tags).size !== tags.length) return invalid()
  return tags
}

function absoluteFilePath(value: unknown): string {
  if (
    typeof value !== 'string'
    || !(
      value.startsWith('/')
      || /^[A-Za-z]:[\\/]/.test(value)
      || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)
    )
    || value.length > 4_096
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error('Team attachment path is invalid.')
  return value
}

function inputFileName(value: unknown): string {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value, 'utf8') > 255
  ) throw new Error('Team attachment file name is invalid.')
  return value
}

function responseFileName(value: unknown): string {
  if (
    typeof value !== 'string'
    || !isWellFormed(value)
    || !value
    || !hasAtMostCodePoints(value, 255)
    || value.trim() !== value
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw invalidContract('Team attachment file name')
  return value
}

function inputMediaType(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 3
    || value.length > 160
    || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[\x20-\x7e]+)?$/.test(value)
  ) throw new Error('Team attachment media type is invalid.')
  return value
}

function responseMediaType(value: unknown): string {
  try { return inputMediaType(value) } catch { throw invalidContract('Team attachment media type') }
}

function sha256Hex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw invalidContract(label)
  return value
}

function optionalSenderOrAddressKind(value: unknown, label: string): 'server' | 'human' | undefined {
  if (value === undefined) return undefined
  if (value !== 'server' && value !== 'human') throw new Error(`Team Messages ${label} kind is invalid.`)
  return value
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Idempotency key is invalid.')
  }
  return value
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label[0]?.toUpperCase() ?? ''}${label.slice(1)} is invalid.`)
  }
  return value
}

function clampedWireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) throw new Error(`${label[0]?.toUpperCase() ?? ''}${label.slice(1)} is invalid.`)
  return Math.min(value, Number.MAX_SAFE_INTEGER)
}

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let length = 0
  for (const _character of value) {
    length += 1
    if (length > maximum) return false
  }
  return true
}

function optionalInteger(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  return value === undefined ? fallback : integer(value, label, minimum, maximum)
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidContract(label)
  return value
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 80 || !Number.isFinite(Date.parse(value))) throw invalidContract(label)
  return value
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value == null ? null : timestamp(value, label)
}

function invalidContract(label: string): Error {
  return new Error(`Team Hub returned an invalid ${label}.`)
}
