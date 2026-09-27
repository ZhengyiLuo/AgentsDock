import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { expectedAssets } from '../direct-release-mirror.mjs'
import { assertReplayRunner, consumeReplayFault, createCandidateReplay, createProductReplay, parseReplayArguments, parseReplayRange, readReplayMetadata, serveProductReplay } from '../product-release-replay.mjs'
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

function scopedFixture(t) {
  const f = fixture(t), names = candidateAssets(f.value.version, 'beta'), desktopAssets = {}
  for (const name of expectedAssets(f.value.version, 'beta', true)) {
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

test('candidate verifies original signer transport and every macOS artifact hash', async t => {
  const f = scopedFixture(t)
  const inspect = () => inspectCandidate({ ...f.options, receiptSha256: f.options.acceptedReceiptSha256 })
  await inspect()
  writeFileSync(join(f.root, 'signer-artifact.zip'), 'different')
  await assert.rejects(inspect, /signing artifact/)
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
  assert.match(child.stderr, /No acceptance result was produced/)
  assert.equal(child.stdout, '')
  await assert.rejects(serveProductReplay({ identity: { sourceSha } }, { certificatePath: '/never-read', privateKeyPath: '/never-read' }), /restricted/)
  assert.throws(() => parseReplayRange('bytes=1-2\n', 10))
})
