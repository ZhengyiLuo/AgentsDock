import { createHash, generateKeyPairSync, sign } from 'node:crypto'
export function signedFixture(overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const payload = Buffer.from('synthetic reviewed npm payload')
  const version = '1.0.0-beta.1', track = 'beta', sourceSha = 'a'.repeat(40)
  const descriptor = { schema: 2, distribution: 'npm', version, track, prerelease: true, commit: sourceSha, api_contract_version: 28, minimum_server_api_contract: 8,
    npm: { name: '@agentsdock/server', version, integrity: `sha512-${createHash('sha512').update(payload).digest('base64')}` },
    archive: { name: `server-${version}.tgz`, url: `https://registry.npmjs.org/@agentsdock/server/-/server-${version}.tgz`, sha256: createHash('sha256').update(payload).digest('hex'), size: payload.length }, ...overrides }
  const bytes = Buffer.from(JSON.stringify(descriptor) + '\n'), signature = sign(null, bytes, privateKey)
  return { descriptor, payload, bytes, signature, identity: { version, track, sourceSha, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) } }
}
