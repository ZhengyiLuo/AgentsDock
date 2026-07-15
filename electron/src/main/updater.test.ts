import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    allowPrerelease: true,
    checkForUpdates: vi.fn<() => Promise<unknown>>().mockResolvedValue(null),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return autoUpdater
    })
  }
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  return { autoUpdater, emit, listeners }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.2.3'
  }
}))
vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }))
vi.mock('./logger', () => ({ appLog: vi.fn() }))

import { AppUpdateManager } from './updater'

describe('AppUpdateManager', () => {
  const managers: AppUpdateManager[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.listeners.clear()
    mocks.autoUpdater.autoDownload = false
    mocks.autoUpdater.autoInstallOnAppQuit = true
    mocks.autoUpdater.allowDowngrade = true
    mocks.autoUpdater.allowPrerelease = true
    mocks.autoUpdater.checkForUpdates.mockReset().mockResolvedValue(null)
    mocks.autoUpdater.quitAndInstall.mockReset()
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/tmp/agentsdock-test-resources' })
    Object.defineProperty(process, 'mas', { configurable: true, value: false })
  })

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.stop()
    vi.useRealTimers()
  })

  const createManager = (lifecycle: ConstructorParameters<typeof AppUpdateManager>[1] = {}) => {
    const manager = new AppUpdateManager(vi.fn(), lifecycle)
    managers.push(manager)
    manager.start()
    return manager
  }

  it('configures explicit direct updates without installing on ordinary quit', () => {
    const manager = createManager()

    expect(manager.status()).toMatchObject({ channel: 'direct', state: 'idle', currentVersion: '1.2.3' })
    expect(mocks.autoUpdater.autoDownload).toBe(true)
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false)
    expect(mocks.autoUpdater.allowDowngrade).toBe(false)
    expect(mocks.autoUpdater.allowPrerelease).toBe(false)
  })

  it('suppresses overlapping checks', async () => {
    let finish: (() => void) | undefined
    mocks.autoUpdater.checkForUpdates.mockImplementation(() => new Promise(resolve => { finish = () => resolve(null) }))
    const manager = createManager()

    const first = manager.check(true)
    const second = manager.check(true)
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    finish?.()
    await Promise.all([first, second])
  })

  it('does not replace a ready update with a later check', async () => {
    const manager = createManager()
    mocks.emit('update-downloaded', { version: '1.2.4' })

    expect(manager.status()).toMatchObject({ state: 'downloaded', availableVersion: '1.2.4', progress: 100 })
    await manager.check(true)
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(manager.status().state).toBe('downloaded')
  })

  it('stops the service before explicitly installing', () => {
    const beforeInstall = vi.fn()
    const installFailed = vi.fn()
    const manager = createManager({ beforeInstall, installFailed })
    mocks.emit('update-downloaded', { version: '1.2.4' })

    expect(manager.install()).toBe(true)
    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(installFailed).not.toHaveBeenCalled()
    expect(manager.status().state).toBe('installing')
  })

  it('restores the service when restart fails synchronously', () => {
    const beforeInstall = vi.fn()
    const installFailed = vi.fn()
    mocks.autoUpdater.quitAndInstall.mockImplementation(() => { throw new Error('restart denied') })
    const manager = createManager({ beforeInstall, installFailed })
    mocks.emit('update-downloaded', { version: '1.2.4' })

    expect(manager.install()).toBe(false)
    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(installFailed).toHaveBeenCalledOnce()
    expect(manager.status()).toMatchObject({ state: 'downloaded', availableVersion: '1.2.4' })
    expect(manager.status().message).toContain('restart denied')
  })
})
