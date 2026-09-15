import type { Event, QueuedTurn } from '../types'
import { isNativeGoalSteerEvent } from './native-goal-steering'

const MAX_OWNERS = 256
const MAX_FILES = 256
type Owner = { files: string[] | null; seq: number; terminal: boolean }

/** File IDs only. The caller must create a fresh instance for each validated server scope. */
export class NativeGoalFileAssociation {
  private readonly owners = new Map<string, Owner>()
  private readonly acknowledgements = new Map<string, string[]>()

  /** A guarded current queue read may seed ownership; absence cannot prove cancellation. */
  rememberSnapshot(sessionId: string, turns: readonly QueuedTurn[], afterSeq = -1): void {
    if (!identifier(sessionId)) return
    for (const turn of turns) {
      if (turn.session_id != null && turn.session_id !== sessionId) continue
      const key = ownerKey(sessionId, turn.queued_id)
      if (!key || this.owners.get(key)?.terminal) continue
      const files = validFiles(turn.file_ids)
      if (files) {
        const previous = this.owners.get(key)
        const unchanged = previous?.files?.length === files.length && previous.files.every((id, index) => id === files[index])
        const floor = Number.isFinite(afterSeq) ? afterSeq : -1
        this.putOwner(key, { files, seq: unchanged ? previous!.seq : Math.max(previous?.seq ?? -1, floor), terminal: false })
      }
    }
  }

  /** An explicitly accepted Remove is different from an ambiguous empty queue read. */
  forget(sessionId: string, queuedId: string): void {
    const key = ownerKey(sessionId, queuedId)
    if (key) this.putOwner(key, { files: null, seq: Infinity, terminal: true })
  }

  /** Freeze pre-request proof for a forward delta, not a historical page. */
  captureAcknowledgementRead(): (event: Event) => Event {
    const captured = new Map(this.owners)
    return event => {
      const key = ownerKey(event.session_id, event.queued_id)
      const previous = key ? captured.get(key) : undefined
      const current = key ? this.owners.get(key) : undefined
      if (!isNativeGoalSteerEvent(event) || event.imported === true
        || !previous?.files || previous.terminal || !current?.files || current.terminal
        || previous.seq !== current.seq || previous.files.length !== current.files.length
        || !previous.files.every((id, index) => id === current.files![index])) return event
      return this.observe(event)
    }
  }

  /** Current live/admission packets only: never enrich historical events from a live queue. */
  observe(event: Event): Event {
    if (event.imported === true) return event
    const key = ownerKey(event.session_id, event.queued_id)
    if (!key || !Number.isFinite(event.seq) || event.seq < 0) return event
    const owner = this.owners.get(key)
    if (isNativeGoalSteerEvent(event)) {
      const receiptKey = identifier(event.id) && identifier(event.run_id)
        ? JSON.stringify([event.session_id, event.queued_id, event.run_id, event.id, event.seq]) : null
      if (event.display_file_ids != null) {
        const files = validFiles(event.display_file_ids) ?? []
        if (!owner || !owner.terminal && event.seq > owner.seq) this.putOwner(key, { files: null, seq: event.seq, terminal: true })
        if (receiptKey) this.rememberAcknowledgement(receiptKey, files)
        return { ...event, file_ids: [...files] }
      }
      const replayFiles = receiptKey ? this.acknowledgements.get(receiptKey) : undefined
      if (replayFiles) return { ...event, file_ids: [...replayFiles], display_file_ids: [...replayFiles] }
      // A stale acknowledgement cannot consume a newer queue edit. An exact
      // duplicate is served only from its own immutable receipt above.
      if (owner && (owner.terminal || event.seq <= owner.seq)) return event
      const files = owner?.files
      this.putOwner(key, { files: null, seq: event.seq, terminal: true })
      if (!files) return event
      if (receiptKey) this.rememberAcknowledgement(receiptKey, files)
      return { ...event, file_ids: [...files], display_file_ids: [...files] }
    }
    if (owner && (owner.terminal || event.seq <= owner.seq)) return event
    if (event.type === 'turn_unqueued' || event.type === 'turn_started') {
      this.putOwner(key, { files: null, seq: event.seq, terminal: true })
    } else if (event.type === 'turn_queued' || event.type === 'turn_queue_updated' && (event.display_file_ids != null || event.file_ids != null)) {
      this.putOwner(key, { files: validFiles(event.display_file_ids ?? event.file_ids ?? []), seq: event.seq, terminal: false })
    }
    // In particular, run-now and a later empty HTTP queue do not discard the
    // owner before the durable native acknowledgement has been observed.
    return event
  }

  private putOwner(key: string, owner: Owner): void {
    this.owners.delete(key)
    this.owners.set(key, owner)
    if (this.owners.size > MAX_OWNERS) this.owners.delete(this.owners.keys().next().value!)
  }

  private rememberAcknowledgement(key: string, files: string[]): void {
    this.acknowledgements.set(key, [...files])
    if (this.acknowledgements.size > MAX_OWNERS) this.acknowledgements.delete(this.acknowledgements.keys().next().value!)
  }
}

/** Retain an already-proven acknowledgement through exact HTTP/history replay only. */
export function retainNativeGoalAcknowledgementFiles(previous: Event, incoming: Event): Event {
  if (previous.imported === true || incoming.imported === true
    || !isNativeGoalSteerEvent(previous) || !isNativeGoalSteerEvent(incoming)
    || !identifier(previous.id) || !ownerKey(previous.session_id, previous.queued_id)
    || previous.id !== incoming.id || previous.session_id !== incoming.session_id
    || previous.seq !== incoming.seq || previous.queued_id !== incoming.queued_id
    || previous.run_id !== incoming.run_id || previous.prompt !== incoming.prompt) return incoming
  if (incoming.display_file_ids != null) return { ...incoming, file_ids: validFiles(incoming.display_file_ids) ?? [] }
  if (previous.display_file_ids != null) {
    const files = validFiles(previous.display_file_ids) ?? []
    return { ...incoming, file_ids: [...files], display_file_ids: [...files] }
  }
  if (incoming.file_ids != null && (!Array.isArray(incoming.file_ids) || incoming.file_ids.length > 0)) return incoming
  const files = validFiles(previous.file_ids)
  return files?.length ? { ...incoming, file_ids: files } : incoming
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
}

function ownerKey(sessionId: unknown, queuedId: unknown): string | null {
  return identifier(sessionId) && identifier(queuedId) ? JSON.stringify([sessionId, queuedId]) : null
}

function validFiles(value: unknown): string[] | null {
  return Array.isArray(value) && value.length <= MAX_FILES && value.every(identifier) ? [...value] : null
}
