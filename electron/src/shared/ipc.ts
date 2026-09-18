import type {
  AgentFile,
  AgentCrossChatRoute,
  AgentCrossChatRouteUpdateResult,
  AgentCrossChatRoutesSnapshot,
  AgentTeamMailRoutesSnapshot,
  AgentTextFile,
  AppUpdateStatus,
  AppUpdateTrack,
  AddServerProfileInput,
  BootstrapPayload,
  BulkImportSessionItem,
  BulkImportSessionResult,
  ClaudePendingInteraction,
  ClaudeMcpControlInput,
  ClaudeMcpSnapshot,
  ClaudeRuntimeSnapshot,
  CodexBackgroundTerminalTerminateInput,
  CodexBackgroundTerminalsCleanInput,
  CodexBackgroundTerminalsSnapshot,
  CodexGoalInput,
  CodexGoalSnapshot,
  CodexGoalsConfiguration,
  CodexAuthStatus,
  CodexSubagentsConfiguration,
  CodexServerSettingsScope,
  CodexOperationAccepted,
  CodexPendingInteraction,
  CodexPermissionProfile,
  CodexReviewInput,
  CodexRollbackInput,
  CodexRollbackResult,
  CodexRuntimeSnapshot,
  CodexShellInput,
  ChatReference,
  ChatInboxPage,
  ChatInboxDeleteReceipt,
  TeamReference,
  ChatSearchSnapshot,
  CreateAgentCrossChatRouteInput,
  CrossChatExchange,
  CrossChatHandoff,
  CrossChatHandoffSummary,
  DeleteAgentCrossChatRouteResult,
  CreateJobInput,
  CreateSessionInput,
  DigestInput,
  Event,
  FilesPage,
  ForwardedPort,
  Health,
  JsonValue,
  LanguageSettingsSnapshot,
  Job,
  JobRunNowResult,
  JobRunHistoryPage,
  LocalSessionCandidate,
  NativeFileRef,
  PinnedItem,
  ProcessSnapshot,
  ProfileBootstrapPayload,
  ProfileNotificationPayload,
  ProviderReloadResult,
  ProfileSessionSearchResult,
  ProviderCommandsSnapshot,
  PublicServerProfile,
  PublicServerSettings,
  QueuedCrossChatDeliveryIdentity,
  QueuedRunNowResponse,
  QueuedTurn,
  ResumeSessionInput,
  RuntimeCatalog,
  SendTurnInput,
  ServerSettings,
  ServerForceRestartConfirmation,
  ServerRestartStatus,
  TestServerConnectionInput,
  ServerSetupCapabilities,
  ServerSetupDiagnostics,
  ServerSetupInput,
  ServerSetupResult,
  ServerUpdateStatus,
  ServerUpdateTrack,
  Session,
  SessionSnapshot,
  TimelineIndex,
  TimelinePage,
  TimelineTracePage,
  TimelineSearchResult,
  TurnStopResult,
  TerminalConnectOptions,
  TerminalAction,
  TerminalWindowsSnapshot,
  TmuxPane,
  UpdateSessionInput,
  UpdateAgentCrossChatRouteInput,
  UpdateServerProfilePatch,
  UpdateJobInput,
  ViewState,
  WorkspaceEntriesPage,
  WorkspaceCreateResult,
  WorkspaceFile,
  WorkspaceInfo,
  WorkspaceProfileScope,
  WorkspaceRemoveResult,
  WorkspaceRenameResult,
  WorkspaceSearchPage,
  WorkingDirectoryCompletion
} from './types'
import type {
  TeamHubBootstrapInput,
  TeamHubConnectInput,
  TeamHubConfigureServerRoleInput,
  TeamHubChannel,
  TeamHubCreateChannelInput,
  TeamHubCreateDirectInput,
  TeamHubCreateInvitationInput,
  TeamHubCreateNodeEnrollmentInput,
  TeamHubDeviceSessionPage,
  TeamHubDispatchAvailability,
  TeamHubForgetBindingInput,
  TeamHubInvitationAcceptance,
  TeamHubInvitationPage,
  TeamHubJoinInput,
  TeamHubMessage,
  TeamHubMembership,
  TeamHubMembershipPage,
  TeamHubOneTimeSecretReceipt,
  TeamHubPostMessageInput,
  TeamHubRecoverDeviceInput,
  TeamHubScope,
  TeamHubStatus,
  TeamHubTeamDetails,
  TeamHubUpdateMemberInput,
  TeamHubWorkspace
} from './team-hub'
import type {
  TeamNetworkAgent,
  TeamNetworkBulletinPage,
  TeamNetworkBulletinPost,
  TeamNetworkBulletinQuery,
  TeamNetworkCapabilities,
  TeamNetworkCreatePassiveRequestInput,
  TeamNetworkDeleteBulletinInput,
  TeamNetworkDeleteBulletinResult,
  TeamNetworkDeletionJournalResult,
  TeamNetworkDeletionQuery,
  TeamNetworkDelivery,
  TeamNetworkDeliveryReceiptInput,
  TeamNetworkMailboxEntry,
  TeamNetworkMailboxPage,
  TeamNetworkMailboxQuery,
  TeamNetworkPassiveRequestCreated,
  TeamNetworkPassiveRequestDetails,
  TeamNetworkPassiveRequestReply,
  TeamNetworkPostBulletinInput,
  TeamNetworkProjectionPage,
  TeamNetworkProjectionQuery,
  TeamNetworkRegisterAgentInput,
  TeamNetworkRenameServerInput,
  TeamNetworkServerProfile,
  TeamNetworkReplyPassiveRequestInput,
  TeamNetworkSendMailboxInput,
  TeamAttachment,
  TeamAttachmentCacheInput,
  TeamAttachmentCacheResult,
  TeamAttachmentDeclaration,
  TeamAttachmentDeclareInput,
  TeamAttachmentUploadInput,
  TeamMessage,
  TeamMessageCreateInput,
  TeamMessageDeleteInput,
  TeamMessageDismissInput,
  TeamMessageDismissResult,
  TeamMessageHistory,
  TeamMessageDeleteResult,
  TeamMessagePage,
  TeamMessageQuery,
  TeamMessageReceiptInput,
  TeamMailboxStateInput,
  TeamMailboxStateResult,
  TeamMessageReceiptResult,
  TeamMessageRevisionInput,
  TeamMessagesCapability,
  TeamSkill,
  TeamSkillArchiveInput,
  TeamSkillDetails,
  TeamSkillPage,
  TeamSkillPinInput,
  TeamSkillQuery,
  TeamSkillVersion,
  TeamSkillVersionsPage,
  TeamSkillVersionsQuery
} from './team-network'
import type {
  SecurePeerActivateInput,
  SecurePeerApproveInput,
  SecurePeerConfigureHostInput,
  SecurePeerCompletionWaitInput,
  SecurePeerControlStatus,
  SecurePeerDeactivateInput,
  SecurePeerForgetConnectionInput,
  SecurePeerUpdateEndpointInput,
  SecurePeerJoinInput,
  SecurePeerPairing,
  SecurePeerPublishRouteInput,
  SecurePeerProfileScope,
  SecurePeerRejectInput,
  SecurePeerRevokeRouteInput,
  SecurePeerRevokeInput
} from './secure-peer'

export interface AgentsDockAPI {
  /** Native operator-only controls, deliberately absent from shared-chat clients. */
  workspaceGit?: {
    status(scope: WorkspaceProfileScope, sessionId: string): Promise<import('./workspace-git').WorkspaceGitStatus>
    diff(scope: WorkspaceProfileScope, sessionId: string, path: string, view: import('./workspace-git').WorkspaceGitView): Promise<import('./workspace-git').WorkspaceGitDiff>
    conflict(scope: WorkspaceProfileScope, sessionId: string, path: string): Promise<import('./workspace-git').WorkspaceGitConflict>
    action(scope: WorkspaceProfileScope, sessionId: string, input: import('./workspace-git').WorkspaceGitAction): Promise<import('./workspace-git').WorkspaceGitStatus>
  }
  /** Restricted browser renderer. It has no native, filesystem, or other-chat authority. */
  readonly sharedChat?: true
  sideQuestions?: {
    ask(scope: import('./side-questions').SideQuestionScope, sessionId: string, input: import('./side-questions').SideQuestionInput): Promise<import('./side-questions').SideQuestionAnswer>
    cancel(scope: import('./side-questions').SideQuestionScope, sessionId: string, requestId: string): Promise<import('./side-questions').SideQuestionCancellation>
    close?(scope: import('./side-questions').SideQuestionScope, sessionId: string, sideChatId: string): Promise<void>
  }
  chatShares: {
    preview(scope: WorkspaceProfileScope, sessionId: string): Promise<import('./chat-shares').ChatSharePreview>
    list(scope: WorkspaceProfileScope, sessionId: string, mode: import('./chat-shares').ChatShareMode): Promise<import('./chat-shares').ChatShareRecord[]>
    create(scope: WorkspaceProfileScope, sessionId: string, input: import('./chat-shares').CreateChatShareInput): Promise<import('./chat-shares').CreatedChatShare>
    revoke(scope: WorkspaceProfileScope, sessionId: string, mode: import('./chat-shares').ChatShareMode, shareId: string): Promise<void>
  }
  mailHints?: {
    acknowledgePage(input: import('./team-mail-hints').MailHintPageAcknowledgment): Promise<import('./team-mail-hints').MailHintProjection | null>
    acknowledgeBulletinRefresh?(input: import('./team-bulletin-hints').BulletinHintRefresh): Promise<import('./team-mail-hints').MailHintProjection | null>
  }
  bootstrap(): Promise<BootstrapPayload>
  language: {
    get(): Promise<LanguageSettingsSnapshot>
    set(preference: import('./i18n').LanguagePreference): Promise<LanguageSettingsSnapshot>
  }
  teamHub: {
    status(): Promise<TeamHubStatus>
    connect(input?: TeamHubConnectInput): Promise<TeamHubStatus>
    configureServerRole(scope: SecurePeerProfileScope, input: TeamHubConfigureServerRoleInput): Promise<TeamHubStatus>
    bootstrap(input: TeamHubBootstrapInput): Promise<TeamHubWorkspace>
    join(input: TeamHubJoinInput): Promise<TeamHubWorkspace>
    acceptInvitation(scope: TeamHubScope): Promise<TeamHubInvitationAcceptance>
    recoverDevice(input: TeamHubRecoverDeviceInput): Promise<TeamHubWorkspace>
    refresh(scope: TeamHubScope): Promise<TeamHubWorkspace>
    logout(scope: TeamHubScope): Promise<TeamHubStatus>
    disconnect(scope: TeamHubScope): Promise<TeamHubStatus>
    forgetBinding(input: TeamHubForgetBindingInput): Promise<TeamHubStatus>
    workspace(scope: TeamHubScope): Promise<TeamHubWorkspace>
    team(scope: TeamHubScope, teamId: string): Promise<TeamHubTeamDetails>
    deviceSessions(scope: TeamHubScope, cursor?: string): Promise<TeamHubDeviceSessionPage>
    revokeDeviceSession(scope: TeamHubScope, sessionId: string): Promise<{ revoked: true }>
    members(scope: TeamHubScope, teamId: string, cursor?: string): Promise<TeamHubMembershipPage>
    invitations(scope: TeamHubScope, teamId: string, cursor?: string): Promise<TeamHubInvitationPage>
    revokeInvitation(scope: TeamHubScope, teamId: string, invitationId: string): Promise<{ revoked: true }>
    updateMember(scope: TeamHubScope, input: TeamHubUpdateMemberInput): Promise<TeamHubMembership>
    createInvitation(scope: TeamHubScope, input: TeamHubCreateInvitationInput): Promise<TeamHubOneTimeSecretReceipt>
    createNodeEnrollment(scope: TeamHubScope, input: TeamHubCreateNodeEnrollmentInput): Promise<TeamHubOneTimeSecretReceipt>
    createChannel(scope: TeamHubScope, input: TeamHubCreateChannelInput): Promise<TeamHubChannel>
    createDirect(scope: TeamHubScope, input: TeamHubCreateDirectInput): Promise<TeamHubChannel>
    messages(scope: TeamHubScope, channelId: string, beforeSequence?: number): Promise<{ messages: TeamHubMessage[]; next_before_sequence: number | null }>
    postMessage(scope: TeamHubScope, input: TeamHubPostMessageInput): Promise<TeamHubMessage>
    networkCapabilities(scope: TeamHubScope): Promise<TeamNetworkCapabilities>
    network(scope: TeamHubScope, query: TeamNetworkProjectionQuery): Promise<TeamNetworkProjectionPage>
    renameNetworkServer(scope: TeamHubScope, input: TeamNetworkRenameServerInput): Promise<TeamNetworkServerProfile>
    registerNetworkAgent(scope: TeamHubScope, input: TeamNetworkRegisterAgentInput): Promise<TeamNetworkAgent>
    bulletin(scope: TeamHubScope, query: TeamNetworkBulletinQuery): Promise<TeamNetworkBulletinPage>
    postBulletin(scope: TeamHubScope, input: TeamNetworkPostBulletinInput): Promise<TeamNetworkBulletinPost>
    deleteNetworkBulletin(scope: TeamHubScope, input: TeamNetworkDeleteBulletinInput): Promise<TeamNetworkDeleteBulletinResult>
    networkDeletions(scope: TeamHubScope, query: TeamNetworkDeletionQuery): Promise<TeamNetworkDeletionJournalResult>
    mailbox(scope: TeamHubScope, query: TeamNetworkMailboxQuery): Promise<TeamNetworkMailboxPage>
    sendMailbox(scope: TeamHubScope, input: TeamNetworkSendMailboxInput): Promise<TeamNetworkMailboxEntry>
    networkItem(scope: TeamHubScope, teamId: string, itemId: string): Promise<TeamNetworkMailboxEntry>
    recordDeliveryReceipt(scope: TeamHubScope, input: TeamNetworkDeliveryReceiptInput): Promise<TeamNetworkDelivery>
    createPassiveRequest(scope: TeamHubScope, input: TeamNetworkCreatePassiveRequestInput): Promise<TeamNetworkPassiveRequestCreated>
    passiveRequest(scope: TeamHubScope, teamId: string, requestId: string): Promise<TeamNetworkPassiveRequestDetails>
    replyPassiveRequest(scope: TeamHubScope, input: TeamNetworkReplyPassiveRequestInput): Promise<TeamNetworkPassiveRequestReply>
    teamMessagesCapabilities(scope: TeamHubScope): Promise<TeamMessagesCapability>
    teamMessages(scope: TeamHubScope, query: TeamMessageQuery): Promise<TeamMessagePage>
    teamMessage(scope: TeamHubScope, teamId: string, messageId: string): Promise<TeamMessage>
    teamMessageThread(scope: TeamHubScope, query: import('./team-network').TeamMessageThreadQuery): Promise<import('./team-network').TeamMessageThreadPage>
    createTeamMessage(scope: TeamHubScope, input: TeamMessageCreateInput): Promise<TeamMessage>
    recordTeamMessageReceipt(scope: TeamHubScope, input: TeamMessageReceiptInput): Promise<TeamMessageReceiptResult>
    setTeamMessageMailboxState(scope: TeamHubScope, input: TeamMailboxStateInput): Promise<TeamMailboxStateResult>
    deleteTeamMessage(scope: TeamHubScope, input: TeamMessageDeleteInput): Promise<TeamMessageDeleteResult>
    reviseTeamMessage(scope: TeamHubScope, input: TeamMessageRevisionInput): Promise<TeamMessage>
    dismissTeamMessage(scope: TeamHubScope, input: TeamMessageDismissInput): Promise<TeamMessageDismissResult>
    teamMessageHistory(scope: TeamHubScope, teamId: string, messageId: string, version?: number): Promise<TeamMessageHistory>
    declareTeamAttachment(scope: TeamHubScope, input: TeamAttachmentDeclareInput): Promise<TeamAttachmentDeclaration>
    uploadTeamAttachment(scope: TeamHubScope, input: TeamAttachmentUploadInput): Promise<TeamAttachment>
    teamAttachment(scope: TeamHubScope, teamId: string, attachmentId: string): Promise<TeamAttachment>
    cacheTeamAttachment(scope: TeamHubScope, input: TeamAttachmentCacheInput): Promise<TeamAttachmentCacheResult>
    teamSkills(scope: TeamHubScope, query: TeamSkillQuery): Promise<TeamSkillPage>
    teamSkill(scope: TeamHubScope, teamId: string, skillId: string): Promise<TeamSkillDetails>
    teamSkillVersions(scope: TeamHubScope, query: TeamSkillVersionsQuery): Promise<TeamSkillVersionsPage>
    teamSkillVersion(scope: TeamHubScope, teamId: string, skillId: string, version: number): Promise<TeamSkillVersion>
    pinTeamSkill(scope: TeamHubScope, input: TeamSkillPinInput): Promise<TeamSkill>
    archiveTeamSkill(scope: TeamHubScope, input: TeamSkillArchiveInput): Promise<TeamSkill>
    dispatchAvailability(): Promise<TeamHubDispatchAvailability>
    securePeerStatus(scope: SecurePeerProfileScope): Promise<SecurePeerControlStatus>
    configureSecurePeerHost(scope: SecurePeerProfileScope, input: SecurePeerConfigureHostInput): Promise<SecurePeerControlStatus>
    requestSecurePeerPairing(scope: SecurePeerProfileScope, input: SecurePeerJoinInput): Promise<SecurePeerPairing>
    waitForSecurePeerPairingCompletion(scope: SecurePeerProfileScope, input: SecurePeerCompletionWaitInput): Promise<SecurePeerControlStatus>
    stopSecurePeerPairingCompletionWait(scope: SecurePeerProfileScope, requestId: string): Promise<void>
    refreshSecurePeerPairing(scope: SecurePeerProfileScope, pairingId: string): Promise<SecurePeerPairing>
    cancelSecurePeerPairing(scope: SecurePeerProfileScope, pairingId: string): Promise<SecurePeerControlStatus>
    activateSecurePeerPairing(scope: SecurePeerProfileScope, input: SecurePeerActivateInput): Promise<SecurePeerControlStatus>
    deactivateSecurePeerConnection(scope: SecurePeerProfileScope, input: SecurePeerDeactivateInput): Promise<SecurePeerControlStatus>
    forgetSecurePeerConnection(scope: SecurePeerProfileScope, input: SecurePeerForgetConnectionInput): Promise<SecurePeerControlStatus>
    updateSecurePeerConnectionEndpoint(scope: SecurePeerProfileScope, input: SecurePeerUpdateEndpointInput): Promise<SecurePeerControlStatus>
    securePeers(scope: TeamHubScope, teamId: string): Promise<SecurePeerPairing[]>
    approveSecurePeerPairing(scope: SecurePeerProfileScope, input: SecurePeerApproveInput): Promise<SecurePeerControlStatus>
    rejectSecurePeerPairing(scope: SecurePeerProfileScope, input: SecurePeerRejectInput): Promise<SecurePeerControlStatus>
    revokeSecurePeer(scope: TeamHubScope, teamId: string, input: SecurePeerRevokeInput): Promise<SecurePeerPairing>
    publishSecurePeerRoute(scope: SecurePeerProfileScope, input: SecurePeerPublishRouteInput): Promise<SecurePeerControlStatus>
    revokeSecurePeerRoute(scope: SecurePeerProfileScope, input: SecurePeerRevokeRouteInput): Promise<SecurePeerControlStatus>
  }
  updates: {
    status(): Promise<AppUpdateStatus>
    check(): Promise<AppUpdateStatus>
    install(): Promise<boolean>
    setTrack(track: AppUpdateTrack): Promise<AppUpdateStatus>
  }
  settings: {
    get(): Promise<PublicServerSettings>
    apply(settings: ServerSettings): Promise<Health>
  }
  servers: {
    list(): Promise<PublicServerProfile[]>
    getActive(): Promise<PublicServerProfile>
    add(input: AddServerProfileInput): Promise<PublicServerProfile>
    update(profileId: string, patch: UpdateServerProfilePatch): Promise<PublicServerProfile>
    updateAndSwitch(profileId: string, patch: UpdateServerProfilePatch): Promise<ProfileBootstrapPayload>
    remove(profileId: string): Promise<boolean>
    reorder(profileIds: string[]): Promise<PublicServerProfile[]>
    switch(profileId: string, force?: boolean): Promise<ProfileBootstrapPayload>
    refresh(profileId: string, profileGeneration: number): Promise<ProfileBootstrapPayload>
    testConnection(input: TestServerConnectionInput): Promise<Health>
    restartStatus(scope: WorkspaceProfileScope): Promise<ServerRestartStatus>
    restart(
      scope: WorkspaceProfileScope,
      expectedServerInstanceId: string,
      forceConfirmation?: ServerForceRestartConfirmation
    ): Promise<ProfileBootstrapPayload>
  }
  serverUpdates: {
    status(): Promise<ServerUpdateStatus>
    check(track?: ServerUpdateTrack): Promise<ServerUpdateStatus>
    start(version?: string, track?: ServerUpdateTrack, whenIdle?: boolean): Promise<ServerUpdateStatus>
    cancel(scheduleId: string): Promise<ServerUpdateStatus>
  }
  setup: {
    capabilities(): Promise<ServerSetupCapabilities>
    run(input: ServerSetupInput): Promise<ServerSetupResult>
    cancel(): Promise<boolean>
    diagnostics(): Promise<ServerSetupDiagnostics>
    openLog(): Promise<boolean>
  }
  sessions: {
    list(): Promise<Session[]>
    create(input: CreateSessionInput): Promise<Session>
    resume(input: ResumeSessionInput): Promise<Session>
    update(sessionId: string, patch: UpdateSessionInput): Promise<Session>
    reloadProvider(sessionId: string): Promise<ProviderReloadResult>
    remove(sessionId: string): Promise<boolean>
    fork(sessionId: string): Promise<Session>
    reorder(sessionId: string, relativeTo: string, placement: 'before' | 'after', targetFolder?: string): Promise<Session[]>
    searchHistory(query: string, limit?: number): Promise<TimelineSearchResult[]>
    searchAllProfiles(query: string, limit?: number): Promise<ProfileSessionSearchResult[]>
    markRead(sessionId: string, seq?: number | null): Promise<Session>
    markUnread(sessionId: string): Promise<Session>
    acknowledgeEmergency(sessionId: string, alertId: string): Promise<Session>
    importHistory(sessionId: string, force?: boolean): Promise<TimelinePage>
    listLocal(): Promise<LocalSessionCandidate[]>
    bulkImport(items: BulkImportSessionItem[]): Promise<BulkImportSessionResult[]>
  }
  providerCommands: {
    list(sessionId: string, refresh?: boolean): Promise<ProviderCommandsSnapshot>
  }
  timeline: {
    cached(sessionId: string): Promise<SessionSnapshot | null>
    open(sessionId: string, forceRemote?: boolean): Promise<SessionSnapshot>
    older(sessionId: string, before: number, limit?: number): Promise<TimelinePage>
    historicalOlder(sessionId: string, before: number, limit?: number): Promise<TimelinePage>
    around(sessionId: string, anchorSeq: number, limit?: number): Promise<TimelinePage>
    trace(sessionId: string, runId: string, anchorSeq: number, after?: number, limit?: number): Promise<TimelineTracePage>
    index(sessionId: string): Promise<TimelineIndex>
    search(sessionId: string, query: string, limit?: number): Promise<TimelineSearchResult[]>
    subscribe(sessionId: string, after: number): Promise<void>
    unsubscribe(sessionId: string): Promise<void>
    saveViewState(scope: WorkspaceProfileScope, state: ViewState): Promise<void>
    getViewState(scope: WorkspaceProfileScope, sessionId: string): Promise<ViewState | null>
  }
  diffs: {
    get(sessionId: string, runId: string): Promise<string>
  }
  turns: {
    send(input: SendTurnInput): Promise<{ session: Session; event?: Event; queued?: boolean; queued_id?: string; position?: number }>
    stop(sessionId: string): Promise<TurnStopResult>
  }
  codex: {
    auth(scope: CodexServerSettingsScope): Promise<CodexAuthStatus>
    loginWithApiKey(scope: CodexServerSettingsScope, apiKey: string): Promise<CodexAuthStatus>
    serverGoals(): Promise<CodexGoalsConfiguration>
    setServerGoals(enabled: boolean): Promise<CodexGoalsConfiguration>
    serverSubagents(scope: CodexServerSettingsScope): Promise<CodexSubagentsConfiguration>
    setServerSubagents(scope: CodexServerSettingsScope, limit: number | null): Promise<CodexSubagentsConfiguration>
    runtime(sessionId: string): Promise<CodexRuntimeSnapshot>
    loadThread(sessionId: string): Promise<CodexRuntimeSnapshot>
    resolveInteraction(
      sessionId: string,
      interactionId: string,
      response: Record<string, JsonValue>
    ): Promise<CodexPendingInteraction>
    permissionProfiles(sessionId: string): Promise<CodexPermissionProfile[]>
    goal(sessionId: string): Promise<CodexGoalSnapshot>
    setGoal(sessionId: string, input: CodexGoalInput): Promise<CodexGoalSnapshot>
    clearGoal(sessionId: string): Promise<CodexGoalSnapshot>
    compact(sessionId: string): Promise<CodexOperationAccepted>
    rollback(sessionId: string, input: CodexRollbackInput): Promise<CodexRollbackResult>
    review(sessionId: string, input: CodexReviewInput): Promise<CodexOperationAccepted>
    shell(sessionId: string, input: CodexShellInput): Promise<CodexOperationAccepted>
    backgroundTerminals(sessionId: string): Promise<CodexBackgroundTerminalsSnapshot>
    terminateBackgroundTerminal(
      sessionId: string,
      input: CodexBackgroundTerminalTerminateInput
    ): Promise<boolean>
    cleanBackgroundTerminals(
      sessionId: string,
      input: CodexBackgroundTerminalsCleanInput
    ): Promise<boolean>
  }
  claude: {
    runtime(sessionId: string): Promise<ClaudeRuntimeSnapshot>
    refreshContextUsage(sessionId: string): Promise<ClaudeRuntimeSnapshot>
    mcp(sessionId: string): Promise<ClaudeMcpSnapshot>
    controlMcp(sessionId: string, input: ClaudeMcpControlInput): Promise<ClaudeMcpSnapshot>
    resolveInteraction(
      sessionId: string,
      interactionId: string,
      response: Record<string, JsonValue>
    ): Promise<ClaudePendingInteraction>
  }
  queue: {
    list(sessionId: string): Promise<QueuedTurn[]>
    update(
      sessionId: string,
      queuedId: string,
      prompt: string,
      chatReferences?: ChatReference[],
      clientCapabilities?: string[],
      teamReferences?: TeamReference[],
      expectedMessageRevision?: number
    ): Promise<boolean>
    remove(sessionId: string, queuedId: string): Promise<boolean>
    skipCrossChatDelivery(sessionId: string, queuedId: string, identity: QueuedCrossChatDeliveryIdentity): Promise<boolean>
    move(sessionId: string, queuedId: string, direction: 'up' | 'down', expectedAdjacentQueuedId?: string): Promise<QueuedTurn[]>
    runNow(sessionId: string, queuedId: string): Promise<QueuedRunNowResponse>
  }
  agentRoutes: {
    list(scope: WorkspaceProfileScope, sessionId: string): Promise<AgentCrossChatRoutesSnapshot>
    search(scope: WorkspaceProfileScope, query: string, excludeSessionId: string, limit?: number): Promise<ChatSearchSnapshot>
    create(scope: WorkspaceProfileScope, sessionId: string, input: CreateAgentCrossChatRouteInput): Promise<AgentCrossChatRoute>
    update(scope: WorkspaceProfileScope, sessionId: string, routeId: string, input: UpdateAgentCrossChatRouteInput): Promise<AgentCrossChatRouteUpdateResult>
    remove(scope: WorkspaceProfileScope, sessionId: string, routeId: string, expectedRevision: string): Promise<DeleteAgentCrossChatRouteResult>
  }
  agentTeamMailRoutes: {
    list(scope: WorkspaceProfileScope, sessionId: string): Promise<AgentTeamMailRoutesSnapshot>
    remove(scope: WorkspaceProfileScope, sessionId: string, routeId: string, expectedRevision: string): Promise<DeleteAgentCrossChatRouteResult>
  }
  handoffs: {
    get(envelopeId: string): Promise<CrossChatHandoff>
    cancel(envelopeId: string): Promise<CrossChatHandoffSummary>
  }
  chatInbox: {
    list(scope: WorkspaceProfileScope, sessionId: string, cursor?: string | null, limit?: number): Promise<ChatInboxPage>
    remove(scope: WorkspaceProfileScope, sessionId: string, messageId: string): Promise<ChatInboxDeleteReceipt>
  }
  exchanges: {
    get(exchangeId: string): Promise<CrossChatExchange>
    cancel(exchangeId: string): Promise<CrossChatExchange>
  }
  jobs: {
    list(): Promise<Job[]>
    runs(
      sessionId: string,
      jobId: string,
      beforeSeq?: number | null,
      limit?: number,
      timelineGroupId?: string | null
    ): Promise<JobRunHistoryPage>
    create(input: CreateJobInput): Promise<Job>
    update(jobId: string, patch: UpdateJobInput): Promise<Job>
    remove(jobId: string): Promise<boolean>
    run(jobId: string): Promise<JobRunNowResult>
  }
  files: {
    choose(): Promise<NativeFileRef[]>
    pathForFile(file: File): string
    stageNativeFile(file: File): Promise<NativeFileRef | null>
    stageClipboardImage(data: ArrayBuffer, name: string, type: string): Promise<NativeFileRef>
    upload(sessionId: string, paths: string[]): Promise<AgentFile[]>
    list(sessionId: string, offset?: number, limit?: number, contentPrefix?: string): Promise<FilesPage>
    findEvent(sessionId: string, fileId: string): Promise<Event | null>
    readText(sessionId: string, file: AgentFile, requestId: string): Promise<AgentTextFile>
    cancelReadText(sessionId: string, requestId: string): Promise<boolean>
    save(sessionId: string, file: AgentFile): Promise<string | null>
    open(sessionId: string, file: AgentFile): Promise<void>
    openLinked(sessionId: string, target: string): Promise<void>
    reveal(sessionId: string, file: AgentFile): Promise<void>
    beginDrag(sessionId: string, file: AgentFile): Promise<boolean>
    mediaURL(profileId: string, profileGeneration: number, sessionId: string, fileId: string): string
  }
  workspace: {
    info(sessionId: string): Promise<WorkspaceInfo>
    entries(sessionId: string, path?: string, offset?: number, limit?: number): Promise<WorkspaceEntriesPage>
    search(sessionId: string, query?: string, limit?: number): Promise<WorkspaceSearchPage>
    read(sessionId: string, path: string): Promise<WorkspaceFile>
    readAbsolute(sessionId: string, path: string): Promise<WorkspaceFile>
    writeAbsolute(sessionId: string, path: string, content: string, expectedRevision: string): Promise<WorkspaceFile>
    overwriteAbsolute(sessionId: string, path: string, content: string): Promise<WorkspaceFile>
    previewAvailable(scope: WorkspaceProfileScope, sessionId: string, path: string): Promise<boolean>
    mediaURL(profileId: string, profileGeneration: number, sessionId: string, path: string): string
    download(sessionId: string, path: string): Promise<string | null>
    create(sessionId: string, path: string, kind: 'file' | 'directory'): Promise<WorkspaceCreateResult>
    write(sessionId: string, path: string, content: string, expectedRevision: string): Promise<WorkspaceFile>
    overwrite(sessionId: string, path: string, content: string): Promise<WorkspaceFile>
    rename(sessionId: string, path: string, newName: string, expectedRevision: string): Promise<WorkspaceRenameResult>
    remove(sessionId: string, path: string, expectedRevision: string, recursive: boolean): Promise<WorkspaceRemoveResult>
  }
  workingDirectories: {
    complete(path: string, limit?: number): Promise<WorkingDirectoryCompletion>
  }
  digest: {
    preview(input: DigestInput): Promise<string>
    send(input: DigestInput): Promise<boolean>
  }
  runtime: {
    catalog(refresh?: boolean): Promise<RuntimeCatalog>
  }
  processes: {
    list(sessionId: string): Promise<ProcessSnapshot>
    tail(sessionId: string, path: string, lines?: number): Promise<string>
  }
  tmux: {
    list(sessionId: string, includeAll?: boolean): Promise<TmuxPane[]>
    capture(sessionId: string, paneId: string, lines?: number): Promise<string>
  }
  terminal: {
    connect(profileId: string, profileGeneration: number, sessionId: string, options: TerminalConnectOptions): Promise<void>
    write(profileId: string, profileGeneration: number, sessionId: string, data: string): void
    resize(profileId: string, profileGeneration: number, sessionId: string, columns: number, rows: number): void
    scroll(profileId: string, profileGeneration: number, sessionId: string, delta: number): void
    disconnect(profileId: string, profileGeneration: number, sessionId: string): Promise<void>
    kill(profileId: string, profileGeneration: number, sessionId: string): Promise<boolean>
    windows(profileId: string, profileGeneration: number, sessionId: string): Promise<TerminalWindowsSnapshot>
    action(profileId: string, profileGeneration: number, sessionId: string, action: TerminalAction, target?: string): Promise<TerminalWindowsSnapshot>
  }
  ports: {
    list(profileId: string, profileGeneration: number): Promise<ForwardedPort[]>
    start(
      profileId: string,
      profileGeneration: number,
      sessionId: string,
      remotePort: number,
      preferredLocalPort?: number
    ): Promise<ForwardedPort>
    stop(profileId: string, profileGeneration: number, remotePort: number): Promise<void>
    open(profileId: string, profileGeneration: number, remotePort: number): Promise<void>
  }
  pins: {
    list(scope: WorkspaceProfileScope, sessionId: string): Promise<PinnedItem[]>
    put(scope: WorkspaceProfileScope, item: PinnedItem): Promise<PinnedItem[]>
    remove(scope: WorkspaceProfileScope, sessionId: string, itemId: string): Promise<PinnedItem[]>
  }
  preferences: {
    get<T>(key: string, fallback: T): Promise<T>
    set<T>(key: string, value: T): Promise<void>
    getScoped<T>(scope: WorkspaceProfileScope, key: string, fallback: T): Promise<T>
    setScoped<T>(scope: WorkspaceProfileScope, key: string, value: T): Promise<void>
  }
  native: {
    // True only when AGENTSDOCK_DISABLE_ANALYTICS=1 is set in the process
    // environment - used by CI's packaged-app smoke-test launches (which run
    // the real binary with a fresh, disposable user-data directory) so they
    // don't mint and report a brand-new anonymous install id on every run.
    analyticsDisabled: boolean
    openExternal(url: string): Promise<void>
    showItemInFolder(path: string): Promise<void>
    setBadge(count: number): Promise<void>
    notify(payload: ProfileNotificationPayload): Promise<void>
    log(scope: string, message: string, data?: unknown): Promise<void>
    readClipboard(): Promise<string>
    writeClipboard(text: string): Promise<void>
    readyForNotifications(): Promise<boolean>
    readyForSecurePeerInvite(): Promise<boolean>
    closeWindow(): Promise<void>
    completeCloseFlush(requestId: string, saved?: boolean): Promise<boolean>
    retryStorage(): Promise<void>
  }
  events: {
    on<K extends keyof import('./types').AppEventMap>(name: K, listener: (payload: import('./types').AppEventMap[K]) => void): () => void
  }
}

declare global {
  interface Window {
    agentsDock: AgentsDockAPI
  }
}
