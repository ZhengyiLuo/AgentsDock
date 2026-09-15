import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { resetComponentStore, setTestClient, useAppStore } from './component-mocks/app-store'
import { CodexSubagentSettings } from '../src/components/CodexSubagentSettings'
import { ServerError } from '../src/api/AgentServerClient'

const configuration = { configurable: true, max_concurrent_threads_per_session: 6, message: 'Configured.' }
const health = { ok: true, server_identity: 'server-a', server_instance_id: 'boot-a',
  capabilities: { codex_controls: { available: true, version: 1, interactive_client_capability: 'codex_interactive_v1' } } }
let tree: ReturnType<typeof create> | null = null
let writes: Array<number | null> = []
let reads = 0
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const byId = (id: string) => tree!.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0]
const render = async (visible = true) => { await act(async () => { tree = create(<CodexSubagentSettings visible={visible} />) }) }
const change = async (value: string) => { await act(async () => { byId('codex-subagents-limit').props.onChangeText(value) }) }
const press = async (id: string) => { await act(async () => { byId(id).props.onPress() }) }
beforeEach(() => {
  writes = []; reads = 0
  resetComponentStore({ activeProfileId: 'profile-a', profileGeneration: 1, connected: true, connecting: false,
    switchingProfileId: null, workspaceAdopting: false, health })
  setTestClient({ validationRevision: 4, isValidated: true,
    codexServerSubagents: async () => { reads++; return configuration },
    setCodexServerSubagents: async limit => { writes.push(limit); return { ...configuration, max_concurrent_threads_per_session: limit } } })
})
afterEach(async () => { if (tree) await act(async () => { tree!.unmount() }); tree = null })

test('loads confirmed configuration, edits locally, saves explicitly, and resets to null', async () => {
  await render()
  assert.equal(reads, 1)
  assert.equal(byId('codex-subagents-limit').props.value, '6')
  await change('12')
  assert.deepEqual(writes, [])
  await press('codex-subagents-save')
  assert.deepEqual(writes, [12])
  assert.equal(byId('codex-subagents-limit').props.value, '12')
  await press('codex-subagents-reset')
  assert.deepEqual(writes, [12, null])
  assert.equal(byId('codex-subagents-limit').props.value, '')
  assert.match(JSON.stringify(tree!.toJSON()), /does not mean unlimited/)
})
test('hidden and unsupported settings never call administration', async () => {
  await render(false)
  assert.equal(tree!.toJSON(), null)
  await act(async () => { useAppStore.setState({ health: null }); tree!.update(<CodexSubagentSettings visible />) })
  assert.equal(tree!.toJSON(), null)
  assert.equal(reads, 0)
})
test('invalid numbers are disabled and cannot dispatch even through an old callback', async () => {
  await render()
  for (const value of ['0', '-1', '1.5', '1e3', '9007199254740992']) {
    await change(value)
    assert.equal(byId('codex-subagents-save').props.disabled, true)
    await press('codex-subagents-save')
  }
  assert.deepEqual(writes, [])
})
test('save is single-flight and acknowledges only the returned value', async () => {
  const pending = deferred<typeof configuration>()
  setTestClient({ validationRevision: 4, codexServerSubagents: async () => configuration,
    setCodexServerSubagents: limit => { writes.push(limit); return pending.promise } })
  await render(); await change('8')
  const save = byId('codex-subagents-save').props.onPress
  await act(async () => { save(); save() })
  assert.deepEqual(writes, [8])
  assert.equal(byId('codex-subagents-save').props.disabled, true)
  await act(async () => { pending.resolve({ ...configuration, max_concurrent_threads_per_session: 7 }) })
  assert.equal(byId('codex-subagents-limit').props.value, '7')
})
test('read and save failures expose retry without claiming a successful save', async () => {
  let attempts = 0
  setTestClient({ validationRevision: 4,
    codexServerSubagents: async () => { if (++attempts === 1) throw new Error('Network interrupted'); return configuration },
    setCodexServerSubagents: async () => { throw new Error('Server is busy') } })
  await render()
  assert.match(JSON.stringify(tree!.toJSON()), /Network interrupted/)
  await press('codex-subagents-retry')
  await change('8'); await press('codex-subagents-save')
  assert.match(JSON.stringify(tree!.toJSON()), /Server is busy/)
  assert.equal(byId('codex-subagents-limit').props.value, '8')
  assert.equal(byId('codex-subagents-save').props.disabled, false)
})
test('unsupported transports and denied administration are read-only with guidance', async () => {
  setTestClient({ validationRevision: 4, codexServerSubagents: async () => ({ ...configuration, configurable: false, message: 'Requires native Codex transport.' }) })
  await render()
  assert.equal(byId('codex-subagents-save').props.disabled, true)
  assert.match(JSON.stringify(tree!.toJSON()), /Requires native Codex transport/)
  await act(async () => { tree!.unmount() }); tree = null
  setTestClient({ validationRevision: 4, codexServerSubagents: async () => { throw new ServerError(403, 'Denied') } })
  await render()
  assert.equal(byId('codex-subagents-save').props.disabled, true)
  assert.match(JSON.stringify(tree!.toJSON()), /not authorized/)
})
test('old displayed controls cannot save after profile switch, server restart, or validation change', async () => {
  const connection = setTestClient({ validationRevision: 4, codexServerSubagents: async () => configuration,
    setCodexServerSubagents: async limit => { writes.push(limit); return configuration } })
  await render(); await change('8')
  const stale = byId('codex-subagents-save').props.onPress
  await act(async () => { useAppStore.setState({ health: { ...health, server_instance_id: 'boot-b' } }); stale() })
  assert.deepEqual(writes, [])
  await change('9')
  const staleValidation = byId('codex-subagents-save').props.onPress
  Object.defineProperty(connection, 'validationRevision', { value: 5 })
  await act(async () => { staleValidation() })
  assert.deepEqual(writes, [])
})
test('late save response cannot overwrite the replacement server configuration', async () => {
  const pending = deferred<typeof configuration>()
  setTestClient({ validationRevision: 4, codexServerSubagents: async () => configuration, setCodexServerSubagents: () => pending.promise })
  await render(); await change('8'); await press('codex-subagents-save')
  await act(async () => {
    setTestClient({ validationRevision: 5, codexServerSubagents: async () => ({ ...configuration, max_concurrent_threads_per_session: 3 }) })
    useAppStore.setState({ activeProfileId: 'profile-b', profileGeneration: 2 })
  })
  await act(async () => { pending.resolve({ ...configuration, max_concurrent_threads_per_session: 8 }) })
  assert.equal(byId('codex-subagents-limit').props.value, '3')
})
test('same-tick capability loss rejects a retained Save callback before React unmounts it', async () => {
  await render(); await change('8')
  const stale = byId('codex-subagents-save').props.onPress
  await act(async () => { useAppStore.setState({ health: { ...health, capabilities: {} } }); stale() })
  assert.deepEqual(writes, [])
  assert.equal(tree!.toJSON(), null)
})
