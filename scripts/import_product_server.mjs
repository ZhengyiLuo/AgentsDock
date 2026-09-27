#!/usr/bin/env node
// Read-only import verification. The established private key remains in the
// standalone signer; this never signs, publishes, exports Git or runs installers.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, closeSync, createReadStream, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { GitHubClient } from './direct-release-mirror.mjs'
import { verifyExportSource } from './legacy-server-release.mjs'
import { releaseIdentity, verifyServerBundleIdentity } from './product-release.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIGNER = 'ZhengyiLuo/AgentsServer'
const need = (condition, message) => { if (!condition) throw new Error(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const positive = value => /^(?:[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value))
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)

function regular(path, maximum = 32768) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const stat = fstatSync(fd)
    need(stat.isFile() && stat.size > 0 && stat.size <= maximum, 'Import inputs must be bounded regular files.')
    const bytes = readFileSync(fd)
    need(bytes.length <= maximum, 'Import input exceeds its size limit.')
    return bytes
  } finally { closeSync(fd) }
}

function identity(options) {
  // Reuse reviewed-ref, strict version and source validation without inventing a
  // production receipt or treating a test-only candidate as publication-ready.
  const value = releaseIdentity(options.version, options.sourceSha, options.sourceRef, options.sourceSha)
  need(positive(options.signerRunId), 'An explicit positive signer run ID is required.')
  return value
}

export function validateSignerArtifact(run, listing, options) {
  identity(options)
  need(run && String(run.id) === String(options.signerRunId) && positive(run.run_attempt)
    && run.status === 'completed' && run.conclusion === 'success' && run.event === 'workflow_dispatch'
    && run.path === '.github/workflows/server-npm-candidate.yml'
    && run.repository?.full_name === SIGNER && run.head_repository?.full_name === SIGNER
    && positive(run.repository?.id) && run.repository.id === run.head_repository?.id
    && commit(run.head_sha), 'Signer run is not the successful controlled standalone candidate workflow.')
  releaseIdentity(options.version, options.sourceSha, run.head_branch, run.head_sha)
  const expected = `signed-product-server-${options.version}-${options.sourceSha}-${run.id}-${run.run_attempt}`
  need(listing && Number.isSafeInteger(listing.total_count) && listing.total_count <= 100
    && Array.isArray(listing.artifacts) && listing.total_count === listing.artifacts.length,
  'Signer artifact listing is incomplete or ambiguous.')
  const matches = listing.artifacts.filter(artifact => artifact.name === expected)
  need(matches.length === 1, 'Exact attempt-specific signed product artifact is missing or ambiguous.')
  const artifact = matches[0], provenance = artifact.workflow_run
  need(positive(artifact.id) && artifact.expired === false && Number.isSafeInteger(artifact.size_in_bytes)
    && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 500 * 1024 * 1024
    && /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')
    && provenance?.id === run.id && provenance.head_sha === run.head_sha && provenance.head_branch === run.head_branch
    && provenance.repository_id === run.repository.id && provenance.head_repository_id === run.repository.id,
  'Signer artifact provenance, availability or immutable archive digest differs.')
  return { run, artifact }
}

async function archiveIdentity(path, expected) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const stat = fstatSync(fd)
    need(stat.isFile() && stat.size === expected.size_in_bytes, 'Downloaded signer ZIP differs from the artifact size.')
    const digest = createHash('sha256')
    let count = 0
    for await (const chunk of createReadStream(path, { fd, autoClose: false })) {
      count += chunk.length
      need(count <= expected.size_in_bytes, 'Signer ZIP grew during verification.')
      digest.update(chunk)
    }
    need(count === expected.size_in_bytes && `sha256:${digest.digest('hex')}` === expected.digest,
      'Downloaded signer ZIP differs from the immutable Actions artifact digest.')
  } finally { closeSync(fd) }
}

const VERIFY_ZIP = `
import hashlib,json,os,stat,sys,zipfile
from pathlib import Path
archive,root=Path(sys.argv[1]),Path(sys.argv[2]); names=json.loads(sys.argv[3])
extract=len(sys.argv)>4 and sys.argv[4]=='extract'
with zipfile.ZipFile(archive) as source:
    files={}; directories=set()
    for entry in source.infolist():
        mode=entry.external_attr >> 16
        if entry.is_dir():
            if entry.filename not in {'npm/','legacy/'} or entry.filename in directories or entry.file_size != 0:
                raise ValueError('Unexpected or duplicate archive directory')
            directories.add(entry.filename); continue
        if entry.filename not in names or entry.filename in files or entry.flag_bits & 1 or stat.S_IFMT(mode) not in {0,stat.S_IFREG}:
            raise ValueError('Unexpected, duplicate or unsafe archive member')
        maximum=64 if entry.filename.endswith('.sig') else 32768 if entry.filename.endswith('.json') else 200*1024*1024
        if not 0<entry.file_size<=maximum: raise ValueError('Signer archive member exceeds its size limit')
        files[entry.filename]=entry
    if sorted(files) != sorted(names): raise ValueError('Incomplete signer archive')
    if extract:
        root.mkdir(mode=0o700)
        (root/'npm').mkdir(mode=0o700); (root/'legacy').mkdir(mode=0o700)
    for name in names:
        expected=root/name; entry=files[name]
        if extract:
            descriptor=os.open(expected,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o644)
            with os.fdopen(descriptor,'wb') as target,source.open(entry) as zipped:
                written=0
                while True:
                    chunk=zipped.read(1024*1024)
                    if not chunk: break
                    written+=len(chunk)
                    if written>entry.file_size: raise ValueError('Archive member grew during extraction')
                    target.write(chunk)
                if written!=entry.file_size: raise ValueError('Archive member size differs')
        metadata=expected.lstat()
        if not stat.S_ISREG(metadata.st_mode) or entry.file_size != metadata.st_size or metadata.st_size > 200*1024*1024:
            raise ValueError('Signer archive member size differs')
        left=hashlib.sha256(); right=hashlib.sha256()
        with source.open(entry) as zipped, expected.open('rb') as disk:
            while True:
                a=zipped.read(1024*1024); b=disk.read(1024*1024)
                if not a and not b: break
                left.update(a); right.update(b)
        if left.digest()!=right.digest(): raise ValueError('Extracted signer artifact bytes differ')
print('verified')
`

async function verifyImportContext(options, { client, execute, repositoryDirectory }) {
  const release = identity(options)
  need(options.assets && options.archive, 'Exact extracted server assets and original Actions ZIP are both required.')
  const run = client.optional(`repos/${SIGNER}/actions/runs/${options.signerRunId}`)
  const listing = client.optional(`repos/${SIGNER}/actions/runs/${options.signerRunId}/artifacts?per_page=100`)
  const { artifact } = validateSignerArtifact(run, listing, options)
  const exportSha = run.head_sha
  let checkout
  try {
    checkout = execute('git', ['-C', repositoryDirectory, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch { throw new Error('Signer import requires the exact pinned canonical checkout.') }
  need(checkout === options.sourceSha, 'Signer import checkout differs from the exact canonical source.')
  // This proves the signer workflow's entire checkout is the exact reviewed
  // canonical server subtree, including the established committed public key.
  verifyExportSource({ ...options, track: release.track, exportSha }, { client, execute, repositoryDirectory })
  await archiveIdentity(options.archive, artifact)
  return { release, run, artifact, exportSha }
}

function archiveNames(version) {
  return ['product-server-bundle.json', 'npm/agents-server-npm-manifest.json', 'npm/agents-server-npm-manifest.sig',
    `npm/server-${version}.tgz`, 'legacy/agents-server-manifest.json', 'legacy/agents-server-manifest.sig',
    `legacy/agents-server-${version}.tar.gz`]
}

function verifyZip(options, execute, extract = false) {
  try {
    need(execute('python3', ['-c', VERIFY_ZIP, options.archive, options.assets, JSON.stringify(archiveNames(options.version)),
      ...(extract ? ['extract'] : [])],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] }).trim() === 'verified',
    'Signer ZIP members were not verified.')
  } catch { throw new Error(extract
    ? 'Signer ZIP extraction requires a new directory and exactly seven bounded regular public bundle files.'
    : 'Original signer ZIP must contain only the exact seven verified public bundle files.') }
}

export async function inspectProductServerImport(options, { client = new GitHubClient(), execute = execFileSync,
  repositoryDirectory = ROOT, publicKey } = {}) {
  const { release, run, artifact, exportSha } = await verifyImportContext(options, { client, execute, repositoryDirectory })
  const value = { version: release.version, track: release.track, sourceSha: release.sourceSha,
    npmManifestSha256: hash(regular(join(options.assets, 'npm/agents-server-npm-manifest.json'))),
    legacyManifestSha256: hash(regular(join(options.assets, 'legacy/agents-server-manifest.json'))),
    serverBundleSha256: hash(regular(join(options.assets, 'product-server-bundle.json'))) }
  verifyServerBundleIdentity(value, options.assets, publicKey)
  verifyZip(options, execute)
  return { schema: 1, kind: 'artifact-only-server-import', releaseAcceptance: false,
    ...value, sourceRef: options.sourceRef, exportSha,
    signerRunId: String(run.id), signerRunAttempt: String(run.run_attempt),
    signerArtifactId: String(artifact.id), signerArtifactName: artifact.name, signerArtifactDigest: artifact.digest }
}

export async function extractProductServerImport(options, { client = new GitHubClient(), execute = execFileSync,
  repositoryDirectory = ROOT, publicKey } = {}) {
  const dependencies = { client, execute, repositoryDirectory, publicKey }
  // Verify the original immutable artifact and source before any extraction.
  // Failure deliberately preserves a partial new directory for inspection;
  // no retry can overwrite it or replace accepted bytes.
  await verifyImportContext(options, dependencies)
  verifyZip(options, execute, true)
  return inspectProductServerImport(options, dependencies)
}

function emit(value) {
  for (const [key, content] of Object.entries(value)) {
    need(!/[\r\n]/.test(String(content)), 'Unsafe import workflow output.')
    process.stdout.write(`${key}=${content}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, ...args] = process.argv.slice(2), options = {}
    need(['inspect', 'extract'].includes(operation) && args.length % 2 === 0, 'Usage: import_product_server.mjs inspect|extract --assets DIR --archive ZIP --source-sha SHA --source-ref REF --version VERSION --signer-run-id ID [--report FILE]')
    const allowed = new Set(['assets', 'archive', 'source-sha', 'source-ref', 'version', 'signer-run-id', 'report'])
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i].slice(2), key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      need(args[i].startsWith('--') && allowed.has(name) && !(key in options) && args[i + 1], 'Invalid signer import option.')
      options[key] = args[i + 1]
    }
    const report = await (operation === 'extract' ? extractProductServerImport : inspectProductServerImport)(options)
    if (options.report) writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    emit({ export_sha: report.exportSha, signer_run_id: report.signerRunId, signer_run_attempt: report.signerRunAttempt,
      signer_artifact_id: report.signerArtifactId, signer_artifact_name: report.signerArtifactName,
      signer_artifact_digest: report.signerArtifactDigest, server_bundle_sha256: report.serverBundleSha256,
      npm_manifest_sha256: report.npmManifestSha256, legacy_manifest_sha256: report.legacyManifestSha256,
      descriptor_base64: regular(join(options.assets, 'npm/agents-server-npm-manifest.json'), 8192).toString('base64'),
      signature_base64: regular(join(options.assets, 'npm/agents-server-npm-manifest.sig'), 64).toString('base64') })
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
