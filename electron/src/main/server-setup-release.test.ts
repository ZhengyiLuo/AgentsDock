// @vitest-environment node
import { sign, type KeyObject } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveServerSetupRelease, serverSetupVersionGuard } from './server-setup-release'

const signing = vi.hoisted(() => ({ privateKey: null as KeyObject | null }))
vi.mock('./coordinated-updates', async importOriginal => {
  const original = await importOriginal<typeof import('./coordinated-updates')>()
  const { generateKeyPairSync } = await import('node:crypto')
  const keys = generateKeyPairSync('ed25519')
  signing.privateKey = keys.privateKey
  return { ...original, SERVER_RELEASE_PUBLIC_KEY: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString() }
})

const releases = 'https://github.com/ZhengyiLuo/AgentsServer/releases'
const api = 'https://api.github.com/repos/ZhengyiLuo/AgentsServer/releases?per_page=100'
function fixture(version = '1.0.3', overrides: Record<string, unknown> = {}) {
  const archive = { name: `agents-server-${version}.tar.gz`, url: `${releases}/download/v${version}/agents-server-${version}.tar.gz`, sha256: 'a'.repeat(64), size: 1024 }
  const bytes = Buffer.from(JSON.stringify({ schema: 1, version, track: version.includes('-') ? 'beta' : 'stable', prerelease: version.includes('-'), archive, ...overrides }))
  const signature = sign(null, bytes, signing.privateKey!)
  const responses = new Map<string, Buffer | string | number>()
  for (const root of [`${releases}/latest/download`, `${releases}/download/v${version}`]) {
    responses.set(`${root}/agents-server-manifest.json`, bytes)
    responses.set(`${root}/agents-server-manifest.sig`, signature)
  }
  const fetcher = vi.fn<typeof fetch>(async input => {
    const value = responses.get(String(input))
    if (value === undefined) throw new Error(`Unexpected request: ${input}`)
    return typeof value === 'number' ? new Response('', { status: value })
      : new Response(typeof value === 'string' ? value : Uint8Array.from(value))
  })
  return { responses, fetcher, archive }
}

describe('guided setup signed release discovery', () => {
  it.skipIf(process.platform === 'win32')('runs the host guard in a real shell and blocks older Beta installation while allowing fresh, equal and newer versions', () => {
    const installRoot = mkdtempSync(join(tmpdir(), 'agentsdock-version-guard-'))
    const current = join(installRoot, 'current')
    const script = serverSetupVersionGuard({ track: 'beta', version: '1.0.4-beta.10', url: '', sha256: '' })
    const run = () => spawnSync('/bin/sh', ['-s'], {
      input: script, encoding: 'utf8', env: { PATH: process.env.PATH, AGENTS_SERVER_INSTALL_DIR: installRoot }
    })
    try {
      expect(run().status).toBe(0)
      mkdirSync(current, { recursive: true })
      for (const version of ['1.0.4', '1.0.5', '1.0.4-beta.11']) {
        writeFileSync(join(current, 'VERSION'), `${version}\n`)
        const result = run()
        expect(result.status).toBe(78)
        expect(result.stderr).toContain(`Refusing to downgrade AgentsServer ${version}`)
      }
      for (const version of ['1.0.3', '1.0.4-beta.2', '1.0.4-beta.10']) {
        writeFileSync(join(current, 'VERSION'), `${version}\n`)
        expect(run().status).toBe(0)
      }
    } finally { rmSync(installRoot, { recursive: true, force: true }) }
  })

  it('resolves Stable through the public latest endpoint and verifies the immutable signed release', async () => {
    const f = fixture()
    expect(await resolveServerSetupRelease('stable', undefined, f.fetcher)).toEqual({
      track: 'stable', version: '1.0.3', url: f.archive.url, sha256: f.archive.sha256
    })
    expect(f.fetcher.mock.calls.map(call => call[0])).toEqual([
      `${releases}/latest/download/agents-server-manifest.json`, `${releases}/latest/download/agents-server-manifest.sig`,
      `${releases}/download/v1.0.3/agents-server-manifest.json`, `${releases}/download/v1.0.3/agents-server-manifest.sig`
    ])
  })

  it('selects the latest Beta semantically and ignores drafts and stable releases', async () => {
    const f = fixture('1.0.4-beta.10')
    f.responses.set(api, JSON.stringify([
      { tag_name: 'v2.0.0', prerelease: false },
      { tag_name: 'v1.0.4-beta.2', prerelease: true },
      { tag_name: 'v1.0.4-beta.11', prerelease: true, draft: true },
      { tag_name: 'v1.0.4-beta.10', prerelease: true }
    ]))
    expect(await resolveServerSetupRelease('beta', undefined, f.fetcher)).toMatchObject({ version: '1.0.4-beta.10', track: 'beta' })
    expect(f.fetcher).toHaveBeenCalledTimes(3)
  })

  it('uses public release links when Beta discovery is rate limited, then still requires the signed immutable pair', async () => {
    const f = fixture('1.0.4-beta.10')
    f.responses.set(api, 429)
    f.responses.set(releases, '<a href="/ZhengyiLuo/AgentsServer/releases/tag/v1.0.4-beta.2">Older</a><a href="/ZhengyiLuo/AgentsServer/releases/tag/v1.0.4-beta.10">Beta</a>')
    expect(await resolveServerSetupRelease('beta', undefined, f.fetcher)).toMatchObject({ version: '1.0.4-beta.10' })
  })

  it('rejects a tampered immutable descriptor without falling back to the discovered or obsolete release', async () => {
    const f = fixture()
    f.responses.set(`${releases}/download/v1.0.3/agents-server-manifest.json`, '{}')
    await expect(resolveServerSetupRelease('stable', undefined, f.fetcher)).rejects.toThrow('signature is invalid')
    expect(f.fetcher).toHaveBeenCalledTimes(4)
  })

  it('rejects signed metadata for another channel or an arbitrary archive location', async () => {
    const wrongChannel = fixture('1.0.4-beta.10')
    await expect(resolveServerSetupRelease('stable', undefined, wrongChannel.fetcher)).rejects.toThrow('selected version and channel')
    const wrongArchive = fixture('1.0.3', { archive: { name: 'agents-server-1.0.3.tar.gz', url: 'https://example.com/installer', sha256: 'a'.repeat(64), size: 1024 } })
    await expect(resolveServerSetupRelease('stable', undefined, wrongArchive.fetcher)).rejects.toThrow('archive metadata is invalid')
    const unsafeVersion = fixture('1.0.3\n')
    await expect(resolveServerSetupRelease('stable', undefined, unsafeVersion.fetcher)).rejects.toThrow('selected version and channel')
  })

  it('bounds metadata and honors cancellation before sending any request', async () => {
    const f = fixture()
    f.responses.set(`${releases}/latest/download/agents-server-manifest.json`, 'x'.repeat(8193))
    await expect(resolveServerSetupRelease('stable', undefined, f.fetcher)).rejects.toThrow('size limit')
    f.fetcher.mockClear()
    const controller = new AbortController()
    controller.abort(new Error('Cancelled by user'))
    await expect(resolveServerSetupRelease('stable', controller.signal, f.fetcher)).rejects.toThrow('Cancelled by user')
    expect(f.fetcher).not.toHaveBeenCalled()
  })
})
