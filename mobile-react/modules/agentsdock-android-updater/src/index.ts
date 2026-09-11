import { requireOptionalNativeModule } from 'expo-modules-core'

export interface AndroidUpdaterNativeState {
  available: boolean
  canRequestPackageInstalls: boolean
  packageName: string
  versionCode: number
  versionName: string
  signerSha256: string
}

export interface AndroidInstallRequest {
  fileUri: string
  sha256: string
  sizeBytes: number
  versionCode: number
}

export interface AndroidInstallResult {
  permissionRequired: boolean
  sessionId: number | null
  versionCode: number
  sha256: string
}

interface AndroidUpdaterNativeModule {
  getStateAsync(): Promise<AndroidUpdaterNativeState>
  openInstallPermissionSettingsAsync(): Promise<boolean>
  installPackageAsync(request: AndroidInstallRequest): Promise<AndroidInstallResult>
}

const nativeModule = requireOptionalNativeModule<AndroidUpdaterNativeModule>('AgentsDockAndroidUpdater')

export function androidUpdaterNativeAvailable(): boolean {
  return nativeModule != null
}

export async function getAndroidUpdaterStateAsync(): Promise<AndroidUpdaterNativeState> {
  if (!nativeModule) throw new Error('Android updater native module is unavailable')
  return nativeModule.getStateAsync()
}

export async function openAndroidInstallPermissionSettingsAsync(): Promise<boolean> {
  if (!nativeModule) throw new Error('Android updater native module is unavailable')
  return nativeModule.openInstallPermissionSettingsAsync()
}

export async function installAndroidPackageAsync(request: AndroidInstallRequest): Promise<AndroidInstallResult> {
  if (!nativeModule) throw new Error('Android updater native module is unavailable')
  return nativeModule.installPackageAsync(request)
}
