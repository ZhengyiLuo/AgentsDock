export function timelineCacheHasGap(cachedVisible: number, incomingVisible: number, authoritativeTotal?: number | null, oldestCachedSeq?: number | null): boolean {
  if (authoritativeTotal == null || authoritativeTotal < 0) return false
  if (authoritativeTotal <= cachedVisible + incomingVisible) return false
  // A partial tail beginning after sequence one remains pageable. Sequence one
  // plus a much newer tail cannot be paged because `before=1` skips the gap.
  return oldestCachedSeq == null || oldestCachedSeq <= 1
}
