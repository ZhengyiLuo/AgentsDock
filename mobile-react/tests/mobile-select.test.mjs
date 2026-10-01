import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const dialogs = fs.readFileSync(path.resolve('src/components/Dialogs.tsx'), 'utf8')
const inspector = fs.readFileSync(path.resolve('src/components/Inspector.tsx'), 'utf8')

test('chat runtime choices distinguish the server default from a pinned model', () => {
  // Inspector offers both settings; the composer also exposes Reasoning.
  assert.match(inspector, /runtimeCatalogOptions\(runtime, session\.backend, 'models', session\.model\)/)
  assert.match(inspector, /runtimeEffortOptions\(runtime, session\.backend, session\.model, session\.effort\)/)
  assert.match(inspector, /runtimeEffortAfterModelChange\(state\.runtime, current\.backend, value \|\| null, current\.effort\)/)
  assert.match(inspector, /<ChoiceField label="Model"[^\n]*value=\{session\.model \?\? ''\} options=\{modelOptions\}/)
  assert.doesNotMatch(inspector, /label: runtime\?\.backends\[session\.backend\]\?\.default_model/)
})

test('mobile select uses a bounded safe-area sheet with an explicit close target', () => {
  assert.match(dialogs, /<SafeAreaView style=\{styles\.selectSafeArea\} edges=\{\['top', 'bottom'\]\}>/)
  assert.match(dialogs, /compact && styles\.selectBackdropCompact/)
  assert.match(dialogs, /maxHeight: Math\.min\(440, height \* 0\.62\)/)
  assert.match(dialogs, /<SheetCloseButton onPress=\{close\} label=\{`Close \$\{title\.toLocaleLowerCase\(\)\}`\} \/>/)
  assert.match(dialogs, /selectBackdropCompact: \{ justifyContent: 'flex-end'/)
})
