import assert from 'node:assert/strict'
import test from 'node:test'
import type { Health, ServerProfile, Session } from '../types'
import type { StageTeamMailDraftInput } from '../lib/team-mail-draft'
import { client, useAppStore } from './useAppStore'
const originalFetch = globalThis.fetch
const originalSync = useAppStore.getState().syncSelectedSession
globalThis.fetch = async () => { throw new Error('No live transport is allowed in draft staging tests') }
const sessions: Session[] = [{ id: 'source', title: 'Source', backend: 'codex' }, { id: 'target', title: 'Target', backend: 'codex' }, { id: 'third', title: 'Third', backend: 'codex' }]
const health: Health = { ok: true, server_identity: 'server', server_instance_id: 'instance', capabilities: {
  agent_team_messages_v1: { available: true, version: 1, mention_sigil: '@@', send_requires_mention: true },
  team_hub_v1: { available: true, version: 1, server_session_base_path: '/api/team-hub-server' },
} }
function reset(): StageTeamMailDraftInput {
  client.markValidated()
  useAppStore.setState({ initialized: true, activeProfileId: 'uninitialized', profileGeneration: 0, selectedSessionId: 'source', connected: true,
    connecting: false, switchingProfileId: null, workspaceAdopting: false, health, sessions, profiles: [{ id: 'uninitialized', serverIdentity: 'server' } as ServerProfile],
    drafts: { target: 'Keep my draft' }, teamReferencesBySession: {}, chatReferencesBySession: {}, snapshots: {}, uploads: {}, syncSelectedSession: async () => {} })
  return { sessionId: 'target', expectedSelectedSessionId: 'source', expectedProfileId: 'uninitialized', expectedProfileGeneration: 0,
    expectedServerIdentity: 'server', expectedServerInstanceId: 'instance', expectedValidationRevision: client.validationRevision,
    intent: 'reply', message: { teamId: 'team', messageId: 'message', senderId: 'peer', senderName: 'Peer', senderKind: 'server',
      title: 'Exact mail', section: 'mail', mailboxBox: 'inbox' } }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
try {
  await test('Mail Reply only stages a draft and exact sender reference after navigation', async () => {
    const input = reset()
    assert.equal(await useAppStore.getState().stageTeamMailDraft(input), true)
    assert.equal(useAppStore.getState().selectedSessionId, 'target')
    assert.match(useAppStore.getState().drafts.target, /^Keep my draft\n\nReply to/)
    assert.equal(useAppStore.getState().teamReferencesBySession.target[0].target_id, 'peer')
    assert.deepEqual(useAppStore.getState().chatReferencesBySession, {})
  })
  for (const name of ['draft', 'selection', 'instance', 'validation', 'adoption', 'profile identity', 'capabilities']) await test(`Mail draft staging preserves user work after ${name} changes during navigation`, async () => {
    const input = reset(), waiting = deferred()
    useAppStore.setState({ syncSelectedSession: () => waiting.promise })
    const staging = useAppStore.getState().stageTeamMailDraft(input)
    await new Promise<void>(resolve => setImmediate(resolve))
    if (name === 'draft') useAppStore.setState({ drafts: { target: 'New user text' } })
    if (name === 'selection') useAppStore.setState({ selectedSessionId: 'third' })
    if (name === 'instance') useAppStore.setState({ health: { ...health, server_instance_id: 'other' } })
    if (name === 'validation') { client.revokeValidation(); client.markValidated() }
    if (name === 'adoption') useAppStore.setState({ workspaceAdopting: true })
    if (name === 'profile identity') useAppStore.setState({ profiles: [{ id: 'uninitialized', serverIdentity: 'other' } as ServerProfile] })
    if (name === 'capabilities') useAppStore.setState({ health: { ...health, capabilities: {} } })
    waiting.resolve()
    assert.equal(await staging, false)
    assert.equal(useAppStore.getState().drafts.target, name === 'draft' ? 'New user text' : 'Keep my draft')
    assert.deepEqual(useAppStore.getState().teamReferencesBySession, {})
  })
  await test('stale starting selection and unsupported Team capability never navigate or change draft', async () => {
    const input = reset()
    assert.equal(await useAppStore.getState().stageTeamMailDraft({ ...input, expectedSelectedSessionId: 'other' }), false)
    useAppStore.setState({ health: { ...health, capabilities: {} } })
    assert.equal(await useAppStore.getState().stageTeamMailDraft(input), false)
    assert.equal(useAppStore.getState().selectedSessionId, 'source')
    assert.equal(useAppStore.getState().drafts.target, 'Keep my draft')
  })
} finally { globalThis.fetch = originalFetch; useAppStore.setState({ syncSelectedSession: originalSync }) }
