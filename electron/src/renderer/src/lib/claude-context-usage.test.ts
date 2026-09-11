import { describe, expect, it } from 'vitest'
import {
  formatClaudeContextUsageDetail,
  formatContextPercent,
  parseClaudeContextUsage
} from './claude-context-usage'

describe('Claude context usage', () => {
  it('reads the authoritative Claude SDK context response', () => {
    const usage = parseClaudeContextUsage({
      context_usage: {
        totalTokens: 66_000,
        maxTokens: 100_000,
        rawMaxTokens: 200_000,
        percentage: 66,
        model: 'claude-opus-4-1'
      },
      provider_session_id: 'claude-session',
      usage_generation: 7,
      snapshot_at: '2026-08-05T12:00:00Z'
    })

    expect(usage).toEqual({
      contextTokens: 66_000,
      effectiveContextWindow: 100_000,
      rawContextWindow: 200_000,
      contextPercent: 66,
      model: 'claude-opus-4-1',
      providerSessionId: 'claude-session',
      snapshotAt: '2026-08-05T12:00:00Z',
      usageGeneration: 7
    })
    expect(formatContextPercent(usage?.contextPercent ?? null)).toBe('66%')
    expect(formatClaudeContextUsageDetail(usage)).toContain('66k / 100k usable tokens')
  })

  it('calculates and clamps percentage when the SDK omits it', () => {
    expect(parseClaudeContextUsage({ total_tokens: 25, max_tokens: 100 })?.contextPercent).toBe(25)
    expect(parseClaudeContextUsage({ total_tokens: 120, max_tokens: 100 })?.contextPercent).toBe(100)
  })

  it('returns no usage for fallback runtimes without context data', () => {
    expect(parseClaudeContextUsage(null)).toBeNull()
    expect(parseClaudeContextUsage({ model: 'claude' })).toBeNull()
  })
})
