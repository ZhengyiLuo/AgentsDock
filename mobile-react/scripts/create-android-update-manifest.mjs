import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SIGNER_SHA256 = '3ff67f11c62187c52f18e48e7ecd3cf25aa1fcf21ba0477c9eb9e3feeab82e5a'
const PACKAGE_NAME = 'com.zhengyiluo.agentsdock'
const argumentsByName = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (!name?.startsWith('--') || value == null) usage()
  argumentsByName.set(name.slice(2), value)
}

const apkPath = path.resolve(required('apk'))
const tagName = required('tag')
const outputPath = path.resolve(required('output'))
const publishedAt = argumentsByName.get('published-at') ?? new Date().toISOString()
if (!/^android-v[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tagName)) throw new Error(`Invalid Android tag: ${tagName}`)
if (!/^[A-Za-z0-9._-]+\.apk$/.test(path.basename(apkPath))) throw new Error(`Invalid APK asset name: ${path.basename(apkPath)}`)
if (!Number.isFinite(Date.parse(publishedAt))) throw new Error(`Invalid publication time: ${publishedAt}`)
const config = JSON.parse(fs.readFileSync(path.resolve('app.json'), 'utf8')).expo
if (config.android?.package !== PACKAGE_NAME) throw new Error(`Unexpected Android package: ${String(config.android?.package)}`)
if (!Number.isSafeInteger(config.android?.versionCode) || config.android.versionCode < 1) throw new Error('Invalid Android versionCode')
const apk = fs.readFileSync(apkPath)
const manifest = {
  schemaVersion: 1,
  channel: 'beta',
  tagName,
  packageName: PACKAGE_NAME,
  versionName: config.version,
  versionCode: config.android.versionCode,
  publishedAt: new Date(publishedAt).toISOString(),
  signingCertificateSha256: SIGNER_SHA256,
  apk: {
    assetName: path.basename(apkPath),
    sizeBytes: apk.byteLength,
    sha256: crypto.createHash('sha256').update(apk).digest('hex'),
  },
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
console.log(`Wrote Android update manifest for build ${manifest.versionCode}: ${outputPath}`)

function required(name) {
  const value = argumentsByName.get(name)
  if (!value) usage()
  return value
}

function usage() {
  console.error('Usage: node scripts/create-android-update-manifest.mjs --apk FILE --tag TAG --output FILE [--published-at ISO]')
  process.exit(64)
}
