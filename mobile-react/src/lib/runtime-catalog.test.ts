import assert from 'node:assert/strict'
import test from 'node:test'
import type { Health, RuntimeCatalog } from '../types'
import {
  cursorBackendSupported,
  isBackendLocked,
  runtimeCatalogOptions,
  runtimeEffortAfterModelChange,
  runtimeEffortOptions,
  runtimeSelectionError,
  selectableChatBackends,
} from './runtime-catalog'

const catalog: RuntimeCatalog = {
  backends: {
    codex: {
      default_model: 'gpt-5.6-sol',
      default_effort: 'medium',
      models: [
        { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
        { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
      ],
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
    },
  },
}

test('server default explains why the concrete default also appears', () => {
  assert.deepEqual(runtimeCatalogOptions(catalog, 'codex', 'models'), [
    { value: '', label: 'Server default (GPT-5.6-Sol)' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
  ])
})

test('runtime choices preserve an advertised default without duplicate sentinels', () => {
  const advertised: RuntimeCatalog = {
    backends: {
      codex: {
        ...catalog.backends.codex,
        models: [
          { value: '', label: 'Automatic' },
          { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
          { value: 'gpt-5.6-sol', label: 'Duplicate' },
        ],
      },
    },
  }
  assert.deepEqual(runtimeCatalogOptions(advertised, 'codex', 'models'), [
    { value: '', label: 'Automatic (GPT-5.6-Sol)' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
  ])
})

test('a saved custom value stays visible while the catalog reloads', () => {
  assert.deepEqual(runtimeCatalogOptions(null, 'codex', 'models', 'custom-model'), [
    { value: '', label: 'Loading model choices…' },
    { value: 'custom-model', label: 'custom-model' },
  ])
})

test('locked options pass through generically for any backend', () => {
  const lockedCatalog: RuntimeCatalog = {
    backends: {
      cursor: {
        default_model: 'auto',
        default_effort: null,
        models: [
          { value: 'auto', label: 'Auto' },
          { value: 'gpt-5.2', label: 'GPT-5.2', locked: true, locked_reason: 'Requires a paid Cursor plan' },
        ],
        efforts: [],
      },
    },
  }
  const options = runtimeCatalogOptions(lockedCatalog, 'cursor', 'models')
  const locked = options.find(option => option.value === 'gpt-5.2')
  assert.equal(locked?.locked, true)
  assert.equal(locked?.locked_reason, 'Requires a paid Cursor plan')
  assert.equal(options.find(option => option.value === 'auto')?.locked, undefined)
})

const cursorCatalog: RuntimeCatalog = {
  ...catalog,
  backends: {
    ...catalog.backends,
    cursor: {
      available: true,
      default_model: 'auto',
      default_effort: null,
      models: [{ value: 'auto', label: 'Auto' }],
      efforts: [],
      diagnostic: { backend: 'cursor', status: 'ready', available: true, message: 'Ready' },
    },
  },
}

function cursorHealth(version: number): Health {
  return { ok: true, capabilities: { cursor_backend: { available: true, version } } }
}

test('Cursor admission fails closed unless hardened capability v2 is advertised', () => {
  assert.equal(cursorBackendSupported(cursorHealth(1)), false)
  assert.deepEqual(selectableChatBackends(cursorHealth(1)), ['claude', 'codex'])
  assert.match(runtimeSelectionError(cursorHealth(1), cursorCatalog, 'cursor') ?? '', /hardened Cursor backend/i)
  assert.equal(cursorBackendSupported(cursorHealth(2)), true)
  assert.deepEqual(selectableChatBackends(cursorHealth(2)), ['claude', 'codex', 'cursor'])
  assert.equal(runtimeSelectionError(cursorHealth(2), cursorCatalog, 'cursor', 'auto'), null)
})

test('a chat backend is switchable only before a provider session exists', () => {
  assert.equal(isBackendLocked({ backend_locked: null, session_id: null, claude_session_id: null, codex_thread_id: null, cursor_session_id: null }), false)
  assert.equal(isBackendLocked({ backend_locked: true }), true)
  assert.equal(isBackendLocked({ codex_thread_id: 'thread-123' }), true)
  assert.equal(isBackendLocked({ claude_session_id: 'sess-abc' }), true)
  assert.equal(isBackendLocked({ cursor_session_id: 'cur-1' }), true)
  assert.equal(isBackendLocked({ session_id: 'legacy-1' }), true)
})

test('locked and unknown Cursor models cannot be admitted', () => {
  const locked: RuntimeCatalog = {
    ...cursorCatalog,
    backends: {
      ...cursorCatalog.backends,
      cursor: {
        ...cursorCatalog.backends.cursor,
        models: [{ value: 'auto', label: 'Auto' }, { value: 'pro', label: 'Pro', locked: true, locked_reason: 'Upgrade Cursor' }],
      },
    },
  }
  assert.equal(runtimeSelectionError(cursorHealth(2), locked, 'cursor', 'pro'), 'Upgrade Cursor')
  assert.match(runtimeSelectionError(cursorHealth(2), locked, 'cursor', 'missing') ?? '', /not offered/i)
})

test('reasoning options follow the selected model and downgrade an incompatible effort', () => {
  const scoped: RuntimeCatalog = {
    backends: {
      codex: {
        ...catalog.backends.codex,
        model_efforts: {
          'gpt-5.6-sol': [{ value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }],
          'gpt-5.6-luna': [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }],
        },
      },
    },
  }
  assert.deepEqual(runtimeEffortOptions(scoped, 'codex', 'gpt-5.6-luna').map(option => option.value), ['', 'low', 'medium'])
  assert.equal(runtimeEffortAfterModelChange(scoped, 'codex', 'gpt-5.6-luna', 'high'), 'medium')
})

test('model-scoped Ultra remains an explicit selectable reasoning option', () => {
  const scoped: RuntimeCatalog = {
    backends: {
      codex: {
        ...catalog.backends.codex,
        model_efforts: {
          'gpt-5.6-sol': [
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'ultra', label: 'Ultra' },
          ],
        },
      },
    },
  }
  assert.deepEqual(runtimeEffortOptions(scoped, 'codex', 'gpt-5.6-sol').map(option => option.value), ['', 'medium', 'high', 'ultra'])
  assert.equal(runtimeEffortAfterModelChange(scoped, 'codex', 'gpt-5.6-sol', 'ultra'), 'ultra')
})
