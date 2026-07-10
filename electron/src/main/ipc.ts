import { BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import type { AppService } from './service'
import { appLog } from './logger'
import type { AppUpdateManager } from './updater'

export function registerIpc(service: AppService, updater: AppUpdateManager): void {
  const handle = (channel: string, listener: (...args: any[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, ...args) => listener(...args))
  }

  handle('app:bootstrap', () => service.bootstrap())
  handle('updates:status', () => updater.status())
  handle('updates:check', () => updater.check(true))
  handle('updates:install', () => updater.install())
  handle('settings:get', () => service.publicSettings())
  handle('settings:apply', settings => service.applySettings(settings))

  handle('sessions:list', () => service.listSessions())
  handle('sessions:create', input => service.createSession(input))
  handle('sessions:resume', input => service.resumeSession(input))
  handle('sessions:update', (sessionId, patch) => service.updateSession(sessionId, patch))
  handle('sessions:remove', sessionId => service.removeSession(sessionId))
  handle('sessions:fork', sessionId => service.forkSession(sessionId))
  handle('sessions:reorder', (sessionId, relativeTo, placement) => service.reorderSession(sessionId, relativeTo, placement))
  handle('sessions:search-history', (query, limit) => service.searchSessions(query, limit))
  handle('sessions:read', (sessionId, seq) => service.markRead(sessionId, seq))
  handle('sessions:unread', sessionId => service.markUnread(sessionId))
  handle('sessions:import-history', (sessionId, force) => service.importHistory(sessionId, force))

  handle('timeline:cached', sessionId => service.cachedTimeline(sessionId))
  handle('timeline:open', sessionId => service.openTimeline(sessionId))
  handle('timeline:older', (sessionId, before, limit) => service.olderTimeline(sessionId, before, limit))
  handle('timeline:around', (sessionId, anchorSeq, limit) => service.timelineAround(sessionId, anchorSeq, limit))
  handle('timeline:index', sessionId => service.timelineIndex(sessionId))
  handle('timeline:search', (sessionId, query, limit) => service.searchTimeline(sessionId, query, limit))
  handle('timeline:subscribe', (sessionId, after) => service.subscribeTimeline(sessionId, after))
  handle('timeline:unsubscribe', sessionId => service.unsubscribeTimeline(sessionId))
  handle('timeline:view-state:get', sessionId => service.viewState(sessionId))
  handle('timeline:view-state:save', state => service.saveViewState(state))
  handle('diffs:get', (sessionId, runId) => service.codeDiff(sessionId, runId))

  handle('turns:send', input => service.sendTurn(input))
  handle('turns:stop', sessionId => service.stopTurn(sessionId))

  handle('queue:list', sessionId => service.queue(sessionId))
  handle('queue:update', (sessionId, queuedId, prompt) => service.updateQueued(sessionId, queuedId, prompt))
  handle('queue:remove', (sessionId, queuedId) => service.removeQueued(sessionId, queuedId))
  handle('queue:move', (sessionId, queuedId, direction) => service.moveQueued(sessionId, queuedId, direction))
  handle('queue:run-now', (sessionId, queuedId) => service.runQueuedNow(sessionId, queuedId))

  handle('jobs:list', () => service.listJobs())
  handle('jobs:create', input => service.createJob(input))
  handle('jobs:update', (jobId, patch) => service.updateJob(jobId, patch))
  handle('jobs:remove', jobId => service.removeJob(jobId))
  handle('jobs:run', jobId => service.runJob(jobId))

  handle('files:choose', () => service.chooseFiles())
  handle('files:stage-clipboard', (data, name, type) => service.stageClipboardImage(data, name, type))
  handle('files:upload', (sessionId, paths) => service.uploadFiles(sessionId, paths))
  handle('files:list', (sessionId, offset, limit, contentPrefix) => service.listFiles(sessionId, offset, limit, contentPrefix))
  handle('files:event', (sessionId, fileId) => service.fileEvent(sessionId, fileId))
  handle('files:save', file => service.saveFile(file))
  handle('files:open', file => service.openFile(file))
  handle('files:open-linked', (sessionId, target) => service.openLinkedFile(sessionId, target))
  handle('files:reveal', file => service.revealFile(file))
  handle('files:prepare-drag', file => service.prepareFileForDrag(file))
  ipcMain.removeHandler('files:begin-drag')
  ipcMain.handle('files:begin-drag', async (event, file) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return false
    await service.beginDrag(file, window)
    return true
  })

  handle('digest:preview', input => service.previewDigest(input))
  handle('digest:send', input => service.sendDigest(input))
  handle('runtime:catalog', () => service.runtime())
  handle('processes:list', sessionId => service.processes(sessionId))
  handle('processes:tail', (sessionId, path, lines) => service.processLog(sessionId, path, lines))
  handle('tmux:list', (sessionId, includeAll) => service.tmux(sessionId, includeAll))
  handle('tmux:capture', (sessionId, paneId, lines) => service.captureTmux(sessionId, paneId, lines))
  handle('terminal:connect', (sessionId, options) => service.connectTerminal(sessionId, options))
  handle('terminal:disconnect', sessionId => service.disconnectTerminal(sessionId))
  handle('terminal:kill', sessionId => service.killTerminal(sessionId))
  handle('terminal:windows', sessionId => service.terminalWindows(sessionId))
  handle('terminal:action', (sessionId, action, target) => service.terminalAction(sessionId, action, target))
  ipcMain.removeAllListeners('terminal:write')
  ipcMain.on('terminal:write', (_event, sessionId, data) => service.writeTerminal(sessionId, data))
  ipcMain.removeAllListeners('terminal:resize')
  ipcMain.on('terminal:resize', (_event, sessionId, columns, rows) => service.resizeTerminal(sessionId, columns, rows))
  handle('pins:list', sessionId => service.pins(sessionId))
  handle('pins:put', item => service.putPin(item))
  handle('pins:remove', (sessionId, itemId) => service.removePin(sessionId, itemId))
  handle('preferences:get', (key, fallback) => service.preference(key, fallback))
  handle('preferences:set', (key, value) => service.putPreference(key, value))

  handle('native:open-external', async url => {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new Error('Unsupported external URL')
    await shell.openExternal(parsed.toString())
  })
  handle('native:show-item', path => shell.showItemInFolder(path))
  handle('native:set-badge', count => service.setBadge(count))
  handle('native:notify', (title, body, sessionId) => service.notify(title, body, sessionId))
  handle('native:log', (scope, message, data) => appLog(`renderer:${scope}`, message, data))
  handle('native:clipboard:read', () => clipboard.readText())
  handle('native:clipboard:write', text => clipboard.writeText(String(text ?? '')))
  ipcMain.removeHandler('native:close-window')
  ipcMain.handle('native:close-window', event => BrowserWindow.fromWebContents(event.sender)?.close())
}
