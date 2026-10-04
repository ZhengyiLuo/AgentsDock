import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateDesktopBuildNumber } from '../validate_desktop_build_number.mjs'

test('explicit reservation starts after accepted local builds and advances with new CI runs', () => {
  assert.equal(validateDesktopBuildNumber('1186', '1'), '1186')
  assert.equal(validateDesktopBuildNumber('1187', '2'), '1187')
  assert.equal(validateDesktopBuildNumber('1364', '179'), '1364')
  assert.equal(validateDesktopBuildNumber('1365', '180'), '1365')
  for (const build of ['1183', '1184', '1185', '1187', '9999']) assert.throws(() => validateDesktopBuildNumber(build, '1'), /exactly 1186/)
  assert.throws(() => validateDesktopBuildNumber('1186', '2'), /exactly 1187/)
  assert.throws(() => validateDesktopBuildNumber('1186', '179'), /exactly 1364/)
  assert.equal(validateDesktopBuildNumber('1186', '1'), '1186', 'rerunning the same workflow retains its reservation')
})

test('refuses omitted, ambiguous, unsafe or overflowing build reservations', () => {
  for (const build of ['', '001186', '-1', '0', '1.5', '1186\n', '1e4', '9007199254740992']) assert.throws(() => validateDesktopBuildNumber(build, '1'))
  for (const run of ['', '0', '-1', '1.5', '9007199254740991']) assert.throws(() => validateDesktopBuildNumber('1186', run))
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
