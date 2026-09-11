import assert from 'node:assert/strict'
import test from 'node:test'
import { teamNetworkProxyRoute, teamNetworkRequestPath } from './team-network'

test('host Teamspace uses the authenticated server-session proxy', () => {
  assert.deepEqual(teamNetworkProxyRoute({ ok: true, capabilities: { team_hub_v1: {
    available: true,
    designated_host: true,
    version: 1,
    base_path: '/api/team-hub',
    server_session_base_path: '/api/team-hub-server',
    hub_id: 'hub-1',
    host_server_identity: 'server-1',
  } } }), { basePath: '/api/team-hub-server', sessionPath: '/v1/server-session' })
})

test('secure peers use only a canonical v4 proxy mount', () => {
  const route = teamNetworkProxyRoute({ ok: true, capabilities: { team_hub_v1: {
    available: true,
    designated_host: false,
    version: 1,
    base_path: '/api/team-hub-secure/123e4567-e89b-42d3-a456-426614174000',
    transport: 'secure_peer',
    hub_id: 'hub-1',
    host_server_identity: 'server-1',
  } } })
  assert.equal(route?.sessionPath, '/v1/peer-session')
  assert.equal(teamNetworkProxyRoute({ ok: true, capabilities: { team_hub_v1: {
    available: true,
    designated_host: false,
    version: 1,
    base_path: '/api/team-hub-secure/not-a-uuid',
    transport: 'secure_peer',
    hub_id: 'hub-1',
    host_server_identity: 'server-1',
  } } }), null)
})

test('Teamspace request paths cannot escape their authenticated mount', () => {
  assert.equal(teamNetworkRequestPath('/api/team-hub-server', '/v1/teams'), '/api/team-hub-server/v1/teams')
  assert.throws(() => teamNetworkRequestPath('/api/team-hub-server', '/../api/health'))
  assert.throws(() => teamNetworkRequestPath('https://hub.example', '/v1/teams'))
})
