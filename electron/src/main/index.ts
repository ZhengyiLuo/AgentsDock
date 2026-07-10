import { app, BrowserWindow, dialog, Menu, net, protocol, session, shell } from 'electron'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { registerIpc } from './ipc'
import { appLog } from './logger'
import { AppService } from './service'
import { AppUpdateManager } from './updater'

protocol.registerSchemesAsPrivileged([
  { scheme: 'agentsdock-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

process.on('uncaughtException', error => appLog('fatal', 'uncaught exception', errorDetails(error)))
process.on('unhandledRejection', reason => appLog('fatal', 'unhandled rejection', errorDetails(reason)))

// Keep the preview app's cache, drafts, and encrypted settings when the
// production bundle replaces it as the canonical AgentsDock binary.
app.setPath('userData', join(app.getPath('appData'), 'agentsdock-electron'))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  let service: AppService | null = null
  const updater = new AppUpdateManager(status => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('app:update', status)
    }
  })

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    try {
      appLog('main', 'application ready', { version: app.getVersion(), electron: process.versions.electron })
      appLog('main', 'constructing app service')
      service = new AppService()
      appLog('main', 'app service ready')
      registerIpc(service, updater)
      appLog('main', 'IPC registered')
      session.defaultSession.protocol.handle('agentsdock-media', request => {
        const url = new URL(request.url)
        const fileId = decodeURIComponent(url.pathname.replace(/^\//, ''))
        if (!service || url.hostname !== 'file' || !fileId) return new Response('Not found', { status: 404 })
        return service.mediaResponse(fileId, request)
      })
      createMenu(() => mainWindow)
      mainWindow = createWindow()
      service.addWindow(mainWindow)
      service.start()
      updater.start()
      appLog('main', 'window created and background services started')
    } catch (error) {
      const details = errorDetails(error)
      appLog('fatal', 'startup failed', details)
      dialog.showErrorBox('AgentsDock could not start', `${details.message}\n\nLog: ${join(app.getPath('userData'), 'logs', 'agentsdock.log')}`)
      app.quit()
      return
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
        service?.addWindow(mainWindow)
      } else {
        mainWindow?.show()
      }
    })
  }).catch(error => {
    appLog('fatal', 'app readiness failed', errorDetails(error))
    app.quit()
  })

  app.on('before-quit', () => {
    updater.stop()
    service?.stop()
  })
  app.on('window-all-closed', () => app.quit())
}

function errorDetails(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'AgentsDock',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#171717',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
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
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', event => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

function createMenu(window: () => BrowserWindow | null): void {
  const send = (command: string): void => window()?.webContents.send('native:menu', { command })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Check for Updates…', click: () => send('check-update') },
      { label: 'Settings…', accelerator: 'Command+,', click: () => send('settings') },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }
    ] },
    { role: 'fileMenu', submenu: [
      { label: 'New Chat', accelerator: 'Command+N', click: () => send('new-chat') },
      { label: 'Attach Files…', accelerator: 'Command+O', click: () => send('attach-files') },
      { type: 'separator' }, { role: 'close' }
    ] },
    { role: 'editMenu' },
    { label: 'Chat', submenu: [
      { label: 'Find Chat…', accelerator: 'Command+P', click: () => send('find-chat') },
      { label: 'Find in Current Chat…', accelerator: 'Command+F', click: () => send('find-in-current-chat') },
      { label: 'Next Chat', accelerator: 'Control+Tab', click: () => send('next-chat') },
      { label: 'Previous Chat', accelerator: 'Control+Shift+Tab', click: () => send('previous-chat') },
      { type: 'separator' },
      { label: 'Toggle Inspector', accelerator: 'Command+L', click: () => send('toggle-inspector') },
      { label: 'Jump to Latest', accelerator: 'Command+Down', click: () => send('jump-latest') }
    ] },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'AgentsDock Documentation', click: () => shell.openExternal('https://github.com/ZhengyiLuo/ZenithDock') }
    ] }
  ]))
}
