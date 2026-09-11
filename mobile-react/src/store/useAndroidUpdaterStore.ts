import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import { create } from 'zustand'
import {
  androidUpdaterNativeAvailable,
  getAndroidUpdaterStateAsync,
  installAndroidPackageAsync,
  openAndroidInstallPermissionSettingsAsync,
  type AndroidUpdaterNativeState,
} from 'agentsdock-android-updater'
import {
  ANDROID_RELEASES_API_URL,
  ANDROID_UPDATE_CHECK_INTERVAL_MS,
  cachedAndroidUpdate,
  latestAndroidUpdate,
  updateDownloadPercent,
  type AvailableAndroidUpdate,
} from '../lib/android-update'

type AndroidUpdateChannel = 'unknown' | 'sideload' | 'play' | 'unavailable'
type AndroidUpdateStage = 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'verifying' | 'permission' | 'installer' | 'error'

interface AndroidUpdaterState {
  channel: AndroidUpdateChannel
  stage: AndroidUpdateStage
  nativeState: AndroidUpdaterNativeState | null
  update: AvailableAndroidUpdate | null
  downloadPercent: number
  dismissedVersionCode: number | null
  error: string | null
  check(force?: boolean): Promise<void>
  install(): Promise<void>
  resumeAfterPermission(reopenSettings?: boolean): Promise<void>
  dismissBanner(): Promise<void>
}

interface PersistedUpdaterState {
  checkedAt: number
  update: AvailableAndroidUpdate | null
  dismissedVersionCode: number | null
}

interface PendingPackage {
  update: AvailableAndroidUpdate
  fileUri: string
}

const CACHE_KEY = 'agentsdock.android-updater.v1'
const DOWNLOAD_DIRECTORY = 'agentsdock-android-updates'
const NETWORK_TIMEOUT_MS = 15_000
let checkInFlight: Promise<void> | null = null
let installInFlight: Promise<void> | null = null
let pendingPackage: PendingPackage | null = null
let persistedLoaded = false
let persistedState: PersistedUpdaterState = { checkedAt: 0, update: null, dismissedVersionCode: null }

export const useAndroidUpdaterStore = create<AndroidUpdaterState>((set, get) => ({
  channel: 'unknown',
  stage: 'idle',
  nativeState: null,
  update: null,
  downloadPercent: 0,
  dismissedVersionCode: null,
  error: null,

  async check(force = false) {
    if (checkInFlight) return checkInFlight
    checkInFlight = (async () => {
      if (Platform.OS !== 'android' || !androidUpdaterNativeAvailable()) {
        set({ channel: 'unavailable', stage: 'idle', update: null })
        return
      }
      const nativeState = await getAndroidUpdaterStateAsync()
      if (!nativeState.available) {
        set({ channel: 'play', stage: 'up-to-date', nativeState, update: null, error: null })
        return
      }
      await loadPersistedState()
      set({
        channel: 'sideload',
        nativeState,
        dismissedVersionCode: persistedState.dismissedVersionCode,
      })
      const now = Date.now()
      const cached = persistedState.update && persistedState.update.versionCode > nativeState.versionCode
        ? persistedState.update
        : null
      if (!force && persistedState.checkedAt <= now && now - persistedState.checkedAt < ANDROID_UPDATE_CHECK_INTERVAL_MS) {
        set({ stage: cached ? 'available' : 'up-to-date', update: cached, error: null })
        return
      }
      set({ stage: 'checking', error: null })
      try {
        const releases = await fetchJson(ANDROID_RELEASES_API_URL, 2_000_000)
        const update = await latestAndroidUpdate(
          releases,
          nativeState.versionCode,
          url => fetchJson(url, 64_000),
        )
        persistedState = {
          checkedAt: now,
          update,
          dismissedVersionCode: persistedState.dismissedVersionCode,
        }
        await persistUpdaterState().catch(() => undefined)
        set({ stage: update ? 'available' : 'up-to-date', update, error: null })
      } catch (error) {
        persistedState = {
          checkedAt: now,
          update: cached,
          dismissedVersionCode: persistedState.dismissedVersionCode,
        }
        await persistUpdaterState().catch(() => undefined)
        set({
          stage: force ? 'error' : cached ? 'available' : 'idle',
          update: cached,
          error: force ? readableError(error) : null,
        })
      }
    })().finally(() => { checkInFlight = null })
    return checkInFlight
  },

  async install() {
    if (installInFlight) return installInFlight
    installInFlight = (async () => {
      const update = get().update
      if (!update || get().channel !== 'sideload') return
      set({ stage: 'downloading', downloadPercent: 0, error: null })
      try {
        const cacheRoot = FileSystem.cacheDirectory
        if (!cacheRoot) throw new Error('Android update cache is unavailable')
        const directory = `${cacheRoot}${DOWNLOAD_DIRECTORY}`
        const fileUri = `${directory}/${update.apk.assetName}`
        await FileSystem.makeDirectoryAsync(directory, { intermediates: true })
        await FileSystem.deleteAsync(fileUri, { idempotent: true })
        const download = FileSystem.createDownloadResumable(
          update.downloadUrl,
          fileUri,
          { headers: { Accept: 'application/octet-stream' } },
          progress => {
            if (get().update?.versionCode !== update.versionCode) return
            set({ downloadPercent: updateDownloadPercent(progress.totalBytesWritten, update.apk.sizeBytes) })
          },
        )
        const result = await download.downloadAsync()
        if (!result || result.status < 200 || result.status >= 300) {
          throw new Error(`GitHub returned ${result?.status ?? 'no response'} while downloading the APK`)
        }
        pendingPackage = { update, fileUri: result.uri }
        set({ stage: 'verifying', downloadPercent: 100 })
        await stagePendingPackage(set)
      } catch (error) {
        pendingPackage = null
        set({ stage: 'error', error: readableError(error) })
      }
    })().finally(() => { installInFlight = null })
    return installInFlight
  },

  async resumeAfterPermission(reopenSettings = false) {
    if (!pendingPackage || get().stage !== 'permission' || installInFlight) return
    installInFlight = (async () => {
      try {
        const nativeState = await getAndroidUpdaterStateAsync()
        set({ nativeState })
        if (!nativeState.canRequestPackageInstalls) {
          if (reopenSettings) await openAndroidInstallPermissionSettingsAsync()
          return
        }
        set({ stage: 'verifying', error: null })
        await stagePendingPackage(set)
      } catch (error) {
        set({ stage: 'error', error: readableError(error) })
      }
    })().finally(() => { installInFlight = null })
    return installInFlight
  },

  async dismissBanner() {
    const versionCode = get().update?.versionCode ?? null
    set({ dismissedVersionCode: versionCode })
    await loadPersistedState()
    persistedState = { ...persistedState, dismissedVersionCode: versionCode }
    await persistUpdaterState().catch(() => undefined)
  },
}))

async function stagePendingPackage(set: (patch: Partial<AndroidUpdaterState>) => void): Promise<void> {
  const pending = pendingPackage
  if (!pending) throw new Error('The verified Android update is no longer available')
  const result = await installAndroidPackageAsync({
    fileUri: pending.fileUri,
    sha256: pending.update.apk.sha256,
    sizeBytes: pending.update.apk.sizeBytes,
    versionCode: pending.update.versionCode,
  })
  if (result.permissionRequired) {
    set({ stage: 'permission', error: null })
    await openAndroidInstallPermissionSettingsAsync()
    return
  }
  pendingPackage = null
  set({ stage: 'installer', error: null })
}

async function loadPersistedState(): Promise<void> {
  if (persistedLoaded) return
  persistedLoaded = true
  try {
    const value = JSON.parse(await AsyncStorage.getItem(CACHE_KEY) ?? 'null') as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const candidate = value as Record<string, unknown>
    persistedState = {
      checkedAt: typeof candidate.checkedAt === 'number' && Number.isFinite(candidate.checkedAt) ? candidate.checkedAt : 0,
      update: cachedAndroidUpdate(candidate.update),
      dismissedVersionCode: Number.isSafeInteger(candidate.dismissedVersionCode) ? candidate.dismissedVersionCode as number : null,
    }
  } catch {
    persistedState = { checkedAt: 0, update: null, dismissedVersionCode: null }
  }
}

async function persistUpdaterState(): Promise<void> {
  await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(persistedState))
}

async function fetchJson(url: string, maximumBytes: number): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`GitHub update check failed with HTTP ${response.status}`)
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > maximumBytes) throw new Error('GitHub update response is unexpectedly large')
    const text = await response.text()
    if (text.length > maximumBytes) throw new Error('GitHub update response is unexpectedly large')
    return JSON.parse(text) as unknown
  } finally {
    clearTimeout(timeout)
  }
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'The GitHub update check timed out.'
  return error instanceof Error ? error.message : String(error)
}
