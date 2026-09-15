import type { Event, Health } from '../types'
import { isImportedHistoryRecord, isImportedProviderControlMetadata } from './provider-origin'
import { isNativeSteerSupersession } from './timeline'

interface ActivityFact { revision: number; seq: number; runId: string; active: boolean }
export interface ActivityHealthRequest { scope: string; revision: number; order: number }

/** Desktop's per-chat run ownership and request ordering; no timers or I/O. */
export class ActivityHealthProjection {
  private scope = ''
  private revision = 0
  private requestOrder = 0
  private acceptedOrder = 0
  private facts = new Map<string, ActivityFact>()
  private admissions = new Map<string, { revision: number; active: boolean }>()
  private health: Health | null = null

  private enter(scope: string): void {
    if (scope === this.scope) return
    this.scope = scope
    this.revision = 0
    this.acceptedOrder = 0
    this.facts.clear()
    this.admissions.clear()
    this.health = null
  }

  capture(scope: string): ActivityHealthRequest {
    this.enter(scope)
    return { scope, revision: this.revision, order: ++this.requestOrder }
  }

  initialize(scope: string, health: Health | null): void {
    this.enter(scope)
    if (this.health && health && this.health.server_instance_id !== health.server_instance_id) {
      this.facts.clear()
      this.admissions.clear()
      this.health = health
    }
    this.health ??= health
  }

  accept(scope: string, incoming: Health, request?: ActivityHealthRequest): Health {
    this.enter(scope)
    const barrier = request?.scope === scope ? request : this.capture(scope)
    if (barrier.order < this.acceptedOrder && this.health) return this.health
    if (this.health && this.health.server_instance_id !== incoming.server_instance_id) {
      this.facts.clear()
      this.admissions.clear()
    }
    const active = new Set([...(incoming.active ?? []), ...(incoming.active_sessions ?? [])])
    for (const [sessionId, fact] of this.facts) {
      const incomingOwner = incoming.active_runs?.find(row => row.session_id === sessionId)?.run_id
      if (fact.revision > barrier.revision) {
        if (fact.active) active.add(sessionId)
        else active.delete(sessionId)
      } else if (!fact.active || !active.has(sessionId)
        || (typeof incomingOwner === 'string' && incomingOwner !== fact.runId)) {
        this.facts.delete(sessionId)
      }
    }
    for (const [sessionId, admission] of this.admissions) {
      if (admission.revision > barrier.revision) {
        if (admission.active) active.add(sessionId)
        else active.delete(sessionId)
      }
      else this.admissions.delete(sessionId)
    }
    this.acceptedOrder = barrier.order
    this.health = withActivity(incoming, active, this.facts)
    return this.health
  }

  /** Accepted force-send can precede its start event. A newer poll may settle it. */
  admit(scope: string, sessionId: string): Health | null {
    this.enter(scope)
    this.admissions.set(sessionId, { revision: ++this.revision, active: true })
    if (this.health) {
      const active = new Set([...(this.health.active ?? []), ...(this.health.active_sessions ?? []), sessionId])
      this.health = withActivity(this.health, active, this.facts)
    }
    return this.health
  }

  confirmStopped(scope: string, sessionId: string, request: ActivityHealthRequest, owner: string | null | undefined): boolean {
    this.enter(scope)
    if (request.scope !== scope || (this.facts.get(sessionId)?.revision ?? 0) > request.revision
      || (this.admissions.get(sessionId)?.revision ?? 0) > request.revision
      || this.runId(sessionId) !== owner) return false
    const previous = this.facts.get(sessionId)
    if (previous) this.facts.set(sessionId, { ...previous, active: false, revision: ++this.revision })
    this.admissions.set(sessionId, { revision: ++this.revision, active: false })
    if (this.health) {
      const active = new Set([...(this.health.active ?? []), ...(this.health.active_sessions ?? [])])
      active.delete(sessionId)
      this.health = withActivity(this.health, active, this.facts)
    }
    return true
  }

  observe(scope: string, event: Event): Health | null {
    this.enter(scope)
    if (isImportedHistoryRecord(event) || isImportedProviderControlMetadata(event)
      || isNativeSteerSupersession(event)) return this.health
    const active = event.type === 'turn_started'
    if (!active && !['turn_finished', 'turn_stopped'].includes(event.type)) return this.health
    const runId = event.run_id?.trim() ?? ''
    if (!runId || !event.session_id || !Number.isSafeInteger(event.seq)) return this.health
    const previous = this.facts.get(event.session_id)
    const healthOwner = this.health?.active_runs?.find(row => row.session_id === event.session_id)?.run_id
    if (!active && typeof healthOwner === 'string' && healthOwner && runId !== healthOwner) return this.health
    if (previous && (event.seq <= previous.seq || (!active && previous.active && runId !== previous.runId))) return this.health
    this.admissions.delete(event.session_id)
    this.facts.set(event.session_id, { revision: ++this.revision, seq: event.seq, runId, active })
    if (this.health) {
      const ids = new Set([...(this.health.active ?? []), ...(this.health.active_sessions ?? [])])
      if (active) ids.add(event.session_id)
      else ids.delete(event.session_id)
      this.health = withActivity(this.health, ids, this.facts)
    }
    return this.health
  }

  runId(sessionId: string): string | null | undefined {
    const fact = this.facts.get(sessionId)
    if (fact) return fact.active ? fact.runId : null
    const owner = this.health?.active_runs?.find(row => row.session_id === sessionId)?.run_id
    return typeof owner === 'string' ? owner : undefined
  }
}

function withActivity(health: Health, active: Set<string>, facts: Map<string, ActivityFact>): Health {
  const previous = health.active ?? health.active_sessions ?? []
  let runs = health.active_runs
  if (runs) {
    runs = runs.filter(row => typeof row.session_id === 'string' && active.has(row.session_id)
      && (!facts.get(row.session_id)?.active || facts.get(row.session_id)?.runId === row.run_id))
    for (const [sessionId, fact] of facts) {
      if (fact.active && active.has(sessionId) && !runs.some(row => row.session_id === sessionId)) {
        runs.push({ session_id: sessionId, run_id: fact.runId })
      }
    }
    if (JSON.stringify(runs) === JSON.stringify(health.active_runs)) runs = health.active_runs
  }
  if (runs === health.active_runs && previous.length === active.size && previous.every(id => active.has(id))) return health
  const ids = [...active]
  return { ...health, active: ids, ...(health.active_sessions ? { active_sessions: ids } : {}),
    ...(runs ? { active_runs: runs } : {}) }
}
