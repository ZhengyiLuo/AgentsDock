import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const ADHOC_ISOLATION_MARKER = 'adhoc-isolated-user-data'
export const ADHOC_ISOLATED_USER_DATA_DIRECTORY = 'agentsdock-electron-local-adhoc'

export function resolveUserDataPath(
  appDataPath: string,
  resourcesPath: string,
  packaged: boolean,
  requestedPath: string | undefined,
  pathExists: (path: string) => boolean = existsSync
): string {
  if (packaged && pathExists(join(resourcesPath, ADHOC_ISOLATION_MARKER))) {
    // A marked ad-hoc bundle must not be able to opt back into production
    // credentials through an inherited environment variable.
    return join(appDataPath, ADHOC_ISOLATED_USER_DATA_DIRECTORY)
  }
  return requestedPath?.trim() || join(appDataPath, 'agentsdock-electron')
}
