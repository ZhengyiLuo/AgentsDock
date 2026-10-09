import { afterEach, expect, it, vi } from 'vitest'
import { flushEndpointDraft, queueEndpointDraft, readEndpointDraft } from './endpoint-draft'

const draft = { baseURL: 'https://gateway.example/v1', model: 'model-one', protocol: 'anthropic' as const, authHeader: 'x-api-key' as const }
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear() })

it('debounces writes, restores pending fields, and allowlists non-secret fields only', () => {
  vi.useFakeTimers()
  const write = vi.spyOn(localStorage, 'setItem')
  queueEndpointDraft('server-a', 'opencode', { ...draft, api_key: 'never-persist', result: 'verified' } as typeof draft)
  queueEndpointDraft('server-a', 'opencode', { ...draft, model: 'model-two' })
  expect(write).not.toHaveBeenCalled()
  expect(readEndpointDraft('server-a', 'opencode')?.model).toBe('model-two')
  vi.advanceTimersByTime(400)
  expect(write).toHaveBeenCalledTimes(1)
  const stored = JSON.parse(write.mock.calls[0][1])
  expect(Object.keys(stored).sort()).toEqual(['authHeader', 'baseURL', 'model', 'protocol'])
  expect(readEndpointDraft('server-a', 'opencode')).toEqual({ ...draft, model: 'model-two' })
})

it('isolates servers and providers, flushes on close, and does not invent defaults', () => {
  vi.useFakeTimers()
  queueEndpointDraft('server-a', 'opencode', draft)
  flushEndpointDraft('server-a', 'opencode')
  expect(readEndpointDraft('server-b', 'opencode')).toBeNull()
  expect(readEndpointDraft('server-a', 'claude')).toBeNull()
  expect(readEndpointDraft(null, 'opencode')).toBeNull()
  expect(readEndpointDraft('server-a', 'opencode')).toEqual(draft)
})

it.each(['https://user:secret@example.test/v1', 'https://example.test/v1?key=secret', 'https://example.test/v1#secret'])('never persists URL credentials: %s', baseURL => {
  vi.useFakeTimers()
  queueEndpointDraft('server-a', 'opencode', { ...draft, baseURL })
  flushEndpointDraft('server-a', 'opencode')
  expect(readEndpointDraft('server-a', 'opencode')?.baseURL).toBe('')
  expect(localStorage.getItem(localStorage.key(0)!)).not.toContain('secret')
})

it('tolerates unavailable storage without losing the current non-secret draft', () => {
  vi.useFakeTimers()
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') })
  queueEndpointDraft('storage-failure', 'claude', draft)
  expect(() => flushEndpointDraft('storage-failure', 'claude')).not.toThrow()
  expect(readEndpointDraft('storage-failure', 'claude')).toEqual(draft)
})
