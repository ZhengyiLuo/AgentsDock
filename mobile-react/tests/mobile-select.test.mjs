import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const dialogs = fs.readFileSync(path.resolve('src/components/Dialogs.tsx'), 'utf8')
const inspector = fs.readFileSync(path.resolve('src/components/Inspector.tsx'), 'utf8')
const dropdown = fs.readFileSync(path.resolve('src/components/ModelDropdown.tsx'), 'utf8')

test('chat runtime choices distinguish the server default from a pinned model', () => {
  // Per-chat model/effort selection lives in the chat details Inspector. (The
  // old Create Chat dialog's copy of these selects was removed in favor of
  // direct plus-button creation.)
  assert.match(inspector, /const catalog = providerRuntimeCatalog\(runtime, session\)/)
  assert.match(inspector, /runtimeCatalogOptions\(catalog, session\.backend, 'models', session\.model, isCustomProvider\(session\)\)/)
  assert.match(inspector, /runtimeEffortOptions\(catalog, session\.backend, session\.model, session\.effort\)/)
  assert.match(inspector, /runtimeEffortAfterModelChange\(catalog, session\.backend, model, session\.effort\)/)
  assert.match(inspector, /<ModelDropdown[^\n]+testID="chat-model-picker" value=\{session\.model \?\? ''\} options=\{modelOptions\}/)
  assert.doesNotMatch(inspector, /label: runtime\?\.backends\[session\.backend\]\?\.default_model/)
})

test('model choices expand inline on both platforms and hide unavailable entries', () => {
  assert.doesNotMatch(dropdown, /\bModal\b|ActionSheetIOS|Platform\.OS|position: 'absolute'/)
  assert.match(dropdown, /accessibilityState=\{\{ expanded: open \}\}/)
  assert.match(dropdown, /setOpen\(current => !current\)/)
  assert.match(dropdown, /options\.filter\(\(option, index\) => !option\.locked/)
  assert.match(dropdown, /if \(option\.locked\) return/)
  assert.match(dropdown, /setOpen\(false\); onChange\(option\.value\)/)
  assert.match(dropdown, /nestedScrollEnabled keyboardShouldPersistTaps="always"/)
  assert.match(dropdown, /maxHeight: 240/)
  assert.match(dropdown, /No selectable models\./)
  assert.match(dialogs, /<ModelDropdown key=\{`\$\{profileGeneration\}:\$\{defaultChoice\}`\}/)
})

test('both mobile pickers label unavailable models truthfully and expose inventory notices', () => {
  for (const source of [dialogs, inspector]) {
    assert.match(source, /runtimeOptionLabel\(option, t\)/)
    assert.doesNotMatch(source, /upgrade required/)
    assert.match(source, /runtimeInventoryNotice\(/)
    assert.match(source, /disabled=\{option\.locked\}/)
  }
  assert.match(inspector, /if \(option\.locked\) return/)
  assert.match(dialogs, /runtimeCatalogOptions\(defaultCatalog, chatDefaults\.backend, 'models', chatDefaults\.model, isCustomProvider\(chatDefaults\)\)/)
})

test('mobile select uses a bounded safe-area sheet with an explicit close target', () => {
  assert.match(dialogs, /<SafeAreaView style=\{styles\.selectSafeArea\} edges=\{\['top', 'bottom'\]\}>/)
  assert.match(dialogs, /compact && styles\.selectBackdropCompact/)
  assert.match(dialogs, /maxHeight: Math\.min\(440, height \* 0\.62\)/)
  assert.match(dialogs, /<SheetCloseButton onPress=\{close\} label=\{`Close \$\{title\.toLocaleLowerCase\(\)\}`\} \/>/)
  assert.match(dialogs, /selectBackdropCompact: \{ justifyContent: 'flex-end'/)
})

test('chat details choices avoid nested iOS modals inside the page sheet', () => {
  assert.match(inspector, /ActionSheetIOS\.showActionSheetWithOptions\(/)
  assert.match(inspector, /if \(Platform\.OS === 'ios'\) \{[\s\S]*?ActionSheetIOS\.showActionSheetWithOptions\(/)
  assert.match(inspector, /\{Platform\.OS !== 'ios' \? <Modal visible=\{open && !disabled\}/)
  assert.match(inspector, /disabledButtonIndices/)
  assert.match(inspector, /if \(iosChoicesPresented\.current\) return/)
  assert.match(inspector, /iosChoicesPresented\.current = false/)
})
