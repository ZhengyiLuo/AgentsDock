// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, LoaderCircle, Shield, X } from 'lucide-react'
import type { CursorPermissionMode, Session } from '@shared/types'
import { cursorBackendAvailable, cursorBackendUnavailableReason } from '@shared/runtime-catalog'
import { normalizeCursorPermissionMode } from '@shared/cursor-permissions'
import {
  CURSOR_PERMISSION_MODE_HELP,
  CURSOR_PERMISSION_MODE_LABELS,
  supportedCursorPermissionModes
} from '../lib/cursor-permission-copy'
import { queueCursorPermissionUpdate } from '../lib/cursor-permission-updates'
import { useAppStore } from '../store/app-store'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function CursorPermissionMenu({
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
  const [internalOpen, setInternalOpen] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [mode, setMode] = useState<CursorPermissionMode>(() => permissionMode(session))
  const modeRef = useRef(mode)
  const saveEpoch = useRef(0)
  const mounted = useRef(true)
  const health = useAppStore(state => state.health)
  const catalog = useAppStore(state => state.runtimeCatalog)
  const permissionModes = supportedCursorPermissionModes(health?.capabilities?.cursor_backend?.permission_modes)
  const available = cursorBackendAvailable(health, catalog) && permissionModes.length > 0
  const unavailableReason = cursorBackendUnavailableReason(health, catalog)
  const controlsDisabled = !available || saveState === 'saving'
  const label = CURSOR_PERMISSION_MODE_LABELS[mode]
  const open = controlledOpen ?? internalOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    saveEpoch.current += 1
    setOpen(false)
    setSaveState('idle')
    setSaveError(null)
    const next = permissionMode(session)
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
    const next = permissionMode(session)
    modeRef.current = next
    setMode(next)
  }, [saveState, session.cursor_permission_mode])

  useEffect(() => {
    if (saveState !== 'saved') return
    const timer = window.setTimeout(() => setSaveState('idle'), 1_400)
    return () => window.clearTimeout(timer)
  }, [saveState])

  const apply = (next: CursorPermissionMode) => {
    if (controlsDisabled || !permissionModes.includes(next) || next === modeRef.current) return
    modeRef.current = next
    setMode(next)
    const epoch = ++saveEpoch.current
    setSaveState('saving')
    setSaveError(null)
    void queueCursorPermissionUpdate(session.id, { cursor_permission_mode: next })
      .then(() => {
        if (!mounted.current || epoch !== saveEpoch.current) return
        setSaveState('saved')
      })
      .catch(cause => {
        if (!mounted.current || epoch !== saveEpoch.current) return
        const updated = useAppStore.getState().sessions.find(candidate => candidate.id === session.id)
        const fallback = permissionMode(updated ?? session)
        modeRef.current = fallback
        setMode(fallback)
        setSaveState('error')
        setSaveError(errorMessage(cause))
      })
  }

  return <Popover.Root open={available && open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button
        type="button"
        className={`codex-permission-chip${available ? '' : ' unavailable'}`}
        aria-label={t("ui.CursorPermissionMenu.CursorPermissionMenu.cursor_permissions_dda1918", { "label": String(label) })}
        title={available ? t("ui.CursorPermissionMenu.CursorPermissionMenu.cursor_permissions_dda1918", { "label": String(label) }) : unavailableReason ?? t("ui.CursorPermissionMenu.CursorPermissionMenu.cursor_permissions_are_unavailable_4bcf0cc")}
        disabled={!available}
      >
        <Shield size={14} aria-hidden="true" />
        <span className="codex-permission-primary">{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        className="codex-permission-popover"
        side="top"
        align="start"
        sideOffset={8}
        aria-labelledby="cursor-permission-title"
        aria-describedby="cursor-permission-description"
      >
        <header>
          <span className="codex-permission-popover-icon"><Shield size={16} aria-hidden="true" /></span>
          <div>
            <h3 id="cursor-permission-title">{t("ui.CursorPermissionMenu.CursorPermissionMenu.cursor_permissions_e31718f")}</h3>
            <p id="cursor-permission-description">{t("ui.CursorPermissionMenu.CursorPermissionMenu.applies_to_future_turns_in_this_chat_95b5680")}</p>
          </div>
          <div className="codex-permission-popover-actions">
            <span className={`codex-permission-save-state ${saveState}`} role="status" aria-live="polite">
              {saveState === 'saving' && <><LoaderCircle className="spin" size={12} />{" "}{t("ui.CursorPermissionMenu.CursorPermissionMenu.saving_096b736")}</>}
              {saveState === 'saved' && <><Check size={12} />{" "}{t("ui.CursorPermissionMenu.CursorPermissionMenu.saved_b5c120b")}</>}
              {saveState === 'error' && 'Not saved'}
            </span>
            <Popover.Close asChild>
              <button type="button" className="codex-permission-popover-close" aria-label={t("ui.CursorPermissionMenu.CursorPermissionMenu.close_cursor_permissions_69244be")} title={t("ui.CursorPermissionMenu.CursorPermissionMenu.close_7d9eb7a")}>
                <X size={14} aria-hidden="true" />
              </button>
            </Popover.Close>
          </div>
        </header>
        <div className="codex-permission-fields claude-permission-fields">
          <label>
            <span>{t("ui.CursorPermissionMenu.CursorPermissionMenu.permission_mode_c7a8e6d")}</span>
            <select
              value={mode}
              disabled={controlsDisabled}
              onChange={event => apply(event.target.value as CursorPermissionMode)}
            >
              {permissionModes.map(value =>
                <option key={value} value={value}>{CURSOR_PERMISSION_MODE_LABELS[value]}</option>
              )}
            </select>
          </label>
        </div>
        <p className="codex-permission-hint">{CURSOR_PERMISSION_MODE_HELP[mode]}</p>
        {running && <p className="codex-permission-hint">{t("ui.CursorPermissionMenu.CursorPermissionMenu.this_change_applies_to_the_next_turn_the_a_af4af7d")}</p>}
        {saveError && <p className="codex-permission-error" role="alert">{saveError}</p>}
        <Popover.Arrow className="codex-permission-arrow" />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}

function permissionMode(session: Session): CursorPermissionMode {
  return normalizeCursorPermissionMode(session.cursor_permission_mode)
}

function errorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}
