#!/usr/bin/env node
/**
 * Production updater smoke test, deliberately restricted to disposable macOS
 * GitHub runners. It uses the signed published packages, real UI input and
 * native Squirrel installation, never a patched updater or renderer test hook.
 * Run after BOTH the canonical release and legacy mirror are public:
 * node scripts/verify_electron_migration.mjs --from-version 0.2.13-beta.33 \
 *   --to-version 1.0.0-beta.1 --output "$RUNNER_TEMP/agentsdock-migration"
 * For stable promotion, run separate disposable jobs with:
 *   --from-version 0.2.12 --to-version 1.0.0 --track stable
 *   --from-version 1.0.0-beta.2 --to-version 1.0.0 --track beta
 * The track is the saved subscription, not the target release's metadata.
 * Beta remains the default for the existing bridge acceptance command.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const LEGACY = 'https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/download'
const CANONICAL = 'https://github.com/ZhengyiLuo/AgentsDock/releases/download'
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export function parseArguments(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!['--from-version', '--to-version', '--output', '--track'].includes(key) || !argv[i + 1] || options[key]) {
      throw new Error(`Invalid or duplicate argument: ${key}`)
    }
    options[key] = argv[i + 1]
  }
  assert(VERSION.test(options['--from-version']), 'A valid source desktop version is required')
  assert(VERSION.test(options['--to-version']), 'A valid target desktop version is required')
  assert(options['--from-version'] !== options['--to-version'], 'Migration versions must differ')
  const track = options['--track'] ?? 'beta'
  assert(track === 'stable' || track === 'beta', 'Track must be stable or beta')
  assert(track !== 'stable' || !options['--to-version'].includes('-'), 'Stable track cannot offer a prerelease target')
  assert(isAbsolute(options['--output'] ?? ''), 'Output must be an absolute path')
  return { from: options['--from-version'], to: options['--to-version'], track, output: resolve(options['--output']) }
}

export function assertMigrationTrack(track, status, persistedTrack) {
  assert(track === 'stable' || track === 'beta', 'Track must be stable or beta')
  assert.equal(status.track, track, 'Updater changed the selected test subscription')
  assert.equal(typeof persistedTrack, 'string', 'Saved update track is missing')
  assert.equal(persistedTrack.trim(), track, 'Saved update track changed during migration')
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }).trim()
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function until(label, action, milliseconds = 60_000) {
  const deadline = Date.now() + milliseconds
  let lastError
  do {
    try {
      const result = await action()
      if (result) return result
    } catch (error) { lastError = error }
    await delay(1000)
  } while (Date.now() < deadline)
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

async function releaseApp(base, version, output, name) {
  const asset = `AgentsDock-${version}-mac-universal.zip`
  const checksumResponse = await fetch(`${base}/v${version}/SHA256SUMS`, { signal: AbortSignal.timeout(30_000) })
  assert(checksumResponse.ok, `Checksum download failed: ${checksumResponse.status}`)
  const checksums = await checksumResponse.text()
  assert(Buffer.byteLength(checksums) < 64 * 1024, 'Unexpected checksum manifest size')
  const lines = checksums.split(/\r?\n/).filter(line => line.slice(66).replace(/^\*/, '') === asset)
  assert.equal(lines.length, 1, `Missing or duplicate checksum for ${asset}`)
  const checksum = lines[0].slice(0, 64)
  assert(/^[a-f0-9]{64}$/.test(checksum), 'Invalid release checksum')
  const archive = join(output, asset)
  run('/usr/bin/curl', ['--fail', '--location', '--retry', '3', '--max-time', '600', '--output', archive, `${base}/v${version}/${asset}`])
  assert.equal(await hashFile(archive), checksum, 'Published ZIP checksum mismatch')
  const extracted = join(output, name)
  await mkdir(extracted)
  run('/usr/bin/ditto', ['-x', '-k', archive, extracted])
  const app = join(extracted, 'AgentsDock.app')
  verifyApp(app, version)
  return { app, zipSHA256: checksum, asarSHA256: await hashFile(join(app, 'Contents/Resources/app.asar')) }
}

function appVersion(app) {
  return run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')])
}

function verifyApp(app, version) {
  assert.equal(appVersion(app), version)
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  // Verify the signer instead of trusting an Info.plist string or parsing the
  // human-oriented codesign output (which is written to stderr).
  run('/usr/bin/codesign', ['--verify', '-R=anchor apple generic and certificate leaf[subject.OU] = "KRR35MWWHD"', app])
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
  assert(!existsSync(join(app, 'Contents/Resources/disable-auto-update')), 'A local update-disabled package is not valid migration evidence')
}

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function connect(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then(response => response.json())
  const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl && item.url.startsWith('file:'))
  assert(target, 'Owned app renderer is not available')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const requests = new Map()
  let nextId = 0
  socket.addEventListener('message', event => {
    const packet = JSON.parse(String(event.data))
    const request = requests.get(packet.id)
    if (!request) return
    requests.delete(packet.id)
    clearTimeout(request.timer)
    packet.error ? request.reject(new Error(packet.error.message)) : request.resolve(packet.result)
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 15_000)
    requests.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert(!result.exceptionDetails, result.exceptionDetails?.text)
    return result.result.value
  }
  return {
    call, evaluate,
    close: () => socket.close(),
    screenshot: async path => {
      const result = await call('Page.captureScreenshot', { format: 'png' })
      await writeFile(path, Buffer.from(result.data, 'base64'))
    },
    clickButton: async names => {
      const point = await until(`Visible button ${names.join('/')}`, () => evaluate(`(() => {
        const names = ${JSON.stringify(names)};
        const button = [...document.querySelectorAll('button')].find(el => !el.disabled &&
          names.includes((el.getAttribute('aria-label') || el.textContent).trim()) && el.getClientRects().length);
        if (!button) return null;
        const rect = button.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        return button.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
      })()`))
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    }
  }
}

// The last pre-1.0 Stable app has one scrolling Settings panel, while the
// bridge has an Updates tab. Navigate those real controls without changing
// the update channel or invoking the installer outside the rendered UI.
export function locateMigrationUpdateSettings(document) {
  const updatesTab = [...document.querySelectorAll('button')].find(button =>
    !button.disabled && (button.getAttribute('aria-label') || button.textContent).trim() === 'Updates' &&
    button.getClientRects().length)
  if (updatesTab) return 'tab'
  const panels = [...document.querySelectorAll('.update-panel')].filter(panel =>
    panel.getClientRects().length &&
    /^App updates(?:\s|$)/.test(panel.querySelector('.update-copy strong')?.textContent?.trim() ?? '') &&
    panel.querySelector('[aria-label="App update channel"]'))
  if (panels.length !== 1) return null
  panels[0].scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
  return 'inline'
}

async function openMigrationUpdateSettings(client) {
  await client.clickButton(['Open app settings', 'App settings', 'Settings'])
  const target = await until('App update settings navigation', () =>
    client.evaluate(`(${locateMigrationUpdateSettings.toString()})(document)`))
  if (target === 'tab') await client.clickButton(['Updates'])
}

function processesFor(app) {
  const executable = `${app}/Contents/MacOS/AgentsDock`
  return run('/bin/ps', ['-axo', 'pid=,command=']).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return match && (match[2] === executable || match[2].startsWith(`${executable} `)) ? [Number(match[1])] : []
  })
}

async function stopOwned(app) {
  for (const pid of processesFor(app)) {
    try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  await until('Owned app exit', () => processesFor(app).length === 0, 20_000)
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  assert(process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'macOS',
    'This installer test is restricted to disposable macOS GitHub runners, never a developer machine')
  assert(process.env.RUNNER_TEMP, 'RUNNER_TEMP is required')
  const runnerTemp = await realpath(process.env.RUNNER_TEMP)
  const parent = await realpath(resolve(options.output, '..'))
  const scoped = relative(runnerTemp, join(parent, basename(options.output)))
  assert(scoped && !scoped.startsWith('..') && !isAbsolute(scoped), 'Output must be a new directory inside RUNNER_TEMP')
  assert(!existsSync(options.output), 'Refusing to reuse an existing installer-test directory')
  assert(!run('/bin/ps', ['-axo', 'command=']).includes('/AgentsDock.app/Contents/MacOS/AgentsDock'), 'An AgentsDock app is already running')
  await mkdir(options.output)
  const logs = createWriteStream(join(options.output, 'app.log'), { flags: 'wx' })
  let client
  let ownedApp
  try {
    const previous = await releaseApp(LEGACY, options.from, options.output, 'installation')
    const expected = await releaseApp(CANONICAL, options.to, options.output, 'expected')
    ownedApp = previous.app
    const profileDirectory = join(options.output, 'profile')
    await mkdir(profileDirectory)
    const fixture = {
      schemaVersion: 2, activeProfileId: 'migration-smoke', profiles: [{
        id: 'migration-smoke', name: 'Migration test — disconnected', serverUrl: 'http://127.0.0.1:9',
        serverIdentity: null, keychainAccessToken: false, serverSetupComplete: true,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
      }]
    }
    await writeFile(join(profileDirectory, 'settings.json'), `${JSON.stringify(fixture)}\n`)
    // Seed only this disposable profile, before launch. Never switch the real
    // updater's track to make a target appear or repair a failed assertion.
    await writeFile(join(profileDirectory, 'update-track'), `${options.track}\n`)
    await writeFile(join(profileDirectory, 'app-language.json'), '{"preference":"en"}\n')
    const port = await freePort()
    const launch = () => {
      const child = spawn(join(ownedApp, 'Contents/MacOS/AgentsDock'), [`--remote-debugging-port=${port}`], {
        env: { ...process.env, AGENTSDOCK_USER_DATA: profileDirectory, AGENTSDOCK_DISABLE_ANALYTICS: '1' }, stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stdout.pipe(logs, { end: false })
      child.stderr.pipe(logs, { end: false })
      child.on('error', error => logs.write(`Launch error: ${error.message}\n`))
      return child
    }
    const original = launch()
    client = await until('Legacy app renderer', () => connect(port))
    await client.call('Page.bringToFront')
    await until('Legacy app ready', () => client.evaluate('Boolean(window.agentsDock?.updates)'))
    const before = await client.evaluate('window.agentsDock.updates.status()')
    assert.equal(before.currentVersion, options.from)
    assert.equal(before.channel, 'direct')
    assertMigrationTrack(options.track, before, await readFile(join(profileDirectory, 'update-track'), 'utf8'))
    const beforeBootstrap = await client.evaluate('window.agentsDock.bootstrap()')
    assert.equal(beforeBootstrap.activeProfileId, fixture.activeProfileId, 'Old app did not use the isolated test profile')
    assert.equal(beforeBootstrap.profiles.find(profile => profile.id === 'migration-smoke')?.name, fixture.profiles[0].name)
    await openMigrationUpdateSettings(client)
    await client.screenshot(join(options.output, '01-legacy-updater.png'))
    const downloaded = await until('Published target download', async () => {
      const status = await client.evaluate('window.agentsDock.updates.status()')
      if (status.state === 'error' || status.state === 'disabled') throw new Error(status.message)
      return status.state === 'downloaded' ? status : null
    }, 8 * 60_000)
    assert.equal(downloaded.availableVersion, options.to, 'Source feed did not offer the expected target')
    assertMigrationTrack(options.track, downloaded, await readFile(join(profileDirectory, 'update-track'), 'utf8'))
    await client.screenshot(join(options.output, '02-bridge-ready.png'))
    await client.clickButton(['Restart to update'])
    client.close()
    client = null
    await until('Native updater replaced the installed bundle', () => appVersion(ownedApp) === options.to, 4 * 60_000)
    verifyApp(ownedApp, options.to)
    assert.equal(await hashFile(join(ownedApp, 'Contents/Resources/app.asar')), expected.asarSHA256, 'Installed app differs from the sealed public target')
    const relaunched = await until('Native updater relaunched the app', () => processesFor(ownedApp).find(pid => pid !== original.pid))
    // Squirrel may omit diagnostic CLI arguments on relaunch. Reopen only the
    // owned installation to inspect its normal startup with the same profile.
    await stopOwned(ownedApp)
    launch()
    client = await until('Updated renderer', () => connect(port))
    await client.call('Page.bringToFront')
    await until('Updated app ready', () => client.evaluate('Boolean(window.agentsDock?.updates)'))
    const after = await client.evaluate('window.agentsDock.updates.status()')
    assert.equal(after.currentVersion, options.to)
    assertMigrationTrack(options.track, after, await readFile(join(profileDirectory, 'update-track'), 'utf8'))
    assert.equal(after.channel, 'direct')
    const afterBootstrap = await client.evaluate('window.agentsDock.bootstrap()')
    assert.equal(afterBootstrap.activeProfileId, fixture.activeProfileId)
    assert.equal(afterBootstrap.profiles.find(profile => profile.id === 'migration-smoke')?.name, fixture.profiles[0].name)
    assert.match(await readFile(join(ownedApp, 'Contents/Resources/app-update.yml'), 'utf8'), /repo:\s*AgentsDock\s*$/m)
    const settings = JSON.parse(await readFile(join(profileDirectory, 'settings.json'), 'utf8'))
    assert.equal(settings.activeProfileId, fixture.activeProfileId)
    assert.equal(settings.profiles.find(profile => profile.id === 'migration-smoke')?.name, fixture.profiles[0].name)
    assert.equal(settings.profiles.find(profile => profile.id === 'migration-smoke')?.serverUrl, fixture.profiles[0].serverUrl)
    assert.equal(JSON.parse(await readFile(join(profileDirectory, 'app-language.json'), 'utf8')).preference, 'en')
    await openMigrationUpdateSettings(client)
    await until('Updated app checked its canonical feed', async () => {
      const status = await client.evaluate('window.agentsDock.updates.status()')
      return status.state === 'not-available' && status.currentVersion === options.to
    })
    await client.screenshot(join(options.output, '03-canonical-feed-current.png'))
    const receipt = { from: options.from, to: options.to, track: options.track, beforeTrack: before.track, afterTrack: after.track,
      sourceZIP: previous.zipSHA256, targetZIP: expected.zipSHA256,
      installedASAR: expected.asarSHA256, nativeRelaunchObserved: Boolean(relaunched), preserved: ['profile', 'update-track', 'language'],
      checks: ['signed old package', 'real UI download/install', 'native replacement/relaunch', 'public target identity', 'new feed check'],
      completedAt: new Date().toISOString() }
    await writeFile(join(options.output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
    console.log(JSON.stringify(receipt, null, 2))
  } catch (error) {
    if (client) await client.screenshot(join(options.output, 'failure.png')).catch(() => {})
    throw error
  } finally {
    client?.close()
    if (ownedApp) await stopOwned(ownedApp)
    logs.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.stack); process.exitCode = 1 })
}
