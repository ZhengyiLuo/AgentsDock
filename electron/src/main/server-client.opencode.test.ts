import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentServerClient } from './server-client'

describe('OpenCode native session and turn wire contract', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('preserves backend, permissions, native attachments and selected skills over HTTP', async () => {
    const requests: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit = {}) => {
      requests.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ session: { id: 'open-chat', title: 'OpenCode', backend: 'opencode', opencode_session_id: 'ses-native', opencode_permission_mode: 'plan' } }), { status: 200 })
    }))
    const client = new AgentServerClient('http://example.test:7850', 'token')
    const session = await client.createSession({ title: 'OpenCode', folder: 'General', cwd: '/work', backend: 'opencode', opencode_permission_mode: 'plan' })
    expect(session.opencode_session_id).toBe('ses-native')
    expect(requests[0]).toMatchObject({ backend: 'opencode', opencode_permission_mode: 'plan', model: null, effort: null, import_history: false })
    await client.updateSession(session.id, { opencode_permission_mode: 'full_access' })
    expect(requests[1]).toEqual({ opencode_permission_mode: 'full_access' })
    await client.sendTurn(session.id, 'Inspect the attachment', ['file-1'], null, null, ['opencode_provider_commands_v1'], [], [], { id: 'pcmd_' + 'a'.repeat(32), revision: 'pcmdrev_' + 'b'.repeat(32) })
    expect(requests[2]).toMatchObject({ file_ids: ['file-1'], model: '', effort: '', client_capabilities: ['opencode_provider_commands_v1'], skill_selection: { id: 'pcmd_' + 'a'.repeat(32), revision: 'pcmdrev_' + 'b'.repeat(32) } })
  })

  it('blocks external resume before any request, and normalizes invalid saved permissions', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ session: { id: 'chat', backend: 'opencode' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const client = new AgentServerClient('http://example.test:7850', 'token')
    await expect(client.createSession({ title: 'OpenCode', folder: 'General', cwd: '/work', backend: 'opencode', providerId: 'external-id' })).rejects.toThrow(/external OpenCode/)
    expect(fetcher).not.toHaveBeenCalled()
    await client.updateSession('chat', { opencode_permission_mode: 'auto_review' } as never)
    const init = (fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1]
    expect(JSON.parse(String(init.body))).toEqual({ opencode_permission_mode: 'default' })
  })
})
