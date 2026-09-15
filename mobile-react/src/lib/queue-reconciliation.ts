import type { Event } from '../types'
import { crossChatQueueRefreshSessionId, isNativeGoalSteerEvent } from './queue'
import { isImportedHistoryRecord, isImportedProviderControlMetadata } from './provider-origin'

/**
 * One session's queue observations within one validated connection/server scope.
 * The store owns that scope and must compare revision at the snapshot commit,
 * not merely when a request resolves. Timeline processing is independent.
 */
export class QueueReconciliationState {
  private currentRevision = 0
  private snapshotCoveredSeq: number | null = null

  get revision(): number { return this.currentRevision }
  get coveredSeq(): number | null { return this.snapshotCoveredSeq }

  /** False suppresses queue projection, not timeline ingestion or a confirming read. */
  observe(event: Event): boolean {
    if (!eventAffectsQueueObservation(event)) return true
    if (this.snapshotCoveredSeq !== null && Number.isFinite(event.seq)
      && event.seq <= this.snapshotCoveredSeq) return false
    // A drain for an absent ID still invalidates an older in-flight queue read.
    this.currentRevision += 1
    return true
  }

  /**
   * Only an explicitly sequenced page can advance the event high-water mark.
   * This is not an atomic server queue version: a covered queue signal may
   * still warrant a confirming read if its state was published separately.
   */
  commitSnapshot(latestSeq?: number | null): void {
    this.currentRevision += 1
    if (typeof latestSeq === 'number' && Number.isSafeInteger(latestSeq) && latestSeq >= 0) {
      this.snapshotCoveredSeq = Math.max(this.snapshotCoveredSeq ?? 0, latestSeq)
    }
  }
}

function eventAffectsQueueObservation(event: Event): boolean {
  if (isImportedHistoryRecord(event) || isImportedProviderControlMetadata(event)) return false
  // Empty membership still asks the store to reconcile a possibly stale queue.
  if (event.type === 'queue_snapshot' && Array.isArray(event.positions)) return true
  if (event.positions?.length) return true
  if (crossChatQueueRefreshSessionId(event)) return true
  if (event.type === 'turn_queue_paused') return Boolean(event.queued_id || event.queued_ids?.length)
  if (!event.queued_id) return false
  return event.type === 'turn_queued'
    || event.type === 'turn_queue_delivery_fenced'
    || event.type === 'turn_unqueued'
    || event.type === 'turn_started'
    || isNativeGoalSteerEvent(event)
    || event.type === 'turn_queue_run_now'
    || event.type === 'turn_queue_updated'
}
