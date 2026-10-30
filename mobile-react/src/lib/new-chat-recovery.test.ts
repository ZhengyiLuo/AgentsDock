import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseNewChatBackend, newChatRecoveryInput } from './new-chat-recovery'
import type { CreateSessionInput, Health, RuntimeCatalog } from '../types'

test('keep an available preference; otherwise choose only from available candidates', () => {
  const choices = ['claude', 'codex', 'cursor', 'opencode', 'gemini-custom'] as const
  for (const preferred of choices) {
    assert.equal(chooseNewChatBackend(choices, preferred, () => { throw new Error('Must inherit') }), preferred)
  }
  choices.forEach((choice, index) => {
    assert.equal(chooseNewChatBackend(choices, 'claude-custom', () => (index + 0.5) / choices.length), choice)
  })
  assert.equal(chooseNewChatBackend([], 'gemini-custom', () => { throw new Error('No candidates') }), undefined)
})

test('an unavailable API can fall back to the same agent native mode, without revisiting rejected choices', () => {
  const input: CreateSessionInput = { title: 'New chat', folder: 'General', cwd: '/old', backend: 'claude', provider_connection: 'custom' }
  const health: Health = { ok: true, default_cwd: '/server', capabilities: { provider_connections_v1: { per_chat: true } } }
  const runtime: RuntimeCatalog = { backends: {
    claude: { models: [], efforts: [], native_credentials_present: true, available: true,
      custom_provider: { configured: true, available: true } },
    codex: { models: [], efforts: [], native_credentials_present: false, available: false },
  } }
  const message = 'Connect this custom API in My Agents before creating a chat.'
  const fallback = newChatRecoveryInput(input, health, runtime, 409, message)
  assert.equal(fallback?.backend, 'claude')
  assert.equal(fallback?.provider_connection, 'default')
  assert.equal(fallback?.cwd, '/server')
  assert.equal(newChatRecoveryInput(input, health, runtime, 409, message, ['claude']), null)
  for (const status of [401, 403, 500]) assert.equal(newChatRecoveryInput(input, health, runtime, status, message), null)
})
