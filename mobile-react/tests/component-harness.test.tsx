import { act, create } from 'react-test-renderer'
import { Text, View } from 'react-native'
import { CodexGoalBar } from '../src/components/CodexGoalBar'
import { CodexStatusButton } from '../src/components/CodexControls'
import { CodexServerSettings } from '../src/components/CodexServerSettings'
import { resetComponentStore, useAppStore } from './component-mocks/app-store'
import { Alert } from './component-mocks/react-native'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function StoreProbe() {
  const generation = useAppStore(state => state.profileGeneration)
  return <View><Text testID="generation">{generation}</Text></View>
}

resetComponentStore({ profileGeneration: 1 })
let renderer!: ReturnType<typeof create>
await act(async () => { renderer = create(<StoreProbe />) })
assert(renderer.root.findByProps({ testID: 'generation' }).children[0] === '1', 'Probe should render the initial store value')
await act(async () => { useAppStore.setState({ profileGeneration: 2 }) })
assert(renderer.root.findByProps({ testID: 'generation' }).children[0] === '2', 'Store updates must rerender subscribers for scope-switch tests')
await act(async () => { renderer.unmount() })

// A production import smoke check keeps the mock boundary narrow. Production
// controls run with their real hooks and correctly disappear without support.
await act(async () => {
  renderer = create(<><CodexGoalBar /><CodexStatusButton compact={false} /><CodexServerSettings visible /></>)
})
assert(renderer.toJSON() === null, 'Unsupported controls should remain hidden')
await act(async () => { renderer.unmount() })

let confirmed = false
Alert.__reset()
Alert.alert('Confirm', 'Test action', [{ text: 'Confirm', onPress: () => { confirmed = true } }])
assert(!confirmed, 'The native alert mock must not auto-confirm destructive actions')
Alert.__calls[0].buttons?.[0].onPress?.()
assert(confirmed, 'Tests must explicitly confirm a recorded native alert')
Alert.__reset()

console.log('native component harness tests passed')
