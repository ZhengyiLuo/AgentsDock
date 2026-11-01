#!/usr/bin/env node
// Release orchestration only: run the pinned source builder unchanged. Recover
// only a recognized DMG ticket-download network failure, then run its complete
// native verifier. Never sign, resubmit, repack the app, or publish here.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const need = (ok, message) => { if (!ok) throw new Error(message) }
export function transientStapleFailure(code, output) {
  return code === 68 && /Error Domain=NSURLErrorDomain Code=-(?:1005|1001)\b/.test(output) &&
    /api\.apple-cloudkit\.com\//.test(output) && /staple and validate action failed! Error 68\./.test(output)
}
export function recoverableBuildFailure(code, output, version) {
  const tail = output.slice(-65536)
  const processing = tail.lastIndexOf('Processing: ')
  return processing >= 0 &&
    tail.slice(processing).split('\n')[0].trim().endsWith(`/AgentsDock-${version}-mac-universal.dmg`) &&
    /status: Accepted\b/.test(tail.slice(0, processing)) &&
    transientStapleFailure(code, tail.slice(processing))
}
export function removeDmgMetadata(text, name) {
  const lines = text.split('\n'), result = []
  let skipping = false, matches = 0
  for (const line of lines) {
    if (line === `  - url: ${name}`) { skipping = true; matches++; continue }
    if (skipping && (/^  - url:/.test(line) || /^path:/.test(line))) skipping = false
    if (!skipping) result.push(line)
  }
  need(matches === 1, 'Expected exactly one pre-stapling DMG metadata entry.')
  return result.join('\n')
}
export async function retryStaple(run, wait, report = () => {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await run()
    if (result.status === 0) return
    need(attempt < 3 && transientStapleFailure(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`),
      'DMG stapling failed; no verified release may be produced.')
    report(`Transient Apple ticket-download failure; retry ${attempt + 1}/3.`)
    await wait(15000 * (attempt + 1))
  }
}
function regular(path) {
  const stat = lstatSync(path)
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, 'Expected a regular nonempty release asset.')
}
function command(program, args, timeout = 120000) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  return result
}
function checked(program, args, timeout) {
  const result = command(program, args, timeout)
  need(result.status === 0, `Required macOS release verification failed: ${program}`)
}
export async function main(args = process.argv.slice(2)) {
  need(args.length === 3, 'Usage: build_macos_with_staple_recovery.mjs SOURCE_ROOT SOURCE_SHA VERSION')
  const [rootInput, source, version] = args, root = resolve(rootInput)
  need(/^[a-f0-9]{40}$/.test(source) && /^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/.test(version), 'Invalid frozen source/version.')
  const pin = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  need(pin.status === 0 && pin.stdout.trim() === source, 'Builder must run the exact frozen product source.')
  const track = process.env.AGENTSDOCK_RELEASE_TRACK
  need(track === 'beta' || track === 'stable', 'Explicit release track required.')
  assert.equal(JSON.parse(readFileSync(join(root, 'electron/package.json'), 'utf8')).version, version)
  let tail = ''
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(join(root, 'scripts/build_electron_release.sh'), [], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', bytes => {
      output.write(bytes); tail = (tail + bytes.toString()).slice(-262144)
    })
    child.on('error', reject); child.on('close', (code, signal) => resolvePromise({ code, signal }))
  })
  if (result.code === 0) return
  need(!result.signal && recoverableBuildFailure(result.code, tail, version),
    'Pinned macOS build failed outside the recoverable DMG network boundary.')
  const assets = join(root, 'electron/dist-release'), name = `AgentsDock-${version}-mac-universal.dmg`
  const dmg = join(assets, name), metadata = join(assets, `${track === 'beta' ? 'beta' : 'latest'}-mac.yml`)
  regular(dmg); regular(metadata)
  const normalized = removeDmgMetadata(readFileSync(metadata, 'utf8'), name)
  checked('/usr/bin/codesign', ['--verify', '--strict', '-R=anchor apple generic and certificate leaf[subject.OU] = "KRR35MWWHD"', dmg])
  await retryStaple(() => command('/usr/bin/xcrun', ['stapler', 'staple', dmg]),
    ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)), console.log)
  checked('/usr/bin/xcrun', ['stapler', 'validate', dmg])
  // Identical finalization to the pinned builder, reached only after success.
  const blockmap = `${dmg}.blockmap`
  regular(blockmap); unlinkSync(blockmap)
  writeFileSync(metadata, normalized)
  checked(join(root, 'scripts/verify_electron_release.sh'), [assets, version, track], 600000)
  console.log('Recovered DMG ticket download; all original native release checks passed.')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
