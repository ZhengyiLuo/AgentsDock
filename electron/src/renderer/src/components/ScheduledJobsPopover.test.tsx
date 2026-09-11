import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { JobDialog } from './Dialogs'
import { ScheduledJobsPopover } from './ScheduledJobsPopover'

const session: Session = { id: 'chat-1', title: 'Chat', backend: 'codex' }
const styles = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

describe('ScheduledJobsPopover', () => {
  beforeEach(() => {
    useAppStore.setState({
      sessions: [session],
      selectedSessionId: session.id,
      jobs: [{ id: 'job-1', session_id: session.id, title: 'Status', prompt: 'Check status', interval_seconds: 3600 }],
      health: null,
      modals: { ...useAppStore.getState().modals, job: false }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('separates the add action from jobs and renders the schedule at row size', async () => {
    render(<ScheduledJobsPopover session={session} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scheduled jobs' }))

    const schedule = await screen.findByText('Every 1h')
    expect(schedule).toHaveClass('jobs-menu-schedule')
    expect(schedule.tagName).toBe('SPAN')

    const add = screen.getByRole('button', { name: 'Add scheduled job' })
    expect(add).toHaveClass('jobs-menu-add')
    expect(add.previousElementSibling).toHaveClass('menu-separator')
    expect(add.nextElementSibling).toHaveClass('menu-separator')
  })

  it('uses a clock for the scheduled-jobs header action', () => {
    render(<ScheduledJobsPopover session={session} />)

    expect(screen.getByRole('button', { name: 'Scheduled jobs' }).querySelector('svg')).toHaveClass('lucide-clock-3')
  })

  it('stretches every job, add action, and access option across the full menu row', async () => {
    render(<ScheduledJobsPopover session={session} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scheduled jobs' }))

    for (const name of ['Status, Every 1h', 'Add scheduled job', 'Full access', 'Read-only', 'Blocked']) {
      const row = screen.getByRole('button', { name })
      expect(row).toHaveClass('menu-item')
      expect(row.closest('.jobs-menu')).not.toBeNull()
    }

    const rowStyle = styles.match(/\.jobs-menu \.menu-item \{([^}]*)\}/)?.[1] ?? ''
    // Native buttons otherwise shrink to their labels, leaving the right side
    // outside both the shared hover highlight and the clickable hit area.
    expect(rowStyle).toMatch(/\bwidth:\s*100%;/)
    expect(rowStyle).toMatch(/\btext-align:\s*left;/)
  })

  it('contains long job names, keeps schedule metadata visible, and exposes the full name on hover', async () => {
    const title = 'Guard all Pat H100 Ray clusters across every production region'
    useAppStore.setState({
      jobs: [{ id: 'job-1', session_id: session.id, title, prompt: 'Check status', interval_seconds: 3600 }]
    })
    render(<ScheduledJobsPopover session={session} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Scheduled jobs' }))

    const row = screen.getByRole('button', { name: `${title}, Every 1h` })
    expect(row).toHaveAttribute('title', title)
    expect(row.querySelector('.jobs-menu-title')).toHaveTextContent(title)
    expect(row.querySelector('.jobs-menu-schedule')).toHaveTextContent('Every 1h')
    expect(styles).toMatch(/\.jobs-menu \{[^}]*width:\s*min\(300px,[^}]*max-width:\s*300px;/s)
    expect(styles).toMatch(/\.jobs-menu-item \{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/s)
    expect(styles).toMatch(/\.jobs-menu-title \{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s)
    expect(styles).toMatch(/\.jobs-menu-schedule \{[^}]*max-width:\s*50%;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s)
  })

  it('opens the scheduled-job dialog and closes it from its X button', async () => {
    const user = userEvent.setup()
    render(<><ScheduledJobsPopover session={session} /><JobDialog /></>)

    await user.click(screen.getByRole('button', { name: 'Scheduled jobs' }))
    await user.click(await screen.findByRole('button', { name: 'Add scheduled job' }))

    expect(await screen.findByRole('dialog', { name: 'Schedule a job' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close Schedule a job' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Schedule a job' })).not.toBeInTheDocument())
    expect(useAppStore.getState().modals.job).toBe(false)
    expect(screen.queryByRole('button', { name: 'Add scheduled job' })).not.toBeInTheDocument()
  })

  it('keeps dialogs outside the native Electron drag region', () => {
    expect(styles).toMatch(/\.dialog-overlay \{[^}]*-webkit-app-region: no-drag;/s)
    expect(styles).toMatch(/\.form-dialog \{[^}]*-webkit-app-region: no-drag;/s)
  })

  it('keeps menu headings quiet and schedule metadata full-size and theme-blue', () => {
    expect(styles).toMatch(/\.jobs-menu \.menu-label \{[^}]*color: color-mix\(in srgb, var\(--faint\)[^}]*\}/s)
    expect(styles).toMatch(/\.jobs-menu-schedule \{[^}]*max-width: 50%;[^}]*color: color-mix\(in srgb, var\(--accent\) 82%, var\(--text\)\);[^}]*font: inherit;/s)
    // Schedule metadata keeps its meaning on hover; the shared menu row owns
    // the neutral highlight instead of turning the whole row blue and white.
    expect(styles).not.toMatch(/\.jobs-menu[^{}]*:hover[^{}]*\{[^}]*color: white;/s)
    expect(styles).toMatch(/\.menu-item:is\([^{}]*\):not\(\[data-disabled\]\):not\(:disabled\) \{ background: var\(--interaction-hover\); \}/)
  })

  it('offers confirmed deletion when an existing job is right-clicked', async () => {
    const remove = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { remove } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ScheduledJobsPopover session={session} />)
    await user.click(screen.getByRole('button', { name: 'Scheduled jobs' }))

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Status, Every 1h' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete scheduled job…' }))

    expect(await screen.findByRole('dialog', { name: 'Delete scheduled job?' })).toBeVisible()
    expect(remove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Delete job' }))

    await waitFor(() => expect(remove).toHaveBeenCalledWith('job-1'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete scheduled job?' })).not.toBeInTheDocument())
  })

  it('keeps the confirmation open and explains a deletion failure', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('The server refused this request.'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { jobs: { remove } } as unknown as AgentsDockAPI
    })
    const user = userEvent.setup()
    render(<ScheduledJobsPopover session={session} />)
    await user.click(screen.getByRole('button', { name: 'Scheduled jobs' }))

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Status, Every 1h' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete scheduled job…' }))
    await user.click(screen.getByRole('button', { name: 'Delete job' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The server refused this request.')
    expect(screen.getByRole('dialog', { name: 'Delete scheduled job?' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Delete job' })).toBeEnabled()
  })
})
