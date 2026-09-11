import type {
  TeamHubAcceptedMembership,
  TeamHubChannel,
  TeamHubDeviceSession,
  TeamHubDeviceSessionPage,
  TeamHubInvitationPage,
  TeamHubInvitationSummary,
  TeamHubMembership,
  TeamHubMembershipPage,
  TeamHubMessage,
  TeamHubNode,
  TeamHubPrincipal,
  TeamHubSessionSummary,
  TeamHubTeam,
  TeamHubUpdateMemberInput
} from '../shared/team-hub'
import type {
  TeamNetworkAddress,
  TeamNetworkAgent,
  TeamNetworkAgentBackend,
  TeamNetworkBodyFormat,
  TeamNetworkBulletinPage,
  TeamNetworkBulletinPost,
  TeamNetworkDeleteBulletinResult,
  TeamNetworkDeletionPage,
  TeamNetworkCapabilities,
  TeamNetworkDelivery,
  TeamNetworkMailboxEntry,
  TeamNetworkMailboxAddress,
  TeamNetworkMailboxPage,
  TeamNetworkPassiveRequestCreated,
  TeamNetworkPassiveRequestDetails,
  TeamNetworkPassiveRequestReply,
  TeamNetworkProjectionPage,
  TeamNetworkReceiptState,
  TeamAttachment,
  TeamAttachmentDeclaration,
  TeamMessage,
  TeamMessageCreateInput,
  TeamMessageDeleteResult,
  TeamMessagePage,
  TeamMessageProvenance,
  TeamMessageQuery,
  TeamMessageReceiptResult,
  TeamMessagesCapability,
  TeamMailSubjectsCapability,
  TeamMailboxStateCapability,
  TeamSkill,
  TeamSkillDetails,
  TeamSkillPage,
  TeamSkillVersion,
  TeamSkillVersionsPage
} from '../shared/team-network'
import {
  parseTeamNetworkAgentResponse,
  parseTeamNetworkBulletinPage,
  parseTeamNetworkBulletinDeleteResponse,
  parseTeamNetworkBulletinPostResponse,
  parseTeamNetworkDeletionPage,
  parseTeamNetworkCapabilities,
  parseTeamNetworkDeliveryResponse,
  parseTeamNetworkMailboxEntry,
  parseTeamNetworkMailboxPage,
  parseTeamNetworkPassiveRequestCreated,
  parseTeamNetworkPassiveRequestDetails,
  parseTeamNetworkProjection,
  parseTeamAttachmentDeclaration,
  parseTeamAttachmentResponse,
  parseTeamMessagePage,
  parseTeamMessageDeleteResponse,
  parseTeamMessageDismissResponse,
  parseTeamMessageHistory,
  parseTeamMessageReceiptResponse,
  parseTeamMessageResponse,
  parseTeamMessagesCapability,
  parseTeamMailSubjectsCapability,
  parseTeamMailboxStateCapability,
  parseTeamMailboxStateResponse,
  parseTeamAllServersAliasCapability,
  parseTeamSkillDetails,
  parseTeamSkillPage,
  parseTeamSkillResponse,
  parseTeamSkillVersionResponse,
  parseTeamSkillVersionsPage
} from '../shared/team-network'
import { normalizeMountedTeamHubURL } from '../shared/team-hub-url'
import type {
  SecurePeerPairing,
  SecurePeerRevokeInput
} from '../shared/secure-peer'
import { parseSecurePeerPairing } from './secure-peer-contract'

const DEFAULT_TIMEOUT_MS = 15_000
const BINARY_TIMEOUT_MS = 120_000
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_BINARY_ERROR_BYTES = 64 * 1024
const MAX_ATTACHMENT_CHUNK_BYTES = 8 * 1024 * 1024
const MESSAGE_PAGE_LIMIT = 20

export interface TeamHubHealthResponse {
  ok: true
  service: 'agentsdock-team-hub'
  api_version: 1
  schema_version?: number
  hub_id: string
  instance_id: string
  bootstrapped: boolean
  bootstrap_required: boolean
  peer_session_available?: boolean
  server_session_available?: boolean
  capabilities?: {
    team_network_v1?: TeamNetworkCapabilities
    team_messages_v1?: TeamMessagesCapability
    team_mail_subjects_v1?: TeamMailSubjectsCapability
    team_mailbox_state_v1?: TeamMailboxStateCapability
    team_all_servers_alias_v1?: import('../shared/types').TeamAllServersAliasCapability
  }
}

export interface TeamHubAuthBundle {
  access_token: string
  token_type: 'Bearer'
  access_expires_at: string
  refresh_token: string
  refresh_expires_at: string
  session: TeamHubSessionSummary
  principal: TeamHubPrincipal
  teams: TeamHubTeam[]
}

export interface TeamHubSessionResponse {
  session: TeamHubSessionSummary
  principal: TeamHubPrincipal
  teams: TeamHubTeam[]
}

export interface TeamHubInvitationSecret {
  invitation: {
    id: string
    team_id: string
    invitee_email: string
    role: string
    expires_at: string
  }
  token: string
}

export interface TeamHubEnrollmentSecret {
  enrollment: {
    id: string
    team_id: string
    server_identity: string
    display_name: string
    public_key_fingerprint: string
    expires_at: string
  }
  token: string
}

export interface TeamHubInvitationAcceptanceResponse {
  membership: TeamHubAcceptedMembership
  teams: TeamHubTeam[]
}

export class TeamHubClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'TeamHubClientError'
  }
}

/** A redacted, typed failure to receive an HTTP response from the Hub. */
export class TeamHubTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamHubTransportError'
  }
}

export interface TeamHubClientOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  /** Test seam for body-stream deadlines after response headers arrive. */
  timeoutSignal?: (timeoutMs: number) => AbortSignal
}

export class TeamHubClient {
  private readonly baseURL: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly timeoutSignal: (timeoutMs: number) => AbortSignal
  private readonly abortController = new AbortController()
  private teamMessageRevisionQueriesSupported: boolean | null = null
  private teamMailSubjectsAvailable = false
  private teamMailboxStateAvailable = false

  constructor(baseURL: string, options: TeamHubClientOptions = {}) {
    this.baseURL = normalizeMountedTeamHubURL(baseURL)
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.timeoutSignal = options.timeoutSignal ?? (timeoutMs => AbortSignal.timeout(timeoutMs))
  }

  dispose(): void {
    this.abortController.abort()
  }

  async health(): Promise<TeamHubHealthResponse> {
    this.teamMailSubjectsAvailable = false
    this.teamMailboxStateAvailable = false
    const health = parseHealth(await this.request('/v1/health'))
    this.teamMailSubjectsAvailable = health.capabilities?.team_mail_subjects_v1?.available === true
    this.teamMailboxStateAvailable = health.capabilities?.team_mailbox_state_v1?.available === true
    return health
  }

  peerSession(): Promise<TeamHubSessionResponse> {
    return this.request('/v1/peer-session').then(parseSessionResponse)
  }

  serverSession(): Promise<TeamHubSessionResponse> {
    return this.request('/v1/server-session').then(parseSessionResponse)
  }

  bootstrap(
    proof: string,
    input: { email: string; display_name: string; device_label: string },
    requestId?: string
  ): Promise<TeamHubAuthBundle> {
    return this.request('/v1/bootstrap/redeem', {
      method: 'POST',
      headers: {
        'X-Team-Hub-Bootstrap-Proof': proof,
        ...(requestId ? { 'X-Team-Hub-Bootstrap-Request-Id': requestId } : {})
      },
      body: input,
      sensitiveValues: [proof]
    }).then(parseAuthBundle)
  }

  redeemInvitation(token: string, input: { email: string; display_name: string; device_label: string }): Promise<TeamHubAuthBundle> {
    return this.request('/v1/invitations/redeem', {
      method: 'POST',
      body: { token, ...input },
      sensitiveValues: [token]
    }).then(parseAuthBundle)
  }

  acceptInvitation(accessToken: string, token: string): Promise<TeamHubInvitationAcceptanceResponse> {
    return this.authenticated('/v1/invitations/accept', accessToken, {
      method: 'POST',
      body: { token },
      sensitiveValues: [token]
    }).then(parseInvitationAcceptance)
  }

  recoverDevice(proof: string, input: { device_label: string }): Promise<TeamHubAuthBundle> {
    return this.request('/v1/device-recovery/redeem', {
      method: 'POST',
      headers: { 'X-Team-Hub-Device-Recovery-Proof': proof },
      body: input,
      sensitiveValues: [proof]
    }).then(parseAuthBundle)
  }

  refresh(refreshToken: string): Promise<TeamHubAuthBundle> {
    return this.request('/v1/sessions/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
      sensitiveValues: [refreshToken]
    }).then(parseAuthBundle)
  }

  session(accessToken: string): Promise<TeamHubSessionResponse> {
    return this.authenticated('/v1/session', accessToken).then(parseSessionResponse)
  }

  deviceSessions(accessToken: string, cursor?: string, limit = 50): Promise<TeamHubDeviceSessionPage> {
    return this.authenticated(`/v1/sessions?${pageQuery(cursor, limit)}`, accessToken).then(parseDeviceSessionPage)
  }

  revokeDeviceSession(accessToken: string, sessionId: string): Promise<{ revoked: true }> {
    return this.authenticated(`/v1/sessions/${segment(sessionId)}/revoke`, accessToken, { method: 'POST' })
      .then(parseRevokedResponse)
  }

  revoke(accessToken: string, refreshToken: string): Promise<{ revoked: true }> {
    return this.authenticated('/v1/sessions/revoke', accessToken, {
      method: 'POST',
      body: { refresh_token: refreshToken },
      sensitiveValues: [refreshToken]
    }).then(value => {
      if (record(value, 'revoke response').revoked !== true) throw invalidResponse()
      return { revoked: true as const }
    })
  }

  teams(accessToken: string): Promise<{ teams: TeamHubTeam[] }> {
    return this.authenticated('/v1/teams', accessToken).then(parseTeamsResponse)
  }

  team(accessToken: string, teamId: string): Promise<{ team: TeamHubTeam }> {
    return this.authenticated(`/v1/teams/${segment(teamId)}`, accessToken).then(value => ({ team: parseTeam(record(value, 'team response').team) }))
  }

  members(accessToken: string, teamId: string, cursor?: string, _limit = 50): Promise<TeamHubMembershipPage> {
    // beta.33 returns the complete visible member list and its secure-peer
    // allowlist rejects every query on this route. Keep it query-free until a
    // negotiated Hub capability explicitly enables pagination.
    if (cursor !== undefined) {
      return Promise.reject(new Error('Team member pagination is not supported by this Hub.'))
    }
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/members`,
      accessToken
    ).then(parseMembershipPage)
  }

  updateMember(
    accessToken: string,
    teamId: string,
    principalId: string,
    patch: TeamHubUpdateMemberInput['patch']
  ): Promise<{ member: TeamHubMembership }> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/members/${segment(principalId)}`,
      accessToken,
      { method: 'PATCH', body: patch }
    ).then(value => ({ member: parseMembership(record(value, 'member response').member) }))
  }

  nodes(accessToken: string, teamId: string): Promise<{ nodes: TeamHubNode[] }> {
    return this.authenticated(`/v1/teams/${segment(teamId)}/nodes`, accessToken).then(value => ({
      nodes: boundedArray(record(value, 'nodes response').nodes, 'nodes', 2_000).map(parseNode)
    }))
  }

  channels(accessToken: string, teamId: string): Promise<{ channels: TeamHubChannel[] }> {
    return this.authenticated(`/v1/teams/${segment(teamId)}/channels`, accessToken).then(value => ({
      channels: boundedArray(record(value, 'channels response').channels, 'channels', 2_000).map(parseChannel)
    }))
  }

  createInvitation(
    accessToken: string,
    teamId: string,
    body: { invitee_email: string; role: string; ttl_seconds?: number }
  ): Promise<TeamHubInvitationSecret> {
    return this.authenticated(`/v1/teams/${segment(teamId)}/invitations`, accessToken, { method: 'POST', body }).then(parseInvitationSecret)
  }

  invitations(accessToken: string, teamId: string, cursor?: string, limit = 50): Promise<TeamHubInvitationPage> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/invitations?${pageQuery(cursor, limit)}`,
      accessToken
    ).then(parseInvitationPage)
  }

  revokeInvitation(accessToken: string, teamId: string, invitationId: string): Promise<{ revoked: true }> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/invitations/${segment(invitationId)}/revoke`,
      accessToken,
      { method: 'POST' }
    ).then(parseRevokedResponse)
  }

  createNodeEnrollment(
    accessToken: string,
    teamId: string,
    body: { server_identity: string; display_name: string; public_key: string; ttl_seconds?: number }
  ): Promise<TeamHubEnrollmentSecret> {
    return this.authenticated(`/v1/teams/${segment(teamId)}/node-enrollments`, accessToken, { method: 'POST', body }).then(parseEnrollmentSecret)
  }

  createChannel(
    accessToken: string,
    teamId: string,
    body: {
      kind: 'board' | 'announcements' | 'direct'
      visibility: 'team' | 'private'
      slug?: string
      display_name?: string
      participant_principal_ids?: string[]
      idempotency_key: string
    }
  ): Promise<{ channel: TeamHubChannel }> {
    return this.authenticated(`/v1/teams/${segment(teamId)}/channels`, accessToken, { method: 'POST', body }).then(value => ({
      channel: parseChannel(record(value, 'channel response').channel)
    }))
  }

  messages(accessToken: string, channelId: string, beforeSequence?: number): Promise<{
    messages: TeamHubMessage[]
    next_before_sequence: number | null
  }> {
    const query = new URLSearchParams({ limit: String(MESSAGE_PAGE_LIMIT) })
    if (beforeSequence !== undefined) query.set('before_sequence', String(beforeSequence))
    return this.authenticated(`/v1/channels/${segment(channelId)}/messages?${query}`, accessToken).then(parseMessagesResponse)
  }

  postMessage(
    accessToken: string,
    channelId: string,
    body: {
      body: string
      body_format: 'plain' | 'markdown'
      kind: 'post' | 'announcement'
      thread_root_message_id?: string
      parent_message_id?: string
      idempotency_key: string
    }
  ): Promise<{ message: TeamHubMessage }> {
    return this.authenticated(`/v1/channels/${segment(channelId)}/messages`, accessToken, { method: 'POST', body }).then(value => ({
      message: parseMessage(record(value, 'message response').message)
    }))
  }

  securePeers(accessToken: string, teamId: string): Promise<{ peers: SecurePeerPairing[] }> {
    return this.authenticated(`/v1/teams/${segment(teamId)}/secure-peers`, accessToken).then(value => ({
      peers: boundedArray(record(value, 'secure peers response').peers, 'peers', 512).map(peer => parseSecurePeerPairing(peer))
    }))
  }

  revokeSecurePeer(
    accessToken: string,
    teamId: string,
    input: SecurePeerRevokeInput
  ): Promise<{ peer: SecurePeerPairing }> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/secure-peers/${segment(securePeerUUID(input.peerId, 'peer'))}/revoke`,
      accessToken,
      {
        method: 'POST',
        body: {
          idempotency_key: idempotencyKey(input.idempotencyKey),
          expected_certificate_fingerprint: certificateFingerprint(input.expectedCertificateFingerprint)
        }
      }
    ).then(value => ({ peer: parseSecurePeerPairing(record(value, 'revoke peer response').peer) }))
  }

  network(accessToken: string, teamId: string, afterServerId: string | null, limit: number): Promise<TeamNetworkProjectionPage> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (afterServerId) query.set('after_server_id', afterServerId)
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network?${query}`,
      accessToken
    ).then(parseTeamNetworkProjection)
  }

  registerNetworkAgent(
    accessToken: string,
    teamId: string,
    body: {
      external_agent_id: string
      backend: TeamNetworkAgentBackend
      display_name: string
      idempotency_key: string
    }
  ): Promise<{ agent: TeamNetworkAgent }> {
    return this.authenticated(`/v1/teams/${segment(teamId)}/network/agents`, accessToken, {
      method: 'POST', body
    }).then(parseTeamNetworkAgentResponse)
  }

  networkBulletin(
    accessToken: string,
    teamId: string,
    afterSequence: number,
    limit: number
  ): Promise<TeamNetworkBulletinPage> {
    const query = new URLSearchParams({
      after_sequence: String(afterSequence),
      limit: String(limit)
    })
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/bulletin?${query}`,
      accessToken
    ).then(parseTeamNetworkBulletinPage)
  }

  postNetworkBulletin(
    accessToken: string,
    teamId: string,
    body: {
      body: string
      body_format: TeamNetworkBodyFormat
      reply_to_post_id?: string
      idempotency_key: string
    }
  ): Promise<{ post: TeamNetworkBulletinPost }> {
    return this.authenticated(`/v1/teams/${segment(teamId)}/network/bulletin`, accessToken, {
      method: 'POST', body
    }).then(parseTeamNetworkBulletinPostResponse)
  }

  deleteNetworkBulletin(
    accessToken: string,
    teamId: string,
    postId: string,
    body: { idempotency_key: string }
  ): Promise<TeamNetworkDeleteBulletinResult> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/bulletin/${segment(postId)}`,
      accessToken,
      { method: 'DELETE', body }
    ).then(parseTeamNetworkBulletinDeleteResponse)
  }

  networkDeletions(
    accessToken: string,
    teamId: string,
    afterSequence: number,
    limit: number
  ): Promise<TeamNetworkDeletionPage> {
    const query = new URLSearchParams({
      after_sequence: String(afterSequence),
      limit: String(limit)
    })
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/deletions?${query}`,
      accessToken
    ).then(parseTeamNetworkDeletionPage)
  }

  networkMailbox(
    accessToken: string,
    teamId: string,
    address: TeamNetworkMailboxAddress,
    afterSequence: number,
    limit: number
  ): Promise<TeamNetworkMailboxPage> {
    const query = new URLSearchParams({
      address_kind: address.kind,
      address_id: address.id,
      after_sequence: String(afterSequence),
      limit: String(limit)
    })
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/mailbox?${query}`,
      accessToken
    ).then(parseTeamNetworkMailboxPage)
  }

  sendNetworkMailbox(
    accessToken: string,
    teamId: string,
    body: {
      to: TeamNetworkAddress
      from_agent_id?: string
      body: string
      body_format: TeamNetworkBodyFormat
      idempotency_key: string
    }
  ): Promise<TeamNetworkMailboxEntry> {
    return this.authenticated(`/v1/teams/${segment(teamId)}/network/mailbox`, accessToken, {
      method: 'POST', body
    }).then(parseTeamNetworkMailboxEntry)
  }

  networkItem(accessToken: string, teamId: string, itemId: string): Promise<TeamNetworkMailboxEntry> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/items/${segment(itemId)}`,
      accessToken
    ).then(parseTeamNetworkMailboxEntry)
  }

  recordNetworkDeliveryReceipt(
    accessToken: string,
    teamId: string,
    deliveryId: string,
    body: { state: TeamNetworkReceiptState; idempotency_key: string; address_kind?: 'server' | 'human'; address_id?: string }
  ): Promise<{ delivery: TeamNetworkDelivery }> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/deliveries/${segment(deliveryId)}/receipts`,
      accessToken,
      { method: 'POST', body }
    ).then(parseTeamNetworkDeliveryResponse)
  }

  createNetworkPassiveRequest(
    accessToken: string,
    teamId: string,
    body: {
      to: TeamNetworkAddress
      from_agent_id?: string
      body: string
      body_format: TeamNetworkBodyFormat
      idempotency_key: string
      expires_in_seconds: number
    }
  ): Promise<TeamNetworkPassiveRequestCreated> {
    return this.authenticated(`/v1/teams/${segment(teamId)}/network/requests`, accessToken, {
      method: 'POST', body
    }).then(parseTeamNetworkPassiveRequestCreated)
  }

  networkPassiveRequest(
    accessToken: string,
    teamId: string,
    requestId: string
  ): Promise<TeamNetworkPassiveRequestDetails> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/requests/${segment(requestId)}`,
      accessToken
    ).then(parseTeamNetworkPassiveRequestDetails)
  }

  replyNetworkPassiveRequest(
    accessToken: string,
    teamId: string,
    requestId: string,
    body: {
      from_agent_id?: string
      body: string
      body_format: TeamNetworkBodyFormat
      idempotency_key: string
    }
  ): Promise<TeamNetworkPassiveRequestReply> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/requests/${segment(requestId)}/replies`,
      accessToken,
      { method: 'POST', body }
    ).then(parseTeamNetworkPassiveRequestCreated)
  }

  async teamMessages(
    accessToken: string,
    teamId: string,
    queryInput: Omit<TeamMessageQuery, 'teamId'>
  ): Promise<TeamMessagePage> {
    const query = new URLSearchParams({ box: queryInput.box, limit: String(queryInput.limit ?? 50) })
    if (this.teamMailboxStateAvailable && queryInput.box === 'inbox') query.set('include_mailbox_state', 'true')
    if (this.teamMailSubjectsAvailable) query.set('include_mail_subject', 'true')
    if (queryInput.addressKind) query.set('address_kind', queryInput.addressKind)
    if (queryInput.addressId) query.set('address_id', queryInput.addressId)
    if (queryInput.unread) query.set('unread', '1')
    if (queryInput.fromKind) query.set('from_kind', queryInput.fromKind)
    if (queryInput.fromId) query.set('from_id', queryInput.fromId)
    if (queryInput.since) query.set('since', queryInput.since)
    if (queryInput.afterSequence) query.set('after_sequence', String(queryInput.afterSequence))
    const request = (includeRevision: boolean) => {
      if (includeRevision) query.set('include_revision', '1')
      else query.delete('include_revision')
      return this.authenticated(
        `/v1/teams/${segment(teamId)}/network/messages?${query}`,
        accessToken
      ).then(value => parseTeamMessagePage(value, teamId))
    }
    if (this.teamMessageRevisionQueriesSupported === false) return request(false)
    try {
      const page = await request(true)
      this.teamMessageRevisionQueriesSupported = true
      return page
    } catch (cause) {
      if (!(cause instanceof TeamHubClientError) || cause.status !== 422) throw cause
      this.teamMessageRevisionQueriesSupported = false
      return request(false)
    }
  }

  async teamMessage(accessToken: string, teamId: string, messageId: string): Promise<TeamMessage> {
    const path = `/v1/teams/${segment(teamId)}/network/messages/${segment(messageId)}`
    const query = new URLSearchParams()
    if (this.teamMailboxStateAvailable) query.set('include_mailbox_state', 'true')
    if (this.teamMailSubjectsAvailable) query.set('include_mail_subject', 'true')
    const request = (includeRevision: boolean) => {
      if (includeRevision) query.set('include_revision', '1')
      else query.delete('include_revision')
      return this.authenticated(`${path}${query.size ? `?${query}` : ''}`, accessToken)
        .then(value => parseTeamMessageResponse(value, teamId)).then(result => result.message)
    }
    if (this.teamMessageRevisionQueriesSupported === false) return request(false)
    try {
      const message = await request(true)
      this.teamMessageRevisionQueriesSupported = true
      return message
    } catch (cause) {
      if (!(cause instanceof TeamHubClientError) || cause.status !== 422) throw cause
      this.teamMessageRevisionQueriesSupported = false
      return request(false)
    }
  }

  createTeamMessage(
    accessToken: string,
    teamId: string,
    body: {
      kind: 'message' | 'skill'
      title?: string
      body: string
      body_format: TeamNetworkBodyFormat
      recipients: Array<{ kind: 'server' | 'human' | 'all' | 'all_servers'; id?: string }>
      attachment_ids: string[]
      in_reply_to_message_id?: string
      skill?: {
        slug: string
        summary?: string
        tags?: string[]
        change_note?: string
        expected_version?: number
      }
      provenance?: TeamMessageProvenance
      idempotency_key: string
    }
  ): Promise<TeamMessage> {
    return this.authenticated(`/v1/teams/${segment(teamId)}/network/messages`, accessToken, {
      method: 'POST', body
    }).then(value => parseTeamMessageResponse(value, teamId)).then(result => result.message)
  }

  recordTeamMessageReceipt(
    accessToken: string,
    teamId: string,
    messageId: string,
    body: { state: TeamNetworkReceiptState; idempotency_key: string }
  ): Promise<TeamMessageReceiptResult> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/messages/${segment(messageId)}/receipts`,
      accessToken,
      { method: 'POST', body }
    ).then(parseTeamMessageReceiptResponse)
  }

  setTeamMessageMailboxState(accessToken: string, teamId: string, messageId: string,
    body: { address_kind: 'server'; address_id: string; unread: boolean; expected_version: number; idempotency_key: string }) {
    return this.authenticated(`/v1/teams/${segment(teamId)}/network/messages/${segment(messageId)}/mailbox-state`,
      accessToken, { method: 'POST', body }).then(parseTeamMailboxStateResponse)
  }

  dismissTeamMessage(accessToken: string, teamId: string, messageId: string,
    body: { address_kind: 'server' | 'human'; address_id: string; idempotency_key: string }) {
    return this.authenticated(`/v1/teams/${segment(teamId)}/network/messages/${segment(messageId)}/dismissals`,
      accessToken, { method: 'POST', body }).then(parseTeamMessageDismissResponse)
  }

  teamMessageHistory(accessToken: string, teamId: string, messageId: string, version?: number) {
    return this.authenticated(`/v1/teams/${segment(teamId)}/network/messages/${segment(messageId)}/revisions${version === undefined ? '' : `?version=${version}`}`,
      accessToken).then(parseTeamMessageHistory)
  }

  deleteTeamMessage(
    accessToken: string,
    teamId: string,
    messageId: string,
    body: { idempotency_key: string }
  ): Promise<TeamMessageDeleteResult> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/messages/${segment(messageId)}`,
      accessToken,
      { method: 'DELETE', body }
    ).then(parseTeamMessageDeleteResponse)
  }

  reviseTeamMessage(
    accessToken: string,
    teamId: string,
    messageId: string,
    body: {
      body: string
      body_format: TeamNetworkBodyFormat
      expected_version: number
      idempotency_key: string
    }
  ): Promise<TeamMessage> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/messages/${segment(messageId)}/revisions${this.teamMailSubjectsAvailable ? '?include_mail_subject=true' : ''}`,
      accessToken,
      { method: 'POST', body }
    ).then(value => parseTeamMessageResponse(value, teamId)).then(result => result.message)
  }

  declareTeamAttachment(
    accessToken: string,
    teamId: string,
    body: {
      file_name: string
      media_type: string
      byte_size: number
      sha256: string
      idempotency_key: string
    },
    signal?: AbortSignal
  ): Promise<TeamAttachmentDeclaration> {
    return this.authenticated(`/v1/teams/${segment(teamId)}/network/attachments`, accessToken, {
      method: 'POST', body, signal
    }).then(value => parseTeamAttachmentDeclaration(value, teamId))
  }

  teamAttachment(
    accessToken: string,
    teamId: string,
    attachmentId: string,
    signal?: AbortSignal
  ): Promise<TeamAttachment> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/attachments/${segment(attachmentId)}`,
      accessToken,
      { signal }
    ).then(value => parseTeamAttachmentResponse(value, teamId)).then(result => result.attachment)
  }

  async uploadTeamAttachmentChunk(
    accessToken: string,
    teamId: string,
    attachmentId: string,
    bytes: Uint8Array,
    start: number,
    total: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (
      !bytes.byteLength
      || bytes.byteLength > MAX_ATTACHMENT_CHUNK_BYTES
      || !Number.isSafeInteger(start)
      || start < 0
      || !Number.isSafeInteger(total)
      || total < 1
      || start + bytes.byteLength > total
    ) {
      throw new Error('Invalid Team attachment chunk.')
    }
    const end = start + bytes.byteLength - 1
    const response = await this.binaryAuthenticated(
      `/v1/teams/${segment(teamId)}/network/attachments/${segment(attachmentId)}/content`,
      accessToken,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.byteLength),
          'Content-Range': `bytes ${start}-${end}/${total}`
        },
        body: bytes,
        signal
      }
    )
    await response.body?.cancel().catch(() => undefined)
  }

  downloadTeamAttachmentChunk(
    accessToken: string,
    teamId: string,
    attachmentId: string,
    start: number,
    end: number,
    callerSignal?: AbortSignal
  ): Promise<Response> {
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || end < start
      || end - start + 1 > MAX_ATTACHMENT_CHUNK_BYTES
    ) {
      throw new Error('Invalid Team attachment byte range.')
    }
    return this.binaryAuthenticated(
      `/v1/teams/${segment(teamId)}/network/attachments/${segment(attachmentId)}/content`,
      accessToken,
      { method: 'GET', headers: { Range: `bytes=${start}-${end}` }, signal: callerSignal }
    )
  }

  teamSkills(
    accessToken: string,
    teamId: string,
    includeArchived: boolean,
    slug?: string
  ): Promise<TeamSkillPage> {
    const query = new URLSearchParams({ include_archived: includeArchived ? '1' : '0' })
    if (slug) query.set('slug', slug)
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/skills?${query}`,
      accessToken
    ).then(value => parseTeamSkillPage(value, teamId))
  }

  teamSkill(accessToken: string, teamId: string, skillId: string): Promise<TeamSkillDetails> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/skills/${segment(skillId)}`,
      accessToken
    ).then(value => parseTeamSkillDetails(value, teamId)).then(result => result.skill)
  }

  teamSkillVersions(accessToken: string, teamId: string, skillId: string): Promise<TeamSkillVersionsPage> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/skills/${segment(skillId)}/versions`,
      accessToken
    ).then(value => parseTeamSkillVersionsPage(value, teamId))
  }

  teamSkillVersion(
    accessToken: string,
    teamId: string,
    skillId: string,
    version: number
  ): Promise<TeamSkillVersion> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/skills/${segment(skillId)}/versions/${version}`,
      accessToken
    ).then(value => parseTeamSkillVersionResponse(value, teamId)).then(result => result.version)
  }

  pinTeamSkill(
    accessToken: string,
    teamId: string,
    skillId: string,
    body: { pinned: boolean; idempotency_key: string }
  ): Promise<TeamSkill> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/skills/${segment(skillId)}/pin`,
      accessToken,
      { method: 'POST', body }
    ).then(value => parseTeamSkillResponse(value, teamId)).then(result => result.skill)
  }

  archiveTeamSkill(
    accessToken: string,
    teamId: string,
    skillId: string,
    body: { archived: boolean; idempotency_key: string }
  ): Promise<TeamSkill> {
    return this.authenticated(
      `/v1/teams/${segment(teamId)}/network/skills/${segment(skillId)}/archive`,
      accessToken,
      { method: 'POST', body }
    ).then(value => parseTeamSkillResponse(value, teamId)).then(result => result.skill)
  }

  private authenticated(
    path: string,
    accessToken: string,
    options: Omit<RequestOptions, 'accessToken'> = {}
  ): Promise<unknown> {
    return this.request(path, {
      ...options,
      accessToken,
      sensitiveValues: [...(options.sensitiveValues ?? []), accessToken]
    })
  }

  private binaryAuthenticated(
    path: string,
    accessToken: string,
    options: BinaryRequestOptions
  ): Promise<Response> {
    return this.binaryRequest(path, {
      ...options,
      accessToken,
      sensitiveValues: [...(options.sensitiveValues ?? []), accessToken]
    })
  }

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid Team Hub request path.')
    const url = `${this.baseURL}${path}`
    const method = options.method ?? 'GET'
    const headers = new Headers({ Accept: 'application/json' })
    if (options.accessToken) headers.set('Authorization', `Bearer ${options.accessToken}`)
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value)
    let body: string | undefined
    if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      const length = Buffer.byteLength(body)
      if (length > MAX_REQUEST_BYTES) throw new Error('Team Hub request is too large.')
      headers.set('Content-Type', 'application/json')
      headers.set('Content-Length', String(length))
    }
    let response: Response
    const timeoutSignal = this.timeoutSignal(this.timeoutMs)
    const requestSignal = AbortSignal.any([
      this.abortController.signal,
      timeoutSignal,
      ...(options.signal ? [options.signal] : [])
    ])
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        redirect: 'error',
        signal: requestSignal
      })
    } catch (error) {
      if (this.abortController.signal.aborted) throw new Error('The Team Hub connection changed.')
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('The Team attachment operation was cancelled.')
      if (timeoutSignal.aborted || error instanceof Error && error.name === 'TimeoutError') {
        throw new TeamHubTransportError('Team Hub did not respond in time.')
      }
      throw new TeamHubTransportError('Could not reach Team Hub.')
    }
    const declaredLength = Number(response.headers.get('Content-Length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error('Team Hub response is too large.')
    let text: string
    try {
      text = await readBoundedResponse(response, MAX_RESPONSE_BYTES, 'Team Hub response is too large.', requestSignal)
    } catch (error) {
      throw responseBodyError(
        error,
        this.abortController.signal,
        timeoutSignal,
        'Team Hub response stream was interrupted.',
        options.signal
      )
    }
    let payload: unknown = {}
    if (text) {
      try { payload = JSON.parse(text) }
      catch { throw new Error('Team Hub returned an invalid response.') }
    }
    if (!response.ok) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {}
      const code = cleanErrorCode(error.code)
      const message = redactSensitive(cleanErrorMessage(error.message, response.status), options.sensitiveValues ?? [])
      throw new TeamHubClientError(response.status, code, message)
    }
    if (!isRecord(payload)) throw new Error('Team Hub returned an invalid response.')
    return payload
  }

  private async binaryRequest(path: string, options: BinaryRequestOptions): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid Team Hub request path.')
    const headers = new Headers(options.headers)
    headers.set('Accept', 'application/octet-stream, application/json')
    if (options.accessToken) headers.set('Authorization', `Bearer ${options.accessToken}`)
    let response: Response
    const timeoutSignal = this.timeoutSignal(BINARY_TIMEOUT_MS)
    const requestSignal = AbortSignal.any([
      this.abortController.signal,
      timeoutSignal,
      ...(options.signal ? [options.signal] : [])
    ])
    try {
      response = await this.fetchImpl(`${this.baseURL}${path}`, {
        method: options.method,
        headers,
        body: options.body as BodyInit | undefined,
        redirect: 'error',
        signal: requestSignal
      })
    } catch (error) {
      if (this.abortController.signal.aborted) throw new Error('The Team Hub connection changed.')
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('The Team attachment transfer was cancelled.')
      if (timeoutSignal.aborted || error instanceof Error && error.name === 'TimeoutError') {
        throw new TeamHubTransportError('Team attachment transfer timed out.')
      }
      throw new TeamHubTransportError('Could not reach Team Hub.')
    }
    if (response.ok) return responseWithTypedBody(
      response,
      this.abortController.signal,
      timeoutSignal,
      'Team attachment transfer was interrupted.',
      options.signal
    )
    let raw = ''
    try {
      raw = await readBoundedResponse(
        response,
        MAX_BINARY_ERROR_BYTES,
        'Team Hub attachment error response is too large.',
        requestSignal
      )
    } catch (error) {
      const translated = responseBodyError(
        error,
        this.abortController.signal,
        timeoutSignal,
        'Team attachment error response was interrupted.',
        options.signal
      )
      if (
        translated instanceof TeamHubTransportError
        || this.abortController.signal.aborted
        || options.signal?.aborted
      ) throw translated
      // A bounded error body is optional; retain the authoritative HTTP status.
    }
    let payload: unknown = {}
    try { payload = raw ? JSON.parse(raw) : {} } catch { /* preserve generic error */ }
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {}
    const code = cleanErrorCode(error.code)
    const message = redactSensitive(cleanErrorMessage(error.message, response.status), options.sensitiveValues ?? [])
    throw new TeamHubClientError(response.status, code, message)
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  accessToken?: string
  sensitiveValues?: string[]
  signal?: AbortSignal
}

interface BinaryRequestOptions {
  method: 'GET' | 'PUT' | 'HEAD'
  headers?: Record<string, string>
  body?: Uint8Array
  accessToken?: string
  sensitiveValues?: string[]
  signal?: AbortSignal
}

function segment(value: string): string {
  const clean = value.trim()
  if (!clean || clean.length > 240 || /[\u0000-\u001f\u007f]/.test(clean)) throw new Error('Invalid Team Hub identifier.')
  return encodeURIComponent(clean)
}

function idempotencyKey(value: unknown): string {
  const clean = identifier(value, 'idempotency key')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clean)) {
    throw new Error('Invalid secure peer idempotency key.')
  }
  return clean
}

function securePeerUUID(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`Invalid secure peer ${label} identifier.`)
  }
  return value
}

function certificateFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error('Invalid peer certificate fingerprint.')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanErrorCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'request_failed'
}

function cleanErrorMessage(value: unknown, status: number): string {
  if (typeof value !== 'string') return `Team Hub request failed (${status}).`
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 400)
  return clean || `Team Hub request failed (${status}).`
}

function redactSensitive(message: string, values: string[]): string {
  let redacted = message
  for (const value of values) {
    if (value) redacted = redacted.split(value).join('[redacted]')
  }
  return redacted
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
}

async function readBoundedResponse(
  response: Response,
  maximumBytes = MAX_RESPONSE_BYTES,
  tooLargeMessage = 'Team Hub response is too large.',
  signal?: AbortSignal
): Promise<string> {
  const rawLength = response.headers.get('Content-Length')
  if (rawLength !== null && (/^\d+$/.test(rawLength) ? Number(rawLength) : Number.POSITIVE_INFINITY) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(tooLargeMessage)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const cancelForAbort = () => { void reader.cancel(signal?.reason).catch(() => undefined) }
  if (signal?.aborted) cancelForAbort()
  else signal?.addEventListener('abort', cancelForAbort, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
      signal?.throwIfAborted()
      if (item.done) break
      total += item.value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(tooLargeMessage)
      }
      chunks.push(item.value)
    }
    const declaredLength = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : null
    if (declaredLength !== null && total !== declaredLength) {
      throw new TeamHubTruncatedResponseError()
    }
  } finally {
    signal?.removeEventListener('abort', cancelForAbort)
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total).toString('utf8')
}

class TeamHubTruncatedResponseError extends Error {}

function responseBodyError(
  error: unknown,
  connectionSignal: AbortSignal,
  timeoutSignal: AbortSignal,
  interruptedMessage: string,
  callerSignal?: AbortSignal
): unknown {
  if (connectionSignal.aborted) return new Error('The Team Hub connection changed.')
  if (callerSignal?.aborted) return callerSignal.reason ?? new Error('The Team attachment transfer was cancelled.')
  if (timeoutSignal.aborted) return new TeamHubTransportError('Team Hub did not respond in time.')
  if (error instanceof TeamHubTruncatedResponseError) return new TeamHubTransportError(interruptedMessage)
  if (error instanceof Error && /response is too large/i.test(error.message)) return error
  return new TeamHubTransportError(interruptedMessage)
}

function responseWithTypedBody(
  response: Response,
  connectionSignal: AbortSignal,
  timeoutSignal: AbortSignal,
  interruptedMessage: string,
  callerSignal?: AbortSignal
): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  const rawLength = response.headers.get('Content-Length')
  const declaredLength = rawLength !== null && /^\d+$/.test(rawLength) && Number.isSafeInteger(Number(rawLength))
    ? Number(rawLength)
    : null
  let receivedBytes = 0
  const signals = [connectionSignal, timeoutSignal, ...(callerSignal ? [callerSignal] : [])]
  const requestSignal = AbortSignal.any(signals)
  const cancelForAbort = () => { void reader.cancel(requestSignal.reason).catch(() => undefined) }
  if (requestSignal.aborted) cancelForAbort()
  else requestSignal.addEventListener('abort', cancelForAbort, { once: true })
  const release = () => {
    requestSignal.removeEventListener('abort', cancelForAbort)
    try { reader.releaseLock() } catch { /* already released */ }
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read()
        requestSignal.throwIfAborted()
        if (item.done) {
          release()
          if (declaredLength !== null && receivedBytes !== declaredLength) {
            controller.error(new TeamHubTransportError(interruptedMessage))
          } else {
            controller.close()
          }
        } else {
          receivedBytes += item.value.byteLength
          if (declaredLength !== null && receivedBytes > declaredLength) {
            await reader.cancel().catch(() => undefined)
            release()
            controller.error(new TeamHubTransportError(interruptedMessage))
          } else {
            controller.enqueue(item.value)
          }
        }
      } catch (error) {
        release()
        controller.error(responseBodyError(error, connectionSignal, timeoutSignal, interruptedMessage, callerSignal))
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined)
      release()
    }
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

function parseHealth(value: unknown): TeamHubHealthResponse {
  const item = record(value, 'health response')
  if (
    item.ok !== true
    || item.service !== 'agentsdock-team-hub'
    || item.api_version !== 1
    || typeof item.bootstrapped !== 'boolean'
    || typeof item.bootstrap_required !== 'boolean'
    || item.bootstrapped === item.bootstrap_required
    || item.peer_session_available !== undefined && typeof item.peer_session_available !== 'boolean'
    || item.server_session_available !== undefined && typeof item.server_session_available !== 'boolean'
  ) throw invalidResponse()
  let capabilities: TeamHubHealthResponse['capabilities']
  if (item.capabilities !== undefined) {
    const advertised = record(item.capabilities, 'health capabilities')
    const network = advertised.team_network_v1 === undefined
      ? undefined
      : parseTeamNetworkCapabilities(advertised.team_network_v1)
    const messages = advertised.team_messages_v1 === undefined
      ? undefined
      : parseTeamMessagesCapability(advertised.team_messages_v1)
    const allServers = advertised.team_all_servers_alias_v1 === undefined
      ? undefined
      : parseTeamAllServersAliasCapability(advertised.team_all_servers_alias_v1)
    let mailSubjects: TeamMailSubjectsCapability | undefined
    try {
      if (advertised.team_mail_subjects_v1 !== undefined) {
        mailSubjects = parseTeamMailSubjectsCapability(advertised.team_mail_subjects_v1)
      }
    } catch {
      // Subjects are optional. Unknown/disabled contracts keep legacy mail
      // usable, but must not authorize writes or opt-in reads.
    }
    let mailboxState: TeamMailboxStateCapability | undefined
    try {
      if (advertised.team_mailbox_state_v1 !== undefined) mailboxState = parseTeamMailboxStateCapability(advertised.team_mailbox_state_v1)
    } catch { /* An optional unknown capability cannot authorize mailbox mutations. */ }
    if (network || messages || allServers || mailSubjects || mailboxState) capabilities = {
      ...(network ? { team_network_v1: network } : {}),
      ...(messages ? { team_messages_v1: messages } : {}),
      ...(mailSubjects ? { team_mail_subjects_v1: mailSubjects } : {}),
      ...(mailboxState ? { team_mailbox_state_v1: mailboxState } : {}),
      ...(allServers ? { team_all_servers_alias_v1: allServers } : {})
    }
  }
  return {
    ok: true,
    service: 'agentsdock-team-hub',
    api_version: 1,
    ...(typeof item.schema_version === 'number' && Number.isSafeInteger(item.schema_version) && item.schema_version > 0
      ? { schema_version: item.schema_version } : {}),
    hub_id: identifier(item.hub_id, 'Hub identity'),
    instance_id: identifier(item.instance_id, 'Hub instance'),
    bootstrapped: item.bootstrapped,
    bootstrap_required: item.bootstrap_required,
    ...(typeof item.peer_session_available === 'boolean' ? { peer_session_available: item.peer_session_available } : {}),
    ...(typeof item.server_session_available === 'boolean' ? { server_session_available: item.server_session_available } : {}),
    ...(capabilities ? { capabilities } : {})
  }
}

function parseAuthBundle(value: unknown): TeamHubAuthBundle {
  const item = record(value, 'authentication response')
  if (item.token_type !== 'Bearer') throw invalidResponse()
  const accessExpiresAt = timestamp(item.access_expires_at, 'access expiry')
  const refreshExpiresAt = timestamp(item.refresh_expires_at, 'refresh expiry')
  return {
    access_token: credential(item.access_token, 'access token'),
    token_type: 'Bearer',
    access_expires_at: accessExpiresAt,
    refresh_token: credential(item.refresh_token, 'refresh token'),
    refresh_expires_at: refreshExpiresAt,
    session: parseSession(item.session),
    principal: parsePrincipal(item.principal),
    teams: boundedArray(item.teams, 'teams', 1_000).map(parseTeam)
  }
}

function parseSessionResponse(value: unknown): TeamHubSessionResponse {
  const item = record(value, 'session response')
  return {
    session: parseSession(item.session),
    principal: parsePrincipal(item.principal),
    teams: boundedArray(item.teams, 'teams', 1_000).map(parseTeam)
  }
}

function parseTeamsResponse(value: unknown): { teams: TeamHubTeam[] } {
  return { teams: boundedArray(record(value, 'teams response').teams, 'teams', 1_000).map(parseTeam) }
}

function parseMembershipPage(value: unknown): TeamHubMembershipPage {
  const item = record(value, 'members response')
  // beta.33 returns the complete list without a cursor envelope. Preserve the
  // stricter parser whenever either pagination field is present so a partial
  // or contradictory future response still fails closed.
  const hasMoreField = Object.hasOwn(item, 'has_more')
  const nextCursorField = Object.hasOwn(item, 'next_cursor')
  if (hasMoreField !== nextCursorField) throw invalidResponse()
  const pagination = hasMoreField
    ? parseCursorEnvelope(item, 'members')
    : { has_more: false, next_cursor: null }
  return {
    members: boundedArray(item.members, 'members', 2_000).map(parseMembership),
    ...pagination
  }
}

function parseInvitationPage(value: unknown): TeamHubInvitationPage {
  const item = record(value, 'invitations response')
  const pagination = parseCursorEnvelope(item, 'invitations')
  return {
    invitations: boundedArray(item.invitations, 'invitations', 100).map(parseInvitationSummary),
    ...pagination
  }
}

function parseInvitationSummary(value: unknown): TeamHubInvitationSummary {
  const item = record(value, 'invitation')
  const role = text(item.role, 'invitation role', 32)
  if (!['admin', 'member', 'guest'].includes(role)) throw invalidResponse()
  return {
    id: identifier(item.id, 'invitation'),
    invitee_email: email(item.invitee_email),
    role: role as TeamHubInvitationSummary['role'],
    issued_by_principal_id: identifier(item.issued_by_principal_id, 'invitation issuer'),
    created_at: timestamp(item.created_at, 'invitation creation time'),
    expires_at: timestamp(item.expires_at, 'invitation expiry')
  }
}

function parseDeviceSessionPage(value: unknown): TeamHubDeviceSessionPage {
  const item = record(value, 'sessions response')
  const pagination = parseCursorEnvelope(item, 'sessions')
  return {
    sessions: boundedArray(item.sessions, 'sessions', 100).map(parseDeviceSession),
    ...pagination
  }
}

function parseDeviceSession(value: unknown): TeamHubDeviceSession {
  const item = record(value, 'device session')
  return {
    id: identifier(item.id, 'device session'),
    device_label: text(item.device_label, 'device label', 160),
    created_at: timestamp(item.created_at, 'device session creation time'),
    last_seen_at: timestamp(item.last_seen_at, 'device session last-seen time'),
    expires_at: timestamp(item.expires_at, 'device session expiry'),
    revoked_at: nullableTimestamp(item.revoked_at, 'device session revocation time'),
    current: booleanValue(item.current, 'current-session marker')
  }
}

function parseCursorEnvelope(
  item: Record<string, unknown>,
  label: string
): { has_more: boolean; next_cursor: string | null } {
  const hasMore = booleanValue(item.has_more, `${label} continuation marker`)
  const nextCursor = item.next_cursor == null ? null : opaqueCursor(item.next_cursor, `${label} cursor`)
  if (hasMore !== Boolean(nextCursor)) throw invalidResponse()
  return { has_more: hasMore, next_cursor: nextCursor }
}

function parseRevokedResponse(value: unknown): { revoked: true } {
  if (record(value, 'revocation response').revoked !== true) throw invalidResponse()
  return { revoked: true }
}

function parseInvitationSecret(value: unknown): TeamHubInvitationSecret {
  const item = record(value, 'invitation response')
  const invitation = record(item.invitation, 'invitation')
  const role = text(invitation.role, 'invitation role', 32)
  if (!['admin', 'member', 'guest'].includes(role)) throw invalidResponse()
  return {
    invitation: {
      id: identifier(invitation.id, 'invitation'),
      team_id: identifier(invitation.team_id, 'invitation team'),
      invitee_email: email(invitation.invitee_email),
      role,
      expires_at: timestamp(invitation.expires_at, 'invitation expiry')
    },
    token: credential(item.token, 'invitation token')
  }
}

function parseEnrollmentSecret(value: unknown): TeamHubEnrollmentSecret {
  const item = record(value, 'enrollment response')
  const enrollment = record(item.enrollment, 'enrollment')
  return {
    enrollment: {
      id: identifier(enrollment.id, 'enrollment'),
      team_id: identifier(enrollment.team_id, 'enrollment team'),
      server_identity: identifier(enrollment.server_identity, 'server identity'),
      display_name: text(enrollment.display_name, 'node name', 160),
      public_key_fingerprint: text(enrollment.public_key_fingerprint, 'public key fingerprint', 240),
      expires_at: timestamp(enrollment.expires_at, 'enrollment expiry')
    },
    token: credential(item.token, 'enrollment token')
  }
}

function parseInvitationAcceptance(value: unknown): TeamHubInvitationAcceptanceResponse {
  const item = record(value, 'invitation acceptance response')
  const membership = record(item.membership, 'accepted membership')
  const role = text(membership.role, 'accepted membership role', 32)
  if (!['admin', 'member', 'guest'].includes(role)) throw invalidResponse()
  return {
    membership: {
      id: identifier(membership.id, 'accepted membership'),
      team_id: identifier(membership.team_id, 'accepted membership team'),
      principal_id: identifier(membership.principal_id, 'accepted membership principal'),
      role: role as TeamHubAcceptedMembership['role'],
      status: text(membership.status, 'accepted membership status', 32)
    },
    teams: boundedArray(item.teams, 'teams', 1_000).map(parseTeam)
  }
}

function parsePrincipal(value: unknown): TeamHubPrincipal {
  const item = record(value, 'principal')
  const kind = item.kind == null ? undefined : text(item.kind, 'principal kind', 32)
  if (kind != null && !['human', 'service', 'node'].includes(kind)) throw invalidResponse()
  return {
    id: identifier(item.id, 'principal'),
    ...(kind ? { kind } : {}),
    email: item.email == null ? null : email(item.email),
    display_name: text(item.display_name, 'principal display name', 160)
  }
}

function parseSession(value: unknown): TeamHubSessionSummary {
  const item = record(value, 'session')
  return {
    id: identifier(item.id, 'session'),
    device_label: text(item.device_label, 'device label', 160),
    expires_at: timestamp(item.expires_at, 'session expiry')
  }
}

function parseTeam(value: unknown): TeamHubTeam {
  const item = record(value, 'team')
  const role = text(item.role, 'team role', 32)
  if (!['owner', 'admin', 'member', 'guest', 'automation'].includes(role)) throw invalidResponse()
  return {
    id: identifier(item.id, 'team'),
    kind: text(item.kind, 'team kind', 32),
    slug: text(item.slug, 'team slug', 120),
    display_name: text(item.display_name, 'team display name', 160),
    role: role as TeamHubTeam['role'],
    status: text(item.status, 'team status', 32)
  }
}

function parseMembership(value: unknown): TeamHubMembership {
  const item = record(value, 'membership')
  const role = text(item.role, 'membership role', 32)
  if (!['owner', 'admin', 'member', 'guest', 'automation'].includes(role)) throw invalidResponse()
  return {
    principal_id: identifier(item.principal_id, 'member principal'),
    email: item.email == null ? null : email(item.email),
    display_name: text(item.display_name, 'member display name', 160),
    role: role as TeamHubMembership['role'],
    status: text(item.status, 'membership status', 32)
  }
}

function parseNode(value: unknown): TeamHubNode {
  const item = record(value, 'node')
  return {
    id: identifier(item.id, 'node'),
    team_id: identifier(item.team_id, 'node team'),
    server_identity: identifier(item.server_identity, 'server identity'),
    display_name: text(item.display_name, 'node display name', 160),
    status: text(item.status, 'node status', 32),
    enrolled_at: timestamp(item.enrolled_at, 'node enrollment time'),
    last_seen_at: nullableTimestamp(item.last_seen_at, 'node last-seen time'),
    public_key_fingerprint: optionalText(item.public_key_fingerprint, 'node fingerprint', 240)
  }
}

function parseChannel(value: unknown): TeamHubChannel {
  const item = record(value, 'channel')
  const permissions = record(item.permissions, 'channel permissions')
  const kind = text(item.kind, 'channel kind', 32)
  const visibility = text(item.visibility, 'channel visibility', 32)
  if (!['board', 'announcements', 'direct'].includes(kind) || !['team', 'private'].includes(visibility)) throw invalidResponse()
  return {
    id: identifier(item.id, 'channel'),
    team_id: identifier(item.team_id, 'channel team'),
    kind: kind as TeamHubChannel['kind'],
    visibility: visibility as TeamHubChannel['visibility'],
    slug: nullableText(item.slug, 'channel slug', 120),
    display_name: nullableText(item.display_name, 'channel display name', 160),
    created_by_principal_id: identifier(item.created_by_principal_id, 'channel creator'),
    created_at: timestamp(item.created_at, 'channel creation time'),
    updated_at: timestamp(item.updated_at, 'channel update time'),
    archived_at: nullableTimestamp(item.archived_at, 'channel archive time'),
    participants: boundedArray(item.participants, 'channel participants', 2_000).map(value => identifier(value, 'channel participant')),
    permissions: {
      read: booleanValue(permissions.read, 'channel read permission'),
      post: booleanValue(permissions.post, 'channel post permission'),
      manage: booleanValue(permissions.manage, 'channel manage permission'),
      dispatch: booleanValue(permissions.dispatch, 'channel dispatch permission')
    },
    ...(item.unread_count === undefined ? {} : { unread_count: nonnegativeInteger(item.unread_count, 'unread count') })
  }
}

function parseMessagesResponse(value: unknown): { messages: TeamHubMessage[]; next_before_sequence: number | null } {
  const item = record(value, 'messages response')
  return {
    messages: boundedArray(item.messages, 'messages', 100).map(parseMessage),
    next_before_sequence: item.next_before_sequence == null
      ? null
      : positiveInteger(item.next_before_sequence, 'next message sequence')
  }
}

function parseMessage(value: unknown): TeamHubMessage {
  const item = record(value, 'message')
  const kind = text(item.kind, 'message kind', 32)
  const format = text(item.body_format, 'message format', 32)
  if (!['post', 'announcement', 'system'].includes(kind) || !['plain', 'markdown'].includes(format)) throw invalidResponse()
  return {
    id: identifier(item.id, 'message'),
    team_id: identifier(item.team_id, 'message team'),
    channel_id: identifier(item.channel_id, 'message channel'),
    channel_sequence: positiveInteger(item.channel_sequence, 'message sequence'),
    kind,
    thread_root_message_id: nullableIdentifier(item.thread_root_message_id, 'thread root'),
    parent_message_id: nullableIdentifier(item.parent_message_id, 'parent message'),
    author_principal_id: identifier(item.author_principal_id, 'message author'),
    body_format: format as TeamHubMessage['body_format'],
    body: text(item.body, 'message body', 64 * 1024, true),
    created_at: timestamp(item.created_at, 'message creation time'),
    edited_at: nullableTimestamp(item.edited_at, 'message edit time'),
    deleted_at: nullableTimestamp(item.deleted_at, 'message deletion time')
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Team Hub returned an invalid ${label}.`)
  return value
}

function boundedArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Team Hub returned invalid ${label}.`)
  return value
}

function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000\u007f]/.test(value) || (!allowEmpty && !value.trim())) {
    throw new Error(`Team Hub returned an invalid ${label}.`)
  }
  return value
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : text(value, label, maximum)
}

function nullableText(value: unknown, label: string, maximum: number): string | null {
  return value == null ? null : text(value, label, maximum)
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 240)
  if (/[\u0000-\u001f\u007f]/.test(result)) throw new Error(`Team Hub returned an invalid ${label}.`)
  return result
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value == null ? null : identifier(value, label)
}

function opaqueCursor(value: unknown, label = 'cursor'): string {
  const result = text(value, label, 2_048)
  if (/\s|[\u0000-\u001f\u007f]/.test(result)) throw new Error(`Team Hub returned an invalid ${label}.`)
  return result
}

function pageQuery(cursor: string | undefined, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Team Hub page size must be between 1 and 100.')
  const query = new URLSearchParams({ limit: String(limit) })
  if (cursor !== undefined) query.set('cursor', opaqueCursor(cursor))
  return query.toString()
}

function email(value: unknown): string {
  const result = text(value, 'email', 320)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw invalidResponse()
  return result
}

function credential(value: unknown, label: string): string {
  const result = text(value, label, 16_384)
  if (/[\r\n]/.test(result)) throw invalidResponse()
  return result
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 80)
  if (!Number.isFinite(Date.parse(result))) throw invalidResponse()
  return result
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value == null ? null : timestamp(value, label)
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`Team Hub returned an invalid ${label}.`)
  return value
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Team Hub returned an invalid ${label}.`)
  return value
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Team Hub returned an invalid ${label}.`)
  return value
}

function invalidResponse(): Error {
  return new Error('Team Hub returned an invalid response.')
}
