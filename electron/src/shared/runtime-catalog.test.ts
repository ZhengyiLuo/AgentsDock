import { describe, expect, it } from 'vitest'
import type { Health, RuntimeCatalog, RuntimeDiagnostic } from './types'
import { runtimeCatalogHasSelectableModels, runtimeCatalogOptions, runtimeDiagnosticFor, runtimeDiagnosticLabel, runtimeDiagnosticNeedsAttention } from './runtime-catalog'

const validCatalog: RuntimeCatalog = {
  backends: {
    claude: { models: [{ value: '', label: 'Server default' }, { value: 'sonnet', label: 'Sonnet' }], efforts: [] },
    codex: { models: [{ value: '', label: 'Server default' }, { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }], efforts: [] }
  }
}

describe('runtimeCatalogHasSelectableModels', () => {
  it('accepts a catalog with concrete choices for both backends', () => {
    expect(runtimeCatalogHasSelectableModels(validCatalog)).toBe(true)
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
})
