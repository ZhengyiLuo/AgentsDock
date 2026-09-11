import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Health, TeamReference } from '../types'
import { chatMentionTrigger, chatReferencesEqual, localChatReferenceContractSupported } from './chat-references'
import { insertTeamReference, loadTeamMentionCandidates, parseStoredTeamReferences, reconcileTeamReferences, requireTeamReferenceSupport, restoreFailedTeamReferences, teamAllServersAliasAvailable, teamBulletinAliasAvailable, teamMentionTrigger, teamMessagesAvailable, teamReferenceContractSupported, teamReferencesEqual, teamReferenceTokenPresent, validTeamReferences } from './team-references'

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

test('discovery uses approved secure proxy and keeps offline inboxes while excluding self and suspended', async () => {
  const client = connection(path => path.includes('/network?') ? { ...page, servers: [server, { ...server, id: 'self', owned_by_caller: true }, { ...server, id: 'same', server_identity: health.server_identity }, { ...server, id: 'off', status: 'offline' }, { ...server, id: 'suspended', status: 'suspended' }] } : respond(path))
  const candidates = await loadTeamMentionCandidates(client, health, () => true)
  assert.deepEqual(candidates, [{ id: 'server:team-1:node-1', label: 'Atlas', teamName: 'Studio', target }, { id: 'server:team-1:off', label: 'Atlas', teamName: 'Studio', hint: 'Offline · inbox available', target: { ...target, target_id: 'off' } }])
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

const bulletinCapability = { available: true, version: 1, mention: '@@bulletin', legacy_mention: '@@all' }
const allServersCapability = { available: true, version: 1, mention: '@@all', recipient_kind: 'all_servers', max_recipients_per_message: 1024 }
const aliasHealth: Health = { ...health, capabilities: { ...health.capabilities, team_bulletin_alias_v1: bulletinCapability, team_all_servers_alias_v1: allServersCapability } }
const aliasHub = { ...hub, capabilities: { ...hub.capabilities, team_all_servers_alias_v1: allServersCapability } }
const bulletinReference: TeamReference = { ...reference, recipient_kind: 'all', target_id: 'all', display_name_snapshot: 'bulletin', source_text_end: 10 }
const allServersReference: TeamReference = { ...reference, recipient_kind: 'all_servers', target_id: 'all_servers', display_name_snapshot: 'all', source_text_end: 5 }

test('Bulletin and all-server aliases require their exact native contracts', () => {
  assert.equal(teamBulletinAliasAvailable(aliasHealth), true)
  assert.equal(teamAllServersAliasAvailable(aliasHealth), true)
  assert.equal(teamReferenceContractSupported(health, reference), true)
  for (const candidate of [bulletinReference, allServersReference]) {
    assert.equal(teamReferenceContractSupported(aliasHealth, candidate), true)
    assert.equal(teamReferenceContractSupported(health, candidate), false)
    assert.equal(teamReferenceContractSupported({ ...aliasHealth, capabilities: { ...aliasHealth.capabilities, team_hub_v1: undefined } }, candidate), false)
  }
  for (const changed of [{ available: false }, { version: 2 }, { mention: '@@all' }, { legacy_mention: '@@everyone' }, { required: 'true' }, { extra: true }]) {
    assert.equal(teamBulletinAliasAvailable({ ...health, capabilities: { ...health.capabilities, team_bulletin_alias_v1: { ...bulletinCapability, ...changed } } }), false)
  }
  for (const changed of [{ available: false }, { version: 2 }, { mention: '@@bulletin' }, { recipient_kind: 'all' }, { max_recipients_per_message: 0 }, { max_recipients_per_message: 1025 }, { max_recipients_per_message: 1.5 }, { extra: true }]) {
    assert.equal(teamAllServersAliasAvailable({ ...health, capabilities: { ...health.capabilities, team_all_servers_alias_v1: { ...allServersCapability, ...changed } } }), false)
  }
})

test('alias selection and stored drafts preserve exact destination without reinterpreting legacy Bulletin', () => {
  for (const candidate of [bulletinReference, allServersReference]) {
    const result = insertTeamReference('@@', { kind: '@@', start: 0, end: 2, query: '' }, candidate)
    assert.deepEqual(result.reference, candidate)
    assert.deepEqual(parseStoredTeamReferences([candidate], result.text), [candidate])
    assert.deepEqual(reconcileTeamReferences(result.text, `Ask ${result.text}`, [candidate]), [{ ...candidate, source_text_start: 4, source_text_end: candidate.source_text_end + 4 }])
  }
  const legacy = { ...bulletinReference, display_name_snapshot: 'all', source_text_end: 5 }
  assert.deepEqual(parseStoredTeamReferences([legacy], '@@all '), [legacy])
  assert.equal(parseStoredTeamReferences([legacy], '@@all ')[0]?.recipient_kind, 'all')
  assert.deepEqual(validTeamReferences('@@all ', [{ ...allServersReference, target_id: 'all' }]), [])
  assert.deepEqual(validTeamReferences('@@all ', [{ ...allServersReference, recipient_kind: 'all', target_id: 'all_servers' }]), [])
  assert.deepEqual(validTeamReferences('@@bulletin ', [{ ...bulletinReference, recipient_kind: 'all_servers' }]), [])
})

test('discovery exposes Bulletin and all servers only behind native and verified Hub capability gates', async () => {
  const client = connection(path => path === '/v1/health' ? aliasHub : respond(path))
  const candidates = await loadTeamMentionCandidates(client, aliasHealth, () => true)
  assert.deepEqual(candidates.map(candidate => candidate.id), ['all_servers:team-1', 'server:team-1:node-1', 'bulletin:team-1'])
  assert.deepEqual(candidates.find(candidate => candidate.id === 'bulletin:team-1')?.target, { kind: 'recipient', recipient_kind: 'all', team_id: 'team-1', target_id: 'all', display_name_snapshot: 'bulletin' })
  assert.deepEqual(candidates.find(candidate => candidate.id === 'all_servers:team-1')?.target, { kind: 'recipient', recipient_kind: 'all_servers', team_id: 'team-1', target_id: 'all_servers', display_name_snapshot: 'all' })
  const oldServer = await loadTeamMentionCandidates(client, health, () => true)
  assert.deepEqual(oldServer.map(candidate => candidate.target.recipient_kind), ['server'])
  const oldHub = await loadTeamMentionCandidates(connection(respond), aliasHealth, () => true)
  assert.deepEqual(oldHub.map(candidate => candidate.target.recipient_kind), ['server', 'all'])
  const nestedOnly = connection(path => path === '/v1/health' ? { ...hub, capabilities: { team_messages_v1: { ...hub.capabilities.team_messages_v1, all_servers: allServersCapability } } } : respond(path))
  assert.equal((await loadTeamMentionCandidates(nestedOnly, aliasHealth, () => true)).some(candidate => candidate.target.recipient_kind === 'all_servers'), false)
  for (const changed of [{ version: 2 }, { max_recipients_per_message: 1025 }, { mention: '@@bulletin' }]) {
    const malformed = connection(path => path === '/v1/health' ? { ...aliasHub, capabilities: { ...aliasHub.capabilities, team_all_servers_alias_v1: { ...allServersCapability, ...changed } } } : respond(path))
    assert.equal((await loadTeamMentionCandidates(malformed, aliasHealth, () => true)).some(candidate => candidate.target.recipient_kind === 'all_servers'), false)
  }
})

test('admission and queued-edit validation reject unsupported aliases and recheck Hub identity', async () => {
  const client = connection(path => path === '/v1/health' ? aliasHub : respond(path))
  await requireTeamReferenceSupport(client, health, [reference], () => true)
  assert.equal(client.paths.length, 0)
  for (const candidate of [bulletinReference, allServersReference]) {
    await assert.rejects(requireTeamReferenceSupport(client, health, [candidate], () => true), /does not support/)
  }
  assert.equal(client.paths.length, 0)
  await requireTeamReferenceSupport(client, aliasHealth, [bulletinReference, allServersReference], () => true)
  assert.deepEqual(client.paths, ['/v1/health'])
  await assert.rejects(requireTeamReferenceSupport(connection(respond), aliasHealth, [allServersReference], () => true), /cannot deliver/)
  await assert.rejects(requireTeamReferenceSupport(connection(() => ({ ...aliasHub, hub_id: 'other-hub' })), aliasHealth, [allServersReference], () => true), /different Hub identity/)
  await assert.rejects(requireTeamReferenceSupport(connection(() => ({ ...aliasHub, capabilities: { team_all_servers_alias_v1: allServersCapability } })), aliasHealth, [bulletinReference], () => true), /does not support structured/)
})

test('alias validation rejects stale reconnects and capability loss before admission', async () => {
  let current = true
  const stale = connection(path => { current = false; return aliasHub })
  await assert.rejects(requireTeamReferenceSupport(stale, aliasHealth, [allServersReference], () => current), /active server changed/)
  const never = connection(() => { throw new Error('Unexpected request') })
  await assert.rejects(requireTeamReferenceSupport(never, aliasHealth, [allServersReference], () => false), /active server changed/)
  let latestHealth = aliasHealth
  const downgraded = connection(() => { latestHealth = health; return aliasHub })
  await assert.rejects(requireTeamReferenceSupport(downgraded, aliasHealth, [allServersReference], () => teamReferenceContractSupported(latestHealth, allServersReference)), /active server changed/)
})

test('discovery rejects duplicate teams and stale alias results', async () => {
  const duplicate = connection(path => path === '/v1/health' ? aliasHub : path === '/v1/peer-session' ? { ...session, teams: [...session.teams, ...session.teams] } : page)
  await assert.rejects(loadTeamMentionCandidates(duplicate, aliasHealth, () => true), /repeated a team identity/)
  let current = true
  const stale = connection(path => { if (path.includes('/network?')) current = false; return path === '/v1/health' ? aliasHub : respond(path) })
  await assert.rejects(loadTeamMentionCandidates(stale, aliasHealth, () => current), /active server changed/)
})
