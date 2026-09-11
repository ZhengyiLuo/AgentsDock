import type {
  Backend,
  ChatReference,
  ChatReferenceAction,
  Health,
  Session,
} from '../types'
import { claudeInteractiveClientCapability } from './claude-controls'
import { codexInteractiveClientCapability } from './codex-controls'

export const CROSS_CHAT_HANDOFFS_V1_CLIENT_CAPABILITY = 'cross_chat_handoffs_v1'
export const CROSS_CHAT_HANDOFFS_V2_CLIENT_CAPABILITY = 'cross_chat_handoffs_v2'
export const AGENT_CROSS_CHAT_ROUTES_CLIENT_CAPABILITY = 'agent_cross_chat_routes_v2'
export const ROUTE_HINT_MENTIONS_CAPABILITY_VERSION = 7
export const EXACT_QUEUED_DELIVERY_SKIP_CAPABILITY_VERSION = 9
export const MAX_CHAT_REFERENCES = 16

export function exactQueuedDeliverySkipAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  return crossChatCapabilityVersion(health) >= EXACT_QUEUED_DELIVERY_SKIP_CAPABILITY_VERSION
    && capability?.features?.exact_queued_delivery_skip === true
}

export interface ChatMentionTrigger {
  kind: '@' | '/chat'
  start: number
  end: number
  query: string
}

export interface InsertChatReferenceResult {
  text: string
  reference: ChatReference
  caret: number
}

/**
 * Reconstructs the native caret after one text edit. React Native may deliver
 * onChangeText before its matching selection event on iOS, so the previous
 * selection is used only when it can actually produce the new string. The
 * contiguous-diff fallback keeps mention discovery working when that
 * selection is stale.
 */
export function caretAfterTextChange(
  previousText: string,
  nextText: string,
  previousSelection: { start: number; end: number },
): number {
  const start = Math.max(0, Math.min(previousSelection.start, previousText.length))
  const end = Math.max(start, Math.min(previousSelection.end, previousText.length))
  const insertedLength = nextText.length - (previousText.length - (end - start))
  if (insertedLength >= 0) {
    const candidate = start + insertedLength
    if (
      previousText.slice(0, start) + nextText.slice(start, candidate) + previousText.slice(end) === nextText
    ) return candidate
  }

  let prefix = 0
  const prefixLimit = Math.min(previousText.length, nextText.length)
  while (prefix < prefixLimit && previousText[prefix] === nextText[prefix]) prefix += 1

  let suffix = 0
  const suffixLimit = Math.min(previousText.length - prefix, nextText.length - prefix)
  while (
    suffix < suffixLimit
    && previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) suffix += 1

  return Math.max(prefix, nextText.length - suffix)
}

const CHAT_REFERENCE_ACTIONS = new Set<ChatReferenceAction>([
  'direct_message',
  'route',
  'request_reply',
  'instruction',
  'final_result',
])

export function agentCrossChatRoutesSupported(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  return crossChatCapabilityVersion(health) >= ROUTE_HINT_MENTIONS_CAPABILITY_VERSION
    && capability?.features?.durable_route_grants === true
    && capability.features.agent_cross_chat_routes === true
    && capability.features.agent_ambient_local_handoffs === false
    && capability.agent_routes?.policy === 'default_deny'
    && capability.agent_routes.client_capability === AGENT_CROSS_CHAT_ROUTES_CLIENT_CAPABILITY
}

export function routeHintMentionsAvailable(health: Health | null | undefined): boolean {
  return crossChatHandoffsAvailable(health)
    && agentCrossChatRoutesSupported(health)
    && supportedCrossChatActions(health).includes('route')
}

export function crossChatHandoffsAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  return capability?.available === true && crossChatCapabilityVersion(health) >= 1
}

export function crossChatCapabilityVersion(health: Health | null | undefined): number {
  const version = health?.capabilities?.cross_chat_handoffs_v1?.version
  if (version === undefined) return 1
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 1 ? version : 0
}

export function supportedCrossChatActions(health: Health | null | undefined): ChatReferenceAction[] {
  if (!crossChatHandoffsAvailable(health)) return []
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  const advertised = capability?.actions
  if (!Array.isArray(advertised)) return ['instruction', 'final_result']
  const version = crossChatCapabilityVersion(health)
  return [...new Set(advertised.filter((action): action is ChatReferenceAction => (
    CHAT_REFERENCE_ACTIONS.has(action)
    && (action !== 'request_reply' || version >= 2)
    && (action !== 'direct_message' || (version >= 5 && capability?.features?.direct_message_mentions === true))
    && (action !== 'route' || (version >= ROUTE_HINT_MENTIONS_CAPABILITY_VERSION && agentCrossChatRoutesSupported(health)) || (version >= 5 && capability?.features?.route_mentions === true))
  )))]
}

export function defaultCrossChatAction(
  health: Health | null | undefined,
  sourceBackend?: Backend | null,
): ChatReferenceAction | null {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  const actions = supportedCrossChatActions(health).filter(action => (
    action !== 'request_reply'
    || Boolean(sourceBackend && supportedCrossChatTargetBackends(health).includes(sourceBackend))
  ))
  // Legacy/secure-peer handoffs keep the least-authoritative default. A local
  // @ mention uses chatMentionAction() only after the complete v7 route gate.
  if (actions.includes('instruction')) return 'instruction'
  if (capability?.default_action && actions.includes(capability.default_action)) return capability.default_action
  return actions[0] ?? null
}

/** Local @ and /chat mentions are pending durable route grants in v7. */
export function chatMentionAction(_trigger: Pick<ChatMentionTrigger, 'kind'>): Extract<ChatReferenceAction, 'route'> {
  return 'route'
}

/** Keep the authority bit consistent whenever a reference action changes. */
export function chatReferenceWithAction(reference: ChatReference, action: ChatReferenceAction): ChatReference {
  const next: ChatReference = { ...reference, action }
  if (action === 'route') next.grant_intent = true
  else delete next.grant_intent
  return next
}

/** Fail closed unless the exact v7 route contract and authority bit agree. */
export function localChatReferenceContractSupported(
  health: Health | null | undefined,
  reference: Pick<ChatReference, 'action' | 'grant_intent' | 'target_kind'>,
): boolean {
  return reference.target_kind !== 'secure_peer'
    && routeHintMentionsAvailable(health)
    && supportedCrossChatActions(health).includes(reference.action)
    && (reference.action === 'route' ? reference.grant_intent === true : reference.grant_intent !== true)
}

export function supportedCrossChatTargetBackends(health: Health | null | undefined): Backend[] {
  if (!crossChatHandoffsAvailable(health)) return []
  const advertised = health?.capabilities?.cross_chat_handoffs_v1?.supported_target_backends
  if (!Array.isArray(advertised)) return ['codex', 'claude']
  return advertised.filter((backend): backend is Backend => backend === 'codex' || backend === 'claude' || backend === 'cursor')
}

/**
 * Every ordinary mobile turn advertises the interaction surface it can
 * actually render. Cross-chat v1 is additive; request/reply authority is sent
 * only when the active server explicitly advertises capability version 2.
 */
export function interactiveClientCapabilities(
  session: Pick<Session, 'backend'> | null | undefined,
  health: Health | null | undefined,
): string[] {
  const capabilities: string[] = []
  const interactive = session?.backend === 'claude'
    ? claudeInteractiveClientCapability(health)
    : session?.backend === 'codex'
      ? codexInteractiveClientCapability(health)
      : null
  if (interactive) capabilities.push(interactive)
  if (crossChatHandoffsAvailable(health)) {
    capabilities.push(CROSS_CHAT_HANDOFFS_V1_CLIENT_CAPABILITY)
    if (crossChatCapabilityVersion(health) >= 2) {
      capabilities.push(CROSS_CHAT_HANDOFFS_V2_CLIENT_CAPABILITY)
    }
    if (routeHintMentionsAvailable(health)) capabilities.push(AGENT_CROSS_CHAT_ROUTES_CLIENT_CAPABILITY)
  }
  return capabilities
}

/** Finds an active, unresolved mention query ending at the native caret. */
export function chatMentionTrigger(
  text: string,
  caret: number,
  references: readonly ChatReference[] = [],
): ChatMentionTrigger | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length))
  const lineStart = text.lastIndexOf('\n', safeCaret - 1) + 1
  const line = text.slice(lineStart, safeCaret)
  const candidates: ChatMentionTrigger[] = []
  const insideResolvedReference = (offset: number) => references.some(reference => (
    reference.source_text_start <= offset
    && offset < reference.source_text_end
    && text.slice(reference.source_text_start, reference.source_text_end) === `@${reference.display_title_snapshot}`
  ))

  const at = line.lastIndexOf('@')
  if (at >= 0) {
    const absolute = lineStart + at
    const previous = absolute > 0 ? text[absolute - 1] : ''
    const query = text.slice(absolute + 1, safeCaret)
    if (!insideResolvedReference(absolute) && (!previous || /\s|[([{]/u.test(previous)) && !query.includes('\n')) {
      candidates.push({ kind: '@', start: absolute, end: safeCaret, query })
    }
  }

  const lowerLine = line.toLocaleLowerCase()
  const slash = lowerLine.lastIndexOf('/chat')
  if (slash >= 0) {
    const absolute = lineStart + slash
    const previous = absolute > 0 ? text[absolute - 1] : ''
    const suffix = text.slice(absolute + 5, safeCaret)
    if (!insideResolvedReference(absolute) && (!previous || /\s|[([{]/u.test(previous)) && (suffix === '' || /^[\s/]/u.test(suffix))) {
      candidates.push({
        kind: '/chat',
        start: absolute,
        end: safeCaret,
        query: suffix.replace(/^\/?\s*/u, ''),
      })
    }
  }

  return candidates.sort((left, right) => right.start - left.start)[0] ?? null
}

export function insertChatReference(
  text: string,
  trigger: ChatMentionTrigger,
  session: Pick<Session, 'id' | 'title'>,
  action: ChatReferenceAction = 'instruction',
): InsertChatReferenceResult {
  const title = session.title.trim() || session.id
  if (title.startsWith('@')) throw new Error('Chat names beginning with @ cannot be referenced. Rename the chat and try again.')
  const display = `@${title}`
  const prefix = text.slice(0, trigger.start)
  const suffix = text.slice(trigger.end)
  const needsSpace = suffix.length === 0 || !/^\s/u.test(suffix)
  const inserted = `${display}${needsSpace ? ' ' : ''}`
  return {
    text: `${prefix}${inserted}${suffix}`,
    reference: {
      session_id: session.id,
      display_title_snapshot: title,
      source_text_start: trigger.start,
      source_text_end: trigger.start + display.length,
      action,
      ...(action === 'route' ? { grant_intent: true as const } : {}),
    },
    caret: trigger.start + inserted.length,
  }
}

/**
 * Applies one contiguous native text edit. Any edit touching a chip's exact
 * text revokes its authority; edits before or after it shift/preserve safely.
 */
export function reconcileChatReferences(
  previousText: string,
  nextText: string,
  references: readonly ChatReference[],
): ChatReference[] {
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
        source_text_end: reference.source_text_end + delta,
      }]
    }
    return []
  })
}

export interface RestoredChatComposer {
  text: string
  references: ChatReference[]
}

export function removeChatReferencesForSession(
  referencesBySession: Readonly<Record<string, readonly ChatReference[]>>,
  sessionId: string,
): Record<string, ChatReference[]> {
  const result: Record<string, ChatReference[]> = {}
  for (const [sourceSessionId, references] of Object.entries(referencesBySession)) {
    if (sourceSessionId === sessionId) continue
    const retained = references
      .filter(reference => reference.session_id !== sessionId)
      .map(reference => ({ ...reference }))
    if (retained.length) result[sourceSessionId] = retained
  }
  return result
}

/**
 * Restores a composer admission after the HTTP request failed. Text typed
 * after admission is appended without allowing either the submitted grants or
 * the newly typed grants to drift. In particular, an attachment-only send has
 * no prefix/separator, so it must not shift new references by two code units.
 */
export function restoreFailedChatComposer(
  admittedText: string,
  admittedReferences: readonly ChatReference[],
  currentText: string,
  currentReferences: readonly ChatReference[],
  sourceSessionId?: string | null,
): RestoredChatComposer {
  const hasAdmittedText = admittedText.length > 0
  const hasCurrentText = currentText.length > 0
  const mergeCurrent = hasCurrentText && currentText !== admittedText
  const separator = hasAdmittedText && mergeCurrent ? '\n\n' : ''
  const text = mergeCurrent
    ? `${admittedText}${separator}${currentText}`
    : hasAdmittedText
      ? admittedText
      : hasCurrentText
        ? currentText
        : admittedText
  const currentOffset = mergeCurrent ? admittedText.length + separator.length : 0
  const references = mergeCurrent
    ? [
        ...admittedReferences,
        ...currentReferences.map(reference => ({
          ...reference,
          source_text_start: reference.source_text_start + currentOffset,
          source_text_end: reference.source_text_end + currentOffset,
        })),
      ]
    : hasAdmittedText
      ? admittedReferences
      : currentReferences
  return {
    text,
    references: validChatReferences(text, references, sourceSessionId),
  }
}

export function chatReferencesEqual(
  left: readonly ChatReference[],
  right: readonly ChatReference[],
): boolean {
  if (left.length !== right.length || left.length > MAX_CHAT_REFERENCES) return false
  const orderedLeft = [...left].sort(compareChatReferences)
  const orderedRight = [...right].sort(compareChatReferences)
  return orderedLeft.every((reference, index) => sameChatReference(reference, orderedRight[index]))
}

/**
 * Validates exact UTF-16 spans and one grant per target/action without ever
 * inferring authority from prose.
 */
export function validChatReferences(
  text: string,
  references: readonly ChatReference[],
  sourceSessionId?: string | null,
): ChatReference[] {
  // AgentsServer computes these offsets by encoding the complete prompt as
  // UTF-16. A lone surrogate anywhere in a corrupted/restored draft would
  // make that operation fail before an otherwise exact reference is checked.
  // Refuse the whole authority payload locally instead of sending a request
  // that API contract 13 cannot validate deterministically.
  if (references.length > MAX_CHAT_REFERENCES || !hasWellFormedUtf16(text)) return []
  const accepted: ChatReference[] = []
  const occupied: Array<[number, number]> = []
  const authorizedActions = new Set<string>()
  for (const reference of [...references].sort((left, right) => left.source_text_start - right.source_text_start)) {
    if (
      !reference.session_id
      || reference.session_id !== reference.session_id.trim()
      || unicodeScalarLength(reference.session_id) > 128
      || !hasWellFormedUtf16(reference.session_id)
      || reference.session_id === sourceSessionId
    ) continue
    if (
      !reference.display_title_snapshot
      || reference.display_title_snapshot.startsWith('@')
      || unicodeScalarLength(reference.display_title_snapshot) > 240
      || !hasWellFormedUtf16(reference.display_title_snapshot)
    ) continue
    if (!CHAT_REFERENCE_ACTIONS.has(reference.action)) continue
    if (!Number.isInteger(reference.source_text_start) || !Number.isInteger(reference.source_text_end)) continue
    if (reference.source_text_start < 0 || reference.source_text_end <= reference.source_text_start || reference.source_text_end > text.length) continue
    if (text.slice(reference.source_text_start, reference.source_text_end) !== `@${reference.display_title_snapshot}`) continue
    if (occupied.some(([start, end]) => reference.source_text_start < end && reference.source_text_end > start)) continue
    const authorityKey = `${reference.session_id}\u0000${reference.action}`
    if (authorizedActions.has(authorityKey)) continue
    accepted.push({ ...reference })
    occupied.push([reference.source_text_start, reference.source_text_end])
    authorizedActions.add(authorityKey)
  }
  return accepted
}

export function parseStoredChatReferences(
  value: unknown,
  text: string,
  sourceSessionId?: string | null,
): ChatReference[] {
  if (!Array.isArray(value) || value.length > MAX_CHAT_REFERENCES) return []
  const references = value.flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const item = candidate as Record<string, unknown>
    if (
      typeof item.session_id !== 'string'
      || typeof item.display_title_snapshot !== 'string'
      || typeof item.source_text_start !== 'number'
      || typeof item.source_text_end !== 'number'
      || (item.action !== 'direct_message' && item.action !== 'route' && item.action !== 'request_reply' && item.action !== 'instruction' && item.action !== 'final_result')
    ) return []
    return [item as unknown as ChatReference]
  })
  return validChatReferences(text, references, sourceSessionId)
}

export function chatReferenceLabel(action: ChatReferenceAction): string {
  if (action === 'route') return 'Grant route'
  if (action === 'direct_message') return 'Direct message'
  if (action === 'request_reply') return 'Reply expected'
  if (action === 'final_result') return 'Send my final result'
  return 'Send only'
}

function compareChatReferences(left: ChatReference, right: ChatReference): number {
  return left.source_text_start - right.source_text_start
    || left.source_text_end - right.source_text_end
    || compareStrings(left.session_id, right.session_id)
    || compareStrings(left.action, right.action)
    || compareStrings(left.display_title_snapshot, right.display_title_snapshot)
}

function sameChatReference(left: ChatReference, right: ChatReference | undefined): boolean {
  return Boolean(right)
    && left.session_id === right!.session_id
    && left.display_title_snapshot === right!.display_title_snapshot
    && left.source_text_start === right!.source_text_start
    && left.source_text_end === right!.source_text_end
    && left.action === right!.action
    && left.grant_intent === right!.grant_intent
    && left.target_kind === right!.target_kind
    && left.target_server_identity === right!.target_server_identity
    && left.target_connection_id === right!.target_connection_id
    && left.target_route_id === right!.target_route_id
    && left.target_route_revision === right!.target_route_revision
    && left.route_action === right!.route_action
}

function unicodeScalarLength(value: string): number {
  let length = 0
  for (const _character of value) length += 1
  return length
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}
