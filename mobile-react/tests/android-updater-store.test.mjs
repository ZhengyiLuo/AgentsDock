import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

test('update discovery, download, permission, retry and concurrent checks preserve the install flow', async () => {
  await mkdir(resolve('build/tmp'), { recursive: true })
  const directory = await mkdtemp(resolve('build/tmp/android-updater-test-'))
  const outfile = join(directory, 'test.mjs')
  const originalFetch = globalThis.fetch
  const boundary = {
    nativeError: null,
    downloadError: null,
    downloads: 0,
    installs: [],
    permissionOpens: 0,
    allowInstall: false,
    releaseDownload: null,
    state: { available: true, versionCode: 10, canRequestPackageInstalls: false },
    async getState() {
      if (this.nativeError) throw this.nativeError
      return { ...this.state, canRequestPackageInstalls: this.allowInstall }
    },
    async download(uri, progress) {
      this.downloads++
      progress({ totalBytesWritten: 50 })
      if (this.downloadError) throw this.downloadError
      if (this.releaseDownload) await this.releaseDownload
      return { uri, status: 200 }
    },
  }
  globalThis.__androidUpdaterTest = boundary
  const nativeModule = `
    const b = globalThis.__androidUpdaterTest;
    export const androidUpdaterNativeAvailable = () => true;
    export const getAndroidUpdaterStateAsync = () => b.getState();
    export const openAndroidInstallPermissionSettingsAsync = async () => { b.permissionOpens++; };
    export const installAndroidPackageAsync = async request => {
      b.installs.push(request);
      return { permissionRequired: !b.allowInstall };
    };
  `
  const fileModule = `
    const b = globalThis.__androidUpdaterTest;
    export const cacheDirectory = 'file:///private/cache/';
    export const makeDirectoryAsync = async () => {};
    export const deleteAsync = async () => {};
    export const createDownloadResumable = (url, uri, options, progress) => ({
      downloadAsync: () => b.download(uri, progress)
    });
  `
  try {
    await build({
      stdin: {
        contents: "export { useAndroidUpdaterStore } from './src/store/useAndroidUpdaterStore'; export * from './src/lib/android-update';",
        resolveDir: process.cwd(), loader: 'ts',
      },
      outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
      plugins: [{ name: 'updater-native-boundaries', setup(context) {
        const modules = new Map([
          ['react-native', "export const Platform = { OS: 'android' };"],
          ['agentsdock-android-updater', nativeModule],
          ['expo-file-system/legacy', fileModule],
        ])
        context.onResolve({ filter: /.*/ }, args => {
          if (modules.has(args.path)) return { path: args.path, namespace: 'boundary' }
          if (args.path === 'zustand') return { path: resolve('tests/mocks/zustand.ts') }
          if (args.path === '@react-native-async-storage/async-storage') return { path: resolve('tests/mocks/async-storage.ts') }
        })
        context.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: modules.get(args.path) }))
      } }],
    })
    const module = await import(pathToFileURL(outfile).href)
    const store = module.useAndroidUpdaterStore
    const state = () => store.getState()
    const manifest = {
      schemaVersion: 1, channel: 'beta', tagName: 'android-v0.1.1-beta.9',
      packageName: module.ANDROID_UPDATE_PACKAGE, versionName: '0.1.1', versionCode: 11,
      publishedAt: '2026-10-27T00:00:00Z', signingCertificateSha256: module.ANDROID_UPDATE_SIGNER_SHA256,
      apk: { assetName: 'AgentsDock.apk', sizeBytes: 100, sha256: 'a'.repeat(64) },
    }
    const base = `https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/download/${manifest.tagName}/`
    const release = {
      tag_name: manifest.tagName, draft: false, prerelease: true, published_at: manifest.publishedAt,
      html_url: `https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/${manifest.tagName}`,
      assets: [
        { name: module.ANDROID_UPDATE_MANIFEST_ASSET, size: 500, digest: null, browser_download_url: base + module.ANDROID_UPDATE_MANIFEST_ASSET },
        { name: manifest.apk.assetName, size: 100, digest: `sha256:${manifest.apk.sha256}`, browser_download_url: base + manifest.apk.assetName },
      ],
    }
    let requests = 0
    let failure = null
    globalThis.fetch = async url => {
      requests++
      if (failure === 'list' || (failure === 'manifest' && url.includes('/download/'))) throw new Error('Offline')
      return new Response(JSON.stringify(url.includes('/download/') ? manifest : [release]))
    }
    boundary.nativeError = new Error('Native state unavailable')
    await state().check(true)
    assert.equal(state().stage, 'error')
    boundary.nativeError = null
    for (const mode of ['list', 'manifest']) {
      failure = mode
      await state().check(true)
      assert.equal(state().stage, 'error')
      assert.equal(state().update, null)
    }
    failure = null
    await state().check(true)
    assert.equal(state().stage, 'available')
    assert.equal(state().update.versionCode, 11)
    boundary.downloadError = new Error('Download interrupted')
    await state().install()
    assert.equal(state().stage, 'error')
    assert.equal(boundary.installs.length, 0)
    boundary.downloadError = null
    let releaseDownload
    boundary.releaseDownload = new Promise(resolve => { releaseDownload = resolve })
    const installing = state().install()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state().stage, 'downloading')
    const beforeCheck = requests
    await state().check(true)
    assert.equal(requests, beforeCheck)
    assert.equal(state().stage, 'downloading')
    const duplicate = state().install()
    releaseDownload()
    await Promise.all([installing, duplicate])
    boundary.releaseDownload = null
    assert.equal(boundary.downloads, 2)
    assert.equal(state().stage, 'permission')
    await state().check(true)
    assert.equal(requests, beforeCheck)
    assert.equal(state().stage, 'permission')
    await state().resumeAfterPermission(true)
    assert.equal(state().stage, 'permission')
    assert.equal(boundary.permissionOpens, 2)
    boundary.allowInstall = true
    await state().resumeAfterPermission()
    assert.equal(state().stage, 'installer')
    assert.equal(boundary.downloads, 2, 'Permission return must reuse the downloaded APK')
    assert.deepEqual(boundary.installs.at(-1), {
      fileUri: `file:///private/cache/agentsdock-android-updates/${manifest.apk.assetName}`,
      sha256: manifest.apk.sha256, sizeBytes: 100, versionCode: 11,
    })
    await state().install()
    assert.equal(state().stage, 'installer', 'Installer cancellation permits another attempt')
    boundary.state.versionCode = 11
    await state().check(true)
    assert.equal(state().stage, 'up-to-date')
    assert.equal(state().update, null)
  } finally {
    globalThis.fetch = originalFetch
    delete globalThis.__androidUpdaterTest
    await rm(directory, { recursive: true, force: true })
  }
})
