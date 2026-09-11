import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { Alert } from './component-mocks/react-native'
import { resetComponentStore, setTestClient, useAppStore } from './component-mocks/app-store'
import { CodexServerSettings } from '../src/components/CodexServerSettings'
import { ServerError } from '../src/api/AgentServerClient'
import { subscribeCodexGoalsConfiguration } from '../src/lib/codex-goals-configuration'

const enabled = { enabled: true, configurable: true, message: 'Enabled.' }
const disabled = { ...enabled, enabled: false }
const health = { capabilities: { codex_controls: { available: true, version: 1, interactive_client_capability: 'codex_interactive_v1' } } }
let tree: ReturnType<typeof create> | null = null
const subscriptions: Array<() => void> = []
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const byId = (id: string) => tree!.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0]
const render = async (visible = true) => { await act(async () => { tree = create(<CodexServerSettings visible={visible} />) }) }
const change = async (value: boolean) => { await act(async () => { byId('codex-server-goals-toggle').props.onValueChange(value) }) }

beforeEach(() => {
  resetComponentStore({ activeProfileId: 'profile-a', profileGeneration: 1, connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false, health })
  setTestClient({ isValidated: true, codexServerGoals: async () => enabled, setCodexServerGoals: async value => ({ ...enabled, enabled: value }) })
  Alert.__reset()
})
afterEach(async () => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('settings load confirmed server state and publish a profile-scoped refresh', async () => {
  const changes: unknown[] = []
  subscriptions.push(subscribeCodexGoalsConfiguration(detail => changes.push(detail)))
  await render()
  assert.equal(byId('codex-server-goals-toggle').props.value, true)
  assert.equal(byId('codex-server-goals-toggle').props.disabled, false)
  assert.deepEqual(changes, [{ profileId: 'profile-a', profileGeneration: 1, enabled: true }])
})

test('hidden or unsupported settings never request server administration', async () => {
  let reads = 0
  setTestClient({ isValidated: true, codexServerGoals: async () => { reads++; return enabled } })
  await render(false)
  assert.equal(tree!.toJSON(), null)
  await act(async () => { useAppStore.setState({ health: null }); tree!.update(<CodexServerSettings visible />) })
  assert.equal(tree!.toJSON(), null)
  assert.equal(reads, 0)
})

test('enable is single-flight and displays the confirmed response immediately', async () => {
  const pending = deferred<typeof enabled>()
  const writes: boolean[] = []
  setTestClient({ isValidated: true, codexServerGoals: async () => disabled, setCodexServerGoals: value => { writes.push(value); return pending.promise } })
  await render()
  const toggle = byId('codex-server-goals-toggle').props.onValueChange
  await act(async () => { toggle(true); toggle(true) })
  assert.deepEqual(writes, [true])
  assert.equal(byId('codex-server-goals-toggle').props.disabled, true)
  assert.equal(byId('codex-server-goals-toggle').props.value, false)
  await act(async () => { pending.resolve(enabled) })
  assert.equal(byId('codex-server-goals-toggle').props.value, true)
  assert.equal(byId('codex-server-goals-toggle').props.disabled, false)
})

test('disable needs confirmation, cancellation is inert, and repeat taps make one request', async () => {
  const writes: boolean[] = []
  setTestClient({ isValidated: true, codexServerGoals: async () => enabled, setCodexServerGoals: async value => { writes.push(value); return disabled } })
  await render()
  const toggle = byId('codex-server-goals-toggle').props.onValueChange
  await act(async () => { toggle(false); toggle(false) })
  assert.equal(Alert.__calls.length, 1)
  assert.deepEqual(writes, [])
  await act(async () => { Alert.__calls[0].buttons.find(button => button.style === 'cancel')!.onPress!() })
  assert.deepEqual(writes, [])
  await change(false)
  await act(async () => { Alert.__calls[1].buttons.find(button => button.style === 'destructive')!.onPress!() })
  assert.deepEqual(writes, [false])
  assert.equal(byId('codex-server-goals-toggle').props.value, false)
})

test('failed save preserves confirmed state and permits retry', async () => {
  let attempts = 0
  setTestClient({ isValidated: true, codexServerGoals: async () => disabled, setCodexServerGoals: async () => { if (++attempts === 1) throw new ServerError(409, 'A turn is active. Try again when idle.'); return enabled } })
  await render()
  await change(true)
  assert.equal(byId('codex-server-goals-toggle').props.value, false)
  assert.match(JSON.stringify(tree!.toJSON()), /A turn is active/)
  assert.equal(byId('codex-server-goals-toggle').props.disabled, false)
  await change(true)
  assert.equal(attempts, 2)
  assert.equal(byId('codex-server-goals-toggle').props.value, true)
})

test('unsupported administration is read-only; transient read failure has a working retry', async () => {
  let reads = 0
  setTestClient({ isValidated: true, codexServerGoals: async () => { if (++reads === 1) throw new Error('Connection interrupted'); throw new ServerError(403, 'Not configurable') } })
  await render()
  assert.match(JSON.stringify(tree!.toJSON()), /Connection interrupted/)
  await act(async () => { byId('codex-server-goals-retry').props.onPress() })
  assert.equal(reads, 2)
  assert.equal(byId('codex-server-goals-toggle').props.disabled, true)
  assert.match(JSON.stringify(tree!.toJSON()), /Individual goal controls remain/)
})

test('late results cannot change or broadcast into a different profile', async () => {
  const pending = deferred<typeof enabled>()
  const changes: unknown[] = []
  subscriptions.push(subscribeCodexGoalsConfiguration(detail => changes.push(detail)))
  setTestClient({ isValidated: true, codexServerGoals: () => pending.promise })
  await render()
  await act(async () => {
    setTestClient({ isValidated: true, codexServerGoals: async () => disabled })
    useAppStore.setState({ activeProfileId: 'profile-b', profileGeneration: 2 })
  })
  await act(async () => { pending.resolve(enabled) })
  assert.equal(byId('codex-server-goals-toggle').props.value, false)
  assert.deepEqual(changes, [{ profileId: 'profile-b', profileGeneration: 2, enabled: false }])
})

test('pending profile switch rejects an already-open destructive confirmation', async () => {
  let writes = 0
  setTestClient({ isValidated: true, codexServerGoals: async () => enabled, setCodexServerGoals: async () => { writes++; return disabled } })
  await render()
  await change(false)
  await act(async () => { useAppStore.setState({ switchingProfileId: 'profile-b' }) })
  await act(async () => { Alert.__calls[0].buttons.find(button => button.style === 'destructive')!.onPress!() })
  assert.equal(writes, 0)
  assert.equal(byId('codex-server-goals-toggle').props.disabled, true)
})

test('reconnect releases old save state and ignores the old completion', async () => {
  const pending = deferred<typeof enabled>()
  let reads = 0
  setTestClient({ isValidated: true, codexServerGoals: async () => { reads++; return disabled }, setCodexServerGoals: () => pending.promise })
  await render()
  await change(true)
  await act(async () => { useAppStore.setState({ connected: false, connecting: true }) })
  await act(async () => { useAppStore.setState({ connected: true, connecting: false }) })
  assert.equal(reads, 2)
  assert.equal(byId('codex-server-goals-toggle').props.disabled, false)
  await act(async () => { pending.resolve(enabled) })
  assert.equal(byId('codex-server-goals-toggle').props.value, false)
})
