import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentServerClient } from './server-client'

const input = { request_id: 'request-a', question: 'Why?' }
const answer = { request_id: 'request-a', session_id: 'chat/a', backend: 'codex', answer: 'Because.', context_note: 'Recent snapshot.' }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('side-question HTTP contract', () => {
  it('sends only the side-question endpoint and validates exact response ownership', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(answer)))
    vi.stubGlobal('fetch', fetch)
    const timeoutSignal = vi.fn(() => new AbortController().signal)
    const client = new AgentServerClient('https://server.example.test', 'test-token', { timeoutSignal })
    await expect(client.askSideQuestion('chat/a', input)).resolves.toEqual(answer)
    expect(fetch).toHaveBeenCalledOnce()
    const [url, options] = fetch.mock.calls[0]
    expect(url).toBe('https://server.example.test/api/sessions/chat%2Fa/side-questions')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual(input)
    expect(options.headers.get('X-AgentsDock-Token')).toBe('test-token')
    expect(options.redirect).toBe('error')
    expect(timeoutSignal).toHaveBeenCalledWith(210_000)
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...answer, session_id: 'wrong' })))
    await expect(client.askSideQuestion('chat/a', input)).rejects.toThrow('side_question_invalid_response')
  })

  it('never retries a failed provider request or falls back to a normal turn', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'Provider unavailable' }), { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const client = new AgentServerClient('https://server.example.test', '')
    await expect(client.askSideQuestion('chat/a', input)).rejects.toThrow('Provider unavailable')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('cancels only the exact side-question URL', async () => {
    const cancelled = { request_id: 'request/a', status: 'cancelled' }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(cancelled)))
    vi.stubGlobal('fetch', fetch)
    const client = new AgentServerClient('https://server.example.test', '')
    await expect(client.cancelSideQuestion('chat/a', 'request/a')).resolves.toEqual(cancelled)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://server.example.test/api/sessions/chat%2Fa/side-questions/request%2Fa', expect.objectContaining({ method: 'DELETE' }))
  })
})
