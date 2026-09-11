import {
  formatClaudeContextUsageDetail,
  formatContextPercent,
  parseClaudeContextUsage,
} from './claude-context-usage'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

const usage = parseClaudeContextUsage({
  context_usage: {
    totalTokens: 66_000,
    maxTokens: 100_000,
    rawMaxTokens: 200_000,
    percentage: 66,
    model: 'claude-opus-4-1',
  },
  provider_session_id: 'claude-session',
  usage_generation: 7,
  snapshot_at: '2026-08-05T12:00:00Z',
})
assert(usage?.contextTokens === 66_000, 'must read nested camelCase token usage')
assert(usage.effectiveContextWindow === 100_000, 'must read the effective context window')
assert(usage.rawContextWindow === 200_000, 'must retain the raw model window')
assert(usage.contextPercent === 66, 'must use the explicit provider percentage')
assert(usage.providerSessionId === 'claude-session', 'must retain the provider-session fence')
assert(usage.usageGeneration === 7, 'must retain the usage generation')
assert(formatContextPercent(usage.contextPercent) === '66%', 'must format whole percentages compactly')
assert(formatClaudeContextUsageDetail(usage).includes('66k / 100k usable tokens'), 'must explain the effective window')
assert(parseClaudeContextUsage({ total_tokens: 25, max_tokens: 100 })?.contextPercent === 25, 'must calculate missing percentage')
assert(parseClaudeContextUsage({ total_tokens: 120, max_tokens: 100 })?.contextPercent === 100, 'must clamp percentage')
assert(parseClaudeContextUsage(null) === null, 'must tolerate an unavailable snapshot')
assert(parseClaudeContextUsage({ model: 'claude' }) === null, 'must reject incomplete snapshots')

console.log('Claude context usage tests passed')
