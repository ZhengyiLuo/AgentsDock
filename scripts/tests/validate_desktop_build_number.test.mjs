import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateDesktopBuildNumber } from '../validate_desktop_build_number.mjs'

test('the original epoch retains every allocated run and rerun reservation', () => {
  for (let run = 1; run <= 20; run++) {
    const build = String(1185 + run)
    assert.equal(validateDesktopBuildNumber(build, String(run)), build)
    assert.equal(validateDesktopBuildNumber(build, String(run)), build, 'a rerun retains its reservation')
    assert.throws(() => validateDesktopBuildNumber(String(Number(build) + 1), String(run)), /exactly/)
  }
  for (const build of ['1183', '1184', '1185', '1187', '9999']) assert.throws(() => validateDesktopBuildNumber(build, '1'), /exactly 1186/)
  assert.throws(() => validateDesktopBuildNumber('1186', '2'), /exactly 1187/)
  assert.throws(() => validateDesktopBuildNumber('1232', '20'), /exactly 1205/)
})

test('the new epoch starts above audited local packages without reusing a native build', () => {
  assert.equal(validateDesktopBuildNumber('1233', '21'), '1233')
  assert.equal(validateDesktopBuildNumber('1233', '21'), '1233', 'a rerun retains its new-epoch reservation')
  assert.equal(validateDesktopBuildNumber('1234', '22'), '1234')
  for (let build = 1205; build <= 1232; build++) assert.throws(() => validateDesktopBuildNumber(String(build), '21'), /exactly 1233/)
  assert.throws(() => validateDesktopBuildNumber('1234', '21'), /exactly 1233/)
  assert.throws(() => validateDesktopBuildNumber('1233', '22'), /exactly 1234/)
  for (let run = 21; run <= 22; run++) {
    const build = String(1232 + run - 20)
    assert.equal(validateDesktopBuildNumber(build, String(run)), build)
    assert.throws(() => validateDesktopBuildNumber(build, String(run + 1)), /exactly/)
  }
})

test('the next epoch clears local diagnostic build 1239 without remapping runs 21 and 22', () => {
  assert.equal(validateDesktopBuildNumber('1233', '21'), '1233')
  assert.equal(validateDesktopBuildNumber('1234', '22'), '1234')
  assert.equal(validateDesktopBuildNumber('1240', '23'), '1240')
  assert.equal(validateDesktopBuildNumber('1240', '23'), '1240', 'reruns retain their reservation')
  assert.equal(validateDesktopBuildNumber('1396', '179'), '1396')
  assert.equal(validateDesktopBuildNumber('1397', '180'), '1397')
  for (let build = 1233; build <= 1239; build++) assert.throws(() => validateDesktopBuildNumber(String(build), '23'), /exactly 1240/)
  for (let run = 23; run <= 120; run++) {
    const build = String(1239 + run - 22)
    assert.equal(validateDesktopBuildNumber(build, String(run)), build)
    assert.throws(() => validateDesktopBuildNumber(build, String(run + 1)), /exactly/)
  }
})

test('refuses omitted, ambiguous, unsafe or overflowing build reservations', () => {
  for (const build of ['', '001186', '-1', '0', '1.5', '1186\n', '1e4', '9007199254740992']) assert.throws(() => validateDesktopBuildNumber(build, '1'))
  for (const run of ['', '0', '-1', '1.5', '9007199254740991']) assert.throws(() => validateDesktopBuildNumber('1186', run))
  const lastSafeRun = Number.MAX_SAFE_INTEGER - (1239 - 22)
  assert.equal(validateDesktopBuildNumber(String(Number.MAX_SAFE_INTEGER), String(lastSafeRun)), String(Number.MAX_SAFE_INTEGER))
  assert.throws(() => validateDesktopBuildNumber(String(Number.MAX_SAFE_INTEGER), String(lastSafeRun + 1)), /supported range/)
})

test('beta.5 preparation follows beta.4 run 31 without changing historical reservations', () => {
  assert.equal(validateDesktopBuildNumber('1248', '31'), '1248')
  assert.equal(validateDesktopBuildNumber('1249', '32'), '1249')
  assert.equal(validateDesktopBuildNumber('1249', '32'), '1249', 'retry retains the same reservation')
  for (const build of ['1217', '1248', '1250']) assert.throws(() => validateDesktopBuildNumber(build, '32'), /exactly 1249/)
  assert.throws(() => validateDesktopBuildNumber('1249', '33'), /exactly 1250/)
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
  const cutover = spawnSync(process.execPath, [script, '1233', '21'], { encoding: 'utf8' })
  assert.equal(cutover.status, 0, cutover.stderr)
  assert.equal(cutover.stdout, 'build_number=1233\n')
  const secondCutover = spawnSync(process.execPath, [script, '1240', '23'], { encoding: 'utf8' })
  assert.equal(secondCutover.status, 0, secondCutover.stderr)
  assert.equal(secondCutover.stdout, 'build_number=1240\n')
  for (const [build, run, expected] of [['1206', '21', '1233'], ['1232', '21', '1233'], ['1233', '22', '1234'], ['1235', '23', '1240'], ['1239', '23', '1240'], ['1240', '24', '1241']]) {
    const invalid = spawnSync(process.execPath, [script, build, run], { encoding: 'utf8' })
    assert.equal(invalid.status, 1)
    assert.equal(invalid.stdout, '')
    assert.match(invalid.stderr, new RegExp(`requires exactly ${expected}`))
  }
})

test('platform stamps share the preparation reservation and publication only replays the seal', () => {
  const draft = readFileSync(new URL('../../.github/workflows/direct-desktop-release-draft.yml', import.meta.url), 'utf8')
  const publish = readFileSync(new URL('../../.github/workflows/direct-desktop-release-publish.yml', import.meta.url), 'utf8')
  assert.match(draft, /WORKFLOW_RUN: \$\{\{ github\.run_number \}\}/)
  assert.match(draft, /validate_desktop_build_number\.mjs "\$REQUESTED_BUILD" "\$WORKFLOW_RUN"/)
  assert.equal((draft.match(/BUILD_NUMBER: \$\{\{ needs\.validate-request\.outputs\.build_number \}\}/g) ?? []).length, 4)
  assert.equal((draft.match(/n<1186/g) ?? []).length, 4, 'the historical sanity floor is identical on every platform')
  assert.equal((draft.match(/AGENTSDOCK_EXPECTED_BUILD_NUMBER=/g) ?? []).length, 4)
  assert.doesNotMatch(publish, /github\.run_number|validate_desktop_build_number\.mjs|BUILD_NUMBER:/)
  assert.match(publish, /platform verifiers observed different checksum manifests/)
  assert.match(publish, /direct-release-mirror\.mjs publish/)
})
