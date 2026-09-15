import type {
  TeamHubBootstrapInput,
  TeamHubConnectInput,
  TeamHubConfigureServerRoleInput,
  TeamHubCreateChannelInput,
  TeamHubCreateDirectInput,
  TeamHubCreateInvitationInput,
  TeamHubCreateNodeEnrollmentInput,
  TeamHubForgetBindingInput,
  TeamHubJoinInput,
  TeamHubPostMessageInput,
  TeamHubRecoverDeviceInput,
  TeamHubScope,
  TeamHubStatus,
  TeamHubUpdateMemberInput
} from '../shared/team-hub'
import { TeamHubService } from './team-hub-service'
import type {
  TeamNetworkBulletinQuery,
  TeamNetworkCreatePassiveRequestInput,
  TeamNetworkDeleteBulletinInput,
  TeamNetworkDeletionQuery,
  TeamNetworkDeliveryReceiptInput,
  TeamNetworkMailboxQuery,
  TeamNetworkPostBulletinInput,
  TeamNetworkProjectionQuery,
  TeamNetworkRegisterAgentInput,
  TeamNetworkRenameServerInput,
  TeamNetworkReplyPassiveRequestInput,
  TeamNetworkSendMailboxInput,
  TeamAttachmentCacheInput,
  TeamAttachmentDeclareInput,
  TeamAttachmentUploadInput,
  TeamMessageCreateInput,
  TeamMessageDeleteInput,
  TeamMessageDismissInput,
  TeamMessageQuery,
  TeamMessageThreadQuery,
  TeamMessageReceiptInput,
  TeamMailboxStateInput,
  TeamMessageRevisionInput,
  TeamSkillArchiveInput,
  TeamSkillPinInput,
  TeamSkillQuery,
  TeamSkillVersionsQuery
} from '../shared/team-network'
import type {
  SecurePeerActivateInput,
  SecurePeerApproveInput,
  SecurePeerConfigureHostInput,
  SecurePeerCompletionWaitInput,
  SecurePeerDeactivateInput,
  SecurePeerForgetConnectionInput,
  SecurePeerJoinInput,
  SecurePeerPublishRouteInput,
  SecurePeerProfileScope,
  SecurePeerRejectInput,
  SecurePeerRevokeRouteInput,
  SecurePeerRevokeInput
} from '../shared/secure-peer'
import type { TeamAttachmentMediaResourceIdentity } from '../shared/media-url'
import type { AdmittedUploadFile } from './file-upload-grants'

/**
 * Team Hub is additive. Delayed settings/keychain/dialog initialization must
 * never prevent the existing AgentsServer chat window from starting.
 */
export class LazyTeamHubService {
  private delegate: TeamHubService | null = null
  private initializationError: string | null = null

  constructor(private readonly create: () => TeamHubService) {}

  status(): TeamHubStatus {
    const service = this.tryService()
    return service ? service.status() : unavailableStatus(this.initializationError)
  }

  async connect(input?: TeamHubConnectInput) {
    // A user retry may succeed after a transient filesystem/keychain problem.
    this.initializationError = null
    const service = this.requireService()
    return service.connect(input)
  }

  configureServerRole(scope: SecurePeerProfileScope, input: TeamHubConfigureServerRoleInput) {
    return this.requireService().configureServerRole(scope, input)
  }

  bootstrap(input: TeamHubBootstrapInput) { return this.requireService().bootstrap(input) }
  join(input: TeamHubJoinInput) { return this.requireService().join(input) }
  acceptInvitation(scope: TeamHubScope) { return this.requireService().acceptInvitation(scope) }
  recoverDevice(input: TeamHubRecoverDeviceInput) { return this.requireService().recoverDevice(input) }
  refresh(scope: TeamHubScope) { return this.requireService().refresh(scope) }
  logout(scope: TeamHubScope) { return this.requireService().logout(scope) }
  disconnect(scope: TeamHubScope) { return this.requireService().disconnect(scope) }
  forgetBinding(input: TeamHubForgetBindingInput) { return this.requireService().forgetBinding(input) }
  removeServerProfile(profileId: string) {
    // Profile removal is itself the recovery path for stale Teamspace state;
    // retry initialization after a transient earlier settings failure.
    this.initializationError = null
    return this.requireService().removeServerProfile(profileId)
  }
  workspace(scope: TeamHubScope) { return this.requireService().workspace(scope) }
  teamDetails(scope: TeamHubScope, teamId: string) { return this.requireService().teamDetails(scope, teamId) }
  deviceSessions(scope: TeamHubScope, cursor?: string) { return this.requireService().deviceSessions(scope, cursor) }
  revokeDeviceSession(scope: TeamHubScope, sessionId: string) { return this.requireService().revokeDeviceSession(scope, sessionId) }
  members(scope: TeamHubScope, teamId: string, cursor?: string) { return this.requireService().members(scope, teamId, cursor) }
  invitations(scope: TeamHubScope, teamId: string, cursor?: string) { return this.requireService().invitations(scope, teamId, cursor) }
  revokeInvitation(scope: TeamHubScope, teamId: string, invitationId: string) { return this.requireService().revokeInvitation(scope, teamId, invitationId) }
  updateMember(scope: TeamHubScope, input: TeamHubUpdateMemberInput) { return this.requireService().updateMember(scope, input) }
  createInvitation(scope: TeamHubScope, input: TeamHubCreateInvitationInput) { return this.requireService().createInvitation(scope, input) }
  createNodeEnrollment(scope: TeamHubScope, input: TeamHubCreateNodeEnrollmentInput) { return this.requireService().createNodeEnrollment(scope, input) }
  createChannel(scope: TeamHubScope, input: TeamHubCreateChannelInput) { return this.requireService().createChannel(scope, input) }
  createDirect(scope: TeamHubScope, input: TeamHubCreateDirectInput) { return this.requireService().createDirect(scope, input) }
  messages(scope: TeamHubScope, channelId: string, beforeSequence?: number) { return this.requireService().messages(scope, channelId, beforeSequence) }
  postMessage(scope: TeamHubScope, input: TeamHubPostMessageInput) { return this.requireService().postMessage(scope, input) }
  networkCapabilities(scope: TeamHubScope) { return this.requireService().networkCapabilities(scope) }
  network(scope: TeamHubScope, query: TeamNetworkProjectionQuery) { return this.requireService().network(scope, query) }
  renameNetworkServer(scope: TeamHubScope, input: TeamNetworkRenameServerInput) { return this.requireService().renameNetworkServer(scope, input) }
  registerNetworkAgent(scope: TeamHubScope, input: TeamNetworkRegisterAgentInput) { return this.requireService().registerNetworkAgent(scope, input) }
  bulletin(scope: TeamHubScope, query: TeamNetworkBulletinQuery) { return this.requireService().bulletin(scope, query) }
  postBulletin(scope: TeamHubScope, input: TeamNetworkPostBulletinInput) { return this.requireService().postBulletin(scope, input) }
  deleteNetworkBulletin(scope: TeamHubScope, input: TeamNetworkDeleteBulletinInput) { return this.requireService().deleteNetworkBulletin(scope, input) }
  networkDeletions(scope: TeamHubScope, query: TeamNetworkDeletionQuery) { return this.requireService().networkDeletions(scope, query) }
  mailbox(scope: TeamHubScope, query: TeamNetworkMailboxQuery) { return this.requireService().mailbox(scope, query) }
  sendMailbox(scope: TeamHubScope, input: TeamNetworkSendMailboxInput) { return this.requireService().sendMailbox(scope, input) }
  networkItem(scope: TeamHubScope, teamId: string, itemId: string) { return this.requireService().networkItem(scope, teamId, itemId) }
  recordDeliveryReceipt(scope: TeamHubScope, input: TeamNetworkDeliveryReceiptInput) { return this.requireService().recordDeliveryReceipt(scope, input) }
  createPassiveRequest(scope: TeamHubScope, input: TeamNetworkCreatePassiveRequestInput) { return this.requireService().createPassiveRequest(scope, input) }
  passiveRequest(scope: TeamHubScope, teamId: string, requestId: string) { return this.requireService().passiveRequest(scope, teamId, requestId) }
  replyPassiveRequest(scope: TeamHubScope, input: TeamNetworkReplyPassiveRequestInput) { return this.requireService().replyPassiveRequest(scope, input) }
  teamMessagesCapabilities(scope: TeamHubScope) { return this.requireService().teamMessagesCapabilities(scope) }
  teamMessages(scope: TeamHubScope, query: TeamMessageQuery) { return this.requireService().teamMessages(scope, query) }
  teamMessage(scope: TeamHubScope, teamId: string, messageId: string) { return this.requireService().teamMessage(scope, teamId, messageId) }
  teamMessageThread(scope: TeamHubScope, query: TeamMessageThreadQuery) { return this.requireService().teamMessageThread(scope, query) }
  createTeamMessage(scope: TeamHubScope, input: TeamMessageCreateInput) { return this.requireService().createTeamMessage(scope, input) }
  recordTeamMessageReceipt(scope: TeamHubScope, input: TeamMessageReceiptInput) { return this.requireService().recordTeamMessageReceipt(scope, input) }
  setTeamMessageMailboxState(scope: TeamHubScope, input: TeamMailboxStateInput) { return this.requireService().setTeamMessageMailboxState(scope, input) }
  deleteTeamMessage(scope: TeamHubScope, input: TeamMessageDeleteInput) { return this.requireService().deleteTeamMessage(scope, input) }
  reviseTeamMessage(scope: TeamHubScope, input: TeamMessageRevisionInput) { return this.requireService().reviseTeamMessage(scope, input) }
  dismissTeamMessage(scope: TeamHubScope, input: TeamMessageDismissInput) { return this.requireService().dismissTeamMessage(scope, input) }
  teamMessageHistory(scope: TeamHubScope, teamId: string, messageId: string, version?: number) { return this.requireService().teamMessageHistory(scope, teamId, messageId, version) }
  declareTeamAttachment(scope: TeamHubScope, input: TeamAttachmentDeclareInput, file: AdmittedUploadFile, signal?: AbortSignal) {
    return this.requireService().declareTeamAttachment(scope, input, file, signal)
  }
  uploadTeamAttachment(scope: TeamHubScope, input: TeamAttachmentUploadInput, file: AdmittedUploadFile, signal?: AbortSignal) {
    return this.requireService().uploadTeamAttachment(scope, input, file, signal)
  }
  teamAttachment(scope: TeamHubScope, teamId: string, attachmentId: string) { return this.requireService().teamAttachment(scope, teamId, attachmentId) }
  cacheTeamAttachment(scope: TeamHubScope, input: TeamAttachmentCacheInput) { return this.requireService().cacheTeamAttachment(scope, input) }
  teamAttachmentMediaResponse(resource: TeamAttachmentMediaResourceIdentity, request: Request) {
    return this.requireService().teamAttachmentMediaResponse(resource, request)
  }
  teamSkills(scope: TeamHubScope, query: TeamSkillQuery) { return this.requireService().teamSkills(scope, query) }
  teamSkill(scope: TeamHubScope, teamId: string, skillId: string) { return this.requireService().teamSkill(scope, teamId, skillId) }
  teamSkillVersions(scope: TeamHubScope, query: TeamSkillVersionsQuery) { return this.requireService().teamSkillVersions(scope, query) }
  teamSkillVersion(scope: TeamHubScope, teamId: string, skillId: string, version: number) { return this.requireService().teamSkillVersion(scope, teamId, skillId, version) }
  pinTeamSkill(scope: TeamHubScope, input: TeamSkillPinInput) { return this.requireService().pinTeamSkill(scope, input) }
  archiveTeamSkill(scope: TeamHubScope, input: TeamSkillArchiveInput) { return this.requireService().archiveTeamSkill(scope, input) }
  dispatchAvailability() { return this.requireService().dispatchAvailability() }
  securePeerStatus(scope: SecurePeerProfileScope) { return this.requireService().securePeerStatus(scope) }
  configureSecurePeerHost(scope: SecurePeerProfileScope, input: SecurePeerConfigureHostInput) { return this.requireService().configureSecurePeerHost(scope, input) }
  requestSecurePeerPairing(scope: SecurePeerProfileScope, input: SecurePeerJoinInput) { return this.requireService().requestSecurePeerPairing(scope, input) }
  waitForSecurePeerPairingCompletion(scope: SecurePeerProfileScope, input: SecurePeerCompletionWaitInput) { return this.requireService().waitForSecurePeerPairingCompletion(scope, input) }
  stopSecurePeerPairingCompletionWait(scope: SecurePeerProfileScope, requestId: string) { return this.requireService().stopSecurePeerPairingCompletionWait(scope, requestId) }
  refreshSecurePeerPairing(scope: SecurePeerProfileScope, pairingId: string) { return this.requireService().refreshSecurePeerPairing(scope, pairingId) }
  cancelSecurePeerPairing(scope: SecurePeerProfileScope, pairingId: string) { return this.requireService().cancelSecurePeerPairing(scope, pairingId) }
  approveSecurePeerPairing(scope: SecurePeerProfileScope, input: SecurePeerApproveInput) { return this.requireService().approveSecurePeerPairing(scope, input) }
  rejectSecurePeerPairing(scope: SecurePeerProfileScope, input: SecurePeerRejectInput) { return this.requireService().rejectSecurePeerPairing(scope, input) }
  activateSecurePeerPairing(scope: SecurePeerProfileScope, input: SecurePeerActivateInput) { return this.requireService().activateSecurePeerPairing(scope, input) }
  deactivateSecurePeerConnection(scope: SecurePeerProfileScope, input: SecurePeerDeactivateInput) { return this.requireService().deactivateSecurePeerConnection(scope, input) }
  forgetSecurePeerConnection(scope: SecurePeerProfileScope, input: SecurePeerForgetConnectionInput) { return this.requireService().forgetSecurePeerConnection(scope, input) }
  securePeers(scope: TeamHubScope, teamId: string) { return this.requireService().securePeers(scope, teamId) }
  revokeSecurePeer(scope: TeamHubScope, teamId: string, input: SecurePeerRevokeInput) { return this.requireService().revokeSecurePeer(scope, teamId, input) }
  publishSecurePeerRoute(scope: SecurePeerProfileScope, input: SecurePeerPublishRouteInput) { return this.requireService().publishSecurePeerRoute(scope, input) }
  revokeSecurePeerRoute(scope: SecurePeerProfileScope, input: SecurePeerRevokeRouteInput) { return this.requireService().revokeSecurePeerRoute(scope, input) }

  stop(): void {
    this.delegate?.stop()
    this.delegate = null
  }

  private tryService(): TeamHubService | null {
    if (this.delegate) return this.delegate
    if (this.initializationError) return null
    try {
      this.delegate = this.create()
      return this.delegate
    } catch (error) {
      this.initializationError = error instanceof Error ? error.message : 'Team Hub could not initialize.'
      return null
    }
  }

  private requireService(): TeamHubService {
    const service = this.tryService()
    if (service) return service
    throw new Error(this.initializationError || 'Team Hub could not initialize.')
  }
}

function unavailableStatus(message: string | null): TeamHubStatus {
  return {
    version: 1,
    profileId: 'team-hub-unavailable',
    profileGeneration: 0,
    serverIdentity: null,
    serverName: null,
    generation: 0,
    hubUrl: null,
    hubIdentity: null,
    savedHubIdentity: null,
    transport: null,
    designatedHost: false,
    availabilityMessage: null,
    availabilityAction: null,
    canForgetBinding: false,
    backgroundReconnectAllowed: false,
    connectionState: 'error',
    authenticated: false,
    bootstrapRequired: false,
    principal: null,
    session: null,
    error: message || 'Team Hub could not initialize.'
  }
}
