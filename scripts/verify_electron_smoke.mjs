#!/usr/bin/env node
/** Bounded, isolated launch/termination check; not interactive quit acceptance. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const execFileAsync = promisify(execFile)

async function within(promise, milliseconds, signal) {
  let timer, abort
  try {
    assert(!signal?.aborted, 'Isolated smoke observation was cancelled')
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => resolve(null), milliseconds)
      abort = () => reject(new Error('Isolated smoke observation was cancelled'))
      signal?.addEventListener('abort', abort, { once: true })
    })])
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
}

function signalOwnedGroup(pid, signal) {
  assert(Number.isSafeInteger(pid) && pid > 1, 'Invalid owned smoke process group')
  try { process.kill(-pid, signal); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

function groupExists(pid) {
  try { return signalOwnedGroup(pid, 0) }
  catch (error) {
    // macOS can briefly report EPERM while an orphan is being reaped. It is
    // still present, not proof of successful cleanup; retain the deadline.
    if (error.code === 'EPERM') return true
    throw error
  }
}

async function groupStopped(pid, milliseconds) {
  const deadline = Date.now() + milliseconds
  do {
    if (!groupExists(pid)) return true
    await delay(Math.min(25, Math.max(1, deadline - Date.now())))
  } while (Date.now() < deadline)
  return !groupExists(pid)
}

export async function verifyElectronSmoke({ executable, args = [], userDataPath, logPath,
  launchMilliseconds = 10_000, shutdownMilliseconds = 30_000, cleanupMilliseconds = 2_000,
  maximumLogBytes = 1024 * 1024, env = process.env, signal }) {
  assert(['darwin', 'linux'].includes(process.platform), 'Smoke supervisor requires POSIX process groups')
  assert(isAbsolute(executable) && isAbsolute(userDataPath) && isAbsolute(logPath), 'Smoke paths must be absolute')
  for (const value of [launchMilliseconds, shutdownMilliseconds, cleanupMilliseconds]) {
    assert(Number.isInteger(value) && value > 0 && value <= 60_000, 'Invalid bounded smoke deadline')
  }
  assert(Number.isInteger(maximumLogBytes) && maximumLogBytes > 0 && maximumLogBytes <= 16 * 1024 * 1024, 'Invalid smoke log bound')
  // Refuse an existing profile or log. Never substitute HOME or pretend this
  // machine is a disposable CI runner; the normal app reads the explicit guard.
  assert(!signal?.aborted, 'Isolated smoke observation was cancelled')
  await mkdir(userDataPath, { mode: 0o700 })
  const log = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let child, ownedGroup = false, exit, closed, logBytes = 0, logOverflow = false, logError = false
  let logWrites = Promise.resolve()
  const capture = chunk => {
    const available = Math.max(0, maximumLogBytes - logBytes)
    const bytes = chunk.subarray(0, available)
    logOverflow ||= bytes.length < chunk.length
    logBytes += bytes.length
    if (bytes.length) logWrites = logWrites.then(() => log.writeFile(bytes)).catch(() => { logError = true })
  }
  let result, failure
  try {
    const smokeEnv = { ...env, AGENTSDOCK_USER_DATA: userDataPath, AGENTSDOCK_DISABLE_ANALYTICS: '1',
      AGENTSDOCK_DISABLE_LOCAL_SERVER_DISCOVERY: '1' }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS',
      'AGENTSDOCK_CAPTURE_PATH', 'AGENTSDOCK_MIGRATE_SAFE_STORAGE']) delete smokeEnv[key]
    child = spawn(executable, args, {
      detached: true,
      env: smokeEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    exit = new Promise(resolve => {
      child.once('error', () => resolve({ code: null, signal: null, spawnError: true }))
      child.once('exit', (code, signal) => resolve({ code, signal, spawnError: false }))
    })
    closed = new Promise(resolve => { child.once('close', () => resolve(true)) })
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    assert(Number.isSafeInteger(child.pid) && child.pid > 1, 'Could not start isolated smoke app')
    // detached creates a new POSIX session/group; independently confirm the
    // group leader before allowing cleanup signals to any descendants.
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'pgid=', '-p', String(child.pid)], { timeout: 2_000, maxBuffer: 128 })
    assert(Number(stdout.trim()) === child.pid, 'Smoke child does not own its process group')
    ownedGroup = true
    assert(await within(exit, launchMilliseconds, signal) === null, 'Signed macOS app exited during isolated launch observation')
    assert(!logOverflow && !logError, 'Isolated smoke log exceeded its bound or could not be written')
    child.kill('SIGTERM')
    const stopped = await within(exit, shutdownMilliseconds, signal)
    assert(stopped, 'Signed macOS app did not terminate before the shutdown deadline; cleanup does not count as acceptance')
    assert(!stopped.spawnError && stopped.code === 0 && stopped.signal === null,
      `Signed macOS app did not exit cleanly (code=${stopped.code}, signal=${stopped.signal ?? 'none'})`)
    assert(await within(closed, cleanupMilliseconds, signal), 'Owned smoke app output did not close before its deadline')
    assert(await groupStopped(child.pid, cleanupMilliseconds), 'Smoke app exited but left owned helper processes running')
    result = { schema: 1, observation: 'isolated-launch-and-termination', exitCode: 0, exitSignal: null,
      forcedCleanup: false, interactiveQuitAccepted: false, launchMilliseconds, shutdownMilliseconds }
  } catch (error) {
    failure = error
  } finally {
    // Only this child and its confirmed fresh session may be cleaned up. A
    // timeout/crash remains failure even if forced cleanup subsequently works.
    try {
      if (ownedGroup && groupExists(child.pid)) {
        signalOwnedGroup(child.pid, 'SIGTERM')
        if (!await groupStopped(child.pid, cleanupMilliseconds)) {
          signalOwnedGroup(child.pid, 'SIGKILL')
          if (!await groupStopped(child.pid, cleanupMilliseconds)) failure = new Error('Owned smoke process group could not be cleaned up')
        }
      } else if (!ownedGroup && child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await within(exit, cleanupMilliseconds)
      }
    } catch {
      failure = new Error('Owned smoke process cleanup failed; inspect its isolated private evidence')
    }
    if (closed && !await within(closed, cleanupMilliseconds)) {
      failure = new Error('Owned smoke output streams did not close after bounded cleanup')
      child.stdout.destroy()
      child.stderr.destroy()
    }
    child?.stdout?.removeListener('data', capture)
    child?.stderr?.removeListener('data', capture)
    await logWrites
    await log.close()
  }
  if (failure) throw failure
  assert(!logOverflow && !logError, 'Isolated smoke log exceeded its bound or could not be written')
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  try {
    assert(process.argv.length === 5, 'Usage: verify_electron_smoke.mjs <executable> <new-user-data-path> <new-private-log-path>')
    const [executable, userDataPath, logPath] = process.argv.slice(2)
    process.stdout.write(`${JSON.stringify(await verifyElectronSmoke({ executable, userDataPath, logPath, signal: controller.signal }))}\n`)
  } catch (error) {
    // Do not print the captured app log, child command, environment or tokens.
    process.stderr.write(`Isolated macOS smoke failed: ${error.message}\n`)
    process.exitCode = 2
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}
