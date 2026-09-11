import type { Session } from '../types'

export const SESSION_MUTATION_FIELDS = [
  'title',
  'folder',
  'cwd',
  'backend',
  'model',
  'effort',
  'system_prompt',
  'codex_approval_policy',
  'codex_sandbox_mode',
  'codex_permission_profile',
  'codex_approvals_reviewer',
  'claude_permission_mode',
  'cursor_permission_mode',
  'provider_jobs_access',
  'pinned',
  'archived',
] as const

export type SessionMutationField = typeof SESSION_MUTATION_FIELDS[number]
export type SessionMutationPatch = Partial<Pick<Session, SessionMutationField>>

export interface SessionMutationToken {
  generation: number
  sessionId: string
  revision: number
  fields: SessionMutationField[]
}

export interface SessionReadToken {
  generation: number
  revision: number
}

interface FieldMutation {
  revision: number
  requested: Session[SessionMutationField]
  status: 'pending' | 'succeeded' | 'failed'
  serverValue?: Session[SessionMutationField]
  serverUpdatedAt?: string | null
}

interface FieldHistory {
  baseValue: Session[SessionMutationField]
  mutations: FieldMutation[]
}

interface ConfirmedField {
  revision: number
  value: Session[SessionMutationField]
  serverUpdatedAt?: string | null
  createdAt: number
  staleObservations: number
}

interface SessionHistory {
  latestRevision: number
  fields: Map<SessionMutationField, FieldHistory>
  confirmed: Map<SessionMutationField, ConfirmedField>
}

const CONFIRMED_FIELD_TTL_MS = 2 * 60 * 1000
const MAX_STALE_OBSERVATIONS = 3
const MAX_CONFIRMED_FIELDS = 256

/**
 * Reconciles optimistic PATCH responses and full-session reads. A list or
 * timeline request captures a read token before going to the network; fields
 * changed after that point remain overlaid even when the PATCH has already
 * completed. Confirmed overlays retire when the server echoes the value, when
 * a strictly newer server timestamp proves another edit won, or after a small
 * bounded grace window for servers that do not provide usable timestamps.
 */
export class SessionMutationReconciler {
  private generation = 1
  private nextRevision = 0
  private histories = new Map<string, SessionHistory>()

  captureRead(): SessionReadToken {
    return { generation: this.generation, revision: this.nextRevision }
  }

  begin(session: Session, patch: SessionMutationPatch): SessionMutationToken {
    const revision = ++this.nextRevision
    const fields = SESSION_MUTATION_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(patch, field))
    let history = this.histories.get(session.id)
    if (!history) {
      history = { latestRevision: revision, fields: new Map(), confirmed: new Map() }
      this.histories.set(session.id, history)
    }
    history.latestRevision = revision
    for (const field of fields) {
      let fieldHistory = history.fields.get(field)
      if (!fieldHistory) {
        fieldHistory = { baseValue: session[field], mutations: [] }
        history.fields.set(field, fieldHistory)
      }
      fieldHistory.mutations.push({ revision, requested: patch[field], status: 'pending' })
    }
    return { generation: this.generation, sessionId: session.id, revision, fields }
  }

  succeed(current: Session, updated: Session, token: SessionMutationToken): Session {
    if (token.generation !== this.generation) return current
    const history = this.histories.get(token.sessionId)
    if (!history) return current
    // Only the newest request may contribute non-editable server metadata.
    // Editable fields are always reconciled independently below.
    const result: Session = token.revision === history.latestRevision ? { ...updated } : { ...current }
    for (const field of SESSION_MUTATION_FIELDS) copySessionField(result, current, field)
    this.settleFields(result, token, 'succeeded', updated)
    this.compact(token.sessionId)
    return result
  }

  fail(current: Session, token: SessionMutationToken): Session {
    if (token.generation !== this.generation) return current
    const history = this.histories.get(token.sessionId)
    if (!history) return current
    const result = { ...current }
    this.settleFields(result, token, 'failed')
    this.compact(token.sessionId)
    return result
  }

  /** Merge a full-session response without reviving fields from a stale read. */
  reconcileIncoming(current: Session, incoming: Session, read: SessionReadToken): Session {
    if (read.generation !== this.generation || current.id !== incoming.id) return current
    const history = this.histories.get(current.id)
    if (!history) return mergeSession(current, incoming)

    const result = { ...current, ...incoming }
    const incomingUpdatedAt = timestamp(incoming.updated_at)
    for (const field of SESSION_MUTATION_FIELDS) {
      const fieldHistory = history.fields.get(field)
      if (fieldHistory) {
        // Pending local intent always wins until its PATCH settles. This also
        // covers an older successful mutation waiting behind a newer request.
        setSessionField(result, field, resolvedFieldValue(fieldHistory))
        continue
      }

      const confirmed = history.confirmed.get(field)
      if (!confirmed) continue
      if (read.revision < confirmed.revision) {
        // The read began before this write, so its field can never supersede it.
        setSessionField(result, field, confirmed.value)
        continue
      }
      if (Object.is(incoming[field], confirmed.value)) {
        history.confirmed.delete(field)
        continue
      }

      const confirmedUpdatedAt = timestamp(confirmed.serverUpdatedAt)
      if (
        confirmedUpdatedAt !== null
        && incomingUpdatedAt !== null
        && incomingUpdatedAt > confirmedUpdatedAt
      ) {
        // A strictly newer durable server record is a genuine subsequent edit.
        history.confirmed.delete(field)
        continue
      }

      const expired = Date.now() - confirmed.createdAt >= CONFIRMED_FIELD_TTL_MS
      if (expired || confirmed.staleObservations >= MAX_STALE_OBSERVATIONS) {
        // Missing/equal timestamps cannot establish ordering. Fail open after
        // a bounded grace period instead of retaining an immortal local value.
        history.confirmed.delete(field)
        continue
      }
      confirmed.staleObservations += 1
      setSessionField(result, field, confirmed.value)
    }
    this.deleteEmptyHistory(current.id)
    return sameSession(current, result) ? current : result
  }

  abandon(token: SessionMutationToken): void {
    if (token.generation !== this.generation) return
    // Remove only this token: a new profile may already be editing the same
    // chat ID, and revisions deliberately remain monotonic across clear().
    const history = this.histories.get(token.sessionId)
    if (!history) return
    for (const field of token.fields) {
      const fieldHistory = history.fields.get(field)
      if (!fieldHistory) continue
      fieldHistory.mutations = fieldHistory.mutations.filter(mutation => mutation.revision !== token.revision)
      if (!fieldHistory.mutations.length) history.fields.delete(field)
    }
    this.compact(token.sessionId)
  }

  clear(): void {
    this.generation += 1
    this.histories.clear()
  }

  private settleFields(
    result: Session,
    token: SessionMutationToken,
    status: 'succeeded' | 'failed',
    updated?: Session,
  ): void {
    const history = this.histories.get(token.sessionId)
    if (!history) return
    for (const field of token.fields) {
      const fieldHistory = history.fields.get(field)
      const mutation = fieldHistory?.mutations.find(candidate => candidate.revision === token.revision)
      if (!fieldHistory || !mutation || mutation.status !== 'pending') continue
      mutation.status = status
      if (status === 'succeeded' && updated) {
        mutation.serverValue = updated[field]
        mutation.serverUpdatedAt = updated.updated_at
      }
      setSessionField(result, field, resolvedFieldValue(fieldHistory))
    }
  }

  private compact(sessionId: string): void {
    const history = this.histories.get(sessionId)
    if (!history) return
    for (const [field, fieldHistory] of history.fields) {
      if (fieldHistory.mutations.some(mutation => mutation.status === 'pending')) continue
      const accepted = latestAcceptedMutation(fieldHistory)
      if (accepted) {
        history.confirmed.set(field, {
          revision: accepted.revision,
          value: accepted.serverValue,
          serverUpdatedAt: accepted.serverUpdatedAt,
          createdAt: Date.now(),
          staleObservations: 0,
        })
      }
      history.fields.delete(field)
    }
    this.deleteEmptyHistory(sessionId)
    this.pruneConfirmedFields()
  }

  private deleteEmptyHistory(sessionId: string): void {
    const history = this.histories.get(sessionId)
    if (history && !history.fields.size && !history.confirmed.size) this.histories.delete(sessionId)
  }

  private pruneConfirmedFields(): void {
    let confirmedCount = 0
    const confirmed: Array<{ sessionId: string; field: SessionMutationField; revision: number }> = []
    for (const [sessionId, history] of this.histories) {
      for (const [field, value] of history.confirmed) {
        confirmedCount += 1
        confirmed.push({ sessionId, field, revision: value.revision })
      }
    }
    if (confirmedCount <= MAX_CONFIRMED_FIELDS) return
    confirmed.sort((left, right) => left.revision - right.revision)
    for (const value of confirmed.slice(0, confirmedCount - MAX_CONFIRMED_FIELDS)) {
      this.histories.get(value.sessionId)?.confirmed.delete(value.field)
      this.deleteEmptyHistory(value.sessionId)
    }
  }
}

function latestAcceptedMutation(history: FieldHistory): FieldMutation | null {
  for (let index = history.mutations.length - 1; index >= 0; index -= 1) {
    const mutation = history.mutations[index]!
    if (mutation.status === 'succeeded') return mutation
  }
  return null
}

function resolvedFieldValue(history: FieldHistory): Session[SessionMutationField] {
  for (let index = history.mutations.length - 1; index >= 0; index -= 1) {
    const mutation = history.mutations[index]!
    if (mutation.status === 'failed') continue
    return mutation.status === 'succeeded' ? mutation.serverValue : mutation.requested
  }
  return history.baseValue
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function mergeSession(current: Session, incoming: Session): Session {
  const result = { ...current, ...incoming }
  return sameSession(current, result) ? current : result
}

function sameSession(left: Session, right: Session): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].every(key => left[key as keyof Session] === right[key as keyof Session])
}

function copySessionField(target: Session, source: Session, field: SessionMutationField): void {
  setSessionField(target, field, source[field])
}

function setSessionField(target: Session, field: SessionMutationField, value: Session[SessionMutationField]): void {
  // TypeScript cannot correlate a computed union key with its corresponding
  // value union, but both are constrained by SessionMutationField above.
  ;(target as unknown as Record<SessionMutationField, Session[SessionMutationField]>)[field] = value
}
