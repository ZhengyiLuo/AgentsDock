// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, LoaderCircle, Shield, X } from 'lucide-react'
import type { ClaudePermissionMode, ClaudeRuntimePolicy, Session } from '@shared/types'
import {
  CLAUDE_PERMISSION_MODE_HELP,
  CLAUDE_PERMISSION_MODE_LABELS,
  supportedClaudePermissionModes
} from '../lib/claude-permission-copy'
import { queueClaudePermissionUpdate } from '../lib/claude-permission-updates'
import { useAppStore } from '../store/app-store'
import { useClaudeRuntime } from './ClaudeRuntimeContext'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function ClaudePermissionMenu({
  session,
  running,
  open: controlledOpen,
  onOpenChange
}: {
  session: Session
  running: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  useLocale()
  const { runtime, supported, mutating } = useClaudeRuntime()
  const sharedDisconnected = useAppStore(state => window.agentsDock.sharedChat === true && !state.connected)
  const [internalOpen, setInternalOpen] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [mode, setMode] = useState<ClaudePermissionMode>(() => permissionMode(session, runtime?.policy))
  const modeRef = useRef(mode)
  const saveEpoch = useRef(0)
  const mounted = useRef(true)
  const featureSupported = runtime?.features?.permission_mode_control === true
  const supportedModes = supportedClaudePermissionModes(runtime?.permission_modes)
  const modesResolved = supportedModes.length > 0
  const policyResolved = (session.claude_permission_mode ?? runtime?.policy?.permission_mode) != null
  const modeSupported = supportedModes.includes(mode)
  const available = supported && featureSupported && modesResolved && policyResolved && modeSupported
  const turnActive = running || runtime?.status?.type === 'active'
  const controlsDisabled = mutating || saveState === 'saving' || sharedDisconnected
  const label = CLAUDE_PERMISSION_MODE_LABELS[mode]
  const unavailableLabel = !supported
    ? t('ui.permission.unavailable')
    : !runtime || (featureSupported && modesResolved && !policyResolved)
      ? 'Loading permissions'
      : 'Update server'
  const accessibleLabel = !supported
    ? 'Claude permissions unavailable; update AgentsServer and use Claude Agent SDK'
    : !runtime
      ? 'Claude permissions loading'
      : !featureSupported || !modesResolved || (policyResolved && !modeSupported)
        ? 'Claude permission modes unavailable; update AgentsServer'
        : !policyResolved
          ? 'Claude permissions loading'
          : `Claude permissions: ${label}`
  const open = controlledOpen ?? internalOpen
  const effectiveOpen = open && available && !sharedDisconnected
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    saveEpoch.current += 1
    setOpen(false)
    setSaveState('idle')
    setSaveError(null)
    const next = permissionMode(session, runtime?.policy)
    modeRef.current = next
    setMode(next)
  }, [session.id])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      saveEpoch.current += 1
    }
  }, [])

  useEffect(() => {
    if (saveState === 'saving') return
    const next = permissionMode(session, runtime?.policy)
    modeRef.current = next
    setMode(next)
  }, [runtime?.policy?.permission_mode, saveState, session.claude_permission_mode])

  useEffect(() => {
    if (saveState !== 'saved') return
    const timer = window.setTimeout(() => setSaveState('idle'), 1_400)
    return () => window.clearTimeout(timer)
  }, [saveState])

  const apply = (next: ClaudePermissionMode) => {
    if (!available || controlsDisabled || next === modeRef.current) return
    modeRef.current = next
    setMode(next)
    const epoch = ++saveEpoch.current
    setSaveState('saving')
    setSaveError(null)
    void queueClaudePermissionUpdate(session.id, { claude_permission_mode: next })
      .then(() => {
        if (!mounted.current || epoch !== saveEpoch.current) return
        setSaveState('saved')
      })
      .catch(cause => {
        if (!mounted.current || epoch !== saveEpoch.current) return
        const updated = useAppStore.getState().sessions.find(candidate => candidate.id === session.id)
        const fallback = permissionMode(updated ?? session, runtime?.policy)
        modeRef.current = fallback
        setMode(fallback)
        setSaveState('error')
        setSaveError(errorMessage(cause))
      })
  }

  return <Popover.Root open={effectiveOpen} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button
        type="button"
        className={`codex-permission-chip${available ? '' : ' unavailable'}`}
        aria-label={accessibleLabel}
        title={accessibleLabel}
        disabled={!available || sharedDisconnected}
      >
        <Shield size={14} aria-hidden="true" />
        {available
          ? <span className="codex-permission-primary">{label}</span>
          : <span className="codex-permission-unavailable">{unavailableLabel}</span>}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        className="codex-permission-popover"
        side="top"
        align="start"
        sideOffset={8}
        aria-labelledby="claude-permission-title"
        aria-describedby="claude-permission-description"
      >
        <header>
          <span className="codex-permission-popover-icon"><Shield size={16} aria-hidden="true" /></span>
          <div>
            <h3 id="claude-permission-title">{t("ui.ClaudePermissionMenu.ClaudePermissionMenu.claude_permissions_084e457")}</h3>
            <p id="claude-permission-description">{t("ui.ClaudePermissionMenu.ClaudePermissionMenu.applies_to_future_interactive_claude_sdk_t_63d9fa1")}</p>
          </div>
          <div className="codex-permission-popover-actions">
            <span className={`codex-permission-save-state ${saveState}`} role="status" aria-live="polite">
              {saveState === 'saving' && <><LoaderCircle className="spin" size={12} />{" "}{t("ui.ClaudePermissionMenu.ClaudePermissionMenu.saving_096b736")}</>}
              {saveState === 'saved' && <><Check size={12} />{" "}{t("ui.ClaudePermissionMenu.ClaudePermissionMenu.saved_b5c120b")}</>}
              {saveState === 'error' && 'Not saved'}
            </span>
            <Popover.Close asChild>
              <button type="button" className="codex-permission-popover-close" aria-label={t("ui.ClaudePermissionMenu.ClaudePermissionMenu.close_claude_permissions_fdea62d")} title={t("ui.ClaudePermissionMenu.ClaudePermissionMenu.close_7d9eb7a")}>
                <X size={14} aria-hidden="true" />
              </button>
            </Popover.Close>
          </div>
        </header>
        <div className="codex-permission-fields claude-permission-fields">
          <label>
            <span>{t("ui.ClaudePermissionMenu.ClaudePermissionMenu.permission_mode_c7a8e6d")}</span>
            <select
              value={mode}
              disabled={controlsDisabled}
              onChange={event => apply(event.target.value as ClaudePermissionMode)}
            >
              {supportedModes.map(value =>
                <option key={value} value={value}>{CLAUDE_PERMISSION_MODE_LABELS[value]}</option>
              )}
            </select>
          </label>
        </div>
        <p className="codex-permission-hint">{CLAUDE_PERMISSION_MODE_HELP[mode]}</p>
        {turnActive && <p className="codex-permission-hint">{t("ui.ClaudePermissionMenu.ClaudePermissionMenu.this_change_applies_to_the_next_turn_the_a_af4af7d")}</p>}
        {saveError && <p className="codex-permission-error" role="alert">{saveError}</p>}
        <Popover.Arrow className="codex-permission-arrow" />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}

function permissionMode(session: Session, runtimePolicy?: ClaudeRuntimePolicy | null): ClaudePermissionMode {
  return session.claude_permission_mode ?? runtimePolicy?.permission_mode ?? 'default'
}

function errorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}
