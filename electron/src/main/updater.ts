import { app, net } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppUpdateStatus, AppUpdateTrack } from '../shared/types'
import { appLog } from './logger'
import { newestCompatibleReleaseFromAtom, type CompatibleRelease } from './updater-feed.mjs'

const STARTUP_CHECK_DELAY_MS = 15_000
const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000
const MAC_INSTALL_SETTLE_MS = 8_000
const RELEASE_CHECK_TIMEOUT_MS = 15_000
const BETA_FEED_MAX_BYTES = 512 * 1024
const RELEASE_METADATA_MAX_BYTES = 64 * 1024
const RELEASES_URL = 'https://github.com/ZhengyiLuo/AgentsDock/releases'
const RELEASES_ATOM_URL = `${RELEASES_URL}.atom`
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const APP_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/
const CHECK_BLOCKING_STATES = new Set<AppUpdateStatus['state']>([
  'checking',
  'available',
  'downloading',
  'installing'
])
const TRACK_BLOCKING_STATES = new Set<AppUpdateStatus['state']>([
  ...CHECK_BLOCKING_STATES,
  'downloaded'
])

export interface AppUpdateLifecycle {
  beforeInstall?: () => void
  installFailed?: () => void
}

export interface AppUpdateTrackStore {
  read(): AppUpdateTrack
  write(track: AppUpdateTrack): void
}

export class AppUpdateManager {
  private value: AppUpdateStatus
  private startupTimer: NodeJS.Timeout | null = null
  private periodicTimer: NodeJS.Timeout | null = null
  private manualCheck = false
  private started = false
  private checkInFlight: Promise<void> | null = null
  private readyUpdateBeforeRefresh: AppUpdateStatus | null = null
  private checkErrorHandled = false
  private track: AppUpdateTrack = 'stable'
  private betaFeedOverridden = false
  private developmentChecksEnabled = false

  constructor(
    private readonly publish: (status: AppUpdateStatus) => void,
    private readonly lifecycle: AppUpdateLifecycle = {},
    private readonly trackStore: AppUpdateTrackStore = fileUpdateTrackStore()
  ) {
    this.value = initialStatus()
  }

  status(): AppUpdateStatus {
    return { ...this.value }
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.track = this.trackStore.read()

    if (!app.isPackaged) {
      this.developmentChecksEnabled = true
      this.set({
        state: 'idle',
        channel: 'development',
        track: this.track,
        message: 'Ready to check published releases. Local development builds do not self-update.'
      })
      return
    }
    if (existsSync(join(process.resourcesPath, 'disable-auto-update'))) {
      this.set({
        state: 'disabled',
        channel: 'development',
        track: this.track,
        message: 'This local build does not replace signed release builds.'
      })
      return
    }
    if (process.platform === 'linux' && !process.env.APPIMAGE) {
      this.set({
        state: 'disabled',
        channel: 'development',
        track: this.track,
        message: 'Portable Linux tarballs do not self-update. Install the AppImage to receive automatic updates.'
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
    // Installing only after an explicit user action avoids surprising an
    // operator who merely quit while long-running chats were active.
    autoUpdater.autoInstallOnAppQuit = false
    this.configureTrack()
    this.bindEvents()
    this.set({ state: 'idle', channel: 'direct', track: this.track, message: trackMessage(this.track) })

    this.startupTimer = setTimeout(() => void this.check(false), STARTUP_CHECK_DELAY_MS)
    this.periodicTimer = setInterval(() => void this.check(false), PERIODIC_CHECK_INTERVAL_MS)
  }

  async check(manual = true): Promise<AppUpdateStatus> {
    return this.performCheck(manual)
  }

  private async performCheck(manual: boolean): Promise<AppUpdateStatus> {
    if (this.value.channel === 'development') {
      return this.developmentChecksEnabled ? this.performDevelopmentCheck(manual) : this.status()
    }
    if (this.value.channel !== 'direct') return this.status()
    if (CHECK_BLOCKING_STATES.has(this.value.state)) return this.status()
    if (this.checkInFlight) {
      await this.checkInFlight
      return this.status()
    }
    if (this.value.state === 'downloaded') this.readyUpdateBeforeRefresh = this.status()
    this.manualCheck = manual
    this.checkErrorHandled = false
    this.set({
      state: 'checking',
      message: this.readyUpdateBeforeRefresh ? 'Checking for a newer update…' : 'Checking for updates…',
      progress: undefined
    })
    const updateCheck = this.track === 'beta'
      ? this.prepareBetaFeed().then(() => autoUpdater.checkForUpdates())
      : autoUpdater.checkForUpdates()
    this.checkInFlight = updateCheck
      .then(async result => {
        // electron-updater exposes auto-download completion as a nested
        // promise. Always consume it so download failures cannot become
        // unhandled rejections during startup, periodic, or manual checks.
        if (result?.downloadPromise) await result.downloadPromise
      })
      .catch(error => {
        if (!this.checkErrorHandled) this.fail(error)
      })
      .finally(() => {
        this.checkInFlight = null
        this.checkErrorHandled = false
        if (this.readyUpdateBeforeRefresh && this.value.state === 'checking') {
          this.restoreReadyUpdate('The downloaded update is still ready, but AgentsDock could not confirm whether a newer build exists.')
        }
      })
    await this.checkInFlight
    return this.status()
  }

  private async performDevelopmentCheck(manual: boolean): Promise<AppUpdateStatus> {
    if (this.checkInFlight) {
      await this.checkInFlight
      return this.status()
    }
    this.manualCheck = manual
    this.set({
      state: 'checking',
      availableVersion: undefined,
      progress: undefined,
      message: `Checking published ${this.track === 'beta' ? 'Beta' : 'Stable'} releases…`
    })
    this.checkInFlight = this.latestPublishedVersion()
      .then(latestVersion => {
        this.set({
          // package.json intentionally keeps a development manifest version;
          // it does not describe how recent the checked-out source is. Report
          // the published release as information instead of falsely claiming
          // that a local checkout is outdated (or can self-update).
          state: 'idle',
          availableVersion: latestVersion,
          message: `Latest published release on the ${this.track === 'beta' ? 'Beta' : 'Stable'} channel: ${latestVersion}. This local development build does not self-update; source freshness is determined by Git.`,
          checkedAt: now()
        })
        this.manualCheck = false
      })
      .catch(error => this.fail(error))
      .finally(() => {
        this.checkInFlight = null
      })
    await this.checkInFlight
    return this.status()
  }

  async setTrack(track: AppUpdateTrack): Promise<AppUpdateStatus> {
    if (track !== 'stable' && track !== 'beta') throw new Error('Unknown update channel.')
    if (this.value.channel !== 'direct' && this.value.channel !== 'development') return this.status()
    if (this.value.state === 'checking' || (this.value.channel === 'direct' && TRACK_BLOCKING_STATES.has(this.value.state))) {
      throw new Error('Wait for the current update operation to finish before changing channels.')
    }
    if (track === this.track) {
      return this.value.channel === 'development' && !this.developmentChecksEnabled
        ? this.status()
        : this.check(true)
    }

    this.trackStore.write(track)
    this.track = track
    if (this.value.channel === 'development') {
      if (!this.developmentChecksEnabled) {
        this.set({ track })
        return this.status()
      }
      this.set({ track, state: 'idle', availableVersion: undefined, checkedAt: undefined })
      return this.check(true)
    }
    this.configureTrack()
    this.set({
      state: 'idle',
      track,
      availableVersion: undefined,
      progress: undefined,
      downloadedAt: undefined,
      message: trackMessage(track)
    })
    return this.check(true)
  }

  async install(): Promise<boolean> {
    if (this.value.state !== 'downloaded') return false

    // A beta can be superseded after it has already been downloaded. Refresh
    // immediately before installation and await any replacement download so a
    // single restart always targets the newest release visible on the channel.
    await this.performCheck(true)
    if (this.value.state !== 'downloaded') return false

    appLog('updater', 'installing downloaded update', { version: this.value.availableVersion })
    this.set({
      state: 'installing',
      message: process.platform === 'darwin'
        ? `Preparing AgentsDock ${this.value.availableVersion ?? 'update'}…`
        : `Restarting into AgentsDock ${this.value.availableVersion ?? 'update'}…`
    })
    try {
      if (process.platform === 'darwin') {
        const downloadedAt = Date.parse(this.value.downloadedAt ?? '')
        const elapsed = Number.isFinite(downloadedAt) ? Math.max(0, Date.now() - downloadedAt) : 0
        const remaining = Math.max(0, MAC_INSTALL_SETTLE_MS - elapsed)
        if (remaining > 0) await delay(remaining)
        this.set({ message: `Restarting into AgentsDock ${this.value.availableVersion ?? 'update'}…` })
      }
      this.lifecycle.beforeInstall?.()
      autoUpdater.quitAndInstall(false, true)
      return true
    } catch (error) {
      this.lifecycle.installFailed?.()
      const message = error instanceof Error ? error.message : String(error)
      appLog('updater', 'could not install downloaded update', { message })
      this.set({
        state: 'downloaded',
        message: `The update is still downloaded, but AgentsDock could not restart: ${message}`
      })
      return false
    }
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
      // electron-updater may clear its pending cache while replacing a
      // download. Once replacement begins, the prior installer can no longer
      // be treated as a safe fallback if the new download fails.
      this.readyUpdateBeforeRefresh = null
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
      if (this.restoreReadyUpdate()) return
      this.set({
        state: 'not-available',
        availableVersion: undefined,
        progress: undefined,
        downloadedAt: undefined,
        message: this.track === 'beta' ? 'AgentsDock is up to date on the beta channel.' : 'AgentsDock is up to date.',
        checkedAt: now()
      })
      this.manualCheck = false
    })
    autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => {
      appLog('updater', 'update downloaded', { version: info.version })
      this.readyUpdateBeforeRefresh = null
      this.set({
        state: 'downloaded',
        availableVersion: info.version,
        progress: 100,
        message: `AgentsDock ${info.version} is ready to install.`,
        checkedAt: now(),
        downloadedAt: now()
      })
      this.manualCheck = false
    })
    autoUpdater.on('error', error => {
      this.checkErrorHandled = true
      this.fail(error)
    })
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    appLog('updater', 'update check failed', { message, manual: this.manualCheck })
    if (this.restoreReadyUpdate(`The downloaded update is still ready, but AgentsDock could not check for a newer build: ${message}`)) return
    this.set({
      state: 'error',
      message: this.manualCheck ? `Could not check for updates: ${message}` : 'Automatic update check will retry later.',
      progress: undefined,
      checkedAt: now()
    })
    this.manualCheck = false
  }

  private restoreReadyUpdate(message?: string): boolean {
    const ready = this.readyUpdateBeforeRefresh
    if (!ready) return false
    this.readyUpdateBeforeRefresh = null
    this.manualCheck = false
    this.set({
      ...ready,
      state: 'downloaded',
      message: message ?? `AgentsDock ${ready.availableVersion ?? 'update'} is ready to install.`,
      checkedAt: now()
    })
    return true
  }

  private configureTrack(): void {
    if (this.track === 'stable' && this.betaFeedOverridden) {
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'ZhengyiLuo',
        repo: 'AgentsDock'
      })
      this.betaFeedOverridden = false
    }
    autoUpdater.allowPrerelease = this.track === 'beta'
    autoUpdater.channel = this.track === 'beta' ? 'beta' : 'latest'
    // A prerelease can have a newer SemVer core than the current stable
    // release. Explicitly choosing Stable must still return the user to the
    // latest stable build; ordinary stable and beta checks never downgrade.
    autoUpdater.allowDowngrade = this.track === 'stable' && versionIsPrerelease(app.getVersion())
  }

  private async prepareBetaFeed(): Promise<void> {
    const release = await this.resolveNewestBetaCompatibleRelease()
    const channel = release.track === 'beta' ? 'beta' : 'latest'

    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `${RELEASES_URL}/download/v${release.version}`,
      channel
    })
    // GenericProvider gives this property precedence over the feed's channel.
    // Its setter also enables downgrades, which an ordinary Beta check must
    // never allow (including a stale/truncated feed after stable promotion).
    autoUpdater.channel = channel
    autoUpdater.allowDowngrade = false
    this.betaFeedOverridden = true
  }

  private async latestPublishedVersion(): Promise<string> {
    const betaRelease = this.track === 'beta' ? await this.resolveNewestBetaCompatibleRelease() : null
    const metadataURL = betaRelease
      ? `${RELEASES_URL}/download/v${betaRelease.version}/${updateMetadataName(betaRelease.track)}`
      : `${RELEASES_URL}/latest/download/${updateMetadataName('stable')}`
    const metadata = await fetchBoundedReleaseText(
      metadataURL,
      'text/yaml, text/plain',
      'GitHub update metadata',
      RELEASE_METADATA_MAX_BYTES
    )
    const version = versionFromUpdateMetadata(metadata)
    const validForTrack = this.track === 'beta'
      ? APP_VERSION_PATTERN.test(version)
      : STABLE_VERSION_PATTERN.test(version)
    if (!validForTrack || (betaRelease && version !== betaRelease.version)) {
      throw new Error(`GitHub returned invalid ${this.track === 'beta' ? 'Beta' : 'Stable'} update metadata.`)
    }
    return version
  }

  private async resolveNewestBetaCompatibleRelease(): Promise<CompatibleRelease> {
    const feed = await fetchBoundedReleaseText(
      RELEASES_ATOM_URL,
      'application/atom+xml, application/xml, text/xml',
      'GitHub beta feed',
      BETA_FEED_MAX_BYTES
    )
    const release = newestCompatibleReleaseFromAtom(feed)
    if (!release) throw new Error('No compatible AgentsDock release was found in the public release feed.')
    return release
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
    track: 'stable',
    currentVersion: app.getVersion(),
    message: 'Automatic updates are enabled.'
  }
}

function trackMessage(track: AppUpdateTrack): string {
  if (track === 'beta') return 'Beta updates are enabled. You may receive unfinished features.'
  return versionIsPrerelease(app.getVersion())
    ? 'Stable updates are enabled. The latest stable build will replace this beta.'
    : 'Stable updates are enabled.'
}

function versionIsPrerelease(version: string): boolean {
  return version.split('+', 1)[0].includes('-')
}

function updateMetadataName(track: AppUpdateTrack): string {
  const prefix = track === 'beta' ? 'beta' : 'latest'
  if (process.platform === 'darwin') return `${prefix}-mac.yml`
  if (process.platform === 'win32') return `${prefix}.yml`
  if (process.platform === 'linux') return `${prefix}-linux${process.arch === 'arm64' ? '-arm64' : ''}.yml`
  throw new Error(`App update checks are unavailable on ${process.platform}.`)
}

function versionFromUpdateMetadata(metadata: string): string {
  const line = metadata.split(/\r?\n/).find(candidate => candidate.startsWith('version:'))
  if (!line) throw new Error('GitHub update metadata did not include a version.')
  return unquoteMetadataScalar(line.slice('version:'.length))
}

function unquoteMetadataScalar(value: string): string {
  const raw = value.trim()
  const quoted = /^(?:'([^']+)'|"([^"]+)")$/.exec(raw)
  return quoted ? quoted[1] || quoted[2] : raw
}

export function defaultAppUpdateTrack(version: string): AppUpdateTrack {
  return versionIsPrerelease(version) ? 'beta' : 'stable'
}

function fileUpdateTrackStore(): AppUpdateTrackStore {
  const path = join(app.getPath('userData'), 'update-track')
  return {
    read: () => {
      try { return readFileSync(path, 'utf8').trim() === 'beta' ? 'beta' : 'stable' }
      catch { return defaultAppUpdateTrack(app.getVersion()) }
    },
    write: track => {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      writeFileSync(temporary, `${track}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, path)
    }
  }
}

function isMacAppStoreBuild(): boolean {
  return Boolean((process as NodeJS.Process & { mas?: boolean }).mas)
}

function now(): string {
  return new Date().toISOString()
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function fetchBoundedReleaseText(url: string, accept: string, label: string, maxBytes: number): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RELEASE_CHECK_TIMEOUT_MS)
  try {
    const response = await net.fetch(url, {
      cache: 'no-store',
      headers: { Accept: accept },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`)
    return await readBoundedUTF8(response, maxBytes, controller.signal, label)
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out.`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function readBoundedUTF8(response: Response, maxBytes: number, signal: AbortSignal, label = 'GitHub beta feed'): Promise<string> {
  const advertisedLength = response.headers.get('Content-Length')
  if (advertisedLength !== null) {
    const normalized = advertisedLength.trim()
    const length = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN
    if (!Number.isSafeInteger(length) || length < 0) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`${label} returned an invalid Content-Length header.`)
    }
    if (length > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`${label} exceeded the response size limit.`)
    }
  }
  if (!response.body) throw new Error(`${label} returned an empty response.`)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const abort = (): void => {
    rejectAbort(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) abort()
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      if (!value?.byteLength) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label} exceeded the response size limit.`)
      }
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', abort)
    if (signal.aborted) await reader.cancel(signal.reason).catch(() => undefined)
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} returned invalid UTF-8.`)
  }
}
