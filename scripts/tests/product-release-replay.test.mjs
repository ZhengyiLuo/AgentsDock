import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, X509Certificate } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { checkServerIdentity } from 'node:tls'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { expectedAssets } from '../direct-release-mirror.mjs'
import { assertReplayReadiness, assertReplayRunner, consumeReplayFault, createCandidateReplay, createCandidateServerReplay, createProductReplay, createReplayStartupDiagnostics,
  finalizeReplayListener, parseReplayArguments, parseReplayOriginProbe, parseReplayProbeDiagnostics, parseReplayRange,
  parseReplayStartupDiagnostics, probeReplayOrigin, readReplayMetadata, replayBaselineMetadata, serveProductReplay } from '../product-release-replay.mjs'
import { assertCandidateRunner, candidateAssets, inspectCandidate, validateCandidateReceipt } from '../product-candidate-receipt.mjs'
import { newestCompatibleReleaseFromAtom } from '../../electron/src/main/updater-feed.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceSha = 'a'.repeat(40)

function fixture(t, version = '1.0.7-beta.16') {
  const root = mkdtempSync(join(tmpdir(), 'agentsdock-replay-unit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const serverDirectory = join(root, 'server'), desktopDirectory = join(root, 'desktop')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const track = version.includes('-') ? 'beta' : 'stable'
  const value = { schema: 1, version, track, sourceSha, sourceRef: 'release/test', workflowSha: sourceSha,
    exportSha: 'b'.repeat(40), prepareRunId: '123', prepareRunNumber: '3', buildNumber: '5003', windowsSigning: 'signed' }
  const artifacts = {}, descriptors = {}
  const put = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes) }
  for (const distribution of ['npm', 'legacy']) {
    const npm = distribution === 'npm'
    const packageRoot = npm ? 'package' : `agents-server-${version}`
    const archiveName = npm ? `server-${version}.tgz` : `agents-server-${version}.tar.gz`
    const stage = join(root, `stage-${distribution}`)
    for (const [name, bytes] of Object.entries({ VERSION: `${version}\n`, 'agent_server.py': 'server', 'update_runner.py': 'updater',
      'install.sh': '#!/bin/sh\nexit 0\n', 'release-public-key.pem': 'fixture public key' })) {
      const path = join(stage, packageRoot, npm ? 'server' : '', name)
      put(path, bytes); chmodSync(path, name === 'install.sh' ? 0o755 : 0o644)
    }
    if (npm) for (const name of ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'npm/cli.cjs']) put(join(stage, packageRoot, name), 'fixture')
    mkdirSync(join(serverDirectory, distribution), { recursive: true })
    const archivePath = join(serverDirectory, distribution, archiveName)
    execFileSync('tar', ['-czf', archivePath, '-C', stage, packageRoot], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const payload = readFileSync(archivePath)
    const descriptor = { schema: npm ? 2 : 1, version, track, prerelease: track === 'beta', commit: sourceSha, api_contract_version: 28,
      archive: { name: archiveName, size: payload.length, sha256: hash(payload),
        url: npm ? `https://registry.npmjs.org/@agentsdock/server/-/${archiveName}`
          : `https://github.com/ZhengyiLuo/AgentsServer/releases/download/v${version}/${archiveName}` },
      ...(npm ? { distribution: 'npm', minimum_server_api_contract: 8,
        npm: { name: '@agentsdock/server', version, integrity: `sha512-${createHash('sha512').update(payload).digest('base64')}` } } : {}) }
    descriptors[distribution] = descriptor
    const stem = npm ? 'agents-server-npm-manifest' : 'agents-server-manifest'
    const bytes = Buffer.from(`${JSON.stringify(descriptor)}\n`)
    put(join(serverDirectory, distribution, `${stem}.json`), bytes)
    put(join(serverDirectory, distribution, `${stem}.sig`), sign(null, bytes, privateKey))
    value[npm ? 'npmManifestSha256' : 'legacyManifestSha256'] = hash(bytes)
    for (const name of [archiveName, `${stem}.json`, `${stem}.sig`]) {
      const content = readFileSync(join(serverDirectory, distribution, name))
      artifacts[`${distribution}/${name}`] = { size: content.length, sha256: hash(content) }
    }
  }
  const bundle = JSON.stringify({ schema: 1, version, track, sourceSha, npmManifestSha256: value.npmManifestSha256,
    legacyManifestSha256: value.legacyManifestSha256, artifacts })
  put(join(serverDirectory, 'product-server-bundle.json'), bundle)
  value.serverBundleSha256 = hash(bundle)
  const sums = []
  for (const name of expectedAssets(version, track, true).filter(name => name !== 'SHA256SUMS')) {
    const content = name.startsWith('agents-server-npm-manifest') ? readFileSync(join(serverDirectory, 'npm', name))
      : Buffer.from(name.endsWith('.yml') ? `version: ${version}\n` : `synthetic unit artifact: ${name}\n`)
    put(join(desktopDirectory, name), content)
    sums.push(`${hash(content)}  ${name}\n`)
  }
  put(join(desktopDirectory, 'SHA256SUMS'), sums.join(''))
  value.desktopManifestSha256 = hash(sums.join(''))
  const receiptPath = join(root, 'release.json'), preparationRunPath = join(root, 'prepare-run.json')
  put(receiptPath, JSON.stringify(value))
  put(preparationRunPath, JSON.stringify({ id: 123, run_number: 3, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    head_sha: sourceSha, head_branch: 'release/test', head_repository: { full_name: 'ZhengyiLuo/AgentsDock' }, path: '.github/workflows/product-release.yml' }))
  return { root, value, descriptors, options: { receiptPath, acceptedReceiptSha256: hash(readFileSync(receiptPath)), preparationRunPath,
    serverDirectory, desktopDirectory, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) } }
}

async function consume(response) {
  try {
    if (Buffer.isBuffer(response.body)) return response.body
    const chunks = []
    for await (const chunk of response.body) chunks.push(chunk)
    return Buffer.concat(chunks)
  } finally { await response.dispose() }
}

function scopedFixture(t, version) {
  const f = fixture(t, version), names = candidateAssets(f.value.version, f.value.track), desktopAssets = {}
  for (const name of expectedAssets(f.value.version, f.value.track, true)) {
    if (!names.includes(name)) rmSync(join(f.options.desktopDirectory, name))
  }
  const sums = names.filter(name => name !== 'SHA256SUMS').map(name => `${hash(readFileSync(join(f.options.desktopDirectory, name)))}  ${name}`).join('\n') + '\n'
  writeFileSync(join(f.options.desktopDirectory, 'SHA256SUMS'), sums)
  for (const name of names) {
    const bytes = readFileSync(join(f.options.desktopDirectory, name))
    desktopAssets[name] = { size: bytes.length, sha256: hash(bytes) }
  }
  // Cryptographic contract fixture, not a real signing run or native artifact.
  const signerArchive = Buffer.from('synthetic signer transport fixture')
  writeFileSync(join(f.root, 'signer-artifact.zip'), signerArchive)
  const imported = { schema: 1, kind: 'artifact-only-server-import', releaseAcceptance: false,
    ...Object.fromEntries(['version', 'track', 'sourceSha', 'sourceRef', 'exportSha', 'npmManifestSha256', 'legacyManifestSha256', 'serverBundleSha256'].map(key => [key, f.value[key]])),
    signerRunId: '123', signerRunAttempt: '2', signerArtifactDigest: `sha256:${hash(signerArchive)}` }
  const report = Buffer.from(JSON.stringify(imported))
  writeFileSync(join(f.root, 'server-import.json'), report)
  f.value = { ...imported, kind: 'agentsdock-macos-candidate', scope: 'darwin-app-server', publicationEligible: false,
    buildNumber: '1189', desktopManifestSha256: hash(sums), serverImportSha256: hash(report), desktopAssets }
  writeFileSync(f.options.receiptPath, JSON.stringify(f.value))
  f.options.acceptedReceiptSha256 = hash(readFileSync(f.options.receiptPath))
  delete f.options.preparationRunPath
  return f
}

test('test-only macOS scope verifies exact signed bytes but cannot enter production replay', async t => {
  const f = scopedFixture(t), replay = await createCandidateReplay(f.options)
  assert.equal(replay.identity.kind, 'candidate')
  assert.equal(replay.identity.publicationEligible, false)
  assert(!replay.inventory().some(entry => /AppImage|\.exe|linux|win\.yml/.test(entry.url)))
  assert(replay.inventory().some(entry => entry.url.endsWith('.tgz')))
  assert(replay.inventory().some(entry => entry.url.endsWith('-mac-universal.zip')))
  await assert.rejects(() => createProductReplay(f.options), /candidate/)
  assert.throws(() => validateCandidateReceipt({ ...f.value, publicationEligible: true }))
  assert.throws(() => validateCandidateReceipt({ ...f.value, sourceRef: 'release/bad.lock' }))
  writeFileSync(join(f.root, 'server-import.json'), 'changed')
  await assert.rejects(() => createCandidateReplay(f.options), /import report/)
})

test('reviewed stable candidate exposes exact stable routes but stays publication-ineligible', async t => {
  const f = scopedFixture(t, '1.0.9'), replay = await createCandidateReplay(f.options)
  assert.equal(replay.identity.kind, 'candidate')
  assert.equal(replay.identity.track, 'stable')
  assert.equal(replay.identity.publicationEligible, false)
  assert(replay.inventory().some(item => item.url.endsWith('/latest/download/latest-mac.yml')))
  assert(!replay.inventory().some(item => item.url.endsWith('/beta-mac.yml')))
  const latest = await replay.respond({method: 'GET', host: 'api.github.com', path: '/repos/ZhengyiLuo/AgentsDock/releases/latest'})
  assert.equal(JSON.parse(await consume(latest)).prerelease, false)
  await assert.rejects(() => createProductReplay(f.options), /candidate/)
  assert.throws(() => validateCandidateReceipt({...f.value, track: 'beta'}))
  assert.throws(() => validateCandidateReceipt({...f.value, version: '1.0.10'}))
})

test('baseline routing keeps beta metadata and strict version order confined to exact reviewed journeys', () => {
  assert.deepEqual(replayBaselineMetadata('1.0.8-beta.5', '1.0.9', true),
    {track: 'beta', metadata: 'beta-mac.yml', prerelease: true})
  assert.deepEqual(replayBaselineMetadata('1.0.6', '1.0.9', true),
    {track: 'stable', metadata: 'latest-mac.yml', prerelease: false})
  assert.equal(replayBaselineMetadata('1.0.6', '1.0.8-beta.5', true).track, 'stable')
  for (const candidate of ['1.0.10-beta.2', '1.0.10-beta.3', '1.0.10-beta.4', '1.0.10-beta.5']) {
    assert.deepEqual(replayBaselineMetadata('1.0.10-beta.1', candidate, true),
      {track: 'beta', metadata: 'beta-mac.yml', prerelease: true})
  }
  for (const args of [['1.0.8-beta.5', '1.0.9', false], ['1.0.8-beta.4', '1.0.9', true],
    ['1.0.8-beta.5', '1.0.9-beta.1', true], ['1.0.9', '1.0.9', true], ['1.0.10', '1.0.9', true],
    ['1.0.8', '1.0.9', true], ['1.0.6+local', '1.0.9', true],
    ['1.0.10-beta.1', '1.0.10-beta.2', false], ['1.0.10-beta.1', '1.0.10-beta.3', false],
    ['1.0.10-beta.1', '1.0.10-beta.6', true], ['1.0.10-beta.2', '1.0.10-beta.3', true],
    ['1.0.8-beta.5', '1.0.10-beta.3', true], ['1.0.10-beta.1', '1.0.10-beta.3+local', true],
    ['1.0.10-beta.1', '1.0.10-beta.4', false], ['1.0.10-beta.2', '1.0.10-beta.4', true],
    ['1.0.10-beta.3', '1.0.10-beta.4', true], ['1.0.8-beta.5', '1.0.10-beta.4', true],
    ['1.0.10-beta.1', '1.0.10-beta.4+local', true],
    ['1.0.10-beta.1', '1.0.10-beta.5', false], ['1.0.10-beta.2', '1.0.10-beta.5', true],
    ['1.0.10-beta.3', '1.0.10-beta.5', true], ['1.0.10-beta.4', '1.0.10-beta.5', true],
    ['1.0.8-beta.5', '1.0.10-beta.5', true], ['1.0.10-beta.1', '1.0.10-beta.5+local', true],
    ['1.0.8-beta.5', '1.0.10-beta.2', true], ['1.0.10-beta.2', '1.0.10-beta.2', true]]) assert.throws(() => replayBaselineMetadata(...args))
})

test('beta.2 through beta.5 replay remain nonpublishing and verify the independent beta.1 seal before routing', async t => {
  for (const version of ['1.0.10-beta.2', '1.0.10-beta.3', '1.0.10-beta.4', '1.0.10-beta.5']) {
    const f = scopedFixture(t, version), replay = await createCandidateReplay(f.options)
    assert.equal(replay.identity.kind, 'candidate')
    assert.equal(replay.identity.publicationEligible, false)
    assert.throws(() => validateCandidateReceipt({...f.value, publicationEligible: true}))
    const baselineDesktopDirectory = join(f.root, 'baseline')
    mkdirSync(baselineDesktopDirectory)
    writeFileSync(join(baselineDesktopDirectory, 'SHA256SUMS'), 'substituted baseline manifest')
    await assert.rejects(() => createCandidateReplay({...f.options, baselineDesktopDirectory,
      baselineVersion: '1.0.10-beta.1'}), /Baseline public checksum manifest differs from independently pinned bytes/)
  }
})

test('candidate verifies original signer transport and every macOS artifact hash', async t => {
  const f = scopedFixture(t)
  const inspect = () => inspectCandidate({ ...f.options, receiptSha256: f.options.acceptedReceiptSha256 })
  await inspect()
  writeFileSync(join(f.root, 'signer-artifact.zip'), 'different')
  await assert.rejects(inspect, /signing artifact/)
})

test('server-only Linux replay binds original matched artifact bytes but cannot serve any desktop route', async t => {
  const f = scopedFixture(t), replay = await createCandidateServerReplay(f.options)
  assert.equal(replay.identity.kind, 'candidate-server-linux')
  assert.equal(replay.identity.publicationEligible, false)
  assert.equal(replay.identity.desktopAcceptance, false)
  assert(replay.inventory().some(item => item.url.endsWith('.tar.gz')))
  assert(replay.inventory().some(item => item.url.endsWith('.tgz')))
  assert(replay.inventory().every(item => !item.url.includes('ZhengyiLuo/AgentsDock')))
  assert.equal((await replay.respond({method: 'GET', host: 'github.com', path: '/ZhengyiLuo/AgentsDock/releases.atom'})).status, 404)
  await assert.rejects(() => createCandidateServerReplay({...f.options, baselineVersion: '1.0.6', baselineDesktopDirectory: '/fixture'}), /cannot select/)
  writeFileSync(join(f.root, 'server-import.json'), 'changed')
  await assert.rejects(() => createCandidateServerReplay(f.options), /import report/)
})

test('server-only replay parser refuses desktop baseline and unrelated transfer fault scopes', () => {
  const args = ['inspect', '--scope', 'candidate-server-linux', '--receipt', '/receipt', '--receipt-sha256', 'a'.repeat(64),
    '--server-assets', '/server', '--desktop-assets', '/desktop']
  assert.equal(parseReplayArguments(args).options['--scope'], 'candidate-server-linux')
  assert.throws(() => parseReplayArguments([...args, '--baseline-desktop', '/old', '--baseline-version', '1.0.6']), /Server-only/)
  assert.throws(() => parseReplayArguments(['serve', ...args.slice(1), '--certificate', '/cert', '--private-key', '/key',
    '--fault-control', '/fault', '--fault-observed', '/observed']), /Server-only/)
})

test('candidate replay requires explicit real hosted ci dispatch and has no production preparation run', () => {
  const environment = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'ZhengyiLuo/AgentsDock',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/release/test',
    GITHUB_SHA: sourceSha, GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '1', RUNNER_OS: 'macOS' }
  assert.doesNotThrow(() => assertCandidateRunner(environment, 'darwin'))
  for (const change of [{ GITHUB_EVENT_NAME: 'pull_request' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_WORKFLOW_REF: environment.GITHUB_WORKFLOW_REF.replace('ci.yml', 'product-release-acceptance.yml') },
    { GITHUB_RUN_ATTEMPT: '0' }, { GITHUB_WORKFLOW_REF: environment.GITHUB_WORKFLOW_REF.replace('release/test', 'main') }]) {
    assert.throws(() => assertCandidateRunner({ ...environment, ...change }, 'darwin'))
  }
  const args = ['inspect', '--scope', 'candidate', '--receipt', '/receipt', '--receipt-sha256', 'a'.repeat(64), '--server-assets', '/server', '--desktop-assets', '/desktop']
  assert.equal(parseReplayArguments(args).options['--scope'], 'candidate')
  assert.throws(() => parseReplayArguments(args.filter((_, i) => i !== 1 && i !== 2)), /Missing/)
})

test('replays only receipt-bound exact server/native bytes and labels generated discovery', async t => {
  const f = fixture(t), replay = await createProductReplay(f.options)
  assert.equal(replay.identity.sourceSha, sourceSha)
  assert.equal(replay.identity.discovery, 'synthetic-replay-not-publication')
  assert.equal(Object.hasOwn(replay.identity, 'passed'), false)
  for (const entry of replay.inventory()) {
    const url = new URL(entry.url)
    const response = await replay.respond({ method: 'GET', host: url.host, path: `${url.pathname}${url.search}` })
    assert.equal(response.status, 200)
    const bytes = await consume(response)
    assert.equal(bytes.length, entry.size)
    assert.equal(hash(bytes), entry.sha256)
    assert.equal(response.headers['x-agentsdock-replay'], 'test-only')
  }
  const entry = replay.inventory().find(entry => entry.url.endsWith('.atom'))
  assert.equal(entry.generated, true)
  const feed = await consume(await replay.respond({ method: 'GET', host: 'github.com', path: '/ZhengyiLuo/AgentsDock/releases.atom' }))
  assert.deepEqual(newestCompatibleReleaseFromAtom(feed.toString()), { version: f.value.version, track: 'beta' })
  assert.equal(replay.inventory().find(entry => entry.url.endsWith('.tgz')).generated, false)
  assert(!replay.inventory().some(entry => entry.url.includes('/latest')))
})

test('stable replay exposes stable aliases but a beta never becomes latest', async t => {
  const f = fixture(t, '1.0.7'), replay = await createProductReplay(f.options)
  const response = await replay.respond({ method: 'GET', host: 'api.github.com', path: '/repos/ZhengyiLuo/AgentsDock/releases/latest' })
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(await consume(response)).prerelease, false)
  const webLatest = await replay.respond({ method: 'GET', host: 'github.com', path: '/ZhengyiLuo/AgentsDock/releases/latest' })
  assert.equal(JSON.parse(await consume(webLatest)).tag_name, 'v1.0.7')
  assert(replay.inventory().some(entry => entry.url.endsWith('/latest/download/latest-mac.yml')))
  for (const name of ['agents-server-manifest.json', 'agents-server-manifest.sig']) {
    const response = await replay.respond({ method: 'GET', host: 'github.com', path: `/ZhengyiLuo/AgentsServer/releases/latest/download/${name}` })
    assert.deepEqual(await consume(response), readFileSync(join(f.options.serverDirectory, 'legacy', name)))
  }
  assert(!replay.inventory().some(entry => entry.url.endsWith('/beta-mac.yml')))
})

test('beta replay preserves a checksum-bound stable desktop baseline instead of making beta latest', async t => {
  const f = fixture(t), directory = join(f.root, 'baseline')
  mkdirSync(directory)
  const names = { 'AgentsDock-1.0.6-mac-universal.zip': Buffer.from('unit fixture only'),
    'latest-mac.yml': Buffer.from('version: 1.0.6\n') }
  for (const [name, bytes] of Object.entries(names)) writeFileSync(join(directory, name), bytes)
  writeFileSync(join(directory, 'SHA256SUMS'), Object.entries(names).map(([name, bytes]) => `${hash(bytes)}  ${name}\n`).join(''))
  const replay = await createProductReplay({ ...f.options, baselineDesktopDirectory: directory, baselineVersion: '1.0.6' })
  const latest = await replay.respond({ method: 'GET', host: 'github.com', path: '/ZhengyiLuo/AgentsDock/releases/latest' })
  assert.equal(JSON.parse(await consume(latest)).tag_name, 'v1.0.6')
  const yaml = await replay.respond({ method: 'GET', host: 'github.com', path: '/ZhengyiLuo/AgentsDock/releases/latest/download/latest-mac.yml' })
  assert.equal((await consume(yaml)).toString(), 'version: 1.0.6\n')
  writeFileSync(join(directory, 'latest-mac.yml'), 'version: 1.0.7\n')
  await assert.rejects(createProductReplay({ ...f.options, baselineDesktopDirectory: directory, baselineVersion: '1.0.6' }), /differ/)
})

test('fault control admits one exact legacy download only and never mutates packages', async t => {
  const f = fixture(t), replay = await createProductReplay(f.options)
  const control = join(f.root, 'fault.json')
  const request = replay.inventory().find(item => item.url.endsWith('.tar.gz') && item.url.includes('/AgentsServer/'))
  const url = new URL(request.url)
  writeFileSync(control, JSON.stringify({ schema: 1, kind: 'truncate-legacy-once', sourceSha,
    releaseReceiptSha256: replay.identity.releaseReceiptSha256 }), { mode: 0o600 })
  assert.equal(await consumeReplayFault(replay, control, 'registry.npmjs.org', url.pathname), null)
  const values = await Promise.all([consumeReplayFault(replay, control, url.host, url.pathname),
    consumeReplayFault(replay, control, url.host, url.pathname)])
  assert.equal(values.filter(Boolean).length, 1)
  assert.equal(values.find(Boolean).sha256, request.sha256)
  assert.equal(await consumeReplayFault(replay, control, url.host, url.pathname), null)
  const bytes = await consume(await replay.respond({ method: 'GET', host: url.host, path: url.pathname }))
  assert.equal(hash(bytes), request.sha256)
})

test('fault contender losing after its validated read serves normally; rearming remains rejected', async t => {
  const f = fixture(t), replay = await createProductReplay(f.options)
  const control = join(f.root, 'fault.json'), consumed = `${control}.consumed`
  const request = replay.inventory().find(item => item.url.endsWith('.tar.gz') && item.url.includes('/AgentsServer/'))
  const url = new URL(request.url)
  const bytes = Buffer.from(JSON.stringify({ schema: 1, kind: 'truncate-legacy-once', sourceSha,
    releaseReceiptSha256: replay.identity.releaseReceiptSha256 }))
  writeFileSync(control, bytes, { mode: 0o600 })
  let contenderReady, resumeContender
  const ready = new Promise(resolve => { contenderReady = resolve })
  const resume = new Promise(resolve => { resumeContender = resolve })
  const contender = consumeReplayFault(replay, control, url.host, url.pathname, {
    statControl: async path => {
      if (path === consumed) { contenderReady(); await resume }
      return lstat(path)
    }
  })
  await ready
  let winner
  try { winner = await consumeReplayFault(replay, control, url.host, url.pathname) }
  finally { resumeContender() }
  assert.equal(winner.sha256, request.sha256)
  assert.equal(await contender, null)
  assert.deepEqual(readFileSync(consumed), bytes)
  await assert.rejects(lstat(control), { code: 'ENOENT' })

  writeFileSync(control, bytes, { mode: 0o600 })
  await assert.rejects(consumeReplayFault(replay, control, url.host, url.pathname), /already consumed/)
  assert.deepEqual(readFileSync(consumed), bytes)
  assert.deepEqual(readFileSync(control), bytes)
  assert.equal(hash(await consume(await replay.respond({ method: 'GET', host: url.host, path: url.pathname }))), request.sha256)
})

test('fault contender losing before its read returns null without swallowing other read errors', async t => {
  const f = fixture(t), replay = await createProductReplay(f.options)
  const control = join(f.root, 'fault.json')
  const request = replay.inventory().find(item => item.url.endsWith('.tar.gz') && item.url.includes('/AgentsServer/'))
  const url = new URL(request.url)
  writeFileSync(control, JSON.stringify({ schema: 1, kind: 'truncate-legacy-once', sourceSha,
    releaseReceiptSha256: replay.identity.releaseReceiptSha256 }), { mode: 0o600 })
  const denied = Object.assign(new Error('fixture read denial'), { code: 'EACCES' })
  await assert.rejects(consumeReplayFault(replay, control, url.host, url.pathname, {
    readControl: async () => { throw denied }
  }), error => error === denied)
  let winner
  const loser = await consumeReplayFault(replay, control, url.host, url.pathname, {
    readControl: async path => {
      winner = await consumeReplayFault(replay, control, url.host, url.pathname)
      return readFile(path)
    }
  })
  assert.equal(winner.sha256, request.sha256)
  assert.equal(loser, null)
  assert.equal(hash(await consume(await replay.respond({ method: 'GET', host: url.host, path: url.pathname }))), request.sha256)
})

test('GET, HEAD and valid single ranges preserve exact bytes; unsafe ranges fail', async t => {
  const f = fixture(t), replay = await createProductReplay(f.options)
  const path = `/ZhengyiLuo/AgentsDock/releases/download/v${f.value.version}/AgentsDock-${f.value.version}-mac-universal.zip`
  const full = await consume(await replay.respond({ method: 'GET', host: 'github.com', path }))
  for (const [range, expected] of [['bytes=0-4', full.subarray(0, 5)], ['bytes=5-', full.subarray(5)],
    ['bytes=-4', full.subarray(-4)], ['bytes=0-999999', full]]) {
    const response = await replay.respond({ method: 'GET', host: 'github.com:443', path, headers: { range } })
    assert.equal(response.status, 206)
    assert.deepEqual(await consume(response), expected)
  }
  const head = await replay.respond({ method: 'HEAD', host: 'github.com', path })
  assert.equal(head.headers['content-length'], String(full.length))
  assert.equal((await consume(head)).length, 0)
  for (const range of ['bytes=0-1,4-5', 'bytes=99999-', 'bytes=-0', 'bytes=5-4', 'bytes=9007199254740992-', 'items=0-1']) {
    const response = await replay.respond({ method: 'GET', host: 'github.com', path, headers: { range } })
    assert.equal(response.status, 416); await consume(response)
  }
})

test('refuses arbitrary hosts, routes, proxy forms, query strings, secrets and mutations', async t => {
  const f = fixture(t), replay = await createProductReplay(f.options)
  const valid = { method: 'GET', host: 'github.com', path: `/ZhengyiLuo/AgentsDock/releases/download/v${f.value.version}/beta-mac.yml` }
  const cached = await replay.respond({ ...valid, path: `${valid.path}?noCache=1abcuv09` })
  assert.equal(cached.status, 200); await consume(cached)
  for (const change of [{ method: 'POST' }, { method: 'CONNECT' }, { host: 'private.example' }, { host: 'github.com.evil' },
    { host: 'github.com:8080' }, { host: 'user:secret@github.com' }, { path: '//private.example/secret' },
    { path: 'https://github.com/private' }, { path: '/private/profile' }, { path: `${valid.path}?token=secret` },
    { path: `${valid.path}?noCache=123&other=1` }, { path: `${valid.path}?noCache=WWW` },
    { path: `${valid.path}#fragment` }, { headers: { Authorization: 'private' } }, { headers: { cookie: 'private' } },
    { path: valid.path.replace('/beta-mac.yml', '/%2e%2e/private') }]) {
    const response = await replay.respond({ ...valid, ...change })
    assert([400, 404, 405].includes(response.status)); assert.doesNotMatch((await consume(response)).toString(), /secret|private/)
  }
  const betaLatest = await replay.respond({ method: 'GET', host: 'api.github.com', path: '/repos/ZhengyiLuo/AgentsDock/releases/latest' })
  assert.equal(betaLatest.status, 404); await consume(betaLatest)
})

test('refuses wrong receipt, successful-run identity, signatures and desktop seals', async t => {
  const f = fixture(t)
  await assert.rejects(createProductReplay({ ...f.options, acceptedReceiptSha256: '0'.repeat(64) }), /accepted SHA/)
  const run = readFileSync(f.options.preparationRunPath)
  writeFileSync(f.options.preparationRunPath, JSON.stringify({ ...JSON.parse(run), conclusion: 'failure' }))
  await assert.rejects(createProductReplay(f.options), /successful canonical/)
  writeFileSync(f.options.preparationRunPath, run)
  const signature = join(f.options.serverDirectory, 'npm/agents-server-npm-manifest.sig')
  const signed = readFileSync(signature); writeFileSync(signature, Buffer.alloc(64))
  await assert.rejects(createProductReplay(f.options), /signature/)
  writeFileSync(signature, signed)
  writeFileSync(join(f.options.desktopDirectory, 'SHA256SUMS'), 'invalid\n')
  await assert.rejects(createProductReplay(f.options), /Checksum manifest/)
})

test('rehashes before serving and rejects changed assets or symlink replacement', async t => {
  const f = fixture(t), replay = await createProductReplay(f.options)
  const name = `server-${f.value.version}.tgz`, file = join(f.options.serverDirectory, 'npm', name)
  const original = readFileSync(file), request = { method: 'GET', host: 'registry.npmjs.org', path: `/@agentsdock/server/-/${name}` }
  const changed = Buffer.from(original); changed[0] ^= 1; writeFileSync(file, changed)
  await assert.rejects(replay.respond(request), /bytes changed/)
  writeFileSync(file, original.subarray(0, 4))
  await assert.rejects(replay.respond(request), /size changed/)
  rmSync(file); symlinkSync(f.options.receiptPath, file)
  await assert.rejects(replay.respond(request))
})

test('the actual metadata buffers parsed for routing must match the receipt hashes', async t => {
  const f = fixture(t)
  for (const [directory, name, expected] of [
    [f.options.serverDirectory, 'npm/agents-server-npm-manifest.json', f.value.npmManifestSha256],
    [f.options.serverDirectory, 'legacy/agents-server-manifest.json', f.value.legacyManifestSha256],
    [f.options.serverDirectory, 'product-server-bundle.json', f.value.serverBundleSha256],
    [f.options.desktopDirectory, 'SHA256SUMS', f.value.desktopManifestSha256]
  ]) {
    const path = join(directory, name), original = readFileSync(path)
    assert.deepEqual(await readReplayMetadata(path, expected), original)
    writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]))
    await assert.rejects(readReplayMetadata(path, expected), /metadata bytes differ/)
  }
})

test('response bodies and returned inventory cannot mutate future responses', async t => {
  const f = fixture(t), replay = await createProductReplay(f.options)
  const request = { method: 'GET', host: 'github.com', path: '/ZhengyiLuo/AgentsDock/releases.atom' }
  const first = await consume(await replay.respond(request)), expected = hash(first)
  first.fill(0)
  replay.inventory()[0].sha256 = '0'.repeat(64)
  assert.equal(hash(await consume(await replay.respond(request))), expected)
})

test('arguments and hosted-runner restriction fail before certificate reads or listener creation', async () => {
  const args = ['inspect', '--receipt', '/fixture/receipt', '--receipt-sha256', 'a'.repeat(64), '--prepare-run', '/fixture/run',
    '--server-assets', '/fixture/server', '--desktop-assets', '/fixture/desktop']
  assert.equal(parseReplayArguments(args).operation, 'inspect')
  for (const extra of [['--port', '443'], ['--proxy', 'https://private'], ['--receipt', '/other'], ['--unknown']]) {
    assert.throws(() => parseReplayArguments([...args, ...extra]))
  }
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', GITHUB_SHA: sourceSha,
    RUNNER_TEMP: '/disposable/runner', GITHUB_REPOSITORY: 'ZhengyiLuo/AgentsDock',
    GITHUB_WORKFLOW_REF: 'ZhengyiLuo/AgentsDock/.github/workflows/product-release-acceptance.yml@refs/heads/release/test' }
  assert.doesNotThrow(() => assertReplayRunner(env, 'darwin'))
  for (const change of [{ GITHUB_ACTIONS: '' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY: 'fork/AgentsDock' },
    { RUNNER_TEMP: '/' }, { GITHUB_WORKFLOW_REF: 'unreviewed' }, { GITHUB_SHA: 'main' }]) {
    assert.throws(() => assertReplayRunner({ ...env, ...change }, 'darwin'))
  }
  const child = spawnSync(process.execPath, [resolve(import.meta.dirname, '../product-release-replay.mjs'), 'serve', ...args.slice(1),
    '--certificate', '/does-not-exist', '--private-key', '/does-not-exist'], {
    env: { ...process.env, GITHUB_ACTIONS: '' }, encoding: 'utf8', timeout: 5000
  })
  assert.equal(child.status, 1)
  assert.equal(child.stderr, '')
  const diagnostics = parseReplayStartupDiagnostics(child.stdout)
  assert.deepEqual(diagnostics.map(({ stage, status }) => ({ stage, status })), [
    { stage: 'arguments', status: 'entered' }, { stage: 'runner-guard', status: 'entered' },
    { stage: 'runner-guard', status: 'failed' }
  ])
  assert(diagnostics.every(record => record.releaseAcceptance === false))
  assert(!child.stdout.includes('/does-not-exist'))
  await assert.rejects(serveProductReplay({ identity: { sourceSha } }, { certificatePath: '/never-read', privateKeyPath: '/never-read' }), /restricted/)
  assert.throws(() => parseReplayRange('bytes=1-2\n', 10))
})

test('startup diagnostics contain only finite public phases and safe codes, never exception content', () => {
  let output = ''
  const diagnostics = createReplayStartupDiagnostics(line => { output += line })
  diagnostics.stage('arguments'); diagnostics.stage('runner-guard'); diagnostics.stage('listener-bind')
  diagnostics.failure(Object.assign(new Error('private-token and /private/key.pem'), {
    code: 'EADDRINUSE', stderr: Buffer.from('private subprocess output'), command: 'secret command'
  }))
  const records = parseReplayStartupDiagnostics(Buffer.from(output))
  assert.equal(records.at(-1).stage, 'listener-bind')
  assert.equal(records.at(-1).code, 'EADDRINUSE')
  assert(!/private|secret|command|stderr/.test(output))
  assert.throws(() => diagnostics.stage('serving'), /phase transition/)
  const before = output
  diagnostics.failure(new Error('extra failure'))
  assert.equal(output, before)
  let unknown = ''
  const rejected = createReplayStartupDiagnostics(line => { unknown += line })
  rejected.stage('arguments'); rejected.failure({ code: 'token=private' })
  assert.equal(parseReplayStartupDiagnostics(unknown).at(-1).code, 'STARTUP_REJECTED')
  assert(!unknown.includes('private'))
})

test('startup parser rejects oversized, raw, extra-field and out-of-order logs', () => {
  let valid = ''
  const diagnostics = createReplayStartupDiagnostics(line => { valid += line })
  diagnostics.stage('arguments'); diagnostics.stage('runner-guard'); diagnostics.stage('serving')
  assert.equal(parseReplayStartupDiagnostics(valid).at(-1).status, 'ready')
  const records = parseReplayStartupDiagnostics(valid)
  const serialize = value => value.map(record => JSON.stringify(record)).join('\n') + '\n'
  for (const invalid of [Buffer.alloc(32769), '', 'raw stderr with secret', `${valid}private log\n`,
    serialize(records.map(record => ({ ...record, raw: 'secret' }))),
    serialize(records.map(record => ({ ...record, sequence: 1 }))),
    serialize(records.map(record => ({ ...record, stage: 'private/path' }))),
    serialize(records.map(record => ({ ...record, releaseAcceptance: true }))),
    serialize([...records, { ...records[0], sequence: 4 }]),
    serialize([records[0], { ...records[1], status: 'failed', code: 'UNTRUSTED_CODE' }]),
    serialize([records[0], { ...records[1], status: 'failed', code: 'EACCES' }])]) {
    assert.throws(() => parseReplayStartupDiagnostics(invalid))
  }
})

test('CI readiness diagnostics parse bounded safe records and never print the raw replay log', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/ci.yml'), 'utf8')
  assert.match(workflow, /parseReplayStartupDiagnostics/)
  assert.match(workflow, /O_NOFOLLOW/)
  assert.match(workflow, /32769/)
  assert.match(workflow, /launcherPresent/)
  assert.match(workflow, /parseReplayProbeDiagnostics/)
  assert.match(workflow, /--cacert "\$RUNNER_TEMP\/agentsdock-acceptance-network\/ca\.pem"/)
  assert(!/\b(?:cat|tail|head)\b[^\n]*replay\.log/.test(workflow))
})

test('post-bind startup failure always closes listener and connections before rejection (inert server mock)', async () => {
  for (const code of ['EPERM', 'EACCES']) {
    const calls = [], failure = Object.assign(new Error('private native detail'), { code })
    const server = { closeAllConnections: () => calls.push('connections-closed'),
      close: callback => { calls.push('listener-closed'); callback() } }
    await assert.rejects(finalizeReplayListener(server, async () => { calls.push('initialize'); throw failure }),
      error => error === failure)
    assert.deepEqual(calls, ['initialize', 'connections-closed', 'listener-closed'])
  }
  let closed = false
  const server = { closeAllConnections: () => { closed = true }, close: callback => callback() }
  assert.equal(await finalizeReplayListener(server, async () => {}), server)
  assert.equal(closed, false)
})

test('readiness requires finite ready record, private owned PID and exact process (injected ps observation)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agentsdock-replay-readiness-unit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const logPath = join(root, 'replay.log'), pidPath = join(root, 'replay.pid')
  const nodeProbe = { kind: 'replay-origin-probe', verified: true, code: 'VERIFIED', remoteIp: '127.0.0.1',
    tlsAuthorized: true, leafMatched: true, httpCode: 200, replayMarker: true, bodyBytes: 1,
    bodySha256: 'a'.repeat(64), leafSha256: 'b'.repeat(64) }
  const paths = { logPath, pidPath, nodeProbe }
  let ready = ''
  const diagnostics = createReplayStartupDiagnostics(line => { ready += line })
  diagnostics.stage('arguments'); diagnostics.stage('serving')
  writeFileSync(logPath, ready)
  writeFileSync(pidPath, '12345\n', { mode: 0o600 })
  const command = `${process.execPath} scripts/product-release-replay.mjs serve --scope candidate --private-key ${join(root, 'leaf.key')} --pid-file ${pidPath}`
  const observed = `12345 ${process.getuid()} ${command}\n`
  assert.deepEqual(await assertReplayReadiness(paths, { queryProcess: pid => {
    assert.equal(pid, 12345); return observed
  } }), { ready: true, pid: 12345 })
  await assert.rejects(assertReplayReadiness({ ...paths, nodeProbe: { kind: 'replay-origin-probe', verified: false, code: 'TLS_UNAUTHORIZED' } },
    { queryProcess: () => { throw new Error('must not query') } }), /HTTPS probe/)
  for (const output of ['12345 0 arbitrary-command\n', observed.replace('12345', '12346'),
    observed.replace(' serve ', ' inspect '), observed.replace(pidPath, `${pidPath}-other`),
    observed.replace(process.execPath, '/untrusted/node'), `${observed}unexpected second process\n`, 'x'.repeat(8193)]) {
    await assert.rejects(assertReplayReadiness(paths, { queryProcess: () => output }))
  }
  chmodSync(pidPath, 0o644)
  await assert.rejects(assertReplayReadiness(paths), /private/)
  chmodSync(pidPath, 0o600)
  writeFileSync(logPath, ready.split('\n')[0] + '\n')
  await assert.rejects(assertReplayReadiness(paths), /not completed/)
  writeFileSync(logPath, Buffer.alloc(32769))
  await assert.rejects(assertReplayReadiness(paths), /bounded/)
  rmSync(logPath); symlinkSync(pidPath, logPath)
  await assert.rejects(assertReplayReadiness(paths))
})

test('probe diagnostics expose only numeric TLS/HTTP status, validated IP and exact marker', () => {
  const headers = 'HTTP/1.1 200 OK\r\nX-AgentsDock-Replay: test-only\r\nAuthorization: private-token\r\n\r\n'
  assert.deepEqual(parseReplayProbeDiagnostics('127.0.0.1|0|200\n', headers), {
    remoteIp: '127.0.0.1', sslVerifyResult: 0, httpCode: 200, replayMarker: true
  })
  assert.deepEqual(parseReplayProbeDiagnostics('|0|000\n', ''), {
    remoteIp: null, sslVerifyResult: 0, httpCode: 0, replayMarker: false
  })
  assert.deepEqual(parseReplayProbeDiagnostics('::1|20|000\n', ''), {
    remoteIp: '::1', sslVerifyResult: 20, httpCode: 0, replayMarker: false
  })
  assert.equal(parseReplayProbeDiagnostics('127.0.0.1|0|200\n', headers.replace('test-only', 'other')).replayMarker, false)
  assert.equal(parseReplayProbeDiagnostics('127.0.0.1|0|200\n', headers.replace('Authorization: private-token',
    'x-agentsdock-replay: test-only')).replayMarker, false)
  for (const metadata of ['private-token|0|200\n', '999.0.0.1|0|200\n', 'a:b|0|200\n',
    '127.0.0.1|-1|200\n', '127.0.0.1|256|200\n', '127.0.0.1|0|600\n', '127.0.0.1|0|200\nsecret', 'x'.repeat(129)]) {
    assert.throws(() => parseReplayProbeDiagnostics(metadata, headers))
  }
  for (const badHeaders of ['private-token', 'HTTP/1.1 200 OK\r\nAuthorization: bad\0value\r\n', 'x'.repeat(32769)]) {
    assert.throws(() => parseReplayProbeDiagnostics('127.0.0.1|0|200\n', badHeaders))
  }
  assert.throws(() => parseReplayProbeDiagnostics('127.0.0.1|0|200\n', headers.replace('200 OK', '404 Not Found')), /status differs/)
})

function originProbeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agentsdock-origin-probe-unit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const caPath = join(root, 'ca.pem'), expectedLeafPath = join(root, 'leaf.pem')
  const execute = (...args) => execFileSync('openssl', args, { cwd: root,
    env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
  writeFileSync(join(root, 'ca.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Disposable unit CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n')
  writeFileSync(join(root, 'leaf.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=github.com\n')
  writeFileSync(join(root, 'leaf.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:github.com\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
  execute('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=Disposable unit CA',
    '-config', 'ca.cnf', '-keyout', 'ca.key', '-out', 'ca.pem')
  execute('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=github.com',
    '-config', 'leaf.cnf', '-keyout', 'leaf.key', '-out', 'leaf.csr')
  execute('x509', '-req', '-sha256', '-days', '1', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
    '-extfile', 'leaf.ext', '-out', 'leaf.pem')
  chmodSync(caPath, 0o600); chmodSync(expectedLeafPath, 0o600)
  return { root, caPath, expectedLeafPath, raw: new X509Certificate(readFileSync(expectedLeafPath)).raw }
}

test('Node origin probe preserves native TLS verification and exact peer/leaf/body constraints (inert transport)', async t => {
  const f = originProbeFixture(t)
  let requestCount = 0
  const run = async (change = {}) => probeReplayOrigin(f, {
    lookup: async (name, options) => { assert.equal(name, 'github.com'); assert.equal(options.family, 4)
      return change.dns ?? { address: '127.0.0.1', family: 4 } },
    request: (url, options, callback) => {
      requestCount++
      assert.equal(url, 'https://github.com/ZhengyiLuo/AgentsDock/releases.atom')
      assert.equal(options.rejectUnauthorized, true)
      assert.equal(options.checkServerIdentity, checkServerIdentity)
      assert.equal(options.servername, 'github.com')
      assert.equal(options.agent, false)
      assert.equal(options.autoSelectFamily, false)
      assert.deepEqual(Object.keys(options).sort(), ['ca', 'rejectUnauthorized', 'checkServerIdentity', 'servername', 'family',
        'autoSelectFamily', 'agent', 'headers', 'lookup'].sort())
      assert.deepEqual(options.ca, readFileSync(f.caPath))
      options.lookup('github.com', {}, (error, ip, family) => { assert.equal(error, null); assert.equal(ip, '127.0.0.1'); assert.equal(family, 4) })
      options.lookup('untrusted.example', {}, error => assert.equal(error.code, 'DNS_NOT_LOOPBACK'))
      const req = new EventEmitter()
      req.destroy = () => {}
      req.end = () => queueMicrotask(() => {
        if (change.timeout) return
        if (change.error) { req.emit('error', Object.assign(new Error('private raw detail'), { code: change.error })); return }
        const response = Readable.from([change.body ?? Buffer.from('<feed/>')])
        response.statusCode = change.httpCode ?? 200
        response.rawHeaders = change.headers ?? ['X-AgentsDock-Replay', 'test-only']
        response.socket = { authorized: change.authorized ?? true, remoteAddress: change.peer ?? '127.0.0.1',
          getPeerCertificate: () => ({ raw: change.raw ?? f.raw }) }
        callback(response)
      })
      return req
    }
  })
  const success = parseReplayOriginProbe(JSON.stringify(await run()))
  assert.equal(success.verified, true); assert.equal(success.bodySha256, hash('<feed/>'))
  assert.equal(success.leafSha256, hash(f.raw))
  for (const [change, code] of [
    [{ authorized: false }, 'TLS_UNAUTHORIZED'], [{ peer: '192.0.2.1' }, 'PEER_NOT_LOOPBACK'],
    [{ raw: Buffer.from('different certificate') }, 'LEAF_MISMATCH'], [{ httpCode: 302 }, 'RESPONSE_REJECTED'],
    [{ headers: [] }, 'RESPONSE_REJECTED'], [{ headers: ['x-agentsdock-replay', 'test-only', 'X-AgentsDock-Replay', 'test-only'] }, 'RESPONSE_REJECTED'],
    [{ headers: [null, 'private'] }, 'RESPONSE_REJECTED'],
    [{ body: Buffer.alloc(32769) }, 'BODY_REJECTED'], [{ body: Buffer.alloc(0) }, 'BODY_REJECTED'],
    [{ error: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'],
    [{ error: 'secret-token' }, 'PROBE_FAILED']]) {
    assert.deepEqual(parseReplayOriginProbe(JSON.stringify(await run(change))), { kind: 'replay-origin-probe', verified: false, code })
  }
  const before = requestCount
  assert.equal((await run({ dns: { address: '192.0.2.1', family: 4 } })).code, 'DNS_NOT_LOOPBACK')
  assert.equal(requestCount, before)
  assert.equal((await run({ timeout: true })).code, 'TIMEOUT')
  const afterTimeout = requestCount
  const other = originProbeFixture(t)
  const original = readFileSync(f.caPath)
  writeFileSync(f.caPath, readFileSync(other.caPath))
  assert.equal((await run()).code, 'CHAIN_REJECTED')
  assert.equal(requestCount, afterTimeout)
  writeFileSync(f.caPath, original)
  chmodSync(f.caPath, 0o644)
  assert.equal((await run()).code, 'INPUT_REJECTED')
  assert.equal(requestCount, afterTimeout)
})

test('origin result parser refuses unbounded/raw/private fields and forged partial success', () => {
  const failure = { kind: 'replay-origin-probe', verified: false, code: 'CERT_HAS_EXPIRED' }
  assert.deepEqual(parseReplayOriginProbe(JSON.stringify(failure)), failure)
  for (const value of [{ ...failure, message: 'private' }, { ...failure, code: 'secret-token' },
    { ...failure, code: 'VERIFIED' }, { ...failure, verified: true }, { ...failure, verified: 'false' }]) {
    assert.throws(() => parseReplayOriginProbe(JSON.stringify(value)))
  }
  assert.throws(() => parseReplayOriginProbe('private stderr'))
  assert.throws(() => parseReplayOriginProbe(Buffer.alloc(2049)))
})
