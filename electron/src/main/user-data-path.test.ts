import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ADHOC_ISOLATION_MARKER,
  resolveUserDataPath
} from './user-data-path'

describe('Electron user-data path', () => {
  it('keeps ordinary packaged builds on canonical app data', () => {
    const appDataPath = '/Users/test/Library/Application Support'
    expect(resolveUserDataPath(appDataPath, '/Applications/AgentsDock.app/Contents/Resources', true, undefined, () => false))
      .toBe(join(appDataPath, 'agentsdock-electron'))
  })

  it('preserves an explicit test path for unmarked builds', () => {
    expect(resolveUserDataPath('/app-data', '/resources', true, ' /tmp/agentsdock-test ', () => false))
      .toBe('/tmp/agentsdock-test')
  })

  it('forces marked ad-hoc builds away from production data and ignores an unsafe override', () => {
    const appDataPath = '/app-data'
    const resourcesPath = '/resources'
    const markerPath = join(resourcesPath, ADHOC_ISOLATION_MARKER)
    const exists = vi.fn((path: string) => path === markerPath)
    expect(resolveUserDataPath(appDataPath, resourcesPath, true, '/app-data/agentsdock-electron', exists))
      .toBe(join(appDataPath, 'agentsdock-electron-local-adhoc'))
    expect(exists).toHaveBeenCalledWith(markerPath)
  })
})
