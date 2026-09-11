import type { CodexTokenUsage, Event, JsonValue } from '@shared/types'

export interface CodexContextUsage {
  contextTokens: number | null
  contextWindow: number | null
  effectiveContextWindow: number | null
  baselineTokens: number | null
  contextPercent: number | null
  inputTokens: number | null
  cachedInputTokens: number | null
  cacheWriteInputTokens: number | null
  outputTokens: number | null
  reasoningOutputTokens: number | null
  totalTokens: number | null
  runId: string | null
  turnId: string | null
  threadId: string | null
  snapshotAt: string | null
  seq: number | null
}

/**
 * Reconciles the latest durable AgentsDock usage event with app-server's live
 * runtime snapshot. The live sample wins for metrics while the durable event
 * supplies turn/run attribution and remains useful after app-server unloads.
 */
export function latestCodexContextUsage(
  events: readonly Event[],
  runtimeUsage?: CodexTokenUsage | null,
  currentThreadId?: string | null
): CodexContextUsage | null {
  let durable: CodexContextUsage | null = null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const usage = usageFromEvent(event)
    if (usage && usageMatchesThread(usage, currentThreadId)) {
      durable = usage
      break
    }
  }

  // A selected runtime that explicitly reports no usage is authoritative. Do
  // not resurrect an old compaction snapshot from a previous provider thread.
  if (runtimeUsage === null) return null
  const live = parseCodexContextUsage(runtimeUsage)
  if (live && live.threadId && !usageMatchesThread(live, currentThreadId)) return null
  if (!live) return durable
  if (!durable) return live
  return {
    ...durable,
    ...live,
    runId: live.runId ?? durable.runId,
    turnId: live.turnId ?? durable.turnId,
    threadId: live.threadId ?? durable.threadId,
    snapshotAt: live.snapshotAt ?? durable.snapshotAt,
    seq: durable.seq
  }
}

export function parseCodexContextUsage(value: unknown): CodexContextUsage | null {
  const root = objectValue(value)
  if (!root) return null
  return parseUsageRecords(root, null)
}

export function formatContextUsage(usage: CodexContextUsage | null): string {
  if (!usage) return '—'
  if (usage.contextPercent != null) return `${formatPercent(usage.contextPercent)}%`
  if (usage.contextTokens != null && usage.contextWindow != null && usage.contextWindow > 0) {
    return `${formatPercent(usage.contextTokens / usage.contextWindow * 100)}%`
  }
  return usage.contextTokens != null ? formatCompactTokens(usage.contextTokens) : '—'
}

export function formatContextUsageDetail(usage: CodexContextUsage | null): string {
  if (!usage) return 'Context usage is not available yet.'
  const effectiveTokens = usage.contextTokens == null
    ? null
    : Math.max(0, usage.contextTokens - (usage.baselineTokens ?? 0))
  const context = effectiveTokens == null
    ? null
    : usage.effectiveContextWindow != null
      ? `${formatCompactTokens(effectiveTokens)} / ${formatCompactTokens(usage.effectiveContextWindow)} usable tokens`
      : `${formatCompactTokens(effectiveTokens)} context tokens`
  const parts = [context]
  if (usage.inputTokens != null) parts.push(`${formatCompactTokens(usage.inputTokens)} input`)
  if (usage.cachedInputTokens != null) parts.push(`${formatCompactTokens(usage.cachedInputTokens)} cached`)
  if (usage.cacheWriteInputTokens != null) parts.push(`${formatCompactTokens(usage.cacheWriteInputTokens)} cache write`)
  if (usage.outputTokens != null) parts.push(`${formatCompactTokens(usage.outputTokens)} output`)
  if (usage.reasoningOutputTokens != null) parts.push(`${formatCompactTokens(usage.reasoningOutputTokens)} reasoning`)
  return parts.filter(Boolean).join(' · ') || 'Context usage is not available yet.'
}

export function formatCompactTokens(value: number): string {
  const safe = Math.max(0, Math.round(value))
  if (safe < 1_000) return safe.toLocaleString()
  if (safe < 100_000) return `${trimDecimal(safe / 1_000)}k`
  if (safe < 1_000_000) return `${Math.round(safe / 1_000)}k`
  return `${trimDecimal(safe / 1_000_000)}m`
}

function usageFromEvent(event: Event): CodexContextUsage | null {
  let raw: Record<string, JsonValue> | null = null
  if (event.type === 'codex_token_usage') raw = objectValue(event)
  else if (event.type === 'codex_compaction_completed') {
    raw = objectValue(event.token_usage_after)
    if (!raw) return null
  }
  if (!raw) return null
  const parsed = parseUsageRecords(raw, event)
  if (!parsed) return null
  return {
    ...parsed,
    runId: parsed.runId ?? cleanString(event.run_id),
    turnId: parsed.turnId ?? cleanString(event.turn_id),
    threadId: parsed.threadId ?? cleanString(event.thread_id ?? event.provider_session_id),
    snapshotAt: parsed.snapshotAt ?? cleanString(event.snapshot_at ?? event.ts),
    seq: event.seq
  }
}

function parseUsageRecords(
  root: Record<string, JsonValue>,
  event: Event | null
): CodexContextUsage | null {
  const native = firstObject(root, ['token_usage', 'tokenUsage', 'native']) ?? root
  const last = firstObject(native, ['last', 'lastTokenUsage', 'last_token_usage'])
    ?? firstObject(root, ['last', 'lastTokenUsage', 'last_token_usage'])
  const total = firstObject(native, ['total', 'totalTokenUsage', 'total_token_usage'])
    ?? firstObject(root, ['total', 'totalTokenUsage', 'total_token_usage'])
  const sources = uniqueRecords([root, native])

  const inputTokens = firstNumber(sources, ['input_tokens', 'inputTokens'])
    ?? firstNumber(last ? [last] : [], ['input_tokens', 'inputTokens'])
  const cachedInputTokens = firstNumber(sources, ['cached_input_tokens', 'cachedInputTokens'])
    ?? firstNumber(last ? [last] : [], ['cached_input_tokens', 'cachedInputTokens'])
  const cacheWriteInputTokens = firstNumber(sources, ['cache_write_input_tokens', 'cacheWriteInputTokens'])
    ?? firstNumber(last ? [last] : [], ['cache_write_input_tokens', 'cacheWriteInputTokens'])
  const outputTokens = firstNumber(sources, ['output_tokens', 'outputTokens'])
    ?? firstNumber(last ? [last] : [], ['output_tokens', 'outputTokens'])
  const reasoningOutputTokens = firstNumber(sources, ['reasoning_output_tokens', 'reasoningOutputTokens'])
    ?? firstNumber(last ? [last] : [], ['reasoning_output_tokens', 'reasoningOutputTokens'])
  const contextWindow = firstNumber(sources, [
    'context_window', 'contextWindow', 'model_context_window', 'modelContextWindow'
  ])
  const baselineTokens = firstNumber(sources, ['baseline_tokens', 'baselineTokens'])
    ?? (contextWindow != null && contextWindow > CODEX_CONTEXT_BASELINE_TOKENS
      ? CODEX_CONTEXT_BASELINE_TOKENS
      : 0)
  const effectiveContextWindow = firstNumber(sources, [
    'effective_context_window', 'effectiveContextWindow'
  ]) ?? (contextWindow != null ? Math.max(0, contextWindow - baselineTokens) : null)
  const explicitContextTokens = firstNumber(sources, ['context_tokens', 'contextTokens'])
  const lastTotal = firstNumber(last ? [last] : [], ['total_tokens', 'totalTokens'])
  const calculatedLast = sumKnown(inputTokens, outputTokens)
  const contextTokens = explicitContextTokens ?? lastTotal ?? calculatedLast
  const explicitPercent = firstNumber(sources, ['context_percent', 'contextPercent'])
  // Codex reserves 12k tokens for system/tool context. Match its own context
  // meter by measuring the usable portion instead of dividing by the raw model
  // window. Recompute when raw counts are present so older AgentsServer
  // snapshots with the former raw percentage become accurate too.
  const contextPercent = contextTokens != null && effectiveContextWindow != null && effectiveContextWindow > 0
    ? roundPercent(Math.min(100, Math.max(0, contextTokens - baselineTokens) / effectiveContextWindow * 100))
    : explicitPercent
  // AgentsServer's normalized `total_tokens` is the live-context value from
  // native `last.totalTokens`; cumulative accounting is deliberately separate.
  // Prefer that explicit cumulative field (or native `total`) for the UI's
  // "Session total" datum so it never repeats the context-occupancy number.
  const totalTokens = firstNumber(sources, ['cumulative_total_tokens', 'cumulativeTotalTokens'])
    ?? firstNumber(total ? [total] : [], ['total_tokens', 'totalTokens'])
    ?? firstNumber(sources, ['total_tokens', 'totalTokens'])

  if (
    contextTokens == null
    && contextWindow == null
    && contextPercent == null
    && inputTokens == null
    && outputTokens == null
    && totalTokens == null
  ) return null

  return {
    contextTokens,
    contextWindow,
    effectiveContextWindow,
    baselineTokens,
    contextPercent,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    runId: cleanString(recordString(root, ['run_id', 'runId']) ?? event?.run_id),
    turnId: cleanString(recordString(root, ['turn_id', 'turnId']) ?? event?.turn_id),
    threadId: cleanString(recordString(root, ['thread_id', 'threadId']) ?? event?.thread_id),
    snapshotAt: cleanString(recordString(root, ['snapshot_at', 'snapshotAt']) ?? event?.snapshot_at),
    seq: event?.seq ?? null
  }
}

export const CODEX_CONTEXT_BASELINE_TOKENS = 12_000

function usageMatchesThread(usage: CodexContextUsage, currentThreadId?: string | null): boolean {
  const expected = cleanString(currentThreadId)
  if (!expected) return true
  return usage.threadId === expected
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

function uniqueRecords(records: Array<Record<string, JsonValue> | null>): Record<string, JsonValue>[] {
  return records.filter((record, index): record is Record<string, JsonValue> => (
    Boolean(record) && records.indexOf(record) === index
  ))
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

function recordString(record: Record<string, JsonValue>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return null
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function sumKnown(...values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value != null)
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null
}

function formatPercent(value: number): string {
  const bounded = Math.max(0, value)
  return bounded < 10 && bounded % 1 !== 0 ? bounded.toFixed(1) : String(Math.round(bounded))
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}
