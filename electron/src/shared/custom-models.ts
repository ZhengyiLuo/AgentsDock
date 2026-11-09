export type CustomModelBackend = 'codex' | 'claude' | 'opencode' | 'cursor' | 'gemini'
export interface CustomModels {
  backend: CustomModelBackend
  revision: number | string
  default_model: string | null
  models?: { value: string; label: string; locked?: boolean; check_status?: string }[]
  check_available?: boolean
  discovery_status?: 'ready' | 'empty' | 'partial' | 'unavailable' | 'authentication_failed'
}
export interface CustomModelCheck { backend: CustomModelBackend; revision: number | string; model: string; status: string; scope: 'text_request' }
export function parseCustomModelCheck(backend: CustomModelBackend, value: unknown): CustomModelCheck {
  const input = value as CustomModelCheck
  if (!input || input.backend !== backend || input.scope !== 'text_request'
    || !['verified', 'unsupported', 'model_unavailable', 'authentication_failed', 'rate_limited', 'connection_failed', 'invalid_response'].includes(input.status)) return invalid()
  const id = model(input.model)
  if (!id) return invalid()
  return { backend, revision: revision(backend, input.revision), model: id, status: input.status, scope: 'text_request' }
}
export interface CustomModelInput { model: string | null; expected_revision: number | string }
function invalid(): never { throw new Error('CUSTOM_MODELS_INVALID') }
export function customModelBackend(value: unknown): CustomModelBackend {
  return value === 'codex' || value === 'claude' || value === 'opencode' || value === 'cursor' || value === 'gemini' ? value : invalid()
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
      return { value: id, label: item.label, ...(item.locked === true ? { locked: true } : {}) }
    })
    result.discovery_status = input.discovery_status
    if (input.check_available === true) result.check_available = true
  }
  return result
}
