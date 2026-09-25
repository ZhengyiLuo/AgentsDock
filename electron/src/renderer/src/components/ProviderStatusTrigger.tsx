import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { ChevronRight, LoaderCircle } from 'lucide-react'

/** One header entry point for native provider controls. */
export const ProviderStatusTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  provider: string
  status: string
  tone: 'idle' | 'active' | 'waiting' | 'error'
  loading?: boolean
}>(function ProviderStatusTrigger({ provider, status, tone, loading, className, ...props }, ref) {
  return <button type="button" {...props} ref={ref} className={`codex-status-button ${tone}${className ? ` ${className}` : ''}`}>
    {loading || tone === 'active' ? <LoaderCircle className="spin" size={11} aria-hidden="true" /> : <span aria-hidden="true" />}
    <b>{provider}</b><small>{status}</small><ChevronRight size={12} aria-hidden="true" />
  </button>
})
