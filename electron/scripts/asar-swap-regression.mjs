#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  copyFile,
  link,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink
} from 'node:fs/promises'
import { constants as fsConstants, createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const STARTUP_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 10_000
const SETTLE_AFTER_IMPORT_MS = 750
const CODEMIRROR_CHUNK = /^out\/renderer\/assets\/CodeMirrorEditor-[A-Za-z0-9_-]+\.js$/
const APP_LOG_FAILURE = /CodeMirrorEditor-|ERR_FILE_NOT_FOUND|\[renderer\] process gone|page load failed|\[preload\] failed to load|window unresponsive|uncaught exception|unhandled rejection|\[fatal\]|asar/i

const usage = `Usage:
  node electron/scripts/asar-swap-regression.mjs [--expected-electron VERSION] <Subject.app> <replacement.asar>

Launches the packaged macOS app with isolated user data and remote debugging,
then proves an as-yet-unloaded CodeMirror chunk remains readable after app.asar
is atomically replaced by a valid archive that does not contain that exact chunk.

The original app.asar is restored before the script exits.`

class CdpConnection {
  constructor(url) {
    this.url = url
    this.socket = null
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.closed = false
  }

  async connect() {
    const socket = new WebSocket(this.url)
    this.socket = socket
    socket.addEventListener('message', event => this.#onMessage(String(event.data)))
    socket.addEventListener('close', event => this.#onClose(`CDP socket closed (${event.code} ${event.reason})`))
    socket.addEventListener('error', () => this.#onClose('CDP socket error'))
    await new Promise((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error(`Timed out connecting to ${this.url}`)), REQUEST_TIMEOUT_MS)
      socket.addEventListener('open', () => {
        clearTimeout(timeout)
        resolveOpen()
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timeout)
        rejectOpen(new Error(`Could not connect to ${this.url}`))
      }, { once: true })
    })
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async call(method, params = {}, sessionId) {
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Cannot call ${method}: CDP socket is not open`)
    }
    const id = this.nextId++
    const packet = { id, method, params }
    if (sessionId) packet.sessionId = sessionId
    return await new Promise((resolveCall, rejectCall) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        rejectCall(new Error(`CDP ${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        method,
        resolve: result => {
          clearTimeout(timeout)
          resolveCall(result)
        },
        reject: error => {
          clearTimeout(timeout)
          rejectCall(error)
        }
      })
      this.socket.send(JSON.stringify(packet))
    })
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close()
    this.#onClose('CDP connection closed')
  }

  #onMessage(raw) {
    let packet
    try {
      packet = JSON.parse(raw)
    } catch {
      return
    }
    if (packet.id) {
      const pending = this.pending.get(packet.id)
      if (!pending) return
      this.pending.delete(packet.id)
      if (packet.error) {
        pending.reject(new Error(`CDP ${pending.method} failed: ${packet.error.message}`))
      } else {
        pending.resolve(packet.result)
      }
      return
    }
    if (packet.method) {
      for (const listener of this.listeners) listener(packet)
    }
  }

  #onClose(message) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error(message))
    this.pending.clear()
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log(usage)
    return
  }
  if (process.platform !== 'darwin') throw new Error('This regression harness only supports packaged macOS .app bundles')

  const subjectApp = resolve(options.subjectApp)
  const replacementAsar = resolve(options.replacementAsar)
  const resourcesDirectory = join(subjectApp, 'Contents', 'Resources')
  const subjectAsar = join(resourcesDirectory, 'app.asar')
  const executable = await packagedExecutable(subjectApp)
  await access(subjectAsar, fsConstants.R_OK | fsConstants.W_OK)
  await access(replacementAsar, fsConstants.R_OK)
  if ((await realpath(subjectAsar)) === (await realpath(replacementAsar))) {
    throw new Error('The replacement ASAR must not be the subject app.asar')
  }

  const [subjectArchive, replacementArchive, subjectDigest, replacementDigest] = await Promise.all([
    inspectAsar(subjectAsar),
    inspectAsar(replacementAsar),
    hashFile(subjectAsar),
    hashFile(replacementAsar)
  ])
  requireAppArchive(subjectArchive, 'subject')
  requireAppArchive(replacementArchive, 'replacement')
  if (subjectDigest === replacementDigest) throw new Error('The replacement ASAR has the same SHA-256 digest as the subject ASAR')

  const chunks = subjectArchive.files.filter(path => CODEMIRROR_CHUNK.test(path))
  if (chunks.length !== 1) {
    throw new Error(`Expected exactly one subject CodeMirrorEditor chunk, found ${chunks.length}: ${chunks.join(', ') || '(none)'}`)
  }
  const chunkPath = chunks[0]
  if (replacementArchive.files.includes(chunkPath)) {
    throw new Error(`Replacement ASAR still contains the selected old chunk: ${chunkPath}`)
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'agentsdock-asar-swap-'))
  const userData = join(tempRoot, 'user-data')
  const appLogPath = join(userData, 'logs', 'agentsdock.log')
  const backupAsar = join(resourcesDirectory, `.app.asar.regression-backup-${randomUUID()}`)
  const stagedAsar = join(resourcesDirectory, `.app.asar.regression-stage-${randomUUID()}`)
  let child = null
  let cdp = null
  let backupCreated = false
  let swapped = false
  let interrupted = false
  const handleSignal = () => {
    interrupted = true
    void terminateChild(child)
  }
  process.once('SIGINT', handleSignal)
  process.once('SIGTERM', handleSignal)

  try {
    console.log(`subject: ${subjectApp}`)
    console.log(`chunk:   ${chunkPath}`)
    console.log(`userData: ${userData}`)

    const stderrLines = []
    let stderrBuffer = ''
    const devToolsURL = deferred()
    child = spawn(executable, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], {
      env: {
        ...process.env,
        AGENTSDOCK_DISABLE_ANALYTICS: '1',
        AGENTSDOCK_USER_DATA: userData
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const mainPid = child.pid
    if (!mainPid) throw new Error('Packaged app did not report a PID')
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => process.stdout.write(`[app stdout] ${chunk}`))
    child.stderr.on('data', chunk => {
      const text = String(chunk)
      stderrLines.push(text)
      stderrBuffer += text
      const match = stderrBuffer.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) devToolsURL.resolve(match[1])
    })
    child.once('error', devToolsURL.reject)
    child.once('exit', (code, signal) => devToolsURL.reject(new Error(`App exited before CDP was ready (code=${code}, signal=${signal})`)))

    const browserURL = await withTimeout(devToolsURL.promise, STARTUP_TIMEOUT_MS, 'Timed out waiting for the DevTools endpoint')
    cdp = new CdpConnection(browserURL)
    await cdp.connect()
    await cdp.call('Target.setDiscoverTargets', { discover: true })
    const page = await waitForPageTarget(cdp, subjectAsar)
    const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    const diagnostics = []
    cdp.onEvent(packet => collectDiagnostic(packet, sessionId, diagnostics))
    await Promise.all([
      cdp.call('Runtime.enable', {}, sessionId),
      cdp.call('Log.enable', {}, sessionId)
    ])
    await waitForRendererReady(cdp, sessionId)

    const browserVersion = await cdp.call('Browser.getVersion')
    const electronVersion = electronVersionFromUserAgent(browserVersion.userAgent)
    if (options.expectedElectron && electronVersion !== options.expectedElectron) {
      throw new Error(`Electron version mismatch: expected ${options.expectedElectron}, got ${electronVersion || '(not present in user agent)'}`)
    }

    const chunkURL = new URL(`./assets/${basename(chunkPath)}`, page.url).href
    const alreadyLoaded = await evaluate(cdp, sessionId, `performance.getEntriesByType('resource').some(entry => entry.name === ${JSON.stringify(chunkURL)})`)
    if (alreadyLoaded) throw new Error(`Selected lazy chunk was already loaded before the ASAR swap: ${chunkURL}`)

    const rendererPid = await soleRendererPid(cdp)
    if (!isProcessRunning(child)) throw new Error(`Main app PID ${mainPid} exited before the ASAR swap`)
    console.log(`pre-swap: main PID ${mainPid}, renderer PID ${rendererPid}, selected chunk not loaded`)

    const logOffset = await fileSize(appLogPath)
    const diagnosticOffset = diagnostics.length
    const stderrOffset = stderrLines.length
    const originalStat = await stat(subjectAsar)
    await link(subjectAsar, backupAsar)
    backupCreated = true
    await copyFile(replacementAsar, stagedAsar)
    await chmod(stagedAsar, originalStat.mode)
    await syncFile(stagedAsar)
    await rename(stagedAsar, subjectAsar)
    swapped = true
    const swappedStat = await stat(subjectAsar)
    if (sameInode(originalStat, swappedStat)) throw new Error('Atomic replacement did not change the app.asar inode')
    const liveDigest = await hashFile(subjectAsar)
    if (liveDigest !== replacementDigest) throw new Error('Live app.asar does not match the requested replacement after rename')
    console.log(`swapped: inode ${originalStat.ino} -> ${swappedStat.ino}`)

    const imported = await evaluate(cdp, sessionId, `import(${JSON.stringify(chunkURL)}).then(module => ({ keys: Object.keys(module).sort() }))`)
    if (!imported?.keys?.includes('CodeMirrorEditor')) {
      throw new Error(`Old chunk import resolved without the expected CodeMirrorEditor export: ${JSON.stringify(imported)}`)
    }

    await delay(SETTLE_AFTER_IMPORT_MS)
    const rendererPidAfter = await soleRendererPid(cdp)
    if (rendererPidAfter !== rendererPid) {
      throw new Error(`Renderer PID changed across the ASAR swap/import: ${rendererPid} -> ${rendererPidAfter}`)
    }
    if (!isProcessRunning(child) || child.pid !== mainPid) throw new Error(`Main app PID ${mainPid} did not survive the ASAR swap/import`)
    const survivalProbe = await evaluate(cdp, sessionId, `({ readyState: document.readyState })`)
    if (survivalProbe.readyState !== 'complete') {
      throw new Error(`CDP survival probe failed: ${JSON.stringify(survivalProbe)}`)
    }
    await cdp.call('Browser.getVersion')

    const postSwapDiagnostics = diagnostics.slice(diagnosticOffset)
    if (postSwapDiagnostics.length) {
      throw new Error(`CDP reported post-swap errors:\n${postSwapDiagnostics.map(item => `  ${item}`).join('\n')}`)
    }
    const postSwapLog = await readFileTail(appLogPath, logOffset)
    if (APP_LOG_FAILURE.test(postSwapLog)) throw new Error(`App log contains a post-swap failure signal:\n${postSwapLog.trim()}`)
    const postSwapStderr = stderrLines.slice(stderrOffset).join('')
    if (APP_LOG_FAILURE.test(postSwapStderr)) throw new Error(`App stderr contains a post-swap failure signal:\n${postSwapStderr.trim()}`)

    console.log(`PASS: ${basename(chunkPath)} resolved from the original inode; main/renderer PIDs and CDP survived with no failure logs${electronVersion ? ` (Electron ${electronVersion})` : ''}.`)
  } finally {
    process.removeListener('SIGINT', handleSignal)
    process.removeListener('SIGTERM', handleSignal)
    if (cdp && !cdp.closed && isProcessRunning(child)) {
      try { await cdp.call('Browser.close') } catch { /* fall through to process termination */ }
      if (isProcessRunning(child)) await waitForExit(child, EXIT_TIMEOUT_MS)
    }
    await terminateChild(child)
    cdp?.close()
    if (swapped && backupCreated) {
      await rename(backupAsar, subjectAsar)
      backupCreated = false
      swapped = false
    }
    await removeIfPresent(stagedAsar)
    if (backupCreated) await removeIfPresent(backupAsar)
    await rm(tempRoot, { recursive: true, force: true })
    if (interrupted) throw new Error('Interrupted')
  }
}

function parseArguments(args) {
  let expectedElectron
  const positional = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--expected-electron') {
      expectedElectron = args[index + 1]
      if (!expectedElectron) throw new Error('--expected-electron requires a version')
      index += 1
      continue
    }
    if (argument.startsWith('--expected-electron=')) {
      expectedElectron = argument.slice('--expected-electron='.length)
      if (!expectedElectron) throw new Error('--expected-electron requires a version')
      continue
    }
    if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`)
    positional.push(argument)
  }
  if (positional.length !== 2) throw new Error(usage)
  return { subjectApp: positional[0], replacementAsar: positional[1], expectedElectron }
}

async function packagedExecutable(appPath) {
  if (!appPath.endsWith('.app')) throw new Error(`Subject must be a macOS .app bundle: ${appPath}`)
  const macOSDirectory = join(appPath, 'Contents', 'MacOS')
  const entries = await readdir(macOSDirectory, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(macOSDirectory, entry.name)
    try {
      await access(path, fsConstants.X_OK)
      candidates.push(path)
    } catch { /* not the bundle executable */ }
  }
  if (candidates.length !== 1) {
    throw new Error(`Expected one executable in ${macOSDirectory}, found ${candidates.length}: ${candidates.join(', ') || '(none)'}`)
  }
  return candidates[0]
}

async function inspectAsar(path) {
  const handle = await open(path, 'r')
  try {
    const archiveStat = await handle.stat()
    const sizePickle = Buffer.alloc(8)
    await readExactly(handle, sizePickle, 0)
    if (sizePickle.readUInt32LE(0) !== 4) throw new Error(`${path} has an invalid ASAR size pickle`)
    const headerSize = sizePickle.readUInt32LE(4)
    if (headerSize < 8 || headerSize > archiveStat.size - 8 || headerSize > 128 * 1024 * 1024) {
      throw new Error(`${path} has an invalid ASAR header size: ${headerSize}`)
    }
    const headerPickle = Buffer.alloc(headerSize)
    await readExactly(handle, headerPickle, 8)
    const payloadSize = headerPickle.readUInt32LE(0)
    const jsonSize = headerPickle.readInt32LE(4)
    if (jsonSize < 2 || jsonSize > payloadSize - 4 || jsonSize > headerSize - 8) {
      throw new Error(`${path} has an invalid ASAR JSON header length: ${jsonSize}`)
    }
    const header = JSON.parse(headerPickle.subarray(8, 8 + jsonSize).toString('utf8'))
    if (!header || typeof header !== 'object' || !header.files || typeof header.files !== 'object') {
      throw new Error(`${path} has no ASAR file tree`)
    }
    return { files: listAsarFiles(header), headerSize, size: archiveStat.size }
  } finally {
    await handle.close()
  }
}

async function readExactly(handle, buffer, position) {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset)
    if (!bytesRead) throw new Error(`Unexpected end of file while reading ${handle.fd}`)
    offset += bytesRead
  }
}

function listAsarFiles(header) {
  const files = []
  const visit = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const path = prefix ? `${prefix}/${name}` : name
      files.push(path)
      if (child?.files) visit(child, path)
    }
  }
  visit(header, '')
  return files.sort()
}

function requireAppArchive(archive, label) {
  for (const required of ['package.json', 'out/main/index.js', 'out/renderer/index.html']) {
    if (!archive.files.includes(required)) throw new Error(`The ${label} ASAR is not a packaged AgentsDock archive: missing ${required}`)
  }
}

async function waitForPageTarget(cdp, subjectAsar) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.call('Target.getTargets')
    const pages = targetInfos.filter(target => target.type === 'page' && target.url.startsWith('file:'))
    const page = pages.find(target => decodeURIComponent(target.url).includes(subjectAsar)) || pages[0]
    if (page) return page
    await delay(100)
  }
  throw new Error('Timed out waiting for the packaged renderer target')
}

async function waitForRendererReady(cdp, sessionId) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(cdp, sessionId, `document.readyState === 'complete' && typeof window.agentsDock === 'object'`)
      if (ready) return
    } catch { /* execution context may not exist yet */ }
    await delay(100)
  }
  throw new Error('Timed out waiting for the packaged renderer to become ready')
}

async function evaluate(cdp, sessionId, expression) {
  const response = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }, sessionId)
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text
    throw new Error(`Renderer evaluation failed: ${description}`)
  }
  return response.result?.value
}

async function soleRendererPid(cdp) {
  const { processInfo } = await cdp.call('SystemInfo.getProcessInfo')
  const rendererPids = processInfo.filter(process => process.type === 'renderer').map(process => process.id)
  if (rendererPids.length !== 1) {
    throw new Error(`Expected one renderer PID in the isolated app, found ${rendererPids.length}: ${rendererPids.join(', ') || '(none)'}`)
  }
  return rendererPids[0]
}

function collectDiagnostic(packet, sessionId, diagnostics) {
  if (packet.sessionId !== sessionId) return
  if (packet.method === 'Runtime.exceptionThrown') {
    diagnostics.push(`exception: ${packet.params.exceptionDetails.exception?.description || packet.params.exceptionDetails.text}`)
  } else if (packet.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(packet.params.type)) {
    diagnostics.push(`console ${packet.params.type}: ${packet.params.args.map(argument => argument.value ?? argument.description).join(' ')}`)
  } else if (packet.method === 'Log.entryAdded' && packet.params.entry.level === 'error') {
    diagnostics.push(`log error: ${packet.params.entry.text}`)
  }
}

function electronVersionFromUserAgent(userAgent = '') {
  return userAgent.match(/\bElectron\/([^\s]+)/)?.[1]
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function syncFile(path) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function isProcessRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null)
}

async function terminateChild(child) {
  if (!isProcessRunning(child)) return
  child.kill('SIGTERM')
  if (await waitForExit(child, EXIT_TIMEOUT_MS)) return
  child.kill('SIGKILL')
  await waitForExit(child, 2_000)
}

async function waitForExit(child, timeoutMs) {
  if (!isProcessRunning(child)) return true
  return await new Promise(resolveExit => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolveExit(true)
    }
    child.once('exit', onExit)
  })
}

async function fileSize(path) {
  try { return (await stat(path)).size } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

async function readFileTail(path, offset) {
  try {
    const contents = await readFile(path)
    return contents.subarray(Math.min(offset, contents.length)).toString('utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

async function removeIfPresent(path) {
  try { await unlink(path) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function deferred() {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), timeoutMs) })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

main().catch(error => {
  console.error(`FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exitCode = 1
})
