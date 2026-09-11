import { describe, expect, it, vi } from 'vitest'
import { TeamHubClient, TeamHubClientError, TeamHubTransportError } from './team-hub-client'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const peerPairingId = '09d7bb2e-3b47-4be7-89fc-2cecd90f4434'
const peerFingerprint = `sha256:${'b'.repeat(64)}`

function peerPairingResponse(status = 'pending_approval') {
  return {
    id: peerPairingId,
    direction: 'incoming',
    status,
    peer_server_identity: 'server-remote',
    peer_display_name: 'Remote server',
    remote_endpoint: '100.64.0.1:7851',
    host_server_identity: 'server-local',
    host_ca_fingerprint: `sha256:${'a'.repeat(64)}`,
    peer_public_key_fingerprint: peerFingerprint,
    transcript_hash: 'c'.repeat(64),
    sas_words: ['amber', 'birch', 'cobalt', 'delta', 'ember', 'forest'],
    requested_scopes: ['teamspace.read', 'cross_chat.instruction'],
    granted_scopes: status === 'approved' ? ['cross_chat.instruction'] : [],
    team_id: status === 'approved' ? 'team-1' : null,
    team_display_name: status === 'approved' ? 'Studio' : null,
    hub_id: status === 'approved' ? 'hub-local' : null,
    connection_id: status === 'approved' ? '22e7bb2e-3b47-4be7-89fc-2cecd90f4434' : null,
    local_proxy_base_path: null,
    certificate_expires_at: null,
    certificate_fingerprint: status === 'revoked' ? peerFingerprint : null,
    last_seen_at: null,
    expires_at: '2026-08-24T00:00:00Z',
    error: null
  }
}

describe('TeamHubClient', () => {
  it('opts into mailbox attention only after negotiation, clears it on downgrade, and forwards versioned writes', async () => {
    let advertised: unknown = { available: true, version: 1, address_kinds: ['server'] }
    const receipt = { kind: 'server', id: 'server-2', display_name: 'Recipient', state: 'read',
      delivered_at: '2026-09-09T12:00:00Z', read_at: '2026-09-09T12:01:00Z' }
    const state = { address_kind: 'server', address_id: 'server-2', unread: true, version: 2 }
    const message = { id: 'message-1', sequence: 1, kind: 'message', title: null,
      body_format: 'markdown', body_bytes: 5, body_sha256: 'a'.repeat(64),
      sender: { kind: 'server', id: 'server-1', display_name: 'Studio' }, recipients: [receipt],
      attachments: [], in_reply_to_message_id: null, skill: null, provenance: {}, created_at: '2026-09-09T12:00:00Z' }
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/health')) return response({ ok: true, service: 'agentsdock-team-hub', api_version: 1,
        hub_id: 'hub-stable-a', instance_id: 'instance-a', bootstrapped: true, bootstrap_required: false,
        capabilities: { team_mailbox_state_v1: advertised } })
      if (url.pathname.endsWith('/mailbox-state') && init.method === 'POST') {
        return response({ message_id: 'message-1', mailbox_state: state, recipients: [receipt] })
      }
      const owned = url.searchParams.get('box') !== 'sent'
      const projected = { ...message, ...(owned ? { delivery: receipt } : {}),
        ...(owned && url.searchParams.get('include_mailbox_state') === 'true' ? { mailbox_state: state } : {}) }
      if (url.searchParams.has('box')) return response({ box: url.searchParams.get('box'),
        address: owned ? { kind: 'server', id: 'server-2' } : null,
        messages: [{ ...projected, preview: 'Hello' }], next_after_sequence: 1, has_more: false })
      return response({ message: { ...projected, body: 'Hello' } })
    })
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await expect(client.teamMessage('access', 'team-1', 'message-1')).resolves.not.toHaveProperty('mailbox_state')
    await client.health()
    await expect(client.teamMessages('access', 'team-1', { box: 'inbox', unread: true }))
      .resolves.toMatchObject({ messages: [{ mailbox_state: state }] })
    expect(new URL(String(fetch.mock.calls.at(-1)?.[0])).searchParams.get('unread')).toBe('1')
    await expect(client.teamMessage('access', 'team-1', 'message-1')).resolves.toMatchObject({ mailbox_state: state })
    await client.teamMessages('access', 'team-1', { box: 'sent' })
    expect(new URL(String(fetch.mock.calls.at(-1)?.[0])).searchParams.has('include_mailbox_state')).toBe(false)
    const body = { address_kind: 'server' as const, address_id: 'server-2', unread: true, expected_version: 1, idempotency_key: 'attention-key' }
    await expect(client.setTeamMessageMailboxState('access', 'team-1', 'message-1', body)).resolves.toMatchObject({ mailbox_state: state })
    expect(new URL(String(fetch.mock.calls.at(-1)?.[0])).pathname).toBe('/api/team-hub/v1/teams/team-1/network/messages/message-1/mailbox-state')
    expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toEqual(body)
    for (const unsupported of [undefined, { available: true, version: 2, address_kinds: ['server'] }]) {
      advertised = unsupported
      await client.health()
      await expect(client.teamMessage('access', 'team-1', 'message-1')).resolves.not.toHaveProperty('mailbox_state')
      expect(new URL(String(fetch.mock.calls.at(-1)?.[0])).searchParams.has('include_mailbox_state')).toBe(false)
    }
    const anotherClient = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await anotherClient.teamMessages('access', 'team-1', { box: 'inbox' })
    expect(new URL(String(fetch.mock.calls.at(-1)?.[0])).searchParams.has('include_mailbox_state')).toBe(false)
  })

  it('opts into subjects only for the exact capable client and clears support after a downgrade', async () => {
    const health = { ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-a', instance_id: 'hub-instance-a', bootstrapped: true, bootstrap_required: false }
    const subjectCapability = { available: true, version: 1, max_subject_chars: 160 }
    let advertised = true
    const sender = { kind: 'server', id: 'server-1', display_name: 'Studio' }
    const recipient = { kind: 'server', id: 'server-2', display_name: 'Recipient', state: 'available', delivered_at: null, read_at: null }
    const message = { id: 'message-1', sequence: 1, kind: 'message', title: 'Daily summary',
      body_format: 'markdown', body_bytes: 5, body_sha256: 'a'.repeat(64), sender,
      recipients: [recipient], attachments: [], in_reply_to_message_id: 'original-1', skill: null,
      provenance: {}, created_at: '2026-09-09T12:00:00Z' }
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/health')) return response({ ...health,
        ...(advertised ? { capabilities: { team_mail_subjects_v1: subjectCapability } } : {}) })
      if (url.pathname.endsWith('/revisions') && init.method === 'GET') return response({ message_id: message.id, versions: [] })
      const titled = url.searchParams.get('include_mail_subject') === 'true'
        || init.method === 'POST' && !url.pathname.endsWith('/revisions')
      const projected = { ...message, title: titled ? message.title : null }
      if (url.searchParams.has('box')) return response({ box: 'sent', address: null,
        messages: [{ ...projected, preview: 'Hello' }], next_after_sequence: 1, has_more: false })
      return response({ message: { ...projected, body: 'Hello' } })
    })
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await expect(client.teamMessage('access', 'team-1', 'message-1')).resolves.toMatchObject({ title: null })
    expect(new URL(String(fetch.mock.calls.at(-1)?.[0])).searchParams.has('include_mail_subject')).toBe(false)
    await expect(client.health()).resolves.toMatchObject({ capabilities: { team_mail_subjects_v1: subjectCapability } })
    await expect(client.teamMessages('access', 'team-1', { box: 'sent' })).resolves.toMatchObject({ messages: [{ title: 'Daily summary' }] })
    await expect(client.teamMessage('access', 'team-1', 'message-1')).resolves.toMatchObject({ title: 'Daily summary' })
    await client.teamMessageHistory('access', 'team-1', 'message-1', 1)
    await expect(client.reviseTeamMessage('access', 'team-1', 'message-1', {
      body: 'Hello', body_format: 'markdown', expected_version: 1, idempotency_key: 'revision-key'
    })).resolves.toMatchObject({ title: 'Daily summary' })
    expect(fetch.mock.calls.slice(-4).map(call => new URL(String(call[0])).searchParams.get('include_mail_subject')))
      .toEqual(['true', 'true', null, 'true'])
    const historyCall = fetch.mock.calls.at(-2)
    expect(new URL(String(historyCall?.[0])).searchParams.toString()).toBe('version=1')
    await client.createTeamMessage('access', 'team-1', { kind: 'message', title: 'Daily summary',
      body: 'Hello', body_format: 'markdown', recipients: [{ kind: 'server', id: 'server-2' }],
      attachment_ids: [], in_reply_to_message_id: 'original-1', idempotency_key: 'subject-key' })
    expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ title: 'Daily summary', in_reply_to_message_id: 'original-1' })
    advertised = false
    await client.health()
    await expect(client.teamMessage('access', 'team-1', 'message-1')).resolves.toMatchObject({ title: null })
    await client.teamMessages('access', 'team-1', { box: 'sent' })
    await client.teamMessageHistory('access', 'team-1', 'message-1')
    await client.reviseTeamMessage('access', 'team-1', 'message-1', {
      body: 'Hello', body_format: 'markdown', expected_version: 1, idempotency_key: 'revision-key'
    })
    for (const call of fetch.mock.calls.slice(-4)) {
      expect(new URL(String(call[0])).searchParams.has('include_mail_subject')).toBe(false)
    }
    expect(fetch.mock.calls.filter(call => new URL(String(call[0])).pathname.endsWith('/health'))).toHaveLength(2)
    const anotherClient = new TeamHubClient('http://127.0.0.1:7852/api/team-hub', { fetch })
    await anotherClient.teamMessage('access', 'team-1', 'message-1')
    expect(new URL(String(fetch.mock.calls.at(-1)?.[0])).searchParams.has('include_mail_subject')).toBe(false)
  })

  it.each([null, { available: false, version: 1, max_subject_chars: 160 },
    { available: true, version: 2, max_subject_chars: 160 },
    { available: true, version: 1, max_subject_chars: 161 },
    { available: true, version: 1, max_subject_chars: 160, unexpected: true }
  ])('keeps core health usable but drops unsupported optional subject support (%j)', async unsupported => {
    const health = { ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-a', instance_id: 'instance-a', bootstrapped: true, bootstrap_required: false }
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ...health, capabilities: {
        team_mail_subjects_v1: { available: true, version: 1, max_subject_chars: 160 }
      } }))
      .mockResolvedValueOnce(response({ ...health, capabilities: { team_mail_subjects_v1: unsupported } }))
      .mockResolvedValueOnce(response({ box: 'sent', address: null, messages: [], next_after_sequence: 0, has_more: false }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await expect(client.health()).resolves.toHaveProperty('capabilities.team_mail_subjects_v1.available', true)
    const downgraded = await client.health()
    expect(downgraded).toMatchObject(health)
    expect(downgraded.capabilities?.team_mail_subjects_v1).toBeUndefined()
    await client.teamMessages('access', 'team-1', { box: 'sent' })
    expect(new URL(String(fetch.mock.calls.at(-1)?.[0])).searchParams.has('include_mail_subject')).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('uses the frozen V1 health contract without credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      hub_id: 'hub-stable-a',
      instance_id: 'hub-instance-a',
      bootstrapped: false,
      bootstrap_required: true
    }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    await expect(client.health()).resolves.toMatchObject({ api_version: 1, bootstrapped: false })
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:7850/api/team-hub/v1/health', expect.objectContaining({
      method: 'GET', redirect: 'error'
    }))
    const headers = fetch.mock.calls[0][1].headers as Headers
    expect(headers.has('Authorization')).toBe(false)
    expect(headers.has('X-AgentsDock-Token')).toBe(false)
    expect(headers.has('Origin')).toBe(false)
  })

  it.each([
    [undefined, undefined], [16, 16], [17, 17], [18, 18],
    [null, undefined], ['17', undefined], [true, undefined], [0, undefined],
    [-17, undefined], [17.5, undefined], [Number.MAX_SAFE_INTEGER + 1, undefined]
  ])('retains only a valid optional Hub schema version (%s)', async (schemaVersion, expected) => {
    const fetch = vi.fn().mockResolvedValue(response({
      ok: true, service: 'agentsdock-team-hub', api_version: 1,
      hub_id: 'hub-stable-a', instance_id: 'hub-instance-a',
      bootstrapped: true, bootstrap_required: false, schema_version: schemaVersion
    }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    const health = await client.health()
    expect(health.schema_version).toBe(expected)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reads the server-scoped session through its exact proxy without a Hub bearer', async () => {
    const snapshot = {
      session: { id: 'managed_server_session_team-1', device_label: 'AgentsServer', expires_at: '2027-01-01T00:00:00Z' },
      principal: { id: 'service_managed_server', kind: 'service', display_name: 'Studio', email: null },
      teams: [{ id: 'team-1', kind: 'shared', slug: 'studio', display_name: 'Studio', role: 'automation', status: 'active' }]
    }
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({
        ok: true, service: 'agentsdock-team-hub', api_version: 1,
        hub_id: 'hub-stable-a', instance_id: 'hub-instance-a',
        bootstrapped: true, bootstrap_required: false, server_session_available: true
      }))
      .mockResolvedValueOnce(response(snapshot))
    const client = new TeamHubClient('https://dock.example.test/prefix/api/team-hub-server', { fetch })

    await expect(client.health()).resolves.toMatchObject({ server_session_available: true })
    await expect(client.serverSession()).resolves.toEqual(snapshot)
    expect(fetch.mock.calls[1][0]).toBe('https://dock.example.test/prefix/api/team-hub-server/v1/server-session')
    expect((fetch.mock.calls[1][1].headers as Headers).has('Authorization')).toBe(false)
  })

  it('sends bearer credentials only in headers and blocks redirect following', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ teams: [] }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await client.teams('access-secret')

    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:7850/api/team-hub/v1/teams')
    expect(url).not.toContain('access-secret')
    expect(init.redirect).toBe('error')
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer access-secret')
    expect((init.headers as Headers).has('X-AgentsDock-Token')).toBe(false)
  })

  it('uses bounded cursor pages and exact human-administration mutation contracts', async () => {
    const createdAt = '2026-09-05T00:00:00Z'
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({
        sessions: [{
          id: 'session-2', device_label: 'Laptop', created_at: createdAt,
          last_seen_at: createdAt, expires_at: '2026-10-05T00:00:00Z',
          revoked_at: null, current: false
        }],
        has_more: true, next_cursor: 'session:next'
      }))
      .mockResolvedValueOnce(response({ revoked: true }))
      .mockResolvedValueOnce(response({
        members: [{
          principal_id: 'person-2', email: 'member@example.test', display_name: 'Member',
          role: 'member', status: 'active'
        }]
      }))
      .mockResolvedValueOnce(response({
        member: {
          principal_id: 'person-2', email: 'member@example.test', display_name: 'Member',
          role: 'admin', status: 'active'
        }
      }))
      .mockResolvedValueOnce(response({
        invitations: [{
          id: 'invite-2', invitee_email: 'invitee@example.test', role: 'guest',
          issued_by_principal_id: 'owner', created_at: createdAt,
          expires_at: '2026-09-06T00:00:00Z', token: 'must-not-escape'
        }],
        has_more: false, next_cursor: null
      }))
      .mockResolvedValueOnce(response({ revoked: true }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    await expect(client.deviceSessions('access', 'session:cursor', 25)).resolves.toMatchObject({
      sessions: [{ id: 'session-2', current: false }], has_more: true, next_cursor: 'session:next'
    })
    await expect(client.revokeDeviceSession('access', 'session-2')).resolves.toEqual({ revoked: true })
    await expect(client.members('access', 'team-1', undefined, 50)).resolves.toMatchObject({
      members: [{ principal_id: 'person-2' }], has_more: false
    })
    await expect(client.updateMember('access', 'team-1', 'person-2', { role: 'admin' }))
      .resolves.toMatchObject({ member: { role: 'admin' } })
    const invitations = await client.invitations('access', 'team-1')
    expect(JSON.stringify(invitations)).not.toContain('must-not-escape')
    await expect(client.revokeInvitation('access', 'team-1', 'invite-2')).resolves.toEqual({ revoked: true })

    expect(fetch.mock.calls.map(call => [new URL(call[0]).pathname + new URL(call[0]).search, call[1].method])).toEqual([
      ['/api/team-hub/v1/sessions?limit=25&cursor=session%3Acursor', 'GET'],
      ['/api/team-hub/v1/sessions/session-2/revoke', 'POST'],
      ['/api/team-hub/v1/teams/team-1/members', 'GET'],
      ['/api/team-hub/v1/teams/team-1/members/person-2', 'PATCH'],
      ['/api/team-hub/v1/teams/team-1/invitations?limit=50', 'GET'],
      ['/api/team-hub/v1/teams/team-1/invitations/invite-2/revoke', 'POST']
    ])
    expect(fetch.mock.calls[3][1].body).toBe(JSON.stringify({ role: 'admin' }))
    expect(fetch.mock.calls.every(call => (call[1].headers as Headers).get('Authorization') === 'Bearer access')).toBe(true)
  })

  it('classifies a JSON body reset after authenticated response headers as transport failure', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"teams":'))
        controller.error(new TypeError('connection reset'))
      }
    }), { status: 200 }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    await expect(client.teams('access-secret')).rejects.toBeInstanceOf(TeamHubTransportError)
  })

  it('keeps the beta.33 members route query-free and rejects a stale cursor before fetch', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(
      response({ members: [] })
    ))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    await client.members('access', 'team-1')
    await expect(client.members('access', 'team-1', 'member:next', 25))
      .rejects.toThrow('Team member pagination is not supported')

    expect(fetch.mock.calls.map(call => new URL(call[0]).pathname + new URL(call[0]).search)).toEqual([
      '/api/team-hub/v1/teams/team-1/members'
    ])
  })

  it('rejects a partial members pagination envelope', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      members: [], has_more: false
    }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    await expect(client.members('access', 'team-1')).rejects.toThrow('Team Hub returned an invalid')
  })

  it('classifies a declared JSON body truncation as transport failure', async () => {
    const body = '{"teams":[]}'
    const fetch = vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'Content-Length': String(Buffer.byteLength(body) + 5) }
    }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    await expect(client.teams('access-secret')).rejects.toBeInstanceOf(TeamHubTransportError)
  })

  it('keeps the request deadline active while an authenticated JSON body stalls', async () => {
    const deadline = new AbortController()
    const timeoutSignal = vi.fn(() => deadline.signal)
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"teams":')) }
    }), { status: 200 }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch, timeoutSignal })
    const loading = client.teams('access-secret')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())

    deadline.abort(new DOMException('Timed out.', 'TimeoutError'))

    await expect(loading).rejects.toBeInstanceOf(TeamHubTransportError)
  })

  it('matches the exact bootstrap header/body and never leaks its proof in an error', async () => {
    const proof = 'one-time-bootstrap-secret'
    const fetch = vi.fn().mockResolvedValue(response({
      error: { code: 'invalid_proof', message: `Rejected ${proof}` }
    }, 401))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    const thrown = await client.bootstrap(proof, {
      email: 'owner@example.test', display_name: 'Owner', device_label: 'Desktop'
    }).catch(error => error)
    expect(thrown).toBeInstanceOf(TeamHubClientError)
    expect(String(thrown.message)).not.toContain(proof)
    expect(String(thrown.message)).toContain('[redacted]')
    const init = fetch.mock.calls[0][1]
    expect((init.headers as Headers).get('X-Team-Hub-Bootstrap-Proof')).toBe(proof)
    expect((init.headers as Headers).get('X-Team-Hub-Bootstrap-Request-Id')).toBeNull()
    expect(JSON.parse(init.body)).toEqual({
      email: 'owner@example.test', display_name: 'Owner', device_label: 'Desktop'
    })
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json')
    expect((init.headers as Headers).get('Content-Length')).toBe(String(Buffer.byteLength(init.body)))
  })

  it('binds a remote bootstrap redemption to the parent-issued request id without exposing either secret', async () => {
    const proof = `bootstrap_remote.${'a'.repeat(43)}`
    const requestId = '0dc9411c-d409-4d3e-ac83-9f03e3a55d98'
    const fetch = vi.fn().mockResolvedValue(response({
      error: { code: 'invalid_proof', message: `Rejected ${proof} for ${requestId}` }
    }, 401))
    const client = new TeamHubClient('https://atlas.my-tailnet.ts.net:8444/api/team-hub', { fetch })

    const thrown = await client.bootstrap(proof, {
      email: 'owner@example.test', display_name: 'Owner', device_label: 'Desktop'
    }, requestId).catch(error => error)

    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://atlas.my-tailnet.ts.net:8444/api/team-hub/v1/bootstrap/redeem')
    expect((init.headers as Headers).get('X-Team-Hub-Bootstrap-Proof')).toBe(proof)
    expect((init.headers as Headers).get('X-Team-Hub-Bootstrap-Request-Id')).toBe(requestId)
    expect((init.headers as Headers).has('X-AgentsDock-Token')).toBe(false)
    expect(String(thrown.message)).not.toContain(proof)
  })

  it('matches direct-channel and passive-post contracts', async () => {
    const channel = {
      id: 'dm-1', team_id: 'team-1', kind: 'direct', visibility: 'private', slug: null, display_name: null,
      created_by_principal_id: 'me', created_at: '2026-08-20T12:00:00Z', updated_at: '2026-08-20T12:00:00Z',
      archived_at: null, participants: ['me', 'other'],
      permissions: { read: true, post: true, manage: false, dispatch: false }
    }
    const message = {
      id: 'message-1', team_id: 'team-1', channel_id: 'dm-1', channel_sequence: 1, kind: 'post',
      thread_root_message_id: null, parent_message_id: null, author_principal_id: 'me', body_format: 'plain',
      body: '@agent please notice this passively', created_at: '2026-08-20T12:00:00Z', edited_at: null, deleted_at: null
    }
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ channel }))
      .mockResolvedValueOnce(response({ message }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    await client.createChannel('access', 'team/one', {
      kind: 'direct', visibility: 'private', participant_principal_ids: ['me', 'other'], idempotency_key: 'idem-dm'
    })
    await client.postMessage('access', 'dm/one', {
      body: '@agent please notice this passively', body_format: 'plain', kind: 'post', idempotency_key: 'idem-post'
    })

    expect(fetch.mock.calls[0][0]).toContain('/v1/teams/team%2Fone/channels')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      kind: 'direct', visibility: 'private', participant_principal_ids: ['me', 'other'], idempotency_key: 'idem-dm'
    })
    expect(fetch.mock.calls[1][0]).toContain('/v1/channels/dm%2Fone/messages')
    expect(JSON.parse(fetch.mock.calls[1][1].body).kind).toBe('post')
  })

  it('requires server-computed channel permissions before adopting a channel', async () => {
    const channel = {
      id: 'board-1', team_id: 'team-1', kind: 'board', visibility: 'team', slug: 'general', display_name: 'General',
      created_by_principal_id: 'me', created_at: '2026-08-20T12:00:00Z', updated_at: '2026-08-20T12:00:00Z',
      archived_at: null, participants: []
    }
    const fetch = vi.fn().mockResolvedValue(response({ channels: [channel] }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    await expect(client.channels('access', 'team-1')).rejects.toThrow('channel permissions')
  })

  it('adopts the exact Team Messages V2 list, receipt, and skill wrappers', async () => {
    const createdAt = '2026-09-04T12:00:00Z'
    const sender = { kind: 'server', id: 'server-1', display_name: 'Studio' }
    const recipient = {
      kind: 'human', id: 'human-1', display_name: 'Pat', state: 'available',
      delivered_at: null, read_at: null
    }
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({
        box: 'inbox', address: { kind: 'human', id: 'human-1' },
        messages: [{
          id: 'message-1', sequence: 1, kind: 'message', title: null, body_format: 'markdown',
          preview: 'Hello', body_bytes: 5, body_sha256: 'a'.repeat(64), sender,
          recipients: [recipient], attachments: [], in_reply_to_message_id: null, skill: null,
          provenance: {}, created_at: createdAt, delivery: recipient
        }],
        next_after_sequence: 1, has_more: false
      }))
      .mockResolvedValueOnce(response({ message_id: 'message-1', recipients: [recipient] }))
      .mockResolvedValueOnce(response({
        skill: {
          id: 'skill-1', slug: 'runbook', title: 'Runbook', summary: '', tags: [], version: 1,
          versions_count: 1, pinned: false, pinned_at: null, archived: false, archived_at: null,
          author: sender, body_bytes: 4,
          current: { version: 1, message_id: 'message-2', change_note: '', created_at: createdAt },
          created_at: createdAt, updated_at: createdAt, permissions: { edit: true, manage: true },
          body: '# Go', body_format: 'markdown', attachments: []
        }
      }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    const page = await client.teamMessages('access', 'team-1', {
      box: 'inbox', addressKind: 'human', addressId: 'human-1', limit: 20
    })
    const receipt = await client.recordTeamMessageReceipt('access', 'team-1', 'message-1', {
      state: 'delivered', idempotency_key: 'receipt-key-1'
    })
    const skill = await client.teamSkill('access', 'team-1', 'skill-1')

    expect(page.messages[0]).toMatchObject({ team_id: 'team-1', preview: 'Hello' })
    expect(receipt).toMatchObject({ message_id: 'message-1', recipients: [{ id: 'human-1' }] })
    expect(skill).toMatchObject({ id: 'skill-1', team_id: 'team-1', body: '# Go' })
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      expect.stringContaining('/v1/teams/team-1/network/messages?'),
      expect.stringContaining('/v1/teams/team-1/network/messages/message-1/receipts'),
      expect.stringContaining('/v1/teams/team-1/network/skills/skill-1')
    ])
  })

  it('uses the exact authenticated deletion and deletion-journal routes', async () => {
    const deletedAt = '2026-09-05T12:00:00Z'
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ deleted: true, message_id: 'message/one' }))
      .mockResolvedValueOnce(response({ deleted: true, post_id: 'post/one' }))
      .mockResolvedValueOnce(response({
        deletions: [
          { sequence: 8, kind: 'message', id: 'message/one', deleted_at: deletedAt },
          { sequence: 9, kind: 'bulletin', id: 'post/one', deleted_at: deletedAt }
        ],
        next_after_sequence: 9,
        has_more: false
      }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    await expect(client.deleteTeamMessage('access', 'team/one', 'message/one', {
      idempotency_key: 'delete-message-1'
    })).resolves.toEqual({ deleted: true, message_id: 'message/one' })
    await expect(client.deleteNetworkBulletin('access', 'team/one', 'post/one', {
      idempotency_key: 'delete-post-1'
    })).resolves.toEqual({ deleted: true, post_id: 'post/one' })
    await expect(client.networkDeletions('access', 'team/one', 7, 25)).resolves.toMatchObject({
      next_after_sequence: 9,
      deletions: [{ sequence: 8, kind: 'message' }, { sequence: 9, kind: 'bulletin' }]
    })

    expect(fetch.mock.calls.map(([url, init]) => [new URL(url).pathname + new URL(url).search, init.method, init.body])).toEqual([
      ['/api/team-hub/v1/teams/team%2Fone/network/messages/message%2Fone', 'DELETE', JSON.stringify({ idempotency_key: 'delete-message-1' })],
      ['/api/team-hub/v1/teams/team%2Fone/network/bulletin/post%2Fone', 'DELETE', JSON.stringify({ idempotency_key: 'delete-post-1' })],
      ['/api/team-hub/v1/teams/team%2Fone/network/deletions?after_sequence=7&limit=25', 'GET', undefined]
    ])
    expect(fetch.mock.calls.every(([, init]) => (init.headers as Headers).get('Authorization') === 'Bearer access')).toBe(true)
  })

  it('cancels and rejects chunked JSON and binary-error responses beyond their byte caps', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.enqueue(new Uint8Array([0x61]))
        controller.close()
      }
    })
    const fetch = vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await expect(client.health()).rejects.toThrow('response is too large')

    const binaryCancel = vi.fn()
    const binaryError = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024))
        controller.enqueue(new Uint8Array([0x61]))
      },
      cancel: binaryCancel
    })
    const binaryFetch = vi.fn().mockResolvedValue(new Response(binaryError, { status: 502 }))
    const binaryClient = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch: binaryFetch })
    await expect(binaryClient.downloadTeamAttachmentChunk('access', 'team-1', 'attachment-1', 0, 3))
      .rejects.toMatchObject({ status: 502, code: 'request_failed' })
    expect(binaryCancel).toHaveBeenCalledOnce()
  })

  it('translates a successful binary body reset for the cache consumer', async () => {
    const binaryBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.error(new TypeError('socket reset'))
      }
    })
    const fetch = vi.fn().mockResolvedValue(new Response(binaryBody, {
      status: 206,
      headers: {
        'Content-Length': '4',
        'Content-Range': 'bytes 0-3/4'
      }
    }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    const response = await client.downloadTeamAttachmentChunk('access', 'team-1', 'attachment-1', 0, 3)

    await expect(response.arrayBuffer()).rejects.toBeInstanceOf(TeamHubTransportError)
  })

  it('classifies a normal early EOF in a declared binary range as transport failure', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), {
      status: 206,
      headers: {
        'Content-Length': '4',
        'Content-Range': 'bytes 0-3/4'
      }
    }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    const response = await client.downloadTeamAttachmentChunk('access', 'team-1', 'attachment-1', 0, 3)

    await expect(response.arrayBuffer()).rejects.toBeInstanceOf(TeamHubTransportError)
  })

  it('preserves caller cancellation while reading a delayed binary error body', async () => {
    const cancel = vi.fn()
    let markReadStarted!: () => void
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve })
    const body = new ReadableStream<Uint8Array>({
      pull() {
        markReadStarted()
        return new Promise(() => undefined)
      },
      cancel
    })
    const fetch = vi.fn().mockResolvedValue(new Response(body, { status: 502 }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    const caller = new AbortController()
    const reason = new Error('renderer upload was cancelled')

    const pending = client.downloadTeamAttachmentChunk(
      'access', 'team-1', 'attachment-1', 0, 3, caller.signal
    )
    await readStarted
    caller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('keeps a full page of maximum-size messages within the bounded response budget', async () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index + 1}`,
      team_id: 'team-1',
      channel_id: 'channel-1',
      channel_sequence: index + 1,
      kind: 'post',
      thread_root_message_id: null,
      parent_message_id: null,
      author_principal_id: 'principal-1',
      body_format: 'plain',
      body: 'x'.repeat(64 * 1024),
      created_at: '2026-08-20T12:00:00Z',
      edited_at: null,
      deleted_at: null
    }))
    const fetch = vi.fn().mockResolvedValue(response({ messages, next_before_sequence: 1 }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    await expect(client.messages('access', 'channel-1')).resolves.toMatchObject({ messages: { length: 20 } })
    expect(fetch.mock.calls[0][0]).toContain('limit=20')
  })

  it('rejects malformed auth bundles before a caller can persist their credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      access_token: '', token_type: 'Bearer', access_expires_at: 'not-a-date',
      refresh_token: 'refresh', refresh_expires_at: '2026-09-20T12:00:00Z',
      session: {}, principal: {}, teams: []
    }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await expect(client.refresh('old-refresh')).rejects.toThrow('invalid')
  })

  it('sends device recovery proof only in the dedicated header', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      ...{
        access_token: 'access-new', token_type: 'Bearer', access_expires_at: '2026-08-20T13:00:00Z',
        refresh_token: 'refresh-new', refresh_expires_at: '2026-09-20T12:00:00Z',
        session: { id: 'session-1', device_label: 'This Mac', expires_at: '2026-09-20T12:00:00Z' },
        principal: { id: 'principal-1', email: 'owner@example.test', display_name: 'Owner' }, teams: []
      }
    }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await client.recoverDevice('recovery-proof-secret', { device_label: 'This Mac' })

    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:7850/api/team-hub/v1/device-recovery/redeem')
    expect(url).not.toContain('recovery-proof-secret')
    expect((init.headers as Headers).get('X-Team-Hub-Device-Recovery-Proof')).toBe('recovery-proof-secret')
    expect(JSON.parse(init.body)).toEqual({ device_label: 'This Mac' })
  })

  it('accepts an existing-user invitation with authentication and validates the result', async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      membership: {
        id: 'membership-2', team_id: 'team-2', principal_id: 'principal-1', role: 'member', status: 'active'
      },
      teams: [{ id: 'team-2', kind: 'shared', slug: 'team-two', display_name: 'Team two', role: 'member', status: 'active' }]
    }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    const result = await client.acceptInvitation('access-secret', 'invitation-secret')

    expect(result.membership.team_id).toBe('team-2')
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:7850/api/team-hub/v1/invitations/accept')
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer access-secret')
    expect(JSON.parse(init.body)).toEqual({ token: 'invitation-secret' })
  })

  it('keeps assigned-peer revocation exact-team scoped with certificate CAS', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ peer: peerPairingResponse('revoked') }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await client.revokeSecurePeer('access', 'team-1', {
      peerId: peerPairingId,
      expectedCertificateFingerprint: peerFingerprint,
      idempotencyKey: '42e7bb2e-3b47-4be7-89fc-2cecd90f4434'
    })

    expect(fetch.mock.calls[0][0]).toBe(
      `http://127.0.0.1:7850/api/team-hub/v1/teams/team-1/secure-peers/${peerPairingId}/revoke`
    )
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      idempotency_key: '42e7bb2e-3b47-4be7-89fc-2cecd90f4434',
      expected_certificate_fingerprint: peerFingerprint
    })
  })

  it('propagates caller cancellation through attachment declaration and metadata requests', async () => {
    const requests: AbortSignal[] = []
    const fetch = vi.fn((_url: string | URL | Request, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      requests.push(signal)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })

    for (const invoke of [
      (signal: AbortSignal) => client.declareTeamAttachment('access', 'team-1', {
        file_name: 'private.bin', media_type: 'application/octet-stream', byte_size: 3,
        sha256: 'a'.repeat(64), idempotency_key: 'declare-private'
      }, signal),
      (signal: AbortSignal) => client.teamAttachment('access', 'team-1', 'attachment-1', signal)
    ]) {
      const controller = new AbortController()
      const reason = new Error('renderer destroyed')
      const pending = invoke(controller.signal)
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0))
      controller.abort(reason)
      await expect(pending).rejects.toBe(reason)
      requests.shift()
    }
  })
})
