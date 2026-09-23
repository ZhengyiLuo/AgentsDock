#!/usr/bin/env node
import { createPublicKey, verify } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = 'agents-server-npm-manifest.json'
const SIGNATURE = 'agents-server-npm-manifest.sig'
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/

function readRegular(filename, limit) {
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error('Release inputs must be bounded regular files.')
    const bytes = readFileSync(fd)
    if (bytes.length > limit) throw new Error('Release input exceeds its size limit.')
    return bytes
  } finally { closeSync(fd) }
}

function inside(root, candidate) {
  const suffix = relative(root, candidate)
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

export function validateDescriptor(bytes, signature, publicKey, appVersion) {
  const key = createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, bytes, key, signature)) throw new Error('Coordinated release signature is invalid.')
  const descriptor = JSON.parse(bytes.toString('utf8'))
  if (!VERSION.test(appVersion) || descriptor.version !== appVersion || descriptor.schema !== 2 || descriptor.distribution !== 'npm') throw new Error('Coordinated release must match the exact staged app version and npm schema.')
  const beta = appVersion.includes('-')
  if (descriptor.track !== (beta ? 'beta' : 'stable') || descriptor.prerelease !== beta) throw new Error('Coordinated release track does not match the app version.')
  if (!Number.isSafeInteger(descriptor.api_contract_version) || !Number.isSafeInteger(descriptor.minimum_server_api_contract) || descriptor.minimum_server_api_contract < 1 || descriptor.api_contract_version < descriptor.minimum_server_api_contract) throw new Error('Coordinated release has invalid API compatibility metadata.')
  if (!/^[a-f0-9]{40}$/.test(descriptor.commit)) throw new Error('Coordinated release must pin its source commit.')
  const integrity = descriptor.npm?.integrity
  if (descriptor.npm?.name !== '@agentsdock/server' || descriptor.npm?.version !== appVersion || typeof integrity !== 'string' || !integrity.startsWith('sha512-')) throw new Error('Coordinated release has invalid npm identity.')
  const digest = Buffer.from(integrity.slice(7), 'base64')
  if (digest.length !== 64 || `sha512-${digest.toString('base64')}` !== integrity) throw new Error('Coordinated release has invalid npm integrity.')
  const name = `server-${appVersion}.tgz`
  if (descriptor.archive?.name !== name || descriptor.archive?.url !== `https://registry.npmjs.org/@agentsdock/server/-/${name}` || !/^[a-f0-9]{64}$/.test(descriptor.archive?.sha256) || !Number.isSafeInteger(descriptor.archive?.size) || descriptor.archive.size < 1 || descriptor.archive.size > 200 * 1024 * 1024) throw new Error('Coordinated release has invalid archive metadata.')
  return descriptor
}

export function stageCoordinatedRelease({ packageJSON, resourcesDirectory, manifestPath, signaturePath, appVersion, publicKey = readRegular(join(ROOT, 'server/release-public-key.pem'), 4096) }) {
  if (!packageJSON || !resourcesDirectory || !manifestPath || !signaturePath || !appVersion) throw new Error('Provide an explicit staged package, resources directory, app version, manifest, and signature.')
  const packagePath = realpathSync(packageJSON)
  const stagedRoot = dirname(packagePath)
  const repositoryRelative = relative(ROOT, packagePath)
  if (inside(ROOT, packagePath) && !repositoryRelative.startsWith(`dist${sep}`) && !repositoryRelative.startsWith(`build${sep}`)) throw new Error('Refusing to modify source package metadata. Use an explicit package in a staged build directory.')
  const requestedResources = resolve(resourcesDirectory)
  const resources = join(stagedRoot, 'build', 'coordinated-release')
  if (requestedResources !== resources && requestedResources !== join(dirname(resolve(packageJSON)), 'build', 'coordinated-release')) throw new Error('Resources must be in the staged package build/coordinated-release directory.')
  let ancestor = resources
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  if (realpathSync(ancestor) !== stagedRoot && !inside(stagedRoot, realpathSync(ancestor))) throw new Error('Staged resource path resolves outside the staged package.')
  const metadata = JSON.parse(readRegular(packagePath, 1024 * 1024))
  if (metadata.version !== appVersion) throw new Error('Stage the app version explicitly before enrolling coordinated updates.')
  if (metadata.build?.extraMetadata?.version !== undefined && metadata.build.extraMetadata.version !== appVersion) throw new Error('Electron Builder metadata overrides the coordinated app version.')
  if (metadata.build?.directories?.app && metadata.build.directories.app !== '.') throw new Error('Coordinated staging requires the explicit Electron app package directory.')
  const bytes = readRegular(manifestPath, 8192)
  const signature = readRegular(signaturePath, 64)
  const descriptor = validateDescriptor(bytes, signature, publicKey, appVersion)
  for (const [name, content] of [[MANIFEST, bytes], [SIGNATURE, signature]]) {
    const target = join(resources, name)
    if (existsSync(target) && !readRegular(target, 1024 * 1024).equals(content)) throw new Error('A different coordinated release is already staged. Use a fresh build directory.')
  }
  const extraResources = metadata.build?.extraResources ?? []
  if (!Array.isArray(extraResources)) throw new Error('Staged package extraResources must be an array.')
  const existing = extraResources.filter(item => typeof item === 'object' && item?.to === 'coordinated-release')
  const resourceEntry = { from: 'build/coordinated-release', to: 'coordinated-release', filter: [MANIFEST, SIGNATURE] }
  if (existing.some(item => JSON.stringify(item) !== JSON.stringify(resourceEntry))) throw new Error('Conflicting coordinated resource packaging rule.')
  metadata.agentsDock = { ...metadata.agentsDock, coordinatedUpdates: true }
  metadata.build = { ...metadata.build, extraResources: existing.length ? extraResources : [...extraResources, resourceEntry] }
  mkdirSync(resources, { recursive: true })
  for (const [name, content] of [[MANIFEST, bytes], [SIGNATURE, signature]]) if (!existsSync(join(resources, name))) writeFileSync(join(resources, name), content, { flag: 'wx', mode: 0o644 })
  const temporary = `${packagePath}.coordinated-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
  renameSync(temporary, packagePath)
  return { version: descriptor.version, serverPackage: descriptor.npm.name, resourcesDirectory: resources, enrolled: true }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const names = { '--package-json': 'packageJSON', '--resources-directory': 'resourcesDirectory', '--manifest': 'manifestPath', '--signature': 'signaturePath', '--app-version': 'appVersion' }
    const values = {}
    const args = process.argv.slice(2)
    for (let index = 0; index < args.length; index += 2) {
      const key = names[args[index]]
      if (!key || Object.hasOwn(values, key) || !args[index + 1]) throw new Error('Usage: stage_coordinated_release.mjs --package-json STAGED/package.json --resources-directory STAGED/build/coordinated-release --app-version VERSION --manifest FILE --signature FILE')
      values[key] = args[index + 1]
    }
    process.stdout.write(`${JSON.stringify(stageCoordinatedRelease(values), null, 2)}\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
