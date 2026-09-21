import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyLegacyBridge, verifyPublishedServerPaths } from '../coordinated-release.mjs'

const VERSION = '1.0.4-beta.12'
function fixture(t, mutation = '') {
  const directory = mkdtempSync(join(tmpdir(), 'agentsdock-runtime-parity-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  execFileSync('python3', ['-c', `
import io,sys,tarfile
from pathlib import Path
root=Path(sys.argv[1]); version=sys.argv[2]; mutation=sys.argv[3]
runtime={'VERSION':(version+'\\n').encode(),'agent_server.py':b'new ensure-capable server','update_runner.py':b'new npm updater','install.sh':b'installer','release-public-key.pem':b'public key'}
for npm in [True,False]:
    with tarfile.open(root/('npm.tgz' if npm else 'legacy.tar.gz'),'w:gz',format=tarfile.PAX_FORMAT) as archive:
        payload=dict(runtime)
        if not npm and mutation=='bytes': payload['agent_server.py']=b'old server without ensure'
        if not npm and mutation=='missing': del payload['agent_server.py']
        if not npm and mutation=='extra': payload['extra.py']=b'other source'
        for name,data in payload.items():
            prefix='package/server/' if npm else 'agents-server-'+version+'/'
            member=tarfile.TarInfo(prefix+name); member.size=len(data); member.mode=0o755 if name in {'install.sh','update_runner.py'} else 0o644
            if not npm and mutation=='mode' and name=='install.sh': member.mode=0o644
            archive.addfile(member,io.BytesIO(data))
        if not npm and mutation=='link':
            member=tarfile.TarInfo('agents-server-'+version+'/linked'); member.type=tarfile.SYMTYPE; member.linkname='/etc/passwd'; archive.addfile(member)
        if not npm and mutation=='traversal':
            member=tarfile.TarInfo('agents-server-'+version+'/../escape'); member.size=1; archive.addfile(member,io.BytesIO(b'x'))
        if npm:
            for name in ['package.json','README.md','LICENSE','NOTICE','npm/cli.cjs']:
                member=tarfile.TarInfo('package/'+name); member.size=1; member.mode=0o644; archive.addfile(member,io.BytesIO(b'x'))
`, directory, VERSION, mutation])
  const npmBytes = readFileSync(join(directory, 'npm.tgz')), legacyBytes = readFileSync(join(directory, 'legacy.tar.gz'))
  const sha256 = value => createHash('sha256').update(value).digest('hex')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const npm = { version: VERSION, track: 'beta', api_contract_version: 28, commit: 'a'.repeat(40), npm: { integrity: `sha512-${createHash('sha512').update(npmBytes).digest('base64')}` }, archive: { url: `https://registry.npmjs.org/@agentsdock/server/-/server-${VERSION}.tgz`, size: npmBytes.length, sha256: sha256(npmBytes) } }
  const legacy = { schema: 1, version: VERSION, track: 'beta', prerelease: true, api_contract_version: 28, commit: 'b'.repeat(40), archive: { name: `agents-server-${VERSION}.tar.gz`, url: `https://github.com/ZhengyiLuo/AgentsServer/releases/download/v${VERSION}/agents-server-${VERSION}.tar.gz`, size: legacyBytes.length, sha256: sha256(legacyBytes) } }
  const bytes = Buffer.from(JSON.stringify(legacy)), signature = sign(null, bytes, privateKey)
  const root = `https://github.com/ZhengyiLuo/AgentsServer/releases/download/v${VERSION}/agents-server-manifest`
  const replies = new Map([[npm.archive.url, npmBytes], [`${root}.json`, bytes], [`${root}.sig`, signature], [legacy.archive.url, legacyBytes]])
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push(url)
    assert.deepEqual(options.headers, { Accept: 'application/octet-stream' })
    assert.equal(options.redirect, url.startsWith('https://registry.npmjs.org/') ? 'error' : 'manual')
    if (!replies.has(url)) return new Response('', { status: 404 })
    const payload = replies.get(url)
    return new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < payload.length; offset += 37) controller.enqueue(payload.subarray(offset, offset + 37))
      controller.close()
    } }))
  }
  return { npm, legacy, bytes, signature, replies, requests, fetchImpl, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey }
}

test('final public gate proves npm and signed legacy bridge contain the exact same runtime despite export commit differences', async t => {
  const f = fixture(t)
  const result = await verifyPublishedServerPaths(f.npm, f)
  assert.deepEqual(result, { runtime_files: 5, version: VERSION, identical: true })
  assert.equal(f.requests.length, 4)
})

test('final public gate rejects missing bridge, invalid signature, altered archive and runtime differences', async t => {
  for (const mutation of ['missing-public', 'signature', 'archive', 'bytes', 'missing', 'extra', 'mode', 'link', 'traversal']) {
    const f = fixture(t, mutation)
    if (mutation === 'missing-public') f.replies.delete([...f.replies.keys()].find(url => url.endsWith('.json')))
    if (mutation === 'signature') f.replies.set([...f.replies.keys()].find(url => url.endsWith('.sig')), Buffer.alloc(64))
    if (mutation === 'archive') f.replies.set(f.legacy.archive.url, Buffer.alloc(f.legacy.archive.size))
    await assert.rejects(verifyPublishedServerPaths(f.npm, f), /not publicly available|signature|signed size or hash|runtime/)
  }
})

test('bridge signature envelope pins version, track, API and canonical standalone location', t => {
  const f = fixture(t)
  for (const change of [v => { v.version = '1.0.4-beta.9' }, v => { v.track = 'stable' }, v => { v.api_contract_version = 27 }, v => { v.schema = 2 }, v => { v.archive.url = 'https://example.com/archive' }]) {
    const value = structuredClone(f.legacy); change(value)
    const bytes = Buffer.from(JSON.stringify(value)), signature = sign(null, bytes, f.privateKey)
    assert.throws(() => verifyLegacyBridge(bytes, signature, f.npm, f.publicKey), /differs|identity/)
  }
})

test('public bridge fetch follows only bounded HTTPS GitHub asset redirects without credentials', async t => {
  const f = fixture(t)
  const baseline = f.fetchImpl
  f.fetchImpl = async (url, options) => {
    if (url === f.legacy.archive.url) return new Response('', { status: 302, headers: { location: 'https://example.com/not-github' } })
    return baseline(url, options)
  }
  await assert.rejects(verifyPublishedServerPaths(f.npm, f), /outside trusted public GitHub/)
})

test('public bridge GitHub CDN redirects retain exact streamed archive verification', async t => {
  const f = fixture(t), baseline = f.fetchImpl
  const cdn = 'https://release-assets.githubusercontent.com/synthetic/archive?temporary=public'
  f.replies.set(cdn, f.replies.get(f.legacy.archive.url))
  f.fetchImpl = async (url, options) => url === f.legacy.archive.url
    ? new Response('', { status: 302, headers: { location: cdn } }) : baseline(url, options)
  assert.equal((await verifyPublishedServerPaths(f.npm, f)).identical, true)
})
