export function nextBoundedVisibleCount(
  current: number,
  total: number,
  initial: number,
  pageSize = initial,
): number {
  const safeTotal = nonNegativeInteger(total)
  const safeInitial = Math.min(safeTotal, Math.max(1, nonNegativeInteger(initial)))
  const safePageSize = Math.max(1, nonNegativeInteger(pageSize))
  const safeCurrent = Math.min(safeTotal, Math.max(safeInitial, nonNegativeInteger(current)))
  if (safeCurrent >= safeTotal) return safeInitial
  return Math.min(safeTotal, safeCurrent + safePageSize)
}

export function reconcileCurrentMediaId(
  fileIds: readonly string[],
  currentId: string | null,
  initialId: string,
): string | null {
  if (currentId && fileIds.includes(currentId)) return currentId
  if (fileIds.includes(initialId)) return initialId
  return fileIds[0] ?? null
}

export interface MediaClaimOwner {
  ownerKey: string
  candidates: readonly string[]
}

/** Allocate one unique, bounded native-media budget across mounted rows. */
export function boundedMediaClaimsForOwner(
  owners: readonly MediaClaimOwner[],
  requestedOwnerKey: string,
  limit: number,
): string[] {
  const safeLimit = nonNegativeInteger(limit)
  if (safeLimit === 0) return []
  const seen = new Set<string>()
  const requestedClaims: string[] = []
  for (const owner of owners) {
    for (const id of owner.candidates) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      if (owner.ownerKey === requestedOwnerKey) requestedClaims.push(id)
      if (seen.size >= safeLimit) return requestedClaims
    }
  }
  return requestedClaims
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}
