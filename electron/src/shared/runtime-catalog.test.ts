import { describe, expect, it } from 'vitest'
import type { RuntimeCatalog } from './types'
import { runtimeCatalogHasSelectableModels, runtimeCatalogOptions } from './runtime-catalog'

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
