export type TeamHubRole = 'owner' | 'admin' | 'member' | 'guest' | 'automation'
export type TeamHubTransport = 'loopback' | 'tailscale_serve' | 'direct_ip' | 'secure_peer'

export interface TeamHubRoute {
  transport: TeamHubTransport
  hubUrl: string | null
  /** Present only for a pinned local secure-peer proxy route. */
  basePath?: string
  connectionId?: string
  hostServerIdentity?: string
  hubIdentity?: string
}
export type TeamHubConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'needs-bootstrap'
  | 'signed-out'
  | 'authenticated'
  | 'offline'
  | 'unavailable'
  | 'error'

export interface TeamHubScope {
  /** Immutable desktop AgentsServer profile identifier. */
  profileId: string
  /** AgentsServer profile generation captured when discovery completed. */
  profileGeneration: number
  /** Stable identity pinned by the active AgentsServer profile. */
  serverIdentity: string
  generation: number
  hubIdentity: string | null
  /** Additional immutable route binding for secure server-to-server transport. */
  connectionId?: string
  hostServerIdentity?: string
}

export interface TeamHubServerScope {
  profileId: string
  profileGeneration: number
  serverIdentity: string | null
  serverUrl: string
  serverName: string
}

export type TeamHubServerRole = 'host' | 'member'

export interface TeamHubConfigureServerRoleInput {
  role: TeamHubServerRole
  serverName: string
  /** Supplied only when explicitly creating a fresh server-owned network. */
  networkName?: string
  /** Rename an existing Host only; never enable or change a server role. */
  renameOnly?: true
}

export interface TeamHubDiscovery {
  available: boolean
  designatedHost: boolean
  version: 1
  basePath: string | null
  /** Authenticated AgentsServer proxy for this host's server-scoped Teamspace identity. */
  serverSessionBasePath?: string
  transport: TeamHubTransport | null
  hubUrl: string | null
  routes?: TeamHubRoute[]
  hubIdentity: string | null
  hostServerIdentity: string | null
  connectionId?: string
  message: string
  action: string | null
}

export interface TeamHubPrincipal {
  id: string
  kind?: string
  display_name: string
  email?: string | null
  status?: string
}

export interface TeamHubMembership {
  principal_id: string
  role: TeamHubRole
  status: string
  display_name: string
  email?: string | null
}

export interface TeamHubMembershipPage {
  members: TeamHubMembership[]
  has_more: boolean
  next_cursor: string | null
}

export interface TeamHubInvitationSummary {
  id: string
  invitee_email: string
  role: Exclude<TeamHubRole, 'owner' | 'automation'>
  issued_by_principal_id: string
  created_at: string
  expires_at: string
}

export interface TeamHubInvitationPage {
  invitations: TeamHubInvitationSummary[]
  has_more: boolean
  next_cursor: string | null
}

export interface TeamHubDeviceSession {
  id: string
  device_label: string
  created_at: string
  last_seen_at: string
  expires_at: string
  revoked_at: string | null
  current: boolean
}

export interface TeamHubDeviceSessionPage {
  sessions: TeamHubDeviceSession[]
  has_more: boolean
  next_cursor: string | null
}

export interface TeamHubUpdateMemberInput {
  teamId: string
  principalId: string
  patch: { role: 'admin' | 'member' | 'guest' } | { status: 'active' | 'suspended' | 'revoked' }
}

export interface TeamHubTeam {
  id: string
  kind: 'personal' | 'shared' | string
  slug: string
  display_name: string
  role: TeamHubRole
  status: string
}

export interface TeamHubNode {
  id: string
  team_id: string
  server_identity: string
  display_name: string
  status: string
  enrolled_at: string
  last_seen_at: string | null
  public_key_fingerprint?: string
}

export type TeamHubChannelKind = 'board' | 'announcements' | 'direct'

export interface TeamHubChannelPermissions {
  read: boolean
  post: boolean
  manage: boolean
  dispatch: boolean
}

export interface TeamHubChannel {
  id: string
  team_id: string
  kind: TeamHubChannelKind
  visibility: 'team' | 'private'
  slug: string | null
  display_name: string | null
  created_by_principal_id: string
  created_at: string
  updated_at: string
  archived_at: string | null
  participants: string[]
  permissions: TeamHubChannelPermissions
  unread_count?: number
}

export interface TeamHubMessageAuthor {
  principal_id: string
  display_name: string
  kind?: string
}

export interface TeamHubMessageProvenance {
  acting_principal_id?: string | null
  agent_id?: string | null
  run_id?: string | null
  chat_id?: string | null
  node_id?: string | null
}

export interface TeamHubMessage {
  id: string
  team_id: string
  channel_id: string
  channel_sequence: number
  kind: 'post' | 'announcement' | 'system' | string
  body: string
  body_format: 'plain' | 'markdown'
  created_at: string
  author_principal_id: string
  thread_root_message_id: string | null
  parent_message_id: string | null
  edited_at: string | null
  deleted_at: string | null
  author?: TeamHubMessageAuthor
  provenance?: TeamHubMessageProvenance | null
}

export interface TeamHubSessionSummary {
  id: string
  device_label: string
  expires_at: string
}

export interface TeamHubStatus {
  version: 1
  profileId: string
  profileGeneration: number
  serverIdentity: string | null
  serverName: string | null
  serverUrl?: string | null
  generation: number
  hubUrl: string | null
  hubIdentity: string | null
  savedHubIdentity: string | null
  connectionId?: string
  hostServerIdentity?: string
  transport: TeamHubTransport | null
  routes?: TeamHubRoute[]
  designatedHost: boolean
  availabilityMessage: string | null
  availabilityAction: string | null
  canForgetBinding: boolean
  /** The active Teamspace identity is owned by the authenticated AgentsServer. */
  serverManaged?: boolean
  /**
   * Main-process-owned permission for bounded passive recovery of this exact
   * profile. Explicit Disconnect/Deactivate persists `false` across restarts.
   */
  backgroundReconnectAllowed?: boolean
  connectionState: TeamHubConnectionState
  authenticated: boolean
  authenticationMode?: 'human' | 'paired_node' | 'server'
  bootstrapRequired: boolean
  principal: TeamHubPrincipal | null
  session: TeamHubSessionSummary | null
  error: string | null
}

export interface TeamHubBackgroundReconnectScope {
  profileId: string
  profileGeneration: number
  serverIdentity: string
  generation: number
}

export interface TeamHubWorkspace {
  status: TeamHubStatus
  teams: TeamHubTeam[]
}

export interface TeamHubTeamDetails {
  scope: TeamHubScope
  team: TeamHubTeam
  membership: TeamHubMembership
  members: TeamHubMembership[]
  membersHasMore?: boolean
  membersNextCursor?: string | null
  nodes: TeamHubNode[]
  channels: TeamHubChannel[]
}

export interface TeamHubManagedBootstrapInput {
  profileScope: Pick<TeamHubScope, 'profileId' | 'profileGeneration' | 'serverIdentity'>
  teamName: string
}

/** Legacy proof-based owner enrollment, retained for older native callers. */
export interface TeamHubLegacyBootstrapInput {
  email: string
  displayName: string
  deviceLabel: string
  unsafeDirectIPConfirmed?: true
}

export type TeamHubBootstrapInput = TeamHubManagedBootstrapInput | TeamHubLegacyBootstrapInput

export interface TeamHubConnectInput {
  transport?: Extract<TeamHubTransport, 'tailscale_serve' | 'secure_peer'>
  backgroundReconnect?: TeamHubBackgroundReconnectScope
  surfaceReconnect?: TeamHubBackgroundReconnectScope
}

export interface TeamHubJoinInput {
  email: string
  displayName: string
  deviceLabel: string
}

export interface TeamHubAcceptedMembership {
  id: string
  team_id: string
  principal_id: string
  role: TeamHubRole
  status: string
}

export interface TeamHubInvitationAcceptance {
  membership: TeamHubAcceptedMembership
  workspace: TeamHubWorkspace
}

export interface TeamHubRecoverDeviceInput {
  deviceLabel: string
}

export interface TeamHubForgetBindingInput {
  profileId: string
  profileGeneration: number
  serverIdentity: string
  expectedGeneration: number
  expectedHubIdentity: string
}

export interface TeamHubCreateInvitationInput {
  teamId: string
  inviteeEmail: string
  role: Exclude<TeamHubRole, 'owner' | 'automation'>
}

export type TeamHubOneTimeSecretReceipt = {
  saved: false
  label: string
  instructions: string[]
} | {
  saved: true
  id: string
  expiresAt: string | null
  fileName: string
  label: string
  instructions: string[]
}

export interface TeamHubCreateNodeEnrollmentInput {
  teamId: string
  serverIdentity: string
  displayName: string
  publicKey: string
}

export interface TeamHubCreateChannelInput {
  teamId: string
  kind: Exclude<TeamHubChannelKind, 'direct'>
  visibility: 'team' | 'private'
  slug: string
  displayName: string
  idempotencyKey: string
}

export interface TeamHubCreateDirectInput {
  teamId: string
  participantPrincipalId: string
  idempotencyKey: string
}

export interface TeamHubPostMessageInput {
  channelId: string
  body: string
  kind?: 'post' | 'announcement'
  bodyFormat?: 'plain' | 'markdown'
  idempotencyKey: string
}

export interface TeamHubDispatchAvailability {
  available: false
  reason: string
}
