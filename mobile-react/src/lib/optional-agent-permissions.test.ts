import assert from 'node:assert/strict'
import { optionalPermissionModes, queueOptionalPermissionUpdate, awaitOptionalPermissionUpdates } from './optional-agent-permissions'
import { interactiveClientCapabilities } from './chat-references'
import { isBackendLocked } from './runtime-catalog'
import type { Health, Session } from '../types'

const health: Health = { ok: true, capabilities: { gemini_backend: { available: true, version: 1, client_capability: 'gemini_acp_v1', permission_modes: ['default', 'autoEdit', 'yolo'] } } }
const session: Session = { id: 'test', title: 'Test', backend: 'gemini', provider_connection: 'custom' }
assert.deepEqual(interactiveClientCapabilities(session, health), ['gemini_acp_v1'])
assert.deepEqual(interactiveClientCapabilities(session, { ok: true }), [])
assert.deepEqual(optionalPermissionModes(session, health, null), ['default', 'autoEdit', 'yolo'])
assert.deepEqual(optionalPermissionModes({ ...session, gemini_permission_modes: ['default', 'plan'] }, health, null), ['default', 'plan'])
assert.deepEqual(optionalPermissionModes({ ...session, backend: 'opencode' }, health, { backends: { opencode: { models: [], efforts: [], permission_modes: ['default', 'plan', 'not-a-mode'] } } }), ['default', 'plan'])
assert.equal(isBackendLocked({ gemini_session_id: 'native' }), true)
assert.equal(isBackendLocked({ opencode_session_id: 'native' }), true)
const scope = { profileId: 'a', profileGeneration: 1, sessionId: 'test' }
let release!: () => void
let finished = false
const gate = new Promise<void>(resolve => { release = resolve })
const operation = queueOptionalPermissionUpdate(scope, () => gate)
const waiting = awaitOptionalPermissionUpdates(scope).then(() => { finished = true })
await Promise.resolve()
assert.equal(finished, false)
await awaitOptionalPermissionUpdates({ ...scope, profileGeneration: 2 })
release()
await operation
await waiting
assert.equal(finished, true)
console.log('optional provider protocol, permissions, and send barrier passed')
