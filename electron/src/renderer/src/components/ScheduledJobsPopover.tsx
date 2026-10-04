// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import * as ContextMenu from '@radix-ui/react-context-menu'
import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import { Check, CirclePause, Clock3, LoaderCircle, Pause, Pencil, Play, Plus, Square, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Event as AgentEvent, Health, Job, ProviderJobsAccess, RuntimeCatalog, Session } from '@shared/types'
import { runtimeSelectionError } from '@shared/runtime-catalog'
import { trackEvent } from '../lib/analytics'
import { describeJobSchedule } from '../lib/job-schedule'
import { PROVIDER_JOBS_ACCESS_MODES, providerJobsAccessLabel, providerJobsAccessState } from '../lib/provider-jobs-access'
import { useAppStore } from '../store/app-store'

const EMPTY_EVENTS: AgentEvent[] = []

/**
 * Header popover that lists the chat's scheduled jobs, lets the user add a new
 * one (opening the existing job panel), and picks the per-chat agent access
 * mode applied to every scheduled job in this chat. Styled like the chat menu.
 */
export function ScheduledJobsPopover({ session }: { session: Session }) {
  useLocale()
  const allJobs = useAppStore(state => state.jobs)
  const health = useAppStore(state => state.health)
  const runtimeCatalog = useAppStore(state => state.runtimeCatalog)
  const events = useAppStore(state => state.snapshots[session.id]?.events ?? EMPTY_EVENTS)
  const sessionActive = useAppStore(state => state.activeSessionIds.has(session.id))
  const activeRunId = useAppStore(state => {
    const run = state.health?.active_runs?.find(candidate => candidate.session_id === session.id)
    return typeof run?.run_id === 'string' && run.run_id.trim() ? run.run_id.trim() : null
  })
  const jobs = useMemo(() => allJobs.filter(job => job.session_id === session.id), [allJobs, session.id])
  const stoppableJobId = useMemo(() => activeScheduledJobId(events, activeRunId), [activeRunId, events])
  const runningJobIds = useMemo(() => {
    if (activeRunId) return new Set(stoppableJobId ? [stoppableJobId] : [])
    return currentRunningJobIds(events, sessionActive)
  }, [activeRunId, events, sessionActive, stoppableJobId])
  const [open, setOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<Job | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const deleteRequest = useRef(0)

  useEffect(() => {
    deleteRequest.current += 1
    setDeleteCandidate(null)
    setDeleteError(null)
    setDeleting(false)
  }, [session.id])

  const access = providerJobsAccessState(session, health)
  const setAccess = (mode: ProviderJobsAccess) => {
    const current = providerJobsAccessState(session, useAppStore.getState().health)
    if (!current.available) {
      useAppStore.getState().setError('Update AgentsServer before changing agent scheduled-jobs access.')
      return
    }
    void useAppStore.getState().updateSession(session.id, { provider_jobs_access: mode })
  }
  const addJob = () => {
    setOpen(false)
    useAppStore.getState().setModal('job', true)
  }
  const editJob = (job: (typeof jobs)[number]) => {
    setOpen(false)
    window.dispatchEvent(new CustomEvent('agentsdock:edit-job', { detail: job }))
  }
  const replaceJob = (updated: Job) => useAppStore.setState(state => ({
    jobs: state.jobs.map(candidate => candidate.id === updated.id ? updated : candidate)
  }))
  const perform = async (key: string, operation: () => Promise<void>) => {
    if (pendingAction) return
    setPendingAction(key)
    try {
      await operation()
    } catch (error) {
      useAppStore.getState().setError(jobActionErrorMessage(error))
    } finally {
      setPendingAction(current => current === key ? null : current)
    }
  }
  const runJob = async (job: Job) => {
    const result = await window.agentsDock.jobs.run(job.id)
    if (!result || typeof result !== 'object') return
    if (!result.ok) throw new Error(result.message?.trim() || t('ui.ScheduledJobsPopover.runFailed'))
    if (result.job) replaceJob(result.job)
    else if (result.manual_run_pending) replaceJob({ ...job, manual_run_pending: true })
    trackEvent('scheduled_job_run_requested')
  }
  const toggleJob = async (job: Job) => {
    const enable = job.enabled === false
    const updated = await window.agentsDock.jobs.update(job.id, { enabled: enable })
    replaceJob(updated)
    trackEvent(enable ? 'scheduled_job_resumed' : 'scheduled_job_paused')
  }
  const stopJob = async () => {
    await useAppStore.getState().stopTurnForSession(session.id)
    if (!useAppStore.getState().activeSessionIds.has(session.id)) trackEvent('scheduled_job_run_cancelled')
  }
  const requestDelete = (job: Job) => {
    setOpen(false)
    setDeleteError(null)
    setDeleteCandidate(job)
  }
  const deleteJob = async () => {
    if (!deleteCandidate || deleting) return
    const candidate = deleteCandidate
    const request = ++deleteRequest.current
    setDeleting(true)
    setDeleteError(null)
    try {
      const removed = await window.agentsDock.jobs.remove(candidate.id)
      if (deleteRequest.current !== request) return
      if (!removed) throw new Error(`“${candidate.title}” could not be deleted.`)
      trackEvent('scheduled_job_deleted')
      setDeleteCandidate(null)
    } catch (error) {
      if (deleteRequest.current === request) setDeleteError(jobDeleteErrorMessage(error))
    } finally {
      if (deleteRequest.current === request) setDeleting(false)
    }
  }

  return <><Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button className="icon-button" title={t("ui.ScheduledJobsPopover.ScheduledJobsPopover.scheduled_jobs_46863de")} aria-label={t("ui.ScheduledJobsPopover.ScheduledJobsPopover.scheduled_jobs_46863de")}><Clock3 size={16} aria-hidden="true" /></button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="menu-content jobs-menu" side="bottom" align="end" sideOffset={8} collisionPadding={12} onOpenAutoFocus={event => event.preventDefault()}>
        <div className="menu-label">{t("ui.ScheduledJobsPopover.ScheduledJobsPopover.scheduled_4724f34")}</div>
        {jobs.length
          ? jobs.map(job => {
            const running = runningJobIds.has(job.id)
            const status: JobMenuStatus = running ? 'running' : job.enabled === false ? 'disabled' : 'scheduled'
            const statusLabel = jobStatusLabel(status)
            const runtimeError = scheduledJobRuntimeError(job, session, health, runtimeCatalog)
            const stoppable = stoppableJobId === job.id
            const runPending = job.manual_run_pending === true
            const busy = pendingAction !== null
            return <ContextMenu.Root key={job.id}>
              <ContextMenu.Trigger asChild><button type="button" className="menu-item jobs-menu-item" title={`${job.title} — ${statusLabel}`} aria-label={`${job.title}, ${describeJobSchedule(job)}, ${statusLabel}`} onClick={() => editJob(job)}>
                <span className={`jobs-menu-status ${status}`} title={statusLabel} aria-hidden="true">{status === 'running' ? <LoaderCircle className="spin" size={14} /> : status === 'disabled' ? <CirclePause size={14} /> : <Clock3 size={14} />}</span>
                <span className="jobs-menu-title">{job.title}</span>
                <span className="jobs-menu-schedule">{describeJobSchedule(job)}</span>
              </button></ContextMenu.Trigger>
              <ContextMenu.Portal><ContextMenu.Content className="menu-content jobs-row-menu" onCloseAutoFocus={event => event.preventDefault()}>
                <ContextMenu.Item className="menu-item" disabled={busy || running || runPending || Boolean(runtimeError)} title={runtimeError || undefined} onSelect={() => void perform(`${job.id}:run`, () => runJob(job))}>{pendingAction === `${job.id}:run` ? <LoaderCircle className="spin" size={14} /> : <Play size={14} aria-hidden="true" />}{runPending ? t('ui.ScheduledJobsPopover.runPending') : t('ui.ScheduledJobsPopover.runOnce')}</ContextMenu.Item>
                {stoppable && <ContextMenu.Item className="menu-item" disabled={busy} onSelect={() => void perform(`${job.id}:stop`, stopJob)}>{pendingAction === `${job.id}:stop` ? <LoaderCircle className="spin" size={14} /> : <Square size={14} aria-hidden="true" />}{t('ui.ScheduledJobsPopover.stopCurrentRun')}</ContextMenu.Item>}
                <ContextMenu.Item className="menu-item" disabled={busy || Boolean(job.enabled === false && runtimeError)} title={job.enabled === false ? runtimeError || undefined : undefined} onSelect={() => void perform(`${job.id}:toggle`, () => toggleJob(job))}>{pendingAction === `${job.id}:toggle` ? <LoaderCircle className="spin" size={14} /> : job.enabled === false ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{job.enabled === false ? t('ui.ScheduledJobsPopover.resumeSchedule') : t('ui.ScheduledJobsPopover.pauseSchedule')}</ContextMenu.Item>
                <ContextMenu.Separator className="menu-separator" />
                <ContextMenu.Item className="menu-item" onSelect={() => editJob(job)}><Pencil size={14} aria-hidden="true" />{t("ui.ScheduledJobsPopover.edit_scheduled_job_457a92b")}</ContextMenu.Item>
                <ContextMenu.Separator className="menu-separator" />
                <ContextMenu.Item className="menu-item danger" onSelect={() => requestDelete(job)}><Trash2 size={14} aria-hidden="true" />{t("ui.ScheduledJobsPopover.delete_scheduled_job_f8b1191")}</ContextMenu.Item>
              </ContextMenu.Content></ContextMenu.Portal>
            </ContextMenu.Root>
          })
          : <div className="jobs-menu-empty">{t("ui.ScheduledJobsPopover.ScheduledJobsPopover.no_scheduled_jobs_91e9086")}</div>}
        <div className="menu-separator" />
        <button type="button" className="menu-item jobs-menu-add" onClick={addJob}><Plus size={14} aria-hidden="true" />{t("ui.ScheduledJobsPopover.ScheduledJobsPopover.add_scheduled_job_0e49854")}</button>
        <div className="menu-separator" />
        <div className="menu-label">{t("ui.ScheduledJobsPopover.ScheduledJobsPopover.agent_access_f504d02")}</div>
        {PROVIDER_JOBS_ACCESS_MODES.map(mode => <button
          type="button"
          className="menu-item jobs-menu-access"
          key={mode}
          disabled={!access.available}
          aria-pressed={access.effective === mode}
          onClick={() => setAccess(mode)}
        >{access.effective === mode ? <Check size={14} aria-hidden="true" /> : <span className="jobs-menu-check-spacer" aria-hidden="true" />}{providerJobsAccessLabel(mode)}</button>)}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
  <Dialog.Root open={Boolean(deleteCandidate)} onOpenChange={next => {
    if (next || deleting) return
    setDeleteCandidate(null)
    setDeleteError(null)
  }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="form-dialog confirm-dialog jobs-delete-dialog" onEscapeKeyDown={event => { if (deleting) event.preventDefault() }}>
        <header>
          <div><Dialog.Title>{t("ui.ScheduledJobsPopover.ScheduledJobsPopover.delete_scheduled_job_a561ada")}</Dialog.Title><Dialog.Description>{deleteCandidate ? t("ui.ScheduledJobsPopover.ScheduledJobsPopover.will_stop_running_in_the_future_results_al_e308481", { "job": String(deleteCandidate.title) }) : ''}</Dialog.Description></div>
          <button type="button" className="icon-button" aria-label={t("ui.ScheduledJobsPopover.ScheduledJobsPopover.close_delete_scheduled_job_d51ef91")} disabled={deleting} onClick={() => setDeleteCandidate(null)}><X size={16} /></button>
        </header>
        {deleteError && <p className="jobs-delete-error" role="alert">{deleteError}</p>}
        <div className="confirm-actions">
          <button type="button" className="quiet-button" disabled={deleting} onClick={() => setDeleteCandidate(null)}>{t("ui.ScheduledJobsPopover.ScheduledJobsPopover.cancel_19766ed")}</button>
          <button type="button" className="danger-button" disabled={deleting} onClick={() => void deleteJob()}>{deleting && <LoaderCircle className="spin" size={13} />}{" "}{t("ui.ScheduledJobsPopover.ScheduledJobsPopover.delete_job_be79dd9")}</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root></>
}

function jobDeleteErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : t("ui.ScheduledJobsPopover.jobDeleteErrorMessage.the_scheduled_job_could_not_be_deleted_a3a9125"))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
}

type JobMenuStatus = 'disabled' | 'running' | 'scheduled'

function jobStatusLabel(status: JobMenuStatus): string {
  if (status === 'running') return t('ui.ScheduledJobsPopover.statusRunning')
  if (status === 'disabled') return t('ui.ScheduledJobsPopover.statusDisabled')
  return t('ui.ScheduledJobsPopover.statusScheduled')
}

function scheduledJobRuntimeError(
  job: Job,
  session: Session,
  health: Health | null,
  catalog: RuntimeCatalog | null
): string | null {
  const backend = job.context_mode === 'standalone' ? job.backend ?? session.backend : session.backend
  return runtimeSelectionError(health, catalog, backend, backend === session.backend ? session.model : null,
    backend === session.backend ? session.codex_provider : undefined, session.codex_provider_catalog)
}

function activeScheduledJobId(events: AgentEvent[], activeRunId: string | null): string | null {
  if (!activeRunId) return null
  let latest: { jobId: string; order: number; running: boolean } | null = null
  for (const event of events) {
    const linkedRunIds = [event.run_id, event.job_status_run_id, event.job_latest_status_run_id, event.job_latest_run_id]
      .map(value => value?.trim() || '')
    if (!linkedRunIds.includes(activeRunId)) continue
    const jobId = String(event.job_id || event.job?.id || '').trim()
    if (!jobId || (event.purpose !== 'scheduled_job' && !event.job_id && !event.job?.id)) continue
    const running = jobEventRunningState(event)
    if (running == null) continue
    const order = Math.max(
      Number(event.seq || 0),
      Number(event.job_status_seq || 0),
      Number(event.job_latest_status_seq || 0),
      Number(event.job_run_status_seq || 0)
    )
    if (!latest || order >= latest.order) latest = { jobId, order, running }
  }
  return latest?.running ? latest.jobId : null
}

function currentRunningJobIds(events: AgentEvent[], sessionActive: boolean): Set<string> {
  if (!sessionActive) return new Set()
  const latest = new Map<string, { order: number; running: boolean }>()
  for (const event of events) {
    const jobId = String(event.job_id || event.job?.id || '').trim()
    if (!jobId) continue
    const running = jobEventRunningState(event)
    if (running == null) continue
    const order = Math.max(
      Number(event.seq || 0),
      Number(event.job_status_seq || 0),
      Number(event.job_latest_status_seq || 0),
      Number(event.job_run_status_seq || 0)
    )
    const current = latest.get(jobId)
    if (!current || order >= current.order) latest.set(jobId, { order, running })
  }
  return new Set([...latest].filter(([, state]) => state.running).map(([jobId]) => jobId))
}

function jobEventRunningState(event: AgentEvent): boolean | null {
  const status = String(event.job_status || event.job_latest_status || event.job_run_status || '').trim().toLowerCase()
  if (['running', 'started', 'active', 'in_progress'].includes(status)) return true
  if (['completed', 'complete', 'succeeded', 'success', 'done', 'failed', 'error', 'stopped', 'cancelled', 'canceled', 'deferred', 'queued'].includes(status)) return false
  if (event.is_error || event.stopped) return false
  if (['job_finished', 'job_error', 'job_deferred', 'turn_finished', 'turn_stopped'].includes(event.type)) return false
  if (['job_ran', 'job_started', 'turn_started'].includes(event.type)) return true
  return null
}

function jobActionErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : t('ui.ScheduledJobsPopover.actionFailed'))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
}
