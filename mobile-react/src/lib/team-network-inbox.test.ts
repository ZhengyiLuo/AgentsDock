import assert from 'node:assert/strict'
import test from 'node:test'
import { TEAM_NETWORK_INBOX_BLOCKER, teamNetworkInboxAvailable } from './team-network-inbox'

test('Team Network stays fail-closed without an authenticated proxy contract', () => {
  assert.equal(teamNetworkInboxAvailable({ ok: true, api_contract_version: 25 }), false)
  assert.match(TEAM_NETWORK_INBOX_BLOCKER, /authenticated Teamspace proxy/)
})

test('Team Network admits only the server-scoped host proxy', () => {
  assert.equal(teamNetworkInboxAvailable({ ok: true, capabilities: { team_hub_v1: {
    available: true,
    designated_host: true,
    version: 1,
    base_path: '/api/team-hub',
    server_session_base_path: '/api/team-hub-server',
    hub_id: 'hub',
    host_server_identity: 'server',
  } } }), true)
})
