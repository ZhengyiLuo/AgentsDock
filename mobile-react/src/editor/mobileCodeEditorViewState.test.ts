import assert from 'node:assert/strict'
import {
  cachedMobileCodeEditorViewState,
  clearMobileCodeEditorViewStateCache,
  rememberMobileCodeEditorViewState,
} from './mobileCodeEditorViewState'

clearMobileCodeEditorViewStateCache()
const original = { anchor: 2, head: 4, scrollTop: 90, scrollLeft: 3, folds: [{ from: 1, to: 8 }] }
rememberMobileCodeEditorViewState('/workspace/a.ts', original)
const cached = cachedMobileCodeEditorViewState('/workspace/a.ts')
assert.deepEqual(cached, original)
cached!.folds![0].from = 99
assert.equal(cachedMobileCodeEditorViewState('/workspace/a.ts')!.folds![0].from, 1)

for (let index = 0; index < 30; index += 1) {
  rememberMobileCodeEditorViewState(`/workspace/${index}.ts`, original)
}
assert.equal(cachedMobileCodeEditorViewState('/workspace/a.ts'), undefined)
assert.notEqual(cachedMobileCodeEditorViewState('/workspace/29.ts'), undefined)

console.log('mobile code editor view-state tests passed')
