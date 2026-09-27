import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AgentServerClient } from './server-client'

export interface DiscoveredLocalServer { name: string; serverUrl: string; accessToken: string; serverIdentity: string }

async function ownedListener(port: number): Promise<boolean> {
  try {
    const { stdout } = await promisify(execFile)(process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof',
      ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpu'], { timeout: 2000, maxBuffer: 16384 })
    const owners = stdout.split('\n').filter(line => /^u\d+$/.test(line)).map(line => Number(line.slice(1)))
    // Check the listener before sending a credential. Another OS user may
    // have reused a stopped instance's port; health identity alone is too late.
    return owners.length > 0 && owners.every(uid => uid === process.getuid?.())
  } catch { return false }
}

async function ownedPath(path: string, home: string): Promise<void> {
  for (let current = path; current !== dirname(home); current = dirname(current)) {
    const info = await lstat(current)
    if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022)) throw new Error('Untrusted local installation')
    if (current === home) return
  }
  throw new Error('Outside local installation')
}

async function readOwned(path: string, home: string, secret = false): Promise<string> {
  await ownedPath(path, home)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 16384 || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & (secret ? 0o077 : 0o022))) throw new Error('Unsafe installation file')
    const bytes = Buffer.alloc(16385)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 16384) throw new Error('Oversized installation file')
    return bytes.subarray(0, bytesRead).toString('utf8')
  } finally { await file.close() }
}

function envValues(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    // Parse data only; never source a shell file or expand commands/variables.
    result[match[1]] = value
  }
  return result
}

/** One bounded startup scan of this OS user's managed installs. No LAN/port scan. */
export async function discoverLocalServers(home = homedir(), probe = async (url: string, token: string) =>
  new AgentServerClient(url, token).health(2000, 'error'), listenerOwned = ownedListener): Promise<DiscoveredLocalServer[]> {
  if (!['darwin', 'linux'].includes(process.platform)) return []
  home = await realpath(home)
  const roots: Array<{ name: string; config: string; state: string }> = [
    { name: 'default', config: join(home, '.config/agents-server'), state: join(home, '.agentsdock') }
  ]
  const named = join(home, '.config/agents-server-instances')
  try {
    await ownedPath(named, home)
    for (const item of (await readdir(named, { withFileTypes: true })).slice(0, 64)) {
      if (!item.isDirectory() || !/^[a-z][a-z0-9-]{0,31}$/.test(item.name) || item.name === 'default') continue
      roots.push({ name: item.name, config: join(named, item.name), state: join(home, '.agentsdock-instances', item.name) })
    }
  } catch { /* No managed named instances. */ }
  let machine = hostname()
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { const file = await open(path, 'r'); try { const value = (await file.readFile('utf8')).trim(); if (value) { machine = value; break } } finally { await file.close() } } catch { /* macOS */ }
  }
  const found: DiscoveredLocalServer[] = []
  // Fixed batches bound concurrency; each health request is deadline-limited.
  for (let offset = 0; offset < roots.length; offset += 4) await Promise.all(roots.slice(offset, offset + 4).map(async candidate => {
    try {
      const env = envValues(await readOwned(join(candidate.config, 'env'), home, true))
      const rawPort = env.AGENTSDOCK_AGENT_PORT ?? env.ZENITHBOT_AGENT_PORT ?? '7850'
      if (!/^\d{1,5}$/.test(rawPort)) return
      const port = Number(rawPort)
      if (port < 1 || port > 65535) return
      if (!await listenerOwned(port)) return
      const token = env.AGENTSDOCK_AGENT_TOKEN ?? env.ZENITHDOCK_AGENT_TOKEN ?? env.ZENITHBOT_AGENT_TOKEN ?? ''
      if (!/^[\x21-\x7e]{16,4096}$/.test(token)) return
      await ownedPath(candidate.state, home)
      let identity: string
      try { identity = (await readOwned(join(candidate.state, 'server-identity'), home)).trim() }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
        identity = createHash('sha256').update(`${machine}|${candidate.state}`).digest('hex').slice(0, 24)
      }
      if (!/^[a-zA-Z0-9_-]{16,128}$/.test(identity)) return
      const serverUrl = `http://127.0.0.1:${port}`
      const health = await probe(serverUrl, token)
      if (health.ok !== true || health.server_identity !== identity) return
      found.push({ name: `${candidate.name} · ${port}`, serverUrl, accessToken: token, serverIdentity: identity })
    } catch { /* Missing/stopped/untrusted installations are not imported. Never log credentials. */ }
  }))
  return found.sort((a, b) => a.serverUrl.localeCompare(b.serverUrl))
}
