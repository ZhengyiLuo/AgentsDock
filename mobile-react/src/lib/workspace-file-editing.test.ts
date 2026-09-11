import assert from 'node:assert/strict'
import test from 'node:test'
import { utf8ByteLength, workspaceFileDepartureDecision, workspaceTextIsDirectlyEditable } from './workspace-file-editing'

const revision = 'a'.repeat(64)

test('writable workspace text opens directly in its editor', () => {
  assert.equal(workspaceTextIsDirectlyEditable({ content: '# Notes', revision, writable: true }, true, 1024), true)
})

test('direct editing preserves server, revision, truncation, and memory gates', () => {
  assert.equal(workspaceTextIsDirectlyEditable({ content: 'text', revision, writable: false }, true, 1024), false)
  assert.equal(workspaceTextIsDirectlyEditable({ content: 'text', revision, writable: true }, false, 1024), false)
  assert.equal(workspaceTextIsDirectlyEditable({ content: 'text', revision: 'bad', writable: true }, true, 1024), false)
  assert.equal(workspaceTextIsDirectlyEditable({ content: 'text', revision, writable: true, truncated: true }, true, 1024), false)
  assert.equal(workspaceTextIsDirectlyEditable({ content: 'text', revision, writable: true }, true, 3), false)
})

test('editing limits count UTF-8 bytes instead of JavaScript code units', () => {
  assert.equal('🙂'.length, 2)
  assert.equal(utf8ByteLength('🙂'), 4)
  assert.equal(workspaceTextIsDirectlyEditable({ content: '🙂', revision, writable: true }, true, 3), false)
  assert.equal(workspaceTextIsDirectlyEditable({ content: '🙂', revision, writable: true }, true, 4), true)
})

test('departure never silently abandons a dirty or saving editor', () => {
  assert.deepEqual(workspaceFileDepartureDecision(false, false, false), { kind: 'leave' })
  assert.deepEqual(workspaceFileDepartureDecision(false, true, false), { kind: 'confirm_discard' })
  assert.deepEqual(workspaceFileDepartureDecision(true, true, false), { kind: 'confirm_saving', hasNewerDraft: false })
  assert.deepEqual(workspaceFileDepartureDecision(true, true, true), { kind: 'confirm_saving', hasNewerDraft: true })
})
