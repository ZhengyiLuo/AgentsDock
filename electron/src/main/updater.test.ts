import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface MockUpdateCheckResult {
  downloadPromise?: Promise<unknown> | null
}

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    allowPrerelease: true,
    channel: null as string | null,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn<() => Promise<MockUpdateCheckResult | null>>().mockResolvedValue(null),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return autoUpdater
    })
  }
  const netFetch = vi.fn<typeof fetch>()
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  return { autoUpdater, emit, listeners, netFetch, appVersion: '1.2.3', appIsPackaged: true }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return mocks.appIsPackaged },
    getVersion: () => mocks.appVersion
  },
  net: { fetch: mocks.netFetch }
}))
vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }))
vi.mock('./logger', () => ({ appLog: vi.fn() }))

import { AppUpdateManager, defaultAppUpdateTrack } from './updater'

describe('AppUpdateManager', () => {
  const originalPlatform = process.platform
  const originalAppImage = process.env.APPIMAGE
  const managers: AppUpdateManager[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.listeners.clear()
    mocks.autoUpdater.autoDownload = false
    mocks.autoUpdater.autoInstallOnAppQuit = true
    mocks.autoUpdater.allowDowngrade = true
    mocks.autoUpdater.allowPrerelease = true
    mocks.autoUpdater.channel = null
    mocks.autoUpdater.setFeedURL.mockReset()
    mocks.autoUpdater.checkForUpdates.mockReset().mockResolvedValue(null)
    mocks.netFetch.mockReset().mockResolvedValue(new Response(
      '<feed><entry><link href="https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.2.6-beta.1" /></entry></feed>',
      { status: 200 }
    ))
    mocks.autoUpdater.quitAndInstall.mockReset()
    mocks.appVersion = '1.2.3'
    mocks.appIsPackaged = true
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    process.env.APPIMAGE = '/tmp/AgentsDock.AppImage'
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/tmp/agentsdock-test-resources' })
    Object.defineProperty(process, 'mas', { configurable: true, value: false })
  })

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.stop()
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    if (originalAppImage === undefined) delete process.env.APPIMAGE
    else process.env.APPIMAGE = originalAppImage
    vi.useRealTimers()
  })

  const createManager = (lifecycle: ConstructorParameters<typeof AppUpdateManager>[1] = {}, track: 'stable' | 'beta' = 'stable') => {
    const manager = new AppUpdateManager(vi.fn(), lifecycle, {
      read: vi.fn(() => track),
      write: vi.fn()
    })
    managers.push(manager)
    manager.start()
    return manager
  }

  it('defaults fresh prerelease installs to the beta channel', () => {
    expect(defaultAppUpdateTrack('0.2.7-beta.6')).toBe('beta')
    expect(defaultAppUpdateTrack('0.2.6')).toBe('stable')
  })

  it('configures explicit direct updates without installing on ordinary quit', () => {
    const manager = createManager()

    expect(manager.status()).toMatchObject({ channel: 'direct', track: 'stable', state: 'idle', currentVersion: '1.2.3' })
    expect(mocks.autoUpdater.autoDownload).toBe(true)
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false)
    expect(mocks.autoUpdater.allowDowngrade).toBe(false)
    expect(mocks.autoUpdater.allowPrerelease).toBe(false)
    expect(mocks.autoUpdater.channel).toBe('latest')
  })

  it('configures beta updates while keeping downgrades disabled', () => {
    const manager = createManager({}, 'beta')

    expect(manager.status()).toMatchObject({ channel: 'direct', track: 'beta', state: 'idle' })
    expect(mocks.autoUpdater.allowPrerelease).toBe(true)
    expect(mocks.autoUpdater.channel).toBe('beta')
    expect(mocks.autoUpdater.allowDowngrade).toBe(false)
  })

  it('disables automatic updates for the manual Linux tarball distribution', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    delete process.env.APPIMAGE

    const manager = createManager({}, 'beta')

    expect(manager.status()).toMatchObject({ channel: 'development', state: 'disabled', track: 'beta' })
    expect(manager.status().message).toContain('Install the AppImage')
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('persists update channel choices without running the updater in development distributions', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    delete process.env.APPIMAGE
    const write = vi.fn()
    const manager = new AppUpdateManager(vi.fn(), {}, { read: () => 'stable', write })
    managers.push(manager)
    manager.start()

    await manager.setTrack('beta')

    expect(manager.status()).toMatchObject({ channel: 'development', state: 'disabled', track: 'beta' })
    expect(write).toHaveBeenCalledWith('beta')
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled()
  })

  it('checks the published stable metadata from an unpackaged build without downloading', async () => {
    mocks.appIsPackaged = false
    mocks.netFetch.mockResolvedValue(new Response(
      'version: 1.2.4\npath: AgentsDock-1.2.4-mac-universal.zip\n',
      { status: 200 }
    ))
    const manager = createManager()

    expect(manager.status()).toMatchObject({ channel: 'development', state: 'idle', track: 'stable' })
    await manager.check(true)

    expect(mocks.netFetch).toHaveBeenCalledWith(
      'https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/latest/download/latest-mac.yml',
      {
        cache: 'no-store',
        headers: { Accept: 'text/yaml, text/plain' },
        signal: expect.any(AbortSignal)
      }
    )
    expect(manager.status()).toMatchObject({
      channel: 'development',
      state: 'idle',
      track: 'stable',
      currentVersion: '1.2.3',
      availableVersion: '1.2.4',
      message: 'Latest published Stable release: 1.2.4. This local development build does not self-update; source freshness is determined by Git.'
    })
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled()
  })

  it('switches an unpackaged build to Beta and checks its published platform metadata', async () => {
    mocks.appIsPackaged = false
    mocks.netFetch.mockImplementation(async input => {
      const url = String(input)
      return new Response(url.endsWith('/releases.atom')
        ? '<feed><entry><link href="https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.2.6-beta.1" /></entry></feed>'
        : 'version: 1.2.6-beta.1\npath: AgentsDock-1.2.6-beta.1-mac-universal.zip\n', { status: 200 })
    })
    const write = vi.fn()
    const manager = new AppUpdateManager(vi.fn(), {}, { read: () => 'stable', write })
    managers.push(manager)
    manager.start()

    await manager.setTrack('beta')

    expect(write).toHaveBeenCalledWith('beta')
    expect(mocks.netFetch).toHaveBeenCalledTimes(2)
    expect(mocks.netFetch).toHaveBeenLastCalledWith(
      'https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/download/v1.2.6-beta.1/beta-mac.yml',
      {
        cache: 'no-store',
        headers: { Accept: 'text/yaml, text/plain' },
        signal: expect.any(AbortSignal)
      }
    )
    expect(manager.status()).toMatchObject({
      channel: 'development',
      state: 'idle',
      track: 'beta',
      availableVersion: '1.2.6-beta.1',
      message: 'Latest published Beta release: 1.2.6-beta.1. This local development build does not self-update; source freshness is determined by Git.'
    })
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled()
  })

  it('refreshes published release information without comparing it to local source freshness', async () => {
    mocks.appIsPackaged = false
    mocks.netFetch
      .mockResolvedValueOnce(new Response(
        'version: 1.2.4\npath: AgentsDock-1.2.4-mac-universal.zip\n',
        { status: 200 }
      ))
      .mockResolvedValueOnce(new Response(
        'version: 1.2.3\npath: AgentsDock-1.2.3-mac-universal.zip\n',
        { status: 200 }
      ))
    const manager = createManager()

    await manager.check(true)
    expect(manager.status().availableVersion).toBe('1.2.4')

    await manager.check(true)

    expect(manager.status()).toMatchObject({
      state: 'idle',
      availableVersion: '1.2.3',
      message: 'Latest published Stable release: 1.2.3. This local development build does not self-update; source freshness is determined by Git.'
    })
  })

  it('switches a stable install to beta and checks immediately', async () => {
    const write = vi.fn()
    const manager = new AppUpdateManager(vi.fn(), {}, { read: () => 'stable', write })
    managers.push(manager)
    manager.start()

    await manager.setTrack('beta')

    expect(write).toHaveBeenCalledWith('beta')
    expect(mocks.autoUpdater.allowPrerelease).toBe(true)
    expect(mocks.autoUpdater.channel).toBe('beta')
    expect(mocks.autoUpdater.allowDowngrade).toBe(false)
    expect(mocks.netFetch).toHaveBeenCalledWith(
      'https://github.com/ZhengyiLuo/AgentsDock-Releases/releases.atom',
      {
        cache: 'no-store',
        headers: { Accept: 'application/atom+xml, application/xml, text/xml' },
        signal: expect.any(AbortSignal)
      }
    )
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/download/v1.2.6-beta.1',
      channel: 'beta'
    })
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('selects the greatest compatible beta instead of the first Atom entry', async () => {
    mocks.netFetch.mockResolvedValue(new Response(
      '<feed>' +
      '<entry><link href="https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.2.6" /></entry>' +
      '<entry><link href="https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.3.0-beta.2" /></entry>' +
      '<entry><link href="https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.3.0-beta.11" /></entry>' +
      '</feed>',
      { status: 200 }
    ))
    const manager = createManager({}, 'beta')

    await manager.check(true)

    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'generic',
      url: 'https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/download/v1.3.0-beta.11'
    }))
    expect(mocks.autoUpdater.setFeedURL.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.autoUpdater.checkForUpdates.mock.invocationCallOrder[0])
  })

  it('reads a bounded UTF-8 Atom feed before checking the resolved beta channel', async () => {
    const feed = '<feed><title>Béta releases 🚀</title>' +
      '<entry><link href="https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.2.7-beta.4" /></entry></feed>'
    mocks.netFetch.mockResolvedValue(new Response(feed, {
      status: 200,
      headers: { 'Content-Length': String(Buffer.byteLength(feed, 'utf8')) }
    }))
    const manager = createManager({}, 'beta')

    await manager.check(true)

    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/download/v1.2.7-beta.4'
    }))
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('rejects and cancels an Atom feed whose declared length exceeds the cap', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    mocks.netFetch.mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'Content-Length': String(512 * 1024 + 1) }
    }))
    const manager = createManager({}, 'beta')

    await expect(manager.check(true)).resolves.toMatchObject({ state: 'error' })

    expect(manager.status().message).toContain('response size limit')
    expect(cancel).toHaveBeenCalledOnce()
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('rejects and cancels a chunked Atom feed when streamed bytes exceed the cap', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(512 * 1024))
        controller.enqueue(new Uint8Array(1))
      },
      cancel
    })
    mocks.netFetch.mockResolvedValue(new Response(body, { status: 200 }))
    const manager = createManager({}, 'beta')

    await expect(manager.check(true)).resolves.toMatchObject({ state: 'error' })

    expect(manager.status().message).toContain('response size limit')
    expect(cancel).toHaveBeenCalledOnce()
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('leaves stable discovery on the GitHub latest-release provider', async () => {
    const manager = createManager()

    await manager.check(true)

    expect(mocks.netFetch).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('restores the GitHub provider after leaving a resolved beta feed', async () => {
    const write = vi.fn()
    const manager = new AppUpdateManager(vi.fn(), {}, { read: () => 'beta', write })
    managers.push(manager)
    manager.start()
    await manager.check(true)
    mocks.emit('update-not-available', { version: '1.2.3' })
    mocks.autoUpdater.setFeedURL.mockClear()
    mocks.autoUpdater.checkForUpdates.mockClear()

    await manager.setTrack('stable')

    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'ZhengyiLuo',
      repo: 'AgentsDock-Releases'
    })
    expect(mocks.netFetch).toHaveBeenCalledOnce()
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('allows an explicit beta-to-stable downgrade to the latest stable build', async () => {
    mocks.appVersion = '1.3.0-beta.5'
    const write = vi.fn()
    const publish = vi.fn()
    const manager = new AppUpdateManager(publish, {}, { read: () => 'beta', write })
    managers.push(manager)
    manager.start()

    expect(mocks.autoUpdater.allowDowngrade).toBe(false)
    await manager.setTrack('stable')

    expect(write).toHaveBeenCalledWith('stable')
    expect(mocks.autoUpdater.allowPrerelease).toBe(false)
    expect(mocks.autoUpdater.channel).toBe('latest')
    expect(mocks.autoUpdater.allowDowngrade).toBe(true)
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      track: 'stable',
      message: expect.stringContaining('latest stable build will replace this beta')
    }))
  })

  it('restores beta-to-stable downgrade permission after restarting before installation', () => {
    mocks.appVersion = '1.3.0-beta.5'
    const manager = createManager({}, 'stable')

    expect(manager.status()).toMatchObject({ channel: 'direct', track: 'stable' })
    expect(mocks.autoUpdater.allowDowngrade).toBe(true)
  })

  it('rejects unknown tracks and channel changes while an update is ready', async () => {
    const manager = createManager()

    await expect(manager.setTrack('nightly' as 'beta')).rejects.toThrow('Unknown update channel')
    mocks.emit('update-downloaded', { version: '1.2.4' })
    await expect(manager.setTrack('beta')).rejects.toThrow('current update operation')
    expect(mocks.autoUpdater.channel).toBe('latest')
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

  it('times out a stalled beta feed and allows a later check', async () => {
    mocks.netFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const manager = createManager({}, 'beta')

    const check = manager.check(true)
    await vi.advanceTimersByTimeAsync(15_000)

    await expect(check).resolves.toMatchObject({ state: 'error' })
    expect(manager.status().message).toContain('timed out')

    mocks.netFetch.mockResolvedValue(new Response(
      '<feed><entry><link href="https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.2.6-beta.1" /></entry></feed>',
      { status: 200 }
    ))
    mocks.autoUpdater.checkForUpdates.mockResolvedValue(null)
    await manager.check(true)
    expect(mocks.netFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the beta-feed deadline active while a response body stalls', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    mocks.netFetch.mockResolvedValue(new Response(body, { status: 200 }))
    const manager = createManager({}, 'beta')

    const check = manager.check(true)
    await vi.advanceTimersByTimeAsync(15_000)

    await expect(check).resolves.toMatchObject({ state: 'error' })
    expect(manager.status().message).toContain('timed out')
    expect(cancel).toHaveBeenCalledOnce()
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('replaces a ready beta with the newest beta on a later check', async () => {
    const manager = createManager({}, 'beta')
    mocks.emit('update-downloaded', { version: '1.2.4' })
    mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
      mocks.emit('update-available', { version: '1.2.6' })
      mocks.emit('update-downloaded', { version: '1.2.6' })
      return null
    })

    expect(manager.status()).toMatchObject({ state: 'downloaded', availableVersion: '1.2.4', progress: 100 })
    await manager.check(true)
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    expect(manager.status()).toMatchObject({ state: 'downloaded', availableVersion: '1.2.6', progress: 100 })
  })

  it('preserves a ready update when its freshness check fails', async () => {
    const manager = createManager({}, 'beta')
    mocks.emit('update-downloaded', { version: '1.2.4' })
    mocks.autoUpdater.checkForUpdates.mockRejectedValue(new Error('offline'))

    await manager.check(true)

    expect(manager.status()).toMatchObject({ state: 'downloaded', availableVersion: '1.2.4', progress: 100 })
    expect(manager.status().message).toContain('still ready')
    expect(manager.status().message).toContain('offline')
  })

  it('consumes a failed auto-download during a regular update check', async () => {
    const manager = createManager({}, 'beta')
    mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
      mocks.emit('update-available', { version: '1.2.6' })
      return { downloadPromise: Promise.reject(new Error('automatic download failed')) }
    })

    await expect(manager.check(false)).resolves.toMatchObject({
      state: 'error',
      availableVersion: '1.2.6'
    })
    expect(manager.status().message).toBe('Automatic update check will retry later.')
  })

  it('does not install a stale beta after its replacement download fails', async () => {
    const manager = createManager({}, 'beta')
    mocks.emit('update-downloaded', { version: '1.2.4' })
    mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
      mocks.emit('update-available', { version: '1.2.6' })
      return { downloadPromise: Promise.reject(new Error('replacement download failed')) }
    })

    await expect(manager.install()).resolves.toBe(false)

    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(manager.status()).toMatchObject({ state: 'error', availableVersion: '1.2.6' })
    expect(manager.status().message).toContain('replacement download failed')
  })

  it('revalidates, replaces, and settles a macOS update before installing once', async () => {
    const beforeInstall = vi.fn()
    const installFailed = vi.fn()
    const manager = createManager({ beforeInstall, installFailed }, 'beta')
    mocks.emit('update-downloaded', { version: '1.2.4' })
    mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
      mocks.emit('update-available', { version: '1.2.6' })
      const downloadPromise = Promise.resolve().then(() => {
        mocks.emit('update-downloaded', { version: '1.2.6' })
      })
      return { downloadPromise }
    })

    const installation = manager.install()
    await vi.advanceTimersByTimeAsync(7_999)
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await expect(installation).resolves.toBe(true)
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(installFailed).not.toHaveBeenCalled()
    expect(manager.status()).toMatchObject({ state: 'installing', availableVersion: '1.2.6' })
  })

  it('restores the service when restart fails synchronously', async () => {
    const beforeInstall = vi.fn()
    const installFailed = vi.fn()
    mocks.autoUpdater.quitAndInstall.mockImplementation(() => { throw new Error('restart denied') })
    const manager = createManager({ beforeInstall, installFailed })
    mocks.emit('update-downloaded', { version: '1.2.4' })

    const installation = manager.install()
    await vi.advanceTimersByTimeAsync(8_000)

    await expect(installation).resolves.toBe(false)
    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(installFailed).toHaveBeenCalledOnce()
    expect(manager.status()).toMatchObject({ state: 'downloaded', availableVersion: '1.2.4' })
    expect(manager.status().message).toContain('restart denied')
  })
})
