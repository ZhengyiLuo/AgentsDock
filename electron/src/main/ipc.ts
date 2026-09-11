import { app, BrowserWindow, clipboard, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { AppService } from './service'
import { appLog } from './logger'
import type { AppUpdateManager } from './updater'
import { ServerSetupManager } from './server-setup'
import { acknowledgeWindowCloseFlush, closeWindowAfterRendererFlush } from './window-close'
import type { LazyTeamHubService } from './team-hub-lazy-service'
import { LOCAL_SESSION_IMPORT_HARD_LIST_LIMIT, parseBulkImportSessionItems } from '../shared/local-session-import'
import type { LanguageSettings } from './language'

export interface RegisterIpcOptions {
  language?: Pick<LanguageSettings, 'get' | 'set'>
  securePeerInviteReady?: () => boolean
  notificationReady?: () => boolean
}

export function registerIpc(
  service: AppService,
  updater: AppUpdateManager,
  teamHub?: LazyTeamHubService,
  options: RegisterIpcOptions = {}
): ServerSetupManager {
  const serverSetup = new ServerSetupManager()
  const artifactTextReads = new Map<string, AbortController>()
  const handleWithEvent = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => {
      requireTrustedSender(event, channel)
      return listener(event, ...args)
    })
  }
  const handle = (channel: string, listener: (...args: any[]) => unknown): void => {
    handleWithEvent(channel, (_event, ...args) => listener(...args))
  }

  handle('app:bootstrap', () => service.bootstrap())
  if (options.language) {
    const language = options.language
    handle('language:get', () => language.get())
    handle('language:set', preference => language.set(preference))
  }
  if (teamHub) {
    handle('team-hub:status', () => teamHub.status())
    handle('team-hub:connect', input => teamHub.connect(input))
    handle('team-hub:server-role:configure', (scope, input) => teamHub.configureServerRole(scope, input))
    handle('team-hub:bootstrap', input => teamHub.bootstrap(input))
    handle('team-hub:join', input => teamHub.join(input))
    handle('team-hub:invitation:accept', scope => teamHub.acceptInvitation(scope))
    handle('team-hub:device-recover', input => teamHub.recoverDevice(input))
    handle('team-hub:refresh', scope => teamHub.refresh(scope))
    handle('team-hub:logout', scope => teamHub.logout(scope))
    handle('team-hub:disconnect', scope => teamHub.disconnect(scope))
    handle('team-hub:binding:forget', input => teamHub.forgetBinding(input))
    handle('team-hub:workspace', scope => teamHub.workspace(scope))
    handle('team-hub:team', (scope, teamId) => teamHub.teamDetails(scope, teamId))
    handle('team-hub:device-sessions', (scope, cursor) => teamHub.deviceSessions(scope, cursor))
    handle('team-hub:device-session:revoke', (scope, sessionId) => teamHub.revokeDeviceSession(scope, sessionId))
    handle('team-hub:members', (scope, teamId, cursor) => teamHub.members(scope, teamId, cursor))
    handle('team-hub:invitations', (scope, teamId, cursor) => teamHub.invitations(scope, teamId, cursor))
    handle('team-hub:invitation:revoke', (scope, teamId, invitationId) => teamHub.revokeInvitation(scope, teamId, invitationId))
    handle('team-hub:member:update', (scope, input) => teamHub.updateMember(scope, input))
    handle('team-hub:invitation:create', (scope, input) => teamHub.createInvitation(scope, input))
    handle('team-hub:node-enrollment:create', (scope, input) => teamHub.createNodeEnrollment(scope, input))
    handle('team-hub:channel:create', (scope, input) => teamHub.createChannel(scope, input))
    handle('team-hub:direct:create', (scope, input) => teamHub.createDirect(scope, input))
    handle('team-hub:messages', (scope, channelId, beforeSequence) => teamHub.messages(scope, channelId, beforeSequence))
    handle('team-hub:message:post', (scope, input) => teamHub.postMessage(scope, input))
    handle('team-hub:network:capabilities', scope => teamHub.networkCapabilities(scope))
    handle('team-hub:network:get', (scope, query) => teamHub.network(scope, query))
    handle('team-hub:network:agent:register', (scope, input) => teamHub.registerNetworkAgent(scope, input))
    handle('team-hub:network:bulletin:list', (scope, query) => teamHub.bulletin(scope, query))
    handle('team-hub:network:bulletin:post', (scope, input) => teamHub.postBulletin(scope, input))
    handle('team-hub:network:bulletin:delete', (scope, input) => teamHub.deleteNetworkBulletin(scope, input))
    handle('team-hub:network:deletions:list', (scope, query) => teamHub.networkDeletions(scope, query))
    handle('team-hub:network:mailbox:list', (scope, query) => teamHub.mailbox(scope, query))
    handle('team-hub:network:mailbox:send', (scope, input) => teamHub.sendMailbox(scope, input))
    handle('team-hub:network:item:get', (scope, teamId, itemId) => teamHub.networkItem(scope, teamId, itemId))
    handle('team-hub:network:delivery:receipt', (scope, input) => teamHub.recordDeliveryReceipt(scope, input))
    handle('team-hub:network:request:create', (scope, input) => teamHub.createPassiveRequest(scope, input))
    handle('team-hub:network:request:get', (scope, teamId, requestId) => teamHub.passiveRequest(scope, teamId, requestId))
    handle('team-hub:network:request:reply', (scope, input) => teamHub.replyPassiveRequest(scope, input))
    handle('team-hub:network:messages:capabilities', scope => teamHub.teamMessagesCapabilities(scope))
    handle('team-hub:network:messages:list', (scope, query) => teamHub.teamMessages(scope, query))
    handle('team-hub:network:message:get', (scope, teamId, messageId) => teamHub.teamMessage(scope, teamId, messageId))
    handle('team-hub:network:message:create', (scope, input) => teamHub.createTeamMessage(scope, input))
    handle('team-hub:network:message:receipt', (scope, input) => teamHub.recordTeamMessageReceipt(scope, input))
    handle('team-hub:network:message:mailbox-state', (scope, input) => teamHub.setTeamMessageMailboxState(scope, input))
    handle('team-hub:network:message:delete', (scope, input) => teamHub.deleteTeamMessage(scope, input))
    handle('team-hub:network:message:revise', (scope, input) => teamHub.reviseTeamMessage(scope, input))
    handle('team-hub:network:message:dismiss', (scope, input) => teamHub.dismissTeamMessage(scope, input))
    handle('team-hub:network:message:history', (scope, teamId, messageId, version) => teamHub.teamMessageHistory(scope, teamId, messageId, version))
    handleWithEvent('team-hub:network:attachment:declare', async (event, scope, input) => {
      const operation = service.beginTeamAttachmentOperation(event.sender.id)
      let file: ReturnType<AppService['admitTeamAttachmentFile']> | null = null
      let reservation: { teamId: string; path: string } | null = null
      let bound = false
      try {
        const teamId = input?.teamId
        const path = input?.path
        file = service.admitTeamAttachmentFile(event.sender.id, scope, teamId, path)
        reservation = { teamId, path }
        const declaration = await teamHub.declareTeamAttachment(scope, input, file, operation.signal)
        operation.assertCurrent()
        service.bindTeamAttachmentDeclaration(
          event.sender.id,
          scope,
          teamId,
          path,
          declaration.attachment.id
        )
        bound = true
        return declaration
      } finally {
        try {
          if (!bound && reservation) {
            try {
              service.abandonTeamAttachmentDeclaration(
                event.sender.id, scope, reservation.teamId, reservation.path
              )
            } catch { /* teardown must still close the held file and operation lease */ }
          }
        } finally {
          try { file?.close() }
          finally { operation.release() }
        }
      }
    })
    handleWithEvent('team-hub:network:attachment:upload', async (event, scope, input) => {
      const operation = service.beginTeamAttachmentOperation(event.sender.id)
      let file: ReturnType<AppService['admitTeamAttachmentFile']> | null = null
      try {
        file = service.admitTeamAttachmentFile(
          event.sender.id,
          scope,
          input.teamId,
          input.path,
          input.attachmentId
        )
        const attachment = await teamHub.uploadTeamAttachment(scope, input, file, operation.signal)
        operation.assertCurrent()
        return attachment
      } finally {
        try { file?.close() }
        finally { operation.release() }
      }
    })
    handle('team-hub:network:attachment:get', (scope, teamId, attachmentId) => (
      teamHub.teamAttachment(scope, teamId, attachmentId)
    ))
    handle('team-hub:network:attachment:cache', (scope, input) => teamHub.cacheTeamAttachment(scope, input))
    handle('team-hub:network:skills:list', (scope, query) => teamHub.teamSkills(scope, query))
    handle('team-hub:network:skill:get', (scope, teamId, skillId) => teamHub.teamSkill(scope, teamId, skillId))
    handle('team-hub:network:skill:versions', (scope, query) => teamHub.teamSkillVersions(scope, query))
    handle('team-hub:network:skill:version:get', (scope, teamId, skillId, version) => (
      teamHub.teamSkillVersion(scope, teamId, skillId, version)
    ))
    handle('team-hub:network:skill:pin', (scope, input) => teamHub.pinTeamSkill(scope, input))
    handle('team-hub:network:skill:archive', (scope, input) => teamHub.archiveTeamSkill(scope, input))
    handle('team-hub:dispatch:availability', () => teamHub.dispatchAvailability())
    handle('team-hub:secure-peer:status', scope => teamHub.securePeerStatus(scope))
    handle('team-hub:secure-peer:host', (scope, input) => teamHub.configureSecurePeerHost(scope, input))
    handle('team-hub:secure-peer:request', (scope, input) => teamHub.requestSecurePeerPairing(scope, input))
    handle('team-hub:secure-peer:completion-wait', (scope, input) => teamHub.waitForSecurePeerPairingCompletion(scope, input))
    handle('team-hub:secure-peer:completion-stop', (scope, requestId) => teamHub.stopSecurePeerPairingCompletionWait(scope, requestId))
    handle('team-hub:secure-peer:refresh', (scope, pairingId) => teamHub.refreshSecurePeerPairing(scope, pairingId))
    handle('team-hub:secure-peer:cancel', (scope, pairingId) => teamHub.cancelSecurePeerPairing(scope, pairingId))
    handle('team-hub:secure-peer:activate', (scope, input) => teamHub.activateSecurePeerPairing(scope, input))
    handle('team-hub:secure-peer:connection:deactivate', (scope, input) => teamHub.deactivateSecurePeerConnection(scope, input))
    handle('team-hub:secure-peer:connection:forget', (scope, input) => teamHub.forgetSecurePeerConnection(scope, input))
    handle('team-hub:secure-peer:list', (scope, teamId) => teamHub.securePeers(scope, teamId))
    handle('team-hub:secure-peer:approve', (scope, input) => teamHub.approveSecurePeerPairing(scope, input))
    handle('team-hub:secure-peer:reject', (scope, input) => teamHub.rejectSecurePeerPairing(scope, input))
    handle('team-hub:secure-peer:revoke', (scope, teamId, input) => teamHub.revokeSecurePeer(scope, teamId, input))
    handle('team-hub:secure-peer:route:publish', (scope, input) => teamHub.publishSecurePeerRoute(scope, input))
    handle('team-hub:secure-peer:route:revoke', (scope, input) => teamHub.revokeSecurePeerRoute(scope, input))
  }
  handle('updates:status', () => updater.status())
  handle('updates:check', () => updater.check(true))
  handle('updates:install', () => updater.install())
  handle('updates:set-track', track => updater.setTrack(track))
  handle('settings:get', () => service.publicSettings())
  handle('settings:apply', settings => service.applySettings(settings))
  handle('servers:list', () => service.listServers())
  handle('servers:get-active', () => service.getActiveServer())
  handle('servers:add', input => service.addServer(input))
  handle('servers:update', (profileId, patch) => service.updateServer(profileId, patch))
  handle('servers:update-and-switch', (profileId, patch) => service.updateServerAndSwitch(profileId, patch))
  handle('servers:remove', profileId => service.removeServer(profileId))
  handle('servers:reorder', profileIds => service.reorderServers(profileIds))
  handle('servers:switch', (profileId, force) => service.switchServer(profileId, force))
  handle('servers:refresh', (profileId, profileGeneration) => service.refreshServer(profileId, profileGeneration))
  handle('servers:test-connection', input => service.testServerConnection(input))
  handle('servers:restart-status', scope => service.serverRestartStatus(scope))
  handle('servers:restart', (scope, expectedServerInstanceId, forceConfirmation) => forceConfirmation === undefined
    ? service.restartServer(scope, expectedServerInstanceId)
    : service.restartServer(scope, expectedServerInstanceId, forceConfirmation))
  handle('server-updates:status', () => service.serverUpdateStatus())
  handle('server-updates:check', track => service.checkServerUpdate(track))
  handle('server-updates:start', (version, track, whenIdle) => service.startServerUpdate(version, track, whenIdle))
  handle('server-updates:cancel', scheduleId => service.cancelServerUpdate(scheduleId))
  handle('server-setup:capabilities', () => serverSetup.capabilities())
  handle('server-setup:cancel', () => serverSetup.cancel())
  handle('server-setup:diagnostics', () => serverSetup.diagnostics())
  handle('server-setup:open-log', async () => {
    const error = await shell.openPath(serverSetup.diagnostics().logPath)
    if (error) throw new Error(`Could not open the setup log: ${error}`)
    return true
  })
  ipcMain.removeHandler('server-setup:run')
  ipcMain.handle('server-setup:run', (event, input) => {
    requireTrustedSender(event, 'server-setup:run')
    return serverSetup.run(input, progress => {
      if (!event.sender.isDestroyed()) event.sender.send('server:setup-progress', progress)
    })
  })

  handle('sessions:list', () => service.listSessions())
  handle('sessions:create', input => service.createSession(input))
  handle('sessions:resume', input => service.resumeSession(input))
  handle('sessions:update', (sessionId, patch) => service.updateSession(sessionId, patch))
  handle('sessions:provider:reload', sessionId => service.reloadProvider(sessionId))
  handle('sessions:remove', sessionId => service.removeSession(sessionId))
  handle('sessions:fork', sessionId => service.forkSession(sessionId))
  handle('sessions:reorder', (sessionId, relativeTo, placement, targetFolder) => service.reorderSession(sessionId, relativeTo, placement, targetFolder))
  handle('sessions:search-history', (query, limit) => service.searchSessions(query, limit))
  handle('sessions:search-all-profiles', (query, limit) => service.searchAllProfileSessions(query, limit))
  handle('sessions:read', (sessionId, seq) => service.markRead(sessionId, seq))
  handle('sessions:unread', sessionId => service.markUnread(sessionId))
  handle('sessions:emergency:acknowledge', (sessionId, alertId) => service.acknowledgeEmergency(sessionId, alertId))
  handle('sessions:import-history', (sessionId, force) => service.importHistory(sessionId, force))
  handle('sessions:list-local', () => service.listLocalSessions())
  handle('sessions:bulk-import', items => service.bulkImportSessions(
    parseBulkImportSessionItems(items, LOCAL_SESSION_IMPORT_HARD_LIST_LIMIT)
  ))

  handle('timeline:cached', sessionId => service.cachedTimeline(sessionId))
  handle('timeline:open', (sessionId, forceRemote) => service.openTimeline(sessionId, forceRemote))
  handle('timeline:older', (sessionId, before, limit) => service.olderTimeline(sessionId, before, limit))
  handle('timeline:historical-older', (sessionId, before, limit) => service.historicalOlderTimeline(sessionId, before, limit))
  handle('timeline:around', (sessionId, anchorSeq, limit) => service.timelineAround(sessionId, anchorSeq, limit))
  handle('timeline:trace', (sessionId, runId, anchorSeq, after, limit) => service.timelineTrace(sessionId, runId, anchorSeq, after, limit))
  handle('timeline:index', sessionId => service.timelineIndex(sessionId))
  handle('timeline:search', (sessionId, query, limit) => service.searchTimeline(sessionId, query, limit))
  handle('timeline:subscribe', (sessionId, after) => service.subscribeTimeline(sessionId, after))
  handle('timeline:unsubscribe', sessionId => service.unsubscribeTimeline(sessionId))
  handle('timeline:view-state:get', (scope, sessionId) => service.viewState(scope, sessionId))
  handle('timeline:view-state:save', (scope, state) => service.saveViewState(scope, state))
  handle('diffs:get', (sessionId, runId) => service.codeDiff(sessionId, runId))

  handle('turns:send', input => service.sendTurn(input))
  handle('turns:stop', sessionId => service.stopTurn(sessionId))

  handle('codex:server-goals:get', () => service.codexServerGoals())
  handle('codex:server-goals:set', enabled => service.setCodexServerGoals(Boolean(enabled)))
  handle('codex:runtime', sessionId => service.codexRuntime(sessionId))
  handle('codex:thread:load', sessionId => service.loadCodexThread(sessionId))
  handle('codex:interaction:resolve', (sessionId, interactionId, response) => (
    service.resolveCodexInteraction(sessionId, interactionId, response)
  ))
  handle('codex:permission-profiles', sessionId => service.codexPermissionProfiles(sessionId))
  handle('codex:goal:get', sessionId => service.codexGoal(sessionId))
  handle('codex:goal:set', (sessionId, input) => service.setCodexGoal(sessionId, input))
  handle('codex:goal:clear', sessionId => service.clearCodexGoal(sessionId))
  handle('codex:compact', sessionId => service.compactCodexThread(sessionId))
  handle('codex:rollback', (sessionId, input) => service.rollbackCodexThread(sessionId, input))
  handle('codex:review', (sessionId, input) => service.reviewCodexThread(sessionId, input))
  handle('codex:shell', (sessionId, input) => service.shellCodexThread(sessionId, input))
  handle('codex:background-terminals', sessionId => service.codexBackgroundTerminals(sessionId))
  handle('codex:background-terminal:terminate', (sessionId, input) => (
    service.terminateCodexBackgroundTerminal(sessionId, input)
  ))
  handle('codex:background-terminals:clean', (sessionId, input) => (
    service.cleanCodexBackgroundTerminals(sessionId, input)
  ))

  handle('claude:runtime', sessionId => service.claudeRuntime(sessionId))
  handle('claude:context-usage:refresh', sessionId => service.refreshClaudeContextUsage(sessionId))
  handle('claude:mcp', sessionId => service.claudeMcp(sessionId))
  handle('claude:mcp:control', (sessionId, input) => service.controlClaudeMcp(sessionId, input))
  handle('claude:interaction:resolve', (sessionId, interactionId, response) => (
    service.resolveClaudeInteraction(sessionId, interactionId, response)
  ))

  handle('queue:list', sessionId => service.queue(sessionId))
  handle('queue:update', (sessionId, queuedId, prompt, chatReferences, clientCapabilities, teamReferences) => (
    service.updateQueued(sessionId, queuedId, prompt, chatReferences, clientCapabilities, teamReferences)
  ))
  handle('queue:remove', (sessionId, queuedId) => service.removeQueued(sessionId, queuedId))
  handle('queue:skip-cross-chat-delivery', (sessionId, queuedId, identity) => (
    service.skipQueuedCrossChatDelivery(sessionId, queuedId, identity)
  ))
  handle('queue:move', (sessionId, queuedId, direction, expectedAdjacentQueuedId) => service.moveQueued(sessionId, queuedId, direction, expectedAdjacentQueuedId))
  handle('queue:run-now', (sessionId, queuedId) => service.runQueuedNow(sessionId, queuedId))

  handle('agent-routes:list', (scope, sessionId) => service.agentHandoffRoutes(scope, sessionId))
  handle('agent-routes:search', (scope, query, excludeSessionId, limit) => service.searchAgentHandoffTargets(scope, query, excludeSessionId, limit))
  handle('agent-routes:create', (scope, sessionId, input) => service.createAgentHandoffRoute(scope, sessionId, input))
  handle('agent-routes:update', (scope, sessionId, routeId, input) => service.updateAgentHandoffRoute(scope, sessionId, routeId, input))
  handle('agent-routes:remove', (scope, sessionId, routeId, expectedRevision) => service.deleteAgentHandoffRoute(scope, sessionId, routeId, expectedRevision))

  handle('handoffs:get', envelopeId => service.crossChatHandoff(envelopeId))
  handle('handoffs:cancel', envelopeId => service.cancelCrossChatHandoff(envelopeId))
  handle('exchanges:get', exchangeId => service.crossChatExchange(exchangeId))
  handle('exchanges:cancel', exchangeId => service.cancelCrossChatExchange(exchangeId))

  handle('jobs:list', () => service.listJobs())
  handle('jobs:runs', (sessionId, jobId, beforeSeq, limit, timelineGroupId) => (
    service.jobRuns(sessionId, jobId, beforeSeq, limit, timelineGroupId)
  ))
  handle('jobs:create', input => service.createJob(input))
  handle('jobs:update', (jobId, patch) => service.updateJob(jobId, patch))
  handle('jobs:remove', jobId => service.removeJob(jobId))
  handle('jobs:run', jobId => service.runJob(jobId))

  handleWithEvent('files:choose', event => service.chooseFiles(event.sender.id))
  handleWithEvent('files:stage-native', (event, path) => service.stageNativeFile(event.sender.id, path))
  handleWithEvent('files:stage-clipboard', (event, data, name, type) => service.stageClipboardImage(event.sender.id, data, name, type))
  handleWithEvent('files:upload', (event, sessionId, paths) => service.uploadFiles(event.sender.id, sessionId, paths))
  handle('files:list', (sessionId, offset, limit, contentPrefix) => service.listFiles(sessionId, offset, limit, contentPrefix))
  handle('files:event', (sessionId, fileId) => service.fileEvent(sessionId, fileId))
  ipcMain.removeHandler('files:read-text')
  ipcMain.handle('files:read-text', async (event, sessionId, file, requestId) => {
    requireTrustedSender(event, 'files:read-text')
    const key = artifactTextReadKey(event, sessionId, requestId)
    artifactTextReads.get(key)?.abort()
    const controller = new AbortController()
    artifactTextReads.set(key, controller)
    try {
      return await service.readTextFile(sessionId, file, controller.signal)
    } finally {
      if (artifactTextReads.get(key) === controller) artifactTextReads.delete(key)
    }
  })
  ipcMain.removeHandler('files:read-text:cancel')
  ipcMain.handle('files:read-text:cancel', (event, sessionId, requestId) => {
    requireTrustedSender(event, 'files:read-text:cancel')
    const key = artifactTextReadKey(event, sessionId, requestId)
    const controller = artifactTextReads.get(key)
    if (!controller) return false
    artifactTextReads.delete(key)
    controller.abort()
    return true
  })
  handle('files:save', (sessionId, file) => service.saveFile(sessionId, file))
  handle('files:open', (sessionId, file) => service.openFile(sessionId, file))
  handle('files:open-linked', (sessionId, target) => service.openLinkedFile(sessionId, target))
  handle('files:reveal', (sessionId, file) => service.revealFile(sessionId, file))
  ipcMain.removeHandler('files:begin-drag')
  ipcMain.handle('files:begin-drag', (event, sessionId, file) => {
    requireTrustedSender(event, 'files:begin-drag')
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return false
    return service.beginDrag(sessionId, file, window)
  })
  handle('workspace:info', sessionId => service.workspaceInfo(sessionId))
  handle('workspace:entries', (sessionId, path, offset, limit) => service.workspaceEntries(sessionId, path, offset, limit))
  handle('workspace:search', (sessionId, query, limit) => service.workspaceSearch(sessionId, query, limit))
  handle('workspace:read', (sessionId, path) => service.workspaceFile(sessionId, path))
  handle('workspace:read-absolute', (sessionId, path) => service.absoluteFile(sessionId, path))
  handle('workspace:write-absolute', (sessionId, path, content, expectedRevision) => service.writeAbsoluteFile(sessionId, path, content, expectedRevision))
  handle('workspace:overwrite-absolute', (sessionId, path, content) => service.overwriteAbsoluteFile(sessionId, path, content))
  handle('workspace:preview-available', (scope, sessionId, path) => service.workspacePreviewAvailable(scope, sessionId, path))
  handle('workspace:download', (sessionId, path) => service.downloadWorkspaceFile(sessionId, path))
  handle('workspace:create', (sessionId, path, kind) => service.createWorkspaceEntry(sessionId, path, kind))
  handle('workspace:write', (sessionId, path, content, expectedRevision) => service.writeWorkspaceFile(sessionId, path, content, expectedRevision))
  handle('workspace:overwrite', (sessionId, path, content) => service.overwriteWorkspaceFile(sessionId, path, content))
  handle('workspace:rename', (sessionId, path, newName, expectedRevision) => service.renameWorkspaceEntry(sessionId, path, newName, expectedRevision))
  handle('workspace:remove', (sessionId, path, expectedRevision, recursive) => service.removeWorkspaceEntry(sessionId, path, expectedRevision, recursive))
  handle('working-directories:complete', (path, limit) => service.completeWorkingDirectory(path, limit))

  handle('digest:preview', input => service.previewDigest(input))
  handle('digest:send', input => service.sendDigest(input))
  handle('runtime:catalog', refresh => service.runtime(Boolean(refresh)))
  handle('processes:list', sessionId => service.processes(sessionId))
  handle('processes:tail', (sessionId, path, lines) => service.processLog(sessionId, path, lines))
  handle('tmux:list', (sessionId, includeAll) => service.tmux(sessionId, includeAll))
  handle('tmux:capture', (sessionId, paneId, lines) => service.captureTmux(sessionId, paneId, lines))
  handle('terminal:connect', (profileId, profileGeneration, sessionId, options) => service.connectTerminal(profileId, profileGeneration, sessionId, options))
  handle('terminal:disconnect', (profileId, profileGeneration, sessionId) => service.disconnectTerminalForProfile(profileId, profileGeneration, sessionId))
  handle('terminal:kill', (profileId, profileGeneration, sessionId) => service.killTerminal(profileId, profileGeneration, sessionId))
  handle('terminal:windows', (profileId, profileGeneration, sessionId) => service.terminalWindows(profileId, profileGeneration, sessionId))
  handle('terminal:action', (profileId, profileGeneration, sessionId, action, target) => service.terminalAction(profileId, profileGeneration, sessionId, action, target))
  handle('ports:list', (profileId, profileGeneration) => service.listForwardedPorts(profileId, profileGeneration))
  handle('ports:start', (profileId, profileGeneration, sessionId, remotePort, preferredLocalPort) => (
    service.startForwardedPort(profileId, profileGeneration, sessionId, remotePort, preferredLocalPort)
  ))
  handle('ports:stop', (profileId, profileGeneration, remotePort) => (
    service.stopForwardedPort(profileId, profileGeneration, remotePort)
  ))
  handle('ports:open', (profileId, profileGeneration, remotePort) => (
    service.openForwardedPort(profileId, profileGeneration, remotePort)
  ))
  ipcMain.removeAllListeners('terminal:write')
  ipcMain.on('terminal:write', (event, profileId, profileGeneration, sessionId, data) => {
    if (acceptTrustedSender(event, 'terminal:write')) service.writeTerminal(profileId, profileGeneration, sessionId, data)
  })
  ipcMain.removeAllListeners('terminal:resize')
  ipcMain.on('terminal:resize', (event, profileId, profileGeneration, sessionId, columns, rows) => {
    if (acceptTrustedSender(event, 'terminal:resize')) service.resizeTerminal(profileId, profileGeneration, sessionId, columns, rows)
  })
  ipcMain.removeAllListeners('terminal:scroll')
  ipcMain.on('terminal:scroll', (event, profileId, profileGeneration, sessionId, delta) => {
    if (acceptTrustedSender(event, 'terminal:scroll')) service.scrollTerminal(profileId, profileGeneration, sessionId, delta)
  })
  handle('pins:list', (scope, sessionId) => service.pins(scope, sessionId))
  handle('pins:put', (scope, item) => service.putPin(scope, item))
  handle('pins:remove', (scope, sessionId, itemId) => service.removePin(scope, sessionId, itemId))
  handle('preferences:get', (key, fallback) => service.preference(key, fallback))
  handle('preferences:set', (key, value) => service.putPreference(key, value))
  handle('preferences:get-scoped', (scope, key, fallback) => service.scopedPreference(scope, key, fallback))
  handle('preferences:set-scoped', (scope, key, value) => service.putScopedPreference(scope, key, value))

  handle('native:open-external', async url => {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new Error('Unsupported external URL')
    await shell.openExternal(parsed.toString())
  })
  handle('native:show-item', path => shell.showItemInFolder(path))
  handle('native:set-badge', count => service.setBadge(count))
  handle('native:notify', payload => service.notify(payload))
  handle('native:log', (scope, message, data) => appLog(`renderer:${scope}`, message, data))
  handle('native:clipboard:read', () => clipboard.readText())
  handle('native:clipboard:write', text => clipboard.writeText(String(text ?? '')))
  handle('native:notification:ready', () => options.notificationReady?.() ?? false)
  handle('native:secure-peer-invite:ready', () => options.securePeerInviteReady?.() ?? false)
  ipcMain.removeHandler('native:close-window')
  ipcMain.handle('native:close-window', event => {
    requireTrustedSender(event, 'native:close-window')
    return closeWindowAfterRendererFlush(BrowserWindow.fromWebContents(event.sender))
  })
  ipcMain.removeHandler('native:close-flush-complete')
  ipcMain.handle('native:close-flush-complete', (event, requestId) => {
    requireTrustedSender(event, 'native:close-flush-complete')
    return acknowledgeWindowCloseFlush(BrowserWindow.fromWebContents(event.sender), requestId)
  })
  return serverSetup
}

type SenderEvent = IpcMainEvent | IpcMainInvokeEvent

function artifactTextReadKey(event: SenderEvent, sessionId: unknown, requestId: unknown): string {
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 2_048 || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new Error('Invalid artifact text read chat.')
  }
  if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 240 || /[\u0000-\u001f\u007f]/.test(requestId)) {
    throw new Error('Invalid artifact text read request.')
  }
  return `${event.sender.id}:${sessionId}:${requestId}`
}

function acceptTrustedSender(event: SenderEvent, channel: string): boolean {
  if (isTrustedSender(event)) return true
  appLog('security', 'blocked IPC from an untrusted renderer', {
    channel,
    url: event.senderFrame?.url || event.sender.getURL()
  })
  return false
}

function requireTrustedSender(event: SenderEvent, channel: string): void {
  if (!acceptTrustedSender(event, channel)) throw new Error('Blocked request from an untrusted renderer')
}

function isTrustedSender(event: SenderEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed() || event.senderFrame?.parent) return false
  const value = event.senderFrame?.url || event.sender.getURL()
  try {
    const url = new URL(value)
    if (app.isPackaged) {
      return url.protocol === 'file:' && decodeURIComponent(url.pathname).endsWith('/out/renderer/index.html')
    }
    const devURL = process.env.ELECTRON_RENDERER_URL?.trim()
    if (devURL) return url.origin === new URL(devURL).origin
    return url.protocol === 'file:' && decodeURIComponent(url.pathname).endsWith('/out/renderer/index.html')
  } catch {
    return false
  }
}
