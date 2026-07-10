import { app } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppUpdateStatus } from '../shared/types'
import { appLog } from './logger'

const STARTUP_CHECK_DELAY_MS = 15_000
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000

export class AppUpdateManager {
  private value: AppUpdateStatus
  private startupTimer: NodeJS.Timeout | null = null
  private periodicTimer: NodeJS.Timeout | null = null
  private manualCheck = false
  private started = false

  constructor(private readonly publish: (status: AppUpdateStatus) => void) {
    this.value = initialStatus()
  }

  status(): AppUpdateStatus {
    return { ...this.value }
  }

  start(): void {
    if (this.started) return
    this.started = true

    if (!app.isPackaged) {
      this.set({
        state: 'disabled',
        channel: 'development',
        message: 'Updates are checked by packaged builds.'
      })
      return
    }
    if (existsSync(join(process.resourcesPath, 'disable-auto-update'))) {
      this.set({
        state: 'disabled',
        channel: 'development',
        message: 'This local build does not replace signed release builds.'
      })
      return
    }
    if (isMacAppStoreBuild()) {
      this.set({
        state: 'disabled',
        channel: 'app-store',
        message: 'Updates are delivered by TestFlight or the Mac App Store.'
      })
      return
    }

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowDowngrade = false
    autoUpdater.allowPrerelease = false
    this.bindEvents()
    this.set({ state: 'idle', channel: 'direct', message: 'Automatic updates are enabled.' })

    this.startupTimer = setTimeout(() => void this.check(false), STARTUP_CHECK_DELAY_MS)
    this.periodicTimer = setInterval(() => void this.check(false), PERIODIC_CHECK_INTERVAL_MS)
  }

  async check(manual = true): Promise<AppUpdateStatus> {
    if (this.value.channel !== 'direct') return this.status()
    if (this.value.state === 'checking' || this.value.state === 'downloading') return this.status()
    this.manualCheck = manual
    this.set({ state: 'checking', message: 'Checking for updates…', progress: undefined })
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.fail(error)
    }
    return this.status()
  }

  install(): boolean {
    if (this.value.state !== 'downloaded') return false
    appLog('updater', 'installing downloaded update', { version: this.value.availableVersion })
    autoUpdater.quitAndInstall(false, true)
    return true
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.periodicTimer) clearInterval(this.periodicTimer)
    this.startupTimer = null
    this.periodicTimer = null
  }

  private bindEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      appLog('updater', 'checking for update')
      this.set({ state: 'checking', message: 'Checking for updates…', checkedAt: now() })
    })
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      appLog('updater', 'update available', { version: info.version })
      this.set({
        state: 'available',
        availableVersion: info.version,
        message: `AgentsDock ${info.version} is available. Downloading…`,
        checkedAt: now()
      })
    })
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.set({
        state: 'downloading',
        progress: Math.max(0, Math.min(100, progress.percent)),
        message: `Downloading AgentsDock ${this.value.availableVersion ?? 'update'}…`
      })
    })
    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      appLog('updater', 'app is current', { version: info.version })
      this.set({
        state: 'not-available',
        availableVersion: undefined,
        progress: undefined,
        message: 'AgentsDock is up to date.',
        checkedAt: now()
      })
      this.manualCheck = false
    })
    autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => {
      appLog('updater', 'update downloaded', { version: info.version })
      this.set({
        state: 'downloaded',
        availableVersion: info.version,
        progress: 100,
        message: `AgentsDock ${info.version} is ready to install.`,
        checkedAt: now()
      })
      this.manualCheck = false
    })
    autoUpdater.on('error', error => this.fail(error))
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    appLog('updater', 'update check failed', { message, manual: this.manualCheck })
    this.set({
      state: 'error',
      message: this.manualCheck ? `Could not check for updates: ${message}` : 'Automatic update check will retry later.',
      progress: undefined,
      checkedAt: now()
    })
    this.manualCheck = false
  }

  private set(patch: Partial<AppUpdateStatus>): void {
    this.value = { ...this.value, ...patch }
    this.publish(this.status())
  }
}

function initialStatus(): AppUpdateStatus {
  return {
    state: 'idle',
    channel: 'direct',
    currentVersion: app.getVersion(),
    message: 'Automatic updates are enabled.'
  }
}

function isMacAppStoreBuild(): boolean {
  return Boolean((process as NodeJS.Process & { mas?: boolean }).mas)
}

function now(): string {
  return new Date().toISOString()
}
