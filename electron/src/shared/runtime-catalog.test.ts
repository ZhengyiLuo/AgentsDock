import { describe, expect, it } from 'vitest'
import type { Health, RuntimeCatalog, RuntimeDiagnostic } from './types'
import {
  chatBackendChoice,
  chatBackendSelection,
  codexCustomProviderAvailable,
  selectableChatBackendChoices,
  cursorBackendAvailable,
  cursorBackendSupported,
  runtimeCatalogHasSelectableModels,
  runtimeCatalogOptions,
  runtimeEffortAfterModelChange,
  runtimeEffortOptions,
  runtimeDiagnosticCurrentError,
  runtimeDiagnosticFor,
  runtimeDiagnosticLabel,
  runtimeDiagnosticNeedsAttention,
  runtimeModelLockReason,
  runtimeSelectionError,
  selectableChatBackends,
} from './runtime-catalog'

const validCatalog: RuntimeCatalog = {
  backends: {
    claude: { models: [{ value: '', label: 'Server default' }, { value: 'sonnet', label: 'Sonnet' }], efforts: [] },
    codex: { models: [{ value: '', label: 'Server default' }, { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }], efforts: [] }
  }
}

describe('passive Claude authentication status from the server', () => {
  it.each(['unknown', 'unauthenticated'] as const)('allows a native retry while reporting %s honestly', status => {
    const diagnostic: RuntimeDiagnostic = {
      backend: 'claude', status, available: false, installed: true,
      authenticated: status === 'unauthenticated' ? false : null,
      message: status === 'unknown'
        ? 'Claude will check authentication when you send a message.'
        : 'The last Claude request failed authentication.'
    }
    const catalog: RuntimeCatalog = { backends: { ...validCatalog.backends,
      claude: { ...validCatalog.backends.claude, available: false, diagnostic }
    } }
    const health: Health = { ok: true, runtimes: { claude: diagnostic } }
    expect(runtimeCatalogHasSelectableModels(catalog)).toBe(true)
    expect(selectableChatBackends(health, catalog)).toContain('claude')
    expect(runtimeSelectionError(health, catalog, 'claude', 'sonnet')).toBeNull()
    expect(runtimeDiagnosticLabel(runtimeDiagnosticFor(health, catalog, 'claude')))
      .toBe(status === 'unknown' ? 'Not checked' : 'Sign-in required')
  })
})

describe('per-chat Codex provider selection', () => {
  const health: Health = { ok: true, capabilities: { codex_provider_v1: { per_chat: true, per_chat_models: true } }, runtimes: {
    codex: { backend: 'codex', status: 'unauthenticated', available: false, message: 'OpenAI sign-in required' }
  } }
  const catalog: RuntimeCatalog = { backends: { ...validCatalog.backends, codex: { ...validCatalog.backends.codex,
    custom_provider: { configured: true, available: true, model: 'gpt-6-astra', base_url: 'https://inference.example/v1' }
  } } }

  it('adds exactly one choice while preserving native Codex identity and legacy defaults', () => {
    expect(selectableChatBackendChoices(health, catalog)).toEqual(['claude', 'codex', 'codex-custom', 'opencode'])
    expect(chatBackendChoice({ backend: 'codex' })).toBe('codex')
    expect(chatBackendChoice({ backend: 'codex', codex_provider: 'custom' })).toBe('codex-custom')
    expect(chatBackendSelection('codex-custom')).toEqual({ backend: 'codex', codex_provider: 'custom' })
    expect(chatBackendSelection('codex')).toEqual({ backend: 'codex', codex_provider: 'default' })
  })

  it('requires the per-chat capability and a configured ready endpoint', () => {
    expect(codexCustomProviderAvailable(health, catalog)).toBe(true)
    expect(codexCustomProviderAvailable({ ok: true }, catalog)).toBe(false)
    expect(codexCustomProviderAvailable(health, validCatalog)).toBe(false)
    expect(runtimeSelectionError({ ok: true }, catalog, 'codex', null, 'custom')).toContain('Update AgentsServer')
    expect(runtimeSelectionError(health, validCatalog, 'codex', null, 'custom')).toContain('Settings')
  })

  it('admits custom independently of normal Codex login without replacing its model catalog', () => {
    expect(runtimeDiagnosticFor(health, catalog, 'codex')?.status).toBe('unauthenticated')
    expect(runtimeDiagnosticFor(health, catalog, 'codex', 'custom')?.status).toBe('ready')
    expect(runtimeSelectionError(health, catalog, 'codex', null, 'custom')).toBeNull()
    expect(runtimeSelectionError(health, catalog, 'codex', 'gpt-6-astra', 'custom')).toBeNull()
    expect(runtimeSelectionError(health, catalog, 'codex', 'another-model', 'custom')).toBeNull()
    expect(runtimeCatalogOptions(catalog, 'codex', 'models')).toContainEqual({ value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' })
    expect(runtimeCatalogOptions(catalog, 'codex', 'models', null, 'custom').some(option => option.value === 'gpt-5.6-sol')).toBe(false)
    expect(runtimeEffortOptions(catalog, 'codex', null, 'high', 'custom')).toEqual([{ value: '', label: 'Server default' }])
  })

  it('uses discovered endpoint models and model-specific effort without pinning a configured model', () => {
    const discovered: RuntimeCatalog = { backends: { ...catalog.backends, codex: { ...catalog.backends.codex, custom_provider: {
      configured: true, available: true, model: null, base_url: 'https://inference.example/v1',
      models: [{ value: 'provider/fast', label: 'Fast' }, { value: 'provider/deep', label: 'Deep' }],
      efforts: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
      model_efforts: { 'provider/fast': [{ value: 'low', label: 'Low' }] }, default_model: 'provider/deep'
    } } } }
    expect(codexCustomProviderAvailable(health, discovered)).toBe(true)
    expect(runtimeCatalogOptions(discovered, 'codex', 'models', null, 'custom')).toContainEqual({ value: 'provider/fast', label: 'Fast · Unverified' })
    expect(runtimeCatalogOptions(discovered, 'codex', 'models', null, 'custom').some(option => option.value === 'gpt-5.6-sol')).toBe(false)
    expect(runtimeEffortOptions(discovered, 'codex', 'provider/deep', null, 'custom')).toEqual([{ value: '', label: 'Server default' }])
    expect(runtimeEffortAfterModelChange(discovered, 'codex', 'provider/fast', 'high', 'custom')).toBe('low')
    expect(runtimeEffortAfterModelChange(discovered, 'codex', 'unlisted-model', 'high', 'custom')).toBeNull()
    expect(runtimeSelectionError(health, discovered, 'codex', 'unlisted-model', 'custom')).toBeNull()
  })
  it('keeps a retained chat available after endpoint removal and uses only that chat’s model catalog', () => {
    const retained = { configured: true, available: true, model: null, base_url: 'https://first.example/v1',
      models: [{ value: 'first/model', label: 'First' }], efforts: [{ value: 'high', label: 'High' }] }
    const removed: RuntimeCatalog = { backends: { codex: { models: [], efforts: [], custom_provider: {
      configured: false, available: false, model: null, base_url: null
    } } } }
    expect(runtimeSelectionError(health, removed, 'codex', 'first/model', 'custom', retained)).toBeNull()
    expect(runtimeDiagnosticFor(health, removed, 'codex', 'custom', retained)?.available).toBe(true)
    expect(runtimeCatalogOptions(catalog, 'codex', 'models', null, 'custom', retained)).toContainEqual({ value: 'first/model', label: 'First · Unverified' })
    expect(runtimeCatalogOptions(catalog, 'codex', 'models', null, 'custom', retained).some(option => option.value === 'gpt-6-astra')).toBe(false)
  })

  it('honors explicit empty efforts and distinguishes unverified, checked and unsupported models', () => {
    const custom = { configured: true, available: true, model: null, base_url: 'https://endpoint.example/v1',
      models: [{ value: 'vendor/chat', label: 'Chat' }, { value: 'vendor/other', label: 'Other' }, { value: 'vendor/unknown', label: 'Unknown' }],
      efforts: [{ value: 'high', label: 'High' }], default_effort: 'high', model_efforts: { 'vendor/chat': [] },
      model_capabilities: {
        'vendor/chat': { kind: 'chat' as const, compatibility: 'verified' as const, reasoning_efforts: [], reasoning_supported: null },
        'vendor/other': { kind: 'unknown' as const, compatibility: 'unsupported' as const, reasoning_efforts: [], reasoning_supported: false }
      } }
    expect(runtimeEffortOptions(catalog, 'codex', 'vendor/chat', 'high', 'custom', custom)).toEqual([{ value: '', label: 'Server default' }])
    expect(runtimeEffortAfterModelChange(catalog, 'codex', 'vendor/chat', 'high', 'custom', custom)).toBeNull()
    const models = runtimeCatalogOptions(catalog, 'codex', 'models', null, 'custom', custom)
    expect(models.find(item => item.value === 'vendor/chat')?.label).toBe('Chat · Basic check passed')
    expect(models.find(item => item.value === 'vendor/other')?.locked).toBe(true)
    expect(models.find(item => item.value === 'vendor/unknown')).toEqual({ value: 'vendor/unknown', label: 'Unknown · Unverified' })
    expect(runtimeSelectionError(health, catalog, 'codex', 'vendor/other', 'custom', custom)).toContain('compatibility check')
    expect(runtimeSelectionError(health, catalog, 'codex', 'vendor/unknown', 'custom', custom)).toBeNull()
    expect(runtimeEffortAfterModelChange({ backends: { codex: { models: [], efforts: custom.efforts, model_efforts: { plain: [] } } } }, 'codex', 'plain', 'high')).toBeNull()
  })
})

describe('runtimeCatalogHasSelectableModels', () => {
  it('accepts a catalog with concrete choices for both backends', () => {
    expect(runtimeCatalogHasSelectableModels(validCatalog)).toBe(true)
  })

  it('accepts a catalog with no Cursor models at all - Cursor is optional, not required', () => {
    // Most servers won't have Cursor configured/authenticated yet. Requiring
    // it here would throw "Server returned no selectable models" and null
    // out the whole runtime catalog for every server that lacks it, even
    // though Claude/Codex are fine - see main/service.ts's loadRuntimeCatalog.
    expect(runtimeCatalogHasSelectableModels(validCatalog)).toBe(true)
    expect(validCatalog.backends.cursor).toBeUndefined()
  })

  it('still surfaces Cursor models generically when a server does have them', () => {
    const withCursor: RuntimeCatalog = {
      backends: {
        ...validCatalog.backends,
        cursor: { models: [{ value: '', label: 'Server default' }, { value: 'auto', label: 'Auto' }], efforts: [] }
      }
    }
    expect(runtimeCatalogOptions(withCursor, 'cursor', 'models')).toEqual([
      { value: '', label: 'Server default' },
      { value: 'auto', label: 'Auto' }
    ])
  })

  it('rejects the synthetic server-default-only response', () => {
    expect(runtimeCatalogHasSelectableModels({
      backends: {
        claude: { models: [{ value: '', label: 'Server default' }], efforts: [] },
        codex: { models: [{ value: '', label: 'Server default' }], efforts: [] }
      }
    })).toBe(false)
  })

  it('rejects missing and partial catalogs', () => {
    expect(runtimeCatalogHasSelectableModels(null)).toBe(false)
    expect(runtimeCatalogHasSelectableModels({ backends: { codex: validCatalog.backends.codex } })).toBe(false)
  })
})

describe('optional Cursor backend admission', () => {
  const cursorCatalog: RuntimeCatalog = {
    backends: {
      ...validCatalog.backends,
      cursor: {
        available: true,
        models: [{ value: '', label: 'Server default' }, { value: 'auto', label: 'Auto' }],
        efforts: []
      }
    }
  }
  const cursorHealth: Health = {
    ok: true,
    capabilities: {
      cursor_backend: {
        available: true,
        required: false,
        message: 'Cursor is ready.',
        action: null,
        version: 2,
        permission_modes: ['default', 'full_access', 'plan']
      }
    }
  }

  it('requires a compatible v2-or-newer health capability and available catalog backend', () => {
    expect(cursorBackendSupported(cursorHealth)).toBe(true)
    expect(cursorBackendAvailable(cursorHealth, cursorCatalog)).toBe(true)
    expect(selectableChatBackends(cursorHealth, cursorCatalog)).toEqual(['claude', 'codex', 'cursor'])

    expect(cursorBackendAvailable({ ok: true }, cursorCatalog)).toBe(false)
    expect(cursorBackendAvailable(cursorHealth, validCatalog)).toBe(false)
    expect(selectableChatBackends(cursorHealth, validCatalog)).toEqual(['claude', 'codex', 'cursor'])
    expect(selectableChatBackends(cursorHealth, null)).toEqual(['claude', 'codex', 'cursor'])
    expect(cursorBackendSupported({
      ...cursorHealth,
      capabilities: {
        ...cursorHealth.capabilities,
        cursor_backend: { ...cursorHealth.capabilities!.cursor_backend!, version: 3 as 2 }
      }
    })).toBe(true)
    expect(cursorBackendAvailable(cursorHealth, {
      backends: { ...cursorCatalog.backends, cursor: { ...cursorCatalog.backends.cursor, available: false } }
    })).toBe(false)
  })

  it('uses the freshest runtime diagnostic instead of a stale catalog availability bit', () => {
    const staleReadyCatalog: RuntimeCatalog = {
      backends: {
        ...cursorCatalog.backends,
        cursor: {
          ...cursorCatalog.backends.cursor,
          available: true,
          diagnostic: {
            backend: 'cursor', status: 'ready', available: true,
            message: 'Ready', checked_at: '2026-08-30T10:00:00Z'
          }
        }
      }
    }
    const newerMissingHealth: Health = {
      ...cursorHealth,
      runtimes: {
        cursor: {
          backend: 'cursor', status: 'missing', available: false,
          message: 'Cursor CLI is missing.', checked_at: '2026-08-30T10:01:00Z'
        }
      }
    }
    expect(cursorBackendAvailable(newerMissingHealth, staleReadyCatalog)).toBe(false)
    expect(runtimeSelectionError(newerMissingHealth, staleReadyCatalog, 'cursor', 'auto')).toContain('Cursor CLI is missing.')

    const staleMissingCatalog: RuntimeCatalog = {
      backends: {
        ...cursorCatalog.backends,
        cursor: {
          ...cursorCatalog.backends.cursor,
          available: false,
          diagnostic: {
            backend: 'cursor', status: 'missing', available: false,
            message: 'Missing', checked_at: '2026-08-30T10:00:00Z'
          }
        }
      }
    }
    const newerReadyHealth: Health = {
      ...cursorHealth,
      runtimes: {
        cursor: {
          backend: 'cursor', status: 'ready', available: true,
          message: 'Cursor is ready.', checked_at: '2026-08-30T10:01:00Z'
        }
      }
    }
    expect(cursorBackendAvailable(newerReadyHealth, staleMissingCatalog)).toBe(true)
    expect(runtimeSelectionError(newerReadyHealth, staleMissingCatalog, 'cursor', 'auto')).toBeNull()
  })

  it('reports loading instead of setup failure before a ready Cursor catalog arrives', () => {
    const readyHealth: Health = {
      ...cursorHealth,
      runtimes: {
        cursor: {
          backend: 'cursor', status: 'ready', available: true,
          message: 'Cursor is installed and authenticated.', checked_at: '2026-08-30T10:01:00Z'
        }
      }
    }
    expect(runtimeSelectionError(readyHealth, null, 'cursor', 'auto')).toMatch(/model choices are still loading/i)
    expect(runtimeSelectionError(readyHealth, null, 'cursor', 'auto')).not.toMatch(/install|sign in/i)
  })

  it('keeps missing and superseded v1 capability responses on the legacy backend set', () => {
    expect(selectableChatBackends({ ok: true, capabilities: {} }, cursorCatalog)).toEqual(['claude', 'codex'])
    expect(selectableChatBackends({
      ...cursorHealth,
      capabilities: {
        cursor_backend: { ...cursorHealth.capabilities!.cursor_backend!, version: 1 as 2 }
      }
    }, cursorCatalog)).toEqual(['claude', 'codex'])
  })

  it('fails closed for Cursor work when either capability signal disappears', () => {
    expect(runtimeSelectionError(cursorHealth, cursorCatalog, 'cursor', 'auto')).toBeNull()
    expect(runtimeSelectionError({ ok: true }, cursorCatalog, 'cursor', 'auto')).toMatch(/Cursor is unavailable/)
    expect(runtimeSelectionError(cursorHealth, validCatalog, 'cursor', 'auto')).toMatch(/Cursor is unavailable/)
    expect(runtimeSelectionError(cursorHealth, cursorCatalog, 'cursor', 'legacy-custom')).toMatch(/not offered by Cursor/)
  })
})

describe('locked model admission', () => {
  const catalog: RuntimeCatalog = {
    backends: {
      ...validCatalog.backends,
      cursor: {
        available: true,
        models: [
          { value: 'auto', label: 'Auto' },
          { value: 'premium', label: 'Premium', locked: true, locked_reason: 'Upgrade Cursor first.' }
        ],
        efforts: []
      }
    }
  }

  it('returns the server reason for an explicitly selected locked model', () => {
    expect(runtimeModelLockReason(catalog, 'cursor', 'premium')).toBe('Upgrade Cursor first.')
    expect(runtimeModelLockReason(catalog, 'cursor', 'auto')).toBeNull()
    expect(runtimeModelLockReason(catalog, 'cursor', 'unknown-custom')).toBeNull()
  })
})

describe('runtimeCatalogOptions', () => {
  it('uses the server-advertised default label and concrete choices', () => {
    expect(runtimeCatalogOptions(validCatalog, 'codex', 'models')).toEqual([
      { value: '', label: 'Server default' },
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }
    ])
  })

  it('shows a loading state instead of the misleading Server model fallback', () => {
    expect(runtimeCatalogOptions(null, 'codex', 'models')).toEqual([
      { value: '', label: 'Loading model choices…' }
    ])
  })

  it('preserves a saved custom choice while the catalog reloads', () => {
    expect(runtimeCatalogOptions(null, 'claude', 'models', 'claude-fable-5')).toEqual([
      { value: '', label: 'Loading model choices…' },
      { value: 'claude-fable-5', label: 'claude-fable-5' }
    ])
  })
})

describe('model-scoped reasoning efforts', () => {
  const catalog: RuntimeCatalog = {
    backends: {
      claude: validCatalog.backends.claude,
      codex: {
        default_model: 'gpt-5.6-sol',
        default_effort: 'medium',
        models: [
          { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: [
            { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'ultra', label: 'Ultra' }
          ] },
          { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: [
            { value: 'low', label: 'Low' }, { value: 'high', label: 'High' }, { value: 'max', label: 'Max' }
          ] }
        ],
        efforts: [
          { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
          { value: 'max', label: 'Max' }, { value: 'ultra', label: 'Ultra' }
        ]
      }
    }
  }

  it('shows only efforts supported by the selected model', () => {
    expect(runtimeEffortOptions(catalog, 'codex', 'gpt-5.6-luna', 'max')).toEqual([
      { value: '', label: 'Server default' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ])
  })

  it('uses the server default model when the model selection is empty', () => {
    expect(runtimeEffortOptions(catalog, 'codex', null).map(option => option.value)).toEqual(['', 'low', 'medium', 'ultra'])
  })

  it('preserves a supported effort when the model changes', () => {
    expect(runtimeEffortAfterModelChange(catalog, 'codex', 'gpt-5.6-luna', 'high')).toBe('high')
  })

  it('clamps an unsupported effort to the nearest supported level', () => {
    expect(runtimeEffortAfterModelChange(catalog, 'codex', 'gpt-5.6-luna', 'ultra')).toBe('max')
  })

  it('clears stale reasoning effort when a Cursor model changes', () => {
    expect(runtimeEffortAfterModelChange(catalog, 'cursor', 'auto', 'high')).toBeNull()
  })

  it('supports the server model_efforts index used by older model rows', () => {
    const indexedCatalog: RuntimeCatalog = {
      ...catalog,
      backends: {
        ...catalog.backends,
        codex: {
          ...catalog.backends.codex,
          models: [{ value: 'custom', label: 'Custom' }],
          model_efforts: { custom: [{ value: 'high', label: 'High' }] }
        }
      }
    }
    expect(runtimeEffortOptions(indexedCatalog, 'codex', 'custom').map(option => option.value)).toEqual(['', 'high'])
  })
})

describe('runtime diagnostics', () => {
  const ready = (checked_at: string): RuntimeDiagnostic => ({
    backend: 'codex', status: 'ready', available: true, installed: true, authenticated: true,
    message: 'Codex is ready.', checked_at,
  })

  it('uses the newest diagnostic across health and catalog responses', () => {
    const health = { ok: true, runtimes: { codex: ready('2026-07-14T10:00:00Z') } } as Health
    const catalog: RuntimeCatalog = {
      ...validCatalog,
      backends: {
        ...validCatalog.backends,
        codex: {
          ...validCatalog.backends.codex,
          diagnostic: { ...ready('2026-07-14T10:01:00Z'), status: 'unauthenticated', available: false, authenticated: false, message: 'Sign in.' },
        },
      },
    }
    expect(runtimeDiagnosticFor(health, catalog, 'codex')?.status).toBe('unauthenticated')
  })

  it('surfaces a failed run without claiming the CLI is unavailable', () => {
    const diagnostic = { ...ready('2026-07-14T10:00:00Z'), last_error: 'Latest provider run failed.' }
    expect(runtimeDiagnosticNeedsAttention(diagnostic)).toBe(true)
    expect(runtimeDiagnosticLabel(diagnostic)).toBe('Latest run failed')
    expect(diagnostic.available).toBe(true)
  })

  it('clears a stale failure warning after a newer successful CLI probe', () => {
    const diagnostic = {
      ...ready('2026-07-14T10:02:00Z'),
      last_error: 'The previous provider run failed.',
      last_error_at: '2026-07-14T10:01:00Z',
    }
    expect(runtimeDiagnosticNeedsAttention(diagnostic)).toBe(false)
    expect(runtimeDiagnosticLabel(diagnostic)).toBe('Ready')
    expect(runtimeDiagnosticCurrentError(diagnostic)).toBe('')
  })
})
