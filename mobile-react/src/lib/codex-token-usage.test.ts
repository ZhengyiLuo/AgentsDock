import {
  formatCompactTokens,
  formatContextUsage,
  formatContextUsageDetail,
  latestCodexContextUsage,
  parseCodexContextUsage,
} from './codex-token-usage'
import type { Event } from '../types'

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message?: string): void {
  if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, received ${String(actual)}`)
}

function event(seq: number, type: string, patch: Partial<Event> = {}): Event {
  return { id: `event-${seq}`, session_id: 'chat', seq, type, ts: `2026-07-31T12:00:${String(seq).padStart(2, '0')}Z`, ...patch }
}

const native = parseCodexContextUsage({
  total: { totalTokens: 7_300_000 },
  last: {
    totalTokens: 237_118,
    inputTokens: 236_644,
    cachedInputTokens: 228_000,
    cacheWriteInputTokens: 512,
    outputTokens: 474,
    reasoningOutputTokens: 192,
  },
  modelContextWindow: 258_400,
})
assert(native)
equal(native.contextTokens, 237_118, 'context occupancy must use last.totalTokens')
equal(native.totalTokens, 7_300_000, 'session total must use cumulative total.totalTokens')
equal(native.cacheWriteInputTokens, 512)
equal(formatContextUsage(native), '92%')

const durable = latestCodexContextUsage([
  event(1, 'codex_token_usage', { run_id: 'old', context_tokens: 10_500, context_window: 100_000 }),
  event(2, 'tool_finished'),
  event(3, 'codex_token_usage', {
    run_id: 'latest',
    turn_id: 'turn-latest',
    input_tokens: 80_000,
    output_tokens: 1_000,
    context_tokens: 81_000,
    context_window: 100_000,
    context_percent: 81,
    cumulative_total_tokens: 172_000,
  }),
])
assert(durable)
equal(durable.contextTokens, 81_000)
equal(durable.totalTokens, 172_000)
equal(durable.runId, 'latest')
equal(durable.seq, 3)

const compacted = latestCodexContextUsage([
  event(5, 'codex_token_usage', { run_id: 'before', context_tokens: 220_000, context_window: 258_400 }),
  event(6, 'codex_compaction_completed', {
    run_id: 'compact',
    token_usage_after: {
      context_tokens: 25_514,
      context_window: 258_400,
      input_tokens: 25_000,
      output_tokens: 514,
    },
  }),
], {
  last: { totalTokens: 26_000, inputTokens: 25_400, outputTokens: 600 },
  total: { totalTokens: 8_000_000 },
  modelContextWindow: 258_400,
})
assert(compacted)
equal(compacted.contextTokens, 26_000, 'live metrics must win over durable metrics')
equal(compacted.runId, 'compact', 'durable attribution must survive a live merge')
equal(compacted.seq, 6)
equal(formatContextUsage(compacted), '10%')

equal(latestCodexContextUsage([
  event(7, 'codex_compaction_completed', {
    provider_session_id: 'thread-old',
    token_usage_after: {
      thread_id: 'thread-old',
      context_tokens: 90_000,
      context_window: 100_000,
    },
  }),
  event(8, 'provider_rollover', { provider_session_id: 'thread-old' }),
  event(9, 'user_prompt'),
], null, 'thread-new'), null, 'rollover must clear durable context fallback')

equal(latestCodexContextUsage([
  event(10, 'codex_compaction_completed', {
    provider_session_id: 'thread-old',
    token_usage_after: {
      thread_id: 'thread-old',
      context_tokens: 40_000,
      context_window: 100_000,
    },
  }),
], null, 'thread-fork'), null, 'copied fork history must not leak old-thread usage')

const currentThread = latestCodexContextUsage([
  event(11, 'codex_compaction_completed', {
    provider_session_id: 'thread-current',
    token_usage_after: {
      thread_id: 'thread-current',
      context_tokens: 30_000,
      context_window: 100_000,
    },
  }),
], null, 'thread-current')
assert(currentThread)
equal(currentThread.contextTokens, 30_000)

equal(latestCodexContextUsage([
  event(12, 'codex_token_usage', {
    provider_session_id: 'thread-current',
    context_tokens: 75_000,
    context_window: 100_000,
  }),
], null, 'thread-current', 'cleared'), null, 'an explicit provider reset must invalidate durable context immediately')
equal(latestCodexContextUsage([
  event(13, 'codex_token_usage', {
    provider_session_id: 'thread-current',
    context_tokens: 75_000,
    context_window: 100_000,
  }),
], null, 'thread-current', 'unavailable'), null, 'an unavailable live context must not resurrect stale durable occupancy')

const normalizedLive = latestCodexContextUsage([], {
  run_id: 'run-live',
  turn_id: 'turn-live',
  context_tokens: 51_000,
  context_window: 100_000,
  cumulative_total_tokens: 900_000,
})
assert(normalizedLive)
equal(normalizedLive.contextTokens, 51_000)
equal(normalizedLive.totalTokens, 900_000)
equal(normalizedLive.runId, 'run-live')
equal(formatContextUsage(normalizedLive), '51%')

equal(latestCodexContextUsage([event(1, 'turn_finished')], null), null)
equal(formatContextUsage(null), '—')
equal(formatContextUsageDetail(null), 'Context usage is not available yet.')
equal(formatCompactTokens(92_400), '92.4k')

console.log('Codex context usage helpers passed')
