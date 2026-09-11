import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

function component(name) {
  return fs.readFileSync(path.resolve(`src/components/${name}.tsx`), 'utf8')
}

test('notification routing verifies the canonical server namespace throughout navigation', () => {
  const source = component('AppShell')
  assert.match(source, /typeof data\.serverIdentity === 'string'/)
  assert.match(source, /profileNamespace\(target\) !== serverIdentity/)
  assert.match(source, /profileNamespace\(currentTarget\) !== serverIdentity/)
  assert.match(source, /current\.selectedSessionId !== sessionId/)
})

test('connection-bound modals are scoped to the active profile generation', () => {
  const source = component('AppShell')
  assert.match(source, /const modalScopeCurrent = modalGeneration === profileGeneration/)
  assert.match(source, /setModalGeneration\(profileGeneration\)/)
  assert.match(source, /visible=\{modalScopeCurrent && search && !isWelcomeSession\(selected\?\.id\)\}/)
  assert.match(source, /runId=\{modalScopeCurrent \? reviewRun : null\}/)
})

test('composer async callbacks carry and revalidate profile generation and session', () => {
  const source = component('Composer')
  assert.match(source, /client\.isValidated/)
  assert.match(source, /beginTurnAdmission\(sessionId\)/)
  assert.match(source, /sendPrompt\(steer, profileGeneration, sessionId, \{[\s\S]*?admissionToken,[\s\S]*?\}\)/)
  assert.match(source, /endTurnAdmission\(sessionId, admissionToken\)/)
  assert.match(source, /const admittedDraft = consumeComposer \? currentDraft : undefined/)
  assert.match(source, /const admittedFiles = consumeComposer \? currentUploads : undefined/)
  assert.match(source, /attachFiles\([\s\S]*?profileGeneration, sessionId\)/)
  assert.match(source, /state\.profileGeneration === profileGeneration/)
  assert.match(source, /state\.selectedSessionId === sessionId/)
  assert.match(source, /runNow\(sessionId, turn\.queued_id, profileGeneration\)/)
  assert.match(source, /workspaceAdopting/)
  assert.match(source, /editable=\{!switching && !admissionPreflight\}/)
})

test('deferred native callbacks remain bound to their originating profile generation', () => {
  const sidebar = component('Sidebar')
  const inspector = component('Inspector')
  assert.match(sidebar, /function profileScopeIsCurrent/)
  assert.match(sidebar, /state\.profileGeneration === scope\.profileGeneration/)
  assert.match(sidebar, /sessionScopeIsCurrent\(scope, session\.id\)/)
  assert.match(sidebar, /clearTimeout\(folderSheetTimer\.current\)/)
  assert.match(sidebar, /remove\(session\.id, scope\.profileGeneration\)/)
  assert.match(sidebar, /workspaceAdopting/)
  assert.match(inspector, /state\.profileGeneration === profileGeneration/)
  assert.match(inspector, /remove\(sessionId, profileGeneration\)/)
  assert.match(inspector, /deleteJob\(job\.id, profileGeneration\)/)
  assert.match(inspector, /pointerEvents=\{workspaceAdopting \? 'none' : 'auto'\}/)
})

test('direct-client surfaces do not mount until the active client is validated', () => {
  for (const name of ['MediaGrid', 'TerminalView', 'CodeReview', 'Dialogs']) {
    const source = component(name)
    assert.match(source, /connection\.isValidated/, `${name} must require client validation`)
    assert.match(source, /state\.connected/, `${name} callbacks must require a connected store`)
    assert.match(source, /!state\.switchingProfileId/, `${name} callbacks must reject profile switching`)
  }
})
