import type { Event, Health } from '../shared/types'
import { isImportedHistoryRecord, isImportedProviderControlMetadata } from '../shared/provider-origin'
import { isNativeSteerTransitionStop } from '../shared/semantic-timeline'

interface ActivityFact { revision: number; seq: number; runId: string; active: boolean }
export interface ActivityHealthRequest { scope: string; revision: number; order: number }

/** Local ordering only. No clock, provider request, polling, or durable state. */
export class ActivityHealthProjection {
  private scope = ''
  private revision = 0
  private requestOrder = 0
  private acceptedOrder = 0
  private facts = new Map<string, ActivityFact>()
  private health: Health | null = null

  private enter(scope: string): void {
    if (scope === this.scope) return
    this.scope = scope
    this.revision = 0
    this.acceptedOrder = 0
    this.facts.clear()
    this.health = null
  }

  capture(scope: string): ActivityHealthRequest {
    this.enter(scope)
    return { scope, revision: this.revision, order: ++this.requestOrder }
  }

  accept(scope: string, incoming: Health, request?: ActivityHealthRequest): Health {
    this.enter(scope)
    const barrier = request?.scope === scope ? request : this.capture(scope)
    // Another authenticated response already superseded this request. Do not
    // restore an older boot or activity snapshot after a concurrent refresh.
    if (barrier.order < this.acceptedOrder && this.health) return this.health
    const instanceChanged = this.health !== null
      && this.health.server_instance_id !== incoming.server_instance_id
    if (instanceChanged) this.facts.clear()
    const active = new Set(incoming.active ?? incoming.active_sessions ?? [])
    for (const [sessionId, fact] of this.facts) {
      const incomingOwner = incoming.active_runs?.find(row => row.session_id === sessionId)?.run_id
      if (fact.revision > barrier.revision) {
        if (fact.active) active.add(sessionId)
        else active.delete(sessionId)
      } else if (!fact.active || !active.has(sessionId)
        || (typeof incomingOwner === 'string' && incomingOwner !== fact.runId)) {
        // A genuinely newer idle health response can settle a missing terminal.
        this.facts.delete(sessionId)
      }
    }
    this.acceptedOrder = barrier.order
    this.health = withActivity(incoming, active, this.facts)
    return this.health
  }

  observe(scope: string, event: Event): Health | null {
    this.enter(scope)
    if (isImportedHistoryRecord(event) || isImportedProviderControlMetadata(event)
      || isNativeSteerTransitionStop(event)) return this.health
    const active = event.type === 'turn_started'
    // Error/progress notices do not release a server turn slot. Its explicit
    // finished/stopped edge (or a fresh health response) owns that transition.
    if (!active && !['turn_finished', 'turn_stopped'].includes(event.type)) return this.health
    const runId = event.run_id?.trim() ?? ''
    if (!runId || !event.session_id || !Number.isSafeInteger(event.seq)) return this.health
    const previous = this.facts.get(event.session_id)
    const healthOwner = this.health?.active_runs?.find(row => row.session_id === event.session_id)?.run_id
    if (!active && typeof healthOwner === 'string' && healthOwner && runId !== healthOwner) return this.health
    if (previous && (event.seq <= previous.seq || (!active && previous.active && runId !== previous.runId))) {
      return this.health
    }
    this.facts.set(event.session_id, { revision: ++this.revision, seq: event.seq, runId, active })
    if (this.health) {
      const ids = new Set(this.health.active ?? this.health.active_sessions ?? [])
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
