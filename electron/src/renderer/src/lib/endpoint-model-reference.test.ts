import { expect, it } from 'vitest'
import { endpointModelReference } from './endpoint-model-reference'

it.each([
  ['https://opencode.ai/zen', 'OpenCode Zen', 'https://opencode.ai/docs/zen/#endpoints'],
  ['https://opencode.ai/zen/v1/', 'OpenCode Zen', 'https://opencode.ai/docs/zen/#endpoints'],
  ['https://opencode.ai/zen/go', 'OpenCode Go', 'https://opencode.ai/docs/go/#endpoints'],
  ['https://opencode.ai/zen/go/v1/', 'OpenCode Go', 'https://opencode.ai/docs/go/#endpoints'],
  ['https://api.anthropic.com', 'Anthropic', 'https://platform.claude.com/docs/en/models/overview'],
  ['https://api.anthropic.com/v1/', 'Anthropic', 'https://platform.claude.com/docs/en/models/overview'],
  ['https://openrouter.ai/api', 'OpenRouter', 'https://openrouter.ai/models'],
  ['https://openrouter.ai/api/v1/', 'OpenRouter', 'https://openrouter.ai/models'],
  [' https://eu.openrouter.ai/api/v1 ', 'OpenRouter', 'https://openrouter.ai/models'],
])('links %s to its official model IDs', (endpoint, provider, url) => {
  expect(endpointModelReference(endpoint)).toEqual({ provider, url })
})

it.each([
  '', 'https://', 'https://company.example/v1', 'https://opencode.ai.evil.test/zen/v1',
  'https://opencode.ai/other', 'https://api.anthropic.com/proxy/v1',
  'http://opencode.ai/zen/v1', 'https://opencode.ai:8443/zen/v1',
  'https://secret@opencode.ai/zen/v1', 'https://opencode.ai/zen/v1?key=secret',
  'https://opencode.ai/zen/v1#secret',
])('does not guess a catalog for %s', endpoint => {
  expect(endpointModelReference(endpoint)).toBeNull()
})
