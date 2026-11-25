import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { collectSymbols } from '../scripts/collect-ios-archive-symbols.mjs'

test('archive copies matching device symbols without substituting simulator or unrelated UUIDs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agentsdock-dsym-test-'))
  try {
    const archive = path.join(root, 'app.xcarchive')
    const pods = path.join(root, 'Pods')
    const frameworks = path.join(archive, 'Products', 'Applications', 'AgentsDock.app', 'Frameworks')
    for (const name of ['Image', 'Existing', 'Missing']) mkdirSync(path.join(frameworks, `${name}.framework`), { recursive: true })
    for (const name of ['Image', 'Existing', 'Missing']) writeFileSync(path.join(frameworks, `${name}.framework`, name), `unchanged-${name}`)
    mkdirSync(path.join(archive, 'dSYMs', 'Existing.framework.dSYM'), { recursive: true })
    mkdirSync(path.join(pods, 'simulator', 'Image.framework.dSYM'), { recursive: true })
    mkdirSync(path.join(pods, 'device', 'Image.framework.dSYM'), { recursive: true })
    const result = collectSymbols(archive, pods, file => [file.includes('simulator') ? 'SIMULATOR' : 'DEVICE'])
    assert.deepEqual(result, { copied: ['Image.framework'], present: ['Existing.framework'], unavailable: ['Missing.framework'] })
    assert.ok(existsSync(path.join(archive, 'dSYMs', 'Image.framework.dSYM')))
    assert.ok(!existsSync(path.join(archive, 'dSYMs', 'Missing.framework.dSYM')))
    for (const name of ['Image', 'Existing', 'Missing']) {
      assert.equal(readFileSync(path.join(frameworks, `${name}.framework`, name), 'utf8'), `unchanged-${name}`)
    }
    assert.throws(() => collectSymbols(archive, pods, file => [file.includes('dSYMs') ? 'WRONG' : 'DEVICE']), /UUID mismatch/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
