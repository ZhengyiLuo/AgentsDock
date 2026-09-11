import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Health, TeamReference } from '../types'
import { chatMentionTrigger, chatReferencesEqual, localChatReferenceContractSupported } from './chat-references'
import { insertTeamReference, loadTeamMentionCandidates, parseStoredTeamReferences, reconcileTeamReferences, restoreFailedTeamReferences, teamMentionTrigger, teamMessagesAvailable, teamReferencesEqual, teamReferenceTokenPresent, validTeamReferences } from './team-references'

const basePath = '/api/team-hub-secure/12345678-1234-4123-8123-123456789abc'
const health: Health = { ok: true, server_identity: 'local-server', capabilities: {
  agent_team_messages_v1: { available: true, version: 1, mention_sigil: '@@', send_requires_mention: true },
  team_hub_v1: { available: true, version: 1, designated_host: false, transport: 'secure_peer', base_path: basePath, hub_id: 'hub-1', host_server_identity: 'host-1' },
} }
const target = { kind: 'recipient' as const, recipient_kind: 'server' as const, team_id: 'team-1', target_id: 'node-1', display_name_snapshot: 'Atlas' }
const reference: TeamReference = { ...target, source_text_start: 0, source_text_end: 7, grant_intent: true }
const hub = { hub_id: 'hub-1', capabilities: { team_messages_v1: { available: true, version: 1 } } }
const session = { principal: { id: 'node_local', kind: 'node' }, teams: [{ id: 'team-1', display_name: 'Studio', status: 'active' }] }
const server = { id: 'node-1', server_identity: 'remote-1', display_name: 'Remote', recipient_display_name: 'Atlas', status: 'active', owned_by_caller: false }
const page = { network: { id: 'team-1', hub_id: 'hub-1' }, servers: [server], has_more: false, next_after_server_id: 'node-1' }
function connection(respond: (path: string) => unknown | Promise<unknown>) {
  const paths: string[] = []
  return { paths, teamNetworkGet: async <T>(base: string, path: string): Promise<T> => {
    assert.equal(base, basePath)
    paths.push(path)
    return await respond(path) as T
  } }
}
const respond = (path: string) => path === '/v1/health' ? hub : path === '/v1/peer-session' ? session : page

test('@@ is distinct from local @ and ignores resolved references, emails, and triples', () => {
  assert.deepEqual(teamMentionTrigger('Ask @@At', 8), { kind: '@@', start: 4, end: 8, query: 'At' })
  assert.equal(chatMentionTrigger('@@Atlas', 7), null)
  for (const text of ['@@@Atlas', 'mail@@Atlas', '@Atlas']) assert.equal(teamMentionTrigger(text, text.length), null)
  assert.equal(teamMentionTrigger('@@Atlas ', 8, [], [reference]), null)
  assert.deepEqual(teamMentionTrigger('🧭 @@At', 7), { kind: '@@', start: 3, end: 7, query: 'At' })
})

test('selection preserves exact opaque recipient identity and UTF-16 spans', () => {
  const original = '🧭 Ask @@At please'
  const inserted = insertTeamReference(original, { kind: '@@', start: 7, end: 11, query: 'At' }, target)
  assert.equal(inserted.text, '🧭 Ask @@Atlas please')
  assert.equal(inserted.text.slice(inserted.reference.source_text_start, inserted.reference.source_text_end), '@@Atlas')
  assert.equal(inserted.reference.target_id, 'node-1')
  assert.equal(inserted.reference.grant_intent, true)
  assert.equal(validTeamReferences(inserted.text, [inserted.reference]).length, 1)
  assert.throws(() => insertTeamReference('@@', { kind: '@@', start: 0, end: 2, query: '' }, { ...target, display_name_snapshot: '@Admin' }))
})

test('edits shift exact spans and revoke touched markers, never infer new grants', () => {
  const shifted = reconcileTeamReferences('@@Atlas ', 'Ask @@Atlas ', [reference])
  assert.equal(shifted[0]?.source_text_start, 4)
  assert.deepEqual(reconcileTeamReferences('@@Atlas ', '@@Atlass ', [reference]), [])
  assert.deepEqual(reconcileTeamReferences('@@Atlas ', '@@Atlasx', [reference]), [])
  assert.deepEqual(reconcileTeamReferences('Ask ', 'Ask @@Atlas ', []), [])
  assert.equal(teamReferenceTokenPresent('Ask @@Atlass now', 'Atlas'), false)
  assert.equal(teamReferenceTokenPresent('Ask @@Atlas now', 'Atlas'), true)
})

test('rejects invalid authority, overlap, malformed UTF-16, excessive references and duplicate targets', () => {
  for (const changed of [{ grant_intent: false }, { recipient_kind: 'human' }, { kind: 'skill' }, { team_id: '' }, { target_id: ' node-1' }, { source_text_start: 0.5 }, { source_text_end: 8 }]) {
    assert.deepEqual(validTeamReferences('@@Atlas ', [{ ...reference, ...changed } as TeamReference]), [])
  }
  assert.deepEqual(validTeamReferences('@@Atlas \ud800', [reference]), [])
  assert.deepEqual(validTeamReferences('@@Atlas ', Array(17).fill(reference)), [])
  assert.deepEqual(validTeamReferences('@@Atlas ', [reference], [{ source_text_start: 0, source_text_end: 7 }]), [])
  assert.equal(validTeamReferences('@@Atlas @@Atlas ', [reference, { ...reference, source_text_start: 8, source_text_end: 15 }]).length, 1)
  assert.deepEqual(parseStoredTeamReferences([null, 1, { ...reference, secret: 'omit' }], '@@Atlas '), [reference])
  assert.equal(teamReferencesEqual([reference], [{ ...reference, target_id: 'other' }]), false)
})

test('failed sends restore selected grants and newly typed grants with correct offsets', () => {
  const other = { ...reference, target_id: 'node-2' }
  const restored = restoreFailedTeamReferences('@@Atlas ', [reference], '@@Atlas ', [other], '@@Atlas ')
  assert.deepEqual(restored, [reference])
  const current = { ...other, display_name_snapshot: 'Nova', source_text_end: 6 }
  assert.deepEqual(restoreFailedTeamReferences('', [], '@@Nova ', [current], '@@Nova '), [current])
  const merged = restoreFailedTeamReferences('@@Atlas ', [reference], '@@Nova ', [current], '@@Atlas \n\n@@Nova ')
  assert.equal(merged[1]?.source_text_start, 10)
  assert.equal(merged[1]?.target_id, 'node-2')
})

test('capability gate requires the precise send contract and an approved path-bound proxy', () => {
  assert.equal(teamMessagesAvailable(health), true)
  assert.equal(teamMessagesAvailable({ ...health, capabilities: { ...health.capabilities, agent_team_messages_v1: { available: true, version: 2, mention_sigil: '@@', send_requires_mention: true } } }), false)
  assert.equal(teamMessagesAvailable({ ...health, capabilities: { ...health.capabilities, team_hub_v1: { ...health.capabilities!.team_hub_v1!, base_path: 'https://untrusted.test/api/team-hub' } } }), false)
  assert.equal(teamMessagesAvailable(null), false)
})

test('discovery uses approved secure proxy and recipient aliases, excluding self, offline, suspended', async () => {
  const client = connection(path => path.includes('/network?') ? { ...page, servers: [server, { ...server, id: 'self', owned_by_caller: true }, { ...server, id: 'same', server_identity: health.server_identity }, { ...server, id: 'off', status: 'offline' }, { ...server, id: 'suspended', status: 'suspended' }] } : respond(path))
  const candidates = await loadTeamMentionCandidates(client, health, () => true)
  assert.deepEqual(candidates, [{ id: 'server:team-1:node-1', label: 'Atlas', teamName: 'Studio', target }])
  assert.deepEqual(client.paths, ['/v1/health', '/v1/peer-session', '/v1/teams/team-1/network?limit=100'])
})

test('discovery follows bounded exact continuation IDs and rejects repeated cursors', async () => {
  const client = connection(path => path.includes('after_server_id=node-1') ? { ...page, servers: [{ ...server, id: 'node-2', display_name: 'Nova', recipient_display_name: 'Nova' }], next_after_server_id: 'node-2' } : path.includes('/network?') ? { ...page, has_more: true } : respond(path))
  assert.equal((await loadTeamMentionCandidates(client, health, () => true)).length, 2)
  const looping = connection(path => path.includes('/network?') ? { ...page, has_more: true } : respond(path))
  await assert.rejects(loadTeamMentionCandidates(looping, health, () => true), /repeated|pagination/)
})

test('discovery fails closed for stale scope, wrong identity and offline errors; retry loads fresh', async () => {
  let current = true
  const stale = connection(path => { if (path.includes('/network?')) current = false; return respond(path) })
  await assert.rejects(loadTeamMentionCandidates(stale, health, () => current), /active server changed/)
  for (const replacement of [{ ...page, network: { id: 'other-team', hub_id: 'hub-1' } }, { ...page, network: { id: 'team-1', hub_id: 'other-hub' } }]) {
    const wrong = connection(path => path.includes('/network?') ? replacement : respond(path))
    await assert.rejects(loadTeamMentionCandidates(wrong, health, () => true), /different team or Hub/)
  }
  const denied = connection(path => path === '/v1/health' ? { ...hub, capabilities: {} } : respond(path))
  await assert.rejects(loadTeamMentionCandidates(denied, health, () => true), /does not support/)
  let offline = true
  const retry = connection(path => { if (offline) throw new Error('Server offline'); return respond(path) })
  await assert.rejects(loadTeamMentionCandidates(retry, health, () => true), /offline/)
  offline = false
  assert.equal((await loadTeamMentionCandidates(retry, health, () => true)).length, 1)
})

test('local reference contracts cannot admit legacy secure-peer targets or ignore authority changes', () => {
  const local = { session_id: 'other', display_title_snapshot: 'Other', source_text_start: 0, source_text_end: 6, action: 'route' as const, grant_intent: true as const }
  assert.equal(chatReferencesEqual([local], [{ ...local, grant_intent: undefined }]), false)
  assert.equal(chatReferencesEqual([local], [{ ...local, target_kind: 'secure_peer' }]), false)
  assert.equal(localChatReferenceContractSupported(health, { ...local, target_kind: 'secure_peer' }), false)
})
