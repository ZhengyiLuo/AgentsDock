import { describe, it, expect } from 'vitest'
import { isServerConnectionError } from './connection-error'

describe('IPC connection error classification', () => {
  it.each(['fetch failed', 'TypeError: fetch failed', "Error invoking remote method 'turns:send': TypeError: fetch failed",
    'TimeoutError: The operation was aborted due to timeout', 'The server profile has not passed its identity check.'
  ])('recognizes the transport diagnostic %s', message => expect(isServerConnectionError(message)).toBe(true))
  it.each(['Not logged in. Please run codex login.', 'Invalid API key', 'Server identity changed from a to b.',
    'Provider said fetch failed while reading a website', 'Token expired', 'Configure your API endpoint', null
  ])('does not relabel a provider or security failure: %s', message => expect(isServerConnectionError(message)).toBe(false))
})
