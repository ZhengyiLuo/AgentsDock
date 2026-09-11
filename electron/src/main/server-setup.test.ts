import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerSetupProgress, ServerSetupResult } from '../shared/types'

const fsHarness = vi.hoisted(() => ({
  mkdtemp: vi.fn<(prefix: string) => Promise<string>>(),
  rm: vi.fn<(path: string, options: { recursive: boolean; force: boolean }) => Promise<void>>()
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: { ...actual, mkdtemp: fsHarness.mkdtemp, rm: fsHarness.rm },
    mkdtemp: fsHarness.mkdtemp,
    rm: fsHarness.rm
  }
})

import {
  createLineConsumer,
  isRetryableLaunchdSetupFailure,
  LOCAL_RELEASE_BOOTSTRAP,
  localReleaseBootstrap,
  parseServerSetupResult,
  parseSSHConfigHostname,
  PINNED_BETA_SERVER_RELEASE,
  PINNED_SERVER_RELEASE_SHA256,
  PINNED_SERVER_RELEASE_URL,
  PINNED_SERVER_RELEASE_VERSION,
  PINNED_STABLE_SERVER_RELEASE,
  pinnedServerRelease,
  redactServerSetupLogLine,
  remoteFallbackURL,
  REMOTE_BOOTSTRAP,
  remoteReleaseBootstrap,
  remoteShellArgs,
  serverSetupCapabilities,
  SERVER_SETUP_PATH_BOOTSTRAP,
  SERVER_SETUP_PREFLIGHT_SCRIPT,
  ServerSetupManager,
  type ServerSetupTimings,
  serverSetupFailureMessage,
  serverSetupProcessPath,
  validateServerSetupInput
} from './server-setup'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

type ServerSetupManagerHarness = {
  runLocal(port: number, progress: (value: ServerSetupProgress) => void, teamHubHost?: boolean, release?: unknown): Promise<ServerSetupResult>
  runRemote(sshHost: string, port: number, progress: (value: ServerSetupProgress) => void, teamHubHost?: boolean, release?: unknown): Promise<ServerSetupResult>
  runProcess(
    command: string,
    args: string[],
    stdin: string | undefined,
    progress: (value: ServerSetupProgress) => void,
    expectResult: boolean,
    options?: { phase?: ServerSetupProgress['phase']; message?: string }
  ): Promise<ServerSetupResult | null>
  state: 'idle' | 'running' | 'failed' | 'completed' | 'cancelled'
}

function testTimings(patch: Partial<Omit<ServerSetupTimings, 'stageTimeoutMs'>> & {
  stageTimeoutMs?: Partial<ServerSetupTimings['stageTimeoutMs']>
} = {}): ServerSetupTimings {
  return {
    overallTimeoutMs: patch.overallTimeoutMs ?? 2_000,
    inactivityTimeoutMs: patch.inactivityTimeoutMs ?? 1_000,
    heartbeatMs: patch.heartbeatMs ?? 20,
    terminateGraceMs: patch.terminateGraceMs ?? 10,
    stageTimeoutMs: {
      connect: 1_000,
      download: 1_000,
      runtime: 1_000,
      install: 1_000,
      service: 1_000,
      health: 1_000,
      diagnostics: 1_000,
      complete: 1_000,
      ...patch.stageTimeoutMs
    }
  }
}

beforeEach(() => {
  fsHarness.mkdtemp.mockReset().mockResolvedValue('/tmp/agents-server-setup-test')
  fsHarness.rm.mockReset().mockResolvedValue(undefined)
})

describe('server setup', () => {
  it('validates local and SSH setup without accepting shell input', () => {
    expect(validateServerSetupInput({ target: 'local', port: 7850 })).toEqual({ target: 'local', port: 7850, track: 'stable' })
    expect(validateServerSetupInput({ target: 'local', port: 7850, teamHubHost: false })).toEqual({ target: 'local', port: 7850, track: 'stable', teamHubHost: false })
    expect(validateServerSetupInput({ target: 'ssh', sshHost: 'user@server-01', port: 9000, track: 'beta', teamHubHost: true })).toEqual({ target: 'ssh', sshHost: 'user@server-01', port: 9000, track: 'beta', teamHubHost: true })
    expect(() => validateServerSetupInput({ target: 'ssh', sshHost: 'user@server; reboot', port: 7850 })).toThrow(/SSH host/)
    expect(() => validateServerSetupInput({ target: 'local', port: 70000 })).toThrow(/Port/)
    expect(() => validateServerSetupInput({ target: 'ssh', sshHost: 'user@server', port: 22 })).toThrow(/HTTP API port, not the SSH port/)
    expect(() => validateServerSetupInput({ target: 'local', port: 0 })).toThrow(/1024 and 65535/)
    expect(() => validateServerSetupInput({ target: 'local', track: 'nightly' as 'stable' })).toThrow(/Stable or Beta/)
    expect(() => validateServerSetupInput({ target: 'local', teamHubHost: 'true' as unknown as boolean })).toThrow(/Team Network/)
  })

  it('explains the intentionally remote-only Windows server setup without exposing win32 jargon', () => {
    const originalPlatform = process.platform
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      expect(serverSetupCapabilities()).toEqual({
        available: false,
        local: false,
        ssh: false,
        reason: 'One-click setup is not available on Windows.'
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('selects immutable Stable and Beta release triples without mixing channels', () => {
    expect(pinnedServerRelease()).toBe(PINNED_STABLE_SERVER_RELEASE)
    expect(pinnedServerRelease('stable')).toBe(PINNED_STABLE_SERVER_RELEASE)
    expect(pinnedServerRelease('beta')).toBe(PINNED_BETA_SERVER_RELEASE)
    expect(PINNED_BETA_SERVER_RELEASE).toEqual({
      track: 'beta',
      version: '0.1.26-beta.46',
      url: 'https://github.com/ZhengyiLuo/AgentsServer/releases/download/v0.1.26-beta.46/agents-server-0.1.26-beta.46.tar.gz',
      sha256: '5928e3c58406bf8beb4862510d71935b9846e61181504d0645781d04136d4b51'
    })
    expect(PINNED_STABLE_SERVER_RELEASE).toEqual({
      track: 'stable',
      version: '0.1.25',
      url: 'https://github.com/ZhengyiLuo/AgentsServer/releases/download/v0.1.25/agents-server-0.1.25.tar.gz',
      sha256: 'a5d8768d17715b0bfbd0f4b7d5fb85052e9baf46a3d3dda51975e4c21b2933e9'
    })
    expect(PINNED_SERVER_RELEASE_VERSION).toBe('0.1.25')
    expect(PINNED_SERVER_RELEASE_URL).toBe(PINNED_STABLE_SERVER_RELEASE.url)
    expect(PINNED_SERVER_RELEASE_SHA256).toBe(PINNED_STABLE_SERVER_RELEASE.sha256)

    const stableLocal = localReleaseBootstrap(PINNED_STABLE_SERVER_RELEASE)
    const betaLocal = localReleaseBootstrap(PINNED_BETA_SERVER_RELEASE)
    const stableRemote = remoteReleaseBootstrap(PINNED_STABLE_SERVER_RELEASE)
    const betaRemote = remoteReleaseBootstrap(PINNED_BETA_SERVER_RELEASE)
    expect(stableLocal).toContain(`VERSION="${PINNED_STABLE_SERVER_RELEASE.version}"`)
    expect(stableLocal).toContain(PINNED_STABLE_SERVER_RELEASE.url)
    expect(stableLocal).toContain(PINNED_STABLE_SERVER_RELEASE.sha256)
    expect(stableLocal).not.toContain(PINNED_BETA_SERVER_RELEASE.url)
    expect(betaLocal).toContain(`VERSION="${PINNED_BETA_SERVER_RELEASE.version}"`)
    expect(betaLocal).toContain(PINNED_BETA_SERVER_RELEASE.url)
    expect(betaLocal).toContain(PINNED_BETA_SERVER_RELEASE.sha256)
    expect(betaLocal).not.toContain(PINNED_STABLE_SERVER_RELEASE.url)
    expect(stableRemote).toContain(PINNED_STABLE_SERVER_RELEASE.url)
    expect(stableRemote).not.toContain(PINNED_BETA_SERVER_RELEASE.url)
    expect(betaRemote).toContain(PINNED_BETA_SERVER_RELEASE.url)
    expect(betaRemote).not.toContain(PINNED_STABLE_SERVER_RELEASE.url)
  })

  it('parses the private installer result without exposing it as progress', () => {
    expect(parseServerSetupResult('ordinary progress')).toBeNull()
    expect(parseServerSetupResult('AGENTSDOCK_SETUP_RESULT={"server_url":"http://100.64.0.10:7850","access_token":"0123456789abcdef0123456789abcdef","service":"systemd-user","tailscale_ip":"100.64.0.10","server_version":"0.1.0"}')).toEqual({
      serverUrl: 'http://100.64.0.10:7850',
      accessToken: '0123456789abcdef0123456789abcdef',
      service: 'systemd-user',
      tailscaleIP: '100.64.0.10',
      serverVersion: '0.1.0'
    })
  })

  it('builds a remote fallback URL from a safe SSH destination', () => {
    expect(remoteFallbackURL('user@server.local', 7850)).toBe('http://server.local:7850')
    expect(remoteFallbackURL('dev@2001:db8::1', 7850)).toBe('http://[2001:db8::1]:7850')
    expect(remoteFallbackURL('user@lab-alias', 7850, '100.64.0.20')).toBe('http://100.64.0.20:7850')
  })

  it('uses the HostName resolved by ssh -G for HTTP instead of an SSH-only alias', () => {
    expect(parseSSHConfigHostname(`
host lab-alias
user dev
hostname 100.64.0.20
port 22
`, 'dev@lab-alias')).toBe('100.64.0.20')
    expect(parseSSHConfigHostname('', 'dev@lab-alias')).toBe('lab-alias')
    expect(parseSSHConfigHostname('hostname bad/path', 'dev@lab-alias')).toBe('lab-alias')
  })

  it('does not tell users to run AgentsDock as root when launchd reports a restart race', () => {
    expect(serverSetupFailureMessage([
      'Bootstrap failed: 5: Input/output error',
      'Try re-running the command as root for richer errors.'
    ], 5)).toBe('macOS could not restart AgentsServer. Wait a moment and try again; running AgentsDock as root is not required.')
  })

  it('preserves the last useful installer error instead of a generic privilege hint', () => {
    expect(serverSetupFailureMessage([
      '[4/7] Installing the user service',
      'launchctl: service configuration is invalid',
      'Try re-running the command as root for richer errors.'
    ], 1)).toBe('launchctl: service configuration is invalid')
  })

  it('surfaces the real server bind error instead of later benign shutdown output', () => {
    expect(serverSetupFailureMessage([
      '[5/7] Waiting for authenticated health',
      "Jul 30 15:39:52 352279b-lcedt python[1553570]: ERROR: [Errno 13] error while attempting to bind on address ('0.0.0.0', 22): permission denied",
      'Jul 30 15:39:52 352279b-lcedt python[1553570]: INFO: Shutting down',
      'Jul 30 15:39:52 352279b-lcedt python[1553570]: INFO: Waiting for application shutdown.',
      'Jul 30 15:39:52 352279b-lcedt python[1553570]: INFO: Application shutdown complete.',
      "Jul 30 15:39:52 352279b-lcedt systemd[1500]: agents-server.service: Failed with result 'exit-code'.",
      'The previous release was restored.'
    ], 1)).toBe("ERROR: [Errno 13] error while attempting to bind on address ('0.0.0.0', 22): permission denied")
  })

  it('ignores benign lifecycle output but preserves an unknown legitimate service error', () => {
    expect(serverSetupFailureMessage([
      'launchctl: service configuration is invalid',
      'Active: failed (Result: exit-code) since Thu 2026-07-30 15:39:52 PDT; 1s ago',
      'Jul 30 15:39:52 studio python[100]: INFO: Application shutdown complete.'
    ], 1)).toBe('launchctl: service configuration is invalid')
  })

  it('surfaces an actionable prerequisite failure as the final setup error', () => {
    const actionable = 'Missing guided-setup prerequisites: curl bash. Install them with this server\'s package manager, then retry guided setup; do not run the installer with sudo.'
    expect(serverSetupFailureMessage([
      'Checking remote prerequisites',
      `AGENTSDOCK_PREFLIGHT_ERROR=${actionable}`,
      'Connection to server closed.',
      'Try re-running the command as root for richer errors.'
    ], 78)).toBe(actionable)
  })

  it('retries only the known launchd service-removal race', () => {
    expect(isRetryableLaunchdSetupFailure(new Error(serverSetupFailureMessage([
      'Bootstrap failed: 5: Input/output error',
      'Try re-running the command as root for richer errors.'
    ], 5)))).toBe(true)
    expect(isRetryableLaunchdSetupFailure(new Error('Bootstrap failed: 78: Invalid property list'))).toBe(false)
    expect(isRetryableLaunchdSetupFailure(new Error('Authentication failed'))).toBe(false)
  })

  it('keeps the local installer checkout until the installer process finishes', async () => {
    const manager = new ServerSetupManager() as unknown as ServerSetupManagerHarness
    const installer = deferred<ServerSetupResult | null>()
    const result: ServerSetupResult = {
      serverUrl: 'http://127.0.0.1:7850',
      accessToken: '0123456789abcdef0123456789abcdef',
      service: 'launchd-user',
      tailscaleIP: ''
    }
    const runProcess = vi.spyOn(manager, 'runProcess')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(installer.promise)

    const setup = manager.runLocal(7850, vi.fn(), true)
    await vi.waitFor(() => expect(runProcess).toHaveBeenCalledTimes(3))

    expect(runProcess.mock.calls[0]).toEqual([
      '/bin/sh',
      ['-s', '--'],
      SERVER_SETUP_PREFLIGHT_SCRIPT,
      expect.any(Function),
      false,
      { phase: 'runtime', message: 'Checking local setup prerequisites…' }
    ])
    expect(runProcess.mock.calls[1]?.slice(0, 3)).toEqual([
      '/bin/sh',
      ['-s', '--', '/tmp/agents-server-setup-test/AgentsServer'],
      LOCAL_RELEASE_BOOTSTRAP
    ])
    expect(runProcess.mock.calls[2]?.[1]).toEqual([
      '/tmp/agents-server-setup-test/AgentsServer/install.sh',
      '--non-interactive', '--port', '7850', '--team-hub-host'
    ])
    expect(runProcess.mock.calls[2]?.[5]).toEqual({
      phase: 'runtime',
      message: 'Preparing the AgentsServer runtime…'
    })
    expect(fsHarness.rm).not.toHaveBeenCalled()

    installer.resolve(result)
    await expect(setup).resolves.toEqual(result)
    expect(fsHarness.rm).toHaveBeenCalledOnce()
    expect(fsHarness.rm).toHaveBeenCalledWith('/tmp/agents-server-setup-test', { recursive: true, force: true })
  })

  it('stops local setup before creating a checkout when prerequisite preflight fails', async () => {
    const manager = new ServerSetupManager() as unknown as ServerSetupManagerHarness
    const runProcess = vi.spyOn(manager, 'runProcess').mockRejectedValueOnce(new Error('Install tmux, then retry guided setup.'))

    await expect(manager.runLocal(7850, vi.fn())).rejects.toThrow('Install tmux')

    expect(runProcess).toHaveBeenCalledOnce()
    expect(runProcess.mock.calls[0]?.slice(0, 3)).toEqual(['/bin/sh', ['-s', '--'], SERVER_SETUP_PREFLIGHT_SCRIPT])
    expect(fsHarness.mkdtemp).not.toHaveBeenCalled()
    expect(fsHarness.rm).not.toHaveBeenCalled()
  })

  it('uses BatchMode for remote preflight and installer bootstrap', async () => {
    const manager = new ServerSetupManager() as unknown as ServerSetupManagerHarness
    const result: ServerSetupResult = {
      serverUrl: 'http://100.64.0.10:7850',
      accessToken: '0123456789abcdef0123456789abcdef',
      service: 'systemd-user',
      tailscaleIP: '100.64.0.10'
    }
    const runProcess = vi.spyOn(manager, 'runProcess')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(result)

    await expect(manager.runRemote('user@server', 7850, vi.fn(), true)).resolves.toEqual(result)

    expect(runProcess).toHaveBeenCalledTimes(2)
    expect(runProcess.mock.calls[0]?.[1]).toEqual(remoteShellArgs('user@server', 'sh'))
    expect(runProcess.mock.calls[0]?.[2]).toBe(SERVER_SETUP_PREFLIGHT_SCRIPT)
    expect(runProcess.mock.calls[0]?.[4]).toBe(false)
    expect(runProcess.mock.calls[1]?.[1]).toEqual([...remoteShellArgs('user@server', 'sh'), '7850', 'true'])
    expect(runProcess.mock.calls[1]?.[2]).toBe(REMOTE_BOOTSTRAP)
    expect(runProcess.mock.calls[1]?.[4]).toBe(true)
    expect(runProcess.mock.calls.every(call => call[1].includes('BatchMode=yes'))).toBe(true)
    expect(runProcess.mock.calls.every(call => call[1].includes('ServerAliveInterval=15'))).toBe(true)
    expect(runProcess.mock.calls.every(call => call[1].includes('ServerAliveCountMax=4'))).toBe(true)
  })

  it('does not launch the remote clone or installer after preflight failure', async () => {
    const manager = new ServerSetupManager() as unknown as ServerSetupManagerHarness
    const runProcess = vi.spyOn(manager, 'runProcess').mockRejectedValueOnce(new Error('The systemctl --user session is unavailable.'))

    await expect(manager.runRemote('user@server', 7850, vi.fn())).rejects.toThrow('systemctl --user')

    expect(runProcess).toHaveBeenCalledOnce()
    expect(runProcess.mock.calls[0]?.[1]).toEqual(remoteShellArgs('user@server', 'sh'))
    expect(runProcess.mock.calls[0]?.[2]).toBe(SERVER_SETUP_PREFLIGHT_SCRIPT)
  })

  it('parses only the saved PATH value without sourcing other env-file content', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-preflight-path-'))
    const config = join(directory, 'config')
    const customBin = join(directory, 'custom-bin')
    const marker = join(directory, 'must-not-exist')
    mkdirSync(config, { recursive: true })
    mkdirSync(customBin, { recursive: true })
    writeFileSync(join(config, 'env'), `AGENTSDOCK_AGENT_TOKEN=secret\nDONT_SOURCE=\$(touch "${marker}")\nPATH=${customBin}\n`)
    try {
      const output = execFileSync('/bin/sh', ['-c', `${SERVER_SETUP_PATH_BOOTSTRAP}\nprintf '%s' "$PATH"`], {
        encoding: 'utf8',
        env: { HOME: directory, PATH: '/usr/bin:/bin', AGENTS_SERVER_CONFIG_DIR: config }
      })
      expect(output.split(':')[0]).toBe(customBin)
      expect(output).toContain('/opt/homebrew/bin')
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps the evaluated preflight and remote bootstrap shell syntax valid', () => {
    expect(() => execFileSync('/bin/sh', ['-n'], { input: SERVER_SETUP_PREFLIGHT_SCRIPT })).not.toThrow()
    expect(() => execFileSync('/bin/sh', ['-n'], { input: LOCAL_RELEASE_BOOTSTRAP })).not.toThrow()
    expect(() => execFileSync('/bin/sh', ['-n'], { input: REMOTE_BOOTSTRAP })).not.toThrow()
    expect(LOCAL_RELEASE_BOOTSTRAP).toContain('if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]')
    expect(REMOTE_BOOTSTRAP).toContain('if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]')
    expect(LOCAL_RELEASE_BOOTSTRAP).not.toContain('git clone')
    expect(REMOTE_BOOTSTRAP).not.toContain('git clone')
  })

  it('rejects an unsafe remote Team Network host position before running downloaded code', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-host-flag-'))
    const marker = join(directory, 'must-not-exist')
    try {
      const result = spawnSync('/bin/sh', ['-s', '--', '7850', `true; touch ${marker}`], {
        input: REMOTE_BOOTSTRAP,
        encoding: 'utf8',
        env: { ...process.env, HOME: directory, AGENTS_SERVER_CONFIG_DIR: join(directory, 'config') }
      })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('Invalid Team Network host choice.')
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('carries the validated Team Network host choice into the selected installer path', async () => {
    const actual = new ServerSetupManager()
    const manager = actual as unknown as ServerSetupManagerHarness
    const progress = vi.fn()
    const result: ServerSetupResult = {
      serverUrl: 'http://127.0.0.1:7850',
      accessToken: '0123456789abcdef0123456789abcdef',
      service: 'launchd-user',
      tailscaleIP: ''
    }
    const runLocal = vi.spyOn(manager, 'runLocal').mockResolvedValue(result)

    await expect(actual.run({ target: 'local', port: 7850, teamHubHost: true }, progress)).resolves.toEqual(result)

    expect(runLocal).toHaveBeenCalledWith(7850, progress, true, PINNED_STABLE_SERVER_RELEASE)
  })

  it('verifies and extracts the pinned release archive before exposing it to the installer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-release-bootstrap-'))
    const source = join(directory, `agents-server-${PINNED_SERVER_RELEASE_VERSION}`)
    const archive = join(directory, 'release.tar.gz')
    const destination = join(directory, 'verified-release')
    mkdirSync(source)
    writeFileSync(join(source, 'VERSION'), `${PINNED_SERVER_RELEASE_VERSION}\n`)
    writeFileSync(join(source, 'install.sh'), '#!/bin/sh\nexit 0\n')
    execFileSync('tar', ['-czf', archive, '-C', directory, `agents-server-${PINNED_SERVER_RELEASE_VERSION}`])
    const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
    const script = LOCAL_RELEASE_BOOTSTRAP
      .replace(PINNED_SERVER_RELEASE_URL, `file://${archive}`)
      .replace(PINNED_SERVER_RELEASE_SHA256, sha256)
    try {
      execFileSync('/bin/sh', ['-s', '--', destination], {
        input: script,
        env: { ...process.env, HOME: directory, AGENTS_SERVER_CONFIG_DIR: join(directory, 'config') }
      })
      expect(readFileSync(join(destination, 'VERSION'), 'utf8').trim()).toBe(PINNED_SERVER_RELEASE_VERSION)
      expect(existsSync(join(destination, 'install.sh'))).toBe(true)

      const rejected = join(directory, 'rejected-release')
      const rejectedScript = script.replace(sha256, '0'.repeat(64))
      expect(() => execFileSync('/bin/sh', ['-s', '--', rejected], {
        input: rejectedScript,
        env: { ...process.env, HOME: directory, AGENTS_SERVER_CONFIG_DIR: join(directory, 'config') },
        stdio: ['pipe', 'pipe', 'pipe']
      })).toThrow()
      expect(existsSync(rejected)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('continues with a capability warning when the tmux version probe is unusable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentsdock-preflight-probe-'))
    const config = join(directory, 'config')
    const fakeBin = join(directory, 'bin')
    mkdirSync(config, { recursive: true })
    mkdirSync(fakeBin, { recursive: true })
    for (const command of ['curl', 'bash', 'tar', 'systemctl']) {
      const path = join(fakeBin, command)
      writeFileSync(path, '#!/bin/sh\nexit 0\n')
      chmodSync(path, 0o755)
    }
    const uname = join(fakeBin, 'uname')
    writeFileSync(uname, '#!/bin/sh\nprintf Linux\n')
    chmodSync(uname, 0o755)
    const brokenTmux = join(fakeBin, 'tmux')
    writeFileSync(brokenTmux, '#!/bin/sh\nexit 69\n')
    chmodSync(brokenTmux, 0o755)
    writeFileSync(join(config, 'env'), `PATH=${fakeBin}\n`)
    try {
      const result = spawnSync('/bin/sh', ['-s'], {
        input: SERVER_SETUP_PREFLIGHT_SCRIPT,
        encoding: 'utf8',
        env: { HOME: directory, PATH: '/usr/bin:/bin', AGENTS_SERVER_CONFIG_DIR: config }
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('AGENTSDOCK_PREFLIGHT_WARNING=tmux is unavailable.')
      expect(result.stderr).not.toContain('AGENTSDOCK_PREFLIGHT_ERROR=')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('adds common Finder and Homebrew locations to spawned setup commands', () => {
    const path = serverSetupProcessPath('/finder-only/bin')
    expect(path.split(':')).toEqual(expect.arrayContaining([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/home/linuxbrew/.linuxbrew/bin',
      '/usr/bin',
      '/bin',
      '/finder-only/bin'
    ]))
  })

  it('treats carriage returns as progress line boundaries', () => {
    const lines: string[] = []
    const consume = createLineConsumer(line => lines.push(line))
    consume('Downloading 10%\rDownloading 50%')
    consume('\r\nInstalling\nReady')
    consume.flush()
    expect(lines.filter(Boolean)).toEqual([
      'Downloading 10%',
      'Downloading 50%',
      'Installing',
      'Ready'
    ])
  })

  it('redacts setup results, environment tokens, and bearer credentials from diagnostics', () => {
    expect(redactServerSetupLogLine(
      'AGENTSDOCK_SETUP_RESULT={"server_url":"http://localhost","access_token":"super-secret"}'
    )).toBe('AGENTSDOCK_SETUP_RESULT=[connection details redacted]')
    expect(redactServerSetupLogLine('AGENTSDOCK_AGENT_TOKEN=super-secret')).toBe('AGENTSDOCK_AGENT_TOKEN=[REDACTED]')
    expect(redactServerSetupLogLine('AGENTSDOCK_AGENT_TOKEN="super-secret"')).toBe('AGENTSDOCK_AGENT_TOKEN="[REDACTED]"')
    expect(redactServerSetupLogLine('Access token: super-secret')).toBe('Access token: [REDACTED]')
    expect(redactServerSetupLogLine('Access token = "super-secret"')).toBe('Access token = "[REDACTED]"')
    expect(redactServerSetupLogLine('  Access token  super-secret')).toBe('  Access token  [REDACTED]')
    expect(redactServerSetupLogLine('Authorization: Bearer super-secret')).toBe('Authorization: Bearer [REDACTED]')
    expect(redactServerSetupLogLine("Authorization: Bearer 'super-secret'")).toBe("Authorization: Bearer '[REDACTED]'")
  })

  it('shows optional preflight warnings as clean progress text', async () => {
    const manager = new ServerSetupManager(testTimings()) as unknown as ServerSetupManagerHarness
    const progress = vi.fn()
    await expect(manager.runProcess(
      '/bin/sh',
      ['-c', 'printf "%s\\n" "AGENTSDOCK_PREFLIGHT_WARNING=tmux is unavailable." >&2'],
      undefined,
      progress,
      false,
      { phase: 'runtime', message: 'Checking prerequisites…' }
    )).resolves.toBeNull()
    expect(progress).toHaveBeenCalledWith({ phase: 'runtime', message: 'tmux is unavailable.' })
  })

  it('emits progress heartbeats while a quiet setup process is still healthy', async () => {
    const manager = new ServerSetupManager(testTimings({ heartbeatMs: 20 })) as unknown as ServerSetupManagerHarness
    const progress = vi.fn()
    await expect(manager.runProcess(
      '/bin/sh',
      ['-c', 'sleep 0.09'],
      undefined,
      progress,
      false,
      { phase: 'install', message: 'Installing dependencies…' }
    )).resolves.toBeNull()
    expect(progress.mock.calls.some(([value]) => /Still working: Installing dependencies/.test(value.message))).toBe(true)
  })

  it('stops and explains a setup process that becomes inactive', async () => {
    const manager = new ServerSetupManager(testTimings({
      inactivityTimeoutMs: 45,
      heartbeatMs: 15,
      terminateGraceMs: 5
    })) as unknown as ServerSetupManagerHarness
    await expect(manager.runProcess(
      '/bin/sh',
      ['-c', 'sleep 5'],
      undefined,
      vi.fn(),
      false,
      { phase: 'download', message: 'Downloading…' }
    )).rejects.toThrow(/produced no output/)
  })

  it('enforces a per-stage setup deadline separately from inactivity', async () => {
    const manager = new ServerSetupManager(testTimings({
      inactivityTimeoutMs: 1_000,
      heartbeatMs: 15,
      stageTimeoutMs: { service: 45 }
    })) as unknown as ServerSetupManagerHarness
    await expect(manager.runProcess(
      '/bin/sh',
      ['-c', 'while :; do echo waiting; sleep 0.01; done'],
      undefined,
      vi.fn(),
      false,
      { phase: 'service', message: 'Starting service…' }
    )).rejects.toThrow(/service setup step exceeded/)
  })

  it('cancels the active process tree and records a cancelled state', async () => {
    const actual = new ServerSetupManager(testTimings())
    const manager = actual as unknown as ServerSetupManagerHarness
    vi.spyOn(manager, 'runLocal').mockImplementation((_port, progress) =>
      manager.runProcess(
        '/bin/sh',
        ['-c', 'sleep 5 & wait'],
        undefined,
        progress,
        false,
        { phase: 'install', message: 'Installing…' }
      ).then(() => {
        throw new Error('The cancelled process unexpectedly completed.')
      })
    )
    const running = actual.run({ target: 'local', port: 7850 }, vi.fn())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(actual.cancel()).toBe(true)
    expect(actual.diagnostics().state).toBe('running')
    await expect(actual.run({ target: 'local', port: 7850 }, vi.fn())).rejects.toThrow(/already running/)
    await expect(running).rejects.toThrow(/cancelled/)
    expect(actual.diagnostics().state).toBe('cancelled')
    expect(actual.cancel()).toBe(false)
  })
})
