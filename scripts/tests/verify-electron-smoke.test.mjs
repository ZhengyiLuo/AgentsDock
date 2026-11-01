import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyElectronSmoke } from '../verify_electron_smoke.mjs'

const posix = ['darwin', 'linux'].includes(process.platform)
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }

async function fixture(t, code, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentsdock-smoke-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const userDataPath = join(root, 'new-profile'), logPath = join(root, 'smoke.log')
  return { root, logPath, userDataPath, run: overrides => verifyElectronSmoke({
    executable: process.execPath, args: ['-e', code], userDataPath, logPath,
    launchMilliseconds: 200, shutdownMilliseconds: 300, cleanupMilliseconds: 300, ...options, ...overrides
  }) }
}

test('isolated launch records clean exit without claiming interactive quit or changing HOME', { skip: !posix }, async t => {
  const item = await fixture(t, `
    console.log(JSON.stringify({ profile: process.env.AGENTSDOCK_USER_DATA,
      discovery: process.env.AGENTSDOCK_DISABLE_LOCAL_SERVER_DISCOVERY,
      analytics: process.env.AGENTSDOCK_DISABLE_ANALYTICS, actualHome: process.env.HOME,
      runAsNode: process.env.ELECTRON_RUN_AS_NODE, nodeOptions: process.env.NODE_OPTIONS }))
    process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 100)
  `, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--no-warnings' } })
  const result = await item.run()
  assert.equal(result.exitCode, 0)
  assert.equal(result.exitSignal, null)
  assert.equal(result.forcedCleanup, false)
  assert.equal(result.interactiveQuitAccepted, false)
  const observed = JSON.parse(await readFile(item.logPath, 'utf8'))
  assert.equal(observed.profile, item.userDataPath)
  assert.equal(observed.discovery, '1')
  assert.equal(observed.analytics, '1')
  assert.equal(observed.actualHome, process.env.HOME)
  assert.equal(observed.runAsNode, undefined)
  assert.equal(observed.nodeOptions, undefined)
  assert.equal((await stat(item.userDataPath)).mode & 0o777, 0o700)
  assert.equal((await stat(item.logPath)).mode & 0o777, 0o600)
})

test('a shutdown timeout stays failed after owned forced cleanup; unrelated process survives', { skip: !posix }, async t => {
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)'], { stdio: 'ignore' })
  t.after(() => sentinel.kill('SIGTERM'))
  const item = await fixture(t, `console.log(process.pid); process.on('SIGTERM', () => {}); setInterval(() => {}, 100)`)
  const started = Date.now()
  await assert.rejects(item.run(), /shutdown deadline/)
  assert(Date.now() - started < 5_000)
  const pid = Number((await readFile(item.logPath, 'utf8')).trim())
  assert(pid > 1)
  assert.equal(alive(pid), false)
  assert.equal(alive(sentinel.pid), true)
})

test('nonzero shutdown fails even though termination finishes within its bound', { skip: !posix }, async t => {
  const item = await fixture(t, `process.on('SIGTERM', () => process.exit(17)); setInterval(() => {}, 100)`)
  await assert.rejects(item.run(), /did not exit cleanly \(code=17, signal=none\)/)
})

test('clean main-process exit with surviving owned helper is failure and helper is cleaned up', { skip: !posix }, async t => {
  const item = await fixture(t, `
    const helper = require('node:child_process').spawn(process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 100)'], { stdio: 'ignore' })
    console.log(helper.pid)
    process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 100)
  `)
  await assert.rejects(item.run(), /left owned helper processes running/)
  const pid = Number((await readFile(item.logPath, 'utf8')).trim())
  assert(pid > 1)
  assert.equal(alive(pid), false)
})

test('signal termination is reported rather than described as clean app shutdown', { skip: !posix }, async t => {
  const item = await fixture(t, `setInterval(() => {}, 100)`)
  await assert.rejects(item.run(), /did not exit cleanly \(code=null, signal=SIGTERM\)/)
})

test('an early exit cannot pass a launch smoke check', { skip: !posix }, async t => {
  const item = await fixture(t, `setTimeout(() => process.exit(0), 100)`)
  await assert.rejects(item.run(), /exited during isolated launch/)
})

test('existing profile and log are not reused', { skip: !posix }, async t => {
  const item = await fixture(t, `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 100)`)
  await item.run()
  await assert.rejects(item.run(), /EEXIST/)
  await assert.rejects(item.run({ userDataPath: join(item.root, 'other-profile') }), /EEXIST/)
})

test('captured log is bounded and overflow is failure, not a raw log dump', { skip: !posix }, async t => {
  const item = await fixture(t, `console.log('synthetic-secret'.repeat(10_000)); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 100)`,
    { maximumLogBytes: 100 })
  await assert.rejects(item.run(), error => {
    assert.match(error.message, /log exceeded its bound/)
    assert(!error.message.includes('synthetic-secret'))
    return true
  })
  assert.equal((await stat(item.logPath)).size, 100)
})

test('output written at shutdown is drained and cannot hide a late log overflow', { skip: !posix }, async t => {
  const item = await fixture(t, `
    process.on('SIGTERM', () => process.stdout.write('late-output'.repeat(10_000), () => process.exit(0)))
    setInterval(() => {}, 100)
  `, { maximumLogBytes: 100 })
  await assert.rejects(item.run(), /log exceeded its bound/)
  assert.equal((await stat(item.logPath)).size, 100)
})

test('cancelling observation cleans up only its owned process and remains failure', { skip: !posix }, async t => {
  const controller = new AbortController()
  const item = await fixture(t, `console.log(process.pid); process.on('SIGTERM', () => {}); setInterval(() => {}, 100)`,
    { launchMilliseconds: 2_000, signal: controller.signal })
  const result = item.run()
  await delay(150)
  controller.abort()
  await assert.rejects(result, /cancelled/)
  const pid = Number((await readFile(item.logPath, 'utf8')).trim())
  assert(pid > 1)
  assert.equal(alive(pid), false)
})

test('smoke verifier delegates bounded supervision and never tails private app logs', async () => {
  const text = await readFile(new URL('../verify_electron_release.sh', import.meta.url), 'utf8')
  assert(text.includes('node "$ROOT/scripts/verify_electron_smoke.mjs"'))
  assert(!text.includes('wait "$SMOKE_PID"'))
  assert(!text.includes('tail -80'))
  assert(text.includes('interactive quit acceptance is separate'))
})
