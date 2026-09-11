import type { Backend, ChatReference, ChatReferenceAction, Health, Session } from '@shared/types'
import type { SecurePeerRemoteRoute } from '@shared/secure-peer'

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

const CHAT_REFERENCE_ACTIONS = new Set<ChatReferenceAction>([
  'direct_message',
  'route',
  'request_reply',
  'instruction',
  'final_result'
])
const EXPLICIT_CHAT_REFERENCE_ACTIONS = new Set<ChatReferenceAction>(['direct_message', 'route'])
export const AGENT_CROSS_CHAT_ROUTES_CLIENT_CAPABILITY = 'agent_cross_chat_routes_v2'
export const ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY = 'chat_conversation_async_route_v1'
export const ROUTE_HINT_MENTIONS_CAPABILITY_VERSION = 7
export const EXACT_QUEUED_DELIVERY_SKIP_CAPABILITY_VERSION = 9
export const EXACT_QUEUED_PEER_DELIVERY_SKIP_CAPABILITY_VERSION = 10
export const MAX_CHAT_REFERENCES = 16

export function exactQueuedDeliverySkipAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  return Number(capability?.version ?? 1) >= EXACT_QUEUED_DELIVERY_SKIP_CAPABILITY_VERSION
    && capability?.features?.exact_queued_delivery_skip === true
}

export function exactQueuedPeerDeliverySkipAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  return Number(capability?.version ?? 1) >= EXACT_QUEUED_PEER_DELIVERY_SKIP_CAPABILITY_VERSION
    && capability?.features?.exact_queued_peer_delivery_skip === true
}

export function agentCrossChatRoutesSupported(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  return Number(capability?.version ?? 1) >= ROUTE_HINT_MENTIONS_CAPABILITY_VERSION
    && capability?.features?.durable_route_grants === true
    && capability?.features?.agent_cross_chat_routes === true
    && capability?.features?.agent_ambient_local_handoffs === false
    && capability?.agent_routes?.policy === 'default_deny'
    && capability?.agent_routes?.client_capability === AGENT_CROSS_CHAT_ROUTES_CLIENT_CAPABILITY
}

export function agentCrossChatRoutesAvailable(health: Health | null | undefined): boolean {
  return health?.capabilities?.cross_chat_handoffs_v1?.available === true
    && agentCrossChatRoutesSupported(health)
}

export function crossChatHandoffsAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  return capability?.available === true && Number(capability.version ?? 1) >= 1
}

export function asyncChatRouteAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  const mode = capability?.agent_routes?.async_route_v1
  return agentCrossChatRoutesAvailable(health)
    && capability?.features?.async_route_v1 === true
    && mode?.available === true
    && mode.client_capability === ASYNC_CHAT_ROUTE_CLIENT_CAPABILITY
    && mode.mode === 'async_route_v1'
}

/**
 * Current composer references are pending durable route grants. The server
 * persists them only if it accepts the turn. Requiring the complete v7,
 * default-deny contract prevents legacy ambient or direct-message servers
 * from interpreting the same marker with broader authority.
 */
export function routeHintMentionsAvailable(health: Health | null | undefined): boolean {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  return capability?.available === true
    && Number(capability.version ?? 1) >= ROUTE_HINT_MENTIONS_CAPABILITY_VERSION
    && agentCrossChatRoutesSupported(health)
    && supportedCrossChatActions(health).includes('route')
}

export function supportedCrossChatActions(health: Health | null | undefined): ChatReferenceAction[] {
  if (!crossChatHandoffsAvailable(health)) return []
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  const advertised = capability?.actions
  if (!Array.isArray(advertised)) return ['instruction', 'final_result']
  const version = Number(capability?.version ?? 1)
  return [...new Set(advertised.filter((action): action is ChatReferenceAction => (
    CHAT_REFERENCE_ACTIONS.has(action)
    && (action !== 'request_reply' || version >= 2)
    && (action !== 'direct_message' || (
      version >= 5 && capability?.features?.direct_message_mentions === true
    ))
    && (action !== 'route' || (
      (version >= ROUTE_HINT_MENTIONS_CAPABILITY_VERSION
        && capability?.features?.durable_route_grants === true
        && capability?.features?.agent_cross_chat_routes === true
        && capability?.features?.agent_ambient_local_handoffs === false
        && capability?.agent_routes?.policy === 'default_deny'
        && capability?.agent_routes?.client_capability === AGENT_CROSS_CHAT_ROUTES_CLIENT_CAPABILITY)
      || (version >= 5 && capability?.features?.route_mentions === true)
    ))
  )))]
}

export function defaultCrossChatAction(
  health: Health | null | undefined,
  sourceBackend?: Backend | null
): ChatReferenceAction | null {
  const capability = health?.capabilities?.cross_chat_handoffs_v1
  const actions = supportedCrossChatActions(health).filter(action => (
    action !== 'request_reply'
    || Boolean(sourceBackend && supportedCrossChatTargetBackends(health).includes(sourceBackend))
  ))
  // Legacy and secure-peer references still need a safe default. New
  // same-server @ references are always optional route hints instead.
  if (actions.includes('instruction')) return 'instruction'
  if (capability?.default_action && actions.includes(capability.default_action)) return capability.default_action
  return actions[0] ?? null
}

export function chatMentionAction(_trigger: Pick<ChatMentionTrigger, 'kind'>): Extract<ChatReferenceAction, 'route'> {
  return 'route'
}

export function explicitChatReferenceAction(action: ChatReferenceAction): action is Extract<ChatReferenceAction, 'direct_message' | 'route'> {
  return EXPLICIT_CHAT_REFERENCE_ACTIONS.has(action)
}

export function chatReferenceText(reference: Pick<ChatReference, 'action' | 'display_title_snapshot'>): string {
  return `@${reference.display_title_snapshot}`
}

function chatReferenceDisplayTitleSupported(title: string): boolean {
  return !title.startsWith('@')
}

function chatReferenceTokenMatches(
  text: string,
  reference: Pick<ChatReference, 'action' | 'display_title_snapshot' | 'source_text_start' | 'source_text_end'>
): boolean {
  const previous = reference.source_text_start > 0 ? text[reference.source_text_start - 1] : ''
  const next = reference.source_text_end < text.length ? text[reference.source_text_end] : ''
  const token = text.slice(reference.source_text_start, reference.source_text_end)
  const currentToken = chatReferenceText(reference)
  // Historical v5 route records used @@Title. Keep them parseable for
  // read-only timeline/queued-job rendering, but all new insertions use @.
  const legacyRouteToken = reference.action === 'route'
    ? `@@${reference.display_title_snapshot}`
    : null
  return chatReferenceDisplayTitleSupported(reference.display_title_snapshot)
    && (token === currentToken || token === legacyRouteToken)
    && (!previous || /\s|[([{]/u.test(previous))
    && (!next || /\s/u.test(next))
}

/** True only for the current v7 @Title pending durable-grant marker. */
export function currentRouteHintReference(
  text: string,
  reference: Pick<ChatReference, 'action' | 'display_title_snapshot' | 'source_text_start' | 'source_text_end'>
): boolean {
  return reference.action === 'route'
    && text.slice(reference.source_text_start, reference.source_text_end) === chatReferenceText(reference)
    && chatReferenceTokenMatches(text, reference)
}

/** Preserve the literal marker when showing a historical @@ route record. */
export function chatReferenceDisplayText(
  text: string,
  reference: Pick<ChatReference, 'action' | 'display_title_snapshot' | 'source_text_start' | 'source_text_end'>
): string {
  return chatReferenceTokenMatches(text, reference)
    ? text.slice(reference.source_text_start, reference.source_text_end)
    : chatReferenceText(reference)
}

export function supportedCrossChatTargetBackends(health: Health | null | undefined): Backend[] {
  if (!crossChatHandoffsAvailable(health)) return []
  const advertised = health?.capabilities?.cross_chat_handoffs_v1?.supported_target_backends
  if (!Array.isArray(advertised)) return ['codex', 'claude']
  return advertised.filter((backend): backend is Backend => (
    backend === 'codex' || backend === 'claude' || backend === 'cursor'
  ))
}

/** Finds an active, not-yet-resolved mention query ending at the textarea caret. */
export function chatMentionTrigger(
  text: string,
  caret: number,
  references: readonly ChatReference[] = []
): ChatMentionTrigger | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length))
  const lineStart = text.lastIndexOf('\n', safeCaret - 1) + 1
  const line = text.slice(lineStart, safeCaret)
  const candidates: ChatMentionTrigger[] = []
  const insideResolvedReference = (offset: number) => references.some(reference => (
    reference.source_text_start <= offset
    && offset < reference.source_text_end
    && chatReferenceTokenMatches(text, reference)
  ))

  for (let at = line.length - 1; at >= 0; at -= 1) {
    if (line[at] !== '@' || line[at - 1] === '@' || line[at + 1] === '@') continue
    const absolute = lineStart + at
    const previous = absolute > 0 ? text[absolute - 1] : ''
    const query = text.slice(absolute + 1, safeCaret)
    if (!insideResolvedReference(absolute) && (!previous || /\s|[([{]/u.test(previous)) && !query.includes('\n')) {
      candidates.push({ kind: '@', start: absolute, end: safeCaret, query })
    }
    break
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
        query: suffix.replace(/^\/?\s*/u, '')
      })
    }
  }

  return candidates.sort((left, right) => right.start - left.start)[0] ?? null
}

export function insertChatReference(
  text: string,
  trigger: ChatMentionTrigger,
  session: Pick<Session, 'id' | 'title'>,
  action: ChatReferenceAction = 'route',
  options?: { grantIntent?: boolean }
): InsertChatReferenceResult {
  const title = session.title.trim() || session.id
  if (!chatReferenceDisplayTitleSupported(title)) {
    throw new Error('Chat names beginning with @ cannot be referenced. Rename the chat and try again.')
  }
  const display = chatReferenceText({ action, display_title_snapshot: title })
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
      ...(action === 'route' && options?.grantIntent === true ? { grant_intent: true as const } : {})
    },
    caret: trigger.start + inserted.length
  }
}

export function insertSecurePeerChatReference(
  text: string,
  trigger: ChatMentionTrigger,
  route: SecurePeerRemoteRoute,
  action: Extract<ChatReferenceAction, 'instruction' | 'request_reply'>
): InsertChatReferenceResult {
  if (!route.actions.includes(action)) throw new Error('That remote chat route does not allow this action.')
  const label = `${route.peerDisplayName}/${route.alias}`
  if (!chatReferenceDisplayTitleSupported(label)) {
    throw new Error('Chat reference labels beginning with @ are not supported.')
  }
  const display = `@${label}`
  const prefix = text.slice(0, trigger.start)
  const suffix = text.slice(trigger.end)
  const needsSpace = suffix.length === 0 || !/^\s/u.test(suffix)
  const inserted = `${display}${needsSpace ? ' ' : ''}`
  return {
    text: `${prefix}${inserted}${suffix}`,
    reference: {
      // Remote servers never reveal their private chat id. The public route id
      // occupies the legacy required field while the explicit target fields
      // select the secure-peer delivery path.
      session_id: route.routeId,
      display_title_snapshot: label,
      source_text_start: trigger.start,
      source_text_end: trigger.start + display.length,
      action,
      target_kind: 'secure_peer',
      target_server_identity: route.peerServerIdentity,
      target_connection_id: secureRouteConnectionId(route),
      target_route_id: route.routeId,
      target_route_revision: route.revision
    },
    caret: trigger.start + inserted.length
  }
}

/**
 * Applies one contiguous textarea edit to structured reference spans. Any
 * edit touching a chip's text revokes that authority instead of guessing.
 */
export function reconcileChatReferences(
  previousText: string,
  nextText: string,
  references: readonly ChatReference[]
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
  const reconciled = references.flatMap(reference => {
    if (reference.source_text_end <= prefix) return [reference]
    if (reference.source_text_start >= previousEditEnd) {
      return [{
        ...reference,
        source_text_start: reference.source_text_start + delta,
        source_text_end: reference.source_text_end + delta
      }]
    }
    return []
  })
  return reconciled.filter(reference => chatReferenceTokenMatches(nextText, reference))
}

export function atomicChatReferenceCaret(caret: number, references: readonly ChatReference[]): number {
  const reference = references.find(candidate => candidate.source_text_start < caret && caret < candidate.source_text_end)
  if (!reference) return caret
  return caret - reference.source_text_start < reference.source_text_end - caret
    ? reference.source_text_start
    : reference.source_text_end
}

export function atomicChatReferenceNavigation(
  caret: number,
  references: readonly ChatReference[],
  key: 'ArrowLeft' | 'ArrowRight'
): number | null {
  const reference = key === 'ArrowLeft'
    ? [...references].reverse().find(candidate => candidate.source_text_start < caret && caret <= candidate.source_text_end)
    : references.find(candidate => candidate.source_text_start <= caret && caret < candidate.source_text_end)
  if (!reference) return null
  return key === 'ArrowLeft' ? reference.source_text_start : reference.source_text_end
}

export function atomicChatReferenceDeletion(
  text: string,
  references: readonly ChatReference[],
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

export function validChatReferences(
  text: string,
  references: readonly ChatReference[],
  sourceSessionId?: string | null
): ChatReference[] {
  const accepted: ChatReference[] = []
  const occupied: Array<[number, number]> = []
  const authorizedActions = new Set<string>()
  for (const reference of [...references].sort((left, right) => left.source_text_start - right.source_text_start)) {
    if (accepted.length >= MAX_CHAT_REFERENCES) break
    if (
      typeof reference.session_id !== 'string' || !reference.session_id || reference.session_id.length > 240
      || typeof reference.display_title_snapshot !== 'string' || !reference.display_title_snapshot || reference.display_title_snapshot.length > 320
      || /[\u0000-\u001f\u007f]/.test(reference.session_id)
      || /[\u0000-\u001f\u007f]/.test(reference.display_title_snapshot)
      || reference.target_kind !== 'secure_peer' && reference.session_id === sourceSessionId
    ) continue
    if (!CHAT_REFERENCE_ACTIONS.has(reference.action)) continue
    if (!Number.isInteger(reference.source_text_start) || !Number.isInteger(reference.source_text_end)) continue
    if (reference.source_text_start < 0 || reference.source_text_end <= reference.source_text_start || reference.source_text_end > text.length) continue
    if (!chatReferenceTokenMatches(text, reference)) continue
    if (occupied.some(([start, end]) => reference.source_text_start < end && reference.source_text_end > start)) continue
    if (reference.target_kind === 'secure_peer' && !validSecurePeerReferenceTarget(reference)) continue
    if (reference.target_kind !== undefined && reference.target_kind !== 'secure_peer') continue
    if (reference.target_kind !== 'secure_peer' && (
      reference.target_server_identity !== undefined
      || reference.target_connection_id !== undefined
      || reference.target_route_id !== undefined
      || reference.target_route_revision !== undefined
    )) continue
    const authorityKey = reference.target_kind === 'secure_peer'
      ? `secure_peer\u0000${reference.target_server_identity}\u0000${reference.target_connection_id}\u0000${reference.target_route_id}\u0000${reference.action}`
      : `${reference.session_id}\u0000${reference.action}`
    if (authorizedActions.has(authorityKey)) continue
    const canonicalGrantMarker = reference.target_kind !== 'secure_peer'
      && reference.action === 'route'
      && reference.grant_intent === true
      && text.slice(reference.source_text_start, reference.source_text_end) === chatReferenceText(reference)
    accepted.push(canonicalChatReference(reference, canonicalGrantMarker))
    occupied.push([reference.source_text_start, reference.source_text_end])
    authorizedActions.add(authorityKey)
  }
  return accepted
}

/**
 * Migrates v5 same-server @ direct-message and @@ route markers to the
 * canonical single-@ route-hint display. This never synthesizes v7 grant
 * intent, so restored history remains read-only until the user reselects it.
 * Exact secure-peer and older action-specific records retain their authority.
 */
export function canonicalizeLocalRouteHints(
  text: string,
  references: readonly ChatReference[],
  sourceSessionId?: string | null
): { text: string; references: ChatReference[] } {
  const valid = validChatReferences(text, references, sourceSessionId)
  const canonical: ChatReference[] = []
  let output = ''
  let cursor = 0
  for (const reference of valid) {
    output += text.slice(cursor, reference.source_text_start)
    const start = output.length
    const normalize = reference.target_kind !== 'secure_peer'
      && (reference.action === 'direct_message' || reference.action === 'route')
    const marker = normalize
      ? `@${reference.display_title_snapshot}`
      : text.slice(reference.source_text_start, reference.source_text_end)
    output += marker
    canonical.push({
      ...reference,
      source_text_start: start,
      source_text_end: start + marker.length,
      ...(normalize ? { action: 'route' as const } : {})
    })
    cursor = reference.source_text_end
  }
  output += text.slice(cursor)
  return { text: output, references: validChatReferences(output, canonical, sourceSessionId) }
}

function canonicalChatReference(reference: ChatReference, preserveGrantIntent = false): ChatReference {
  const common = {
    session_id: reference.session_id,
    display_title_snapshot: reference.display_title_snapshot,
    source_text_start: reference.source_text_start,
    source_text_end: reference.source_text_end,
    action: reference.action,
    ...(preserveGrantIntent ? { grant_intent: true as const } : {}),
    ...(reference.action === 'route'
      && (reference.route_action === 'instruction' || reference.route_action === 'request_reply')
      ? { route_action: reference.route_action }
      : {})
  }
  return reference.target_kind === 'secure_peer' ? {
    ...common,
    target_kind: 'secure_peer',
    target_server_identity: reference.target_server_identity,
    target_connection_id: reference.target_connection_id,
    target_route_id: reference.target_route_id,
    target_route_revision: reference.target_route_revision
  } : common
}

export function parseStoredChatReferences(value: unknown, text: string, sourceSessionId?: string | null): ChatReference[] {
  if (!Array.isArray(value)) return []
  const references = value.flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const item = candidate as Record<string, unknown>
    if (
      typeof item.session_id !== 'string'
      || typeof item.display_title_snapshot !== 'string'
      || typeof item.source_text_start !== 'number'
      || typeof item.source_text_end !== 'number'
      || !CHAT_REFERENCE_ACTIONS.has(item.action as ChatReferenceAction)
    ) return []
    const reference = item as unknown as ChatReference
    if (reference.target_kind === 'secure_peer' && !validSecurePeerReferenceTarget(reference)) return []
    if (reference.target_kind !== undefined && reference.target_kind !== 'secure_peer') return []
    return [reference]
  })
  return validChatReferences(text, references, sourceSessionId)
}

export function securePeerReferenceMatchesRoute(reference: ChatReference, route: SecurePeerRemoteRoute): boolean {
  return reference.target_kind === 'secure_peer'
    && reference.target_server_identity === route.peerServerIdentity
    && reference.target_connection_id === secureRouteConnectionId(route)
    && reference.target_route_id === route.routeId
    && reference.target_route_revision === route.revision
    && (reference.action === 'instruction' || reference.action === 'request_reply')
    && route.actions.includes(reference.action)
}

function validSecurePeerReferenceTarget(reference: ChatReference): boolean {
  return reference.session_id === reference.target_route_id
    && isUUIDv4(reference.target_connection_id)
    && isUUIDv4(reference.target_route_id)
    && typeof reference.target_server_identity === 'string'
    && reference.target_server_identity.length > 0
    && reference.target_server_identity.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(reference.target_server_identity)
    && typeof reference.target_route_revision === 'string'
    && /^rev_[0-9a-f]{32}$/.test(reference.target_route_revision)
    && (reference.action === 'instruction' || reference.action === 'request_reply')
}

function secureRouteConnectionId(route: SecurePeerRemoteRoute): string {
  const value = route.connectionId
  if (!isUUIDv4(value)) throw new Error('The remote chat route has an invalid connection binding.')
  return value
}

function isUUIDv4(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

export function chatReferenceLabel(action: ChatReferenceAction): string {
  if (action === 'direct_message') return 'Legacy chat reference'
  if (action === 'route') return 'Route hint'
  if (action === 'request_reply') return 'Reply expected'
  if (action === 'final_result') return 'Deliver final result'
  return 'Agent may send'
}
