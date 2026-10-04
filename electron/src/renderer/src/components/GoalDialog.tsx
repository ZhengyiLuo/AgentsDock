import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Goal, X } from 'lucide-react'
import './GoalDialog.css'

/** Shared presentation only; each provider owns its goal state and actions. */
export function GoalDialogContent({ title, description, closeLabel, busy, children }: {
  title: string
  description: string
  closeLabel: string
  busy?: boolean
  children: ReactNode
}) {
  return <Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="form-dialog goal-dialog" aria-busy={busy}>
      <header>
        <Goal size={20} aria-hidden="true" />
        <div>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
        </div>
        <Dialog.Close asChild><button type="button" className="icon-button" aria-label={closeLabel}><X size={16} /></button></Dialog.Close>
      </header>
      {children}
    </Dialog.Content>
  </Dialog.Portal>
}

export function GoalConditionField({ label, placeholder, value, onChange, disabled, autoFocus = true }: {
  label: string
  placeholder: string
  value: string
  onChange(value: string): void
  disabled?: boolean
  autoFocus?: boolean
}) {
  return <label className="goal-field">
    <span>{label}</span>
    <textarea autoFocus={autoFocus} rows={4} maxLength={4000} value={value} disabled={disabled} aria-label={label}
      placeholder={placeholder} onChange={event => onChange(event.target.value)} />
    <small>{value.length.toLocaleString()} / 4,000</small>
  </label>
}

export function GoalSummaryBar({ label, condition, metadata, openLabel, onOpen, actions }: {
  label: string
  condition: string
  metadata: ReactNode
  openLabel: string
  onOpen?: () => void
  actions?: ReactNode
}) {
  const summary = <><Goal size={15} aria-hidden="true" /><span className="goal-summary-condition">{condition}</span>
    <span className="goal-summary-meta">{metadata}</span></>
  return <section className="goal-summary-bar" aria-label={label}>
    {onOpen ? <button type="button" className="goal-summary" onClick={onOpen} aria-label={openLabel} title={condition}>{summary}</button>
      : <div className="goal-summary">{summary}</div>}
    {actions && <div className="goal-summary-actions">{actions}</div>}
  </section>
}

export function GoalProgress({ label, status, condition, metrics, reason }: {
  label: string
  status: string
  condition: string
  metrics: Array<{ label: string; value: ReactNode }>
  reason?: { label: string; text: string } | null
}) {
  return <section className="goal-progress" aria-label={label}>
    <strong>{status}</strong><p>{condition}</p>
    <dl>{metrics.map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl>
    {reason && <div className="goal-reason"><strong>{reason.label}</strong><p>{reason.text}</p></div>}
  </section>
}
