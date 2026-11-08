import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoverableBuildFailure, recoverableVerificationFailure, removeDmgMetadata, retryStaple, retryValidation, retryFinalVerification, snapshotFinalizedAssets, transientStapleFailure, transientValidationFailure } from '../build_macos_with_staple_recovery.mjs'

const network = 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup\nThe staple and validate action failed! Error 68.\n'
const build = 'status: Accepted\nProcessing: /tmp/release/AgentsDock-1.0.11-beta.2-mac-universal.dmg\n'+network
const validation = network.replace('staple and validate action', 'validate action')
const accepted = 'path: /tmp/release/AgentsDock-1.0.11-beta.2-mac-universal.dmg\nstatus: Accepted\n'
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
test('recognize final DMG, extracted ZIP app and mounted DMG app validation transport failures', () => {
  for (const target of ['/tmp/release/AgentsDock-1.0.11-beta.2-mac-universal.dmg',
    '/var/folders/private/T/agentsdock-release.Abc123/zip/AgentsDock.app',
    '/var/folders/private/T/agentsdock-release.aBc456/dmg/AgentsDock.app']) {
    const output=accepted+'Processing: '+target+'\n'+validation
    assert(recoverableVerificationFailure(68,output,'1.0.11-beta.2'))
    assert(!recoverableVerificationFailure(68,output,'1.0.11-beta.3'))
    assert(!recoverableVerificationFailure(68,output.replace('Accepted','Invalid'),'1.0.11-beta.2'))
    for (const code of [0,1,65,null]) assert(!recoverableVerificationFailure(code,output,'1.0.11-beta.2'))
  }
})
test('do not treat early app stapling or unrelated files as completed-package verification', () => {
  for (const target of ['/tmp/release/mac-universal/AgentsDock.app','/tmp/other.dmg','/tmp/AgentsDock.app']) {
    assert(!recoverableVerificationFailure(68,accepted+'Processing: '+target+'\n'+validation,'1.0.11-beta.2'))
  }
  assert(!recoverableVerificationFailure(68,build,'1.0.11-beta.2'))
  assert(!recoverableVerificationFailure(68,accepted+'Processing: /tmp/agentsdock-release.Abc123/zip/AgentsDock.app\n'+network,'1.0.11-beta.2'))
})
test('earlier transient failure cannot authorize a later invalid ticket', () => {
  const output=build+'Processing: /tmp/agentsdock-release.Abc123/zip/AgentsDock.app\nThe validate action failed! Error 68.\n'
  assert(!recoverableVerificationFailure(68,output,'1.0.11-beta.2'))
})
test('retry ticket validation transport failures, then require an actual success', async () => {
  let calls=0;const waits=[]
  await retryValidation(async()=>++calls===3?{status:0}:{status:68,stderr:validation},async ms=>waits.push(ms))
  assert.equal(calls,3);assert.deepEqual(waits,[15000,30000])
  calls=0;waits.length=0
  await assert.rejects(retryValidation(async()=>{calls++;return {status:68,stderr:validation}},async ms=>waits.push(ms)),/validation failed/)
  assert.equal(calls,4);assert.deepEqual(waits,[15000,30000,45000])
  assert(transientValidationFailure(68,validation.replace('-1005','-1001')))
})
test('validation retries do not accept signature, certificate, timeout or non-transport failures', async () => {
  for(const result of [{status:1,stderr:validation},{status:65,stderr:validation},
    {status:null,signal:'SIGTERM',stderr:validation},{status:68,stderr:'invalid ticket'},
    {status:68,signal:'SIGTERM',stderr:validation},{status:68,error:{code:'ETIMEDOUT'},stderr:validation},
    {status:68,stderr:validation.replace('-1005','-1202')},
    {status:68,stderr:validation.replace('api.apple-cloudkit.com','example.com')},
    {status:68,stderr:network}]) {
    let calls=0
    await assert.rejects(retryValidation(async()=>{calls++;return result},async()=>assert.fail('must not retry')))
    assert.equal(calls,1)
  }
})
test('a non-network failure after one transient validation error stops immediately', async () => {
  let calls=0
  await assert.rejects(retryValidation(async()=>++calls===1?{status:68,stderr:validation}:{status:2,stderr:'checksum mismatch'},async()=>{}))
  assert.equal(calls,2)
})
test('stale validation diagnostics and a different Apple endpoint cannot trigger retries', () => {
  assert(!transientValidationFailure(68,validation+'invalid ticket\n'))
  assert(!transientValidationFailure(68,validation+'Processing: /another/AgentsDock.app\nThe validate action failed! Error 68.\n'))
  assert(!transientValidationFailure(68,validation.replace('/production/public/records/lookup','/other')))
})
test('full-verifier retry preserves all asset identities and requires a real zero exit', async () => {
  let calls=0;const state={zip:{sha256:'abc',size:3}},waits=[]
  await retryFinalVerification(async()=>++calls===2?{status:0}:{status:68,stdout:validation},async()=>structuredClone(state),async ms=>waits.push(ms))
  assert.equal(calls,2);assert.deepEqual(waits,[15000])
  calls=0
  await assert.rejects(retryFinalVerification(async()=>{calls++;return {status:68,stdout:validation}},async()=>structuredClone(state),async()=>{}))
  assert.equal(calls,4)
})
test('asset mutation during failure, success or retry delay fails closed', async () => {
  for(const status of [0,68]) {
    let changed=false,calls=0
    await assert.rejects(retryFinalVerification(async()=>{calls++;changed=true;return {status,stdout:validation}},
      async()=>({zip:changed?'changed':'original'}),async()=>assert.fail('must not retry')),/changed during/)
    assert.equal(calls,1)
  }
  let changed=false,calls=0
  await assert.rejects(retryFinalVerification(async()=>{calls++;return {status:68,stdout:validation}},
    async()=>({zip:changed?'changed':'original'}),async()=>{changed=true}),/changed before/)
  assert.equal(calls,1)
})
test('snapshot requires complete finalized exact-version native inputs', async t => {
  const directory=mkdtempSync(join(tmpdir(),'ticket-validation-test-'))
  t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const version='1.0.11-beta.2',zip=`AgentsDock-${version}-mac-universal.zip`,dmg=`AgentsDock-${version}-mac-universal.dmg`
  const metadata=`version: ${version}\nfiles:\n  - url: ${zip}\n    sha512: fixture\npath: ${zip}\n`
  for(const name of [zip,zip+'.blockmap',dmg]) writeFileSync(join(directory,name),'fixture')
  writeFileSync(join(directory,'beta-mac.yml'),metadata)
  const snapshot=await snapshotFinalizedAssets(directory,version,'beta')
  assert.equal(Object.keys(snapshot).length,4)
  assert.match(snapshot[zip].sha256,/^[a-f0-9]{64}$/)
  await assert.rejects(snapshotFinalizedAssets(directory,'1.0.11-beta.3','beta'))
  writeFileSync(join(directory,dmg+'.blockmap'),'stale')
  await assert.rejects(snapshotFinalizedAssets(directory,version,'beta'),/finalized DMG/)
  unlinkSync(join(directory,dmg+'.blockmap'))
  writeFileSync(join(directory,'beta-mac.yml'),metadata+`  - url: ${dmg}\n`)
  await assert.rejects(snapshotFinalizedAssets(directory,version,'beta'),/ZIP-only/)
  writeFileSync(join(directory,'beta-mac.yml'),metadata)
  unlinkSync(join(directory,zip))
  await assert.rejects(snapshotFinalizedAssets(directory,version,'beta'))
})
