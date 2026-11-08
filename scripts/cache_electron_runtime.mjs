#!/usr/bin/env node
// Source-CI transport recovery only. Never changes a product update feed.
import { createHash } from 'node:crypto'
import { createWriteStream, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

const API = 'https://api.github.com/repos/electron/electron'
const MAX_ARCHIVE = 512 * 1024 * 1024

export function officialElectronDownloader({ version, platform, arch, sha256, fetchImpl = fetch }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^(linux|darwin|win32)$/.test(platform)
      || !/^(x64|arm64|armv7l|ia32)$/.test(arch) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('An exact Electron version, supported target and pinned SHA-256 are required')
  }
  const name = `electron-v${version}-${platform}-${arch}.zip`
  const canonical = `https://github.com/electron/electron/releases/download/v${version}/${name}`
  return {
    async download(url, target) {
      if (url !== canonical) throw new Error('Unexpected Electron artifact URL')
      const signal = AbortSignal.timeout(120_000)
      let response
      try {
        response = await fetchImpl(canonical, { signal, credentials: 'omit' })
      } catch (error) {
        // A failed transport may still leave GitHub's API route reachable.
        if (!(error instanceof TypeError) && error?.name !== 'TimeoutError') throw error
      }
      if (!response || response.status >= 500 && response.status <= 599) {
        await response?.body?.cancel()
        console.error('Electron public download unavailable; trying the same official asset through GitHub API.')
        const apiSignal = AbortSignal.timeout(120_000)
        const release = await fetchImpl(`${API}/releases/tags/v${version}`, {
          signal: apiSignal, credentials: 'omit', redirect: 'error',
          headers: { Accept: 'application/vnd.github+json' }
        })
        if (!release.ok || !release.body) throw new Error(`Electron release lookup returned HTTP ${release.status}`)
        const chunks = []
        let size = 0
        for await (const chunk of release.body) {
          size += chunk.length
          if (size > 2 * 1024 * 1024) throw new Error('Electron release metadata exceeds size limit')
          chunks.push(chunk)
        }
        const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const assets = metadata.assets?.filter(asset => asset.name === name) ?? []
        const asset = assets[0]
        if (metadata.tag_name !== `v${version}` || metadata.draft !== false || metadata.prerelease !== false
            || assets.length !== 1 || !Number.isSafeInteger(asset.id) || asset.id <= 0
            || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size)
            || asset.size <= 0 || asset.size > MAX_ARCHIVE) {
          throw new Error('GitHub did not return the exact published Electron artifact')
        }
        // Construct the endpoint; never trust an arbitrary download URL in metadata.
        response = await fetchImpl(`${API}/releases/assets/${asset.id}`, {
          signal: apiSignal, credentials: 'omit', headers: { Accept: 'application/octet-stream' }
        })
      }
      if (!response.ok || !response.body) throw new Error(`Electron artifact returned HTTP ${response.status}`)
      const hash = createHash('sha256')
      let bytes = 0
      const bounded = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length
          if (bytes > MAX_ARCHIVE) return callback(new Error('Electron artifact exceeds size limit'))
          hash.update(chunk)
          callback(null, chunk)
        }
      })
      await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(target, { flags: 'wx', mode: 0o600 }))
      if (hash.digest('hex') !== sha256) throw new Error('Electron artifact does not match the npm-pinned SHA-256')
    }
  }
}

export async function cacheElectronRuntime(directory = process.cwd()) {
  const require = createRequire(resolve(directory, 'package.json'))
  const project = require('./package.json')
  const electronPackagePath = require.resolve('electron/package.json')
  const electronRequire = createRequire(electronPackagePath)
  const { version } = electronRequire('./package.json')
  if (project.devDependencies?.electron !== version) throw new Error('Electron runtime must match the exact project pin')
  for (const key of Object.keys(process.env)) {
    if (/^(?:electron_|npm_config_electron_|npm_package_config_electron_)/i.test(key)
        && /mirror|custom|checksum|override|install_platform|install_arch/i.test(key)) {
      throw new Error(`Source-CI runtime download refuses ${key}`)
    }
  }
  const { platform, arch } = process
  const name = `electron-v${version}-${platform}-${arch}.zip`
  const checksums = JSON.parse(readFileSync(electronRequire.resolve('./checksums.json'), 'utf8'))
  const { downloadArtifact } = await import(pathToFileURL(electronRequire.resolve('@electron/get')).href)
  const result = await downloadArtifact({ version, platform, arch, artifactName: 'electron', checksums,
    cacheRoot: process.env.electron_config_cache,
    tempDirectory: process.env.electron_config_cache,
    downloader: officialElectronDownloader({ version, platform, arch, sha256: checksums[name] }) })
  console.log(`Verified pinned Electron ${version} (${platform}/${arch}) in the installer cache.`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cacheElectronRuntime().catch(error => { console.error(error.message); process.exitCode = 1 })
}
