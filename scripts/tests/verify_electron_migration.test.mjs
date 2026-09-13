import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseArguments } from '../verify_electron_migration.mjs'

const valid = ['--from-version', '0.2.13-beta.33', '--to-version', '1.0.0-beta.1', '--output', '/tmp/migration-argument-test']

test('accepts explicit source, target and absolute output without side effects', () => {
  assert.deepEqual(parseArguments(valid), { from: '0.2.13-beta.33', to: '1.0.0-beta.1', output: '/tmp/migration-argument-test' })
})

test('rejects unsafe, partial and ambiguous installer inputs', () => {
  for (const args of [
    [], [...valid, '--from-version', '0.2.12'], [...valid, '--unknown', 'yes'],
    ['--from-version', '../escape', ...valid.slice(2)],
    [...valid.slice(0, 4), '--output', 'relative'],
    ['--from-version', '1.0.0-beta.1', ...valid.slice(2)]
  ]) assert.throws(() => parseArguments(args))
})

test('refuses to run the signed installer on an ordinary developer machine', () => {
  const child = spawnSync(process.execPath, [resolve(import.meta.dirname, '../verify_electron_migration.mjs'), ...valid], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_OS: 'macOS' }, timeout: 5000
  })
  assert.equal(child.status, 1)
  assert.match(child.stderr, /restricted to disposable macOS GitHub runners/)
  assert.doesNotMatch(child.stderr, /download failed|Checksum|ENOENT/)
})
