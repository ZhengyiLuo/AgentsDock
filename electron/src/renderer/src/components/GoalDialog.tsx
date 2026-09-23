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
