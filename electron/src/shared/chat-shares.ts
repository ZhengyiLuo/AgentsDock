export type ChatShareMode = 'snapshot' | 'interactive'

export const MAX_CHAT_SHARE_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_CHAT_SHARE_MESSAGE_BYTES = 256 * 1024

export interface SharedChatAttribution {
  shared_chat_id?: string | null
  shared_chat_request_id?: string | null
  author_label?: 'Collaborator' | null
}

export function isSharedChatCollaborator(value: SharedChatAttribution & { imported?: boolean | null }): boolean {
  return value.imported !== true && value.author_label === 'Collaborator'
    && /^interactive_[a-f0-9]{32}$/.test(value.shared_chat_id ?? '')
    && /^[A-Za-z0-9_-]{8,128}$/.test(value.shared_chat_request_id ?? '')
}

export interface ChatSharePreview {
  messages: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: number }>
  through_bytes: number
  digest: string
  warning: string
}

export interface ChatShareRecord {
  id: string
  title: string
  created_at: number
  expires_at: number | null
  revoked_at: number | null
  redeemed_at?: number | null
  message_count?: number
}

export interface CreatedChatShare extends ChatShareRecord {
  path: string
  url: string | null
}

export type CreateChatShareInput = {
  mode: 'snapshot'
  confirmed_public: true
  through_bytes: number
  digest: string
  title?: string
  expires_at?: number
} | {
  mode: 'interactive'
  confirmed_interactive: true
  title?: string
  expires_at?: number
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid chat share response.')
  return value as Record<string, unknown>
}

export function chatShareId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid chat share identity.')
  return value
}

export function chatShareMode(value: unknown): ChatShareMode {
  if (value !== 'snapshot' && value !== 'interactive') throw new Error('Invalid sharing mode.')
  return value
}

function timestamp(value: unknown, nullable = false): number | null {
  if (nullable && value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 253402300799) throw new Error('Invalid chat share timestamp.')
  return value
}

export function parseChatShareRecord(value: unknown, mode: ChatShareMode): ChatShareRecord {
  const item = record(value)
  if (typeof item.title !== 'string' || item.title.length > 1024) throw new Error('Invalid chat share title.')
  return { id: chatShareId(mode === 'snapshot' ? item.share_id : item.id), title: item.title,
    created_at: timestamp(item.created_at)!, expires_at: timestamp(item.expires_at, true), revoked_at: timestamp(item.revoked_at, true),
    ...(item.redeemed_at === undefined ? {} : { redeemed_at: timestamp(item.redeemed_at, true) }),
    ...(Number.isSafeInteger(item.message_count) && Number(item.message_count) >= 0 ? { message_count: Number(item.message_count) } : {}) }
}

export function parseChatShareList(value: unknown, mode: ChatShareMode): ChatShareRecord[] {
  const item = record(value)
  if (!Array.isArray(item.shares) || item.shares.length > 100) throw new Error('Invalid chat share list.')
  const shares = item.shares.map(row => parseChatShareRecord(row, mode))
  if (new Set(shares.map(row => row.id)).size !== shares.length) throw new Error('Duplicate chat share identity.')
  return shares
}

export function parseCreatedChatShare(value: unknown, mode: ChatShareMode): CreatedChatShare {
  const item = record(value)
  const metadata = parseChatShareRecord(item, mode)
  const expected = mode === 'snapshot' ? /^\/share\/[A-Za-z0-9_-]{43}$/ : new RegExp(`^/interactive-chat/${metadata.id}#invite=[A-Za-z0-9_-]{43}$`)
  if (typeof item.path !== 'string' || !expected.test(item.path)) throw new Error('Invalid chat share link.')
  if (item.url !== null) {
    if (typeof item.url !== 'string') throw new Error('Invalid public chat URL.')
    const url = new URL(item.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || `${url.pathname}${url.hash}` !== item.path) throw new Error('Invalid public chat URL.')
  }
  return { ...metadata, path: item.path, url: item.url as string | null }
}

export function parseChatSharePreview(value: unknown): ChatSharePreview {
  const item = record(value)
  if (!Array.isArray(item.messages) || !Number.isSafeInteger(item.through_bytes)
    || Number(item.through_bytes) < 0
    || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest)
    || typeof item.warning !== 'string' || item.warning.length > 8192) throw new Error('Invalid chat preview.')
  const utf8 = new TextEncoder()
  const messages: ChatSharePreview['messages'] = item.messages.map(value => {
    const message = record(value)
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string'
      || utf8.encode(message.text).byteLength > MAX_CHAT_SHARE_MESSAGE_BYTES) throw new Error('Invalid chat preview message.')
    return { role: message.role, text: message.text, ...(message.timestamp === undefined ? {} : { timestamp: timestamp(message.timestamp)! }) }
  })
  // Limit exported text, not the size or message count of the source event log.
  if (utf8.encode(JSON.stringify(messages)).byteLength > MAX_CHAT_SHARE_SNAPSHOT_BYTES) throw new Error('Chat preview exceeds the 2 MiB text snapshot limit.')
  return { messages, through_bytes: Number(item.through_bytes), digest: item.digest, warning: item.warning }
}

export function chatShareCreateBody(input: CreateChatShareInput): Record<string, unknown> {
  const mode = chatShareMode(input.mode)
  if (input.title !== undefined && (typeof input.title !== 'string' || [...input.title].length > 256)) throw new Error('Share title is too long.')
  if (input.expires_at !== undefined && timestamp(input.expires_at)! <= Date.now() / 1000) throw new Error('Share expiry must be in the future.')
  const optional = { ...(input.title === undefined ? {} : { title: input.title }), ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }) }
  if (mode === 'snapshot' && input.mode === 'snapshot' && input.confirmed_public === true
    && Number.isSafeInteger(input.through_bytes) && input.through_bytes > 0 && /^[a-f0-9]{64}$/.test(input.digest)) {
    return { ...optional, confirmed_public: true, through_bytes: input.through_bytes, digest: input.digest }
  }
  if (mode === 'interactive' && input.mode === 'interactive' && input.confirmed_interactive === true) return { ...optional, confirmed_interactive: true }
  throw new Error('Explicit sharing confirmation is required.')
}
