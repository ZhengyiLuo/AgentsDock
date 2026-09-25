#!/usr/bin/env node
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDescriptor } from './stage_coordinated_release.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NAMES = ['agents-server-npm-manifest.json', 'agents-server-npm-manifest.sig']
function regular(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error('Packaged coordinated metadata must be a bounded regular file.')
    const bytes = readFileSync(fd)
    if (bytes.length > limit) throw new Error('Packaged coordinated metadata exceeds its size limit.')
    return bytes
  } finally { closeSync(fd) }
}

export function verifyCoordinatedResources({ resources, packageJSON, manifestPath = process.env.AGENTSDOCK_COORDINATED_MANIFEST, signaturePath = process.env.AGENTSDOCK_COORDINATED_SIGNATURE, publicKey = regular(join(ROOT, 'server/release-public-key.pem'), 4096) }) {
  const metadata = JSON.parse(regular(packageJSON, 1024 * 1024))
  const directory = join(resources, 'coordinated-release')
  if (Boolean(manifestPath) !== Boolean(signaturePath)) throw new Error('Both expected coordinated descriptor inputs are required.')
  if (!manifestPath) {
    if (metadata.agentsDock?.coordinatedUpdates || existsSync(directory)) throw new Error('Packaged coordinated enrollment requires explicit expected descriptor inputs.')
    return { enrolled: false }
  }
  if (metadata.agentsDock?.coordinatedUpdates !== true) throw new Error('Packaged app is missing coordinated enrollment metadata.')
  if (!lstatSync(directory).isDirectory() || JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(NAMES)) throw new Error('Packaged coordinated resource set is not exact.')
  const bytes = regular(manifestPath, 8192), signature = regular(signaturePath, 64)
  validateDescriptor(bytes, signature, publicKey, metadata.version)
  for (const [name, expected] of [[NAMES[0], bytes], [NAMES[1], signature]]) if (!regular(join(directory, name), name.endsWith('.sig') ? 64 : 8192).equals(expected)) throw new Error('Packaged coordinated resource bytes differ from the accepted descriptor.')
  return { enrolled: true, version: metadata.version }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: verify_coordinated_resources.mjs RESOURCES EXTRACTED_PACKAGE_JSON')
    process.stdout.write(`${JSON.stringify(verifyCoordinatedResources({ resources: resolve(process.argv[2]), packageJSON: resolve(process.argv[3]) }))}\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
