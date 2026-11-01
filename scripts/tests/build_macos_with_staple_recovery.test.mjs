import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recoverableBuildFailure, removeDmgMetadata, retryStaple, transientStapleFailure } from '../build_macos_with_staple_recovery.mjs'

const network = 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup\nThe staple and validate action failed! Error 68.\n'
const build = 'status: Accepted\nProcessing: /tmp/release/AgentsDock-1.0.11-beta.2-mac-universal.dmg\n'+network
test('recover only the final versioned DMG boundary after accepted notarization', () => {
  assert(recoverableBuildFailure(68, build, '1.0.11-beta.2'))
  for (const code of [0,1,65,null]) assert(!recoverableBuildFailure(code, build, '1.0.11-beta.2'))
  assert(!recoverableBuildFailure(68, build, '1.0.11-beta.3'))
  assert(!recoverableBuildFailure(68, build.replace('Accepted','Invalid'), '1.0.11-beta.2'))
  assert(!recoverableBuildFailure(68, build.replace('.dmg','.app'), '1.0.11-beta.2'))
  assert(!recoverableBuildFailure(68, build+'Processing: /tmp/another.dmg\n'+network, '1.0.11-beta.2'))
  assert(!recoverableBuildFailure(68, build.replace('-1005','-1202'), '1.0.11-beta.2'))
})
test('retry recognized network errors only, with bounded increasing delays', async () => {
  let calls=0;const waits=[]
  await retryStaple(async()=>++calls===3?{status:0}:{status:68,stderr:network},async ms=>waits.push(ms))
  assert.equal(calls,3);assert.deepEqual(waits,[15000,30000])
  calls=0;waits.length=0
  await assert.rejects(retryStaple(async()=>{calls++;return {status:68,stderr:network}},async ms=>waits.push(ms)),/failed/)
  assert.equal(calls,4);assert.deepEqual(waits,[15000,30000,45000])
  for (const result of [{status:65,stderr:network},{status:null,stderr:network},{status:68,stderr:'invalid ticket'}]) {
    calls=0
    await assert.rejects(retryStaple(async()=>{calls++;return result},async()=>assert.fail('must not retry')))
    assert.equal(calls,1)
  }
  assert(transientStapleFailure(68,network.replace('-1005','-1001')))
})
test('remove only the matching stale DMG row, preserve the ZIP and all remaining metadata', () => {
  const dmg='AgentsDock-1.0.11-beta.2-mac-universal.dmg'
  const original=`version: 1.0.11-beta.2\nfiles:\n  - url: App.zip\n    sha512: abc\n    size: 42\n  - url: ${dmg}\n    sha512: stale\n    size: 43\npath: App.zip\nsha512: abc\nreleaseDate: now\n`
  assert.equal(removeDmgMetadata(original,dmg),original.replace(`  - url: ${dmg}\n    sha512: stale\n    size: 43\n`,''))
  assert.throws(()=>removeDmgMetadata(original,'wrong.dmg'))
  assert.throws(()=>removeDmgMetadata(original.replace('path:',`  - url: ${dmg}\npath:`),dmg))
})
