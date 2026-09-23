import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateDesktopBuildNumber } from '../validate_desktop_build_number.mjs'

test('explicit reservation starts after accepted local builds and advances with new CI runs', () => {
  assert.equal(validateDesktopBuildNumber('1186', '1'), '1186')
  assert.equal(validateDesktopBuildNumber('1187', '2'), '1187')
  assert.equal(validateDesktopBuildNumber('1366', '179'), '1366')
  assert.equal(validateDesktopBuildNumber('1367', '180'), '1367')
  for (const build of ['1183', '1184', '1185', '1187', '9999']) assert.throws(() => validateDesktopBuildNumber(build, '1'), /exactly 1186/)
  assert.throws(() => validateDesktopBuildNumber('1186', '2'), /exactly 1187/)
  assert.throws(() => validateDesktopBuildNumber('1186', '179'), /exactly 1366/)
  assert.equal(validateDesktopBuildNumber('1186', '1'), '1186', 'rerunning the same workflow retains its reservation')
})

test('preserves historical runs and skips accepted local builds 1206 and 1207', () => {
  for (let run = 1; run <= 20; run++) {
    const build = String(1185 + run)
    assert.equal(validateDesktopBuildNumber(build, String(run)), build)
  }
  assert.equal(validateDesktopBuildNumber('1205', '20'), '1205', 'historical reruns retain their reservation')
  assert.equal(validateDesktopBuildNumber('1208', '21'), '1208')
  assert.equal(validateDesktopBuildNumber('1209', '22'), '1209')
  for (const build of ['1205', '1206', '1207', '1209']) assert.throws(() => validateDesktopBuildNumber(build, '21'), /exactly 1208/)
  assert.throws(() => validateDesktopBuildNumber('1208', '22'), /exactly 1209/)
  assert.equal(validateDesktopBuildNumber('1208', '21'), '1208', 'new reruns retain their reservation')
})

test('refuses omitted, ambiguous, unsafe or overflowing build reservations', () => {
  for (const build of ['', '001186', '-1', '0', '1.5', '1186\n', '1e4', '9007199254740992']) assert.throws(() => validateDesktopBuildNumber(build, '1'))
  for (const run of ['', '0', '-1', '1.5', '9007199254740991']) assert.throws(() => validateDesktopBuildNumber('1186', run))
  const lastSafeRun = Number.MAX_SAFE_INTEGER - 1187
  assert.equal(validateDesktopBuildNumber(String(Number.MAX_SAFE_INTEGER), String(lastSafeRun)), String(Number.MAX_SAFE_INTEGER))
  assert.throws(() => validateDesktopBuildNumber(String(Number.MAX_SAFE_INTEGER), String(lastSafeRun + 1)), /supported range/)
})

test('the workflow CLI emits only an exact reservation and rejects reuse on the next run', () => {
  const script = fileURLToPath(new URL('../validate_desktop_build_number.mjs', import.meta.url))
  const first = spawnSync(process.execPath, [script, '1186', '1'], { encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.stdout, 'build_number=1186\n')
  const next = spawnSync(process.execPath, [script, '1186', '2'], { encoding: 'utf8' })
  assert.equal(next.status, 1)
  assert.equal(next.stdout, '')
  assert.match(next.stderr, /requires exactly 1187/)
})

test('the workflow CLI reserves 1208 after the local-only accepted builds', () => {
  const script = fileURLToPath(new URL('../validate_desktop_build_number.mjs', import.meta.url))
  const accepted = spawnSync(process.execPath, [script, '1208', '21'], { encoding: 'utf8' })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(accepted.stdout, 'build_number=1208\n')
  for (const build of ['1206', '1207']) {
    const reused = spawnSync(process.execPath, [script, build, '21'], { encoding: 'utf8' })
    assert.equal(reused.status, 1)
    assert.equal(reused.stdout, '')
    assert.match(reused.stderr, /requires exactly 1208/)
  }
})
