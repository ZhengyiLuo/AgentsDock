import type { ClaudeTokenUsage, JsonValue } from '@shared/types'

export interface ClaudeContextUsage {
  contextTokens: number
  effectiveContextWindow: number
  rawContextWindow: number | null
  contextPercent: number
  model: string | null
  providerSessionId: string | null
  snapshotAt: string | null
  usageGeneration: number | null
}

export function parseClaudeContextUsage(value: ClaudeTokenUsage | null | undefined): ClaudeContextUsage | null {
  const root = objectValue(value)
  if (!root) return null
  const native = firstObject(root, ['context_usage', 'contextUsage', 'native', 'raw']) ?? root
  const sources = native === root ? [root] : [root, native]
  const contextTokens = firstNumber(sources, ['context_tokens', 'contextTokens', 'total_tokens', 'totalTokens'])
  const effectiveContextWindow = firstNumber(sources, [
    'effective_context_window', 'effectiveContextWindow', 'max_tokens', 'maxTokens'
  ])
  if (contextTokens == null || effectiveContextWindow == null || effectiveContextWindow <= 0) return null
  const explicitPercent = firstNumber(sources, ['context_percent', 'contextPercent', 'percentage'])
  return {
    contextTokens,
    effectiveContextWindow,
    rawContextWindow: firstNumber(sources, ['raw_context_window', 'rawContextWindow', 'raw_max_tokens', 'rawMaxTokens']),
    contextPercent: clampPercent(explicitPercent ?? contextTokens / effectiveContextWindow * 100),
    model: firstString(sources, ['model']),
    providerSessionId: firstString(sources, ['provider_session_id', 'providerSessionId', 'claude_session_id', 'claudeSessionId']),
    snapshotAt: firstString(sources, ['snapshot_at', 'snapshotAt']),
    usageGeneration: firstNumber(sources, ['usage_generation', 'usageGeneration', 'generation'])
  }
}

export function formatClaudeContextUsageDetail(usage: ClaudeContextUsage | null): string {
  if (!usage) return 'Claude context usage is not available yet.'
  const raw = usage.rawContextWindow != null && usage.rawContextWindow !== usage.effectiveContextWindow
    ? ` · ${formatCompactTokens(usage.rawContextWindow)} raw window`
    : ''
  const model = usage.model ? ` · ${usage.model}` : ''
  return `${formatCompactTokens(usage.contextTokens)} / ${formatCompactTokens(usage.effectiveContextWindow)} usable tokens${raw}${model}`
}

export function formatContextPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const bounded = clampPercent(value)
  return `${Number.isInteger(bounded) ? bounded.toFixed(0) : bounded.toFixed(1)}%`
}

function objectValue(value: unknown): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null
}

function firstObject(record: Record<string, JsonValue>, keys: readonly string[]): Record<string, JsonValue> | null {
  for (const key of keys) {
    const candidate = objectValue(record[key])
    if (candidate) return candidate
  }
  return null
}

function firstNumber(records: readonly Record<string, JsonValue>[], keys: readonly string[]): number | null {
  for (const record of records) {
    for (const key of keys) {
      const candidate = record[key]
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate
    }
  }
  return null
}

function firstString(records: readonly Record<string, JsonValue>[], keys: readonly string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    }
  }
  return null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function formatCompactTokens(value: number): string {
  const safe = Math.max(0, Math.round(value))
  if (safe < 1_000) return safe.toLocaleString()
  if (safe < 100_000) return `${trimDecimal(safe / 1_000)}k`
  if (safe < 1_000_000) return `${Math.round(safe / 1_000)}k`
  return `${trimDecimal(safe / 1_000_000)}m`
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}
