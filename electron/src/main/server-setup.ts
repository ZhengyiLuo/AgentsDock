import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type {
  ServerSetupCapabilities,
  ServerSetupDiagnostics,
  ServerSetupInput,
  ServerSetupProgress,
  ServerSetupResult
} from '../shared/types'
import { appLog } from './logger'
import { resolveServerSetupRelease, serverSetupVersionGuard, type PinnedServerRelease } from './server-setup-release'
const RESULT_PREFIX = 'AGENTSDOCK_SETUP_RESULT='
const PREFLIGHT_ERROR_PREFIX = 'AGENTSDOCK_PREFLIGHT_ERROR='
const PREFLIGHT_WARNING_PREFIX = 'AGENTSDOCK_PREFLIGHT_WARNING='
const LAUNCHD_RESTART_FAILURE = 'macOS could not restart AgentsServer.'
const LAUNCHD_STOPPING_FAILURE = 'macOS is still stopping the previous AgentsServer service.'
const LAUNCHD_RETRY_DELAY_MS = 600
const SETUP_LOG_MAX_BYTES = 2 * 1024 * 1024
const SETUP_LOG_TAIL_LINES = 100
const DEFAULT_TIMINGS: ServerSetupTimings = Object.freeze({
  // The packaged installer allows up to 5 minutes for uv installation and
  // 20 minutes for dependency resolution. Keep the enclosing watchdog above
  // those bounded stages so AgentsDock never kills a still-valid install first.
  overallTimeoutMs: 40 * 60_000,
  inactivityTimeoutMs: 6 * 60_000,
  heartbeatMs: 15_000,
  terminateGraceMs: 2_000,
  stageTimeoutMs: {
    connect: 60_000,
    download: 6 * 60_000,
    runtime: 26 * 60_000,
    install: 6 * 60_000,
    service: 4 * 60_000,
    health: 4 * 60_000,
    diagnostics: 4 * 60_000,
    complete: 60_000
  }
})

export interface ServerSetupTimings {
  overallTimeoutMs: number
  inactivityTimeoutMs: number
  heartbeatMs: number
  terminateGraceMs: number
  stageTimeoutMs: Record<ServerSetupProgress['phase'], number>
}

interface ProcessRunOptions {
  phase?: ServerSetupProgress['phase']
  message?: string
}
export const SERVER_SETUP_PATH_BOOTSTRAP = `AGENTSDOCK_PREFLIGHT_CONFIG_DIR="\${AGENTS_SERVER_CONFIG_DIR:-$HOME/.config/agents-server}"
AGENTSDOCK_PREFLIGHT_ENV_FILE="$AGENTSDOCK_PREFLIGHT_CONFIG_DIR/env"
AGENTSDOCK_PREFLIGHT_SAVED_PATH=""
AGENTSDOCK_PREFLIGHT_LINE=""
if [ -r "$AGENTSDOCK_PREFLIGHT_ENV_FILE" ]; then
  while IFS= read -r AGENTSDOCK_PREFLIGHT_LINE || [ -n "$AGENTSDOCK_PREFLIGHT_LINE" ]; do
    case "$AGENTSDOCK_PREFLIGHT_LINE" in
      PATH=*) AGENTSDOCK_PREFLIGHT_SAVED_PATH="\${AGENTSDOCK_PREFLIGHT_LINE#PATH=}" ;;
    esac
  done < "$AGENTSDOCK_PREFLIGHT_ENV_FILE"
fi
export PATH="\${AGENTSDOCK_PREFLIGHT_SAVED_PATH:+$AGENTSDOCK_PREFLIGHT_SAVED_PATH:}$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin:/usr/sbin:/sbin\${PATH:+:$PATH}"
`
export const SERVER_SETUP_PREFLIGHT_SCRIPT = `set -u
${SERVER_SETUP_PATH_BOOTSTRAP}
agentsdock_preflight_fail() {
  printf '${PREFLIGHT_ERROR_PREFIX}%s\n' "$1" >&2
  exit 78
}
AGENTSDOCK_PREFLIGHT_MISSING=""
agentsdock_preflight_require() {
  AGENTSDOCK_PREFLIGHT_TOOL="$1"
  shift
  if ! command -v "$AGENTSDOCK_PREFLIGHT_TOOL" >/dev/null 2>&1 || ! "$@" >/dev/null 2>&1; then
    AGENTSDOCK_PREFLIGHT_MISSING="\${AGENTSDOCK_PREFLIGHT_MISSING:+$AGENTSDOCK_PREFLIGHT_MISSING }$AGENTSDOCK_PREFLIGHT_TOOL"
  fi
}
agentsdock_preflight_require curl curl --version
agentsdock_preflight_require bash bash --version
agentsdock_preflight_require tar tar --version
if ! command -v tmux >/dev/null 2>&1 || ! tmux -V >/dev/null 2>&1; then
  printf '${PREFLIGHT_WARNING_PREFIX}%s\n' "tmux is unavailable. Guided setup will continue, but background terminal sessions will remain disabled until tmux is installed." >&2
fi
if command -v shasum >/dev/null 2>&1 && shasum -a 256 /dev/null >/dev/null 2>&1; then
  :
elif command -v sha256sum >/dev/null 2>&1 && sha256sum /dev/null >/dev/null 2>&1; then
  :
else
  AGENTSDOCK_PREFLIGHT_MISSING="\${AGENTSDOCK_PREFLIGHT_MISSING:+$AGENTSDOCK_PREFLIGHT_MISSING }SHA-256"
fi
AGENTSDOCK_PREFLIGHT_OS="$(uname -s 2>/dev/null || printf unknown)"
if [ -n "$AGENTSDOCK_PREFLIGHT_MISSING" ]; then
  case "$AGENTSDOCK_PREFLIGHT_OS" in
    Darwin) agentsdock_preflight_fail "Missing guided-setup prerequisites: $AGENTSDOCK_PREFLIGHT_MISSING. Install them with Homebrew (brew install $AGENTSDOCK_PREFLIGHT_MISSING), then retry guided setup; do not run AgentsDock as root." ;;
    Linux) agentsdock_preflight_fail "Missing guided-setup prerequisites: $AGENTSDOCK_PREFLIGHT_MISSING. Install them with this server's package manager, then retry guided setup; do not run the installer with sudo." ;;
    *) agentsdock_preflight_fail "Missing guided-setup prerequisites on $AGENTSDOCK_PREFLIGHT_OS: $AGENTSDOCK_PREFLIGHT_MISSING. Install them, then retry guided setup." ;;
  esac
fi
case "$AGENTSDOCK_PREFLIGHT_OS" in
  Darwin)
    AGENTSDOCK_PREFLIGHT_UID="$(id -u)"
    if ! /bin/launchctl print "gui/$AGENTSDOCK_PREFLIGHT_UID" >/dev/null 2>&1; then
      agentsdock_preflight_fail "The macOS launchd GUI domain gui/$AGENTSDOCK_PREFLIGHT_UID is unavailable. Sign in to this Mac's desktop as the target user, verify 'launchctl print gui/$AGENTSDOCK_PREFLIGHT_UID', then retry guided setup; do not run AgentsDock as root."
    fi
    ;;
  Linux)
    if ! command -v systemctl >/dev/null 2>&1; then
      agentsdock_preflight_fail "The Linux systemctl command is unavailable. Guided setup requires systemd user services; install or enable systemd for this host, then retry without sudo."
    fi
    if ! systemctl --user show-environment >/dev/null 2>&1; then
      agentsdock_preflight_fail "The systemctl --user session is unavailable. Sign in as the target user or ask an administrator to enable that user's systemd manager, verify 'systemctl --user show-environment', then retry guided setup without sudo."
    fi
    ;;
  *) agentsdock_preflight_fail "Guided setup does not support $AGENTSDOCK_PREFLIGHT_OS. Use a macOS launchd GUI user session or a Linux systemd user session." ;;
esac
`
export function localReleaseBootstrap(release: PinnedServerRelease): string {
  return `set -eu
${SERVER_SETUP_PATH_BOOTSTRAP}
DESTINATION="$1"
VERSION="${release.version}"
RELEASE_URL="${release.url}"
EXPECTED_SHA="${release.sha256}"
WORK="\$(mktemp -d)"
trap 'rm -rf "\$WORK"' EXIT
ARCHIVE="\$WORK/agents-server.tar.gz"
printf '[AgentsDock setup] Downloading pinned AgentsServer %s\\n' "\$VERSION"
curl --fail --location --silent --show-error --connect-timeout 15 --max-time 300 --retry 3 --retry-delay 2 "\$RELEASE_URL" -o "\$ARCHIVE"
printf '[AgentsDock setup] Verifying downloaded archive\\n'
if command -v shasum >/dev/null 2>&1 && shasum -a 256 /dev/null >/dev/null 2>&1; then
  ACTUAL_SHA="\$(shasum -a 256 "\$ARCHIVE" | awk '{print \$1}')"
elif command -v sha256sum >/dev/null 2>&1 && sha256sum /dev/null >/dev/null 2>&1; then
  ACTUAL_SHA="\$(sha256sum "\$ARCHIVE" | awk '{print \$1}')"
else
  printf 'No working SHA-256 tool was found.\\n' >&2
  exit 2
fi
if [ "\$ACTUAL_SHA" != "\$EXPECTED_SHA" ]; then
  printf 'AgentsServer archive verification failed. Expected %s but received %s.\\n' "\$EXPECTED_SHA" "\$ACTUAL_SHA" >&2
  exit 2
fi
tar -xzf "\$ARCHIVE" -C "\$WORK"
SOURCE="\$WORK/agents-server-\$VERSION"
test "\$(tr -d '[:space:]' < "\$SOURCE/VERSION")" = "\$VERSION"
mv "\$SOURCE" "\$DESTINATION"
`
}

export function remoteReleaseBootstrap(release: PinnedServerRelease): string {
  return `set -eu
${SERVER_SETUP_PATH_BOOTSTRAP}
PORT="\${1:-7850}"
TEAM_HUB_HOST="\${2:-false}"
case "$TEAM_HUB_HOST" in
  true|false) ;;
  *) printf 'Invalid Team Network host choice.\n' >&2; exit 2 ;;
esac
VERSION="${release.version}"
RELEASE_URL="${release.url}"
EXPECTED_SHA="${release.sha256}"
DIR="\$(mktemp -d)"
trap 'rm -rf "\$DIR"' EXIT
ARCHIVE="\$DIR/agents-server.tar.gz"
printf '[AgentsDock setup] Downloading pinned AgentsServer %s\\n' "\$VERSION"
curl --fail --location --silent --show-error --connect-timeout 15 --max-time 300 --retry 3 --retry-delay 2 "\$RELEASE_URL" -o "\$ARCHIVE"
printf '[AgentsDock setup] Verifying downloaded archive\\n'
if command -v shasum >/dev/null 2>&1 && shasum -a 256 /dev/null >/dev/null 2>&1; then
  ACTUAL_SHA="\$(shasum -a 256 "\$ARCHIVE" | awk '{print \$1}')"
elif command -v sha256sum >/dev/null 2>&1 && sha256sum /dev/null >/dev/null 2>&1; then
  ACTUAL_SHA="\$(sha256sum "\$ARCHIVE" | awk '{print \$1}')"
else
  printf 'No working SHA-256 tool was found.\\n' >&2
  exit 2
fi
if [ "\$ACTUAL_SHA" != "\$EXPECTED_SHA" ]; then
  printf 'AgentsServer archive verification failed. Expected %s but received %s.\\n' "\$EXPECTED_SHA" "\$ACTUAL_SHA" >&2
  exit 2
fi
tar -xzf "\$ARCHIVE" -C "\$DIR"
SOURCE="\$DIR/agents-server-\$VERSION"
test "\$(tr -d '[:space:]' < "\$SOURCE/VERSION")" = "\$VERSION"
INSTALL_PID=""
cancel_remote_install() {
  if [ -n "\$INSTALL_PID" ] && kill -0 "\$INSTALL_PID" >/dev/null 2>&1; then
    kill -TERM "\$INSTALL_PID" >/dev/null 2>&1 || true
    wait "\$INSTALL_PID" 2>/dev/null || true
  fi
  exit 130
}
trap cancel_remote_install HUP INT TERM
if [ "$TEAM_HUB_HOST" = "true" ]; then
  set -- --non-interactive --port "$PORT" --team-hub-host
else
  set -- --non-interactive --port "$PORT"
fi
"\$SOURCE/install.sh" "$@" &
INSTALL_PID="\$!"
INSTALL_STATUS=0
wait "\$INSTALL_PID" || INSTALL_STATUS="\$?"
INSTALL_PID=""
exit "\$INSTALL_STATUS"
`
}

export function serverSetupCapabilities(): ServerSetupCapabilities {
  const supportedPlatform = process.platform === 'darwin' || process.platform === 'linux'
  const sandboxed = Boolean(process.mas)
  return {
    available: supportedPlatform && !sandboxed,
    local: supportedPlatform && !sandboxed,
    ssh: supportedPlatform && !sandboxed,
    reason: sandboxed
      ? 'The App Store sandbox cannot install background services. Use the direct desktop build or the setup guide.'
      : supportedPlatform ? undefined : `One-click setup is not available on ${process.platform === 'win32' ? 'Windows' : process.platform}.`
  }
}

export function validateServerSetupInput(input: ServerSetupInput): Required<Pick<ServerSetupInput, 'target' | 'port' | 'track'>> & Pick<ServerSetupInput, 'teamHubHost'> & { sshHost?: string } {
  const target = input.target
  if (target !== 'local' && target !== 'ssh') throw new Error('Choose where to install AgentsServer.')
  const track = input.track ?? 'stable'
  if (track !== 'stable' && track !== 'beta') throw new Error('Choose the Stable or Beta AgentsServer channel.')
  const teamHubHost = input.teamHubHost
  if (teamHubHost !== undefined && typeof teamHubHost !== 'boolean') {
    throw new Error('Choose whether this server should start a Team Network.')
  }
  const port = Number(input.port ?? 7850)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Port must be between 1024 and 65535. This is the AgentsServer HTTP API port, not the SSH port; SSH uses your SSH config.')
  }
  const hostChoice = teamHubHost === undefined ? {} : { teamHubHost }
  if (target === 'local') return { target, port, track, ...hostChoice }
  const sshHost = input.sshHost?.trim() || ''
  if (!sshHost || sshHost.startsWith('-') || !/^[A-Za-z0-9_.@%+:[\]-]+$/.test(sshHost)) {
    throw new Error('Enter an SSH host such as user@server or a configured SSH alias.')
  }
  return { target, port, track, sshHost, ...hostChoice }
}

export function parseServerSetupResult(line: string): ServerSetupResult | null {
  if (!line.startsWith(RESULT_PREFIX)) return null
  const raw = JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>
  const serverUrl = typeof raw.server_url === 'string' ? raw.server_url : ''
  const accessToken = typeof raw.access_token === 'string' ? raw.access_token : ''
  if (!/^https?:\/\//.test(serverUrl) || accessToken.length < 32) throw new Error('AgentsServer returned an invalid setup result.')
  return {
    serverUrl,
    accessToken,
    service: typeof raw.service === 'string' ? raw.service : 'user-service',
    tailscaleIP: typeof raw.tailscale_ip === 'string' ? raw.tailscale_ip : '',
    serverVersion: typeof raw.server_version === 'string' ? raw.server_version : undefined
  }
}

export function remoteFallbackURL(sshHost: string, port: number, resolvedHost?: string): string {
  let host = resolvedHost?.trim() || sshHost.slice(sshHost.lastIndexOf('@') + 1)
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
  return `http://${host}:${port}`
}

export function parseSSHConfigHostname(output: string, sshHost: string): string {
  const configured = output
    .split(/\r\n|\r|\n/)
    .map(line => line.trim().match(/^hostname\s+(.+)$/i)?.[1]?.trim() || '')
    .find(Boolean)
  const fallback = sshHost.slice(sshHost.lastIndexOf('@') + 1).replace(/^\[|\]$/g, '')
  const candidate = configured || fallback
  return /^[A-Za-z0-9_.:%+-]+$/.test(candidate) ? candidate : fallback
}

export function serverSetupFailureMessage(lines: readonly string[], exitCode: number | null): string {
  const meaningful = lines.map(line => line.trim()).filter(Boolean)
  const preflight = [...meaningful].reverse().find(line => line.startsWith(PREFLIGHT_ERROR_PREFIX))
  if (preflight) return preflight.slice(PREFLIGHT_ERROR_PREFIX.length).trim()
  if (meaningful.some(line => /Bootstrap failed:\s*5:\s*Input\/output error/i.test(line))) {
    return `${LAUNCHD_RESTART_FAILURE} Wait a moment and try again; running AgentsDock as root is not required.`
  }
  if (meaningful.some(line => /Operation already in progress/i.test(line))) {
    return `${LAUNCHD_STOPPING_FAILURE} Wait a moment and try again; running AgentsDock as root is not required.`
  }
  const highPriority = [...meaningful].reverse().find(line => (
    /\bERROR\b|permission denied|address already in use|traceback|uncaught exception/i.test(serverSetupJournalMessage(line))
  ))
  if (highPriority) return serverSetupJournalMessage(highPriority)
  const detail = [...meaningful].reverse().find(line => !isBenignServerSetupFailureLine(line))
  return detail || `AgentsServer setup exited with status ${exitCode ?? 'unknown'}.`
}

function serverSetupJournalMessage(line: string): string {
  return line.trim().replace(
    /^[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\S+\s+(?:python|systemd)(?:\[\d+\])?:\s*/i,
    ''
  )
}

export function isBenignServerSetupFailureLine(line: string): boolean {
  const value = line.trim()
  if (!value) return true
  if (/^Try re-running the command as root for richer errors\.?$/i.test(value)) return true
  if (/^The previous release(?: and service)? (?:was|were) restored\.?$/i.test(value)) return true
  if (/^[●○]\s+agents-server\.service\b/i.test(value)) return true
  if (/^(?:Loaded|Active|Main PID|Tasks|Memory|CPU|CGroup):\s+/i.test(value)) return true
  if (/^[├└]─\s*\d+\s+/i.test(value)) return true

  const journalMessage = serverSetupJournalMessage(value)
  return /^(?:INFO:\s*)?(?:Started server process \[\d+\]|Waiting for application startup\.?|Application startup complete\.?|Shutting down\.?|Waiting for application shutdown\.?|Application shutdown complete\.?|Finished server process \[\d+\])$/i.test(journalMessage)
    || /^(?:agents-server\.service:\s+)?Deactivated successfully\.?$/i.test(journalMessage)
    || /^(?:Started|Stopped)\s+AgentsServer\.?$/i.test(journalMessage)
}

export function isRetryableLaunchdSetupFailure(error: unknown): boolean {
  const value = error instanceof Error ? error.message : String(error)
  return value.startsWith(LAUNCHD_RESTART_FAILURE) || value.startsWith(LAUNCHD_STOPPING_FAILURE)
}

export class ServerSetupManager {
  private active: ChildProcessWithoutNullStreams | null = null
  private releaseAbort: AbortController | null = null
  private cancelRequested = false
  private overallDeadlineAt = 0
  private state: ServerSetupDiagnostics['state'] = 'idle'
  private diagnosticTail: string[] = []
  private startedAt?: string
  private updatedAt?: string
  private target?: ServerSetupInput['target']

  constructor(
    private readonly timings: ServerSetupTimings = DEFAULT_TIMINGS,
    private readonly resolveRelease: typeof resolveServerSetupRelease = resolveServerSetupRelease
  ) {}

  capabilities(): ServerSetupCapabilities { return serverSetupCapabilities() }

  diagnostics(): ServerSetupDiagnostics {
    return {
      logPath: currentServerSetupLogPath(),
      state: this.state,
      tail: [...this.diagnosticTail],
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      target: this.target
    }
  }

  cancel(): boolean {
    if (this.state !== 'running') return false
    this.cancelRequested = true
    this.updatedAt = new Date().toISOString()
    this.recordDiagnostic('Cancellation requested by the user.')
    this.releaseAbort?.abort()
    if (this.active) terminateProcessTree(this.active, this.timings.terminateGraceMs)
    return true
  }

  async run(input: ServerSetupInput, progress: (value: ServerSetupProgress) => void): Promise<ServerSetupResult> {
    const capability = this.capabilities()
    if (!capability.available) throw new Error(capability.reason || 'One-click server setup is unavailable in this build.')
    if (this.state === 'running') throw new Error('AgentsServer setup is already running.')
    const validated = validateServerSetupInput(input)
    this.cancelRequested = false
    this.state = 'running'
    this.target = validated.target
    this.startedAt = new Date().toISOString()
    this.updatedAt = this.startedAt
    this.overallDeadlineAt = Date.now() + this.timings.overallTimeoutMs
    this.diagnosticTail = []
    this.releaseAbort = new AbortController()
    try {
      this.emitProgress(progress, { phase: 'download', message: `Checking the latest ${validated.track === 'beta' ? 'Beta' : 'Stable'} AgentsServer release…` })
      const release = await this.resolveRelease(validated.track, this.releaseAbort.signal)
      this.throwIfCancelled()
      this.recordDiagnostic(`Setup started (${validated.target}, port ${validated.port}, ${release.track} AgentsServer ${release.version}).`)
      appLog('server-setup', 'setup started', { target: validated.target, port: validated.port, track: release.track, version: release.version })
      const result = validated.target === 'local'
        ? await this.runLocal(validated.port, progress, validated.teamHubHost, release)
        : await this.runRemote(validated.sshHost!, validated.port, progress, validated.teamHubHost, release)
      this.throwIfCancelled()
      this.state = 'completed'
      this.updatedAt = new Date().toISOString()
      this.recordDiagnostic(`Setup completed (${result.service}, AgentsServer ${result.serverVersion || release.version}).`)
      appLog('server-setup', 'setup completed', { target: validated.target, service: result.service, tailscale: Boolean(result.tailscaleIP) })
      return result
    } catch (error) {
      const normalized = this.cancelRequested ? setupCancelledError() : normalizeError(error)
      this.state = this.cancelRequested ? 'cancelled' : 'failed'
      this.updatedAt = new Date().toISOString()
      this.recordDiagnostic(`${this.state === 'cancelled' ? 'Setup cancelled' : 'Setup failed'}: ${normalized.message}`)
      appLog('server-setup', 'setup failed', { target: validated.target, message: normalized.message, cancelled: this.cancelRequested })
      throw normalized
    } finally {
      this.releaseAbort = null
      this.active = null
      this.overallDeadlineAt = 0
    }
  }

  private async runLocal(
    port: number,
    progress: (value: ServerSetupProgress) => void,
    teamHubHost = false,
    release: PinnedServerRelease
  ): Promise<ServerSetupResult> {
    this.emitProgress(progress, { phase: 'runtime', message: 'Checking local setup prerequisites…' })
    await this.runProcess('/bin/sh', ['-s', '--'], SERVER_SETUP_PREFLIGHT_SCRIPT + serverSetupVersionGuard(release), progress, false, {
      phase: 'runtime',
      message: 'Checking local setup prerequisites…'
    })
    this.throwIfCancelled()
    const directory = await mkdtemp(join(tmpdir(), 'agents-server-setup-'))
    try {
      this.emitProgress(progress, { phase: 'download', message: `Downloading verified AgentsServer ${release.version}…` })
      await this.runProcess(
        '/bin/sh',
        ['-s', '--', join(directory, 'AgentsServer')],
        localReleaseBootstrap(release),
        progress,
        false,
        { phase: 'download', message: `Downloading verified AgentsServer ${release.version}…` }
      )
      this.throwIfCancelled()
      return await this.runInstaller('/bin/bash', [
        join(directory, 'AgentsServer', 'install.sh'),
        '--non-interactive',
        '--port',
        String(port),
        ...(teamHubHost ? ['--team-hub-host'] : [])
      ], undefined, progress)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async runRemote(
    sshHost: string,
    port: number,
    progress: (value: ServerSetupProgress) => void,
    teamHubHost = false,
    release: PinnedServerRelease
  ): Promise<ServerSetupResult> {
    const resolvedHost = await resolveSSHConfigHost(sshHost)
    if (resolvedHost !== sshHost.slice(sshHost.lastIndexOf('@') + 1)) {
      this.recordDiagnostic(`Resolved the SSH destination to ${resolvedHost}.`, 'connect')
    }
    this.emitProgress(progress, { phase: 'connect', message: `Connecting to ${sshHost}…` })
    await this.runProcess(sshCommand(), remoteShellArgs(sshHost, 'sh'), SERVER_SETUP_PREFLIGHT_SCRIPT + serverSetupVersionGuard(release), progress, false, {
      phase: 'connect',
      message: `Connecting to ${sshHost}…`
    })
    this.throwIfCancelled()
    const result = await this.runInstaller(sshCommand(), [
      ...remoteShellArgs(sshHost, 'sh'), String(port), teamHubHost ? 'true' : 'false'
    ], remoteReleaseBootstrap(release), progress, { phase: 'download', message: `Downloading verified AgentsServer ${release.version} on ${sshHost}…` })
    if (result.serverUrl.startsWith('http://127.0.0.1:') && !result.tailscaleIP) {
      result.serverUrl = remoteFallbackURL(sshHost, port, resolvedHost)
    }
    return result
  }

  private async runInstaller(
    command: string,
    args: string[],
    stdin: string | undefined,
    progress: (value: ServerSetupProgress) => void,
    options: ProcessRunOptions = { phase: 'runtime', message: 'Preparing the AgentsServer runtime…' }
  ): Promise<ServerSetupResult> {
    try {
      const result = await this.runProcess(command, args, stdin, progress, true, options)
      if (!result) throw new Error('AgentsServer setup completed without connection details.')
      return result
    } catch (error) {
      if (!isRetryableLaunchdSetupFailure(error)) throw error
      this.throwIfCancelled()
      this.emitProgress(progress, { phase: 'service', message: 'macOS is finishing the previous service restart; retrying safely…' })
      await new Promise<void>(resolve => setTimeout(resolve, LAUNCHD_RETRY_DELAY_MS))
      this.throwIfCancelled()
      const result = await this.runProcess(command, args, stdin, progress, true, {
        phase: 'service',
        message: 'Retrying the AgentsServer service restart…'
      })
      if (!result) throw new Error('AgentsServer setup completed without connection details.')
      return result
    }
  }

  private runProcess(
    command: string,
    args: string[],
    stdin: string | undefined,
    progress: (value: ServerSetupProgress) => void,
    expectResult: boolean,
    options: ProcessRunOptions = {}
  ): Promise<ServerSetupResult | null> {
    return new Promise((resolve, reject) => {
      if (this.cancelRequested) {
        reject(setupCancelledError())
        return
      }
      const startedAt = Date.now()
      if (!this.overallDeadlineAt) this.overallDeadlineAt = startedAt + this.timings.overallTimeoutMs
      const child = spawn(command, args, {
        env: { ...process.env, PATH: serverSetupProcessPath(process.env.PATH), LC_ALL: 'C', LANG: 'C' },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      })
      this.active = child
      let result: ServerSetupResult | null = null
      const tail: string[] = []
      let settled = false
      let terminalError: Error | null = null
      let lastActivityAt = startedAt
      let lastHeartbeatAt = startedAt
      let stageStartedAt = startedAt
      let currentPhase = options.phase || 'install'
      let lastMessage = options.message || 'Running AgentsServer setup…'

      const stop = (error: Error): void => {
        if (terminalError) return
        terminalError = error
        this.recordDiagnostic(error.message, currentPhase)
        terminateProcessTree(child, this.timings.terminateGraceMs)
      }
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearInterval(watchdog)
        if (this.active === child) this.active = null
        callback()
      }
      const updatePhase = (line: string): void => {
        const detected = detectSetupPhase(line)
        if (detected && phaseRank(detected) > phaseRank(currentPhase)) {
          currentPhase = detected
          stageStartedAt = Date.now()
        }
      }
      const consumeLine = (line: string): void => {
        lastActivityAt = Date.now()
        updatePhase(line)
        try {
          const parsed = parseServerSetupResult(line)
          if (parsed) {
            result = parsed
            this.recordDiagnostic('AgentsServer returned connection details (access token redacted).', 'complete')
            return
          }
        } catch (error) {
          stop(normalizeError(error))
          return
        }
        if (!line.trim()) return
        const redacted = redactServerSetupLogLine(line)
        tail.push(redacted)
        if (tail.length > SETUP_LOG_TAIL_LINES) tail.shift()
        lastMessage = (
          redacted.startsWith(PREFLIGHT_ERROR_PREFIX)
            ? redacted.slice(PREFLIGHT_ERROR_PREFIX.length)
            : redacted.startsWith(PREFLIGHT_WARNING_PREFIX)
              ? redacted.slice(PREFLIGHT_WARNING_PREFIX.length)
              : redacted
        ).replace(/^\s+/, '')
        this.emitProgress(progress, { phase: currentPhase, message: lastMessage })
      }
      // stdout and stderr can each deliver partial lines. Keep their buffers
      // separate so a warning cannot splice itself into the private result line.
      const consumeStdout = createLineConsumer(consumeLine)
      const consumeStderr = createLineConsumer(consumeLine)
      child.stdout.on('data', chunk => consumeStdout(String(chunk)))
      child.stderr.on('data', chunk => consumeStderr(String(chunk)))
      child.on('error', error => {
        const failure = new Error(`Could not start ${command}: ${error.message}`)
        terminalError = failure
        finish(() => reject(failure))
      })
      child.on('close', code => {
        consumeStdout.flush()
        consumeStderr.flush()
        if (terminalError) {
          finish(() => reject(terminalError!))
          return
        }
        if (this.cancelRequested) {
          finish(() => reject(setupCancelledError()))
          return
        }
        if (code !== 0) {
          finish(() => reject(new Error(serverSetupFailureMessage(tail, code))))
          return
        }
        if (!result && expectResult) {
          finish(() => reject(new Error('AgentsServer setup completed without connection details.')))
          return
        }
        finish(() => resolve(result))
      })
      child.stdin.on('error', error => {
        if (!terminalError) stop(new Error(`Could not send setup instructions to ${command}: ${error.message}`))
      })
      const watchdog = setInterval(() => {
        const now = Date.now()
        if (this.cancelRequested) {
          stop(setupCancelledError())
          return
        }
        if (now >= this.overallDeadlineAt) {
          stop(new Error(`AgentsServer setup exceeded the ${formatDuration(this.timings.overallTimeoutMs)} overall limit. Retry and open the setup log if it happens again.`))
          return
        }
        const stageLimit = this.timings.stageTimeoutMs[currentPhase]
        if (now - stageStartedAt >= stageLimit) {
          stop(new Error(`AgentsServer setup stopped because the ${phaseLabel(currentPhase)} step exceeded ${formatDuration(stageLimit)}. Retry and open the setup log for details.`))
          return
        }
        if (now - lastActivityAt >= this.timings.inactivityTimeoutMs) {
          stop(new Error(`AgentsServer setup stopped because the ${phaseLabel(currentPhase)} step produced no output for ${formatDuration(this.timings.inactivityTimeoutMs)}. Check the network or remote host, then retry.`))
          return
        }
        if (now - lastHeartbeatAt >= this.timings.heartbeatMs) {
          lastHeartbeatAt = now
          this.emitProgress(progress, {
            phase: currentPhase,
            message: `Still working: ${lastMessage} (${formatDuration(now - startedAt)} elapsed)…`
          }, false)
        }
      }, Math.max(5, Math.min(this.timings.heartbeatMs, 1_000)))
      watchdog.unref?.()
      child.stdin.end(stdin || undefined)
    })
  }

  private emitProgress(
    progress: (value: ServerSetupProgress) => void,
    value: ServerSetupProgress,
    persist = true
  ): void {
    this.updatedAt = new Date().toISOString()
    if (persist) this.recordDiagnostic(value.message, value.phase)
    progress(value)
  }

  private recordDiagnostic(message: string, phase?: ServerSetupProgress['phase']): void {
    const redacted = redactServerSetupLogLine(message).trim()
    if (!redacted) return
    const entry = `${new Date().toISOString()}${phase ? ` [${phase}]` : ''} ${redacted}`
    this.diagnosticTail.push(entry)
    if (this.diagnosticTail.length > SETUP_LOG_TAIL_LINES) this.diagnosticTail.shift()
    appendServerSetupLog(entry)
  }

  private throwIfCancelled(): void {
    if (this.cancelRequested) throw setupCancelledError()
    if (this.overallDeadlineAt && Date.now() >= this.overallDeadlineAt) {
      throw new Error(`AgentsServer setup exceeded the ${formatDuration(this.timings.overallTimeoutMs)} overall limit. Retry and open the setup log if it happens again.`)
    }
  }
}

function sshCommand(): string { return process.platform === 'darwin' ? '/usr/bin/ssh' : 'ssh' }

export function resolveSSHConfigHost(sshHost: string): Promise<string> {
  return new Promise(resolve => {
    execFile(sshCommand(), ['-G', sshHost], {
      encoding: 'utf8',
      env: { ...process.env, PATH: serverSetupProcessPath(process.env.PATH), LC_ALL: 'C', LANG: 'C' },
      timeout: 5_000,
      maxBuffer: 256 * 1024
    }, (_error, stdout) => {
      resolve(parseSSHConfigHostname(String(stdout || ''), sshHost))
    })
  })
}

export function remoteShellArgs(sshHost: string, shell: 'sh' | 'bash'): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ConnectionAttempts=2',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'TCPKeepAlive=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    sshHost,
    shell, '-s', '--'
  ]
}

export function serverSetupProcessPath(currentPath = ''): string {
  const common = [
    process.env.HOME ? `${process.env.HOME}/.local/bin` : '',
    process.env.HOME ? `${process.env.HOME}/.cargo/bin` : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    ...currentPath.split(':')
  ]
  return [...new Set(common.filter(Boolean))].join(':')
}

function detectSetupPhase(line: string): ServerSetupProgress['phase'] | null {
  if (/\[1\/7\]|\[2\/7\]/i.test(line)) return 'runtime'
  if (/\[3\/7\]/i.test(line)) return 'install'
  if (/\[4\/7\]/i.test(line)) return 'service'
  if (/\[5\/7\]/i.test(line)) return 'health'
  if (/\[6\/7\]/i.test(line)) return 'diagnostics'
  if (/\[7\/7\]/i.test(line)) return 'complete'
  if (/dependenc|prerequisite|\btmux\b|\bcurl\b|launchd GUI|systemctl --user|\buv\b/i.test(line)) return 'runtime'
  if (/activating/i.test(line)) return 'install'
  if (/service/i.test(line)) return 'service'
  if (/health/i.test(line)) return 'health'
  if (/runtime diagnostics/i.test(line)) return 'diagnostics'
  if (/ready/i.test(line)) return 'complete'
  if (/download|archive/i.test(line)) return 'download'
  return null
}

export function createLineConsumer(onLine: (line: string) => void): ((chunk: string) => void) & { flush(): void } {
  let buffer = ''
  const consume = ((chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r\n|\r|\n/)
    buffer = lines.pop() || ''
    for (const line of lines) onLine(line)
  }) as ((chunk: string) => void) & { flush(): void }
  consume.flush = () => {
    if (buffer) onLine(buffer)
    buffer = ''
  }
  return consume
}

export function redactServerSetupLogLine(line: string): string {
  if (line.startsWith(RESULT_PREFIX)) return `${RESULT_PREFIX}[connection details redacted]`
  return line
    .replace(/("access_token"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/\b(Access\s+token(?:\s*[:=]\s*|\s{2,}))(["']?)[^\s"'<>]+\2/gi, '$1$2[REDACTED]$2')
    .replace(/\b(AGENTSDOCK_[A-Z0-9_]*TOKEN\s*=\s*)(["']?)[^\s"'<>]+\2/gi, '$1$2[REDACTED]$2')
    .replace(/\b(Authorization\s*:\s*Bearer\s+)(["']?)[^\s"'<>]+\2/gi, '$1$2[REDACTED]$2')
    .replace(/([?&](?:access_)?token=)[^&\s]+/gi, '$1[REDACTED]')
}

export function currentServerSetupLogPath(): string {
  const override = process.env.AGENTSDOCK_SERVER_SETUP_LOG_PATH?.trim()
  if (override) return override
  try {
    if (app && typeof app.getPath === 'function') {
      return join(app.getPath('userData'), 'logs', 'server-setup.log')
    }
  } catch { /* Electron app paths are unavailable in isolated unit tests. */ }
  return join(tmpdir(), 'agentsdock-server-setup.log')
}

function appendServerSetupLog(entry: string): void {
  try {
    const path = currentServerSetupLogPath()
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path) && statSync(path).size >= SETUP_LOG_MAX_BYTES) {
      try { renameSync(path, `${path}.1`) } catch { /* keep writing to the active log */ }
    }
    appendFileSync(path, `${entry}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch { /* setup diagnostics must never break setup */ }
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams, graceMs: number): void {
  signalProcessTree(child, 'SIGTERM')
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalProcessTree(child, 'SIGKILL')
  }, Math.max(0, graceMs))
  force.unref?.()
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch { /* fall through to the direct child */ }
  }
  try { child.kill(signal) } catch { /* it already exited */ }
}

function phaseLabel(phase: ServerSetupProgress['phase']): string {
  switch (phase) {
    case 'connect': return 'SSH connection'
    case 'download': return 'download and verification'
    case 'runtime': return 'runtime preparation'
    case 'install': return 'installation'
    case 'service': return 'service setup'
    case 'health': return 'health check'
    case 'diagnostics': return 'diagnostics'
    case 'complete': return 'completion'
  }
}

function phaseRank(phase: ServerSetupProgress['phase']): number {
  return ['connect', 'download', 'runtime', 'install', 'service', 'health', 'diagnostics', 'complete'].indexOf(phase)
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1_000))
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

function setupCancelledError(): Error {
  return new Error('AgentsServer setup was cancelled.')
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
