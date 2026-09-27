import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverLocalServers } from './local-server-discovery'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
async function install(name = 'test') {
  const home = await mkdtemp(join(tmpdir(), 'local-discovery-')); roots.push(home)
  const config = join(home, '.config/agents-server-instances', name)
  const state = join(home, '.agentsdock-instances', name)
  await mkdir(config, { recursive: true, mode: 0o700 }); await mkdir(state, { recursive: true, mode: 0o700 })
  await writeFile(join(config, 'env'), 'AGENTSDOCK_AGENT_PORT=7859\nAGENTSDOCK_AGENT_TOKEN=synthetic-local-token\n', { mode: 0o600 })
  await writeFile(join(state, 'server-identity'), 'synthetic-server-identity', { mode: 0o600 })
  return { home, config, state }
}
it('authenticates only managed loopback ports and verifies durable identity', async () => {
  const { home } = await install()
  const probe = vi.fn().mockResolvedValue({ ok: true, server_identity: 'synthetic-server-identity' })
  expect(await discoverLocalServers(home, probe, async () => true)).toEqual([{ name: 'test · 7859', serverUrl: 'http://127.0.0.1:7859', accessToken: 'synthetic-local-token', serverIdentity: 'synthetic-server-identity' }])
  expect(probe).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:7859', 'synthetic-local-token')
  probe.mockClear()
  expect(await discoverLocalServers(home, probe, async () => false)).toEqual([])
  expect(probe).not.toHaveBeenCalled()
  probe.mockResolvedValue({ ok: true, server_identity: 'another-server-identity' })
  expect(await discoverLocalServers(home, probe, async () => true)).toEqual([])
})
it('rejects nonprivate credentials, links, shell expressions and stopped services', async () => {
  const { home, config } = await install()
  const probe = vi.fn().mockRejectedValue(new Error('offline'))
  expect(await discoverLocalServers(home, probe, async () => true)).toEqual([])
  probe.mockClear()
  await chmod(join(config, 'env'), 0o644)
  expect(await discoverLocalServers(home, probe, async () => true)).toEqual([]); expect(probe).not.toHaveBeenCalled()
  await rm(join(config, 'env')); await symlink('/etc/hosts', join(config, 'env'))
  expect(await discoverLocalServers(home, probe, async () => true)).toEqual([]); expect(probe).not.toHaveBeenCalled()
  await rm(join(config, 'env')); await writeFile(join(config, 'env'), 'AGENTSDOCK_AGENT_PORT=$(id)\nAGENTSDOCK_AGENT_TOKEN=synthetic-local-token', { mode: 0o600 })
  expect(await discoverLocalServers(home, probe, async () => true)).toEqual([]); expect(probe).not.toHaveBeenCalled()
})
