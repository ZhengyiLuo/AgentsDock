import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import {
  formatContextUsage,
  latestCodexContextUsage,
  parseCodexContextUsage
} from './codex-token-usage'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `event-${seq}`,
  session_id: 'chat',
  seq,
  type,
  ts: `2026-07-31T12:00:${String(seq).padStart(2, '0')}Z`,
  ...patch
})

describe('Codex context usage', () => {
  it('reads the native Codex app-server token usage shape', () => {
    const usage = parseCodexContextUsage({
      total: {
        totalTokens: 7_300_000,
        inputTokens: 7_000_000,
        cachedInputTokens: 6_600_000,
        cacheWriteInputTokens: 1_024,
        outputTokens: 300_000,
        reasoningOutputTokens: 100_000
      },
      last: {
        totalTokens: 237_118,
        inputTokens: 236_644,
        cachedInputTokens: 228_000,
        cacheWriteInputTokens: 512,
        outputTokens: 474,
        reasoningOutputTokens: 192
      },
      modelContextWindow: 258_400
    })

    expect(usage).toMatchObject({
      contextTokens: 237_118,
      contextWindow: 258_400,
      inputTokens: 236_644,
      cachedInputTokens: 228_000,
      cacheWriteInputTokens: 512,
      outputTokens: 474,
      reasoningOutputTokens: 192,
      totalTokens: 7_300_000
    })
    expect(usage).toMatchObject({
      baselineTokens: 12_000,
      effectiveContextWindow: 246_400
    })
    expect(formatContextUsage(usage)).toBe('91%')
  })

  it('prefers normalized durable fields and retains latest-turn attribution', () => {
    const usage = latestCodexContextUsage([
      event(1, 'codex_token_usage', {
        run_id: 'run-one',
        turn_id: 'turn-one',
        input_tokens: 10_000,
        cached_input_tokens: 8_000,
        output_tokens: 500,
        total_tokens: 10_500,
        cumulative_total_tokens: 72_000,
        context_tokens: 10_500,
        context_window: 100_000
      }),
      event(2, 'tool_finished', { run_id: 'run-two' }),
      event(3, 'codex_token_usage', {
        run_id: 'run-two',
        turn_id: 'turn-two',
        input_tokens: 80_000,
        output_tokens: 1_000,
        total_tokens: 81_000,
        cumulative_total_tokens: 172_000,
        context_tokens: 81_000,
        context_window: 100_000,
        context_percent: 81
      })
    ])

    expect(usage).toMatchObject({
      contextTokens: 81_000,
      contextWindow: 100_000,
      contextPercent: 78.41,
      totalTokens: 172_000,
      runId: 'run-two',
      turnId: 'turn-two',
      seq: 3
    })
  })

  it('uses live metrics while preserving durable run metadata and handles post-compaction usage', () => {
    const events = [
      event(5, 'codex_token_usage', {
        run_id: 'run-before',
        context_tokens: 220_000,
        context_window: 258_400
      }),
      event(6, 'codex_compaction_completed', {
        run_id: 'run-compact',
        token_usage_after: {
          context_tokens: 25_514,
          context_window: 258_400,
          input_tokens: 25_000,
          output_tokens: 514
        }
      })
    ]
    const usage = latestCodexContextUsage(events, {
      last: { totalTokens: 26_000, inputTokens: 25_400, outputTokens: 600 },
      total: { totalTokens: 8_000_000 },
      modelContextWindow: 258_400
    })

    expect(usage).toMatchObject({
      contextTokens: 26_000,
      contextWindow: 258_400,
      inputTokens: 25_400,
      outputTokens: 600,
      totalTokens: 8_000_000,
      runId: 'run-compact',
      seq: 6
    })
    expect(formatContextUsage(usage)).toBe('5.7%')
  })

  it('does not resurrect stale durable usage after the current runtime clears it', () => {
    const events = [event(4, 'codex_compaction_completed', {
      thread_id: 'old-thread',
      token_usage_after: {
        thread_id: 'old-thread',
        context_tokens: 210_000,
        context_window: 258_400
      }
    })]

    expect(latestCodexContextUsage(events, null, 'new-thread')).toBeNull()
    expect(latestCodexContextUsage(events, undefined, 'new-thread')).toBeNull()
  })

  it('accepts threadless live data from the selected runtime but rejects a mismatched live thread', () => {
    const live = { last: { totalTokens: 112_000 }, modelContextWindow: 258_400 }
    expect(latestCodexContextUsage([], live, 'current-thread')?.contextTokens).toBe(112_000)
    expect(latestCodexContextUsage([], {
      ...live,
      thread_id: 'other-thread'
    }, 'current-thread')).toBeNull()
  })

  it('returns no usage for legacy servers without token data', () => {
    expect(latestCodexContextUsage([event(1, 'turn_finished')], null)).toBeNull()
    expect(formatContextUsage(null)).toBe('—')
  })
})
