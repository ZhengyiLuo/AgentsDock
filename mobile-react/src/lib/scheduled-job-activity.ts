import type { Event, Health, Job, RuntimeCatalog, Session } from '../types'
import { runtimeSelectionError } from './runtime-catalog'

export function activeSessionRunId(health: Health | null, sessionId: string): string | null {
  const value = health?.active_runs?.find(run => run.session_id === sessionId)?.run_id
  return typeof value === 'string' ? value.trim() || null : null
}

/** A Stop control requires the exact server-reported active execution. */
export function activeScheduledJobId(events: readonly Event[], activeRunId: string | null): string | null {
  if (!activeRunId?.trim()) return null
  let latest: { id: string; order: number; running: boolean } | null = null
  for (const event of events) {
    if (![event.run_id, event.job_status_run_id, event.job_latest_status_run_id, event.job_latest_run_id].some(id => id?.trim() === activeRunId)) continue
    const id = String(event.job_id || event.job?.id || '').trim(), running = jobEventRunningState(event)
    if (!id || running == null) continue
    const order = jobEventOrder(event)
    if (!latest || order >= latest.order) latest = { id, order, running }
  }
  return latest?.running ? latest.id : null
}

export function currentRunningJobIds(events: readonly Event[], sessionActive: boolean, activeRunId: string | null = null): Set<string> {
  if (!sessionActive) return new Set()
  if (activeRunId) {
    const id = activeScheduledJobId(events, activeRunId)
    return new Set(id ? [id] : [])
  }
  const latest = new Map<string, { order: number; running: boolean }>()
  for (const event of events) {
    const id = String(event.job_id || event.job?.id || '').trim(), running = jobEventRunningState(event)
    if (!id || running == null) continue
    const order = jobEventOrder(event), prior = latest.get(id)
    if (!prior || order >= prior.order) latest.set(id, { order, running })
  }
  return new Set([...latest].filter(([, state]) => state.running).map(([id]) => id))
}

export function scheduledJobRuntimeError(job: Job, session: Pick<Session, 'backend' | 'model'>, health: Health | null, catalog: RuntimeCatalog | null): string | null {
  const backend = job.context_mode === 'standalone' ? job.backend ?? session.backend : session.backend
  return runtimeSelectionError(health, catalog, backend, backend === session.backend ? session.model : null)
}

function jobEventOrder(event: Event): number {
  return Math.max(...[event.seq, event.job_status_seq, event.job_latest_status_seq, event.job_run_status_seq].map(value => Number.isFinite(value) ? Number(value) : 0))
}

function jobEventRunningState(event: Event): boolean | null {
  const status = String(event.job_status || event.job_latest_status || event.job_run_status || '').trim().toLowerCase()
  if (['running', 'started', 'active', 'in_progress'].includes(status)) return true
  if (['completed', 'complete', 'succeeded', 'success', 'done', 'failed', 'error', 'stopped', 'cancelled', 'canceled', 'deferred', 'queued'].includes(status)) return false
  if (event.is_error || event.stopped || ['job_finished', 'job_error', 'job_deferred', 'turn_finished', 'turn_stopped'].includes(event.type)) return false
  if (['job_ran', 'job_started', 'turn_started'].includes(event.type)) return true
  return null
}
