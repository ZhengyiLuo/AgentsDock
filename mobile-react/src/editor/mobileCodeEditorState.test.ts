import assert from 'node:assert/strict'
import {
  CODE_EDITOR_ENGINE_SOURCE,
  CODE_EDITOR_PROTOCOL_VERSION,
  type CodeEditorEngineMessage,
} from './codeEditorProtocol'
import {
  acceptMobileCodeEditorMessage,
  createMobileCodeEditorMirror,
  markMobileCodeEditorClean,
  resetMobileCodeEditorEngine,
} from './mobileCodeEditorState'

const viewState = { anchor: 1, head: 1, scrollTop: 0, scrollLeft: 0 }
const message = (sequence: number, event: CodeEditorEngineMessage['event']): CodeEditorEngineMessage => ({
  source: CODE_EDITOR_ENGINE_SOURCE,
  version: CODE_EDITOR_PROTOCOL_VERSION,
  sequence,
  event,
})

let mirror = createMobileCodeEditorMirror('one\ntwo')
let transition = acceptMobileCodeEditorMessage(mirror, message(1, { type: 'ready' }))
assert.equal(transition.mirror.engineReady, true)
mirror = transition.mirror

transition = acceptMobileCodeEditorMessage(mirror, message(2, {
  type: 'initialized',
  snapshot: { content: 'one\ntwo', utf8Bytes: 7, lines: 2, viewState },
}))
assert.equal(transition.mirror.initialized, true)
mirror = transition.mirror

transition = acceptMobileCodeEditorMessage(mirror, message(3, {
  type: 'changed',
  changes: [{ from: 4, to: 7, insert: 'three\nfour' }],
  utf8Bytes: 14,
  lines: 3,
  viewState,
}))
assert.equal(transition.mirror.content, 'one\nthree\nfour')
assert.equal(transition.mirror.dirty, true)
assert.equal(transition.needsSnapshot, false)
mirror = transition.mirror

const gap = acceptMobileCodeEditorMessage(mirror, message(5, {
  type: 'changed',
  changes: [{ from: 0, to: 3, insert: 'ONE' }],
  utf8Bytes: 14,
  lines: 3,
  viewState,
}))
assert.equal(gap.needsSnapshot, true)
assert.equal(gap.mirror.content, mirror.content)

const recovered = acceptMobileCodeEditorMessage(gap.mirror, message(6, {
  type: 'snapshot',
  snapshot: { content: 'ONE\nthree\nfour', utf8Bytes: 14, lines: 3, viewState },
}))
assert.equal(recovered.mirror.content, 'ONE\nthree\nfour')
assert.equal(recovered.mirror.recovering, false)

const clean = markMobileCodeEditorClean(recovered.mirror)
assert.equal(clean.dirty, false)
const restarted = resetMobileCodeEditorEngine(clean)
assert.equal(restarted.content, clean.content)
assert.equal(restarted.sequence, 0)
assert.equal(restarted.recovering, true)

console.log('mobile code editor state tests passed')
