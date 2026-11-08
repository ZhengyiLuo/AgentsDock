#!/usr/bin/env node
// Release orchestration only: run the pinned source builder unchanged. Recover
// only recognized ticket transport failures after DMG notarization acceptance,
// then run its complete native verifier. Never sign, resubmit, repack the app,
// bypass a check, or publish here.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const need = (ok, message) => { if (!ok) throw new Error(message) }
export function transientStapleFailure(code, output) {
  return code === 68 && /Error Domain=NSURLErrorDomain Code=-(?:1005|1001)\b/.test(output) &&
    /api\.apple-cloudkit\.com\//.test(output) && /staple and validate action failed! Error 68\./.test(output)
}
export function transientValidationFailure(code, output) {
  const processing = output.lastIndexOf('Processing: ')
  const failure = processing < 0 ? output : output.slice(processing)
  return code === 68 && /Error Domain=NSURLErrorDomain Code=-(?:1005|1001)\b/.test(failure) &&
    /https:\/\/api\.apple-cloudkit\.com\/database\/1\/com\.apple\.gk\.ticket-delivery\/production\/public\/records\/lookup(?:[\s"},]|$)/.test(failure) &&
    /The validate action failed! Error 68\.\s*$/.test(failure)
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
export function recoverableVerificationFailure(code, output, version) {
  const tail = output.slice(-65536), processing = tail.lastIndexOf('Processing: ')
  if (processing < 0) return false
  const before = tail.slice(0, processing), last = tail.slice(processing)
  const target = last.split('\n')[0].trim().slice('Processing: '.length)
  // Both archives already exist and this versioned outer DMG was accepted.
  // App-stapling failures before ZIP creation are not this boundary.
  return before.includes(`/AgentsDock-${version}-mac-universal.dmg`) && /status: Accepted\b/.test(before) &&
    (target.endsWith(`/AgentsDock-${version}-mac-universal.dmg`) ||
      /\/agentsdock-release\.[A-Za-z0-9]+\/(?:zip|dmg)\/AgentsDock\.app$/.test(target)) &&
    transientValidationFailure(code, last)
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
export async function retryValidation(run, wait, report = () => {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await run()
    if (result.status === 0 && !result.signal && !result.error) return
    need(!result.signal && !result.error && attempt < 3 && transientValidationFailure(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`),
      'Required macOS release validation failed; no verified release may be produced.')
    report(`Transient Apple ticket-validation network failure; retry ${attempt + 1}/3.`)
    await wait(15000 * (attempt + 1))
  }
}
function command(program, args, timeout = 120000) {
  // Preserve stdout/stderr ordering so an older network error cannot authorize
  // recovery of a later failure. Arguments are passed positionally, not evaluated.
  const result = spawnSync('/bin/sh', ['-c', 'exec "$@" 2>&1', 'release-check', program, ...args],
    { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  return result
}
export async function snapshotFinalizedAssets(assets, version, track) {
  const zip = `AgentsDock-${version}-mac-universal.zip`, dmg = `AgentsDock-${version}-mac-universal.dmg`
  const metadataName = `${track === 'beta' ? 'beta' : 'latest'}-mac.yml`
  for (const name of [zip, `${zip}.blockmap`, dmg, metadataName]) regular(join(assets, name))
  need(!existsSync(join(assets, `${dmg}.blockmap`)), 'Final verification requires finalized DMG metadata.')
  const metadata = readFileSync(join(assets, metadataName), 'utf8').split('\n')
  need(metadata.includes(`version: ${version}`) && metadata.includes(`path: ${zip}`) &&
    metadata.includes(`  - url: ${zip}`) && !metadata.some(line => /^\s*- url:.*\.dmg["']?\s*$/.test(line)),
  'Final verification requires exact ZIP-only update metadata.')
  const snapshot = {}
  for (const name of readdirSync(assets).sort()) {
    const path = join(assets, name), stat = lstatSync(path)
    need(!stat.isSymbolicLink(), 'Release assets must not be symlinks.')
    if (stat.isDirectory()) continue
    regular(path)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    snapshot[name] = { size: stat.size, sha256: hash.digest('hex') }
  }
  return snapshot
}
export async function retryFinalVerification(run, capture, wait, report = () => {}) {
  const accepted = await capture()
  await retryValidation(async () => {
    assert.deepEqual(await capture(), accepted, 'Release assets changed before verification.')
    const result = await run()
    assert.deepEqual(await capture(), accepted, 'Release assets changed during verification.')
    return result
  }, wait, report)
}
function checked(program, args, timeout) {
  const result = command(program, args, timeout)
  need(result.status === 0, `Required macOS release verification failed: ${program}`)
}
export function streamPinnedBuild(root, output = process.stdout) {
  let tail = ''
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/sh', ['-c', 'exec "$@" 2>&1', 'release-builder', join(root, 'scripts/build_electron_release.sh')],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    // The builder's streams are merged by the shell before Node observes them.
    // stderr here can contain only the wrapper's own exec/launch diagnostics.
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
      output.write(bytes); tail = (tail + bytes.toString()).slice(-262144)
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolvePromise({ code, signal, tail }))
  })
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
  const result = await streamPinnedBuild(root), tail = result.tail
  if (result.code === 0) return
  const needsStaple = recoverableBuildFailure(result.code, tail, version)
  need(!result.signal && (needsStaple || recoverableVerificationFailure(result.code, tail, version)),
    'Pinned macOS build failed outside the recoverable ticket transport boundary.')
  const assets = join(root, 'electron/dist-release'), name = `AgentsDock-${version}-mac-universal.dmg`
  const dmg = join(assets, name), metadata = join(assets, `${track === 'beta' ? 'beta' : 'latest'}-mac.yml`)
  regular(dmg); regular(metadata)
  const wait = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
  if (needsStaple) {
    const normalized = removeDmgMetadata(readFileSync(metadata, 'utf8'), name)
    checked('/usr/bin/codesign', ['--verify', '--strict', '-R=anchor apple generic and certificate leaf[subject.OU] = "KRR35MWWHD"', dmg])
    await retryStaple(() => command('/usr/bin/xcrun', ['stapler', 'staple', dmg]), wait, console.log)
    await retryValidation(() => command('/usr/bin/xcrun', ['stapler', 'validate', dmg]), wait, console.log)
    // Identical finalization to the pinned builder, reached only after success.
    const blockmap = `${dmg}.blockmap`
    regular(blockmap); unlinkSync(blockmap)
    writeFileSync(metadata, normalized)
  }
  // Retry the complete original verifier on the same bytes, never skip a check.
  await retryFinalVerification(() => command(join(root, 'scripts/verify_electron_release.sh'), [assets, version, track], 600000),
    () => snapshotFinalizedAssets(assets, version, track), wait, console.log)
  console.log('Recovered Apple ticket transport; all original native release checks passed.')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
