import { describe, expect, it, vi } from 'vitest'
import { TeamHubClient } from './team-hub-client'

function response(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}
const capability = { available: true, version: 1, max_page_items: 25, max_thread_items: 2048 }

describe('Team Mail thread client', () => {
  it('encodes exact identifiers and sends only one authenticated GET with bounded cursor parameters', async () => {
    const query = { teamId: 'team/one', messageId: 'mail?one', afterSequence: 7, limit: 2 }
    const result = { team_id: query.teamId, anchor_message_id: query.messageId, root_message_id: 'root-1',
      messages: [], next_after_sequence: 7, has_more: false, truncated: true }
    const fetch = vi.fn().mockResolvedValue(response(result))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await expect(client.teamMessageThread('test-access', query)).resolves.toEqual(result)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [input, init] = fetch.mock.calls[0]
    const url = new URL(String(input))
    expect(url.pathname).toBe('/api/team-hub/v1/teams/team%2Fone/network/messages/mail%3Fone/thread')
    expect([...url.searchParams]).toEqual([['after_sequence', '7'], ['limit', '2']])
    expect(init.method).toBe('GET')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-access')
    expect(init.body).toBeUndefined()
    await expect(client.teamMessageThread('test-access', { ...query, limit: 26 })).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a foreign page instead of returning a successful-looking empty thread', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ team_id: 'foreign', anchor_message_id: 'mail-1', root_message_id: 'mail-1',
      messages: [], next_after_sequence: 0, has_more: false, truncated: false }))
    const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
    await expect(client.teamMessageThread('test-access', { teamId: 'team-1', messageId: 'mail-1' })).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps ordinary health usable when optional thread capability is absent, malformed, or from an unknown version', async () => {
    for (const advertised of [undefined, null, { ...capability, version: 2 }, { ...capability, max_page_items: 100 }, capability]) {
      const fetch = vi.fn().mockResolvedValue(response({ ok: true, service: 'agentsdock-team-hub', api_version: 1,
        hub_id: 'hub-1', instance_id: 'instance-1', bootstrapped: true, bootstrap_required: false,
        capabilities: { team_mail_threads_v1: advertised } }))
      const client = new TeamHubClient('http://127.0.0.1:7850/api/team-hub', { fetch })
      const health = await client.health()
      expect(health.bootstrapped).toBe(true)
      expect(health.capabilities?.team_mail_threads_v1).toEqual(advertised === capability ? capability : undefined)
    }
  })
})
