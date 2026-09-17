import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentsDockAPI } from '../shared/ipc'
import type { AppEventMap } from '../shared/types'
import { buildMediaURL, buildWorkspaceMediaURL } from '../shared/media-url'

const api: AgentsDockAPI = {
  sideQuestions: {
    ask: (scope, sessionId, input) => ipcRenderer.invoke('side-questions:ask', scope, sessionId, input),
    cancel: (scope, sessionId, requestId) => ipcRenderer.invoke('side-questions:cancel', scope, sessionId, requestId)
  },
  chatShares: {
    preview: (scope, sessionId) => ipcRenderer.invoke('chat-shares:preview', scope, sessionId),
    list: (scope, sessionId, mode) => ipcRenderer.invoke('chat-shares:list', scope, sessionId, mode),
    create: (scope, sessionId, input) => ipcRenderer.invoke('chat-shares:create', scope, sessionId, input),
    revoke: (scope, sessionId, mode, shareId) => ipcRenderer.invoke('chat-shares:revoke', scope, sessionId, mode, shareId)
  },
  mailHints: {
    acknowledgePage: input => ipcRenderer.invoke('team:mail-hints:acknowledge-page', input),
    acknowledgeBulletinRefresh: input => ipcRenderer.invoke('team:mail-hints:acknowledge-bulletin', input)
  },
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  language: {
    get: () => ipcRenderer.invoke('language:get'),
    set: preference => ipcRenderer.invoke('language:set', preference)
  },
  teamHub: {
    status: () => ipcRenderer.invoke('team-hub:status'),
    connect: input => input
      ? ipcRenderer.invoke('team-hub:connect', input)
      : ipcRenderer.invoke('team-hub:connect'),
    configureServerRole: (scope, input) => ipcRenderer.invoke('team-hub:server-role:configure', scope, input),
    bootstrap: input => ipcRenderer.invoke('team-hub:bootstrap', input),
    join: input => ipcRenderer.invoke('team-hub:join', input),
    acceptInvitation: scope => ipcRenderer.invoke('team-hub:invitation:accept', scope),
    recoverDevice: input => ipcRenderer.invoke('team-hub:device-recover', input),
    refresh: scope => ipcRenderer.invoke('team-hub:refresh', scope),
    logout: scope => ipcRenderer.invoke('team-hub:logout', scope),
    disconnect: scope => ipcRenderer.invoke('team-hub:disconnect', scope),
    forgetBinding: input => ipcRenderer.invoke('team-hub:binding:forget', input),
    workspace: scope => ipcRenderer.invoke('team-hub:workspace', scope),
    team: (scope, teamId) => ipcRenderer.invoke('team-hub:team', scope, teamId),
    deviceSessions: (scope, cursor) => ipcRenderer.invoke('team-hub:device-sessions', scope, cursor),
    revokeDeviceSession: (scope, sessionId) => ipcRenderer.invoke('team-hub:device-session:revoke', scope, sessionId),
    members: (scope, teamId, cursor) => ipcRenderer.invoke('team-hub:members', scope, teamId, cursor),
    invitations: (scope, teamId, cursor) => ipcRenderer.invoke('team-hub:invitations', scope, teamId, cursor),
    revokeInvitation: (scope, teamId, invitationId) => ipcRenderer.invoke('team-hub:invitation:revoke', scope, teamId, invitationId),
    updateMember: (scope, input) => ipcRenderer.invoke('team-hub:member:update', scope, input),
    createInvitation: (scope, input) => ipcRenderer.invoke('team-hub:invitation:create', scope, input),
    createNodeEnrollment: (scope, input) => ipcRenderer.invoke('team-hub:node-enrollment:create', scope, input),
    createChannel: (scope, input) => ipcRenderer.invoke('team-hub:channel:create', scope, input),
    createDirect: (scope, input) => ipcRenderer.invoke('team-hub:direct:create', scope, input),
    messages: (scope, channelId, beforeSequence) => ipcRenderer.invoke('team-hub:messages', scope, channelId, beforeSequence),
    postMessage: (scope, input) => ipcRenderer.invoke('team-hub:message:post', scope, input),
    networkCapabilities: scope => ipcRenderer.invoke('team-hub:network:capabilities', scope),
    network: (scope, query) => ipcRenderer.invoke('team-hub:network:get', scope, query),
    renameNetworkServer: (scope, input) => ipcRenderer.invoke('team-hub:network:server:rename', scope, input),
    registerNetworkAgent: (scope, input) => ipcRenderer.invoke('team-hub:network:agent:register', scope, input),
    bulletin: (scope, query) => ipcRenderer.invoke('team-hub:network:bulletin:list', scope, query),
    postBulletin: (scope, input) => ipcRenderer.invoke('team-hub:network:bulletin:post', scope, input),
    deleteNetworkBulletin: (scope, input) => ipcRenderer.invoke('team-hub:network:bulletin:delete', scope, input),
    networkDeletions: (scope, query) => ipcRenderer.invoke('team-hub:network:deletions:list', scope, query),
    mailbox: (scope, query) => ipcRenderer.invoke('team-hub:network:mailbox:list', scope, query),
    sendMailbox: (scope, input) => ipcRenderer.invoke('team-hub:network:mailbox:send', scope, input),
    networkItem: (scope, teamId, itemId) => ipcRenderer.invoke('team-hub:network:item:get', scope, teamId, itemId),
    recordDeliveryReceipt: (scope, input) => ipcRenderer.invoke('team-hub:network:delivery:receipt', scope, input),
    createPassiveRequest: (scope, input) => ipcRenderer.invoke('team-hub:network:request:create', scope, input),
    passiveRequest: (scope, teamId, requestId) => ipcRenderer.invoke('team-hub:network:request:get', scope, teamId, requestId),
    replyPassiveRequest: (scope, input) => ipcRenderer.invoke('team-hub:network:request:reply', scope, input),
    teamMessagesCapabilities: scope => ipcRenderer.invoke('team-hub:network:messages:capabilities', scope),
    teamMessages: (scope, query) => ipcRenderer.invoke('team-hub:network:messages:list', scope, query),
    teamMessage: (scope, teamId, messageId) => ipcRenderer.invoke('team-hub:network:message:get', scope, teamId, messageId),
    teamMessageThread: (scope, query) => ipcRenderer.invoke('team-hub:network:message:thread', scope, query),
    createTeamMessage: (scope, input) => ipcRenderer.invoke('team-hub:network:message:create', scope, input),
    recordTeamMessageReceipt: (scope, input) => ipcRenderer.invoke('team-hub:network:message:receipt', scope, input),
    setTeamMessageMailboxState: (scope, input) => ipcRenderer.invoke('team-hub:network:message:mailbox-state', scope, input),
    deleteTeamMessage: (scope, input) => ipcRenderer.invoke('team-hub:network:message:delete', scope, input),
    reviseTeamMessage: (scope, input) => ipcRenderer.invoke('team-hub:network:message:revise', scope, input),
    dismissTeamMessage: (scope, input) => ipcRenderer.invoke('team-hub:network:message:dismiss', scope, input),
    teamMessageHistory: (scope, teamId, messageId, version) => ipcRenderer.invoke('team-hub:network:message:history', scope, teamId, messageId, version),
    declareTeamAttachment: (scope, input) => ipcRenderer.invoke('team-hub:network:attachment:declare', scope, input),
    uploadTeamAttachment: (scope, input) => ipcRenderer.invoke('team-hub:network:attachment:upload', scope, input),
    teamAttachment: (scope, teamId, attachmentId) => (
      ipcRenderer.invoke('team-hub:network:attachment:get', scope, teamId, attachmentId)
    ),
    cacheTeamAttachment: (scope, input) => ipcRenderer.invoke('team-hub:network:attachment:cache', scope, input),
    teamSkills: (scope, query) => ipcRenderer.invoke('team-hub:network:skills:list', scope, query),
    teamSkill: (scope, teamId, skillId) => ipcRenderer.invoke('team-hub:network:skill:get', scope, teamId, skillId),
    teamSkillVersions: (scope, query) => ipcRenderer.invoke('team-hub:network:skill:versions', scope, query),
    teamSkillVersion: (scope, teamId, skillId, version) => (
      ipcRenderer.invoke('team-hub:network:skill:version:get', scope, teamId, skillId, version)
    ),
    pinTeamSkill: (scope, input) => ipcRenderer.invoke('team-hub:network:skill:pin', scope, input),
    archiveTeamSkill: (scope, input) => ipcRenderer.invoke('team-hub:network:skill:archive', scope, input),
    dispatchAvailability: () => ipcRenderer.invoke('team-hub:dispatch:availability'),
    securePeerStatus: scope => ipcRenderer.invoke('team-hub:secure-peer:status', scope),
    configureSecurePeerHost: (scope, input) => ipcRenderer.invoke('team-hub:secure-peer:host', scope, input),
    requestSecurePeerPairing: (scope, input) => ipcRenderer.invoke('team-hub:secure-peer:request', scope, input),
    waitForSecurePeerPairingCompletion: (scope, input) => ipcRenderer.invoke('team-hub:secure-peer:completion-wait', scope, input),
    stopSecurePeerPairingCompletionWait: (scope, requestId) => ipcRenderer.invoke('team-hub:secure-peer:completion-stop', scope, requestId),
    refreshSecurePeerPairing: (scope, pairingId) => ipcRenderer.invoke('team-hub:secure-peer:refresh', scope, pairingId),
    cancelSecurePeerPairing: (scope, pairingId) => ipcRenderer.invoke('team-hub:secure-peer:cancel', scope, pairingId),
    activateSecurePeerPairing: (scope, input) => ipcRenderer.invoke('team-hub:secure-peer:activate', scope, input),
    deactivateSecurePeerConnection: (scope, input) => ipcRenderer.invoke('team-hub:secure-peer:connection:deactivate', scope, input),
    forgetSecurePeerConnection: (scope, input) => ipcRenderer.invoke('team-hub:secure-peer:connection:forget', scope, input),
    updateSecurePeerConnectionEndpoint: (scope, input) => ipcRenderer.invoke('team-hub:secure-peer:connection:endpoint', scope, input),
    securePeers: (scope, teamId) => ipcRenderer.invoke('team-hub:secure-peer:list', scope, teamId),
    approveSecurePeerPairing: (scope, input) => ipcRenderer.invoke('team-hub:secure-peer:approve', scope, input),
    rejectSecurePeerPairing: (scope, input) => ipcRenderer.invoke('team-hub:secure-peer:reject', scope, input),
    revokeSecurePeer: (scope, teamId, input) => ipcRenderer.invoke('team-hub:secure-peer:revoke', scope, teamId, input),
    publishSecurePeerRoute: (scope, input) => ipcRenderer.invoke('team-hub:secure-peer:route:publish', scope, input),
    revokeSecurePeerRoute: (scope, input) => ipcRenderer.invoke('team-hub:secure-peer:route:revoke', scope, input)
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    setTrack: track => ipcRenderer.invoke('updates:set-track', track)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    apply: settings => ipcRenderer.invoke('settings:apply', settings)
  },
  servers: {
    list: () => ipcRenderer.invoke('servers:list'),
    getActive: () => ipcRenderer.invoke('servers:get-active'),
    add: input => ipcRenderer.invoke('servers:add', input),
    update: (profileId, patch) => ipcRenderer.invoke('servers:update', profileId, patch),
    updateAndSwitch: (profileId, patch) => ipcRenderer.invoke('servers:update-and-switch', profileId, patch),
    remove: profileId => ipcRenderer.invoke('servers:remove', profileId),
    reorder: profileIds => ipcRenderer.invoke('servers:reorder', profileIds),
    switch: (profileId, force) => ipcRenderer.invoke('servers:switch', profileId, force),
    refresh: (profileId, profileGeneration) => ipcRenderer.invoke('servers:refresh', profileId, profileGeneration),
    testConnection: input => ipcRenderer.invoke('servers:test-connection', input),
    restartStatus: scope => ipcRenderer.invoke('servers:restart-status', scope),
    restart: (scope, expectedServerInstanceId, forceConfirmation) => forceConfirmation
      ? ipcRenderer.invoke('servers:restart', scope, expectedServerInstanceId, forceConfirmation)
      : ipcRenderer.invoke('servers:restart', scope, expectedServerInstanceId)
  },
  serverUpdates: {
    status: () => ipcRenderer.invoke('server-updates:status'),
    check: track => ipcRenderer.invoke('server-updates:check', track),
    start: (version, track, whenIdle) => ipcRenderer.invoke('server-updates:start', version, track, whenIdle),
    cancel: scheduleId => ipcRenderer.invoke('server-updates:cancel', scheduleId)
  },
  setup: {
    capabilities: () => ipcRenderer.invoke('server-setup:capabilities'),
    run: input => ipcRenderer.invoke('server-setup:run', input),
    cancel: () => ipcRenderer.invoke('server-setup:cancel'),
    diagnostics: () => ipcRenderer.invoke('server-setup:diagnostics'),
    openLog: () => ipcRenderer.invoke('server-setup:open-log')
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: input => ipcRenderer.invoke('sessions:create', input),
    resume: input => ipcRenderer.invoke('sessions:resume', input),
    update: (sessionId, patch) => ipcRenderer.invoke('sessions:update', sessionId, patch),
    reloadProvider: sessionId => ipcRenderer.invoke('sessions:provider:reload', sessionId),
    remove: sessionId => ipcRenderer.invoke('sessions:remove', sessionId),
    fork: sessionId => ipcRenderer.invoke('sessions:fork', sessionId),
    reorder: (sessionId, relativeTo, placement, targetFolder) => ipcRenderer.invoke('sessions:reorder', sessionId, relativeTo, placement, targetFolder),
    searchHistory: (query, limit) => ipcRenderer.invoke('sessions:search-history', query, limit),
    searchAllProfiles: (query, limit) => ipcRenderer.invoke('sessions:search-all-profiles', query, limit),
    markRead: (sessionId, seq) => ipcRenderer.invoke('sessions:read', sessionId, seq),
    markUnread: sessionId => ipcRenderer.invoke('sessions:unread', sessionId),
    acknowledgeEmergency: (sessionId, alertId) => ipcRenderer.invoke('sessions:emergency:acknowledge', sessionId, alertId),
    importHistory: (sessionId, force) => ipcRenderer.invoke('sessions:import-history', sessionId, force),
    listLocal: () => ipcRenderer.invoke('sessions:list-local'),
    bulkImport: items => ipcRenderer.invoke('sessions:bulk-import', items)
  },
  providerCommands: {
    list: (sessionId, refresh) => ipcRenderer.invoke('provider-commands:list', sessionId, refresh)
  },
  timeline: {
    cached: sessionId => ipcRenderer.invoke('timeline:cached', sessionId),
    open: (sessionId, forceRemote) => ipcRenderer.invoke('timeline:open', sessionId, forceRemote),
    older: (sessionId, before, limit) => ipcRenderer.invoke('timeline:older', sessionId, before, limit),
    historicalOlder: (sessionId, before, limit) => ipcRenderer.invoke('timeline:historical-older', sessionId, before, limit),
    around: (sessionId, anchorSeq, limit) => ipcRenderer.invoke('timeline:around', sessionId, anchorSeq, limit),
    trace: (sessionId, runId, anchorSeq, after, limit) => ipcRenderer.invoke('timeline:trace', sessionId, runId, anchorSeq, after, limit),
    index: sessionId => ipcRenderer.invoke('timeline:index', sessionId),
    search: (sessionId, query, limit) => ipcRenderer.invoke('timeline:search', sessionId, query, limit),
    subscribe: (sessionId, after) => ipcRenderer.invoke('timeline:subscribe', sessionId, after),
    unsubscribe: sessionId => ipcRenderer.invoke('timeline:unsubscribe', sessionId),
    saveViewState: (scope, state) => ipcRenderer.invoke('timeline:view-state:save', scope, state),
    getViewState: (scope, sessionId) => ipcRenderer.invoke('timeline:view-state:get', scope, sessionId)
  },
  diffs: {
    get: (sessionId, runId) => ipcRenderer.invoke('diffs:get', sessionId, runId)
  },
  turns: {
    send: input => ipcRenderer.invoke('turns:send', input),
    stop: sessionId => ipcRenderer.invoke('turns:stop', sessionId)
  },
  codex: {
    serverGoals: () => ipcRenderer.invoke('codex:server-goals:get'),
    setServerGoals: enabled => ipcRenderer.invoke('codex:server-goals:set', enabled),
    serverSubagents: scope => ipcRenderer.invoke('codex:server-subagents:get', scope),
    setServerSubagents: (scope, limit) => ipcRenderer.invoke('codex:server-subagents:set', scope, limit),
    runtime: sessionId => ipcRenderer.invoke('codex:runtime', sessionId),
    loadThread: sessionId => ipcRenderer.invoke('codex:thread:load', sessionId),
    resolveInteraction: (sessionId, interactionId, response) => (
      ipcRenderer.invoke('codex:interaction:resolve', sessionId, interactionId, response)
    ),
    permissionProfiles: sessionId => ipcRenderer.invoke('codex:permission-profiles', sessionId),
    goal: sessionId => ipcRenderer.invoke('codex:goal:get', sessionId),
    setGoal: (sessionId, input) => ipcRenderer.invoke('codex:goal:set', sessionId, input),
    clearGoal: sessionId => ipcRenderer.invoke('codex:goal:clear', sessionId),
    compact: sessionId => ipcRenderer.invoke('codex:compact', sessionId),
    rollback: (sessionId, input) => ipcRenderer.invoke('codex:rollback', sessionId, input),
    review: (sessionId, input) => ipcRenderer.invoke('codex:review', sessionId, input),
    shell: (sessionId, input) => ipcRenderer.invoke('codex:shell', sessionId, input),
    backgroundTerminals: sessionId => ipcRenderer.invoke('codex:background-terminals', sessionId),
    terminateBackgroundTerminal: (sessionId, input) => (
      ipcRenderer.invoke('codex:background-terminal:terminate', sessionId, input)
    ),
    cleanBackgroundTerminals: (sessionId, input) => (
      ipcRenderer.invoke('codex:background-terminals:clean', sessionId, input)
    )
  },
  claude: {
    runtime: sessionId => ipcRenderer.invoke('claude:runtime', sessionId),
    refreshContextUsage: sessionId => ipcRenderer.invoke('claude:context-usage:refresh', sessionId),
    mcp: sessionId => ipcRenderer.invoke('claude:mcp', sessionId),
    controlMcp: (sessionId, input) => ipcRenderer.invoke('claude:mcp:control', sessionId, input),
    resolveInteraction: (sessionId, interactionId, response) => (
      ipcRenderer.invoke('claude:interaction:resolve', sessionId, interactionId, response)
    )
  },
  queue: {
    list: sessionId => ipcRenderer.invoke('queue:list', sessionId),
    update: (sessionId, queuedId, prompt, chatReferences, clientCapabilities, teamReferences, expectedMessageRevision) => (
      ipcRenderer.invoke('queue:update', sessionId, queuedId, prompt, chatReferences, clientCapabilities, teamReferences,
        ...(expectedMessageRevision !== undefined ? [expectedMessageRevision] : []))
    ),
    remove: (sessionId, queuedId) => ipcRenderer.invoke('queue:remove', sessionId, queuedId),
    skipCrossChatDelivery: (sessionId, queuedId, identity) => (
      ipcRenderer.invoke('queue:skip-cross-chat-delivery', sessionId, queuedId, identity)
    ),
    move: (sessionId, queuedId, direction, expectedAdjacentQueuedId) => ipcRenderer.invoke('queue:move', sessionId, queuedId, direction, expectedAdjacentQueuedId),
    runNow: (sessionId, queuedId) => ipcRenderer.invoke('queue:run-now', sessionId, queuedId)
  },
  agentRoutes: {
    list: (scope, sessionId) => ipcRenderer.invoke('agent-routes:list', scope, sessionId),
    search: (scope, query, excludeSessionId, limit) => ipcRenderer.invoke('agent-routes:search', scope, query, excludeSessionId, limit),
    create: (scope, sessionId, input) => ipcRenderer.invoke('agent-routes:create', scope, sessionId, input),
    update: (scope, sessionId, routeId, input) => ipcRenderer.invoke('agent-routes:update', scope, sessionId, routeId, input),
    remove: (scope, sessionId, routeId, expectedRevision) => ipcRenderer.invoke('agent-routes:remove', scope, sessionId, routeId, expectedRevision)
  },
  agentTeamMailRoutes: {
    list: (scope, sessionId) => ipcRenderer.invoke('agent-team-mail-routes:list', scope, sessionId),
    remove: (scope, sessionId, routeId, expectedRevision) => ipcRenderer.invoke('agent-team-mail-routes:remove', scope, sessionId, routeId, expectedRevision)
  },
  handoffs: {
    get: envelopeId => ipcRenderer.invoke('handoffs:get', envelopeId),
    cancel: envelopeId => ipcRenderer.invoke('handoffs:cancel', envelopeId)
  },
  chatInbox: {
    list: (scope, sessionId, cursor, limit) => ipcRenderer.invoke('chat-inbox:list', scope, sessionId, cursor, limit),
    remove: (scope, sessionId, messageId) => ipcRenderer.invoke('chat-inbox:remove', scope, sessionId, messageId)
  },
  exchanges: {
    get: exchangeId => ipcRenderer.invoke('exchanges:get', exchangeId),
    cancel: exchangeId => ipcRenderer.invoke('exchanges:cancel', exchangeId)
  },
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    runs: (sessionId, jobId, beforeSeq, limit, timelineGroupId) => ipcRenderer.invoke(
      'jobs:runs',
      sessionId,
      jobId,
      beforeSeq,
      limit,
      timelineGroupId
    ),
    create: input => ipcRenderer.invoke('jobs:create', input),
    update: (jobId, patch) => ipcRenderer.invoke('jobs:update', jobId, patch),
    remove: jobId => ipcRenderer.invoke('jobs:remove', jobId),
    run: jobId => ipcRenderer.invoke('jobs:run', jobId)
  },
  files: {
    choose: () => ipcRenderer.invoke('files:choose'),
    pathForFile: file => webUtils.getPathForFile(file),
    stageNativeFile: file => {
      const path = webUtils.getPathForFile(file)
      return path ? ipcRenderer.invoke('files:stage-native', path) : Promise.resolve(null)
    },
    stageClipboardImage: (data, name, type) => ipcRenderer.invoke('files:stage-clipboard', data, name, type),
    upload: (sessionId, paths) => ipcRenderer.invoke('files:upload', sessionId, paths),
    list: (sessionId, offset, limit, contentPrefix) => ipcRenderer.invoke('files:list', sessionId, offset, limit, contentPrefix),
    findEvent: (sessionId, fileId) => ipcRenderer.invoke('files:event', sessionId, fileId),
    readText: (sessionId, file, requestId) => ipcRenderer.invoke('files:read-text', sessionId, file, requestId),
    cancelReadText: (sessionId, requestId) => ipcRenderer.invoke('files:read-text:cancel', sessionId, requestId),
    save: (sessionId, file) => ipcRenderer.invoke('files:save', sessionId, file),
    open: (sessionId, file) => ipcRenderer.invoke('files:open', sessionId, file),
    openLinked: (sessionId, target) => ipcRenderer.invoke('files:open-linked', sessionId, target),
    reveal: (sessionId, file) => ipcRenderer.invoke('files:reveal', sessionId, file),
    beginDrag: (sessionId, file) => ipcRenderer.invoke('files:begin-drag', sessionId, file),
    mediaURL: (profileId, profileGeneration, sessionId, fileId) => buildMediaURL(profileId, profileGeneration, sessionId, fileId)
  },
  workspace: {
    info: sessionId => ipcRenderer.invoke('workspace:info', sessionId),
    entries: (sessionId, path, offset, limit) => ipcRenderer.invoke('workspace:entries', sessionId, path, offset, limit),
    search: (sessionId, query, limit) => ipcRenderer.invoke('workspace:search', sessionId, query, limit),
    read: (sessionId, path) => ipcRenderer.invoke('workspace:read', sessionId, path),
    readAbsolute: (sessionId, path) => ipcRenderer.invoke('workspace:read-absolute', sessionId, path),
    writeAbsolute: (sessionId, path, content, expectedRevision) => ipcRenderer.invoke('workspace:write-absolute', sessionId, path, content, expectedRevision),
    overwriteAbsolute: (sessionId, path, content) => ipcRenderer.invoke('workspace:overwrite-absolute', sessionId, path, content),
    previewAvailable: (scope, sessionId, path) => ipcRenderer.invoke('workspace:preview-available', scope, sessionId, path),
    mediaURL: (profileId, profileGeneration, sessionId, path) => buildWorkspaceMediaURL(profileId, profileGeneration, sessionId, path),
    download: (sessionId, path) => ipcRenderer.invoke('workspace:download', sessionId, path),
    create: (sessionId, path, kind) => ipcRenderer.invoke('workspace:create', sessionId, path, kind),
    write: (sessionId, path, content, expectedRevision) => ipcRenderer.invoke('workspace:write', sessionId, path, content, expectedRevision),
    overwrite: (sessionId, path, content) => ipcRenderer.invoke('workspace:overwrite', sessionId, path, content),
    rename: (sessionId, path, newName, expectedRevision) => ipcRenderer.invoke('workspace:rename', sessionId, path, newName, expectedRevision),
    remove: (sessionId, path, expectedRevision, recursive) => ipcRenderer.invoke('workspace:remove', sessionId, path, expectedRevision, recursive)
  },
  workingDirectories: {
    complete: (path, limit) => ipcRenderer.invoke('working-directories:complete', path, limit)
  },
  digest: {
    preview: input => ipcRenderer.invoke('digest:preview', input),
    send: input => ipcRenderer.invoke('digest:send', input)
  },
  runtime: { catalog: refresh => ipcRenderer.invoke('runtime:catalog', refresh) },
  processes: {
    list: sessionId => ipcRenderer.invoke('processes:list', sessionId),
    tail: (sessionId, path, lines) => ipcRenderer.invoke('processes:tail', sessionId, path, lines)
  },
  tmux: {
    list: (sessionId, includeAll) => ipcRenderer.invoke('tmux:list', sessionId, includeAll),
    capture: (sessionId, paneId, lines) => ipcRenderer.invoke('tmux:capture', sessionId, paneId, lines)
  },
  terminal: {
    connect: (profileId, profileGeneration, sessionId, options) => ipcRenderer.invoke('terminal:connect', profileId, profileGeneration, sessionId, options),
    write: (profileId, profileGeneration, sessionId, data) => ipcRenderer.send('terminal:write', profileId, profileGeneration, sessionId, data),
    resize: (profileId, profileGeneration, sessionId, columns, rows) => ipcRenderer.send('terminal:resize', profileId, profileGeneration, sessionId, columns, rows),
    scroll: (profileId, profileGeneration, sessionId, delta) => ipcRenderer.send('terminal:scroll', profileId, profileGeneration, sessionId, delta),
    disconnect: (profileId, profileGeneration, sessionId) => ipcRenderer.invoke('terminal:disconnect', profileId, profileGeneration, sessionId),
    kill: (profileId, profileGeneration, sessionId) => ipcRenderer.invoke('terminal:kill', profileId, profileGeneration, sessionId),
    windows: (profileId, profileGeneration, sessionId) => ipcRenderer.invoke('terminal:windows', profileId, profileGeneration, sessionId),
    action: (profileId, profileGeneration, sessionId, action, target) => ipcRenderer.invoke('terminal:action', profileId, profileGeneration, sessionId, action, target)
  },
  ports: {
    list: (profileId, profileGeneration) => ipcRenderer.invoke('ports:list', profileId, profileGeneration),
    start: (profileId, profileGeneration, sessionId, remotePort, preferredLocalPort) => (
      ipcRenderer.invoke('ports:start', profileId, profileGeneration, sessionId, remotePort, preferredLocalPort)
    ),
    stop: (profileId, profileGeneration, remotePort) => (
      ipcRenderer.invoke('ports:stop', profileId, profileGeneration, remotePort)
    ),
    open: (profileId, profileGeneration, remotePort) => (
      ipcRenderer.invoke('ports:open', profileId, profileGeneration, remotePort)
    )
  },
  pins: {
    list: (scope, sessionId) => ipcRenderer.invoke('pins:list', scope, sessionId),
    put: (scope, item) => ipcRenderer.invoke('pins:put', scope, item),
    remove: (scope, sessionId, itemId) => ipcRenderer.invoke('pins:remove', scope, sessionId, itemId)
  },
  preferences: {
    get: (key, fallback) => ipcRenderer.invoke('preferences:get', key, fallback),
    set: (key, value) => ipcRenderer.invoke('preferences:set', key, value),
    getScoped: (scope, key, fallback) => ipcRenderer.invoke('preferences:get-scoped', scope, key, fallback),
    setScoped: (scope, key, value) => ipcRenderer.invoke('preferences:set-scoped', scope, key, value)
  },
  native: {
    analyticsDisabled: process.env.AGENTSDOCK_DISABLE_ANALYTICS === '1',
    openExternal: url => ipcRenderer.invoke('native:open-external', url),
    showItemInFolder: path => ipcRenderer.invoke('native:show-item', path),
    setBadge: count => ipcRenderer.invoke('native:set-badge', count),
    notify: payload => ipcRenderer.invoke('native:notify', payload),
    log: (scope, message, data) => ipcRenderer.invoke('native:log', scope, message, data),
    readClipboard: () => ipcRenderer.invoke('native:clipboard:read'),
    writeClipboard: text => ipcRenderer.invoke('native:clipboard:write', text),
    readyForNotifications: () => ipcRenderer.invoke('native:notification:ready'),
    readyForSecurePeerInvite: () => ipcRenderer.invoke('native:secure-peer-invite:ready'),
    closeWindow: () => ipcRenderer.invoke('native:close-window'),
    completeCloseFlush: (requestId, saved) => ipcRenderer.invoke('native:close-flush-complete', requestId, saved),
    retryStorage: () => ipcRenderer.invoke('native:retry-storage')
  },
  events: {
    on: <K extends keyof AppEventMap>(name: K, listener: (payload: AppEventMap[K]) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: AppEventMap[K]): void => listener(payload)
      ipcRenderer.on(name, wrapped)
      return () => ipcRenderer.removeListener(name, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('agentsDock', api)
