import { app, BrowserWindow, clipboard, dialog, Menu, net, powerMonitor, protocol, session, shell, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { registerIpc } from './ipc'
import { appLog } from './logger'
import { reportStorageError } from './storage-health'
import { AppService } from './service'
import { createEditMenu } from './edit-menu'
import { LanguageSettings } from './language'
import { localizeNativeMenu } from './native-menu'
import { t } from '../shared/i18n'
import type { ServerSetupManager } from './server-setup'
import { AppUpdateManager } from './updater'
import { installWindowCloseFlush } from './window-close'
import { parseMediaURL } from '../shared/media-url'
import { shortcutAccelerator } from '../shared/shortcuts'
import { workspacePathFromInternalLink } from '../shared/workspace-link-url'
import { LazyTeamHubService } from './team-hub-lazy-service'
import { TeamHubService } from './team-hub-service'
import { resolveUserDataPath } from './user-data-path'
import {
  SECURE_PEER_INVITE_EVENT,
  installSecurePeerDeepLinkLifecycle,
  SecurePeerDeepLinkRouter
} from './secure-peer-deep-link'

protocol.registerSchemesAsPrivileged([
  { scheme: 'agentsdock-media', privileges: { standard: true, secure: true, stream: true } }
])

process.on('uncaughtException', error => { reportStorageError(error); appLog('fatal', 'uncaught exception', errorDetails(error)) })
process.on('unhandledRejection', reason => { reportStorageError(reason); appLog('fatal', 'unhandled rejection', errorDetails(reason)) })

// Keep the preview app's cache, drafts, and encrypted settings when the
// production bundle replaces it as the canonical AgentsDock binary.
app.setPath('userData', resolveUserDataPath(
  app.getPath('appData'),
  process.resourcesPath,
  app.isPackaged,
  process.env.AGENTSDOCK_USER_DATA
))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  let service: AppService | null = null
  let serverSetup: ServerSetupManager | null = null
  let teamHub: LazyTeamHubService | null = null
  let language: LanguageSettings | null = null
  const securePeerDeepLinks = new SecurePeerDeepLinkRouter()
  const showMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  const protocolRegistered = installSecurePeerDeepLinkLifecycle({
    packaged: app.isPackaged,
    platform: process.platform,
    defaultApp: process.defaultApp,
    execPath: process.execPath,
    argv: process.argv,
    router: securePeerDeepLinks,
    showMainWindow,
    registerOpenURL: listener => { app.on('open-url', listener) },
    registerSecondInstance: listener => { app.on('second-instance', (_event, commandLine) => listener(commandLine)) },
    setDefaultProtocolClient: (scheme, executable, args) => executable
      ? app.setAsDefaultProtocolClient(scheme, executable, args)
      : app.setAsDefaultProtocolClient(scheme)
  })
  if (protocolRegistered === false) appLog('main', 'could not register secure peer invite protocol')
  // Keep the service alive until Electron's ordinary quit lifecycle closes
  // the renderer. The native close handshake persists the last draft and
  // timeline position using the current profile generation; will-quit stops
  // the service only after that handshake has completed.
  const updater = new AppUpdateManager(status => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('app:update', status)
    }
  })

  app.whenReady().then(() => {
    try {
      language = new LanguageSettings(app.getPath('userData'), () => app.getPreferredSystemLanguages()[0] || app.getLocale(), snapshot => {
        createMenu(() => mainWindow)
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send('app:language', snapshot)
        }
      })
      appLog('main', 'application ready', { version: app.getVersion(), electron: process.versions.electron })
      appLog('main', 'constructing app service')
      service = new AppService({
        removeTeamHubProfile: profileId => {
          const currentTeamHub = teamHub
          if (!currentTeamHub) throw new Error('Teamspace profile cleanup is not available yet.')
          return currentTeamHub.removeServerProfile(profileId)
        }
      })
      const appService = service
      teamHub = new LazyTeamHubService(() => new TeamHubService({
        discovery: {
          currentScope: () => appService.teamHubServerScope(),
          currentMailHintScope: expected => appService.currentMailHintScope(expected),
          currentDiscovery: expected => appService.currentTeamHubDiscovery(expected),
          discover: expected => appService.discoverTeamHub(expected),
          configureTeamHubServerRole: (expected, input) => appService.configureTeamHubServerRole(expected, input),
          requestBootstrapProof: (expected, input) => appService.requestTeamHubBootstrapProof(expected, input),
          securePeerStatus: expected => appService.securePeerStatus(expected),
          securePeerHostPeers: (expected, teamId) => appService.securePeerHostPeers(expected, teamId),
          revokeSecurePeerHostPeer: (expected, teamId, input) => appService.revokeSecurePeerHostPeer(expected, teamId, input),
          configureSecurePeerHost: (expected, input) => appService.configureSecurePeerHost(expected, input),
          requestSecurePeerPairing: (expected, input) => appService.requestSecurePeerPairing(expected, input),
          waitForSecurePeerPairingCompletion: (expected, input, signal) => appService.waitForSecurePeerPairingCompletion(expected, input, signal),
          refreshSecurePeerPairing: (expected, pairingId) => appService.refreshSecurePeerPairing(expected, pairingId),
          cancelSecurePeerPairing: (expected, pairingId) => appService.cancelSecurePeerPairing(expected, pairingId),
          approveSecurePeerPairing: (expected, input) => appService.approveSecurePeerPairing(expected, input),
          rejectSecurePeerPairing: (expected, input) => appService.rejectSecurePeerPairing(expected, input),
          activateSecurePeerPairing: (expected, input) => appService.activateSecurePeerPairing(expected, input),
          deactivateSecurePeerConnection: (expected, input) => appService.deactivateSecurePeerConnection(expected, input),
          forgetSecurePeerConnection: (expected, input) => appService.forgetSecurePeerConnection(expected, input),
          updateSecurePeerConnectionEndpoint: (expected, input, beforeWrite) => appService.updateSecurePeerConnectionEndpoint(expected, input, beforeWrite),
          publishSecurePeerRoute: (expected, input) => appService.publishSecurePeerRoute(expected, input),
          revokeSecurePeerRoute: (expected, input) => appService.revokeSecurePeerRoute(expected, input),
          secureTeamHubProxyFetch: (expected, basePath) => appService.secureTeamHubProxyFetch(expected, basePath),
          serverTeamHubProxyFetch: (expected, basePath) => appService.serverTeamHubProxyFetch(expected, basePath)
        },
        teamCacheRoot: join(app.getPath('userData'), 'team-cache')
      }))
      appLog('main', 'app service ready')
      serverSetup = registerIpc(service, updater, teamHub, {
        language,
        notificationReady: () => appService.rendererReadyForNotificationRoutes(mainWindow),
        securePeerInviteReady: () => {
          const window = mainWindow
          if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) return false
          securePeerDeepLinks.rendererReady(payload => {
            const target = mainWindow
            if (!target || target.isDestroyed() || target.webContents.isDestroyed() || target.webContents.isLoadingMainFrame()) return false
            target.webContents.send(SECURE_PEER_INVITE_EVENT, payload)
            showMainWindow()
            return true
          })
          return true
        }
      })
      appLog('main', 'IPC registered')
      session.defaultSession.setPermissionCheckHandler(() => false)
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
      session.defaultSession.protocol.handle('agentsdock-media', async request => {
        const resource = parseMediaURL(request.url)
        if (!service || !resource) return mediaNotFoundResponse()
        try {
          if ('fileId' in resource) {
            return await service.mediaResponse(
              resource.profileId,
              resource.profileGeneration,
              resource.sessionId,
              resource.fileId,
              request
            )
          }
          if ('attachmentId' in resource) {
            if (!teamHub) return mediaNotFoundResponse()
            return await teamHub.teamAttachmentMediaResponse(resource, request)
          }
          return await service.workspaceMediaResponse(
            resource.profileId,
            resource.profileGeneration,
            resource.sessionId,
            resource.path,
            request
          )
        } catch {
          return mediaNotFoundResponse()
        }
      })
      createMenu(() => mainWindow)
      mainWindow = createWindow()
      installSecurePeerDeepLinkWindow(mainWindow, securePeerDeepLinks)
      service.addWindow(mainWindow)
      service.start()
      updater.start()
      appLog('main', 'window created and background services started')
    } catch (error) {
      const details = errorDetails(error)
      appLog('fatal', 'startup failed', details)
      dialog.showErrorBox(t('native.startupFailure'), `${details.message}\n\n${t('native.logPath', { path: join(app.getPath('userData'), 'logs', 'agentsdock.log') })}`)
      app.quit()
      return
    }

    app.on('activate', () => {
      language?.refreshSystemLocale()
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
        installSecurePeerDeepLinkWindow(mainWindow, securePeerDeepLinks)
        service?.addWindow(mainWindow)
      } else {
        mainWindow?.show()
      }
    })
    powerMonitor.on('resume', () => language?.refreshSystemLocale())
  }).catch(error => {
    appLog('fatal', 'app readiness failed', errorDetails(error))
    app.quit()
  })

  app.on('will-quit', () => {
    serverSetup?.cancel()
    updater.stop()
    service?.stop()
    teamHub?.stop()
  })
  app.on('window-all-closed', () => app.quit())
}

function installSecurePeerDeepLinkWindow(window: BrowserWindow, router: SecurePeerDeepLinkRouter): void {
  router.rendererUnavailable()
  window.webContents.on('did-start-loading', () => router.rendererUnavailable())
  window.on('closed', () => router.rendererUnavailable())
}

function errorDetails(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function createWindow(): BrowserWindow {
  const platformWindowOptions = process.platform === 'darwin'
    ? {
        titleBarStyle: 'hiddenInset' as const,
        trafficLightPosition: { x: 16, y: 16 }
      }
    : {}
  const window = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'AgentsDock',
    ...platformWindowOptions,
    backgroundColor: '#171717',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      devTools: !app.isPackaged,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.on('preload-error', (_event, path, error) => appLog('preload', 'failed to load', { path, error: error.stack || error.message }))
  window.webContents.on('did-fail-load', (_event, code, description, url) => appLog('renderer', 'page load failed', { code, description, url }))
  window.webContents.on('render-process-gone', (_event, details) => appLog('renderer', 'process gone', details))
  window.webContents.on('unresponsive', () => appLog('renderer', 'window unresponsive'))
  window.webContents.on('responsive', () => appLog('renderer', 'window responsive again'))
  window.webContents.once('did-finish-load', () => {
    const path = process.env.AGENTSDOCK_CAPTURE_PATH
    if (!path) return
    setTimeout(() => void window.webContents.capturePage().then(image => writeFile(path, image.toPNG())), 1800)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalURL(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  installWindowCloseFlush(window, {
    onTimeout: requestId => appLog('persistence', 'renderer close flush timed out', { requestId })
  })
  installNativeContextMenu(window)

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

function installNativeContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = []
    const separator = (): void => {
      if (template.length && template.at(-1)?.type !== 'separator') template.push({ type: 'separator' })
    }

    const workspacePath = workspacePathFromInternalLink(params.linkURL)
    if (workspacePath) {
      template.push({ label: t('native.copyPath'), click: () => clipboard.writeText(workspacePath) })
    } else if (params.linkURL) {
      template.push(
        { label: t('native.openLink'), enabled: isExternalURL(params.linkURL), click: () => void openExternalURL(params.linkURL) },
        { label: t('native.copyLink'), click: () => clipboard.writeText(params.linkURL) }
      )
    }

    if (params.mediaType === 'image') {
      separator()
      template.push({ label: t('native.copyImage'), click: () => window.webContents.copyImageAt(params.x, params.y) })
    }

    if (params.isEditable) {
      separator()
      template.push(
        { role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'pasteAndMatchStyle', enabled: params.editFlags.canPaste },
        { role: 'delete', enabled: params.editFlags.canDelete },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll }
      )
    } else if (params.selectionText.trim()) {
      separator()
      template.push(
        { role: 'copy', enabled: params.editFlags.canCopy },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll }
      )
    }

    while (template.at(-1)?.type === 'separator') template.pop()
    if (template.length) Menu.buildFromTemplate(localizeNativeMenu(template)).popup({ window })
  })
}

function createMenu(window: () => BrowserWindow | null): void {
  const send = (command: string): void => window()?.webContents.send('native:menu', { command })
  const devViewItems: MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }]
  const viewMenu: MenuItemConstructorOptions = {
    label: t('native.view'),
    submenu: [
      ...devViewItems,
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { label: t('native.chatFont'), submenu: [
        { label: t('native.increaseSize'), accelerator: 'CmdOrCtrl+Alt+Plus', click: () => send('chat-font-increase') },
        { label: t('native.decreaseSize'), accelerator: 'CmdOrCtrl+Alt+-', click: () => send('chat-font-decrease') },
        { label: t('native.textSize'), submenu: [
          { label: '13 px', click: () => send('chat-font-size:13') },
          { label: '14 px', click: () => send('chat-font-size:14') },
          { label: '15 px', click: () => send('chat-font-size:15') },
          { label: '16 px', click: () => send('chat-font-size:16') },
          { label: '18 px', click: () => send('chat-font-size:18') },
          { label: '20 px', click: () => send('chat-font-size:20') },
          { label: '22 px', click: () => send('chat-font-size:22') },
          { label: '24 px', click: () => send('chat-font-size:24') }
        ] },
        { type: 'separator' },
        { label: t('native.systemFont'), click: () => send('chat-font-family:system') },
        { label: t('native.roundedFont'), click: () => send('chat-font-family:rounded') },
        { label: t('native.monospacedFont'), click: () => send('chat-font-family:mono') }
      ] },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }
  const applicationMenu: MenuItemConstructorOptions = process.platform === 'darwin'
    ? { role: 'appMenu', label: 'AgentsDock', submenu: [
        { role: 'about' }, { type: 'separator' },
        { label: t('native.checkUpdates'), click: () => send('check-update') },
        { label: t('native.settings'), accelerator: shortcutAccelerator('settings'), click: () => send('settings') },
        { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }
      ] }
    : { label: 'AgentsDock', submenu: [
        { role: 'about' },
        { label: t('native.checkUpdates'), click: () => send('check-update') },
        { label: t('native.settings'), accelerator: shortcutAccelerator('settings'), click: () => send('settings') },
        { type: 'separator' }, { role: 'quit' }
      ] }
  Menu.setApplicationMenu(Menu.buildFromTemplate(localizeNativeMenu([
    applicationMenu,
    { role: 'fileMenu', submenu: [
      { label: t('native.newChat'), accelerator: shortcutAccelerator('newChat'), click: () => send('new-chat') },
      { label: t('native.openWorkspaceFile'), accelerator: shortcutAccelerator('openWorkspaceFile'), click: () => send('open-workspace-file') },
      { label: t('native.attachFiles'), accelerator: shortcutAccelerator('attachFiles'), click: () => send('attach-files') },
      { type: 'separator' }, { label: t('native.close'), accelerator: shortcutAccelerator('closeSurface'), click: () => send('close-surface') }
    ] },
    createEditMenu(send),
    { label: t('native.chat'), submenu: [
      { label: t('native.switchChat'), accelerator: shortcutAccelerator('findChat'), click: () => send('find-chat') },
      { label: t('native.find'), accelerator: shortcutAccelerator('findInChat'), click: () => send('find-in-current-chat') },
      { label: t('native.nextWorkspaceTab'), accelerator: shortcutAccelerator('nextWorkspaceTab'), click: () => send('next-workspace-tab') },
      { label: t('native.previousWorkspaceTab'), accelerator: shortcutAccelerator('previousWorkspaceTab'), click: () => send('previous-workspace-tab') },
      { type: 'separator' },
      { label: t('native.toggleInspector'), accelerator: shortcutAccelerator('toggleInspector'), click: () => send('toggle-inspector') },
      { label: t('native.jumpLatest'), accelerator: shortcutAccelerator('jumpLatest'), click: () => send('jump-latest') }
    ] },
    { label: t('native.server'), submenu: [
      { label: t('native.nextServer'), accelerator: shortcutAccelerator('nextServer'), click: () => send('next-server') },
      { label: t('native.previousServer'), accelerator: shortcutAccelerator('previousServer'), click: () => send('previous-server') }
    ] },
    viewMenu,
    { role: 'windowMenu', submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      ...(process.platform === 'darwin' ? [{ role: 'front' as const }] : [{ role: 'close' as const }])
    ] },
    { role: 'help', submenu: [
      { label: t('native.documentation'), click: () => void openExternalURL('https://github.com/ZhengyiLuo/AgentsDock') }
    ] }
  ])))
}

function isExternalURL(value: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function mediaNotFoundResponse(): Response {
  return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
}

async function openExternalURL(value: string): Promise<void> {
  if (!isExternalURL(value)) return
  await shell.openExternal(value)
}
