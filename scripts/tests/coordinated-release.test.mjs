import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { signedFixture } from './coordinated-release-fixture.mjs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { COORDINATED_ASSETS, decodeCoordinatedInputs, verifyCoordinatedBytes, verifyCoordinatedDirectory, verifyRegistryPayload } from '../coordinated-release.mjs'


test('decodes exact optional public inputs, validates signature and preserves raw bytes', t => {
  const value = signedFixture()
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-pair-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  assert.equal(decodeCoordinatedInputs('', '', value.identity, directory), false)
  assert.deepEqual(decodeCoordinatedInputs(value.bytes.toString('base64'), value.signature.toString('base64'), value.identity, directory), value.descriptor)
  assert.deepEqual(readFileSync(join(directory, COORDINATED_ASSETS[0])), value.bytes)
  assert.deepEqual(readFileSync(join(directory, COORDINATED_ASSETS[1])), value.signature)
  assert.deepEqual(verifyCoordinatedDirectory(directory, value.identity), value.descriptor)
  assert.throws(() => decodeCoordinatedInputs(value.bytes.toString('base64'), value.signature.toString('base64'), value.identity, directory), /EEXIST/)
})

test('rejects one missing input, noncanonical or oversized base64 before writing', () => {
  const f = signedFixture(), b64 = f.bytes.toString('base64'), sig = f.signature.toString('base64')
  for (const [a, b] of [[b64, ''], ['', sig], [b64 + '\n', sig], ['x'.repeat(12000), sig]]) assert.throws(() => decodeCoordinatedInputs(a, b, f.identity, '/nonexistent-output'), /both|base64|limit/)
})

test('rejects invalid signature, source, version and API contract envelopes', () => {
  const f = signedFixture()
  assert.throws(() => verifyCoordinatedBytes(Buffer.concat([f.bytes, Buffer.from(' ')]), f.signature, f.identity), /signature/)
  assert.throws(() => verifyCoordinatedBytes(Buffer.alloc(8193), f.signature, f.identity), /size/)
  assert.throws(() => verifyCoordinatedBytes(f.bytes, f.signature.subarray(1), f.identity), /size/)
  assert.throws(() => verifyCoordinatedBytes(f.bytes, f.signature, { ...f.identity, sourceSha: 'b'.repeat(40) }), /source/)
  assert.throws(() => verifyCoordinatedBytes(f.bytes, f.signature, { ...f.identity, version: '1.0.0-beta.2' }), /version/)
  for (const overrides of [{ minimum_server_api_contract: 29 }, { minimum_server_api_contract: 0 }, { api_contract_version: 28.1 }, { distribution: 'github' }, { npm: { ...f.descriptor.npm, version: '1.0.0' } }, { archive: { ...f.descriptor.archive, url: 'https://example.com/payload' } }]) {
    const invalid = signedFixture(overrides)
    assert.throws(() => verifyCoordinatedBytes(invalid.bytes, invalid.signature, invalid.identity), /API|version|npm/)
  }
})

test('requires the exact published npm tarball bytes with no redirects or registry credentials', async () => {
  const f = signedFixture()
  await verifyRegistryPayload(f.descriptor, async (url, options) => {
    assert.equal(url, f.descriptor.archive.url)
    assert.equal(options.redirect, 'error')
    assert.deepEqual(options.headers, { Accept: 'application/octet-stream' })
    assert.ok(options.signal)
    return new Response(f.payload)
  })
  await assert.rejects(verifyRegistryPayload(f.descriptor, async () => new Response('', { status: 404 })), /publicly available/)
  await assert.rejects(verifyRegistryPayload(f.descriptor, async () => new Response(Buffer.alloc(f.payload.length + 1))), /exceeds/)
  await assert.rejects(verifyRegistryPayload(f.descriptor, async () => new Response(Buffer.alloc(f.payload.length))), /differs/)
  await assert.rejects(verifyRegistryPayload(f.descriptor, async () => new Response(f.payload.subarray(1))), /differs/)
})

test('production CLI resolves the tracked public trust root from a foreign working directory', t => {
  const f = signedFixture()
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-default-trust-root-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const helper = new URL('../coordinated-release.mjs', import.meta.url)
  const env = { ...process.env, RELEASE_VERSION: f.identity.version, RELEASE_TRACK: f.identity.track, SOURCE_SHA: f.identity.sourceSha, COORDINATED_MANIFEST_BASE64: f.bytes.toString('base64'), COORDINATED_SIGNATURE_BASE64: f.signature.toString('base64') }
  const result = spawnSync(process.execPath, [helper.pathname, 'prepare', join(directory, 'output')], { cwd: directory, env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  // Reaching cryptographic rejection proves the production default loaded its
  // tracked Ed25519 key, rather than using the CWD or an injected fixture key.
  assert.match(result.stderr, /^Invalid coordinated release signature\.\n$/)
  assert.doesNotMatch(result.stderr, /ENOENT|no such file|Invalid key/)
})
