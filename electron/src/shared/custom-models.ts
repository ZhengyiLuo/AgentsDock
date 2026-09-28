export type CustomModelBackend = 'codex' | 'claude' | 'opencode' | 'cursor'
export interface CustomModels {
  backend: CustomModelBackend
  revision: number | string
  default_model: string | null
  models?: { value: string; label: string }[]
  discovery_status?: 'ready' | 'empty' | 'partial' | 'unavailable' | 'authentication_failed'
}
export interface CustomModelInput { model: string | null; expected_revision: number | string }
function invalid(): never { throw new Error('CUSTOM_MODELS_INVALID') }
export function customModelBackend(value: unknown): CustomModelBackend {
  return value === 'codex' || value === 'claude' || value === 'opencode' || value === 'cursor' ? value : invalid()
}
function model(value: unknown): string | null {
  return value === null ? null : typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value) ? value : invalid()
}
function revision(backend: CustomModelBackend, value: unknown): number | string {
  if (backend === 'codex') return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : invalid()
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : invalid()
}
export function customModelInput(backend: CustomModelBackend, value: unknown): CustomModelInput {
  customModelBackend(backend)
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== 'expected_revision,model') return invalid()
  const input = value as CustomModelInput
  return { model: model(input.model), expected_revision: revision(backend, input.expected_revision) }
}
export function parseCustomModels(backend: CustomModelBackend, value: unknown, listing: boolean): CustomModels {
  if (!value || typeof value !== 'object') return invalid()
  const input = value as CustomModels
  if (input.backend !== backend) return invalid()
  const result: CustomModels = { backend, revision: revision(backend, input.revision), default_model: model(input.default_model) }
  if (listing) {
    if (!['ready', 'empty', 'partial', 'unavailable', 'authentication_failed'].includes(input.discovery_status ?? '') || !Array.isArray(input.models) || input.models.length > 512) return invalid()
    result.models = input.models.map(item => {
      const id = model(item.value)
      if (!id || typeof item.label !== 'string' || !item.label || item.label.length > 256 || /[\x00-\x1f\x7f]/.test(item.label)) return invalid()
      return { value: id, label: item.label }
    })
    result.discovery_status = input.discovery_status
  }
  return result
}
