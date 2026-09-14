import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { assertMigrationTrack, parseArguments } from '../verify_electron_migration.mjs'

const valid = ['--from-version', '0.2.13-beta.33', '--to-version', '1.0.0-beta.1', '--output', '/tmp/migration-argument-test']

test('accepts explicit source, target and absolute output without side effects', () => {
  assert.deepEqual(parseArguments(valid), { from: '0.2.13-beta.33', to: '1.0.0-beta.1', track: 'beta', output: '/tmp/migration-argument-test' })
})

test('accepts true Stable migration and Beta subscribers receiving the same stable release', () => {
  for (const [from, track] of [['0.2.12', 'stable'], ['1.0.0-beta.2', 'beta']]) {
    assert.deepEqual(parseArguments([
      '--from-version', from, '--to-version', '1.0.0', '--track', track,
      '--output', '/tmp/migration-argument-test'
    ]), { from, to: '1.0.0', track, output: '/tmp/migration-argument-test' })
  }
  assert.equal(parseArguments([...valid, '--track', 'beta']).track, 'beta')
})

test('rejects unknown, missing, duplicate and impossible track arguments', () => {
  for (const args of [
    [...valid, '--track', 'nightly'], [...valid, '--track', 'Stable'],
    [...valid, '--track'], [...valid, '--track', ''],
    [...valid, '--track', 'beta', '--track', 'stable'],
    [...valid, '--track', 'stable']
  ]) assert.throws(() => parseArguments(args))
})

test('asserts the selected subscription in both updater status and saved settings', () => {
  for (const track of ['stable', 'beta']) {
    const other = track === 'stable' ? 'beta' : 'stable'
    const status = { currentVersion: '1.0.0', track }
    assert.doesNotThrow(() => assertMigrationTrack(track, status, `${track}\n`))
    assert.throws(() => assertMigrationTrack(track, { ...status, track: other }, `${track}\n`), /selected test subscription/)
    assert.throws(() => assertMigrationTrack(track, status, `${other}\n`), /Saved update track changed/)
    assert.throws(() => assertMigrationTrack(track, status, undefined), /Saved update track is missing/)
    assert.deepEqual(status, { currentVersion: '1.0.0', track })
  }
  assert.throws(() => assertMigrationTrack('nightly', { track: 'nightly' }, 'nightly'), /Track must be/)
})

test('rejects unsafe, partial and ambiguous installer inputs', () => {
  for (const args of [
    [], [...valid, '--from-version', '0.2.12'], [...valid, '--unknown', 'yes'],
    ['--from-version', '../escape', ...valid.slice(2)],
    [...valid.slice(0, 4), '--output', 'relative'],
    ['--from-version', '1.0.0-beta.1', ...valid.slice(2)]
  ]) assert.throws(() => parseArguments(args))
})

test('refuses Beta and Stable installer journeys on an ordinary developer machine', () => {
  for (const args of [valid, [
    '--from-version', '0.2.12', '--to-version', '1.0.0', '--track', 'stable',
    '--output', '/tmp/migration-argument-test'
  ]]) {
    const child = spawnSync(process.execPath, [resolve(import.meta.dirname, '../verify_electron_migration.mjs'), ...args], {
      encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_OS: 'macOS' }, timeout: 5000
    })
    assert.equal(child.status, 1)
    assert.match(child.stderr, /restricted to disposable macOS GitHub runners/)
    assert.doesNotMatch(child.stderr, /download failed|Checksum|ENOENT/)
  }
})
