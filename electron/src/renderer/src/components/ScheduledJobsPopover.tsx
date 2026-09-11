// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import * as ContextMenu from '@radix-ui/react-context-menu'
import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import { Check, Clock3, LoaderCircle, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Job, ProviderJobsAccess, Session } from '@shared/types'
import { describeJobSchedule } from '../lib/job-schedule'
import { PROVIDER_JOBS_ACCESS_MODES, providerJobsAccessLabel, providerJobsAccessState } from '../lib/provider-jobs-access'
import { useAppStore } from '../store/app-store'

/**
 * Header popover that lists the chat's scheduled jobs, lets the user add a new
 * one (opening the existing job panel), and picks the per-chat agent access
 * mode applied to every scheduled job in this chat. Styled like the chat menu.
 */
export function ScheduledJobsPopover({ session }: { session: Session }) {
  useLocale()
  const allJobs = useAppStore(state => state.jobs)
  const health = useAppStore(state => state.health)
  const jobs = useMemo(() => allJobs.filter(job => job.session_id === session.id), [allJobs, session.id])
  const [open, setOpen] = useState(false)
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
          ? jobs.map(job => <ContextMenu.Root key={job.id}>
              <ContextMenu.Trigger asChild><button type="button" className="menu-item jobs-menu-item" title={job.title} aria-label={`${job.title}, ${describeJobSchedule(job)}`} onClick={() => editJob(job)}>
                <Clock3 size={14} aria-hidden="true" />
                <span className="jobs-menu-title">{job.title}</span>
                <span className="jobs-menu-schedule">{describeJobSchedule(job)}</span>
              </button></ContextMenu.Trigger>
              <ContextMenu.Portal><ContextMenu.Content className="menu-content jobs-row-menu" onCloseAutoFocus={event => event.preventDefault()}>
                <ContextMenu.Item className="menu-item" onSelect={() => editJob(job)}><Pencil size={14} aria-hidden="true" />{t("ui.ScheduledJobsPopover.edit_scheduled_job_457a92b")}</ContextMenu.Item>
                <ContextMenu.Separator className="menu-separator" />
                <ContextMenu.Item className="menu-item danger" onSelect={() => requestDelete(job)}><Trash2 size={14} aria-hidden="true" />{t("ui.ScheduledJobsPopover.delete_scheduled_job_f8b1191")}</ContextMenu.Item>
              </ContextMenu.Content></ContextMenu.Portal>
            </ContextMenu.Root>)
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
