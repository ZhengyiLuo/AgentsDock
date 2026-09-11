import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { CrossChatHandoff } from '../types'

export interface ChatMessageBodyIdentity {
  messageId: string
  sourceSessionId: string
  targetSessionId: string
  conversationId?: string
  queuedId?: string
  messageRevision?: number
  editedByUser?: boolean
  incoming: boolean
  mailbox?: boolean
  bodyHash?: string
}

/** Select only the body belonging to this exact participant/revision snapshot. */
export function authenticatedChatMessageBody(detail: CrossChatHandoff, identity: ChatMessageBodyIdentity): string {
  if (!identity.messageId || !identity.sourceSessionId || !identity.targetSessionId
    || detail.id !== identity.messageId
    || (detail.message_id !== identity.messageId && !(identity.queuedId && detail.message_id == null))
    || detail.conversation_mode !== 'async_route_v1'
    || detail.source_session_id !== identity.sourceSessionId || detail.target_session_id !== identity.targetSessionId
    || identity.conversationId && detail.conversation_id !== identity.conversationId
    || identity.queuedId && detail.queued_id != null && detail.queued_id !== identity.queuedId
    || identity.mailbox && detail.delivery_mode !== 'mailbox') {
    throw new Error('This message changed or belongs to a different conversation. Refresh before opening it.')
  }
  const revision = identity.messageRevision
  if (identity.incoming && detail.message_revision !== undefined
    && (typeof detail.message_revision !== 'number' || !Number.isSafeInteger(detail.message_revision) || detail.message_revision < 0)) {
    throw new Error('This message revision could not be verified.')
  }
  // A recipient edit never changes the sender's immutable original body.
  if (identity.incoming && revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0
    || (detail.message_revision ?? (identity.mailbox ? -1 : 0)) !== revision)) {
    throw new Error('This message was edited. Refresh before opening its current body.')
  }
  const edited = identity.incoming && (identity.editedByUser || detail.message_edited_by_user
    || (revision ?? 0) > 0 || (detail.message_revision ?? 0) > 0)
  if (edited && (revision === undefined || detail.message_edited_by_user !== true
    || detail.message_revision !== revision || typeof detail.target_body !== 'string')) {
    throw new Error('The edited recipient message could not be verified.')
  }
  const body = edited ? detail.target_body : detail.body
  if (typeof body !== 'string') throw new Error('The server did not return this message body.')
  if (identity.bodyHash && (!/^[a-f0-9]{64}$/iu.test(identity.bodyHash)
    || bytesToHex(sha256(utf8ToBytes(body))) !== identity.bodyHash.toLowerCase())) {
    throw new Error('This message body does not match its recorded revision. Refresh and try again.')
  }
  return body
}

export function chatMessageBodyHashMatches(body: string, hash: string): boolean {
  return /^[a-f0-9]{64}$/iu.test(hash) && bytesToHex(sha256(utf8ToBytes(body))) === hash.toLowerCase()
}
