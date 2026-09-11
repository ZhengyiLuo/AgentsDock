import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TeamHubClient } from './team-hub-client'
import { AgentServerClient } from './server-client'
import { readSecureSecretFile } from './team-hub-secret-files'
import { deriveMountedTeamHubURL } from '../shared/team-hub-url'
import { normalizeServerURL } from '../shared/server-url'

const liveURL = process.env.AGENTSDOCK_TEAM_HUB_LIVE_URL
const bootstrapProofFile = process.env.AGENTSDOCK_TEAM_HUB_BOOTSTRAP_PROOF_FILE
const embeddedServerURL = process.env.AGENTSDOCK_TEAM_HUB_SERVER_LIVE_URL
const embeddedServerToken = process.env.AGENTSDOCK_TEAM_HUB_SERVER_LIVE_TOKEN

describe.skipIf(!embeddedServerURL || !embeddedServerToken)('mounted Team Hub discovery contract', () => {
  it('discovers and verifies the Hub on the authenticated AgentsServer listener', async () => {
    const server = new AgentServerClient(embeddedServerURL!, embeddedServerToken!)
    const health = await server.health(5_000, 'error')
    const capability = health.capabilities?.team_hub_v1
    expect(capability).toMatchObject({
      available: true,
      designated_host: true,
      version: 1,
      base_path: '/api/team-hub',
      host_server_identity: health.server_identity
    })
    const hubURL = deriveMountedTeamHubURL(normalizeServerURL(embeddedServerURL!), capability!.base_path!)
    const hub = new TeamHubClient(hubURL)
    await expect(hub.health()).resolves.toMatchObject({ hub_id: capability!.hub_id })
    hub.dispose()
    server.dispose()
  }, 15_000)
})

describe.skipIf(!liveURL || !bootstrapProofFile)('Team Hub live V1 contract', () => {
  it('bootstraps and exercises authenticated teams, ACL channels, and passive messages', async () => {
    const client = new TeamHubClient(liveURL!)
    const health = await client.health()
    expect(health).toMatchObject({
      ok: true,
      service: 'agentsdock-team-hub',
      api_version: 1,
      bootstrapped: false,
      bootstrap_required: true
    })

    const ownerEmail = `desktop-live-${randomUUID()}@example.test`
    const owner = await client.bootstrap(readSecureSecretFile(bootstrapProofFile!), {
      email: ownerEmail,
      display_name: 'Desktop live owner',
      device_label: 'Desktop live test'
    })
    const team = owner.teams[0]
    expect(team).toMatchObject({ role: 'owner', status: 'active' })

    const board = (await client.createChannel(owner.access_token, team.id, {
      kind: 'board',
      visibility: 'team',
      slug: 'desktop-live',
      display_name: 'Desktop live',
      idempotency_key: randomUUID()
    })).channel
    expect(board.permissions).toEqual({ read: true, post: true, manage: true, dispatch: false })

    const posted = (await client.postMessage(owner.access_token, board.id, {
      body: '@agent this remains a passive live-contract post',
      body_format: 'plain',
      kind: 'post',
      idempotency_key: randomUUID()
    })).message
    expect(posted).toMatchObject({ team_id: team.id, channel_id: board.id, kind: 'post' })
    await expect(client.messages(owner.access_token, board.id)).resolves.toMatchObject({
      messages: [{ id: posted.id, body: '@agent this remains a passive live-contract post' }]
    })

    const memberEmail = `desktop-member-${randomUUID()}@example.test`
    const invitation = await client.createInvitation(owner.access_token, team.id, {
      invitee_email: memberEmail,
      role: 'member'
    })
    const member = await client.redeemInvitation(invitation.token, {
      email: memberEmail,
      display_name: 'Desktop live member',
      device_label: 'Desktop member test'
    })
    const announcements = (await client.createChannel(owner.access_token, team.id, {
      kind: 'announcements',
      visibility: 'team',
      slug: 'desktop-announcements',
      display_name: 'Desktop announcements',
      idempotency_key: randomUUID()
    })).channel
    const memberChannels = await client.channels(member.access_token, team.id)
    expect(memberChannels.channels.find(channel => channel.id === announcements.id)?.permissions).toEqual({
      read: true, post: false, manage: false, dispatch: false
    })

    client.dispose()
  }, 30_000)
})
