import assert from 'node:assert/strict'
import { act, create } from 'react-test-renderer'
import { ModelDropdown } from '../src/components/ModelDropdown'
import { useLanguageStore } from '../src/store/useLanguageStore'
import type { RuntimeOption } from '../src/types'

useLanguageStore.setState({ locale: 'en', preference: 'en' })
const options: RuntimeOption[] = [
  { value: '', label: 'Default', locked: true },
  { value: 'old', label: 'Old', locked: true, not_listed: true },
  { value: 'denied', label: 'Denied', locked: true },
  { value: 'current', label: 'Current' },
  { value: 'current', label: 'Duplicate' },
  ...Array.from({ length: 100 }, (_, i) => ({ value: `other-${i}`, label: `Other ${i}` })),
]
const selected: string[] = []
let renderer!: ReturnType<typeof create>
const component = (value = 'old', choices = options, scope = 'server-a') =>
  <ModelDropdown key={scope} testID="models" value={value} options={choices} onChange={next => selected.push(next)} />
const trigger = () => renderer.root.findAllByProps({ testID: 'models' }).find(node => typeof node.type === 'string')!
const exists = (testID: string) => renderer.root.findAllByProps({ testID }).length > 0

await act(async () => { renderer = create(component()) })
assert.equal(trigger().props.accessibilityState.expanded, false)
assert.match(trigger().props.accessibilityLabel, /Old.*Not in current list/)
await act(async () => { trigger().props.onPress() })
assert.ok(exists('models-options'))
for (const value of ['old', 'denied', 'default']) assert.equal(exists(`models-option-${value}`), false)
assert.equal(renderer.root.findAllByProps({ testID: 'models-option-current' }).filter(node => typeof node.type === 'string').length, 1)
assert.ok(exists('models-option-other-99'))
assert.equal(renderer.root.findAllByType('Modal' as never).length, 0)

await act(async () => { trigger().props.onPress() })
assert.equal(exists('models-options'), false)
await act(async () => { trigger().props.onPress() })
await act(async () => { renderer.root.findByProps({ testID: 'models-option-current' }).props.onPress() })
assert.deepEqual(selected, ['current'])
assert.equal(exists('models-options'), false)

await act(async () => { renderer.update(component('current')) })
await act(async () => { trigger().props.onPress() })
assert.equal(renderer.root.findByProps({ testID: 'models-option-current' }).props.accessibilityState.selected, true)
await act(async () => { renderer.update(component('current', [{ value: 'current', label: 'Current', locked: true }])) })
assert.equal(exists('models-option-current'), false)
assert.ok(JSON.stringify(renderer.toJSON()).includes('No selectable models.'))

await act(async () => { renderer.update(component('current', options, 'server-b')) })
assert.equal(exists('models-options'), false, 'A different chat/server must not inherit an open dropdown')
await act(async () => { renderer.unmount() })
console.log('Model dropdown rendered interactions passed: inline, toggle, select, unavailable, duplicate, empty, long list and scope change')
